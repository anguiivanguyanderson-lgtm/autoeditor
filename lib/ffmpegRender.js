// Render an MP4 in-browser with single-thread ffmpeg.wasm.
// opts: { clips:[{name,start,duration}], imagesByName:{name->File}, audioFile:File,
//         width, height, fps, onProgress? }
import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile, toBlobURL } from "@ffmpeg/util";

let _ffmpeg = null;
async function getFFmpeg(onProgress) {
  if (_ffmpeg) return _ffmpeg;
  const ffmpeg = new FFmpeg();
  if (onProgress) ffmpeg.on("progress", ({ progress }) => onProgress(Math.min(1, progress)));
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

export async function renderVideo(opts) {
  const { clips, imagesByName, audioFile, width, height, fps, onProgress } = opts;
  const ffmpeg = await getFFmpeg(onProgress);

  // Write images with sequential FS names; build concat list. Gap clips (no
  // image) share a single generated black frame.
  let blackWritten = false;
  let concat = "";
  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i];
    const file = imagesByName[clip.name];
    let fsName;
    if (file) {
      fsName = `img${String(i).padStart(4, "0")}.${extOf(file.name)}`;
      await ffmpeg.writeFile(fsName, await fetchFile(file));
    } else {
      if (!blackWritten) {
        await ffmpeg.writeFile("black.png", await fetchFile(await blackPng(width, height)));
        blackWritten = true;
      }
      fsName = "black.png";
    }
    concat += `file '${fsName}'\nduration ${clip.duration}\n`;
    // Repeat the last image once more so the concat demuxer honors its duration.
    if (i === clips.length - 1) concat += `file '${fsName}'\n`;
  }
  await ffmpeg.writeFile("concat.txt", new TextEncoder().encode(concat));

  const audioExt = extOf(audioFile.name);
  const audioFs = `audio.${audioExt}`;
  await ffmpeg.writeFile(audioFs, await fetchFile(audioFile));

  const vf =
    `scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps},format=yuv420p`;

  await ffmpeg.exec([
    "-f", "concat", "-safe", "0", "-i", "concat.txt",
    "-i", audioFs,
    "-vf", vf,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
    "-c:a", "aac", "-b:a", "192k",
    "-shortest", "-movflags", "+faststart",
    "output.mp4",
  ]);

  const data = await ffmpeg.readFile("output.mp4");
  return new Blob([data.buffer], { type: "video/mp4" });
}
