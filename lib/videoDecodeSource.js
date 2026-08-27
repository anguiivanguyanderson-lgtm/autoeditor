// Sequential MP4 → VideoDecoder frame source.
//
// Demuxes a clip ONCE (mp4box), then feeds its encoded chunks to a hardware
// VideoDecoder IN ORDER and hands back the decoded frame for a given source
// time — no per-frame seeking. This mirrors ffmpeg's streaming decode, so video
// clips render fast instead of re-decoding from a keyframe every output frame
// (which is what the <video>.currentTime seek path does, and why it's slow on
// mobile). Access MUST be monotonic in time (the render advances forward), which
// the render loop guarantees per clip.
import { createFile, DataStream } from "mp4box";

// Extract the codec description (avcC/hvcC/…) bytes VideoDecoder.configure needs.
function descriptionOf(trak) {
  const entry = trak.mdia.minf.stbl.stsd.entries[0];
  const box = entry.avcC || entry.hvcC || entry.vpcC || entry.av1C;
  if (!box) return null;
  const stream = new DataStream(undefined, 0, DataStream.BIG_ENDIAN);
  box.write(stream);
  return new Uint8Array(stream.buffer, 8); // strip the 8-byte box header (size+type)
}

// Returns { frameAt(srcSec) -> VideoFrame|null, close() } or null if the clip
// can't be hardware-decoded (caller then falls back to the seek path).
export async function createVideoSource(file) {
  if (typeof VideoDecoder === "undefined" || typeof EncodedVideoChunk === "undefined") return null;
  let mp4;
  try { mp4 = createFile(); } catch (_) { return null; }

  const chunks = [];
  let track = null, description = null;

  const ready = new Promise((resolve, reject) => {
    mp4.onError = (e) => reject(new Error("demux error: " + e));
    mp4.onReady = (info) => {
      const vt = info.videoTracks && info.videoTracks[0];
      if (!vt) { reject(new Error("no video track")); return; }
      track = vt;
      try { description = descriptionOf(mp4.getTrackById(vt.id)); } catch (_) { description = null; }
      mp4.onSamples = (id, user, samples) => {
        for (const s of samples) {
          chunks.push(new EncodedVideoChunk({
            type: s.is_sync ? "key" : "delta",
            timestamp: Math.round((s.cts / s.timescale) * 1e6),
            duration: Math.round((s.duration / s.timescale) * 1e6),
            data: s.data,
          }));
        }
      };
      mp4.setExtractionOptions(vt.id, null, { nbSamples: 1e9 });
      mp4.start();
      resolve();
    };
  });

  try {
    const ab = await file.arrayBuffer();
    ab.fileStart = 0;
    mp4.appendBuffer(ab);
    mp4.flush();
    await ready;
  } catch (_) { return null; }
  if (!track || !chunks.length) return null;

  const config = {
    codec: track.codec,
    codedWidth: (track.video && track.video.width) || track.track_width,
    codedHeight: (track.video && track.video.height) || track.track_height,
  };
  if (description) config.description = description;
  try {
    const sup = await VideoDecoder.isConfigSupported(config);
    if (!sup || !sup.supported) return null;
  } catch (_) { return null; }

  let decErr = null;
  const frames = []; // decoded VideoFrames, ascending presentation timestamp (µs)
  let decoder;
  try {
    decoder = new VideoDecoder({ output: (f) => frames.push(f), error: (e) => { decErr = e; } });
    decoder.configure(config);
  } catch (_) { return null; }

  let fedIndex = 0, flushed = false;
  const tick = () => new Promise((r) => setTimeout(r, 0));

  function dropOlderThan(ts) {
    // Keep the frame that is current for ts (largest ≤ ts) plus what follows.
    while (frames.length > 1 && frames[1].timestamp <= ts) {
      const old = frames.shift(); try { old.close(); } catch (_) {}
    }
  }

  async function frameAt(srcSec) {
    if (decErr) throw decErr;
    const target = Math.max(0, srcSec) * 1e6;
    // Decode forward until a frame at/after target exists (or the clip ended).
    while (true) {
      if (decErr) throw decErr;
      const last = frames.length ? frames[frames.length - 1].timestamp : -1;
      if ((frames.length && last >= target) || (fedIndex >= chunks.length && flushed)) break;
      while (fedIndex < chunks.length && decoder.decodeQueueSize < 8) decoder.decode(chunks[fedIndex++]);
      if (fedIndex >= chunks.length && !flushed) { try { await decoder.flush(); } catch (e) { decErr = e; } flushed = true; }
      else await tick();
    }
    dropOlderThan(target);
    let cur = frames[0] || null;
    for (const fr of frames) { if (fr.timestamp <= target) cur = fr; else break; }
    return cur;
  }

  function close() {
    try { decoder.close(); } catch (_) {}
    for (const fr of frames) { try { fr.close(); } catch (_) {} }
    frames.length = 0;
  }

  return { frameAt, close, width: config.codedWidth, height: config.codedHeight };
}
