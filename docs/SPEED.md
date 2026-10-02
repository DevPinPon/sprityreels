# How fast is it, and what does a faster graphics card change?

On a PC with an NVIDIA card, a 10-minute 1080p talking video becomes five finished reels in about a minute, and the first moments are on screen after about half a minute. The card speeds up one stage, speech recognition, and a mid-range card does that almost as fast as a flagship: published speeds put an RTX 2000 Ada at 30x real time and an RTX 5090 at 53x, which is 20 seconds against 11 for ten minutes of audio. Using the card at all matters far more than which card it is: on the CPU the same stage takes two to five minutes.

How to read the numbers. **Measured** were taken while writing this on a 4-core cloud computer with no graphics card (FFmpeg 6.1; a 10-minute 1080p30, 8 Mbps H.264 file). **Recorded** come from `docs/CLIP_STUDIO.md`, measured on an RTX 2000 Ada with a Ryzen 7 7800X3D. **Published** come from RunPod's "Best GPU for Whisper" benchmark (September 2026). **Estimate** are mine. Nothing here was measured on an RTX 5080 or 5090. `npm run bench` replaces the estimates with a measurement on your own PC (below).

## Ten minutes of 1080p talking video, automatic picks, no AI ranking

All three PCs are assumed to have the same Ryzen 7 7800X3D, an NVMe disk, FFmpeg with NVENC and the whisper.cpp CUDA 12 build. Only the card differs.

| Stage | RTX 2000 Ada | RTX 5080 | RTX 5090 | Basis |
|---|---|---|---|---|
| Copy the file in, read it, pull the audio out | 4 s | 4 s | 4 s | measured 3.6 s for the audio on 4 slow cores and 10 s to copy on that machine's slow disk; estimate for this PC |
| Speech recognition (large-v3-turbo) | 23 s | 14 to 20 s | 14 s | published speed 30.4x / 35.2 to 53x / 53x, plus about 3 s to start whisper and load the model (estimate) |
| Find the moments | 1 s | 1 s | 1 s | measured |
| **Moments on screen after** | **about 28 s** | **about 20 to 25 s** | **about 19 s** | |
| Five reels: tracking, captions, render | 25 to 35 s | 25 to 35 s | 25 to 35 s | recorded: a 31 s reel rendered in 5.6 s with NVENC on the Ada PC; three renders run at once; tracking is the unmeasured part (below) |
| **Finished reels after** | **about 55 to 65 s** | **about 45 to 60 s** | **about 45 to 55 s** | about 10x real time |

A video where the picture matters (gameplay, sports) also gets the picture pass: measured at 55 s on the 4-core machine for this 8 Mbps file (about 15 to 20 s on a Ryzen 7 7800X3D, estimate). It is skipped for videos that are mostly speech. AI ranking, if switched on, adds 10 to 40 s of waiting for the model (estimate), whatever the card.

Without a working GPU build of whisper (what `docs/CLIP_STUDIO.md` records for the Ada PC: the CUDA 11.8 build did not find its cuBLAS DLLs, so it ran on the CPU) speech recognition takes two to five minutes for the same video, and everything three to six.

## What a faster card does and does not change

| Card | Speech, 10 minutes of audio | Published speed | Source |
|---|---|---|---|
| RTX 2000 Ada | 20 s | 30.4x | RunPod, faster-whisper, int8, one stream |
| RTX 4090 | 17 s | 35.2x | same |
| RTX 5080 | 11 to 17 s | not published | assumed between a 4090 and a 5090 |
| RTX 5090 | 11 s | 53.0x | same |

A 5090 is 1.74 times an RTX 2000 Ada here, although it has about eight times the shader cores and eight times the memory bandwidth (21,760 cores and 1.8 TB/s against 2,816 and 224 GB/s): transcribing one stream is limited by the many small steps of the decoder, not by how big the card is. The rest of the pipeline does not use the card for its work: decoding, the caption and crop filters and the picture pass run on the CPU, and NVENC (the card's encoder) is not the slow part of a render. A faster card therefore saves about 10 seconds on a 10-minute video, and the CPU and the disk decide most of the rest.

These ratios come from faster-whisper; this project runs whisper.cpp, which can scale differently, and the rented machines behind the published numbers have their own CPUs (a 3090 beats a 4090 in the same table). Treat any card-to-card projection as good to about 30%.

## What could not be measured here

* **Face and subject tracking on a graphics card.** The tracker uses MediaPipe's GPU delegate where the browser has real graphics hardware. On the 4-core, no-GPU machine it ran on the CPU and cost about 32 s per reel on top of the render (two 18 s reels: 97 s with tracking, 33 s without). On a GPU it should be a few seconds per reel; that is the largest uncertainty in the table above.
* **whisper.cpp on any card.** Someone reported the pinned CUDA 12.4 build and `large-v3-turbo-q5_0` model working on an RTX 5080 in [this issue](https://github.com/Yuuzulight/Mana/issues/933) (0.33 to 0.35 s for what they call a long clip; the clip lengths are not stated).
* **AI ranking time**, which depends on the model and the network.

## Measure your own PC

```powershell
npm run build
npm run bench -- "D:\Videos\talk.mp4"
```

The video must have speech in it. The check makes a 10-minute version of it (a shorter file is repeated, a longer one is cut, without re-encoding; `--minutes 5` changes the length), runs the product's own pipeline on it (upload, audio, whisper, moments, then `--reels 5` reels with tracking, captions and render, as the studio does) and prints the time of every stage. `--no-tracking` skips face following, `--json` prints the numbers for a script. It then scales the speech stage to other cards from the published ratios, so a run on an RTX 2000 Ada gives the projection for a 5090 from your own measurement instead of from a guess.

It needs the same tools as the studio (`npm run setup:clips`) and shows whether whisper ran on the card or the CPU. For the card, use the whisper.cpp CUDA 12 build (it bundles cuBLAS 12; keep `cublas64_12.dll` next to `whisper-cli.exe`) and point `SPRITYREELS_WHISPER_CLI` at it.
