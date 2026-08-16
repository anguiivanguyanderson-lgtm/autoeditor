"use client";
import { useCallback, useRef } from "react";
import { transitionOf } from "../lib/transitions";

function label(t) {
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

// Filename without its extension, for the clip caption.
function stem(name) {
  if (!name) return "";
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(0, i) : name;
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
  transitionsByName, selectedName, onSelect,
  onSeek, onOpen, onAdd,
}) {
  const trackRef = useRef(null);
  const downRef = useRef(null); // pointer-down position, to tell a clip tap from a drag

  // Scrub the playhead. Reference the track's box for x/width; the ruler and
  // audio lane are horizontally aligned with it, so this works for all three.
  const seekAt = useCallback((clientX) => {
    const el = trackRef.current;
    if (!el || !duration) return;
    const r = el.getBoundingClientRect();
    const x = Math.min(Math.max(clientX - r.left, 0), r.width);
    onSeek((x / r.width) * duration);
  }, [duration, onSeek]);

  const onScrubDown = useCallback((e) => {
    seekAt(e.clientX);
    const move = (ev) => seekAt(ev.clientX);
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }, [seekAt]);

  // A clip opens the inspector only on a clean tap, not a drag/scroll.
  const onClipClick = useCallback((name, e) => {
    const d = downRef.current;
    if (d && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 6 && onOpen) onOpen(name);
  }, [onOpen]);

  const step = duration > 180 ? 30 : duration > 90 ? 15 : duration > 30 ? 10 : 5;
  const ticks = [];
  for (let t = 0; t <= duration + 0.001; t += step) ticks.push(Math.round(t));

  const pct = (v) => `${Math.min(100, (v / duration) * 100)}%`;
  const stop = (e) => e.stopPropagation();

  // Give each clip a readable minimum: when the timeline is dense, widen the
  // track past the container so it scrolls horizontally instead of crushing
  // clips into slivers. Percentages resolve against this wider track, so the
  // ruler, clips, waveform and playhead all stay aligned.
  const rowMin = clips.length ? 30 + clips.length * 72 : 0;

  return (
    <div className="tl" style={rowMin ? { "--tl-min": `${rowMin}px` } : undefined}>
      <div className="tl__row tl__row--ruler">
        <div className="tl__gutter" aria-hidden="true" />
        <div className="tl__ruler tl__scrub" onPointerDown={onScrubDown} title="Drag to move the playhead">
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
            if (selectedName === c.name) cls.push("is-sel");
            if (tr.xfade) cls.push("is-on");
            return (
              <button
                key={c.name}
                type="button"
                className={cls.join(" ")}
                style={{ left: pct(c.start) }}
                title={`Transition: ${tr.label} — click to change`}
                onPointerDown={stop}
                onClick={() => onSelect && onSelect(c.name)}
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

        <div className="tl__track" ref={trackRef}>
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
              if (c.name === selectedName) cls.push("is-selected");
              if (badClips && badClips.has(c.name)) cls.push("is-bad");
              const fname = el && el.fileName ? stem(el.fileName) : "";
              return (
                <div
                  key={c.name}
                  className={cls.join(" ")}
                  style={{ ...style, backgroundImage: el && el.url ? `url(${el.url})` : undefined }}
                  title={`${el && el.fileName ? el.fileName + " · " : ""}${label(c.start)} · ${c.duration.toFixed(1)}s — click to preview / replace`}
                  onPointerDown={(e) => { downRef.current = { x: e.clientX, y: e.clientY }; }}
                  onClick={(e) => onClipClick(c.name, e)}
                >
                  <span className="clip__meta">{c.duration.toFixed(1)}s</span>
                  {fname && <span className="clip__name">{fname}</span>}
                </div>
              );
            })}
          </div>

          <div className="tl__lane tl__lane--audio tl__scrub" onPointerDown={onScrubDown}>
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
