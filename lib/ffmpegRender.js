// Render an MP4 in-browser with single-thread ffmpeg.wasm.
// opts: { clips:[{name,start,duration}], imagesByName:{name->File}, audioFile,
//         width, height, fps, transitions?:string[], transitionDuration?, onProgress? }
//
// With no transitions we use the fast concat demuxer. When transitions are set
// we build an xfade filter-chain anchored to each clip's timestamp so the total
// length (and audio sync) is preserved.
import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile, toBlobURL } from "@ffmpeg/util";
import { transitionOf, MIN_TRANSITION_DURATION, MAX_TRANSITION_DURATION } from "./transitions";

let _ffmpeg = null;
let _onProgress = null; // updated per render; a single stable listener reads it
async function getFFmpeg() {
  if (_ffmpeg) return _ffmpeg;
  const ffmpeg = new FFmpeg();
  ffmpeg.on("progress", ({ progress }) => { if (_onProgress) _onProgress(Math.min(1, progress)); });
  // The worker loads the UMD core via importScripts, and cross-context loading
  // needs a blob URL — a raw same-origin path throws "Cannot find module".
  await ffmpeg.load({
    coreURL: await toBlobURL("/ffmpeg/ffmpeg-core.js", "text/javascript"),
    wasmURL: await toBlobURL("/ffmpeg/ffmpeg-core.wasm", "application/wasm"),
  });
  _ffmpeg = ffmpeg;
  return ffmpeg;
}

function extOf(name) {
  const m = name.match(/\.([a-z0-9]+)$/i);
  return m ? m[1].toLowerCase() : "png";
}

// A solid black frame for gap clips (removed images / lead-in placeholders).
function blackPng(width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, width, height);
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), "image/png"));
}

async function writeClipImages(ffmpeg, clips, imagesByName, width, height) {
  let blackWritten = false;
  const paths = [];
  for (let i = 0; i < clips.length; i++) {
    const file = imagesByName[clips[i].name];
    if (file) {
      const p = `img${String(i).padStart(4, "0")}.${extOf(file.name)}`;
      await ffmpeg.writeFile(p, await fetchFile(file));
      paths.push(p);
    } else {
      if (!blackWritten) {
        await ffmpeg.writeFile("black.png", await fetchFile(await blackPng(width, height)));
        blackWritten = true;
      }
      paths.push("black.png");
    }
  }
  return paths;
}

function vfChain(width, height, fps) {
  return `scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps},format=yuv420p`;
}

async function readOut(ffmpeg) {
  const data = await ffmpeg.readFile("output.mp4");
  return new Blob([data.buffer], { type: "video/mp4" });
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

async function renderConcat(ffmpeg, { clips, paths, audioFs, width, height, fps, fadeIn, fadeOut, total }) {
  let concat = "";
  for (let i = 0; i < clips.length; i++) {
    concat += `file '${paths[i]}'\nduration ${clips[i].duration}\n`;
    if (i === clips.length - 1) concat += `file '${paths[i]}'\n`;
  }
  await ffmpeg.writeFile("concat.txt", new TextEncoder().encode(concat));

  const vf = [vfChain(width, height, fps), ...fadeVideo(fadeIn, fadeOut, total)].join(",");
  const af = fadeAudio(fadeIn, fadeOut, total);
  const args = [
    "-f", "concat", "-safe", "0", "-i", "concat.txt",
    "-i", audioFs,
    "-vf", vf,
  ];
  if (af.length) args.push("-af", af.join(","));
  args.push(
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
    "-c:a", "aac", "-b:a", "192k",
    "-shortest", "-movflags", "+faststart",
    "output.mp4",
  );
  await ffmpeg.exec(args);
  return readOut(ffmpeg);
}

// A static clip stream: a looped still held for its whole duration.
function stillStream(i, W, H, fps) {
  return `[${i}:v]${vfChain(W, H, fps)}[v${i}]`;
}

// A Ken Burns zoom stream. Fed a SINGLE image frame and expanded to `frames`
// output frames by zoompan (d=frames) — the smooth, canonical form (looping the
// still with d=1 is what causes the shake). The source is supersampled 2x first
// so zoompan's integer crop rounding stays sub-pixel and doesn't jitter.
function zoomStream(i, W, H, fps, motionType, amount, frames) {
  const A = amount.toFixed(4);
  const FR = Math.max(2, frames);
  const z = motionType === "zoomout"
    ? `1+${A}-(on/${FR - 1})*${A}`
    : `1+(on/${FR - 1})*${A}`;
  // Supersample the source so zoompan's integer crop stays well below a pixel.
  // This only adds filter cost on zoom clips, not the whole-video encode.
  const M = 3;
  const PW = Math.round(W * M), PH = Math.round(H * M);
  const pre = `[${i}:v]scale=${PW}:${PH}:force_original_aspect_ratio=decrease,` +
    `pad=${PW}:${PH}:(ow-iw)/2:(oh-ih)/2,setsar=1`;
  const zp = `zoompan=z='${z}':d=${FR}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${W}x${H}:fps=${fps}`;
  return `${pre},${zp},format=yuv420p[v${i}]`;
}

async function renderGraph(ffmpeg, opts) {
  const {
    clips, paths, audioFs, width, height, fps,
    transitions, transitionDuration, motions, motionAmount, fadeIn, fadeOut, total,
  } = opts;
  const n = clips.length;
  const frame = 1 / fps;
  const clampT = (d) => Math.min(MAX_TRANSITION_DURATION, Math.max(MIN_TRANSITION_DURATION, d));
  const tdur = (k) => (!transitions || !transitions[k] || transitions[k] === "cut" ? frame : clampT(transitionDuration));
  const tname = (k) => transitionOf(transitions && transitions[k]).xfade || "fade";

  // Per-clip motion (gaps never zoom).
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
    parts.push(
      `[${last}][v${k}]xfade=transition=${tname(k)}:duration=${tdur(k).toFixed(3)}:offset=${clips[k].start.toFixed(3)}[${out}]`
    );
    last = out;
  }

  const vf = fadeVideo(fadeIn, fadeOut, total);
  if (vf.length) { parts.push(`[${last}]${vf.join(",")}[vf]`); last = "vf"; }

  const af = fadeAudio(fadeIn, fadeOut, total);
  let amap = `${n}:a`;
  if (af.length) { parts.push(`[${n}:a]${af.join(",")}[aout]`); amap = "[aout]"; }

  await ffmpeg.exec([
    ...inputs,
    "-i", audioFs,
    "-filter_complex", parts.join(";"),
    "-map", `[${last}]`, "-map", amap,
    "-t", total.toFixed(3),
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "192k",
    "-movflags", "+faststart",
    "output.mp4",
  ]);
  return readOut(ffmpeg);
}

export async function renderVideo(opts) {
  const {
    clips, imagesByName, audioFile, width, height, fps = 30,
    transitions, transitionDuration = 0.4,
    motions, motionAmount = 0.08, fadeIn = 0, fadeOut = 0,
    onProgress,
  } = opts;
  _onProgress = onProgress || null;
  const ffmpeg = await getFFmpeg();

  const audioFs = `audio.${extOf(audioFile.name)}`;
  await ffmpeg.writeFile(audioFs, await fetchFile(audioFile));

  const paths = await writeClipImages(ffmpeg, clips, imagesByName, width, height);
  const total = clips.length ? clips[clips.length - 1].start + clips[clips.length - 1].duration : 0;

  const hasTransition = Array.isArray(transitions) && clips.length >= 2 &&
    transitions.some((t, i) => i > 0 && t && t !== "cut");
  const hasMotion = Array.isArray(motions) &&
    motions.some((m, i) => m && m !== "none" && !clips[i].gap);
  const args = { clips, paths, audioFs, width, height, fps, fadeIn, fadeOut, total };

  return (hasTransition || hasMotion)
    ? renderGraph(ffmpeg, { ...args, transitions, transitionDuration, motions, motionAmount })
    : renderConcat(ffmpeg, args);
}
