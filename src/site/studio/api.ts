import type { ClipDefaults, ClipJob, ClipMomentSet, ClipSource } from '../../engine/clips/types';
import type { ClipShortDetail, ClipShortSummary } from '../../engine/clips/api';

export { clipsAPI, uploadClipSource } from '../../engine/clips/api';
export type { ClipShortDetail, ClipShortSummary };

export type Overview = {
  tools: { linkImport: boolean; transcription: 'gpu' | 'cpu' | null; ffmpeg: boolean; encoder: 'nvenc' | 'x264' | null; faceTracking: boolean; fonts: boolean };
  ai: { gemini: boolean; claude: boolean };
  limits: { uploadBytes: number; maxVideoMinutes: number; retentionHours: number; /** Minutes of video a visitor may import a day (0: no limit) and what is left today. */ minutesPerDay: number; minutesLeft: number | null };
  settings: ClipDefaults;
  sources: ClipSource[];
  shorts: ClipShortSummary[];
  jobs: ClipJob[];
};
export type SourceDetail = { source: ClipSource; moments: ClipMomentSet[]; shorts: ClipShortSummary[]; jobs: ClipJob[] };

/** What the visitor chooses before the reels are made; it maps onto the options of a short. */
export type ReelStyle = { captions: boolean; preset: ClipDefaults['captions']['preset']; aspect: ClipDefaults['aspect']; subject: ClipDefaults['subject']; hook: boolean; bleep: boolean };
export const DEFAULT_STYLE: ReelStyle = { captions: true, preset: 'pop', aspect: '9:16', subject: 'auto', hook: true, bleep: false };
export const styleOptions = (s: ReelStyle) => ({ aspect: s.aspect, subject: s.subject, captions: { enabled: s.captions, preset: s.preset }, hook: { enabled: s.hook }, censor: { enabled: s.bleep, style: 'bleep' } });

export const LENGTHS = [
  { id: 'short', label: 'Short', hint: '15–30 s', min: 15, max: 30 },
  { id: 'standard', label: 'Standard', hint: '30–60 s', min: 30, max: 60 },
  { id: 'long', label: 'Long', hint: '60–90 s', min: 60, max: 90 },
] as const;
export type LengthId = typeof LENGTHS[number]['id'];

export const message = (error: unknown) => error instanceof Error ? error.message : 'Something went wrong. Try again.';
