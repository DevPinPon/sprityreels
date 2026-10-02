import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { unzipSync } from 'fflate';
import type { ClipShort, ClipTranscript, ClipWord } from '../src/engine/clips/types';
import { DEFAULT_CLIP_SETTINGS, applyShortPatch, newShort, validateSourceUrl } from '../src/engine/clips/types';
import { alignEnvelope, energyEnvelope, makeTranscript, refineWithEnergy, sentencesFrom, wordsFromJson3, wordsFromWhisper } from '../src/engine/clips/transcript';
import { localMoments, parseMomentReply } from '../src/engine/clips/moments';
import { buildTimeline, keptRanges } from '../src/engine/clips/timeline';
import { CAPTION_PRESET_DEFS, activeColor, assText, buildAss, buildSrt, captionCards } from '../src/engine/clips/captions';
import type { FaceSample } from '../src/engine/clips/reframe';
import { cameraAt, cropExpression, planCamera } from '../src/engine/clips/reframe';
import { parseScriptReply } from '../src/engine/clips/script';
import { geminiCost } from '../src/engine/clips/pricing';
import { createApp } from '../server/app';
import type { AppOptions } from '../server/app';
import { GeminiClient, GeminiKeys, UsageLedger, pcmToWav } from '../server/clips/gemini';
import { fontMeasurer } from '../server/clips/fonts';
import type { ClipTools } from '../server/clips/tools';
import { ffmpegMajor, filterGraphArgs, probeMedia, run } from '../server/clips/tools';

const FONTS = path.resolve('public/fonts/clips');
const w = (t: string, s: number, e: number): ClipWord => ({ t, s, e });

// ------------------------------------------------------------ transcripts
test('whisper DTW words are refined by loudness; captions, sentences and section sync parse', () => {
  // DTW token times land near each token's end; " You" starts after a pause that its span covers.
  const json = { result: { language: 'en' }, transcription: [
    { tokens: [{ text: '[_BEG_]', t_dtw: -1 }, { text: ' Hello', offsets: { from: 0, to: 400 }, t_dtw: 45 }, { text: ' world', offsets: { from: 400, to: 800 }, t_dtw: 90 }, { text: '.', offsets: { from: 800, to: 820 }, t_dtw: 95 }] },
    { tokens: [{ text: ' You', offsets: { from: 900, to: 900 }, t_dtw: 170 }, { text: ' win', offsets: { from: 900, to: 910 }, t_dtw: 200 }, { text: '!', t_dtw: 205 }] },
  ] };
  const energy = new Uint8Array(250).fill(20);
  for (let i = 5; i < 95; i++) energy[i] = 80;      // "Hello world." 0.05-0.95 s
  for (let i = 150; i < 205; i++) energy[i] = 80;   // "You win!" 1.50-2.05 s (silence 0.95-1.50)
  const raw = wordsFromWhisper(json, 0), refined = wordsFromWhisper(json, 0, energy);
  assert.deepEqual(raw.map(x => x.t), ['Hello', 'world.', 'You', 'win!']);
  assert.ok(raw[2].s < 1, 'without loudness the word starts at the previous boundary');
  assert.ok(refined[2].s >= 1.45 && refined[2].s <= 1.55, `"You" moves to the end of the pause (${refined[2].s})`);
  assert.ok(refined.every((x, i) => i === 0 || x.s >= refined[i - 1].s), 'words stay ordered');
  // Offsets shift words onto the source timeline (chunked transcription).
  assert.equal(wordsFromWhisper(json, 10)[0].s, 10);

  const captions = wordsFromJson3({ events: [{ tStartMs: 1000, dDurationMs: 2000, segs: [{ utf8: 'this is' }, { utf8: ' great', tOffsetMs: 900 }] }, { tStartMs: 1500, aAppend: 1, segs: [{ utf8: '\n' }] }, { tStartMs: 4000, dDurationMs: 800, segs: [{ utf8: '[Music]' }] }] }, 10);
  assert.deepEqual(captions.map(x => x.t), ['this', 'is', 'great']);
  assert.equal(captions[0].s, 1); assert.equal(captions[2].s, 1.9);

  const words = ['Hi', 'there.', 'So', 'here', 'is', 'the', 'thing'].map((t, i) => w(t, i * .4, i * .4 + .3)).concat([w('after', 5, 5.3), w('pause', 5.4, 5.7)]);
  assert.deepEqual(sentencesFrom(words).map(s => [s.a, s.b]), [[0, 1], [2, 6], [7, 8]]);

  // A section that starts 0.37 s earlier than requested is found by matching loudness patterns.
  const full = new Uint8Array(3000); for (let i = 0; i < full.length; i++) full[i] = 30 + Math.round(40 * Math.abs(Math.sin(i / 7) * Math.sin(i / 53)));
  const part = full.slice(1463, 1463 + 900), a = alignEnvelope(full, part, 15);
  assert.ok(Math.abs(a.offset - 14.63) < .011 && a.confidence > .99, JSON.stringify(a));
  const pcm = new Int16Array(16000); for (let i = 8000; i < 16000; i++) pcm[i] = Math.round(8000 * Math.sin(i / 3));
  const env = energyEnvelope(pcm, 16000);
  assert.equal(env.length, 100); assert.ok(env[10] < 10 && env[90] > 70);
  assert.ok(refineWithEnergy([], env).length === 0);
});

// ------------------------------------------------------------ ranking
function podcast(): ClipTranscript {
  const lines = [
    'Welcome back to the show everybody.', 'Today we have a lot to cover about the weather and the news.', 'Let me read a few messages from listeners first.', 'Thanks to everyone who wrote in this week.',
    'And that was the update on the local sports teams.', 'Okay moving on to the next topic now.',
    'Here is the secret nobody tells you about money?', 'Your salary is not the problem, your habits are the problem.', 'The first time I got a raise I bought a car I could not afford and I was broke by summer.', 'So automate your savings on payday, before you ever see the money!', 'If you never see it, you never miss it.',
    'Anyway, back to the schedule for next week.', 'We will talk to a guest about gardening.', 'That is all for now, see you soon.',
  ];
  const words: ClipWord[] = []; let t = 1;
  for (const line of lines) { for (const token of line.split(' ')) { words.push(w(token, t, t + .28)); t += .33; } t += .9; }
  return makeTranscript(words, { engine: 'whisper', language: 'en', model: 'test', duration: t + 1 });
}
test('local moments find the hook, the payoff and the most replayed part without overlaps', () => {
  const t = podcast(), secret = t.sentences[6].s;
  // Viewers replay the whole money advice (from the question to "you never miss it").
  const heat = Array.from({ length: 50 }, (_, i) => ({ s: i * t.duration / 50, e: (i + 1) * t.duration / 50, v: Math.abs(i * t.duration / 50 - secret - 11) < 12 ? 1 : .15 }));
  const ctx = { title: 'Money habits', creator: 'Test Show', description: '', heatmap: heat, chapters: [] };
  const moments = localMoments(t, ctx, { count: 3, minSeconds: 10, maxSeconds: 30, prompt: '', genre: 'podcast', range: null });
  assert.ok(moments.length >= 2);
  const top = moments[0];
  assert.ok(top.start <= secret + .1 && top.end >= t.sentences[9].e - .1, `top moment covers the money advice (${top.start}-${top.end})`);
  assert.match(top.hook, /secret nobody tells you/i); assert.ok(top.score > moments[moments.length - 1].score);
  assert.ok(top.scores.trend >= 6, 'the most replayed part raises the trend score');
  assert.ok(top.hashtags.includes('shorts') && top.hashtags.includes('podcast'));
  for (const a of moments) for (const b of moments) if (a !== b) assert.ok(Math.min(a.end, b.end) - Math.max(a.start, b.start) <= .25 * Math.min(a.end - a.start, b.end - b.start) + 1e-6);
  for (const m of moments) { assert.ok(m.end - m.start <= 31 && m.end - m.start >= 9.8); assert.ok(m.score >= 0 && m.score <= 99); }
  // A prompt keeps only matching moments.
  const garden = localMoments(t, ctx, { count: 3, minSeconds: 3, maxSeconds: 12, prompt: 'gardening guest', genre: 'auto', range: null });
  assert.ok(garden.length >= 1 && garden[0].start >= t.sentences[11].s - 4, JSON.stringify(garden.map(m => [m.start, m.end])));
});

test('AI moment and script replies are validated, snapped to sentences and cleaned', () => {
  const t = podcast(), ctx = { title: 'x', creator: 'y', description: '', heatmap: [], chapters: [] }, opts = { count: 5, minSeconds: 10, maxSeconds: 30, prompt: '', genre: 'auto' as const, range: null };
  const reply = '```json\n' + JSON.stringify({ moments: [
    { startSentence: 6, endSentence: 10, teaserStartSentence: 10, teaserEndSentence: 10, title: 'The money secret', hook: 'Nobody\u0007 tells you this', reason: 'Strong', hookScore: 9, flowScore: 8, valueScore: 9, trendScore: 7, hashtags: ['#Money', 'saving tips'], keywords: ['money'] },
    { startSentence: 7, endSentence: 9, title: 'overlaps', hook: 'dup', reason: '', hookScore: 5, flowScore: 5, valueScore: 5, trendScore: 5, hashtags: [], keywords: [] },
    { startSentence: 99, endSentence: 120, title: 'outside', hook: 'x', reason: '', hookScore: 9, flowScore: 9, valueScore: 9, trendScore: 9, hashtags: [], keywords: [] },
    { startSentence: 12, endSentence: 12, title: 'too short, grown', hook: 'Gardening', reason: '', hookScore: 3, flowScore: 3, valueScore: 3, trendScore: 3, hashtags: [], keywords: [] },
  ] }) + '\n```';
  const moments = parseMomentReply(reply, t, ctx, opts, 'gemini');
  assert.equal(moments.length, 2, 'overlapping and out-of-range picks are dropped');
  assert.equal(moments[0].hook, 'Nobody tells you this'); assert.deepEqual(moments[0].hashtags, ['Money', 'savingtips']);
  assert.ok(moments[0].teaser && moments[0].teaser.start >= moments[0].start);
  assert.ok(moments[1].end - moments[1].start >= 10, 'a short pick grows by whole sentences to the minimum length');
  assert.equal(moments[0].engine, 'gemini'); assert.equal(moments[0].score, Math.round((9 * .3 + 8 * .25 + 9 * .25 + 7 * .2) * 9.9));
  assert.throws(() => parseMomentReply('I cannot help with that', t, ctx, opts, 'gemini'), /format/);

  const script = parseScriptReply(JSON.stringify({ title: 'T', hook: 'H', description: 'D', hashtags: ['#a'], segments: [
    { type: 'voice', text: 'Wait until you hear this [dramatic pause] **really**.', style: 'hyped', startSentence: 6, endSentence: 6 },
    { type: 'quote', text: '', style: '', startSentence: 7, endSentence: 9 },
    { type: 'voice', text: 'Do you agree?', style: '', startSentence: 99, endSentence: 99 },
  ] }), t, { start: t.sentences[6].s, end: t.sentences[10].e });
  assert.deepEqual(script.segments.map(s => s.kind), ['voice', 'source', 'voice']);
  assert.equal((script.segments[0] as { text: string }).text, 'Wait until you hear this really.');
  const quote = script.segments[1] as { start: number; end: number };
  assert.ok(Math.abs(quote.start - (t.sentences[7].s - .08)) < 1e-6 && quote.end > t.sentences[9].e);
  assert.ok((script.segments[2] as { broll: number }).broll <= t.sentences[13].s + 1e-3, 'footage indices are clamped near the moment');
});

// ------------------------------------------------------------ editing
function shortFor(segments: ClipShort['segments'], patch: object = {}) {
  return applyShortPatch(newShort({ id: '00000000-0000-4000-8000-000000000001', sourceId: '00000000-0000-4000-8000-000000000002', name: 'Test', mode: 'clip', segments, defaults: DEFAULT_CLIP_SETTINGS, creditText: 'Credit: Test' }), patch, 100);
}
test('timelines cut pauses and fillers on frame boundaries, move caption words and punch in on jump cuts', () => {
  const words = [w('So', 1, 1.2), w('um,', 1.3, 1.6), w('this', 1.7, 1.9), w('works.', 1.95, 2.3), w('After', 4.5, 4.8), w('a', 4.85, 4.9), w('pause.', 4.95, 5.4)];
  const kept = keptRanges(words, .5, 6, { silence: true, fillers: true, maxPause: .45 });
  assert.equal(kept.length, 3, JSON.stringify(kept));
  assert.ok(kept[0].e <= 1.3 && kept[1].s >= 1.6 - .01, 'the filler is cut out');
  const short = shortFor([{ id: 'seg0001', kind: 'source', start: .5, end: 6 }], { wordEdits: { s2: 'THIS', s5: '' } });
  const tl = buildTimeline(short, { words }, { fps: 30, keywords: ['works'] });
  for (const p of tl.pieces) { assert.ok(Math.abs(p.out * 30 - Math.round(p.out * 30)) < 1e-6 && Math.abs(p.dur * 30 - Math.round(p.dur * 30)) < 1e-6, 'frame-aligned'); }
  assert.ok(tl.removed > 2 && tl.duration < 3.5, `${tl.removed} s removed, ${tl.duration} s left`);
  assert.deepEqual(tl.pieces.map(p => p.zoom), [1, 1.12, 1], 'punch-ins alternate on jump cuts');
  assert.deepEqual(tl.words.map(x => x.text), ['So', 'THIS', 'works.', 'After', 'pause.'], 'fillers and hidden words leave the captions; edits apply');
  assert.ok(tl.words.find(x => x.text === 'works.')!.emphasis);
  for (const x of tl.words) assert.ok(x.s >= 0 && x.e <= tl.duration + 1e-6);
  const after = tl.words.find(x => x.text === 'After')!, piece = tl.pieces[2];
  assert.ok(Math.abs(after.s - (piece.out + (4.5 - piece.src))) < 1e-3, 'words keep their place inside a piece');
  const voice = shortFor([{ id: 'seg0002', kind: 'voice', text: 'Hello there friends', style: '', broll: 2, audio: null }]);
  assert.throws(() => buildTimeline(voice, { words }, { fps: 30 }), /voiceover/);
  assert.equal(buildTimeline(voice, { words }, { fps: 30, voiceEstimate: true }).words.length, 3);
  assert.throws(() => applyShortPatch(short, { captions: { preset: 'fancy' } }, 100), /preset/);
  assert.throws(() => applyShortPatch(short, { unknown: 1 }, 100), /Unsupported/);
  assert.throws(() => validateSourceUrl('file:///C:/secret.mp4'), /http/);
  assert.throws(() => validateSourceUrl('http://127.0.0.1:5173/api/clips'), /private or local addresses/);
  assert.equal(validateSourceUrl('https://www.youtube.com/watch?v=abc'), 'https://www.youtube.com/watch?v=abc');
});

test('ASS captions escape transcript text, follow word timing and measure real glyphs', () => {
  const measure = fontMeasurer(FONTS);
  assert.ok(measure('Poppins Black', 'Your salary is', 102, 2) < measure('Poppins Black', 'Your salary is not the problem', 102, 2));
  assert.equal(assText('{\\an8}hack\\N'), '(∖an8)hack∖N');
  const words = [{ key: 's0', text: '{\\pos(0,0)}Evil', s: 0, e: .4, emphasis: false, end: false, voice: false }, { key: 's1', text: 'salary', s: .45, e: .9, emphasis: true, end: false, voice: false }, { key: 's2', text: 'is', s: .95, e: 1.2, emphasis: false, end: true, voice: false }, { key: 's3', text: 'Next', s: 2, e: 2.4, emphasis: false, end: false, voice: false }];
  const short = shortFor([{ id: 'seg0003', kind: 'source', start: 0, end: 3 }]);
  const cards = captionCards(words, short.captions, 1080, measure);
  assert.equal(cards.length, 2, 'a sentence end starts a new card');
  const clean = captionCards(['Your', 'salary', 'is'].map((text, i) => ({ key: 's' + i, text, s: i * .3, e: i * .3 + .25, emphasis: false, end: false, voice: false })), short.captions, 1080, measure);
  assert.equal(clean.length, 1); assert.equal(clean[0].lines.length, 1, 'real glyph widths keep a short phrase on one line');
  const ass = buildAss({ timeline: { duration: 3, fps: 30, pieces: [], words, voiceWindows: [], removed: 0 }, short: { ...short, hook: { enabled: true, text: 'Hook {\\b1}', seconds: 1.5 } }, hookText: 'Hook {\\b1}', creditText: 'Credit: A', measure });
  assert.ok(!ass.includes('{\\pos(0,0)}') && ass.includes('(∖pos(0,0))Evil'), 'data never becomes override tags');
  assert.ok(ass.includes('Hook (∖b1)'));
  const dialogues = ass.split('\n').filter(l => l.startsWith('Dialogue: 2,'));
  assert.equal(dialogues.length, 4, 'one event per spoken word');
  assert.ok(dialogues[1].startsWith('Dialogue: 2,0:00:00.45,0:00:00.95,'), dialogues[1]);
  assert.match(ass, /PlayResX: 1080\nPlayResY: 1920/); assert.match(ass, /Style: Caption,Poppins Black,102,/);
  assert.ok(ass.includes('\\clip(0,1908,0,1920)\\t(0,3000,\\clip(0,1908,1080,1920))'), 'the progress bar grows over the whole short');
  assert.equal(activeColor(CAPTION_PRESET_DEFS.comic, '#FFE600'), '#FFFFFF', 'a yellow highlight on yellow text switches to white');
  const srt = buildSrt(words);
  assert.equal(srt, '1\n00:00:00,000 --> 00:00:01,200\n(\\pos(0,0))Evil salary is\n\n2\n00:00:02,000 --> 00:00:02,500\nNext\n');
});

// ------------------------------------------------------------ reframing
test('the camera follows the talking face, holds inside a dead zone and cuts on speaker and scene changes', () => {
  const samples: FaceSample[] = [];
  for (let i = 0; i <= 100; i++) {
    const t = i / 10, cut = t >= 8, aTalks = t < 4, bTalks = t >= 4 && t < 8;
    const jitter = Math.sin(i * 1.7) * .004;
    samples.push({ t, faces: cut ? [{ x: .5, y: .45, w: .2, h: .3, jaw: .1 + (i % 3) * .1, mouth: .05, score: 1 }] : [
      { x: .3 + jitter, y: .4, w: .12, h: .2, jaw: aTalks ? .05 + (i % 2) * .35 : .05, mouth: aTalks ? .05 + (i % 2) * .08 : .02, score: 1 },
      { x: .7 - jitter, y: .4, w: .12, h: .2, jaw: bTalks ? .05 + (i % 2) * .35 : .05, mouth: bTalks ? .05 + (i % 2) * .08 : .02, score: 1 }] });
  }
  const words = Array.from({ length: 50 }, (_, i) => w('word', i * .2, i * .2 + .15));
  const plan = planCamera({ track: { format: 'sprityreels-face-track', version: 1, width: 1920, height: 1080, fps: 10, delegate: 'GPU', ranges: [{ s: 0, e: 10 }], samples, scenes: [8] }, words, layout: 'auto', srcW: 1920, srcH: 1080, outW: 1080, outH: 1920 });
  assert.equal(plan.layout, 'tracked'); assert.ok(plan.speakers >= 2);
  const winW = Math.round(1080 * 9 / 16), centre = (t: number) => (cameraAt(plan.primary, t).x + winW / 2) / 1920;
  assert.ok(Math.abs(centre(1) - .3) < .03, `speaker A first (${centre(1)})`);
  assert.ok(Math.abs(centre(6) - .7) < .03, `then speaker B (${centre(6)})`);
  assert.ok(Math.abs(centre(9) - .5) < .03, `new shot after the scene cut (${centre(9)})`);
  const switchKey = plan.primary.find(k => k.cut && k.t > 3 && k.t < 8)!;
  assert.ok(switchKey && switchKey.t >= 4.4 && switchKey.t <= 5.5, `the switch waits for a sustained new speaker (${switchKey?.t})`);
  assert.ok(!plan.primary.some(k => !k.cut && k.t > .5 && k.t < 3.8), 'landmark jitter never moves the camera');
  assert.ok(plan.primary.some(k => k.cut && Math.abs(k.t - 8) < .11), 'the scene cut is a hard cut');
  assert.match(cropExpression(plan.primary, 'x', 3, 3), /^if\(lt\(t,/, 'a piece crossing the speaker change switches inside the expression');
  assert.equal(cropExpression(plan.primary, 'x', 1, 1), String(cameraAt(plan.primary, 1).x));
  const none = planCamera({ track: null, words, layout: 'auto', srcW: 1920, srcH: 1080, outW: 1080, outH: 1920 });
  assert.equal(none.layout, 'fit');
  assert.equal(planCamera({ track: null, words, layout: 'split', srcW: 1920, srcH: 1080, outW: 1080, outH: 1920 }).layout, 'center');
});

// ------------------------------------------------------------ Gemini client
test('Gemini requests use structured JSON and TTS with store off, bill the ledger and never expose the key', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'sprityreels-gemini-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const keys = new GeminiKeys(path.join(root, 'keys', 'gemini.json')), ledger = new UsageLedger(path.join(root, 'usage.jsonl'));
  const saved = process.env.GEMINI_API_KEY; delete process.env.GEMINI_API_KEY; t.after(() => { if (saved !== undefined) process.env.GEMINI_API_KEY = saved; });
  const calls: { url: string; headers: Record<string, string>; body: any }[] = [];
  let mode: 'ok' | '401' | '429' = 'ok';
  const fetchStub = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)); calls.push({ url, headers: init.headers as Record<string, string>, body });
    if (mode === '401') return new Response(JSON.stringify({ error: { message: 'API key not valid. key=SECRET' } }), { status: 400 });
    if (mode === '429') return new Response('{}', { status: 429 });
    if (body.response_format.type === 'audio') return new Response(JSON.stringify({ steps: [{ type: 'model_output', content: [{ type: 'audio', data: pcmToWav(Buffer.alloc(48000), 24000).toString('base64') }] }], usage: { total_input_tokens: 12, total_output_tokens: 25 } }));
    return new Response(JSON.stringify({ steps: [{ type: 'thought' }, { type: 'model_output', content: [{ type: 'text', text: '{"ok":' }, { type: 'text', text: 'true}' }] }], usage: { total_input_tokens: 1000, total_output_tokens: 200, total_thought_tokens: 100 } }));
  }) as typeof fetch;
  const client = new GeminiClient(keys, ledger, fetchStub, 1);
  await assert.rejects(client.json({ system: 's', prompt: 'p', schema: {}, kind: 'moments' }), /GEMINI_API_KEY is missing/);
  await assert.rejects(keys.save('short'), /does not look like/);
  const key = 'AIzaTESTKEY_0123456789abcdefghijklmnop';
  await keys.save(key);
  assert.deepEqual(await keys.status(), { configured: true, source: 'file', hint: '…mnop' });
  const answer = await client.json({ system: 'sys', prompt: 'find moments', schema: { type: 'object' }, kind: 'moments', sourceId: 'src' });
  assert.equal(answer.text, '{"ok":true}');
  const req = calls[0];
  assert.equal(req.url, 'https://generativelanguage.googleapis.com/v1beta/interactions'); assert.equal(req.headers['x-goog-api-key'], key);
  assert.equal(req.body.store, false); assert.equal(req.body.model, 'gemini-3.8-flash'); assert.equal(req.body.system_instruction, 'sys');
  assert.deepEqual(req.body.response_format, { type: 'text', mime_type: 'application/json', schema: { type: 'object' } });
  assert.equal(answer.usage.outputTokens, 300, 'thinking tokens bill as output');
  const speech = await client.speech({ model: 'gemini-3.8-flash-tts', text: 'Hello', style: 'warm', voice: 'Kore', shortId: 'short1' });
  assert.equal(speech.seconds, 1); assert.equal(speech.wav.toString('ascii', 0, 4), 'RIFF');
  assert.deepEqual(calls[1].body.input, [{ type: 'user_input', content: [{ type: 'text', text: 'Hello', annotations: [{ type: 'speech_metadata', style: 'warm' }] }] }]);
  assert.deepEqual(calls[1].body.generation_config, { speech_config: [{ voice: 'Kore' }] });
  const summary = await ledger.summary();
  assert.equal(summary.calls, 2); assert.equal(summary.voiceSeconds, 1);
  assert.ok(Math.abs(summary.monthUsd - (geminiCost('gemini-3.8-flash', 1000, 300) + geminiCost('gemini-3.8-flash-tts', 12, 25))) < 1e-7);
  assert.ok(Math.abs(summary.byShort.short1 - geminiCost('gemini-3.8-flash-tts', 12, 25)) < 1e-7);
  mode = '401';
  await assert.rejects(client.json({ system: 's', prompt: 'p', schema: {}, kind: 'moments' }), (e: Error) => /rejected the API key/.test(e.message) && !e.message.includes(key) && !e.message.includes('SECRET'));
  mode = '429'; const before = calls.length;
  await assert.rejects(client.json({ system: 's', prompt: 'p', schema: {}, kind: 'moments' }), /rate limit/);
  assert.equal(calls.length - before, 2, 'rate limits retry once');
  assert.ok(!(await readFile(path.join(root, 'usage.jsonl'), 'utf8')).includes(key));
});

// ------------------------------------------------------------ service and website API
test('the filter graph file option matches the installed FFmpeg (6.x needs -filter_complex_script)', async () => {
  assert.deepEqual(filterGraphArgs(6, 'graph.txt'), ['-filter_complex_script', 'graph.txt']);
  assert.deepEqual(filterGraphArgs(7, 'graph.txt'), ['-/filter_complex', 'graph.txt']);
  assert.ok(await ffmpegMajor() >= 4, 'FFmpeg is installed for the render tests');
});

async function makeVideo(file: string, seconds: number) {
  // 16:9 test pattern with "speech": 2 s tone bursts and 1 s silences, so trimming and loudness have real signal.
  await run('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=s=640x360:r=30:d=${seconds}`, '-f', 'lavfi', '-i', `aevalsrc='0.3*sin(2*PI*220*t)*lt(mod(t,3),2)':s=48000:d=${seconds}`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', file], { timeout: 120_000 });
}
/** Words over each tone burst; the transcriber stands in for whisper so tests are fast and deterministic. */
function fakeTranscriber(seconds: number) {
  const lines = ['Here is the secret nobody tells you?', 'Your habits are the real problem.', 'Save money every payday!', 'You will never miss it.', 'Most people wait too long.', 'Start small and start today.', 'That is the whole trick.', 'Thanks for watching this.', 'See you next week.', 'Bye for now everyone.'];
  return async () => {
    const words: ClipWord[] = [];
    for (let k = 0; k * 3 + 2 <= seconds; k++) { const tokens = lines[k % lines.length].split(' '); tokens.forEach((t, i) => words.push(w(t, k * 3 + .1 + i * 1.8 / tokens.length, k * 3 + .1 + (i + .85) * 1.8 / tokens.length))); }
    return { words, language: 'en', model: 'test transcriber' };
  };
}
const testTools = async (): Promise<ClipTools> => ({ ytdlp: null, whisper: null, whisperModel: null, whisperGpu: null, ffmpeg: true, nvenc: false, fonts: FONTS, cacheDir: tmpdir() });
async function until<T>(read: () => Promise<T>, done: (v: T) => boolean, ms = 180_000) {
  const end = Date.now() + ms;
  for (;;) { const v = await read(); if (done(v)) return v; if (Date.now() > end) throw new Error(`Timed out: ${JSON.stringify(v).slice(0, 400)}`); await new Promise(r => setTimeout(r, 200)); }
}

// ------------------------------------------------------------ the website on a real HTTP server
/** The website's request layer on a real server; every visitor is a cookie jar of their own. */
async function startSite(t: { after: (fn: () => unknown) => void }, extra: Partial<AppOptions> = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'sprityreels-site-'));
  const opened: string[] = [];
  let origin = '';
  const app = createApp({ root, dataDir: path.join(root, 'data'), origin: () => origin, resolveHost: async () => [{ address: '93.184.216.34' }], minFreeBytes: 0, ...extra,
    service: { tools: testTools, transcriber: fakeTranscriber(30), directors: {}, launcher: { find: async () => 'test-browser', open: async (_b, url) => { opened.push(url); return { stop: async () => {} }; } }, ...extra.service } });
  const http = createServer((req, res) => void app.handle(req, res, () => { res.statusCode = 404; res.end(); }));
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  t.after(async () => { http.closeAllConnections(); await new Promise<void>(r => http.close(() => r())); await app.dispose(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });
  const visitor = () => {
    let cookie = '';
    const raw = async (route: string, init: RequestInit = {}) => {
      const res = await fetch(origin + route, { ...init, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(init.headers as Record<string, string>) } });
      const set = res.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
      return res;
    };
    const call = async (route: string, body?: unknown, headers: Record<string, string> = {}) => {
      const res = await raw('/api/clips' + route, body === undefined ? { headers } : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-SprityReels-Request': 'clips', ...headers }, body: JSON.stringify(body) });
      return { status: res.status, data: await res.json().catch(() => null) as any };
    };
    const upload = async (file: string, rights = 'own', note = '') => (await raw(`/api/clips/sources/upload?file=${path.basename(file)}&rights=${rights}&note=${encodeURIComponent(note)}`, { method: 'POST', headers: { 'X-SprityReels-Request': 'clips' }, body: await readFile(file) })).json() as Promise<any>;
    return { raw, call, upload, id: () => cookie.split('=')[1] ?? '' };
  };
  return { root, origin, opened, app, visitor };
}

test('the website API keeps visitors apart and refuses unsigned, cross-site and private requests', async t => {
  const key = 'AIzaTESTKEY_abcdefghijklmnopqrstuvwxyz', saved = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY; t.after(() => { if (saved !== undefined) process.env.GEMINI_API_KEY = saved; else delete process.env.GEMINI_API_KEY; });
  const site = await startSite(t, { aiPerHour: 2, resolveHost: async host => [{ address: host.startsWith('internal') ? '10.0.0.7' : '93.184.216.34' }] }), a = site.visitor(), b = site.visitor();
  // Writes need the website's own header; other origins and other sites are refused.
  assert.equal((await fetch(site.origin + '/api/clips/settings', { method: 'POST', body: '{}' })).status, 403);
  assert.equal((await a.call('', undefined, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await a.call('', undefined, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await fetch(site.origin + '/api/health')).status, 200);
  // The overview says whether AI picks exist, and nothing about the key or what it costs.
  let overview = (await a.call('')).data;
  assert.deepEqual(overview.ai, { gemini: false, claude: false }); assert.ok(!('usage' in overview));
  process.env.GEMINI_API_KEY = key;
  overview = (await a.call('')).data;
  assert.deepEqual(overview.ai, { gemini: true, claude: false }); assert.ok(!JSON.stringify(overview).includes(key.slice(-6)));
  assert.equal((await a.call('/settings/gemini', { key })).status, 404, 'visitors cannot set the operator key');
  delete process.env.GEMINI_API_KEY;

  // A private workspace per visitor.
  const file = path.join(site.root, 'talk.mp4');
  await makeVideo(file, 12);
  const { source, job } = await a.upload(file);
  await until(() => a.call('/jobs/' + job.id), r => r.data.status !== 'running' && r.data.status !== 'queued');
  assert.equal((await a.call('')).data.sources.length, 1);
  assert.equal((await b.call('')).data.sources.length, 0, 'another visitor sees nothing');
  assert.equal((await b.call('/sources/' + source.id)).status, 404);
  assert.equal((await b.raw(`/api/clips/sources/${source.id}/media`)).status, 404);
  assert.equal(site.app.workspaceCount(), 2);

  // Links must come from a known site and may never point inside the network.
  const link = (url: string) => a.call('/sources', { url, rights: 'own' });
  assert.match((await link('https://example.com/v')).data.error, /not supported/);
  assert.equal((await link('http://169.254.169.254/latest/meta-data')).status, 400);
  assert.match((await link('https://internal.youtube.com/watch?v=1')).data.error, /private address/);
  assert.equal((await link('https://www.youtube.com/watch?v=abc')).status, 503, 'a public YouTube link passes the guard and then needs yt-dlp');
  assert.match((await a.call('/sources', { url: 'https://www.youtube.com/watch?v=abc' })).data.error, /right to use/);

  // Only the page this server opened may call the tracker routes.
  assert.equal((await fetch(site.origin + '/api/clips/track/abc')).status, 403);
  assert.equal((await fetch(site.origin + '/api/clips/track/abc', { headers: { 'X-Tracker-Key': 'wrong' } })).status, 403);
  assert.equal((await fetch(site.origin + '/api/clips/track/abc', { headers: { 'X-Tracker-Key': site.app.trackerKey } })).status, 404, 'a valid key still needs a running job');

  // AI-assisted requests are rationed per visitor; the automatic picks are not.
  const ai = () => a.call(`/sources/${source.id}/moments`, { engine: 'gemini', userRequestedGeneration: true });
  assert.notEqual((await ai()).status, 429); assert.notEqual((await ai()).status, 429);
  const limited = await ai();
  assert.equal(limited.status, 429); assert.match(limited.data.error, /limited/);
  assert.equal((await a.call(`/sources/${source.id}/moments`, { count: 2 })).status, 200);
  assert.ok([404, 409].includes((await b.call(`/sources/${source.id}/moments`, { engine: 'gemini', userRequestedGeneration: true })).status), 'the budget is per visitor, and b has no such source');
});

test('uploads above the size limit are refused before any of the body is stored', async t => {
  const site = await startSite(t, { maxUploadBytes: 1000 }), v = site.visitor();
  const res = await v.raw('/api/clips/sources/upload?file=big.mp4&rights=own', { method: 'POST', headers: { 'X-SprityReels-Request': 'clips' }, body: new Uint8Array(5000) });
  assert.equal(res.status, 413); assert.match((await res.json() as any).error, /smaller than/);
  assert.equal((await v.call('')).data.sources.length, 0);
  const bad = await v.raw('/api/clips/sources/upload?file=notes.txt&rights=own', { method: 'POST', headers: { 'X-SprityReels-Request': 'clips' }, body: new Uint8Array(10) });
  assert.equal(bad.status, 400);
});

test('an upload becomes ranked moments and captioned, speaker-framed vertical shorts with a post kit', async t => {
  const site = await startSite(t), v = site.visitor();
  assert.equal((await v.call('/settings', { minSeconds: 6, maxSeconds: 12, count: 3 })).status, 200);
  const clips = () => path.join(site.root, 'data', 'workspaces', v.id(), 'clips');
  const file = path.join(site.root, 'talk.mp4');
  await makeVideo(file, 30);
  const { source, job } = await v.upload(file, 'permission', 'clipping program');
  const imported = await until(() => v.call('/jobs/' + job.id), r => r.data.status !== 'running' && r.data.status !== 'queued');
  assert.equal(imported.data.status, 'done', JSON.stringify(imported.data));
  const detail = (await v.call('/sources/' + source.id)).data;
  assert.equal(detail.source.status, 'ready'); assert.equal(detail.source.transcript.engine, 'whisper'); assert.ok(detail.source.duration > 29);
  assert.equal(detail.moments[0].engine, 'local'); assert.ok(detail.moments[0].moments.length >= 2);
  const top = detail.moments[0].moments[0];
  assert.ok(top.end - top.start <= 12.5);
  assert.match((await v.call(`/sources/${source.id}/moments`, { engine: 'gemini' })).data.error, /userRequestedGeneration/);
  const preview = (await v.call(`/sources/${source.id}/preview`, { start: top.start, end: top.end })).data;
  assert.equal(preview.url, `/api/clips/sources/${source.id}/media`);
  assert.equal((await v.raw(preview.url, { headers: { Range: 'bytes=0-99' } })).status, 206);

  // A clip short with the credit line (permission basis), center crop, rendered with x264.
  const created = (await v.call('/shorts', { sourceId: source.id, momentId: top.id, options: { layout: 'center', captions: { preset: 'impact' } } })).data.short;
  assert.equal(created.overlays.creditText, ''); // uploads have no creator name; the credit line stays empty
  assert.equal((await v.call('/shorts/' + created.id, { revision: 0, name: 'x' })).status, 409);
  const edited = (await v.call('/shorts/' + created.id, { revision: 1, hook: { text: 'Nobody tells you this' }, overlays: { creditText: 'Credit: Test Show' } })).data;
  assert.equal(edited.revision, 2);
  const renderJob = (await v.call(`/shorts/${created.id}/render`, { revision: 2 })).data;
  const rendered = await until(() => v.call('/jobs/' + renderJob.id), r => r.data.status !== 'running' && r.data.status !== 'queued');
  assert.equal(rendered.data.status, 'done', JSON.stringify(rendered.data));
  const info = await probeMedia(path.join(clips(), 'shorts', created.id, 'output.mp4'));
  assert.equal(info.width, 1080); assert.equal(info.height, 1920); assert.equal(info.vcodec, 'h264'); assert.equal(info.acodec, 'aac');
  const shortDetail = (await v.call('/shorts/' + created.id)).data;
  assert.ok(!('costUsd' in shortDetail) && !('voiceEstimateUsd' in shortDetail), 'visitors never see what a call cost');
  assert.ok(Math.abs(info.duration - shortDetail.render.duration) < .1, `${info.duration} vs ${shortDetail.render.duration}`);
  assert.ok(shortDetail.timeline.removed > 1, 'pauses between bursts were trimmed');
  const zip = unzipSync(new Uint8Array(await (await v.raw(`/api/clips/shorts/${created.id}/export`)).arrayBuffer()));
  const names = Object.keys(zip);
  assert.equal(names.length, 5); assert.ok(['cover.jpg', 'post.txt', 'short.json'].every(n => names.includes(n)) && names.some(n => n.endsWith('.mp4')) && names.some(n => n.endsWith('.srt')), names.join());
  assert.match(new TextDecoder().decode(zip['post.txt']), /CREDIT\nCredit: Test Show[\s\S]*Rights basis: permission \(clipping program\)/);
  const range = await v.raw(`/api/clips/shorts/${created.id}/video`, { headers: { Range: 'bytes=0-99' } });
  assert.equal(range.status, 206); assert.equal((await range.arrayBuffer()).byteLength, 100);
  assert.match((await v.raw(`/api/clips/shorts/${created.id}/video?download=1`, { method: 'HEAD' })).headers.get('content-disposition') ?? '', /^attachment; filename=/);

  // Speaker framing: the render opens the headless tracker page; the test plays the worker's part.
  const tracked = (await v.call('/shorts', { sourceId: source.id, start: 3, end: 9, options: { layout: 'tracked', captions: { enabled: false }, hook: { enabled: false } } })).data.short;
  const trackRender = (await v.call(`/shorts/${tracked.id}/render`, { revision: 1 })).data;
  await until(async () => site.opened.length, n => n === 1, 60_000);
  const page = new URL(site.opened[0]), jobId = page.searchParams.get('job')!, key = page.searchParams.get('key')!;
  assert.match(site.opened[0], new RegExp(`^${site.origin}/\\?view=clip-worker&job=`));
  assert.equal(key, site.app.trackerKey);
  const track = (route: string, body?: unknown) => fetch(`${site.origin}/api/clips/track/${route}`, { ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }), headers: { 'Content-Type': 'application/json', 'X-SprityReels-Request': 'clips', 'X-Tracker-Key': key } });
  const trackJob = await until(async () => await (await track(jobId)).json() as any, d => Array.isArray(d.frames));
  assert.ok(trackJob.frames.length >= 30 && trackJob.frames[0].t >= 2.9, `${trackJob.frames.length} frames`);
  assert.ok(await site.app.frames.files() >= 30, 'while tracking, the frames the tracker page reads are files inside the frame vault');
  assert.equal(site.app.frames.size, 1);
  assert.equal((await track(`${jobId}/frame/0`)).headers.get('content-type'), 'image/jpeg');
  const samples = trackJob.frames.map((f: { t: number }) => ({ t: f.t, faces: [{ x: .8, y: .4, w: .1, h: .18, jaw: .2, mouth: .05, score: 1 }] }));
  assert.equal((await track(`${jobId}/samples`, { samples, done: samples.length, delegate: 'GPU' })).status, 200);
  assert.equal((await track(`${jobId}/finish`, { ok: true })).status, 200);
  const trackedDone = await until(() => v.call('/jobs/' + trackRender.id), r => r.data.status !== 'running' && r.data.status !== 'queued');
  assert.equal(trackedDone.data.status, 'done', JSON.stringify(trackedDone.data));
  assert.ok((await stat(path.join(clips(), 'sources', source.id, 'tracks'))).isDirectory());
  // The reel is delivered: not one frame of the video is left anywhere on the server.
  assert.equal(await site.app.frames.files(), 0); assert.equal(site.app.frames.size, 0);
  assert.deepEqual((await readdir(path.join(clips(), 'sources', source.id, 'tracks'))).filter(n => !n.endsWith('.json')), [], 'no frame folder next to the tracks');
  // The crop followed the face on the right: the right part of the 640x360 test pattern fills the frame.
  assert.match(await readFile(path.join(clips(), 'shorts', tracked.id, 'work', 'graph.txt'), 'utf8'), /crop=w=202:h=360:x='411':y='0'/);

  // Every rendered short of the video in one streamed download, with a sheet for bulk scheduling.
  const all = await v.raw(`/api/clips/sources/${source.id}/export`);
  assert.equal(all.status, 200); assert.equal(all.headers.get('content-type'), 'application/zip');
  const kit = unzipSync(new Uint8Array(await all.arrayBuffer())), files = Object.keys(kit).sort();
  const folders = [...new Set(files.filter(f => f.includes('/')).map(f => f.split('/')[0]))];
  assert.equal(folders.length, 2, files.join());
  for (const folder of folders) for (const name of [`${folder}.mp4`, `${folder}.srt`, 'cover.jpg', 'post.txt']) assert.ok(files.includes(`${folder}/${name}`), `${folder}/${name}`);
  const sheet = new TextDecoder().decode(kit['posts.csv']).replace(/^﻿/, '').trim().split('\r\n');
  assert.equal(sheet.length, 3); assert.match(sheet[0], /^folder,video,seconds,title,description,hashtags,edited_since_render$/);
  const sizes = await Promise.all([created.id, tracked.id].map(async id => (await stat(path.join(clips(), 'shorts', id, 'output.mp4'))).size));
  assert.deepEqual(folders.map(f => kit[`${f}/${f}.mp4`].length).sort(), [...sizes].sort(), 'the videos are copied byte for byte');

  // Batch: several moments at once, each rendering on its own.
  const batch = (await v.call('/shorts/batch', { sourceId: source.id, momentIds: detail.moments[0].moments.slice(0, 2).map((m: { id: string }) => m.id), options: { layout: 'center' } })).data;
  assert.equal(batch.shorts.length, 2);
  for (const item of batch.shorts) assert.equal((await until(() => v.call('/jobs/' + item.job.id), r => r.data.status !== 'running' && r.data.status !== 'queued')).data.status, 'done');
  assert.equal((await v.call(`/shorts/${created.id}/delete`, {})).data.deleted, created.id);
  assert.equal((await v.call(`/sources/${source.id}/delete`, { confirm: true })).data.deleted, source.id);
  assert.deepEqual((await v.call('')).data.shorts, []);
});
