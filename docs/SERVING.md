# Running Sprity Reels for many people at once, cheaply

This is the guide for an operator who expects many visitors at the same time. It says where the money goes, what the server now does to keep that bill small, which settings to turn, and what is still missing. Numbers marked **measured** were taken on a 4-vCPU sandbox with FFmpeg 6.1 while writing this guide (test videos made with FFmpeg's own generators, so treat them as shapes, not promises). Numbers marked **repo** come from `docs/CLIP_STUDIO.md`, **list** are published list prices, and **estimate** are my assumptions: replace those with your own.

## The short version

1. **Speech recognition is the bill.** On a CPU-only machine it is roughly 85 to 90 percent of the compute for a video (about 190 core-minutes per hour of video at 5x real time on 16 threads, **repo**). One NVIDIA GPU runs it 30 to 60 times faster than real time (**repo**), so one GPU box does the work of many CPU boxes. Everything else together is about 15 to 40 core-minutes per hour of video, depending on the footage.
2. **Queue the peaks, do not buy for them.** All visitors now share one fair scheduler with fixed slots per kind of work. A small machine that makes people wait a little at 9 pm is far cheaper than one sized for 9 pm, and the studio shows each visitor their place in line instead of a frozen bar.
3. **The AI can cost more than the compute.** Claude Opus 5.5 ranking a one-hour podcast is an estimated 10 to 40 cents; Gemini 3.8 Flash about 2 cents; the automatic picks are free. Give free visitors the automatic and Gemini picks, and cap AI spend per visitor and per day.
4. **Storage grows forever unless something deletes it.** Set a retention time and a per-visitor quota.
5. **Polling and downloads were quietly expensive.** Fixed, with numbers below.

## Where the money goes, per hour of source video (about five 45-second reels)

| Step | CPU-only server | Server with one NVIDIA GPU | Source |
|---|---|---|---|
| Speech to text (whisper large-v3-turbo q5_0) | about 12 minutes of a 16-core machine (192 core-minutes) | 1 to 2 minutes of the GPU | repo (5x and 30-60x real time) |
| Picture pass at import (upload, 1080p30; a link uses a 240p copy, about a tenth of this). Skipped for videos that are mostly speech | 9 to 22 core-minutes (28x real time on 4 cores for clean footage; 11x for a noisy 8 Mbps 1080p file) | same | measured |
| Scene scan for a vision pick (keyframes only past 5 minutes) | 1 to 6 core-minutes (1.3 s for 5 minutes of 1080p30 with a keyframe every 8 s; 13.9 s for 10 minutes of 8 Mbps video with one every 2 s, which is what video sites use; 11 s for 5 minutes if every frame is decoded) | same | measured |
| Face and subject tracking | a browser start-up of a few seconds plus the models per reel; two 12 s reels took about 33 s longer with tracking than without | same | measured (rough) |
| Render, x264 `veryfast` CRF 21 (the new default) | 4.8 core-minutes (16 s on 4 cores for 50 s of 1080x1920) | NVENC: close to nothing | measured |
| Render at the old default, `medium` CRF 19 | 10.2 core-minutes, and 30% larger files | same | measured |
| AI ranking, Claude Opus 5.5 | 20 to 40 thousand input and a few thousand output and thinking tokens: about $0.10 to $0.40 at $4 and $20 per million tokens | same | list + estimate |
| AI ranking, Claude Sonnet 5.5 | half of that ($2 and $10 per million) | same | list + estimate |
| AI ranking, Gemini 3.8 Flash | about $0.02 | same | repo |
| Storage | the upload (often 2 to 4 GB for a 1080p hour) plus about 10 MB per reel | same | estimate |
| Egress | each reel is played or downloaded one to a few times, 6 to 12 MB each | same | estimate |

Reading it: on CPU the transcript step is five to ten times everything else, so the first question for a service is whether it has a GPU. With a GPU the remaining costs are the picture pass, tracking and the AI, and the AI is usually the largest.

## What the server now does

### One fair scheduler for the whole machine (`server/scheduler.ts`)

Every step that needs a worker (downloads, quick decoding, speech recognition, AI calls, renders, tracking, picture scans) takes a slot in a shared **lane**. Slots are sized from the machine at start-up, and again once the GPU and encoder are known:

| Lane | Default slots | Why |
|---|---|---|
| `gpu` (speech recognition) | 1 (one per 16 cores on a CPU box) | one CPU run uses every core; each run gets `cores / slots` threads |
| `render` | cores / 4, or 3 with NVENC | an encode keeps about four cores busy |
| `scan` | cores / 4 | the picture pass and the scene scan decode video |
| `track` | the smallest of cores / 4, memory / 1.5 GB, 4 | each tracker is a headless Chromium (roughly 0.5 to 1 GB) |
| `prep` | cores / 2 | pulling audio out of a video must not wait behind an hour of speech |
| `net`, `ai` | 4 and 8 | waiting for a download or an answer costs nothing |

Waiting steps are served **fairly, not first come first served**: a free slot goes to the visitor with the fewest steps running in that lane, the one served longest ago on a tie. A visitor who asks for twenty reels cannot hold up one who asks for one. A job that waits shows "Waiting for a free worker. N ahead of you" in the studio.

**Admission control.** New imports and renders are refused up front with a 503 and `Retry-After` when more than `SPRITYREELS_MAX_BACKLOG` (400) steps already wait in the heavy lanes, and with a 429 when one visitor has more than `SPRITYREELS_MAX_JOBS` (60) jobs going. Nothing is stored for refused work.

What it does and does not buy (**measured**: eight 50 s encodes on 4 cores): all at once they finish together after 118 s; two at a time they finish in pairs after 30, 60, 90 and 122 s. The total is the same, since the CPU is the limit either way, but the first reels arrive after 30 s instead of 118 s, and the memory in use stays bounded (a whisper run needs roughly 1 to 2 GB and a tracker 0.5 to 1 GB, **estimate**: twenty at once is how a server runs out of memory).

`tests/crowd.test.ts` runs the whole product with twelve visitors at the same moment, each uploading a video and making a reel, on a server limited to one speech slot and two render slots (**measured**, 4 cores, 8 s test videos with a stand-in transcriber). All twelve were served in 14.5 s. No lane ever ran more than its slots (at most 1 speech run and 2 renders at once), up to 10 steps waited in a lane, the studio showed waiting visitors their place in line (174 of their polls carried one), every visitor saw only their own video and reel, and when it was over nothing was running, no frame was left, and the metrics read zero.

### Polling and downloads

The studio screen asks the server for its state while a job runs. With a hundred busy visitors that is a hundred requests a second, and each one used to read two files per reel from disk.

| | Before | After |
|---|---|---|
| 100 visitors, 20 reels each, polling as fast as the server answers (**measured**) | 202 requests/s, 6.7 ms of server CPU per request | 2,000 requests/s, 0.55 ms per request |
| The same 100 visitors on one shared workspace (62 reels before, twice as many, 122, after) | 72 requests/s, median 1.35 s | 3,993 requests/s, median 20 ms |
| 100 visitors polling every 1.5 s while nothing changes | 10.7 KB per request | a 304 for 99 of every 100 requests, 1.3 KB per request on average |
| How often a studio screen asks | every 1 s while busy, every 5 s otherwise, in any tab | every 1.5 s while busy, every 20 s otherwise, every 30 s in a background tab, at once when the tab returns |

How: every reel of a visitor is kept in memory and updated by the writes that change it; the answer for a screen is built once, serialized once, given a validator (`ETag`, a 304 when unchanged) and gzipped once; the usage ledger, which grows with every AI call, is no longer read for the screens. Reels, covers and source videos carry an `ETag`, `Last-Modified` and `If-Range` handling and `Cache-Control: private, no-cache`, so a reel that is played again, reloaded or sought in is not sent twice. The built site is compressed at build time (`scripts/precompress.mjs`): 824 KB of scripts, styles and pages become 200 KB (76% less to send). Idle connections are kept for 65 seconds so polling visitors reuse them.

### Skipping work nobody uses

The **picture pass** (motion in the video, for action picks) is read only by the ranking of action videos: gaming and sports genres, and videos with little speech (under 45% of the time). A podcast or an interview never uses it, so it is no longer run for them (the stage says "Not needed: this video is mostly speech"): no decode of the video, and no 240p download for a link. With a GPU this was the largest CPU cost left per upload, so it matters most there. A model that looks at the video (Claude) fetches the small copy of a link itself when it needs it. `SPRITYREELS_PICTURE_PASS=always` restores the old behaviour.

### Cheaper renders

Measured on a 50 s clip at 1080x1920: x264 `medium` CRF 19 took 34 s and made 16.8 MB; `veryfast` CRF 21 took 16 s and made 12.9 MB; `veryfast` CRF 23 took 15 s and made 10.1 MB. The new default is `veryfast` CRF 21: about half the CPU and a quarter less to store and send, which every social platform re-encodes anyway. The tracker looks at 8 frames a second (`SPRITYREELS_TRACK_FPS`, 2 to 15: fewer is cheaper and a little looser). Each render gets `cores / render slots` encoder threads.

### Storage and limits

* `SPRITYREELS_RETENTION_HOURS`: files are deleted this long after the visitor's last visit (checked every 10 minutes; a visitor with work running is never deleted). The studio tells the visitor. Off by default, so a local install never deletes anything; **turn it on for a public site** (72 is a reasonable start).
* `SPRITYREELS_MAX_WORKSPACE_MB`: most a visitor may keep; uploads stop at what is left, and the upload limit the studio shows shrinks with it. The share is checked when a visitor uploads: what links download and what renders write counts toward it afterwards but is not refused.
* `SPRITYREELS_MAX_MINUTES_PER_DAY`: minutes of video one visitor may import per UTC day. This is the most direct cost control there is, because transcription, the picture pass and storage all grow with video minutes (a retry of the same video is not counted twice, a refused video is not stored, and the studio tells the visitor what is left). A free tier of 30 to 60 minutes is common.
* `SPRITYREELS_MIN_FREE_GB` (default 2): uploads stop with a 503 while the data disk has less than this free, so a flood of uploads from many new visitors cannot fill it.
* `SPRITYREELS_MAX_VIDEO_MIN`: longest video (default 360). Cost grows with length, and one six-hour video is 72 minutes of a 16-core CPU for its transcript alone. 60 to 120 is typical for a free tier.
* Working frames never accumulate: see the README. `SPRITYREELS_FRAMES_DIR=/dev/shm/sprityreels-frames` keeps the few that must be files in RAM, off the disk (and off a cloud disk's I/O bill).

### AI spend

* `SPRITYREELS_AI_USD_PER_VISITOR_DAY` and `SPRITYREELS_AI_USD_PER_DAY`: at list price, per visitor and for the whole service, per UTC day. When one is reached, AI picks pause (the automatic picks never do) and the visitor is told. The service total is kept in `spend.json`, so a restart does not hand the day back. Without them the only limit is `SPRITYREELS_AI_PER_HOUR` (12): at Opus prices that is a possible $3 an hour for one visitor, so set a budget.
* `SPRITYREELS_CLAUDE_MODEL=claude-sonnet-5-5` halves the price. I would not switch without comparing picks on your own videos; the setting exists so you can.
* `SPRITYREELS_CLAUDE_CACHE=1` caches the pictures and the transcript for five minutes. The first request costs 25% more input and later ones 90% less, so it pays only if a video is asked about more than about once in five minutes: break-even is about one repeat per four first requests. It is off by default because most visitors ask once.
* Each AI pick records tokens and list-price cost in the visitor's usage ledger (`usage.jsonl`).

### Watching it

`SPRITYREELS_OPERATOR_KEY` (16 or more characters) turns on `GET /api/metrics` (header `X-Operator-Key` or `Authorization: Bearer`), in Prometheus text: `sprityreels_lane_capacity|running|waiting{lane=…}`, `sprityreels_backlog` (the number to scale on), `sprityreels_workspaces_loaded`, `sprityreels_frame_leases`, `sprityreels_ai_spend_usd_today`, `sprityreels_process_rss_bytes`. Without a key the endpoint does not exist (404), and behind a reverse proxy it does not trust "from this computer".

`node scripts/loadtest.mjs http://127.0.0.1:3000 200 20` starts 200 virtual visitors for 20 seconds and prints requests per second, latency percentiles, errors and the share of 304s. Run it against a copy of your real setup before launch.

## Sizing a machine

* **Hours of video a machine can take per hour:** speech recognition decides. CPU: about 5 on 16 cores; one GPU: 30 to 60. Add the picture pass (11 to 28x real time on 4 cores, so 1 core handles about 3 to 7 hours of 1080p video per hour) and renders (a 4-core encode lane makes about 3 seconds of reel per second).
* **Slots:** start from the defaults, watch `sprityreels_lane_waiting`, and raise a lane only if its CPU is idle while steps wait. Set them with `SPRITYREELS_CAPACITY=gpu=1,render=3,track=2,scan=2` (any lane, 1 to 64).
* **Waiting time** is roughly (steps waiting) x (time per step) / (slots). Choose `SPRITYREELS_MAX_BACKLOG` so that number stays tolerable: 400 steps behind 2 render slots at 20 s each is a wait of over an hour, which is too many.
* **Memory:** about 2 GB for the server and its caches, 1 to 2 GB per speech run, 0.5 to 1 GB per tracker, plus FFmpeg. 16 GB is comfortable for the default slots.

## Cheapest shapes, in the order I would try them

1. **One machine with an NVIDIA GPU** (a T4 or L4 class card, 8 to 16 vCPUs, 32 GB), a reverse proxy for HTTPS, `SPRITYREELS_DATA` on its disk, retention on. Whisper on the GPU and NVENC for renders (both are detected). The local engine and Gemini picks for free visitors; Claude for paid ones. This serves a lot before a second machine is needed, and it is the cheapest per hour of video.
2. **One large CPU machine** (16 to 32 cores) with a shorter maximum video length, if no GPU is available. Consider a smaller speech model for English-only content: `ggml-small.en-q5_1` is, by my estimate, three to five times faster than large-v3-turbo with lower accuracy. Test it on your content before using it.
3. **Hosted speech recognition** instead of running whisper: several providers charge per audio hour at a small fraction of a CPU server's cost. This is not built: the studio has a `transcriber` hook (used by the tests) that a hosted adapter could fill. It needs word timestamps, and it sends your visitors' audio to a third party, which is a privacy decision to make deliberately.

## Not built yet

* **More than one machine.** Jobs live in the memory of one process and files on its disk. Spreading work over several machines needs a shared queue (Redis, Postgres) and shared object storage. A restart interrupts running jobs (visitors press Retry).
* **Serving files from object storage or a CDN.** Reels and source videos are streamed by the Node process. With object storage and signed links, downloads cost the storage's egress price (or nothing, on providers with free egress) and no server CPU.
* **A cache shared between visitors** for popular public videos: the same link imported by fifty people is transcribed fifty times. Worth doing once volume shows it matters; the transcript, picture pass and scene scan are the shareable parts, and a link's rights and terms need thought first.
* **One warm tracker browser** reused across reels, instead of a new Chromium each time (a few seconds and 0.5 to 1 GB of churn per reel).
* **Splitting long transcriptions** so a three-hour video does not hold the only speech slot for 36 minutes on a CPU box; for now cap the video length.
* **Push instead of polling** (server-sent events) for progress. Polling is cheap now; push would remove the rest.
* **Accounts, plans and billing**: budgets are per anonymous visitor (a cookie) and per service. A visitor who clears cookies gets a new workspace, so per-IP limits belong in the proxy.
