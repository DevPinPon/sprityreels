import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ClipWord } from '../src/engine/clips/types';
import { createApp } from '../server/app';
import type { ClipTools } from '../server/clips/tools';
import { run } from '../server/clips/tools';
import { LANES } from '../server/scheduler';
import type { Lane } from '../server/scheduler';

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
async function until<T>(read: () => T | Promise<T>, done: (v: T) => boolean, ms = 180_000) {
  const end = Date.now() + ms;
  for (;;) { const v = await read(); if (done(v)) return v; if (Date.now() > end) throw new Error(`Timed out: ${JSON.stringify(v).slice(0, 300)}`); await sleep(40); }
}
const testTools = async (): Promise<ClipTools> => ({ ytdlp: null, whisper: null, whisperModel: null, whisperGpu: null, ffmpeg: true, nvenc: false, fonts: path.resolve('public/fonts/clips'), cacheDir: tmpdir() });
const words = (): ClipWord[] => 'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen'.split(' ').map((t, i) => ({ t, s: i * .5, e: i * .5 + .4 }));

test('twelve visitors at once on a small machine: every one is served, the lanes never run over their slots, work waited its turn, nobody sees anybody else’s files, and no frame is left', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'sprityreels-crowd-')); t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  const file = path.join(root, 'v.mp4');
  await run('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=15:d=8', '-f', 'lavfi', '-i', "aevalsrc='0.2*sin(2*PI*220*t)':s=16000:d=8", '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-t', '8', file], { timeout: 60_000 });
  const capacity = { gpu: 1, prep: 2, render: 2, scan: 1, track: 1 };
  let origin = '';
  const app = createApp({ root, dataDir: path.join(root, 'data'), origin: () => origin, minFreeBytes: 0, capacity, operatorKey: 'operator-key-0123456789', resolveHost: async () => [{ address: '93.184.216.34' }],
    service: { tools: testTools, directors: {}, transcriber: async () => { await sleep(150); return { words: words(), language: 'en', model: 'test' }; } } });
  const http = createServer((req, res) => void app.handle(req, res, () => { res.statusCode = 404; res.end(); }));
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  t.after(async () => { http.closeAllConnections(); await new Promise<void>(r => http.close(() => r())); await app.dispose(); });

  // Watch the lanes the whole time.
  const peak = Object.fromEntries(LANES.map(l => [l, { running: 0, waiting: 0 }])) as Record<Lane, { running: number; waiting: number }>;
  let maxLeases = 0, sawQueue = 0;
  const watcher = setInterval(() => { const s = app.scheduler.stats(); for (const lane of LANES) { peak[lane].running = Math.max(peak[lane].running, s.lanes[lane].running); peak[lane].waiting = Math.max(peak[lane].waiting, s.lanes[lane].queued); } maxLeases = Math.max(maxLeases, app.frames.size); }, 5);
  t.after(() => clearInterval(watcher));

  const bytes = await readFile(file), N = 12, started = Date.now();
  const visitor = async () => {
    let cookie = '';
    const call = async (route: string, body?: unknown) => {
      const res = await fetch(origin + '/api/clips' + route, body === undefined ? { headers: cookie ? { Cookie: cookie } : {} } : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-SprityReels-Request': 'clips', ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) });
      const set = res.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
      return { status: res.status, data: await res.json().catch(() => null) as any };
    };
    const up = await fetch(origin + '/api/clips/sources/upload?file=v.mp4&rights=own&watch=false', { method: 'POST', headers: { 'X-SprityReels-Request': 'clips' }, body: bytes });
    cookie = (up.headers.get('set-cookie') ?? '').split(';')[0];
    assert.equal(up.status, 202);
    const source = (await up.json() as any).source.id as string;
    await until(async () => { const d = (await call(`/sources/${source}`)).data; if (d.jobs.some((j: { queue?: unknown }) => j.queue)) sawQueue++; return d.source.status; }, s => s === 'ready');
    const made = await call('/shorts', { sourceId: source, start: 1, end: 6, render: true, options: { layout: 'center', captions: { enabled: false }, hook: { enabled: false } } });
    assert.equal(made.status, 201, JSON.stringify(made.data));
    const short = made.data.short.id as string;
    const done = await until(async () => (await call(`/shorts/${short}`)).data.render, r => !!r && r.status !== 'queued' && r.status !== 'rendering');
    return { call, source, short, done };
  };
  const results = await Promise.all(Array.from({ length: N }, visitor));
  clearInterval(watcher);
  const seconds = (Date.now() - started) / 1000;
  console.log(`# ${N} visitors, ${seconds.toFixed(1)} s, peaks ${JSON.stringify(peak)}, queue seen by ${sawQueue} polls`);

  for (const r of results) assert.equal(r.done.status, 'done', JSON.stringify(r.done));
  for (const lane of LANES) if (lane in capacity) assert.ok(peak[lane].running <= (capacity as Record<string, number>)[lane], `${lane} ran ${peak[lane].running} at once with ${(capacity as Record<string, number>)[lane]} slots`);
  assert.equal(peak.render.running, 2, 'the render lane was full: the machine was kept busy');
  assert.ok(peak.render.waiting >= 4, `renders waited in line (${peak.render.waiting} at most)`);
  assert.ok(peak.gpu.waiting >= 3, `speech recognition waited in line (${peak.gpu.waiting} at most)`);
  assert.ok(sawQueue > 0, 'visitors were shown that they were waiting');
  // Everyone has only their own work.
  for (const r of results) {
    const overview = (await r.call('')).data;
    assert.equal(overview.sources.length, 1); assert.equal(overview.sources[0].id, r.source); assert.equal(overview.shorts.length, 1); assert.equal(overview.shorts[0].id, r.short);
  }
  assert.equal(new Set(results.map(r => r.short)).size, N);
  // The machine is idle again and holds no frame.
  assert.deepEqual(app.scheduler.stats().backlog, 0);
  assert.equal(await app.frames.files(), 0); assert.equal(app.frames.size, 0);
  const metrics = await (await fetch(origin + '/api/metrics', { headers: { 'X-Operator-Key': 'operator-key-0123456789' } })).text();
  assert.match(metrics, /^sprityreels_backlog 0$/m); assert.match(metrics, /^sprityreels_lane_running\{lane="render"\} 0$/m); assert.match(metrics, /^sprityreels_workspaces_loaded 12$/m);
  void maxLeases;
});
