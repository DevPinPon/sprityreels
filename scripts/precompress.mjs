// After `vite build`: writes .br and .gz copies of the text files in dist/ so the server can send them as they are, with no
// compression work per request. Files that do not shrink by at least 10% are left alone.
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.argv[2] ?? 'dist'), TEXT = new Set(['.html', '.js', '.mjs', '.css', '.svg', '.json', '.txt']);
let files = 0, before = 0, after = 0;
const walk = dir => { for (const entry of readdirSync(dir, { withFileTypes: true })) { const file = path.join(dir, entry.name); if (entry.isDirectory()) walk(file); else if (TEXT.has(path.extname(file).toLowerCase())) pack(file); } };
function pack(file) {
  const data = readFileSync(file);
  if (data.length < 1024) return;
  const br = brotliCompressSync(data, { params: { [constants.BROTLI_PARAM_QUALITY]: data.length > 1e6 ? 9 : 11, [constants.BROTLI_PARAM_SIZE_HINT]: data.length } }), gz = gzipSync(data, { level: 9 });
  let best = data.length;
  if (br.length < data.length * 0.9) { writeFileSync(`${file}.br`, br); best = Math.min(best, br.length); }
  if (gz.length < data.length * 0.9) { writeFileSync(`${file}.gz`, gz); best = Math.min(best, gz.length); }
  files++; before += data.length; after += best;
}
if (!statSync(root, { throwIfNoEntry: false })?.isDirectory()) { console.error(`No ${root}: run vite build first.`); process.exit(1); }
walk(root);
console.log(`precompressed ${files} files: ${(before / 1024).toFixed(0)} KB -> ${(after / 1024).toFixed(0)} KB (${before ? Math.round(100 - after * 100 / before) : 0}% less to send)`);
