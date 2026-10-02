import { ClipToolError, ffmpegMajor, run } from '../clips/tools';
import { SIGNAL_PIXELS } from './keyframes';
import type { SignalSample } from './keyframes';

/** The picture scan: FFmpeg decodes a long video, keeps one frame every few seconds, shrinks it to 64x64 grey and writes the
 * raw bytes to its standard output, which this process reads straight into memory. No frame is ever written to a file.
 * Each frame is bound to its real presentation time by FFmpeg's showinfo log (the same rule Rinegan uses: a frame whose time
 * cannot be matched is refused, never guessed). On a long video only keyframes are decoded, which is several times
 * faster, and the sample is bounded: at most `maxFrames` frames (8 MiB of pixels at the default). */
export type SignalScan = { samples: SignalSample[]; gap: number; from: number; to: number; keyframesOnly: boolean };
export type ScanOptions = {
  duration: number;
  /** Source seconds of the first second of the file (a downloaded section starts later than the video). */
  offset?: number;
  from?: number;
  to?: number;
  /** Closest spacing between samples in seconds (default 1). */
  minGap?: number;
  /** Most frames kept (default 2048, Rinegan's ceiling). */
  maxFrames?: number;
  /** Videos longer than this many seconds decode only their keyframes (default 300). */
  keyframesAbove?: number;
  signal?: AbortSignal;
  onProgress?: (fraction: number) => void;
};

export async function scanSignals(file: string, options: ScanOptions): Promise<SignalScan> {
  const offset = options.offset ?? 0, from = Math.max(options.from ?? 0, offset), to = Math.min(options.to ?? options.duration, options.duration), span = to - from;
  if (!(span > 0)) return { samples: [], gap: 0, from, to, keyframesOnly: false };
  const maxFrames = Math.max(1, Math.floor(options.maxFrames ?? 2048)), gap = Math.max(options.minGap ?? 1, span / maxFrames);
  const major = await ffmpegMajor();
  // After a seek FFmpeg's clock restarts at the seek point, so showinfo's times are relative to `from`.
  const attempt = async (keyframesOnly: boolean): Promise<SignalScan> => {
    const times: number[] = [], pixels: Uint8Array[] = [];
    let carry: Buffer = Buffer.alloc(0);
    await run('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'info', '-nostats', ...(keyframesOnly ? ['-skip_frame', 'nokey'] : []),
      '-ss', (from - offset).toFixed(3), '-t', span.toFixed(3), '-i', file, '-map', '0:v:0', '-an', '-sn', '-dn',
      '-vf', `select='isnan(prev_selected_t)+gte(t-prev_selected_t\\,${gap.toFixed(3)})',showinfo,scale=64:64:flags=area,format=gray`,
      ...(major >= 6 ? ['-fps_mode', 'passthrough'] : ['-vsync', '0']), '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1'], {
      timeout: 4 * 3600_000, signal: options.signal,
      onStdoutData: chunk => {
        carry = carry.length ? Buffer.concat([carry, chunk]) : chunk;
        let at = 0;
        // Copy each frame out: the chunk's memory is reused by the stream.
        while (carry.length - at >= SIGNAL_PIXELS) { pixels.push(Uint8Array.from(carry.subarray(at, at + SIGNAL_PIXELS))); at += SIGNAL_PIXELS; }
        carry = Buffer.from(carry.subarray(at));
      },
      onStderr: line => {
        if (!line.includes('showinfo') || !/\bn:\s*\d+/.test(line)) return;
        const m = /pts_time:\s*(-?\d+(?:\.\d+)?)/.exec(line);
        if (m) { times.push(Number(m[1])); options.onProgress?.(Math.max(0, Math.min(1, Number(m[1]) / span))); }
      },
    });
    if (times.length !== pixels.length) throw new ClipToolError(`The picture scan could not match its frames to their times (${pixels.length} frames, ${times.length} times), so it was discarded rather than guessed.`, 502);
    const samples = times.map((t, i) => ({ index: i, t: from + Math.max(0, t), pixels: pixels[i] })).filter(s => s.t < to + 0.001);
    return { samples, gap, from, to, keyframesOnly };
  };
  const keyframesOnly = span > (options.keyframesAbove ?? 300);
  const first = await attempt(keyframesOnly);
  // A file with no usable keyframe flags decodes nothing in keyframe mode: scan every frame instead.
  if (keyframesOnly && first.samples.length < Math.min(4, Math.floor(span / gap))) return attempt(false);
  return first;
}
