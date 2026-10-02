import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** The frame vault: the one place on disk where Sprity Reels may keep pictures of a visitor's video while it works.
 *
 * Most frame work never touches the disk (the keyframe scan and the contact sheets stay in memory). The few steps that
 * need image files (the face tracker's browser reads them over HTTP, a command-line AI reads them from paths) ask the
 * vault for a lease: a private folder that is removed
 *   - when the step ends, whether it worked, failed or was cancelled (use / release),
 *   - when the job that owns it ends, before the job is reported as finished (purge by job),
 *   - when its video or reel is deleted (purge by source / short),
 *   - when it outlives its time to live, in case something hung (sweep),
 *   - when the server stops, and at the next start for anything a crash left behind (purgeAll / ready).
 * Reels are only reported ready after their frames are gone. Nothing outside this folder is ever deleted. */
export type FrameOwner = {
  /** The workspace the lease belongs to (its folder), so one visitor's clean-up never reaches another's. */
  scope?: string;
  sourceId?: string | null;
  shortId?: string | null;
  jobId?: string | null;
  /** What the frames are for (logs and tests only). */
  label: string;
};
export type FrameLease = { readonly id: string; readonly dir: string; readonly owner: Readonly<FrameOwner>; readonly created: number };
export type FrameMatch = Partial<Pick<FrameOwner, 'scope' | 'sourceId' | 'shortId' | 'jobId'>>;
export type FrameVaultOptions = { ttlMs?: number; now?: () => number; onError?: (message: string, error: unknown) => void };

/** Present in every folder this class manages; a folder without it is never emptied (a mistyped path cannot wipe data). */
export const FRAME_MARKER = '.sprityreels-frames';
const LEASE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KEYS = ['scope', 'sourceId', 'shortId', 'jobId'] as const;

export class FrameVault {
  private leases = new Map<string, FrameLease>();
  /** Folders that could not be removed yet (a file still open on Windows): retried by every sweep. */
  private stuck = new Set<string>();
  private prepared?: Promise<void>;
  private timer?: NodeJS.Timeout;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(readonly root: string, private options: FrameVaultOptions = {}) {
    if (!path.isAbsolute(root)) throw new Error('The frame folder must be an absolute path.');
    this.ttlMs = options.ttlMs ?? 2 * 3600_000;
    this.now = options.now ?? Date.now;
  }

  /** Creates the folder and removes whatever an earlier run left in it. Runs once; every other call waits for it. */
  ready() {
    return this.prepared ??= (async () => {
      await mkdir(this.root, { recursive: true });
      const names = await readdir(this.root);
      if (names.length && !names.includes(FRAME_MARKER)) throw new Error(`${this.root} is not a Sprity Reels frame folder (the marker file is missing), so it was left alone.`);
      if (!names.includes(FRAME_MARKER)) await writeFile(path.join(this.root, FRAME_MARKER), 'Working frames of Sprity Reels. Everything in this folder is deleted when the work ends.\n');
      for (const name of names) if (name !== FRAME_MARKER) await this.remove(path.join(this.root, name));
    })();
  }

  /** A new private folder for one step's frames. */
  async open(owner: FrameOwner): Promise<FrameLease> {
    await this.ready();
    const id = randomUUID(), dir = path.join(this.root, id);
    await mkdir(dir);
    const lease: FrameLease = { id, dir, owner: Object.freeze({ ...owner }), created: this.now() };
    this.leases.set(id, lease);
    return lease;
  }

  /** Removes the lease's folder. Safe to call twice and never throws: a folder that cannot go yet is retried by the sweep. */
  async release(lease: FrameLease) {
    this.leases.delete(lease.id);
    await this.remove(lease.dir);
  }

  /** Runs `work` with a lease and removes it afterwards, however the work ends. */
  async use<T>(owner: FrameOwner, work: (dir: string, lease: FrameLease) => Promise<T>): Promise<T> {
    const lease = await this.open(owner);
    try { return await work(lease.dir, lease); }
    finally { await this.release(lease); }
  }

  /** Removes every lease that carries all of the given ids. An empty match removes nothing (use purgeAll for that). */
  async purge(match: FrameMatch) {
    const wanted = KEYS.filter(key => match[key] !== undefined);
    if (!wanted.length) return 0;
    const hit = [...this.leases.values()].filter(lease => wanted.every(key => lease.owner[key] === match[key]));
    await Promise.all(hit.map(lease => this.release(lease)));
    return hit.length;
  }

  /** Removes every lease and every folder in the vault, including leftovers nobody owns. */
  async purgeAll() {
    await this.ready();
    const count = this.leases.size;
    await Promise.all([...this.leases.values()].map(lease => this.release(lease)));
    for (const name of await readdir(this.root).catch(() => [] as string[])) if (name !== FRAME_MARKER) await this.remove(path.join(this.root, name));
    return count;
  }

  /** Removes leases older than the time to live (something hung), folders nobody owns that are that old, and retries stuck ones. */
  async sweep(maxAgeMs = this.ttlMs) {
    await this.ready();
    const now = this.now();
    let removed = 0;
    for (const lease of [...this.leases.values()]) if (now - lease.created > maxAgeMs) { await this.release(lease); removed++; }
    for (const dir of [...this.stuck]) { await this.remove(dir); if (!this.stuck.has(dir)) removed++; }
    for (const name of await readdir(this.root).catch(() => [] as string[])) {
      if (!LEASE_ID.test(name) || this.leases.has(name)) continue;
      const dir = path.join(this.root, name), age = now - ((await stat(dir).catch(() => null))?.mtimeMs ?? now);
      if (age > maxAgeMs) { await this.remove(dir); removed++; }
    }
    return removed;
  }

  /** Sweeps on a timer that never keeps the process alive. Returns a function that stops it. */
  startSweeper(everyMs = 60_000) {
    this.timer ??= setInterval(() => { void this.sweep().catch(error => this.options.onError?.('The frame sweep failed.', error)); }, everyMs);
    this.timer.unref();
    return () => this.stopSweeper();
  }
  stopSweeper() { if (this.timer) { clearInterval(this.timer); this.timer = undefined; } }

  /** Stops the sweeper and removes everything. */
  async close() { this.stopSweeper(); return this.purgeAll(); }

  /** Leases in use right now (for tests and the operator's log). */
  active() { return [...this.leases.values()].map(lease => ({ id: lease.id, label: lease.owner.label, ageMs: this.now() - lease.created })); }
  get size() { return this.leases.size; }
  /** Files on disk below the vault (the marker excluded): 0 whenever no step is working on frames. */
  async files() {
    let count = 0;
    const walk = async (dir: string) => {
      for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
        if (entry.isDirectory()) await walk(path.join(dir, entry.name)); else if (dir !== this.root || entry.name !== FRAME_MARKER) count++;
      }
    };
    await walk(this.root);
    return count;
  }

  /** Only ever removes something directly inside the vault folder. */
  private async remove(dir: string) {
    if (path.dirname(dir) !== this.root) return;
    try { await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 }); this.stuck.delete(dir); }
    catch (error) { this.stuck.add(dir); this.options.onError?.('Frames could not be deleted yet; they will be retried.', error); }
  }
}
