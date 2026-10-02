import os from 'node:os';

/** One scheduler for the whole machine.
 *
 * Every visitor has a private studio, and a studio used to run its own lanes, so a hundred visitors ran a hundred
 * transcriptions at once and the machine thrashed (and was paid for at the size of its worst minute). Here all studios share
 * the lanes: each lane has a fixed number of slots sized to the hardware, work that does not fit waits in a queue, and the
 * queue is fair, not first come first served: when a slot frees up it goes to the visitor who has the fewest steps running
 * in that lane (the one served longest ago on a tie), so someone who asks for twenty reels cannot hold up someone who asks
 * for one. A small machine that queues its busy minutes is much cheaper than one sized for them. */
export const LANES = ['net', 'prep', 'gpu', 'ai', 'render', 'track', 'scan'] as const;
export type Lane = typeof LANES[number];
export type Capacity = Record<Lane, number>;

/** Slots when one studio has the machine to itself (a local install, the tests). */
export const SOLO_CAPACITY: Capacity = { net: 2, prep: 2, gpu: 1, ai: 3, render: 2, track: 1, scan: 1 };
/** The lanes that burn CPU, GPU or memory: the ones a backlog is measured in. */
export const HEAVY_LANES: readonly Lane[] = ['gpu', 'render', 'track', 'scan'];

export type Machine = { cores?: number; memoryGB?: number; /** whisper runs on a GPU */ gpu?: boolean; /** the video encoder is an NVIDIA chip */ nvenc?: boolean };
/** Slots for a machine shared by many visitors. Speech recognition on a CPU uses every core, so it runs one at a time (or
 * one per 16 cores); an encode or a picture scan keeps about four cores busy; every tracker is a headless Chromium
 * (roughly 0.5 to 1 GB), so memory limits them too. Waiting for downloads and for an AI answer costs nothing, so those lanes
 * are wide. `prep` is quick decoding (pulling the audio out of a video) that must not queue behind an hour of speech recognition. */
export function machineCapacity(machine: Machine = {}): Capacity {
  const cores = Math.max(1, Math.floor(machine.cores ?? os.availableParallelism?.() ?? os.cpus().length)), gb = machine.memoryGB ?? os.totalmem() / 2 ** 30;
  const per = (n: number) => Math.max(1, Math.floor(cores / n));
  return { net: 4, prep: per(2), ai: 8, gpu: machine.gpu ? 1 : per(16), render: machine.nvenc ? 3 : per(4), track: Math.max(1, Math.min(per(4), Math.floor(gb / 1.5), 4)), scan: per(4) };
}
/** "render=3,track=2": the operator's own numbers for some lanes. Anything else in the text is ignored. */
export function parseCapacity(text: string | undefined): Partial<Capacity> {
  const out: Partial<Capacity> = {};
  for (const part of (text ?? '').split(',')) {
    const [name, value] = part.split('=').map(s => s.trim()), n = Number(value);
    if ((LANES as readonly string[]).includes(name) && Number.isInteger(n) && n >= 1 && n <= 64) out[name as Lane] = n;
  }
  return out;
}

/** The service cannot take more work right now. `retryAfter` is a hint in seconds. */
export class Busy extends Error { constructor(message: string, readonly retryAfter = 60) { super(message); } }
export class Cancelled extends Error { constructor() { super('Cancelled.'); } }

type Ticket = { owner: string; seq: number; grant: () => void; reject: (error: Error) => void; onQueue?: (ahead: number | null) => void; cleanup: () => void };
type LaneState = { capacity: number; running: number; runningBy: Map<string, number>; waiting: Map<string, Ticket[]>; lastGrant: Map<string, number>; timer?: NodeJS.Timeout };
export type SchedulerLimits = { /** Steps one visitor may have waiting in one lane (default 200). */ maxQueuedPerOwner?: number; /** Waiting steps in the heavy lanes after which new work is refused (default 400). */ maxBacklog?: number };

export class Scheduler {
  private lanes = new Map<Lane, LaneState>();
  private seq = 0;
  readonly capacity: Capacity;
  constructor(capacity: Capacity = SOLO_CAPACITY, private limits: SchedulerLimits = {}) {
    this.capacity = { ...capacity };
    for (const lane of LANES) { this.capacity[lane] = Math.max(1, Math.floor(capacity[lane] ?? SOLO_CAPACITY[lane])); this.lanes.set(lane, { capacity: this.capacity[lane], running: 0, runningBy: new Map(), waiting: new Map(), lastGrant: new Map() }); }
  }

  /** Runs `fn` when `owner` has a slot in `lane`. `onQueue` hears how many steps will start before this one (0: next), and
   * null once it runs. A step cancelled while it waits never runs. */
  async run<T>(lane: Lane, owner: string, signal: AbortSignal | undefined, fn: () => Promise<T>, onQueue?: (ahead: number | null) => void): Promise<T> {
    signal?.throwIfAborted();
    const state = this.lanes.get(lane)!;
    if ((state.waiting.get(owner)?.length ?? 0) >= (this.limits.maxQueuedPerOwner ?? 200)) throw new Busy('You have too many steps waiting. Wait for some to finish.', 30);
    await new Promise<void>((grant, reject) => {
      const ticket: Ticket = { owner, seq: ++this.seq, grant, reject, onQueue, cleanup: () => signal?.removeEventListener('abort', abort) };
      const abort = () => { if (this.remove(state, ticket)) { reject(new Cancelled()); this.tell(state); } };
      signal?.addEventListener('abort', abort, { once: true });
      const queue = state.waiting.get(owner) ?? []; state.waiting.set(owner, queue); queue.push(ticket);
      this.dispatch(state);
      if (state.waiting.get(owner)?.includes(ticket)) this.tell(state, true);
    });
    try { signal?.throwIfAborted(); return await fn(); }
    finally {
      state.running--;
      const n = (state.runningBy.get(owner) ?? 1) - 1; if (n > 0) state.runningBy.set(owner, n); else state.runningBy.delete(owner);
      this.dispatch(state);
    }
  }

  /** Changes the slots of some lanes (the machine's GPU is only known after the tools are found). Waiting steps start at once when a lane grows. */
  retune(capacity: Partial<Capacity>) {
    for (const lane of LANES) {
      const n = capacity[lane];
      if (n === undefined) continue;
      this.capacity[lane] = Math.max(1, Math.floor(n));
      const state = this.lanes.get(lane)!; state.capacity = this.capacity[lane]; this.dispatch(state);
    }
  }
  /** Steps waiting in the heavy lanes. */
  backlog() { return HEAVY_LANES.reduce((total, lane) => total + this.queued(lane), 0); }
  queued(lane: Lane) { let n = 0; for (const queue of this.lanes.get(lane)!.waiting.values()) n += queue.length; return n; }
  /** Refuses new heavy work while the backlog is over its limit. */
  admit(extra = 1) {
    const max = this.limits.maxBacklog ?? 400;
    if (this.backlog() + extra > max) throw new Busy('Sprity Reels is very busy right now. Please try again in a few minutes.', 120);
  }
  stats() {
    const lanes = Object.fromEntries(LANES.map(lane => { const s = this.lanes.get(lane)!; return [lane, { capacity: s.capacity, running: s.running, queued: this.queued(lane) }]; })) as Record<Lane, { capacity: number; running: number; queued: number }>;
    return { lanes, backlog: this.backlog() };
  }

  private remove(state: LaneState, ticket: Ticket) {
    const queue = state.waiting.get(ticket.owner), i = queue ? queue.indexOf(ticket) : -1;
    if (!queue || i < 0) return false;
    queue.splice(i, 1); if (!queue.length) state.waiting.delete(ticket.owner);
    ticket.cleanup();
    return true;
  }
  /** The visitor whose step starts next: fewest running in this lane, then served longest ago. */
  private nextOwner(running: Map<string, number>, last: Map<string, number>, queues: Map<string, unknown[]>) {
    let best: string | null = null, bestRunning = Infinity, bestLast = Infinity;
    for (const [owner, queue] of queues) {
      if (!queue.length) continue;
      const r = running.get(owner) ?? 0, l = last.get(owner) ?? 0;
      if (r < bestRunning || (r === bestRunning && l < bestLast)) { best = owner; bestRunning = r; bestLast = l; }
    }
    return best;
  }
  private dispatch(state: LaneState) {
    let granted = false;
    while (state.running < state.capacity) {
      const owner = this.nextOwner(state.runningBy, state.lastGrant, state.waiting);
      if (owner === null) break;
      const queue = state.waiting.get(owner)!, ticket = queue.shift()!;
      if (!queue.length) state.waiting.delete(owner);
      state.running++; state.runningBy.set(owner, (state.runningBy.get(owner) ?? 0) + 1); state.lastGrant.set(owner, ++this.seq);
      ticket.cleanup(); ticket.onQueue?.(null); ticket.grant(); granted = true;
    }
    if (granted) this.tell(state);
  }
  /** Tells every waiting step how many will start before it. Spread out in time unless `now`, because a long queue changes
   * with every step that ends. */
  private tell(state: LaneState, now = false) {
    const send = () => {
      state.timer = undefined;
      const running = new Map(state.runningBy), last = new Map(state.lastGrant), queues = new Map([...state.waiting].map(([o, q]) => [o, [...q]] as [string, Ticket[]]));
      let order = 0, seq = this.seq;
      for (;;) {
        const owner = this.nextOwner(running, last, queues);
        if (owner === null) break;
        const ticket = queues.get(owner)!.shift()!;
        running.set(owner, (running.get(owner) ?? 0) + 1); last.set(owner, ++seq);
        ticket.onQueue?.(order++);
      }
    };
    if (now) { if (state.timer) { clearTimeout(state.timer); state.timer = undefined; } send(); return; }
    if (!state.timer) { state.timer = setTimeout(send, 150); state.timer.unref(); }
  }
}
