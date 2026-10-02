import { FaceLandmarker } from '@mediapipe/tasks-vision';
import type { FaceLandmarkerResult } from '@mediapipe/tasks-vision';
import wasmLoaderPath from '@mediapipe/tasks-vision/vision_wasm_internal.js?url';
import wasmBinaryPath from '@mediapipe/tasks-vision/vision_wasm_internal.wasm?url';
import { delegatesToTry } from './delegate';
import type { FaceBox } from './reframe';

/** Browser-side face tracking with MediaPipe Face Landmarker (Apache-2.0, installed by npm run setup:clips). Returns face
 * boxes plus mouth signals (jawOpen blendshape, inner-lip gap) that the reframer uses to find who is talking. */
export type FaceDetector = { detect: (image: ImageBitmap, timestampMs: number) => FaceBox[]; delegate: 'GPU' | 'CPU'; close: () => void };
const options = (delegate: 'GPU' | 'CPU', runningMode: 'VIDEO' | 'IMAGE') => ({
  baseOptions: { modelAssetPath: '/mediapipe/face_landmarker.task', delegate }, runningMode, numFaces: 4,
  minFaceDetectionConfidence: .4, minFacePresenceConfidence: .4, minTrackingConfidence: .4, outputFaceBlendshapes: true,
});
async function create(runningMode: 'VIDEO' | 'IMAGE') {
  const files = { wasmLoaderPath, wasmBinaryPath };
  let last: unknown;
  for (const delegate of delegatesToTry()) {
    try { return { landmarker: await FaceLandmarker.createFromOptions(files, options(delegate, runningMode)), delegate }; } catch (error) { last = error; }
  }
  throw new Error(`The face model could not start${last instanceof Error ? `: ${last.message}` : ''}. Run npm run setup:clips in the Sprity Reels folder, then reload.`);
}
type Map2 = (x: number, y: number) => readonly [number, number];
function boxes(result: FaceLandmarkerResult, map: Map2 = (x, y) => [x, y]): FaceBox[] {
  return result.faceLandmarks.map((points, i) => {
    let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
    for (const p of points) { const [x, y] = map(p.x, p.y); x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    const [ux, uy] = map(points[13]?.x ?? 0, points[13]?.y ?? 0), [lx, ly] = map(points[14]?.x ?? 0, points[14]?.y ?? 0), h = Math.max(1e-3, y1 - y0);
    const shapes = result.faceBlendshapes?.[i]?.categories ?? [], jaw = shapes.find(c => c.categoryName === 'jawOpen')?.score ?? 0;
    const r = (v: number) => Math.round(v * 1e4) / 1e4;
    return { x: r((x0 + x1) / 2), y: r((y0 + y1) / 2), w: r(x1 - x0), h: r(h), jaw: r(jaw), mouth: r(Math.hypot(lx - ux, ly - uy) / h), score: 1 };
  });
}

/** VIDEO mode tracks faces between frames; when it finds none, an IMAGE-mode pass over overlapping left/right halves
 * catches the small faces of wide two-shots. */
export async function createFaceDetector(): Promise<FaceDetector> {
  const video = await create('VIDEO'), still = await create('IMAGE');
  const canvas = document.createElement('canvas'), ctx = canvas.getContext('2d')!;
  const tiles = (image: ImageBitmap) => {
    const out: FaceBox[] = [], w = Math.round(image.width * .6), h = image.height;
    canvas.width = w; canvas.height = h;
    for (const left of [0, image.width - w]) {
      ctx.drawImage(image, left, 0, w, h, 0, 0, w, h);
      const map: Map2 = (x, y) => [(left + x * w) / image.width, y];
      for (const f of boxes(still.landmarker.detect(canvas), map)) if (!out.some(o => Math.abs(o.x - f.x) < f.w / 2)) out.push(f);
    }
    return out;
  };
  return {
    delegate: video.delegate,
    detect: (image, timestampMs) => { const found = boxes(video.landmarker.detectForVideo(image, timestampMs)); return found.length ? found : tiles(image); },
    close: () => { video.landmarker.close(); still.landmarker.close(); },
  };
}
