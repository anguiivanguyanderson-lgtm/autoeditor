// Talks to the local render backend (server/). Exposes the same renderVideo /
// cancelRender surface the old in-browser ffmpeg.wasm module had, so page.js is
// unchanged apart from its import. Assets are POSTed to the backend, progress
// streams back over SSE, and the finished MP4 is returned as a Blob.
//
// BASE is empty by default (same origin — the backend serves this static UI).
// For dev (frontend on :3000, backend on :4000) set NEXT_PUBLIC_RENDER_URL.
const BASE = process.env.NEXT_PUBLIC_RENDER_URL || "";

let _job = null; // { jobId, es } for the in-flight render, so cancel can reach it

export async function renderVideo(opts) {
  const {
    clips, imagesByName, audioFile, width, height, fps = 30,
    transitions, transitionDuration = 0.4, fadeIn = 0, fadeOut = 0,
    captions = null, captionStyle = "classic", captionSize = "md",
    onProgress,
  } = opts;

  const spec = {
    clips, width, height, fps,
    transitions, transitionDuration, fadeIn, fadeOut,
    captions, captionStyle, captionSize,
  };

  const fd = new FormData();
  fd.append("spec", JSON.stringify(spec));
  fd.append("audio", audioFile, audioFile.name);
  // Each image is a field keyed by its clip name; gap clips have no image and
  // the backend renders them black.
  for (const [name, file] of Object.entries(imagesByName)) fd.append(name, file, file.name);

  let res;
  try {
    res = await fetch(`${BASE}/render`, { method: "POST", body: fd });
  } catch {
    throw new Error("Render server not reachable — is it running?");
  }
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new Error(e.error || `Render request failed (${res.status})`);
  }
  const { jobId } = await res.json();

  await new Promise((resolve, reject) => {
    const es = new EventSource(`${BASE}/render/${jobId}/events`);
    _job = { jobId, es };
    es.onmessage = (ev) => {
      let d;
      try { d = JSON.parse(ev.data); } catch { return; }
      if (d.progress != null && onProgress) onProgress(d.progress);
      if (d.done) { es.close(); resolve(); }
      if (d.error) { es.close(); reject(new Error(d.error)); }
    };
    es.onerror = () => { es.close(); reject(new Error("Lost connection to the render server")); };
  });

  const fileRes = await fetch(`${BASE}/render/${jobId}/file`);
  _job = null;
  if (!fileRes.ok) throw new Error("Render finished but the file could not be fetched");
  return await fileRes.blob();
}

export function cancelRender() {
  if (!_job) return;
  const { jobId, es } = _job;
  try { es.close(); } catch { /* already closed */ }
  fetch(`${BASE}/render/${jobId}/cancel`, { method: "POST" }).catch(() => {});
  _job = null;
}
