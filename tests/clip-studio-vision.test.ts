import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import type { ClipWord } from '../src/engine/clips/types';
import { makeTranscript } from '../src/engine/clips/transcript';
import { VISUAL_RATE, actionPeaks, parseVisualActivity, visualPeaks } from '../src/engine/clips/signals';
import { buildMomentPrompt, localMoments, normalizeMoments, parseMomentReply } from '../src/engine/clips/moments';
import { ClipStudioService } from '../server/clips/service';
import type { ClipTools } from '../server/clips/tools';
import { run } from '../server/clips/tools';
import { contactSheet, grabFrames, tileSize } from '../server/clips/frames';
import type { DirectorAnswer, DirectorRequest, TextDirector } from '../server/directors';

const w = (t: string, s: number, e: number): ClipWord => ({ t, s, e });
const silent = (seconds: number) => makeTranscript([], { engine: 'whisper', language: 'en', model: 'test', duration: seconds });
const ctxOf = (extra: object = {}) => ({ title: 'Test', creator: 'Host', description: '', heatmap: [], chapters: [], ...extra });
const opts = (extra: object = {}) => ({ count: 3, minSeconds: 8, maxSeconds: 30, prompt: '', genre: 'auto' as const, range: null, ...extra });
/** Picture change at 4 Hz: calm footage (level 5) with a hard cut every 8 s, and fast motion (level 45) from `burst` for 3 s. */
function footage(seconds: number, burst: number | null) {
  const v = new Uint8Array(seconds * VISUAL_RATE).fill(5);
  for (let t = 8; t < seconds; t += 8) v[t * VISUAL_RATE] = 70;
  if (burst !== null) for (let k = burst * VISUAL_RATE; k < (burst + 3) * VISUAL_RATE; k++) v[k] = 45;
  return v;
}
/** Steady ambience (55) with an optional loud burst. */
function sound(seconds: number, loud: [number, number] | null) {
  const e = new Uint8Array(seconds * 100).fill(55);
  if (loud) for (let i = loud[0] * 100; i < loud[1] * 100; i++) e[i] = 80;
  return e;
}

// ------------------------------------------------------------ signals
test('picture peaks find sustained motion and ignore single hard cuts', () => {
  assert.deepEqual(visualPeaks(footage(120, null)), [], 'cuts alone are not action');
  const peaks = visualPeaks(footage(120, 60));
  assert.equal(peaks.length, 1, JSON.stringify(peaks));
  assert.ok(peaks[0].s >= 59.5 && peaks[0].e <= 63.5 && peaks[0].level >= 35, JSON.stringify(peaks[0]));
  const text = 'frame:0 pts:0 pts_time:0\nlavfi.scd.mafd=0.000\nframe:1 pts:1 pts_time:0.25\nlavfi.scd.mafd=10.000\nframe:2 pts:2 pts_time:0.5\nlavfi.scd.mafd=150\n';
  assert.deepEqual([...parseVisualActivity(text, 1)], [0, 26, 255, 0]);
});

test('action peaks merge what is heard and seen into one stronger event', () => {
  const both = actionPeaks(sound(120, [61, 63]), footage(120, 60));
  assert.equal(both.length, 1, JSON.stringify(both));
  assert.ok(both[0].audio > 20 && both[0].visual > 35, JSON.stringify(both[0]));
  const heard = actionPeaks(sound(120, [61, 63]), undefined)[0], seen = actionPeaks(undefined, footage(120, 60))[0];
  assert.ok(both[0].strength > heard.strength && both[0].strength > seen.strength, `${both[0].strength} > ${heard.strength}, ${seen.strength}`);
  assert.equal(seen.audio, 0); assert.equal(heard.visual, 0);
});

// ------------------------------------------------------------ picks
test('a silent visual highlight becomes an action pick with its build-up', () => {
  const picks = localMoments(silent(120), ctxOf({ energy: sound(120, null), visual: footage(120, 70) }), opts({ count: 2 }));
  const action = picks.find(p => p.kind === 'action');
  assert.ok(action, JSON.stringify(picks));
  assert.ok(action!.start <= 70 - 6 && action!.end >= 73 + 1, `${action!.start}-${action!.end}`);
  assert.match(action!.reason, /motion on screen at 1:10 \(seen, not heard\): build-up, peak and reaction/);
  // Without the picture pass the same video has nothing to offer.
  assert.equal(localMoments(silent(120), ctxOf({ energy: sound(120, null) }), opts()).length, 0);
  // A talk genre stays with talk picks even when the picture is busy.
  const podcast = makeTranscript(Array.from({ length: 300 }, (_, i) => w(i % 12 === 11 ? 'end.' : 'word', i * .38, i * .38 + .3)), { engine: 'whisper', language: 'en', model: 'test', duration: 120 });
  assert.equal(localMoments(podcast, ctxOf({ visual: footage(120, 70) }), opts({ genre: 'podcast' })).filter(p => p.kind === 'action').length, 0);
});

test('AI engines return action moments by seconds and see the peaks in the prompt', () => {
  const t = silent(120), ctx = ctxOf({ energy: sound(120, [61, 63]), visual: footage(120, 60) });
  const prompt = buildMomentPrompt(t, ctx, opts({ genre: 'gaming' }));
  assert.match(prompt, /Action peaks found in the sound and the picture[^\n]*6\d\.\d+s heard\+seen/);
  assert.match(prompt, /This video has no speech \(120 s long\)/);
  const reply = JSON.stringify({ moments: [
    { kind: 'action', startSentence: -1, endSentence: -1, startSeconds: 45, endSeconds: 66, teaserStartSentence: -1, teaserEndSentence: -1, title: 'The play', hook: 'Watch the left side', reason: 'goal', hookScore: 8, flowScore: 8, valueScore: 9, trendScore: 6, hashtags: ['goal'], keywords: [] },
    { kind: 'action', startSentence: -1, endSentence: -1, startSeconds: 118, endSeconds: 119, teaserStartSentence: -1, teaserEndSentence: -1, title: 'Too short at the end', hook: '', reason: '', hookScore: 5, flowScore: 5, valueScore: 5, trendScore: 5, hashtags: [], keywords: [] },
  ] });
  const moments = parseMomentReply(reply, t, ctx, opts(), 'codex');
  assert.equal(moments.length, 2, JSON.stringify(moments));
  const play = moments.find(m => m.title === 'The play')!;
  assert.equal(play.kind, 'action'); assert.ok(play.start >= 44.5 && play.start <= 45.5 && play.end >= 65 && play.end <= 67, `${play.start}-${play.end}`);
  assert.equal(play.checks![0].text, 'Starts before the action builds');
  const tail = moments.find(m => m.title === 'Too short at the end')!;
  assert.ok(tail.end <= 120 && tail.end - tail.start >= 8 - .01, 'a short range grows to the minimum inside the video');
  // Talk moments of a transcript still come from sentences; seconds of -1 are ignored.
  const talk = makeTranscript([w('What', 1, 1.3), w('happened?', 1.4, 1.9), w('We', 2.5, 2.7), w('won', 2.8, 3.1), w('the', 3.2, 3.4), w('final', 3.5, 3.9), w('tonight.', 4, 4.6)], { engine: 'whisper', language: 'en', model: 'test', duration: 20 });
  const [m] = normalizeMoments([{ kind: 'talk', startSentence: 0, endSentence: 1, startSeconds: -1, endSeconds: -1, title: 'Win' }], talk, ctxOf(), { minSeconds: 3, maxSeconds: 30, count: 3 }, 'agent');
  assert.equal(m.kind, 'talk'); assert.ok(m.start < 1 && m.end > 4.6);
});

// ------------------------------------------------------------ contact sheets and the picture pass
const FONTS = path.resolve('public/fonts/clips');
const testTools = async (): Promise<ClipTools> => ({ ytdlp: null, whisper: null, whisperModel: null, whisperGpu: null, ffmpeg: true, nvenc: false, fonts: FONTS, cacheDir: tmpdir() });
async function until<T>(read: () => Promise<T>, done: (v: T) => boolean, ms = 180_000) {
  const end = Date.now() + ms;
  for (;;) { const v = await read(); if (done(v)) return v; if (Date.now() > end) throw new Error(`Timed out: ${JSON.stringify(v).slice(0, 400)}`); await new Promise(r => setTimeout(r, 150)); }
}
/** Still grey picture and a quiet hum, except a fast pan across a test pattern (no sound change at all) from 40 to 43 s. */
async function silentHighlight(file: string, seconds = 60) {
  await run('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=0x506070:s=320x180:r=15:d=${seconds}`, '-f', 'lavfi', '-i', `testsrc2=s=1280x180:r=15:d=3,crop=320:180:'mod(t*1500,960)':0`,
    '-f', 'lavfi', '-i', `aevalsrc='0.03*sin(2*PI*300*t)':s=48000:d=${seconds}`,
    '-filter_complex', '[1:v]setpts=PTS+40/TB[m];[0:v][m]overlay=eof_action=pass[v]', '-map', '[v]', '-map', '2:a', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-t', String(seconds), file], { timeout: 120_000 });
}

test('contact sheets tile frames with their times and skip unreadable ones', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'sprityreels-sheet-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'v.mp4');
  await silentHighlight(file, 12);
  const frames = await grabFrames(file, [1, 5, 11.5, 30], { width: 320 });
  assert.equal(frames.filter(Boolean).length, 3, 'a time past the end gives no frame');
  assert.equal(frames[3], null);
  const tile = tileSize(16 / 9, 240), sheet = await contactSheet(frames, ['0:01', '0:05', '0:11', '0:30'], { cols: 2, tile, title: 'Test sheet' });
  assert.deepEqual(tile, { w: 240, h: 136 });
  const meta = await sharp(sheet.jpeg).metadata();
  assert.equal(meta.format, 'jpeg'); assert.equal(meta.width, 2 * 240 + 3 * 4); assert.equal(meta.height, 30 + 2 * 136 + 3 * 4);
  assert.deepEqual(tileSize(9 / 16, 240), { w: 136, h: 240 });
  assert.equal((await import('node:fs/promises').then(fs => fs.readdir(root))).length, 1, 'frames are read into memory: no frame file is written');
});

class VisionDirector implements TextDirector {
  readonly vision = true;
  calls: { request: DirectorRequest; sizes: number[] }[] = [];
  async status() { return { available: true, connected: true, message: 'Ready.' }; }
  async generate(request: DirectorRequest): Promise<DirectorAnswer> {
    this.calls.push({ request, sizes: await Promise.all((request.images ?? []).map(async f => (await stat(f)).size)) });
    return { text: JSON.stringify({ moments: [{ kind: 'action', startSentence: -1, endSentence: -1, startSeconds: 30, endSeconds: 46, teaserStartSentence: -1, teaserEndSentence: -1, title: 'Pattern appears', hook: 'Wait for it', reason: 'the picture changes', hookScore: 7, flowScore: 7, valueScore: 7, trendScore: 5, hashtags: [], keywords: [] }] }), model: 'vision-test' };
  }
  dispose() {}
}
test('imports watch the picture: silent highlights become action picks, and a vision director sees contact sheets', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'sprityreels-clips-vision-'));
  const codex = new VisionDirector();
  const service = new ClipStudioService(path.join(root, 'clips'), { projectRoot: root, tools: testTools, transcriber: async () => ({ words: [], language: 'en', model: 'test' }), directors: { codex }, launcher: { find: async () => null, open: async () => ({ stop: async () => {} }) } });
  t.after(async () => { await service.dispose(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });
  await service.saveSettings({ minSeconds: 8, maxSeconds: 20, count: 2 });
  const file = path.join(root, 'silent.mp4');
  await silentHighlight(file);
  async function* body() { yield new Uint8Array(await readFile(file)); }
  const { source, job } = await service.importUpload('silent.mp4', body(), 0, { rights: 'own' });
  assert.equal(source.stages.visual?.status, 'pending');
  const done = await until(async () => service.job(job.id), j => j.status !== 'running' && j.status !== 'queued');
  assert.equal(done.status, 'done', JSON.stringify(done));
  const src = await service.getSource(source.id);
  assert.equal(src.stages.visual?.status, 'done', JSON.stringify(src.stages.visual));
  assert.match(src.stages.visual!.message, /1 burst of on-screen action/);
  assert.equal((await stat(path.join(root, 'clips', 'sources', source.id, 'visual.bin'))).size, 60 * VISUAL_RATE);
  const [set] = await service.momentSets(source.id);
  const action = set.moments.find(m => m.kind === 'action');
  assert.ok(action && action.start <= 36 && action.end >= 43, JSON.stringify(set.moments.map(m => [m.kind, m.start, m.end, m.reason])));
  assert.match(action!.reason, /seen, not heard/);
  const page = await service.transcriptPage(source.id);
  assert.equal(page.pictureWatched, true);
  assert.ok(page.actionPeaks.some(p => p.at >= 40 && p.at <= 43 && p.picture > 0 && p.audioDb === 0), JSON.stringify(page.actionPeaks));

  // Agents (MCP) look at the video through a contact sheet.
  const frames = await service.frames(source.id, { start: 38, end: 44, count: 4 });
  assert.equal(frames.mimeType, 'image/jpeg'); assert.deepEqual(frames.times, [38, 40, 42, 44]);
  assert.equal((await sharp(Buffer.from(frames.data, 'base64')).metadata()).format, 'jpeg');
  await assert.rejects(service.frames(source.id, { start: 50, end: 40 }), /after start/);
  await assert.rejects(service.frames(source.id, { times: [1, 999] }), /inside the video/);

  // A vision director gets the prompt plus an overview and the action peaks up close; the sheets are gone afterwards.
  const ranked = await service.findMoments(source.id, { engine: 'codex', userRequestedGeneration: true, genre: 'gaming' });
  const finished = await until(async () => service.job(ranked.job!.id), j => j.status !== 'running' && j.status !== 'queued');
  assert.equal(finished.status, 'done', JSON.stringify(finished));
  const call = codex.calls[0];
  assert.equal(call.request.images?.length, 2, 'an overview and one sheet of action peaks');
  assert.ok(call.sizes.every(size => size > 5000));
  assert.match(call.request.prompt, /Image 1 is a storyboard of \d+ frames chosen across the video/);
  assert.match(call.request.prompt, /marked “cut”/);
  assert.match(call.request.prompt, /Image 2 shows action peaks, one row each: row 1 is the peak at 4\d\.\d s \(seen\)/);
  for (const f of call.request.images!) await assert.rejects(stat(f));
  assert.equal(await service.vault.files(), 0, 'no frame file is left once the model has answered');
  assert.equal(service.vault.size, 0);
  // What the picture scan keeps is numbers: scene times, hashes and change scores, no pictures.
  const evidence = JSON.parse(await readFile(path.join(root, 'clips', 'sources', source.id, 'evidence.json'), 'utf8'));
  assert.equal(evidence.format, 'sprityreels-evidence'); assert.match(evidence.note, /No pictures/);
  assert.ok(evidence.candidates.length >= 30 && evidence.candidates.every((c: { perceptualHash: string }) => /^[0-9a-f]{32}$/.test(c.perceptualHash)));
  const codexSet = (await service.momentSets(source.id))[0];
  assert.equal(codexSet.engine, 'codex'); assert.equal(codexSet.moments[0].kind, 'action');

  // A source imported without the picture pass can run it later.
  async function* again() { yield new Uint8Array(await readFile(file)); }
  const plain = await service.importUpload('plain.mp4', again(), 0, { rights: 'own', watch: 'false' });
  await until(async () => service.job(plain.job.id), j => j.status !== 'running' && j.status !== 'queued');
  assert.equal((await service.getSource(plain.source.id)).stages.visual?.status, 'skipped');
  const watching = await service.watchSource(plain.source.id);
  await until(async () => service.job(watching.id), j => j.status !== 'running' && j.status !== 'queued');
  assert.equal((await service.getSource(plain.source.id)).stages.visual?.status, 'done');
});
