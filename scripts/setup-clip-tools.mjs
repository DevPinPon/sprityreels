// Installs the local Sprity Reels toolkit. Every file is pinned by size and SHA-256 and kept when it already matches.
//   yt-dlp 2026.08.19 (Unlicense)             .sprityreels/tools/yt-dlp/yt-dlp.exe            link import (Windows build)
//   whisper.cpp b5130 CUDA 11.8 (MIT)         .sprityreels/tools/whisper/b5130/               GPU transcription (Windows x64)
//   Whisper large-v3-turbo q5_0 (MIT)         .sprityreels/tools/whisper/models/              word-timed transcripts
//   MediaPipe Face Landmarker (Apache-2.0)    public/mediapipe/face_landmarker.task       speaker tracking for vertical reframing
//   EfficientDet-Lite0 (Apache-2.0)           public/mediapipe/efficientdet_lite0.tflite  object tracking (people, balls, vehicles, animals)
//   Caption fonts (SIL OFL 1.1)               public/fonts/clips/                         animated captions (studio preview and FFmpeg/libass)
// On macOS and Linux, install yt-dlp and whisper.cpp with a package manager and set SPRITYREELS_YTDLP / SPRITYREELS_WHISPER_CLI.
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tools = path.join(root, '.sprityreels', 'tools'), windows = process.platform === 'win32';
const FONTS_COMMIT = '23e54b51ddffbc7713c583748e3bd86f62b1fa4a';
const font = (dir, file, size, sha256, target = file) => ({ url: `https://raw.githubusercontent.com/google/fonts/${FONTS_COMMIT}/ofl/${dir}/${file}`, target: path.join(root, 'public', 'fonts', 'clips', target), size, sha256 });
const WHISPER = { build: 'b5130', size: 272982859, sha256: '0b29b2175bb17ec26da29677cbc7c467c57d103245144d62a49a703f6bc3fdae', url: 'https://github.com/ggml-org/whisper.cpp/releases/download/b5130/whisper-cublas-11.8.0-bin-x64.zip' };
const FILES = [
  ...(windows ? [{ url: 'https://github.com/yt-dlp/yt-dlp/releases/download/2026.08.19/yt-dlp.exe', target: path.join(tools, 'yt-dlp', 'yt-dlp.exe'), size: 17840399, sha256: '66674953fe251b89f4d08c5f0e35e0728679bd67ab3d7d05c0562af101dd3e7a' }] : []),
  { url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-large-v3-turbo-q5_0.bin', target: path.join(tools, 'whisper', 'models', 'ggml-large-v3-turbo-q5_0.bin'), size: 574041195, sha256: '394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2' },
  { url: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task', target: path.join(root, 'public', 'mediapipe', 'face_landmarker.task'), size: 3758596, sha256: '64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff' },
  { url: 'https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float16/latest/efficientdet_lite0.tflite', target: path.join(root, 'public', 'mediapipe', 'efficientdet_lite0.tflite'), size: 7254339, sha256: '4b59100025bea1235a84c1038879a6cccc9f6c49f5e41144e91e74d99e780993' },
  font('poppins', 'Poppins-Bold.ttf', 155996, '983676516167748b74de6f4771fb384c664fd913acb8b471122ecacf5da5ea6c'),
  font('poppins', 'Poppins-ExtraBold.ttf', 154836, 'f2ab17c1a63a0ecc12c2461848fc8a469395e3cd2d641803e889c643d9f958e1'),
  font('poppins', 'Poppins-Black.ttf', 153440, 'd82aaaf98a9283f9a8edd24e51173337d8eaf09e25cd3d98831f8ec8461748a1'),
  font('poppins', 'OFL.txt', 4385, '6be04893d770899a015649c7aa3b582f871b272f8747a92b78b17c3e5c8b2573', 'OFL-Poppins.txt'),
  font('anton', 'Anton-Regular.ttf', 170812, 'a4ba3a92350ebb031da0cb47630ac49eb265082ca1bc0450442f4a83ab947cab'),
  font('anton', 'OFL.txt', 4484, 'ee67e6ee22790b7929f1a3769ca2801d565c64b5a9096942c1adf5596de9c9e4', 'OFL-Anton.txt'),
  font('bebasneue', 'BebasNeue-Regular.ttf', 61400, '08e4623805102d819f58601e46e345648846075e363b2ceb23313c2d1c83ec73'),
  font('bebasneue', 'OFL.txt', 4337, '72082f6cb4d04be2ecf7cc7d9e1e7d73787f0af8a5a278a47cade70c16b78341', 'OFL-BebasNeue.txt'),
  font('archivoblack', 'ArchivoBlack-Regular.ttf', 90988, 'dd9a89a019b4849f66ab75455fe7bdf931311042cbb0f0f97acc061539703180'),
  font('archivoblack', 'OFL.txt', 4492, '3173acd82f8c6159b5b1037b539fcbd4edff68e65c2ea8b9412b5a5ca97b08ff', 'OFL-ArchivoBlack.txt'),
  font('bangers', 'Bangers-Regular.ttf', 93148, '4160a7311de9342674cce9160cde9fcbb30f48190397d86ff1b70b455af65824'),
  font('bangers', 'OFL.txt', 4479, '630dd5a307c0657b094d324e069b390edf90182fe5003639e06c02a0e5769af7', 'OFL-Bangers.txt'),
  font('lilitaone', 'LilitaOne-Regular.ttf', 28092, 'f5b641c45c69d772ee4eda687bc9fda411d5cad6b0b45371491da4580cbc8d59'),
  font('lilitaone', 'OFL.txt', 4392, '255d5debbb80eb2ea762644311f266a279e8778f00156655a516e2b7781a63e1', 'OFL-LilitaOne.txt'),
];

const mb = bytes => `${(bytes / 1e6).toFixed(1)} MB`;
const fileHash = async file => { const hash = createHash('sha256'); await pipeline(createReadStream(file), hash); return hash.digest('hex'); };
const matches = async (file, size, sha256) => { const info = await stat(file).catch(() => null); return !!info && info.size === size && await fileHash(file) === sha256; };

// Streams to <target>.pending while hashing, so an interrupted or tampered download never replaces a good file.
async function download({ url, target, size, sha256 }) {
  const label = path.relative(root, target);
  if (await matches(target, size, sha256)) { console.log(`ok   ${label}`); return; }
  await mkdir(path.dirname(target), { recursive: true });
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`Download failed for ${label}: HTTP ${res.status}`);
  const hash = createHash('sha256'), pending = `${target}.pending`;
  let received = 0, shown = -1;
  const body = Readable.fromWeb(res.body);
  body.on('data', chunk => {
    hash.update(chunk); received += chunk.length;
    const pct = Math.floor(received / size * 100);
    if (size > 20e6 && pct >= shown + 10) { shown = pct - pct % 10; process.stdout.write(`\rget  ${label} ${mb(received)} / ${mb(size)} `); }
  });
  if (size <= 20e6) process.stdout.write(`get  ${label} (${mb(size)})… `);
  await pipeline(body, createWriteStream(pending));
  if (received !== size || hash.digest('hex') !== sha256) { await rm(pending, { force: true }); throw new Error(`${label} does not match the pinned size and SHA-256. Nothing was replaced; review the upstream file before updating this script.`); }
  await rm(target, { force: true }); await rename(pending, target);
  console.log(size > 20e6 ? '\n     done' : 'done');
}

async function findFile(dir, name) {
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === name) return full;
    if (entry.isDirectory()) { const found = await findFile(full, name); if (found) return found; }
  }
  return null;
}

async function installWhisper() {
  const dir = path.join(tools, 'whisper', WHISPER.build), marker = path.join(dir, '.verified');
  const existing = await findFile(dir, 'whisper-cli.exe');
  if (existing && await stat(marker).then(() => true, () => false)) { console.log(`ok   ${path.relative(root, existing)}`); return existing; }
  const zip = path.join(tools, 'whisper', `whisper-cublas-11.8.0-${WHISPER.build}.zip`);
  await download({ ...WHISPER, target: zip });
  await rm(dir, { recursive: true, force: true }); await mkdir(dir, { recursive: true });
  // Windows 10+ ships bsdtar, which extracts ZIP archives. Call it by path: GNU tar from Git reads "D:" as a remote host.
  const tar = windows ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
  const result = spawnSync(tar, ['-xf', zip, '-C', dir], { stdio: 'inherit', windowsHide: true });
  if (result.status !== 0) throw new Error('Could not extract the whisper.cpp archive with tar.');
  const cli = await findFile(dir, 'whisper-cli.exe');
  if (!cli) throw new Error('The whisper.cpp archive did not contain whisper-cli.exe.');
  await writeFile(marker, `${WHISPER.url}\n${WHISPER.sha256}\n`); await rm(zip, { force: true });
  console.log(`ok   ${path.relative(root, cli)}`);
  return cli;
}

for (const file of FILES) await download(file);
const manifest = { version: 1, ytdlp: windows ? path.join(tools, 'yt-dlp', 'yt-dlp.exe') : null, whisperCli: windows ? await installWhisper() : null, whisperModel: FILES.find(f => f.target.endsWith('.bin')).target, whisperBuild: windows ? WHISPER.build : null };
await writeFile(path.join(tools, 'clip-tools.json'), `${JSON.stringify(manifest, null, 2)}\n`);
if (!windows) console.log('Install yt-dlp and whisper.cpp (whisper-cli) with your package manager, then set SPRITYREELS_YTDLP and SPRITYREELS_WHISPER_CLI if they are not on PATH.');
console.log('Sprity Reels tools are ready. Restart Sprity Reels to pick them up.');
