# Sprity Reels

Turn long videos into scroll-stopping vertical reels. Paste a link or drop a file, and Sprity Reels finds the best moments, repairs each one so it stands alone, frames it with a camera that follows the action, adds word-accurate captions and hands you ready-to-post MP4s.

This project is a website around the reel engine that was built as **Clip Studio** inside RigEasy. The engine and server code were copied here; RigEasy itself was not touched.

## What is in it

- **The website** (`src/site/`): a landing page, and a guided studio in four steps: *Add video → Find moments → Pick moments → Get reels*. React 19 and Vite, dark glass design, no UI framework.
- **The reel engine** (`src/engine/clips/`, `server/clips/`): ranking of moments from the words, the sound and the picture; boundary repair; face, object and motion tracking for the camera; per-shot layouts; eight caption styles; swear-word bleeping; loudness; export kits. See `docs/CLIP_STUDIO.md` for how it works.
- **The server** (`server/`): one Node process that serves the site and the API, gives every visitor a private workspace, and guards what a public site must guard (below).

- **Many visitors, cheaply** (`server/scheduler.ts`, `docs/SERVING.md`): one fair scheduler for the machine, admission control, retention, quotas and AI budgets, cheap polling and downloads, metrics for autoscaling.
- **The picture scan and the frame vault** (`server/evidence/`): the CPU-and-RAM keyframe engine of Rinegan (scene changes, near-duplicate removal, a storyboard of the frames that matter) and the rule that every frame the server takes is deleted when the reels are delivered (below).

Not part of this project: RigEasy's character, rigging and story features, its MCP server, and the Codex and Claude Code connections (they rely on a person's own local sign-in, which a hosted service does not have). The seat they filled is taken by Claude through the Anthropic API.

## Run it on your own computer (Windows)

You need Node 22, FFmpeg 6 or newer with libass on the PATH, and Chrome or Edge.

```powershell
npm install
npm run setup:clips     # yt-dlp, whisper.cpp with its model, the MediaPipe models and the caption fonts (about 0.9 GB, checksum-verified)
npm run dev             # http://127.0.0.1:3000
```

`npm run dev` serves the site with hot reload. `npm run build` and `npm start` serve the production build from `dist/`.

**How fast is this computer?** `npm run bench -- "D:\Videos\talk.mp4"` runs the whole pipeline on a 10-minute version of that video and prints the time of every stage, and what a faster graphics card would change. It also shows whether speech recognition ran on the card or the CPU. See `docs/SPEED.md`.

On macOS or Linux, `npm run setup:clips` fetches the models and fonts only. Install `yt-dlp`, `ffmpeg` and `whisper.cpp` (`whisper-cli` and a `ggml-large-v3-turbo-q5_0.bin` model) yourself and point to them in `.env` (see `.env.example`).

## Run it as a service

1. Install Node 22, FFmpeg 6+ with libass, Chromium, yt-dlp and whisper.cpp on the server. Set `SPRITYREELS_YTDLP`, `SPRITYREELS_WHISPER_CLI`, `SPRITYREELS_WHISPER_MODEL` and `SPRITYREELS_BROWSER` where they are not on the PATH.
2. `npm ci && npm run build && npm start` with `HOST=0.0.0.0`, behind a reverse proxy that terminates HTTPS. Set `SPRITYREELS_SECURE_COOKIES=1`. If the proxy rewrites the `Host` header, list the public origin in `SPRITYREELS_ORIGINS`.
3. Let uploads through the proxy: raise its body-size limit to at least `SPRITYREELS_MAX_UPLOAD_MB` and turn off request buffering.
4. Keep `SPRITYREELS_DATA` (default `.sprityreels/data`) on a disk with room for uploads and renders.
5. For many visitors at once, read `docs/SERVING.md` first: where the money goes, the settings that keep it small (retention, quotas, AI budgets, slots) and a load-test script. Set a retention time with `SPRITYREELS_RETENTION_HOURS` for a public site.
6. Set `ANTHROPIC_API_KEY` to offer AI-ranked picks by Claude, which also looks at frames of the video, and/or `GEMINI_API_KEY` for Gemini (transcript only). Without a key the automatic picks still work.

The face and subject tracker runs in a headless Chromium on the server. As root (a container) it starts with `--no-sandbox`, so keep the container itself isolated. Without graphics hardware it uses MediaPipe's CPU delegate, which is much faster than an emulated GPU.

### How the site protects itself

- **Private workspaces.** A cookie names each visitor's workspace; every request is answered by that visitor's own service, so nobody sees another visitor's videos.
- **No cross-site requests.** Writes need a custom header, and the `Origin` and `Sec-Fetch-Site` of every request must match the site.
- **Links.** Pasted links must come from a known video site (`SPRITYREELS_LINK_HOSTS`) and every address the host resolves to must be public. Nothing points yt-dlp at the server's own network.
- **The tracker page** is opened by the server itself and proves it with a key made at start-up, from a loopback address.
- **Uploads** are refused above `SPRITYREELS_MAX_UPLOAD_MB`, before the body is stored, and above what is left of a visitor's share of the disk (`SPRITYREELS_MAX_WORKSPACE_MB`).
- **One machine, shared fairly.** Every visitor's work waits its turn in shared lanes sized to the machine (`server/scheduler.ts`); a busy machine answers 503 with `Retry-After` instead of piling up work, and the studio shows each visitor their place in the line.
- **AI spend** is rationed per visitor per hour (`SPRITYREELS_AI_PER_HOUR`) and, when you set them, per visitor and per day in dollars (`SPRITYREELS_AI_USD_PER_VISITOR_DAY`, `SPRITYREELS_AI_USD_PER_DAY`). API keys, costs and file paths never reach the browser.
- **Headers.** A strict Content-Security-Policy, `nosniff`, no framing.

### Frames: kept in memory, deleted when your reels are delivered

Rinegan works on the CPU and in RAM, and so does this site. Every frame the server takes from a video is short-lived, and the rule is enforced in one place, the **frame vault** (`<data>/frames`).

- **Memory first.** The picture scan (FFmpeg decodes, shrinks each sampled frame to 64×64 grey, and the server reads it from FFmpeg's output into RAM) and the contact sheets for the AI picker never touch the disk. Claude receives its sheets from memory, so for an AI pick no frame is written anywhere at any point; the tests list the server's files while the model is reading them.
- **Files only where a step cannot avoid them.** The face tracker's browser reads its frames over HTTP, and a command-line model reads image paths. Those frames go in a private folder (a *lease*) of the vault.
- **Deleted when the step ends** (finished, failed or cancelled), **before a job is reported done** (a reel is marked ready only after its frames are gone), **when a reel or video is deleted**, **after `SPRITYREELS_FRAME_TTL_MIN` minutes** (default 120) in case something hung, **when the server starts** (anything a crash left behind) and **when it stops**.
- The vault only ever empties a folder that carries its own marker file, so a mistyped path cannot wipe other data.
- What stays after a video is analysed is numbers, not pictures: `evidence.json` holds scene times, 128-bit hashes and change scores. The video, the reels and their cover images stay in the visitor's workspace until the visitor deletes them.

### What is not built yet

Accounts and billing, a job queue to spread renders over several machines (one machine is shared fairly between visitors now), per-IP rate limits (put them in the proxy), and a terms and privacy page. Visitors' files are deleted after a retention time only when you set one. Commentary shorts (the AI voiceover mode) exist in the engine and the API but have no screen yet. Link import needs yt-dlp and network access and has not been exercised against live sites from this repository's tests.

## Where AI is used

| Step | What does it | Cost |
|---|---|---|
| Speech to text, word by word | whisper.cpp large-v3-turbo on the server | none per video |
| Ranking the moments | the local engine (rules, loudness, replay heat, motion); optionally Claude Opus 5.5 (transcript and frames) or Gemini 3.8 Flash (transcript) | none; about a cent or two per long video with Gemini; Claude is billed per token (list price $4 / $20 per million tokens in/out, plus a few thousand tokens per contact sheet) |
| Seeing the picture | on-server motion measurement and Rinegan's keyframe scan (scene changes, near-duplicates, storyboard), plus MediaPipe face and object detection | none |
| Assembling the reel | FFmpeg: cuts, crops, captions, loudness | none |

A generative video model is not part of assembly: a reel is the speaker's real footage, cut and framed. **Claude** is the director that sees: `ANTHROPIC_API_KEY` turns it on, `SPRITYREELS_CLAUDE_MODEL` changes the model (default `claude-opus-5-5`; `claude-sonnet-5-5` is half the price, so compare their picks on your own videos before switching) and `SPRITYREELS_CLAUDE_EFFORT` how hard it thinks (default `medium`). The request uses the official Anthropic SDK, structured outputs for the JSON answer, and the API's server-side fallback so a request a safety classifier declines is retried on Anthropic's recommended model. Another model can join the ranking step by implementing `TextDirector` in `server/directors.ts` and passing it as `service.directors`.

## Commands

| | |
|---|---|
| `npm run dev` | Site with hot reload on `PORT` (3000) |
| `npm run build` | Typecheck, build `dist/`, and compress its text files ahead of time |
| `npm start` | Serve the build |
| `npm run typecheck` | Client and server |
| `npm test` | the engine, real FFmpeg renders, the frame vault and keyframe scan, and the website API on a real HTTP server |
| `npm run setup:clips` | Install the pinned tools, models and fonts |
| `npm run bench -- <video>` | Time the whole pipeline on this computer for a 10-minute video, stage by stage |
| `node scripts/loadtest.mjs <url> 200 20` | 200 virtual visitors for 20 seconds: requests per second, latency, 304s |

## Layout

```
src/site/            landing page and studio (React)
src/styles/          design system and page styles
src/engine/clips/    ranking, repair, tracking, captions, camera planning (shared by the browser and the server)
server/              app.ts (visitors and guards), start.ts (one port), scheduler.ts (fair lanes for the whole machine), links.ts, browser.ts, directors.ts (Claude), support.ts
server/evidence/     the frame vault, the RAM-only picture scan and Rinegan's keyframe selection
server/clips/        the reel service: import, moments, render, export
public/              caption fonts, MediaPipe models
tests/               engine, render, scheduling, limits and website tests
scripts/             setup-clip-tools.mjs, precompress.mjs (runs after the build), loadtest.mjs (how many visitors can this server look after?)
docs/                CLIP_STUDIO.md (the engine), SERVING.md (many visitors: cost, capacity, settings)
```

## Where the code came from

`src/engine/clips/` and `server/clips/` were copied from RigEasy's Clip Studio and renamed (`.rigeasy` to `.sprityreels`, `RIGEASY_*` to `SPRITYREELS_*`, file formats and messages). Changes beyond the rename: the request layer (`server/clips/bridge.ts`, `server/app.ts`) is new; `server/browser.ts` starts as root and reports a browser that dies at start-up; `src/engine/clips/delegate.ts` picks the CPU delegate without graphics hardware; `src/components/ClipWorker.tsx` sends the tracker key.

`server/evidence/keyframes.ts` is adapted from **Rinegan** (npm `sprity`, MIT), `src/evidence-selection.ts` and `src/evidence.ts`: the keyframe selector, the perceptual hash, the change score, the scene and transient rules, and the rule that a frame's time must be matched by FFmpeg's own log before it is trusted. What changed: signals come from a sparse sample of a long video (keyframes only past five minutes, at most 2,048 frames, 8 MiB of pixels) instead of every frame of a short recording, the scene threshold adapts to that spacing, a storyboard is picked window by window so a busy stretch cannot use all the frames, and nothing is written to disk. Rinegan's sprite toolkit (video to sprite sheets, slicing, Unity export, interpolation) and its memory and MCP layers are not part of this site: they do not make reels.

See `THIRD_PARTY_NOTICES.md` for the licenses of the tools, models and fonts.
