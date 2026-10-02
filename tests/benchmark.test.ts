import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ClipWord } from '../src/engine/clips/types';
import { CARDS, cardFor, formatReport, projectCards, runBenchmark } from '../server/benchmark';
import type { BenchReport } from '../server/benchmark';
import type { ClipTools } from '../server/clips/tools';
import { run } from '../server/clips/tools';

const near = (actual: number, expected: number, tolerance = .01) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} is not within ${tolerance} of ${expected}`);
const testTools = async (): Promise<ClipTools> => ({ ytdlp: null, whisper: null, whisperModel: null, whisperGpu: null, ffmpeg: true, nvenc: false, fonts: path.resolve('public/fonts/clips'), cacheDir: tmpdir() });

test('a graphics card is recognised by the name nvidia-smi reports, the most specific match', () => {
  assert.equal(cardFor('NVIDIA RTX 2000 Ada Generation')?.name, 'RTX 2000 Ada');
  assert.equal(cardFor('NVIDIA GeForce RTX 5090')?.name, 'RTX 5090');
  assert.equal(cardFor('NVIDIA GeForce RTX 5080')?.name, 'RTX 5080');
  assert.equal(cardFor('NVIDIA GeForce RTX 3060'), null);
  assert.equal(cardFor(null), null);
  assert.ok(CARDS.every(c => c.speed[0] > 0 && c.speed[0] <= c.speed[1]), 'every range runs from slower to faster');
});

test('a run on the Ada 2000 is scaled to other cards by the published ratio, and only speech recognition changes', () => {
  // Ten minutes of audio took 21 s of speech recognition and 60 s altogether on a card published at 30.4x.
  const rows = projectCards({ audioSeconds: 600, speechSeconds: 21, totalSeconds: 60, card: cardFor('NVIDIA RTX 2000 Ada Generation'), onGpu: true });
  const by = Object.fromEntries(rows.map(r => [r.card, r]));
  assert.deepEqual(Object.keys(by), ['RTX 2000 Ada', 'RTX 4090', 'RTX 5080', 'RTX 5090']);
  near(by['RTX 2000 Ada'].speechSeconds[0], 21); near(by['RTX 2000 Ada'].totalSeconds[1], 60); assert.equal(by['RTX 2000 Ada'].measured, true);
  near(by['RTX 5090'].speechSeconds[0], 21 * 30.4 / 53); near(by['RTX 5090'].totalSeconds[0], 39 + 21 * 30.4 / 53);
  near(by['RTX 4090'].speechSeconds[1], 21 * 30.4 / 35.2);
  // The 5080 has no published figure: it is a range from a 4090 to a 5090.
  near(by['RTX 5080'].speechSeconds[0], 21 * 30.4 / 53); near(by['RTX 5080'].speechSeconds[1], 21 * 30.4 / 35.2);
  assert.match(by['RTX 5080'].note ?? '', /between a 4090 and a 5090/);
  for (const r of rows) assert.ok(r.totalSeconds[0] >= 39, 'the stages that are not speech recognition never get faster');
});

test('a run on the CPU, or on a card with no published speed, uses the published speeds alone', () => {
  const cpu = projectCards({ audioSeconds: 600, speechSeconds: 180, totalSeconds: 230, card: null, onGpu: false });
  near(cpu.find(r => r.card === 'RTX 2000 Ada')!.speechSeconds[0], 600 / 30.4); near(cpu.find(r => r.card === 'RTX 5090')!.totalSeconds[0], 50 + 600 / 53);
  assert.ok(cpu.every(r => !r.measured));
  // A measured 3090 is not in the default comparison, but it is added so the report shows the card that was measured.
  const own = projectCards({ audioSeconds: 600, speechSeconds: 15, totalSeconds: 50, card: cardFor('NVIDIA GeForce RTX 3090'), onGpu: true });
  assert.equal(own.find(r => r.card === 'RTX 3090')?.measured, true); near(own.find(r => r.card === 'RTX 3090')!.speechSeconds[0], 15);
  near(own.find(r => r.card === 'RTX 5090')!.speechSeconds[0], 15 * 43.8 / 53);
});

test('the report reads as plain text and says where each number comes from', () => {
  const report: BenchReport = {
    pc: { cpu: 'AMD Ryzen 7 7800X3D 8-Core Processor', threads: 16, memoryGB: 32, platform: 'win32 10.0', gpu: { name: 'NVIDIA RTX 2000 Ada Generation', memoryGB: 16, driver: '572.83' } },
    tools: { speech: 'gpu', encoder: 'NVIDIA NVENC', tracking: true },
    video: { name: 'talk.mp4', seconds: 600, width: 1920, height: 1080, megabytes: 612, looped: false, source: '600 s' },
    stages: { copy: 1.2, speech: 21.4, speechX: 28, other: 4.1, picture: null, toMoments: 27, reels: 33, reelCount: 5, reelLength: 41, total: 60 },
    card: 'RTX 2000 Ada', cards: projectCards({ audioSeconds: 600, speechSeconds: 21.4, totalSeconds: 60, card: cardFor('RTX 2000 Ada'), onGpu: true }), notes: [],
  };
  const text = formatReport(report);
  for (const part of ['moments on screen after', 'finished reels after', '28.0x real time', '10.0x real time for 10 min of video', 'RTX 5080', '[no published figure', 'RTX 2000 Ada (yours)', 'on the graphics card', 'not needed', 'good to about 30%'])
    assert.ok(text.includes(part), `the report should say "${part}":\n${text}`);
  assert.ok(!/[^\x00-\x7f]/.test(text), 'plain ASCII, so an older Windows console shows it correctly');
  assert.match(formatReport({ ...report, tools: { ...report.tools, speech: 'cpu' }, card: null, notes: ['A note.'] }), /could not be scaled[\s\S]*Note: A note\./);
});

test('the check refuses a video without sound before it starts anything', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'sprityreels-bench-')); t.after(() => rm(root, { recursive: true, force: true }));
  const silent = path.join(root, 'silent.mp4');
  await run('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=15:d=6', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', silent], { timeout: 60_000 });
  await assert.rejects(runBenchmark({ file: silent, root: path.resolve('.') }), /sound and a picture/);
});

test('the check runs the real pipeline on a video repeated to the asked length, and reports every stage', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'sprityreels-bench-')); t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  const file = path.join(root, 'twelve.mp4');
  await run('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=15:d=12', '-f', 'lavfi', '-i', "aevalsrc='0.2*sin(2*PI*220*t)':s=16000:d=12", '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '30', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-t', '12', file], { timeout: 60_000 });
  const lines = ['Here is the secret nobody tells you?', 'Your habits are the real problem.', 'Save money every payday!', 'You will never miss it.', 'Most people wait too long.', 'Start small and start today.'];
  // Stands in for whisper: a sentence in every 3 s of the audio it is given (16 kHz mono 16-bit is 32000 bytes a second).
  const transcriber = async (wav: string) => {
    await new Promise(resolve => setTimeout(resolve, 250));
    const seconds = Math.floor((await stat(wav)).size / 32000), words: ClipWord[] = [];
    for (let k = 0; k * 3 + 2 <= seconds; k++) { const tokens = lines[k % lines.length].split(' '); tokens.forEach((t, i) => words.push({ t, s: k * 3 + .1 + i * 1.8 / tokens.length, e: k * 3 + .1 + (i + .85) * 1.8 / tokens.length })); }
    return { words, language: 'en', model: 'stand-in' };
  };
  const seen: string[] = [];
  const report = await runBenchmark({ file, root: path.resolve('.'), minutes: 1, reels: 1, tracking: false, log: line => seen.push(line), app: { service: { tools: testTools, directors: {}, transcriber } } });

  assert.equal(report.video.looped, true, 'a 12 s file is repeated up to the minute that was asked for');
  near(report.video.seconds, 60, 2);
  assert.equal(report.tools.speech, 'standin'); assert.equal(report.tools.tracking, false);
  assert.ok(report.stages.speech >= .25, `speech recognition is timed by the pipeline itself (${report.stages.speech})`);
  assert.ok(report.stages.toMoments > report.stages.speech && report.stages.copy > 0 && report.stages.other >= 0);
  assert.equal(report.stages.reelCount, 1); assert.ok(report.stages.reelLength > 5 && report.stages.reels > 0, JSON.stringify(report.stages));
  near(report.stages.total, report.stages.toMoments + report.stages.reels, .001);
  // Nothing was measured on a card, so the other cards come from the published speeds alone: 60 s of audio at 30.4x is about two seconds.
  near(report.cards.find(c => c.card === 'RTX 2000 Ada')!.speechSeconds[0], report.video.seconds / 30.4, .001);
  assert.ok(seen.length >= 2, 'it says what it is doing while it works');
  assert.match(formatReport(report), /moments on screen after[\s\S]*finished reels after[\s\S]*RTX 5080/);
});
