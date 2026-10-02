import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app';
import type { AppOptions } from '../server/app';
import type { ClipTools } from '../server/clips/tools';
import { run } from '../server/clips/tools';

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
async function until<T>(read: () => T | Promise<T>, done: (v: T) => boolean, ms = 60_000) {
  const end = Date.now() + ms;
  for (;;) { const v = await read(); if (done(v)) return v; if (Date.now() > end) throw new Error(`Timed out: ${JSON.stringify(v).slice(0, 300)}`); await sleep(40); }
}
const testTools = async (): Promise<ClipTools> => ({ ytdlp: null, whisper: null, whisperModel: null, whisperGpu: null, ffmpeg: true, nvenc: false, fonts: path.resolve('public/fonts/clips'), cacheDir: tmpdir() });
async function site(t: { after: (fn: () => unknown) => void }, extra: Partial<AppOptions> = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'sprityreels-limits-'));
  let origin = '';
  const app = createApp({ root, dataDir: path.join(root, 'data'), origin: () => origin, resolveHost: async () => [{ address: '93.184.216.34' }], minFreeBytes: 0, ...extra, service: { tools: testTools, directors: {}, ...extra.service } });
  const http = createServer((req, res) => void app.handle(req, res, () => { res.statusCode = 404; res.end(); }));
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  t.after(async () => { http.closeAllConnections(); await new Promise<void>(r => http.close(() => r())); await app.dispose(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });
  const visitor = () => {
    let cookie = '';
    const raw = async (route: string, init: RequestInit = {}) => { const res = await fetch(origin + route, { ...init, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(init.headers as Record<string, string>) } }); const set = res.headers.get('set-cookie'); if (set) cookie = set.split(';')[0]; return res; };
    const get = async (route: string) => { const res = await raw('/api/clips' + route); return { status: res.status, data: await res.json().catch(() => null) as any }; };
    const upload = async (name: string, bytes: Buffer<ArrayBuffer>) => { const res = await raw(`/api/clips/sources/upload?file=${name}&rights=own&watch=false`, { method: 'POST', headers: { 'X-SprityReels-Request': 'clips' }, body: bytes }); return { status: res.status, data: await res.json().catch(() => null) as any }; };
    return { raw, get, upload, id: () => cookie.split('=')[1] ?? '' };
  };
  return { root, app, visitor, workspaces: path.join(root, 'data', 'workspaces') };
}

test('files are deleted when a visitor has not been back for the retention time, and only then', async t => {
  const s = await site(t, { retentionHours: 1, retentionSweepMs: 3_600_000 });
  const hex = (n: number) => n.toString(16).padStart(32, '0');
  const make = async (id: string, ageHours: number | null) => {
    const dir = path.join(s.workspaces, id, 'clips', 'sources'); await mkdir(dir, { recursive: true }); await writeFile(path.join(dir, 'video.mp4'), 'x');
    if (ageHours !== null) { await writeFile(path.join(s.workspaces, id, '.active'), 'x'); const when = new Date(Date.now() - ageHours * 3600_000); await utimes(path.join(s.workspaces, id, '.active'), when, when); }
    else { const when = new Date(Date.now() - 5 * 3600_000); await utimes(path.join(s.workspaces, id), when, when); }
  };
  await make(hex(1), 3); await make(hex(2), 0.2); await make(hex(3), null); await mkdir(path.join(s.workspaces, 'not-a-workspace'), { recursive: true });
  assert.equal(await s.app.expire(), 2, 'the one idle for 3 hours and the one with no visit recorded and an old folder');
  assert.deepEqual((await readdir(s.workspaces)).sort(), [hex(2), 'not-a-workspace'].sort());

  // A visit is recorded, and a workspace in use is never removed.
  const v = s.visitor();
  assert.equal((await v.get('')).status, 200);
  await until(() => stat(path.join(s.workspaces, v.id(), '.active')).then(() => true, () => false), ok => ok);
  const old = new Date(Date.now() - 10 * 3600_000); await utimes(path.join(s.workspaces, v.id(), '.active'), old, old);
  assert.equal(await s.app.expire(), 0, 'a visitor who is here right now keeps their files even if the record is old');
  assert.equal((await v.get('')).data.limits.retentionHours, 1, 'the visitor is told how long files are kept');
  assert.equal(s.app.workspaceCount(), 1);
});

test('nothing is deleted when retention is off', async t => {
  const s = await site(t);
  const dir = path.join(s.workspaces, 'a'.repeat(32)); await mkdir(dir, { recursive: true }); const when = new Date(Date.now() - 400 * 24 * 3600_000); await utimes(dir, when, when);
  assert.equal(await s.app.expire(), 0);
  assert.equal((await readdir(s.workspaces)).length, 1);
  assert.equal((await s.visitor().get('')).data.limits.retentionHours, 0);
});

test('one visitor cannot fill the disk: uploads stop at their share, and the limit shown shrinks with it', async t => {
  const s = await site(t, { maxWorkspaceBytes: 5e6, maxUploadBytes: 4e6 });
  const v = s.visitor(), junk = (mb: number) => Buffer.alloc(Math.round(mb * 1e6), 7);
  assert.equal((await v.get('')).data.limits.uploadBytes, 4e6, 'with an empty workspace the limit is the upload limit');
  assert.equal((await v.upload('a.mp4', junk(3))).status, 202);
  const after = (await v.get('')).data.limits.uploadBytes;
  assert.ok(after > 1.5e6 && after < 2.1e6, `about 2 MB left, not ${after}`);
  const refused = await v.upload('b.mp4', junk(3));
  assert.equal(refused.status, 413); assert.match(refused.data.error, /workspace has \d+ MB free/);
  assert.equal((await v.upload('c.mp4', junk(1))).status, 202, 'a smaller file still fits');
  // Another visitor has their own share.
  assert.equal((await s.visitor().upload('d.mp4', junk(3))).status, 202);
});

test('a video longer than the operator allows is refused with the limit in the message', async t => {
  const s = await site(t, { maxVideoMinutes: 2 });
  const file = path.join(s.root, 'long.mp4');
  await run('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x405060:s=64x36:r=1:d=150', '-f', 'lavfi', '-i', "aevalsrc='0.1*sin(2*PI*220*t)':s=8000:d=150", '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-g', '30', '-c:a', 'aac', '-t', '150', file], { timeout: 60_000 });
  const v = s.visitor(), bytes = await readFile(file);
  assert.equal((await v.get('')).data.limits.maxVideoMinutes, 2);
  const up = await v.upload('long.mp4', bytes);
  assert.equal(up.status, 202);
  const failed = await until(async () => (await v.get(`/sources/${up.data.source.id}`)).data.source, src => src.status !== 'working');
  assert.equal(failed.status, 'failed'); assert.match(failed.error, /Use videos up to 2 minutes/);
});

test('uploads stop while the disk is nearly full, so a flood of uploads cannot fill it', async t => {
  const s = await site(t, { minFreeBytes: Number.MAX_SAFE_INTEGER });
  const v = s.visitor();
  assert.equal((await v.get('')).data.limits.uploadBytes, 0, 'the studio is told there is no room');
  const refused = await v.upload('a.mp4', Buffer.alloc(1e6, 7));
  assert.equal(refused.status, 503); assert.match(refused.data.error, /nearly full/);
  assert.equal((await readdir(path.join(s.workspaces, v.id(), 'clips', 'sources')).catch(() => [])).length, 0, 'nothing was stored');
  const open = await site(t, { minFreeBytes: 0 });
  assert.equal((await open.visitor().upload('a.mp4', Buffer.alloc(1e6, 7))).status, 202);
});

test('a visitor has a number of video minutes a day: a video that goes over is refused, a retry is not counted twice, and the studio says what is left', async t => {
  const s = await site(t, { maxMinutesPerDay: 2 });
  const file = path.join(s.root, 'min.mp4');
  await run('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x405060:s=64x36:r=1:d=70', '-f', 'lavfi', '-i', "aevalsrc='0.1*sin(2*PI*220*t)':s=8000:d=70", '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-t', '70', file], { timeout: 60_000 });
  const bytes = await readFile(file), v = s.visitor();
  const before = (await v.get('')).data.limits; assert.equal(before.minutesPerDay, 2); assert.equal(before.minutesLeft, 2);
  const a = await v.upload('a.mp4', bytes); assert.equal(a.status, 202);
  await until(async () => (await v.get(`/sources/${a.data.source.id}`)).data.source.status, st => st !== 'working');
  assert.equal((await v.get('')).data.limits.minutesLeft, 0, '70 s of 120 s used: 50 s left is under a minute');
  const b = await v.upload('b.mp4', bytes); assert.equal(b.status, 202, 'there is still some left, so the upload is taken');
  const over = await until(async () => (await v.get(`/sources/${b.data.source.id}`)).data.source, src => src.status !== 'working');
  assert.equal(over.status, 'failed'); assert.match(over.error, /takes 2 minutes of video per visitor a day/);
  // Retrying the first video does not count it again.
  const retry = await v.raw(`/api/clips/sources/${a.data.source.id}/retry`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-SprityReels-Request': 'clips' }, body: '{}' });
  assert.equal(retry.status, 202);
  const again = await until(async () => (await v.get(`/sources/${a.data.source.id}`)).data.source, src => src.status !== 'working');
  assert.doesNotMatch(again.error ?? '', /minutes of video per visitor/);
  // Another visitor has their own minutes.
  assert.equal((await s.visitor().get('')).data.limits.minutesLeft, 2);
  // With nothing left at all, a new video is refused before it is stored.
  const minute = path.join(s.root, 'minute.mp4');
  await run('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x405060:s=64x36:r=1:d=60', '-f', 'lavfi', '-i', "aevalsrc='0.1*sin(2*PI*220*t)':s=8000:d=60", '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-t', '60', minute], { timeout: 60_000 });
  const full = await site(t, { maxMinutesPerDay: 1 }), w = full.visitor(), exact = await readFile(minute);
  const one = await w.upload('one.mp4', exact); assert.equal(one.status, 202);
  await until(async () => (await w.get(`/sources/${one.data.source.id}`)).data.source.status, st => st !== 'working');
  assert.equal((await w.get('')).data.limits.minutesLeft, 0);
  const none = await w.upload('two.mp4', exact);
  assert.equal(none.status, 429); assert.match(none.data.error, /used today’s 1 minute of video/);
  assert.equal((await w.get('')).data.sources.length, 1, 'the refused video was not stored');
});
