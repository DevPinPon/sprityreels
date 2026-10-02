import { spawn } from 'node:child_process';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** A Chromium-based browser for the headless tracker page (Chrome, Edge or Chromium). SPRITYREELS_BROWSER overrides the search. */
export async function findBrowser() {
  const env = process.env, programs = env.ProgramFiles || 'C:/Program Files', programs86 = env['ProgramFiles(x86)'] || 'C:/Program Files (x86)';
  const candidates = env.SPRITYREELS_BROWSER ? [env.SPRITYREELS_BROWSER] : process.platform === 'win32'
    ? [path.join(programs, 'Google/Chrome/Application/chrome.exe'), path.join(programs86, 'Google/Chrome/Application/chrome.exe'), ...(env.LOCALAPPDATA ? [path.join(env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe')] : []),
      path.join(programs86, 'Microsoft/Edge/Application/msedge.exe'), path.join(programs, 'Microsoft/Edge/Application/msedge.exe')]
    : process.platform === 'darwin'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Applications/Chromium.app/Contents/MacOS/Chromium']
      : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge', '/snap/bin/chromium'];
  for (const file of candidates) if (await access(file).then(() => true, () => false)) return file;
  return null;
}
export type BrowserRun = { stop: () => Promise<void> };

/** Flags for a headless run. Chromium refuses to start as root without --no-sandbox (the usual case in a container), and
 * a container's small /dev/shm crashes it, so Linux gets both. */
export function headlessArgs(profile: string, url: string, platform = process.platform, uid = process.getuid?.()) {
  return ['--headless=new', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-sync',
    '--disable-background-networking', '--mute-audio', '--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows', '--enable-unsafe-swiftshader', '--window-size=1280,900',
    ...(platform === 'linux' ? ['--disable-dev-shm-usage', ...(uid === 0 ? ['--no-sandbox'] : [])] : []), url];
}

/** Opens a page of this server in a headless browser with a throwaway profile (never a person's own session). stop() ends
 * the whole process tree and deletes the profile. A browser that exits within the first moments (a missing library, a
 * refused sandbox) is reported here, with its last error line, instead of leaving the caller to wait out a timeout. */
export async function openHeadless(browser: string, url: string): Promise<BrowserRun> {
  const profile = await mkdtemp(path.join(tmpdir(), 'sprityreels-browser-'));
  const child = spawn(browser, headlessArgs(profile, url), { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' });
  let errors = '', stopped = false;
  child.stderr!.on('data', (chunk: Buffer) => { if (errors.length < 6000) errors += chunk.toString('utf8'); });
  child.on('error', () => {});
  const run: BrowserRun = {
    async stop() {
      if (stopped) return;
      stopped = true;
      if (child.exitCode === null && child.pid) {
        // Browsers start helper processes; end the tree, not only the launcher.
        if (process.platform === 'win32') await new Promise<void>(resolve => { const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); killer.on('close', () => resolve()); killer.on('error', () => resolve()); });
        else { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
      }
      await new Promise(resolve => setTimeout(resolve, 300));
      await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
    },
  };
  const early = await new Promise<'running' | number | null>(resolve => {
    const timer = setTimeout(() => resolve('running'), 1500);
    child.once('exit', code => { clearTimeout(timer); resolve(code); });
    child.once('error', () => { clearTimeout(timer); resolve(-1); });
  });
  if (early !== 'running') {
    await run.stop();
    const hint = errors.split(/\r?\n/).map(l => l.trim()).filter(Boolean).pop()?.replace(/(?:[A-Za-z]:\\|\/)[^\s'"]+/g, '…').slice(0, 160);
    throw new Error(`The browser stopped at start-up${hint ? `: ${hint}` : '.'}`);
  }
  child.stderr!.resume();
  return run;
}
