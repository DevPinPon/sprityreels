import { createReadStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { ClipMoment, ClipSource } from '../src/engine/clips/types';
import type { AppOptions } from './app';
import { findBrowser } from './browser';
import { probeMedia, resolveClipTools, run } from './clips/tools';
import { startServer } from './start';

/** A graphics card and how fast it does speech recognition, in multiples of real time (a range where the figure is an assumption).
 * The figures are Whisper large-v3-turbo with faster-whisper at int8, one stream at a time, from RunPod's "Best GPU for Whisper: What the
 * benchmarks show in 2026" (September 2026). The article lists no RTX 5080: it is taken to fall between the 4090 and the 5090. This
 * server runs whisper.cpp, which can scale differently from card to card, which is why the check measures the card in the computer first
 * and only scales that run by these ratios. A rented machine's own CPU also moves single-stream numbers (the 3090 beats the 4090 in the
 * table), so treat a projection as good to about 30%. */
export type Card = { name: string; speed: [slowest: number, fastest: number]; note?: string };
export const CARDS: Card[] = [
  { name: 'RTX 2000 Ada', speed: [30.4, 30.4] },
  { name: 'RTX A4000', speed: [30.5, 30.5] },
  { name: 'L4', speed: [31.5, 31.5] },
  { name: 'RTX 3090', speed: [43.8, 43.8] },
  { name: 'RTX 4090', speed: [35.2, 35.2] },
  { name: 'RTX 5080', speed: [35.2, 53], note: 'no published figure: between a 4090 and a 5090' },
  { name: 'RTX 5090', speed: [53, 53] },
];
/** The cards shown in the report next to the one that was measured. */
export const COMPARED = ['RTX 2000 Ada', 'RTX 4090', 'RTX 5080', 'RTX 5090'];

/** The published card a graphics card's name (from nvidia-smi) belongs to, the most specific match. */
export function cardFor(gpuName: string | null | undefined): Card | null {
  const name = (gpuName ?? '').toLowerCase();
  return CARDS.filter(c => name.includes(c.name.toLowerCase())).sort((a, b) => b.name.length - a.name.length)[0] ?? null;
}

export type Measured = { audioSeconds: number; speechSeconds: number; totalSeconds: number; card: Card | null; onGpu: boolean | null };
export type Projection = { card: string; speechSeconds: [number, number]; totalSeconds: [number, number]; note?: string; measured?: boolean };

/** Speech recognition on other cards, and what everything then takes. A run that used a card from the table is scaled by the ratio of
 * the published speeds; a run on the CPU (or on a card that is not in the table) cannot be, so the published speed alone is used. The
 * other stages run on the same CPU, disk and encoder in both cases, so they stay as measured. */
export function projectCards(m: Measured, targets: Card[] = CARDS.filter(c => COMPARED.includes(c.name) || c.name === m.card?.name)): Projection[] {
  const base = m.onGpu && m.card ? (m.card.speed[0] + m.card.speed[1]) / 2 : null;
  const speech = (speed: number) => base !== null ? m.speechSeconds * base / speed : m.audioSeconds / speed;
  const rest = m.totalSeconds - m.speechSeconds;
  return targets.map(t => {
    const fast = speech(t.speed[1]), slow = speech(t.speed[0]);
    return { card: t.name, speechSeconds: [fast, slow], totalSeconds: [rest + fast, rest + slow], note: t.note, ...(base !== null && m.card?.name === t.name ? { measured: true } : {}) };
  });
}

export type BenchReport = {
  pc: { cpu: string; threads: number; memoryGB: number; platform: string; gpu: { name: string; memoryGB: number; driver: string } | null };
  tools: { speech: 'gpu' | 'cpu' | 'standin' | 'missing'; encoder: string | null; tracking: boolean };
  video: { name: string; seconds: number; width: number; height: number; megabytes: number; looped: boolean; source: string };
  /** Seconds, measured on this PC. */
  stages: { copy: number; speech: number; speechX: number; other: number; picture: number | null; toMoments: number; reels: number; reelCount: number; reelLength: number; total: number };
  card: string | null;
  cards: Projection[];
  notes: string[];
};
export type BenchOptions = {
  /** The video to test (it must have speech in it). */
  file: string;
  /** The project folder (tools, caption fonts, the built site for the tracker). */
  root: string;
  /** Length of the video that is timed (default 10 minutes): a shorter file is repeated, a longer one is cut, without re-encoding. */
  minutes?: number;
  /** Reels to make from the best moments (default 5). */
  reels?: number;
  /** Follow faces and subjects as the studio does (default true). */
  tracking?: boolean;
  /** Settings for the server the check runs (the tests give it a stand-in transcriber). */
  app?: Partial<Omit<AppOptions, 'root' | 'origin'>>;
  log?: (line: string) => void;
};

async function graphicsCard() {
  try {
    const { stdout } = await run('nvidia-smi', ['--query-gpu=name,memory.total,driver_version', '--format=csv,noheader,nounits'], { timeout: 10_000 });
    const [name, memory, driver] = (stdout.trim().split(/\r?\n/)[0] ?? '').split(',').map(s => s.trim());
    return name ? { name, memoryGB: Math.round(Number(memory) / 1024), driver: driver ?? '' } : null;
  } catch { return null; }
}

/** The test video: the file as it is when it already has the right length, otherwise `seconds` of it, repeated or cut by copying
 * the streams (no re-encode, so it takes seconds). Falls back to the file itself when its container cannot be copied. */
async function testVideo(file: string, seconds: number, duration: number, dir: string) {
  if (Math.abs(duration - seconds) <= 2) return { file, looped: false };
  const out = path.join(dir, `test${path.extname(file) || '.mp4'}`);
  try {
    await run('ffmpeg', ['-nostdin', '-v', 'error', '-y', ...(duration < seconds ? ['-stream_loop', '-1'] : []), '-i', file, '-map', '0:v:0', '-map', '0:a:0?', '-c', 'copy', '-t', String(seconds), out], { timeout: 600_000 });
    return { file: out, looped: duration < seconds };
  } catch { return { file, looped: false }; }
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
type Detail = { source: ClipSource; moments: { moments: ClipMoment[] }[] };

export async function runBenchmark(opts: BenchOptions): Promise<BenchReport> {
  const log = opts.log ?? (() => {}), wantReels = Math.max(1, Math.min(12, opts.reels ?? 5)), seconds = Math.round((opts.minutes ?? 10) * 60);
  const original = await probeMedia(opts.file);
  if (!original.hasVideo || !original.hasAudio || original.duration < 5) throw new Error('Use a video with sound and a picture, at least a few seconds long (a talk, a podcast, an interview).');
  const notes: string[] = [], work = await mkdtemp(path.join(os.tmpdir(), 'sprityreels-bench-'));
  let server: Awaited<ReturnType<typeof startServer>> | null = null;
  try {
    log(`Preparing a ${(seconds / 60).toFixed(seconds % 60 ? 1 : 0)}-minute test video from ${path.basename(opts.file)}…`);
    const test = await testVideo(opts.file, seconds, original.duration, work), info = test.file === opts.file ? original : await probeMedia(test.file);
    const bytes = (await stat(test.file)).size;
    if (test.file === opts.file && Math.abs(original.duration - seconds) > 2) notes.push(`This file could not be repeated or cut without re-encoding, so it was timed as it is (${Math.round(original.duration)} s). The times are for that length, not for ${seconds / 60} minutes.`);
    const tools = await resolveClipTools(opts.root), browser = await findBrowser(), gpu = await graphicsCard();
    const built = await stat(path.join(opts.root, 'dist', 'index.html')).then(() => true, () => false), tracking = opts.tracking !== false && !!browser && built;
    if (opts.tracking !== false && !browser) notes.push('No Chrome or Edge was found, so faces and subjects were not followed (the reels were centred). Following them adds a few seconds per reel.');
    else if (opts.tracking !== false && !built) notes.push('The site is not built yet (npm run build), and the tracker page is part of it, so faces and subjects were not followed. Following them adds a few seconds per reel.');
    server = await startServer({ root: opts.root, port: 0, app: { dataDir: path.join(work, 'data'), minFreeBytes: 0, maxUploadBytes: Math.max(1e9, bytes * 1.05), maxVideoMinutes: Math.max(360, Math.ceil(info.duration / 60) + 1), ...opts.app } });
    const base = server.url;
    let cookie = '';
    const call = async (route: string, body?: unknown) => {
      const res = await fetch(`${base}/api/clips${route}`, body === undefined ? { headers: cookie ? { Cookie: cookie } : {} } : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-SprityReels-Request': 'clips', ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) });
      const text = await res.text(); let data: unknown = null; try { data = JSON.parse(text); } catch { /* not JSON */ }
      if (!res.ok) throw new Error(`${route} answered ${res.status}: ${(data as { error?: string } | null)?.error ?? text.slice(0, 200)}`);
      return data as Record<string, any>;
    };

    // The video goes in the way the studio sends it, and everything after that is the product's own pipeline.
    log('Importing: copy, audio, speech recognition, moments…');
    const started = performance.now();
    const up = await fetch(`${base}/api/clips/sources/upload?file=${encodeURIComponent(path.basename(test.file))}&rights=own`, { method: 'POST', headers: { 'X-SprityReels-Request': 'clips' },
      body: Readable.toWeb(createReadStream(test.file)) as unknown as BodyInit, duplex: 'half' } as RequestInit);
    cookie = (up.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    const upBody = await up.json().catch(() => null) as { source?: { id: string }; error?: string } | null;
    if (up.status !== 202 || !upBody?.source) throw new Error(`The upload was refused (${up.status}): ${upBody?.error ?? 'unknown reason'}`);
    const copy = (performance.now() - started) / 1000, id = upBody.source.id;

    let pictureFrom = 0, pictureTo = 0, detail = await call(`/sources/${id}`) as Detail;
    const deadline = Date.now() + Math.max(900, info.duration * 4) * 1000;
    while (detail.source.status === 'working') {
      if (Date.now() > deadline) throw new Error('The import did not finish in time.');
      const visual = detail.source.stages.visual?.status;
      if (visual === 'running' && !pictureFrom) pictureFrom = performance.now();
      if (pictureFrom && !pictureTo && visual && visual !== 'running') pictureTo = performance.now();
      await sleep(100); detail = await call(`/sources/${id}`) as Detail;
    }
    const toMoments = (performance.now() - started) / 1000;
    if (pictureFrom && !pictureTo) pictureTo = performance.now();
    if (detail.source.status === 'failed') throw new Error(detail.source.error ?? 'The import failed.');
    const transcript = detail.source.transcript, speech = transcript?.seconds ?? 0, picture = pictureFrom ? (pictureTo - pictureFrom) / 1000 : null;
    const speechTool: BenchReport['tools']['speech'] = opts.app?.service?.transcriber ? 'standin' : !tools.whisper || !tools.whisperModel ? 'missing' : /\(GPU\)/.test(transcript?.model ?? '') ? 'gpu' : 'cpu';
    if (!transcript?.words) notes.push('No speech was found in this video: use one with people talking.');

    // Reels from the best moments, all at once like the studio's "Create reels" button.
    const picks = (detail.moments[0]?.moments ?? []).slice(0, wantReels);
    let reels = 0, reelLength = 0;
    if (picks.length) {
      log(`Making ${picks.length} reel${picks.length === 1 ? '' : 's'}: ${tracking ? 'tracking, ' : ''}captions, render…`);
      const t = performance.now(), reelsBy = Date.now() + 30 * 60_000;
      const made = await Promise.all(picks.map(m => call('/shorts', { sourceId: id, momentId: m.id, render: true, ...(tracking ? {} : { options: { layout: 'center' } }) })));
      const finished = await Promise.all(made.map(async m => {
        for (;;) {
          const short = (await call(`/shorts/${m.short.id}`)).render as { status: string; duration?: number; error?: string | null } | null;
          if (short && short.status !== 'queued' && short.status !== 'rendering') { if (short.status !== 'done') throw new Error(`A reel failed: ${short.error ?? short.status}`); return short; }
          if (Date.now() > reelsBy) throw new Error('The reels did not finish in time.');
          await sleep(150);
        }
      }));
      reels = (performance.now() - t) / 1000; reelLength = finished.reduce((sum, r) => sum + (r.duration ?? 0), 0) / finished.length;
    } else notes.push('No moments were found, so no reels were made.');
    const total = toMoments + reels;
    const card = gpu ? cardFor(gpu.name) : null, onGpu = speechTool === 'gpu' ? true : speechTool === 'cpu' ? false : null;
    if (speechTool === 'cpu') notes.push('Speech recognition ran on the CPU. The whisper.cpp CUDA 12 build (with cublas64_12.dll next to it; set SPRITYREELS_WHISPER_CLI to its whisper-cli) would run it on the graphics card.');
    if (speechTool === 'gpu' && gpu && !card) notes.push(`${gpu.name} has no published speed, so the other cards below use the published figures alone.`);
    return {
      pc: { cpu: (os.cpus()[0]?.model ?? 'unknown CPU').replace(/\s+/g, ' ').trim(), threads: os.availableParallelism?.() ?? os.cpus().length, memoryGB: Math.round(os.totalmem() / 2 ** 30), platform: `${os.platform()} ${os.release()}`, gpu },
      tools: { speech: speechTool, encoder: tools.nvenc ? 'NVIDIA NVENC' : tools.ffmpeg ? 'x264 (CPU)' : null, tracking },
      video: { name: path.basename(opts.file), seconds: info.duration, width: info.width, height: info.height, megabytes: Math.round(bytes / 1e6), looped: test.looped, source: `${Math.round(original.duration)} s` },
      stages: { copy, speech, speechX: speech > 0 ? info.duration / speech : 0, other: Math.max(0, toMoments - copy - speech - (picture ?? 0)), picture, toMoments, reels, reelCount: picks.length, reelLength, total },
      card: card?.name ?? null,
      cards: projectCards({ audioSeconds: info.duration, speechSeconds: speech, totalSeconds: total, card, onGpu }),
      notes,
    };
  } finally {
    await server?.close().catch(() => {});
    await rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }).catch(() => {});
  }
}

const clock = (s: number) => s >= 90 ? `${Math.floor(s / 60)} min ${String(Math.round(s % 60)).padStart(2, '0')} s` : `${s < 10 ? s.toFixed(1) : Math.round(s)} s`;
const range = ([a, b]: [number, number]) => Math.abs(a - b) < .5 ? clock(a) : `${clock(a)} to ${clock(b)}`;
const row = (label: string, value: string, extra = '') => `  ${label} ${'.'.repeat(Math.max(2, 38 - label.length))} ${value.padStart(10)}${extra ? `   ${extra}` : ''}`;

/** The report as plain text for a terminal. */
export function formatReport(r: BenchReport): string {
  const s = r.stages, minutes = r.video.seconds / 60, lines: string[] = [];
  lines.push('Sprity Reels speed check', '');
  lines.push(`PC         ${r.pc.cpu}, ${r.pc.threads} threads, ${r.pc.memoryGB} GB memory`);
  lines.push(`Graphics   ${r.pc.gpu ? `${r.pc.gpu.name}, ${r.pc.gpu.memoryGB} GB (driver ${r.pc.gpu.driver})` : 'no NVIDIA card found'}`);
  lines.push(`Speech     ${{ gpu: 'whisper.cpp on the graphics card', cpu: 'whisper.cpp on the CPU', standin: 'a stand-in (test run)', missing: 'not set up (whisper.cpp is missing)' }[r.tools.speech]}`);
  lines.push(`Encoder    ${r.tools.encoder ?? 'FFmpeg is missing'}${r.tools.tracking ? ', faces and subjects followed' : ', faces not followed'}`);
  lines.push(`Video      ${r.video.name}: ${clock(r.video.seconds)} of ${r.video.width}x${r.video.height}, ${r.video.megabytes} MB${r.video.looped ? ` (the ${r.video.source} file repeated)` : ''}`, '');
  lines.push(`Measured on this PC (the product's own pipeline, no AI ranking)`);
  lines.push(row('copy the file in', clock(s.copy)));
  lines.push(row('speech recognition', clock(s.speech), s.speechX ? `${s.speechX.toFixed(1)}x real time` : ''));
  lines.push(row('audio, analysis, moments', clock(s.other)));
  lines.push(row('picture pass', s.picture === null ? 'not needed' : clock(s.picture), s.picture === null ? '(mostly speech)' : ''));
  lines.push(row('=> moments on screen after', clock(s.toMoments)));
  lines.push(row(`${s.reelCount} reel${s.reelCount === 1 ? '' : 's'} (${r.tools.tracking ? 'tracking, ' : ''}captions, render)`, clock(s.reels), s.reelCount ? `${clock(s.reels / s.reelCount)} each on average, reels ${Math.round(s.reelLength)} s long` : ''));
  lines.push(row('=> finished reels after', clock(s.total), `${(r.video.seconds / s.total).toFixed(1)}x real time for ${minutes.toFixed(minutes % 1 ? 1 : 0)} min of video`), '');
  lines.push(`Speech recognition on other cards${r.card ? ` (this run on your ${r.card}, scaled by published speed ratios)` : ' (published speeds; this run could not be scaled)'}`);
  for (const c of r.cards) lines.push(`  ${(c.card + (c.measured ? ' (yours)' : '')).padEnd(22)} speech ${range(c.speechSeconds).padEnd(14)} everything ${range(c.totalSeconds)}${c.note ? `   [${c.note}]` : ''}`);
  lines.push('', 'Published speeds: faster-whisper, large-v3-turbo, int8, one stream (RunPod, 2026). Other software scales differently: treat the other cards as good to about 30%.');
  if (r.notes.length) lines.push('', ...r.notes.map(n => `Note: ${n}`));
  return lines.join('\n');
}
