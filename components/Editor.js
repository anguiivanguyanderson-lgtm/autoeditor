"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Timeline from "./Timeline";
import {
  TRANSITION_LIST, transitionOf,
  MIN_TRANSITION_DURATION, MAX_TRANSITION_DURATION,
} from "../lib/transitions";
import {
  CAPTION_STYLE_LIST, captionAt, drawCaption, captionFontPx,
} from "../lib/captions";

function tc(t) {
  if (!isFinite(t) || t < 0) t = 0;
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  const d = Math.floor((t * 10) % 10);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${d}`;
}

function clock(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export default function Editor({
  clips, imageEls, audioUrl, duration, peaks, dims,
  aspect, setAspect, fps, setFps,
  onRender, onCancel, busy, progress, outUrl, error, warnings,
  replaceImage, removeImage, fillGap,
  transitionsByName, transitionDuration, setTransition, applyTransitionAll, setTransitionDuration,
  fadeIn, setFadeIn, fadeOut, setFadeOut,
  undo, redo, canUndo, canRedo,
  captionCues, captionsOn, setCaptionsOn, captionStyle, setCaptionStyle,
  captionSize, setCaptionSize, captionName, captionError, onCaptionFile,
}) {
  const canvasRef = useRef(null);
  const audioRef = useRef(null);
  const rafRef = useRef(0);
  const fileInputRef = useRef(null);
  const capInputRef = useRef(null);
  const replaceInputRef = useRef(null);
  const pending = useRef(null); // gap-fill target name
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [elapsed, setElapsed] = useState(0); // seconds spent in the current render
  const [selectedCut, setSelectedCut] = useState(null); // selected clip name (drives transition)
  const [currentType, setCurrentType] = useState("fade");
  const [inspect, setInspect] = useState(null);   // slot name open in the inspector
  const [pendFile, setPendFile] = useState(null);  // chosen replacement, not yet applied
  const [pendUrl, setPendUrl] = useState(null);

  // Gap "+" → pick a file to fill an empty slot / lead-in.
  const askAdd = useCallback((name) => {
    pending.current = name;
    if (fileInputRef.current) fileInputRef.current.click();
  }, []);

  const onPickFile = useCallback((e) => {
    const file = e.target.files && e.target.files[0];
    if (file && pending.current && fillGap) fillGap(pending.current, file);
    e.target.value = "";
    pending.current = null;
  }, [fillGap]);

  // Clip inspector: click a clip → preview → optionally pick a replacement,
  // preview it, then Apply (or Remove the image).
  const clearPend = useCallback(() => {
    setPendUrl((u) => { if (u) URL.revokeObjectURL(u); return null; });
    setPendFile(null);
  }, []);
  const openInspect = useCallback((name) => { clearPend(); setInspect(name); }, [clearPend]);
  const closeInspect = useCallback(() => { clearPend(); setInspect(null); }, [clearPend]);
  const onPickReplacement = useCallback((e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!file || !file.type.startsWith("image/")) return;
    setPendFile(file);
    setPendUrl((u) => { if (u) URL.revokeObjectURL(u); return URL.createObjectURL(file); });
  }, []);
  const applyReplacement = useCallback(() => {
    if (inspect && pendFile && replaceImage) replaceImage(inspect, pendFile);
    closeInspect();
  }, [inspect, pendFile, replaceImage, closeInspect]);
  const removeInspected = useCallback(() => {
    if (inspect && removeImage) removeImage(inspect);
    closeInspect();
  }, [inspect, removeImage, closeInspect]);

  useEffect(() => {
    if (!inspect) return;
    const onEsc = (e) => { if (e.key === "Escape") closeInspect(); };
    window.addEventListener("keydown", onEsc);
    return () => window.removeEventListener("keydown", onEsc);
  }, [inspect, closeInspect]);

  const onPickCaption = useCallback((e) => {
    const file = e.target.files && e.target.files[0];
    if (file && onCaptionFile) onCaptionFile(file);
    e.target.value = "";
  }, [onCaptionFile]);

  const draw = useCallback((t) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const W = canvas.width, H = canvas.height;
    ctx.globalAlpha = 1;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, W, H);

    if (clips.length) {
      let idx = clips.findIndex((c) => t >= c.start && t < c.start + c.duration);
      if (idx === -1) idx = clips.length - 1;
      const clip = clips[idx];
      const type = idx > 0 ? (transitionsByName[clip.name] || "cut") : "cut";
      const tdur = type === "cut" ? 0 : Math.min(transitionDuration, clip.duration);

      if (idx > 0 && tdur > 0 && t < clip.start + tdur) {
        // Inside a transition: blend the previous image into this one.
        const p = Math.min(1, Math.max(0, (t - clip.start) / tdur));
        transitionOf(type).canvas(
          ctx, imageEls[clips[idx - 1].name] || null, imageEls[clip.name] || null, p, W, H
        );
        ctx.globalAlpha = 1;
      } else {
        const img = imageEls[clip.name];
        if (img) {
          const scale = Math.min(W / img.naturalWidth, H / img.naturalHeight);
          const w = img.naturalWidth * scale, h = img.naturalHeight * scale;
          ctx.drawImage(img, (W - w) / 2, (H - h) / 2, w, h);
        }
      }
    }

    // Captions burn in before the fades, so the fade dims them too.
    if (captionsOn && captionCues && captionCues.length) {
      const txt = captionAt(captionCues, t);
      if (txt) drawCaption(ctx, txt, W, H, captionStyle, captionFontPx(H, captionSize));
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
  }, [clips, imageEls, transitionsByName, transitionDuration, fadeIn, fadeOut, duration,
      captionsOn, captionCues, captionStyle, captionSize]);

  useEffect(() => { draw(time); }, [time, draw]);
  useEffect(() => { setTime(0); }, [audioUrl]);

  // Elapsed render timer.
  useEffect(() => {
    if (!busy) { setElapsed(0); return; }
    const start = Date.now();
    setElapsed(0);
    const id = setInterval(() => setElapsed((Date.now() - start) / 1000), 250);
    return () => clearInterval(id);
  }, [busy]);

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
  }, [transitionsByName]);

  const pickType = useCallback((type) => {
    setCurrentType(type);
    if (selectedCut) setTransition(selectedCut, type);
  }, [selectedCut, setTransition]);

  const selectedClip = selectedCut && clips.find((c) => c.name === selectedCut);
  const selectedIndex = selectedClip ? clips.indexOf(selectedClip) : -1;
  const selectedImageNum = selectedClip && !selectedClip.gap ? imageClips.indexOf(selectedClip) + 1 : 0;

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
            <div className="history">
              <button
                className="hbtn" onClick={undo} disabled={!canUndo}
                title="Undo (Ctrl+Z)" aria-label="Undo"
              >↺</button>
              <button
                className="hbtn" onClick={redo} disabled={!canRedo}
                title="Redo (Ctrl+Shift+Z)" aria-label="Redo"
              >↻</button>
            </div>
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
          selectedName={selectedCut}
          onSelect={selectClip}
          onSeek={seek}
          onOpen={openInspect}
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

          {!busy ? (
            <button className="render" onClick={onRender}>Render MP4</button>
          ) : (
            <>
              <button className="render render--busy" disabled>
                Rendering… {Math.round(progress * 100)}%
              </button>
              <div className="progress"><i style={{ width: `${Math.round(progress * 100)}%` }} /></div>
              <div className="render-meta">
                <span>{clock(elapsed)} elapsed</span>
                {progress > 0.03 && <span>~{clock(elapsed * (1 - progress) / progress)} left</span>}
              </div>
              <button className="cancel" onClick={onCancel}>Cancel</button>
            </>
          )}
          {outUrl && <a className="download" href={outUrl} download="story.mp4">↓ Download MP4</a>}
          {error && <div className="note note--bad">{error}</div>}
        </div>

        <div className="panel">
          <h2 className="panel__h">Scene fades</h2>
          <div className="mini-h">Fade the opening and ending (video &amp; audio).</div>
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

        <div className="panel captions">
          <h2 className="panel__h">Captions</h2>
          {!(captionCues && captionCues.length) ? (
            <div className="cap-empty">
              <button type="button" className="cap-upload" onClick={() => capInputRef.current && capInputRef.current.click()}>
                <span className="cap-upload__i">⤒</span> Upload timestamped script
              </button>
              <p className="cap-hint">
                An <code>.srt</code>, <code>.vtt</code>, or timestamped <code>.txt</code> — inline
                markers like <code>(0:03)</code>, NoteGPT ranges, or <code>[0:03]</code> lines all
                work. Captions sync to the audio and burn into the MP4.
              </p>
              {captionError && <div className="note note--bad">{captionError}</div>}
            </div>
          ) : (
            <>
              <div className="cap-bar">
                <button
                  type="button"
                  className={`cap-switch ${captionsOn ? "is-on" : ""}`}
                  onClick={() => setCaptionsOn(!captionsOn)}
                  aria-pressed={captionsOn}
                >
                  <span className="cap-switch__box" />
                  {captionsOn ? "On" : "Off"}
                </button>
                <span className="cap-meta">
                  <span className="cap-meta__name">{captionName || "captions"}</span>
                  {captionCues.length} lines ·{" "}
                  <button type="button" className="cap-replace" onClick={() => capInputRef.current && capInputRef.current.click()}>replace</button>
                </span>
              </div>

              <div className="cap-body" aria-disabled={!captionsOn}>
                <div className="mini-h">Style</div>
                <div className="transitions__chips">
                  {CAPTION_STYLE_LIST.map((st) => (
                    <button
                      key={st.id}
                      type="button"
                      className={`trchip ${captionStyle === st.id ? "is-on" : ""}`}
                      onClick={() => setCaptionStyle(st.id)}
                    >
                      {st.label}
                    </button>
                  ))}
                </div>

                <div className="mini-h" style={{ marginTop: 12 }}>Size</div>
                <div className="seg">
                  {[["sm", "Small"], ["md", "Medium"], ["lg", "Large"]].map(([id, lbl]) => (
                    <button
                      key={id}
                      type="button"
                      className={captionSize === id ? "is-on" : ""}
                      onClick={() => setCaptionSize(id)}
                    >{lbl}</button>
                  ))}
                </div>
              </div>
              {captionError && <div className="note note--bad">{captionError}</div>}
            </>
          )}
        </div>

        <div className="panel transitions">
          <div className="transitions__head">
            <span className="panel__h">Transitions</span>
            <span className="transitions__target">
              {selectedIndex > 0
                ? `Into image ${selectedImageNum || "—"} · ${tc(selectedClip.start)}`
                : selectedIndex === 0
                  ? "First image — no incoming transition"
                  : "Tap a ◇ cut above to set its transition"}
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
      <input
        ref={replaceInputRef} type="file" accept="image/*" hidden
        onChange={onPickReplacement}
      />
      <input
        ref={capInputRef} type="file" accept=".srt,.vtt,.txt,text/plain" hidden
        onChange={onPickCaption}
      />

      {inspect && (() => {
        const insClip = clips.find((c) => c.name === inspect);
        const el = imageEls[inspect];
        const num = insClip ? imageClips.indexOf(insClip) + 1 : 0;
        const curUrl = pendUrl || (el && el.url);
        return (
          <div className="modal" role="dialog" aria-modal="true" onClick={closeInspect}>
            <div className="modal__card" onClick={(e) => e.stopPropagation()}>
              <div className="modal__head">
                <span className="modal__title">
                  {num ? `Image ${num} of ${imageCount}` : "Image"}
                  {insClip && <span className="modal__at"> · {tc(insClip.start)}</span>}
                </span>
                <button className="modal__x" onClick={closeInspect} aria-label="Close">✕</button>
              </div>

              <div className="modal__stage">
                {curUrl && <img src={curUrl} alt="" />}
                {pendUrl && <span className="modal__flag">New — not applied yet</span>}
              </div>
              <div className="modal__file">
                {pendFile ? pendFile.name : (el && el.fileName) || ""}
              </div>

              {!pendUrl ? (
                <div className="modal__actions">
                  <button className="mbtn mbtn--primary" onClick={() => replaceInputRef.current && replaceInputRef.current.click()}>
                    Replace image…
                  </button>
                  <button className="mbtn mbtn--danger" onClick={removeInspected}>Remove from timeline</button>
                </div>
              ) : (
                <div className="modal__actions">
                  <button className="mbtn mbtn--primary" onClick={applyReplacement}>Apply replacement</button>
                  <button className="mbtn" onClick={() => replaceInputRef.current && replaceInputRef.current.click()}>Choose different…</button>
                  <button className="mbtn mbtn--ghost" onClick={clearPend}>Cancel</button>
                </div>
              )}
            </div>
          </div>
        );
      })()}
    </section>
  );
}
