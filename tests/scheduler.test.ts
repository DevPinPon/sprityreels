import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ClipWord } from '../src/engine/clips/types';
import { createApp } from '../server/app';
import { ClipStudioService } from '../server/clips/service';
import type { ClipTools } from '../server/clips/tools';
import { run } from '../server/clips/tools';
import { Busy, Cancelled, LANES, SOLO_CAPACITY, Scheduler, machineCapacity, parseCapacity } from '../server/scheduler';

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
async function until<T>(read: () => T | Promise<T>, done: (v: T) => boolean, ms = 60_000) {
  const end = Date.now() + ms;
  for (;;) { const v = await read(); if (done(v)) return v; if (Date.now() > end) throw new Error(`Timed out: ${JSON.stringify(v).slice(0, 300)}`); await sleep(20); }
}
type Gate = { promise: Promise<void>; resolve: () => void };
const deferred = (): Gate => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
const caps = (over: Partial<typeof SOLO_CAPACITY> = {}) => ({ ...SOLO_CAPACITY, ...over });

// ------------------------------------------------------------ the scheduler on its own
test('a lane never runs more steps at once than it has slots, however many visitors ask', async () => {
  const scheduler = new Scheduler(caps({ render: 3 }));
  let now = 0, peak = 0, finished = 0;
  await Promise.all(Array.from({ length: 200 }, (_, v) => Array.from({ length: 3 }, async () => {
    await scheduler.run('render', `visitor-${v}`, undefined, async () => { peak = Math.max(peak, ++now); await sleep(1); now--; finished++; });
  })).flat());
  assert.equal(finished, 600); assert.equal(peak, 3); assert.equal(scheduler.backlog(), 0);
  assert.deepEqual(scheduler.stats().lanes.render, { capacity: 3, running: 0, queued: 0 });
});

test('the queue is fair: one visitor asking for twenty reels cannot hold up another asking for one', async () => {
  const scheduler = new Scheduler(caps({ render: 1 })), order: string[] = [], gates: Gate[] = [];
  const job = (owner: string, name: string) => scheduler.run('render', owner, undefined, async () => { order.push(name); const g = deferred(); gates.push(g); await g.promise; });
  const all = [...Array.from({ length: 8 }, (_, i) => job('greedy', `greedy-${i}`)), job('polite', 'polite-0')];
  await until(() => order.length, n => n === 1);
  assert.deepEqual(order, ['greedy-0']);
  gates[0].resolve();
  await until(() => order.length, n => n === 2);
  assert.equal(order[1], 'polite-0', 'the visitor with nothing running goes before the greedy visitor’s second step');
  for (let i = 1; i < 9; i++) { await until(() => gates[i], g => !!g); gates[i].resolve(); }
  await Promise.all(all);
  assert.deepEqual(order.slice(2), Array.from({ length: 7 }, (_, i) => `greedy-${i + 1}`), 'the rest follow in order');
});

test('with several slots the slots are shared out evenly, and every visitor is served before anyone is served twice', async () => {
  const scheduler = new Scheduler(caps({ scan: 3 })), started: string[] = [], gates: Gate[] = [];
  // Every visitor asks for two steps (the first of each, then the second of each).
  const all = [0, 1].flatMap(() => Array.from({ length: 30 }, (_, v) => scheduler.run('scan', `v${v}`, undefined, async () => { started.push(`v${v}`); const g = deferred(); gates.push(g); await g.promise; })));
  for (let n = 0; n < 60; n++) { await until(() => gates.length, g => g > n); gates[n].resolve(); }
  await Promise.all(all);
  assert.equal(new Set(started.slice(0, 30)).size, 30, 'the first thirty steps belong to thirty different visitors');
});

test('a step cancelled while it waits never runs and frees nothing it did not hold', async () => {
  const scheduler = new Scheduler(caps({ gpu: 1 })), gate = deferred(), ran: string[] = [];
  const first = scheduler.run('gpu', 'a', undefined, async () => { ran.push('first'); await gate.promise; });
  await until(() => ran.length, n => n === 1);
  const cancel = new AbortController();
  const waiting = scheduler.run('gpu', 'b', cancel.signal, async () => { ran.push('cancelled'); });
  const behind = scheduler.run('gpu', 'c', undefined, async () => { ran.push('behind'); });
  await sleep(20);
  assert.equal(scheduler.stats().lanes.gpu.queued, 2);
  cancel.abort();
  await assert.rejects(waiting, (e: Error) => e instanceof Cancelled);
  assert.equal(scheduler.stats().lanes.gpu.queued, 1);
  gate.resolve(); await first; await behind;
  assert.deepEqual(ran, ['first', 'behind']);
  assert.deepEqual(scheduler.stats().lanes.gpu, { capacity: 1, running: 0, queued: 0 });
  await assert.rejects(scheduler.run('gpu', 'd', AbortSignal.abort(), async () => 1), /abort/i, 'a signal that is already aborted never queues');
});

test('a waiting step is told how many start before it, then that it is running', async () => {
  const scheduler = new Scheduler(caps({ render: 1 })), gate = deferred(), heard: Record<string, (number | null)[]> = { b: [], c: [] };
  const a = scheduler.run('render', 'a', undefined, () => gate.promise);
  const b = scheduler.run('render', 'b', undefined, async () => {}, n => heard.b.push(n));
  const c = scheduler.run('render', 'c', undefined, async () => {}, n => heard.c.push(n));
  await sleep(300);
  assert.equal(heard.b.at(-1), 0, 'b is next'); assert.equal(heard.c.at(-1), 1, 'c has one ahead');
  gate.resolve(); await Promise.all([a, b, c]);
  assert.equal(heard.b.at(-1), null); assert.equal(heard.c.at(-1), null);
  assert.ok(heard.c.includes(1) && heard.c.indexOf(1) < heard.c.length - 1);
});

test('new work is refused while the backlog is full, and a visitor cannot queue without limit', async () => {
  const scheduler = new Scheduler(caps({ render: 1, net: 1 }), { maxBacklog: 3, maxQueuedPerOwner: 2 }), gate = deferred();
  const blocker = scheduler.run('render', 'x', undefined, () => gate.promise);
  const waits = ['a', 'b'].map(o => scheduler.run('render', o, undefined, async () => {}));
  await sleep(10);
  scheduler.admit(1);
  assert.equal(scheduler.backlog(), 2);
  const third = scheduler.run('render', 'c', undefined, async () => {});
  await sleep(10);
  assert.throws(() => scheduler.admit(1), (e: Error) => e instanceof Busy && /very busy/.test(e.message) && (e as Busy).retryAfter > 0);
  assert.doesNotThrow(() => scheduler.admit(0));
  // Waiting for the network is not heavy work: it does not count.
  const net = scheduler.run('net', 'n', undefined, () => gate.promise); const netWaiting = scheduler.run('net', 'm', undefined, async () => {});
  await sleep(10);
  assert.equal(scheduler.backlog(), 3);
  // One visitor's own limit.
  const p1 = scheduler.run('render', 'greedy', undefined, async () => {}), p2 = scheduler.run('render', 'greedy', undefined, async () => {});
  await assert.rejects(scheduler.run('render', 'greedy', undefined, async () => {}), (e: Error) => e instanceof Busy && /too many steps/.test(e.message));
  gate.resolve(); await Promise.all([blocker, ...waits, third, net, netWaiting, p1, p2]);
  assert.equal(scheduler.backlog(), 0);
});

test('slots can be changed while steps wait', async () => {
  const scheduler = new Scheduler(caps({ render: 1 })), gate = deferred(); let running = 0;
  const all = Array.from({ length: 4 }, (_, i) => scheduler.run('render', `v${i}`, undefined, async () => { running++; await gate.promise; }));
  await until(() => running, n => n === 1);
  scheduler.retune({ render: 3 });
  await until(() => running, n => n === 3);
  assert.equal(scheduler.capacity.render, 3);
  gate.resolve(); await Promise.all(all);
});

test('slots follow the machine, and the operator can set any of them', () => {
  assert.deepEqual(machineCapacity({ cores: 4, memoryGB: 16 }), { net: 4, prep: 2, ai: 8, gpu: 1, render: 1, track: 1, scan: 1 });
  assert.deepEqual(machineCapacity({ cores: 32, memoryGB: 64 }), { net: 4, prep: 16, ai: 8, gpu: 2, render: 8, track: 4, scan: 8 });
  assert.equal(machineCapacity({ cores: 32, memoryGB: 3 }).track, 2, 'memory limits the trackers (each is a browser)');
  assert.equal(machineCapacity({ cores: 8, memoryGB: 32, gpu: true }).gpu, 1);
  assert.equal(machineCapacity({ cores: 16, memoryGB: 32, nvenc: true }).render, 3);
  assert.deepEqual(parseCapacity('render=3, track=2,bogus=9,scan=0,gpu=x,net=100'), { render: 3, track: 2 });
  assert.deepEqual(parseCapacity(undefined), {});
  assert.deepEqual(new Set(LANES), new Set(Object.keys(SOLO_CAPACITY)));
});

// ------------------------------------------------------------ studios that share the machine
const testTools = async (): Promise<ClipTools> => ({ ytdlp: null, whisper: null, whisperModel: null, whisperGpu: null, ffmpeg: true, nvenc: false, fonts: path.resolve('public/fonts/clips'), cacheDir: tmpdir() });
async function tone(file: string, seconds = 6) {
  await run('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=0x405060:s=160x90:r=10:d=${seconds}`, '-f', 'lavfi', '-i', `aevalsrc='0.3*sin(2*PI*220*t)':s=16000:d=${seconds}`, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-t', String(seconds), file], { timeout: 60_000 });
}
const words = (): ClipWord[] => 'one two three four five six seven eight nine ten'.split(' ').map((t, i) => ({ t, s: i * .5, e: i * .5 + .4 }));

test('two visitors share one speech-recognition slot: the second waits, is told so, and starts when the first is done', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'sprityreels-share-')); t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  const file = path.join(root, 'v.mp4'); await tone(file);
  const scheduler = new Scheduler(caps({ gpu: 1 })), gate = deferred(), calls: string[] = [];
  const studio = (name: string, gated: boolean) => new ClipStudioService(path.join(root, name), { projectRoot: root, tools: testTools, scheduler, directors: {}, launcher: { find: async () => null, open: async () => ({ stop: async () => {} }) },
    transcriber: async () => { calls.push(name); if (gated) await gate.promise; return { words: words(), language: 'en', model: 'test' }; } });
  const first = studio('first', true), second = studio('second', false);
  t.after(async () => { await first.dispose(); await second.dispose(); });
  const upload = (service: ClipStudioService) => { async function* body() { yield new Uint8Array(await readFile(file)); } return service.importUpload('v.mp4', body(), 0, { rights: 'own', watch: 'false' }); };
  const a = await upload(first);
  await until(() => calls, c => c.includes('first'));
  const b = await upload(second);
  const waiting = await until(() => second.job(b.job.id), j => !!j.queue);
  assert.equal(waiting.queue!.lane, 'gpu'); assert.equal(waiting.queue!.ahead, 0);
  assert.deepEqual(calls, ['first'], 'the second visitor’s speech recognition has not started');
  gate.resolve();
  const done = await until(() => second.job(b.job.id), j => j.status !== 'running' && j.status !== 'queued');
  assert.equal(done.status, 'done', JSON.stringify(done)); assert.equal(done.queue, null);
  assert.deepEqual(calls, ['first', 'second']);
  assert.equal((await until(() => first.job(a.job.id), j => j.status !== 'running' && j.status !== 'queued')).status, 'done');
});

test('work is refused up front, before anything is stored, when the machine is full or a visitor has too much going on', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'sprityreels-admit-')); t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  const full = new ClipStudioService(path.join(root, 'full'), { projectRoot: root, tools: testTools, directors: {}, scheduler: new Scheduler(caps(), { maxBacklog: 0 }) });
  t.after(() => full.dispose());
  async function* body() { yield new Uint8Array([1, 2, 3]); }
  await assert.rejects(full.importUpload('v.mp4', body(), 3, { rights: 'own' }), (e: { status?: number; retryAfter?: number }) => e.status === 503 && (e.retryAfter ?? 0) > 0);
  await assert.rejects(full.importLink({ url: 'https://www.youtube.com/watch?v=abcdefghijk', rights: 'own' }), (e: { status?: number }) => e.status === 503);
  assert.deepEqual(await full.listSources(), [], 'nothing was stored for work that was refused');
  const busy = new ClipStudioService(path.join(root, 'busy'), { projectRoot: root, tools: testTools, directors: {}, maxActiveJobs: 0 });
  t.after(() => busy.dispose());
  await assert.rejects(busy.importUpload('v.mp4', body(), 3, { rights: 'own' }), (e: { status?: number; message?: string }) => e.status === 429 && /work in progress/.test(e.message ?? ''));
});

test('the website answers 503 with Retry-After while the machine is full', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'sprityreels-http-')); t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  let origin = '';
  const app = createApp({ root, dataDir: path.join(root, 'data'), origin: () => origin, maxBacklog: 0, resolveHost: async () => [{ address: '93.184.216.34' }], service: { tools: testTools, directors: {} } });
  const http = createServer((req, res) => void app.handle(req, res, () => { res.statusCode = 404; res.end(); }));
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  t.after(async () => { http.closeAllConnections(); await new Promise<void>(r => http.close(() => r())); await app.dispose(); });
  const res = await fetch(origin + '/api/clips/sources', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-SprityReels-Request': 'clips' }, body: JSON.stringify({ url: 'https://www.youtube.com/watch?v=abcdefghijk', rights: 'own' }) });
  assert.equal(res.status, 503); assert.equal(res.headers.get('retry-after'), '120');
  assert.match((await res.json() as { error: string }).error, /very busy/);
  assert.equal(app.scheduler.stats().backlog, 0);
});
