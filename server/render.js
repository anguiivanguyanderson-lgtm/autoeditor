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

// Clips backed by a video file (vs a still image) are detected by extension —
// the upload keeps the original extension, so paths tell us the kind.
const VIDEO_RE = /\.(mp4|mov|m4v|webm|mkv|avi|3gp)$/i;
const isVideoPath = (p) => !!p && VIDEO_RE.test(p);

// atempo only takes 0.5–2.0 per instance, so chain it for larger speed-ups
// (audio equivalent of setpts video speed). Returns "" for ~1x.
function atempoChain(speed) {
  let s = speed;
  const parts = [];
  while (s > 2.0001) { parts.push("atempo=2.0"); s /= 2.0; }
  if (s > 1.0001) parts.push(`atempo=${s.toFixed(4)}`);
  return parts.join(",");
}

// A video clip stream. The input is seeked to the trim in-point with -ss, so
// here we normalise to the canvas, optionally speed it up so the whole clip fits
// the slot (`speed` > 1 = fast-forward, via setpts), clone the last frame to fill
// any slot still longer than the footage (tpad), cut to exactly `span`, and reset
// PTS. With motion, an animated Ken Burns zoom is layered on (zoompan d=1).
function videoStream(i, W, H, fps, span, motionType, amount, speed = 1) {
  const S = span.toFixed(3);
  const fast = speed > 1.0001;
  const spd = fast ? `,setpts=(PTS-STARTPTS)/${speed.toFixed(4)}` : "";
  const base = `[${i}:v]${vfChain(W, H, fps)}${spd},` +
    `tpad=stop_mode=clone:stop_duration=${S},trim=duration=${S},setpts=PTS-STARTPTS`;
  if (!motionType || motionType === "none") {
    // Re-timebase to CFR after a speed change so downstream xfade/encode stay clean.
    return `${base}${fast ? `,fps=${fps}` : ""}[v${i}]`;
  }
  const FR = Math.max(2, Math.round(span * fps));
  const A = amount.toFixed(4);
  const z = motionType === "zoomout" ? `1+${A}-(on/${FR - 1})*${A}` : `1+(on/${FR - 1})*${A}`;
  const PW = Math.round(W * ZOOM_SS), PH = Math.round(H * ZOOM_SS);
  return `${base},scale=${PW}:${PH}:flags=bicubic,` +
    `zoompan=z='${z}':d=1:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${W}x${H}:fps=${fps},` +
    `format=yuv420p[v${i}]`;
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

// The transition duration before clip k (a "cut"/none is a single-frame instant).
function transitionDur(transitions, transitionDuration, k, frame) {
  return (!transitions || !transitions[k] || transitions[k] === "cut")
    ? frame : Math.min(MAX_TRANSITION_DURATION, Math.max(MIN_TRANSITION_DURATION, transitionDuration));
}
// Build the per-clip video inputs + filtergraph (scale/zoompan per clip, then the
// xfade chain) for a list of clips whose `.start` is relative to THIS chain's t=0.
// Returns { inputs, parts, last } — `last` is the composited video label. Shared by
// the single-pass render and by each segment of a segmented render.
function buildVideoChain(clips, paths, { width, height, fps, transitions, transitionDuration, motions, motionAmount = 0.08, trims, speeds }) {
  const n = clips.length;
  const frame = 1 / fps;
  const tdur = (k) => transitionDur(transitions, transitionDuration, k, frame);
  const tname = (k) => xfadeName(transitions && transitions[k]);
  const motTypes = clips.map((c, i) => (c.gap ? "none" : (motions && motions[i]) || "none"));
  const inputs = [];
  const parts = [];
  for (let i = 0; i < n; i++) {
    const span = (i < n - 1 ? clips[i].duration + tdur(i + 1) : clips[i].duration) + 2 * frame;
    if (isVideoPath(paths[i]) && !clips[i].gap) {
      const inSec = Math.max(0, (trims && +trims[i]) || 0);
      const spd = speeds && +speeds[i] > 1 ? +speeds[i] : 1;
      inputs.push("-ss", inSec.toFixed(3), "-i", paths[i]);
      parts.push(videoStream(i, width, height, fps, span, motTypes[i], motionAmount, spd));
    } else if (motTypes[i] === "none") {
      inputs.push("-loop", "1", "-t", span.toFixed(3), "-i", paths[i]);
      parts.push(stillStream(i, width, height, fps));
    } else {
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
  return { inputs, parts, last };
}

function graphArgs({ clips, paths, audioName, width, height, fps, transitions, transitionDuration, motions, motionAmount = 0.08, trims, volumes, speeds, audible, fadeIn, fadeOut, total, capChain, encoder }, filterFiles) {
  const n = clips.length;
  const { inputs, parts, last: vEnd } = buildVideoChain(clips, paths, { width, height, fps, transitions, transitionDuration, motions, motionAmount, trims, speeds });
  let last = vEnd;
  if (capChain) { parts.push(`[${last}]${capChain}[vcap]`); last = "vcap"; }
  const vf = fadeVideo(fadeIn, fadeOut, total);
  if (vf.length) { parts.push(`[${last}]${vf.join(",")}[vf]`); last = "vf"; }

  // Audio: the voiceover is input n. Any video clip with a volume above 0 (and an
  // actual audio track) is delayed to its slot, volume-scaled, and summed in — so
  // the clip's own sound plays under the narration. amix normalize=0 keeps levels.
  const af = fadeAudio(fadeIn, fadeOut, total);
  const vAudio = [];
  for (let i = 0; i < n; i++) {
    const vol = volumes ? +volumes[i] : 0;
    if (isVideoPath(paths[i]) && !clips[i].gap && vol > 0 && (!audible || audible[i])) {
      const startMs = Math.round(clips[i].start * 1000);
      const lbl = `ea${i}`;
      // Speed the audio to match a fast-forwarded clip (atempo), then cut to slot.
      const spd = speeds && +speeds[i] > 1 ? +speeds[i] : 1;
      const at = spd > 1 ? `${atempoChain(spd)},` : "";
      parts.push(`[${i}:a]${at}atrim=duration=${clips[i].duration.toFixed(3)},asetpts=PTS-STARTPTS,` +
        `volume=${vol.toFixed(3)},adelay=${startMs}|${startMs}[${lbl}]`);
      vAudio.push(`[${lbl}]`);
    }
  }
  let amap;
  if (vAudio.length) {
    parts.push(`[${n}:a]${vAudio.join("")}amix=inputs=${vAudio.length + 1}:normalize=0:dropout_transition=0[amx]`);
    if (af.length) { parts.push(`[amx]${af.join(",")}[aout]`); amap = "[aout]"; }
    else amap = "[amx]";
  } else {
    amap = `${n}:a`;
    if (af.length) { parts.push(`[${n}:a]${af.join(",")}[aout]`); amap = "[aout]"; }
  }

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
// Graph-path renders open every clip as a simultaneous input, so a huge timeline
// exhausts the OS (file descriptors / memory) mid-filtergraph — notably on macOS
// (default 256 fds). Above this many clips we render in segments and stitch them.
const SEGMENT_MAX = Math.max(10, parseInt(process.env.RENDER_SEGMENT_MAX || "60", 10) || 60);

// Near-lossless intermediate settings per encoder (segments are re-encoded once in
// the join, so we keep them visually lossless while staying on the same silicon).
function intermediateCodecArgs(encoder) {
  switch (encoder) {
    case "h264_qsv":   return ["-c:v", "h264_qsv", "-global_quality", "15", "-pix_fmt", "yuv420p"];
    case "h264_nvenc": return ["-c:v", "h264_nvenc", "-preset", "p4", "-rc", "constqp", "-qp", "15", "-pix_fmt", "yuv420p"];
    case "h264_amf":   return ["-c:v", "h264_amf", "-rc", "cqp", "-qp_i", "15", "-qp_p", "15", "-pix_fmt", "yuv420p"];
    case "h264_mediacodec": return ["-c:v", "h264_mediacodec", "-b:v", "40M"]; // negotiates its own pix_fmt
    default:           return ["-c:v", "libx264", "-preset", "veryfast", "-crf", "12", "-pix_fmt", "yuv420p"];
  }
}

// Final pass: xfade the segment videos together at their boundary transitions
// (reproducing the crossfade seamlessly), then apply captions, fades and audio.
// audioClips = audible video clips (re-opened here for their sound). Returns { args, text }.
function buildJoinArgs({ segFiles, segDurs, boundaries, width, height, fps, capChain, audioName, audioClips, fadeIn, fadeOut, total, encoder }, joinFc) {
  const S = segFiles.length;
  const parts = [];
  for (let j = 0; j < S; j++) parts.push(`[${j}:v]fps=${fps},format=yuv420p,setsar=1[s${j}]`);
  let last = "s0", off = 0;
  for (let j = 1; j < S; j++) {
    const bt = boundaries[j - 1];
    off += segDurs[j - 1] - bt.d;
    const out = j === S - 1 ? "vjoin" : `jx${j}`;
    parts.push(`[${last}][s${j}]xfade=transition=${bt.name}:duration=${bt.d.toFixed(3)}:offset=${off.toFixed(3)}[${out}]`);
    last = out;
  }
  if (capChain) { parts.push(`[${last}]${capChain}[vcap]`); last = "vcap"; }
  const vf = fadeVideo(fadeIn, fadeOut, total);
  if (vf.length) { parts.push(`[${last}]${vf.join(",")}[vf]`); last = "vf"; }
  // Audio: voiceover is input S; audible video clips follow (re-opened for sound).
  const voice = S;
  const audioInputs = [], vAudio = [];
  let ai = S + 1;
  for (const ac of audioClips) {
    audioInputs.push("-ss", ac.trim.toFixed(3), "-i", ac.path);
    const idx = ai++;
    const startMs = Math.round(ac.start * 1000);
    const at = ac.speed > 1 ? `${atempoChain(ac.speed)},` : "";
    parts.push(`[${idx}:a]${at}atrim=duration=${ac.duration.toFixed(3)},asetpts=PTS-STARTPTS,volume=${ac.vol.toFixed(3)},adelay=${startMs}|${startMs}[ea${ac.i}]`);
    vAudio.push(`[ea${ac.i}]`);
  }
  const af = fadeAudio(fadeIn, fadeOut, total);
  let amap;
  if (vAudio.length) {
    parts.push(`[${voice}:a]${vAudio.join("")}amix=inputs=${vAudio.length + 1}:normalize=0:dropout_transition=0[amx]`);
    if (af.length) { parts.push(`[amx]${af.join(",")}[aout]`); amap = "[aout]"; } else amap = "[amx]";
  } else {
    amap = `${voice}:a`;
    if (af.length) { parts.push(`[${voice}:a]${af.join(",")}[aout]`); amap = "[aout]"; }
  }
  const inputArgs = [];
  for (const f of segFiles) inputArgs.push("-i", f);
  inputArgs.push("-i", audioName, ...audioInputs);
  const args = [
    ...inputArgs,
    "-filter_complex_script", joinFc,
    "-map", `[${last}]`, "-map", amap,
    "-t", total.toFixed(3),
    ...videoCodecArgs(encoder),
    "-c:a", "aac", "-b:a", "192k",
    "-movflags", "+faststart", "output.mp4",
  ];
  return { args, text: parts.join(";") };
}

// A multi-pass plan: render clips in chunks of SEGMENT_MAX to near-lossless
// intermediates, then a small join pass xfades them + adds captions/audio.
function buildSegmentedPlan(spec, io, total) {
  const { clips, width, height, fps = 30, transitions, transitionDuration = 0.4, motions, motionAmount = 0.08, trims, volumes, speeds, fadeIn = 0, fadeOut = 0 } = spec;
  const { paths, audioName, capChain = "", encoder = "libx264", audible } = io;
  const n = clips.length;
  const frame = 1 / fps;
  const tdur = (k) => transitionDur(transitions, transitionDuration, k, frame);
  const chunks = [];
  for (let lo = 0; lo < n; lo += SEGMENT_MAX) chunks.push([lo, Math.min(lo + SEGMENT_MAX - 1, n - 1)]);

  const passes = [], segFiles = [], segDurs = [], boundaries = [];
  chunks.forEach(([lo, hi], s) => {
    // Rebase this chunk's clip starts to t=0 and compute its exact duration.
    let start = 0; const segClips = [];
    for (let i = lo; i <= hi; i++) { segClips.push({ ...clips[i], start }); start += clips[i].duration - (i < hi ? tdur(i + 1) : 0); }
    const segDur = start;
    const slice = (a) => (Array.isArray(a) ? a.slice(lo, hi + 1) : a);
    const { inputs, parts, last } = buildVideoChain(segClips, slice(paths), {
      width, height, fps, transitions: slice(transitions), transitionDuration, motions: slice(motions), motionAmount, trims: slice(trims), speeds: slice(speeds),
    });
    const fc = `fc_s${s}.txt`, out = `seg${s}.mp4`;
    const args = [...inputs, "-filter_complex_script", fc, "-map", `[${last}]`, "-an", ...intermediateCodecArgs(encoder), "-t", segDur.toFixed(3), out];
    passes.push({ name: `segment ${s + 1}/${chunks.length}`, args, filterFiles: [{ name: fc, text: parts.join(";") }], output: out, total: segDur });
    segFiles.push(out); segDurs.push(segDur);
    if (s > 0) boundaries.push({ name: xfadeName(transitions && transitions[lo]), d: tdur(lo) });
  });

  const audioClips = [];
  for (let i = 0; i < n; i++) {
    const vol = volumes ? +volumes[i] : 0;
    if (isVideoPath(paths[i]) && !clips[i].gap && vol > 0 && (!audible || audible[i])) {
      audioClips.push({ i, path: paths[i], trim: Math.max(0, (trims && +trims[i]) || 0), speed: speeds && +speeds[i] > 1 ? +speeds[i] : 1, vol, start: clips[i].start, duration: clips[i].duration });
    }
  }
  const joinFc = "fc_join.txt";
  const { args, text } = buildJoinArgs({ segFiles, segDurs, boundaries, width, height, fps, capChain, audioName, audioClips, fadeIn, fadeOut, total, encoder }, joinFc);
  passes.push({ name: "join", args, filterFiles: [{ name: joinFc, text }], output: "output.mp4", total });
  return { mode: "segmented", total, passes };
}

// spec: { clips, width, height, fps, transitions, transitionDuration, fadeIn, fadeOut }
// io:   { paths: string[] (per-clip basenames), audioName, capChain, encoder }
export function buildRenderPlan(spec, io) {
  const { clips, width, height, fps = 30, transitions, transitionDuration = 0.4, motions, motionAmount = 0.08, trims, volumes, speeds, fadeIn = 0, fadeOut = 0 } = spec;
  const { paths, audioName, capChain = "", encoder = "libx264", audible } = io;
  const total = clips.length ? clips[clips.length - 1].start + clips[clips.length - 1].duration : 0;
  const hasTransition = Array.isArray(transitions) && clips.length >= 2 &&
    transitions.some((t, i) => i > 0 && t && t !== "cut");
  // Per-clip zoom also needs the filter-graph path (concat can't zoom per clip).
  const hasMotion = Array.isArray(motions) &&
    motions.some((m, i) => m && m !== "none" && clips[i] && !clips[i].gap);
  // Video clips always need the filter-graph path (trim/fit/zoom/audio-mix).
  const hasVideo = Array.isArray(paths) &&
    paths.some((p, i) => isVideoPath(p) && clips[i] && !clips[i].gap);
  const useGraph = hasTransition || hasMotion || hasVideo;
  // Big graph timelines are split into segments + a join to dodge the OS limits.
  if (useGraph && clips.length > SEGMENT_MAX) return buildSegmentedPlan(spec, io, total);
  const common = { clips, paths, audioName, width, height, fps, fadeIn, fadeOut, total, capChain, encoder };
  const filterFiles = [];
  const args = useGraph
    ? graphArgs({ ...common, transitions, transitionDuration, motions, motionAmount, trims, volumes, speeds, audible }, filterFiles)
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

// Does this media file carry an audio track? Probe with ffmpeg (`-i` with no
// output exits non-zero but prints the stream table to stderr) so we never map a
// missing [i:a] stream — which would abort the whole render. ffprobe isn't always
// bundled (ffmpeg-static ships only ffmpeg), so we parse ffmpeg's own output.
function probeHasAudio(dir, file) {
  return new Promise((resolve) => {
    execFile(FFMPEG, ["-hide_banner", "-i", file], { cwd: dir, timeout: 15000 }, (_err, _out, stderr) => {
      resolve(/Stream #\d+:\d+.*: Audio:/i.test(stderr || ""));
    });
  });
}

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
  const { clips, width, height, captions, captionStyle = "classic", captionSize = "md", captionLineHeight, captionFontScale } = spec;

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
    const { filter, files } = buildCaptionBurn(captions, captionStyle, width, height, captionSize, captionLineHeight, captionFontScale);
    await fs.copyFile(FONT_SRC, path.join(dir, CAPTION_FONT));
    for (const f of files) await fs.writeFile(path.join(dir, f.name), f.text);
    capChain = filter;
  }

  // Which video clips actually have audio (so we only mix real streams in).
  const audible = await Promise.all(clips.map((c, i) =>
    (c.gap || !isVideoPath(paths[i])) ? Promise.resolve(false) : probeHasAudio(dir, paths[i])));

  return { paths, audioName, capChain, audible };
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
  const output = opts.output || "output.mp4";
  const threads = opts.threads > 0 ? opts.threads : 0;
  let a = [...args];
  if (threads) {
    // Encoder threads: insert before the output filename (an output option).
    const oi = a.lastIndexOf(output);
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
      if (code === 0) resolve(path.join(dir, output));
      else reject(new Error(`ffmpeg exited ${code}\n${stderr.slice(-2000)}`));
    });
  });
  return { proc, done };
}
