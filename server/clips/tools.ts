import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { access, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ENERGY_RATE } from '../../src/engine/clips/transcript';
import { VISUAL_RATE, parseVisualActivity } from '../../src/engine/clips/signals';

/** Local tools behind Sprity Reels: yt-dlp (links), whisper.cpp (transcripts), FFmpeg/FFprobe (everything else).
 * `npm run setup:clips` installs pinned copies into .sprityreels/tools; SPRITYREELS_YTDLP, SPRITYREELS_WHISPER_CLI and
 * SPRITYREELS_WHISPER_MODEL point to other installs. Nothing here runs through a shell. */
export class ClipToolError extends Error { constructor(message: string, readonly status = 400) { super(message); } }

export type ClipTools = {
  ytdlp: string | null; whisper: string | null; whisperModel: string | null; whisperGpu: boolean | null;
  ffmpeg: boolean; nvenc: boolean; fonts: string; cacheDir: string;
};
const exists = (file: string) => access(file).then(() => true, () => false);
async function onPath(name: string) {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean), exts = process.platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
  for (const dir of dirs) for (const ext of exts) { const file = path.join(dir, name + ext); if (await exists(file)) return file; }
  return null;
}

export async function resolveClipTools(root: string): Promise<ClipTools> {
  let manifest: { ytdlp?: string | null; whisperCli?: string | null; whisperModel?: string | null } = {};
  try { manifest = JSON.parse(await readFile(path.join(root, '.sprityreels', 'tools', 'clip-tools.json'), 'utf8')); } catch { /* not installed yet */ }
  const pick = async (...candidates: (string | null | undefined)[]) => { for (const c of candidates) if (c && await exists(c)) return path.resolve(c); return null; };
  const ytdlp = await pick(process.env.SPRITYREELS_YTDLP, manifest.ytdlp, await onPath('yt-dlp'));
  const whisper = await pick(process.env.SPRITYREELS_WHISPER_CLI, manifest.whisperCli, await onPath('whisper-cli'));
  const whisperModel = await pick(process.env.SPRITYREELS_WHISPER_MODEL, manifest.whisperModel, path.join(root, '.sprityreels', 'tools', 'whisper', 'models', 'ggml-large-v3-turbo-q5_0.bin'));
  // A Windows CUDA build is only usable with the cuBLAS DLL of its CUDA major version next to it or on PATH.
  let whisperGpu: boolean | null = null;
  if (whisper) {
    const files = (await readdir(path.dirname(whisper)).catch(() => [] as string[])).map(f => f.toLowerCase());
    const cudaBackend = files.includes('ggml-cuda.dll') || files.some(f => f.startsWith('libggml-cuda'));
    if (!cudaBackend) whisperGpu = false;
    else if (process.platform !== 'win32') whisperGpu = true;
    else {
      const major = /^cudart64_(\d\d)/.exec(files.find(f => f.startsWith('cudart64_')) ?? '')?.[1]?.replace(/0$/, '') ?? '12', dll = `cublas64_${major}.dll`;
      whisperGpu = files.includes(dll) || (await Promise.all((process.env.PATH ?? '').split(path.delimiter).filter(Boolean).map(dir => exists(path.join(dir, dll))))).some(Boolean);
    }
  }
  const ffmpeg = await ffmpegMajor() > 0;
  let nvenc = false;
  if (ffmpeg && process.env.SPRITYREELS_CLIPS_ENCODER !== 'x264') {
    // A real 0.1 s encode proves the driver works; listing the encoder is not enough.
    nvenc = await run('ffmpeg', ['-hide_banner', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=256x256:d=0.1', '-c:v', 'h264_nvenc', '-f', 'null', '-'], { timeout: 20_000 }).then(() => true, () => false);
  }
  return { ytdlp, whisper, whisperModel, whisperGpu, ffmpeg, nvenc, fonts: path.join(root, 'public', 'fonts', 'clips'), cacheDir: path.join(root, '.sprityreels', 'tools', 'yt-dlp', 'cache') };
}

let majorCache: Promise<number> | null = null;
/** FFmpeg's major version: 0 when FFmpeg is missing, 99 for git builds that carry no release number. A missing FFmpeg is
 * checked again next time, so installing it while Sprity Reels runs is picked up. */
export function ffmpegMajor() {
  const pending = majorCache ??= run('ffmpeg', ['-hide_banner', '-version'], { timeout: 15_000 })
    .then(({ stdout }) => { const m = /ffmpeg version n?(\d+)\./i.exec(stdout); return m ? Number(m[1]) : 99; }, () => 0);
  void pending.then(v => { if (!v && majorCache === pending) majorCache = null; });
  return pending;
}
/** FFmpeg 7 reads an option's value from a file with -/option; FFmpeg 6 and older only know -filter_complex_script. */
export const filterGraphArgs = (major: number, file: string) => major >= 7 ? ['-/filter_complex', file] : ['-filter_complex_script', file];

export type RunOptions = { cwd?: string; timeout?: number; signal?: AbortSignal; onStdout?: (line: string) => void; onStderr?: (line: string) => void; maxOutput?: number;
  /** Binary standard output (frames, images) goes to this callback chunk by chunk instead of being collected as text. */
  onStdoutData?: (chunk: Buffer) => void };
/** Runs a program without a shell, streams lines, kills the whole process tree on cancel or timeout. */
export function run(bin: string, args: string[], options: RunOptions = {}) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    let stdout = '', stderr = '', settled = false, bufOut = '', bufErr = '';
    const max = options.maxOutput ?? 12_000_000;
    const child = spawn(bin, args, { shell: false, windowsHide: true, cwd: options.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const kill = () => {
      if (process.platform === 'win32' && child.pid) { const k = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); k.on('error', () => child.kill()); }
      else child.kill('SIGKILL');
    };
    const finish = (error?: Error) => {
      if (settled) return; settled = true; clearTimeout(timer); options.signal?.removeEventListener('abort', abort);
      if (bufOut) options.onStdout?.(bufOut); if (bufErr) options.onStderr?.(bufErr);
      error ? reject(error) : resolve({ stdout, stderr });
    };
    const abort = () => { kill(); finish(new ClipToolError('Cancelled.', 499)); };
    const timer = setTimeout(() => { kill(); finish(new ClipToolError(`${path.basename(bin)} took too long and was stopped.`, 504)); }, options.timeout ?? 600_000);
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    const lines = (chunk: string, buf: string, cb?: (line: string) => void) => {
      const text = buf + chunk, parts = text.split(/\r?\n|\r/), rest = parts.pop() ?? '';
      if (cb) for (const p of parts) if (p) cb(p);
      return rest;
    };
    child.stdout.on('data', (b: Buffer) => {
      if (options.onStdoutData) { options.onStdoutData(b); return; }
      const s = b.toString('utf8'); if (stdout.length < max) stdout += s; bufOut = lines(s, bufOut, options.onStdout);
    });
    child.stderr.on('data', (b: Buffer) => { const s = b.toString('utf8'); stderr = (stderr + s).slice(-60_000); bufErr = lines(s, bufErr, options.onStderr); });
    child.on('error', e => finish(new ClipToolError(`${path.basename(bin)} could not start: ${e.message}`, 503)));
    child.on('close', code => finish(code === 0 ? undefined : new ClipToolError(`${path.basename(bin)} failed (exit ${code}). ${stderr.trim().split(/\r?\n/).slice(-4).join(' ').slice(0, 600)}`, 502)));
  });
}

// ------------------------------------------------------------------ yt-dlp
export type LinkInfo = {
  id: string; title: string; extractor: string; webpage_url: string; duration: number; width: number; height: number; fps: number;
  uploader: string | null; channel: string | null; channel_url: string | null; uploader_url: string | null; license: string | null; language: string | null;
  description: string; view_count: number | null; like_count: number | null; upload_date: string | null; is_live: boolean;
  heatmap: { start_time: number; end_time: number; value: number }[] | null; chapters: { title: string; start_time: number; end_time: number }[] | null;
  subtitles: Record<string, { ext: string }[]>; automatic_captions: Record<string, { ext: string }[]>;
};
const ytdlpBase = (tools: ClipTools) => ['--ignore-config', '--no-playlist', '--no-mtime', '--no-colors', '--newline', '--socket-timeout', '30', '--retries', '5', '--fragment-retries', '10',
  '--cache-dir', tools.cacheDir, '--js-runtimes', `node:${process.execPath}`];
/** Friendlier messages for the usual yt-dlp failures. Never includes cookies or local paths. */
export function linkError(error: unknown) {
  const text = error instanceof Error ? error.message : String(error);
  if (/cancel/i.test(text)) return 'Cancelled.';
  if (/sign in|login|age|private video|members-only|cookies/i.test(text)) return 'This video needs a signed-in account (private, members-only or age-restricted). Download it yourself and use Upload.';
  if (/unsupported url|no video formats|unable to extract/i.test(text)) return 'This link is not a supported video page. Paste the video page itself, or upload the file.';
  if (/drm/i.test(text)) return 'This video is DRM-protected and cannot be imported.';
  if (/429|too many requests/i.test(text)) return 'The site is rate-limiting downloads right now. Wait a few minutes and try again.';
  if (/404|not found|unavailable|removed/i.test(text)) return 'The video is unavailable (removed, private or region-locked).';
  if (/could not start|ENOENT/i.test(text)) return 'Link import is not set up on this server (yt-dlp is missing). Upload the video file instead.';
  return `The link could not be read: ${text.replace(/[A-Z]:\\[^\s]+/g, '').slice(0, 300)}`;
}
export async function probeLink(tools: ClipTools, url: string, signal?: AbortSignal): Promise<LinkInfo> {
  if (!tools.ytdlp) throw new ClipToolError('Link import is not set up on this server (yt-dlp is missing). Upload the video file instead.', 503);
  const { stdout } = await run(tools.ytdlp, [...ytdlpBase(tools), '-J', '--skip-download', '--', url], { timeout: 120_000, signal, maxOutput: 40_000_000 });
  const info = JSON.parse(stdout) as LinkInfo & { _type?: string };
  if (info._type === 'playlist') throw new ClipToolError('Paste a single video link, not a playlist or channel.');
  return info;
}
const progressArgs = ['--progress-template', 'download:SPRITYREELS %(progress.downloaded_bytes)s %(progress.total_bytes)s %(progress.total_bytes_estimate)s'];
function progressParser(onProgress?: (fraction: number) => void) {
  return (line: string) => {
    const m = /^SPRITYREELS (\S+) (\S+) (\S+)/.exec(line);
    if (!m || !onProgress) return;
    const got = Number(m[1]), total = Number(m[2]) || Number(m[3]);
    if (got >= 0 && total > 0) onProgress(Math.max(0, Math.min(1, got / total)));
  };
}
const formatFor = (quality: string) => `bv*[height<=${quality}][vcodec^=avc1]+ba[acodec^=mp4a]/bv*[height<=${quality}]+ba/b[height<=${quality}]/b`;
async function downloaded(stdout: string) {
  const file = stdout.trim().split(/\r?\n/).filter(Boolean).pop();
  if (!file || !await exists(file)) throw new ClipToolError('yt-dlp finished without a file.', 502);
  return file;
}
export async function downloadAudio(tools: ClipTools, url: string, dir: string, opts: { signal?: AbortSignal; onProgress?: (f: number) => void }) {
  const { stdout } = await run(tools.ytdlp!, [...ytdlpBase(tools), ...progressArgs, '-f', 'ba[acodec^=mp4a]/ba/b', '-o', path.join(dir, 'audio.%(ext)s'), '--print', 'after_move:filepath', '--', url],
    { timeout: 3 * 3600_000, signal: opts.signal, onStdout: progressParser(opts.onProgress) });
  return downloaded(stdout);
}
export async function downloadVideo(tools: ClipTools, url: string, out: string, opts: { quality: string; section?: { start: number; end: number }; signal?: AbortSignal; onProgress?: (f: number) => void }) {
  const args = [...ytdlpBase(tools), ...progressArgs, '-f', formatFor(opts.quality), '--merge-output-format', 'mp4', '-o', out, '--print', 'after_move:filepath'];
  if (opts.section) args.push('--download-sections', `*${opts.section.start.toFixed(2)}-${opts.section.end.toFixed(2)}`);
  if (tools.ffmpeg) { const ff = await onPath('ffmpeg'); if (ff) args.push('--ffmpeg-location', path.dirname(ff)); }
  const { stdout } = await run(tools.ytdlp!, [...args, '--', url], { timeout: 6 * 3600_000, signal: opts.signal, onStdout: progressParser(opts.onProgress) });
  return downloaded(stdout);
}
/** A small video-only copy (240p, else up to 360p) for the picture pass and contact sheets: about a tenth of the size of
 * the 1080p video, and quick to decode. */
export async function downloadProxy(tools: ClipTools, url: string, dir: string, opts: { signal?: AbortSignal; onProgress?: (f: number) => void }) {
  const format = 'bv*[height<=240][height>=140][vcodec^=avc1]/bv*[height<=360][vcodec^=avc1]/bv*[height<=360]/b[height<=360]/wv*/w';
  const args = [...ytdlpBase(tools), ...progressArgs, '-f', format, '-o', path.join(dir, 'proxy.%(ext)s'), '--print', 'after_move:filepath'];
  if (tools.ffmpeg) { const ff = await onPath('ffmpeg'); if (ff) args.push('--ffmpeg-location', path.dirname(ff)); }
  const { stdout } = await run(tools.ytdlp!, [...args, '--', url], { timeout: 3 * 3600_000, signal: opts.signal, onStdout: progressParser(opts.onProgress) });
  return downloaded(stdout);
}
/** Captions in the video's language (manual first, then the original-language ASR track) as json3, if the site has any. */
export async function downloadCaptions(tools: ClipTools, url: string, info: LinkInfo, dir: string, signal?: AbortSignal) {
  const lang = (info.language ?? '').split('-')[0];
  const manual = Object.keys(info.subtitles ?? {}).find(k => lang && (k === lang || k.startsWith(`${lang}-`)) && info.subtitles[k].some(f => f.ext === 'json3'));
  const auto = Object.keys(info.automatic_captions ?? {}), orig = auto.find(k => k === `${lang}-orig`) ?? auto.find(k => k.endsWith('-orig'));
  const pickLang = manual ?? orig ?? (lang && auto.includes(lang) ? lang : null);
  if (!pickLang) return null;
  await run(tools.ytdlp!, [...ytdlpBase(tools), '--skip-download', manual ? '--write-subs' : '--write-auto-subs', '--sub-langs', pickLang, '--sub-format', 'json3', '-o', path.join(dir, 'captions.%(ext)s'), '--', url], { timeout: 120_000, signal });
  const file = (await readdir(dir)).find(f => f.startsWith('captions.') && f.endsWith('.json3'));
  return file ? { file: path.join(dir, file), language: pickLang.replace(/-orig$/, ''), manual: !!manual } : null;
}

// ------------------------------------------------------------------ FFmpeg helpers
export type MediaInfo = { duration: number; width: number; height: number; fps: number; vcodec: string | null; acodec: string | null; hasVideo: boolean; hasAudio: boolean };
const rate = (value: unknown) => { const [a, b] = String(value ?? '').split('/').map(Number); const fps = b ? a / b : a; return Number.isFinite(fps) && fps > 0 ? fps : 0; };
export async function probeMedia(file: string): Promise<MediaInfo> {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height,avg_frame_rate,r_frame_rate:format=duration', '-of', 'json', file], { timeout: 60_000 });
  const raw = JSON.parse(stdout), streams = (raw.streams ?? []) as Record<string, unknown>[];
  const v = streams.find(s => s.codec_type === 'video'), a = streams.find(s => s.codec_type === 'audio');
  return { duration: Number(raw.format?.duration) || 0, width: Number(v?.width) || 0, height: Number(v?.height) || 0, fps: rate(v?.avg_frame_rate) || rate(v?.r_frame_rate),
    vcodec: typeof v?.codec_name === 'string' ? v.codec_name : null, acodec: typeof a?.codec_name === 'string' ? a.codec_name : null, hasVideo: !!v, hasAudio: !!a };
}
/** 16 kHz mono PCM for whisper (and the loudness envelope). */
export async function extractWav(input: string, out: string, opts: { start?: number; duration?: number; signal?: AbortSignal; timeout?: number } = {}) {
  const args = ['-nostdin', '-v', 'error', '-y'];
  if (opts.start) args.push('-ss', opts.start.toFixed(3));
  args.push('-i', input);
  if (opts.duration) args.push('-t', opts.duration.toFixed(3));
  args.push('-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', out);
  await run('ffmpeg', args, { timeout: opts.timeout ?? 3600_000, signal: opts.signal });
  return out;
}
/** Streams a 16-bit PCM WAV into the 10 ms loudness envelope without loading it all. */
export async function wavEnvelope(file: string) {
  const header = Buffer.alloc(4096), handle = await import('node:fs/promises').then(fs => fs.open(file, 'r'));
  let dataOffset = 0, rateHz = 16000, channels = 1;
  try {
    await handle.read(header, 0, header.length, 0);
    let p = 12;
    while (p + 8 <= header.length) {
      const id = header.toString('ascii', p, p + 4), n = header.readUInt32LE(p + 4);
      if (id === 'fmt ') { channels = header.readUInt16LE(p + 10); rateHz = header.readUInt32LE(p + 12); }
      if (id === 'data') { dataOffset = p + 8; break; }
      p += 8 + n + (n % 2);
    }
  } finally { await handle.close(); }
  if (!dataOffset || channels !== 1) throw new ClipToolError('Unexpected audio format.', 500);
  const hop = Math.round(rateHz / ENERGY_RATE), out: number[] = [];
  let sum = 0, count = 0, carry: Buffer | null = null;
  for await (const chunk of createReadStream(file, { start: dataOffset, highWaterMark: 1 << 20 })) {
    let buf = chunk as Buffer;
    if (carry) { buf = Buffer.concat([carry, buf]); carry = null; }
    const usable = buf.length - (buf.length % 2);
    for (let i = 0; i < usable; i += 2) {
      const v = buf.readInt16LE(i); sum += v * v; count++;
      if (count === hop) { const rms = Math.sqrt(sum / hop) / 32768, db = rms > 1e-5 ? 20 * Math.log10(rms) : -100; out.push(Math.max(0, Math.min(100, Math.round(db + 100)))); sum = 0; count = 0; }
    }
    if (usable < buf.length) carry = buf.subarray(usable);
  }
  return Uint8Array.from(out);
}

/** How much the picture changes, VISUAL_RATE times a second over the whole file: FFmpeg's scene detector reports the mean
 * absolute difference between frames 0.25 s apart on a 160-pixel grey copy. The loop filter is skipped while decoding
 * (the picture is only measured, never shown), which makes long 1080p files noticeably faster to scan. */
export async function visualActivity(file: string, workDir: string, opts: { duration: number; signal?: AbortSignal; onProgress?: (f: number) => void }) {
  const out = `visual-${process.pid}-${Date.now().toString(36)}.txt`;
  try {
    await run('ffmpeg', ['-nostdin', '-hide_banner', '-v', 'error', '-skip_loop_filter', 'all', '-flags2', '+fast', '-i', file, '-an', '-sn', '-dn',
      '-vf', `fps=${VISUAL_RATE},scale=160:-2,format=gray,scdet=threshold=100,metadata=print:key=lavfi.scd.mafd:file=${out}`, '-f', 'null', '-', '-progress', 'pipe:1', '-nostats'], {
      timeout: 4 * 3600_000, signal: opts.signal, cwd: workDir,
      onStdout: line => { const m = /^out_time_us=(\d+)/.exec(line); if (m && opts.duration > 0) opts.onProgress?.(Math.min(1, Number(m[1]) / 1e6 / opts.duration)); },
    });
    return parseVisualActivity(await readFile(path.join(workDir, out), 'utf8'), opts.duration);
  } finally { await rm(path.join(workDir, out), { force: true }); }
}

// ------------------------------------------------------------------ whisper.cpp
export type WhisperRun = { json: unknown; gpu: boolean; seconds: number };
/** Word-timed transcription (full JSON with DTW token times). Progress comes from whisper's own percentage lines. */
export async function transcribe(tools: ClipTools, wav: string, opts: { language: string; prompt: string; signal?: AbortSignal; onProgress?: (f: number) => void; /** CPU threads (default: every core, at most 16). */ threads?: number }): Promise<WhisperRun> {
  if (!tools.whisper || !tools.whisperModel) throw new ClipToolError('Transcription is not set up on this server (whisper.cpp is missing).', 503);
  const base = wav.replace(/\.wav$/i, ''), started = Date.now();
  let gpu = false;
  const threads = opts.threads ?? (tools.whisperGpu ? 4 : Math.max(2, Math.min(16, (os.availableParallelism?.() ?? os.cpus().length))));
  const args = ['-m', tools.whisperModel, '-f', wav, '-l', opts.language || 'auto', '-ojf', '-of', base, '-dtw', 'large.v3.turbo', '-nfa', '-pp', '-sns', '-t', String(threads)];
  if (opts.prompt) args.push('--prompt', opts.prompt.slice(0, 220));
  await run(tools.whisper, args, {
    timeout: 6 * 3600_000, signal: opts.signal, cwd: path.dirname(tools.whisper),
    onStderr: line => {
      const m = /progress\s*=\s*(\d+)%/.exec(line);
      if (m) opts.onProgress?.(Number(m[1]) / 100);
      if (/using CUDA|CUDA0|ggml_cuda_init: found/i.test(line)) gpu = true;
    },
  });
  const json = JSON.parse(await readFile(`${base}.json`, 'utf8'));
  return { json, gpu, seconds: (Date.now() - started) / 1000 };
}
