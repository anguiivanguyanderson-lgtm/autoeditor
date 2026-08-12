"use client";
import { useCallback, useRef } from "react";
import { transitionOf } from "../lib/transitions";

function label(t) {
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function Waveform({ peaks }) {
  if (!peaks || !peaks.length) return <div className="wave wave--empty" />;
  const n = peaks.length;
  return (
    <svg className="wave" viewBox={`0 0 ${n} 100`} preserveAspectRatio="none" aria-hidden="true">
      {peaks.map((p, i) => {
        const h = Math.max(1.5, p * 92);
        return <rect key={i} x={i + 0.12} y={(100 - h) / 2} width={0.76} height={h} rx={0.3} />;
      })}
    </svg>
  );
}

// The signature element: a scrubbable track with a fixed label gutter. Clips,
// waveform, playhead and click-to-seek all share the track's coordinate space.
export default function Timeline({
  clips, imageEls, duration, time, peaks, activeName, badClips,
  transitionsByName, selectedCut, onSelectCut,
  onSeek, onReplace, onRemove, onAdd,
}) {
  const trackRef = useRef(null);

  const seekAt = useCallback((clientX) => {
    const el = trackRef.current;
    if (!el || !duration) return;
    const r = el.getBoundingClientRect();
    const x = Math.min(Math.max(clientX - r.left, 0), r.width);
    onSeek((x / r.width) * duration);
  }, [duration, onSeek]);

  const onPointerDown = useCallback((e) => {
    seekAt(e.clientX);
    const move = (ev) => seekAt(ev.clientX);
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }, [seekAt]);

  const step = duration > 180 ? 30 : duration > 90 ? 15 : duration > 30 ? 10 : 5;
  const ticks = [];
  for (let t = 0; t <= duration + 0.001; t += step) ticks.push(Math.round(t));

  const pct = (v) => `${Math.min(100, (v / duration) * 100)}%`;
  const stop = (e) => e.stopPropagation();

  return (
    <div className="tl">
      <div className="tl__row tl__row--ruler">
        <div className="tl__gutter" aria-hidden="true" />
        <div className="tl__ruler">
          {ticks.map((t) => (
            <span className="tl__tick" key={t} style={{ left: pct(t) }}>
              <i className="tl__tickline" />
              {label(t)}
            </span>
          ))}
        </div>
      </div>

      <div className="tl__row tl__row--cuts">
        <div className="tl__gutter" aria-hidden="true" />
        <div className="tl__cuts">
          {clips.map((c, i) => {
            if (i === 0) return null;
            const tr = transitionOf(transitionsByName && transitionsByName[c.name]);
            const cls = ["cut"];
            if (selectedCut === c.name) cls.push("is-sel");
            if (tr.xfade) cls.push("is-on");
            return (
              <button
                key={c.name}
                type="button"
                className={cls.join(" ")}
                style={{ left: pct(c.start) }}
                title={`Transition: ${tr.label} — click to change`}
                onPointerDown={stop}
                onClick={() => onSelectCut && onSelectCut(c.name)}
              >
                {tr.icon}
              </button>
            );
          })}
        </div>
      </div>

      <div className="tl__row">
        <div className="tl__gutter">
          <span className="tl__tag">V</span>
          <span className="tl__tag tl__tag--audio">A</span>
        </div>

        <div className="tl__track" ref={trackRef} onPointerDown={onPointerDown}>
          <div className="tl__lane tl__lane--video">
            {clips.map((c) => {
              const style = { left: pct(c.start), width: pct(c.duration) };

              if (c.gap) {
                return (
                  <div
                    key={c.name}
                    className="clip clip--gap"
                    style={style}
                    title={`Empty · ${label(c.start)} · ${c.duration.toFixed(1)}s`}
                  >
                    <button
                      type="button" className="clip__add" title="Add an image here"
                      onPointerDown={stop} onClick={() => onAdd && onAdd(c.name)}
                    >
                      <span className="clip__plus">+</span>
                      <span className="clip__meta clip__meta--gap">{c.duration.toFixed(1)}s</span>
                    </button>
                  </div>
                );
              }

              const el = imageEls[c.name];
              const cls = ["clip"];
              if (c.name === activeName) cls.push("is-active");
              if (badClips && badClips.has(c.name)) cls.push("is-bad");
              return (
                <div
                  key={c.name}
                  className={cls.join(" ")}
                  style={{ ...style, backgroundImage: el && el.url ? `url(${el.url})` : undefined }}
                  title={`${label(c.start)} · ${c.duration.toFixed(1)}s`}
                >
                  <span className="clip__meta">{c.duration.toFixed(1)}s</span>
                  <div className="clip__actions">
                    <button
                      type="button" className="clip__btn" title="Replace this image"
                      onPointerDown={stop} onClick={() => onReplace && onReplace(c.name)}
                    >⇄</button>
                    <button
                      type="button" className="clip__btn clip__btn--x" title="Remove this image"
                      onPointerDown={stop} onClick={() => onRemove && onRemove(c.name)}
                    >✕</button>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="tl__lane tl__lane--audio">
            <Waveform peaks={peaks} />
          </div>

          <div className="tl__playhead" style={{ left: pct(time) }}>
            <span className="tl__playhead-grip" />
          </div>
        </div>
      </div>
    </div>
  );
}
