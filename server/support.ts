import type { IncomingMessage } from 'node:http';

export class HttpError extends Error { constructor(message: string, readonly status = 400) { super(message); } }

/** Reads a JSON request body of at most `limit` bytes. */
export async function readJson(req: IncomingMessage, limit = 1_000_000): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError('This request is too large.', 413);
    chunks.push(chunk as Buffer);
  }
  if (!size) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError('Send valid JSON.', 400); }
}

/** One `bytes=a-b` range of a file of `size` bytes, or null when the request has no Range header. Throws on a bad range. */
export function byteRange(value: string | undefined, size: number): { start: number; end: number } | null {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2])) throw new HttpError('Unsupported byte range.', 416);
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) throw new HttpError('Byte range is outside this file.', 416);
  return { start, end };
}
