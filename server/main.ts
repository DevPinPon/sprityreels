import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './start';
import { parseCapacity } from './scheduler';

/** npm run dev (Vite in the same process, hot reload) and npm start (the built site from dist/). */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try { process.loadEnvFile(path.join(root, '.env')); } catch { /* no .env file */ }
const int = (value: string | undefined, fallback: number) => { const n = Number(value); return Number.isFinite(n) && n > 0 ? n : fallback; };

// More threads for the file system and DNS than Node's default of four: many visitors read many small files.
process.env.UV_THREADPOOL_SIZE ??= '16';
const dev = process.argv.includes('--dev'), host = process.env.HOST ?? '127.0.0.1';
const running = await startServer({
  root, dev, host, port: int(process.env.PORT, 3000),
  app: {
    dataDir: path.resolve(process.env.SPRITYREELS_DATA || path.join(root, '.sprityreels', 'data')),
    maxUploadBytes: int(process.env.SPRITYREELS_MAX_UPLOAD_MB, 1024) * 1e6, aiPerHour: int(process.env.SPRITYREELS_AI_PER_HOUR, 12),
    secureCookies: process.env.SPRITYREELS_SECURE_COOKIES === '1',
    framesDir: process.env.SPRITYREELS_FRAMES_DIR || undefined, picturePass: process.env.SPRITYREELS_PICTURE_PASS === 'always' ? 'always' : 'auto',
    aiUsdPerDay: Number(process.env.SPRITYREELS_AI_USD_PER_DAY) > 0 ? Number(process.env.SPRITYREELS_AI_USD_PER_DAY) : 0, aiUsdPerVisitorPerDay: Number(process.env.SPRITYREELS_AI_USD_PER_VISITOR_DAY) > 0 ? Number(process.env.SPRITYREELS_AI_USD_PER_VISITOR_DAY) : 0,
    operatorKey: process.env.SPRITYREELS_OPERATOR_KEY || undefined,
    capacity: parseCapacity(process.env.SPRITYREELS_CAPACITY), maxBacklog: int(process.env.SPRITYREELS_MAX_BACKLOG, 400), maxActiveJobs: int(process.env.SPRITYREELS_MAX_JOBS, 60),
    maxVideoMinutes: int(process.env.SPRITYREELS_MAX_VIDEO_MIN, 360), retentionHours: Number(process.env.SPRITYREELS_RETENTION_HOURS) > 0 ? Number(process.env.SPRITYREELS_RETENTION_HOURS) : 0,
    maxWorkspaceBytes: int(process.env.SPRITYREELS_MAX_WORKSPACE_MB, 0) * 1e6, minFreeBytes: Number(process.env.SPRITYREELS_MIN_FREE_GB) >= 0 && process.env.SPRITYREELS_MIN_FREE_GB ? Number(process.env.SPRITYREELS_MIN_FREE_GB) * 1e9 : undefined,
    maxMinutesPerDay: int(process.env.SPRITYREELS_MAX_MINUTES_PER_DAY, 0),
    trustedOrigins: (process.env.SPRITYREELS_ORIGINS ?? '').split(',').map(o => o.trim()).filter(Boolean),
  },
});
console.log(`Sprity Reels ${dev ? '(dev) ' : ''}on ${running.url}`);
const stop = () => { void running.close().finally(() => process.exit(0)); setTimeout(() => process.exit(0), 5000).unref(); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
