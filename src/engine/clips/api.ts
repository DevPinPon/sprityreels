import type { ClipDefaults, ClipJob, ClipMomentSet, ClipReaction, ClipRender, ClipShort, ClipSource } from './types';

/** Browser client for the local Sprity Reels API (/api/clips). */
export type ClipShortSummary = { id: string; sourceId: string; name: string; mode: 'clip' | 'commentary'; revision: number; updated: number; created: number; seconds: number;
  render: { status: ClipRender['status']; revision: number; progress: number; duration: number; current: boolean } | null };
export type ClipOverview = {
  tools: { linkImport: boolean; transcription: 'gpu' | 'cpu' | null; ffmpeg: boolean; encoder: 'nvenc' | 'x264' | null; faceTracking: boolean; fonts: boolean };
  gemini: { configured: boolean; source: 'env' | 'file' | null; hint: string | null };
  settings: ClipDefaults; usage: { monthUsd: number; totalUsd: number; calls: number; voiceSeconds: number; byShort: Record<string, number> };
  sources: ClipSource[]; shorts: ClipShortSummary[]; jobs: ClipJob[];
};
export type ClipSourceDetail = { source: ClipSource; moments: ClipMomentSet[]; shorts: ClipShortSummary[]; jobs: ClipJob[]; reactions: ClipReaction[] };
export type ClipShortDetail = {
  short: ClipShort; render: ClipRender | null; source: { id: string; title: string; duration: number; creator: { name: string; url: string | null } | null; rights: string; url: string | null } | null;
  timeline: { duration: number; removed: number; words: { key: string; text: string; s: number; e: number; emphasis: boolean }[] } | null; costUsd: number; voiceEstimateUsd: number;
};
const headers = { 'Content-Type': 'application/json', 'X-SprityReels-Request': 'clips' };
export async function clipsAPI<T>(route: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/clips${route}`, body === undefined ? { cache: 'no-store' } : { method: 'POST', headers, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status}).`), { status: res.status });
  return data as T;
}
export async function uploadClipSource(file: File, rights: string, note: string, onProgress?: (fraction: number) => void, watch = true) {
  // XMLHttpRequest reports upload progress; fetch does not.
  return new Promise<{ source: ClipSource; job: ClipJob }>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/clips/sources/upload?file=${encodeURIComponent(file.name)}&rights=${encodeURIComponent(rights)}&note=${encodeURIComponent(note)}&watch=${watch}`);
    xhr.setRequestHeader('X-SprityReels-Request', 'clips');
    xhr.upload.onprogress = e => { if (e.lengthComputable) onProgress?.(e.loaded / e.total); };
    xhr.onload = () => { let data: any = {}; try { data = JSON.parse(xhr.responseText); } catch { /* keep empty */ } if (xhr.status >= 200 && xhr.status < 300) resolve(data); else reject(new Error(data.error || `Upload failed (${xhr.status}).`)); };
    xhr.onerror = () => reject(new Error('The upload was interrupted.'));
    xhr.send(file);
  });
}
