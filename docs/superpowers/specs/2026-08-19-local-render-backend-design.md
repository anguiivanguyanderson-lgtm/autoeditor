# Local render backend — design

## Problem

Rendering runs in-browser via single-threaded `ffmpeg.wasm` (`lib/ffmpegRender.js`), so
an 8-minute video takes 10+ minutes and can crash on mobile. Native ffmpeg on the user's
own machine (all cores, hardware-capable) renders the same job in a fraction of the time.

## Goal

Move rendering to a **local backend** that runs on the user's own machine. The browser
frontend POSTs the assets + a render spec to `http://localhost`, a Node service renders
with **native ffmpeg** (bundled, no install), streams progress back, and returns the MP4.
A batch file starts both projects so the user just runs one file.

Decided during brainstorming:

- **Local backend** on the user's machine (localhost). No cloud, no auth, no object
  storage, no queue (single user, one render at a time).
- **Bundled static ffmpeg** via `ffmpeg-static` — nothing to install but Node.
- **Replace** the in-browser render entirely with the server render.
- **Send the asset bytes** over localhost (the browser cannot expose file paths); this is
  a loopback transfer, effectively instant.

## Architecture

```
user PC
 ┌─────────────────────────┐        multipart POST (spec + audio + images)
 │ browser  (Next.js :3000) │ ───────────────────────────────────────────►┐
 │   lib/serverRender.js    │ ◄──────── SSE progress ──────────────────────┤
 │                          │ ◄──────── GET .../file (MP4 blob) ───────────┤
 └─────────────────────────┘                                              │
                                         ┌────────────────────────────────▼─┐
                                         │ Node + Express  (:4000)           │
                                         │   spawn native ffmpeg (ffmpeg-    │
                                         │   static) in a temp job dir       │
                                         └───────────────────────────────────┘
 start.bat: install deps if missing → start backend → build+start frontend → open browser
```

## Project structure

```
story-to-video/
  (existing Next.js frontend)
  lib/serverRender.js         # NEW — talks to the backend (replaces ffmpegRender usage)
  start.bat                   # NEW — launcher
  server/                     # NEW backend project (own package.json)
    package.json              # express, cors, multer, ffmpeg-static
    index.js                  # express app, routes, in-memory job store
    render.js                 # native ffmpeg port (plan builder + spawn + progress)
    captions.js               # copied caption-burn helpers (render-side only)
    transitions.js            # xfade name map (render-side only)
    assets/caption.ttf        # copy of public/fonts/caption.ttf
    tmp/                       # per-job temp dirs (gitignored)
```

## Part 1 — Backend render service (`server/`)

### Dependencies
`express`, `cors`, `multer` (multipart), `ffmpeg-static` (bundled binary path).

### The render spec (API contract)
The same object shape the current `renderVideo(opts)` receives, minus the File objects:

```json
{
  "clips":   [{ "name": "s3", "start": 0, "duration": 5, "gap": false }],
  "width": 1920, "height": 1080, "fps": 30,
  "transitions": ["cut", "fade", "wipeleft"],
  "transitionDuration": 0.4,
  "fadeIn": 0.5, "fadeOut": 0.6,
  "captions": [{ "start": 0, "end": 3, "text": "..." }],
  "captionStyle": "classic", "captionSize": "md"
}
```

Images are uploaded as multipart fields **keyed by clip name** (`s3` → the file); audio as
field `audio`; the spec as a JSON string field `spec`.

### `render.js` — native ffmpeg port
A faithful port of `lib/ffmpegRender.js`. **The filter strings are identical** — only the
FS and process handling change:

- `buildRenderPlan(spec, paths)` — **pure**, returns `{ args, total, mode }`, where `args`
  is the ffmpeg argument array. Mirrors the existing `renderConcat` (concat demuxer, no
  transitions) vs `renderGraph` (xfade filter-complex) split, `vfChain`, `fadeVideo`/
  `fadeAudio`, and the caption `drawtext` chain. `paths` maps clip name → on-disk image
  path (and the audio path, black.png path, caption files). This is the unit-tested core.
- `writeInputs(dir, spec, files)` — writes each uploaded image, the audio, the caption
  font (`assets/caption.ttf` → `caption.ttf`) and per-line caption textfiles, the
  `concat.txt` (concat mode), and generates `black.png` for gap clips via
  `ffmpeg -f lavfi -i color=c=black:s=WxH -frames:v 1 black.png` when any gap exists.
- `runRender(dir, args, total, onProgress)` — `spawn(ffmpegStatic, [...args, "-progress",
  "pipe:1", "-nostats"], { cwd: dir })`; parse `out_time_us`/`out_time_ms` from stdout to
  compute `progress = min(1, outSeconds / total)`; resolve with the output path on exit 0,
  reject on non-zero. Returns the child process so it can be killed for cancel.

Notes on the port:
- ffmpeg runs with `cwd` = the job temp dir, so relative names (`caption.ttf`, `capN.txt`,
  `concat.txt`, image files) resolve exactly as the WASM virtual-FS version expected.
- `captions.js` (copied) exposes `buildCaptionBurn(cues, styleId, width, height, sizeId)`
  and `CAPTION_FONT` verbatim from `lib/captions.js` (only the render-side helpers; the
  transcript parsers stay in the frontend since cues arrive pre-parsed in the spec).
- `transitions.js` (copied) exposes the id → `xfade` name map + `MIN/MAX_TRANSITION_DURATION`.

### `index.js` — Express app + job store
In-memory `Map<jobId, { dir, proc, total, progress, status, outPath, listeners }>`.

- `GET  /health` → `{ ok: true }` (frontend liveness check).
- `POST /render` (multer `.any()`) → write a new temp job dir, `buildRenderPlan` +
  `writeInputs` + `runRender`, store the job, return `{ jobId }` immediately.
- `GET  /render/:id/events` (SSE) → push `{ progress }` events; on completion push
  `{ done: true }`, on failure `{ error }`, then close.
- `GET  /render/:id/file` → stream `output.mp4` (`Content-Type: video/mp4`).
- `POST /render/:id/cancel` → `proc.kill()`, mark cancelled, cleanup dir.
- Cleanup: remove a job's temp dir after the file is downloaded or on cancel; a safety
  sweep removes stale dirs on startup.
- **CORS**: allow `http://localhost:3000`.
- **Port**: `4000` (constant; overridable via `PORT`).

### Backend testing
Vitest in `server/`; unit-test `buildRenderPlan`:
- concat mode when all transitions are `cut` (uses `-f concat`, `-shortest`);
- graph mode when any non-cut transition exists (uses `xfade=...:offset=<clip.start>`);
- `total` equals the last clip's `start + duration`;
- fades appear in `-vf`/`-af` when `fadeIn/fadeOut > 0`;
- caption `drawtext` present when captions are provided.

## Part 2 — Frontend integration

### `lib/serverRender.js`
Exports the **same names and signature** as `lib/ffmpegRender.js` so `app/page.js` changes
only its import source:

- `renderVideo(opts)` — build `FormData` (`spec` JSON + `audio` + one field per image keyed
  by clip name from `opts.imagesByName`), `POST` to `${BASE}/render`, open an
  `EventSource` on `/render/:id/events` calling `opts.onProgress(fraction)`, then
  `fetch` `/render/:id/file` and return the `Blob`.
- `cancelRender()` — `POST /render/:id/cancel` for the in-flight job and close the SSE.
- `BASE = process.env.NEXT_PUBLIC_RENDER_URL || "http://localhost:4000"`.

### `app/page.js`
- Change the render import from `../lib/ffmpegRender` to `../lib/serverRender` (names
  unchanged: `renderVideo`, `cancelRender`).
- `onRender` already passes `clips` (trimmed), `imagesByName`, `audioFile`, `dims`, `fps`,
  `transitions`, `transitionDuration`, `fadeIn/Out`, `captions`, `captionStyle/Size`,
  `onProgress` — all forwarded as-is. No other logic change.
- Error surface: if the backend is unreachable the `fetch`/SSE rejects and the existing
  `setError` path shows the message ("Render server not reachable — is it running?").
- Delete `lib/ffmpegRender.js` (now unused). The `@ffmpeg/*` dependencies and
  `public/ffmpeg/*` become dead weight and can be pruned in a follow-up; not required for
  correctness.

## Part 3 — Launcher (`start.bat`, Windows) with bundled Node

The distributable is **fully self-contained** — no Node install, no npm at runtime, no
internet. A portable `node.exe` is shipped in the folder and the batch references it by
full path.

### Distributable layout (prepared once, then zipped and shipped)
```
StoryToVideo/
  runtime/node.exe            # portable Node for Windows x64 (~50–80 MB)
  start.bat
  frontend/                   # Next.js standalone build output
    .next/standalone/server.js
    .next/static/ ...
    public/ ...
  server/                     # backend with its node_modules (incl. ffmpeg-static)
    index.js  render.js  captions.js  transitions.js  assets/caption.ttf
    node_modules/ ...
```

### Build-time preparation (developer machine, done once)
- Frontend: set `output: 'standalone'` in `next.config`, run the production build, and copy
  `.next/standalone`, `.next/static`, and `public` into the distributable `frontend/`.
- Backend: `npm install` in `server/` so its `node_modules` (incl. `ffmpeg-static`) ships.
- Drop the Windows x64 `node.exe` into `runtime/`.

### `start.bat` (runtime — no npm, no network)
- `cd /d %~dp0`, set `NODE=%~dp0runtime\node.exe`.
- Start backend in its own window: `%NODE% server\index.js`.
- Start frontend in its own window: `%NODE% frontend\.next\standalone\server.js`
  (with `PORT=3000` and the standalone server's expected working dir).
- Wait briefly, then `start http://localhost:3000`.

`node.exe` alone suffices because all dependencies are pre-bundled and the frontend is a
standalone build — npm is never invoked at runtime. `ffmpeg-static` provides ffmpeg.

**Prerequisite: none** (Windows x64). A developer-side "build the distributable" script
(prepares `frontend/`, `server/node_modules`, and copies `node.exe`) is part of this part.

## Data flow (per render)

```
page.onRender → serverRender.renderVideo(opts)
  → FormData(spec + audio + images) → POST /render → { jobId }
  → EventSource /render/:id/events → onProgress(fraction) … until { done }
  → GET /render/:id/file → Blob → URL.createObjectURL → existing "Download MP4"
server: writeInputs → buildRenderPlan → spawn native ffmpeg (cwd=jobdir)
      → parse -progress → emit SSE → on exit 0, expose output.mp4 → cleanup after download
```

## Edge cases

- **Backend not running:** frontend render fails fast with a clear error (we replaced the
  in-browser path, so there is no local fallback — expected, since the batch file starts
  both).
- **Cancel mid-render:** `proc.kill()` stops ffmpeg; the SSE closes; temp dir removed. The
  frontend `onCancel` calls `cancelRender()` exactly as today.
- **Gap clips:** `black.png` generated once per job when any gap exists (native lavfi),
  used in both concat and graph modes like the WASM version.
- **Captions:** cues are parsed in the frontend and sent in the spec; the server only burns
  them (`buildCaptionBurn`), so behavior matches the preview.
- **Filename collisions / weird names:** images are written under deterministic names
  derived from the clip index/extension (not the user filename), avoiding path issues.
- **Concurrent renders:** single user; a second `POST /render` while one runs simply starts
  another job dir. No queue; acceptable for local use.

## Testing

- **Unit (server):** `buildRenderPlan` cases above (Vitest in `server/`).
- **Manual:** run `start.bat`; import audio + images; render an 8-minute project; confirm it
  finishes in minutes (not 10+), progress streams smoothly, transitions/fades/captions match
  the preview, cancel works mid-render, and the downloaded MP4 plays.

## Out of scope (YAGNI)

- Cloud hosting, auth, object storage, job queue, multi-user scaling.
- Hardware-encoder selection (NVENC/QSV) — native x264 first; can add later.
- Desktop-app packaging (Electron/Tauri) and path-based (no-upload) transfer.
- Pruning the now-unused `@ffmpeg/*` deps and `public/ffmpeg/*` (follow-up cleanup).
- Non-Windows launchers (`.sh`) — Windows `.bat` first.
