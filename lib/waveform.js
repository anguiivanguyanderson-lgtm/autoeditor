// Decode an audio file into normalized peak amplitudes for the waveform lane.
// Returns [] on any failure so the UI can fall back to a flat lane.
export async function getWaveformPeaks(file, buckets = 480) {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return [];
    const ctx = new AC();
    const arr = await file.arrayBuffer();
    const audio = await ctx.decodeAudioData(arr);
    const data = audio.getChannelData(0);
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
