// Target waveform resolution once zoomed all the way in, and the hard cap on
// how many buckets we'll ever compute (keeps memory/SVG rect count sane on
// very long narrations). At 10/sec a 0.5s pause between sentences still shows
// as a clear dip — the old fixed 480 buckets gave ~3.75s/bucket on a 30-minute
// voiceover, which flattened every silence into noise.
const SAMPLES_PER_SEC = 10;
const MIN_BUCKETS = 480;
const MAX_BUCKETS = 20000;

// Decode an audio file into normalized peak amplitudes for the waveform lane.
// `buckets` can be forced explicitly; otherwise it's derived from the file's
// own duration so silences stay visible no matter how long the track is.
// Returns [] on any failure so the UI can fall back to a flat lane.
export async function getWaveformPeaks(file, buckets) {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return [];
    const ctx = new AC();
    const arr = await file.arrayBuffer();
    const audio = await ctx.decodeAudioData(arr);
    const data = audio.getChannelData(0);
    if (buckets == null) {
      buckets = Math.round((audio.duration || 0) * SAMPLES_PER_SEC);
      buckets = Math.min(MAX_BUCKETS, Math.max(MIN_BUCKETS, buckets));
    }
    const block = Math.floor(data.length / buckets) || 1;
    const peaks = new Array(buckets);
    let max = 0;
    for (let i = 0; i < buckets; i++) {
      let peak = 0;
      const start = i * block;
      for (let j = 0; j < block; j++) {
        const v = Math.abs(data[start + j] || 0);
        if (v > peak) peak = v;
      }
      peaks[i] = peak;
      if (peak > max) max = peak;
    }
    if (ctx.close) ctx.close();
    return max > 0 ? peaks.map((p) => p / max) : peaks;
  } catch {
    return [];
  }
}