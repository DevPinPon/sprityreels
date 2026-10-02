import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, readdir, rm, stat, statfs, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { findBrowser, openHeadless } from './browser';
import { handleClipApi, handleTrackerApi } from './clips/bridge';
import { GeminiClient, GeminiKeys, UsageLedger } from './clips/gemini';
import { ClipStudioService } from './clips/service';
import type { ClipServiceOptions } from './clips/service';
import { resolveClipTools } from './clips/tools';
import type { ClipTools } from './clips/tools';
import { FrameVault } from './evidence';
import { checkLink, linkHosts } from './links';
import { Scheduler, machineCapacity } from './scheduler';
import type { Capacity } from './scheduler';

export type AppOptions = {
  /** The project folder: tools in .sprityreels/tools, caption fonts in public/fonts/clips. */
  root: string;
  /** Where visitors' workspaces are stored (one folder per visitor). */
  dataDir: string;
  /** This server's own loopback address, which the headless tracker page opens. Never taken from a request. */
  origin: () => string;
  /** Largest upload in bytes (default 1 GB). */
  maxUploadBytes?: number;
  /** AI-assisted requests (they spend the operator's AI credit) allowed per visitor per hour (default 12). */
  aiPerHour?: number;
  /** Idle visitors are released from memory after this long (default 30 min); their files stay on disk. */
  idleMs?: number;
  secureCookies?: boolean;
  /** Origins besides the request's own Host that may make changes, for a reverse proxy that rewrites Host. */
  trustedOrigins?: string[];
  linkHosts?: string[];
  resolveHost?: (host: string) => Promise<{ address: string }[]>;
  /** Longest a step may hold frames before the sweep removes them (default 2 hours; SPRITYREELS_FRAME_TTL_MIN). */
  frameTtlMs?: number;
  /** Where working frames live (default <data>/frames). On Linux a RAM disk such as /dev/shm/sprityreels-frames keeps them off the disk. */
  framesDir?: string;
  /** Slots per lane for the whole machine (default: sized from its cores, memory and GPU; see server/scheduler.ts). */
  capacity?: Partial<Capacity>;
  /** Waiting heavy steps after which new work is refused with a 503 (default 400). */
  maxBacklog?: number;
  /** Jobs one visitor may have queued or running (default 60). */
  maxActiveJobs?: number;
  /** Longest video in minutes (default 360). */
  maxVideoMinutes?: number;
  /** 'auto' (default) reads the picture only of videos that can have action picks; 'always' reads every video's. */
  picturePass?: 'auto' | 'always';
  /** Hours after a visitor's last visit when their videos and reels are deleted (default 0: kept until the visitor deletes them). */
  retentionHours?: number;
  /** How often expired workspaces are looked for (default 10 minutes). */
  retentionSweepMs?: number;
  /** Most bytes one visitor may keep stored (default 0: no limit). */
  maxWorkspaceBytes?: number;
  /** Uploads stop while the disk has less than this free (default 2 GB), so a flood of uploads cannot fill it. */
  minFreeBytes?: number;
  /** Minutes of video one visitor may import per UTC day (default 0: no limit). */
  maxMinutesPerDay?: number;
  /** AI spend (list price, USD) after which AI picks pause until tomorrow (UTC): for the whole service, and for one visitor. 0: no limit. */
  aiUsdPerDay?: number;
  aiUsdPerVisitorPerDay?: number;
  /** A secret (at least 16 characters) that opens /api/metrics for monitoring and autoscaling. Without one the endpoint does not exist. */
  operatorKey?: string;
  /** Replaces parts of every visitor's service (tests: tools, transcriber, launcher). */
  service?: Partial<ClipServiceOptions>;
};
export type Next = () => void;
export type App = { /** AI spend of the service so far today, in USD. */ spentToday: () => number; scheduler: Scheduler; /** Deletes the workspaces nobody has used for the retention time; returns how many. */ expire: () => Promise<number>; handle: (req: IncomingMessage, res: ServerResponse, next: Next) => Promise<unknown>; dispose: () => Promise<void>; workspaceCount: () => number; trackerKey: string;
  /** Where every visitor's working frames live; it is empty whenever no reel is being made. */
  frames: FrameVault };
type Workspace = { id: string; service: ClipStudioService; touched: number; ai: number[]; stamped: number };

/** What the AI has cost the whole service today (UTC), kept in a file so a restart does not give the day's budget back. */
class Spend {
  day = ''; total = 0; private timer?: NodeJS.Timeout;
  constructor(private file: string) {}
  static today() { return new Date().toISOString().slice(0, 10); }
  async load() { try { const v = JSON.parse(await readFile(this.file, 'utf8')); if (v.day === Spend.today() && Number.isFinite(v.total)) { this.day = v.day; this.total = v.total; } } catch { /* a first start */ } }
  roll() { if (this.day !== Spend.today()) { this.day = Spend.today(); this.total = 0; } return this.total; }
  add(usd: number) { this.roll(); this.total += usd; this.timer ??= setTimeout(() => { this.timer = undefined; void mkdir(path.dirname(this.file), { recursive: true }).then(() => writeFile(this.file, JSON.stringify({ day: this.day, total: this.total }))).catch(() => {}); }, 2000).unref(); }
}

const COOKIE = 'sr_ws', LOOPBACK = ['127.0.0.1', '::1', '::ffff:127.0.0.1'];
const WORKSPACE_COOKIE = new RegExp(`(?:^|;\\s*)${COOKIE}=([a-f0-9]{32})(?:;|$)`);

/** The website's request layer around the reel service. Every visitor gets a private workspace (a cookie names it), so
 * nobody sees another visitor's videos. The headless tracker page is the only caller of /track and proves itself with a
 * key made when the server starts. */
export function createApp(opts: AppOptions): App {
  const trackerKey = randomBytes(24).toString('hex');
  // One vault for all visitors. Starting it removes whatever frames a crash left behind, before any visitor's work begins, and
  // its sweeper removes frames that outlive their time limit (something hung). dispose() removes everything.
  const frames = opts.service?.frames ?? new FrameVault(opts.framesDir ? path.resolve(opts.framesDir) : path.join(opts.dataDir, 'frames'), { ttlMs: opts.frameTtlMs ?? (Number(process.env.SPRITYREELS_FRAME_TTL_MIN) > 0 ? Number(process.env.SPRITYREELS_FRAME_TTL_MIN) * 60_000 : undefined), onError: message => console.warn(`[sprityreels] ${message}`) });
  void frames.ready().catch(error => console.warn(`[sprityreels] ${error instanceof Error ? error.message : error}`));
  frames.startSweeper();
  // One scheduler for every visitor: the machine's lanes, shared fairly (see server/scheduler.ts).
  const scheduler = opts.service?.scheduler ?? new Scheduler({ ...machineCapacity(), ...opts.capacity }, { maxBacklog: opts.maxBacklog });
  const owners = new Map<string, ClipStudioService>();
  const spend = new Spend(path.join(opts.dataDir, 'spend.json'));
  void spend.load();
  const workspaces = new Map<string, Workspace>();
  const keys = new GeminiKeys(path.join(opts.dataDir, 'keys', 'gemini.json'));
  const resolveTools = opts.service?.tools ?? (() => resolveClipTools(opts.root));
  let toolsCache: { at: number; value: Promise<ClipTools> } | null = null;
  const tools = () => { if (!toolsCache || Date.now() - toolsCache.at > 60_000) toolsCache = { at: Date.now(), value: resolveTools() }; return toolsCache.value; };
  // The GPU and the encoder are known once the tools are found; slots follow (an operator's own numbers always win).
  if (!opts.service?.scheduler) void tools().then(t => scheduler.retune({ ...machineCapacity({ gpu: !!t.whisperGpu, nvenc: t.nvenc }), ...opts.capacity }), () => {});
  const baseLauncher = opts.service?.launcher ?? { find: findBrowser, open: openHeadless };
  const maxUploadBytes = opts.maxUploadBytes ?? 1024e6, aiPerHour = opts.aiPerHour ?? 12, idleMs = opts.idleMs ?? 30 * 60_000, trusted = opts.trustedOrigins ?? [], hosts = opts.linkHosts ?? linkHosts();

  function makeService(id: string) {
    const dir = path.join(opts.dataDir, 'workspaces', id, 'clips');
    const service: ClipStudioService = new ClipStudioService(dir, {
      projectRoot: opts.root, frames, scheduler, maxActiveJobs: opts.maxActiveJobs, maxSourceSeconds: (opts.maxVideoMinutes ?? 360) * 60, maxMinutesPerDay: opts.maxMinutesPerDay, picturePass: opts.picturePass, ...opts.service, tools,
      gemini: opts.service?.gemini ?? new GeminiClient(keys, new UsageLedger(path.join(dir, 'usage.jsonl'), entry => spend.add(entry.usd))),
      launcher: {
        find: baseLauncher.find,
        open: (browser, url) => {
          const job = new URL(url).searchParams.get('job');
          if (job) { owners.set(job, service); setTimeout(() => owners.delete(job), 30 * 60_000).unref(); }
          return baseLauncher.open(browser, `${url}&key=${trackerKey}`);
        },
      },
    });
    service.origin = opts.origin();
    return service;
  }
  function open(id: string) {
    let w = workspaces.get(id);
    if (!w) { w = { id, service: makeService(id), touched: 0, ai: [], stamped: 0 }; workspaces.set(id, w); }
    w.touched = Date.now();
    void stamp(w);
    return w;
  }
  function takeAi(w: Workspace) {
    const since = Date.now() - 3600_000;
    w.ai = w.ai.filter(t => t > since);
    if (w.ai.length >= aiPerHour) return false;
    w.ai.push(Date.now());
    return true;
  }
  /** May this visitor ask for an AI pick now? The budgets are checked first, so a refused request does not use up their hourly allowance. */
  async function aiAllowed(w: Workspace): Promise<true | string> {
    if (opts.aiUsdPerDay && spend.roll() >= opts.aiUsdPerDay) return 'AI picks are paused for today. The automatic picks still work, and AI picks are back tomorrow.';
    if (opts.aiUsdPerVisitorPerDay) {
      const start = Date.parse(`${Spend.today()}T00:00:00Z`), used = (await w.service.gemini.ledger.entries()).filter(e => e.t >= start).reduce((sum, e) => sum + e.usd, 0);
      if (used >= opts.aiUsdPerVisitorPerDay) return 'You have used today’s AI picks. The automatic picks still work, and AI picks are back tomorrow.';
    }
    return takeAi(w) ? true : 'AI picks are limited for now. Try again in a little while, or use the automatic picks.';
  }
  const busy = (w: Workspace) => w.service.jobList().some(j => j.status === 'queued' || j.status === 'running');
  // ---- how long a visitor's files are kept, and how much of the disk one visitor may use
  const workspacesDir = path.join(opts.dataDir, 'workspaces'), retentionMs = Math.max(0, opts.retentionHours ?? 0) * 3600_000, quota = Math.max(0, opts.maxWorkspaceBytes ?? 0);
  const activeFile = (id: string) => path.join(workspacesDir, id, '.active');
  /** The last visit is written to the workspace at most once a minute (the file's modified time is the clock). */
  async function stamp(w: Workspace) {
    if (Date.now() - w.stamped < 60_000) return;
    w.stamped = Date.now();
    await mkdir(path.join(workspacesDir, w.id), { recursive: true }).then(() => writeFile(activeFile(w.id), String(w.stamped))).catch(() => {});
  }
  async function expire() {
    if (!retentionMs) return 0;
    let removed = 0;
    for (const id of await readdir(workspacesDir).catch(() => [] as string[])) {
      if (!/^[a-f0-9]{32}$/.test(id)) continue;
      const w = workspaces.get(id);
      if (w && (busy(w) || Date.now() - w.touched < retentionMs)) continue;
      const seen = (await stat(activeFile(id)).catch(() => stat(path.join(workspacesDir, id)).catch(() => null)))?.mtimeMs;
      if (seen === undefined || Date.now() - seen < retentionMs) continue;
      if (w) { workspaces.delete(id); await w.service.dispose(); }
      sizes.delete(id);
      await rm(path.join(workspacesDir, id), { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }).then(() => { removed++; }, () => {});
    }
    return removed;
  }
  const expirer = retentionMs ? setInterval(() => { void expire().catch(() => {}); }, opts.retentionSweepMs ?? 10 * 60_000) : undefined;
  expirer?.unref();
  if (retentionMs) setTimeout(() => { void expire().catch(() => {}); }, 5000).unref();
  const sizes = new Map<string, { at: number; bytes: number }>();
  async function usedBytes(id: string) {
    const known = sizes.get(id);
    if (known && Date.now() - known.at < 15_000) return known.bytes;
    let bytes = 0;
    const walk = async (dir: string) => { for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) { const file = path.join(dir, entry.name); if (entry.isDirectory()) await walk(file); else bytes += (await stat(file).catch(() => null))?.size ?? 0; } };
    await walk(path.join(workspacesDir, id));
    sizes.set(id, { at: Date.now(), bytes });
    return bytes;
  }
  const reserve = Math.max(0, opts.minFreeBytes ?? 2e9);
  let free = { at: 0, bytes: Infinity };
  /** Free space on the data disk, looked up at most every ten seconds. */
  async function freeBytes() {
    if (Date.now() - free.at < 10_000) return free.bytes;
    await mkdir(opts.dataDir, { recursive: true }).catch(() => {});
    const info = await statfs(opts.dataDir).catch(() => null);
    free = { at: Date.now(), bytes: info ? info.bavail * info.bsize : Infinity };
    return free.bytes;
  }
  /** What this visitor may upload now: the upload limit, or what is left of their share, or what the disk can spare (and which of the three it is). */
  async function allowance(id: string) {
    let bytes = maxUploadBytes, why: 'limit' | 'quota' | 'disk' = 'limit';
    if (quota) { const left = Math.max(0, quota - await usedBytes(id)); if (left < bytes) { bytes = left; why = 'quota'; } }
    const room = Math.max(0, await freeBytes() - reserve);
    if (room < bytes) { bytes = room; why = 'disk'; }
    return { bytes, why };
  }

  const sweeper = setInterval(() => {
    for (const [id, w] of workspaces) if (Date.now() - w.touched > idleMs && !busy(w)) { workspaces.delete(id); void w.service.dispose(); }
  }, 60_000);
  sweeper.unref();

  const sameOrigin = (req: IncomingMessage) => {
    const host = req.headers.host ?? '', origin = req.headers.origin;
    if (origin && origin !== `http://${host}` && origin !== `https://${host}` && !trusted.includes(origin)) return false;
    const site = req.headers['sec-fetch-site'];
    return !site || site === 'same-origin' || site === 'none';
  };
  const trackerAllowed = (req: IncomingMessage) => {
    if (!LOOPBACK.includes(req.socket.remoteAddress ?? '')) return false;
    const given = Buffer.from(String(req.headers['x-tracker-key'] ?? '')), wanted = Buffer.from(trackerKey);
    return given.length === wanted.length && timingSafeEqual(given, wanted);
  };

  async function handle(req: IncomingMessage, res: ServerResponse, next: Next) {
    const url = new URL(req.url || '/', 'http://localhost');
    const reply = (status: number, data: unknown) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(data)); };
    if (url.pathname === '/api/health') return reply(200, { ok: true });
    if (url.pathname === '/api/metrics') {
      // For monitoring and autoscaling. It exists only when the operator set a key, and always needs it: behind a reverse proxy every
      // request comes from the proxy's own address, so "from this computer" would prove nothing.
      const key = opts.operatorKey && opts.operatorKey.length >= 16 ? Buffer.from(opts.operatorKey) : null;
      const given = Buffer.from(String(req.headers['x-operator-key'] ?? '').trim() || /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ''))?.[1] || '');
      if (!key) return reply(404, { error: 'Not found.' });
      if (given.length !== key.length || !timingSafeEqual(given, key)) return reply(401, { error: 'Not allowed.' });
      const s = scheduler.stats(), lines: string[] = [];
      const gauge = (name: string, help: string, value: number, labels = '') => { if (!lines.includes(`# TYPE ${name} gauge`)) lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`); lines.push(`${name}${labels} ${Number.isFinite(value) ? value : 0}`); };
      for (const [lane, v] of Object.entries(s.lanes)) { gauge('sprityreels_lane_capacity', 'Slots in a lane.', v.capacity, `{lane="${lane}"}`); gauge('sprityreels_lane_running', 'Steps running in a lane.', v.running, `{lane="${lane}"}`); gauge('sprityreels_lane_waiting', 'Steps waiting for a slot in a lane.', v.queued, `{lane="${lane}"}`); }
      gauge('sprityreels_backlog', 'Steps waiting in the heavy lanes (the number to scale on).', s.backlog);
      gauge('sprityreels_workspaces_loaded', 'Visitors whose studio is in memory.', workspaces.size);
      gauge('sprityreels_frame_leases', 'Folders of working frames in use.', frames.size);
      gauge('sprityreels_ai_spend_usd_today', 'AI spend today (UTC), list price.', spend.roll());
      gauge('sprityreels_process_rss_bytes', 'Resident memory of the server.', process.memoryUsage().rss);
      res.statusCode = 200; res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8'); res.setHeader('Cache-Control', 'no-store'); res.end(lines.join('\n') + '\n'); return;
    }
    if (!url.pathname.startsWith('/api/clips')) return next();
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    if (!['GET', 'HEAD', 'POST'].includes(req.method ?? '')) return reply(405, { error: 'Unsupported method.' });
    if (req.method === 'POST' && req.headers['x-sprityreels-request'] !== 'clips') return reply(403, { error: 'Use the Sprity Reels website to make changes.' });
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[2] === 'track') {
      if (!trackerAllowed(req)) return reply(403, { error: 'Not allowed.' });
      const owner = owners.get(parts[3] ?? '');
      if (!owner) return reply(404, { error: 'This tracking job is not running.' });
      return handleTrackerApi(owner, req, res, url);
    }
    if (!sameOrigin(req)) return reply(403, { error: 'Open Sprity Reels directly in your browser.' });
    let id = WORKSPACE_COOKIE.exec(req.headers.cookie ?? '')?.[1] ?? null;
    if (!id) {
      id = randomBytes(16).toString('hex');
      const secure = opts.secureCookies || (req.socket as { encrypted?: boolean }).encrypted || req.headers['x-forwarded-proto'] === 'https';
      res.setHeader('Set-Cookie', `${COOKIE}=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${secure ? '; Secure' : ''}`);
    }
    const w = open(id);
    // A write changes what the visitor has stored: the size is counted again after it, not from before.
    if (req.method === 'POST') sizes.delete(id);
    await handleClipApi(w.service, req, res, url, { maxUploadBytes, uploadAllowance: () => allowance(w.id), retentionHours: opts.retentionHours ?? 0, aiAllowed: () => aiAllowed(w), checkLink: link => checkLink(link, { hosts, resolve: opts.resolveHost }) });
    if (req.method === 'POST') sizes.delete(id);
  }

  return {
    handle, trackerKey, frames, scheduler, expire, spentToday: () => spend.roll(), workspaceCount: () => workspaces.size,
    async dispose() { clearInterval(sweeper); if (expirer) clearInterval(expirer); await Promise.all([...workspaces.values()].map(w => w.service.dispose())); workspaces.clear(); await frames.close(); },
  };
}
