// SPIKE — WebCodecs GPU render path (video-only, no audio/captions yet).
// Proves the pipeline: draw each frame on an OffscreenCanvas (GPU), feed it
// straight to the device's hardware H.264 encoder via WebCodecs, and mux the
// encoded chunks into a playable .mp4 — no ffmpeg, no giant filtergraph, and
// zoom is a sub-pixel canvas transform (so no supersampling and no shake).
//
// Transitions use the SAME canvas painters as the live preview (lib/transitions),
// with the same timing (a transition plays at the start of the incoming clip, the
// outgoing image frozen at its end-of-clip zoom), so the exported frames match
// what you see in the preview exactly — all 8 types, not just a crossfade.
import { Muxer, ArrayBufferTarget } from "mp4-muxer";
import { captionAt, drawCaption, captionFontPx } from "./captions";
import { transitionOf } from "./transitions";

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
  const { clips, width: W, height: H, fps = 30, transitions = [], transitionDuration = 0.4, motions = [], motionAmount = 0.08, audioFile = null,
    cues = null, captionStyle = "classic", captionSize = "md", captionLineHeight = 0, captionFontScale = 1 } = spec;
  if (!clips || !clips.length) throw new Error("Nothing to render.");
  const total = clips[clips.length - 1].start + clips[clips.length - 1].duration;
  const totalFrames = Math.max(1, Math.round(total * fps));

  // Decode the voiceover first, so the muxer can be created with an audio track.
  let audio = null;
  if (audioFile) {
    try {
      const ac = new (window.AudioContext || window.webkitAudioContext)();
      const buf = await ac.decodeAudioData(await audioFile.arrayBuffer());
      audio = { buf, sampleRate: buf.sampleRate, channels: Math.min(2, buf.numberOfChannels), ctx: ac };
    } catch (_) { audio = null; } // fall back to a silent video
  }

  // Decode images ON DEMAND, keeping only a few near the playhead, so a long
  // timeline of large images doesn't exhaust the tab's memory (and crash it).
  const cache = new Map(); // clip index -> ImageBitmap|null
  async function getBmp(i) {
    if (i < 0 || i >= clips.length) return null;
    if (cache.has(i)) return cache.get(i);
    const file = imagesByName[clips[i].name];
    const bmp = file ? await createImageBitmap(file) : null;
    cache.set(i, bmp);
    for (const [k, b] of cache) { if (Math.abs(k - i) > 2) { if (b && b.close) b.close(); cache.delete(k); } }
    return bmp;
  }

  const canvas = new OffscreenCanvas(W, H);
  const ctx = canvas.getContext("2d", { alpha: false });

  // Captions: precompute the font size and make sure the caption font is loaded
  // (the main-thread OffscreenCanvas shares the document's fonts).
  const hasCaptions = !!(cues && cues.length);
  const capFontPx = captionFontPx(H, captionSize, captionFontScale);
  if (hasCaptions && typeof document !== "undefined" && document.fonts) {
    try { await document.fonts.load(`700 ${capFontPx}px "CaptionFont"`); } catch (_) {}
  }

  const codec = await pickCodec(W, H, fps);
  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: "avc", width: W, height: H },
    ...(audio ? { audio: { codec: "aac", sampleRate: audio.sampleRate, numberOfChannels: audio.channels } } : {}),
    fastStart: "in-memory",
  });
  let encErr = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => { encErr = e; },
  });
  encoder.configure({ codec, width: W, height: H, framerate: fps, bitrate: 8_000_000, avc: { format: "avc" } });

  // Ken Burns zoom — identical to the preview's scaleAt: gaps never zoom, and
  // progress is clamped so an outgoing image holds its end-of-clip zoom through a
  // transition (evaluated at the current time t, not a local progress).
  const scaleAt = (i, tt) => {
    const c = clips[i];
    if (!c || c.gap) return 1;
    const m = motions[i];
    if (!m || m === "none") return 1;
    const lp = Math.min(1, Math.max(0, (tt - c.start) / c.duration));
    return m === "zoomout" ? 1 + motionAmount * (1 - lp) : 1 + motionAmount * lp;
  };

  for (let f = 0; f < totalFrames; f++) {
    if (encErr) throw encErr;
    // Backpressure: never queue frames faster than the encoder drains them, or
    // pending frames + encoded chunks pile up in memory and the tab crashes.
    while (encoder.encodeQueueSize > 4) await new Promise((r) => setTimeout(r, 0));

    const t = f / fps;
    ctx.globalAlpha = 1;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, W, H);

    // Current clip: the one whose [start, start+duration) contains t (else the last).
    let idx = -1;
    for (let i = 0; i < clips.length; i++) {
      if (t >= clips[i].start && t < clips[i].start + clips[i].duration) { idx = i; break; }
    }
    if (idx === -1) idx = clips.length - 1;
    const clip = clips[idx];
    const type = idx > 0 ? (transitions[idx] || "cut") : "cut";
    const tdur = type === "cut" ? 0 : Math.min(transitionDuration, clip.duration);

    if (idx > 0 && tdur > 0 && t < clip.start + tdur) {
      // Inside a transition: blend previous image -> current with the exact painter
      // the preview uses, each drawn at its own current zoom. (getBmp(idx-1) then
      // getBmp(idx): both stay in the ±2 cache window, so neither is evicted.)
      const p = Math.min(1, Math.max(0, (t - clip.start) / tdur));
      const prevBmp = await getBmp(idx - 1);
      const curBmp = await getBmp(idx);
      transitionOf(type).canvas(ctx, prevBmp, curBmp, p, W, H, scaleAt(idx - 1, t), scaleAt(idx, t));
      ctx.globalAlpha = 1;
    } else {
      drawContain(ctx, await getBmp(idx), W, H, scaleAt(idx, t), 1);
    }

    // Captions drawn on top of the images.
    if (hasCaptions) {
      const cap = captionAt(cues, t);
      if (cap) drawCaption(ctx, cap, W, H, captionStyle, capFontPx, captionLineHeight);
    }

    const frame = new VideoFrame(canvas, { timestamp: Math.round((f * 1e6) / fps), duration: Math.round(1e6 / fps) });
    encoder.encode(frame, { keyFrame: f % (fps * 2) === 0 });
    frame.close();

    if (onProgress && f % 8 === 0) onProgress(f / totalFrames);
  }

  await encoder.flush();
  if (encErr) throw encErr;

  // Encode the audio track (trimmed to the video length) and mux it in.
  if (audio) {
    const { buf, sampleRate, channels } = audio;
    const audioEnc = new AudioEncoder({ output: (c, m) => muxer.addAudioChunk(c, m), error: (e) => { encErr = e; } });
    audioEnc.configure({ codec: "mp4a.40.2", sampleRate, numberOfChannels: channels, bitrate: 192000 });
    const chans = [];
    for (let c = 0; c < channels; c++) chans.push(buf.getChannelData(c));
    const totalSamples = Math.min(buf.length, Math.ceil(total * sampleRate));
    const STEP = 4096; // samples per AudioData chunk
    for (let off = 0; off < totalSamples; off += STEP) {
      if (encErr) throw encErr;
      const n = Math.min(STEP, totalSamples - off);
      const planar = new Float32Array(n * channels); // f32-planar: [ch0…, ch1…]
      for (let c = 0; c < channels; c++) planar.set(chans[c].subarray(off, off + n), c * n);
      const adata = new AudioData({ format: "f32-planar", sampleRate, numberOfFrames: n, numberOfChannels: channels, timestamp: Math.round((off / sampleRate) * 1e6), data: planar });
      audioEnc.encode(adata);
      adata.close();
      while (audioEnc.encodeQueueSize > 8) await new Promise((r) => setTimeout(r, 0));
    }
    await audioEnc.flush();
    if (audio.ctx && audio.ctx.close) audio.ctx.close();
    if (encErr) throw encErr;
  }

  muxer.finalize();
  for (const b of cache.values()) if (b && b.close) b.close();
  if (onProgress) onProgress(1);
  return new Blob([muxer.target.buffer], { type: "video/mp4" });
}
