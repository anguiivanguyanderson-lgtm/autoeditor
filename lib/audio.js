// Decode an uploaded audio File and return its duration in seconds.
// Uses a detached <audio> element (works for mp3/wav across browsers).
export function getAudioDuration(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const el = document.createElement("audio");
    el.preload = "metadata";
    el.onloadedmetadata = () => {
      const d = el.duration;
      URL.revokeObjectURL(url);
      if (!isFinite(d) || d <= 0) reject(new Error("Could not read audio duration"));
      else resolve(d);
    };
    el.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Could not load audio file"));
    };
    el.src = url;
  });
}
