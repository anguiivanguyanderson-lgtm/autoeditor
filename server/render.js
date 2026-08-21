// Native ffmpeg render — a faithful port of the frontend's lib/ffmpegRender.js.
// The filter strings are identical; only the FS/process handling differs.
import { spawn, execFile } from "node:child_process";
import { promises as fs, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import ffmpegStatic from "ffmpeg-static";
import { xfadeName, MIN_TRANSITION_DURATION, MAX_TRANSITION_DURATION } from "./transitions.js";
import { buildCaptionBurn, CAPTION_FONT } from "./captions.js";

// Crash-safe module dir: import.meta.url works in ESM (dev); in the bundled/SEA
// build it's empty, so fall back to cwd (prod overrides the paths via env anyway).
let MODULE_DIR;
try { MODULE_DIR = path.dirname(fileURLToPath(import.meta.url)); }
catch { MODULE_DIR = process.cwd(); }
// Resolve ffmpeg + font so the app works whether launched by start.bat (env set)
// OR by double-clicking the exe (files sit next to the exe) OR from source (dev).
// Priority: explicit env > next to the exe > dev defaults.
const EXE_DIR = path.dirname(process.execPath);
const nextToExe = (name) => path.join(EXE_DIR, name);
// Bundled ffmpeg is "ffmpeg.exe" on Windows, "ffmpeg" on macOS/Linux.
const FF_BIN = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
const FFMPEG = process.env.FFMPEG_PATH
  || (existsSync(nextToExe(FF_BIN)) ? nextToExe(FF_BIN) : ffmpegStatic);
const FONT_SRC = process.env.CAPTION_FONT_PATH
  || (existsSync(nextToExe("caption.ttf")) ? nextToExe("caption.ttf") : path.join(MODULE_DIR, "assets", "caption.ttf"));

// ---------- pure: build the ffmpeg argument array ----------

function vfChain(width, height, fps) {
  return `scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps},format=yuv420p`;
}

// A still (no-zoom) clip stream: scale/pad to the canvas.
function stillStream(i, width, height, fps) {
  return `[${i}:v]${vfChain(width, height, fps)}[v${i}]`;
}

// A Ken Burns zoom stream: one image frame expanded to `frames` output frames by
// zoompan (d=frames — the smooth form; looping with d=1 is what causes the shake).
// The source is supersampled first so zoompan's integer crop rounding stays
// sub-pixel and doesn't jitter. Only zoom clips pay this cost, not the whole encode.
// The supersample factor drives most of zoom's CPU/RAM cost, so it's tunable:
// RENDER_ZOOM_SS (default 3 = smoothest; phones set 2 to stay responsive).
const ZOOM_SS = Math.max(1, Math.min(3, parseFloat(process.env.RENDER_ZOOM_SS || "3")));
function zoomStream(i, W, H, fps, motionType, amount, frames) {
  const A = amount.toFixed(4);
  const FR = Math.max(2, frames);
  const z = motionType === "zoomout" ? `1+${A}-(on/${FR - 1})*${A}` : `1+(on/${FR - 1})*${A}`;
  const M = ZOOM_SS;
  const PW = Math.round(W * M), PH = Math.round(H * M);
  const pre = `[${i}:v]scale=${PW}:${PH}:force_original_aspect_ratio=decrease,` +
    `pad=${PW}:${PH}:(ow-iw)/2:(oh-ih)/2,setsar=1`;
  const zp = `zoompan=z='${z}':d=${FR}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${W}x${H}:fps=${fps}`;
  return `${pre},${zp},format=yuv420p[v${i}]`;
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

// Video codec args per encoder. Hardware encoders (qsv/nvenc/amf) offload the
// H.264 encode to the GPU and are far faster than CPU libx264.
function videoCodecArgs(encoder) {
  switch (encoder) {
    case "h264_qsv":   return ["-c:v", "h264_qsv", "-preset", "veryfast", "-global_quality", "23"];
    case "h264_nvenc": return ["-c:v", "h264_nvenc", "-preset", "p4", "-rc", "vbr", "-cq", "23", "-pix_fmt", "yuv420p"];
    case "h264_amf":   return ["-c:v", "h264_amf", "-quality", "balanced", "-rc", "cqp", "-qp_i", "23", "-qp_p", "23", "-qp_b", "23"];
    // Android's on-device hardware encoder (same silicon CapCut/KineMaster use).
    // It takes a bitrate, not -crf, and negotiates its own input pixel format.
    case "h264_mediacodec": return ["-c:v", "h264_mediacodec", "-b:v", "8M"];
    default:           return ["-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p"];
  }
}

// The video filtergraph is written to a file and read with -filter_script:v /
// -filter_complex_script, NOT passed on the command line. With captions there's
// one drawtext per line, so the graph can exceed the OS command-line length
// limit (Windows ~32k → spawn ENAMETOOLONG). Reading from a file avoids that.
function concatArgs({ audioName, width, height, fps, fadeIn, fadeOut, total, capChain, encoder }, filterFiles) {
  const vf = [vfChain(width, height, fps), ...(capChain ? [capChain] : []), ...fadeVideo(fadeIn, fadeOut, total)].join(",");
  filterFiles.push({ name: "vf.txt", text: vf });
  const af = fadeAudio(fadeIn, fadeOut, total);
  const args = ["-f", "concat", "-safe", "0", "-i", "concat.txt", "-i", audioName, "-filter_script:v", "vf.txt"];
  if (af.length) args.push("-af", af.join(","));
  args.push(
    ...videoCodecArgs(encoder),
    "-c:a", "aac", "-b:a", "192k",
    "-shortest", "-movflags", "+faststart", "output.mp4",
  );
  return args;
}

function graphArgs({ clips, paths, audioName, width, height, fps, transitions, transitionDuration, motions, motionAmount = 0.08, fadeIn, fadeOut, total, capChain, encoder }, filterFiles) {
  const n = clips.length;
  const frame = 1 / fps;
  const clampT = (d) => Math.min(MAX_TRANSITION_DURATION, Math.max(MIN_TRANSITION_DURATION, d));
  const tdur = (k) => (!transitions || !transitions[k] || transitions[k] === "cut" ? frame : clampT(transitionDuration));
  const tname = (k) => xfadeName(transitions && transitions[k]);
  // Per-clip Ken Burns zoom (gaps never zoom).
  const motTypes = clips.map((c, i) => (c.gap ? "none" : (motions && motions[i]) || "none"));

  const inputs = [];
  const parts = [];
  for (let i = 0; i < n; i++) {
    const span = (i < n - 1 ? clips[i].duration + tdur(i + 1) : clips[i].duration) + 2 * frame;
    if (motTypes[i] === "none") {
      inputs.push("-loop", "1", "-t", span.toFixed(3), "-i", paths[i]);
      parts.push(stillStream(i, width, height, fps));
    } else {
      // Single frame in; zoompan generates the animation (see zoomStream).
      inputs.push("-i", paths[i]);
      parts.push(zoomStream(i, width, height, fps, motTypes[i], motionAmount, Math.round(span * fps)));
    }
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

  filterFiles.push({ name: "fc.txt", text: parts.join(";") });
  return [
    ...inputs, "-i", audioName,
    "-filter_complex_script", "fc.txt",
    "-map", `[${last}]`, "-map", amap,
    "-t", total.toFixed(3),
    ...videoCodecArgs(encoder),
    "-c:a", "aac", "-b:a", "192k",
    "-movflags", "+faststart", "output.mp4",
  ];
}

// Pure: build the ffmpeg argument array for a render, plus `filterFiles` — the
// filtergraph text to write into the job dir (referenced via -filter_script).
// spec: { clips, width, height, fps, transitions, transitionDuration, fadeIn, fadeOut }
// io:   { paths: string[] (per-clip basenames), audioName, capChain, encoder }
export function buildRenderPlan(spec, io) {
  const { clips, width, height, fps = 30, transitions, transitionDuration = 0.4, motions, motionAmount = 0.08, fadeIn = 0, fadeOut = 0 } = spec;
  const { paths, audioName, capChain = "", encoder = "libx264" } = io;
  const total = clips.length ? clips[clips.length - 1].start + clips[clips.length - 1].duration : 0;
  const hasTransition = Array.isArray(transitions) && clips.length >= 2 &&
    transitions.some((t, i) => i > 0 && t && t !== "cut");
  // Per-clip zoom also needs the filter-graph path (concat can't zoom per clip).
  const hasMotion = Array.isArray(motions) &&
    motions.some((m, i) => m && m !== "none" && clips[i] && !clips[i].gap);
  const useGraph = hasTransition || hasMotion;
  const common = { clips, paths, audioName, width, height, fps, fadeIn, fadeOut, total, capChain, encoder };
  const filterFiles = [];
  const args = useGraph
    ? graphArgs({ ...common, transitions, transitionDuration, motions, motionAmount }, filterFiles)
    : concatArgs(common, filterFiles);
  return { mode: useGraph ? "graph" : "concat", total, args, filterFiles };
}

// Probe which H.264 encoder to use: try each hardware encoder with a tiny test
// encode and pick the first that actually runs; fall back to CPU libx264. This
// keeps rendering working on any machine (no GPU, old drivers, etc.).
// On Android (Termux node reports platform "android") try the on-device
// MediaCodec hardware encoder first — that's what keeps CapCut/KineMaster from
// pegging the CPU. Desktops keep their GPU encoders.
const ENCODER_CANDIDATES = process.platform === "android"
  ? ["h264_mediacodec"]
  : ["h264_nvenc", "h264_qsv", "h264_amf"];

function testEncoder(enc) {
  // Encode a few real frames to a temp MP4 (more representative than -f null,
  // which some hardware encoders reject even though real encodes succeed).
  const out = path.join(os.tmpdir(), `svprobe-${process.pid}-${enc}.mp4`);
  return new Promise((resolve) => {
    execFile(
      FFMPEG,
      ["-hide_banner", "-f", "lavfi", "-i", "color=c=black:s=640x360:d=0.3:r=15",
        "-c:v", enc, "-frames:v", "3", "-f", "mp4", "-y", out],
      { timeout: 20000 },
      (err) => { fs.rm(out, { force: true }).catch(() => {}); resolve(!err); },
    );
  });
}

export async function detectEncoder() {
  // Escape hatch: force a specific encoder (e.g. RENDER_ENCODER=libx264 if the
  // hardware one produces a bad/failed render). Skips probing entirely.
  if (process.env.RENDER_ENCODER) return process.env.RENDER_ENCODER;
  for (const enc of ENCODER_CANDIDATES) {
    // eslint-disable-next-line no-await-in-loop
    if (await testEncoder(enc)) return enc;
  }
  return "libx264";
}

// ---------- I/O + process ----------

// Generate a solid black frame for gap clips using ffmpeg's lavfi color source.
function makeBlack(dir, width, height) {
  return new Promise((resolve, reject) => {
    execFile(FFMPEG, [
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

  // Concat file list (used only when there are no transitions; harmless otherwise).
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
// opts.threads caps encoder + filter threads (so a phone doesn't peg every core
// and overheat); opts.nice runs it at low OS priority (so the phone stays
// responsive — foreground apps get CPU first). Both are best-effort.
export function runRender(dir, args, total, onProgress, opts = {}) {
  const threads = opts.threads > 0 ? opts.threads : 0;
  let a = [...args];
  if (threads) {
    // Encoder threads: insert before the output filename (an output option).
    const oi = a.lastIndexOf("output.mp4");
    if (oi >= 0) a.splice(oi, 0, "-threads", String(threads));
    // Filter threads: global options.
    a = ["-filter_complex_threads", String(threads), "-filter_threads", String(threads), ...a];
  }
  a = [...a, "-progress", "pipe:1", "-nostats", "-y"];
  // Low priority keeps the phone usable during a render (Unix only).
  let cmd = FFMPEG, cmdArgs = a;
  if (opts.nice != null && process.platform !== "win32") {
    cmd = "nice"; cmdArgs = ["-n", String(opts.nice), FFMPEG, ...a];
  }
  const proc = spawn(cmd, cmdArgs, { cwd: dir });
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
