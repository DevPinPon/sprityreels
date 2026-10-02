import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { brotliCompressSync, brotliDecompressSync, gunzipSync, gzipSync } from 'node:zlib';
import type { ClipWord } from '../src/engine/clips/types';
import { createApp } from '../server/app';
import { encoderArgs } from '../server/clips/render';
import { ClipStudioService } from '../server/clips/service';
import type { ClipTools } from '../server/clips/tools';
import { run } from '../server/clips/tools';
import { serveStatic } from '../server/static';

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
async function until<T>(read: () => T | Promise<T>, done: (v: T) => boolean, ms = 60_000) {
  const end = Date.now() + ms;
  for (;;) { const v = await read(); if (done(v)) return v; if (Date.now() > end) throw new Error(`Timed out: ${JSON.stringify(v).slice(0, 300)}`); await sleep(30); }
}
const testTools = async (): Promise<ClipTools> => ({ ytdlp: null, whisper: null, whisperModel: null, whisperGpu: null, ffmpeg: true, nvenc: false, fonts: path.resolve('public/fonts/clips'), cacheDir: tmpdir() });
/** A raw request: no transparent decompression, so the bytes the server sent are what the test sees. */
function raw(url: string, headers: Record<string, string> = {}, method = 'GET') {
  return new Promise<{ status: number; headers: IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
    const req = request(url, { method, headers }, res => { const chunks: Buffer[] = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) })); });
    req.on('error', reject); req.end();
  });
}

test('the site sends the precompressed copy a browser accepts, and the plain file to everything else', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'sprityreels-static-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const js = Buffer.from(`console.log(${JSON.stringify('x'.repeat(5000))});`), html = Buffer.from('<!doctype html><title>t</title>' + '<p>hello</p>'.repeat(300));
  await mkdir(path.join(dir, 'assets'));
  await writeFile(path.join(dir, 'assets', 'app-1.js'), js); await writeFile(path.join(dir, 'assets', 'app-1.js.br'), brotliCompressSync(js)); await writeFile(path.join(dir, 'assets', 'app-1.js.gz'), gzipSync(js));
  await writeFile(path.join(dir, 'index.html'), html); await writeFile(path.join(dir, 'index.html.gz'), gzipSync(html));
  await writeFile(path.join(dir, 'solo.js'), js);
  await writeFile(path.join(dir, 'model.wasm'), js); await writeFile(path.join(dir, 'model.wasm.br'), brotliCompressSync(js));
  const handler = serveStatic(dir), http = createServer((req, res) => void handler(req, res, () => { res.statusCode = 404; res.end(); }));
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve)); t.after(() => { http.closeAllConnections(); http.close(); });
  const base = `http://127.0.0.1:${(http.address() as { port: number }).port}`;

  const br = await raw(base + '/assets/app-1.js', { 'Accept-Encoding': 'gzip, deflate, br' });
  assert.equal(br.status, 200); assert.equal(br.headers['content-encoding'], 'br'); assert.equal(br.headers['vary'], 'Accept-Encoding');
  assert.equal(Number(br.headers['content-length']), br.body.length); assert.deepEqual(brotliDecompressSync(br.body), js);
  assert.equal(br.headers['content-type'], 'text/javascript; charset=utf-8'); assert.match(String(br.headers['cache-control']), /immutable/);
  assert.ok(br.body.length < js.length / 10, 'much less is sent');
  const gz = await raw(base + '/assets/app-1.js', { 'Accept-Encoding': 'gzip' });
  assert.equal(gz.headers['content-encoding'], 'gzip'); assert.deepEqual(gunzipSync(gz.body), js);
  for (const header of [{}, { 'Accept-Encoding': 'identity' }, { 'Accept-Encoding': 'br;q=0, gzip;q=0' }] as Record<string, string>[]) {
    const plain = await raw(base + '/assets/app-1.js', header);
    assert.equal(plain.headers['content-encoding'], undefined); assert.deepEqual(plain.body, js);
  }
  assert.equal((await raw(base + '/solo.js', { 'Accept-Encoding': 'br' })).headers['content-encoding'], undefined, 'no compressed copy, no encoding');
  assert.equal((await raw(base + '/model.wasm', { 'Accept-Encoding': 'br' })).headers['content-encoding'], undefined, 'only text files are negotiated');
  const page = await raw(base + '/app', { 'Accept-Encoding': 'gzip' });
  assert.equal(page.headers['content-encoding'], 'gzip', 'page routes fall back to index.html and are compressed too'); assert.deepEqual(gunzipSync(page.body), html);
  const head = await raw(base + '/assets/app-1.js', { 'Accept-Encoding': 'br' }, 'HEAD');
  assert.equal(head.headers['content-encoding'], 'br'); assert.equal(head.body.length, 0);
});

// ------------------------------------------------------------ a studio with a finished reel on disk
async function tone(file: string, seconds = 8) {
  await run('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=0x405060:s=160x90:r=10:d=${seconds}`, '-f', 'lavfi', '-i', `aevalsrc='0.3*sin(2*PI*220*t)':s=16000:d=${seconds}`, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-t', String(seconds), file], { timeout: 60_000 });
}
const words = (): ClipWord[] => 'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen'.split(' ').map((t, i) => ({ t, s: i * .5, e: i * .5 + .4 }));
async function studio(t: { after: (fn: () => unknown) => void }) {
  const root = await mkdtemp(path.join(tmpdir(), 'sprityreels-serve-'));
  let origin = '';
  const app = createApp({ root, dataDir: path.join(root, 'data'), origin: () => origin, resolveHost: async () => [{ address: '93.184.216.34' }], minFreeBytes: 0, service: { tools: testTools, directors: {}, transcriber: async () => ({ words: words(), language: 'en', model: 'test' }) } });
  const http = createServer((req, res) => void app.handle(req, res, () => { res.statusCode = 404; res.end(); }));
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  t.after(async () => { http.closeAllConnections(); await new Promise<void>(r => http.close(() => r())); await app.dispose(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });
  let cookie = '';
  const call = async (route: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(origin + '/api/clips' + route, body === undefined ? { headers: { ...(cookie ? { Cookie: cookie } : {}), ...headers } } : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-SprityReels-Request': 'clips', ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: JSON.stringify(body) });
    const set = res.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
    return { res, status: res.status, data: await res.clone().json().catch(() => null) as any };
  };
  const file = path.join(root, 'v.mp4'); await tone(file);
  const up = await fetch(origin + '/api/clips/sources/upload?file=v.mp4&rights=own&watch=false', { method: 'POST', headers: { 'X-SprityReels-Request': 'clips' }, body: await readFile(file) });
  cookie = (up.headers.get('set-cookie') ?? '').split(';')[0];
  const source = (await up.json() as any).source.id as string;
  await until(async () => (await call(`/sources/${source}`)).data.source.status, s => s === 'ready');
  const short = (await call('/shorts', { sourceId: source, start: 1, end: 6 })).data.short.id as string;
  const dir = path.join(root, 'data', 'workspaces', cookie.split('=')[1], 'clips', 'shorts', short);
  return { root, app, call, origin, source, short, dir, cookie: () => cookie };
}

test('a reel that is played again is not sent again, and a range is only honoured for the version the browser holds', async t => {
  const s = await studio(t);
  const mp4 = Buffer.from(Array.from({ length: 5000 }, (_, i) => i % 251)); await writeFile(path.join(s.dir, 'output.mp4'), mp4);
  const url = `${s.origin}/api/clips/shorts/${s.short}/video`, auth = { Cookie: s.cookie() };
  const first = await raw(url, auth);
  assert.equal(first.status, 200); assert.deepEqual(first.body, mp4);
  const etag = String(first.headers['etag']); assert.match(etag, /^"[0-9a-f]+-[0-9a-f]+"$/);
  assert.equal(first.headers['cache-control'], 'private, no-cache'); assert.ok(first.headers['last-modified']);
  const again = await raw(url, { ...auth, 'If-None-Match': etag });
  assert.equal(again.status, 304); assert.equal(again.body.length, 0);
  assert.equal((await raw(url, { ...auth, 'If-None-Match': `W/${etag}, "other"` })).status, 304);
  assert.equal((await raw(url, { ...auth, 'If-None-Match': '"other"' })).status, 200);
  // Seeking: a range for the version the browser has gets the slice; for a stale one it gets the whole new file.
  const slice = await raw(url, { ...auth, Range: 'bytes=100-199', 'If-Range': etag });
  assert.equal(slice.status, 206); assert.deepEqual(slice.body, mp4.subarray(100, 200)); assert.equal(slice.headers['content-range'], `bytes 100-199/${mp4.length}`);
  const stale = await raw(url, { ...auth, Range: 'bytes=100-199', 'If-Range': '"old-version"' });
  assert.equal(stale.status, 200); assert.equal(stale.body.length, mp4.length);
  assert.equal((await raw(url, { ...auth, Range: 'bytes=100-199' })).status, 206, 'a range with no condition works as before');
  assert.equal((await raw(url, { ...auth, Range: 'bytes=999999-' })).status, 416);
  // Rendering again gives a new file, so the old validator no longer matches.
  const fresh = Buffer.from(mp4); fresh[0] = 255; await writeFile(path.join(s.dir, 'output.mp4'), fresh); const later = new Date(Date.now() + 5000); await utimes(path.join(s.dir, 'output.mp4'), later, later);
  const changed = await raw(url, { ...auth, 'If-None-Match': etag });
  assert.equal(changed.status, 200); assert.notEqual(changed.headers['etag'], etag);
  assert.equal((await raw(url)).status, 404, 'another visitor (no cookie) gets nothing, validator or not');
});

test('a screen that is polled by many reuses its answer for a moment, but never after a change', async t => {
  const s = await studio(t);
  const before = (await s.call(`/sources/${s.source}`)).data;
  assert.equal(before.shorts.length, 1);
  // The same answer for everyone asking inside the window.
  const detail = (id: string) => s.call(`/sources/${id}`);
  const [a, b] = await Promise.all([detail(s.source), detail(s.source)]);
  assert.deepEqual(a.data, b.data);
  // A change by the visitor shows at once.
  assert.equal((await s.call(`/shorts/${s.short}/delete`, {})).status, 200);
  assert.equal((await detail(s.source)).data.shorts.length, 0, 'the deleted reel is gone from the very next answer, not 750 ms later');
  const made = (await s.call('/shorts', { sourceId: s.source, start: 1, end: 6 })).data.short.id;
  assert.equal((await detail(s.source)).data.shorts.length, 1); assert.ok(made);
});

test('the answer is reused inside its window and rebuilt after it, and the overview leaves out the usage ledger', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'sprityreels-cache-')); t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  const file = path.join(root, 'v.mp4'); await tone(file);
  const service = new ClipStudioService(path.join(root, 'clips'), { projectRoot: root, tools: testTools, directors: {}, cacheMs: 150, transcriber: async () => ({ words: words(), language: 'en', model: 'test' }), launcher: { find: async () => null, open: async () => ({ stop: async () => {} }) } });
  t.after(() => service.dispose());
  async function* body() { yield new Uint8Array(await readFile(file)); }
  const { source, job } = await service.importUpload('v.mp4', body(), 0, { rights: 'own', watch: 'false' });
  await until(() => service.job(job.id), j => j.status !== 'running' && j.status !== 'queued');
  const one = service.sourceDetail(source.id);
  assert.equal(service.sourceDetail(source.id), one, 'asked again inside the window: the same answer');
  await sleep(200);
  assert.notEqual(service.sourceDetail(source.id), one, 'after the window it is read again');
  const two = service.sourceDetail(source.id); service.invalidate();
  assert.notEqual(service.sourceDetail(source.id), two, 'a change clears it');
  await assert.rejects(service.sourceDetail('00000000-0000-4000-8000-000000000000'), /not found/);
  assert.equal((await service.overview({ usage: false })).usage, null, 'the usage ledger, which grows with every AI call, is not read for the screens');
  assert.equal(typeof (await service.overview()).usage?.calls, 'number');
});

test('the studio screen is sent once, gzipped, and not at all again while nothing changed; shorts changed in memory show at once', async t => {
  const s = await studio(t), url = `${s.origin}/api/clips/sources/${s.source}`, auth = { Cookie: s.cookie() };
  const plain = await raw(url, auth);
  assert.equal(plain.status, 200); assert.equal(plain.headers['cache-control'], 'private, no-cache'); assert.equal(plain.headers['vary'], 'Accept-Encoding');
  const detail = JSON.parse(plain.body.toString('utf8')), etag = String(plain.headers['etag']);
  assert.equal(detail.shorts.length, 1); assert.equal(detail.source.id, s.source);
  const zipped = await raw(url, { ...auth, 'Accept-Encoding': 'gzip, br' });
  assert.equal(zipped.headers['content-encoding'], 'gzip'); assert.equal(zipped.headers['etag'], etag); assert.equal(Number(zipped.headers['content-length']), zipped.body.length);
  assert.deepEqual(JSON.parse(gunzipSync(zipped.body).toString('utf8')), detail);
  const same = await raw(url, { ...auth, 'If-None-Match': etag });
  assert.equal(same.status, 304); assert.equal(same.body.length, 0);
  // Changing a reel changes the answer (and its validator) at once, with no disk read of the reels in between.
  const renamed = await s.call(`/shorts/${s.short}`, { revision: 1, name: 'A new name' });
  assert.equal(renamed.status, 200, JSON.stringify(renamed.data));
  const after = await raw(url, { ...auth, 'If-None-Match': etag });
  assert.equal(after.status, 200); assert.notEqual(after.headers['etag'], etag);
  assert.equal(JSON.parse(after.body.toString('utf8')).shorts[0].name, 'A new name');
  const second = (await s.call('/shorts', { sourceId: s.source, start: 2, end: 7 })).data.short.id;
  assert.deepEqual(JSON.parse((await raw(url, auth)).body.toString('utf8')).shorts.map((x: { id: string }) => x.id).sort(), [s.short, second].sort());
  // What the memory says is what the disk says: a fresh studio on the same files reads the same reels.
  const again = new ClipStudioService(path.join(s.root, 'data', 'workspaces', s.cookie().split('=')[1], 'clips'), { projectRoot: s.root, tools: testTools, directors: {} });
  t.after(() => again.dispose());
  assert.deepEqual((await again.listShorts(s.source)).map(x => [x.id, x.name]).sort(), [[s.short, 'A new name'], [second, (await s.call(`/shorts/${second}`)).data.short.name]].sort());
});

// ------------------------------------------------------------ what a render costs
test('encoder settings default to the cheap ones, can be changed by the operator, and ignore nonsense', () => {
  const x264 = (env: NodeJS.ProcessEnv, threads?: number) => encoderArgs('x264', '60', { env, threads });
  assert.deepEqual(x264({}), ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-profile:v', 'high', '-g', '60']);
  assert.deepEqual(x264({ SPRITYREELS_X264_PRESET: 'medium', SPRITYREELS_X264_CRF: '19' }).slice(2, 6), ['-preset', 'medium', '-crf', '19']);
  assert.deepEqual(x264({ SPRITYREELS_X264_PRESET: 'fastest', SPRITYREELS_X264_CRF: 'high' }).slice(2, 6), ['-preset', 'veryfast', '-crf', '21'], 'a setting that is not one is ignored');
  assert.deepEqual(x264({ SPRITYREELS_X264_CRF: '99' }).slice(4, 6), ['-crf', '21']);
  assert.deepEqual(x264({}, 4).slice(-2), ['-threads', '4']);
  const nvenc = encoderArgs('nvenc', '60', { env: {} });
  assert.deepEqual([nvenc[nvenc.indexOf('-cq') + 1], nvenc[nvenc.indexOf('-maxrate') + 1], nvenc[nvenc.indexOf('-bufsize') + 1]], ['23', '12M', '24M']);
  const high = encoderArgs('nvenc', '60', { env: { SPRITYREELS_NVENC_CQ: '19', SPRITYREELS_NVENC_MAXRATE: '20M' } });
  assert.deepEqual([high[high.indexOf('-cq') + 1], high[high.indexOf('-maxrate') + 1], high[high.indexOf('-bufsize') + 1]], ['19', '20M', '40M']);
  assert.equal(encoderArgs('nvenc', '60', { env: { SPRITYREELS_NVENC_MAXRATE: 'fast' } })[encoderArgs('nvenc', '60', { env: {} }).indexOf('-maxrate') + 1], '12M');
});

test('a talking video does not get a picture pass nobody would use, an action video does, and the operator can force it', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'sprityreels-pass-')); t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  const file = path.join(root, 'v.mp4'); await tone(file, 8);
  const speech = async (): Promise<{ words: ClipWord[]; language: string; model: string }> => ({ words: words(), language: 'en', model: 'test' });
  const quiet = async (): Promise<{ words: ClipWord[]; language: string; model: string }> => ({ words: [], language: 'en', model: 'test' });
  const studio = (name: string, transcriber: typeof speech, picturePass?: 'always') => new ClipStudioService(path.join(root, name), { projectRoot: root, tools: testTools, directors: {}, transcriber, picturePass, launcher: { find: async () => null, open: async () => ({ stop: async () => {} }) } });
  const imported = async (service: ClipStudioService) => {
    t.after(() => service.dispose());
    async function* body() { yield new Uint8Array(await readFile(file)); }
    const { source, job } = await service.importUpload('v.mp4', body(), 0, { rights: 'own' });
    await until(() => service.job(job.id), j => j.status !== 'running' && j.status !== 'queued');
    return service.getSource(source.id);
  };
  const talk = await imported(studio('talk', speech));
  assert.equal(talk.stages.visual?.status, 'skipped'); assert.match(talk.stages.visual!.message, /mostly speech/); assert.equal(talk.status, 'ready');
  const forced = await imported(studio('forced', speech, 'always'));
  assert.equal(forced.stages.visual?.status, 'done');
  const action = await imported(studio('action', quiet));
  assert.equal(action.stages.visual?.status, 'done', 'a video with little speech is the one the picture pass is for');
});
