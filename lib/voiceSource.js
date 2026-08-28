// Streaming voiceover reader. Instead of decoding the whole voiceover into one big
// in-memory PCM block (~600 MB for 26 min — the buffer that made long renders drop
// audio / OOM on phones), this hands the audio back as small per-window slices:
//
//   • WAV  → read straight from the file (it's already raw PCM — no decode at all).
//   • else → decode ONCE, offload the PCM to an OPFS scratch file on disk, free the
//            in-memory buffer, then read slices back from disk. Falls back to keeping
//            the decoded buffer in memory if OPFS isn't available (no worse than before).
//
// Access must be monotonic in `off` (the render advances forward), so each source keeps
// a small sequential read buffer instead of the whole track.
//
// createVoiceSource(file) -> { sampleRate, numberOfChannels, length, read(off,n), dispose } | null
//   read(off, n) -> Promise<Float32Array[]>  (one array of length n per channel, zero-padded past the end)

// ---- WAV ------------------------------------------------------------------
function parseWavHeader(buf) {
  const dv = new DataView(buf);
  if (dv.byteLength < 12) return null;
  const tag = (o) => String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") return null;
  let off = 12, fmt = null, dataOffset = -1, dataSize = 0;
  while (off + 8 <= dv.byteLength) {
    const id = tag(off);
    const size = dv.getUint32(off + 4, true);
    const body = off + 8;
    if (id === "fmt ") {
      let audioFormat = dv.getUint16(body, true);
      const channels = dv.getUint16(body + 2, true);
      const sampleRate = dv.getUint32(body + 4, true);
      const bitsPerSample = dv.getUint16(body + 14, true);
      // WAVE_FORMAT_EXTENSIBLE: the real format is the first 2 bytes of the SubFormat GUID.
      if (audioFormat === 0xfffe && size >= 40) audioFormat = dv.getUint16(body + 24, true);
      fmt = { audioFormat, channels, sampleRate, bitsPerSample };
    } else if (id === "data") {
      dataOffset = body; dataSize = size;
      if (fmt) break; // data is usually last; stop once we have both
    }
    off = body + size + (size & 1); // chunks are word-aligned
  }
  if (!fmt || dataOffset < 0) return null;
  const bytesPerSample = fmt.bitsPerSample >> 3;
  if (!bytesPerSample || !fmt.channels || (fmt.audioFormat !== 1 && fmt.audioFormat !== 3)) return null;
  return { ...fmt, bytesPerSample, blockAlign: fmt.channels * bytesPerSample, dataOffset, dataSize };
}

function sampleReader(bytesPerSample, audioFormat) {
  if (audioFormat === 3) return (dv, o) => dv.getFloat32(o, true);          // 32-bit float
  if (bytesPerSample === 2) return (dv, o) => dv.getInt16(o, true) / 32768; // 16-bit PCM
  if (bytesPerSample === 3) return (dv, o) => {                             // 24-bit PCM
    let v = dv.getUint8(o) | (dv.getUint8(o + 1) << 8) | (dv.getUint8(o + 2) << 16);
    if (v & 0x800000) v -= 0x1000000;
    return v / 8388608;
  };
  if (bytesPerSample === 4) return (dv, o) => dv.getInt32(o, true) / 2147483648; // 32-bit PCM
  if (bytesPerSample === 1) return (dv, o) => (dv.getUint8(o) - 128) / 128;      // 8-bit unsigned
  return null;
}

async function wavSource(file) {
  const head = await file.slice(0, Math.min(file.size, 65536)).arrayBuffer();
  const h = parseWavHeader(head);
  if (!h) return null;
  const read1 = sampleReader(h.bytesPerSample, h.audioFormat);
  if (!read1) return null;
  const dataEnd = h.dataSize > 0 ? Math.min(file.size, h.dataOffset + h.dataSize) : file.size;
  const length = Math.max(0, Math.floor((dataEnd - h.dataOffset) / h.blockAlign));
  const channels = h.channels;
  const BLOCK = 1 << 18; // samples per file read (~256k)
  let blk = null;
  async function ensure(start, needed) {
    if (blk && start >= blk.start && start + needed <= blk.end) return;
    const end = Math.min(length, start + Math.max(BLOCK, needed));
    const ab = await file.slice(h.dataOffset + start * h.blockAlign, h.dataOffset + end * h.blockAlign).arrayBuffer();
    blk = { start, end, dv: new DataView(ab) };
  }
  async function read(off, n) {
    const out = Array.from({ length: channels }, () => new Float32Array(n));
    const avail = Math.max(0, Math.min(n, length - off));
    if (avail <= 0) return out;
    await ensure(off, avail);
    for (let i = 0; i < avail; i++) {
      const base = (off + i - blk.start) * h.blockAlign;
      for (let c = 0; c < channels; c++) out[c][i] = read1(blk.dv, base + c * h.bytesPerSample);
    }
    return out;
  }
  return { sampleRate: h.sampleRate, numberOfChannels: channels, length, read, dispose: () => { blk = null; } };
}

// ---- Compressed (decode → OPFS offload, or in-memory fallback) -------------
async function opfsOffload(audioBuf, sampleRate, channels, length) {
  if (!(navigator.storage && navigator.storage.getDirectory)) return null;
  const name = `voice-${Date.now()}-${Math.random().toString(36).slice(2)}.pcm`;
  let fh;
  try {
    const root = await navigator.storage.getDirectory();
    fh = await root.getFileHandle(name, { create: true });
    const writable = await fh.createWritable();
    const chans = Array.from({ length: channels }, (_, c) => audioBuf.getChannelData(c));
    const CHUNK = 1 << 16; // samples per write, interleaved f32
    for (let off = 0; off < length; off += CHUNK) {
      const n = Math.min(CHUNK, length - off);
      const inter = new Float32Array(n * channels);
      for (let i = 0; i < n; i++) for (let c = 0; c < channels; c++) inter[i * channels + c] = chans[c][off + i];
      await writable.write(inter.buffer);
    }
    await writable.close();
  } catch (_) {
    try { const r = await navigator.storage.getDirectory(); await r.removeEntry(name); } catch (__) {}
    return null;
  }
  const bpf = channels * 4; // bytes per interleaved frame
  const BLOCK = 1 << 18;
  let blk = null;
  async function ensure(start, needed) {
    if (blk && start >= blk.start && start + needed <= blk.end) return;
    const end = Math.min(length, start + Math.max(BLOCK, needed));
    const f = await fh.getFile();
    const ab = await f.slice(start * bpf, end * bpf).arrayBuffer();
    blk = { start, end, arr: new Float32Array(ab) };
  }
  async function read(off, n) {
    const out = Array.from({ length: channels }, () => new Float32Array(n));
    const avail = Math.max(0, Math.min(n, length - off));
    if (avail <= 0) return out;
    await ensure(off, avail);
    for (let i = 0; i < avail; i++) {
      const base = (off + i - blk.start) * channels;
      for (let c = 0; c < channels; c++) out[c][i] = blk.arr[base + c];
    }
    return out;
  }
  async function dispose() { blk = null; try { const r = await navigator.storage.getDirectory(); await r.removeEntry(name); } catch (_) {} }
  return { sampleRate, numberOfChannels: channels, length, read, dispose };
}

async function decodedSource(file) {
  const AC = typeof window !== "undefined" && (window.AudioContext || window.webkitAudioContext);
  if (!AC) return null;
  let ctx = null, audioBuf = null;
  try {
    ctx = new AC();
    audioBuf = await ctx.decodeAudioData(await file.arrayBuffer());
  } catch (_) { try { ctx && ctx.close(); } catch (__) {} return null; }
  try { ctx.close(); } catch (_) {}
  const sampleRate = audioBuf.sampleRate, channels = audioBuf.numberOfChannels, length = audioBuf.length;
  const off = await opfsOffload(audioBuf, sampleRate, channels, length).catch(() => null);
  if (off) { audioBuf = null; return off; } // big PCM released; read from disk
  // Fallback: keep the decoded buffer in memory (same as the old behaviour).
  const chans = Array.from({ length: channels }, (_, c) => audioBuf.getChannelData(c));
  async function read(o, n) {
    const out = [];
    for (let c = 0; c < channels; c++) {
      const w = new Float32Array(n), src = chans[c];
      const lim = Math.max(0, Math.min(n, src.length - o));
      if (lim > 0) w.set(src.subarray(o, o + lim));
      out.push(w);
    }
    return out;
  }
  return { sampleRate, numberOfChannels: channels, length, read, dispose: () => {} };
}

// Wrap a source so it outputs at `targetRate` (linear interpolation). Needed because a
// file's native rate (e.g. a 32 kHz WAV) may not be one the AAC encoder accepts — it
// only supports 44100/48000 — and reading native rate would make configure() fail.
function resampleSource(src, targetRate) {
  if (!src || src.sampleRate === targetRate) return src;
  const ratio = src.sampleRate / targetRate; // native samples per output sample
  const channels = src.numberOfChannels;
  const length = Math.max(0, Math.round(src.length / ratio));
  async function read(off, n) {
    const out = Array.from({ length: channels }, () => new Float32Array(n));
    if (n <= 0) return out;
    const ni0 = Math.floor(off * ratio);
    const niEnd = Math.min(src.length, Math.ceil((off + n) * ratio) + 2);
    const need = Math.max(0, niEnd - ni0);
    if (need <= 0) return out;
    const win = await src.read(ni0, need);
    for (let i = 0; i < n; i++) {
      const pos = (off + i) * ratio - ni0;
      const i0 = Math.floor(pos);
      if (i0 < 0 || i0 >= need) continue;
      const frac = pos - i0, i1 = Math.min(i0 + 1, need - 1);
      for (let c = 0; c < channels; c++) { const a = win[c][i0] || 0, b = win[c][i1] || 0; out[c][i] = a + (b - a) * frac; }
    }
    return out;
  }
  return { sampleRate: targetRate, numberOfChannels: channels, length, read, dispose: () => { try { src.dispose && src.dispose(); } catch (_) {} } };
}

export async function createVoiceSource(file, allowedRates = [48000, 44100]) {
  if (!file) return null;
  let src = null;
  try { const w = await wavSource(file); if (w && w.length > 0) src = w; } catch (_) {}
  if (!src) { try { src = await decodedSource(file); } catch (_) { src = null; } }
  if (!src) return null;
  // Force a rate the AAC encoder accepts (resample only when the native rate isn't one).
  if (allowedRates && allowedRates.length && !allowedRates.includes(src.sampleRate)) src = resampleSource(src, allowedRates[0]);
  return src;
}
