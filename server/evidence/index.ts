import { storyboardKeyframes, adaptiveSceneThreshold, buildKeyframeCandidates } from './keyframes';
import type { KeyframeCandidate, KeyframeReason } from './keyframes';
import { scanSignals } from './scan';
import type { ScanOptions } from './scan';

export { FRAME_MARKER, FrameVault } from './vault';
export type { FrameLease, FrameMatch, FrameOwner } from './vault';

/** What Sprity Reels remembers about the picture of a video: where its scenes change and which frames stand for it. The
 * file holds numbers only (times, 128-bit hashes, change scores); no pixels, so there are no frames to delete. */
export type Evidence = {
  format: 'sprityreels-evidence'; version: 1; created: number;
  note: string;
  duration: number; gap: number; keyframesOnly: boolean; sceneChangeThreshold: number; scenes: number;
  candidates: KeyframeCandidate[];
};
export type StoryboardFrame = { t: number; reasons: KeyframeReason[]; scene: number };

/** Scans the picture in memory (see scan.ts) and keeps only the numbers. */
export async function buildEvidence(file: string, options: ScanOptions): Promise<Evidence> {
  const scan = await scanSignals(file, options);
  if (scan.samples.length < 2) throw new Error('The picture could not be sampled.');
  const threshold = adaptiveSceneThreshold(scan.samples);
  const candidates = buildKeyframeCandidates(scan.samples, { endSeconds: scan.to, sceneChangeThreshold: threshold });
  return {
    format: 'sprityreels-evidence', version: 1, created: Date.now(), note: 'Numbers only: times, hashes and change scores of sampled frames. No pictures are stored.',
    duration: options.duration, gap: scan.gap, keyframesOnly: scan.keyframesOnly, sceneChangeThreshold: threshold,
    scenes: new Set(candidates.map(c => c.sceneId)).size, candidates,
  };
}

export function validEvidence(value: unknown, duration: number): value is Evidence {
  const v = value as Partial<Evidence> | null;
  return !!v && v.format === 'sprityreels-evidence' && v.version === 1 && Array.isArray(v.candidates) && v.candidates.length >= 2
    && typeof v.sceneChangeThreshold === 'number' && typeof v.duration === 'number' && Math.abs(v.duration - duration) < 1.5;
}

/** About `want` frames across the range, scene changes first, none of them near-duplicates. Deterministic. */
export function evidenceStoryboard(evidence: Evidence, range: { start: number; end: number }, want: number, signal?: AbortSignal): StoryboardFrame[] {
  return storyboardKeyframes(evidence.candidates, range, want, { sceneChangeThreshold: evidence.sceneChangeThreshold, signal })
    .map(k => ({ t: k.timestampUs / 1e6, reasons: k.reasons, scene: Number(/(\d+)$/.exec(k.sceneId ?? '')?.[1] ?? 0) }));
}
