import type { ClipChapter, ClipCheck, ClipTranscript, ClipWord } from './types';
import { ENERGY_RATE, sentenceText } from './transcript';

/** Self-contained moments. The usual reason an AI clipper's picks get thrown away is missing context: the clip opens on
 * "and…" or on an answer whose question was cut, or it stops on "here's why" before the reason. Every engine's picks
 * (local, Gemini, Codex, Claude Code and agents) pass through repairMoment, which moves the boundaries by whole
 * sentences inside the length limits, snaps the cuts into the quietest audio next to the speech and reports what it
 * fixed or could not fix. Topic boundaries (lexical cohesion, pauses and chapters) keep repairs inside one story. */

const TERMINAL = /[.!?…。！？]["”’)\]]*$/u;
const QUESTION = /[?？]["”’)\]]*$/u;
/** Openers that lean on something said before the clip starts. */
const CONNECTOR = /^(and|but|or|nor|plus|because|'?cause|cuz|which|whereas|although|though|otherwise|therefore|thus|hence|also|besides|except|then)\b/i;
const REFERENCE = /^(that'?s\b|that (is|was|were)\b|this is (why|how)\b|which is (why|how)\b|here(?:'?s| is) why\b|the reason (is|was)\b|(like|as) (i|we|you) (said|mentioned|discussed)\b|going back to\b|back to (that|what)\b|to your point\b|same (thing|here)\b|it'?s like that\b)/i;
/** Replies ("Yeah, and…"). "No one tells you" or "Right now" are not replies. */
const RESPONSE = /^(yeah|yes|yep|yup|no|nope|nah|right|exactly|absolutely|totally|true|agreed|sure|definitely|correct|of course)\b(?=\s*[,.!?…]|\s+(i|it|it's|that|and|but|so|he|she|they|we|you|man|dude|bro)\b)/i;
/** "It went…", "She said…": probably about someone or something named just before. */
const PRONOUN = /^((he|she|they|him|her|them|his|their)\b|it (went|was|did|got|had|became|turned|took|cost|made|happened|worked|failed|broke|crashed|dropped|blew|ended|started|sold)\b|this (guy|girl|dude|man|woman)\b)/i;
/** Openers that start a new topic: "Anyway…", "Let's talk about…", "Moving on…". */
const SHIFT = /^(anyway|anyways|moving on|next (question|topic|up|thing)|((so|okay|ok|alright|all right|now),? )?(let'?s|let us) (talk|move|switch|get into|get right into|dive|turn|jump)|speaking of|on (a|another) (different|other|related) note|(one|another|the other) (more )?thing (i|we)|changing (the )?(subject|topics?)|(okay|ok|alright|all right),? so\b|so,? (my|the) (next|last) question)/i;
const ANNOUNCE = /^(let me tell you (about|a story)|i want to talk about|the first thing|story time|true story)/i;
/** Lines that open a new point: "Most people…", "The biggest mistake…", "Nobody tells you…". */
const POINT = /^(most people|the (biggest|best|worst|number one|#1|first|real) (mistake|thing|problem|lesson|secret|tip|reason|rule)|nobody (tells|talks)|here(?:'?s| is) the (thing|secret|truth|problem|deal)|the (secret|truth|key|problem|trick) (is|to)|one of the (biggest|best|worst)|if you (want|ever))/i;
/** A sentence that only announces what comes next. */
const SETUP = /^(so,? |and,? |but,? )?(here(?:'?s| is) (why|how|what|the (thing|secret|trick|deal|problem|kicker|crazy part))|let me (tell|show|explain|ask)|guess what|wait for it|you know what (happened|i did|he did|she did|they did)|and then|the (reason|answer|secret|trick|key|truth|problem) (is|was))\b[^.!?…]{0,32}[.!?…:]?["”’)]*$/i;
/** Questions put to the viewer are fine endings; the next line does not answer them. */
const AUDIENCE_QUESTION = /\b(what do you (guys )?think|do you (guys )?agree|let me know|in the comments|comment below|tell me (below|in the comments))\b/i;
const COUNT_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven'];
const ORDINALS = ['', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh'];
const LIST = /\b(two|three|four|five|six|seven|[2-7]) (big |main |simple |key |quick |important )?(things|reasons|ways|steps|rules|mistakes|tips|lessons|habits|questions|signs|secrets|keys|types|kinds|options|ideas|facts|problems|stages|parts)\b/i;

/** strong: the opener leans on what came before ("And…", "That's why…", "Yeah, …"); weak: a bare "he/she/they". */
export function openerKind(text: string): 'strong' | 'weak' | null {
  const s = text.trim();
  return CONNECTOR.test(s) || REFERENCE.test(s) || RESPONSE.test(s) ? 'strong' : PRONOUN.test(s) ? 'weak' : null;
}
export const isSetup = (text: string) => SETUP.test(text.trim());
export const isQuestion = (text: string) => QUESTION.test(text.trim());
export const isAudienceQuestion = (text: string) => AUDIENCE_QUESTION.test(text.trim());
export const isPunctuated = (t: ClipTranscript) => t.sentences.length > 0 && t.sentences.filter(s => TERMINAL.test(t.words[s.b]?.t ?? '')).length >= t.sentences.length * .3;

/** How many items a sentence promises ("three things"), or 0. */
export function listCount(text: string) {
  const m = LIST.exec(text);
  if (!m) return 0;
  const n = /^\d$/.test(m[1]) ? Number(m[1]) : COUNT_WORDS.indexOf(m[1].toLowerCase());
  return n >= 2 ? n : 0;
}
const listDone = (text: string, n: number) => new RegExp(`\\b(${ORDINALS[n]}(ly)?|number ${COUNT_WORDS[n]}|${n}(st|nd|rd|th)|last(ly)?|finally|the last one)\\b`, 'i').test(text);

// ------------------------------------------------------------------ topic boundaries
const STOP = new Set('about after again also always another anything around away back because been before being between both came come comes could didn\'t does doesn\'t doing done don\'t down each even ever every everyone everything from gave give goes going gone gonna good great have having here i\'ll i\'ve into it\'s just keep kind know knew like literally look looks made make makes many maybe mean more most much must need never next only other over pretty probably put really right said same saying says should some something still stuff such sure take takes talk tell than that that\'s their them then there there\'s these they they\'re thing things think thought this those though through time told took totally very want wanna well went were we\'re what when where which while will with would yeah year years your you\'re'.split(' '));
const content = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}'\s]+/gu, ' ').split(/\s+/).map(w => w.replace(/^'+|'+$/g, '')).filter(w => w.length > 3 && !STOP.has(w) && !/^\d+$/.test(w)).map(w => w.length > 5 ? w.replace(/(ies|es|s|ing|ed)$/, '') : w);
export const isStopWord = (word: string) => STOP.has(word);
/** Idf-weighted bag of content words for similarity (topics, diversity). */
export function bagOf(text: string) { const bag = new Map<string, number>(); for (const w of content(text)) bag.set(w, (bag.get(w) ?? 0) + 1); return bag; }
export function cosine(a: Map<string, number>, b: Map<string, number>, idf: (w: string) => number = () => 1) {
  let dot = 0, na = 0, nb = 0;
  for (const [w, x] of a) { const k = idf(w) ** 2; na += x * x * k; const y = b.get(w); if (y) dot += x * y * k; }
  for (const [w, y] of b) nb += y * y * idf(w) ** 2;
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

const breakCache = new WeakMap<ClipTranscript, { key: string; value: Float32Array }>();
/** Topic-boundary strength (0-1) for each gap between sentence i and i+1: TextTiling-style valleys in the lexical
 * similarity of the ~25 s before and after, spoken topic cues and long pauses, vetoed where the next line continues
 * the current one; chapter starts are always boundaries. */
export function topicBreaks(t: ClipTranscript, chapters: ClipChapter[] = []): Float32Array {
  const key = chapters.map(c => c.start).join(','), hit = breakCache.get(t);
  if (hit && hit.key === key) return hit.value;
  const S = t.sentences, n = S.length, out = new Float32Array(Math.max(0, n - 1));
  if (n >= 4) {
    const bags = S.map(s => bagOf(sentenceText(t, s))), df = new Map<string, number>();
    for (const b of bags) for (const w of b.keys()) df.set(w, (df.get(w) ?? 0) + 1);
    const idf = (w: string) => Math.log(1 + n / (df.get(w) ?? 1));
    const raw = new Float32Array(n - 1), cover = new Float32Array(n - 1);
    for (let g = 0; g < n - 1; g++) {
      const left = new Map<string, number>(), right = new Map<string, number>();
      const add = (into: Map<string, number>, bag: Map<string, number>) => { for (const [w, c] of bag) into.set(w, (into.get(w) ?? 0) + c); };
      let i = g, k = 0;
      for (; i >= 0 && k < 8 && (k < 2 || S[g].e - S[i].s <= 25); i--, k++) add(left, bags[i]);
      const leftSpan = S[g].e - S[i + 1].s;
      for (i = g + 1, k = 0; i < n && k < 8 && (k < 2 || S[i].e - S[g + 1].s <= 25); i++, k++) add(right, bags[i]);
      raw[g] = cosine(left, right, idf);
      // Near the start or end of the video one window is short, and its similarity says little.
      cover[g] = Math.min(1, leftSpan / 20, (S[i - 1].e - S[g + 1].s) / 20);
    }
    const sim = raw.map((v, g) => (v + (raw[g - 1] ?? v) + (raw[g + 1] ?? v)) / 3), text = S.map(x => sentenceText(t, x));
    for (let g = 0; g < n - 1; g++) {
      const v = sim[g], pause = S[g + 1].s - S[g].e, cur = text[g], next = text[g + 1];
      let strength = 0;
      // Only a valley bottom is a boundary. Its depth is measured against the peaks on either side, so the scale of the
      // similarities (sparse chat or dense lectures) does not matter; near-zero similarity everywhere means no evidence.
      if ((g === 0 || v <= sim[g - 1]) && (g === n - 2 || v <= sim[g + 1])) {
        let i = g; while (i > 0 && sim[i - 1] >= sim[i]) i--;
        let j = g; while (j < n - 2 && sim[j + 1] >= sim[j]) j++;
        const peaks = sim[i] + sim[j], relative = (peaks - 2 * v) / Math.max(1e-6, peaks);
        // Word overlap alone is weak evidence in speech: it tops out at 0.6 unless a spoken cue or a pause agrees.
        strength = .6 * Math.max(0, Math.min(1, (relative - .2) / .4)) * Math.min(1, peaks / 2 / .06) * cover[g];
      }
      // Spoken cues are more reliable than word overlap in short passages: "Anyway…", a fresh question, a list or a story
      // start a topic; a reply, "and…", "that's why…" or a line that answers a setup or a question continue one.
      // A claim followed by "here's why" opens a point too.
      const claim = g + 2 < n && SETUP.test(text[g + 2]) && S[g + 2].s - S[g + 1].e < 1.5;
      strength += (SHIFT.test(next) ? .85 : 0) + (ANNOUNCE.test(next) || listCount(next) ? .5 : 0) + (QUESTION.test(next) && !QUESTION.test(cur) ? .35 : 0) + (POINT.test(next) ? .35 : 0) + (claim ? .45 : 0) + (pause >= 4 ? .4 : pause >= 2 ? .25 : 0);
      if (!SHIFT.test(next) && openerKind(next)) strength *= .15;
      if (SETUP.test(cur) || (QUESTION.test(cur) && !QUESTION.test(next))) strength *= .1;
      out[g] = Math.min(1, strength);
    }
  }
  for (const c of chapters) {
    if (!(c.start > 1) || n < 2) continue;
    let best = -1, bestD = 5;
    for (let g = 0; g < n - 1; g++) { const d = Math.abs((S[g].e + S[g + 1].s) / 2 - c.start); if (d < bestD) { bestD = d; best = g; } }
    if (best >= 0) out[best] = 1;
  }
  breakCache.set(t, { key, value: out });
  return out;
}

// ------------------------------------------------------------------ cut points
/** A start cut in the quietest 10 ms frame of the ~0.3 s before speech (the latest of the near-quietest), never inside
 * the previous word. Without loudness data it falls back to a fixed 80 ms lead-in. */
export function snapStart(energy: Uint8Array | undefined, speech: number, previousEnd = -Infinity) {
  const floor = Math.max(0, previousEnd + .02, speech - .3);
  if (!energy?.length || floor >= speech - .03) return Math.max(0, Math.max(floor, speech - .08));
  const i0 = Math.floor(floor * ENERGY_RATE), i1 = Math.floor((speech - .02) * ENERGY_RATE);
  let min = 255; for (let i = i0; i <= i1 && i < energy.length; i++) min = Math.min(min, energy[i]);
  for (let i = Math.min(i1, energy.length - 1); i >= i0; i--) if (energy[i] <= min + 3) return Math.round(i / ENERGY_RATE * 1000) / 1000;
  return Math.max(0, speech - .08);
}
/** An end cut in the first near-quietest frame of the ~0.35 s after speech, never inside the next word. */
export function snapEnd(energy: Uint8Array | undefined, speech: number, nextStart = Infinity) {
  const ceil = Math.min(nextStart - .02, speech + .35);
  if (!energy?.length || ceil <= speech + .05) return Math.max(speech + .02, Math.min(ceil, speech + .15));
  const i0 = Math.ceil((speech + .05) * ENERGY_RATE), i1 = Math.floor(ceil * ENERGY_RATE);
  let min = 255; for (let i = i0; i <= i1 && i < energy.length; i++) min = Math.min(min, energy[i]);
  for (let i = i0; i <= i1 && i < energy.length; i++) if (energy[i] <= min + 3) return Math.round((i + 1) / ENERGY_RATE * 1000) / 1000;
  return speech + .15;
}

// ------------------------------------------------------------------ repair
export type RepairOptions = { minSeconds: number; maxSeconds: number; breaks?: Float32Array | null; energy?: Uint8Array; action?: boolean };
export type RepairResult = { a: number; b: number; start: number; end: number; checks: ClipCheck[] };
type OpenIssue = 'answer' | 'connector' | 'reference' | 'response' | 'midsentence' | 'pronoun';
type EndIssue = 'setup' | 'question' | 'midsentence' | 'list' | 'claim';
const OPEN_FIXED: Record<OpenIssue, string> = {
  answer: 'Starts with the question it answers', connector: 'Starts where the thought begins', reference: 'Starts where the thought begins',
  response: 'Starts with what the reply responds to', midsentence: 'Starts at the start of the sentence', pronoun: 'Starts one sentence earlier, for context',
};
const OPEN_WARN: Record<OpenIssue, string> = {
  answer: 'Opens on an answer; its question did not fit', connector: 'Opens mid-thought', reference: 'Refers back to something before the clip',
  response: 'Opens on a reply to something before the clip', midsentence: 'Starts mid-sentence', pronoun: 'Opens on "he/she/they"',
};
const END_FIXED: Record<EndIssue, string> = { setup: 'Ends after the payoff', question: 'Includes the answer', midsentence: 'Ends at the end of the sentence', list: 'Includes the whole list', claim: 'Ends before the next point starts' };
const END_WARN: Record<EndIssue, string> = { setup: 'Ends on a setup before the payoff', question: 'Ends before the answer', midsentence: 'Ends mid-sentence', list: 'Cuts off a list', claim: 'Ends on a claim explained after the clip' };

/** Grows a sentence range [a, b] until it stands alone (when that fits the maximum length) and reports what it did. */
export function repairMoment(t: ClipTranscript, a0: number, b0: number, opts: RepairOptions): RepairResult {
  const S = t.sentences, n = S.length, W = t.words, punctuated = isPunctuated(t), checks: ClipCheck[] = [];
  const text = (i: number) => sentenceText(t, S[i]), last = (i: number) => W[S[i].b]?.t ?? '';
  const fits = (x: number, y: number) => S[y].e - S[x].s <= opts.maxSeconds + 1e-6;
  const brk = (g: number) => opts.breaks?.[g] ?? 0;
  let a = Math.max(0, Math.min(n - 1, a0)), b = Math.max(a, Math.min(n - 1, b0));

  const openIssue = (i: number): OpenIssue | null => {
    if (i <= 0) return null;
    const cur = text(i), gap = S[i].s - S[i - 1].e;
    if (punctuated && !TERMINAL.test(last(i - 1)) && gap < .7) return 'midsentence';
    if (QUESTION.test(last(i - 1)) && gap < 2.5 && !QUESTION.test(last(i))) return 'answer';
    if (CONNECTOR.test(cur)) return 'connector';
    if (REFERENCE.test(cur)) return 'reference';
    if (RESPONSE.test(cur) && gap < 1.5) return 'response';
    if (PRONOUN.test(cur) && gap < 1.2) return 'pronoun';
    return null;
  };
  let fixed: OpenIssue | null = null, open: OpenIssue | null = null;
  for (let step = 0; step < 3; step++) {
    const issue = openIssue(a);
    if (!issue) { open = null; break; }
    open = issue;
    // A question and its answer belong together even across a topic change; other repairs stay inside the topic.
    const crosses = issue !== 'answer' && issue !== 'midsentence' && brk(a - 1) > .85;
    if (crosses || !fits(a - 1, b)) break;
    if (issue === 'pronoun' && (S[a].s - S[a - 1].e > 1 || brk(a - 1) > .5)) break;
    a--; fixed ??= issue; open = null;
  }
  if (open && open !== 'pronoun') checks.push({ id: 'opening', level: 'warn', text: OPEN_WARN[open] });
  else checks.push(fixed ? { id: 'opening', level: 'fixed', text: OPEN_FIXED[fixed] } : { id: 'opening', level: 'ok', text: 'Clean start' });

  const promised = (x: number, y: number) => { for (let i = x; i <= y; i++) { const k = listCount(text(i)); if (k) return { k, from: i }; } return null; };
  const endIssue = (j: number): EndIssue | null => {
    if (j >= n - 1) return null;
    const cur = text(j), gap = S[j + 1].s - S[j].e;
    if (punctuated && !TERMINAL.test(last(j)) && gap < .7) return 'midsentence';
    if (SETUP.test(cur)) return 'setup';
    // "Most people get this wrong." then "Here's why.": the last line opens the next point.
    if (SETUP.test(text(j + 1)) && gap < 1.5 && !REFERENCE.test(cur)) return 'claim';
    if (QUESTION.test(last(j)) && gap < 1.5 && !AUDIENCE_QUESTION.test(cur) && !QUESTION.test(last(j + 1))) return 'question';
    const list = promised(a, j);
    if (list && !listDone(S.slice(list.from + 1, j + 1).map((_, k) => text(list.from + 1 + k)).join(' '), list.k)) return 'list';
    return null;
  };
  let endFixed: EndIssue | null = null, ending: EndIssue | null = null;
  for (let step = 0; step < 6; step++) {
    const issue = endIssue(b);
    if (!issue) { ending = null; break; }
    ending = issue;
    if (issue === 'claim') {
      // Better to end one line earlier on a finished point than to open a new one; else take its setup and payoff.
      if (b > a && S[b - 1].e - S[a].s >= opts.minSeconds && !endIssue(b - 1)) { b--; endFixed ??= issue; ending = null; break; }
      if (b + 2 >= n || !fits(a, b + 2)) break;
      b += 2; endFixed ??= 'setup'; ending = null; continue;
    }
    if (!fits(a, b + 1) || (issue === 'list' && brk(b) > .85)) break;
    b++; endFixed ??= issue; ending = null;
  }
  // The last item of a list needs its explanation too, when it fits and stays on topic.
  if (endFixed === 'list' && !ending && b + 1 < n && fits(a, b + 1) && brk(b) < .5 && S[b + 1].s - S[b].e < 1.2 && !listCount(text(b + 1))) b++;
  checks.push(ending ? { id: 'ending', level: 'warn', text: END_WARN[ending] } : endFixed ? { id: 'ending', level: 'fixed', text: END_FIXED[endFixed] } : { id: 'ending', level: 'ok', text: 'Ends on its point' });

  if (opts.breaks && b - a >= 3) {
    const lo = S[a].s + (S[b].e - S[a].s) * .2, hi = S[b].e - (S[b].e - S[a].s) * .2;
    let worst = 0;
    for (let g = a; g < b; g++) if (S[g].e >= lo && S[g + 1].s <= hi) worst = Math.max(worst, brk(g));
    if (worst > .75) checks.push({ id: 'topic', level: 'warn', text: 'Changes topic partway' });
  }
  const firstWord = W[S[a].a], lastWord = W[S[b].b];
  const start = snapStart(opts.energy, firstWord.s, W[S[a].a - 1]?.e), end = snapEnd(opts.energy, lastWord.e, W[S[b].b + 1]?.s);
  if (!opts.action) {
    const spoken = W.slice(S[a].a, S[b].b + 1).reduce((sum, w) => sum + (w.e - w.s), 0);
    if (spoken / Math.max(.1, end - start) < .4) checks.push({ id: 'speech', level: 'warn', text: 'Mostly silence or music' });
  }
  return { a, b, start: Math.max(0, start), end, checks };
}

/** Flow points lost to problems a repair could not fix. */
export const checkPenalty = (checks: ClipCheck[] = []) => checks.reduce((p, c) => p + (c.level !== 'warn' ? 0 : c.id === 'opening' || c.id === 'ending' ? 2 : 1.5), 0);
/** Speech coverage (0-1) of a time range, for choosing between talk and action picks. */
export function speechCoverage(words: ClipWord[], start: number, end: number) {
  let sum = 0;
  for (const w of words) if (w.e > start && w.s < end) sum += Math.min(end, w.e) - Math.max(start, w.s);
  return end > start ? sum / (end - start) : 0;
}
