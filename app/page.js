"use client";
import { useCallback, useMemo, useState } from "react";
import "./globals.css";
import { parseTimestampName } from "../lib/timestamp";
import { buildTimeline } from "../lib/timeline";
import { resolveDimensions } from "../lib/dimensions";
import { getAudioDuration } from "../lib/audio";
import { renderVideo } from "../lib/ffmpegRender";
import PreviewPlayer from "../components/PreviewPlayer";

function loadImageEl(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve({ img, url });
    img.src = url;
  });
}

export default function Home() {
  const [audioFile, setAudioFile] = useState(null);
  const [audioUrl, setAudioUrl] = useState(null);
  const [audioDuration, setAudioDuration] = useState(0);
  const [imagesByName, setImagesByName] = useState({});
  const [imageEls, setImageEls] = useState({});
  const [items, setItems] = useState([]);
  const [aspect, setAspect] = useState("16:9");
  const [fps, setFps] = useState(30);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [outUrl, setOutUrl] = useState(null);
  const [error, setError] = useState(null);

  const onAudio = useCallback(async (file) => {
    if (!file) return;
    setError(null);
    try {
      const d = await getAudioDuration(file);
      setAudioFile(file);
      setAudioUrl(URL.createObjectURL(file));
      setAudioDuration(d);
    } catch (e) { setError(e.message); }
  }, []);

  const onImages = useCallback(async (fileList) => {
    const files = Array.from(fileList).filter((f) => f.type.startsWith("image/"));
    const byName = {}, els = {}, its = [];
    for (const f of files) {
      byName[f.name] = f;
      its.push({ name: f.name, seconds: parseTimestampName(f.name) });
      const { img, url } = await loadImageEl(f);
      els[f.name] = img; els[f.name].url = url;
    }
    setImagesByName(byName); setImageEls(els); setItems(its);
  }, []);

  const sample = useMemo(() => {
    const first = items.find((i) => imageEls[i.name]);
    const el = first && imageEls[first.name];
    return el ? { width: el.naturalWidth, height: el.naturalHeight } : null;
  }, [items, imageEls]);

  const dims = useMemo(() => resolveDimensions(aspect, sample), [aspect, sample]);
  const { clips, warnings } = useMemo(
    () => buildTimeline(items, audioDuration),
    [items, audioDuration]
  );

  const ready = audioFile && clips.length > 0;

  const onRender = useCallback(async () => {
    setBusy(true); setError(null); setOutUrl(null); setProgress(0);
    try {
      const blob = await renderVideo({
        clips, imagesByName, audioFile,
        width: dims.width, height: dims.height, fps,
        onProgress: setProgress,
      });
      setOutUrl(URL.createObjectURL(blob));
    } catch (e) { setError(e.message || String(e)); }
    finally { setBusy(false); }
  }, [clips, imagesByName, audioFile, dims, fps]);

  return (
    <main className="wrap">
      <h1>Story → Video Assembler</h1>
      <p className="sub">Upload one voiceover + timestamp-named images → download an MP4.</p>

      <div className="card">
        <div className="row">
          <label className="drop" style={{ flex: 1 }}>
            {audioFile ? `Audio: ${audioFile.name} (${audioDuration.toFixed(1)}s)` : "Choose voiceover audio"}
            <input type="file" accept="audio/*" hidden onChange={(e) => onAudio(e.target.files[0])} />
          </label>
          <label className="drop" style={{ flex: 1 }}>
            {items.length ? `${items.length} images loaded` : "Choose timestamp-named images"}
            <input type="file" accept="image/*" multiple hidden onChange={(e) => onImages(e.target.files)} />
          </label>
        </div>

        <div className="row" style={{ marginTop: 16 }}>
          <label className="field">Aspect
            <select value={aspect} onChange={(e) => setAspect(e.target.value)}>
              <option value="16:9">16:9 (1920×1080)</option>
              <option value="9:16">9:16 (1080×1920)</option>
              <option value="auto">Auto (match images)</option>
            </select>
          </label>
          <label className="field">FPS
            <select value={fps} onChange={(e) => setFps(+e.target.value)}>
              <option value={24}>24</option>
              <option value={30}>30</option>
            </select>
          </label>
          <span className="field">Output: {dims.width}×{dims.height}</span>
        </div>

        {warnings.map((w, i) => <div className="warn" key={i}>⚠ {w}</div>)}
      </div>

      {ready && (
        <div className="card">
          <PreviewPlayer
            clips={clips}
            imageEls={imageEls}
            audioUrl={audioUrl}
            width={dims.width}
            height={dims.height}
          />
          <div className="row" style={{ marginTop: 16 }}>
            <button className="primary" onClick={onRender} disabled={busy}>
              {busy ? "Rendering…" : "Render MP4"}
            </button>
            {outUrl && <a className="dl" href={outUrl} download="story.mp4">Download MP4</a>}
            {error && <span className="warn">Error: {error}</span>}
          </div>
          {busy && <div className="bar"><i style={{ width: `${Math.round(progress * 100)}%` }} /></div>}
        </div>
      )}
    </main>
  );
}
