import type { ClipSubject } from './types';

/** Subjects beyond faces, for reframing footage where nobody talks to the camera: sports, gameplay without a face cam,
 * cars, pets, dance. The tracker page runs MediaPipe's EfficientDet-Lite0 object detector (COCO labels) and measures
 * where the picture moves between frames; this module links those boxes into tracks, picks the subject a shot should
 * follow and turns it into a camera path that pans like an operator: it holds while the subject moves inside the middle
 * of the frame, then follows smoothly, without lag and without leaving the picture. */
export const OBJECT_KINDS = ['person', 'ball', 'vehicle', 'animal'] as const;
export type ObjectKind = typeof OBJECT_KINDS[number];
/** Centre, size (0-1 of the frame) and detector score of one object. */
export type ObjectBox = { x: number; y: number; w: number; h: number; score: number; kind: ObjectKind };
/** The part of the frame that moved since the previous frame, and how much it changed (0-255). */
export type MotionBox = { x: number; y: number; w: number; h: number; level: number };
export type SubjectPoint = { t: number; x: number; y: number; w: number; h: number; score: number };
/** kind group: the size-weighted middle of several people (a team, a band), when no one of them stands out. */
export type SubjectTrack = { kind: ObjectKind | 'group' | 'motion'; points: SubjectPoint[] };
export type SubjectKey = { t: number; x: number; y: number; cut: boolean; linear?: boolean };
type Sample = { t: number; objects?: ObjectBox[]; motion?: MotionBox | null };

/** COCO labels to the subjects Sprity Reels follows. Furniture, screens, food and the like are never subjects. */
const COCO: Record<string, ObjectKind> = {
  person: 'person', 'sports ball': 'ball', frisbee: 'ball',
  bicycle: 'vehicle', car: 'vehicle', motorcycle: 'vehicle', airplane: 'vehicle', bus: 'vehicle', train: 'vehicle', truck: 'vehicle', boat: 'vehicle', skateboard: 'vehicle', surfboard: 'vehicle', skis: 'vehicle', snowboard: 'vehicle',
  bird: 'animal', cat: 'animal', dog: 'animal', horse: 'animal', sheep: 'animal', cow: 'animal', elephant: 'animal', bear: 'animal', zebra: 'animal', giraffe: 'animal',
};
export const objectKind = (label: string): ObjectKind | null => COCO[label.trim().toLowerCase()] ?? null;
/** The detector labels worth detecting at all (the others are skipped inside the detector). */
export const SUBJECT_LABELS = Object.keys(COCO);

export const median = (values: number[]) => { if (!values.length) return 0; const s = [...values].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
export const std = (values: number[]) => { if (values.length < 2) return 0; const m = values.reduce((a, b) => a + b, 0) / values.length; return Math.sqrt(values.reduce((a, b) => a + (b - m) ** 2, 0) / values.length); };
export const sceneIndex = (scenes: number[], t: number) => { let i = 0; while (i < scenes.length && scenes[i] <= t + 1e-6) i++; return i; };

// ------------------------------------------------------------------ motion
/** Where the picture moved between two small grey frames of the same size: the box around the pixels that changed
 * clearly more than the frame as a whole (the middle 80% of their weight, so a stray flicker does not stretch it).
 * null when almost nothing moved, or when most of the frame changed: then the camera itself moved (a pan or a cut),
 * which says nothing about where the subject is. */
export function motionBox(prev: Uint8Array, cur: Uint8Array, width: number, height: number): MotionBox | null {
  const n = width * height;
  if (!n || prev.length !== n || cur.length !== n) return null;
  const hist = new Uint32Array(256);
  for (let i = 0; i < n; i++) hist[Math.abs(cur[i] - prev[i])]++;
  let acc = 0, mid = 0;
  for (; mid < 255; mid++) { acc += hist[mid]; if (acc * 2 >= n) break; }
  const threshold = Math.max(18, mid * 3 + 8), cols = new Float64Array(width), rows = new Float64Array(height);
  let moving = 0, total = 0, sum = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const d = Math.abs(cur[y * width + x] - prev[y * width + x]);
    if (d < threshold) continue;
    const weight = d - threshold + 1;
    moving++; sum += d; total += weight; cols[x] += weight; rows[y] += weight;
  }
  if (moving < Math.max(4, n * .002) || moving > n * .5) return null;
  const span = (axis: Float64Array) => {
    let a = 0, lo = 0, hi = axis.length - 1;
    for (let i = 0; i < axis.length; i++) { a += axis[i]; if (a >= total * .1) { lo = i; break; } }
    a = 0;
    for (let i = axis.length - 1; i >= 0; i--) { a += axis[i]; if (a >= total * .1) { hi = i; break; } }
    return [lo, Math.max(lo, hi) + 1] as const;
  };
  const [x0, x1] = span(cols), [y0, y1] = span(rows), r = (v: number) => Math.round(v * 1e4) / 1e4;
  return { x: r((x0 + x1) / 2 / width), y: r((y0 + y1) / 2 / height), w: r((x1 - x0) / width), h: r((y1 - y0) / height), level: Math.round(sum / moving) };
}

// ------------------------------------------------------------------ tracks
/** Links the boxes of one kind into tracks: each box joins the nearest open track within about its size (balls may
 * jump further), tracks end at scene cuts and after 1 s unseen. Samples without detection results do not count. */
export function objectTracks(samples: Sample[], kind: ObjectKind, scenes: number[] = []): SubjectTrack[] {
  type Open = SubjectTrack & { last: number; scene: number };
  const tracks: Open[] = [];
  let open: Open[] = [];
  for (const s of samples) {
    if (!s.objects) continue;
    const scene = sceneIndex(scenes, s.t), used = new Set<Open>();
    open = open.filter(tr => tr.scene === scene && s.t - tr.last <= 1);
    for (const box of s.objects.filter(o => o.kind === kind && o.score >= .3).sort((a, b) => b.w * b.h - a.w * a.h)) {
      let best: Open | null = null, bestD = Infinity;
      for (const tr of open) {
        if (used.has(tr)) continue;
        const p = tr.points[tr.points.length - 1], reach = Math.max(.04, (p.w + box.w) / 2) + (kind === 'ball' ? .1 : 0);
        const d = Math.hypot(box.x - p.x, box.y - p.y) / reach;
        if (d < 1.5 && d < bestD) { best = tr; bestD = d; }
      }
      if (!best) { best = { kind, points: [], last: s.t, scene }; tracks.push(best); open.push(best); }
      best.points.push({ t: s.t, x: box.x, y: box.y, w: box.w, h: box.h, score: box.score }); best.last = s.t; used.add(best);
    }
  }
  return tracks.map(({ kind: k, points }) => ({ kind: k, points }));
}

/** The size-weighted middle of all people in each sample, with a box around the main ones. */
function groupTrack(samples: Sample[]): SubjectTrack {
  const points: SubjectPoint[] = [];
  for (const s of samples) {
    const people = (s.objects ?? []).filter(o => o.kind === 'person' && o.score >= .3);
    if (!people.length) continue;
    const big = Math.max(...people.map(p => p.w * p.h)), main = people.filter(p => p.w * p.h >= big * .15);
    let wsum = 0, x = 0, y = 0;
    for (const p of main) { const a = p.w * p.h; wsum += a; x += p.x * a; y += p.y * a; }
    const x0 = Math.min(...main.map(p => p.x - p.w / 2)), x1 = Math.max(...main.map(p => p.x + p.w / 2)), y0 = Math.min(...main.map(p => p.y - p.h / 2)), y1 = Math.max(...main.map(p => p.y + p.h / 2));
    points.push({ t: s.t, x: x / wsum, y: y / wsum, w: x1 - x0, h: y1 - y0, score: Math.max(...main.map(p => p.score)) });
  }
  return { kind: 'group', points };
}

/** The subject a shot should follow. auto takes the object that is in most of the shot, big, near the middle and
 * moving (a ball counts half: it is small and often missed); several people with no clear lead become their group;
 * with no object, the moving part of the picture. A named kind only follows that kind (motion: only the movement).
 * null when nothing is steady enough to follow, or for speaker (faces only). */
export function mainSubject(samples: Sample[], want: ClipSubject, scenes: number[] = []): SubjectTrack | null {
  if (want === 'speaker') return null;
  const detected = samples.filter(s => s.objects).length;
  const kinds: ObjectKind[] = want === 'auto' ? [...OBJECT_KINDS] : (OBJECT_KINDS as readonly string[]).includes(want) ? [want as ObjectKind] : [];
  const scored: { track: SubjectTrack; value: number }[] = [];
  if (detected >= 3) for (const kind of kinds) for (const track of objectTracks(samples, kind, scenes)) {
    const presence = track.points.length / detected;
    if (presence < (kind === 'ball' ? .25 : .4)) continue;
    const xs = track.points.map(p => p.x), size = median(track.points.map(p => Math.sqrt(p.w * p.h)));
    const moving = Math.min(1, std(xs) * 6), central = 1 - Math.min(1, Math.abs(median(xs) - .5) * 2);
    scored.push({ track, value: presence * (size + .08) * (.6 + .4 * central) * (1 + moving) * (kind === 'ball' && want === 'auto' ? .5 : 1) });
  }
  scored.sort((a, b) => b.value - a.value);
  const best = scored[0];
  if (best && (best.track.kind === 'person' || want === 'person')) {
    // Several people of similar weight (players, a band): follow their middle rather than guess one of them.
    const people = scored.filter(x => x.track.kind === 'person');
    if (people.length >= 2 && people[1].value >= people[0].value * .5) {
      const group = groupTrack(samples);
      if (group.points.length >= detected * .4) return group;
    }
  }
  if (best) return best.track;
  if (want === 'auto' || want === 'motion') {
    const points = samples.filter(s => s.motion).map(s => ({ t: s.t, x: s.motion!.x, y: s.motion!.y, w: s.motion!.w, h: s.motion!.h, score: Math.min(1, s.motion!.level / 60) }));
    if (points.length >= Math.max(3, samples.length * .4)) return { kind: 'motion', points };
  }
  return null;
}

/** The subject's box at a time: linear across gaps up to 1.5 s, held beyond that and before or after the track. */
export function subjectAt(track: SubjectTrack, t: number): SubjectPoint | null {
  const pts = track.points;
  if (!pts.length) return null;
  if (t <= pts[0].t) return pts[0];
  let i = 0; while (i + 1 < pts.length && pts[i + 1].t <= t) i++;
  const a = pts[i], b = pts[i + 1];
  if (!b || b.t - a.t > 1.5) return a;
  const u = (t - a.t) / Math.max(1e-6, b.t - a.t);
  return { t, x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u, w: a.w + (b.w - a.w) * u, h: a.h + (b.h - a.h) * u, score: Math.min(a.score, b.score) };
}

// ------------------------------------------------------------------ camera path
function medianFilter(values: number[], half: number) {
  return values.map((_, i) => median(values.slice(Math.max(0, i - half), i + half + 1)));
}
/** Exponential smoothing run forwards and then backwards: no lag, and a gentle lead into every move. */
function zeroPhase(values: number[], times: number[], tau: number) {
  const out = [...values];
  for (let i = 1; i < out.length; i++) { const a = 1 - Math.exp(-(times[i] - times[i - 1]) / tau); out[i] = out[i - 1] + a * (out[i] - out[i - 1]); }
  for (let i = out.length - 2; i >= 0; i--) { const a = 1 - Math.exp(-(times[i + 1] - times[i]) / tau); out[i] = out[i + 1] + a * (out[i] - out[i + 1]); }
  return out;
}
/** Ramer-Douglas-Peucker on (t, x, y): the indices to keep so straight segments stay within tol pixels of the path. */
function simplify(times: number[], xs: number[], ys: number[], tol: number) {
  const keep = new Uint8Array(times.length); keep[0] = 1; keep[times.length - 1] = 1;
  const stack: [number, number][] = [[0, times.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let worst = -1, far = tol;
    for (let i = a + 1; i < b; i++) {
      const u = (times[i] - times[a]) / Math.max(1e-9, times[b] - times[a]);
      const d = Math.max(Math.abs(xs[i] - (xs[a] + (xs[b] - xs[a]) * u)), Math.abs(ys[i] - (ys[a] + (ys[b] - ys[a]) * u)));
      if (d > far) { far = d; worst = i; }
    }
    if (worst > 0) { keep[worst] = 1; stack.push([a, worst], [worst, b]); }
  }
  return [...keep.keys()].filter(i => keep[i]);
}

/** Crop keys (top-left, source pixels) that follow a subject over the given sample times. The camera holds while the
 * subject stays within the middle `dead` share of the window, then pans with it; the path is median-filtered (detector
 * jitter), smoothed without lag (tau seconds) and kept inside the picture. People are framed by their upper body. The
 * keys are straight segments (linear) within about 3 pixels of the smooth path (looser for very long, busy shots). */
export function followPath(track: SubjectTrack, times: number[], win: { w: number; h: number }, srcW: number, srcH: number, opts: { dead?: number; tau?: number } = {}): SubjectKey[] {
  if (!times.length) return [];
  const dead = opts.dead ?? .2, tau = opts.tau ?? .35, head = track.kind === 'person' || track.kind === 'group';
  const raw = times.map(t => subjectAt(track, t)!);
  let tx = raw.map(p => p.x * srcW), ty = raw.map(p => (head ? p.y - p.h * .15 : p.y) * srcH);
  tx = medianFilter(tx, 2); ty = medianFilter(ty, 2);
  const lazy = (target: number[], zone: number) => { let c = target[0]; return target.map(v => { if (v > c + zone) c = v - zone; else if (v < c - zone) c = v + zone; return c; }); };
  const cx = zeroPhase(lazy(tx, win.w * dead / 2), times, tau), cy = zeroPhase(lazy(ty, win.h * dead / 2), times, tau);
  const kx = cx.map(x => Math.max(0, Math.min(srcW - win.w, x - win.w / 2))), ky = cy.map(y => Math.max(0, Math.min(srcH - win.h, y - win.h / 2)));
  // A long, busy shot keeps at most 120 keys (each one is a branch of the renderer's crop expression).
  let tol = Math.max(2, srcW * .0015), keep = simplify(times, kx, ky, tol);
  while (keep.length > 120) { tol *= 1.6; keep = simplify(times, kx, ky, tol); }
  return keep.map((i, j) => ({ t: times[i], x: Math.round(kx[i]), y: Math.round(ky[i]), cut: j === 0, ...(j ? { linear: true } : {}) }));
}
