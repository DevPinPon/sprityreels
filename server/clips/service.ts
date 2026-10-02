import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import { gzipSync } from 'node:zlib';
import { createWriteStream } from 'node:fs';
import { appendFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { finished } from 'node:stream/promises';
import { strToU8, zipSync } from 'fflate';
import type { ClipAIEngine, ClipDefaults, ClipEngine, ClipGenre, ClipJob, ClipJobKind, ClipMoment, ClipMomentSet, ClipQuality, ClipReaction, ClipRender, ClipRights, ClipScriptStyle, ClipSegment, ClipShort, ClipSource, ClipStage, ClipStageId, ClipTranscript, ClipWord } from '../../src/engine/clips/types';
import { CLIP_AI_ENGINES, CLIP_ASPECTS, CLIP_GENRES, CLIP_LIMITS, CLIP_QUALITY, CLIP_RIGHTS, ClipInputError, DEFAULT_CLIP_SETTINGS, ID, SCRIPT_STYLES, TTS_VOICES, applyShortPatch, cleanText, estimateShortSeconds, newShort, segmentId, validateDefaults, validateSegments, validateSourceUrl } from '../../src/engine/clips/types';
import { alignEnvelope, makeTranscript, reactionsFromJson3, validateTranscript, wordsFromJson3, wordsFromWhisper, transcriptLines, speechThreshold, silentRuns } from '../../src/engine/clips/transcript';
import type { MomentContext, MomentOptions } from '../../src/engine/clips/moments';
import { MOMENT_INSTRUCTIONS, MOMENT_SCHEMA, actionList, buildMomentPrompt, localMoments, momentPromptParts, normalizeMoments, parseMomentReply, wantsAction } from '../../src/engine/clips/moments';
import { visualPeaks } from '../../src/engine/clips/signals';
import { buildTimeline } from '../../src/engine/clips/timeline';
import { buildAss, buildSrt } from '../../src/engine/clips/captions';
import type { FaceSample, FaceTrackFile } from '../../src/engine/clips/reframe';
import { captionStage, parseSceneScores, planCamera, sceneCuts } from '../../src/engine/clips/reframe';
import { OBJECT_KINDS } from '../../src/engine/clips/subjects';
import { SCRIPT_INSTRUCTIONS, SCRIPT_SCHEMA, buildScriptPrompt, parseScriptReply, templateScript } from '../../src/engine/clips/script';
import { estimateSpeechCost, estimateTextCost } from '../../src/engine/clips/pricing';
import type { ClipTools, LinkInfo } from './tools';
import { ClipToolError, downloadAudio, downloadCaptions, downloadProxy, downloadVideo, extractWav, linkError, probeLink, probeMedia, resolveClipTools, run, transcribe, visualActivity, wavEnvelope } from './tools';
import { clock, contactSheet, grabFrames, tileSize } from './frames';
import { GeminiClient, GeminiError, GeminiKeys, UsageLedger } from './gemini';
import type { MediaSpan } from './render';
import { coverFrame, renderShort } from './render';
import { fontMeasurer } from './fonts';
import type { BrowserRun } from '../browser';
import { findBrowser, openHeadless } from '../browser';
import type { DirectorImage, TextDirector } from '../directors';
import { DirectorUnavailableError, defaultDirectors } from '../directors';
import { Busy, Cancelled, SOLO_CAPACITY, Scheduler } from '../scheduler';
import type { Lane } from '../scheduler';
import type { Evidence } from '../evidence';
import { FrameVault, buildEvidence, evidenceStoryboard, validEvidence } from '../evidence';

/** A JSON answer made once: its bytes, a validator and (when a client asks) its gzip form. */
export type Answer = { body: Buffer; etag: string; gzip: () => Buffer };
function answer(value: unknown): Answer {
  const body = Buffer.from(JSON.stringify(value));
  let packed: Buffer | undefined;
  return { body, etag: `"${createHash('sha1').update(body).digest('base64url').slice(0, 22)}"`, gzip: () => packed ??= gzipSync(body, { level: 6 }) };
}

export class ClipError extends Error { constructor(message: string, readonly status = 400, /** Seconds to wait before trying again (503 and 429). */ readonly retryAfter?: number) { super(message); } }
type Launcher = { find: () => Promise<string | null>; open: (browser: string, url: string) => Promise<BrowserRun> };
const VIDEO_EXT = ['.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi'];
type Section = MediaSpan & { id: string; bytes: number; created: number };
/** Contact sheets for a vision model: files in a vault lease or bytes in memory. discard() deletes the files / drops the bytes. */
type Sheets = { files?: string[]; data?: DirectorImage[]; note: string; count: number; discard: () => Promise<void> };
type TrackRun = { id: string; frames: { n: number; t: number; file: string }[]; width: number; height: number; samples: FaceSample[]; delegate: 'GPU' | 'CPU' | 'none'; done: number; objects: boolean;
  resolve: (ok: boolean, error?: string) => void; timer: ReturnType<typeof setTimeout>; run: BrowserRun | null };
export type ClipServiceOptions = {
  projectRoot: string; tools?: () => Promise<ClipTools>; gemini?: GeminiClient; directors?: Partial<Record<'codex' | 'claude', TextDirector>>;
  launcher?: Launcher; allowLocalUrls?: boolean;
  /** Where working frames live while a step needs them (see server/evidence/vault.ts). The website shares one vault between
   * its visitors; a studio without one gets its own folder. */
  frames?: FrameVault;
  /** The lanes all studios share (the website passes one for the whole machine). A studio without one has the machine to itself. */
  scheduler?: Scheduler;
  /** Jobs one visitor may have queued or running at once (default 60). */
  maxActiveJobs?: number;
  /** Longest video in seconds (default the engine's six hours). */
  maxSourceSeconds?: number;
  /** Minutes of video one visitor may import per UTC day (default 0: no limit). */
  maxMinutesPerDay?: number;
  /** 'auto' (default): the picture pass runs only for videos that can have action picks; 'always': for every video. */
  picturePass?: 'auto' | 'always';
  /** How long a studio screen's data is reused for the visitors' polling (default 750 ms; writes clear it). */
  cacheMs?: number;
  /** Test hook: replaces whisper (receives a 16 kHz WAV, returns words). */
  transcriber?: (wav: string, language: string, signal?: AbortSignal) => Promise<{ words: ClipWord[]; language: string; model: string }>;
};

async function writeJson(file: string, value: unknown) { const temp = `${file}.${randomUUID()}.tmp`; await mkdir(path.dirname(file), { recursive: true }); try { await writeFile(temp, JSON.stringify(value, null, 1)); await rename(temp, file); } finally { await rm(temp, { force: true }); } }
async function readJson<T>(file: string): Promise<T | null> { try { return JSON.parse(await readFile(file, 'utf8')) as T; } catch { return null; } }
const exists = (file: string) => stat(file).then(() => true, () => false);
const stage = (status: ClipStage['status'] = 'pending', message = ''): ClipStage => ({ status, progress: status === 'done' ? 1 : 0, message });
const siteLabel = (site: string | null) => site ? ({ youtube: 'YouTube', tiktok: 'TikTok', twitch: 'Twitch', vimeo: 'Vimeo', instagram: 'Instagram', twitter: 'X', kick: 'Kick', rumble: 'Rumble', facebook: 'Facebook' } as Record<string, string>)[site.toLowerCase().replace(/:.*/, '')] ?? site : null;
const fileSafe = (name: string, fallback: string) => name.replace(/[^\p{L}\p{N} _-]+/gu, '').trim().replace(/\s+/g, '-').slice(0, 60) || fallback;
const keyOf = (value: unknown) => createHash('sha1').update(JSON.stringify(value)).digest('hex').slice(0, 20);

export class ClipStudioService {
  readonly root: string;
  readonly gemini: GeminiClient;
  readonly vault: FrameVault;
  private ownFrames: boolean;
  private toolsCache?: { at: number; value: Promise<ClipTools> };
  private jobs = new Map<string, ClipJob & { abort?: AbortController }>();
  readonly scheduler: Scheduler;
  private jobContext = new AsyncLocalStorage<ClipJob>();
  /** Every short of this visitor with its render, kept in memory and updated by the writes below: a screen refreshed every second
   * would otherwise read two files per short each time. */
  private shortsIndex?: Map<string, { short: ClipShort; render: ClipRender | null }>;
  private shortsLoading?: Promise<Map<string, { short: ClipShort; render: ClipRender | null }>>;
  private setsMemo = new Map<string, ClipMomentSet[]>();
  private reactionsMemo = new Map<string, ClipReaction[]>();
  private writes = new Map<string, Promise<unknown>>();
  private transcripts = new Map<string, ClipTranscript>();
  private energies = new Map<string, Uint8Array>();
  private visuals = new Map<string, Uint8Array>();
  private sectionsInflight = new Map<string, Promise<Section>>();
  private trackRuns = new Map<string, TrackRun>();
  private directors: Partial<Record<'codex' | 'claude', TextDirector>>;
  private launcher: Launcher;
  private initialized?: Promise<void>;
  /** The studio's own origin (from the latest local request), used to open the headless tracking page. */
  origin = 'http://127.0.0.1:5173';

  constructor(root: string, private options: ClipServiceOptions) {
    this.root = root;
    this.gemini = options.gemini ?? new GeminiClient(new GeminiKeys(path.join(options.projectRoot, '.sprityreels', 'keys', 'gemini.json')), new UsageLedger(path.join(root, 'usage.jsonl')));
    this.directors = options.directors ?? defaultDirectors();
    this.ownFrames = !options.frames;
    this.scheduler = options.scheduler ?? new Scheduler(SOLO_CAPACITY);
    this.vault = options.frames ?? new FrameVault(path.join(root, 'frames'));
    this.launcher = options.launcher ?? { find: findBrowser, open: openHeadless };
  }

  // ------------------------------------------------------------------ plumbing
  private init() {
    return this.initialized ??= (async () => {
      await mkdir(path.join(this.root, 'sources'), { recursive: true }); await mkdir(path.join(this.root, 'shorts'), { recursive: true });
      // Working frames live only in the vault. Frame folders an earlier version (or a crash) left in the studio are removed.
      await this.vault.ready();
      for (const old of ['sheets', 'frames']) await rm(path.join(this.root, 'ai-workspace', old), { recursive: true, force: true }).catch(() => {});
      for (const id of (await readdir(path.join(this.root, 'sources')).catch(() => [] as string[])).filter(x => ID.test(x))) {
        for (const entry of await readdir(path.join(this.root, 'sources', id, 'tracks')).catch(() => [] as string[])) if (entry.endsWith('-frames')) await rm(path.join(this.root, 'sources', id, 'tracks', entry), { recursive: true, force: true }).catch(() => {});
      }
      // Work that was running when the studio stopped is marked so it can be retried instead of looking stuck.
      for (const src of await this.listSources()) if (src.status === 'working') await this.updateSource(src.id, s => { s.status = 'failed'; s.error = 'Interrupted when the server restarted. Press Retry to continue.'; for (const st of Object.values(s.stages)) if (st.status === 'running') st.status = 'failed'; });
      for (const id of await this.shortIds()) {
        const r = await readJson<ClipRender>(path.join(this.shortDir(id), 'render.json'));
        if (r && (r.status === 'queued' || r.status === 'rendering')) await writeJson(path.join(this.shortDir(id), 'render.json'), { ...r, status: 'failed', error: 'Interrupted when the server restarted. Render again.' });
      }
    })();
  }
  tools(force = false) {
    if (force || !this.toolsCache || Date.now() - this.toolsCache.at > 60_000) this.toolsCache = { at: Date.now(), value: (this.options.tools ?? (() => resolveClipTools(this.options.projectRoot)))() };
    return this.toolsCache.value;
  }
  /** A step that needs a worker: it waits its fair turn in the machine's shared lane, and the job it belongs to shows where it is
   * in the line. */
  private async lane<T>(lane: Lane, signal: AbortSignal | undefined, fn: () => Promise<T>): Promise<T> {
    const job = this.jobContext.getStore();
    const onQueue = job ? (ahead: number | null) => { job.queue = ahead === null ? null : { lane, ahead }; job.updated = Date.now(); } : undefined;
    try { return await this.scheduler.run(lane, this.root, signal, fn, onQueue); }
    catch (error) {
      if (error instanceof Busy) throw new ClipError(error.message, 503, error.retryAfter);
      if (error instanceof Cancelled) throw new ClipError('Cancelled.', 499);
      throw error;
    }
  }
  /** Speech recognition on a CPU shares the cores between the runs the machine allows at once (one by default: all cores). */
  private whisperThreads(tools: ClipTools) { return tools.whisperGpu ? 4 : Math.max(2, Math.min(16, Math.floor((os.availableParallelism?.() ?? os.cpus().length) / this.scheduler.capacity.gpu))); }
  /** Minutes of video this visitor has imported today (UTC) and what is left of their daily allowance (null: no limit). Counting video
   * minutes is the most direct cost control there is: transcription, the picture pass and storage all grow with them. */
  async minutesToday() {
    const limit = (this.options.maxMinutesPerDay ?? 0) * 60;
    const start = Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
    const entries = (await readFile(path.join(this.root, 'imports.jsonl'), 'utf8').catch(() => '')).split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line) as { t: number; id: string; seconds: number }]; } catch { return []; } }).filter(e => e.t >= start);
    const used = entries.reduce((sum, e) => sum + e.seconds, 0);
    return { entries, used, left: limit ? Math.max(0, limit - used) : null, limit };
  }
  /** Refuses a new video before anything is stored when today's allowance is already used up. */
  private async noMinutesLeft() { if (this.options.maxMinutesPerDay && (await this.minutesToday()).left === 0) throw new ClipError(`You have used today’s ${this.options.maxMinutesPerDay} minute${this.options.maxMinutesPerDay === 1 ? '' : 's'} of video. It starts again at midnight UTC.`, 429); }
  /** Counts a video against today's allowance. A retry of the same video is not counted twice. */
  private spendMinutes(id: string, seconds: number) {
    if (!this.options.maxMinutesPerDay) return Promise.resolve();
    return this.serial('minutes', async () => {
      const today = await this.minutesToday();
      if (today.entries.some(e => e.id === id)) return;
      if (today.used + seconds > today.limit) throw new ClipError(`This site takes ${this.options.maxMinutesPerDay} minute${this.options.maxMinutesPerDay === 1 ? '' : 's'} of video per visitor a day, and you have ${Math.floor((today.left ?? 0) / 60)} left today. It starts again at midnight UTC.`, 429);
      await appendFile(path.join(this.root, 'imports.jsonl'), `${JSON.stringify({ t: Date.now(), id, seconds: Math.round(seconds) })}\n`);
    });
  }
  /** The longest video this studio takes, in seconds. */
  get maxSeconds() { return this.options.maxSourceSeconds ?? CLIP_LIMITS.sourceSeconds; }
  private lengthMessage() { const m = Math.floor(this.maxSeconds / 60); return m >= 120 && m % 60 === 0 ? `Use videos up to ${m / 60} hours.` : `Use videos up to ${m} minutes.`; }
  /** Throws a 503 or 429 (with Retry-After) when new work should not start: the machine's backlog is full, or this visitor has
   * too much in progress. Called before anything is stored for the new work. */
  admit(extra = 1) {
    try { this.scheduler.admit(extra); } catch (error) { throw error instanceof Busy ? new ClipError(error.message, 503, error.retryAfter) : error; }
    const active = [...this.jobs.values()].filter(j => j.status === 'queued' || j.status === 'running').length;
    if (active + extra > (this.options.maxActiveJobs ?? 60)) throw new ClipError('You have a lot of work in progress. Let some of it finish first.', 429, 30);
  }
  private serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const task = (this.writes.get(key) ?? Promise.resolve()).catch(() => {}).then(fn);
    this.writes.set(key, task); return task;
  }
  private startJob(kind: ClipJobKind, refs: { sourceId?: string | null; shortId?: string | null }, fn: (job: ClipJob, signal: AbortSignal, progress: (fraction: number, stage?: string, message?: string) => void) => Promise<unknown>): ClipJob {
    if (kind === 'import' || kind === 'render') this.admit();
    const now = Date.now(), abort = new AbortController();
    const job: ClipJob & { abort?: AbortController } = { id: randomUUID(), kind, sourceId: refs.sourceId ?? null, shortId: refs.shortId ?? null, status: 'queued', stage: '', progress: 0, message: '', error: null, created: now, updated: now, abort };
    this.jobs.set(job.id, job);
    if (this.jobs.size > 300) for (const [id, j] of this.jobs) { if (this.jobs.size <= 250) break; if (j.status !== 'queued' && j.status !== 'running') this.jobs.delete(id); }
    const progress = (fraction: number, stageName?: string, message?: string) => { job.progress = Math.max(0, Math.min(1, fraction)); if (stageName !== undefined) job.stage = stageName; if (message !== undefined) job.message = message; job.updated = Date.now(); };
    void (async () => {
      job.status = 'running'; job.updated = Date.now();
      // Whatever frames the job still holds are deleted before it reports that it finished (or failed, or was cancelled).
      try { job.result = await this.jobContext.run(job, () => fn(job, abort.signal, progress)).finally(() => this.vault.purge({ scope: this.root, jobId: job.id })); job.status = 'done'; job.progress = 1; }
      catch (error) { job.status = abort.signal.aborted ? 'cancelled' : 'failed'; job.error = abort.signal.aborted ? 'Cancelled.' : publicMessage(error); }
      finally { job.updated = Date.now(); job.queue = null; delete job.abort; }
    })();
    return this.publicJob(job);
  }
  private publicJob(job: ClipJob & { abort?: unknown }): ClipJob { const copy = { ...job }; delete copy.abort; return structuredClone(copy); }
  job(id: string) { const j = this.jobs.get(id); if (!j) throw new ClipError('This job is not known (it may have finished before Sprity Reels restarted).', 404); return this.publicJob(j); }
  jobList(filter: { sourceId?: string; shortId?: string } = {}) {
    return [...this.jobs.values()].filter(j => (!filter.sourceId || j.sourceId === filter.sourceId) && (!filter.shortId || j.shortId === filter.shortId)).sort((a, b) => b.created - a.created).slice(0, 60).map(j => this.publicJob(j));
  }
  cancelJob(id: string) { const j = this.jobs.get(id); if (!j) throw new ClipError('This job is not known.', 404); j.abort?.abort(); return this.publicJob(j); }

  // ------------------------------------------------------------------ settings & status
  private sourceDir(id: string) { if (!ID.test(id)) throw new ClipError('Unknown source.', 404); return path.join(this.root, 'sources', id); }
  private shortDir(id: string) { if (!ID.test(id)) throw new ClipError('Unknown short.', 404); return path.join(this.root, 'shorts', id); }
  async settings(): Promise<ClipDefaults> {
    const saved = await readJson<unknown>(path.join(this.root, 'settings.json'));
    try { return saved ? validateDefaults(saved) : structuredClone(DEFAULT_CLIP_SETTINGS); } catch { return structuredClone(DEFAULT_CLIP_SETTINGS); }
  }
  async saveSettings(body: unknown) { const next = validateDefaults(body, await this.settings()); await writeJson(path.join(this.root, 'settings.json'), next); return next; }
  /** usage: false skips reading the usage ledger, which grows with every AI call (the website never shows it). */
  async overview(options: { usage?: boolean } = {}) {
    await this.init();
    const [tools, gemini, settings, sources, shorts, usage, browser] = await Promise.all([this.tools(), this.gemini.keys.status(), this.settings(), this.listSources(), this.listShorts(), options.usage === false ? Promise.resolve(null) : this.gemini.ledger.summary(), this.browser()]);
    const claude = await this.directors.claude?.status().then(s => s.available, () => false) ?? false;
    const minutes = await this.minutesToday();
    return {
      claude, minutesPerDay: this.options.maxMinutesPerDay ?? 0, minutesLeft: minutes.left === null ? null : Math.floor(minutes.left / 60),
      tools: { linkImport: !!tools.ytdlp, transcription: tools.whisper && tools.whisperModel ? (tools.whisperGpu ? 'gpu' : 'cpu') : null, ffmpeg: tools.ffmpeg, encoder: tools.nvenc ? 'nvenc' : tools.ffmpeg ? 'x264' : null, faceTracking: !!browser, fonts: await exists(tools.fonts) },
      gemini, settings, usage, sources, shorts, jobs: this.jobList().filter(j => j.status === 'queued' || j.status === 'running' || Date.now() - j.updated < 120_000),
    };
  }

  private browserCache?: { at: number; value: Promise<string | null> };
  /** Where the tracker's browser is (looked up at most once a minute: it only changes when someone installs one). */
  private browser() { if (!this.browserCache || Date.now() - this.browserCache.at > 60_000) this.browserCache = { at: Date.now(), value: this.launcher.find() }; return this.browserCache.value; }
  private details = new Map<string, { at: number; value: Promise<Answer> }>();
  /** What the studio shows for one video, already serialized, with a validator (the browser gets a 304 while nothing changed) and a
   * gzip copy made once. Many visitors poll it every second or so, so an answer is reused for a moment (and for everyone asking at
   * the same time). Writes call invalidate(). */
  sourceDetail(id: string): Promise<Answer> {
    const hit = this.details.get(id);
    if (hit && Date.now() - hit.at < (this.options.cacheMs ?? 750)) return hit.value;
    const value = (async () => answer({ source: await this.getSource(id), moments: await this.momentSets(id), shorts: await this.listShorts(id), jobs: this.jobList({ sourceId: id }), reactions: await this.reactions(id) }))();
    this.details.set(id, { at: Date.now(), value });
    value.catch(() => { if (this.details.get(id)?.value === value) this.details.delete(id); });
    if (this.details.size > 50) for (const key of this.details.keys()) { if (this.details.size <= 40) break; this.details.delete(key); }
    return value;
  }
  /** Forget reused answers: something changed. */
  invalidate() { this.details.clear(); }

  // ------------------------------------------------------------------ sources
  async listSources(): Promise<ClipSource[]> {
    const ids = (await readdir(path.join(this.root, 'sources')).catch(() => [] as string[])).filter(id => ID.test(id));
    const all = await Promise.all(ids.map(id => readJson<ClipSource>(path.join(this.root, 'sources', id, 'source.json'))));
    return all.filter((s): s is ClipSource => !!s && s.format === 'sprityreels-clip-source').sort((a, b) => b.created - a.created);
  }
  async getSource(id: string) {
    const s = await readJson<ClipSource>(path.join(this.sourceDir(id), 'source.json'));
    if (!s || s.id !== id) throw new ClipError('This source was not found.', 404);
    return s;
  }
  private updateSource(id: string, change: (s: ClipSource) => void | Promise<void>) {
    return this.serial(`source:${id}`, async () => {
      const s = await this.getSource(id);
      await change(s); s.revision++; s.updated = Date.now();
      await writeJson(path.join(this.sourceDir(id), 'source.json'), s);
      return s;
    });
  }
  private newSource(fields: { kind: 'link' | 'upload'; title: string; url: string | null; rights: ClipRights; note: string; quality: ClipQuality; watch: boolean }): ClipSource {
    const now = Date.now();
    return { format: 'sprityreels-clip-source', version: 1, id: randomUUID(), revision: 1, created: now, updated: now, kind: fields.kind, title: fields.title, url: fields.url, site: null, videoId: null,
      creator: null, license: null, language: null, duration: 0, width: 0, height: 0, fps: 0, quality: fields.quality, rights: { basis: fields.rights, note: fields.note, confirmed: now },
      stages: { probe: stage(), captions: stage(), audio: stage(), transcript: stage(), video: stage(), visual: fields.watch ? stage() : stage('skipped', 'Not requested') }, status: 'working', transcript: null, media: { full: false, file: null, bytes: 0, audio: null, proxy: null },
      heatmap: [], chapters: [], description: '', stats: { views: null, likes: null, uploaded: null }, error: null };
  }
  private rightsFrom(value: unknown) {
    if (!CLIP_RIGHTS.includes(value as ClipRights)) throw new ClipError(`Confirm your right to use this video (rights: ${CLIP_RIGHTS.join(', ')}).`);
    return value as ClipRights;
  }
  async importLink(body: unknown) {
    await this.init(); this.admit(); await this.noMinutesLeft();
    const v = (body ?? {}) as Record<string, unknown>;
    for (const key of Object.keys(v)) if (!['url', 'rights', 'note', 'quality', 'fullVideo', 'language', 'watch'].includes(key)) throw new ClipError(`Unsupported field: ${key}.`);
    const url = validateSourceUrl(v.url, this.options.allowLocalUrls), rights = this.rightsFrom(v.rights), note = cleanText(v.note ?? '', CLIP_LIMITS.noteChars, 'Note');
    const settings = await this.settings(), quality = (v.quality ?? settings.quality) as ClipQuality;
    if (!CLIP_QUALITY.includes(quality)) throw new ClipError(`quality must be one of ${CLIP_QUALITY.join(', ')}.`);
    if (v.fullVideo !== undefined && typeof v.fullVideo !== 'boolean') throw new ClipError('fullVideo must be true or false.');
    if (v.watch !== undefined && typeof v.watch !== 'boolean') throw new ClipError('watch must be true or false.');
    if ((await this.listSources()).length >= CLIP_LIMITS.sources) throw new ClipError(`Sprity Reels keeps ${CLIP_LIMITS.sources} sources. Delete old ones first.`);
    if (!(await this.tools()).ytdlp) throw new ClipError('Link import is not set up on this server (yt-dlp is missing). Upload the video file instead.', 503);
    const source = this.newSource({ kind: 'link', title: url, url, rights, note, quality, watch: v.watch !== false });
    if (typeof v.language === 'string' && /^[a-z]{2,3}(-[A-Za-z0-9]+)?$/.test(v.language)) source.language = v.language;
    await writeJson(path.join(this.sourceDir(source.id), 'source.json'), source);
    const job = this.startJob('import', { sourceId: source.id }, (_job, signal, progress) => this.runImport(source.id, { fullVideo: v.fullVideo === true }, signal, progress));
    return { source, job };
  }
  async importUpload(filename: string, body: AsyncIterable<Uint8Array>, declared: number, query: { rights: unknown; note?: unknown; watch?: unknown }) {
    await this.init(); this.admit(); await this.noMinutesLeft();
    const ext = path.extname(filename).toLowerCase();
    if (!VIDEO_EXT.includes(ext)) throw new ClipError(`Upload a video file: ${VIDEO_EXT.join(', ')}.`);
    if (declared > CLIP_LIMITS.uploadBytes) throw new ClipError('Use a video smaller than 20 GB.', 413);
    const rights = this.rightsFrom(query.rights), note = cleanText(query.note ?? '', CLIP_LIMITS.noteChars, 'Note');
    if (query.watch !== undefined && query.watch !== 'true' && query.watch !== 'false' && typeof query.watch !== 'boolean') throw new ClipError('watch must be true or false.');
    const source = this.newSource({ kind: 'upload', title: path.basename(filename, ext).replace(/[_+]+/g, ' ').trim().slice(0, 120) || 'Upload', url: null, rights, note, quality: '1080', watch: query.watch !== false && query.watch !== 'false' });
    const dir = this.sourceDir(source.id), file = path.join(dir, `media${ext}`);
    await mkdir(dir, { recursive: true });
    const out = createWriteStream(file, { flags: 'wx' });
    let size = 0;
    try {
      for await (const chunk of body) { size += chunk.length; if (size > CLIP_LIMITS.uploadBytes) throw new ClipError('Use a video smaller than 20 GB.', 413); if (!out.write(chunk)) await new Promise<void>(r => out.once('drain', () => r())); }
    } catch (error) { out.destroy(); await rm(dir, { recursive: true, force: true }); throw error; }
    finally { out.end(); await finished(out).catch(() => {}); }
    if (!size) { await rm(dir, { recursive: true, force: true }); throw new ClipError('The file is empty.'); }
    source.media = { full: true, file: path.basename(file), bytes: size, audio: null, proxy: null };
    await writeJson(path.join(dir, 'source.json'), source);
    const job = this.startJob('import', { sourceId: source.id }, (_job, signal, progress) => this.runImport(source.id, { fullVideo: true }, signal, progress));
    return { source, job };
  }
  async retrySource(id: string) {
    const s = await this.getSource(id); this.admit();
    if (s.status === 'working' && this.jobList({ sourceId: id }).some(j => j.kind === 'import' && (j.status === 'running' || j.status === 'queued'))) throw new ClipError('This source is still being processed.', 409);
    await this.updateSource(id, x => { x.status = 'working'; x.error = null; for (const st of Object.values(x.stages)) if (st.status === 'failed') st.status = 'pending'; });
    return this.startJob('import', { sourceId: id }, (_job, signal, progress) => this.runImport(id, { fullVideo: s.kind === 'upload' || s.media.full }, signal, progress));
  }
  async deleteSource(id: string, body: unknown) {
    if ((body as { confirm?: unknown })?.confirm !== true) throw new ClipError('Pass confirm: true to delete this source, its downloads and its shorts.');
    await this.getSource(id);
    for (const j of this.jobList({ sourceId: id })) if (j.status === 'running' || j.status === 'queued') this.cancelJob(j.id);
    await this.vault.purge({ scope: this.root, sourceId: id });
    for (const short of await this.listShorts(id)) { await rm(this.shortDir(short.id), { recursive: true, force: true }); this.forgetShort(short.id); }
    this.setsMemo.delete(id); this.reactionsMemo.delete(id);
    this.transcripts.delete(id); this.energies.delete(id); this.visuals.delete(id);
    await rm(this.sourceDir(id), { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    return { deleted: id };
  }

  private async setStage(id: string, name: ClipStageId, patch: Partial<ClipStage>) { await this.updateSource(id, s => { s.stages[name] = { ...(s.stages[name] ?? stage()), ...patch }; }); }
  /** The import pipeline. Links: metadata and captions first (moments in seconds), then audio-only download and
   * whisper for exact words; video downloads later, only for the ranges a short uses (or all of it on request). */
  private async runImport(id: string, opts: { fullVideo: boolean }, signal: AbortSignal, progress: (f: number, stage?: string, message?: string) => void) {
    const dir = this.sourceDir(id), tools = await this.tools();
    try {
      let src = await this.getSource(id);
      if (src.kind === 'link') {
        if (src.stages.probe.status !== 'done') {
          progress(.02, 'probe', 'Reading the link…'); await this.setStage(id, 'probe', { status: 'running', message: 'Reading the link…' });
          let info: LinkInfo;
          try { info = await this.lane('net', signal, () => probeLink(tools, src.url!, signal)); } catch (e) { throw new ClipError(linkError(e)); }
          if (info.is_live) throw new ClipError('This is a live stream. Import it after the stream ends and the recording is available.');
          if (!(info.duration > 3)) throw new ClipError('This link has no playable video length.');
          if (info.duration > this.maxSeconds) throw new ClipError(this.lengthMessage());
          await this.spendMinutes(id, info.duration);
          await writeJson(path.join(dir, 'info.json'), { id: info.id, title: info.title, extractor: info.extractor, webpage_url: info.webpage_url, duration: info.duration, language: info.language, heatmap: info.heatmap, chapters: info.chapters });
          src = await this.updateSource(id, s => {
            s.title = cleanText(info.title || 'Video', 200, 'Title') || 'Video'; s.site = info.extractor ?? null; s.videoId = info.id ?? null; s.url = info.webpage_url || s.url;
            const creator = info.channel || info.uploader; s.creator = creator ? { name: creator.slice(0, 100), url: info.channel_url || info.uploader_url || null } : null;
            s.license = info.license ?? null; s.language = s.language ?? info.language ?? null; s.duration = info.duration; s.width = info.width || 0; s.height = info.height || 0; s.fps = info.fps || 0;
            s.heatmap = (info.heatmap ?? []).slice(0, 1000).map(h => ({ s: h.start_time, e: h.end_time, v: Math.max(0, Math.min(1, h.value)) }));
            s.chapters = (info.chapters ?? []).slice(0, 200).map(c => ({ title: String(c.title ?? '').slice(0, 120), start: c.start_time, end: c.end_time }));
            s.description = String(info.description ?? '').slice(0, 5000); s.stats = { views: info.view_count ?? null, likes: info.like_count ?? null, uploaded: info.upload_date ?? null };
            s.stages.probe = stage('done', 'Link read');
          });
          // Captions are the instant path: a transcript and first moments before any media downloads.
          if (!src.transcript) {
            await this.setStage(id, 'captions', { status: 'running', message: 'Checking the site\'s captions…' });
            try {
              const caps = await this.lane('net', signal, () => downloadCaptions(tools, src.url!, info, dir, signal));
              if (caps) {
                const json = JSON.parse(await readFile(caps.file, 'utf8')), words = wordsFromJson3(json, src.duration), reactions = reactionsFromJson3(json);
                if (reactions.length) { await writeJson(path.join(dir, 'reactions.json'), { events: reactions }); this.reactionsMemo.delete(id); }
                if (words.length > 10) { await this.saveTranscript(id, makeTranscript(words, { engine: 'captions', language: caps.language, model: caps.manual ? 'site captions' : 'site speech captions', duration: src.duration }), 0); await this.autoMoments(id); }
                await rm(caps.file, { force: true });
                await this.setStage(id, 'captions', { status: 'done', progress: 1, message: words.length > 10 ? `Quick transcript from ${caps.manual ? 'captions' : 'automatic captions'}` : 'Captions were empty' });
              } else await this.setStage(id, 'captions', { status: 'skipped', message: 'No captions on the site' });
            } catch (e) { if (signal.aborted) throw e; await this.setStage(id, 'captions', { status: 'skipped', message: 'Captions unavailable' }); }
          }
        }
        src = await this.getSource(id);
        if (!src.media.audio || !await exists(path.join(dir, src.media.audio))) {
          progress(.1, 'audio', 'Downloading audio…'); await this.setStage(id, 'audio', { status: 'running', progress: 0, message: 'Downloading audio only…' });
          let file: string;
          try { file = await this.lane('net', signal, () => downloadAudio(tools, src.url!, dir, { signal, onProgress: f => { progress(.1 + f * .25, 'audio'); void this.setStage(id, 'audio', { progress: f }).catch(() => {}); } })); }
          catch (e) { if (signal.aborted) throw e; throw new ClipError(linkError(e)); }
          src = await this.updateSource(id, s => { s.media.audio = path.basename(file); s.stages.audio = stage('done', 'Audio downloaded'); });
        }
      } else {
        src = await this.getSource(id);
        const info = await probeMedia(path.join(dir, src.media.file!)).catch(() => null);
        if (!info?.hasVideo || !(info.duration > 1)) throw new ClipError('This file has no readable video. Use an MP4, MOV, MKV or WebM file.');
        if (info.duration > this.maxSeconds) throw new ClipError(this.lengthMessage());
        await this.spendMinutes(id, info.duration);
        src = await this.updateSource(id, s => { s.duration = info.duration; s.width = info.width; s.height = info.height; s.fps = info.fps; s.stages.probe = stage('done', 'File read'); s.stages.captions = stage('skipped', 'Uploads use whisper'); s.stages.audio = stage('done', info.hasAudio ? 'Audio in file' : 'No audio track'); s.stages.video = stage('done', 'Full video on this computer'); });
        if (!info.hasAudio) throw new ClipError('This video has no audio track, so there is nothing to transcribe.');
      }
      // Exact words: whisper on the audio (GPU when available), timed with DTW and the loudness envelope.
      src = await this.getSource(id);
      if (src.transcript?.engine !== 'whisper') {
        const audioFile = path.join(dir, src.kind === 'upload' ? src.media.file! : src.media.audio!), wav = path.join(dir, 'audio16.wav');
        progress(.38, 'transcript', 'Preparing audio…'); await this.setStage(id, 'transcript', { status: 'running', progress: 0, message: 'Preparing audio…' });
        await this.lane('prep', signal, () => extractWav(audioFile, wav, { signal }));
        const energy = await wavEnvelope(wav);
        await writeFile(path.join(dir, 'energy.bin'), energy); this.energies.set(id, energy);
        const canWhisper = !!this.options.transcriber || (!!tools.whisper && !!tools.whisperModel);
        if (canWhisper) {
          const started = Date.now(), language = (src.language ?? (await this.settings()).language ?? 'auto').split('-')[0] || 'auto';
          await this.setStage(id, 'transcript', { message: tools.whisperGpu ? 'Transcribing on the GPU…' : 'Transcribing on the CPU…' });
          const result = await this.lane('gpu', signal, async () => {
            if (this.options.transcriber) return this.options.transcriber(wav, language, signal);
            const prompt = [src.creator?.name, src.title].filter(Boolean).join('. ').replace(/https?:\/\/\S+/g, '').slice(0, 200);
            const r = await transcribe(tools, wav, { language, prompt, signal, threads: this.whisperThreads(tools), onProgress: f => { progress(.4 + f * .5, 'transcript', `Transcribing… ${Math.round(f * 100)}%`); void this.setStage(id, 'transcript', { progress: f }).catch(() => {}); } });
            const lang = String((r.json as { result?: { language?: string } }).result?.language ?? language);
            return { words: wordsFromWhisper(r.json as never, 0, energy), language: lang, model: `whisper large-v3-turbo${r.gpu ? ' (GPU)' : ' (CPU)'}` };
          });
          // A video without speech (gameplay, sports, music) still gets moments: action picks from the audio.
          if (result.words.length || !src.transcript) {
            await this.saveTranscript(id, makeTranscript(result.words, { engine: 'whisper', language: result.language, model: result.model, duration: src.duration }), (Date.now() - started) / 1000);
            await this.autoMoments(id);
          }
          await this.setStage(id, 'transcript', { status: 'done', progress: 1, message: result.words.length ? `${result.words.length} words` : 'No speech found: moments come from the action in the audio' });
        } else if (!src.transcript) throw new ClipError('Transcription is not set up on this server (whisper.cpp is missing).', 503);
        else await this.setStage(id, 'transcript', { status: 'skipped', message: 'Using the site captions (install whisper.cpp for exact word timing)' });
        await rm(wav, { force: true });
      }
      src = await this.getSource(id);
      if (src.kind === 'link' && !src.media.full) {
        if (opts.fullVideo) {
          progress(.9, 'video', 'Downloading the full video…'); await this.setStage(id, 'video', { status: 'running', progress: 0, message: 'Downloading the full video…' });
          const file = await this.lane('net', signal, () => downloadVideo(tools, src.url!, path.join(dir, 'media.%(ext)s'), { quality: src.quality, signal, onProgress: f => { progress(.9 + f * .09, 'video'); void this.setStage(id, 'video', { progress: f }).catch(() => {}); } })).catch(e => { if (signal.aborted) throw e; throw new ClipError(linkError(e)); });
          const info = await probeMedia(file);
          await this.updateSource(id, s => { s.media = { ...s.media, full: true, file: path.basename(file), bytes: 0 }; s.width = info.width; s.height = info.height; s.fps = info.fps || s.fps; s.stages.video = stage('done', 'Full video downloaded'); });
        } else await this.setStage(id, 'video', { status: 'skipped', message: 'Video downloads per short (only the parts you use)' });
      }
      if ((await this.getSource(id)).stages.visual?.status === 'pending') {
        // The picture is only read for action picks (gaming, sports, and videos with little speech). A talking video never uses it, so it is not
        // decoded at all: an hour of 1080p costs 9 to 22 core-minutes depending on the footage, and a link would download a small copy first.
        const spoken = await this.transcript(id).catch(() => null);
        if (spoken && this.options.picturePass !== 'always' && !wantsAction(spoken, (await this.settings()).genre)) await this.setStage(id, 'visual', { status: 'skipped', progress: 1, message: 'Not needed: this video is mostly speech' });
        else await this.runVisual(id, signal, progress);
      }
      const done = await this.updateSource(id, s => { s.status = s.transcript ? 'ready' : 'failed'; s.error = s.transcript ? null : 'No speech was found in this video.'; });
      if (done.kind === 'link' && !done.media.full) void this.prefetch(id).catch(() => {});
      return { source: done };
    } catch (error) {
      const message = signal.aborted ? 'Cancelled.' : publicMessage(error);
      await this.updateSource(id, s => { s.status = s.transcript ? 'ready' : 'failed'; s.error = message; for (const st of Object.values(s.stages)) if (st.status === 'running') { st.status = 'failed'; st.message = message; } }).catch(() => {});
      throw error;
    }
  }
  /** The picture pass: how much the picture changes, four times a second over the whole video, from the full video or
   * a small 240p copy of a link. Silent highlights (a trick shot, a dunk in a muted stream) become action picks. It never
   * fails the import: without it, action picks come from the sound alone. */
  private async runVisual(id: string, signal: AbortSignal, progress: (f: number, stage?: string, message?: string) => void) {
    const dir = this.sourceDir(id), tools = await this.tools();
    let src = await this.getSource(id);
    if (!tools.ffmpeg) { await this.setStage(id, 'visual', { status: 'skipped', message: 'Watching the picture needs FFmpeg' }); return; }
    await this.setStage(id, 'visual', { status: 'running', progress: 0, message: 'Watching the picture…' });
    try {
      let video = await this.pictureFile(src), share = 0;
      if (!video) {
        if (src.kind !== 'link' || !src.url || !tools.ytdlp) throw new ClipError('The video is not on the server.');
        share = .4;
        progress(.9, 'visual', 'Downloading a small copy of the video…'); await this.setStage(id, 'visual', { message: 'Downloading a small copy of the video…' });
        const file = await this.lane('net', signal, () => downloadProxy(tools, src.url!, dir, { signal, onProgress: f => { progress(.9 + f * .04, 'visual'); void this.setStage(id, 'visual', { progress: f * share }).catch(() => {}); } }))
          .catch(e => { if (signal.aborted) throw e; throw new ClipError(linkError(e)); });
        src = await this.updateSource(id, s => { s.media.proxy = path.basename(file); });
        video = { file, offset: 0 };
      }
      await this.setStage(id, 'visual', { message: 'Measuring motion in the picture…' });
      const visual = await this.lane('scan', signal, () => visualActivity(video!.file, dir, { duration: src.duration, signal,
        onProgress: f => { progress(.94 + f * .05, 'visual', `Watching the picture… ${Math.round(f * 100)}%`); void this.setStage(id, 'visual', { progress: share + f * (1 - share) }).catch(() => {}); } }));
      await writeFile(path.join(dir, 'visual.bin'), visual); this.visuals.set(id, visual);
      const bursts = visualPeaks(visual).length;
      await this.setStage(id, 'visual', { status: 'done', progress: 1, message: bursts ? `${bursts} burst${bursts === 1 ? '' : 's'} of on-screen action` : 'No bursts of on-screen action' });
      // Action picks change once the picture is known.
      const t = await this.transcript(id).catch(() => null);
      if (t && wantsAction(t, (await this.settings()).genre)) await this.autoMoments(id);
    } catch (error) {
      if (signal.aborted) throw error;
      await this.setStage(id, 'visual', { status: 'failed', message: publicMessage(error) });
    }
  }
  /** Runs the picture pass for a source imported without it (or when it failed). */
  async watchSource(id: string) {
    const s = await this.getSource(id); this.admit();
    if (this.jobList({ sourceId: id }).some(j => j.kind === 'import' && (j.status === 'running' || j.status === 'queued'))) throw new ClipError('This source is still being processed.', 409);
    if (!s.transcript) throw new ClipError('Import this video first.', 409);
    await this.setStage(id, 'visual', { status: 'pending', progress: 0, message: '' });
    return this.startJob('import', { sourceId: id }, async (_job, signal, progress) => { await this.runVisual(id, signal, progress); return { source: await this.getSource(id) }; });
  }
  /** The whole video on this computer, for the picture: the full download or upload, else the small copy of a link. */
  private async pictureFile(src: ClipSource): Promise<{ file: string; offset: number } | null> {
    for (const name of [src.media.full ? src.media.file : null, src.media.proxy]) {
      if (!name) continue;
      const file = path.join(this.sourceDir(src.id), name);
      if (await exists(file)) return { file, offset: 0 };
    }
    return null;
  }
  /** The picture of a video on this computer. A link whose small copy was never fetched (the picture pass is skipped for talking videos)
   * gets it now, because a model that looks at the video needs it; null when there is none and none can be had. */
  private async ensurePicture(id: string, signal: AbortSignal) {
    const src = await this.getSource(id), have = await this.pictureFile(src);
    if (have) return have;
    const tools = await this.tools();
    if (src.kind !== 'link' || !src.url || !tools.ytdlp) return null;
    const file = await this.lane('net', signal, () => downloadProxy(tools, src.url!, this.sourceDir(id), { signal })).catch(error => { if (signal.aborted) throw error; return null; });
    if (!file) return null;
    await this.updateSource(id, s => { s.media.proxy = path.basename(file); });
    return { file, offset: 0 };
  }
  private async visual(id: string) {
    const cached = this.visuals.get(id);
    if (cached) return cached;
    try { const v = new Uint8Array(await readFile(path.join(this.sourceDir(id), 'visual.bin'))); this.visuals.set(id, v); return v; } catch { return undefined; }
  }
  private async saveTranscript(id: string, transcript: ClipTranscript, seconds: number) {
    await writeJson(path.join(this.sourceDir(id), 'transcript.json'), transcript);
    this.transcripts.set(id, transcript);
    await this.updateSource(id, s => { s.transcript = { engine: transcript.engine, language: transcript.language, words: transcript.words.length, model: transcript.model, seconds: Math.round(seconds * 10) / 10 }; if (s.status !== 'ready') s.status = 'ready'; });
  }
  async transcript(id: string): Promise<ClipTranscript> {
    const cached = this.transcripts.get(id);
    if (cached) return cached;
    const t = await readJson<ClipTranscript>(path.join(this.sourceDir(id), 'transcript.json'));
    if (!t) throw new ClipError('This source has no transcript yet.', 409);
    const valid = validateTranscript(t); this.transcripts.set(id, valid);
    return valid;
  }
  private async energy(id: string) {
    const cached = this.energies.get(id);
    if (cached) return cached;
    try { const e = new Uint8Array(await readFile(path.join(this.sourceDir(id), 'energy.bin'))); this.energies.set(id, e); return e; } catch { return undefined; }
  }
  /** Numbered sentences for agents (MCP) and the editor. */
  async transcriptPage(id: string, from = 0, count = 300) {
    const t = await this.transcript(id), src = await this.getSource(id);
    const a = Math.max(0, Math.min(t.sentences.length, Math.floor(from))), n = Math.max(1, Math.min(600, Math.floor(count)));
    const heat = [...src.heatmap].sort((x, y) => y.v - x.v).slice(0, 10).sort((x, y) => x.s - y.s), visual = await this.visual(id);
    return { sourceId: id, title: src.title, creator: src.creator?.name ?? null, duration: t.duration, language: t.language, engine: t.engine, total: t.sentences.length, from: a,
      lines: transcriptLines(t, a, n), mostReplayed: heat.map(h => ({ start: h.s, end: h.e, value: Math.round(h.v * 100) / 100 })), chapters: src.chapters,
      // Peaks in the sound (dB above their surroundings) and the picture (levels of change above their surroundings):
      // candidates for action moments, which clip_save_moments takes as kind action with start/end seconds.
      pictureWatched: !!visual, actionPeaks: actionList({ energy: await this.energy(id), visual }, 20).map(p => ({ at: p.t, start: p.s, end: p.e, audioDb: p.audio, picture: p.visual, strength: p.strength })) };
  }

  // ------------------------------------------------------------------ media: sections & ranges
  private async sections(id: string) { return (await readJson<Section[]>(path.join(this.sourceDir(id), 'sections.json'))) ?? []; }
  /** Media that covers [start, end]: the full file, a downloaded section, or a new section download (links only). */
  async ensureRange(id: string, start: number, end: number, signal?: AbortSignal): Promise<MediaSpan> {
    const src = await this.getSource(id), dir = this.sourceDir(id);
    if (src.media.full && src.media.file) {
      const file = path.join(dir, src.media.file), info = await probeMedia(file);
      return { file, start: 0, end: info.duration || src.duration, offset: 0, width: info.width, height: info.height, hasAudio: info.hasAudio };
    }
    const found = (await this.sections(id)).find(s => s.start <= start + .05 && s.end >= end - .05);
    if (found && await exists(found.file)) return found;
    if (src.kind !== 'link' || !src.url) throw new ClipError('The video for this range is not available.', 409);
    const want = { start: Math.max(0, Math.floor((start - 3) * 10) / 10), end: Math.min(src.duration, Math.ceil((end + 3) * 10) / 10) };
    const key = `${id}:${want.start}:${want.end}`, pending = this.sectionsInflight.get(key);
    if (pending) return pending;
    const task = (async () => {
      const tools = await this.tools(), sid = `${Math.round(want.start * 10)}-${Math.round(want.end * 10)}`, out = path.join(dir, 'sections', `${sid}.mp4`);
      await mkdir(path.dirname(out), { recursive: true });
      const file = await this.lane('net', signal, () => downloadVideo(tools, src.url!, out, { quality: src.quality, section: want, signal })).catch(e => { if (signal?.aborted) throw e; throw new ClipError(linkError(e)); });
      const info = await probeMedia(file);
      // Sections can start on an earlier keyframe: lock the offset by matching loudness against the full audio.
      let offset = want.start;
      const energy = await this.energy(id);
      if (energy && info.hasAudio) {
        const wav = `${file}.wav`;
        try { await extractWav(file, wav, { duration: 40, signal }); const part = await wavEnvelope(wav); const a = alignEnvelope(energy, part, want.start, 6); if (a.confidence >= .5) offset = a.offset; }
        catch { /* keep the requested start */ } finally { await rm(wav, { force: true }); }
      }
      const section: Section = { id: sid, file, start: offset, end: offset + info.duration, offset, width: info.width, height: info.height, hasAudio: info.hasAudio, bytes: (await stat(file)).size, created: Date.now() };
      await this.serial(`sections:${id}`, async () => { const list = (await this.sections(id)).filter(s => s.id !== sid); list.push(section); await writeJson(path.join(dir, 'sections.json'), list); });
      await this.updateSource(id, s => { if (!s.width && info.width) { s.width = info.width; s.height = info.height; s.fps = info.fps; } });
      return section;
    })();
    this.sectionsInflight.set(key, task);
    try { return await task; } finally { this.sectionsInflight.delete(key); }
  }
  /** For the preview player: which file to stream for a range, and the source time of its first frame. */
  async previewRange(id: string, body: unknown) {
    const v = (body ?? {}) as { start?: unknown; end?: unknown }, src = await this.getSource(id);
    const start = Number(v.start), end = Number(v.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end > src.duration + 1 || end - start > 600) throw new ClipError('Choose a range of up to 10 minutes inside the video.');
    const span = await this.ensureRange(id, start, end);
    const sid = src.media.full ? 'media' : path.basename(span.file, '.mp4');
    return { url: sid === 'media' ? `/api/clips/sources/${id}/media` : `/api/clips/sources/${id}/sections/${sid}`, offset: span.offset, start: span.start, end: span.end };
  }
  async mediaFile(id: string, section?: string) {
    const src = await this.getSource(id), dir = this.sourceDir(id);
    if (!section) { if (!src.media.full || !src.media.file) throw new ClipError('The full video is not downloaded.', 404); const file = path.join(dir, src.media.file), info = await stat(file); return { path: file, size: info.size, mtimeMs: info.mtimeMs }; }
    if (!/^\d+-\d+$/.test(section)) throw new ClipError('Unknown section.', 404);
    const s = (await this.sections(id)).find(x => x.id === section);
    if (!s) throw new ClipError('Unknown section.', 404);
    const info = await stat(s.file);
    return { path: s.file, size: info.size, mtimeMs: info.mtimeMs };
  }
  private async prefetch(id: string) {
    const sets = await this.momentSets(id), top = sets[0]?.moments.slice(0, 3) ?? [];
    for (const m of top) await this.ensureRange(id, m.start, m.end).catch(() => {});
  }

  // ------------------------------------------------------------------ moments
  async momentSets(id: string) {
    const known = this.setsMemo.get(id);
    if (known) return [...known];
    const sets = (await readJson<{ sets: ClipMomentSet[] }>(path.join(this.sourceDir(id), 'moments.json')))?.sets ?? [];
    this.setsMemo.set(id, sets);
    return [...sets];
  }
  private async saveSet(id: string, set: ClipMomentSet, replaceAuto = false) {
    return this.serial(`moments:${id}`, async () => {
      let sets = await this.momentSets(id);
      if (replaceAuto) sets = sets.filter(s => !(s.engine === 'local' && !s.prompt));
      sets.unshift(set);
      await writeJson(path.join(this.sourceDir(id), 'moments.json'), { sets: sets.slice(0, 12) });
      this.setsMemo.set(id, sets.slice(0, 12));
      return set;
    });
  }
  private async momentContext(id: string): Promise<MomentContext> {
    const src = await this.getSource(id);
    return { title: src.title, creator: src.creator?.name ?? '', description: src.description, heatmap: src.heatmap, chapters: src.chapters, energy: await this.energy(id), reactions: await this.reactions(id), visual: await this.visual(id) };
  }
  /** Audience reactions from the site's captions ([Laughter], [Applause]…), when the site had any. */
  async reactions(id: string): Promise<ClipReaction[]> {
    const known = this.reactionsMemo.get(id);
    if (known) return known;
    const events = (await readJson<{ events: ClipReaction[] }>(path.join(this.sourceDir(id), 'reactions.json')))?.events ?? [];
    this.reactionsMemo.set(id, events);
    return events;
  }
  private async momentOptions(body: Record<string, unknown>, duration: number): Promise<MomentOptions> {
    const d = await this.settings();
    const num = (v: unknown, def: number, lo: number, hi: number, name: string) => { if (v === undefined) return def; if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi) throw new ClipError(`${name} must be ${lo}-${hi}.`); return v; };
    const minSeconds = num(body.minSeconds, d.minSeconds, CLIP_LIMITS.minShortSeconds, 170, 'minSeconds'), maxSeconds = num(body.maxSeconds, d.maxSeconds, 8, CLIP_LIMITS.shortSeconds, 'maxSeconds');
    if (maxSeconds < minSeconds + 3) throw new ClipError('maxSeconds must be at least 3 seconds longer than minSeconds.');
    const genre = (body.genre ?? d.genre) as ClipGenre;
    if (!CLIP_GENRES.includes(genre)) throw new ClipError(`genre must be one of ${CLIP_GENRES.join(', ')}.`);
    let range: MomentOptions['range'] = null;
    if (body.range !== undefined && body.range !== null) {
      const r = body.range as { start?: unknown; end?: unknown };
      const s = Number(r?.start), e = Number(r?.end);
      if (!Number.isFinite(s) || !Number.isFinite(e) || s < 0 || e <= s + minSeconds || e > duration + 1) throw new ClipError('range must be {start, end} inside the video and longer than the minimum length.');
      range = { start: s, end: e };
    }
    return { count: Math.round(num(body.count, d.count, 1, CLIP_LIMITS.moments, 'count')), minSeconds, maxSeconds, prompt: cleanText(body.prompt ?? '', CLIP_LIMITS.promptChars, 'Prompt'), genre, range };
  }
  private async autoMoments(id: string) {
    const t = await this.transcript(id), d = await this.settings();
    const opts: MomentOptions = { count: d.count, minSeconds: d.minSeconds, maxSeconds: d.maxSeconds, prompt: '', genre: d.genre, range: null };
    const moments = localMoments(t, await this.momentContext(id), opts);
    await this.saveSet(id, { id: randomUUID(), engine: 'local', prompt: '', genre: d.genre, created: Date.now(), model: null, usage: null, moments }, true);
  }
  /** Local engine answers immediately; Gemini, Codex and Claude Code run as jobs and need userRequestedGeneration. */
  async findMoments(id: string, body: unknown) {
    const v = (body ?? {}) as Record<string, unknown>;
    for (const key of Object.keys(v)) if (!['engine', 'prompt', 'count', 'minSeconds', 'maxSeconds', 'genre', 'range', 'userRequestedGeneration'].includes(key)) throw new ClipError(`Unsupported field: ${key}.`);
    const t = await this.transcript(id), opts = await this.momentOptions(v, t.duration), engine = (v.engine ?? 'local') as ClipEngine;
    if (engine === 'local') {
      const moments = localMoments(t, await this.momentContext(id), opts);
      return { set: await this.saveSet(id, { id: randomUUID(), engine: 'local', prompt: opts.prompt, genre: opts.genre, created: Date.now(), model: null, usage: null, moments }) };
    }
    if (!CLIP_AI_ENGINES.includes(engine as ClipAIEngine)) throw new ClipError('engine must be local, gemini, codex or claude.');
    if (v.userRequestedGeneration !== true) throw new ClipError(`${engine} uses your ${engine === 'gemini' ? 'Gemini API key (billed per request)' : 'subscription limits'}. Pass userRequestedGeneration: true when the creator asked for it.`);
    const ctx = await this.momentContext(id), prompt = buildMomentPrompt(t, ctx, opts);
    const job = this.startJob('moments', { sourceId: id }, async (record, signal, progress) => {
      // A model that reads images also looks at the video: a storyboard of scene-aware frames (and the action peaks up
      // close), tiled into contact sheets. They are built in memory, handed to the model, and discarded as soon as it has
      // answered, before the picks are saved.
      const vision = engine !== 'gemini' ? this.directors[engine as 'codex' | 'claude'] : undefined;
      let sheets: Sheets | null = null;
      if (vision?.vision) {
        progress(.04, 'moments', 'Looking at the video…');
        sheets = await this.momentSheets(id, ctx, opts, t, signal, { jobId: record.id, inMemory: vision.imageInput === 'data', onProgress: f => progress(.04 + f * .06, 'moments', 'Looking at the video…') }).catch(e => { if (signal.aborted) throw e; return null; });
      }
      let answer: Awaited<ReturnType<ClipStudioService['ai']>>;
      try {
        progress(.1, 'moments', `Asking ${engine === 'gemini' ? 'Gemini 3.8 Flash' : engine === 'codex' ? 'Codex' : 'Claude'}…`);
        const parts = momentPromptParts(t, ctx, opts);
        answer = await this.ai(engine as ClipAIEngine, { system: MOMENT_INSTRUCTIONS, prompt: sheets ? `${prompt}\n\n${sheets.note}` : prompt, cacheable: { stable: sheets ? `${parts.context}\n\n${sheets.note}` : parts.context, ask: parts.request }, schema: MOMENT_SCHEMA, kind: 'moments', sourceId: id, shortId: null, images: sheets?.files, imageData: sheets?.data }, signal);
      } finally { await sheets?.discard(); }
      const moments = parseMomentReply(answer.text, t, ctx, opts, engine);
      if (!moments.length) throw new ClipError('The AI did not return any usable moments. Try again or loosen the length limits.');
      return { set: await this.saveSet(id, { id: randomUUID(), engine, prompt: opts.prompt, genre: opts.genre, created: Date.now(), model: answer.model, usage: answer.usage, moments }), frames: sheets?.count ?? 0 };
    });
    return { job, estimateUsd: engine === 'gemini' ? estimateTextCost(prompt.length + MOMENT_INSTRUCTIONS.length) : 0 };
  }
  /** Moments written by an agent (Codex / Claude Code over MCP): sentence indices or seconds, validated and snapped. */
  async saveMoments(id: string, body: unknown) {
    const v = (body ?? {}) as { moments?: unknown; prompt?: unknown };
    if (!Array.isArray(v.moments) || !v.moments.length) throw new ClipError('Pass moments: a list with startSentence/endSentence (or start/end seconds), title, hook, reason and scores.');
    const t = await this.transcript(id), d = await this.settings();
    const moments = normalizeMoments(v.moments, t, await this.momentContext(id), { minSeconds: CLIP_LIMITS.minShortSeconds, maxSeconds: CLIP_LIMITS.shortSeconds, count: CLIP_LIMITS.moments }, 'agent');
    if (!moments.length) throw new ClipError('None of the moments matched the transcript. Use sentence indices from sprityreels_clip_transcript, or kind action with start/end seconds.');
    return { set: await this.saveSet(id, { id: randomUUID(), engine: 'agent', prompt: cleanText(v.prompt ?? '', CLIP_LIMITS.promptChars, 'Prompt'), genre: d.genre, created: Date.now(), model: null, usage: null, moments }) };
  }
  private async ai(engine: ClipAIEngine, req: { system: string; prompt: string; schema: object; kind: 'moments' | 'script'; sourceId: string | null; shortId: string | null; images?: string[]; imageData?: DirectorImage[]; cacheable?: { stable: string; ask: string } }, signal: AbortSignal) {
    if (engine === 'gemini') { const { images: _images, imageData: _data, cacheable: _cacheable, ...text } = req; return this.lane('ai', signal, () => this.gemini.json({ ...text, signal })); }
    const director = this.directors[engine];
    if (!director) throw new ClipError(`${engine} is not available in this studio.`, 503);
    const cwd = path.join(this.root, 'ai-workspace');
    await mkdir(cwd, { recursive: true });
    try {
      const pictures = director.vision ? (director.imageInput === 'data' ? (req.imageData?.length ? { imageData: req.imageData } : {}) : (req.images?.length ? { images: req.images } : {})) : {};
      const a = await this.lane('ai', signal, () => director.generate({ system: req.system, prompt: req.prompt, schema: req.schema, cwd, timeoutMs: 300_000, signal, ...(req.cacheable ? { cacheable: req.cacheable } : {}), ...pictures }));
      const usd = a.usage?.usd ?? 0;
      // Subscriptions cost nothing per call; a director that bills per token (Claude through the API) is recorded like Gemini.
      if (a.usage && usd > 0) await this.gemini.ledger.add({ t: Date.now(), kind: req.kind, model: a.model ?? engine, sourceId: req.sourceId, shortId: req.shortId, inputTokens: a.usage.inputTokens, outputTokens: a.usage.outputTokens, usd }).catch(() => {});
      return { text: a.text, model: a.model ?? engine, usage: a.usage ? { inputTokens: a.usage.inputTokens, outputTokens: a.usage.outputTokens, usd } : null };
    } catch (error) { throw error instanceof DirectorUnavailableError ? new ClipError(error.message, 503) : error; }
  }

  /** The picture scan of a video (see server/evidence): where its scenes change, as numbers only. It is made the first time a
   * model asks to see the video and kept next to the source; the frames it looked at were never written to disk. */
  private async evidenceFor(id: string, video: { file: string; offset: number }, duration: number, signal: AbortSignal, onProgress?: (f: number) => void): Promise<Evidence> {
    const file = path.join(this.sourceDir(id), 'evidence.json'), cached = await readJson<Evidence>(file);
    if (validEvidence(cached, duration)) return cached;
    const evidence = await this.lane('scan', signal, () => buildEvidence(video.file, { duration, offset: video.offset, signal, onProgress }));
    await writeJson(file, evidence);
    return evidence;
  }
  /** Contact sheets for a model that reads images: a storyboard of up to 40 frames across the video (or the chosen range),
   * then the strongest action peaks four to an image, one row of six frames each from 8 s before the peak to 4 s after
   * it. The storyboard is the scene-aware selection of the picture scan (every scene change first, near-duplicate frames
   * left out, no long stretch unseen); a video that cannot be scanned gets 40 evenly spaced frames. The note tells the
   * model the time of every frame. null when the picture is not on this computer.
   * The sheets are made in memory. A model that reads files gets them in a vault lease (deleted by discard()); one that
   * takes bytes gets the bytes and nothing is written. */
  private async momentSheets(id: string, ctx: MomentContext, opts: MomentOptions, t: ClipTranscript, signal: AbortSignal, how: { jobId: string; inMemory: boolean; onProgress?: (f: number) => void }): Promise<Sheets | null> {
    const src = await this.getSource(id), video = await this.ensurePicture(id, signal);
    if (!video || !(src.duration > 0)) return null;
    const jpegs: { name: string; jpeg: Buffer }[] = [], lines: string[] = [];
    const from = opts.range?.start ?? 0, to = Math.min(src.duration, opts.range?.end ?? src.duration), aspect = src.width && src.height ? src.width / src.height : 16 / 9;
    let board: ReturnType<typeof evidenceStoryboard> = [];
    try { board = evidenceStoryboard(await this.evidenceFor(id, video, src.duration, signal, how.onProgress), { start: from, end: to }, 40, signal); }
    catch (error) { if (signal.aborted) throw error; }
    let times: number[], marks: string[], overviewNote: string, title: string;
    if (board.length >= 8) {
      times = board.map(f => Math.round(f.t * 10) / 10);
      marks = board.map(f => f.reasons.includes('scene_boundary') ? `${clock(f.t)} cut` : clock(f.t));
      title = `Storyboard: ${times.length} frames from ${clock(from)} to ${clock(to)}, a new scene starts at each “cut”`;
      overviewNote = `Image 1 is a storyboard of ${times.length} frames chosen across the video (every scene change, evenly spread otherwise, near-duplicates left out), left to right and top to bottom, at ${marks.join(', ')}. A frame marked “cut” is the first frame of a new scene.`;
    } else {
      const count = 40;
      times = Array.from({ length: count }, (_, k) => Math.round(from + (to - from) * (k + .5) / count)); marks = times.map(clock);
      title = `Overview: ${count} frames from ${clock(from)} to ${clock(to)}`;
      overviewNote = `Image 1 is an overview of ${count} frames, left to right and top to bottom, at ${marks.join(', ')}.`;
    }
    signal.throwIfAborted();
    const overview = await contactSheet(await grabFrames(video.file, times, { width: 320, offset: video.offset, signal }), marks, { cols: aspect >= 1 ? 8 : 12, tile: tileSize(aspect, 232), title });
    jpegs.push({ name: 'overview.jpg', jpeg: overview.jpeg }); lines.push(overviewNote);
    const offsets = [-8, -4, -1.5, 0, 1.5, 4];
    const peaks = wantsAction(t, opts.genre) || !t.sentences.length ? actionList(ctx, 40).filter(p => p.t >= from && p.t <= to).sort((a, b) => b.strength - a.strength).slice(0, 8).sort((a, b) => a.t - b.t) : [];
    for (let g = 0; g < peaks.length; g += 4) {
      const group = peaks.slice(g, g + 4), at = group.flatMap(p => offsets.map(o => Math.round(Math.max(0, Math.min(src.duration - .05, p.t + o)) * 10) / 10));
      const sheet = await contactSheet(await grabFrames(video.file, at, { width: 360, offset: video.offset, signal }), at.map((x, k) => k % offsets.length === 3 ? `${clock(x)} peak` : clock(x)), { cols: offsets.length, tile: tileSize(aspect, 312), title: `Action peaks ${g + 1}-${g + group.length}: one row each, 8 s before to 4 s after the peak` });
      jpegs.push({ name: `action-${g / 4 + 1}.jpg`, jpeg: sheet.jpeg });
      lines.push(`Image ${jpegs.length} shows action peaks, one row each: ${group.map((p, k) => `row ${k + 1} is the peak at ${p.t.toFixed(1)} s (${p.audio && p.visual ? 'heard and seen' : p.visual ? 'seen' : 'heard'}), frames at ${offsets.map(o => clock(Math.max(0, p.t + o))).join(', ')}`).join('; ')}.`);
    }
    const note = `Attached are contact sheets of frames from the video. ${lines.join(' ')}`;
    if (how.inMemory) return { data: jpegs.map(j => ({ mime: 'image/jpeg' as const, data: j.jpeg })), note, count: jpegs.length, discard: async () => { jpegs.length = 0; } };
    const lease = await this.vault.open({ scope: this.root, sourceId: id, jobId: how.jobId, label: 'moment sheets' });
    try {
      const files = await Promise.all(jpegs.map(async j => { const file = path.join(lease.dir, j.name); await writeFile(file, j.jpeg); return file; }));
      return { files, note, count: files.length, discard: () => this.vault.release(lease) };
    } catch (error) { await this.vault.release(lease); throw error; }
  }
  /** A contact sheet of the video for agents (MCP) that read images: evenly spaced frames between start and end, or the
   * given times. Links without the picture on this computer download the range (up to 10 minutes) first. */
  async frames(id: string, body: unknown) {
    const v = (body ?? {}) as { start?: unknown; end?: unknown; count?: unknown; times?: unknown };
    for (const key of Object.keys(v)) if (!['start', 'end', 'count', 'times'].includes(key)) throw new ClipError(`Unsupported field: ${key}.`);
    const src = await this.getSource(id);
    if (!(src.duration > 0)) throw new ClipError('This source is not imported yet.', 409);
    const inside = (x: unknown, name: string) => { if (typeof x !== 'number' || !Number.isFinite(x) || x < 0 || x > src.duration + .5) throw new ClipError(`${name} must be seconds inside the video (0-${Math.floor(src.duration)}).`); return Math.min(x, Math.max(0, src.duration - .05)); };
    let times: number[];
    if (v.times !== undefined) {
      if (!Array.isArray(v.times) || !v.times.length || v.times.length > 48) throw new ClipError('times must be a list of 1-48 seconds.');
      times = v.times.map((x, i) => inside(x, `times[${i}]`));
    } else {
      const start = v.start === undefined ? 0 : inside(v.start, 'start'), end = v.end === undefined ? src.duration : inside(v.end, 'end'), count = v.count === undefined ? 12 : Number(v.count);
      if (!(end > start)) throw new ClipError('end must be after start.');
      if (!Number.isInteger(count) || count < 1 || count > 48) throw new ClipError('count must be a whole number from 1 to 48.');
      times = Array.from({ length: count }, (_, k) => Math.round((count === 1 ? (start + end) / 2 : start + (end - start) * k / (count - 1)) * 100) / 100);
    }
    let video = await this.pictureFile(src);
    if (!video) {
      const lo = Math.min(...times), hi = Math.max(...times);
      if (src.kind !== 'link' || hi - lo > 600) throw new ClipError('The picture of this video is not on this computer. Watch the picture first (clip_watch downloads a small copy), or ask for frames within 10 minutes of each other.', 409);
      const span = await this.ensureRange(id, lo, Math.min(src.duration, hi + .5));
      video = { file: span.file, offset: span.offset };
    }
    const aspect = src.width && src.height ? src.width / src.height : 16 / 9, n = times.length;
    const cols = aspect >= 1 ? (n <= 3 ? n : n <= 4 ? 2 : n <= 9 ? 3 : n <= 16 ? 4 : 6) : (n <= 4 ? n : n <= 12 ? 6 : 8);
    const sheet = await contactSheet(await grabFrames(video.file, times, { width: 480, offset: video.offset }), times.map(clock), { cols, tile: tileSize(aspect, n <= 4 ? 480 : n <= 16 ? 360 : 280) });
    return { mimeType: 'image/jpeg', data: sheet.jpeg.toString('base64'), times, columns: Math.min(cols, n), width: sheet.width, height: sheet.height };
  }

  // ------------------------------------------------------------------ shorts
  private async shortIds() { return (await readdir(path.join(this.root, 'shorts')).catch(() => [] as string[])).filter(id => ID.test(id)); }
  private shortIndex() {
    if (this.shortsIndex) return Promise.resolve(this.shortsIndex);
    return this.shortsLoading ??= (async () => {
      const index = new Map<string, { short: ClipShort; render: ClipRender | null }>();
      await Promise.all((await this.shortIds()).map(async id => {
        const short = await readJson<ClipShort>(path.join(this.shortDir(id), 'short.json'));
        if (short && short.id === id) index.set(id, { short, render: await readJson<ClipRender>(path.join(this.shortDir(id), 'render.json')) });
      }));
      return this.shortsIndex = index;
    })();
  }
  // The writes that change a short or its render keep the index in step. While the index is still being read from disk the change
  // is applied right after it, on top of whatever the read saw.
  private inIndex(change: (index: Map<string, { short: ClipShort; render: ClipRender | null }>) => void) {
    if (this.shortsIndex) change(this.shortsIndex); else if (this.shortsLoading) void this.shortsLoading.then(change);
  }
  private rememberShort(short: ClipShort) { const copy = structuredClone(short); this.inIndex(index => index.set(copy.id, { short: copy, render: index.get(copy.id)?.render ?? null })); }
  private rememberRender(id: string, render: ClipRender) { const copy = { ...render }; this.inIndex(index => { const known = index.get(id); if (known) known.render = copy; }); }
  private forgetShort(id: string) { this.inIndex(index => { index.delete(id); }); }
  async listShorts(sourceId?: string) {
    await this.init();
    const all = [...(await this.shortIndex()).values()].map(({ short: s, render: r }) => {
      if (sourceId && s.sourceId !== sourceId) return null;
      return { id: s.id, sourceId: s.sourceId, name: s.name, mode: s.mode, revision: s.revision, updated: s.updated, created: s.created, seconds: Math.round(estimateShortSeconds(s) * 10) / 10,
        render: r ? { status: r.status, revision: r.revision, progress: r.progress, duration: r.duration, current: r.revision === s.revision } : null };
    });
    return all.filter(<T,>(x: T | null): x is T => !!x).sort((a, b) => b.created - a.created);
  }
  async getShort(id: string) {
    const short = await readJson<ClipShort>(path.join(this.shortDir(id), 'short.json'));
    if (!short || short.id !== id) throw new ClipError('This short was not found.', 404);
    return short;
  }
  async shortDetail(id: string) {
    const short = await this.getShort(id), src = await this.getSource(short.sourceId).catch(() => null), t = await this.transcript(short.sourceId).catch(() => null);
    const render = await readJson<ClipRender>(path.join(this.shortDir(id), 'render.json'));
    const timeline = t ? buildTimeline(short, t, { fps: src?.fps || 30, keywords: await this.keywordsFor(short), voiceEstimate: true }) : null;
    const usage = await this.gemini.ledger.summary();
    const voiceText = short.segments.filter(s => s.kind === 'voice' && !s.audio).map(s => (s as { text: string }).text).join(' ');
    return { short, render, source: src ? { id: src.id, title: src.title, duration: src.duration, creator: src.creator, rights: src.rights.basis, url: src.url } : null,
      timeline: timeline ? { duration: timeline.duration, removed: timeline.removed, words: timeline.words.slice(0, 4000).map(w => ({ key: w.key, text: w.text, s: w.s, e: w.e, emphasis: w.emphasis })) } : null,
      costUsd: usage.byShort[id] ?? 0, voiceEstimateUsd: voiceText ? estimateSpeechCost(short.voice.model, voiceText).usd : 0 };
  }
  private async keywordsFor(short: ClipShort) {
    if (!short.momentId) return [];
    for (const set of await this.momentSets(short.sourceId)) { const m = set.moments.find(x => x.id === short.momentId); if (m) return m.keywords; }
    return [];
  }
  /** The genre the short's moment was found with, else the studio default (auto layout reads gaming as face cam on top). */
  private async genreFor(short: ClipShort): Promise<ClipGenre> {
    for (const set of short.momentId ? await this.momentSets(short.sourceId) : []) if (set.moments.some(m => m.id === short.momentId)) return set.genre;
    return (await this.settings()).genre;
  }
  private updateShort(id: string, revision: unknown, change: (s: ClipShort) => ClipShort | Promise<ClipShort>) {
    return this.serial(`short:${id}`, async () => {
      const current = await this.getShort(id);
      if (revision !== undefined && revision !== current.revision) throw new ClipError('This short changed in another window or by an agent. Reload it first.', 409);
      const next = await change(structuredClone(current));
      next.revision = current.revision + 1; next.updated = Date.now();
      await writeJson(path.join(this.shortDir(id), 'short.json'), next);
      this.rememberShort(next);
      return next;
    });
  }
  private creditFor(src: ClipSource) {
    if (src.rights.basis === 'own') return '';
    const site = siteLabel(src.site), who = src.creator?.name;
    return who ? `Credit: ${who}${site ? ` · ${site}` : ''}` : site ? `Source: ${site}` : '';
  }
  private postFor(src: ClipSource, title: string, hashtags: string[]) {
    const credit = src.rights.basis === 'own' ? '' : `\n\nOriginal: "${src.title}"${src.creator ? ` by ${src.creator.name}` : ''}${src.url ? ` — ${src.url}` : ''}`;
    return { title: title.slice(0, CLIP_LIMITS.titleChars), description: `${title}${credit}`.slice(0, CLIP_LIMITS.descriptionChars), hashtags: hashtags.slice(0, CLIP_LIMITS.hashtags) };
  }
  async createShort(body: unknown) {
    await this.init();
    const v = (body ?? {}) as Record<string, unknown>;
    for (const key of Object.keys(v)) if (!['sourceId', 'momentId', 'start', 'end', 'mode', 'name', 'segments', 'options', 'teaser', 'render'].includes(key)) throw new ClipError(`Unsupported field: ${key}.`);
    if (typeof v.sourceId !== 'string') throw new ClipError('sourceId is required.');
    if (v.render === true) this.admit();
    const src = await this.getSource(v.sourceId), t = await this.transcript(src.id), d = await this.settings();
    if ((await this.listShorts(src.id)).length >= CLIP_LIMITS.shortsPerSource) throw new ClipError('This source has the maximum number of shorts. Delete some first.');
    let moment: ClipMoment | null = null;
    if (typeof v.momentId === 'string') { for (const set of await this.momentSets(src.id)) { moment = set.moments.find(m => m.id === v.momentId) ?? null; if (moment) break; } if (!moment) throw new ClipError('That moment was not found. Find moments again.', 404); }
    const start = moment ? moment.start : Number(v.start), end = moment ? moment.end : Number(v.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end > src.duration + .5 || end - start < CLIP_LIMITS.minShortSeconds || end - start > CLIP_LIMITS.shortSeconds) throw new ClipError(`Choose a moment, or start/end seconds ${CLIP_LIMITS.minShortSeconds}-${CLIP_LIMITS.shortSeconds} s apart inside the video.`);
    const mode = v.mode === 'commentary' ? 'commentary' : v.mode === undefined || v.mode === 'clip' ? 'clip' : (() => { throw new ClipError('mode must be clip or commentary.'); })();
    const range = { start, end: Math.min(end, src.duration) };
    const segments: ClipSegment[] = v.segments !== undefined ? validateSegments(v.segments, src.duration) : mode === 'commentary' ? templateScript(t, range, { creator: src.creator?.name ?? '', title: src.title }) : [{ id: segmentId(), kind: 'source', start: range.start, end: range.end }];
    const name = cleanText(v.name ?? moment?.title ?? src.title, CLIP_LIMITS.titleChars, 'Name') || 'Short';
    let short = newShort({ id: randomUUID(), sourceId: src.id, name, mode: segments.some(s => s.kind === 'voice') ? 'commentary' : 'clip', segments, defaults: d, creditText: this.creditFor(src),
      momentId: moment?.id ?? null, teaser: v.teaser === true && moment?.teaser ? moment.teaser : null, hook: moment?.hook ?? '', post: this.postFor(src, moment?.title ?? name, moment?.hashtags ?? []) });
    if (src.rights.basis === 'own') short.overlays.credit = false;
    if (v.options !== undefined) short = applyShortPatch(short, v.options, src.duration);
    await writeJson(path.join(this.shortDir(short.id), 'short.json'), short);
    this.rememberShort(short);
    const job = v.render === true ? await this.render(short.id, { revision: short.revision }) : null;
    return { short, job };
  }
  async saveShort(id: string, body: unknown) {
    const v = (body ?? {}) as Record<string, unknown>, { revision, ...patch } = v;
    if (!Number.isInteger(revision)) throw new ClipError('Pass the short revision you edited.');
    const short = await this.getShort(id), src = await this.getSource(short.sourceId);
    return this.updateShort(id, revision, s => applyShortPatch(s, patch, src.duration));
  }
  async deleteShort(id: string) {
    await this.getShort(id);
    for (const j of this.jobList({ shortId: id })) if (j.status === 'running' || j.status === 'queued') this.cancelJob(j.id);
    await this.vault.purge({ scope: this.root, shortId: id });
    await rm(this.shortDir(id), { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    this.forgetShort(id);
    return { deleted: id };
  }
  /** Commentary script: template (offline) immediately, or a job with Gemini / Codex / Claude Code. */
  async writeScript(id: string, body: unknown) {
    const v = (body ?? {}) as Record<string, unknown>;
    for (const key of Object.keys(v)) if (!['engine', 'style', 'seconds', 'notes', 'revision', 'userRequestedGeneration'].includes(key)) throw new ClipError(`Unsupported field: ${key}.`);
    const short = await this.getShort(id), src = await this.getSource(short.sourceId), t = await this.transcript(src.id);
    const sources = short.segments.filter(s => s.kind === 'source') as { start: number; end: number }[];
    const range = sources.length ? { start: Math.min(...sources.map(s => s.start)), end: Math.max(...sources.map(s => s.end)) } : { start: (short.segments[0] as { broll: number }).broll, end: (short.segments[0] as { broll: number }).broll + 30 };
    const style = (v.style ?? 'reaction') as ClipScriptStyle;
    if (!SCRIPT_STYLES.includes(style)) throw new ClipError(`style must be one of ${SCRIPT_STYLES.join(', ')}.`);
    const seconds = v.seconds === undefined ? 45 : Number(v.seconds);
    if (!Number.isFinite(seconds) || seconds < 10 || seconds > 150) throw new ClipError('seconds must be 10-150.');
    const engine = v.engine ?? 'template';
    if (engine === 'template') return { short: await this.updateShort(id, v.revision, s => ({ ...s, mode: 'commentary', segments: templateScript(t, range, { creator: src.creator?.name ?? '', title: src.title }) })), job: null };
    if (!CLIP_AI_ENGINES.includes(engine as ClipAIEngine)) throw new ClipError('engine must be template, gemini, codex or claude.');
    if (v.userRequestedGeneration !== true) throw new ClipError('Writing a script with AI uses your API key or subscription. Pass userRequestedGeneration: true when the creator asked for it.');
    const settings = await this.settings(), prompt = buildScriptPrompt(t, range, { title: src.title, creator: src.creator?.name ?? '', style, seconds, language: settings.language, notes: cleanText(v.notes ?? '', CLIP_LIMITS.promptChars, 'Notes') });
    const job = this.startJob('script', { sourceId: src.id, shortId: id }, async (_job, signal, progress) => {
      progress(.1, 'script', 'Writing the script…');
      const answer = await this.ai(engine as ClipAIEngine, { system: SCRIPT_INSTRUCTIONS, prompt, schema: SCRIPT_SCHEMA, kind: 'script', sourceId: src.id, shortId: id }, signal);
      const script = parseScriptReply(answer.text, t, range);
      const saved = await this.updateShort(id, undefined, s => ({ ...s, mode: 'commentary', segments: script.segments, hook: { ...s.hook, enabled: !!script.hook, text: script.hook || s.hook.text },
        name: script.title || s.name, post: { title: script.title || s.post.title, description: `${script.description}${this.postFor(src, '', []).description}`.slice(0, CLIP_LIMITS.descriptionChars), hashtags: script.hashtags.length ? script.hashtags : s.post.hashtags } }));
      return { short: saved, model: answer.model, usage: answer.usage };
    });
    return { short, job, estimateUsd: engine === 'gemini' ? estimateTextCost(prompt.length + SCRIPT_INSTRUCTIONS.length, 1500) : 0 };
  }

  // ------------------------------------------------------------------ voiceover (Gemini 3.8 TTS)
  async voiceover(id: string, body: unknown) {
    const v = (body ?? {}) as { revision?: unknown; userRequestedGeneration?: unknown };
    const short = await this.getShort(id);
    if (v.revision !== undefined && v.revision !== short.revision) throw new ClipError('This short changed. Reload it first.', 409);
    const lines = short.segments.filter((s): s is Extract<ClipSegment, { kind: 'voice' }> => s.kind === 'voice' && !s.audio);
    if (!lines.length) throw new ClipError('Every voice line already has audio.');
    if (v.userRequestedGeneration !== true) throw new ClipError('Voiceovers use your Gemini API key (billed per second of audio). Pass userRequestedGeneration: true when the creator asked for it.');
    if (!(await this.gemini.keys.get())) throw new ClipError('Voiceovers are not set up on this server (GEMINI_API_KEY is missing).', 412);
    const estimate = estimateSpeechCost(short.voice.model, lines.map(l => l.text).join(' '));
    const job = this.startJob('voice', { sourceId: short.sourceId, shortId: id }, async (_job, signal, progress) => {
      const tools = await this.tools(), cache = path.join(this.root, 'voice-cache');
      await mkdir(cache, { recursive: true });
      let k = 0;
      for (const line of lines) {
        progress(k / lines.length, 'voice', `Voicing line ${k + 1} of ${lines.length}…`);
        const style = [short.voice.style, line.style].filter(Boolean).join('; ').slice(0, 200);
        const key = keyOf({ m: short.voice.model, v: short.voice.voice, s: style, t: line.text }), file = path.join(cache, `${key}.wav`);
        // Identical lines (same text, voice and style) are reused from the cache: no second charge.
        if (!await exists(file)) {
          const speech = await this.lane('ai', signal, () => this.gemini.speech({ model: short.voice.model, text: line.text, style, voice: short.voice.voice, signal, sourceId: short.sourceId, shortId: id }));
          await writeFile(file, speech.wav);
        }
        const words = await this.alignVoice(tools, file, line.text, signal);
        const duration = await probeMedia(file).then(i => i.duration);
        await this.updateShort(id, undefined, s => ({ ...s, segments: s.segments.map(seg => seg.id === line.id && seg.kind === 'voice' && seg.text === line.text ? { ...seg, audio: { key, file, duration, words, model: short.voice.model, voice: short.voice.voice, created: Date.now() } } : seg) }));
        k++;
      }
      return { short: await this.getShort(id) };
    });
    return { job, estimateUsd: estimate.usd, estimateSeconds: Math.round(estimate.seconds) };
  }
  /** Word times for a voice line: whisper on the generated audio, matched to the script's words (script text wins). */
  private async alignVoice(tools: ClipTools, file: string, text: string, signal: AbortSignal): Promise<ClipWord[]> {
    // Gemini TTS sound tags (<laugh>, <short pause>) are performed, not shown in captions.
    const tokens = text.replace(/<[^<>]{1,40}>/g, ' ').split(/\s+/).filter(Boolean), wav = `${file}.16k.wav`;
    await extractWav(file, wav, { signal });
    try {
      const energy = await wavEnvelope(wav), duration = energy.length / 100;
      let heard: ClipWord[] = [];
      if (this.options.transcriber) heard = (await this.options.transcriber(wav, 'auto', signal)).words;
      else if (tools.whisper && tools.whisperModel) heard = wordsFromWhisper((await this.lane('gpu', signal, () => transcribe(tools, wav, { language: 'auto', prompt: text.slice(0, 200), signal, threads: this.whisperThreads(tools) }))).json as never, 0, energy);
      const norm = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
      const out: (ClipWord | null)[] = tokens.map(() => null);
      let j = 0;
      for (let i = 0; i < tokens.length; i++) for (let look = j; look < Math.min(heard.length, j + 4); look++) if (norm(heard[look].t) === norm(tokens[i]) && norm(tokens[i])) { out[i] = { t: tokens[i], s: heard[look].s, e: heard[look].e }; j = look + 1; break; }
      // Unmatched words share the time between their matched neighbours by length; with no match at all, the speech span.
      const thr = speechThreshold(energy), silences = silentRuns(energy, 0, duration, thr, .2);
      const speechStart = silences[0]?.s === 0 ? silences[0].e : 0, speechEnd = silences.length && Math.abs(silences[silences.length - 1].e - duration) < .05 ? silences[silences.length - 1].s : duration;
      for (let i = 0; i < out.length;) {
        if (out[i]) { i++; continue; }
        let k = i; while (k < out.length && !out[k]) k++;
        const from = i ? out[i - 1]!.e : speechStart, to = k < out.length ? out[k]!.s : speechEnd, chars = tokens.slice(i, k).reduce((n, w) => n + w.length + 1, 0);
        let at = from;
        for (let m = i; m < k; m++) { const d = (to - from) * (tokens[m].length + 1) / Math.max(1, chars); out[m] = { t: tokens[m], s: Math.round(at * 1000) / 1000, e: Math.round((at + d * .92) * 1000) / 1000 }; at += d; }
        i = k;
      }
      return out as ClipWord[];
    } finally { await rm(wav, { force: true }); }
  }

  // ------------------------------------------------------------------ render
  async render(id: string, body: unknown) {
    const v = (body ?? {}) as { revision?: unknown };
    const short = await this.getShort(id);
    if (v.revision !== undefined && v.revision !== short.revision) throw new ClipError('This short changed. Reload it first.', 409);
    if (short.segments.some(s => s.kind === 'voice' && !s.audio)) throw new ClipError('Generate the voiceover first (some voice lines have no audio).', 409);
    if (!(await this.tools()).ffmpeg) throw new ClipError('Rendering is not set up on this server (FFmpeg is missing).', 503);
    const running = this.jobList({ shortId: id }).find(j => j.kind === 'render' && (j.status === 'queued' || j.status === 'running'));
    if (running) return running;
    this.admit(); // before anything is written: a render that is refused must not be left looking queued
    const dir = this.shortDir(id), started = Date.now();
    const state: ClipRender = { revision: short.revision, status: 'queued', progress: 0, started, finished: null, error: null, duration: 0, bytes: 0, width: 0, height: 0, encoder: null, warnings: [] };
    await writeJson(path.join(dir, 'render.json'), state); this.rememberRender(id, state);
    return this.startJob('render', { sourceId: short.sourceId, shortId: id }, async (_job, signal, progress) => {
      const save = async (patch: Partial<ClipRender>) => { await writeJson(path.join(dir, 'render.json'), Object.assign(state, patch)); this.rememberRender(id, state); };
      try {
        const src = await this.getSource(short.sourceId), t = await this.transcript(src.id), tools = await this.tools();
        const timeline = buildTimeline(short, t, { fps: normalizeFps(src.fps), keywords: await this.keywordsFor(short) });
        // Footage: only the ranges this short shows (downloaded now for link sources).
        progress(.03, 'footage', 'Getting the footage…'); await save({ status: 'rendering', progress: .03 });
        const ranges = mergeRanges(timeline.pieces.map(p => ({ s: p.src, e: p.src + p.dur })), 8);
        const spans: MediaSpan[] = [];
        for (const r of ranges) spans.push(await this.ensureRange(src.id, r.s, r.e, signal));
        const [W, H] = CLIP_ASPECTS[short.aspect], base = spans[0];
        let track: FaceTrackFile | null = null;
        const warnings: string[] = [];
        if (short.layout !== 'fit' && short.layout !== 'center') {
          progress(.12, 'faces', 'Finding the speakers…');
          track = await this.lane('track', signal, () => this.ensureTrack(src.id, ranges, spans, signal, f => progress(.12 + f * .3, 'faces'), { jobId: _job.id, shortId: id })).catch(e => { if (signal.aborted) throw e; warnings.push(`Face tracking failed (${publicMessage(e)}); the crop stays centred.`); return null; });
        }
        const camera = planCamera({ track, words: t.words, layout: short.layout, subject: short.subject ?? 'auto', srcW: base.width, srcH: base.height, outW: W, outH: H, energy: await this.energy(src.id), genre: await this.genreFor(short) });
        warnings.push(...camera.notes.filter(note => !(warnings.length && /unavailable/.test(note))));
        const ass = buildAss({ timeline, short, hookText: short.hook.text, creditText: short.overlays.creditText, measure: fontMeasurer(tools.fonts), stage: captionStage(camera, track?.samples ?? [], timeline) });
        progress(.45, 'render', 'Rendering…');
        const out = path.join(dir, 'output.mp4');
        const result = await this.lane('render', signal, () => renderShort({ short, timeline, camera, spans, ass, workDir: path.join(dir, 'work'), fontsDir: tools.fonts, out,
          encoder: tools.nvenc ? 'nvenc' : 'x264', hwaccel: tools.nvenc, signal, threads: Math.max(2, Math.floor((os.availableParallelism?.() ?? os.cpus().length) / this.scheduler.capacity.render)), onProgress: f => { progress(.45 + f * .5, 'render'); void save({ progress: .45 + f * .5 }).catch(() => {}); } }));
        await coverFrame(out, path.join(dir, 'cover.jpg'), short.hook.enabled && short.hook.text ? Math.min(timeline.duration / 2, short.hook.seconds * .6) : Math.min(1.5, timeline.duration / 3));
        await writeFile(path.join(dir, 'captions.srt'), buildSrt(timeline.words), 'utf8');
        // The reel is delivered: no frame of this video is left on the server by the time it is reported ready.
        await this.vault.purge({ scope: this.root, jobId: _job.id });
        await save({ status: 'done', progress: 1, finished: Date.now(), duration: timeline.duration, bytes: result.bytes, width: result.width, height: result.height, encoder: result.encoder, warnings });
        return { render: { ...state }, seconds: (Date.now() - started) / 1000 };
      } catch (error) {
        await this.vault.purge({ scope: this.root, jobId: _job.id });
        await save({ status: 'failed', error: signal.aborted ? 'Cancelled.' : publicMessage(error), finished: Date.now() }).catch(() => {});
        throw error;
      }
    });
  }
  /** Renders several moments in one go (the "clip it all" button and agents' batch requests). */
  async batch(body: unknown) {
    const v = (body ?? {}) as { sourceId?: unknown; momentIds?: unknown; options?: unknown; teaser?: unknown };
    if (typeof v.sourceId !== 'string' || !Array.isArray(v.momentIds) || !v.momentIds.length || v.momentIds.length > 20) throw new ClipError('Pass sourceId and 1-20 momentIds.');
    this.admit(v.momentIds.length);
    const out: { short: ClipShort; job: ClipJob | null }[] = [];
    for (const momentId of v.momentIds) out.push(await this.createShort({ sourceId: v.sourceId, momentId, render: true, ...(v.options ? { options: v.options } : {}), ...(v.teaser === true ? { teaser: true } : {}) }));
    return { shorts: out };
  }
  async outputFile(id: string, kind: 'video' | 'cover' | 'srt') {
    await this.getShort(id);
    const file = path.join(this.shortDir(id), kind === 'video' ? 'output.mp4' : kind === 'cover' ? 'cover.jpg' : 'captions.srt');
    const info = await stat(file).catch(() => null);
    if (!info) throw new ClipError('Render this short first.', 404);
    return { path: file, size: info.size, mtimeMs: info.mtimeMs };
  }
  private postText(short: ClipShort, src: ClipSource | null) {
    const tags = short.post.hashtags.map(h => `#${h}`).join(' ');
    return [`TITLE\n${short.post.title}`, `DESCRIPTION\n${short.post.description}`, tags ? `HASHTAGS\n${tags}` : '', src && src.rights.basis !== 'own' ? `CREDIT\n${short.overlays.creditText || src.title}${src.url ? `\n${src.url}` : ''}\nRights basis: ${src.rights.basis}${src.rights.note ? ` (${src.rights.note})` : ''}` : ''].filter(Boolean).join('\n\n') + '\n';
  }
  async exportZip(id: string) {
    const short = await this.getShort(id), dir = this.shortDir(id), r = await readJson<ClipRender>(path.join(dir, 'render.json'));
    if (!r || r.status !== 'done') throw new ClipError('Render this short first.', 409);
    const src = await this.getSource(short.sourceId).catch(() => null), safe = fileSafe(short.name, 'short');
    const files: Record<string, Uint8Array> = {
      [`${safe}.mp4`]: new Uint8Array(await readFile(path.join(dir, 'output.mp4'))), [`${safe}.srt`]: new Uint8Array(await readFile(path.join(dir, 'captions.srt'))),
      'post.txt': strToU8(this.postText(short, src)), 'short.json': strToU8(JSON.stringify({ ...short, render: r }, null, 2)),
    };
    if (await exists(path.join(dir, 'cover.jpg'))) files['cover.jpg'] = new Uint8Array(await readFile(path.join(dir, 'cover.jpg')));
    return { name: `${safe}.zip`, data: zipSync(files, { level: 0 }) };
  }
  /** Every rendered short of a source in one download: a folder per short (MP4, subtitles, cover, post text) and
   * posts.csv for bulk scheduling. The bridge streams the files from disk, so a large batch never sits in memory. */
  async exportSource(id: string) {
    const src = await this.getSource(id), rendered = (await this.listShorts(id)).filter(s => s.render?.status === 'done');
    if (!rendered.length) throw new ClipError('Render at least one short from this video first.', 409);
    const entries: { name: string; file?: string; data?: Uint8Array }[] = [], used = new Set<string>();
    const rows = [['folder', 'video', 'seconds', 'title', 'description', 'hashtags', 'edited_since_render']];
    for (const summary of rendered) {
      const short = await this.getShort(summary.id), dir = this.shortDir(summary.id);
      let folder = fileSafe(short.name, 'short');
      for (let k = 2; used.has(folder); k++) folder = `${fileSafe(short.name, 'short').slice(0, 56)}-${k}`;
      used.add(folder);
      entries.push({ name: `${folder}/${folder}.mp4`, file: path.join(dir, 'output.mp4') });
      if (await exists(path.join(dir, 'captions.srt'))) entries.push({ name: `${folder}/${folder}.srt`, file: path.join(dir, 'captions.srt') });
      if (await exists(path.join(dir, 'cover.jpg'))) entries.push({ name: `${folder}/cover.jpg`, file: path.join(dir, 'cover.jpg') });
      entries.push({ name: `${folder}/post.txt`, data: strToU8(this.postText(short, src)) });
      rows.push([folder, `${folder}/${folder}.mp4`, (summary.render?.duration ?? 0).toFixed(1), short.post.title, short.post.description, short.post.hashtags.map(h => `#${h}`).join(' '), summary.render?.current ? 'no' : 'yes']);
    }
    // Spreadsheet cells that start with = + - @ would run as formulas: they get a leading apostrophe.
    const cell = (v: string) => { const x = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v; return /[",\n\r]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x; };
    entries.push({ name: 'posts.csv', data: strToU8(`\ufeff${rows.map(r => r.map(cell).join(',')).join('\r\n')}\r\n`) });
    return { name: `${fileSafe(src.title, 'video')}-shorts.zip`, entries };
  }

  // ------------------------------------------------------------------ face tracking (headless worker page)
  private async ensureTrack(sourceId: string, ranges: { s: number; e: number }[], spans: MediaSpan[], signal: AbortSignal, onProgress: (f: number) => void, owner: { jobId: string; shortId: string }): Promise<FaceTrackFile | null> {
    const key = keyOf(ranges.map(r => [Math.round(r.s * 10), Math.round(r.e * 10)])), file = path.join(this.sourceDir(sourceId), 'tracks', `${key}.json`);
    const cached = await readJson<FaceTrackFile>(file);
    // Version 1 files have faces only: they are tracked again so faceless shots can follow a subject.
    if (cached?.format === 'sprityreels-face-track' && cached.version >= 2) return cached;
    const browser = await this.launcher.find();
    if (!browser) throw new ClipError('face tracking needs Chrome, Edge or Chromium', 503);
    // The tracker page reads these frames over HTTP, so they are files, but only inside a vault lease: removed when tracking
    // ends (below), when the render ends, if the reel or video is deleted, at the time limit, and at the next start.
    const jobId = randomUUID(), lease = await this.vault.open({ scope: this.root, sourceId, shortId: owner.shortId, jobId: owner.jobId, label: 'face-tracking frames' }), frameDir = lease.dir;
    // Frames a second the tracker looks at (SPRITYREELS_TRACK_FPS, 2 to 15): the camera path is smoothed, so fewer is cheaper and a little looser.
    const fps = Number.isInteger(Number(process.env.SPRITYREELS_TRACK_FPS)) && Number(process.env.SPRITYREELS_TRACK_FPS) >= 2 && Number(process.env.SPRITYREELS_TRACK_FPS) <= 15 ? Number(process.env.SPRITYREELS_TRACK_FPS) : 8;
    const frames: TrackRun['frames'] = [], scenes: number[] = [];
    let width = 0, height = 0;
    try {
      for (const [k, r] of ranges.entries()) {
        const span = spans.find(s => s.start <= r.s + .05 && s.end >= r.e - .05) ?? spans[0];
        // Every frame's scene score goes to a file (relative paths: the working folder is the frame folder, so no drive
        // letter reaches the filter syntax); the adaptive detector then finds soft cuts and ignores fast motion. The first
        // frame always passes: FFmpeg fails an output that receives no frames.
        await run('ffmpeg', ['-nostdin', '-hide_banner', '-v', 'error', '-y', '-ss', (r.s - span.offset).toFixed(3), '-t', (r.e - r.s).toFixed(3), '-i', span.file,
          '-filter_complex', `[0:v]split=2[a][b];[a]fps=${fps},scale='min(960,iw)':-2[f];[b]scale=160:-2,select='eq(n\\,0)+gte(scene\\,0)',metadata=print:key=lavfi.scene_score:file=scene${k}.txt[s]`,
          '-map', '[f]', '-q:v', '4', `r${k}_%05d.jpg`, '-map', '[s]', '-f', 'null', '-'], { timeout: 1800_000, signal, cwd: frameDir });
        const scores = parseSceneScores(await readFile(path.join(frameDir, `scene${k}.txt`), 'utf8').catch(() => ''));
        const rate = scores.length > 1 ? (scores.length - 1) / Math.max(.01, scores[scores.length - 1].t - scores[0].t) : 30;
        for (const cut of sceneCuts(scores, rate)) if (cut > .05) scenes.push(r.s + cut);
        await rm(path.join(frameDir, `scene${k}.txt`), { force: true });
        const names = (await readdir(frameDir)).filter(n => n.startsWith(`r${k}_`)).sort();
        names.forEach((n, i) => frames.push({ n: frames.length, t: Math.round((r.s + i / fps) * 1000) / 1000, file: path.join(frameDir, n) }));
        width = span.width; height = span.height;
      }
      if (!frames.length) return null;
      const samples = await new Promise<{ samples: FaceSample[]; delegate: 'GPU' | 'CPU' | 'none'; objects: boolean }>((resolve, reject) => {
        const runState: TrackRun = { id: jobId, frames, width, height, samples: [], delegate: 'none', done: 0, objects: false, run: null,
          timer: setTimeout(() => finish(false, 'The face tracker stopped responding.'), 90_000),
          resolve: (ok, error) => finish(ok, error) };
        const finish = (ok: boolean, error?: string) => {
          if (!this.trackRuns.has(jobId)) return;
          this.trackRuns.delete(jobId); clearTimeout(runState.timer);
          void runState.run?.stop();
          if (ok) resolve({ samples: runState.samples, delegate: runState.delegate, objects: runState.objects }); else reject(new ClipError(error ?? 'Face tracking failed.'));
        };
        this.trackRuns.set(jobId, runState);
        signal.addEventListener('abort', () => finish(false, 'Cancelled.'), { once: true });
        const progressTimer = setInterval(() => { if (!this.trackRuns.has(jobId)) clearInterval(progressTimer); else onProgress(runState.done / Math.max(1, frames.length)); }, 500);
        this.launcher.open(browser, `${this.origin}/?view=clip-worker&job=${jobId}`).then(r => { runState.run = r; if (!this.trackRuns.has(jobId)) void r.stop(); }, e => finish(false, e instanceof Error ? e.message : 'The browser could not start.'));
      });
      const track: FaceTrackFile = { format: 'sprityreels-face-track', version: 2, width, height, fps, delegate: samples.delegate, objects: samples.objects, ranges: ranges.map(r => ({ ...r })), samples: samples.samples.sort((a, b) => a.t - b.t), scenes: [...new Set(scenes.map(s => Math.round(s * 1000) / 1000))].sort((a, b) => a - b) };
      await writeJson(file, track);
      return track;
    } finally { await this.vault.release(lease); }
  }
  trackJob(jobId: string) {
    const r = this.trackRuns.get(jobId);
    if (!r) throw new ClipError('This tracking job is not running.', 404);
    return { id: r.id, frames: r.frames.map(f => ({ n: f.n, t: f.t })), width: r.width, height: r.height };
  }
  trackFrame(jobId: string, n: number) {
    const r = this.trackRuns.get(jobId), f = r?.frames[n];
    if (!r || !f) throw new ClipError('Unknown frame.', 404);
    return f.file;
  }
  trackSamples(jobId: string, body: unknown) {
    const r = this.trackRuns.get(jobId), v = (body ?? {}) as { samples?: unknown; done?: unknown; delegate?: unknown; objects?: unknown };
    if (!r) throw new ClipError('This tracking job is not running.', 409);
    if (!Array.isArray(v.samples) || v.samples.length > 500) throw new ClipError('Send up to 500 samples at a time.');
    for (const raw of v.samples) {
      const s = raw as FaceSample;
      if (typeof s?.t !== 'number' || !Array.isArray(s.faces) || s.faces.length > 8) continue;
      const num = (x: unknown) => typeof x === 'number' && Number.isFinite(x) ? Math.max(-1, Math.min(2, x)) : 0;
      const sample: FaceSample = { t: s.t, faces: s.faces.map(f => ({ x: num(f.x), y: num(f.y), w: num(f.w), h: num(f.h), jaw: num(f.jaw), mouth: num(f.mouth), score: num(f.score) })) };
      if (Array.isArray(s.objects)) sample.objects = s.objects.slice(0, 16).filter(o => (OBJECT_KINDS as readonly string[]).includes(o?.kind)).map(o => ({ x: num(o.x), y: num(o.y), w: num(o.w), h: num(o.h), score: num(o.score), kind: o.kind }));
      const m = s.motion;
      if (m && typeof m === 'object') sample.motion = { x: num(m.x), y: num(m.y), w: num(m.w), h: num(m.h), level: typeof m.level === 'number' && Number.isFinite(m.level) ? Math.max(0, Math.min(255, Math.round(m.level))) : 0 };
      r.samples.push(sample);
    }
    if (Number.isInteger(v.done)) r.done = v.done as number;
    if (v.delegate === 'GPU' || v.delegate === 'CPU') r.delegate = v.delegate;
    if (v.objects === true) r.objects = true;
    clearTimeout(r.timer); r.timer = setTimeout(() => r.resolve(false, 'The face tracker stopped responding.'), 90_000);
    return { received: r.samples.length };
  }
  trackFinish(jobId: string, body: unknown) {
    const r = this.trackRuns.get(jobId), v = (body ?? {}) as { ok?: unknown; error?: unknown };
    if (!r) throw new ClipError('This tracking job is not running.', 409);
    r.resolve(v.ok === true, typeof v.error === 'string' ? v.error.slice(0, 300) : undefined);
    return { ok: true };
  }
  async dispose() {
    for (const j of this.jobs.values()) j.abort?.abort();
    for (const r of this.trackRuns.values()) r.resolve(false, 'The server is shutting down.');
    await this.vault.purge({ scope: this.root });
    if (this.ownFrames) await this.vault.close();
    for (const d of Object.values(this.directors)) d?.dispose();
  }
  /** The Gemini 3.8 TTS prebuilt voices with Google's character notes. */
  static voices() { return Object.entries(TTS_VOICES).map(([name, note]) => ({ name, note })); }
}

function mergeRanges(ranges: { s: number; e: number }[], gap: number) {
  const out: { s: number; e: number }[] = [];
  for (const r of [...ranges].sort((a, b) => a.s - b.s)) { const last = out[out.length - 1]; if (last && r.s - last.e <= gap) last.e = Math.max(last.e, r.e); else out.push({ ...r }); }
  return out.map(r => ({ s: Math.round(r.s * 1000) / 1000, e: Math.round(r.e * 1000) / 1000 }));
}
/** Output frame rate: the source rate, snapped to a standard one (keeps 23.976/29.97/59.94 exact), at most 60. */
export function normalizeFps(fps: number) {
  const standard = [24000 / 1001, 24, 25, 30000 / 1001, 30, 50, 60000 / 1001, 60];
  if (!(fps > 0)) return 30;
  const best = standard.reduce((a, b) => Math.abs(b - fps) < Math.abs(a - fps) ? b : a);
  return Math.abs(best - fps) < .05 ? Math.round(best * 1e6) / 1e6 : Math.min(60, Math.round(fps));
}
export function publicMessage(error: unknown) {
  if (error instanceof ClipError || error instanceof ClipInputError || error instanceof GeminiError || error instanceof ClipToolError) return error.message;
  if (error instanceof Error && /cancel/i.test(error.message)) return 'Cancelled.';
  return error instanceof Error ? error.message.replace(/[A-Z]:\\[^\s'"]+/g, '…').slice(0, 400) : 'Something went wrong.';
}
