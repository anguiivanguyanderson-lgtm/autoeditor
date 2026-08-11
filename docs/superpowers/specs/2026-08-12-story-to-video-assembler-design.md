# Story → Video Assembler — Design Spec

**Date:** 2026-08-12
**Status:** Approved (design), pending spec review

## Purpose

A fully client-side web app that assembles a finished **MP4** from AI-generated
images plus a single voiceover, automatically syncing each image to the narration
using **timestamp-named images**. It removes the manual step of lining up image
clips with voiceover in a video editor.

## Workflow context

1. An agent processes the master prompt and produces a story **script**.
2. The user generates a voiceover for that script and obtains a **timestamped
   transcript** (from any online tool). Timestamps are at phrase/sentence level,
   e.g. `(0:00) There was one quiet morning… (0:03) A young man sat by his window…`
3. The agent, given that timestamped script, emits the **image prompts** and names
   each image with the timestamp where it should appear, via `#name` — colon-free
   (e.g. `0-00`, `0-03`, `0-09`). Images are generated + downloaded through Flow
   Automator with those names.
4. The user uploads the voiceover + the timestamp-named images to **this site** and
   gets a finished MP4.

## Inputs (uploaded in the site)

- **Voiceover audio** — one file (mp3/wav).
- **Images** — each filename is its start timestamp, colon-free. The parser accepts
  `mm-ss` (`0-03`), `mmss` (`0003`), or plain seconds (`3`) and normalizes to seconds.
- *(Deferred)* the timestamped script — only needed if/when we add burned-in subtitles.

## Core placement engine (pure, deterministic)

- Parse each image filename → `startSeconds`.
- Sort images ascending by `startSeconds`.
- `duration[i] = start[i+1] - start[i]`; the **last** image runs to `audioDuration - start[n]`.
- Produce an ordered clip list `[{ image, start, duration }]`.
- **Validation / warnings:** duplicate timestamps, zero/negative durations, a timestamp
  beyond the audio length, unparseable filenames, non-image files (ignored).

No speech-to-text, no alignment, no guesswork — timing comes entirely from the filenames
plus the audio's total duration.

## Architecture (client-side only)

1. **Upload panel** — audio dropzone + multi-image dropzone; reads `File` objects.
2. **Filename parser/normalizer** — timestamp string → seconds; tolerant of `-`, `_`,
   `mmss`, and plain seconds.
3. **Timeline builder** — computes the clip list + durations from parsed timestamps and
   the audio duration (decoded via WebAudio or `<audio>` metadata).
4. **Preview player** — a `<canvas>` driven by an `<audio>` element: on `timeupdate`,
   draw the image whose `[start, start+duration)` contains `currentTime`. Play/pause/seek,
   and surface any validation warnings so the user catches a wrong/missing image before rendering.
5. **Render settings** — **output aspect** selector with three choices: **16:9
   (`1920×1080`, default)**, **9:16 (`1080×1920`)**, and **Auto** (match the aspect of the
   uploaded images — assumes a consistent set, as generated batches are). fps (24/30).
   **Image fit = contain** (letterbox with black pad), which only applies when an image's
   aspect differs from the chosen frame; with Auto it never letterboxes.
6. **Renderer (`ffmpeg.wasm`)** — build the MP4 from the timed image sequence + audio.
7. **Result panel** — download link + basic info (duration, size).

## Rendering detail

- Use `ffmpeg.wasm` via the **concat demuxer**: write images to the ffmpeg virtual FS,
  generate a `concat.txt` listing each `file 'img' / duration d`, then encode with
  `-vf scale+pad` to the target size, `-r fps`, `-c:v libx264 -pix_fmt yuv420p`, and mux the
  audio with `-c:a aac`, `-shortest`.
- Image fit v1: scale to fit target keeping aspect, pad with black ("contain").

## Non-goals (v1 — YAGNI)

- Transitions / crossfades (hard cut only).
- Ken Burns / zoom.
- Subtitles.
- CapCut / editable-timeline export.
- Music bed / multiple audio tracks.
- Server-side rendering.

## Tech stack

- **Next.js static export** (or a Vite SPA) — client-only, deployable to a static host.
- `@ffmpeg/ffmpeg` (`ffmpeg.wasm`) for encoding.
- No backend; fits the free / GitHub-Pages model.

## Risks / open items

- **`ffmpeg.wasm` performance** on multi-minute 1080p renders (slow, memory-heavy).
  Mitigate: single-thread build, cap resolution, show a progress bar.
- **Cross-origin isolation (COOP/COEP).** Threaded `ffmpeg.wasm` needs `SharedArrayBuffer`,
  which static hosts like GitHub Pages can't enable via headers. Mitigation: use the
  **single-threaded** ffmpeg.wasm build, or ship the `coi-serviceworker` shim to gain
  isolation on Pages. Decide during planning.
- **Audio duration retrieval** — decode via WebAudio (accurate) or `<audio>` metadata.
- **Timestamp format variance** — normalize and validate.

## Success criteria

- Upload the sample set (11 images named `0-00 … 0-34` + a ~45s narration) → correct
  synced preview → export an MP4 that plays with images changing at the right times and
  the audio intact.

## Test data

- The "wisdom story" sample (11 beats, ~110 words) + a ~45s narration of it.
