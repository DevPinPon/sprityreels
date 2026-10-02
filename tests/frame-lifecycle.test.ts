import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { MOMENT_SCHEMA } from '../src/engine/clips/moments';
import { createApp } from '../server/app';
import { ClipStudioService } from '../server/clips/service';
import type { ClipTools } from '../server/clips/tools';
import { run } from '../server/clips/tools';
import { ClaudeDirector, DEFAULT_CLAUDE_MODEL, DirectorUnavailableError, structuredSchema } from '../server/directors';
import type { DirectorAnswer, DirectorRequest, TextDirector } from '../server/directors';
import { FRAME_MARKER, FrameVault, buildEvidence, evidenceStoryboard } from '../server/evidence';
import { adaptiveSceneThreshold, buildKeyframeCandidates, grayHash, perceptualHashHammingDistance, selectDeterministicKeyframes, storyboardKeyframes } from '../server/evidence/keyframes';
import type { KeyframeCandidate, SignalSample } from '../server/evidence/keyframes';
import { scanSignals } from '../server/evidence/scan';

const FONTS = path.resolve('public/fonts/clips');
const testTools = async (): Promise<ClipTools> => ({ ytdlp: null, whisper: null, whisperModel: null, whisperGpu: null, ffmpeg: true, nvenc: false, fonts: FONTS, cacheDir: tmpdir() });
const scratch = (t: { after: (fn: () => unknown) => void }, name: string) => mkdtemp(path.join(tmpdir(), `sprityreels-${name}-`)).then(dir => { t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })); return dir; });
async function until<T>(read: () => Promise<T> | T, done: (v: T) => boolean, ms = 120_000) {
  const end = Date.now() + ms;
  for (;;) { const v = await read(); if (done(v)) return v; if (Date.now() > end) throw new Error(`Timed out: ${JSON.stringify(v).slice(0, 300)}`); await new Promise(r => setTimeout(r, 100)); }
}
/** Every file under `dir` that looks like a picture or a raw frame (the finished reels' cover images are not frames). */
async function pictureFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await pictureFiles(file));
    else if (/\.(jpe?g|png|bmp|webp|gif|tiff?|ppm|yuv|raw)$/i.test(entry.name) && entry.name !== 'cover.jpg') out.push(file);
  }
  return out;
}
/** A grey picture with one fast pan across a test pattern from 40 to 43 s (a visual highlight with no sound change). */
async function silentHighlight(file: string, seconds = 60) {
  await run('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=0x506070:s=320x180:r=15:d=${seconds}`, '-f', 'lavfi', '-i', `testsrc2=s=1280x180:r=15:d=3,crop=320:180:'mod(t*1500,960)':0`,
    '-f', 'lavfi', '-i', `aevalsrc='0.03*sin(2*PI*300*t)':s=48000:d=${seconds}`,
    '-filter_complex', '[1:v]setpts=PTS+40/TB[m];[0:v][m]overlay=eof_action=pass[v]', '-map', '[v]', '-map', '2:a', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-t', String(seconds), file], { timeout: 120_000 });
}
/** Four scenes of 15 s each: a moving pattern, a blue grid, another pattern, red with a yellow box. */
async function fourScenes(file: string) {
  await run('ffmpeg', ['-nostdin', '-hide_banner', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=25:d=15', '-f', 'lavfi', '-i', 'color=c=0x2060c0:s=320x180:r=25:d=15,drawgrid=w=40:h=40:t=2:c=white@0.6',
    '-f', 'lavfi', '-i', 'testsrc=s=320x180:r=25:d=15', '-f', 'lavfi', '-i', 'color=c=0xc03020:s=320x180:r=25:d=15,drawbox=x=40:y=40:w=120:h=60:c=yellow:t=fill',
    '-filter_complex', '[0:v][1:v][2:v][3:v]concat=n=4:v=1:a=0[v]', '-map', '[v]', '-c:v', 'libx264', '-g', '250', '-pix_fmt', 'yuv420p', file], { timeout: 120_000 });
}

// ------------------------------------------------------------ the vault
test('the frame vault deletes a lease when the step ends, however it ends', async t => {
  const root = path.join(await scratch(t, 'vault'), 'frames'), vault = new FrameVault(root);
  const made = await vault.use({ label: 'works' }, async dir => { await writeFile(path.join(dir, 'a.jpg'), 'x'); assert.equal(await vault.files(), 1); return 'result'; });
  assert.equal(made, 'result'); assert.equal(await vault.files(), 0); assert.equal(vault.size, 0);
  await assert.rejects(vault.use({ label: 'fails' }, async dir => { await writeFile(path.join(dir, 'b.jpg'), 'x'); throw new Error('boom'); }), /boom/);
  assert.equal(await vault.files(), 0); assert.equal(vault.size, 0);
  // release twice is harmless
  const lease = await vault.open({ label: 'twice' });
  await vault.release(lease); await vault.release(lease);
  assert.deepEqual((await readdir(root)).sort(), [FRAME_MARKER]);
});

test('purging reaches only the leases that carry the given ids', async t => {
  const vault = new FrameVault(path.join(await scratch(t, 'purge'), 'frames'));
  const open = async (owner: Parameters<FrameVault['open']>[0]) => { const lease = await vault.open(owner); await writeFile(path.join(lease.dir, 'f.jpg'), 'x'); return lease; };
  await open({ scope: 'a', jobId: 'j1', shortId: 's1', sourceId: 'x', label: 'a-j1' });
  await open({ scope: 'a', jobId: 'j2', shortId: 's2', sourceId: 'x', label: 'a-j2' });
  await open({ scope: 'b', jobId: 'j1', shortId: 's1', sourceId: 'x', label: 'b-j1' });
  assert.equal(await vault.purge({}), 0, 'an empty match removes nothing');
  assert.equal(await vault.purge({ scope: 'a', jobId: 'j1' }), 1);
  assert.deepEqual(vault.active().map(l => l.label).sort(), ['a-j2', 'b-j1'], 'the same job id in another workspace is untouched');
  assert.equal(await vault.purge({ scope: 'a', sourceId: 'x' }), 1);
  assert.equal(await vault.files(), 1);
  assert.equal(await vault.purgeAll(), 1);
  assert.equal(await vault.files(), 0);
});

test('a crash leaves nothing behind: the next start removes every orphaned frame, and the sweep removes frames that outlive their time limit', async t => {
  const root = path.join(await scratch(t, 'crash'), 'frames');
  const first = new FrameVault(root);
  const lease = await first.open({ label: 'before the crash' });
  await writeFile(path.join(lease.dir, 'frame.jpg'), 'x');
  // The process dies here: nothing releases the lease. A new process starts on the same folder.
  const second = new FrameVault(root);
  await second.ready();
  assert.equal(await second.files(), 0, 'the start-up sweep removed the orphan');
  assert.deepEqual(await readdir(root), [FRAME_MARKER]);

  let clock = 1_000_000;
  const timed = new FrameVault(root, { ttlMs: 60_000, now: () => clock });
  const old = await timed.open({ label: 'old' }); await writeFile(path.join(old.dir, 'f.jpg'), 'x');
  clock += 30_000; const young = await timed.open({ label: 'young' }); await writeFile(path.join(young.dir, 'f.jpg'), 'x');
  clock += 40_000;
  assert.equal(await timed.sweep(), 1, 'only the lease older than the limit goes');
  assert.deepEqual(timed.active().map(l => l.label), ['young']);
  clock += 60_000;
  assert.equal(await timed.sweep(), 1); assert.equal(await timed.files(), 0);
});

test('a folder that is not a frame vault is never emptied', async t => {
  const root = path.join(await scratch(t, 'foreign'), 'precious');
  await mkdir(root); await writeFile(path.join(root, 'thesis.docx'), 'important');
  await assert.rejects(new FrameVault(root).ready(), /not a Sprity Reels frame folder/);
  assert.equal(await readFile(path.join(root, 'thesis.docx'), 'utf8'), 'important');
  assert.throws(() => new FrameVault('relative/frames'), /absolute/);
});

test('the website empties the vault when it starts and when it stops', async t => {
  const dir = await scratch(t, 'site'), frames = path.join(dir, 'data', 'frames');
  const crashed = new FrameVault(frames), lease = await crashed.open({ label: 'left by a crash' });
  await writeFile(path.join(lease.dir, 'frame.png'), 'x');
  const app = createApp({ root: dir, dataDir: path.join(dir, 'data'), origin: () => 'http://127.0.0.1:1', service: { tools: testTools, directors: {} } });
  await app.frames.ready();
  assert.deepEqual(await readdir(frames), [FRAME_MARKER], 'frames left by an earlier run are gone before any visitor arrives');
  const mine = await app.frames.open({ label: 'in flight' }); await writeFile(path.join(mine.dir, 'frame.png'), 'x');
  await app.dispose();
  assert.equal(await app.frames.files(), 0, 'stopping the server removes the frames of work still in flight');
});

// ------------------------------------------------------------ Rinegan's deterministic keyframe selection
const interval = { startUs: 0, endUs: 10_000_000 };
const cand = (id: string, index: number, timestampUs: number, extra: Partial<KeyframeCandidate> = {}): KeyframeCandidate => ({ id, sourceFrameIndex: index, timestampUs, sceneId: 'one', changeScore: 0, perceptualHash: '0000', transientState: false, transientDurationUs: null, ...extra });
const policy = { interval, mode: 'sparse' as const, minFrames: 3, maxFrames: 5, maxCoverageGapUs: 3_000_000, minSpacingUs: 400_000, changeThreshold: 0.6, nearDuplicateHammingDistance: 1, nearDuplicateWindowUs: 1_000_000, transientMaxDurationUs: 500_000 };
const sample = [
  cand('a', 0, 500_000, { coverage: { startUs: 0, endUs: 1_000_000 }, changeScore: 0.9 }),
  cand('a-dup', 1, 700_000, { coverage: { startUs: 600_000, endUs: 800_000 }, changeScore: 0.1, perceptualHash: '0001' }),
  cand('toast', 2, 900_000, { coverage: { startUs: 850_000, endUs: 950_000 }, changeScore: 0.2, transientState: true, transientDurationUs: 200_000 }),
  cand('scene-two', 3, 3_200_000, { coverage: { startUs: 3_000_000, endUs: 3_400_000 }, sceneId: 'two', changeScore: 0.8, perceptualHash: 'ffff' }),
  cand('middle', 4, 5_300_000, { coverage: { startUs: 5_000_000, endUs: 5_600_000 }, sceneId: 'two', changeScore: 0.4, perceptualHash: 'f0f0' }),
  cand('end', 5, 8_900_000, { coverage: { startUs: 8_500_000, endUs: 9_500_000 }, sceneId: 'two', changeScore: 0.7, perceptualHash: '0f0f' }),
];

test('keyframe selection drops near-duplicates but keeps transient states and scene changes', () => {
  const result = selectDeterministicKeyframes(sample, policy);
  assert.deepEqual(result.duplicateSuppression.suppressed, [{ id: 'a-dup', duplicateOf: 'a', hammingDistance: 1 }]);
  assert.ok(result.duplicateSuppression.preservedTransientIds.includes('toast'));
  assert.ok(result.selected.find(k => k.id === 'toast')!.reasons.includes('transient_state'));
  assert.ok(result.selected.find(k => k.id === 'scene-two')!.reasons.includes('scene_boundary'));
  assert.equal(result.selected.length, 4);
  assert.equal(result.coverage.floorFeasible, false);
  assert.ok(Math.abs(result.coverage.actualCoverageRatio - 0.21) < 1e-9);
});

test('keyframe selection is reproducible whatever the input order, and dense mode keeps more', () => {
  const first = selectDeterministicKeyframes(sample, { ...policy, maxFrames: 4 }), second = selectDeterministicKeyframes([...sample].reverse(), { ...policy, maxFrames: 4 });
  assert.deepEqual(first, second);
  const dense = selectDeterministicKeyframes(sample, { ...policy, mode: 'dense', minFrames: 2, maxFrames: 6 });
  assert.ok(dense.selected.length > first.selected.length); assert.notEqual(dense.policyFingerprint, first.policyFingerprint);
});

test('keyframe selection builds a feasible maximum-gap chain and never drops a frame that chain needs', () => {
  const chain = selectDeterministicKeyframes([cand('early', 0, 100_000), cand('reach-1', 1, 2_400_000, { perceptualHash: '1111' }), cand('reach-2', 2, 4_900_000, { perceptualHash: '2222' }), cand('reach-3', 3, 7_400_000, { perceptualHash: '3333' }), cand('late', 4, 9_900_000, { perceptualHash: '4444' })],
    { ...policy, minFrames: 4, maxFrames: 4, minSpacingUs: 0, nearDuplicateHammingDistance: 0 });
  assert.equal(chain.coverage.floorFeasible, true); assert.equal(chain.coverage.floorMet, true); assert.equal(chain.coverage.largestTimestampGapUs, 2_600_000);
  assert.deepEqual(chain.selected.map(k => k.id), ['early', 'reach-1', 'reach-2', 'reach-3']);
  const bridge = selectDeterministicKeyframes([cand('start', 0, 1_000_000), cand('bridge', 1, 3_900_000), cand('end', 2, 6_800_000, { perceptualHash: 'ffff' })],
    { ...policy, interval: { startUs: 0, endUs: 9_000_000 }, minFrames: 3, maxFrames: 3, minSpacingUs: 0, nearDuplicateHammingDistance: 0, nearDuplicateWindowUs: 5_000_000 });
  assert.equal(bridge.coverage.floorMet, true);
  assert.ok(!bridge.duplicateSuppression.suppressed.some(s => s.id === 'bridge'));
  assert.ok(bridge.duplicateSuppression.preservedTemporalCoverageIds.includes('bridge'));
  assert.equal(perceptualHashHammingDistance('0000', '0001'), 1); assert.equal(perceptualHashHammingDistance('00', '0000'), null);
  assert.throws(() => perceptualHashHammingDistance('not-hex', '0000'), /hexadecimal/);
  assert.throws(() => selectDeterministicKeyframes([cand('x', 0, 20_000_000)], policy), /inside the requested interval/);
  assert.throws(() => selectDeterministicKeyframes(sample, policy, { signal: AbortSignal.abort() }), /abort/i);
  // The first frame of a later window is a scene change when the scene before it was another one.
  assert.ok(selectDeterministicKeyframes([cand('n', 0, 1_000_000, { sceneId: 'two' })], { ...policy, minFrames: 1, maxFrames: 1 }, { previousSceneId: 'one' }).selected[0].reasons.includes('scene_boundary'));
  assert.ok(!selectDeterministicKeyframes([cand('n', 0, 1_000_000, { sceneId: 'two' })], { ...policy, minFrames: 1, maxFrames: 1 }, { previousSceneId: 'two' }).selected[0].reasons.includes('scene_boundary'));
});

const flat = (value: number) => new Uint8Array(4096).fill(value);
const checker = (low: number, high: number) => Uint8Array.from({ length: 4096 }, (_, i) => (Math.floor(i % 64 / 8) + Math.floor(i / 512)) % 2 ? high : low);
test('signals become scene changes, a hash and a short-lived state that returns', () => {
  // Calm grey, a hard cut to a pattern at 5 s, and a 1 s flash at 8 s that goes back to what was there.
  const frames: SignalSample[] = Array.from({ length: 20 }, (_, i) => ({ index: i, t: i * 0.5, pixels: i < 10 ? flat(60) : i === 16 ? flat(250) : checker(40, 220) }));
  const candidates = buildKeyframeCandidates(frames, { endSeconds: 10, sceneChangeThreshold: adaptiveSceneThreshold(frames) });
  assert.equal(candidates.length, 20);
  assert.equal(candidates[0].changeScore, 1);
  const cuts = candidates.filter((c, i) => i && c.sceneId !== candidates[i - 1].sceneId).map(c => c.timestampUs / 1e6);
  assert.deepEqual(cuts, [5, 8, 8.5], 'the hard cut, then the flash and its return');
  assert.deepEqual(candidates.filter(c => c.transientState).map(c => c.timestampUs / 1e6), [8], 'the flash is a transient state: it appears for under 2 s and returns to what was there');
  assert.match(grayHash(frames[0].pixels), /^[0-9a-f]{32}$/);
  assert.equal(candidates[0].coverage!.endUs, 500_000); assert.equal(candidates[19].coverage!.endUs, 10_000_000);
  assert.equal(new Set(candidates.map(c => c.id)).size, 20);
});

test('a storyboard spreads over the whole range, keeps every cut, and is the same every time', () => {
  const frames: SignalSample[] = Array.from({ length: 240 }, (_, i) => ({ index: i, t: i, pixels: Math.floor(i / 60) % 2 ? checker(20 + Math.floor(i / 60) * 20, 230) : flat(60 + Math.floor(i / 60) * 20) }));
  const threshold = adaptiveSceneThreshold(frames), candidates = buildKeyframeCandidates(frames, { endSeconds: 240, sceneChangeThreshold: threshold });
  const board = storyboardKeyframes(candidates, { start: 0, end: 240 }, 40, { sceneChangeThreshold: threshold });
  assert.ok(board.length >= 8 && board.length <= 40, String(board.length));
  for (const cut of [60, 120, 180]) assert.ok(board.some(k => k.timestampUs / 1e6 === cut && k.reasons.includes('scene_boundary')), `the cut at ${cut} s is kept`);
  for (let w = 0; w < 4; w++) assert.ok(board.some(k => k.timestampUs >= w * 60e6 && k.timestampUs < (w + 1) * 60e6), `every minute of the video has a frame (${w})`);
  assert.deepEqual(storyboardKeyframes([...candidates].reverse(), { start: 0, end: 240 }, 40, { sceneChangeThreshold: threshold }), board);
  assert.deepEqual(storyboardKeyframes(candidates, { start: 100.2, end: 100.8 }, 40, { sceneChangeThreshold: threshold }), [], 'a range with no sample has no storyboard');
  assert.ok(storyboardKeyframes(candidates, { start: 60, end: 120 }, 10, { sceneChangeThreshold: threshold }).every(k => k.timestampUs >= 60e6 && k.timestampUs < 120e6));
});

// ------------------------------------------------------------ the picture scan runs in memory
test('the picture scan finds the scene changes of a real video at their exact times and writes no file', async t => {
  const dir = await scratch(t, 'scan'), file = path.join(dir, 'scenes.mp4');
  await fourScenes(file);
  const before = (await readdir(dir)).sort();
  const scan = await scanSignals(file, { duration: 60 });
  assert.equal(scan.samples.length, 60); assert.equal(scan.keyframesOnly, false);
  assert.deepEqual(scan.samples.slice(0, 3).map(s => s.t), [0, 1, 2]); assert.equal(scan.samples[59].t, 59);
  assert.ok(scan.samples.every(s => s.pixels.length === 4096));
  const evidence = await buildEvidence(file, { duration: 60 });
  assert.equal(evidence.scenes, 4);
  const cuts = evidence.candidates.filter((c, i) => i && c.sceneId !== evidence.candidates[i - 1].sceneId).map(c => c.timestampUs / 1e6);
  assert.deepEqual(cuts, [15, 30, 45]);
  assert.ok(!('pixels' in evidence.candidates[0]), 'the pixels are dropped: only numbers are kept');
  assert.deepEqual((await readdir(dir)).sort(), before, 'the scan wrote nothing next to the video');
  // Only part of the video, and only its keyframes (a long video decodes far fewer frames).
  const part = await scanSignals(file, { duration: 60, from: 20, to: 40 });
  assert.ok(part.samples[0].t >= 20 && part.samples.at(-1)!.t < 40 && part.samples.length >= 18, JSON.stringify(part.samples.map(s => s.t)));
  const keys = await scanSignals(file, { duration: 60, keyframesAbove: 10 });
  assert.equal(keys.keyframesOnly, true); assert.ok(keys.samples.length >= 4 && keys.samples.length < 60);
  const board = evidenceStoryboard(evidence, { start: 0, end: 60 }, 40);
  assert.ok(board.length >= 6 && board.some(f => f.reasons.includes('scene_boundary')));
  await assert.rejects(scanSignals(path.join(dir, 'missing.mp4'), { duration: 60 }));
});

// ------------------------------------------------------------ Claude reads the video without anything on disk
type Seen = { headers: IncomingHttpHeaders; body: any };
async function fakeAnthropic(t: { after: (fn: () => unknown) => void }, reply: (seen: Seen) => { status?: number; headers?: Record<string, string>; body: unknown } | Promise<{ status?: number; headers?: Record<string, string>; body: unknown }>) {
  const seen: Seen[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer);
    const entry = { headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'), url: req.url };
    seen.push(entry);
    const out = await reply(entry);
    res.statusCode = out.status ?? 200; res.setHeader('Content-Type', 'application/json');
    for (const [k, v] of Object.entries(out.headers ?? {})) res.setHeader(k, v);
    res.end(JSON.stringify(out.body));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise<void>(r => server.close(() => r())); });
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, seen };
}
const message = (text: string, extra: object = {}) => ({ id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1000, output_tokens: 200 }, ...extra });
const request = (extra: Partial<DirectorRequest> = {}): DirectorRequest => ({ system: 'You pick moments.', prompt: 'Pick.', schema: MOMENT_SCHEMA, cwd: tmpdir(), timeoutMs: 30_000, signal: new AbortController().signal, ...extra });
const KEY = 'sk-ant-test-0123456789abcdef';

test('the Claude director asks for JSON with structured outputs, sends pictures from memory, and keeps its key to itself', async t => {
  const api = await fakeAnthropic(t, () => ({ body: message('{"moments":[]}') }));
  const director = new ClaudeDirector({ apiKey: () => KEY, baseURL: api.url });
  assert.equal(director.vision, true); assert.equal(director.imageInput, 'data');
  const jpeg = await sharp({ create: { width: 64, height: 36, channels: 3, background: '#3366cc' } }).jpeg().toBuffer();
  const answer = await director.generate(request({ imageData: [{ mime: 'image/jpeg', data: jpeg }, { mime: 'image/jpeg', data: jpeg }] }));
  assert.equal(answer.text, '{"moments":[]}'); assert.equal(answer.model, 'claude-opus-5-5');
  assert.deepEqual(answer.usage, { inputTokens: 1000, outputTokens: 200, usd: (1000 * 4 + 200 * 20) / 1e6 });
  const { headers, body } = api.seen[0];
  assert.equal(headers['x-api-key'], KEY);
  assert.match(String(headers['anthropic-beta']), /server-side-fallback-2026-07-01/);
  assert.equal(body.model, DEFAULT_CLAUDE_MODEL); assert.equal(DEFAULT_CLAUDE_MODEL, 'claude-opus-5-5');
  assert.equal(body.fallbacks, 'default', 'a request a safety classifier declines is retried by the API on its recommended model');
  assert.equal(body.output_config.effort, 'medium'); assert.equal(body.output_config.format.type, 'json_schema');
  assert.ok(!('tool_choice' in body) && !('thinking' in body) && !('temperature' in body), 'these models reject forced tool use and sampling controls');
  assert.deepEqual(body.messages[0].content.map((c: { type: string }) => c.type), ['image', 'image', 'text']);
  assert.equal(body.messages[0].content[0].source.type, 'base64'); assert.equal(body.messages[0].content[0].source.media_type, 'image/jpeg');
  assert.equal((await sharp(Buffer.from(body.messages[0].content[0].source.data, 'base64')).metadata()).format, 'jpeg');
  const schema = JSON.stringify(body.output_config.format.schema);
  assert.ok(!/"(minimum|maximum|maxLength|maxItems|minLength)"/.test(schema), 'limits that structured outputs do not accept are removed');
  assert.ok(schema.includes('"additionalProperties":false') && schema.includes('"hookScore"'));
  assert.equal(JSON.stringify(structuredSchema({ type: 'array', minItems: 1, maxItems: 4, items: { type: 'string', maxLength: 5 } })), '{"type":"array","minItems":1,"items":{"type":"string"}}');
});

test('the Claude director says what to do when it cannot answer, and never repeats the key', async t => {
  assert.equal((await new ClaudeDirector({ apiKey: () => undefined }).status()).available, false);
  await assert.rejects(new ClaudeDirector({ apiKey: () => undefined }).generate(request()), (e: Error) => e instanceof DirectorUnavailableError && /ANTHROPIC_API_KEY is missing/.test(e.message));
  assert.equal((await new ClaudeDirector({ apiKey: () => KEY }).status()).available, true);
  const mode = { current: 'refusal' };
  const api = await fakeAnthropic(t, () => {
    const never = { 'x-should-retry': 'false' };
    if (mode.current === 'refusal') return { body: message('', { content: [], stop_reason: 'refusal', stop_details: { type: 'refusal', category: null, explanation: null } }) };
    if (mode.current === 'cut') return { body: message('{"moments":[', { stop_reason: 'max_tokens' }) };
    if (mode.current === 'key') return { status: 401, headers: never, body: { type: 'error', error: { type: 'authentication_error', message: `invalid x-api-key ${KEY}` } } };
    if (mode.current === 'busy') return { status: 429, headers: never, body: { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } } };
    if (mode.current === 'bad') return { status: 400, headers: never, body: { type: 'error', error: { type: 'invalid_request_error', message: `secret detail ${KEY}` } } };
    return { body: message('   ') };
  });
  const director = new ClaudeDirector({ apiKey: () => KEY, baseURL: api.url });
  const expected: Record<string, RegExp> = { refusal: /declined/, cut: /cut off/, key: /check ANTHROPIC_API_KEY/, busy: /rate limit/, empty: /empty answer/ };
  for (const [name, pattern] of Object.entries(expected)) {
    mode.current = name;
    await assert.rejects(director.generate(request()), (e: Error) => e instanceof DirectorUnavailableError && pattern.test(e.message) && !e.message.includes(KEY), name);
  }
  mode.current = 'bad';
  await assert.rejects(director.generate(request()), (e: Error) => !(e instanceof DirectorUnavailableError) && !e.message.includes(KEY) && !e.message.includes('secret detail'), 'a rejected request does not echo the server text');
});

test('AI picks that look at the video keep every frame in memory, and nothing is on disk while the model reads them or after', async t => {
  const root = await scratch(t, 'claude'), file = path.join(root, 'silent.mp4');
  await silentHighlight(file);
  const during: { seen: { vault: number; pictures: string[]; images: number; first: string } | null } = { seen: null };
  const reply = {
    moments: [{ kind: 'action', startSentence: -1, endSentence: -1, startSeconds: 30, endSeconds: 46, teaserStartSentence: -1, teaserEndSentence: -1, title: 'Pattern appears', hook: 'Wait for it', reason: 'the picture changes', hookScore: 7, flowScore: 7, valueScore: 7, trendScore: 5, hashtags: [], keywords: [] }],
  };
  let service!: ClipStudioService;
  const api = await fakeAnthropic(t, async seen => {
    const content = seen.body.messages[0].content as { type: string; text?: string }[];
    // The model is reading its pictures right now: look at the server.
    during.seen = { vault: await service.vault.files(), pictures: await pictureFiles(root), images: content.filter(c => c.type === 'image').length, first: content.at(-1)!.text! };
    return { body: message(JSON.stringify(reply)) };
  });
  service = new ClipStudioService(path.join(root, 'clips'), { projectRoot: root, tools: testTools, transcriber: async () => ({ words: [], language: 'en', model: 'test' }),
    directors: { claude: new ClaudeDirector({ apiKey: () => KEY, baseURL: api.url }) }, launcher: { find: async () => null, open: async () => ({ stop: async () => {} }) } });
  t.after(() => service.dispose());
  await service.saveSettings({ minSeconds: 8, maxSeconds: 20, count: 2 });
  async function* body() { yield new Uint8Array(await readFile(file)); }
  const { source, job } = await service.importUpload('silent.mp4', body(), 0, { rights: 'own' });
  await until(() => service.job(job.id), j => j.status !== 'running' && j.status !== 'queued');
  assert.equal((await service.overview()).claude, true);
  const ranked = await service.findMoments(source.id, { engine: 'claude', userRequestedGeneration: true, genre: 'gaming' });
  const finished = await until(() => service.job(ranked.job!.id), j => j.status !== 'running' && j.status !== 'queued');
  assert.equal(finished.status, 'done', JSON.stringify(finished));
  const seen = during.seen!;
  assert.ok(seen, 'the model was called');
  assert.ok(seen.images >= 1, 'the model received pictures');
  assert.match(seen.first, /storyboard of \d+ frames/);
  assert.equal(seen.vault, 0, 'no frame was in the vault while the model read the pictures: they were sent from memory');
  assert.deepEqual(seen.pictures, [], 'no picture or raw frame existed anywhere on the server while the model read them');
  assert.deepEqual(await pictureFiles(root), []); assert.equal(await service.vault.files(), 0);
  const set = (await service.momentSets(source.id))[0];
  assert.equal(set.engine, 'claude'); assert.equal(set.model, 'claude-opus-5-5'); assert.equal(set.moments[0].kind, 'action');
  assert.equal(api.seen.length, 1);
  // Per-token billing is recorded for the operator like Gemini's.
  assert.ok((await service.gemini.ledger.entries()).some(e => e.kind === 'moments' && e.model === 'claude-opus-5-5' && Math.abs(e.usd - 0.008) < 1e-9));
});

// ------------------------------------------------------------ frames a model reads from files are deleted whatever happens
class FileDirector implements TextDirector {
  readonly vision = true;
  seen: { files: string[]; onDisk: number }[] = [];
  constructor(private act: (request: DirectorRequest) => Promise<DirectorAnswer>) {}
  async status() { return { available: true, connected: true, message: 'Ready.' }; }
  async generate(request: DirectorRequest) {
    const files = request.images ?? [];
    this.seen.push({ files, onDisk: (await Promise.all(files.map(f => stat(f).then(() => 1, () => 0)))).reduce<number>((a, b) => a + b, 0) });
    return this.act(request);
  }
  dispose() {}
}
async function fileDirectorStudio(t: { after: (fn: () => unknown) => void }, act: (request: DirectorRequest) => Promise<DirectorAnswer>) {
  const root = await scratch(t, 'files'), file = path.join(root, 'silent.mp4');
  await silentHighlight(file);
  const director = new FileDirector(act);
  const service = new ClipStudioService(path.join(root, 'clips'), { projectRoot: root, tools: testTools, transcriber: async () => ({ words: [], language: 'en', model: 'test' }), directors: { codex: director }, launcher: { find: async () => null, open: async () => ({ stop: async () => {} }) } });
  t.after(() => service.dispose());
  await service.saveSettings({ minSeconds: 8, maxSeconds: 20, count: 2 });
  async function* body() { yield new Uint8Array(await readFile(file)); }
  const { source, job } = await service.importUpload('silent.mp4', body(), 0, { rights: 'own' });
  await until(() => service.job(job.id), j => j.status !== 'running' && j.status !== 'queued');
  return { service, director, source, root };
}

test('frames a model reads from files are deleted when it fails or when the job is cancelled', async t => {
  let release: () => void = () => {};
  const { service, director, source, root } = await fileDirectorStudio(t, async request => {
    if (request.prompt.includes('FAIL')) throw new DirectorUnavailableError('The model is down.');
    await new Promise<void>((resolve, reject) => { release = resolve; request.signal.addEventListener('abort', () => reject(new Error('Cancelled.')), { once: true }); });
    return { text: '{"moments":[]}' };
  });
  // The model fails while it holds the frames.
  const failing = await service.findMoments(source.id, { engine: 'codex', userRequestedGeneration: true, prompt: 'FAIL' });
  const failed = await until(() => service.job(failing.job!.id), j => j.status !== 'running' && j.status !== 'queued');
  assert.equal(failed.status, 'failed'); assert.match(failed.error ?? '', /model is down/);
  assert.ok(director.seen[0].files.length >= 2 && director.seen[0].onDisk === director.seen[0].files.length, 'the files existed while the model read them');
  assert.equal(await service.vault.files(), 0); assert.deepEqual(await pictureFiles(root), []);
  // The visitor cancels while the model is reading them.
  const waiting = await service.findMoments(source.id, { engine: 'codex', userRequestedGeneration: true, prompt: 'wait' });
  await until(() => director.seen.length, n => n === 2);
  assert.equal(await service.vault.files(), director.seen[1].files.length, 'the frames are in the vault while the model reads them');
  service.cancelJob(waiting.job!.id);
  const cancelled = await until(() => service.job(waiting.job!.id), j => j.status !== 'running' && j.status !== 'queued');
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(await service.vault.files(), 0); assert.equal(service.vault.size, 0); assert.deepEqual(await pictureFiles(root), []);
  release();
});

test('deleting a video removes any frame of it that is still in use', async t => {
  const { service, director, source, root } = await fileDirectorStudio(t, request => new Promise<DirectorAnswer>((_resolve, reject) => request.signal.addEventListener('abort', () => reject(new Error('Cancelled.')), { once: true })));
  const running = await service.findMoments(source.id, { engine: 'codex', userRequestedGeneration: true });
  await until(() => director.seen.length, n => n === 1);
  assert.ok(await service.vault.files() > 0);
  await service.deleteSource(source.id, { confirm: true });
  assert.equal(await service.vault.files(), 0); assert.equal(service.vault.size, 0);
  const ended = await until(() => service.job(running.job!.id), j => j.status !== 'running' && j.status !== 'queued');
  assert.equal(ended.status, 'cancelled');
  assert.deepEqual(await pictureFiles(root), []);
  assert.deepEqual(await readdir(path.join(root, 'clips', 'sources')), []);
});

test('frame folders left by an older version or a crash are removed when a studio starts', async t => {
  const root = await scratch(t, 'legacy'), clips = path.join(root, 'clips'), id = '01234567-89ab-cdef-0123-456789abcdef';
  for (const dir of [path.join(clips, 'ai-workspace', 'sheets', 'x'), path.join(clips, 'ai-workspace', 'frames', 'y'), path.join(clips, 'sources', id, 'tracks', 'abc-frames')]) { await mkdir(dir, { recursive: true }); await writeFile(path.join(dir, 'f.jpg'), 'x'); }
  await writeFile(path.join(clips, 'sources', id, 'tracks', 'abc.json'), '{}');
  const service = new ClipStudioService(clips, { projectRoot: root, tools: testTools, directors: {}, launcher: { find: async () => null, open: async () => ({ stop: async () => {} }) } });
  t.after(() => service.dispose());
  await service.overview();
  assert.deepEqual(await pictureFiles(root), []);
  assert.deepEqual(await readdir(path.join(clips, 'sources', id, 'tracks')), ['abc.json'], 'only the track data stays');
});
