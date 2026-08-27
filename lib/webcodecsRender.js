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
import { Muxer as MP4Muxer, ArrayBufferTarget as MP4ArrayBufferTarget, FileSystemWritableFileStreamTarget as MP4FileTarget } from "mp4-muxer";
import { Muxer as WebMMuxer, ArrayBufferTarget as WebMArrayBufferTarget, FileSystemWritableFileStreamTarget as WebMFileTarget } from "webm-muxer";
import { captionAt, drawCaption, captionFontPx } from "./captions";
import { transitionOf } from "./transitions";
import { createVideoSource } from "./videoDecodeSource";

export function webCodecsSupported() {
  return typeof window !== "undefined"
    && typeof window.VideoEncoder !== "undefined"
    && typeof window.VideoFrame !== "undefined"
    && typeof window.OffscreenCanvas !== "undefined";
}

async function videoCodecOk(codec, width, height, framerate, bitrate) {
  try { const s = await VideoEncoder.isConfigSupported({ codec, width, height, framerate, bitrate }); return !!(s && s.supported); }
  catch (_) { return false; }
}
async function audioCodecOk(codec, sampleRate = 48000, numberOfChannels = 2) {
  if (typeof AudioEncoder === "undefined") return false;
  try { const s = await AudioEncoder.isConfigSupported({ codec, sampleRate, numberOfChannels, bitrate: 192000 }); return !!(s && s.supported); }
  catch (_) { return false; }
}

// Can this browser encode video at all (H.264 or VP9/VP8)? Used to offer the Fast
// render only where it works — Firefox has no H.264 encoder but does have VP9.
export async function webCodecsCanRender() {
  if (!webCodecsSupported() || typeof VideoEncoder === "undefined") return false;
  for (const c of ["avc1.42001f", "avc1.4d0028", "vp09.00.10.08", "vp8"]) {
    if (await videoCodecOk(c, 640, 480, 30, 1_000_000)) return true;
  }
  return false;
}

// Pick the best supported output: H.264/AAC in MP4 (most compatible) if possible,
// else VP9/Opus (or VP8) in WebM (e.g. Firefox). Caps to 1080p. Returns null if
// the browser can't encode video at all. `muxerVideo/muxerAudio` are the muxer's
// codec ids; `videoCodec/audioCodec` are the WebCodecs config strings.
export async function pickRenderProfile(rawW, rawH, fps = 30, bitrate = 8_000_000) {
  if (!webCodecsSupported()) return null;
  let W = rawW, H = rawH;
  const sc = Math.min(1, 1920 / W, 1080 / H);
  if (sc < 1) { W = Math.max(2, Math.round((W * sc) / 2) * 2); H = Math.max(2, Math.round((H * sc) / 2) * 2); }
  // MP4 / H.264 first.
  for (const codec of ["avc1.640028", "avc1.4d0028", "avc1.640033", "avc1.640034", "avc1.42002a", "avc1.42001f"]) {
    if (await videoCodecOk(codec, W, H, fps, bitrate)) {
      const aac = await audioCodecOk("mp4a.40.2");
      return { container: "mp4", width: W, height: H, videoCodec: codec, muxerVideo: "avc", audioCodec: aac ? "mp4a.40.2" : null, muxerAudio: "aac" };
    }
  }
  // WebM / VP9 or VP8 fallback.
  for (const [codec, mux] of [["vp09.00.10.08", "V_VP9"], ["vp8", "V_VP8"]]) {
    if (await videoCodecOk(codec, W, H, fps, bitrate)) {
      const opus = await audioCodecOk("opus");
      return { container: "webm", width: W, height: H, videoCodec: codec, muxerVideo: mux, audioCodec: opus ? "opus" : null, muxerAudio: "A_OPUS" };
    }
  }
  return null;
}

// Pick an H.264 codec string the encoder actually supports at this size. Levels
// ascend so the first supported one is used; the fallback is High@4.0 (handles
// 1080p), never a low level like 3.1 that can't encode the frame.
async function pickCodec(width, height, framerate, bitrate = 8_000_000) {
  const candidates = [
    "avc1.640028", // High L4.0  (1080p)
    "avc1.4d0028", // Main L4.0
    "avc1.640033", // High L5.1  (up to ~4K, if the source is bigger)
    "avc1.640034", // High L5.2
    "avc1.42002a", // Baseline L4.2
    "avc1.42001f", // Baseline L3.1 (last resort, small frames only)
  ];
  for (const codec of candidates) {
    try {
      const s = await VideoEncoder.isConfigSupported({ codec, width, height, framerate, bitrate });
      if (s && s.supported) return codec;
    } catch (_) { /* try next */ }
  }
  return "avc1.4d0028";
}

// Draw a bitmap "contained" (letterboxed) into WxH, zoomed about the centre.
function drawContain(ctx, bmp, W, H, zoom, alpha) {
  if (!bmp) return;
  const iw = bmp.displayWidth || bmp.videoWidth || bmp.naturalWidth || bmp.width;
  const ih = bmp.displayHeight || bmp.videoHeight || bmp.naturalHeight || bmp.height;
  if (!iw || !ih) return;
  const scale = Math.min(W / iw, H / ih) * zoom;
  const dw = iw * scale, dh = ih * scale;
  ctx.globalAlpha = alpha;
  ctx.drawImage(bmp, (W - dw) / 2, (H - dh) / 2, dw, dh);
  ctx.globalAlpha = 1;
}

// spec: { clips:[{name,start,duration}], width, height, fps, transitions[],
//         transitionDuration, motions[], motionAmount }
// imagesByName: { name -> File|Blob }.  onProgress(fraction 0..1).
// Returns an MP4 Blob (video + mixed audio: voiceover and each clip's own audio).

// A yield that a BACKGROUND tab does not throttle. Browsers clamp setTimeout to
// ~1/sec in a hidden tab, which would make the encoder-backpressure waits crawl
// the moment you switch away. MessageChannel tasks keep firing at full speed
// while hidden, so the render keeps running normally in the background.
function makeYield() {
  if (typeof MessageChannel === "undefined") {
    return { tick: () => new Promise((r) => setTimeout(r, 0)), done: () => {} };
  }
  const ch = new MessageChannel();
  const waiters = [];
  ch.port1.onmessage = () => { const w = waiters.shift(); if (w) w(); };
  return {
    tick: () => new Promise((res) => { waiters.push(res); ch.port2.postMessage(0); }),
    done: () => { try { ch.port1.close(); ch.port2.close(); } catch (_) {} },
  };
}

// Keep the tab exempt from background throttling for the whole render by emitting
// (essentially inaudible) audio. IMPORTANT: a *muted* element does NOT work — the
// browser only exempts tabs that output audible sound, so muting/gain-0 gets it
// throttled like any hidden tab. We use a real oscillator at a tiny gain and a
// sub-bass frequency: inaudible on normal output, but genuinely "playing audio",
// which keeps ALL of the page's timers running (even past the 5-min intensive-
// throttling cutoff). Must be started from a user gesture (the render click).
// Returns a stop() to call when the render ends.
export function startKeepAwake() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return () => {};
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    gain.gain.value = 0.0015; // ~ -56 dB: inaudible in practice, but non-zero
    osc.frequency.value = 20;  // sub-bass; no audible tone on normal speakers
    osc.connect(gain); gain.connect(ctx.destination);
    osc.start();
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
    return () => { try { osc.stop(); } catch (_) {} try { ctx.close(); } catch (_) {} };
  } catch (_) { return () => {}; }
}

// Pitch-preserving time-stretch (WSOLA: windowed overlap-add with a small
// cross-correlation search for the best splice point). `speed` > 1 compresses
// (shorter/faster), < 1 expands — the PITCH is preserved, unlike a raw
// playbackRate. `channels`: Float32Array[] at one sample rate; returns new
// Float32Array[] of length ≈ inLen/speed. This is the atempo equivalent so a
// fit-sped video clip's audio doesn't chipmunk.
function timeStretch(channels, speed) {
  const nCh = channels.length;
  const inLen = nCh ? channels[0].length : 0;
  if (!nCh || !inLen || Math.abs(speed - 1) < 1e-3) return channels.map((c) => c.slice());
  const outLen = Math.max(1, Math.round(inLen / speed));
  let N = 1024;                              // analysis/synthesis window
  if (inLen < 2 * N) N = Math.max(128, Math.floor(inLen / 2));
  N -= N % 2;
  if (N < 8) return channels.map((c) => c.slice(0, outLen)); // too short to stretch
  const Hs = N >> 1;                         // synthesis hop (50% overlap)
  const Ha = Hs * speed;                     // analysis hop
  const SEARCH = Math.min(256, Hs);          // splice-point search radius
  const win = new Float32Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
  const ref = channels[0];                   // correlate on ch0, splice all channels alike
  const out = [];
  for (let c = 0; c < nCh; c++) out.push(new Float32Array(outLen + N));
  const norm = new Float32Array(outLen + N);
  let synPos = 0, frame = 0, prevStart = 0;
  while (synPos < outLen) {
    const ideal = Math.round(frame * Ha);
    let anaStart = ideal;
    if (frame > 0) {
      const target = prevStart + Hs;         // where the last frame naturally continues
      let best = -Infinity, bestOff = 0;
      for (let off = -SEARCH; off <= SEARCH; off++) {
        const a = ideal + off;
        if (a < 0 || a + Hs > inLen || target + Hs > inLen) continue;
        let corr = 0;
        for (let k = 0; k < Hs; k += 4) corr += ref[target + k] * ref[a + k];
        if (corr > best) { best = corr; bestOff = off; }
      }
      anaStart = ideal + bestOff;
    }
    if (anaStart < 0) anaStart = 0;
    if (anaStart + N > inLen) anaStart = inLen - N;
    if (anaStart < 0) break;
    for (let c = 0; c < nCh; c++) {
      const ch = channels[c], o = out[c];
      for (let i = 0; i < N; i++) o[synPos + i] += ch[anaStart + i] * win[i];
    }
    for (let i = 0; i < N; i++) norm[synPos + i] += win[i];
    prevStart = anaStart;
    synPos += Hs;
    frame++;
  }
  const res = [];
  for (let c = 0; c < nCh; c++) {
    const o = out[c];
    for (let i = 0; i < outLen; i++) { const g = norm[i]; if (g > 1e-6) o[i] /= g; }
    res.push(o.subarray(0, outLen));
  }
  return res;
}

export async function renderWebCodecs(spec, imagesByName, onProgress, shouldCancel, logs = [], writable = null) {
  // Diagnostics collected as we go, so a failure dialog can show what happened.
  const log = (m) => { try { logs.push(m); } catch (_) {} };
  // Progress is split into phases: video 0–0.9, audio 0.9–0.98, muxing 0.98–1.
  const report = (frac, phase) => { if (onProgress) onProgress(Math.max(0, Math.min(1, frac)), phase); };
  const bail = () => {
    if (shouldCancel && shouldCancel()) { const e = new Error("Render cancelled"); e.cancelled = true; throw e; }
  };
  if (!webCodecsSupported()) throw new Error("WebCodecs isn't supported in this browser.");
  const { clips, fps = 30, transitions = [], transitionDuration = 0.4, motions = [], motionAmount = 0.08, audioFile = null,
    cues = null, captionStyle = "classic", captionSize = "md", captionLineHeight = 0, captionFontScale = 1,
    videosByName = {}, trims = [], speeds = [], volumes = [], bitrate = 8_000_000 } = spec;
  // The render profile decides container + codecs (H.264/AAC MP4, or VP9/Opus WebM
  // for browsers like Firefox) and caps the resolution to 1080p.
  const profile = spec.profile || (await pickRenderProfile(spec.width, spec.height, fps, bitrate));
  if (!profile) throw new Error("This browser can't encode video with WebCodecs.");
  const W = profile.width, H = profile.height;
  const isVideo = (i) => i >= 0 && i < clips.length && Object.prototype.hasOwnProperty.call(videosByName, clips[i].name);
  if (!clips || !clips.length) throw new Error("Nothing to render.");
  const total = clips[clips.length - 1].start + clips[clips.length - 1].duration;
  const totalFrames = Math.max(1, Math.round(total * fps));
  const yielder = makeYield(); // background-tab-safe yield (see makeYield above)

  // Audio: mix the voiceover with each video clip's OWN audio (placed at the
  // clip's start, scaled by its volume, and sped by its fit-speed). We decide the
  // track config up front so the muxer can be created with it; the actual mix is
  // rendered (via OfflineAudioContext) after the video frames.
  const clipAudio = clips.map((c, i) => (isVideo(i) && (volumes[i] || 0) > 0)
    ? { file: videosByName[c.name], start: c.start, dur: c.duration, offset: trims[i] || 0, speed: speeds[i] || 1, vol: volumes[i] }
    : null).filter(Boolean);
  let voiceBuffer = null;
  if (audioFile) {
    try {
      const ac = new (window.AudioContext || window.webkitAudioContext)();
      voiceBuffer = await ac.decodeAudioData(await audioFile.arrayBuffer());
      try { ac.close(); } catch (_) {}
    } catch (_) { voiceBuffer = null; }
  }
  const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const mixRate = voiceBuffer ? voiceBuffer.sampleRate : 48000;
  const mixChannels = 2;
  // The profile already probed audio support (AAC for MP4 / Opus for WebM). A
  // clean video-only file is the fallback when the browser can't encode audio.
  const audioCodec = profile.audioCodec; // WebCodecs config string, or null
  const wantAudio = (!!voiceBuffer || clipAudio.length > 0) && !!OAC && !!audioCodec;
  log(`profile: ${profile.container} ${profile.videoCodec}${audioCodec ? " + " + audioCodec : " (no audio)"}`);

  // Render voiceover + all clip audio into one buffer, trimmed to the video length.
  async function mixAudio() {
    try {
      // Manual mix into plain Float32 buffers — NOT one big OfflineAudioContext,
      // which browsers reject for long timelines ("operation not supported").
      const length = Math.max(1, Math.ceil(total * mixRate));
      const channels = mixChannels;
      const master = [];
      for (let c = 0; c < channels; c++) master.push(new Float32Array(length));
      // Voiceover (decoded at mixRate) from t=0.
      if (voiceBuffer) {
        for (let c = 0; c < channels; c++) {
          const src = voiceBuffer.getChannelData(Math.min(c, voiceBuffer.numberOfChannels - 1));
          master[c].set(src.subarray(0, Math.min(src.length, length)));
        }
      }
      // A tiny offline context, reused only to decode+resample each clip to mixRate.
      const dctx = new OAC(1, 1, mixRate);
      for (const ca of clipAudio) {
        let cbuf = null;
        try { cbuf = await dctx.decodeAudioData(await ca.file.arrayBuffer()); }
        catch (_) { cbuf = null; } // clip may have no audio track
        if (!cbuf) continue;
        const nCh = Math.min(channels, cbuf.numberOfChannels);
        const startSample = Math.max(0, Math.floor(ca.offset * mixRate));
        const regionLen = Math.min(cbuf.length - startSample, Math.round(ca.dur * ca.speed * mixRate));
        if (regionLen <= 0) continue;
        const region = [];
        for (let c = 0; c < nCh; c++) region.push(cbuf.getChannelData(c).subarray(startSample, startSample + regionLen));
        // Pitch-preserving fit-speed: pre-stretch to the slot length.
        const outChans = Math.abs(ca.speed - 1) < 1e-3 ? region : timeStretch(region, ca.speed);
        const at = Math.floor(ca.start * mixRate);
        const oLen = outChans[0].length;
        for (let c = 0; c < channels; c++) {
          const s = outChans[Math.min(c, outChans.length - 1)];
          const dst = master[c];
          const lim = Math.min(oLen, length - at);
          for (let i = 0; i < lim; i++) dst[at + i] += s[i] * ca.vol;
        }
      }
      return { sampleRate: mixRate, channels: master, length };
    } catch (_) { return null; }
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

  // Video clips: one muted offscreen <video> each, seeked frame-by-frame to the
  // source time this output frame needs (mirrors the ffmpeg render's trim/speed).
  const videoEls = new Map(); // clip index -> { v, url } | null
  async function getVideoEl(i) {
    if (videoEls.has(i)) return videoEls.get(i);
    const file = videosByName[clips[i].name];
    if (!file) { videoEls.set(i, null); return null; }
    const v = document.createElement("video");
    v.muted = true; v.playsInline = true; v.preload = "auto";
    const url = URL.createObjectURL(file);
    v.src = url;
    await new Promise((res) => {
      const done = () => { v.removeEventListener("loadeddata", done); v.removeEventListener("error", done); res(); };
      v.addEventListener("loadeddata", done);
      v.addEventListener("error", done);
      try { v.load(); } catch (_) { done(); }
    });
    const entry = { v, url };
    videoEls.set(i, entry);
    return entry;
  }
  function seekTo(v, time) {
    return new Promise((resolve) => {
      const eps = 1 / (fps * 4);
      if (v.readyState >= 2 && Math.abs(v.currentTime - time) <= eps) { resolve(); return; }
      let settled = false;
      const done = () => { if (settled) return; settled = true; v.removeEventListener("seeked", done); resolve(); };
      v.addEventListener("seeked", done);
      try { v.currentTime = time; } catch (_) { done(); }
    });
  }
  // Fast path: decode each video clip sequentially with a hardware VideoDecoder
  // (no per-frame seeking). Falls back to the <video> seek above if a clip can't
  // be decoded that way (unsupported codec, demux failure, …).
  const videoSources = new Map(); // clip index -> source | null (null = use seek)
  async function getVideoSource(i) {
    if (videoSources.has(i)) return videoSources.get(i);
    let src = null;
    try { src = await createVideoSource(videosByName[clips[i].name]); } catch (_) { src = null; }
    videoSources.set(i, src);
    log(`clip ${i}: ${src ? "VideoDecoder (fast)" : "<video> seek (fallback)"}`);
    return src;
  }
  // A drawable for clip i at output time t. Video clips decode sequentially (or
  // fall back to seeking); images return their time-independent ImageBitmap.
  async function getFrame(i, t) {
    if (i < 0 || i >= clips.length) return null;
    if (!isVideo(i)) return getBmp(i);
    const c = clips[i];
    const speed = speeds[i] || 1;
    const trimStart = trims[i] || 0;
    const src = trimStart + Math.max(0, t - c.start) * speed; // monotonic per clip
    const source = await getVideoSource(i);
    if (source) {
      try { const fr = await source.frameAt(src); if (fr) return fr; } catch (_) { /* fall back */ }
    }
    const entry = await getVideoEl(i);
    if (!entry) return null;
    const dur = entry.v.duration || 0;
    await seekTo(entry.v, Math.max(0, Math.min(dur ? dur - 1e-3 : 0, src)));
    return entry.v;
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

  const isMp4 = profile.container !== "webm";
  // Stream straight to a file on disk when a writable is provided (no in-memory
  // size ceiling — needed for long videos whose file exceeds the max ArrayBuffer).
  const streaming = !!writable;
  let muxer;
  if (isMp4) {
    muxer = new MP4Muxer({
      target: streaming ? new MP4FileTarget(writable) : new MP4ArrayBufferTarget(),
      video: { codec: profile.muxerVideo, width: W, height: H },
      ...(wantAudio ? { audio: { codec: profile.muxerAudio, sampleRate: mixRate, numberOfChannels: mixChannels } } : {}),
      fastStart: streaming ? false : "in-memory",
    });
  } else {
    muxer = new WebMMuxer({
      target: streaming ? new WebMFileTarget(writable) : new WebMArrayBufferTarget(),
      video: { codec: profile.muxerVideo, width: W, height: H, frameRate: fps },
      ...(wantAudio ? { audio: { codec: profile.muxerAudio, numberOfChannels: mixChannels, sampleRate: mixRate } } : {}),
      ...(streaming ? { streaming: true } : {}),
    });
  }
  log(streaming ? "output: streaming to file" : "output: in-memory buffer");
  log(`video ${W}x${H} @ ${fps}fps, ${total.toFixed(1)}s, ${totalFrames} frames, codec ${profile.videoCodec}, bitrate ${(bitrate / 1e6).toFixed(1)} Mbps`);
  log(`audio: ${wantAudio ? `${mixRate}Hz ${mixChannels}ch — ${voiceBuffer ? "voiceover" : "no voiceover"}, ${clipAudio.length} clip track(s)` : "none"}`);
  let encErr = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => { encErr = e; log(`video encoder error: ${e && e.message ? e.message : e}`); },
  });
  encoder.configure({ codec: profile.videoCodec, width: W, height: H, framerate: fps, bitrate, ...(isMp4 ? { avc: { format: "avc" } } : {}) });

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
    bail();
    // Backpressure: never queue frames faster than the encoder drains them, or
    // pending frames + encoded chunks pile up in memory and the tab crashes.
    while (encoder.encodeQueueSize > 4) await yielder.tick();

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
    // Free the hardware decoder of clips we've moved past (access is monotonic).
    for (const [k, s] of videoSources) { if (s && s.close && k < idx - 1) { try { s.close(); } catch (_) {} videoSources.set(k, null); } }
    const clip = clips[idx];
    const type = idx > 0 ? (transitions[idx] || "cut") : "cut";
    const tdur = type === "cut" ? 0 : Math.min(transitionDuration, clip.duration);

    if (idx > 0 && tdur > 0 && t < clip.start + tdur) {
      // Inside a transition: blend previous image -> current with the exact painter
      // the preview uses, each drawn at its own current zoom. (getBmp(idx-1) then
      // getBmp(idx): both stay in the ±2 cache window, so neither is evicted.)
      const p = Math.min(1, Math.max(0, (t - clip.start) / tdur));
      const prevFrame = await getFrame(idx - 1, t);
      const curFrame = await getFrame(idx, t);
      transitionOf(type).canvas(ctx, prevFrame, curFrame, p, W, H, scaleAt(idx - 1, t), scaleAt(idx, t));
      ctx.globalAlpha = 1;
    } else {
      drawContain(ctx, await getFrame(idx, t), W, H, scaleAt(idx, t), 1);
    }

    // Captions drawn on top of the images.
    if (hasCaptions) {
      const cap = captionAt(cues, t);
      if (cap) drawCaption(ctx, cap, W, H, captionStyle, capFontPx, captionLineHeight);
    }

    const frame = new VideoFrame(canvas, { timestamp: Math.round((f * 1e6) / fps), duration: Math.round(1e6 / fps) });
    encoder.encode(frame, { keyFrame: f % (fps * 2) === 0 });
    frame.close();

    if (f % 8 === 0) report(0.9 * (f / totalFrames), "Rendering");
  }

  await encoder.flush();
  if (encErr) throw encErr;
  log("video frames encoded");

  // Mix (voiceover + clip audio), then encode the track and mux it in.
  if (wantAudio) {
    report(0.9, "Finalizing audio");
    const mixed = await mixAudio();
    if (mixed) {
      log("audio mixed");
      const sampleRate = mixed.sampleRate;
      const chans = mixed.channels;
      const channels = chans.length;
      let aChunks = 0;
      const audioEnc = new AudioEncoder({ output: (c, m) => { aChunks++; muxer.addAudioChunk(c, m); }, error: (e) => { encErr = e; log(`audio encoder error: ${e && e.message ? e.message : e}`); } });
      audioEnc.configure({ codec: audioCodec, sampleRate, numberOfChannels: channels, bitrate: 192000 });
      const totalSamples = Math.min(mixed.length, Math.ceil(total * sampleRate));
      const STEP = 4096; // samples per AudioData chunk
      for (let off = 0; off < totalSamples; off += STEP) {
        if (encErr) throw encErr;
        bail();
        const n = Math.min(STEP, totalSamples - off);
        const planar = new Float32Array(n * channels); // f32-planar: [ch0…, ch1…]
        for (let c = 0; c < channels; c++) planar.set(chans[c].subarray(off, off + n), c * n);
        const adata = new AudioData({ format: "f32-planar", sampleRate, numberOfFrames: n, numberOfChannels: channels, timestamp: Math.round((off / sampleRate) * 1e6), data: planar });
        audioEnc.encode(adata);
        adata.close();
        if (off % (STEP * 32) === 0) report(0.9 + 0.08 * (off / totalSamples), "Finalizing audio");
        while (audioEnc.encodeQueueSize > 8) await yielder.tick();
      }
      await audioEnc.flush();
      if (encErr) throw encErr;
      log(`audio encoded: ${aChunks} chunk(s)${aChunks === 0 ? " — WARNING: encoder produced no audio" : ""}`);
    } else {
      log("audio mix returned nothing (encoding video-only track)");
    }
  }

  report(0.98, "Muxing");
  muxer.finalize();
  for (const b of cache.values()) if (b && b.close) b.close();
  for (const e of videoEls.values()) { if (e && e.v) { try { e.v.pause(); e.v.removeAttribute("src"); e.v.load(); } catch (_) {} } if (e && e.url) { try { URL.revokeObjectURL(e.url); } catch (_) {} } }
  for (const s of videoSources.values()) { if (s && s.close) { try { s.close(); } catch (_) {} } }
  yielder.done();
  if (streaming) {
    await writable.close();
    log("done: saved to file");
    report(1, "Done");
    return null; // already written to disk
  }
  const blob = new Blob([muxer.target.buffer], { type: isMp4 ? "video/mp4" : "video/webm" });
  log(`done: ${(blob.size / (1024 * 1024)).toFixed(1)} MB`);
  report(1, "Done");
  return blob;
}
