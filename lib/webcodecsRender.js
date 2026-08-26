// SPIKE — WebCodecs GPU render path (video-only, no audio/captions yet).
// Proves the pipeline: draw each frame on an OffscreenCanvas (GPU), feed it
// straight to the device's hardware H.264 encoder via WebCodecs, and mux the
// encoded chunks into a playable .mp4 — no ffmpeg, no giant filtergraph, and
// zoom is a sub-pixel canvas transform (so no supersampling and no shake).
//
// This is deliberately minimal: it renders images with Ken Burns zoom and an
// approximate crossfade so we can confirm the GPU path works end-to-end in a
// real browser. Audio, exact transition timing, and captions come after the
// pipeline is proven.
import { Muxer, ArrayBufferTarget } from "mp4-muxer";

export function webCodecsSupported() {
  return typeof window !== "undefined"
    && typeof window.VideoEncoder !== "undefined"
    && typeof window.VideoFrame !== "undefined"
    && typeof window.OffscreenCanvas !== "undefined";
}

// Pick an H.264 codec string the encoder actually supports at this size.
async function pickCodec(width, height, framerate) {
  const candidates = ["avc1.640028", "avc1.4d0028", "avc1.42002a", "avc1.42001f"];
  for (const codec of candidates) {
    try {
      const s = await VideoEncoder.isConfigSupported({ codec, width, height, framerate, bitrate: 8_000_000 });
      if (s && s.supported) return codec;
    } catch (_) { /* try next */ }
  }
  return "avc1.42001f";
}

// Draw a bitmap "contained" (letterboxed) into WxH, zoomed about the centre.
function drawContain(ctx, bmp, W, H, zoom, alpha) {
  if (!bmp) return;
  const scale = Math.min(W / bmp.width, H / bmp.height) * zoom;
  const dw = bmp.width * scale, dh = bmp.height * scale;
  ctx.globalAlpha = alpha;
  ctx.drawImage(bmp, (W - dw) / 2, (H - dh) / 2, dw, dh);
  ctx.globalAlpha = 1;
}

// spec: { clips:[{name,start,duration}], width, height, fps, transitions[],
//         transitionDuration, motions[], motionAmount }
// imagesByName: { name -> File|Blob }.  onProgress(fraction 0..1).
// Returns a video-only MP4 Blob.
export async function renderWebCodecs(spec, imagesByName, onProgress) {
  if (!webCodecsSupported()) throw new Error("WebCodecs isn't supported in this browser.");
  const { clips, width: W, height: H, fps = 30, transitions = [], transitionDuration = 0.4, motions = [], motionAmount = 0.08 } = spec;
  if (!clips || !clips.length) throw new Error("Nothing to render.");
  const total = clips[clips.length - 1].start + clips[clips.length - 1].duration;
  const totalFrames = Math.max(1, Math.round(total * fps));

  // Decode every image up front into GPU-friendly bitmaps.
  const bmps = await Promise.all(clips.map((c) => (imagesByName[c.name] ? createImageBitmap(imagesByName[c.name]) : Promise.resolve(null))));

  const canvas = new OffscreenCanvas(W, H);
  const ctx = canvas.getContext("2d", { alpha: false });

  const codec = await pickCodec(W, H, fps);
  const muxer = new Muxer({ target: new ArrayBufferTarget(), video: { codec: "avc", width: W, height: H }, fastStart: "in-memory" });
  let encErr = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => { encErr = e; },
  });
  encoder.configure({ codec, width: W, height: H, framerate: fps, bitrate: 8_000_000, avc: { format: "avc" } });

  const zoomAt = (i, p) => {
    const m = motions[i];
    if (!m || m === "none") return 1;
    return m === "zoomout" ? 1 + motionAmount * (1 - p) : 1 + motionAmount * p;
  };

  for (let f = 0; f < totalFrames; f++) {
    if (encErr) throw encErr;
    const t = f / fps;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, W, H);

    // Current clip = the last one whose start is <= t.
    let cur = 0;
    for (let i = 0; i < clips.length; i++) { if (t >= clips[i].start) cur = i; else break; }
    const c = clips[cur];
    const localP = c.duration > 0 ? Math.min(1, (t - c.start) / c.duration) : 0;
    drawContain(ctx, bmps[cur], W, H, zoomAt(cur, localP), 1);

    // Approximate crossfade into the next clip over the last `transitionDuration`.
    const nx = cur + 1;
    if (nx < clips.length) {
      const tr = transitions[nx];
      if (tr && tr !== "cut") {
        const d = transitionDuration;
        const winStart = clips[nx].start - d;
        if (t >= winStart) {
          const a = Math.max(0, Math.min(1, (t - winStart) / d));
          drawContain(ctx, bmps[nx], W, H, zoomAt(nx, 0), a);
        }
      }
    }

    const frame = new VideoFrame(canvas, { timestamp: Math.round((f * 1e6) / fps), duration: Math.round(1e6 / fps) });
    encoder.encode(frame, { keyFrame: f % (fps * 2) === 0 });
    frame.close();

    // Bound the encoder queue and keep the UI responsive.
    if (encoder.encodeQueueSize > 8) await new Promise((r) => setTimeout(r));
    if (onProgress && f % 4 === 0) onProgress(f / totalFrames);
  }

  await encoder.flush();
  if (encErr) throw encErr;
  muxer.finalize();
  bmps.forEach((b) => b && b.close && b.close());
  if (onProgress) onProgress(1);
  return new Blob([muxer.target.buffer], { type: "video/mp4" });
}
