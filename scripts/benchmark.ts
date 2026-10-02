// Times the whole pipeline on this computer: npm run bench -- "D:\Videos\talk.mp4"
//   --minutes 10      length of the video that is timed (a shorter file is repeated, a longer one is cut)
//   --reels 5         reels made from the best moments
//   --no-tracking     do not follow faces and subjects
//   --json            print the numbers as JSON instead of the report
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatReport, runBenchmark } from '../server/benchmark';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try { process.loadEnvFile(path.join(root, '.env')); } catch { /* no .env file */ }

const args = process.argv.slice(2), flag = (name: string) => args.includes(`--${name}`);
const value = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const skip = new Set(['--minutes', '--reels'].flatMap(f => { const i = args.indexOf(f); return i >= 0 ? [i, i + 1] : []; }));
const file = args.find((a, i) => !a.startsWith('--') && !skip.has(i));
const number = (text: string | undefined, fallback: number) => { const n = Number(text); return Number.isFinite(n) && n > 0 ? n : fallback; };

if (!file) {
  console.error('Usage: npm run bench -- <video with speech> [--minutes 10] [--reels 5] [--no-tracking] [--json]');
  process.exit(2);
}
const json = flag('json');
try {
  const report = await runBenchmark({ file: path.resolve(file), root, minutes: number(value('minutes'), 10), reels: number(value('reels'), 5), tracking: !flag('no-tracking'), log: line => { if (!json) console.error(line); } });
  console.log(json ? JSON.stringify(report, null, 2) : `\n${formatReport(report)}`);
  process.exit(0);
} catch (error) {
  console.error(`\nThe speed check stopped: ${error instanceof Error ? error.message : String(error)}`);
  if (/whisper|not set up/i.test(String(error))) console.error('Run "npm run setup:clips" first (it installs whisper.cpp and its model).');
  process.exit(1);
}
