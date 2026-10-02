import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ClipLayout, ClipTranscript, ClipWord } from '../src/engine/clips/types';
import { DEFAULT_CLIP_SETTINGS, applyShortPatch, newShort } from '../src/engine/clips/types';
import type { CameraKey, CameraPane, CameraPlan, FaceBox, FaceSample, FaceTrackFile } from '../src/engine/clips/reframe';
import { cameraAt, captionStage, lipSync, parseSceneScores, planCamera, sceneCuts, screenFaces, tiles } from '../src/engine/clips/reframe';
import type { Timeline } from '../src/engine/clips/timeline';
import { buildTimeline } from '../src/engine/clips/timeline';
import { censorMatcher, maskWord } from '../src/engine/clips/censor';
import type { CaptionStage } from '../src/engine/clips/captions';
import { buildAss, placeBox } from '../src/engine/clips/captions';
import { buildGraph, renderShort } from '../server/clips/render';
import { ClipStudioService } from '../server/clips/service';
import type { ClipTools } from '../server/clips/tools';
import { probeMedia, run } from '../server/clips/tools';
import { makeTranscript, reactionsFromJson3, wordsFromJson3 } from '../src/engine/clips/transcript';
import { repairMoment, snapEnd, snapStart, topicBreaks } from '../src/engine/clips/context';
import { excitementPeaks } from '../src/engine/clips/signals';
import { localMoments, parseMomentReply } from '../src/engine/clips/moments';

const w = (t: string, s: number, e: number): ClipWord => ({ t, s, e });
/** One sentence per line, 0.33 s per word, a short breath between lines (and a longer pause where a line is ''). */
function talk(lines: string[], gap = .5): ClipTranscript {
  const words: ClipWord[] = []; let t = 1;
  for (const line of lines) {
    if (!line) { t += 2.5; continue; }
    for (const token of line.split(' ')) { words.push(w(token, t, t + .28)); t += .33; }
    t += gap;
  }
  return makeTranscript(words, { engine: 'whisper', language: 'en', model: 'test', duration: t + 1 });
}
const ctxOf = (extra: object = {}) => ({ title: 'Test', creator: 'Host', description: '', heatmap: [], chapters: [], ...extra });
const opts = (extra: object = {}) => ({ count: 3, minSeconds: 5, maxSeconds: 30, prompt: '', genre: 'auto' as const, range: null, ...extra });

// ------------------------------------------------------------ self-contained boundaries
test('repair pulls in the question an answer needs and the thought a connector continues', () => {
  const t = talk(['Welcome to the show.', 'Today we talk about saving money.', 'What is the one habit that made you rich?', 'Honestly it was automating my savings every single month.', 'I never saw the money so I never missed it.', 'That changed everything for me.']);
  const qa = repairMoment(t, 3, 5, { minSeconds: 5, maxSeconds: 60 });
  assert.equal(qa.a, 2, 'the moment starts at the question');
  assert.deepEqual(qa.checks.find(c => c.id === 'opening'), { id: 'opening', level: 'fixed', text: 'Starts with the question it answers' });
  assert.ok(qa.start < t.sentences[2].s && qa.start > t.sentences[1].e, 'the cut sits in the pause before the question');
  // Without room for the question, the problem is reported instead of hidden.
  const tight = repairMoment(t, 3, 5, { minSeconds: 5, maxSeconds: t.sentences[5].e - t.sentences[3].s + .5 });
  assert.equal(tight.a, 3);
  assert.equal(tight.checks.find(c => c.id === 'opening')!.level, 'warn');

  const and = talk(['The market crashed in two thousand eight.', 'And that is why I stopped trusting banks.', 'I keep my savings in index funds now.']);
  const fixed = repairMoment(and, 1, 2, { minSeconds: 3, maxSeconds: 60 });
  assert.equal(fixed.a, 0); assert.equal(fixed.checks[0].text, 'Starts where the thought begins');
  // "No one…" and "Right now…" are not replies; a clean opener stays put.
  for (const line of ['No one tells you this about money.', 'Right now I am saving half my income.']) {
    const clean = repairMoment(talk(['Some earlier line here.', line, 'It works.']), 1, 2, { minSeconds: 1, maxSeconds: 60 });
    assert.equal(clean.a, 1, line); assert.equal(clean.checks[0].level, 'ok');
  }
});

test('repair finishes setups, answered questions and promised lists', () => {
  const setup = talk(['Most people get this completely wrong.', 'Here\'s why.', 'They save whatever is left at the end of the month.', 'Save first and then spend the rest.']);
  const s = repairMoment(setup, 0, 1, { minSeconds: 1, maxSeconds: 60 });
  assert.equal(s.b, 2); assert.equal(s.checks.find(c => c.id === 'ending')!.text, 'Ends after the payoff');

  const question = talk(['So I asked him the obvious question.', 'Would you do it again?', 'He said absolutely not, never again.']);
  assert.equal(repairMoment(question, 0, 1, { minSeconds: 1, maxSeconds: 60 }).b, 2, 'the answer is included');
  const prompt = talk(['That is my whole system.', 'What do you think?', 'Anyway next topic is gardening.']);
  assert.equal(repairMoment(prompt, 0, 1, { minSeconds: 1, maxSeconds: 60 }).b, 1, 'a question to the viewer is a fine ending');

  const list = talk(['There are three things you need to know.', 'First, spend less than you earn.', 'Second, invest the difference.', 'Third, be patient for decades.', 'That is really all there is to it.', '', 'Now let us talk about my new kitchen.']);
  const l = repairMoment(list, 0, 2, { minSeconds: 1, maxSeconds: 60 });
  assert.equal(l.b, 4, 'the third item and its closing line are included');
  assert.equal(l.checks.find(c => c.id === 'ending')!.text, 'Includes the whole list');
  const cut = repairMoment(list, 0, 2, { minSeconds: 1, maxSeconds: list.sentences[2].e - list.sentences[0].s + .2 });
  assert.equal(cut.checks.find(c => c.id === 'ending')!.text, 'Cuts off a list');
});

test('cuts land in the quietest audio next to the speech and never inside a neighbouring word', () => {
  const energy = new Uint8Array(400).fill(30);
  for (let i = 100; i < 200; i++) energy[i] = 80; // speech 1.00-2.00 s
  for (let i = 60; i < 92; i++) energy[i] = 52;   // a breath until 0.92 s
  const start = snapStart(energy, 1, .2);
  assert.ok(start >= .92 && start <= .98, `start ${start}`);
  assert.equal(snapStart(energy, 1, .95), .97, 'never inside the previous word');
  const end = snapEnd(energy, 2, 3);
  assert.ok(end >= 2.05 && end <= 2.1, `end ${end}`);
  assert.ok(snapEnd(energy, 2, 2.1) <= 2.08, 'never inside the next word');
  assert.equal(snapStart(undefined, 1), .92); assert.equal(snapEnd(undefined, 2), 2.15);
});

test('topic boundaries come from spoken cues, vocabulary shifts and chapters, not from continuations', () => {
  const cooking = ['Boil the pasta in salted water first.', 'The pasta needs about nine minutes to cook.', 'Meanwhile crush garlic for the tomato sauce.', 'Simmer the tomato sauce with the garlic.', 'Drain the pasta and toss it in the sauce.', 'Finish the pasta with basil and parmesan.'];
  const engines = ['The engine needs fresh oil every year.', 'Old engine oil wears out the pistons.', 'Check the engine oil level with the dipstick.', 'Pistons and gearbox parts love clean oil.', 'A healthy engine runs quieter and longer.', 'Change the gearbox oil less often.'];
  const lexical = topicBreaks(talk([...cooking, ...engines]));
  assert.equal([...lexical].indexOf(Math.max(...lexical)), 5, `word overlap alone finds the change (${[...lexical].map(b => b.toFixed(2)).join(' ')})`);
  assert.ok(lexical[5] > .45 && lexical[5] <= .6 && lexical[1] < .2, 'but on its own it is only moderate evidence');
  const t = talk([...cooking, 'Anyway, let us talk about cars.', ...engines]), breaks = topicBreaks(t);
  assert.ok(breaks[5] >= .85, 'a spoken cue makes it a clear boundary');
  const chapter = topicBreaks(t, [{ title: 'Sauce', start: t.sentences[2].s - .2, end: 60 }]);
  assert.equal(chapter[1], 1, 'a chapter start is a boundary');
  // A clip that straddles both topics is flagged.
  const both = repairMoment(t, 3, 8, { minSeconds: 1, maxSeconds: 60, breaks });
  assert.ok(both.checks.some(c => c.id === 'topic' && c.level === 'warn'), JSON.stringify(both.checks));
  // Continuations are never boundaries: "And that is why…", the payoff after "Here is why.", the answer to a question.
  const talkBreaks = topicBreaks(talk(['The market crashed and everyone panicked.', 'And that is why I stopped trusting banks.', 'Most people get budgeting wrong.', 'Here is why.', 'They save what is left over.', 'Why do they do that?', 'Because nobody taught them.']));
  for (const g of [0, 3, 5]) assert.ok(talkBreaks[g] < .2, `gap ${g}: ${[...talkBreaks].map(b => b.toFixed(2)).join(' ')}`);
  assert.ok(talkBreaks[1] >= .45, 'a claim followed by "here is why" opens a new point');
});

test('a whole podcast episode yields picks that each stand alone', () => {
  const lines = [
    'Welcome back to the Money Habits podcast.', 'Today my guest is a financial planner with twenty years of experience.', 'So let us get right into it.',
    'What is the one habit that made you rich?', 'Honestly it was automating my savings on payday.', 'I never saw the money so I never missed it.', 'That single change beat every stock pick I ever made.',
    'And that is why I tell everyone to start small.', 'Even fifty dollars a month compounds into something real.',
    'Most people get budgeting completely wrong.', 'Here is why.', 'They save whatever is left at the end of the month, and nothing is ever left.', 'Pay yourself first, then spend the rest without guilt.',
    'There are three things you need to know about debt.', 'First, pay off the highest interest rate first.', 'Second, never carry a balance on a credit card.', 'Third, do not borrow for things that lose value.', 'That is honestly the whole system.',
    'Anyway, let us talk about my disastrous first investment.', 'I put everything into one company because a friend said it was a sure thing.', 'It went to zero in six months.', 'I was broke, embarrassed, and I had to move back in with my parents.', 'That was the best lesson I ever paid for.',
  ];
  const t = talk(lines, .7), text = (m: { start: number; end: number }) => t.words.filter(x => x.s >= m.start - .01 && x.e <= m.end + .01).map(x => x.t).join(' ');
  const reactions = [{ t: t.sentences[20].e + .2, kind: 'laughter' as const }, { t: t.sentences[21].e + .2, kind: 'laughter' as const }, { t: t.sentences[22].e + .3, kind: 'applause' as const }];
  for (const [minSeconds, maxSeconds] of [[10, 30], [10, 60], [15, 45]]) {
    const picks = localMoments(t, ctxOf({ reactions }), opts({ count: 6, minSeconds, maxSeconds, genre: 'podcast' })), said = picks.map(text);
    assert.ok(picks.length >= 3, `${minSeconds}-${maxSeconds}: ${said.join(' | ')}`);
    for (const p of said) {
      assert.doesNotMatch(p, /^(It went|And that is why|Here is why|I was broke|That was)/, `opens mid-thought: ${p}`);
      assert.doesNotMatch(p, /completely wrong\.$/, `ends on a claim explained later: ${p}`);
      if (/three things/.test(p)) assert.match(p, /Third/, 'the list keeps its last item');
      if (/zero in six months/.test(p)) assert.match(p, /best lesson I ever paid for\.$/, 'the story keeps its payoff');
    }
  }
});

// ------------------------------------------------------------ viewer signals
test('caption tracks keep audience reactions and drop sound labels from the words', () => {
  const json = { events: [
    { tStartMs: 1000, dDurationMs: 2000, segs: [{ utf8: 'that' }, { utf8: ' was', tOffsetMs: 300 }, { utf8: ' hilarious', tOffsetMs: 600 }] },
    { tStartMs: 3000, dDurationMs: 1000, segs: [{ utf8: '[Laughter]' }] },
    { tStartMs: 5000, dDurationMs: 1500, segs: [{ utf8: '[Música]' }, { utf8: ' ok', tOffsetMs: 700 }] },
    { tStartMs: 7000, dDurationMs: 1000, segs: [{ utf8: '[Applause] thank you (laughs)' }] },
    { tStartMs: 9000, dDurationMs: 1000, segs: [{ utf8: '[Risas]' }] },
  ] };
  assert.deepEqual(reactionsFromJson3(json), [{ t: 3, kind: 'laughter' }, { t: 7, kind: 'applause' }, { t: 7, kind: 'laughter' }, { t: 9, kind: 'laughter' }]);
  assert.deepEqual(wordsFromJson3(json, 20).map(x => x.t), ['that', 'was', 'hilarious', 'ok', 'thank', 'you']);
});

test('laughter lifts a moment, and picks cover different topics', () => {
  const lines: string[] = [];
  const block = (topic: string, k: number) => [`Let me tell you about ${topic} number ${k}.`, `The ${topic} story starts on a quiet morning.`, `Everyone at the ${topic} meeting was confused.`, `Then the ${topic} plan changed completely.`, `That is the ${topic} story.`];
  for (const [k, topic] of ['garden', 'garden', 'kitchen', 'office'].entries()) lines.push(...block(topic, k), '');
  const t = talk(lines);
  const blockStart = (k: number) => t.sentences[k * 5].s;
  // The audience laughed during the office story.
  const office = blockStart(3), reactions = [{ t: office + 6, kind: 'laughter' as const }, { t: office + 9, kind: 'laughter' as const }];
  const picks = localMoments(t, ctxOf({ reactions }), opts({ count: 3, minSeconds: 8, maxSeconds: 18 }));
  assert.ok(picks[0].start >= office - 1 && picks[0].start < office + 1, `the office story wins (${picks.map(p => p.start.toFixed(1)).join(', ')})`);
  assert.match(picks[0].reason, /audience laughed 2 times/);
  const gardens = picks.filter(p => p.start < blockStart(2) - 1);
  assert.equal(gardens.length, 1, 'only one of the two garden stories');
  for (const p of picks) assert.ok(p.checks?.length, 'every pick carries its checks');
});

// ------------------------------------------------------------ action
test('gameplay picks include the build-up before a loud peak, even without words', () => {
  const seconds = 120, energy = new Uint8Array(seconds * 100);
  for (let i = 0; i < energy.length; i++) energy[i] = 55 + (i % 37 === 0 ? 4 : 0); // steady game audio
  for (let i = 7000; i < 7300; i++) energy[i] = 82;                              // a scream and explosion at 70-73 s
  for (let i = 3000; i < 3060; i++) energy[i] = 70;                              // a smaller spike at 30 s
  const peaks = excitementPeaks(energy);
  assert.ok(peaks.length >= 1 && Math.abs(peaks[0].t - 70) < 1 && peaks[0].level > 20, JSON.stringify(peaks));
  const quiet = makeTranscript([w('okay', 60, 60.3), w('here', 60.4, 60.6), w('we', 60.7, 60.8), w('go.', 60.9, 61.2)], { engine: 'whisper', language: 'en', model: 'test', duration: seconds });
  const picks = localMoments(quiet, ctxOf({ energy }), opts({ count: 2, minSeconds: 10, maxSeconds: 40, genre: 'gaming' }));
  const action = picks.find(p => p.kind === 'action');
  assert.ok(action, JSON.stringify(picks));
  assert.ok(action!.start <= 70 - 8 && action!.end >= 73 + 2, `build-up and reaction (${action!.start}-${action!.end})`);
  assert.ok(action!.start <= 60, 'the spoken line before the play is included from its start');
  assert.ok(action!.teaser && action!.teaser.start >= 69 && action!.teaser.end <= 74, 'the peak can open the short as a cold open');
  assert.match(action!.reason, /build-up, peak and reaction/);
  assert.equal(localMoments(quiet, ctxOf({ energy }), opts({ count: 2, minSeconds: 10, maxSeconds: 40, genre: 'podcast' })).filter(p => p.kind === 'action').length, 0, 'talk genres keep talk picks');
});

const FONTS = path.resolve('public/fonts/clips');
const testTools = async (): Promise<ClipTools> => ({ ytdlp: null, whisper: null, whisperModel: null, whisperGpu: null, ffmpeg: true, nvenc: false, fonts: FONTS, cacheDir: tmpdir() });
async function until<T>(read: () => Promise<T>, done: (v: T) => boolean, ms = 180_000) {
  const end = Date.now() + ms;
  for (;;) { const v = await read(); if (done(v)) return v; if (Date.now() > end) throw new Error(`Timed out: ${JSON.stringify(v).slice(0, 400)}`); await new Promise(r => setTimeout(r, 150)); }
}

test('a video without speech imports and gets action moments from its audio', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'sprityreels-clips-action-'));
  const service = new ClipStudioService(path.join(root, 'clips'), { projectRoot: root, tools: testTools, transcriber: async () => ({ words: [], language: 'en', model: 'test' }), directors: {}, launcher: { find: async () => null, open: async () => ({ stop: async () => {} }) } });
  t.after(async () => { await service.dispose(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });
  await service.saveSettings({ minSeconds: 8, maxSeconds: 20, count: 2 });
  // Quiet game ambience with one loud burst at 40-42 s.
  const file = path.join(root, 'match.mp4');
  await run('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=15:d=60', '-f', 'lavfi', '-i', `aevalsrc='0.02*sin(2*PI*300*t)+0.6*sin(2*PI*220*t)*between(t,40,42)':s=48000:d=60`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', file], { timeout: 120_000 });
  const { readFile } = await import('node:fs/promises');
  async function* body() { yield new Uint8Array(await readFile(file)); }
  const { source, job } = await service.importUpload('match.mp4', body(), 0, { rights: 'own' });
  const done = await until(async () => service.job(job.id), j => j.status !== 'running' && j.status !== 'queued');
  assert.equal(done.status, 'done', JSON.stringify(done));
  const src = await service.getSource(source.id);
  assert.equal(src.status, 'ready'); assert.equal(src.transcript?.words, 0);
  const [set] = await service.momentSets(source.id);
  const action = set.moments.find(m => m.kind === 'action');
  assert.ok(action && action.start < 40 - 5 && action.end > 42, JSON.stringify(set.moments.map(m => [m.kind, m.start, m.end])));
});

test('AI picks get the same repair: an answer gains its question and flow pays for what cannot be fixed', () => {
  const t = talk(['We had a long week.', 'Why did you quit your job?', 'Because my boss lied to the whole team about the layoffs.', 'I could not work for someone like that.', 'So I left the next morning.']);
  const reply = JSON.stringify({ moments: [{ startSentence: 2, endSentence: 4, teaserStartSentence: -1, teaserEndSentence: -1, title: 'Why I quit', hook: 'My boss lied', reason: 'story', hookScore: 8, flowScore: 8, valueScore: 8, trendScore: 5, hashtags: [], keywords: [] }] });
  const [m] = parseMomentReply(reply, t, ctxOf(), opts({ minSeconds: 3, maxSeconds: 60 }), 'gemini');
  assert.ok(m.start < t.sentences[1].s && m.start > t.sentences[0].e, 'the question opens the clip');
  assert.equal(m.checks!.find(c => c.id === 'opening')!.level, 'fixed');
  assert.equal(m.scores.flow, 8);
  const [tight] = parseMomentReply(reply, t, ctxOf(), opts({ minSeconds: 3, maxSeconds: t.sentences[4].e - t.sentences[2].s + .1 }), 'gemini');
  assert.equal(tight.scores.flow, 6, 'an unfixable opening costs flow');
});

// ------------------------------------------------------------ reframing
const words = (to: number) => Array.from({ length: Math.ceil(to / .2) }, (_, i) => w('word', i * .2, i * .2 + .15));
const face = (x: number, y: number, size: number, jaw = .05, mouth = .02): FaceBox => ({ x, y, w: size, h: size * 1.6, jaw, mouth, score: 1 });
const trackOf = (samples: FaceSample[], scenes: number[] = [], width = 1920, height = 1080): FaceTrackFile => ({ format: 'sprityreels-face-track', version: 1, width, height, fps: 10, delegate: 'GPU', ranges: [{ s: 0, e: 20 }], samples, scenes });
const plan = (track: FaceTrackFile | null, layout: ClipLayout, extra: object = {}) => planCamera({ track, words: words(20), layout, srcW: 1920, srcH: 1080, outW: 1080, outH: 1920, ...extra });

test('lip sync keeps the camera on the person whose mouth follows the sound, not the busiest mouth', () => {
  // A talks until 5 s, then B. B's mouth moves more all along (laughing, nodding), but only in time with the audio after 5 s.
  const samples: FaceSample[] = [], energy = new Uint8Array(1100).fill(40);
  for (let i = 0; i <= 100; i++) {
    const t = i / 10, aOpen = i % 2 === 0, bOpen = i % 3 === 0, loud = t < 5 ? aOpen : bOpen;
    for (let k = i * 10 - 3; k <= i * 10 + 3; k++) if (k >= 0) energy[k] = loud ? 80 : 52;
    samples.push({ t, faces: [face(.3, .4, .12, aOpen ? .4 : .05, aOpen ? .1 : .02), face(.7, .4, .12, bOpen ? .7 : .05, bOpen ? .12 : .02)] });
  }
  const winW = Math.round(1080 * 9 / 16), centre = (p: ReturnType<typeof plan>, t: number) => (cameraAt(p.primary, t).x + winW / 2) / 1920;
  assert.ok(lipSync(samples.map(s => ({ t: s.t, f: s.faces[0] })), 2, energy)! > .8, 'A is in sync while talking');
  const blind = plan(trackOf(samples), 'tracked');
  assert.ok(Math.abs(centre(blind, 2) - .7) < .03, 'mouth movement alone picks the busier listener');
  const synced = plan(trackOf(samples), 'tracked', { energy });
  assert.ok(Math.abs(centre(synced, 2) - .3) < .03, `lip sync picks the talker (${centre(synced, 2)})`);
  assert.ok(Math.abs(centre(synced, 8.5) - .7) < .03, `and follows the turn to B (${centre(synced, 8.5)})`);
  const cut = synced.primary.find(k => k.cut && k.t > 4 && k.t < 9);
  assert.ok(cut && cut.t >= 5.3 && cut.t <= 7, `one clean cut after the turn (${cut?.t})`);
});

test('scene cuts adapt to the footage: soft cuts in calm shots count, fast motion does not', () => {
  const fps = 30, frames: { t: number; s: number }[] = [];
  for (let i = 0; i < 300; i++) {
    let s = .012 + (i % 5) * .002;
    if (i === 60) s = .18;                                // a soft cut in a calm shot (2 s)
    if (i >= 150 && i < 180) s = .24 + (i % 3) * .06;     // a fast whip pan (5-6 s), peaks at .36
    if (i === 240) s = .8;                                // a hard cut (8 s)
    frames.push({ t: i / fps, s });
  }
  assert.deepEqual(sceneCuts(frames, fps), [2, 8]);
  assert.ok(frames.filter(f => f.s > .32).length > 5, 'the old fixed 0.32 threshold would cut inside the pan and miss 2 s');
  assert.deepEqual(parseSceneScores('frame:0    pts:0       pts_time:0\nlavfi.scene_score=0.000000\nframe:1    pts:512     pts_time:0.0333333\nlavfi.scene_score=0.412000\n'), [{ t: 0, s: 0 }, { t: .0333333, s: .412 }]);
});

test('auto layout is chosen per shot: stacked for quick back-and-forth, follow for one face, blur fill without faces', () => {
  const samples: FaceSample[] = [];
  for (let i = 0; i < 120; i++) {
    const t = i / 8, turn = Math.floor(t / 1.25) % 2, talk = (on: boolean) => on ? (i % 2 ? .45 : .05) : .05;
    samples.push({ t, faces: t < 5 ? [face(.3, .42, .12, talk(turn === 0)), face(.7, .42, .12, talk(turn === 1))] : t < 10 ? [face(.5, .4, .25, talk(true))] : [] });
  }
  const p = plan(trackOf(samples, [5, 10]), 'auto');
  assert.deepEqual(p.shots.map(s => s.layout), ['split', 'tracked', 'fit']);
  assert.equal(p.layout, 'mixed');
  const [top, bottom] = p.shots[0].panes;
  assert.deepEqual([top.x, top.y, top.w, top.h, bottom.y, bottom.h], [0, 0, 1080, 960, 960, 960]);
  const centreX = (pane: CameraPane) => (cameraAt(pane.keys, 2).x + pane.win.w / 2) / 1920;
  assert.ok(Math.abs(centreX(top) - .3) < .03 && Math.abs(centreX(bottom) - .7) < .03, 'left person on top, right person below');
  assert.equal(plan(trackOf(samples, [5, 10]), 'tracked').shots[0].layout, 'tracked', 'an explicit layout is kept');
  assert.ok(plan(trackOf(samples, [5, 10]), 'split').notes.some(n => /Split screen needs two people/.test(n)), 'split falls back per shot, with a note');
});

test('a face cam sits over gameplay for gaming, and under the shared screen otherwise', () => {
  const samples = Array.from({ length: 80 }, (_, i) => ({ t: i / 8, faces: [face(.88 + Math.sin(i) * .002, .8, .07, i % 2 ? .3 : .05)] }));
  const game = plan(trackOf(samples), 'auto', { genre: 'gaming' });
  assert.equal(game.layout, 'gameplay');
  const [cam, content] = game.shots[0].panes;
  assert.deepEqual([cam.y, cam.h, cam.role, content.y, content.h, content.role, content.fit], [0, 576, 'face', 576, 1344, 'content', false]);
  assert.ok(Math.abs((cam.keys[0].x + cam.win.w / 2) / 1920 - .88) < .03 && cam.win.w < 1920 * .3, 'a tight crop around the face cam');
  assert.equal(content.win.h, 1080, 'the game fills its tile from a full-height crop');
  const talk = plan(trackOf(samples), 'auto', { genre: 'education' });
  assert.equal(talk.layout, 'screen');
  assert.deepEqual(talk.shots[0].panes.map(pn => [pn.y, pn.h, pn.role, pn.fit]), [[0, 1190, 'content', true], [1190, 730, 'face', false]]);
  // Without a face cam, the face cam layouts follow the speaker instead.
  const host = Array.from({ length: 40 }, (_, i) => ({ t: i / 8, faces: [face(.5, .4, .25, i % 2 ? .3 : .05)] }));
  const fallback = plan(trackOf(host), 'gameplay');
  assert.equal(fallback.layout, 'tracked'); assert.ok(fallback.notes.some(n => /No face cam/.test(n)));
});

test('tiles cover the frame exactly for 2-4 people', () => {
  const area = (list: { w: number; h: number }[]) => list.reduce((s, r) => s + r.w * r.h, 0);
  assert.deepEqual(tiles(3, true, 1080, 1920).map(r => [r.y, r.h]), [[0, 640], [640, 640], [1280, 640]]);
  assert.deepEqual(tiles(4, true, 1080, 1920).map(r => [r.x, r.y, r.w, r.h]), [[0, 0, 540, 960], [540, 0, 540, 960], [0, 960, 540, 960], [540, 960, 540, 960]]);
  assert.deepEqual(tiles(2, false, 1920, 1080).map(r => [r.x, r.w]), [[0, 960], [960, 960]]);
  for (const n of [1, 2, 3, 4]) assert.equal(area(tiles(n, true, 1080, 1350)), 1080 * 1350);
});

/** A hand-made plan with three shots: two people stacked, a face cam over gameplay, and the full frame over blur. */
function threeShots(srcW: number, srcH: number): CameraPlan {
  const band = { w: even(srcH * 1080 / 960), h: srcH }, still = (win: { w: number; h: number }, cx: number): CameraKey[] => [{ t: 0, x: Math.round(Math.max(0, Math.min(srcW - win.w, cx * srcW - win.w / 2))), y: 0, cut: true }];
  const camWin = { w: Math.round(srcW * .25), h: Math.round(srcW * .25 * 576 / 1080) }, content = { w: even(srcH * 1080 / 1344), h: srcH };
  return { layout: 'mixed', srcW, srcH, outW: 1080, outH: 1920, faceCoverage: 1, speakers: 2, notes: [], primary: still(band, .5), shots: [
    { s: -1, e: 2.5, layout: 'split', panes: [{ x: 0, y: 0, w: 1080, h: 960, role: 'face', fit: false, win: band, keys: still(band, .25) }, { x: 0, y: 960, w: 1080, h: 960, role: 'face', fit: false, win: band, keys: still(band, .75) }] },
    { s: 2.5, e: 5.5, layout: 'gameplay', panes: [{ x: 0, y: 0, w: 1080, h: 576, role: 'face', fit: false, win: camWin, keys: [{ t: 0, x: srcW - camWin.w, y: srcH - camWin.h, cut: true }] }, { x: 0, y: 576, w: 1080, h: 1344, role: 'content', fit: false, win: content, keys: still(content, .5) }] },
    { s: 5.5, e: 1e9, layout: 'fit', panes: [{ x: 0, y: 0, w: 1080, h: 1920, role: 'face', fit: true, win: { w: srcW, h: srcH }, keys: still({ w: srcW, h: srcH }, .5) }] },
  ] };
}
const even = (x: number) => Math.max(2, Math.round(x / 2) * 2);

test('pieces switch layout on the exact frame of a scene cut, and the graph renders with FFmpeg', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'sprityreels-clips-panes-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const video = path.join(root, 'src.mp4');
  await run('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=10', '-f', 'lavfi', '-i', 'sine=f=220:d=10', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', video], { timeout: 120_000 });
  const short = applyShortPatch(newShort({ id: '00000000-0000-4000-8000-000000000003', sourceId: '00000000-0000-4000-8000-000000000004', name: 'Panes', mode: 'clip', segments: [{ id: 'seg0001', kind: 'source', start: 1, end: 8 }], defaults: DEFAULT_CLIP_SETTINGS, creditText: '' }), { captions: { enabled: false }, hook: { enabled: false }, overlays: { progress: false } }, 10);
  const timeline: Timeline = { duration: 5, fps: 30, words: [], voiceWindows: [], removed: 0, pieces: [
    { kind: 'source', segmentId: 'seg0001', out: 0, dur: 3, src: 1, voice: null, zoom: 1.12, cut: false },
    { kind: 'source', segmentId: 'seg0001', out: 3, dur: 2, src: 6, voice: null, zoom: 1, cut: true },
  ] };
  const camera = threeShots(640, 360), spans = [{ file: video, start: 0, end: 10, offset: 0, width: 640, height: 360, hasAudio: true }];
  const { graph } = buildGraph({ short, timeline, camera, spans, hwaccel: false });
  assert.match(graph, /concat=n=2:v=1:a=0\[v0\]/, 'the first piece is two segments');
  const trims = [...graph.matchAll(/\]trim=start_frame=(\d+):end_frame=(\d+)/g)].map(m => [Number(m[1]), Number(m[2])]);
  assert.deepEqual(trims, [[30, 75], [75, 120], [180, 240]], 'the cut at 2.5 s splits the first piece on frame 75');
  assert.match(graph, /xstack=inputs=2:layout=0_0\|0_960,drawbox=x=0:y=957:w=1080:h=6/);
  assert.match(graph, /xstack=inputs=2:layout=0_0\|0_576/);
  const content = /crop=w=(\d+):h=360:x='(\d+)'/.exec(graph.split('\n').find(l => l.includes('scale=1080:1344'))!)!;
  assert.equal(Number(content[1]), even(360 * 1080 / 1344), 'gameplay is never punched in');
  const cam = graph.split('\n').find(l => l.includes('scale=1080:576'))!;
  assert.match(cam, new RegExp(`crop=w=${even(160 / 1.12)}:`), 'the face cam is punched in with the piece');
  assert.match(graph, /gblur=sigma=5,scale=1080:1920/, 'the last shot is the full frame over blur');
  const out = path.join(root, 'out.mp4');
  await renderShort({ short, timeline, camera, spans, ass: buildAss({ timeline, short, hookText: '', creditText: '' }), workDir: path.join(root, 'work'), fontsDir: FONTS, out, encoder: 'x264', hwaccel: false });
  const info = await probeMedia(out);
  assert.equal(info.width, 1080); assert.equal(info.height, 1920);
  assert.ok(Math.abs(info.duration - 5) < .1, `duration ${info.duration}`);
});

test('faces project onto the output through panes, crops and punch-ins', () => {
  const samples: FaceSample[] = [{ t: 1, faces: [face(.25, .5, .1), face(.75, .5, .1)] }, { t: 3, faces: [face(.25, .5, .1), face(.75, .5, .1)] }, { t: 6, faces: [face(.5, .5, .2)] }];
  const camera = threeShots(1920, 1080);
  const split = screenFaces(camera, samples, 1);
  assert.equal(split.length, 2, 'one face in each band');
  assert.ok(split[0].y < 960 && split[0].y + split[0].h <= 960 && split[1].y >= 960, JSON.stringify(split));
  // The band's crop (1216 px of 1920) is clamped to the left edge, so the face sits at 480 * 1080 / 1216 px.
  assert.ok(Math.abs(split[0].x + split[0].w / 2 - 480 * 1080 / 1216) < 3, JSON.stringify(split[0]));
  const zoomed = screenFaces(camera, samples, 1, 1.2);
  assert.ok(zoomed[0].w > split[0].w * 1.15, 'a punch-in makes faces bigger on screen');
  const fit = screenFaces(camera, samples, 6)[0];
  assert.ok(Math.abs(fit.x + fit.w / 2 - 540) < 4 && Math.abs(fit.y + fit.h / 2 - 960) < 4 && Math.abs(fit.w - 216) < 4, JSON.stringify(fit));
  assert.deepEqual(screenFaces(camera, samples, 12), [], 'no face sample nearby');
});

// ------------------------------------------------------------ caption placement
test('auto captions stay off faces, sit between tiles, and do not jump from card to card', () => {
  assert.equal(placeBox([100, 200, 300], 100, 40, 1080, [{ x: 0, y: 80, w: 1080, h: 40 }]), 200, 'first clear candidate');
  assert.equal(placeBox([100, 200, 300], 100, 40, 1080, [], 300), 300, 'keeps the previous position while it is clear');
  assert.equal(placeBox([100, 200], 100, 40, 1080, [{ x: 0, y: 0, w: 1080, h: 190 }]), 200, 'otherwise the one that covers least');

  const tw = (text: string, s: number, e: number, end = false) => ({ key: `s${Math.round(s * 10)}`, text, s, e, emphasis: false, end, voice: false });
  const timeline: Timeline = { duration: 6, fps: 30, pieces: [], voiceWindows: [], removed: 0, words: [tw('Nobody', .2, .6), tw('tells', .65, .9), tw('you.', .95, 1.3, true), tw('Save', 2, 2.3), tw('first.', 2.35, 2.8, true), tw('Then', 4, 4.3), tw('spend.', 4.35, 4.8, true)] };
  const short = applyShortPatch(newShort({ id: '00000000-0000-4000-8000-000000000005', sourceId: '00000000-0000-4000-8000-000000000006', name: 'Place', mode: 'clip', segments: [{ id: 'seg0001', kind: 'source', start: 0, end: 6 }], defaults: DEFAULT_CLIP_SETTINGS, creditText: '' }), { hook: { enabled: true, text: 'Nobody tells you this', seconds: 1.5 } }, 10);
  assert.equal(short.captions.position, 'auto', 'auto is the default for new shorts');
  const ys = (ass: string) => [...ass.matchAll(/Dialogue: 2,[^\n]*\\pos\(540,(\d+)\)/g)].map(m => Number(m[1]));
  const hookY = (ass: string) => Number(/Dialogue: 4,[^\n]*\\pos\(540,(\d+)\)/.exec(ass)![1]);
  // A close-up whose chin reaches the usual caption height; the face moves up after 3.5 s.
  const low = { x: 290, y: 1150, w: 500, h: 400 }, high = { x: 290, y: 300, w: 500, h: 500 };
  const closeUp: CaptionStage = t => ({ faces: [t < 3.5 ? low : high], seams: [] });
  const placed = ys(buildAss({ timeline, short, hookText: short.hook.text, creditText: '', stage: closeUp }));
  const lower = Math.round(1920 * .7);
  assert.ok(placed.length >= 7 && placed.every(y => y !== lower), `captions leave the face (${[...new Set(placed)]})`);
  assert.ok(placed.every(y => y + 60 < 1150 - 77 || y - 60 > 1550 + 38), 'clear of the face with a margin');
  assert.equal(new Set(placed.slice(0, 5)).size, 1, 'the first cards share one position');
  assert.equal(hookY(buildAss({ timeline, short, hookText: short.hook.text, creditText: '', stage: () => ({ faces: [{ x: 300, y: 260, w: 480, h: 420 }], seams: [] }) })) !== Math.round(1920 * .2), true, 'the hook moves off a face at the top');
  const split: CaptionStage = () => ({ faces: [{ x: 340, y: 200, w: 400, h: 450 }, { x: 340, y: 1160, w: 400, h: 450 }], seams: [960] });
  assert.deepEqual([...new Set(ys(buildAss({ timeline, short, hookText: '', creditText: '', stage: split })))], [960], 'between the tiles');
  const fixed = applyShortPatch(short, { captions: { position: 'lower' } }, 10);
  assert.deepEqual([...new Set(ys(buildAss({ timeline, short: fixed, hookText: '', creditText: '', stage: closeUp })))], [lower], 'a chosen position stays put');
});

test('the caption stage follows trims and punch-ins back to the camera plan', () => {
  const camera = threeShots(1920, 1080);
  const samples: FaceSample[] = [{ t: 1, faces: [face(.25, .5, .1), face(.75, .5, .1)] }, { t: 7, faces: [face(.5, .5, .2)] }];
  const timeline = { pieces: [{ kind: 'source' as const, segmentId: 's', out: 0, dur: 2, src: .5, voice: null, zoom: 1, cut: false }, { kind: 'source' as const, segmentId: 's', out: 2, dur: 2, src: 6.5, voice: null, zoom: 1.12, cut: true }] };
  const stage = captionStage(camera, samples, timeline);
  const first = stage(.5), second = stage(2.5);
  assert.deepEqual(first.seams, [960]); assert.equal(first.faces.length, 2, 'output 0.5 s shows source 1.0 s: the split shot');
  assert.deepEqual(second.seams, []); assert.equal(second.faces.length, 1, 'output 2.5 s shows source 7.0 s: the full frame');
  assert.ok(second.faces[0].w > 216 * 1.1, 'with the punch-in of its piece');
});

// ------------------------------------------------------------ censor
test('swear words are masked in captions and bleeped, without catching ordinary words', () => {
  const bad = censorMatcher(['heck', 'frick*']);
  for (const word of ['fuck', 'Fucking,', 'MOTHERFUCKER', 'shit.', 'bullshit', 'bitches', 'asshole', 'goddamn', 'heck!', 'fricking']) assert.ok(bad(word), word);
  for (const word of ['shiitake', 'class', 'assassin', 'pass', 'Dick', 'hello', 'scunthorpe', 'cockpit', 'hecktic']) assert.ok(!bad(word), word);
  assert.equal(maskWord('Fucking,'), 'F******,'); assert.equal(maskWord('shit.'), 's***.');

  const words = [w('This', 0, .3), w('is', .35, .5), w('fucking', .55, 1), w('great.', 1.05, 1.4), w('Holy', 2, 2.3), w('shit!', 2.35, 2.8)];
  const short = applyShortPatch(newShort({ id: '00000000-0000-4000-8000-000000000007', sourceId: '00000000-0000-4000-8000-000000000008', name: 'Bleep', mode: 'clip', segments: [{ id: 'seg0001', kind: 'source', start: 0, end: 3 }], defaults: DEFAULT_CLIP_SETTINGS, creditText: '' }),
    { trim: { silence: false, fillers: false }, censor: { enabled: true }, wordEdits: { s5: '' } }, 10);
  const tl = buildTimeline(short, { words }, { fps: 30 });
  assert.deepEqual(tl.words.map(x => x.text), ['This', 'is', 'f******', 'great.', 'Holy'], 'masked, and a hidden word stays hidden');
  assert.deepEqual(tl.bleeps, [{ s: .52, e: 1.03 }, { s: 2.32, e: 2.83 }], 'the hidden swear word is still bleeped');
  assert.ok(!tl.words[2].emphasis && tl.words[2].censored);
  assert.equal(buildTimeline(applyShortPatch(short, { censor: { enabled: false } }, 10), { words }, { fps: 30 }).bleeps!.length, 0);
  assert.throws(() => applyShortPatch(short, { censor: { style: 'beep' } }, 10), /censor.style/);
});

test('a muted swear word is silent in the rendered audio', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'sprityreels-clips-censor-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const video = path.join(root, 'src.mp4');
  await run('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=30:d=4', '-f', 'lavfi', '-i', 'sine=f=220:d=4', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', video], { timeout: 120_000 });
  const words = [w('What', .2, .5), w('the', .55, .7), w('fuck', 1.2, 1.8), w('happened?', 2, 2.6)];
  const short = applyShortPatch(newShort({ id: '00000000-0000-4000-8000-000000000009', sourceId: '00000000-0000-4000-8000-00000000000a', name: 'Mute', mode: 'clip', segments: [{ id: 'seg0001', kind: 'source', start: 0, end: 3 }], defaults: DEFAULT_CLIP_SETTINGS, creditText: '' }),
    { layout: 'center', trim: { silence: false, fillers: false }, censor: { enabled: true, style: 'mute' }, audio: { normalize: false }, captions: { enabled: false }, hook: { enabled: false } }, 4);
  const timeline = buildTimeline(short, { words }, { fps: 30 });
  const camera = planCamera({ track: null, words, layout: 'center', srcW: 320, srcH: 180, outW: 1080, outH: 1920 }), out = path.join(root, 'out.mp4');
  await renderShort({ short, timeline, camera, spans: [{ file: video, start: 0, end: 4, offset: 0, width: 320, height: 180, hasAudio: true }], ass: buildAss({ timeline, short, hookText: '', creditText: '' }), workDir: path.join(root, 'work'), fontsDir: FONTS, out, encoder: 'x264', hwaccel: false });
  const rms = async (from: number, dur: number) => { const { stderr } = await run('ffmpeg', ['-nostdin', '-hide_banner', '-ss', String(from), '-t', String(dur), '-i', out, '-af', 'astats=measure_perchannel=none', '-vn', '-f', 'null', '-']); return Number(/RMS level dB: (-?[\d.]+|-inf)/.exec(stderr)?.[1].replace('-inf', '-200')); };
  const muted = await rms(1.3, .35), open = await rms(2.1, .35);
  assert.ok(open > -25 && muted < open - 40, `speech ${open} dB, muted word ${muted} dB`);
  const bleeped = applyShortPatch(short, { censor: { style: 'bleep' } }, 4);
  await renderShort({ short: bleeped, timeline, camera, spans: [{ file: video, start: 0, end: 4, offset: 0, width: 320, height: 180, hasAudio: true }], ass: buildAss({ timeline, short: bleeped, hookText: '', creditText: '' }), workDir: path.join(root, 'work2'), fontsDir: FONTS, out, encoder: 'x264', hwaccel: false });
  const tone = await rms(1.3, .35);
  assert.ok(tone > -30, `the bleep is audible (${tone} dB)`);
});
