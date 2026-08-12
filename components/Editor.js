"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Timeline from "./Timeline";

function tc(t) {
  if (!isFinite(t) || t < 0) t = 0;
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  const d = Math.floor((t * 10) % 10);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${d}`;
}

export default function Editor({
  clips, imageEls, audioUrl, duration, peaks, dims,
  aspect, setAspect, fps, setFps,
  onRender, busy, progress, outUrl, error, warnings,
  replaceImage, removeImage, fillGap,
}) {
  const canvasRef = useRef(null);
  const audioRef = useRef(null);
  const rafRef = useRef(0);
  const fileInputRef = useRef(null);
  const pending = useRef(null); // { mode: "replace" | "add", name }
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);

  const askReplace = useCallback((name) => {
    pending.current = { mode: "replace", name };
    if (fileInputRef.current) fileInputRef.current.click();
  }, []);

  const askAdd = useCallback((name) => {
    pending.current = { mode: "add", name };
    if (fileInputRef.current) fileInputRef.current.click();
  }, []);

  const onPickFile = useCallback((e) => {
    const file = e.target.files && e.target.files[0];
    const p = pending.current;
    if (file && p) {
      if (p.mode === "replace" && replaceImage) replaceImage(p.name, file);
      else if (p.mode === "add" && fillGap) fillGap(p.name, file);
    }
    e.target.value = "";
    pending.current = null;
  }, [replaceImage, fillGap]);

  const draw = useCallback((t) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const clip = clips.find((c) => t >= c.start && t < c.start + c.duration) || clips[clips.length - 1];
    if (!clip) return;
    const img = imageEls[clip.name];
    if (!img) return;
    const scale = Math.min(canvas.width / img.naturalWidth, canvas.height / img.naturalHeight);
    const w = img.naturalWidth * scale;
    const h = img.naturalHeight * scale;
    ctx.drawImage(img, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
  }, [clips, imageEls]);

  useEffect(() => { draw(time); }, [time, draw]);
  useEffect(() => { setTime(0); }, [audioUrl]);

  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    const loop = () => { setTime(a.currentTime); rafRef.current = requestAnimationFrame(loop); };
    const onPlay = () => { setPlaying(true); cancelAnimationFrame(rafRef.current); rafRef.current = requestAnimationFrame(loop); };
    const onStop = () => { setPlaying(false); cancelAnimationFrame(rafRef.current); setTime(a.currentTime); };
    a.addEventListener("play", onPlay);
    a.addEventListener("pause", onStop);
    a.addEventListener("ended", onStop);
    return () => {
      a.removeEventListener("play", onPlay);
      a.removeEventListener("pause", onStop);
      a.removeEventListener("ended", onStop);
      cancelAnimationFrame(rafRef.current);
    };
  }, [audioUrl]);

  const toggle = useCallback(() => {
    const a = audioRef.current;
    if (!a) return;
    if (a.paused) a.play(); else a.pause();
  }, []);

  const seek = useCallback((t) => {
    const a = audioRef.current;
    if (!a) return;
    const c = Math.min(Math.max(t, 0), duration);
    a.currentTime = c;
    setTime(c);
  }, [duration]);

  useEffect(() => {
    const onKey = (e) => {
      const tag = (e.target.tagName || "").toLowerCase();
      if (tag === "input" || tag === "select" || tag === "textarea") return;
      if (e.code === "Space") { e.preventDefault(); toggle(); }
      else if (e.code === "ArrowRight") { e.preventDefault(); seek(time + (e.shiftKey ? 5 : 1)); }
      else if (e.code === "ArrowLeft") { e.preventDefault(); seek(time - (e.shiftKey ? 5 : 1)); }
      else if (e.key === "Home") { e.preventDefault(); seek(0); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle, seek, time]);

  const active = clips.find((c) => time >= c.start && time < c.start + c.duration) || clips[clips.length - 1];
  const badClips = useMemo(
    () => new Set(clips.filter((c) => c.duration <= 0.0001).map((c) => c.name)),
    [clips]
  );
  const imageClips = useMemo(() => clips.filter((c) => !c.gap), [clips]);
  const imageCount = imageClips.length;
  const gapCount = clips.length - imageCount;
  const activeIndex = active && !active.gap ? imageClips.indexOf(active) + 1 : 0;

  return (
    <section className="editor">
      <div className="stage">
        <div className="viewer">
          <div className="viewer__frame" style={{ aspectRatio: `${dims.width} / ${dims.height}` }}>
            <canvas ref={canvasRef} width={dims.width} height={dims.height} className="viewer__canvas" />
          </div>

          <div className="transport">
            <button className="play" onClick={toggle} aria-label={playing ? "Pause" : "Play"}>
              {playing ? "❚❚" : "►"}
            </button>
            <div className="time">
              <span className="time__now">{tc(time)}</span>
              <span className="time__sep">/</span>
              <span className="time__total">{tc(duration)}</span>
            </div>
            <div className="transport__spacer" />
            {active && (
              <div className="nowclip">
                <span className="nowclip__k">now</span>
                {active.gap ? "empty gap" : `image ${activeIndex} / ${imageCount}`}
              </div>
            )}
          </div>

          <audio ref={audioRef} src={audioUrl} hidden />
        </div>

        <aside className="export">
          <h2 className="export__h">Export</h2>

          <label className="ctrl">
            <span className="ctrl__label">Aspect ratio</span>
            <span className="selectwrap">
              <select value={aspect} onChange={(e) => setAspect(e.target.value)}>
                <option value="16:9">16:9 — 1920×1080</option>
                <option value="9:16">9:16 — 1080×1920</option>
                <option value="auto">Auto — match images</option>
              </select>
            </span>
          </label>

          <label className="ctrl">
            <span className="ctrl__label">Frame rate</span>
            <span className="selectwrap">
              <select value={fps} onChange={(e) => setFps(+e.target.value)}>
                <option value={24}>24 fps</option>
                <option value={30}>30 fps</option>
              </select>
            </span>
          </label>

          <dl className="specs">
            <div className="spec"><dt>Resolution</dt><dd>{dims.width}×{dims.height}</dd></div>
            <div className="spec"><dt>Images</dt><dd>{imageCount}</dd></div>
            <div className="spec"><dt>Length</dt><dd>{tc(duration)}</dd></div>
          </dl>

          {gapCount > 0 && (
            <div className="note note--gap">
              {gapCount} empty {gapCount === 1 ? "gap" : "gaps"} — these render black.
              Use the <b>+</b> on the timeline to fill them.
            </div>
          )}

          <button className="render" onClick={onRender} disabled={busy}>
            {busy ? `Rendering… ${Math.round(progress * 100)}%` : "Render MP4"}
          </button>
          {busy && <div className="progress"><i style={{ width: `${Math.round(progress * 100)}%` }} /></div>}
          {outUrl && <a className="download" href={outUrl} download="story.mp4">↓ Download MP4</a>}
          {error && <div className="note note--bad">{error}</div>}

          <p className="export__hint">Renders in your browser with ffmpeg — nothing is uploaded.</p>
        </aside>
      </div>

      {warnings.length > 0 && (
        <div className="notes">
          {warnings.map((w, i) => <div className="note" key={i}>{w}</div>)}
        </div>
      )}

      <Timeline
        clips={clips}
        imageEls={imageEls}
        duration={duration}
        time={time}
        peaks={peaks}
        activeName={active && active.name}
        badClips={badClips}
        onSeek={seek}
        onReplace={askReplace}
        onRemove={removeImage}
        onAdd={askAdd}
      />

      <input
        ref={fileInputRef} type="file" accept="image/*" hidden
        onChange={onPickFile}
      />
    </section>
  );
}
