import { copyFile, mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ClipShort } from '../../src/engine/clips/types';
import { CLIP_ASPECTS } from '../../src/engine/clips/types';
import type { Timeline, TimelinePiece } from '../../src/engine/clips/timeline';
import type { CameraPlan, CameraShot } from '../../src/engine/clips/reframe';
import { cropExpression, fitSize, shotAt } from '../../src/engine/clips/reframe';
import { ClipToolError, ffmpegMajor, filterGraphArgs, run } from './tools';

/** One FFmpeg pass per short: frame-accurate trims, speaker-following crops, punch-ins on jump cuts, ducked voiceover,
 * -14 LUFS loudness, and the animated ASS captions burned in. NVENC when the GPU works, x264 otherwise. */
export type MediaSpan = { file: string; start: number; end: number; offset: number; width: number; height: number; hasAudio: boolean };
export type RenderRequest = {
  short: ClipShort; timeline: Timeline; camera: CameraPlan; spans: MediaSpan[]; ass: string; workDir: string; fontsDir: string; out: string;
  encoder: 'nvenc' | 'x264'; hwaccel: boolean; signal?: AbortSignal; onProgress?: (fraction: number) => void;
  /** CPU threads for the x264 encoder (default: all cores). */
  threads?: number;
};
const even = (x: number) => Math.max(2, Math.round(x / 2) * 2);
const f3 = (x: number) => x.toFixed(3);

function spanFor(spans: MediaSpan[], p: TimelinePiece) {
  const need = { s: p.src, e: p.src + p.dur };
  return spans.find(s => s.start <= need.s + .02 && s.end >= need.e - .02) ?? null;
}

export function buildGraph(req: Omit<RenderRequest, 'signal' | 'onProgress' | 'workDir' | 'fontsDir' | 'out' | 'encoder' | 'ass'>) {
  const { short, timeline, camera, spans } = req, [W, H] = CLIP_ASPECTS[short.aspect], fps = timeline.fps;
  if (!timeline.pieces.length) throw new ClipToolError('This short has nothing to render.');
  // Common working resolution: the largest media used, so crops from mixed sections line up.
  const used = timeline.pieces.map(p => { const s = spanFor(spans, p); if (!s) throw new ClipToolError(`The video for ${p.src.toFixed(1)}-${(p.src + p.dur).toFixed(1)} s is not downloaded yet.`, 409); return s; });
  const RW = even(Math.max(...used.map(s => s.width))), RH = even(Math.max(...used.map(s => s.height)));
  type Input = { span: MediaSpan; ss: number; t: number; pieces: number[] };
  const inputs: Input[] = [];
  timeline.pieces.forEach((p, i) => {
    const span = used[i], last = inputs[inputs.length - 1], prev = i > 0 ? timeline.pieces[i - 1] : null;
    const fileStart = p.src - span.offset;
    // Pieces that move forward through the same file share one decoder; jumping back or far ahead opens a new input.
    if (last && last.span === span && prev && p.src >= prev.src + prev.dur - .01 && p.src - (prev.src + prev.dur) <= 20) { last.pieces.push(i); last.t = Math.max(last.t, fileStart + p.dur + 1 - last.ss); return; }
    // Seek to a frame boundary so frame n of the normalised stream is exactly ss + n / fps.
    const ss = Math.floor(Math.max(0, fileStart - 1.5) * fps) / fps;
    inputs.push({ span, ss, t: fileStart + p.dur + 1 - ss, pieces: [i] });
  });
  const args: string[] = [], lines: string[] = [];
  for (const input of inputs) args.push(...(req.hwaccel ? ['-hwaccel', 'cuda'] : []), '-ss', f3(input.ss), '-t', f3(input.t), '-i', input.span.file);
  const voicePieces = timeline.pieces.map((p, i) => ({ p, i })).filter(x => x.p.kind === 'voice' && x.p.voice);
  voicePieces.forEach(v => args.push('-i', v.p.voice!.file));

  // Camera keys were planned on the media the faces were tracked on; scale them to the working resolution.
  const sx = RW / (camera.srcW || RW), sy = RH / (camera.srcH || RH);
  type Segment = { piece: number; n0: number; n1: number; src: number; dur: number; shot: CameraShot };
  /** One shot's panes for one segment: crops that follow their keys, or the whole frame over a blurred copy, tiled. */
  const panes = (from: string, seg: Segment, out: string) => {
    const p = timeline.pieces[seg.piece], list = seg.shot.panes, single = list.length === 1;
    const parts = list.map((_, q) => `${out}q${q}`);
    if (!single) lines.push(`${from}split=${list.length}${list.map((_, q) => `[${out}i${q}]`).join('')}`);
    list.forEach((pane, q) => {
      const src = single ? from : `[${out}i${q}]`, to = parts[q], z = pane.role === 'face' || single ? p.zoom : 1;
      if (pane.fit) {
        const size = fitSize(RW, RH, pane.w, pane.h, z), cw = Math.min(size.w, pane.w), ch = Math.min(size.h, pane.h), bw = even(pane.w / 6), bh = even(pane.h / 6);
        lines.push(`${src}split=2[${to}b][${to}f]`);
        lines.push(`[${to}b]scale=${bw}:${bh}:force_original_aspect_ratio=increase,crop=${bw}:${bh},gblur=sigma=5,scale=${pane.w}:${pane.h},eq=brightness=-0.1:saturation=1.1[${to}g]`);
        lines.push(`[${to}f]scale=${size.w}:${size.h}:flags=lanczos,crop=${cw}:${ch}[${to}c]`);
        lines.push(`[${to}g][${to}c]overlay=${(pane.w - cw) / 2}:${(pane.h - ch) / 2}[${to}]`);
        return;
      }
      const winW = Math.min(RW, pane.win.w * sx), winH = Math.min(RH, pane.win.h * sy), cw = Math.min(RW, even(winW / z)), ch = Math.min(RH, even(winH / z));
      const keys = pane.keys.map(k => ({ ...k, x: k.x * sx, y: k.y * sy }));
      lines.push(`${src}crop=w=${cw}:h=${ch}:x='${cropExpression(keys, 'x', seg.src, seg.dur, (winW - cw) / 2)}':y='${cropExpression(keys, 'y', seg.src, seg.dur, (winH - ch) * .35)}',scale=${pane.w}:${pane.h}:flags=lanczos,setsar=1[${to}]`);
    });
    if (single) { lines.push(`[${parts[0]}]setsar=1,format=yuv420p[${out}]`); return; }
    // Thin dark seams between tiles, like a hand-made split screen.
    const seams = [...new Set(list.flatMap(pn => [pn.y > 0 ? `drawbox=x=${pn.x}:y=${pn.y - 3}:w=${pn.w}:h=6:color=black@0.85:t=fill` : '', pn.x > 0 ? `drawbox=x=${pn.x - 3}:y=${pn.y}:w=6:h=${pn.h}:color=black@0.85:t=fill` : ''].filter(Boolean)))];
    lines.push(`${parts.map(x => `[${x}]`).join('')}xstack=inputs=${list.length}:layout=${list.map(pn => `${pn.x}_${pn.y}`).join('|')},${seams.length ? `${seams.join(',')},` : ''}setsar=1,format=yuv420p[${out}]`);
  };
  const concatIn: string[] = [];
  inputs.forEach((input, k) => {
    // Every input becomes constant frame rate first (phones record variable rate), then pieces cut whole frames and
    // their audio uses the same frame times, so audio and video lengths match exactly across any number of cuts.
    const n = input.pieces.length, frames = new Map<number, [number, number]>(), segments: Segment[] = [];
    for (const i of input.pieces) {
      const p = timeline.pieces[i], n0 = Math.max(0, Math.round((p.src - input.span.offset - input.ss) * fps)), n1 = n0 + Math.max(1, Math.round(p.dur * fps));
      frames.set(i, [n0, n1]);
      // A scene cut inside a piece switches to the next shot's layout on the exact frame (slivers under 2 frames stay).
      const marks = [n0];
      for (const shot of camera.shots) { const nb = n0 + Math.round((shot.s - p.src) * fps); if (shot.s > p.src && nb - marks[marks.length - 1] >= 2 && n1 - nb >= 2) marks.push(nb); }
      marks.push(n1);
      for (let m = 0; m < marks.length - 1; m++) { const src = p.src + (marks[m] - n0) / fps; segments.push({ piece: i, n0: marks[m], n1: marks[m + 1], src, dur: (marks[m + 1] - marks[m]) / fps, shot: shotAt(camera, src + .5 / fps) }); }
    }
    lines.push(`[${k}:v]setpts=PTS-STARTPTS,fps=${fps}${segments.length > 1 ? `,split=${segments.length}${segments.map((_, j) => `[sv${k}_${j}]`).join('')}` : `[sv${k}_0]`}`);
    if (input.span.hasAudio && n > 1) lines.push(`[${k}:a]asplit=${n}${input.pieces.map(i => `[sa${i}]`).join('')}`);
    const norm = input.span.width !== RW || input.span.height !== RH ? `,scale=${RW}:${RH}` : '';
    segments.forEach((seg, j) => {
      const own = segments.filter(s => s.piece === seg.piece), q = own.indexOf(seg);
      lines.push(`[sv${k}_${j}]trim=start_frame=${seg.n0}:end_frame=${seg.n1},setpts=PTS-STARTPTS${norm}[h${k}_${j}]`);
      panes(`[h${k}_${j}]`, seg, own.length > 1 ? `vs${seg.piece}_${q}` : `v${seg.piece}`);
    });
    for (const i of input.pieces) {
      const own = segments.filter(s => s.piece === i);
      if (own.length > 1) lines.push(`${own.map((_, q) => `[vs${i}_${q}]`).join('')}concat=n=${own.length}:v=1:a=0[v${i}]`);
      const p = timeline.pieces[i], [n0, n1] = frames.get(i)!;
      const a = (n0 / fps).toFixed(6), b = (n1 / fps).toFixed(6), dur = (n1 - n0) / fps, ain = n > 1 ? `[sa${i}]` : `[${k}:a]`;
      const volume = short.audio.sourceVolume * (p.kind === 'voice' ? 10 ** (short.audio.duckDb / 20) : 1), fade = Math.min(.012, dur / 4);
      if (input.span.hasAudio) lines.push(`${ain}atrim=start=${a}:end=${b},asetpts=PTS-STARTPTS,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,volume=${volume.toFixed(4)},afade=t=in:st=0:d=${f3(fade)},afade=t=out:st=${(dur - fade).toFixed(6)}:d=${f3(fade)},apad=whole_dur=${dur.toFixed(6)},atrim=duration=${dur.toFixed(6)}[a${i}]`);
      else lines.push(`aevalsrc=0:c=stereo:s=48000:d=${dur.toFixed(6)}[a${i}]`);
      concatIn[i] = `[v${i}][a${i}]`;
    }
  });
  lines.push(`${concatIn.join('')}concat=n=${timeline.pieces.length}:v=1:a=1[vc][ac]`);
  lines.push(`[vc]ass=filename=captions.ass:fontsdir=fonts[vo]`);
  let audio = '[ac]';
  if (voicePieces.length) {
    voicePieces.forEach((v, k) => lines.push(`[${inputs.length + k}:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,adelay=delays=${Math.round(v.p.out * 1000)}:all=1[vv${k}]`));
    lines.push(`[ac]${voicePieces.map((_, k) => `[vv${k}]`).join('')}amix=inputs=${voicePieces.length + 1}:duration=first:dropout_transition=0:normalize=0[am]`);
    audio = '[am]';
  }
  const bleeps = (timeline.bleeps ?? []).filter(b => b.e > b.s && b.s < timeline.duration).slice(0, 400);
  if (bleeps.length) {
    // Censored words: the mix is silenced in 5 ms steps over each word; bleep adds a 1 kHz tone in the same spans.
    const spans = bleeps.map(b => `between(t,${f3(b.s)},${f3(Math.min(timeline.duration, b.e))})`).join('+');
    lines.push(`${audio}asetnsamples=n=240:p=0,volume=volume='1-min(1,${spans})':eval=frame[ab]`);
    audio = '[ab]';
    if ((short.censor?.style ?? 'bleep') === 'bleep') {
      lines.push(`aevalsrc=exprs='0.22*sin(2*PI*1000*t)*min(1,${spans})':c=stereo:s=48000:d=${f3(timeline.duration)}[beep]`);
      lines.push(`[ab][beep]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[abb]`);
      audio = '[abb]';
    }
  }
  lines.push(`${audio}${short.audio.normalize ? 'loudnorm=I=-14:TP=-1.5:LRA=11,' : ''}aresample=48000,atrim=duration=${f3(timeline.duration)}[ao]`);
  return { args, graph: lines.join(';\n'), size: [W, H] as const };
}

async function copyFonts(from: string, to: string) {
  await mkdir(to, { recursive: true });
  for (const f of (await readdir(from).catch(() => [] as string[])).filter(f => /\.(ttf|otf)$/i.test(f))) await copyFile(path.join(from, f), path.join(to, f));
}

const X264_PRESETS = ['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow', 'slower', 'veryslow'];
const whole = (value: string | undefined, low: number, high: number, fallback: number) => { const n = Number(value); return Number.isInteger(n) && n >= low && n <= high ? n : fallback; };
/** Encoder settings. The defaults favour a service: x264 `veryfast` at CRF 21 takes about half the CPU time of `medium` at CRF 19
 * and makes files about a quarter smaller (measured on a 50 s 1080x1920 clip: 16 s and 12.9 MB against 34 s and 16.8 MB), which is
 * what a social platform will re-encode anyway; NVENC runs at constant quality 23 with a 12 Mbit/s ceiling. A creator who wants
 * the last bit of quality sets SPRITYREELS_X264_PRESET=medium and SPRITYREELS_X264_CRF=19 (SPRITYREELS_NVENC_CQ=19,
 * SPRITYREELS_NVENC_MAXRATE=20M). `threads` shares the cores between the renders that run at once. */
export function encoderArgs(encoder: 'nvenc' | 'x264', gop: string, options: { threads?: number; env?: NodeJS.ProcessEnv } = {}) {
  const env = options.env ?? process.env;
  if (encoder === 'nvenc') {
    const rate = whole(/^(\d+)M$/.exec(env.SPRITYREELS_NVENC_MAXRATE ?? '')?.[1], 2, 200, 12);
    return ['-c:v', 'h264_nvenc', '-preset', 'p5', '-tune', 'hq', '-rc', 'vbr', '-cq', String(whole(env.SPRITYREELS_NVENC_CQ, 10, 40, 23)), '-b:v', '0', '-maxrate', `${rate}M`, '-bufsize', `${rate * 2}M`, '-profile:v', 'high', '-spatial-aq', '1', '-temporal-aq', '1', '-bf', '2', '-g', gop];
  }
  const preset = X264_PRESETS.includes(env.SPRITYREELS_X264_PRESET ?? '') ? env.SPRITYREELS_X264_PRESET! : 'veryfast';
  return ['-c:v', 'libx264', '-preset', preset, '-crf', String(whole(env.SPRITYREELS_X264_CRF, 10, 35, 21)), '-profile:v', 'high', '-g', gop, ...(options.threads ? ['-threads', String(options.threads)] : [])];
}

export async function renderShort(req: RenderRequest) {
  const { args, graph, size } = buildGraph(req);
  await mkdir(req.workDir, { recursive: true });
  await writeFile(path.join(req.workDir, 'captions.ass'), req.ass, 'utf8');
  await writeFile(path.join(req.workDir, 'graph.txt'), graph, 'utf8');
  await copyFonts(req.fontsDir, path.join(req.workDir, 'fonts'));
  const fps = req.timeline.fps, gop = String(Math.round(fps * 2));
  const video = encoderArgs(req.encoder, gop, { threads: req.threads });
  const temp = `${req.out}.part.mp4`;
  await run('ffmpeg', ['-nostdin', '-hide_banner', '-v', 'error', '-y', ...args, ...filterGraphArgs(await ffmpegMajor(), 'graph.txt'), '-map', '[vo]', '-map', '[ao]', ...video,
    '-r', String(fps), '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', temp], {
    cwd: req.workDir, timeout: 2 * 3600_000, signal: req.signal,
    onStdout: line => { const m = /^out_time_us=(\d+)/.exec(line); if (m) req.onProgress?.(Math.min(1, Number(m[1]) / 1e6 / Math.max(.1, req.timeline.duration))); },
  });
  await rm(req.out, { force: true }); await rename(temp, req.out);
  return { bytes: (await stat(req.out)).size, width: size[0], height: size[1], encoder: req.encoder === 'nvenc' ? 'NVIDIA NVENC (H.264)' : 'x264 (H.264)' };
}

/** A cover frame (the hook card is on screen early), for Reels/TikTok covers and the studio list. */
export async function coverFrame(video: string, out: string, at: number) {
  await run('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-ss', f3(Math.max(0, at)), '-i', video, '-frames:v', '1', '-q:v', '3', out], { timeout: 60_000 });
  return out;
}
