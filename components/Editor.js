"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Timeline from "./Timeline";
import {
  TRANSITION_LIST, transitionOf,
  MIN_TRANSITION_DURATION, MAX_TRANSITION_DURATION,
} from "../lib/transitions";

const MOTIONS = [
  { id: "none", label: "None", icon: "▮" },
  { id: "zoomin", label: "Zoom in", icon: "⤢" },
  { id: "zoomout", label: "Zoom out", icon: "⤡" },
];

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
  transitionsByName, transitionDuration, setTransition, applyTransitionAll, setTransitionDuration,
  motionByName, setMotion, applyMotionAll, applyMotionAlternate, motionAmount, setMotionAmount,
  fadeIn, setFadeIn, fadeOut, setFadeOut,
}) {
  const canvasRef = useRef(null);
  const audioRef = useRef(null);
  const rafRef = useRef(0);
  const fileInputRef = useRef(null);
  const pending = useRef(null); // { mode: "replace" | "add", name }
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [selectedCut, setSelectedCut] = useState(null); // selected clip name (drives transition + motion)
  const [currentType, setCurrentType] = useState("fade");
  const [currentMotion, setCurrentMotion] = useState("zoomin");

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
    const W = canvas.width, H = canvas.height;
    ctx.globalAlpha = 1;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, W, H);

    // Per-clip Ken Burns scale at time tt (gaps never zoom). Progress is clamped
    // so an outgoing image keeps its end-of-clip zoom through the transition.
    const scaleAt = (ci, tt) => {
      const c = clips[ci];
      if (!c || c.gap) return 1;
      const m = motionByName[c.name] || "none";
      if (m === "none") return 1;
      const lp = c.duration > 0 ? Math.min(1, Math.max(0, (tt - c.start) / c.duration)) : 0;
      return m === "zoomout" ? 1 + motionAmount * (1 - lp) : 1 + motionAmount * lp;
    };

    if (clips.length) {
      let idx = clips.findIndex((c) => t >= c.start && t < c.start + c.duration);
      if (idx === -1) idx = clips.length - 1;
      const clip = clips[idx];
      const type = idx > 0 ? (transitionsByName[clip.name] || "cut") : "cut";
      const tdur = type === "cut" ? 0 : Math.min(transitionDuration, clip.duration);

      if (idx > 0 && tdur > 0 && t < clip.start + tdur) {
        // Inside a transition: blend the previous image into this one, each at
        // its own current zoom so nothing snaps back to normal size.
        const p = Math.min(1, Math.max(0, (t - clip.start) / tdur));
        transitionOf(type).canvas(
          ctx, imageEls[clips[idx - 1].name] || null, imageEls[clip.name] || null,
          p, W, H, scaleAt(idx - 1, t), scaleAt(idx, t)
        );
        ctx.globalAlpha = 1;
      } else {
        const img = imageEls[clip.name];
        if (img) {
          const scale = Math.min(W / img.naturalWidth, H / img.naturalHeight) * scaleAt(idx, t);
          const w = img.naturalWidth * scale, h = img.naturalHeight * scale;
          ctx.drawImage(img, (W - w) / 2, (H - h) / 2, w, h);
        }
      }
    }

    // Scene fades (opening / ending).
    if (fadeIn > 0 && t < fadeIn) {
      ctx.globalAlpha = Math.max(0, 1 - t / fadeIn);
      ctx.fillStyle = "#000"; ctx.fillRect(0, 0, W, H); ctx.globalAlpha = 1;
    }
    const outStart = duration - fadeOut;
    if (fadeOut > 0 && t > outStart) {
      ctx.globalAlpha = Math.min(1, (t - outStart) / fadeOut);
      ctx.fillStyle = "#000"; ctx.fillRect(0, 0, W, H); ctx.globalAlpha = 1;
    }
  }, [clips, imageEls, transitionsByName, transitionDuration, motionByName, motionAmount, fadeIn, fadeOut, duration]);

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

  const selectClip = useCallback((name) => {
    setSelectedCut(name);
    setCurrentType(transitionsByName[name] || "cut");
    setCurrentMotion(motionByName[name] || "none");
  }, [transitionsByName, motionByName]);

  const pickType = useCallback((type) => {
    setCurrentType(type);
    if (selectedCut) setTransition(selectedCut, type);
  }, [selectedCut, setTransition]);

  const pickMotion = useCallback((type) => {
    setCurrentMotion(type);
    if (selectedCut) setMotion(selectedCut, type);
  }, [selectedCut, setMotion]);

  const selectedClip = selectedCut && clips.find((c) => c.name === selectedCut);
  const selectedIndex = selectedClip ? clips.indexOf(selectedClip) : -1;
  const selectedImageNum = selectedClip && !selectedClip.gap ? imageClips.indexOf(selectedClip) + 1 : 0;
  const imageNames = useMemo(() => imageClips.map((c) => c.name), [imageClips]);

  return (
    <section className="editor">
      <div className="main">
        <div className="viewer">
          <div className="viewer__frame">
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

        {warnings.length > 0 && (
          <div className="notes notes--compact">
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
          transitionsByName={transitionsByName}
          motionByName={motionByName}
          selectedName={selectedCut}
          onSelect={selectClip}
          onSeek={seek}
          onReplace={askReplace}
          onRemove={removeImage}
          onAdd={askAdd}
        />
      </div>

      <aside className="side">
        <div className="panel export">
          <h2 className="panel__h">Export</h2>

          <div className="ctrl-row">
            <label className="ctrl">
              <span className="ctrl__label">Aspect</span>
              <span className="selectwrap">
                <select value={aspect} onChange={(e) => setAspect(e.target.value)}>
                  <option value="16:9">16:9 — 1920×1080</option>
                  <option value="9:16">9:16 — 1080×1920</option>
                  <option value="auto">Auto — match</option>
                </select>
              </span>
            </label>
            <label className="ctrl">
              <span className="ctrl__label">FPS</span>
              <span className="selectwrap">
                <select value={fps} onChange={(e) => setFps(+e.target.value)}>
                  <option value={24}>24 fps</option>
                  <option value={30}>30 fps</option>
                </select>
              </span>
            </label>
          </div>

          <dl className="specs">
            <div className="spec"><dt>Resolution</dt><dd>{dims.width}×{dims.height}</dd></div>
            <div className="spec"><dt>Images</dt><dd>{imageCount}</dd></div>
            <div className="spec"><dt>Length</dt><dd>{tc(duration)}</dd></div>
          </dl>

          {gapCount > 0 && (
            <div className="note note--gap">
              {gapCount} empty {gapCount === 1 ? "gap" : "gaps"} render black — fill with the <b>+</b>.
            </div>
          )}

          <button className="render" onClick={onRender} disabled={busy}>
            {busy ? `Rendering… ${Math.round(progress * 100)}%` : "Render MP4"}
          </button>
          {busy && <div className="progress"><i style={{ width: `${Math.round(progress * 100)}%` }} /></div>}
          {outUrl && <a className="download" href={outUrl} download="story.mp4">↓ Download MP4</a>}
          {error && <div className="note note--bad">{error}</div>}
        </div>

        <div className="panel">
          <h2 className="panel__h">Motion &amp; fades</h2>

          <div className="mini-h">
            {selectedImageNum ? `Zoom — image ${selectedImageNum}` : "Zoom — select an image on the timeline"}
          </div>
          <div className="transitions__chips">
            {MOTIONS.map((m) => (
              <button
                key={m.id}
                type="button"
                className={`trchip ${currentMotion === m.id ? "is-on" : ""}`}
                onClick={() => pickMotion(m.id)}
              >
                <span className="trchip__icon">{m.icon}</span>{m.label}
              </button>
            ))}
          </div>
          <label className="trdur">
            <span>Amount</span>
            <input
              type="range" min={0.02} max={0.2} step={0.01}
              value={motionAmount} onChange={(e) => setMotionAmount(+e.target.value)}
            />
            <span className="trdur__val">{Math.round(motionAmount * 100)}%</span>
          </label>
          <div className="btn-row">
            <button type="button" className="trall" onClick={() => applyMotionAll(currentMotion, imageNames)}>
              Apply to all
            </button>
            <button type="button" className="trall" onClick={() => applyMotionAlternate(imageNames)}>
              Alternate
            </button>
          </div>

          <div className="mini-h mini-h--sep">Scene fades — opening &amp; ending</div>
          <label className="trdur">
            <span>Fade in</span>
            <input type="range" min={0} max={2} step={0.1} value={fadeIn} onChange={(e) => setFadeIn(+e.target.value)} />
            <span className="trdur__val">{fadeIn > 0 ? `${fadeIn.toFixed(1)}s` : "off"}</span>
          </label>
          <label className="trdur">
            <span>Fade out</span>
            <input type="range" min={0} max={2} step={0.1} value={fadeOut} onChange={(e) => setFadeOut(+e.target.value)} />
            <span className="trdur__val">{fadeOut > 0 ? `${fadeOut.toFixed(1)}s` : "off"}</span>
          </label>
        </div>

        <div className="panel transitions">
          <div className="transitions__head">
            <span className="panel__h">Transitions</span>
            <span className="transitions__target">
              {selectedIndex > 0
                ? `Into image ${selectedImageNum || "—"} · ${tc(selectedClip.start)}`
                : selectedIndex === 0
                  ? "First image — no incoming transition"
                  : "Select an image or ◇ cut"}
            </span>
          </div>

          <div className="transitions__chips">
            {TRANSITION_LIST.map((tr) => (
              <button
                key={tr.id}
                type="button"
                className={`trchip ${currentType === tr.id ? "is-on" : ""}`}
                onClick={() => pickType(tr.id)}
              >
                <span className="trchip__icon">{tr.icon}</span>{tr.label}
              </button>
            ))}
          </div>

          <label className="trdur">
            <span>Duration</span>
            <input
              type="range" min={MIN_TRANSITION_DURATION} max={MAX_TRANSITION_DURATION} step={0.05}
              value={transitionDuration}
              onChange={(e) => setTransitionDuration(+e.target.value)}
            />
            <span className="trdur__val">{transitionDuration.toFixed(2)}s</span>
          </label>
          <button
            type="button" className="trall"
            onClick={() => applyTransitionAll(currentType, clips.map((c) => c.name))}
          >
            Apply “{transitionOf(currentType).label}” to all cuts
          </button>
        </div>
      </aside>

      <input
        ref={fileInputRef} type="file" accept="image/*" hidden
        onChange={onPickFile}
      />
    </section>
  );
}
