import type { ClipLayout, ClipSubject, ClipWord } from './types';
import type { Timeline } from './timeline';
import { ENERGY_RATE } from './transcript';
import type { MotionBox, ObjectBox, SubjectTrack } from './subjects';
import { followPath, mainSubject, median, sceneIndex, std, subjectAt } from './subjects';

/** Speaker-aware vertical reframing. Faces come from MediaPipe Face Landmarker (run in the studio's worker page);
 * this module turns them into a camera that behaves like an operator: it holds still inside a dead zone, glides when
 * the subject really moves, cuts on speaker changes and scene cuts, and never pans across a cut.
 *
 * The plan is made per shot (between scene cuts), and each shot is a set of panes tiled into the output: one crop that
 * follows the speaker, stacked crops of 2-4 people, a face cam over gameplay, a screen share over its speaker, or the
 * full frame over a blurred copy. In auto layout every shot gets the layout that suits it. Shots that no face leads
 * (sports, gameplay, cars, pets) follow the main subject instead: an object from the detector or the moving part of the
 * picture (subjects.ts). */
export type FaceBox = { x: number; y: number; w: number; h: number; jaw: number; mouth: number; score: number };
/** objects: detector results (every other frame; missing when not run); motion: where the picture moved, if anywhere. */
export type FaceSample = { t: number; faces: FaceBox[]; objects?: ObjectBox[]; motion?: MotionBox | null };
/** Version 2 adds objects and motion (objects: whether the object detector ran). */
export type FaceTrackFile = {
  format: 'sprityreels-face-track'; version: 1 | 2; width: number; height: number; fps: number; delegate: 'GPU' | 'CPU' | 'none';
  ranges: { s: number; e: number }[]; samples: FaceSample[]; scenes: number[]; objects?: boolean;
};
/** linear: move at a steady speed from the previous key (a followed subject); otherwise glide with ease in and out. */
export type CameraKey = { t: number; x: number; y: number; cut: boolean; linear?: boolean };
export type ShotLayout = Exclude<ClipLayout, 'auto'>;
/** One tile of the output (pixels) and what it shows: a crop window (source pixels, top-left keys over source time) or,
 * with fit, the whole frame over a blurred copy. Punch-ins zoom face panes only, never gameplay or a shared screen. */
export type CameraPane = { x: number; y: number; w: number; h: number; role: 'face' | 'content'; fit: boolean; win: { w: number; h: number }; keys: CameraKey[] };
/** subject: what a followed shot keeps in frame (captions stay off it). */
export type CameraShot = { s: number; e: number; layout: ShotLayout; panes: CameraPane[]; subject?: SubjectTrack };
export type CameraPlan = {
  layout: ShotLayout | 'mixed'; shots: CameraShot[]; primary: CameraKey[]; srcW: number; srcH: number; outW: number; outH: number;
  faceCoverage: number; speakers: number; notes: string[];
};

type Track = { id: number; points: { t: number; f: FaceBox }[]; last: number; scene: number };
const even = (x: number) => Math.max(2, Math.round(x / 2) * 2);

/** Links per-frame faces into tracks (nearest centre, reset at scene cuts, dropped after 0.7 s unseen). */
export function linkTracks(samples: FaceSample[], scenes: number[]): Track[] {
  const tracks: Track[] = [];
  let open: Track[] = [], nextId = 0;
  for (const sample of [...samples].sort((a, b) => a.t - b.t)) {
    const scene = sceneIndex(scenes, sample.t);
    open = open.filter(tr => tr.scene === scene && sample.t - tr.last <= .7);
    const used = new Set<Track>();
    const faces = [...sample.faces].filter(f => f.score >= .35 && f.w > .01).sort((a, b) => b.w * b.h - a.w * a.h);
    for (const face of faces) {
      let best: Track | null = null, bestD = Infinity;
      for (const tr of open) {
        if (used.has(tr)) continue;
        const p = tr.points[tr.points.length - 1].f, d = Math.hypot(face.x - p.x, face.y - p.y) / Math.max(.02, (p.w + face.w) / 2);
        if (d < 1.2 && d < bestD) { best = tr; bestD = d; }
      }
      if (!best) { best = { id: nextId++, points: [], last: sample.t, scene }; tracks.push(best); open.push(best); }
      best.points.push({ t: sample.t, f: face }); best.last = sample.t; used.add(best);
    }
  }
  return tracks.filter(tr => tr.points.length >= 2 || tracks.length === 1);
}

/** Mouth activity: movement of jawOpen and lip gap over ±0.4 s (talking oscillates; a held smile does not). */
function activity(track: Track, t: number) {
  const near = track.points.filter(p => Math.abs(p.t - t) <= .4);
  if (near.length < 2) return 0;
  return std(near.map(p => p.f.jaw)) * .6 + std(near.map(p => p.f.mouth * 4)) * .4 + median(near.map(p => p.f.jaw)) * .05;
}
function pearson(a: number[], b: number[]) {
  const n = a.length, ma = a.reduce((s, x) => s + x, 0) / n, mb = b.reduce((s, x) => s + x, 0) / n;
  let cov = 0, va = 0, vb = 0;
  for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; cov += x * y; va += x * x; vb += y * y; }
  return va > 1e-9 && vb > 1e-6 ? cov / Math.sqrt(va * vb) : 0;
}
/** Lip sync: correlation between a face's mouth opening and the loudness over ±1 s, best of ±1 sample of lag (sound
 * and picture are rarely in perfect sync). The person talking opens their mouth when the sound is loud; a listener who
 * nods, laughs silently or chews does not. null when there is not enough data. */
export function lipSync(points: { t: number; f: Pick<FaceBox, 'jaw' | 'mouth'> }[], t: number, energy?: Uint8Array): number | null {
  if (!energy?.length) return null;
  const near = points.filter(p => Math.abs(p.t - t) <= 1);
  if (near.length < 6) return null;
  const mouth = near.map(p => p.f.jaw + p.f.mouth * 1.6), step = (near[near.length - 1].t - near[0].t) / (near.length - 1) || .125;
  const loud = (x: number) => { const i = Math.round(x * ENERGY_RATE); let m = 0; for (let k = i - 6; k <= i + 6; k++) m = Math.max(m, energy[Math.max(0, Math.min(energy.length - 1, k))]); return m; };
  let best = -1;
  for (const lag of [-step, 0, step]) best = Math.max(best, pearson(mouth, near.map(p => loud(p.t + lag))));
  return best;
}
function at(track: Track, t: number) {
  const pts = track.points;
  if (!pts.length || t < pts[0].t - .35 || t > pts[pts.length - 1].t + .35) return null;
  let i = 0; while (i + 1 < pts.length && pts[i + 1].t <= t) i++;
  const a = pts[i], b = pts[Math.min(pts.length - 1, i + 1)];
  if (b.t - a.t > .7 || a === b) return a.f;
  const u = Math.max(0, Math.min(1, (t - a.t) / (b.t - a.t)));
  return { ...a.f, x: a.f.x + (b.f.x - a.f.x) * u, y: a.f.y + (b.f.y - a.f.y) * u, w: a.f.w + (b.f.w - a.f.w) * u, h: a.f.h + (b.f.h - a.f.h) * u };
}
const speaking = (words: ClipWord[], t: number) => words.some(w => w.s - .25 <= t && w.e + .25 >= t);

type Choice = { t: number; track: Track | null; scene: number };
/** Who the camera should show at each sample: the talking face, switching only for a sustained, clearly stronger speaker.
 * With the loudness envelope, mouth movement counts in proportion to how well it follows the sound. */
export function chooseSpeaker(tracks: Track[], samples: FaceSample[], scenes: number[], words: ClipWord[], energy?: Uint8Array): Choice[] {
  const times = [...new Set(samples.map(s => s.t))].sort((a, b) => a - b), out: Choice[] = [];
  let current: Track | null = null, since = -Infinity, challenger: Track | null = null, challengeStart = 0, scene = -1;
  for (const t of times) {
    const sc = sceneIndex(scenes, t), visible = tracks.filter(tr => tr.scene === sc && at(tr, t));
    const size = (tr: Track) => { const f = at(tr, t); return f ? f.w * f.h : 0; };
    const talk = (tr: Track) => { const act = activity(tr, t), sync = visible.length > 1 ? lipSync(tr.points, t, energy) : null; return sync === null ? act : act * (.4 + 1.6 * Math.max(0, sync)); };
    if (sc !== scene) {
      // New shot: take the most active visible face, else the largest.
      scene = sc; challenger = null;
      current = [...visible].sort((a, b) => talk(b) - talk(a) || size(b) - size(a))[0] ?? null; since = t;
    } else if (!current || !visible.includes(current)) {
      current = [...visible].sort((a, b) => talk(b) - talk(a) || size(b) - size(a))[0] ?? current; since = t; challenger = null;
    } else if (visible.length > 1 && speaking(words, t)) {
      const best = [...visible].sort((a, b) => talk(b) - talk(a))[0];
      if (best !== current && talk(best) > talk(current) * 1.4 + .004) {
        if (challenger !== best) { challenger = best; challengeStart = t; }
        if (t - challengeStart >= .5 && t - since >= 1.2) { current = best; since = t; challenger = null; }
      } else challenger = null;
    }
    out.push({ t, track: current && visible.includes(current) ? current : null, scene: sc });
  }
  return out;
}

/** Scene cuts from per-frame scene scores (FFmpeg's select scene score, 0-1). A frame is a cut when it is the local
 * maximum and stands clearly above both an absolute floor and the surrounding frames, like PySceneDetect's adaptive
 * detector: soft cuts in calm footage are found, and fast motion is not mistaken for cuts. */
export function sceneCuts(frames: { t: number; s: number }[], fps: number) {
  const w = Math.max(2, Math.round(fps * .25)), cuts: number[] = [];
  let last = -Infinity;
  for (let i = 1; i < frames.length; i++) {
    const s = frames[i].s;
    if (!(s >= .1)) continue;
    let sum = 0, n = 0, peak = true;
    for (let k = Math.max(1, i - w); k <= Math.min(frames.length - 1, i + w); k++) { if (k === i) continue; sum += frames[k].s; n++; if (frames[k].s > s) peak = false; }
    if (!peak || frames[i].t - last < .35) continue;
    if (s >= .45 || s >= 3.5 * ((n ? sum / n : 0) + .01)) { cuts.push(Math.round(frames[i].t * 1000) / 1000); last = frames[i].t; }
  }
  return cuts;
}

/** FFmpeg metadata=print output ("pts_time:1.23" then "lavfi.scene_score=0.41") to per-frame scene scores. */
export function parseSceneScores(text: string) {
  const out: { t: number; s: number }[] = [];
  let t = NaN;
  for (const line of text.split(/\r?\n/)) {
    const time = /pts_time:(-?[\d.]+)/.exec(line);
    if (time) { t = Number(time[1]); continue; }
    const score = /lavfi\.scene_score=([\d.]+)/.exec(line);
    if (score && Number.isFinite(t)) out.push({ t, s: Number(score[1]) });
  }
  return out;
}

export type ReframeInput = {
  track: FaceTrackFile | null; words: ClipWord[]; layout: ClipLayout; srcW: number; srcH: number; outW: number; outH: number;
  /** The source's 10 ms loudness envelope, for lip sync. */ energy?: Uint8Array;
  /** Auto layout puts a detected face cam over gameplay for gaming, and under the shared screen otherwise. */ genre?: string;
  /** What the crop follows (default auto). */ subject?: ClipSubject;
};
type FaceCam = { x: number; y: number; w: number; h: number };
/** A face cam or call tile: one small face that sits still near an edge for most of the shot, with no large face around. */
function faceCam(present: Track[], count: number): FaceCam | null {
  for (const tr of present) {
    if (tr.points.length < Math.max(3, count * .6)) continue;
    const xs = tr.points.map(p => p.f.x), ys = tr.points.map(p => p.f.y), w = median(tr.points.map(p => p.f.w)), h = median(tr.points.map(p => p.f.h));
    const x = median(xs), y = median(ys), still = std(xs) < .02 && std(ys) < .02, edge = Math.abs(x - .5) > .25 || Math.abs(y - .5) > .25;
    if (w < .16 && still && edge && !present.some(o => o !== tr && median(o.points.map(p => p.f.w)) > .12)) return { x, y, w, h };
  }
  return null;
}

/** Crop windows (in source pixels, top-left) over source time, per shot. */
export function planCamera(input: ReframeInput): CameraPlan {
  const { track, srcW, srcH, outW, outH } = input, notes: string[] = [];
  const note = (text: string) => { if (!notes.includes(text)) notes.push(text); };
  const samples = [...(track?.samples ?? [])].sort((a, b) => a.t - b.t), scenes = track?.scenes ?? [];
  const withFaces = samples.filter(s => s.faces.some(f => f.score >= .35)).length, coverage = samples.length ? withFaces / samples.length : 0;
  const tracks = linkTracks(samples, scenes);
  const people = tracks.filter(tr => tr.points.length >= Math.max(3, samples.length * .15));
  const portrait = outW < outH;
  const windowFor = (aspect: number) => { const h = srcW / srcH > aspect ? srcH : even(srcW / aspect), w = even(h * aspect); return { w: Math.min(srcW, w), h: Math.min(srcH, h) }; };
  const full = windowFor(outW / outH), t0 = samples[0]?.t ?? 0;
  const still = (win: { w: number; h: number }, x = (srcW - win.w) / 2, y = (srcH - win.h) / 2): CameraKey[] => [{ t: t0, x: Math.round(Math.max(0, Math.min(srcW - win.w, x))), y: Math.round(Math.max(0, Math.min(srcH - win.h, y))), cut: true }];
  const single = (layout: ShotLayout, keys = still(full)): CameraPane[] => [{ x: 0, y: 0, w: outW, h: outH, role: 'face', fit: layout === 'fit', win: full, keys }];
  const plan = (layout: CameraPlan['layout'], shots: CameraShot[], primary: CameraKey[]): CameraPlan => ({ layout, shots, primary, srcW, srcH, outW, outH, faceCoverage: coverage, speakers: people.length, notes });

  // No tracking data: one static shot for the whole short.
  if (!track || !samples.length) {
    let layout: ShotLayout = input.layout === 'auto' ? 'fit' : input.layout;
    if (layout !== 'fit' && layout !== 'center') { note('Face tracking is unavailable, so the crop stays centred.'); layout = 'center'; }
    return plan(layout, [{ s: -1, e: 1e9, layout, panes: single(layout) }], still(full));
  }
  const choices = chooseSpeaker(tracks, samples, scenes, input.words, input.energy);
  const primary = smoothPath(choices.map(c => ({ t: c.t, f: c.track ? at(c.track, c.t) : null, scene: c.scene, id: c.track?.id ?? -1 })), full, srcW, srcH, .4);
  const cuts = [...new Set(scenes)].sort((a, b) => a - b), bounds = [-1, ...cuts, 1e9], shots: CameraShot[] = [];
  for (let k = 0; k < bounds.length - 1; k++) {
    const s = bounds[k], e = bounds[k + 1], inShot = samples.filter(x => x.t >= s && x.t < e);
    const sc = sceneIndex(scenes, inShot[0]?.t ?? s + 1e-3);
    const present = tracks.filter(tr => tr.scene === sc && tr.points.length >= Math.max(2, inShot.length * .3)).sort((a, b) => b.points.length - a.points.length);
    const faceShare = inShot.length ? inShot.filter(x => x.faces.some(f => f.score >= .35)).length / inShot.length : 0;
    const cam = inShot.length ? faceCam(present, inShot.length) : null;
    const shotChoices = choices.filter(c => c.t >= s && c.t < e && c.track);
    const switches = shotChoices.reduce((n, c, i) => n + (i && c.track !== shotChoices[i - 1].track ? 1 : 0), 0), span = inShot.length ? inShot[inShot.length - 1].t - inShot[0].t : 0;
    // A subject to follow: a named kind wherever it is found; auto only where no face leads the shot.
    const want = input.subject ?? 'auto', named = want !== 'auto' && want !== 'speaker';
    const subject = inShot.length && want !== 'speaker' && (named || faceShare < .4 || !present.length) ? mainSubject(inShot, want) : null;
    // Fallbacks explain themselves only for shots this short shows (the samples cover just the short's ranges).
    const say = (text: string) => { if (inShot.length) note(text); };
    let layout: ShotLayout;
    if (input.layout === 'auto') {
      if (!inShot.length) layout = coverage >= .4 ? 'tracked' : 'fit';
      else if (subject && named) layout = 'tracked';
      else if (cam && portrait) layout = input.genre === 'gaming' ? 'gameplay' : 'screen';
      else if (faceShare < .4 || !present.length) { layout = subject ? 'tracked' : 'fit'; if (!subject) say('Some shots have no face or clear subject, so they show the full frame over a blurred background.'); }
      // A quick back-and-forth between people who share the frame reads better stacked than as a string of cuts.
      else if (present.length >= 2 && portrait && switches >= 3 && switches / Math.max(1, span) >= 1 / 5) layout = 'split';
      else layout = 'tracked';
    } else layout = input.layout;
    if ((layout === 'gameplay' || layout === 'screen') && (!cam || !portrait)) {
      say(portrait ? 'No face cam was found in some shots, so they follow the speaker instead.' : 'Face cam layouts need a vertical format; landscape shorts show the full frame.');
      layout = portrait && present.length ? 'tracked' : 'center';
    }
    if (layout === 'split' && present.length < 2) { say('Split screen needs two people on screen; shots with one person follow the speaker.'); layout = present.length ? 'tracked' : 'center'; }
    if (named && !subject && inShot.length) say(`No ${want === 'motion' ? 'clear motion' : want} was found in some shots, so they follow the speaker or show the whole frame.`);
    const follow = layout === 'tracked' && subject ? subject : null;
    shots.push({ s, e, layout, panes: panesFor(layout), ...(follow ? { subject: follow } : {}) });

    function panesFor(l: ShotLayout): CameraPane[] {
      if (l === 'tracked' && follow) return single(l, followPath(follow, inShot.map(x => x.t), full, srcW, srcH));
      if (l === 'tracked') return single(l, primary);
      if (l === 'fit' || l === 'center') return single(l);
      if (l === 'split') {
        const group = present.slice(0, 4).sort((p, q) => median(p.points.map(x => x.f.x)) - median(q.points.map(x => x.f.x)));
        return tiles(group.length, portrait, outW, outH).map((cell, i) => {
          const win = windowFor(cell.w / cell.h);
          return { ...cell, role: 'face' as const, fit: false, win, keys: smoothPath(inShot.map(x => ({ t: x.t, f: at(group[i], x.t), scene: sc })), win, srcW, srcH, .42) };
        });
      }
      // Face cam layouts: a tight crop of the face cam, and the game (cropped to fill) or the screen (whole, over blur).
      // The face cam tile is tight (2.8 face widths) so it rarely reaches past the webcam overlay into the game.
      const c = cam!, camH = l === 'gameplay' ? even(outH * .3) : outH - even(outH * .62), camY = l === 'gameplay' ? 0 : outH - camH;
      const camWin = (() => {
        const aspect = outW / camH;
        let w = Math.min(srcW, c.w * srcW * 2.8), h = w / aspect;
        if (h > srcH) { h = srcH; w = h * aspect; }
        return { w: Math.round(w), h: Math.round(h) };
      })();
      const camPane: CameraPane = { x: 0, y: camY, w: outW, h: camH, role: 'face', fit: false, win: camWin, keys: still(camWin, c.x * srcW - camWin.w / 2, c.y * srcH - camWin.h * .42) };
      const contentH = outH - camH, contentWin = windowFor(outW / contentH);
      const content: CameraPane = { x: 0, y: l === 'gameplay' ? camH : 0, w: outW, h: contentH, role: 'content', fit: l === 'screen', win: contentWin, keys: still(contentWin) };
      return l === 'gameplay' ? [camPane, content] : [content, camPane];
    }
  }
  const layouts = [...new Set(shots.filter(s => samples.some(x => x.t >= s.s && x.t < s.e)).map(s => s.layout))];
  return plan(layouts.length === 1 ? layouts[0] : layouts.length ? 'mixed' : shots[0].layout, shots, primary);
}

/** Output tiles for n people, left to right: stacked bands in a vertical format, columns in a wide one, and a 2x2 grid
 * for four. Edges sit on even pixels and the tiles cover the frame exactly. */
export function tiles(n: number, portrait: boolean, W: number, H: number) {
  const cuts = (size: number, parts: number) => Array.from({ length: parts + 1 }, (_, i) => i === parts ? size : Math.round(i * size / parts / 2) * 2);
  if (n === 4) { const xs = cuts(W, 2), ys = cuts(H, 2); return [0, 1, 2, 3].map(i => ({ x: xs[i % 2], y: ys[i >> 1], w: xs[i % 2 + 1] - xs[i % 2], h: ys[(i >> 1) + 1] - ys[i >> 1] })); }
  const edges = cuts(portrait ? H : W, Math.max(1, n));
  return Array.from({ length: Math.max(1, n) }, (_, i) => portrait ? { x: 0, y: edges[i], w: W, h: edges[i + 1] - edges[i] } : { x: edges[i], y: 0, w: edges[i + 1] - edges[i], h: H });
}

/** Dead-zone camera: holds still while the face stays inside the middle 20% of the window, then glides (0.45 s) to
 * re-centre; subject switches and scene cuts are hard cuts. */
function smoothPath(targets: { t: number; f: FaceBox | null; scene: number; id?: number }[], win: { w: number; h: number }, srcW: number, srcH: number, eyeLine: number): CameraKey[] {
  const keys: CameraKey[] = [];
  const clampX = (x: number) => Math.round(Math.max(0, Math.min(srcW - win.w, x))), clampY = (y: number) => Math.round(Math.max(0, Math.min(srcH - win.h, y)));
  const goal = (f: FaceBox) => ({ x: clampX(f.x * srcW - win.w / 2), y: clampY(f.y * srcH - win.h * eyeLine) });
  let cam: { x: number; y: number } | null = null, scene = -1, subject = -2, glideUntil = -1;
  // Median-filter the raw targets (±0.3 s) so landmark jitter never moves the camera.
  const filtered = targets.map((p, i) => {
    if (!p.f) return p;
    const near = targets.filter((q, j) => Math.abs(j - i) <= 6 && Math.abs(q.t - p.t) <= .3 && q.f && q.scene === p.scene && q.id === p.id);
    return { ...p, f: { ...p.f, x: median(near.map(q => q.f!.x)), y: median(near.map(q => q.f!.y)) } };
  });
  for (const p of filtered) {
    const cutHere = p.scene !== scene || (p.id !== undefined && p.id !== subject && p.f !== null && cam !== null && subject !== -2 && p.id >= 0);
    if (!p.f) {
      if (p.scene !== scene) { scene = p.scene; cam = cam ?? { x: clampX((srcW - win.w) / 2), y: clampY((srcH - win.h) / 2) }; keys.push({ t: p.t, ...cam, cut: true }); }
      continue;
    }
    const g = goal(p.f);
    if (!cam || cutHere) {
      // A cut cancels a glide still in progress.
      while (keys.length && keys[keys.length - 1].t > p.t) keys.pop();
      cam = g; scene = p.scene; subject = p.id ?? subject; glideUntil = -1;
      keys.push({ t: p.t, ...cam, cut: true });
      continue;
    }
    if (p.t < glideUntil) continue;
    const dz = win.w * .1, dzy = win.h * .12;
    if (Math.abs(g.x - cam.x) > dz || Math.abs(g.y - cam.y) > dzy) {
      keys.push({ t: p.t, ...cam, cut: false });
      cam = { x: Math.abs(g.x - cam.x) > dz ? g.x : cam.x, y: Math.abs(g.y - cam.y) > dzy ? g.y : cam.y };
      glideUntil = p.t + .45;
      keys.push({ t: glideUntil, ...cam, cut: false });
    }
  }
  if (!keys.length) keys.push({ t: targets[0]?.t ?? 0, x: clampX((srcW - win.w) / 2), y: clampY((srcH - win.h) / 2), cut: true });
  return keys.sort((a, b) => a.t - b.t || (a.cut ? 1 : 0) - (b.cut ? 1 : 0));
}

/** Camera position at a source time, honouring cuts (steps), glides (smoothstep) and follows (linear). */
export function cameraAt(keys: CameraKey[], t: number) {
  if (!keys.length) return { x: 0, y: 0 };
  let i = 0; while (i + 1 < keys.length && keys[i + 1].t <= t) i++;
  const a = keys[i], b = keys[i + 1];
  if (!b || b.cut || t <= a.t) return { x: a.x, y: a.y };
  const u = Math.max(0, Math.min(1, (t - a.t) / Math.max(1e-6, b.t - a.t))), s = b.linear ? u : u * u * (3 - 2 * u);
  return { x: Math.round(a.x + (b.x - a.x) * s), y: Math.round(a.y + (b.y - a.y) * s) };
}
export const shotAt = (plan: Pick<CameraPlan, 'shots'>, t: number) => plan.shots.find(s => t >= s.s && t < s.e) ?? plan.shots[plan.shots.length - 1];

/** An FFmpeg expression of the piece's local time `t` (0 at srcStart) for one axis, piecewise with smoothstep glides
 * and straight follow segments. */
export function cropExpression(keys: CameraKey[], axis: 'x' | 'y', srcStart: number, duration: number, offset = 0) {
  const local = keys.map(k => ({ ...k, t: k.t - srcStart }));
  const inside = local.filter(k => k.t > 0 && k.t < duration);
  const startValue = cameraAt(keys, srcStart)[axis] + offset;
  if (!inside.length) return String(Math.round(startValue));
  // Build segments between consecutive breakpoints; each is constant or a glide.
  const points = [{ t: 0, v: startValue, cut: true, linear: false }, ...inside.map(k => ({ t: k.t, v: k[axis] + offset, cut: k.cut, linear: !!k.linear }))];
  let expr = String(Math.round(points[points.length - 1].v));
  for (let i = points.length - 2; i >= 0; i--) {
    const a = points[i], b = points[i + 1], t0 = a.t.toFixed(3), span = Math.max(1e-3, b.t - a.t).toFixed(3);
    const seg = b.cut || Math.round(a.v) === Math.round(b.v) ? String(Math.round(a.v))
      : b.linear ? `${Math.round(a.v)}+(${Math.round(b.v - a.v)})*(t-${t0})/${span}` : `${Math.round(a.v)}+(${Math.round(b.v - a.v)})*(3*pow((t-${t0})/${span},2)-2*pow((t-${t0})/${span},3))`;
    expr = `if(lt(t,${b.t.toFixed(3)}),${seg},${expr})`;
  }
  return expr;
}

/** The crop a pane shows at a source time (source pixels), after a punch-in. Face panes and single-pane shots zoom;
 * content panes (gameplay, a shared screen) never do. */
export function paneCrop(pane: CameraPane, t: number, zoom: number, single: boolean) {
  const z = pane.role === 'face' || single ? zoom : 1, cam = cameraAt(pane.keys, t), w = pane.win.w / z, h = pane.win.h / z;
  return { x: cam.x + (pane.win.w - w) / 2, y: cam.y + (pane.win.h - h) * .35, w, h, z };
}
/** Size (pixels, before centring) of the whole frame fitted into a pane at a punch-in, as the renderer draws it. */
export function fitSize(srcW: number, srcH: number, pw: number, ph: number, zoom: number) {
  const a = srcW / srcH;
  return a >= pw / ph ? { w: even(pw * zoom), h: even(pw * zoom / a) } : { w: even(ph * zoom * a), h: even(ph * zoom) };
}
export type ScreenRect = { x: number; y: number; w: number; h: number };
/** Faces as they appear in the output frame (pixels) at a source time: through the shot's panes, crops and punch-in.
 * Captions use this to stay off faces; it is the final projected position, not the source position. */
export function screenFaces(plan: CameraPlan, samples: FaceSample[], t: number, zoom = 1): ScreenRect[] {
  const shot = shotAt(plan, t);
  if (!shot || !samples.length) return [];
  let lo = 0, hi = samples.length - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (samples[mid].t < t) lo = mid + 1; else hi = mid; }
  const sample = [samples[lo - 1], samples[lo]].filter(Boolean).sort((a, b) => Math.abs(a.t - t) - Math.abs(b.t - t))[0];
  if (!sample || Math.abs(sample.t - t) > .5) return [];
  const out: ScreenRect[] = [], single = shot.panes.length === 1;
  for (const pane of shot.panes) {
    let map: (x: number, y: number) => [number, number];
    if (pane.fit) {
      const size = fitSize(plan.srcW, plan.srcH, pane.w, pane.h, single ? zoom : 1), cw = Math.min(size.w, pane.w), ch = Math.min(size.h, pane.h);
      const ox = pane.x + (pane.w - cw) / 2 - (size.w - cw) / 2, oy = pane.y + (pane.h - ch) / 2 - (size.h - ch) / 2;
      map = (x, y) => [ox + x / plan.srcW * size.w, oy + y / plan.srcH * size.h];
    } else {
      const c = paneCrop(pane, t, zoom, single);
      map = (x, y) => [pane.x + (x - c.x) * pane.w / c.w, pane.y + (y - c.y) * pane.h / c.h];
    }
    const add = (b: { x: number; y: number; w: number; h: number }) => {
      const [x0, y0] = map((b.x - b.w / 2) * plan.srcW, (b.y - b.h / 2) * plan.srcH), [x1, y1] = map((b.x + b.w / 2) * plan.srcW, (b.y + b.h / 2) * plan.srcH);
      const r = { x: Math.max(pane.x, x0), y: Math.max(pane.y, y0), w: 0, h: 0 };
      r.w = Math.min(pane.x + pane.w, x1) - r.x; r.h = Math.min(pane.y + pane.h, y1) - r.y;
      if (r.w > 4 && r.h > 4) out.push({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) });
    };
    for (const f of sample.faces) if (f.score >= .35) add(f);
    // A followed subject stays visible too: the head of a person (their body may carry captions), else the whole object.
    const followed = shot.subject ? subjectAt(shot.subject, t) : null;
    if (followed && Math.abs(followed.t - t) <= 1.5) {
      const people = shot.subject!.kind === 'person' || shot.subject!.kind === 'group';
      add(people ? { x: followed.x, y: followed.y - followed.h * .375, w: followed.w, h: followed.h * .25 } : { x: followed.x, y: followed.y, w: followed.w * 1.1, h: followed.h * 1.1 });
    }
  }
  return out;
}

/** For caption placement: at an output time, the faces on screen and the seams between tiles, through the timeline
 * (trims, punch-ins) and the camera plan. */
export function captionStage(plan: CameraPlan, samples: FaceSample[], timeline: Pick<Timeline, 'pieces'>) {
  const sorted = [...samples].sort((a, b) => a.t - b.t);
  return (t: number) => {
    const piece = timeline.pieces.find(p => t >= p.out && t < p.out + p.dur) ?? timeline.pieces[timeline.pieces.length - 1];
    if (!piece) return { faces: [], seams: [] };
    const src = piece.src + Math.max(0, t - piece.out), shot = shotAt(plan, src);
    return { faces: screenFaces(plan, sorted, src, piece.zoom), seams: shot && shot.panes.length > 1 ? [...new Set(shot.panes.filter(p => p.y > 0).map(p => p.y))] : [] };
  };
}
