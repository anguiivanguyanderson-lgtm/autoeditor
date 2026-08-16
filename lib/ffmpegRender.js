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
import { buildCaptionBurn, CAPTION_FONT } from "./captions";

let _ffmpeg = null;
let _onProgress = null; // updated per render; a single stable listener reads it
let _total = 0;         // total output seconds, for log-driven progress

// Multi-threaded core needs SharedArrayBuffer, which the browser only exposes
// when the page is cross-origin isolated (COOP/COEP headers). When that holds
// we load the MT core (2-4x faster); otherwise we fall back to single-thread.
export function isMultithread() {
  return typeof SharedArrayBuffer !== "undefined" && globalThis.crossOriginIsolated === true;
}

async function getFFmpeg() {
  if (_ffmpeg) return _ffmpeg;
  const ffmpeg = new FFmpeg();
  // Drive progress from ffmpeg's machine-readable "-progress" stream
  // (out_time=HH:MM:SS.us, newline-flushed) against the known total. The core's
  // built-in progress event and the human status line (\r-delimited) don't
  // surface reliably on the MT build.
  ffmpeg.on("log", ({ message }) => {
    if (!_onProgress || !_total) return;
    const m = message.match(/out_time=\s*(\d+):(\d+):([\d.]+)/) ||
      message.match(/time=\s*(\d+):(\d+):([\d.]+)/);
    if (m) {
      const t = (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]);
      _onProgress(Math.min(0.999, t / _total));
    }
  });
  const mt = isMultithread();
  const base = mt ? "/ffmpeg-mt" : "/ffmpeg";
  // The worker loads the UMD core via importScripts, and cross-context loading
  // needs a blob URL — a raw same-origin path throws "Cannot find module".
  const opts = {
    coreURL: await toBlobURL(`${base}/ffmpeg-core.js`, "text/javascript"),
    wasmURL: await toBlobURL(`${base}/ffmpeg-core.wasm`, "application/wasm"),
  };
  if (mt) opts.workerURL = await toBlobURL(`${base}/ffmpeg-core.worker.js`, "text/javascript");
  await ffmpeg.load(opts);
  _ffmpeg = ffmpeg;
  return ffmpeg;
}

// Abort an in-flight render. Terminating the worker rejects the pending exec()
// (renderVideo throws); we drop the instance so the next render reloads fresh.
export function cancelRender() {
  if (_ffmpeg) {
    try { _ffmpeg.terminate(); } catch { /* already gone */ }
    _ffmpeg = null;
  }
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

async function renderConcat(ffmpeg, { clips, paths, audioFs, width, height, fps, fadeIn, fadeOut, total, capChain }) {
  let concat = "";
  for (let i = 0; i < clips.length; i++) {
    concat += `file '${paths[i]}'\nduration ${clips[i].duration}\n`;
    if (i === clips.length - 1) concat += `file '${paths[i]}'\n`;
  }
  await ffmpeg.writeFile("concat.txt", new TextEncoder().encode(concat));

  // Captions burn in before the scene fades, so they fade with the picture.
  const vf = [
    vfChain(width, height, fps),
    ...(capChain ? [capChain] : []),
    ...fadeVideo(fadeIn, fadeOut, total),
  ].join(",");
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
    "-progress", "pipe:1", "-nostats",
    "output.mp4",
  );
  await ffmpeg.exec(args);
  return readOut(ffmpeg);
}

async function renderGraph(ffmpeg, opts) {
  const {
    clips, paths, audioFs, width, height, fps,
    transitions, transitionDuration, fadeIn, fadeOut, total, capChain,
  } = opts;
  const n = clips.length;
  const frame = 1 / fps;
  const clampT = (d) => Math.min(MAX_TRANSITION_DURATION, Math.max(MIN_TRANSITION_DURATION, d));
  const tdur = (k) => (!transitions || !transitions[k] || transitions[k] === "cut" ? frame : clampT(transitionDuration));
  const tname = (k) => transitionOf(transitions && transitions[k]).xfade || "fade";

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
    parts.push(
      `[${last}][v${k}]xfade=transition=${tname(k)}:duration=${tdur(k).toFixed(3)}:offset=${clips[k].start.toFixed(3)}[${out}]`
    );
    last = out;
  }

  // Captions before the fades, so the fade also dims the text.
  if (capChain) { parts.push(`[${last}]${capChain}[vcap]`); last = "vcap"; }

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
    "-progress", "pipe:1", "-nostats",
    "output.mp4",
  ]);
  return readOut(ffmpeg);
}

// Write the font + one textfile per caption LINE and return the drawtext chain.
async function setupCaptions(ffmpeg, captions, captionStyle, captionSize, width, height) {
  if (!Array.isArray(captions) || !captions.length) return "";
  const { filter, files } = buildCaptionBurn(captions, captionStyle, width, height, captionSize);
  await ffmpeg.writeFile(CAPTION_FONT, await fetchFile("/fonts/caption.ttf"));
  for (const f of files) {
    await ffmpeg.writeFile(f.name, new TextEncoder().encode(f.text));
  }
  return filter;
}

export async function renderVideo(opts) {
  const {
    clips, imagesByName, audioFile, width, height, fps = 30,
    transitions, transitionDuration = 0.4, fadeIn = 0, fadeOut = 0,
    captions = null, captionStyle = "classic", captionSize = "md",
    onProgress,
  } = opts;
  _onProgress = onProgress || null;
  const ffmpeg = await getFFmpeg();

  const audioFs = `audio.${extOf(audioFile.name)}`;
  await ffmpeg.writeFile(audioFs, await fetchFile(audioFile));

  const paths = await writeClipImages(ffmpeg, clips, imagesByName, width, height);
  const total = clips.length ? clips[clips.length - 1].start + clips[clips.length - 1].duration : 0;
  _total = total;

  const capChain = await setupCaptions(ffmpeg, captions, captionStyle, captionSize, width, height);

  const hasTransition = Array.isArray(transitions) && clips.length >= 2 &&
    transitions.some((t, i) => i > 0 && t && t !== "cut");
  const args = { clips, paths, audioFs, width, height, fps, fadeIn, fadeOut, total, capChain };

  const blob = await (hasTransition
    ? renderGraph(ffmpeg, { ...args, transitions, transitionDuration })
    : renderConcat(ffmpeg, args));
  if (_onProgress) _onProgress(1);
  return blob;
}
