import { CENSOR_LIMITS } from './censor';

/** Sprity Reels: shared data model for turning long videos (a link or an upload) into vertical shorts.
 * Everything here is plain data validated on both the server and the studio, so Codex / Claude Code (MCP),
 * the HTTP API and the UI all go through the same rules. */

export const CLIP_LIMITS = {
  sourceSeconds: 6 * 3600, uploadBytes: 20e9, sources: 300, shortsPerSource: 200,
  shortSeconds: 180, minShortSeconds: 3, segments: 80, voiceChars: 700, voiceTotalChars: 5000,
  hookChars: 90, titleChars: 100, descriptionChars: 2200, hashtags: 12, moments: 30, promptChars: 500,
  wordEdits: 3000, noteChars: 300, urlChars: 2048,
} as const;

export const CLIP_RIGHTS = ['own', 'permission', 'license', 'commentary'] as const;
export type ClipRights = typeof CLIP_RIGHTS[number];
export const CLIP_RIGHTS_LABELS: Record<ClipRights, string> = {
  own: 'My own content',
  permission: 'Creator permission or an official clipping program',
  license: 'Licensed or Creative Commons (attribution kept)',
  commentary: 'Commentary, criticism or news (I judge fair use myself)',
};

export const CLIP_GENRES = ['auto', 'podcast', 'interview', 'education', 'comedy', 'business', 'motivation', 'news', 'gaming', 'sports', 'vlog'] as const;
export type ClipGenre = typeof CLIP_GENRES[number];
export const CLIP_ENGINES = ['local', 'gemini', 'codex', 'claude', 'agent', 'manual'] as const;
export type ClipEngine = typeof CLIP_ENGINES[number];
export const CLIP_AI_ENGINES = ['gemini', 'codex', 'claude'] as const;
export type ClipAIEngine = typeof CLIP_AI_ENGINES[number];

export const CLIP_ASPECTS = { '9:16': [1080, 1920], '1:1': [1080, 1080], '4:5': [1080, 1350], '16:9': [1920, 1080] } as const;
export type ClipAspect = keyof typeof CLIP_ASPECTS;
export const CLIP_LAYOUTS = ['auto', 'tracked', 'split', 'gameplay', 'screen', 'fit', 'center'] as const;
export type ClipLayout = typeof CLIP_LAYOUTS[number];
/** What the crop follows. auto: the talking person where there are faces, else the main subject (a person, ball,
 * vehicle or animal) or the motion; speaker: faces only; a kind: that kind of object wherever it is found. */
export const CLIP_SUBJECTS = ['auto', 'speaker', 'person', 'ball', 'vehicle', 'animal', 'motion'] as const;
export type ClipSubject = typeof CLIP_SUBJECTS[number];
export const CAPTION_PRESETS = ['pop', 'karaoke', 'boxed', 'impact', 'neon', 'comic', 'minimal', 'playful'] as const;
export type CaptionPresetId = typeof CAPTION_PRESETS[number];
export const CLIP_ZOOM = ['off', 'cuts', 'rhythm'] as const;
export type ClipZoom = typeof CLIP_ZOOM[number];
export const CLIP_QUALITY = ['720', '1080', '2160'] as const;
export type ClipQuality = typeof CLIP_QUALITY[number];

export const TTS_MODELS = ['gemini-3.8-flash-tts', 'gemini-3.8-flash-lite-tts'] as const;
export type ClipTtsModel = typeof TTS_MODELS[number];
/** Gemini 3.8 TTS prebuilt voices with Google's one-word character notes. */
export const TTS_VOICES: Record<string, string> = {
  Zephyr: 'Bright', Puck: 'Upbeat', Charon: 'Informative', Kore: 'Firm', Fenrir: 'Excitable', Leda: 'Youthful', Orus: 'Firm', Aoede: 'Breezy',
  Callirrhoe: 'Easy-going', Autonoe: 'Bright', Enceladus: 'Breathy', Iapetus: 'Clear', Umbriel: 'Easy-going', Algieba: 'Smooth', Despina: 'Smooth',
  Erinome: 'Clear', Algenib: 'Gravelly', Rasalgethi: 'Informative', Laomedeia: 'Upbeat', Achernar: 'Soft', Alnilam: 'Firm', Schedar: 'Even',
  Gacrux: 'Mature', Pulcherrima: 'Forward', Achird: 'Friendly', Zubenelgenubi: 'Casual', Vindemiatrix: 'Gentle', Sadachbia: 'Lively',
  Sadaltager: 'Knowledgeable', Sulafat: 'Warm',
};
export const SCRIPT_STYLES = ['recap', 'reaction', 'explainer', 'hot-take', 'storytime', 'news'] as const;
export type ClipScriptStyle = typeof SCRIPT_STYLES[number];

export type ClipWord = { t: string; s: number; e: number; p?: number };
export type ClipSentence = { s: number; e: number; a: number; b: number };
export type ClipTranscript = {
  format: 'sprityreels-clip-transcript'; version: 1; engine: 'whisper' | 'captions'; language: string; model: string | null;
  duration: number; words: ClipWord[]; sentences: ClipSentence[];
};

export type ClipStageStatus = 'pending' | 'running' | 'done' | 'skipped' | 'failed';
export type ClipStage = { status: ClipStageStatus; progress: number; message: string };
/** visual (the picture pass) is missing on sources imported before it existed. */
export type ClipStageId = 'probe' | 'captions' | 'audio' | 'transcript' | 'video' | 'visual';
export type ClipHeat = { s: number; e: number; v: number };
export type ClipChapter = { title: string; start: number; end: number };
export type ClipSource = {
  format: 'sprityreels-clip-source'; version: 1; id: string; revision: number; created: number; updated: number;
  kind: 'link' | 'upload'; title: string; url: string | null; site: string | null; videoId: string | null;
  creator: { name: string; url: string | null } | null; license: string | null; language: string | null;
  duration: number; width: number; height: number; fps: number; quality: ClipQuality;
  rights: { basis: ClipRights; note: string; confirmed: number };
  stages: Record<Exclude<ClipStageId, 'visual'>, ClipStage> & { visual?: ClipStage };
  status: 'working' | 'ready' | 'failed';
  transcript: { engine: 'whisper' | 'captions'; language: string; words: number; model: string | null; seconds: number } | null;
  /** proxy: a small (240-360p) video-only copy of a link, for the picture pass and contact sheets. */
  media: { full: boolean; file: string | null; bytes: number; audio: string | null; proxy?: string | null };
  heatmap: ClipHeat[]; chapters: ClipChapter[]; description: string;
  stats: { views: number | null; likes: number | null; uploaded: string | null };
  error: string | null;
};

export type ClipScores = { hook: number; flow: number; value: number; trend: number };
/** What the boundary repair checked: ok, fixed (by moving a boundary) or warn (could not fix inside the length limits). */
export type ClipCheck = { id: 'opening' | 'ending' | 'topic' | 'speech'; level: 'ok' | 'fixed' | 'warn'; text: string };
/** Audience reactions from a site's caption track ([Laughter], [Applause]…), at source seconds. */
export type ClipReaction = { t: number; kind: 'laughter' | 'applause' | 'cheering' };
export type ClipMoment = {
  id: string; start: number; end: number; score: number; scores: ClipScores; title: string; hook: string; reason: string;
  hashtags: string[]; keywords: string[]; teaser: { start: number; end: number } | null; engine: ClipEngine;
  /** talk: built from sentences; action: built around a peak in the sound or the picture (build-up, peak, reaction). */
  kind?: 'talk' | 'action'; checks?: ClipCheck[];
};
export type ClipMomentSet = {
  id: string; engine: ClipEngine; prompt: string; genre: ClipGenre; created: number; model: string | null;
  usage: { inputTokens: number; outputTokens: number; usd: number } | null; moments: ClipMoment[];
};

export type ClipVoiceAudio = { key: string; file: string; duration: number; words: ClipWord[]; model: string; voice: string; created: number };
export type ClipSegment =
  | { id: string; kind: 'source'; start: number; end: number }
  | { id: string; kind: 'voice'; text: string; style: string; broll: number; audio: ClipVoiceAudio | null };
/** position auto keeps captions off faces and between tiles; lower, middle and upper are fixed heights. */
export const CAPTION_POSITIONS = ['auto', 'lower', 'middle', 'upper'] as const;
export type ClipCaptions = { enabled: boolean; preset: CaptionPresetId; position: typeof CAPTION_POSITIONS[number]; size: number; highlight: string; emphasis: boolean; uppercase: boolean | null; maxWords: number };
export type ClipShort = {
  format: 'sprityreels-clip-short'; version: 1; id: string; sourceId: string; revision: number; created: number; updated: number;
  name: string; mode: 'clip' | 'commentary'; momentId: string | null;
  segments: ClipSegment[]; teaser: { start: number; end: number } | null;
  aspect: ClipAspect; layout: ClipLayout; captions: ClipCaptions;
  /** Missing on shorts made before subject following (auto). */
  subject?: ClipSubject;
  hook: { enabled: boolean; text: string; seconds: number };
  trim: { silence: boolean; fillers: boolean; maxPause: number };
  zoom: ClipZoom;
  overlays: { progress: boolean; credit: boolean; creditText: string };
  /** Swear words: masked in captions, bleeped or muted in the audio (built-in English list plus the creator's words). */
  censor: ClipCensor;
  audio: { sourceVolume: number; duckDb: number; normalize: boolean };
  voice: { model: ClipTtsModel; voice: string; style: string };
  wordEdits: Record<string, string>;
  post: { title: string; description: string; hashtags: string[] };
};
export type ClipRender = {
  revision: number; status: 'queued' | 'rendering' | 'done' | 'failed'; progress: number; started: number; finished: number | null;
  error: string | null; duration: number; bytes: number; width: number; height: number; encoder: string | null; warnings: string[];
};

export type ClipJobKind = 'import' | 'transcribe' | 'moments' | 'section' | 'track' | 'script' | 'voice' | 'render';
export type ClipJob = {
  id: string; kind: ClipJobKind; sourceId: string | null; shortId: string | null;
  status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled'; stage: string; progress: number; message: string;
  error: string | null; created: number; updated: number; result?: unknown;
  /** Set while the job waits for a free worker: how many steps start before it (0: it is next). */
  queue?: { lane: string; ahead: number } | null;
};

export type ClipCensor = { enabled: boolean; style: 'bleep' | 'mute'; words: string[] };
export const DEFAULT_CENSOR: ClipCensor = { enabled: false, style: 'bleep', words: [] };
export type ClipDefaults = {
  aspect: ClipAspect; layout: ClipLayout; subject: ClipSubject; captions: ClipCaptions; zoom: ClipZoom; quality: ClipQuality;
  trim: ClipShort['trim']; overlays: { progress: boolean; credit: boolean }; voice: ClipShort['voice']; censor: ClipCensor;
  hookSeconds: number; minSeconds: number; maxSeconds: number; count: number; genre: ClipGenre; language: string;
};
export const DEFAULT_CAPTIONS: ClipCaptions = { enabled: true, preset: 'pop', position: 'auto', size: 1, highlight: '#FFE600', emphasis: true, uppercase: null, maxWords: 0 };
export const DEFAULT_CLIP_SETTINGS: ClipDefaults = {
  aspect: '9:16', layout: 'auto', subject: 'auto', captions: DEFAULT_CAPTIONS, zoom: 'cuts', quality: '1080',
  trim: { silence: true, fillers: true, maxPause: .45 }, overlays: { progress: true, credit: true },
  voice: { model: 'gemini-3.8-flash-tts', voice: 'Puck', style: 'energetic, confident short-form narrator' },
  hookSeconds: 3, minSeconds: 20, maxSeconds: 60, count: 8, genre: 'auto', language: 'auto', censor: DEFAULT_CENSOR,
};

// ------------------------------------------------------------------ validation
export class ClipInputError extends Error {}
function fail(message: string): never { throw new ClipInputError(message); }
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
export const ID = /^[a-f0-9-]{36}$/;
export const SHORT_ID = /^[a-z0-9]{6,24}$/;
/** Removes control characters and collapses whitespace; the result is display text only. */
export function cleanText(value: unknown, max: number, field: string, allowEmpty = true) {
  if (value === undefined || value === null) { if (allowEmpty) return ''; fail(`${field} is required.`); }
  if (typeof value !== 'string') fail(`${field} must be text.`);
  const text = (value as string).replace(/[\u0000-\u001f\u007f-\u009f\p{Zl}\p{Zp}]+/gu, ' ').replace(/\s+/g, ' ').trim();
  if (!allowEmpty && !text) fail(`${field} is required.`);
  if (text.length > max) fail(`${field} must be at most ${max} characters.`);
  return text;
}
function num(value: unknown, min: number, max: number, field: string) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) fail(`${field} must be a number from ${min} to ${max}.`);
  return value as number;
}
function bool(value: unknown, field: string) { if (typeof value !== 'boolean') fail(`${field} must be true or false.`); return value as boolean; }
function pick<T extends string>(value: unknown, options: readonly T[], field: string) { if (!options.includes(value as T)) fail(`${field} must be one of: ${options.join(', ')}.`); return value as T; }
function only(v: Record<string, unknown>, keys: string[], field: string) { for (const key of Object.keys(v)) if (!keys.includes(key)) fail(`Unsupported field in ${field}: ${key}.`); }
const round3 = (x: number) => Math.round(x * 1000) / 1000;
export const HEX = /^#[0-9A-Fa-f]{6}$/;
export const normalizeHashtag = (tag: string) => tag.replace(/^#+/, '').replace(/[^\p{L}\p{N}_]/gu, '').slice(0, 40);

/** A link the studio may pass to yt-dlp: http(s) only, no credentials, never the studio itself. */
export function validateSourceUrl(value: unknown, allowLocal = false) {
  const text = cleanText(value, CLIP_LIMITS.urlChars, 'Link', false);
  let url: URL;
  try { url = new URL(text); } catch { return fail('Paste a full link that starts with https://.'); }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') fail('Only http and https links can be imported.');
  if (url.username || url.password) fail('Remove the user name or password from the link.');
  const host = url.hostname.toLowerCase();
  if (!allowLocal && (host === 'localhost' || host.endsWith('.localhost') || host === '0.0.0.0' || host === '[::1]' || host === '::1' || /^127\./.test(host))) fail('Links to private or local addresses cannot be imported. Upload the file instead.');
  return url.toString();
}

export function validateCaptions(value: unknown, base: ClipCaptions = DEFAULT_CAPTIONS): ClipCaptions {
  if (!isObject(value)) return fail('Caption settings must be an object.');
  only(value, ['enabled', 'preset', 'position', 'size', 'highlight', 'emphasis', 'uppercase', 'maxWords'], 'captions');
  const c = { ...base };
  if (value.enabled !== undefined) c.enabled = bool(value.enabled, 'captions.enabled');
  if (value.preset !== undefined) c.preset = pick(value.preset, CAPTION_PRESETS, 'captions.preset');
  if (value.position !== undefined) c.position = pick(value.position, CAPTION_POSITIONS, 'captions.position');
  if (value.size !== undefined) c.size = round3(num(value.size, .6, 1.5, 'captions.size'));
  if (value.highlight !== undefined) { if (typeof value.highlight !== 'string' || !HEX.test(value.highlight)) fail('captions.highlight must be a #RRGGBB color.'); c.highlight = (value.highlight as string).toUpperCase(); }
  if (value.emphasis !== undefined) c.emphasis = bool(value.emphasis, 'captions.emphasis');
  if (value.uppercase !== undefined) c.uppercase = value.uppercase === null ? null : bool(value.uppercase, 'captions.uppercase');
  if (value.maxWords !== undefined) { const n = num(value.maxWords, 0, 8, 'captions.maxWords'); if (!Number.isInteger(n)) fail('captions.maxWords must be a whole number.'); c.maxWords = n; }
  return c;
}

let counter = 0;
/** Short, URL-safe segment ids (unique within a short). */
export function segmentId() { counter = (counter + 1) % 1e6; return `${Date.now().toString(36)}${counter.toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`.slice(-12).padStart(6, '0'); }

/** Validates a segment list against the source length. Voice audio is kept only when the server passes it through. */
export function validateSegments(value: unknown, duration: number, previous: ClipSegment[] = []): ClipSegment[] {
  if (!Array.isArray(value) || !value.length) return fail('A short needs at least one segment.');
  if (value.length > CLIP_LIMITS.segments) fail(`A short can have at most ${CLIP_LIMITS.segments} segments.`);
  const ids = new Set<string>(), prior = new Map(previous.map(s => [s.id, s])), out: ClipSegment[] = [];
  let voiceChars = 0;
  for (const [i, raw] of value.entries()) {
    if (!isObject(raw)) fail(`Segment ${i + 1} must be an object.`);
    const v = raw as Record<string, unknown>;
    const id = v.id === undefined ? segmentId() : typeof v.id === 'string' && SHORT_ID.test(v.id) ? v.id : fail(`Segment ${i + 1} has an invalid id.`);
    if (ids.has(id)) fail(`Segment ids must be unique (${id}).`);
    ids.add(id);
    if (v.kind === 'source') {
      only(v, ['id', 'kind', 'start', 'end'], `segment ${i + 1}`);
      const start = round3(num(v.start, 0, duration, `Segment ${i + 1} start`)), end = round3(num(v.end, 0, duration + .05, `Segment ${i + 1} end`));
      if (end - start < .3) fail(`Segment ${i + 1} must be at least 0.3 seconds long.`);
      out.push({ id, kind: 'source', start, end: Math.min(end, duration) });
    } else if (v.kind === 'voice') {
      only(v, ['id', 'kind', 'text', 'style', 'broll', 'audio'], `segment ${i + 1}`);
      const text = cleanText(v.text, CLIP_LIMITS.voiceChars, `Segment ${i + 1} voice text`, false), style = cleanText(v.style ?? '', 160, `Segment ${i + 1} style`);
      voiceChars += text.length;
      const broll = round3(num(v.broll ?? 0, 0, Math.max(0, duration - .5), `Segment ${i + 1} footage start`));
      // Generated audio is server-owned: keep the stored copy only while the words it speaks are unchanged.
      const before = prior.get(id), audio = before?.kind === 'voice' && before.text === text && before.style === style ? before.audio : null;
      out.push({ id, kind: 'voice', text, style, broll, audio });
    } else fail(`Segment ${i + 1} kind must be source or voice.`);
  }
  if (voiceChars > CLIP_LIMITS.voiceTotalChars) fail(`Voiceover text can total at most ${CLIP_LIMITS.voiceTotalChars} characters.`);
  return out;
}

/** Applies a partial update from the studio, MCP or HTTP to a short. Unknown fields are rejected. */
export function applyShortPatch(short: ClipShort, patch: unknown, sourceDuration: number): ClipShort {
  if (!isObject(patch)) return fail('Send the changes as an object.');
  only(patch, ['name', 'segments', 'teaser', 'aspect', 'layout', 'subject', 'captions', 'hook', 'trim', 'zoom', 'overlays', 'audio', 'voice', 'wordEdits', 'post', 'censor'], 'short');
  const next: ClipShort = structuredClone(short);
  if (patch.name !== undefined) next.name = cleanText(patch.name, CLIP_LIMITS.titleChars, 'Name', false);
  if (patch.segments !== undefined) next.segments = validateSegments(patch.segments, sourceDuration, short.segments);
  if (patch.teaser !== undefined) {
    if (patch.teaser === null) next.teaser = null;
    else {
      if (!isObject(patch.teaser)) fail('teaser must be {start, end} or null.');
      only(patch.teaser as Record<string, unknown>, ['start', 'end'], 'teaser');
      const t = patch.teaser as Record<string, unknown>, start = round3(num(t.start, 0, sourceDuration, 'teaser.start')), end = round3(num(t.end, 0, sourceDuration, 'teaser.end'));
      if (end - start < .8 || end - start > 8) fail('A teaser must be 0.8 to 8 seconds long.');
      next.teaser = { start, end };
    }
  }
  if (patch.aspect !== undefined) next.aspect = pick(patch.aspect, Object.keys(CLIP_ASPECTS) as ClipAspect[], 'aspect');
  if (patch.layout !== undefined) next.layout = pick(patch.layout, CLIP_LAYOUTS, 'layout');
  if (patch.subject !== undefined) next.subject = pick(patch.subject, CLIP_SUBJECTS, 'subject');
  if (patch.captions !== undefined) next.captions = validateCaptions(patch.captions, short.captions);
  if (patch.hook !== undefined) {
    if (!isObject(patch.hook)) fail('hook must be an object.');
    only(patch.hook, ['enabled', 'text', 'seconds'], 'hook');
    if (patch.hook.enabled !== undefined) next.hook.enabled = bool(patch.hook.enabled, 'hook.enabled');
    if (patch.hook.text !== undefined) next.hook.text = cleanText(patch.hook.text, CLIP_LIMITS.hookChars, 'Hook text');
    if (patch.hook.seconds !== undefined) next.hook.seconds = round3(num(patch.hook.seconds, .5, 10, 'hook.seconds'));
  }
  if (patch.trim !== undefined) {
    if (!isObject(patch.trim)) fail('trim must be an object.');
    only(patch.trim, ['silence', 'fillers', 'maxPause'], 'trim');
    if (patch.trim.silence !== undefined) next.trim.silence = bool(patch.trim.silence, 'trim.silence');
    if (patch.trim.fillers !== undefined) next.trim.fillers = bool(patch.trim.fillers, 'trim.fillers');
    if (patch.trim.maxPause !== undefined) next.trim.maxPause = round3(num(patch.trim.maxPause, .15, 2, 'trim.maxPause'));
  }
  if (patch.zoom !== undefined) next.zoom = pick(patch.zoom, CLIP_ZOOM, 'zoom');
  if (patch.overlays !== undefined) {
    if (!isObject(patch.overlays)) fail('overlays must be an object.');
    only(patch.overlays, ['progress', 'credit', 'creditText'], 'overlays');
    if (patch.overlays.progress !== undefined) next.overlays.progress = bool(patch.overlays.progress, 'overlays.progress');
    if (patch.overlays.credit !== undefined) next.overlays.credit = bool(patch.overlays.credit, 'overlays.credit');
    if (patch.overlays.creditText !== undefined) next.overlays.creditText = cleanText(patch.overlays.creditText, 120, 'Credit text');
  }
  if (patch.audio !== undefined) {
    if (!isObject(patch.audio)) fail('audio must be an object.');
    only(patch.audio, ['sourceVolume', 'duckDb', 'normalize'], 'audio');
    if (patch.audio.sourceVolume !== undefined) next.audio.sourceVolume = round3(num(patch.audio.sourceVolume, 0, 2, 'audio.sourceVolume'));
    if (patch.audio.duckDb !== undefined) next.audio.duckDb = round3(num(patch.audio.duckDb, -40, 0, 'audio.duckDb'));
    if (patch.audio.normalize !== undefined) next.audio.normalize = bool(patch.audio.normalize, 'audio.normalize');
  }
  if (patch.voice !== undefined) {
    if (!isObject(patch.voice)) fail('voice must be an object.');
    only(patch.voice, ['model', 'voice', 'style'], 'voice');
    if (patch.voice.model !== undefined) next.voice.model = pick(patch.voice.model, TTS_MODELS, 'voice.model');
    if (patch.voice.voice !== undefined) { if (typeof patch.voice.voice !== 'string' || !(patch.voice.voice in TTS_VOICES)) fail(`voice.voice must be one of the ${Object.keys(TTS_VOICES).length} Gemini voices.`); next.voice.voice = patch.voice.voice as string; }
    if (patch.voice.style !== undefined) next.voice.style = cleanText(patch.voice.style, 200, 'Voice style');
  }
  if (patch.wordEdits !== undefined) {
    if (!isObject(patch.wordEdits)) fail('wordEdits must map word keys to text.');
    const entries = Object.entries(patch.wordEdits);
    if (entries.length > CLIP_LIMITS.wordEdits) fail(`At most ${CLIP_LIMITS.wordEdits} word edits.`);
    next.wordEdits = {};
    for (const [key, text] of entries) {
      if (!/^(s\d{1,7}|v[a-z0-9]{6,24}\.\d{1,4})$/.test(key)) fail(`Unknown word key ${key}.`);
      next.wordEdits[key] = cleanText(text, 40, `Word ${key}`);
    }
  }
  if (patch.censor !== undefined) next.censor = validateCensor(patch.censor, short.censor ?? DEFAULT_CENSOR);
  if (patch.post !== undefined) {
    if (!isObject(patch.post)) fail('post must be an object.');
    only(patch.post, ['title', 'description', 'hashtags'], 'post');
    if (patch.post.title !== undefined) next.post.title = cleanText(patch.post.title, CLIP_LIMITS.titleChars, 'Post title');
    if (patch.post.description !== undefined) {
      if (typeof patch.post.description !== 'string') fail('Post description must be text.');
      next.post.description = (patch.post.description as string).replace(/[\u0000-\u0008\u000b-\u001f\u007f]+/g, '').slice(0, CLIP_LIMITS.descriptionChars);
    }
    if (patch.post.hashtags !== undefined) {
      if (!Array.isArray(patch.post.hashtags) || patch.post.hashtags.length > CLIP_LIMITS.hashtags) fail(`hashtags must be a list of at most ${CLIP_LIMITS.hashtags}.`);
      next.post.hashtags = [...new Set((patch.post.hashtags as unknown[]).map(t => typeof t === 'string' ? normalizeHashtag(t) : '').filter(Boolean))];
    }
  }
  if (next.mode === 'clip' && next.segments.some(s => s.kind === 'voice')) next.mode = 'commentary';
  return next;
}

export function validateCensor(value: unknown, base: ClipCensor = DEFAULT_CENSOR): ClipCensor {
  if (!isObject(value)) return fail('censor must be an object.');
  only(value, ['enabled', 'style', 'words'], 'censor');
  const c = { ...base, words: [...base.words] };
  if (value.enabled !== undefined) c.enabled = bool(value.enabled, 'censor.enabled');
  if (value.style !== undefined) c.style = pick(value.style, ['bleep', 'mute'] as const, 'censor.style');
  if (value.words !== undefined) {
    if (!Array.isArray(value.words) || value.words.length > CENSOR_LIMITS.words) fail(`censor.words must be a list of at most ${CENSOR_LIMITS.words} words.`);
    c.words = [...new Set((value.words as unknown[]).map((w, i) => cleanText(w, CENSOR_LIMITS.wordChars, `censor word ${i + 1}`).toLowerCase()).filter(Boolean))];
  }
  return c;
}

export function validateDefaults(value: unknown, base: ClipDefaults = DEFAULT_CLIP_SETTINGS): ClipDefaults {
  if (!isObject(value)) return fail('Settings must be an object.');
  only(value, ['aspect', 'layout', 'subject', 'captions', 'zoom', 'quality', 'trim', 'overlays', 'voice', 'hookSeconds', 'minSeconds', 'maxSeconds', 'count', 'genre', 'language', 'censor'], 'settings');
  const d: ClipDefaults = structuredClone(base);
  if (value.aspect !== undefined) d.aspect = pick(value.aspect, Object.keys(CLIP_ASPECTS) as ClipAspect[], 'aspect');
  if (value.layout !== undefined) d.layout = pick(value.layout, CLIP_LAYOUTS, 'layout');
  if (value.subject !== undefined) d.subject = pick(value.subject, CLIP_SUBJECTS, 'subject');
  if (value.captions !== undefined) d.captions = validateCaptions(value.captions, d.captions);
  if (value.zoom !== undefined) d.zoom = pick(value.zoom, CLIP_ZOOM, 'zoom');
  if (value.quality !== undefined) d.quality = pick(value.quality, CLIP_QUALITY, 'quality');
  if (value.trim !== undefined) d.trim = applyShortPatch({ ...emptyShort(), trim: d.trim }, { trim: value.trim }, 1).trim;
  if (value.overlays !== undefined) {
    if (!isObject(value.overlays)) fail('overlays must be an object.');
    only(value.overlays, ['progress', 'credit'], 'overlays');
    if (value.overlays.progress !== undefined) d.overlays.progress = bool(value.overlays.progress, 'overlays.progress');
    if (value.overlays.credit !== undefined) d.overlays.credit = bool(value.overlays.credit, 'overlays.credit');
  }
  if (value.voice !== undefined) d.voice = applyShortPatch({ ...emptyShort(), voice: d.voice }, { voice: value.voice }, 1).voice;
  if (value.censor !== undefined) d.censor = validateCensor(value.censor, d.censor ?? DEFAULT_CENSOR);
  if (value.hookSeconds !== undefined) d.hookSeconds = round3(num(value.hookSeconds, .5, 10, 'hookSeconds'));
  if (value.minSeconds !== undefined) d.minSeconds = Math.round(num(value.minSeconds, CLIP_LIMITS.minShortSeconds, 170, 'minSeconds'));
  if (value.maxSeconds !== undefined) d.maxSeconds = Math.round(num(value.maxSeconds, 8, CLIP_LIMITS.shortSeconds, 'maxSeconds'));
  if (d.maxSeconds < d.minSeconds + 5) fail('maxSeconds must be at least 5 seconds longer than minSeconds.');
  if (value.count !== undefined) d.count = Math.round(num(value.count, 1, CLIP_LIMITS.moments, 'count'));
  if (value.genre !== undefined) d.genre = pick(value.genre, CLIP_GENRES, 'genre');
  if (value.language !== undefined) { if (typeof value.language !== 'string' || !/^(auto|[a-z]{2,3}(-[A-Za-z0-9]{2,8})?)$/.test(value.language)) fail('language must be auto or a language code such as en or es.'); d.language = value.language as string; }
  return d;
}

function emptyShort(): ClipShort {
  return { format: 'sprityreels-clip-short', version: 1, id: '', sourceId: '', revision: 0, created: 0, updated: 0, name: 'Short', mode: 'clip', momentId: null, segments: [], teaser: null,
    aspect: '9:16', layout: 'auto', subject: 'auto', captions: DEFAULT_CAPTIONS, hook: { enabled: true, text: '', seconds: 3 }, trim: DEFAULT_CLIP_SETTINGS.trim, zoom: 'cuts',
    overlays: { progress: true, credit: true, creditText: '' }, censor: DEFAULT_CENSOR, audio: { sourceVolume: 1, duckDb: -18, normalize: true }, voice: DEFAULT_CLIP_SETTINGS.voice, wordEdits: {}, post: { title: '', description: '', hashtags: [] } };
}

/** A new short from settings. The server fills ids, the source and timestamps. */
export function newShort(fields: { id: string; sourceId: string; name: string; mode: 'clip' | 'commentary'; segments: ClipSegment[]; defaults: ClipDefaults; creditText: string; momentId?: string | null; teaser?: { start: number; end: number } | null; hook?: string; post?: ClipShort['post'] }): ClipShort {
  const now = Date.now(), d = fields.defaults;
  return {
    ...emptyShort(), id: fields.id, sourceId: fields.sourceId, revision: 1, created: now, updated: now, name: fields.name.slice(0, CLIP_LIMITS.titleChars) || 'Short', mode: fields.mode,
    momentId: fields.momentId ?? null, segments: fields.segments, teaser: fields.teaser ?? null, aspect: d.aspect, layout: d.layout, subject: d.subject ?? 'auto', captions: structuredClone(d.captions),
    hook: { enabled: !!fields.hook, text: (fields.hook ?? '').slice(0, CLIP_LIMITS.hookChars), seconds: d.hookSeconds }, trim: structuredClone(d.trim), zoom: d.zoom,
    overlays: { ...d.overlays, creditText: fields.creditText.slice(0, 120) }, censor: structuredClone(d.censor ?? DEFAULT_CENSOR), voice: structuredClone(d.voice),
    post: fields.post ?? { title: fields.name.slice(0, CLIP_LIMITS.titleChars), description: '', hashtags: [] },
  };
}

/** Output length before silence trimming (voice segments count their generated audio, or an estimate at 2.6 words/s). */
export function estimateShortSeconds(short: Pick<ClipShort, 'segments' | 'teaser'>) {
  let total = short.teaser ? short.teaser.end - short.teaser.start : 0;
  for (const s of short.segments) total += s.kind === 'source' ? s.end - s.start : s.audio?.duration ?? Math.max(1, s.text.split(/\s+/).length / 2.6);
  return total;
}
export const fmtTime = (seconds: number) => {
  const s = Math.max(0, seconds), h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), sec = s % 60;
  return `${h ? `${h}:${String(m).padStart(2, '0')}` : m}:${sec.toFixed(1).padStart(4, '0')}`;
};
