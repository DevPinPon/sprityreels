import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { MOMENT_SCHEMA } from '../src/engine/clips/moments';
import { createApp } from '../server/app';
import type { AppOptions } from '../server/app';
import type { ClipTools } from '../server/clips/tools';
import { run } from '../server/clips/tools';
import { ClaudeDirector } from '../server/directors';

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
async function until<T>(read: () => T | Promise<T>, done: (v: T) => boolean, ms = 60_000) {
  const end = Date.now() + ms;
  for (;;) { const v = await read(); if (done(v)) return v; if (Date.now() > end) throw new Error(`Timed out: ${JSON.stringify(v).slice(0, 300)}`); await sleep(30); }
}
const testTools = async (): Promise<ClipTools> => ({ ytdlp: null, whisper: null, whisperModel: null, whisperGpu: null, ffmpeg: true, nvenc: false, fonts: path.resolve('public/fonts/clips'), cacheDir: tmpdir() });
async function silentHighlight(file: string, seconds = 60) {
  await run('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=0x506070:s=320x180:r=15:d=${seconds}`, '-f', 'lavfi', '-i', `testsrc2=s=1280x180:r=15:d=3,crop=320:180:'mod(t*1500,960)':0`,
    '-f', 'lavfi', '-i', `aevalsrc='0.03*sin(2*PI*300*t)':s=48000:d=${seconds}`,
    '-filter_complex', '[1:v]setpts=PTS+40/TB[m];[0:v][m]overlay=eof_action=pass[v]', '-map', '[v]', '-map', '2:a', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-t', String(seconds), file], { timeout: 120_000 });
}
const KEY = 'sk-ant-test-0123456789abcdef';
const reply = (extra: object = {}) => ({ id: 'msg_t', type: 'message', role: 'assistant', model: 'claude-opus-5-5', stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1000, output_tokens: 200 }, content: [{ type: 'text', text: JSON.stringify({ moments: [{ kind: 'action', startSentence: -1, endSentence: -1, startSeconds: 30, endSeconds: 46, teaserStartSentence: -1, teaserEndSentence: -1, title: 'Pattern appears', hook: 'Wait for it', reason: 'the picture changes', hookScore: 7, flowScore: 7, valueScore: 7, trendScore: 5, hashtags: [], keywords: [] }] }) }], ...extra });

/** A fake Anthropic API that records requests and answers with moments. */
async function fakeApi(t: { after: (fn: () => unknown) => void }) {
  const seen: any[] = [];
  const server = createServer(async (req, res) => { const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer); seen.push(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(reply())); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise<void>(r => server.close(() => r())); });
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, seen };
}
async function site(t: { after: (fn: () => unknown) => void }, extra: Partial<AppOptions>, apiUrl?: string) {
  const root = await mkdtemp(path.join(tmpdir(), 'sprityreels-operator-'));
  let origin = '';
  const dataDir = path.join(root, 'data');
  const app = createApp({ root, dataDir, origin: () => origin, resolveHost: async () => [{ address: '93.184.216.34' }], minFreeBytes: 0, ...extra,
    service: { tools: testTools, transcriber: async () => ({ words: [], language: 'en', model: 'test' }), directors: apiUrl ? { claude: new ClaudeDirector({ apiKey: () => KEY, baseURL: apiUrl }) } : {}, ...extra.service } });
  const http = createServer((req, res) => void app.handle(req, res, () => { res.statusCode = 404; res.end(); }));
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  t.after(async () => { http.closeAllConnections(); await new Promise<void>(r => http.close(() => r())); await app.dispose(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });
  const visitor = () => {
    let cookie = '';
    const call = async (route: string, body?: unknown) => {
      const res = await fetch(origin + '/api/clips' + route, body === undefined ? { headers: cookie ? { Cookie: cookie } : {} } : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-SprityReels-Request': 'clips', ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) });
      const set = res.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
      return { status: res.status, headers: res.headers, data: await res.json().catch(() => null) as any };
    };
    return { call, upload: async (file: string) => { const res = await fetch(origin + '/api/clips/sources/upload?file=v.mp4&rights=own&watch=false', { method: 'POST', headers: { 'X-SprityReels-Request': 'clips', ...(cookie ? { Cookie: cookie } : {}) }, body: await readFile(file) }); const set = res.headers.get('set-cookie'); if (set) cookie = set.split(';')[0]; return (await res.json() as any).source.id as string; } };
  };
  return { root, dataDir, app, origin, visitor };
}

test('metrics are for the operator only: no key, no endpoint; with one, queue depth and spend for monitoring and autoscaling', async t => {
  const off = await site(t, {});
  assert.equal((await fetch(off.origin + '/api/metrics')).status, 404, 'without an operator key the endpoint does not exist');
  assert.equal((await fetch((await site(t, { operatorKey: 'too-short' })).origin + '/api/metrics', { headers: { 'X-Operator-Key': 'too-short' } })).status, 404, 'a key that is easy to guess does not count');
  const key = 'operator-secret-0123456789', on = await site(t, { operatorKey: key, capacity: { render: 3 } });
  assert.equal((await fetch(on.origin + '/api/metrics')).status, 401);
  assert.equal((await fetch(on.origin + '/api/metrics', { headers: { 'X-Operator-Key': 'operator-secret-0123456780' } })).status, 401);
  assert.equal((await fetch(on.origin + '/api/metrics', { headers: { 'X-Operator-Key': 'x' } })).status, 401);
  for (const headers of [{ 'X-Operator-Key': key }, { Authorization: `Bearer ${key}` }] as Record<string, string>[]) {
    const ok = await fetch(on.origin + '/api/metrics', { headers });
    assert.equal(ok.status, 200); assert.match(ok.headers.get('content-type') ?? '', /^text\/plain/); assert.equal(ok.headers.get('cache-control'), 'no-store');
    const text = await ok.text();
    assert.match(text, /^sprityreels_lane_capacity\{lane="render"\} 3$/m);
    assert.match(text, /^sprityreels_lane_waiting\{lane="gpu"\} 0$/m); assert.match(text, /^sprityreels_backlog 0$/m);
    assert.match(text, /^sprityreels_ai_spend_usd_today 0$/m); assert.match(text, /^# TYPE sprityreels_backlog gauge$/m);
    assert.ok(!text.includes(key), 'the key is never echoed');
  }
});

/** Two visitors and the helpers to ask a fake Claude for picks. Each Opus pick of 1,000 input and 200 output tokens costs $0.008 at list price. */
async function pickers(t: { after: (fn: () => unknown) => void }, extra: Partial<AppOptions>) {
  const api = await fakeApi(t), root = await mkdtemp(path.join(tmpdir(), 'sprityreels-budget-')); t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'v.mp4'); await silentHighlight(file);
  const s = await site(t, { aiPerHour: 100, ...extra }, api.url);
  const visitor = async () => { const v = s.visitor(), source = await v.upload(file); await until(async () => (await v.call(`/sources/${source}`)).data.source.status, st => st === 'ready'); return { v, source }; };
  const pick = async ({ v, source }: { v: ReturnType<typeof s.visitor>; source: string }) => {
    const started = await v.call(`/sources/${source}/moments`, { engine: 'claude', userRequestedGeneration: true, genre: 'gaming' });
    if (started.status === 200) await until(async () => (await v.call(`/jobs/${started.data.job.id}`)).data.status, st => st !== 'running' && st !== 'queued');
    return started;
  };
  return { s, api, visitor, pick };
}

test('a visitor whose AI budget for the day is used up gets the automatic picks only, and nobody else is affected', async t => {
  const { s, api, visitor, pick } = await pickers(t, { aiUsdPerVisitorPerDay: 0.01 });
  const a = await visitor();
  assert.equal((await pick(a)).status, 200); assert.equal((await pick(a)).status, 200, 'two picks are $0.016, but the budget is only checked before a request: 0.008 was under 0.01');
  const refused = await pick(a);
  assert.equal(refused.status, 429); assert.match(refused.data.error, /used today’s AI picks/); assert.equal(api.seen.length, 2, 'a refused request costs nothing');
  assert.equal((await a.v.call(`/sources/${a.source}/moments`, { engine: 'local' })).status, 200, 'the automatic picks never stop');
  const b = await visitor();
  assert.equal((await pick(b)).status, 200, 'another visitor has their own budget');
  assert.ok(Math.abs(s.app.spentToday() - 0.024) < 1e-9);
});

test('when the service’s AI budget for the day is used up AI picks pause for everyone, and the spend survives a restart', async t => {
  const { s, api, visitor, pick } = await pickers(t, { aiUsdPerDay: 0.012 });
  const [a, b, c] = [await visitor(), await visitor(), await visitor()];
  assert.equal((await pick(a)).status, 200); assert.equal((await pick(b)).status, 200);
  assert.ok(Math.abs(s.app.spentToday() - 0.016) < 1e-9, `spent ${s.app.spentToday()}`);
  const paused = await pick(c);
  assert.equal(paused.status, 429); assert.match(paused.data.error, /paused for today/); assert.equal(api.seen.length, 2);
  assert.equal((await c.v.call(`/sources/${c.source}/moments`, { engine: 'local' })).status, 200);
  await until(() => readFile(path.join(s.dataDir, 'spend.json'), 'utf8').then(x => JSON.parse(x).total, () => 0), total => total > 0.0159);
  const again = createApp({ root: s.root, dataDir: s.dataDir, origin: () => 'http://127.0.0.1:1', service: { tools: testTools, directors: {} } });
  t.after(() => again.dispose());
  await until(() => again.spentToday(), v => v > 0.0159);
  assert.ok(Math.abs(again.spentToday() - 0.016) < 1e-9, 'a restart does not hand the day’s budget back');
});

test('the Claude prompt cache is off unless asked for, and when on it caches the pictures and transcript and prices the cache honestly', async t => {
  const seen: any[] = [];
  const server = createServer(async (req, res) => { const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer); seen.push(JSON.parse(Buffer.concat(chunks).toString('utf8'))); res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(reply({ usage: { input_tokens: 100, cache_creation_input_tokens: 1000, cache_read_input_tokens: 5000, output_tokens: 200 } }))); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => { server.closeAllConnections(); server.close(); });
  const baseURL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const jpeg = await sharp({ create: { width: 32, height: 18, channels: 3, background: '#336699' } }).jpeg().toBuffer();
  const request = { system: 's', prompt: 'ask then transcript', schema: MOMENT_SCHEMA, cwd: tmpdir(), timeoutMs: 20_000, signal: new AbortController().signal, imageData: [{ mime: 'image/jpeg' as const, data: jpeg }], cacheable: { stable: 'video facts and transcript', ask: 'find three' } };
  const off = await new ClaudeDirector({ apiKey: () => KEY, baseURL }).generate(request);
  assert.deepEqual(seen[0].messages[0].content.map((c: { type: string }) => c.type), ['image', 'text']);
  assert.equal(seen[0].messages[0].content[1].text, 'ask then transcript'); assert.ok(!JSON.stringify(seen[0]).includes('cache_control'));
  const on = await new ClaudeDirector({ apiKey: () => KEY, baseURL, cache: true }).generate(request);
  const blocks = seen[1].messages[0].content;
  assert.deepEqual(blocks.map((c: { type: string }) => c.type), ['image', 'text', 'text']);
  assert.deepEqual(blocks[1], { type: 'text', text: 'video facts and transcript', cache_control: { type: 'ephemeral' } }); assert.deepEqual(blocks[2], { type: 'text', text: 'find three' });
  // 100 fresh + 1,000 written at 1.25x + 5,000 read at 0.1x = 1,850 input tokens' worth at $4, plus 200 output tokens at $20 per million.
  assert.equal(on.usage!.inputTokens, 6100); assert.ok(Math.abs(on.usage!.usd! - (1850 * 4 + 200 * 20) / 1e6) < 1e-12);
  assert.ok(off.usage!.usd! > 0);
  // Without a split prompt the cache has nothing to cut, so the request is the same as with it off.
  await new ClaudeDirector({ apiKey: () => KEY, baseURL, cache: true }).generate({ ...request, cacheable: undefined });
  assert.ok(!JSON.stringify(seen[2]).includes('cache_control'));
});
