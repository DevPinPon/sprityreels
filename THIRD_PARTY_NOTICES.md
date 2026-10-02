# Third-party notices

## The reel toolkit

Sprity Reels turns long videos into reels. `npm run setup:clips` installs these files (sizes and SHA-256 pinned in `scripts/setup-clip-tools.mjs`):

- **yt-dlp 2026.08.19** (`.sprityreels/tools/yt-dlp/yt-dlp.exe`), from github.com/yt-dlp/yt-dlp. Released into the public domain under the Unlicense. The Windows executable bundles Python and third-party components under their own licenses, listed by the yt-dlp project. Sprity Reels runs it with `--ignore-config`, without cookies or sign-in, and with the URL after `--`.
- **whisper.cpp build b5130, CUDA 11.8** (`.sprityreels/tools/whisper/b5130/`), from github.com/ggml-org/whisper.cpp. Copyright The ggml authors. MIT License. The archive includes NVIDIA CUDA runtime components redistributed under NVIDIA's CUDA EULA.
- **Whisper large-v3-turbo, q5_0 GGML conversion** (`.sprityreels/tools/whisper/models/ggml-large-v3-turbo-q5_0.bin`), from huggingface.co/ggerganov/whisper.cpp. The Whisper weights are Copyright OpenAI, MIT License.
- **@mediapipe/tasks-vision 1.0.1** (npm), the JavaScript and WebAssembly runtime. Copyright The MediaPipe Authors. Apache License 2.0.
- **MediaPipe Face Landmarker** (`public/mediapipe/face_landmarker.task`), from storage.googleapis.com/mediapipe-models. Copyright Google LLC. Apache License 2.0; the text is in `public/mediapipe/LICENSE-2.0.txt`. Used only to frame the talking person, never for identity recognition.
- **MediaPipe EfficientDet-Lite0 object detector** (`public/mediapipe/efficientdet_lite0.tflite`, float16, COCO labels), from storage.googleapis.com/mediapipe-models. Copyright Google LLC / the TensorFlow Authors. Apache License 2.0; the text is in `public/mediapipe/LICENSE-2.0.txt`. Used only to keep a person, ball, vehicle or animal in a vertical crop, never for identity recognition.
- **Caption fonts** (`public/fonts/clips/`), from github.com/google/fonts. Licensed under the SIL Open Font License 1.1; each font's license ships beside it as `OFL-<Family>.txt`:
  - Poppins (Bold, ExtraBold, Black), Copyright 2020 The Poppins Project Authors.
  - Anton, Copyright 2020 The Anton Project Authors.
  - Bebas Neue, Copyright © 2010 by Dharma Type.
  - Archivo Black, Copyright 2017 The Archivo Black Project Authors.
  - Bangers, Copyright 2010 The Bangers Project Authors.
  - Lilita One, Copyright 2011 Juan Montoreano.
- **Rinegan** (npm `sprity`, github.com/DevPinPon/rinegan), `src/evidence-selection.ts` and `src/evidence.ts`, adapted in `server/evidence/keyframes.ts` and `server/evidence/scan.ts`. Copyright (c) 2026 Sprity contributors. MIT License: permission is granted, free of charge, to use, copy, modify, merge, publish, distribute, sublicense and sell copies of the software, provided this copyright notice and the permission notice are included in all copies or substantial portions of it. The software is provided "as is", without warranty of any kind.
- **FFmpeg** is not bundled. It is called as a program from the PATH and has its own license (LGPL or GPL, depending on the build you install).

## The website

- **Sora** and **Inter** (variable fonts, through the `@fontsource-variable` npm packages). SIL Open Font License 1.1.
- **lucide-react** (icons), ISC License. **React**, **fflate** and **Vite**, MIT License. **sharp**, Apache License 2.0. **@anthropic-ai/sdk** (the official Anthropic SDK), MIT License.

## Use of other people's videos

Optional AI ranking uses Anthropic's Claude API and/or Google's Gemini API with the operator's own API key, under Anthropic's and Google's terms. Claude receives the transcript and contact sheets of frames of the video; they are sent from memory and are not stored by Sprity Reels. Imported videos belong to their creators. Sprity Reels records each visitor's stated rights basis and adds attribution to reels made from other people's content, and the visitor remains responsible for how they use that content. An operator who runs Sprity Reels for others should say in their own terms and privacy policy that faces and objects in uploaded videos are detected, on the server, only to frame the reels.
