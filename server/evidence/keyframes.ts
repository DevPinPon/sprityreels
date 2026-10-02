import { createHash } from 'node:crypto';

/** Deterministic, scene-aware keyframe selection for long videos.
 *
 * Adapted from Rinegan ("Sprity", MIT): src/evidence-selection.ts (selectDeterministicKeyframes) and the signal helpers of
 * src/evidence.ts. The selection rules are Rinegan's: near-duplicate frames are dropped by perceptual-hash distance, but a
 * scene boundary, a short-lived transient state and the frames that keep the largest gap between kept frames under a
 * ceiling are never dropped as duplicates; identical inputs give identical output whatever their order. What changed for
 * Sprity Reels: the signals come from a sparse sample of a long video instead of every frame of a short recording, and the
 * scene threshold adapts to that spacing. Nothing here touches the disk: a signal is a 64x64 grey copy of a frame, held in
 * memory only while the scan runs; what is kept afterwards is numbers (a time, a 128-bit hash, a change score). */
export type Interval = { startUs: number; endUs: number };
export type KeyframeCandidate = {
  id: string;
  sourceFrameIndex: number;
  /** The frame's presentation time in the source video, in microseconds. */
  timestampUs: number;
  /** The stretch of the video this sample stands for (until the next sample). */
  coverage?: Interval;
  sceneId: string | null;
  changeScore: number;
  /** Hex-encoded perceptual hash; null disables duplicate comparison for this frame. */
  perceptualHash: string | null;
  transientState: boolean;
  transientDurationUs: number | null;
};
export type KeyframePolicy = {
  interval: Interval;
  mode: 'sparse' | 'dense';
  minFrames: number;
  maxFrames: number;
  /** The largest wanted distance between the interval's edges and the kept frames. */
  maxCoverageGapUs: number;
  /** Applied to optional density fill only. */
  minSpacingUs: number;
  changeThreshold: number;
  nearDuplicateHammingDistance: number;
  nearDuplicateWindowUs: number;
  transientMaxDurationUs: number;
};
export type KeyframeReason = 'transient_state' | 'scene_boundary' | 'change_point' | 'temporal_coverage' | 'density_fill';
export type SelectedKeyframe = KeyframeCandidate & { reasons: KeyframeReason[] };
export type KeyframeSelection = {
  mode: 'sparse' | 'dense';
  selected: SelectedKeyframe[];
  duplicateSuppression: {
    comparedPairs: number;
    suppressed: { id: string; duplicateOf: string; hammingDistance: number }[];
    preservedTransientIds: string[];
    preservedSceneBoundaryIds: string[];
    preservedTemporalCoverageIds: string[];
  };
  coverage: {
    requestedInterval: Interval;
    selectedTimestampSpan: Interval | null;
    actualIntervals: Interval[];
    actualCoverageRatio: number;
    largestTimestampGapUs: number;
    maxCoverageGapUs: number;
    floorFeasible: boolean;
    floorMet: boolean;
    minFrames: number;
    maxFrames: number;
  };
  omitted: { id: string; reason: 'near_duplicate' | 'frame_ceiling' | 'spacing' }[];
  policyFingerprint: string;
};

const SIGNAL_SIDE = 64, HASH_SIDE = 8;
export const SIGNAL_PIXELS = SIGNAL_SIDE * SIGNAL_SIDE;

// ------------------------------------------------------------------ small helpers
function assertInt(value: number, label: string, minimum = 0) { if (!Number.isSafeInteger(value) || value < minimum) throw new RangeError(`${label} must be a whole number of at least ${minimum}.`); }
function assertUnit(value: number, label: string) { if (!Number.isFinite(value) || value < 0 || value > 1) throw new RangeError(`${label} must be between 0 and 1.`); }
function assertInterval(value: Interval, label: string) {
  assertInt(value.startUs, `${label}.startUs`); assertInt(value.endUs, `${label}.endUs`);
  if (value.endUs <= value.startUs) throw new RangeError(`${label} must not be empty.`);
}
const duration = (value: Interval) => value.endUs - value.startUs;
function mergeIntervals(values: readonly Interval[], outer?: Interval) {
  const clipped = values.map(v => outer ? { startUs: Math.max(v.startUs, outer.startUs), endUs: Math.min(v.endUs, outer.endUs) } : { ...v })
    .filter(v => v.endUs > v.startUs).sort((a, b) => a.startUs - b.startUs || a.endUs - b.endUs);
  const merged: Interval[] = [];
  for (const v of clipped) { const last = merged[merged.length - 1]; if (!last || v.startUs > last.endUs) merged.push({ ...v }); else last.endUs = Math.max(last.endUs, v.endUs); }
  return merged;
}
const NIBBLE_BITS = [0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4];
/** Number of differing bits between two hex hashes; null when they are not the same size. */
export function perceptualHashHammingDistance(left: string, right: string) {
  if (!/^[0-9a-f]+$/i.test(left) || !/^[0-9a-f]+$/i.test(right)) throw new TypeError('Perceptual hashes must be non-empty hexadecimal strings.');
  if (left.length !== right.length) return null;
  let distance = 0;
  for (let i = 0; i < left.length; i++) distance += NIBBLE_BITS[parseInt(left[i], 16) ^ parseInt(right[i], 16)] ?? 0;
  return distance;
}
function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(k => `${JSON.stringify(k)}:${stableJson(record[k])}`).join(',')}}`;
}
const fingerprint = (value: unknown) => createHash('sha256').update(stableJson(value), 'utf8').digest('hex');
const transient = (c: KeyframeCandidate, policy: KeyframePolicy) => c.transientState && c.transientDurationUs !== null && c.transientDurationUs <= policy.transientMaxDurationUs;

type Flags = { transient: boolean; boundary: boolean; coverage: boolean };
function comparePriorityDescending(left: { candidate: KeyframeCandidate; flags: Flags }, right: { candidate: KeyframeCandidate; flags: Flags }) {
  const l = [+left.flags.transient, +left.flags.boundary, +left.flags.coverage, left.candidate.changeScore];
  const r = [+right.flags.transient, +right.flags.boundary, +right.flags.coverage, right.candidate.changeScore];
  for (let i = 0; i < 4; i++) if (r[i] - l[i] !== 0) return r[i] - l[i];
  return left.candidate.id.localeCompare(right.candidate.id);
}
function coverageMetrics(selected: readonly KeyframeCandidate[], policy: KeyframePolicy, floorFeasible: boolean): KeyframeSelection['coverage'] {
  const sorted = [...selected].sort((a, b) => a.timestampUs - b.timestampUs || a.id.localeCompare(b.id));
  let largest = duration(policy.interval), span: Interval | null = null;
  if (sorted.length) {
    largest = Math.max(sorted[0].timestampUs - policy.interval.startUs, policy.interval.endUs - sorted[sorted.length - 1].timestampUs);
    for (let i = 1; i < sorted.length; i++) largest = Math.max(largest, sorted[i].timestampUs - sorted[i - 1].timestampUs);
    span = { startUs: sorted[0].timestampUs, endUs: Math.max(sorted[0].timestampUs + 1, sorted[sorted.length - 1].timestampUs + 1) };
  }
  const actual = mergeIntervals(sorted.flatMap(c => c.coverage ? [c.coverage] : []), policy.interval);
  return {
    requestedInterval: { ...policy.interval }, selectedTimestampSpan: span, actualIntervals: actual,
    actualCoverageRatio: actual.reduce((total, i) => total + duration(i), 0) / duration(policy.interval),
    largestTimestampGapUs: largest, maxCoverageGapUs: policy.maxCoverageGapUs, floorFeasible,
    floorMet: sorted.length >= policy.minFrames && largest <= policy.maxCoverageGapUs, minFrames: policy.minFrames, maxFrames: policy.maxFrames,
  };
}

/** The smallest chain of timestamps that keeps every gap under the ceiling while retaining every mandatory frame (a
 * furthest-reachable choice is optimal on a one-dimensional timeline; mandatory frames split the problem), then a
 * deterministic farthest-point fill up to minFrames. */
function coveragePlan(available: readonly KeyframeCandidate[], mandatoryIds: ReadonlySet<string>, policy: KeyframePolicy) {
  const ids = new Set<string>(mandatoryIds), mandatory = available.filter(c => mandatoryIds.has(c.id));
  let cursor = policy.interval.startUs, feasible = available.length >= policy.minFrames && mandatory.length <= policy.maxFrames;
  const furthest = (limit: number, before: number) => {
    const reachable = available.filter(c => c.timestampUs > cursor && c.timestampUs <= limit && c.timestampUs < before);
    if (!reachable.length) return null;
    return [...reachable].sort((a, b) => b.timestampUs - a.timestampUs || Number(mandatoryIds.has(b.id)) - Number(mandatoryIds.has(a.id)) || b.changeScore - a.changeScore || a.id.localeCompare(b.id))[0];
  };
  for (const target of mandatory) {
    while (feasible && target.timestampUs - cursor > policy.maxCoverageGapUs) {
      const filler = furthest(cursor + policy.maxCoverageGapUs, target.timestampUs);
      if (!filler) { feasible = false; break; }
      ids.add(filler.id); cursor = filler.timestampUs;
      if (ids.size > policy.maxFrames) feasible = false;
    }
    cursor = Math.max(cursor, target.timestampUs);
  }
  while (feasible && policy.interval.endUs - cursor > policy.maxCoverageGapUs) {
    const filler = furthest(cursor + policy.maxCoverageGapUs, policy.interval.endUs);
    if (!filler) { feasible = false; break; }
    ids.add(filler.id); cursor = filler.timestampUs;
    if (ids.size > policy.maxFrames) feasible = false;
  }
  while (feasible && ids.size < policy.minFrames) {
    const remaining = available.filter(c => !ids.has(c.id));
    if (!remaining.length) { feasible = false; break; }
    const anchors = [policy.interval.startUs, policy.interval.endUs, ...available.filter(c => ids.has(c.id)).map(c => c.timestampUs)];
    const nearest = (c: KeyframeCandidate) => Math.min(...anchors.map(a => Math.abs(c.timestampUs - a)));
    ids.add([...remaining].sort((a, b) => nearest(b) - nearest(a) || b.changeScore - a.changeScore || a.id.localeCompare(b.id))[0].id);
    if (ids.size > policy.maxFrames) feasible = false;
  }
  return { ids, feasible };
}
/** Evenly spaced picks when a full chain does not fit under the frame ceiling. */
function fallbackCoverage(available: readonly KeyframeCandidate[], policy: KeyframePolicy) {
  const ids = new Set<string>(), total = duration(policy.interval);
  const buckets = Math.min(policy.maxFrames, Math.max(1, Math.ceil(total / policy.maxCoverageGapUs)));
  for (let b = 0; b < buckets; b++) {
    const start = policy.interval.startUs + Math.floor(total * b / buckets), end = policy.interval.startUs + Math.floor(total * (b + 1) / buckets), mid = start + Math.floor((end - start) / 2);
    const inside = available.filter(c => c.timestampUs >= start && c.timestampUs < end), pool = inside.length ? inside : available;
    const winner = [...pool].sort((a, b2) => Math.abs(a.timestampUs - mid) - Math.abs(b2.timestampUs - mid) || b2.changeScore - a.changeScore || a.id.localeCompare(b2.id))[0];
    if (winner) ids.add(winner.id);
  }
  return ids;
}

function validatePolicy(policy: KeyframePolicy) {
  assertInterval(policy.interval, 'policy.interval');
  assertInt(policy.minFrames, 'policy.minFrames', 1); assertInt(policy.maxFrames, 'policy.maxFrames', 1);
  if (policy.maxFrames < policy.minFrames) throw new RangeError('policy.maxFrames must be at least policy.minFrames.');
  assertInt(policy.maxCoverageGapUs, 'policy.maxCoverageGapUs', 1); assertInt(policy.minSpacingUs, 'policy.minSpacingUs');
  assertUnit(policy.changeThreshold, 'policy.changeThreshold');
  assertInt(policy.nearDuplicateHammingDistance, 'policy.nearDuplicateHammingDistance'); assertInt(policy.nearDuplicateWindowUs, 'policy.nearDuplicateWindowUs'); assertInt(policy.transientMaxDurationUs, 'policy.transientMaxDurationUs');
}

/** Deterministic scene- and change-aware selection (Rinegan's authority, without the persistence layer). previousSceneId is
 * the scene of the sample just before the first candidate, when the candidates are one window of a longer timeline: it lets
 * a scene change that falls exactly on the window's edge count as a boundary. */
export function selectDeterministicKeyframes(candidates: readonly KeyframeCandidate[], policy: KeyframePolicy, control: { signal?: AbortSignal; previousSceneId?: string | null } = {}): KeyframeSelection {
  const { signal } = control;
  validatePolicy(policy);
  signal?.throwIfAborted();
  const seen = new Set<string>();
  const sorted = candidates.map((c, i) => {
    if (!c.id.trim() || seen.has(c.id)) throw new TypeError('Keyframe ids must be non-empty and unique.');
    seen.add(c.id);
    assertInt(c.sourceFrameIndex, `candidates[${i}].sourceFrameIndex`); assertInt(c.timestampUs, `candidates[${i}].timestampUs`);
    if (c.timestampUs < policy.interval.startUs || c.timestampUs >= policy.interval.endUs) throw new RangeError('Keyframe timestamps must be inside the requested interval.');
    assertUnit(c.changeScore, `candidates[${i}].changeScore`);
    if (c.perceptualHash !== null && !/^[0-9a-f]+$/i.test(c.perceptualHash)) throw new TypeError('Perceptual hashes must be non-empty hexadecimal strings.');
    if (c.transientDurationUs !== null) assertInt(c.transientDurationUs, `candidates[${i}].transientDurationUs`, 1);
    if (c.transientState !== (c.transientDurationUs !== null)) throw new TypeError('transientState and transientDurationUs must be declared together.');
    if (c.coverage) {
      assertInterval(c.coverage, `candidates[${i}].coverage`);
      if (c.timestampUs < c.coverage.startUs || c.timestampUs >= c.coverage.endUs) throw new RangeError('Keyframe coverage must contain its exact timestamp.');
    }
    return { ...c, coverage: c.coverage ? { ...c.coverage } : undefined };
  }).sort((a, b) => a.timestampUs - b.timestampUs || a.sourceFrameIndex - b.sourceFrameIndex || a.id.localeCompare(b.id));

  const boundaryIds = new Set<string>();
  if (control.previousSceneId !== undefined && sorted.length && sorted[0].sceneId !== control.previousSceneId) boundaryIds.add(sorted[0].id);
  for (let i = 1; i < sorted.length; i++) if (sorted[i].sceneId !== sorted[i - 1].sceneId) boundaryIds.add(sorted[i].id);
  const transientIds = new Set(sorted.filter(c => transient(c, policy)).map(c => c.id));
  const plan = coveragePlan(sorted, new Set([...boundaryIds, ...transientIds]), policy);
  const coverageIds = plan.feasible ? plan.ids : fallbackCoverage(sorted, policy);

  const representatives: KeyframeCandidate[] = [];
  const suppressed: KeyframeSelection['duplicateSuppression']['suppressed'] = [];
  const keptTransient = new Set<string>(), keptBoundary = new Set<string>(), keptCoverage = new Set<string>();
  let comparedPairs = 0;
  for (const candidate of sorted) {
    signal?.throwIfAborted();
    let duplicate: { representative: KeyframeCandidate; distance: number } | null = null;
    if (candidate.perceptualHash !== null) {
      for (let i = representatives.length - 1; i >= 0; i--) {
        const representative = representatives[i];
        if (candidate.timestampUs - representative.timestampUs > policy.nearDuplicateWindowUs) break;
        if (representative.perceptualHash === null) continue;
        comparedPairs++;
        const distance = perceptualHashHammingDistance(candidate.perceptualHash, representative.perceptualHash);
        if (distance !== null && distance <= policy.nearDuplicateHammingDistance) { duplicate = { representative, distance }; break; }
      }
    }
    const isTransient = transient(candidate, policy), isBoundary = boundaryIds.has(candidate.id), isCoverage = coverageIds.has(candidate.id);
    if (duplicate && !isTransient && !isBoundary && !isCoverage) { suppressed.push({ id: candidate.id, duplicateOf: duplicate.representative.id, hammingDistance: duplicate.distance }); continue; }
    if (duplicate && isTransient) keptTransient.add(candidate.id);
    if (duplicate && isBoundary) keptBoundary.add(candidate.id);
    if (duplicate && isCoverage) keptCoverage.add(candidate.id);
    representatives.push(candidate);
  }

  const entries = representatives.map(candidate => ({ candidate, flags: { transient: transient(candidate, policy), boundary: boundaryIds.has(candidate.id), coverage: coverageIds.has(candidate.id) } }));
  const mandatory = entries.filter(({ flags }) => flags.transient || flags.boundary || flags.coverage).sort(comparePriorityDescending);
  const selectedIds = new Set(mandatory.slice(0, policy.maxFrames).map(({ candidate }) => candidate.id));
  const desired = policy.mode === 'dense' ? policy.maxFrames : Math.min(policy.maxFrames, Math.max(policy.minFrames, coverageIds.size, selectedIds.size));
  const byId = new Map(representatives.map(c => [c.id, c]));

  const remainder = entries.filter(({ candidate }) => !selectedIds.has(candidate.id)).sort(comparePriorityDescending);
  const spacingOmitted = new Set<string>();
  for (const entry of remainder) {
    if (selectedIds.size >= desired) break;
    signal?.throwIfAborted();
    const important = entry.flags.transient || entry.flags.boundary || entry.candidate.changeScore >= policy.changeThreshold;
    const tooClose = [...selectedIds].some(id => Math.abs(byId.get(id)!.timestampUs - entry.candidate.timestampUs) < policy.minSpacingUs);
    if (tooClose && !important) { spacingOmitted.add(entry.candidate.id); continue; }
    selectedIds.add(entry.candidate.id);
  }
  if (selectedIds.size < Math.min(desired, representatives.length)) {
    for (const entry of remainder) { if (selectedIds.size >= Math.min(desired, representatives.length)) break; selectedIds.add(entry.candidate.id); }
  }

  const selected: SelectedKeyframe[] = representatives.filter(c => selectedIds.has(c.id)).map(candidate => {
    const reasons: KeyframeReason[] = [];
    if (transient(candidate, policy)) reasons.push('transient_state');
    if (boundaryIds.has(candidate.id)) reasons.push('scene_boundary');
    if (candidate.changeScore >= policy.changeThreshold) reasons.push('change_point');
    if (coverageIds.has(candidate.id)) reasons.push('temporal_coverage');
    if (!reasons.length) reasons.push('density_fill');
    return { ...candidate, reasons };
  }).sort((a, b) => a.timestampUs - b.timestampUs || a.id.localeCompare(b.id));

  const omitted: KeyframeSelection['omitted'] = suppressed.map(({ id }) => ({ id, reason: 'near_duplicate' as const }));
  for (const c of representatives) if (!selectedIds.has(c.id)) omitted.push({ id: c.id, reason: spacingOmitted.has(c.id) ? 'spacing' : 'frame_ceiling' });
  return {
    mode: policy.mode, selected,
    duplicateSuppression: { comparedPairs, suppressed, preservedTransientIds: [...keptTransient].sort(), preservedSceneBoundaryIds: [...keptBoundary].sort(), preservedTemporalCoverageIds: [...keptCoverage].sort() },
    coverage: coverageMetrics(selected, policy, plan.feasible), omitted: omitted.sort((a, b) => a.id.localeCompare(b.id)), policyFingerprint: fingerprint(policy),
  };
}

// ------------------------------------------------------------------ signals: 64x64 grey frames -> hash, change, scenes
/** One sampled frame: its time in seconds and its 64x64 grey pixels (4096 bytes, held in memory only). */
export type SignalSample = { index: number; t: number; pixels: Uint8Array };

/** 8x8 block means of the 64x64 frame. */
function grid8x8(pixels: Uint8Array) {
  if (pixels.length !== SIGNAL_PIXELS) throw new Error('A signal must be an exact 64x64 grey frame.');
  const block = SIGNAL_SIDE / HASH_SIDE, grid = new Uint8Array(HASH_SIDE * HASH_SIDE);
  for (let gy = 0; gy < HASH_SIDE; gy++) for (let gx = 0; gx < HASH_SIDE; gx++) {
    let total = 0;
    for (let y = 0; y < block; y++) { const row = (gy * block + y) * SIGNAL_SIDE + gx * block; for (let x = 0; x < block; x++) total += pixels[row + x]; }
    grid[gy * HASH_SIDE + gx] = Math.round(total / (block * block));
  }
  return grid;
}
/** Two bits per block (the block's brightness quartile): 128 bits as 32 hex characters. */
export function grayHash(pixels: Uint8Array) {
  const grid = grid8x8(pixels), bytes = Buffer.alloc(grid.length / 4);
  for (let i = 0; i < grid.length; i++) bytes[Math.floor(i / 4)] |= (grid[i] >>> 6) << ((3 - (i % 4)) * 2);
  return bytes.toString('hex');
}
/** Mean absolute difference between two grey frames, 0 (identical) to 1. */
export function meanAbsoluteDifference(left: Uint8Array, right: Uint8Array) {
  if (left.length !== right.length || !left.length) throw new Error('Frames must have the same size.');
  let sum = 0;
  for (let i = 0; i < left.length; i++) sum += Math.abs(left[i] - right[i]);
  return sum / (left.length * 255);
}
export type CandidateOptions = { endSeconds: number; sceneChangeThreshold: number; nearDuplicateHammingDistance?: number; transientMaxDurationUs?: number };
export const NEAR_DUPLICATE_HAMMING = 4, TRANSIENT_MAX_US = 2_000_000;

/** A scene boundary is a change clearly above this video's usual change between samples: the 90th percentile, kept between
 * 0.12 (Rinegan's value for dense sampling) and 0.45, so a busy edit does not make every frame a boundary and a calm talk
 * still finds its cuts. */
export function adaptiveSceneThreshold(samples: readonly SignalSample[]) {
  const changes: number[] = [];
  for (let i = 1; i < samples.length; i++) changes.push(meanAbsoluteDifference(samples[i - 1].pixels, samples[i].pixels));
  // Too few samples for a percentile to mean anything (a short video, or a long one with few keyframes).
  if (changes.length < 40) return 0.2;
  changes.sort((a, b) => a - b);
  return Math.min(0.45, Math.max(0.12, changes[Math.min(changes.length - 1, Math.floor(changes.length * 0.9))]));
}

/** Turns scanned frames into candidates: hash, change from the previous sample, scene number, and short-scene-return
 * transients (a state that appears and goes back to what was there within transientMaxDurationUs). The frames themselves
 * are not kept. */
export function buildKeyframeCandidates(samples: readonly SignalSample[], options: CandidateOptions): KeyframeCandidate[] {
  const hamming = options.nearDuplicateHammingDistance ?? NEAR_DUPLICATE_HAMMING, transientMax = options.transientMaxDurationUs ?? TRANSIENT_MAX_US;
  const hashes = samples.map(s => grayHash(s.pixels));
  const us = samples.map(s => Math.max(0, Math.round(s.t * 1e6)));
  const change = samples.map((s, i) => i === 0 ? 1 : meanAbsoluteDifference(samples[i - 1].pixels, s.pixels));
  const scene: number[] = [];
  let number = 0;
  for (let i = 0; i < samples.length; i++) { if (i > 0 && change[i] >= options.sceneChangeThreshold) number++; scene.push(number); }

  const runs: { scene: number; from: number; to: number }[] = [];
  for (let i = 0; i < samples.length; i++) { const last = runs[runs.length - 1]; if (last?.scene === scene[i]) last.to = i; else runs.push({ scene: scene[i], from: i, to: i }); }
  const transientFor = new Map<number, number>();
  for (let r = 1; r + 1 < runs.length; r++) {
    const before = runs[r - 1], current = runs[r], after = runs[r + 1], length = us[after.from] - us[current.from];
    const back = perceptualHashHammingDistance(hashes[before.to], hashes[after.from]);
    if (length > 0 && length <= transientMax && back !== null && back <= hamming) for (let i = current.from; i <= current.to; i++) transientFor.set(i, length);
  }
  return samples.map((s, i) => {
    const endUs = Math.max(us[i] + 1, i + 1 < samples.length ? us[i + 1] : Math.round(options.endSeconds * 1e6));
    return {
      id: `kf-${createHash('sha256').update(JSON.stringify([s.index, us[i], hashes[i]])).digest('hex').slice(0, 16)}`,
      sourceFrameIndex: s.index, timestampUs: us[i], coverage: { startUs: us[i], endUs },
      sceneId: `scene-${String(scene[i]).padStart(6, '0')}`, changeScore: change[i], perceptualHash: hashes[i],
      transientState: transientFor.has(i), transientDurationUs: transientFor.get(i) ?? null,
    };
  });
}

/** A storyboard of about `want` frames across [startSeconds, endSeconds): the range is cut into windows, and each window
 * keeps its own scene changes first, then spreads the rest, so a busy stretch cannot use up every frame. */
export function storyboardKeyframes(candidates: readonly KeyframeCandidate[], range: { start: number; end: number }, want: number, options: { sceneChangeThreshold: number; signal?: AbortSignal }) {
  const startUs = Math.round(range.start * 1e6), endUs = Math.round(range.end * 1e6);
  const inside = candidates.filter(c => c.timestampUs >= startUs && c.timestampUs < endUs).sort((a, b) => a.timestampUs - b.timestampUs || a.sourceFrameIndex - b.sourceFrameIndex || a.id.localeCompare(b.id));
  if (endUs <= startUs || !inside.length) return [] as SelectedKeyframe[];
  const windows = Math.max(1, Math.min(Math.ceil(want / 5), Math.floor(inside.length / 3))), perWindow = Math.max(1, Math.ceil(want / windows));
  const out: SelectedKeyframe[] = [];
  for (let w = 0; w < windows; w++) {
    const from = startUs + Math.floor((endUs - startUs) * w / windows), to = w === windows - 1 ? endUs : startUs + Math.floor((endUs - startUs) * (w + 1) / windows);
    const here = inside.filter(c => c.timestampUs >= from && c.timestampUs < to);
    if (!here.length || to <= from) continue;
    const lowest = Math.max(1, Math.min(here.length, Math.floor(perWindow * 0.6))), highest = Math.min(here.length, perWindow);
    const picked = selectDeterministicKeyframes(here, {
      interval: { startUs: from, endUs: to }, mode: 'sparse', minFrames: lowest, maxFrames: highest,
      maxCoverageGapUs: Math.max(1, Math.ceil((to - from) / lowest)), minSpacingUs: Math.floor((to - from) / (perWindow * 3)),
      changeThreshold: options.sceneChangeThreshold, nearDuplicateHammingDistance: NEAR_DUPLICATE_HAMMING, nearDuplicateWindowUs: to - from, transientMaxDurationUs: TRANSIENT_MAX_US,
    }, { signal: options.signal, previousSceneId: inside.filter(c => c.timestampUs < from).at(-1)?.sceneId });
    out.push(...picked.selected);
  }
  return out.sort((a, b) => a.timestampUs - b.timestampUs);
}
