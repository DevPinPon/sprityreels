import test from 'node:test';
import assert from 'node:assert/strict';
import { request, createServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { DEFAULT_LINK_HOSTS, checkLink, linkHosts, privateAddress } from '../server/links';
import { headlessArgs } from '../server/browser';
import { serveStatic } from '../server/static';
import { HttpError, byteRange, readJson } from '../server/support';

test('private, loopback and reserved addresses are recognised in every notation', () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255', '198.18.0.1',
    '::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '::ffff:7f00:1', '::ffff:a00:1', 'not-an-ip']) assert.equal(privateAddress(address), true, address);
  for (const address of ['93.184.216.34', '8.8.8.8', '172.15.0.1', '172.32.0.1', '100.63.0.1', '2606:2800:220:1:248:1893:25c8:1946', '::ffff:8.8.8.8', '2a00:1450:4001::200e']) assert.equal(privateAddress(address), false, address);
});

test('links must come from a known site and resolve to public addresses only', async () => {
  const resolve = async (host: string) => [{ address: host.startsWith('internal') ? '10.0.0.7' : host.startsWith('mixed') ? '8.8.8.8' : '93.184.216.34' }, ...(host.startsWith('mixed') ? [{ address: '127.0.0.1' }] : [])];
  const reject = async (url: unknown, pattern: RegExp, hosts?: string[]) => assert.rejects(checkLink(url, { resolve, hosts }), (e: unknown) => e instanceof HttpError && e.status === 400 && pattern.test(e.message), String(url));
  await checkLink('https://www.youtube.com/watch?v=abc', { resolve });
  await checkLink('https://youtu.be/abc', { resolve });
  await checkLink('http://vimeo.com/1', { resolve });
  await reject('https://example.com/video', /not supported/);
  await reject('https://notyoutube.com/video', /not supported/, ['youtube.com']);
  await reject('https://youtube.com.evil.example/x', /not supported/);
  await reject('ftp://youtube.com/x', /http and https/);
  await reject('file:///etc/passwd', /http and https/);
  await reject('javascript:alert(1)', /http and https/);
  await reject('not a link', /full link/);
  await reject(undefined, /full link/);
  await reject('http://169.254.169.254/latest/meta-data/', /video site/);
  await reject('http://2130706433/', /video site/);
  await reject('https://internal.youtube.com/x', /private address/);
  await reject('https://mixed.youtube.com/x', /private address/);
  await assert.rejects(checkLink('https://gone.youtube.com/x', { resolve: async () => { throw new Error('ENOTFOUND'); } }), /could not be found/);
  // With * every public host is allowed, and private addresses are still refused.
  await checkLink('https://example.org/clip', { resolve, hosts: ['*'] });
  await checkLink('http://93.184.216.34/clip', { resolve, hosts: ['*'] });
  await reject('http://10.0.0.5/clip', /private address/, ['*']);
  await reject('http://[::1]/clip', /private address/, ['*']);
  assert.deepEqual(linkHosts(undefined), DEFAULT_LINK_HOSTS);
  assert.deepEqual(linkHosts(' Example.com , ,vimeo.com'), ['example.com', 'vimeo.com']);
});

test('the headless browser gets --no-sandbox only as root on Linux, and a roomy shared-memory fallback there', () => {
  const root = headlessArgs('/p', 'http://x/', 'linux', 0), user = headlessArgs('/p', 'http://x/', 'linux', 1000), windows = headlessArgs('C:\\p', 'http://x/', 'win32', undefined), mac = headlessArgs('/p', 'http://x/', 'darwin', 0);
  assert.ok(root.includes('--no-sandbox') && root.includes('--disable-dev-shm-usage'));
  assert.ok(!user.includes('--no-sandbox') && user.includes('--disable-dev-shm-usage'));
  assert.ok(!windows.includes('--no-sandbox') && !windows.includes('--disable-dev-shm-usage'));
  assert.ok(!mac.includes('--no-sandbox'), 'only Linux needs it');
  for (const args of [root, user, windows, mac]) { assert.ok(args.includes('--headless=new')); assert.equal(args[args.length - 1].startsWith('http'), true); assert.ok(args.some(a => a.startsWith('--user-data-dir='))); }
});

test('byte ranges and JSON bodies are parsed strictly', async () => {
  assert.equal(byteRange(undefined, 100), null);
  assert.deepEqual(byteRange('bytes=0-9', 100), { start: 0, end: 9 });
  assert.deepEqual(byteRange('bytes=90-', 100), { start: 90, end: 99 });
  assert.deepEqual(byteRange('bytes=-10', 100), { start: 90, end: 99 });
  assert.deepEqual(byteRange('bytes=50-500', 100), { start: 50, end: 99 });
  for (const bad of ['bytes=100-', 'bytes=9-1', 'bytes=-', 'items=0-1', 'bytes=0-1,5-6']) assert.throws(() => byteRange(bad, 100), (e: unknown) => e instanceof HttpError && e.status === 416, bad);
  const body = (text: string) => Readable.from([Buffer.from(text)]) as never;
  assert.deepEqual(await readJson(body('{"a":1}')), { a: 1 });
  assert.deepEqual(await readJson(body('')), {});
  await assert.rejects(readJson(body('{nope')), (e: unknown) => e instanceof HttpError && e.status === 400);
  await assert.rejects(readJson(body('x'.repeat(50)), 10), (e: unknown) => e instanceof HttpError && e.status === 413);
});

test('the built site is served with page fallback, long caching for assets and no path escape', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'sprityreels-static-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'dist', 'assets'), { recursive: true });
  await writeFile(path.join(root, 'secret.txt'), 'secret');
  await writeFile(path.join(root, 'dist', 'index.html'), '<!doctype html><title>home</title>');
  await writeFile(path.join(root, 'dist', 'assets', 'app-abc.js'), 'console.log(1)');
  await writeFile(path.join(root, 'dist', 'model.task'), 'weights');
  const serve = serveStatic(path.join(root, 'dist'));
  const http = createServer((req, res) => void serve(req, res, () => { res.statusCode = 418; res.end('next'); }));
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  t.after(async () => { http.closeAllConnections(); await new Promise<void>(r => http.close(() => r())); });
  const port = (http.address() as { port: number }).port;
  const get = (pathname: string, method = 'GET') => new Promise<{ status: number; type: string; cache: string; body: string }>((resolve, reject) => {
    request({ host: '127.0.0.1', port, path: pathname, method }, res => { let body = ''; res.on('data', c => body += c); res.on('end', () => resolve({ status: res.statusCode!, type: String(res.headers['content-type']), cache: String(res.headers['cache-control']), body })); }).on('error', reject).end();
  });
  const home = await get('/');
  assert.equal(home.status, 200); assert.match(home.type, /text\/html/); assert.equal(home.cache, 'no-cache'); assert.match(home.body, /home/);
  assert.match((await get('/app')).body, /home/, 'a page route falls back to index.html');
  const script = await get('/assets/app-abc.js');
  assert.equal(script.status, 200); assert.match(script.type, /javascript/); assert.match(script.cache, /immutable/);
  assert.equal((await get('/model.task')).cache, 'public, max-age=86400');
  assert.equal((await get('/missing.js')).status, 404, 'a missing file with an extension is not a page');
  assert.equal((await get('/..%2fsecret.txt')).status, 403);
  { const dots = await get('/%2e%2e/secret.txt'); assert.ok(dots.status === 403 || dots.status === 404, String(dots.status)); assert.ok(!dots.body.includes('secret')); }
  assert.ok(!(await get('/assets/..%2f..%2fsecret.txt')).body.includes('secret'));
  assert.equal((await get('/%00')).status, 400);
  assert.equal((await get('/', 'POST')).status, 418, 'other methods go on to the next handler');
  assert.equal((await get('/', 'HEAD')).body, '');
});
