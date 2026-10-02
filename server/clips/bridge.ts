import type { IncomingMessage, ServerResponse } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { once } from 'node:events';
import { Zip, ZipPassThrough } from 'fflate';
import { HttpError, byteRange, readJson } from '../support';
import { ClipError, ClipStudioService, publicMessage } from './service';
import { GeminiError } from './gemini';
import { ClipToolError } from './tools';
import { ClipInputError } from '../../src/engine/clips/types';

/** Sprity Reels HTTP API. handleClipApi serves the website and handleTrackerApi the headless tracker page; the app layer
 * (server/app.ts) decides who may call which and which visitor's service answers. Nothing here returns an API key, a usage
 * cost or a path on this computer. */
export type ClipApiOptions = {
  /** Largest upload in bytes. */
  maxUploadBytes: number;
  /** What this visitor may upload right now: the largest upload, or less when their workspace is nearly full. */
  uploadAllowance?: () => Promise<{ bytes: number; why: 'limit' | 'quota' | 'disk' }>;
  /** Hours after a visitor's last visit when their files are deleted (0: never). Shown to the visitor. */
  retentionHours?: number;
  /** Called before every request that spends AI credit: true to go on, or the reason to answer 429 with. */
  aiAllowed: () => true | string | Promise<true | string>;
  /** Throws an HttpError unless a pasted link may be handed to yt-dlp (see server/links.ts). */
  checkLink: (url: unknown) => Promise<void>;
};

/** Streams a file with byte ranges. A file that has a modified time also gets a validator (ETag and Last-Modified, `private,
 * no-cache`): the browser asks again before reusing it, and the answer is a 304 with no body while the file is unchanged, so a
 * reel or a source video that is played again, reloaded or seeked is not sent twice. */
function sendFile(req: IncomingMessage, res: ServerResponse, file: { path: string; size: number; mtimeMs?: number }, type: string, download?: string) {
  res.setHeader('Accept-Ranges', 'bytes'); res.setHeader('Content-Type', type);
  if (download) res.setHeader('Content-Disposition', `attachment; filename="${download.replace(/[^a-zA-Z0-9._-]/g, '_')}"`);
  let etag = '', modified = '';
  if (file.mtimeMs !== undefined) {
    etag = `"${file.size.toString(16)}-${Math.floor(file.mtimeMs).toString(16)}"`; modified = new Date(Math.floor(file.mtimeMs / 1000) * 1000).toUTCString();
    res.setHeader('ETag', etag); res.setHeader('Last-Modified', modified); res.setHeader('Cache-Control', 'private, no-cache');
    const none = String(req.headers['if-none-match'] ?? '');
    if (none && (none.trim() === '*' || none.split(',').some(tag => tag.trim().replace(/^W\//, '') === etag))) { res.statusCode = 304; res.end(); return; }
  }
  // A range is only honoured for the version the browser already holds part of.
  const ifRange = String(req.headers['if-range'] ?? ''), honour = !ifRange || ifRange === etag || ifRange === modified;
  let range: ReturnType<typeof byteRange>;
  try { range = honour ? byteRange(req.headers.range, file.size) : null; } catch { res.statusCode = 416; res.setHeader('Content-Range', `bytes */${file.size}`); res.end(); return; }
  res.statusCode = range ? 206 : 200;
  if (range) res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${file.size}`);
  res.setHeader('Content-Length', range ? range.end - range.start + 1 : file.size);
  if (req.method === 'HEAD') { res.end(); return; }
  const stream = createReadStream(file.path, range || undefined); stream.on('error', () => res.destroy()); res.on('close', () => stream.destroy()); stream.pipe(res);
}
/** Streams a stored (uncompressed: video does not compress) ZIP, reading each file from disk as the client takes it. */
async function streamZip(res: ServerResponse, entries: { name: string; file?: string; data?: Uint8Array }[]) {
  const zip = new Zip((error, chunk, final) => { if (error) { res.destroy(error); return; } res.write(chunk); if (final) res.end(); });
  // A client that goes away never drains: closing ends the wait too.
  const drained = () => res.writableNeedDrain ? Promise.race([once(res, 'drain'), once(res, 'close')]).then(() => {}, () => {}) : Promise.resolve();
  for (const entry of entries) {
    if (res.destroyed) return;
    const file = new ZipPassThrough(entry.name);
    zip.add(file);
    if (entry.data) { file.push(entry.data, true); await drained(); continue; }
    for await (const chunk of createReadStream(entry.file!)) {
      if (res.destroyed) return;
      file.push(new Uint8Array(chunk as Buffer)); await drained();
    }
    file.push(new Uint8Array(0), true);
  }
  zip.end();
}
const statusOf = (e: unknown) => e instanceof ClipError || e instanceof GeminiError || e instanceof ClipToolError || e instanceof HttpError ? (e.status === 499 ? 409 : e.status) : e instanceof ClipInputError ? 400 : 500;
const attachment = (name: string) => `attachment; filename="${name.replace(/[^a-zA-Z0-9._-]/g, '_')}"`;

function responder(res: ServerResponse) {
  return (status: number, data: unknown) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(data)); };
}
function failure(res: ServerResponse, error: unknown) {
  if (res.headersSent) { res.destroy(); return; }
  if (statusOf(error) === 413) res.setHeader('Connection', 'close');
  if (error instanceof ClipError && error.retryAfter) res.setHeader('Retry-After', String(Math.ceil(error.retryAfter)));
  responder(res)(statusOf(error), { error: publicMessage(error) });
}

export async function handleClipApi(service: ClipStudioService, req: IncomingMessage, res: ServerResponse, url: URL, options: ClipApiOptions) {
  const send = responder(res);
  const route = url.pathname.slice('/api/clips'.length).split('/').filter(Boolean), get = req.method === 'GET' || req.method === 'HEAD', post = req.method === 'POST';
  // A write changes what the screens show: answers kept for polling are dropped before it and again after it.
  if (post) service.invalidate();
  try {
    if (!route.length && get) {
      const o = await service.overview({ usage: false });
      return send(200, { tools: o.tools, ai: { gemini: o.gemini.configured, claude: o.claude }, limits: { uploadBytes: (await options.uploadAllowance?.())?.bytes ?? options.maxUploadBytes, maxVideoMinutes: Math.floor(service.maxSeconds / 60), retentionHours: options.retentionHours ?? 0, minutesPerDay: o.minutesPerDay, minutesLeft: o.minutesLeft }, settings: o.settings, sources: o.sources, shorts: o.shorts, jobs: o.jobs });
    }
    if (route[0] === 'settings' && route.length === 1) {
      if (get) return send(200, await service.settings());
      if (post) return send(200, await service.saveSettings(await readJson(req, 16_000)));
    }
    if (route[0] === 'jobs' && route.length >= 2) {
      if (route.length === 2 && get) return send(200, service.job(route[1]));
      if (route[2] === 'cancel' && post) return send(200, service.cancelJob(route[1]));
    }
    if (route[0] === 'sources') {
      if (route.length === 1 && post) {
        const body = await readJson(req, 16_000) as { url?: unknown };
        await options.checkLink(body?.url);
        return send(202, await service.importLink(body));
      }
      if (route[1] === 'upload' && route.length === 2 && post) {
        const room = await options.uploadAllowance?.() ?? { bytes: options.maxUploadBytes, why: 'limit' as const }, allowance = Math.min(options.maxUploadBytes, room.bytes), declared = Number(req.headers['content-length']) || 0;
        const tooBig = () => new ClipError(room.why === 'quota' ? `Your workspace has ${Math.floor(allowance / 1e6)} MB free. Delete a video or reel to make room.` : room.why === 'disk' ? 'The server is nearly full right now. Please try again later.' : `Use a video smaller than ${Math.floor(options.maxUploadBytes / 1e6)} MB.`, room.why === 'disk' ? 503 : 413, room.why === 'disk' ? 300 : undefined);
        if (declared > allowance) throw tooBig();
        const limited = async function* () { let size = 0; for await (const chunk of req) { size += chunk.length; if (size > allowance) throw tooBig(); yield chunk as Buffer; } };
        return send(202, await service.importUpload(url.searchParams.get('file') || '', limited(), declared, { rights: url.searchParams.get('rights'), note: url.searchParams.get('note') ?? '', ...(url.searchParams.has('watch') ? { watch: url.searchParams.get('watch') } : {}) }));
      }
      const id = route[1];
      if (route.length === 2 && get) {
        // Polled by every open studio screen: a 304 while nothing changed, gzip when the browser takes it. `private, no-cache` lets the
        // browser keep the answer and ask again, which `no-store` (the default for this API) would not.
        const detail = await service.sourceDetail(id), zipped = /\bgzip\b/i.test(String(req.headers['accept-encoding'] ?? ''));
        res.setHeader('Cache-Control', 'private, no-cache'); res.setHeader('ETag', detail.etag); res.setHeader('Vary', 'Accept-Encoding');
        if (req.headers['if-none-match'] === detail.etag) { res.statusCode = 304; res.end(); return; }
        const body = zipped ? detail.gzip() : detail.body;
        res.statusCode = 200; res.setHeader('Content-Type', 'application/json'); if (zipped) res.setHeader('Content-Encoding', 'gzip');
        res.setHeader('Content-Length', body.length); res.end(req.method === 'HEAD' ? undefined : body); return;
      }
      if (route[2] === 'moments' && route.length === 3 && post) {
        const body = await readJson(req, 16_000) as { engine?: unknown };
        if (body?.engine !== undefined && body.engine !== 'local') { const allowed = await options.aiAllowed(); if (allowed !== true) throw new HttpError(allowed, 429); }
        return send(200, await service.findMoments(id, body));
      }
      if (route[2] === 'preview' && post) return send(200, await service.previewRange(id, await readJson(req, 4096)));
      if (route[2] === 'media' && route.length === 3 && get) return sendFile(req, res, await service.mediaFile(id), 'video/mp4');
      if (route[2] === 'sections' && route.length === 4 && get) return sendFile(req, res, await service.mediaFile(id, route[3]), 'video/mp4');
      if (route[2] === 'export' && route.length === 3 && get) {
        const zip = await service.exportSource(id);
        res.setHeader('Content-Type', 'application/zip'); res.setHeader('Content-Disposition', attachment(zip.name));
        if (req.method === 'HEAD') { res.end(); return; }
        return streamZip(res, zip.entries);
      }
      if (route[2] === 'retry' && post) return send(202, await service.retrySource(id));
      if (route[2] === 'watch' && post) return send(202, await service.watchSource(id));
      if (route[2] === 'delete' && post) return send(200, await service.deleteSource(id, await readJson(req, 4096)));
    }
    if (route[0] === 'shorts') {
      if (route.length === 1 && post) return send(201, await service.createShort(await readJson(req, 400_000)));
      if (route[1] === 'batch' && route.length === 2 && post) return send(202, await service.batch(await readJson(req, 64_000)));
      const id = route[1];
      if (route.length === 2 && get) { const d = await service.shortDetail(id); return send(200, { ...d, costUsd: undefined, voiceEstimateUsd: undefined }); }
      if (route.length === 2 && post) return send(200, await service.saveShort(id, await readJson(req, 400_000)));
      if (route[2] === 'render' && post) return send(202, await service.render(id, await readJson(req, 4096)));
      if (route[2] === 'delete' && post) return send(200, await service.deleteShort(id));
      if (route[2] === 'video' && get) return sendFile(req, res, await service.outputFile(id, 'video'), 'video/mp4', url.searchParams.has('download') ? `${id}.mp4` : undefined);
      if (route[2] === 'cover' && get) return sendFile(req, res, await service.outputFile(id, 'cover'), 'image/jpeg');
      if (route[2] === 'srt' && get) return sendFile(req, res, await service.outputFile(id, 'srt'), 'application/x-subrip', `${id}.srt`);
      if (route[2] === 'export' && get) {
        const file = await service.exportZip(id);
        res.setHeader('Content-Type', 'application/zip'); res.setHeader('Content-Length', file.data.length); res.setHeader('Content-Disposition', attachment(file.name));
        return res.end(req.method === 'HEAD' ? undefined : file.data);
      }
    }
    return send(404, { error: 'Not found.' });
  } catch (error) { return failure(res, error); }
  finally { if (post) service.invalidate(); }
}

/** The headless tracker page: it reads extracted frames and posts back what it found. Only the page this server opened
 * itself may call it (app.ts checks the loopback address and the per-process key). */
export async function handleTrackerApi(service: ClipStudioService, req: IncomingMessage, res: ServerResponse, url: URL) {
  const send = responder(res);
  const route = url.pathname.slice('/api/clips'.length).split('/').filter(Boolean), get = req.method === 'GET' || req.method === 'HEAD', post = req.method === 'POST';
  try {
    if (route[0] === 'track' && route.length >= 2) {
      if (route.length === 2 && get) return send(200, service.trackJob(route[1]));
      if (route[2] === 'frame' && route.length === 4 && get) { const file = service.trackFrame(route[1], Number(route[3])); return sendFile(req, res, { path: file, size: (await stat(file)).size }, 'image/jpeg'); }
      if (route[2] === 'samples' && post) return send(200, service.trackSamples(route[1], await readJson(req, 4_000_000)));
      if (route[2] === 'finish' && post) return send(200, service.trackFinish(route[1], await readJson(req, 4096)));
    }
    return send(404, { error: 'Not found.' });
  } catch (error) { return failure(res, error); }
}
