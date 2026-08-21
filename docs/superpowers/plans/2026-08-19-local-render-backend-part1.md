# Local Render Backend — Part 1 (Backend Service) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans or subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A local Node + Express service (`story-to-video/server/`) that accepts a render spec + assets, renders with bundled native ffmpeg, streams progress over SSE, and returns the MP4 — a faithful port of `lib/ffmpegRender.js`.

**Architecture:** Pure `buildRenderPlan(spec, io)` builds the ffmpeg arg array (concat vs xfade-graph), mirroring the existing filtergraph exactly. `writeInputs` lays out the job temp dir; `runRender` spawns ffmpeg (`ffmpeg-static`) and parses `-progress`. `index.js` exposes `/render`, `/render/:id/events` (SSE), `/render/:id/file`, `/render/:id/cancel`, `/health`, with an in-memory job store.

**Tech Stack:** Node (ESM), Express, multer, cors, ffmpeg-static, Vitest.

---

## File Structure (all new, under `story-to-video/server/`)

- `package.json` — ESM, deps + `test`/`start` scripts.
- `transitions.js` — xfade name map + MIN/MAX transition duration.
- `captions.js` — render-side caption helpers copied verbatim from `lib/captions.js`.
- `render.js` — `buildRenderPlan` (pure), `writeInputs`, `runRender`.
- `index.js` — Express app, job store, routes.
- `render.test.js` — Vitest unit tests for `buildRenderPlan`.
- `assets/caption.ttf` — copy of `public/fonts/caption.ttf`.
- `.gitignore` — `node_modules/`, `tmp/`.

---

## Task 1: Project scaffold + copied helpers

**Files:** `server/package.json`, `server/.gitignore`, `server/transitions.js`, `server/captions.js`, `server/assets/caption.ttf`

- [ ] **Step 1: `server/package.json`**

```json
{
  "name": "story-to-video-server",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": { "start": "node index.js", "test": "vitest run" },
  "dependencies": {
    "cors": "^2.8.5",
    "express": "^4.19.2",
    "ffmpeg-static": "^5.2.0",
    "multer": "^1.4.5-lts.1"
  },
  "devDependencies": { "vitest": "^2.1.0" }
}
```

- [ ] **Step 2: `server/.gitignore`**

```
node_modules/
tmp/
```

- [ ] **Step 3: `server/transitions.js`** (xfade names mirror `lib/transitions.js`)

```js
// id -> ffmpeg xfade name (null = hard cut). Mirrors lib/transitions.js.
const XFADE = {
  cut: null, fade: "fade", fadeblack: "fadeblack",
  wipeleft: "wipeleft", wiperight: "wiperight",
  slideleft: "slideleft", slideright: "slideright",
  circleopen: "circleopen",
};
export const MIN_TRANSITION_DURATION = 0.15;
export const MAX_TRANSITION_DURATION = 1.0;
// Match the frontend: cut/unknown fall back to "fade" for the 1-frame xfade.
export function xfadeName(id) { return XFADE[id] || "fade"; }
```

- [ ] **Step 4: `server/captions.js`** — copy these exports verbatim from `lib/captions.js`: `CAPTION_STYLES`, `CAPTION_SIZES`, `CAPTION_FONT`, `captionCueFile`, `captionFontPx`, plus the module-private `MARGIN_FACTOR`, `lineTop`, and the exports `buildCaptionBurn`, `sanitizeCueText`. Do NOT copy the transcript parsers or `drawCaption` (frontend-only). The copied code must be byte-identical to the originals so burns match the preview.

- [ ] **Step 5: copy the font**

Run: `cp story-to-video/public/fonts/caption.ttf story-to-video/server/assets/caption.ttf` (create `server/assets/` first).

- [ ] **Step 6: install deps**

Run: `cd story-to-video/server && npm install`
Expected: installs express/cors/multer/ffmpeg-static/vitest with no fatal errors.

- [ ] **Step 7: Commit** — SKIP (leave uncommitted; user standing rule).

---

## Task 2: `render.js` — `buildRenderPlan` (pure) with tests (TDD)

**Files:** `server/render.js` (partial), `server/render.test.js`

- [ ] **Step 1: Write the failing tests** — `server/render.test.js`

```js
import { describe, it, expect } from "vitest";
import { buildRenderPlan } from "./render.js";

const base = {
  width: 1920, height: 1080, fps: 30,
  transitionDuration: 0.4, fadeIn: 0, fadeOut: 0,
};
const io = { paths: ["img0.png", "img1.png", "img2.png"], audioName: "audio.mp3", capChain: "" };
const clips = [
  { name: "a", start: 0, duration: 3, gap: false },
  { name: "b", start: 3, duration: 3, gap: false },
  { name: "c", start: 6, duration: 4, gap: false }, // total 10
];

describe("buildRenderPlan", () => {
  it("total is the last clip's start + duration", () => {
    const p = buildRenderPlan({ ...base, clips, transitions: ["cut", "cut", "cut"] }, io);
    expect(p.total).toBe(10);
  });

  it("uses concat mode when there are no non-cut transitions", () => {
    const p = buildRenderPlan({ ...base, clips, transitions: ["cut", "cut", "cut"] }, io);
    expect(p.mode).toBe("concat");
    expect(p.args).toContain("concat.txt");
    expect(p.args).toContain("-shortest");
    // audio is the second input
    expect(p.args.join(" ")).toContain("-i audio.mp3");
  });

  it("uses graph mode with an xfade anchored to clip.start when a transition is set", () => {
    const p = buildRenderPlan({ ...base, clips, transitions: ["cut", "fade", "wipeleft"] }, io);
    expect(p.mode).toBe("graph");
    const fc = p.args[p.args.indexOf("-filter_complex") + 1];
    expect(fc).toContain("xfade=transition=fade");
    expect(fc).toContain("xfade=transition=wipeleft");
    expect(fc).toContain("offset=3.000");
    expect(fc).toContain("offset=6.000");
    expect(p.args).toContain("output.mp4");
  });

  it("adds video+audio fades when fadeIn/fadeOut are set (concat mode)", () => {
    const p = buildRenderPlan(
      { ...base, clips, transitions: ["cut", "cut", "cut"], fadeIn: 0.5, fadeOut: 0.6 }, io
    );
    const s = p.args.join(" ");
    expect(s).toContain("fade=t=in:st=0:d=0.500");
    expect(s).toContain("fade=t=out:st=9.400:d=0.600");
    expect(s).toContain("afade=t=in");
    expect(s).toContain("afade=t=out");
  });

  it("includes the caption drawtext chain when capChain is provided (concat mode)", () => {
    const p = buildRenderPlan(
      { ...base, clips, transitions: ["cut", "cut", "cut"] },
      { ...io, capChain: "drawtext=fontfile=caption.ttf:textfile=cap0.txt" }
    );
    expect(p.args.join(" ")).toContain("drawtext=fontfile=caption.ttf");
  });
});
```

- [ ] **Step 2: Run to verify FAIL**

Run: `cd story-to-video/server && npx vitest run render.test.js`
Expected: FAIL — `buildRenderPlan is not a function`.

- [ ] **Step 3: Implement `buildRenderPlan` in `server/render.js`**

```js
import { xfadeName, MIN_TRANSITION_DURATION, MAX_TRANSITION_DURATION } from "./transitions.js";

function vfChain(width, height, fps) {
  return `scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps},format=yuv420p`;
}
function fadeVideo(fadeIn, fadeOut, total) {
  const parts = [];
  if (fadeIn > 0) parts.push(`fade=t=in:st=0:d=${fadeIn.toFixed(3)}`);
  if (fadeOut > 0) parts.push(`fade=t=out:st=${Math.max(0, total - fadeOut).toFixed(3)}:d=${fadeOut.toFixed(3)}`);
  return parts;
}
function fadeAudio(fadeIn, fadeOut, total) {
  const parts = [];
  if (fadeIn > 0) parts.push(`afade=t=in:st=0:d=${fadeIn.toFixed(3)}`);
  if (fadeOut > 0) parts.push(`afade=t=out:st=${Math.max(0, total - fadeOut).toFixed(3)}:d=${fadeOut.toFixed(3)}`);
  return parts;
}

function concatArgs({ audioName, width, height, fps, fadeIn, fadeOut, total, capChain }) {
  const vf = [vfChain(width, height, fps), ...(capChain ? [capChain] : []), ...fadeVideo(fadeIn, fadeOut, total)].join(",");
  const af = fadeAudio(fadeIn, fadeOut, total);
  const args = ["-f", "concat", "-safe", "0", "-i", "concat.txt", "-i", audioName, "-vf", vf];
  if (af.length) args.push("-af", af.join(","));
  args.push(
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
    "-c:a", "aac", "-b:a", "192k",
    "-shortest", "-movflags", "+faststart", "output.mp4",
  );
  return args;
}

function graphArgs({ clips, paths, audioName, width, height, fps, transitions, transitionDuration, fadeIn, fadeOut, total, capChain }) {
  const n = clips.length;
  const frame = 1 / fps;
  const clampT = (d) => Math.min(MAX_TRANSITION_DURATION, Math.max(MIN_TRANSITION_DURATION, d));
  const tdur = (k) => (!transitions || !transitions[k] || transitions[k] === "cut" ? frame : clampT(transitionDuration));
  const tname = (k) => xfadeName(transitions && transitions[k]);

  const inputs = [];
  const parts = [];
  for (let i = 0; i < n; i++) {
    const span = (i < n - 1 ? clips[i].duration + tdur(i + 1) : clips[i].duration) + 2 * frame;
    inputs.push("-loop", "1", "-t", span.toFixed(3), "-i", paths[i]);
    parts.push(`[${i}:v]${vfChain(width, height, fps)}[v${i}]`);
  }
  let last = "v0";
  for (let k = 1; k < n; k++) {
    const out = k === n - 1 ? "vx" : `x${k}`;
    parts.push(`[${last}][v${k}]xfade=transition=${tname(k)}:duration=${tdur(k).toFixed(3)}:offset=${clips[k].start.toFixed(3)}[${out}]`);
    last = out;
  }
  if (capChain) { parts.push(`[${last}]${capChain}[vcap]`); last = "vcap"; }
  const vf = fadeVideo(fadeIn, fadeOut, total);
  if (vf.length) { parts.push(`[${last}]${vf.join(",")}[vf]`); last = "vf"; }
  const af = fadeAudio(fadeIn, fadeOut, total);
  let amap = `${n}:a`;
  if (af.length) { parts.push(`[${n}:a]${af.join(",")}[aout]`); amap = "[aout]"; }

  return [
    ...inputs, "-i", audioName,
    "-filter_complex", parts.join(";"),
    "-map", `[${last}]`, "-map", amap,
    "-t", total.toFixed(3),
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "192k",
    "-movflags", "+faststart", "output.mp4",
  ];
}

// Pure: build the ffmpeg argument array for a render.
// spec: { clips, width, height, fps, transitions, transitionDuration, fadeIn, fadeOut }
// io:   { paths: string[] (per-clip basenames), audioName, capChain }
export function buildRenderPlan(spec, io) {
  const { clips, width, height, fps = 30, transitions, transitionDuration = 0.4, fadeIn = 0, fadeOut = 0 } = spec;
  const { paths, audioName, capChain = "" } = io;
  const total = clips.length ? clips[clips.length - 1].start + clips[clips.length - 1].duration : 0;
  const hasTransition = Array.isArray(transitions) && clips.length >= 2 &&
    transitions.some((t, i) => i > 0 && t && t !== "cut");
  const common = { clips, paths, audioName, width, height, fps, fadeIn, fadeOut, total, capChain };
  return hasTransition
    ? { mode: "graph", total, args: graphArgs({ ...common, transitions, transitionDuration }) }
    : { mode: "concat", total, args: concatArgs(common) };
}
```

- [ ] **Step 4: Run to verify PASS**

Run: `cd story-to-video/server && npx vitest run render.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit** — SKIP (leave uncommitted).

---

## Task 3: `render.js` — `writeInputs` + `runRender`

**Files:** `server/render.js` (append)

- [ ] **Step 1: Append the I/O + process functions**

```js
import { spawn, execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ffmpegStatic from "ffmpeg-static";
import { buildCaptionBurn, CAPTION_FONT } from "./captions.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FONT_SRC = path.join(__dirname, "assets", "caption.ttf");

function extOf(name) {
  const m = String(name || "").match(/\.([a-z0-9]+)$/i);
  return m ? m[1].toLowerCase() : "png";
}

// Generate a solid black frame for gap clips using ffmpeg's lavfi color source.
function makeBlack(dir, width, height) {
  return new Promise((resolve, reject) => {
    execFile(ffmpegStatic, [
      "-f", "lavfi", "-i", `color=c=black:s=${width}x${height}`,
      "-frames:v", "1", "-y", "black.png",
    ], { cwd: dir }, (err) => (err ? reject(err) : resolve()));
  });
}

// Lay out the job dir. `fileMap` maps upload fieldname -> filename already written
// into `dir` by multer (image fields keyed by clip name, plus "audio").
// Returns { paths, audioName, capChain } for buildRenderPlan.
export async function writeInputs(dir, spec, fileMap) {
  const { clips, width, height, captions, captionStyle = "classic", captionSize = "md" } = spec;

  const audioName = fileMap["audio"];
  const needBlack = clips.some((c) => c.gap);
  if (needBlack) await makeBlack(dir, width, height);

  const paths = clips.map((c) => (c.gap ? "black.png" : fileMap[c.name]));

  // Concat mode file list (only used when there are no transitions, but writing
  // it unconditionally is harmless and keeps writeInputs simple).
  let concat = "";
  for (let i = 0; i < clips.length; i++) {
    concat += `file '${paths[i]}'\nduration ${clips[i].duration}\n`;
    if (i === clips.length - 1) concat += `file '${paths[i]}'\n`;
  }
  await fs.writeFile(path.join(dir, "concat.txt"), concat);

  let capChain = "";
  if (Array.isArray(captions) && captions.length) {
    const { filter, files } = buildCaptionBurn(captions, captionStyle, width, height, captionSize);
    await fs.copyFile(FONT_SRC, path.join(dir, CAPTION_FONT));
    for (const f of files) await fs.writeFile(path.join(dir, f.name), f.text);
    capChain = filter;
  }

  return { paths, audioName, capChain };
}

// Parse ffmpeg -progress output → fraction in [0,1].
function parseProgress(chunk, total) {
  const s = chunk.toString();
  let us = null;
  const mUs = [...s.matchAll(/out_time_us=(\d+)/g)].pop();
  if (mUs) us = +mUs[1];
  else {
    const mT = [...s.matchAll(/out_time=(\d+):(\d+):(\d+(?:\.\d+)?)/g)].pop();
    if (mT) us = ((+mT[1]) * 3600 + (+mT[2]) * 60 + parseFloat(mT[3])) * 1e6;
  }
  if (us == null || !(total > 0)) return null;
  return Math.min(1, (us / 1e6) / total);
}

// Spawn native ffmpeg. Returns { proc, done } where done resolves to the output
// path on success. onProgress(fraction) is called as encoding advances.
export function runRender(dir, args, total, onProgress) {
  const proc = spawn(ffmpegStatic, [...args, "-progress", "pipe:1", "-nostats", "-y"], { cwd: dir });
  let stderr = "";
  proc.stdout.on("data", (buf) => {
    const p = parseProgress(buf, total);
    if (p != null && onProgress) onProgress(p);
  });
  proc.stderr.on("data", (d) => { stderr += d.toString(); });
  const done = new Promise((resolve, reject) => {
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve(path.join(dir, "output.mp4"));
      else reject(new Error(`ffmpeg exited ${code}\n${stderr.slice(-2000)}`));
    });
  });
  return { proc, done };
}
```

- [ ] **Step 2: Verify the module imports cleanly**

Run: `cd story-to-video/server && node -e "import('./render.js').then(m=>console.log(Object.keys(m)))"`
Expected: prints `[ 'buildRenderPlan', 'writeInputs', 'runRender' ]` (order may vary) with no import error.

Then re-run the unit tests: `npx vitest run render.test.js` → still 5 passing.

- [ ] **Step 3: Commit** — SKIP (leave uncommitted).

---

## Task 4: `index.js` — Express app, job store, routes

**Files:** `server/index.js`

- [ ] **Step 1: Write the server**

```js
import express from "express";
import cors from "cors";
import multer from "multer";
import { promises as fs } from "node:fs";
import fssync from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { buildRenderPlan, writeInputs, runRender } from "./render.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TMP = path.join(__dirname, "tmp");
const PORT = process.env.PORT || 4000;
const ORIGIN = process.env.FRONTEND_ORIGIN || "http://localhost:3000";

fssync.mkdirSync(TMP, { recursive: true });
// Startup sweep: clear any stale job dirs from a previous run.
for (const d of fssync.readdirSync(TMP)) {
  fssync.rmSync(path.join(TMP, d), { recursive: true, force: true });
}

const jobs = new Map(); // id -> { dir, proc, total, progress, status, outPath, error, listeners:Set }

const app = express();
app.use(cors({ origin: ORIGIN }));

// Per-request job dir, created before multer writes uploads into it.
function newJob(req, _res, next) {
  const id = crypto.randomUUID();
  const dir = path.join(TMP, id);
  fssync.mkdirSync(dir, { recursive: true });
  req.jobId = id;
  req.jobDir = dir;
  next();
}

const storage = multer.diskStorage({
  destination: (req, _file, cb) => cb(null, req.jobDir),
  // image fields are keyed by clip name; audio by "audio". Keep a safe basename.
  filename: (_req, file, cb) => {
    const safe = String(file.fieldname).replace(/[^a-zA-Z0-9_-]/g, "_");
    const ext = (file.originalname.match(/\.([a-z0-9]+)$/i) || [, "bin"])[1].toLowerCase();
    cb(null, `${safe}.${ext}`);
  },
});
const upload = multer({ storage });

function broadcast(job, payload) {
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of job.listeners) res.write(data);
}

app.get("/health", (_req, res) => res.json({ ok: true }));

app.post("/render", newJob, upload.any(), async (req, res) => {
  try {
    const spec = JSON.parse(req.body.spec);
    const fileMap = {};
    for (const f of req.files) fileMap[f.fieldname] = f.filename;

    const { paths, audioName, capChain } = await writeInputs(req.jobDir, spec, fileMap);
    const plan = buildRenderPlan(spec, { paths, audioName, capChain });

    const job = {
      dir: req.jobDir, proc: null, total: plan.total,
      progress: 0, status: "running", outPath: null, error: null, listeners: new Set(),
    };
    jobs.set(req.jobId, job);

    const { proc, done } = runRender(req.jobDir, plan.args, plan.total, (p) => {
      job.progress = p;
      broadcast(job, { progress: p });
    });
    job.proc = proc;

    done.then((outPath) => {
      job.status = "done"; job.outPath = outPath; job.progress = 1;
      broadcast(job, { progress: 1 });
      broadcast(job, { done: true });
      for (const r of job.listeners) r.end();
      job.listeners.clear();
    }).catch((err) => {
      if (job.status === "cancelled") return;
      job.status = "error"; job.error = String(err.message || err);
      broadcast(job, { error: job.error });
      for (const r of job.listeners) r.end();
      job.listeners.clear();
    });

    res.json({ jobId: req.jobId });
  } catch (err) {
    fssync.rmSync(req.jobDir, { recursive: true, force: true });
    res.status(400).json({ error: String(err.message || err) });
  }
});

app.get("/render/:id/events", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).end();
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.flushHeaders();
  res.write(`data: ${JSON.stringify({ progress: job.progress })}\n\n`);
  if (job.status === "done") { res.write(`data: ${JSON.stringify({ done: true })}\n\n`); return res.end(); }
  if (job.status === "error") { res.write(`data: ${JSON.stringify({ error: job.error })}\n\n`); return res.end(); }
  job.listeners.add(res);
  req.on("close", () => job.listeners.delete(res));
});

app.get("/render/:id/file", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || job.status !== "done" || !job.outPath) return res.status(404).end();
  res.sendFile(job.outPath, (err) => {
    if (!err) {
      // Clean up after the browser has the bytes.
      setTimeout(() => {
        fssync.rmSync(job.dir, { recursive: true, force: true });
        jobs.delete(req.params.id);
      }, 1000);
    }
  });
});

app.post("/render/:id/cancel", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).end();
  job.status = "cancelled";
  if (job.proc) { try { job.proc.kill("SIGKILL"); } catch { /* already gone */ } }
  for (const r of job.listeners) r.end();
  job.listeners.clear();
  fssync.rmSync(job.dir, { recursive: true, force: true });
  jobs.delete(req.params.id);
  res.json({ ok: true });
});

app.listen(PORT, () => console.log(`Render server on http://localhost:${PORT}`));
```

- [ ] **Step 2: Boot smoke test**

Run: `cd story-to-video/server && node -e "import('./index.js')" &` then `curl -s http://localhost:4000/health`
Expected: `{"ok":true}`. Stop the server afterward.

- [ ] **Step 3: Commit** — SKIP (leave uncommitted).

---

## Task 5: End-to-end render smoke test (real ffmpeg)

**Files:** none (a throwaway script; do not commit it).

- [ ] **Step 1: Drive a tiny real render**

Start the server (`node index.js`). With a throwaway script or `curl`, POST `/render` with:
- `spec` = a 2-clip timeline (`[{name:"a",start:0,duration:1,gap:false},{name:"b",start:1,duration:1,gap:false}]`, 640×360, fps 30, `transitions:["cut","fade"]`, no captions, no fades),
- two small PNGs keyed `a` and `b`,
- a short audio file keyed `audio`.

Then open `/render/:id/events` (should stream progress to `done`) and GET `/render/:id/file` (should return a playable MP4). Verify `mode` was `graph` (transition present). Repeat once with `transitions:["cut","cut"]` to exercise the concat path.

Expected: both produce a valid `output.mp4`; progress reaches 1; temp dir is cleaned after download.

- [ ] **Step 2: Final unit run**

Run: `cd story-to-video/server && npx vitest run`
Expected: PASS (5 tests).

---

## Self-Review Notes

- **Spec coverage:** scaffold + copied helpers (Task 1) ↔ spec "Dependencies"/"captions.js"/"transitions.js"; pure `buildRenderPlan` + tests (Task 2) ↔ spec "render.js"/"Backend testing"; `writeInputs`/`runRender` (Task 3) ↔ spec "writeInputs"/"runRender"; Express routes + job store (Task 4) ↔ spec "index.js"; e2e (Task 5) ↔ spec "Manual". Concat vs graph split, fades, captions, gap black frame, progress parsing, cancel, cleanup, CORS all covered.
- **Naming consistency:** `buildRenderPlan(spec, io)` with `io={paths,audioName,capChain}`; `writeInputs(dir, spec, fileMap)`; `runRender(dir, args, total, onProgress) -> {proc, done}`; routes `/render`, `/render/:id/events|file|cancel`, `/health`. Image fields keyed by clip name; audio field `audio`; spec field `spec`.
- **No placeholders:** full code given except the verbatim copy in Task 1 Step 4 (explicitly "copy these exports from lib/captions.js").
- **Commit steps:** SKIPPED per the user's standing no-commit rule.
