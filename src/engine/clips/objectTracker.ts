import { ObjectDetector } from '@mediapipe/tasks-vision';
import wasmLoaderPath from '@mediapipe/tasks-vision/vision_wasm_internal.js?url';
import wasmBinaryPath from '@mediapipe/tasks-vision/vision_wasm_internal.wasm?url';
import { delegatesToTry } from './delegate';
import type { MotionBox, ObjectBox } from './subjects';
import { SUBJECT_LABELS, motionBox, objectKind } from './subjects';

/** Browser-side subject tracking for the tracker page: MediaPipe's EfficientDet-Lite0 object detector (Apache-2.0,
 * installed by npm run setup:clips) finds people, balls, vehicles and animals, and a 64-pixel grey copy of every frame
 * shows where the picture moves. */
export type ObjectFinder = { detect: (image: ImageBitmap) => ObjectBox[]; delegate: 'GPU' | 'CPU'; close: () => void };
const options = (delegate: 'GPU' | 'CPU') => ({
  baseOptions: { modelAssetPath: '/mediapipe/efficientdet_lite0.tflite', delegate }, runningMode: 'IMAGE' as const,
  scoreThreshold: .3, maxResults: 16, categoryAllowlist: SUBJECT_LABELS,
});
export async function createObjectFinder(): Promise<ObjectFinder> {
  const files = { wasmLoaderPath, wasmBinaryPath };
  let detector: ObjectDetector | null = null, delegate: 'GPU' | 'CPU' = 'CPU', last: unknown;
  for (const tried of delegatesToTry()) {
    try { detector = await ObjectDetector.createFromOptions(files, options(tried)); delegate = tried; break; } catch (error) { last = error; }
  }
  if (!detector) throw last;
  const found = detector;
  const r = (v: number) => Math.round(v * 1e4) / 1e4;
  return {
    delegate,
    detect: image => {
      const out: ObjectBox[] = [];
      for (const d of found.detect(image).detections) {
        const best = d.categories[0], box = d.boundingBox, kind = best ? objectKind(best.categoryName) : null;
        if (!kind || !box || !(box.width > 0) || !(box.height > 0)) continue;
        out.push({ x: r((box.originX + box.width / 2) / image.width), y: r((box.originY + box.height / 2) / image.height), w: r(box.width / image.width), h: r(box.height / image.height), score: r(best.score), kind });
      }
      return out;
    },
    close: () => found.close(),
  };
}

/** Motion between consecutive frames (at most 0.3 s apart, so never across two ranges of a short). */
export function createMotionMeter() {
  const canvas = document.createElement('canvas'), ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  let prev: { luma: Uint8Array; t: number; w: number; h: number } | null = null;
  return (image: ImageBitmap, t: number): MotionBox | null => {
    const w = 64, h = Math.max(8, Math.round(64 * image.height / Math.max(1, image.width)));
    canvas.width = w; canvas.height = h;
    ctx.drawImage(image, 0, 0, w, h);
    const rgba = ctx.getImageData(0, 0, w, h).data, luma = new Uint8Array(w * h);
    for (let i = 0; i < luma.length; i++) luma[i] = (rgba[i * 4] * 77 + rgba[i * 4 + 1] * 150 + rgba[i * 4 + 2] * 29) >> 8;
    const box = prev && prev.w === w && prev.h === h && t > prev.t && t - prev.t <= .3 ? motionBox(prev.luma, luma, w, h) : null;
    prev = { luma, t, w, h };
    return box;
  };
}
