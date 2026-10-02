import type { ClipShort, ClipTranscript, ClipWord } from './types';
import { firstWordAt } from './transcript';
import { censorMatcher, maskWord } from './censor';

/** The edit decision list of a short: which source ranges and voice lines play when, at which punch-in, and where
 * every caption word lands on the output clock. Cuts are frame-aligned so audio and video never drift apart. */
export type TimelinePiece = {
  kind: 'source' | 'voice' | 'teaser'; segmentId: string; out: number; dur: number; src: number;
  voice: { file: string; offset: number } | null; zoom: number; cut: boolean;
};
export type TimelineWord = { key: string; text: string; s: number; e: number; emphasis: boolean; end: boolean; voice: boolean; censored?: boolean };
/** bleeps: output-time spans of censored words, bleeped or muted by the renderer. */
export type Timeline = { duration: number; fps: number; pieces: TimelinePiece[]; words: TimelineWord[]; voiceWindows: { s: number; e: number }[]; removed: number; bleeps?: { s: number; e: number }[] };

export const FILLER = /^(u+m+|u+h+m*|e+r+m*|e+r|a+h+|h+m+|m+h*m+|mhm)[,.!?…]*$/i;
const PRE = .06, POST = .1, PUNCH = 1.12;
const r3 = (x: number) => Math.round(x * 1000) / 1000;

/** Kept source ranges inside [start, end] after removing long pauses and filler words. */
export function keptRanges(words: ClipWord[], start: number, end: number, trim: ClipShort['trim']): { s: number; e: number }[] {
  const inside = words.slice(firstWordAt(words, start)).filter(w => w.s < end && w.e > start);
  if (!inside.length || (!trim.silence && !trim.fillers)) return [{ s: start, e: end }];
  const spans: { s: number; e: number }[] = [];
  for (const w of inside) {
    if (trim.fillers && FILLER.test(w.t)) continue;
    spans.push({ s: Math.max(start, w.s - PRE), e: Math.min(end, w.e + POST) });
  }
  if (!spans.length) return [{ s: start, e: end }];
  if (!trim.silence) {
    // Only fillers are cut: keep everything else, including natural pauses.
    const out: { s: number; e: number }[] = []; let cursor = start;
    for (const w of inside) if (FILLER.test(w.t)) { const a = Math.max(start, w.s - .02), b = Math.min(end, w.e + .02); if (a - cursor > .05) out.push({ s: cursor, e: a }); cursor = Math.max(cursor, b); }
    if (end - cursor > .05) out.push({ s: cursor, e: end });
    return merge(out, .08);
  }
  const merged = merge(spans, trim.maxPause);
  // Keep the moment's own lead-in and tail breathing room when they are short.
  if (merged[0].s - start < .25) merged[0].s = start;
  if (end - merged[merged.length - 1].e < .35) merged[merged.length - 1].e = end;
  // A removed filler is always cut out, even where the pause around it is short enough to keep.
  const fillers = trim.fillers ? inside.filter(w => FILLER.test(w.t)).map(w => ({ s: w.s - .02, e: w.e + .02 })) : [];
  return merged.flatMap(r => subtract(r, fillers)).filter(r => r.e - r.s >= .2);
}
function subtract(range: { s: number; e: number }, holes: { s: number; e: number }[]) {
  let pieces = [range];
  for (const h of holes) pieces = pieces.flatMap(p => h.e <= p.s || h.s >= p.e ? [p] : [{ s: p.s, e: h.s }, { s: h.e, e: p.e }].filter(x => x.e - x.s > .05));
  return pieces;
}
function merge(spans: { s: number; e: number }[], gap: number) {
  const out: { s: number; e: number }[] = [];
  for (const span of [...spans].sort((a, b) => a.s - b.s)) {
    const last = out[out.length - 1];
    if (last && span.s - last.e <= gap) last.e = Math.max(last.e, span.e); else out.push({ ...span });
  }
  return out;
}

const EMPHASIS_WORDS = /^(never|always|nobody|everyone|everything|nothing|biggest|worst|best|crazy|insane|secret|truth|mistake|money|million|billion|free|stop|love|hate|wrong|dead|died|fired|broke|rich|huge|massive|literally|actually|seriously|impossible|dangerous)$/i;
/** Words worth colouring: keywords of the moment, numbers and money, and a short list of power words. */
export function isEmphasis(text: string, keywords: Set<string>) {
  const bare = text.toLowerCase().replace(/[^\p{L}\p{N}$%']/gu, '');
  if (!bare) return false;
  return keywords.has(bare) || /[\d$%€£]/.test(text) || EMPHASIS_WORDS.test(bare) || (text.length > 2 && text === text.toUpperCase() && /\p{Lu}/u.test(text));
}

export type TimelineOptions = { fps: number; keywords?: string[]; voiceEstimate?: boolean };
/** Builds the timeline. Voice segments need generated audio unless voiceEstimate is set (planning previews). */
export function buildTimeline(short: ClipShort, transcript: Pick<ClipTranscript, 'words'>, options: TimelineOptions): Timeline {
  const fps = options.fps > 0 ? options.fps : 30, q = (t: number) => Math.round(t * fps) / fps;
  const keywords = new Set((options.keywords ?? []).map(k => k.toLowerCase()));
  const pieces: TimelinePiece[] = [], words: TimelineWord[] = [], voiceWindows: { s: number; e: number }[] = [], bleeps: { s: number; e: number }[] = [];
  let out = 0, removed = 0, zoomToggle = false;
  const censored = short.censor?.enabled ? censorMatcher(short.censor.words) : null;
  const addWord = (key: string, w: ClipWord, s: number, e: number, voice: boolean) => {
    const edited = short.wordEdits[key];
    let text = edited === undefined ? w.t : edited;
    // A hidden or corrected word is still bleeped when what was said is a swear word.
    const bleep = !!censored && (censored(w.t) || (!!text && censored(text)));
    if (bleep) bleeps.push({ s: r3(Math.max(0, s - .03)), e: r3(e + .03) });
    if (!text) return;
    if (bleep) text = maskWord(text);
    words.push({ key, text, s: r3(s), e: r3(Math.max(s + .05, e)), emphasis: !bleep && isEmphasis(text, keywords), end: /[.!?…]["”’)]*$/.test(w.t), voice, ...(bleep ? { censored: true } : {}) });
  };
  const addSource = (kind: 'source' | 'teaser', segmentId: string, start: number, end: number, trim: boolean) => {
    const ranges = trim ? keptRanges(transcript.words, start, end, short.trim) : [{ s: start, e: end }];
    removed += Math.max(0, end - start - ranges.reduce((sum, r) => sum + r.e - r.s, 0));
    ranges.forEach((range, k) => {
      const s = q(range.s), dur = Math.max(2 / fps, q(range.e) - s), base = out;
      const cut = k > 0;
      if (cut && short.zoom !== 'off') zoomToggle = !zoomToggle;
      // Rhythm mode also punches in on long uncut stretches at a word boundary near every ~5 seconds.
      const splits: number[] = [];
      if (short.zoom === 'rhythm' && dur > 7) {
        const inner = transcript.words.slice(firstWordAt(transcript.words, s)).filter(w => w.s > s + 2.5 && w.s < s + dur - 2.5);
        let last = s;
        for (const w of inner) if (w.s - last >= 5) { splits.push(q(w.s - .03)); last = w.s; }
      }
      const bounds = [s, ...splits, s + dur];
      for (let b = 0; b < bounds.length - 1; b++) {
        if (b > 0) zoomToggle = !zoomToggle;
        const ps = bounds[b], pd = q(bounds[b + 1] - ps);
        if (pd <= 0) continue;
        // Times stay exactly on the frame grid (no millisecond rounding) so the renderer cuts whole frames.
        pieces.push({ kind, segmentId, out, dur: pd, src: ps, voice: null, zoom: zoomToggle && short.zoom !== 'off' ? PUNCH : 1, cut: cut && b === 0 });
        out = q(out + pd);
      }
      for (let i = firstWordAt(transcript.words, s); i < transcript.words.length && transcript.words[i].s < s + dur; i++) {
        const w = transcript.words[i];
        if (w.e <= s) continue;
        if (trim && short.trim.fillers && FILLER.test(w.t)) continue;
        addWord(`s${i}`, w, base + Math.max(0, w.s - s), base + Math.min(dur, w.e - s), false);
      }
    });
  };
  if (short.teaser) addSource('teaser', 'teaser', short.teaser.start, short.teaser.end, false);
  for (const seg of short.segments) {
    if (seg.kind === 'source') { addSource('source', seg.id, seg.start, seg.end, short.trim.silence || short.trim.fillers); continue; }
    let duration = seg.audio?.duration ?? 0, voiceWords = seg.audio?.words ?? [];
    if (!seg.audio) {
      if (!options.voiceEstimate) throw new Error('Generate the voiceover before rendering this short.');
      const tokens = seg.text.split(/\s+/).filter(Boolean); duration = Math.max(1, tokens.length / 2.6);
      voiceWords = tokens.map((t, k) => ({ t, s: k * duration / tokens.length, e: (k + .9) * duration / tokens.length }));
    }
    const dur = q(duration + .12);
    pieces.push({ kind: 'voice', segmentId: seg.id, out, dur, src: r3(seg.broll), voice: seg.audio ? { file: seg.audio.file, offset: 0 } : null, zoom: 1, cut: pieces.length > 0 });
    voiceWindows.push({ s: r3(out), e: r3(out + duration) });
    voiceWords.forEach((w, k) => addWord(`v${seg.id}.${k}`, w, out + w.s, out + w.e, true));
    out = q(out + dur);
  }
  return { duration: r3(out), fps, pieces, words: words.sort((a, b) => a.s - b.s), voiceWindows, removed: r3(removed), bleeps: bleeps.sort((a, b) => a.s - b.s) };
}

/** Maps an output time back to the source time shown at that moment (for previews and cover frames). */
export function sourceTimeAt(timeline: Timeline, t: number) {
  const piece = timeline.pieces.find(p => t >= p.out && t < p.out + p.dur) ?? timeline.pieces[timeline.pieces.length - 1];
  return piece ? piece.src + Math.max(0, Math.min(piece.dur, t - piece.out)) : 0;
}
