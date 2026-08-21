# AutoEditor render backend

Local Node service that renders the timeline with native, bundled ffmpeg
(`ffmpeg-static`) and serves the built frontend. The browser POSTs the assets and
a render spec; progress streams back over SSE; the finished MP4 is downloaded.

## Endpoints

- `GET  /health` — `{ ok: true }`.
- `POST /render` — multipart: `spec` (JSON), `audio` (file), one image file per clip
  keyed by the clip name. Returns `{ jobId }`.
- `GET  /render/:id/events` — SSE stream of `{ progress }`, then `{ done: true }` or
  `{ error }`.
- `GET  /render/:id/file` — the finished `output.mp4`.
- `POST /render/:id/cancel` — kills the render and cleans up.

The service also serves the frontend's static export (`../out`) at `/`, so in the
shipped app the UI and the API share one origin and one port.

## Render spec

```json
{
  "clips": [{ "name": "s3", "start": 0, "duration": 5, "gap": false }],
  "width": 1920, "height": 1080, "fps": 30,
  "transitions": ["cut", "fade"],
  "transitionDuration": 0.4,
  "fadeIn": 0.5, "fadeOut": 0.6,
  "captions": [{ "start": 0, "end": 3, "text": "..." }],
  "captionStyle": "classic", "captionSize": "md"
}
```

`render.js` is a native port of the frontend's `lib/ffmpegRender.js`; the ffmpeg
filter strings are identical, so output matches the in-app preview.

## Run

- Production (backend serves the built UI): `npm start`, then open
  `http://localhost:4000`.
- Port / origin overrides: `PORT`, `FRONTEND_ORIGIN`, `FRONTEND_DIR`.
- Tests: `npm test` (unit tests for `buildRenderPlan`).

## Config

- `PORT` — listen port (default `4000`).
- `FRONTEND_DIR` — static UI directory (default `../out`).
- `FRONTEND_ORIGIN` — CORS origin for dev when the frontend runs separately
  (default `http://localhost:3000`).
