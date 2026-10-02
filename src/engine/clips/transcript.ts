import type { ClipReaction, ClipSentence, ClipTranscript, ClipWord } from './types';

/** Loudness envelope: one byte per 10 ms holding dBFS + 100 (0 = silence floor, 100 = full scale). */
export const ENERGY_RATE = 100;
export function energyEnvelope(samples: Int16Array, sampleRate: number): Uint8Array {
  const hop = Math.max(1, Math.round(sampleRate / ENERGY_RATE)), frames = Math.floor(samples.length / hop), out = new Uint8Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let i = f * hop, end = i + hop; i < end; i++) sum += samples[i] * samples[i];
    const rms = Math.sqrt(sum / hop) / 32768, db = rms > 1e-5 ? 20 * Math.log10(rms) : -100;
    out[f] = Math.max(0, Math.min(100, Math.round(db + 100)));
  }
  return out;
}
/** Speech threshold relative to the recording: noise floor (10th percentile) + 14 dB, at least -52 dBFS. */
export function speechThreshold(energy: Uint8Array) {
  if (!energy.length) return 48;
  const hist = new Uint32Array(101);
  for (const v of energy) hist[v]++;
  let acc = 0, floor = 0;
  for (let v = 0; v <= 100; v++) { acc += hist[v]; if (acc >= energy.length * .1) { floor = v; break; } }
  return Math.max(48, Math.min(80, floor + 14));
}
export const energyAt = (energy: Uint8Array, t: number) => energy[Math.max(0, Math.min(energy.length - 1, Math.floor(t * ENERGY_RATE)))] ?? 0;
/** Silent runs (seconds) between a and b that last at least minRun. */
export function silentRuns(energy: Uint8Array, a: number, b: number, threshold: number, minRun = .12) {
  const runs: { s: number; e: number }[] = [], i0 = Math.max(0, Math.floor(a * ENERGY_RATE)), i1 = Math.min(energy.length, Math.ceil(b * ENERGY_RATE));
  let start = -1;
  for (let i = i0; i <= i1; i++) {
    const quiet = i < i1 && energy[i] < threshold;
    if (quiet && start < 0) start = i;
    if (!quiet && start >= 0) { if ((i - start) / ENERGY_RATE >= minRun) runs.push({ s: start / ENERGY_RATE, e: i / ENERGY_RATE }); start = -1; }
  }
  return runs;
}

const PUNCT_ONLY = /^[\s.,!?;:…'"”“’‘()\-–—%]+$/u;
type WhisperToken = { text?: string; offsets?: { from?: number; to?: number }; p?: number; t_dtw?: number };
type WhisperJson = { result?: { language?: string }; transcription?: { offsets?: { from?: number; to?: number }; text?: string; tokens?: WhisperToken[] }[] };

/** whisper.cpp -ojf output (with --dtw) to words. DTW token times land near each token's end, so a word spans from the
 * previous token's DTW time to its own, then the loudness envelope moves starts past pauses and ends before them. */
export function wordsFromWhisper(json: WhisperJson, offset = 0, energy?: Uint8Array): ClipWord[] {
  type Raw = { text: string; from: number; to: number; dtw: number; p: number; punct: boolean };
  const tokens: Raw[] = [];
  for (const seg of json.transcription ?? []) for (const tok of seg.tokens ?? []) {
    const text = String(tok.text ?? '');
    if (!text || /^\[_|^<\|/.test(text)) continue;
    tokens.push({ text, from: (tok.offsets?.from ?? 0) / 1000, to: (tok.offsets?.to ?? 0) / 1000, dtw: typeof tok.t_dtw === 'number' && tok.t_dtw >= 0 ? tok.t_dtw / 100 : -1, p: typeof tok.p === 'number' ? tok.p : 1, punct: PUNCT_ONLY.test(text) });
  }
  const useDtw = tokens.length > 0 && tokens.filter(t => t.dtw >= 0).length >= tokens.length * .8;
  type Build = { text: string; s: number; e: number; p: number[] };
  const words: Build[] = [];
  let prevBoundary = 0;
  for (const tok of tokens) {
    const boundary = useDtw ? Math.max(prevBoundary, tok.dtw) : tok.to;
    const startsWord = /^\s/.test(tok.text) && !tok.punct;
    if (tok.punct || (!startsWord && words.length)) {
      // Punctuation and word pieces extend the current word's text; punctuation does not extend its timing.
      if (words.length) { const w = words[words.length - 1]; w.text += tok.text.trim(); if (!tok.punct) { w.e = Math.max(w.e, boundary); w.p.push(tok.p); } }
    } else words.push({ text: tok.text.trim(), s: useDtw ? prevBoundary : tok.from, e: boundary, p: [tok.p] });
    prevBoundary = boundary;
  }
  const out: ClipWord[] = words.filter(w => w.text).map(w => ({ t: w.text, s: w.s, e: Math.max(w.e, w.s + .04), p: Math.min(...w.p) }));
  if (energy) refineWithEnergy(out, energy);
  return out.map(w => ({ t: w.t, s: r3(w.s + offset), e: r3(w.e + offset), ...(w.p !== undefined && w.p < .999 ? { p: Math.round(w.p * 100) / 100 } : {}) }));
}
const r3 = (x: number) => Math.round(x * 1000) / 1000;

/** Moves each word's start to the end of the last pause inside it, and its end to the start of a pause that begins
 * inside it, using the 10 ms loudness envelope. Words stay ordered and at least 60 ms long. */
export function refineWithEnergy(words: ClipWord[], energy: Uint8Array) {
  if (!words.length || !energy.length) return words;
  const threshold = speechThreshold(energy);
  for (let i = 0; i < words.length; i++) {
    const w = words[i], runs = silentRuns(energy, w.s, w.e, threshold, .1);
    if (!runs.length) continue;
    const last = runs[runs.length - 1];
    // A pause that ends before the word's end means the word started after it.
    if (last.e < w.e - .05) w.s = Math.max(w.s, last.e - .02);
    const first = runs.find(r => r.s > w.s + .06);
    if (first && first.s < w.e) w.e = Math.max(w.s + .06, first.s + .03);
  }
  for (let i = 1; i < words.length; i++) if (words[i].s < words[i - 1].s) words[i].s = words[i - 1].s;
  for (let i = 0; i < words.length - 1; i++) if (words[i].e > words[i + 1].s && words[i + 1].s > words[i].s) words[i].e = Math.max(words[i].s + .04, words[i + 1].s);
  return words;
}

type Json3 = { events?: { tStartMs?: number; dDurationMs?: number; segs?: { utf8?: string; tOffsetMs?: number }[]; aAppend?: number }[] };
/** YouTube json3 captions (auto or manual) to words. Auto captions carry per-word offsets; manual ones get even spacing. */
export function wordsFromJson3(json: Json3, duration: number): ClipWord[] {
  const out: ClipWord[] = [];
  for (const ev of json.events ?? []) {
    if (!ev.segs || ev.aAppend) continue;
    const start = (ev.tStartMs ?? 0) / 1000, dur = (ev.dDurationMs ?? 0) / 1000;
    const pieces: { text: string; at: number | null }[] = [];
    for (const seg of ev.segs) {
      // Sound labels ("[Music]", "[Audience laughing]", "(sighs)") are not words; reactionsFromJson3 keeps the reactions.
      const text = String(seg.utf8 ?? '').replace(/\n/g, ' ').replace(/\[[^\]]*\]|\([^)]*\)/g, ' ');
      if (!text.trim()) continue;
      const tokens = text.trim().split(/\s+/);
      tokens.forEach((t, k) => pieces.push({ text: t, at: k === 0 && typeof seg.tOffsetMs === 'number' ? start + seg.tOffsetMs / 1000 : k === 0 && seg === ev.segs![0] ? start : null }));
    }
    if (!pieces.length) continue;
    for (let k = 0; k < pieces.length; k++) if (pieces[k].at === null) pieces[k].at = start + dur * k / pieces.length;
    for (let k = 0; k < pieces.length; k++) {
      const s = pieces[k].at!, e = k + 1 < pieces.length ? pieces[k + 1].at! : Math.min(start + Math.max(dur, .3), s + 1.2);
      if (/^\[.*\]$/.test(pieces[k].text)) continue;
      out.push({ t: pieces[k].text, s: r3(s), e: r3(Math.max(s + .05, Math.min(e, duration || e))) });
    }
  }
  out.sort((a, b) => a.s - b.s);
  for (let i = 0; i < out.length - 1; i++) if (out[i].e > out[i + 1].s) out[i].e = Math.max(out[i].s + .05, out[i + 1].s);
  return out;
}

/** Audience reactions a caption track marks in brackets ([Laughter], [Applause], [Risas], [Aplausos]…): real viewer
 * signals that whisper does not keep. Music and other sound labels are ignored. */
export function reactionsFromJson3(json: Json3): ClipReaction[] {
  const out: ClipReaction[] = [];
  for (const ev of json.events ?? []) {
    if (!ev.segs) continue;
    const start = (ev.tStartMs ?? 0) / 1000;
    for (const seg of ev.segs) {
      const text = String(seg.utf8 ?? '');
      for (const m of text.matchAll(/[[(]([^\])]{2,30})[\])]/g)) {
        const label = m[1].toLowerCase(), t = Math.round((start + (seg.tOffsetMs ?? 0) / 1000) * 100) / 100;
        const kind = /laugh|chuckl|giggl|risa|rires?|lach|riso|risos|risate|笑/.test(label) ? 'laughter' : /applau|aplaus|clap|palmas|beifall/.test(label) ? 'applause' : /cheer|ovaci|vítor|jubel|crowd|whoop|hurra/.test(label) ? 'cheering' : null;
        if (kind && !out.some(r => r.kind === kind && Math.abs(r.t - t) < 1)) out.push({ t, kind });
      }
    }
  }
  return out.sort((a, b) => a.t - b.t).slice(0, 5000);
}

const TERMINAL = /[.!?…。！？]["”’)\]]*$/u;
/** Sentences from punctuation, long pauses and a length cap (captions without punctuation still segment on pauses). */
export function sentencesFrom(words: ClipWord[], maxWords = 28): ClipSentence[] {
  const out: ClipSentence[] = [];
  let a = 0;
  for (let i = 0; i < words.length; i++) {
    const w = words[i], next = words[i + 1], gap = next ? next.s - w.e : Infinity, len = i - a + 1;
    const soft = /[,;:]$/.test(w.t) && len >= maxWords * .6;
    if (TERMINAL.test(w.t) || gap > .8 || (gap > .45 && len >= 6) || soft || len >= maxWords) { out.push({ s: words[a].s, e: w.e, a, b: i }); a = i + 1; }
  }
  return out;
}

export function makeTranscript(words: ClipWord[], fields: { engine: 'whisper' | 'captions'; language: string; model: string | null; duration: number }): ClipTranscript {
  return { format: 'sprityreels-clip-transcript', version: 1, engine: fields.engine, language: fields.language || 'und', model: fields.model, duration: fields.duration, words, sentences: sentencesFrom(words) };
}
export function validateTranscript(value: unknown): ClipTranscript {
  const t = value as ClipTranscript;
  if (!t || t.format !== 'sprityreels-clip-transcript' || !Array.isArray(t.words) || !Array.isArray(t.sentences)) throw new Error('This transcript file is not readable.');
  return t;
}

export const sentenceText = (t: ClipTranscript, s: ClipSentence) => t.words.slice(s.a, s.b + 1).map(w => w.t).join(' ');
export function wordsBetween(t: Pick<ClipTranscript, 'words'>, start: number, end: number) {
  const out: { index: number; word: ClipWord }[] = [];
  for (let i = firstWordAt(t.words, start); i < t.words.length && t.words[i].s < end; i++) if (t.words[i].e > start) out.push({ index: i, word: t.words[i] });
  return out;
}
/** Index of the first word ending after `time` (binary search). */
export function firstWordAt(words: ClipWord[], time: number) {
  let lo = 0, hi = words.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (words[mid].e <= time) lo = mid + 1; else hi = mid; }
  return lo;
}
/** Sentence index containing or following `time`. */
export function sentenceAt(t: ClipTranscript, time: number) {
  let lo = 0, hi = t.sentences.length - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (t.sentences[mid].e < time) lo = mid + 1; else hi = mid; }
  return Math.max(0, lo);
}
/** Snaps a range to whole sentences (used when an AI or a user gives rough seconds). */
export function snapToSentences(t: ClipTranscript, start: number, end: number) {
  if (!t.sentences.length) return { start, end };
  const a = t.sentences[sentenceAt(t, start + .05)], b = t.sentences[Math.max(0, sentenceAt(t, end - .05))];
  const s = Math.abs(a.s - start) < 3 ? a.s : start, e = b.e >= s + .5 && Math.abs(b.e - end) < 3 ? b.e : end;
  return { start: Math.max(0, s - .08), end: e + .15 };
}

/** Timestamped, numbered sentences for AI prompts and MCP reads: "[#12 01:05.2-01:09.8] text". */
export function transcriptLines(t: ClipTranscript, from = 0, count = t.sentences.length) {
  const mmss = (x: number) => `${String(Math.floor(x / 60)).padStart(2, '0')}:${(x % 60).toFixed(1).padStart(4, '0')}`;
  return t.sentences.slice(from, from + count).map((s, k) => `[#${from + k} ${mmss(s.s)}-${mmss(s.e)}] ${sentenceText(t, s)}`);
}

// ------------------------------------------------------------------ audio sync
/** Offset (seconds) where `part` best matches `full` near `expected`, from loudness envelopes (10 ms resolution),
 * so downloaded sections line up with the full transcript even when containers start on an earlier keyframe. */
export function alignEnvelope(full: Uint8Array, part: Uint8Array, expected: number, search = 6) {
  const n = Math.min(part.length, 30 * ENERGY_RATE);
  if (n < 2 * ENERGY_RATE) return { offset: expected, confidence: 0 };
  const mean = (a: Uint8Array, i0: number, len: number) => { let s = 0; for (let i = 0; i < len; i++) s += a[i0 + i] ?? 0; return s / len; };
  const pm = mean(part, 0, n);
  let pv = 0; for (let i = 0; i < n; i++) pv += (part[i] - pm) ** 2;
  let best = expected, bestScore = -Infinity;
  const e0 = Math.round(expected * ENERGY_RATE), r = Math.round(search * ENERGY_RATE);
  for (let lag = e0 - r; lag <= e0 + r; lag++) {
    if (lag < 0 || lag + n > full.length) continue;
    const fm = mean(full, lag, n);
    let cov = 0, fv = 0;
    for (let i = 0; i < n; i++) { const d = full[lag + i] - fm; cov += d * (part[i] - pm); fv += d * d; }
    const score = cov / Math.sqrt(Math.max(1e-9, pv * fv));
    if (score > bestScore) { bestScore = score; best = lag / ENERGY_RATE; }
  }
  return { offset: best, confidence: Math.max(0, bestScore) };
}
