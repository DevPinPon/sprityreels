import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf',
  '.wasm': 'application/wasm', '.txt': 'text/plain; charset=utf-8', '.map': 'application/json', '.task': 'application/octet-stream', '.tflite': 'application/octet-stream',
};

/** Text files the build compresses ahead of time (scripts/precompress.mjs): the server sends the .br or .gz copy as it is. */
const PACKED = new Set(['.html', '.js', '.mjs', '.css', '.svg', '.json', '.txt']);
function accepts(header: string, name: string) {
  for (const part of header.split(',')) {
    const [token, ...params] = part.trim().split(';');
    if (token.trim().toLowerCase() !== name) continue;
    const q = params.map(p => /^\s*q=([\d.]+)/i.exec(p)?.[1]).find(Boolean);
    return q === undefined || Number(q) > 0;
  }
  return false;
}

/** Serves the built site from `dir`. Page routes such as /app fall back to index.html; a missing file with an extension is a 404. */
export function serveStatic(dir: string) {
  const root = path.resolve(dir);
  return async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    let rel: string;
    try { rel = decodeURIComponent(new URL(req.url || '/', 'http://localhost').pathname); } catch { res.statusCode = 400; res.end(); return; }
    if (rel.includes('\0')) { res.statusCode = 400; res.end(); return; }
    let file = path.join(root, rel);
    if (file !== root && !file.startsWith(root + path.sep)) { res.statusCode = 403; res.end(); return; }
    let info = await stat(file).catch(() => null);
    if (info?.isDirectory()) { file = path.join(file, 'index.html'); info = await stat(file).catch(() => null); }
    if (!info?.isFile()) {
      if (path.extname(rel)) { res.statusCode = 404; res.setHeader('Content-Type', 'text/plain; charset=utf-8'); res.end('Not found.'); return; }
      file = path.join(root, 'index.html'); info = await stat(file).catch(() => null);
      if (!info?.isFile()) return next();
    }
    const ext = path.extname(file).toLowerCase();
    let size = info.size, sendFrom = file;
    if (PACKED.has(ext)) {
      res.setHeader('Vary', 'Accept-Encoding');
      const header = String(req.headers['accept-encoding'] ?? '');
      for (const [encoding, suffix] of [['br', '.br'], ['gzip', '.gz']] as const) {
        if (!accepts(header, encoding)) continue;
        const packed = await stat(file + suffix).catch(() => null);
        if (packed?.isFile()) { res.setHeader('Content-Encoding', encoding); size = packed.size; sendFrom = file + suffix; break; }
      }
    }
    res.statusCode = 200;
    res.setHeader('Content-Type', TYPES[ext] ?? 'application/octet-stream'); res.setHeader('Content-Length', size);
    res.setHeader('Cache-Control', rel.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : ext === '.html' ? 'no-cache' : ['.task', '.tflite', '.wasm', '.ttf', '.woff2'].includes(ext) ? 'public, max-age=86400' : 'public, max-age=300');
    if (req.method === 'HEAD') { res.end(); return; }
    const stream = createReadStream(sendFrom); stream.on('error', () => res.destroy()); res.on('close', () => stream.destroy()); stream.pipe(res);
  };
}
