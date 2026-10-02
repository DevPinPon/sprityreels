import test from 'node:test';
import assert from 'node:assert/strict';
import type { FaceSample, FaceTrackFile } from '../src/engine/clips/reframe';
import { cameraAt, cropExpression, planCamera, screenFaces } from '../src/engine/clips/reframe';
import type { ObjectBox, SubjectTrack } from '../src/engine/clips/subjects';
import { followPath, mainSubject, motionBox, objectKind, objectTracks, subjectAt } from '../src/engine/clips/subjects';
import { applyShortPatch, newShort, DEFAULT_CLIP_SETTINGS, validateDefaults } from '../src/engine/clips/types';

const box = (kind: ObjectBox['kind'], x: number, y = .55, w = .12, h = .3, score = .8): ObjectBox => ({ x, y, w, h, score, kind });
/** Samples at 8 fps; objects on every other frame, like the tracker page. */
function samples(seconds: number, at: (t: number) => { objects?: ObjectBox[]; faces?: FaceSample['faces']; motion?: FaceSample['motion'] }, from = 0): FaceSample[] {
  return Array.from({ length: Math.round(seconds * 8) }, (_, k) => {
    const t = Math.round((from + k / 8) * 1000) / 1000, v = at(t);
    return { t, faces: v.faces ?? [], ...(k % 2 === 0 ? { objects: v.objects ?? [] } : {}), ...(v.motion !== undefined ? { motion: v.motion } : {}) };
  });
}
const trackFile = (list: FaceSample[], scenes: number[] = []): FaceTrackFile => ({ format: 'sprityreels-face-track', version: 2, width: 1920, height: 1080, fps: 8, delegate: 'CPU', objects: true, ranges: [{ s: list[0].t, e: list[list.length - 1].t }], samples: list, scenes });

// ------------------------------------------------------------ detections
test('detector labels map to followable subjects, and furniture never does', () => {
  assert.equal(objectKind('person'), 'person'); assert.equal(objectKind('sports ball'), 'ball'); assert.equal(objectKind('Motorcycle'), 'vehicle'); assert.equal(objectKind('dog'), 'animal');
  for (const label of ['chair', 'tv', 'dining table', 'cell phone', '']) assert.equal(objectKind(label), null);
});

test('motion boxes find the moving part of the frame, not a camera move', () => {
  const W = 64, H = 36, frame = (sx: number, bright = 0) => { const f = new Uint8Array(W * H).fill(60 + bright); for (let y = 12; y < 20; y++) for (let x = sx; x < sx + 8; x++) f[y * W + x] = 220; return f; };
  const moved = motionBox(frame(10), frame(16), W, H);
  assert.ok(moved, 'a square moving right');
  assert.ok(moved!.x > 10 / W && moved!.x < 24 / W && Math.abs(moved!.y - 16 / H) < .06, JSON.stringify(moved));
  assert.ok(moved!.w <= 16 / W + .01 && moved!.level >= 100, JSON.stringify(moved));
  assert.equal(motionBox(frame(10), frame(10), W, H), null, 'nothing moved');
  assert.equal(motionBox(frame(10), frame(10, 90), W, H), null, 'the whole frame changed: a cut or a camera move');
  assert.equal(motionBox(frame(10), new Uint8Array(10), W, H), null);
});

// ------------------------------------------------------------ tracks and the main subject
test('objects link into tracks that end at scene cuts', () => {
  const list = samples(8, t => ({ objects: [box('vehicle', .2 + t * .05), box('vehicle', .8, .6, .1, .1)] }));
  const tracks = objectTracks(list, 'vehicle');
  assert.equal(tracks.length, 2);
  assert.ok(tracks.every(tr => tr.points.length === 32));
  assert.equal(objectTracks(list, 'vehicle', [4]).length, 4, 'a cut at 4 s splits both');
  assert.equal(objectTracks(list, 'animal').length, 0);
});

test('the main subject is the steady, big, central, moving one; several people become a group', () => {
  // A car drives across the middle; a small parked car sits at the edge half the time.
  const road = samples(10, t => ({ objects: [box('vehicle', .3 + t * .04, .55, .2, .2), ...(t < 5 ? [box('vehicle', .92, .7, .06, .05)] : [])] }));
  const car = mainSubject(road, 'auto');
  assert.equal(car?.kind, 'vehicle'); assert.ok(Math.abs(car!.points[0].x - .3) < .01, 'the moving car');
  assert.equal(mainSubject(road, 'speaker'), null, 'speaker follows faces only');
  assert.equal(mainSubject(road, 'ball'), null, 'no ball in this shot');
  // Three players of similar size: follow their middle, not one of them.
  const court = samples(6, t => ({ objects: [box('person', .3 + t * .02, .5, .1, .4), box('person', .5, .5, .1, .38), box('person', .7 - t * .02, .5, .1, .42)] }));
  const group = mainSubject(court, 'auto');
  assert.equal(group?.kind, 'group'); assert.ok(Math.abs(subjectAt(group!, 3)!.x - .5) < .03, JSON.stringify(subjectAt(group!, 3)));
  // A lone person stays a person.
  assert.equal(mainSubject(samples(6, t => ({ objects: [box('person', .4 + t * .03)] })), 'auto')?.kind, 'person');
  // Nothing detected: the moving part of the picture, when it moves most of the time.
  const skate = samples(6, t => ({ motion: { x: .2 + t * .1, y: .6, w: .1, h: .2, level: 80 } }));
  assert.equal(mainSubject(skate, 'auto')?.kind, 'motion');
  assert.equal(mainSubject(samples(6, () => ({ motion: null })), 'auto'), null);
});

// ------------------------------------------------------------ the follow path
const win = { w: 608, h: 1080 }, times = (seconds: number) => Array.from({ length: seconds * 8 }, (_, k) => k / 8);
test('the follow camera holds through jitter, pans without lag and stays inside the picture', () => {
  const jitter: SubjectTrack = { kind: 'vehicle', points: times(10).map((t, k) => ({ t, x: .5 + (k % 2 ? .012 : -.012), y: .5, w: .2, h: .2, score: .9 })) };
  const still = followPath(jitter, times(10), win, 1920, 1080);
  assert.ok(still.every(k => k.x === still[0].x), `jitter never moves the camera: ${still.map(k => k.x).join(',')}`);
  // A subject crossing the frame at constant speed: centred within the dead zone, never lagging far behind.
  const cross: SubjectTrack = { kind: 'vehicle', points: times(10).map(t => ({ t, x: .2 + t * .06, y: .5, w: .1, h: .1, score: .9 })) };
  const keys = followPath(cross, times(10), win, 1920, 1080);
  assert.ok(keys[0].cut && keys.slice(1).every(k => k.linear && !k.cut));
  assert.ok(keys.length < 20, `${keys.length} keys for 80 samples`);
  for (const t of [3, 5, 7]) {
    const centre = cameraAt(keys, t).x + win.w / 2, subject = (.2 + t * .06) * 1920;
    assert.ok(Math.abs(centre - subject) <= win.w * .1 + 12, `t=${t}: camera centre ${centre.toFixed(0)} vs subject ${subject.toFixed(0)}`);
  }
  // Near the edges the crop stops at the picture border.
  const edge: SubjectTrack = { kind: 'animal', points: times(4).map(t => ({ t, x: .02, y: .5, w: .05, h: .05, score: .9 })) };
  assert.ok(followPath(edge, times(4), win, 1920, 1080).every(k => k.x === 0));
  // A long shot of constant zig-zagging stays under the key budget.
  const zigzag: SubjectTrack = { kind: 'ball', points: times(120).map(t => ({ t, x: .5 + .4 * Math.sin(t * 2), y: .5, w: .02, h: .02, score: .9 })) };
  assert.ok(followPath(zigzag, times(120), win, 1920, 1080).length <= 120);
  // Straight segments: exact halfway values, and FFmpeg gets a linear expression.
  const lin = [{ t: 0, x: 100, y: 0, cut: true }, { t: 2, x: 300, y: 0, cut: false, linear: true }];
  assert.equal(cameraAt(lin, 1).x, 200);
  const expr = cropExpression(lin, 'x', 0, 4);
  assert.match(expr, /100\+\(200\)\*\(t-0\.000\)\/2\.000/); assert.doesNotMatch(expr, /pow/);
});

// ------------------------------------------------------------ planning
test('shots without a speaker follow the main subject; a named subject wins everywhere', () => {
  const face = { x: .5, y: .35, w: .12, h: .22, jaw: .1, mouth: .05, score: 1 };
  // 0-6 s: a talking head; 6-12 s (after a cut): a car crossing, no face.
  const list = [...samples(6, () => ({ faces: [face] })), ...samples(6, t => ({ objects: [box('vehicle', .25 + (t - 6) * .08, .6, .2, .15)] }), 6)];
  const input = { track: trackFile(list, [6]), words: [], layout: 'auto' as const, srcW: 1920, srcH: 1080, outW: 1080, outH: 1920 };
  const plan = planCamera(input);
  const talk = plan.shots.find(s => s.e === 6)!, road = plan.shots.find(s => s.s === 6)!;
  assert.equal(talk.layout, 'tracked'); assert.equal(talk.subject, undefined, 'the face leads the first shot');
  assert.equal(road.layout, 'tracked'); assert.equal(road.subject?.kind, 'vehicle');
  const keys = road.panes[0].keys;
  assert.ok(keys[0].t >= 6 && keys.some(k => k.linear), JSON.stringify(keys.slice(0, 3)));
  assert.ok(cameraAt(keys, 11).x > cameraAt(keys, 7).x + 300, 'the crop pans right with the car');
  // Captions keep off the followed car: its box is on screen, where the camera put it.
  const onScreen = screenFaces(plan, list, 9);
  assert.equal(onScreen.length, 1);
  const car = subjectAt(road.subject!, 9)!, crop = cameraAt(keys, 9), scale = 1080 / plan.shots[1].panes[0].win.w;
  assert.ok(Math.abs(onScreen[0].x + onScreen[0].w / 2 - ((car.x * 1920 - crop.x) * scale)) < 30, JSON.stringify({ onScreen, car, crop }));
  // Speaker only: the faceless shot shows the whole frame again.
  assert.equal(planCamera({ ...input, subject: 'speaker' }).shots.find(s => s.s === 6)!.layout, 'fit');
  // A named subject is followed even where there is a face, and reported where it is missing.
  const named = planCamera({ ...input, subject: 'vehicle' });
  assert.equal(named.shots.find(s => s.s === 6)!.subject?.kind, 'vehicle');
  assert.equal(named.shots.find(s => s.e === 6)!.subject, undefined);
  assert.ok(named.notes.some(n => /No vehicle was found in some shots/.test(n)), named.notes.join(' | '));
});

test('the subject option is validated on shorts and settings', () => {
  const short = newShort({ id: 'a', sourceId: 'b', name: 'x', mode: 'clip', segments: [{ id: 'seg001', kind: 'source', start: 0, end: 5 }], defaults: DEFAULT_CLIP_SETTINGS, creditText: '' });
  assert.equal(short.subject, 'auto');
  assert.equal(applyShortPatch(short, { subject: 'ball' }, 60).subject, 'ball');
  assert.throws(() => applyShortPatch(short, { subject: 'face' }, 60), /subject must be one of/);
  assert.equal(validateDefaults({ subject: 'animal' }).subject, 'animal');
});
