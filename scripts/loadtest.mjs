// How many visitors can this server look after at once? Starts N virtual visitors (each gets its own workspace cookie, like a browser) and
// has each ask for the studio overview every EVERY_MS (default 1500, what a studio screen does while something is running).
//   node scripts/loadtest.mjs http://127.0.0.1:3000 200 20
// Optional: PATH_TO_POLL=/api/clips/sources/<id> COOKIE=<sr_ws value> polls a real source of an existing workspace instead (all visitors then share
// it, which is kind to the server; use it to check a busy workspace). Reports requests per second, latency percentiles, errors and the share
// of conditional requests answered with 304.
const [base = 'http://127.0.0.1:3000', visitorsArg = '100', secondsArg = '15'] = process.argv.slice(2);
const visitors = Math.max(1, Number(visitorsArg) || 100), seconds = Math.max(1, Number(secondsArg) || 15), every = Number(process.env.EVERY_MS ?? 1500), route = process.env.PATH_TO_POLL ?? '/api/clips';
const lat = []; let errors = 0, notModified = 0, bytes = 0, stop = false;
async function visitor() {
  let cookie = process.env.COOKIE ? `sr_ws=${process.env.COOKIE}` : '', etag = '';
  await new Promise(r => setTimeout(r, Math.random() * every));
  while (!stop) {
    const t = performance.now();
    try {
      const res = await fetch(base + route, { headers: { ...(cookie ? { Cookie: cookie } : {}), ...(etag ? { 'If-None-Match': etag } : {}) } });
      bytes += (await res.arrayBuffer()).byteLength;
      const set = res.headers.get('set-cookie'); if (set && !cookie) cookie = set.split(';')[0];
      if (res.status === 304) notModified++; else etag = res.headers.get('etag') ?? '';
      if (res.ok || res.status === 304) lat.push(performance.now() - t); else errors++;
    } catch { errors++; }
    await new Promise(r => setTimeout(r, every));
  }
}
const started = Date.now(), all = Array.from({ length: visitors }, visitor);
await new Promise(r => setTimeout(r, seconds * 1000)); stop = true; await Promise.all(all);
const took = (Date.now() - started) / 1000, sorted = lat.sort((a, b) => a - b), q = p => Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0);
console.log(JSON.stringify({ visitors, everyMs: every, route, requestsPerSecond: Math.round(lat.length / took), p50ms: q(.5), p95ms: q(.95), p99ms: q(.99), errors, notModified, kbPerRequest: Number((bytes / Math.max(1, lat.length) / 1024).toFixed(1)) }));
process.exit(errors > lat.length * 0.01 ? 1 : 0);
