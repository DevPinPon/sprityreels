import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { createApp } from './app';
import type { AppOptions } from './app';
import { serveStatic } from './static';

// The built page needs no inline script; the tracker page runs MediaPipe's WebAssembly.
const CSP = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self' data:; connect-src 'self' blob: data:; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

export type StartOptions = { root: string; port: number; host?: string; dev?: boolean; app: Omit<AppOptions, 'root' | 'origin'> };
export type Running = { url: string; port: number; app: ReturnType<typeof createApp>; close: () => Promise<void> };

/** The whole website on one port: the API, and either the built site (dist/) or Vite with hot reload (dev). */
export async function startServer(options: StartOptions): Promise<Running> {
  const { root, dev = false, host = '127.0.0.1' } = options;
  let origin = '';
  const app = createApp({ ...options.app, root, origin: () => origin });
  let rest: (req: http.IncomingMessage, res: http.ServerResponse, next: () => void) => unknown = serveStatic(path.join(root, 'dist'));
  const notFound = (res: http.ServerResponse) => { res.statusCode = 404; res.setHeader('Content-Type', 'text/plain; charset=utf-8'); res.end('Not found.'); };
  const server = http.createServer((req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin'); res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    if (!dev) res.setHeader('Content-Security-Policy', CSP);
    void app.handle(req, res, () => void rest(req, res, () => notFound(res)));
  });
  server.requestTimeout = 0; // large uploads can take a long time
  // Longer than a reverse proxy's idle timeout (60 s is the usual), so it is the proxy that closes an idle connection and never a request
  // in flight on one the server just closed. Polling visitors then reuse their connections instead of opening a new one each time.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 70_000;
  let vite: { middlewares: typeof rest; close: () => Promise<void> } | null = null;
  if (dev) {
    const { createServer } = await import('vite');
    vite = await createServer({ root, appType: 'spa', server: { middlewareMode: true, hmr: { server } } });
    rest = vite.middlewares;
  }
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port, host, resolve); });
  const port = (server.address() as AddressInfo).port;
  origin = `http://127.0.0.1:${port}`;
  return {
    url: `http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`, port, app,
    async close() { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await app.dispose(); await vite?.close(); },
  };
}
