import { ENERGY_RATE, speechThreshold } from './transcript';

/** Action highlights from the sound and the picture. A transcript-only clipper misses the best moments of gameplay and
 * sports: a clutch play, a goal or a crowd roar often has no words at all, and a silent trick shot has no sound either.
 * Loud bursts come from the 10 ms loudness envelope (shouts, explosions, cheering, big laughs); visual bursts come from
 * how much the picture changes four times a second (fast motion, flashes, a flurry of cuts). Both are relative to the
 * surrounding half minute, so a loud or busy video does not turn every second into a peak. */
export type ExcitementPeak = { s: number; e: number; t: number; level: number };
/** One event, heard (audio: dB above its surroundings), seen (visual: picture-change levels above its surroundings) or
 * both. strength puts the two on one scale (20 dB or 40 levels is 1; together they add half of the weaker one). */
export type ActionPeak = { s: number; e: number; t: number; audio: number; visual: number; strength: number };
/** Picture-change samples per second: the mean absolute difference between frames 0.25 s apart, in 8-bit luma levels. */
export const VISUAL_RATE = 4;
const STEP = ENERGY_RATE / 10;

/** Loudness (dB above the -100 dBFS floor) at 0.1 s steps, smoothed over 0.3 s. */
export function loudnessSteps(energy: Uint8Array) {
  const n = Math.floor(energy.length / STEP), mean = new Float32Array(n);
  for (let k = 0; k < n; k++) { let sum = 0; for (let i = k * STEP; i < (k + 1) * STEP; i++) sum += energy[i]; mean[k] = sum / STEP; }
  return mean.map((_, k) => (mean[Math.max(0, k - 1)] + mean[k] + mean[Math.min(n - 1, k + 1)]) / 3);
}

/** Rolling median over ±half steps, with an incremental histogram of whole values from 0 to max. */
export function rollingMedian(values: Float32Array, half: number, max = 100) {
  const n = values.length, out = new Float32Array(n), hist = new Uint32Array(max + 1), bin = (v: number) => Math.max(0, Math.min(max, Math.round(v)));
  let count = 0, lo = 0, hi = -1;
  for (let k = 0; k < n; k++) {
    while (hi < Math.min(n - 1, k + half)) { hi++; hist[bin(values[hi])]++; count++; }
    while (lo < k - half) { hist[bin(values[lo])]--; count--; lo++; }
    let acc = 0, v = 0;
    for (; v <= max; v++) { acc += hist[v]; if (acc * 2 >= count) break; }
    out[k] = v;
  }
  return out;
}

/** Bursts at least minLevel dB above the local median for 0.4 s or more, loudest first, at least minGap seconds apart. */
export function excitementPeaks(energy: Uint8Array | undefined, opts: { minLevel?: number; minGap?: number; max?: number } = {}): ExcitementPeak[] {
  if (!energy || energy.length < 5 * ENERGY_RATE) return [];
  const minLevel = opts.minLevel ?? 6, minGap = opts.minGap ?? 20, max = opts.max ?? 40;
  const level = loudnessSteps(energy), base = rollingMedian(level, 150), floor = speechThreshold(energy);
  const regions: ExcitementPeak[] = [];
  let open: ExcitementPeak | null = null, quietSince = 0;
  for (let k = 0; k <= level.length; k++) {
    const x = k < level.length && level[k] >= floor ? level[k] - base[k] : 0;
    if (x >= minLevel) {
      if (!open) open = { s: k / 10, e: (k + 1) / 10, t: k / 10, level: x };
      open.e = (k + 1) / 10; quietSince = k + 1;
      if (x > open.level) { open.level = x; open.t = k / 10; }
    } else if (open && k - quietSince >= 5) {
      // Bursts separated by less than half a second are one event (a scream, then the crowd).
      if (open.e - open.s >= .4) regions.push(open);
      open = null;
    }
  }
  if (open && open.e - open.s >= .4) regions.push(open);
  const picked: ExcitementPeak[] = [];
  for (const r of regions.sort((a, b) => b.level * Math.sqrt(b.e - b.s) - a.level * Math.sqrt(a.e - a.s))) {
    if (picked.length >= max) break;
    if (picked.some(p => Math.abs(p.t - r.t) < minGap)) continue;
    picked.push({ s: round(r.s), e: round(r.e), t: round(r.t), level: Math.round(r.level * 10) / 10 });
  }
  return picked;
}
const round = (x: number) => Math.round(x * 100) / 100;

/** Bursts of picture change: at least minLevel levels (and half the local median) above the surrounding half minute for
 * 0.75 s or more, strongest first. Each sample is the median of the 1.25 s around it, so a single hard cut counts for
 * nothing while fast motion, a flash that lingers or a flurry of cuts counts in full. */
export function visualPeaks(visual: Uint8Array | undefined, opts: { minLevel?: number; minGap?: number; max?: number } = {}): ExcitementPeak[] {
  if (!visual || visual.length < 5 * VISUAL_RATE) return [];
  const minLevel = opts.minLevel ?? 12, minGap = opts.minGap ?? 20, max = opts.max ?? 40, n = visual.length;
  const smooth = new Float32Array(n), near: number[] = [];
  for (let k = 0; k < n; k++) {
    near.length = 0;
    for (let i = Math.max(0, k - 2); i <= Math.min(n - 1, k + 2); i++) near.push(visual[i]);
    near.sort((a, b) => a - b); smooth[k] = near[near.length >> 1];
  }
  const base = rollingMedian(smooth, 15 * VISUAL_RATE, 255), regions: ExcitementPeak[] = [];
  let open: ExcitementPeak | null = null, calmSince = 0;
  for (let k = 0; k <= n; k++) {
    const x = k < n ? smooth[k] - base[k] : 0, hot = k < n && x >= Math.max(minLevel, base[k] * .5);
    if (hot) {
      if (!open) open = { s: k / VISUAL_RATE, e: (k + 1) / VISUAL_RATE, t: k / VISUAL_RATE, level: x };
      open.e = (k + 1) / VISUAL_RATE; calmSince = k + 1;
      if (x > open.level) { open.level = x; open.t = k / VISUAL_RATE; }
    } else if (open && k - calmSince >= 2) {
      if (open.e - open.s >= .75) regions.push(open);
      open = null;
    }
  }
  if (open && open.e - open.s >= .75) regions.push(open);
  const picked: ExcitementPeak[] = [];
  for (const r of regions.sort((a, b) => b.level * Math.sqrt(b.e - b.s) - a.level * Math.sqrt(a.e - a.s))) {
    if (picked.length >= max) break;
    if (picked.some(p => Math.abs(p.t - r.t) < minGap)) continue;
    picked.push({ s: round(r.s), e: round(r.e), t: round(r.t), level: Math.round(r.level * 10) / 10 });
  }
  return picked;
}

/** Loud and visual bursts merged into events (within 2.5 s of each other they are one play, heard and seen). */
export function actionPeaks(energy: Uint8Array | undefined, visual: Uint8Array | undefined, opts: { minGap?: number; max?: number } = {}): ActionPeak[] {
  const minGap = opts.minGap ?? 20, max = opts.max ?? 40, events: ActionPeak[] = [];
  for (const p of excitementPeaks(energy, { minGap: 3, max: 120 })) events.push({ s: p.s, e: p.e, t: p.t, audio: p.level, visual: 0, strength: 0 });
  for (const p of visualPeaks(visual, { minGap: 3, max: 120 })) {
    const same = events.find(x => Math.abs(x.t - p.t) <= 2.5 || (p.s <= x.e + 1 && p.e >= x.s - 1));
    if (same) { same.visual = Math.max(same.visual, p.level); same.s = Math.min(same.s, p.s); same.e = Math.max(same.e, p.e); }
    else events.push({ s: p.s, e: p.e, t: p.t, audio: 0, visual: p.level, strength: 0 });
  }
  for (const x of events) { const a = Math.min(1.5, x.audio / 20), v = Math.min(1.5, x.visual / 40); x.strength = Math.round((Math.max(a, v) + .5 * Math.min(a, v)) * 100) / 100; }
  const picked: ActionPeak[] = [];
  for (const x of events.sort((a, b) => b.strength * Math.sqrt(Math.min(4, b.e - b.s)) - a.strength * Math.sqrt(Math.min(4, a.e - a.s)))) {
    if (picked.length >= max) break;
    if (picked.some(p => Math.abs(p.t - x.t) < minGap)) continue;
    picked.push(x);
  }
  return picked;
}

/** FFmpeg metadata=print output of the scdet filter ("pts_time:1.25" then "lavfi.scd.mafd=2.4", mean absolute frame
 * difference in percent) at VISUAL_RATE frames per second, as one 0-255 luma-level sample per slot. */
export function parseVisualActivity(text: string, duration: number) {
  const out = new Uint8Array(Math.max(0, Math.ceil(duration * VISUAL_RATE)));
  let t = NaN;
  for (const line of text.split(/\r?\n/)) {
    const time = /pts_time:(-?[\d.]+)/.exec(line);
    if (time) { t = Number(time[1]); continue; }
    const m = /lavfi\.scd\.mafd=([\d.]+)/.exec(line);
    if (!m || !Number.isFinite(t)) continue;
    const k = Math.round(t * VISUAL_RATE);
    if (k >= 0 && k < out.length) out[k] = Math.max(0, Math.min(255, Math.round(Number(m[1]) * 2.55)));
  }
  return out;
}
