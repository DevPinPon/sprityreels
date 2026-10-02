import sharp from 'sharp';
import type { OverlayOptions } from 'sharp';
import { run } from './tools';

/** Contact sheets: frames of a video at chosen times, tiled into one JPEG with the time on every tile. They let a model
 * with image input (Codex in the studio, or an agent through MCP) see what happens in a long video without watching it. */
/** m:ss (h:mm:ss past an hour), with tenths when the time is not a whole second. */
export const clock = (t: number) => {
  const tenths = Math.round(Math.max(0, t) * 10), s = Math.floor(tenths / 10), h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60);
  const sec = `${String(s % 60).padStart(2, '0')}${tenths % 10 ? `.${tenths % 10}` : ''}`;
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
};
const escape = (text: string) => text.replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', '\'': '&apos;' })[c]!);

/** One JPEG per time, four at a time, read straight from FFmpeg's output into memory: no frame is written to disk. Input
 * seeking lands on the exact frame; a time that cannot be read (past the end, a damaged spot) gives null. offset is the
 * file's start in source seconds (downloaded sections start later). */
export async function grabFrames(file: string, times: number[], opts: { width: number; offset?: number; signal?: AbortSignal }): Promise<(Buffer | null)[]> {
  const out: (Buffer | null)[] = times.map(() => null);
  let next = 0;
  const worker = async () => {
    while (next < times.length) {
      const k = next++, chunks: Buffer[] = [];
      opts.signal?.throwIfAborted();
      try {
        await run('ffmpeg', ['-nostdin', '-hide_banner', '-v', 'error', '-ss', Math.max(0, times[k] - (opts.offset ?? 0)).toFixed(3), '-i', file, '-frames:v', '1', '-an', '-vf', `scale=${opts.width}:-2`, '-q:v', '3', '-f', 'image2pipe', '-c:v', 'mjpeg', 'pipe:1'],
          { timeout: 60_000, signal: opts.signal, onStdoutData: chunk => chunks.push(chunk) });
        const jpeg = Buffer.concat(chunks);
        if (jpeg.length) out[k] = jpeg;
      } catch (error) { if (opts.signal?.aborted) throw error; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, times.length) }, worker));
  return out;
}

/** Tile size for a source aspect: the long side of a tile is `long` pixels. */
export function tileSize(aspect: number, long: number) {
  const a = aspect > 0 && Number.isFinite(aspect) ? aspect : 16 / 9;
  return a >= 1 ? { w: long, h: Math.max(2, Math.round(long / a / 2) * 2) } : { w: Math.max(2, Math.round(long * a / 2) * 2), h: long };
}

/** Frames tiled left to right, top to bottom, each with its label in the corner, under an optional title bar. */
export async function contactSheet(frames: (Buffer | null)[], labels: string[], opts: { cols: number; tile: { w: number; h: number }; title?: string }) {
  const pad = 4, { w: tw, h: th } = opts.tile, cols = Math.max(1, Math.min(opts.cols, frames.length)), rows = Math.max(1, Math.ceil(frames.length / cols));
  const titleH = opts.title ? 30 : 0, width = cols * tw + (cols + 1) * pad, height = titleH + rows * th + (rows + 1) * pad;
  const blank = await sharp({ create: { width: tw, height: th, channels: 3, background: '#262626' } }).jpeg().toBuffer();
  const composites: OverlayOptions[] = [];
  for (let k = 0; k < frames.length; k++) {
    const left = pad + (k % cols) * (tw + pad), top = titleH + pad + Math.floor(k / cols) * (th + pad);
    const tile = frames[k] ? await sharp(frames[k]!).resize(tw, th, { fit: 'contain', background: '#000' }).jpeg().toBuffer().catch(() => blank) : blank;
    composites.push({ input: tile, left, top });
    const label = (labels[k] ?? '').slice(0, 40);
    if (label) {
      const lw = Math.min(tw, 12 + label.length * 9);
      composites.push({ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${lw}" height="22"><rect width="${lw}" height="22" fill="#000" fill-opacity="0.7"/><text x="6" y="16" font-family="DejaVu Sans, Arial, Helvetica, sans-serif" font-size="14" font-weight="bold" fill="#fff">${escape(label)}</text></svg>`), left, top: top + th - 22 });
    }
  }
  if (opts.title) composites.push({ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${titleH}"><text x="8" y="21" font-family="DejaVu Sans, Arial, Helvetica, sans-serif" font-size="16" font-weight="bold" fill="#fff">${escape(opts.title.slice(0, 160))}</text></svg>`), left: 0, top: 0 });
  const jpeg = await sharp({ create: { width, height, channels: 3, background: '#111111' } }).composite(composites).jpeg({ quality: 80, mozjpeg: true }).toBuffer();
  return { jpeg, width, height };
}
