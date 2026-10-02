import { useEffect, useState } from 'react';
import type { FaceSample } from '../engine/clips/reframe';

/** Headless tracking page for Sprity Reels. The studio opens it in a background browser with a temporary profile; it
 * reads extracted frames from the local API, runs MediaPipe Face Landmarker on every frame, the object detector on every
 * other frame and a motion meter, and posts the samples back. Without the object model, faces and motion still work. */
type Job = { id: string; frames: { n: number; t: number }[]; width: number; height: number };
// The server opens this page itself and passes a per-process key; the tracker routes refuse a call without it.
const params = new URLSearchParams(window.location.search), key = params.get('key') ?? '';
const headers = { 'Content-Type': 'application/json', 'X-SprityReels-Request': 'clips', 'X-Tracker-Key': key };
const get = (route: string) => fetch(`/api/clips/track/${route}`, { headers: { 'X-Tracker-Key': key } });
async function post(route: string, body: unknown) {
  const res = await fetch(`/api/clips/track/${route}`, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
  return res.json();
}

export default function ClipWorker() {
  const [status, setStatus] = useState('Starting…');
  useEffect(() => {
    const jobId = params.get('job') ?? '';
    void (async () => {
      try {
        const job = await (await get(encodeURIComponent(jobId))).json() as Job & { error?: string };
        if (job.error || job.id !== jobId) throw new Error(job.error || 'This tracking job is no longer active.');
        const { createFaceDetector } = await import('../engine/clips/faceTracker');
        const { createObjectFinder, createMotionMeter } = await import('../engine/clips/objectTracker');
        const detector = await createFaceDetector(), motion = createMotionMeter();
        const objects = await createObjectFinder().catch(() => null);
        let batch: FaceSample[] = [], last = -1;
        try {
          for (const [k, frame] of job.frames.entries()) {
            const blob = await (await get(`${encodeURIComponent(jobId)}/frame/${frame.n}`)).blob();
            const image = await createImageBitmap(blob);
            // VIDEO mode needs strictly increasing timestamps, also across separate ranges.
            const ts = Math.max(last + 1, Math.round(frame.t * 1000)); last = ts;
            batch.push({ t: frame.t, faces: detector.detect(image, ts), motion: motion(image, frame.t), ...(objects && k % 2 === 0 ? { objects: objects.detect(image) } : {}) });
            image.close();
            if (batch.length >= 60 || k === job.frames.length - 1) { await post(`${encodeURIComponent(jobId)}/samples`, { samples: batch, done: k + 1, total: job.frames.length, delegate: detector.delegate, objects: !!objects }); batch = []; }
            setStatus(`${k + 1}/${job.frames.length} on the ${detector.delegate}`);
          }
        } finally { detector.close(); objects?.close(); }
        await post(`${encodeURIComponent(jobId)}/finish`, { ok: true });
        setStatus('Done');
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Tracking failed.';
        setStatus(message);
        await post(`${encodeURIComponent(jobId)}/finish`, { ok: false, error: message }).catch(() => {});
      }
    })();
  }, []);
  return <p id="clip-worker-status" style={{ font: '14px system-ui', margin: 16 }}>{status}</p>;
}
