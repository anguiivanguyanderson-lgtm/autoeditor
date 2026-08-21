"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./globals.css";
import { parseTimestampName } from "../lib/timestamp";
import { buildTimeline, trimClips, LEAD_IN } from "../lib/timeline";
import { resolveDimensions } from "../lib/dimensions";
import { getAudioDuration } from "../lib/audio";
import { getWaveformPeaks } from "../lib/waveform";
import { renderVideo, cancelRender, getActiveRender, reconnectRender } from "../lib/serverRender";
import { DEFAULT_TRANSITION_DURATION, mixTransitions } from "../lib/transitions";
import { parseTranscript } from "../lib/captions";
import Dropzone from "../components/Dropzone";
import Editor from "../components/Editor";

function loadImageEl(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { img.url = url; img.fileName = file.name; resolve(img); };
    img.src = url;
  });
}

function fmtTime(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

// Undo/redo over one composition snapshot. Object URLs are intentionally never
// revoked, so an undone snapshot still points at a live image.
function useHistory(initial) {
  const [hist, setHist] = useState({ past: [], present: initial, future: [] });
  const commit = useCallback((updater) => {
    setHist((h) => {
      const next = typeof updater === "function" ? updater(h.present) : updater;
      if (next === h.present) return h;
      return { past: [...h.past, h.present], present: next, future: [] };
    });
  }, []);
  const undo = useCallback(() => setHist((h) => {
    if (!h.past.length) return h;
    const prev = h.past[h.past.length - 1];
    return { past: h.past.slice(0, -1), present: prev, future: [h.present, ...h.future] };
  }), []);
  const redo = useCallback(() => setHist((h) => {
    if (!h.future.length) return h;
    const nxt = h.future[0];
    return { past: [...h.past, h.present], present: nxt, future: h.future.slice(1) };
  }), []);
  return [
    hist.present, commit,
    { undo, redo, canUndo: hist.past.length > 0, canRedo: hist.future.length > 0 },
  ];
}

// A slot is one point on the timeline: { id, seconds, file, img, empty }.
// Empty slots are placeholders (a removed image or the lead-in you filled out).
export default function Home() {
  const [audioFile, setAudioFile] = useState(null);
  const [audioUrl, setAudioUrl] = useState(null);
  const [audioDuration, setAudioDuration] = useState(0);
  const [peaks, setPeaks] = useState([]);
  const [aspect, setAspect] = useState("16:9");
  const [fps, setFps] = useState(30);
  const [transitionDuration, setTransitionDuration] = useState(DEFAULT_TRANSITION_DURATION);
  const [fadeIn, setFadeIn] = useState(0.5);          // opening fade seconds (0 = off)
  const [fadeOut, setFadeOut] = useState(0.6);        // ending fade seconds (0 = off)
  const [trimEnd, setTrimEnd] = useState(0); // export end point (0 = untrimmed / full audio)
  const [captionRaw, setCaptionRaw] = useState(null); // uploaded transcript text
  const [captionName, setCaptionName] = useState(null);
  const [captionsOn, setCaptionsOn] = useState(false);
  const [captionStyle, setCaptionStyle] = useState("classic");
  const [captionSize, setCaptionSize] = useState("md");
  const [built, setBuilt] = useState(false);          // committed images to the timeline?
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [outUrl, setOutUrl] = useState(null);
  const [error, setError] = useState(null);
  // A render that was already running when this tab loaded (e.g. reopened after
  // closing the browser mid-render). Shown as a banner and reconnected to.
  const [resume, setResume] = useState(null); // { busy, progress, url, error }
  const idRef = useRef(0);
  const nextId = () => `s${idRef.current++}`;

  // Composition (undoable): slots + per-clip transition choices, snapshotted together.
  const [doc, commitDoc, { undo, redo, canUndo, canRedo }] =
    useHistory({ slots: [], transitionsByName: {} });
  const { slots, transitionsByName } = doc;

  const onAudio = useCallback(async (files) => {
    const file = files[0];
    if (!file) return;
    setError(null);
    try {
      const d = await getAudioDuration(file);
      setAudioFile(file);
      setAudioUrl(URL.createObjectURL(file));
      setAudioDuration(d);
      getWaveformPeaks(file).then(setPeaks);
    } catch (e) { setError(e.message); }
  }, []);

  // Import images, merged by timestamp: a file whose timestamp matches an
  // existing slot fills/replaces it; otherwise it becomes a new slot.
  const addImages = useCallback(async (fileList) => {
    const files = Array.from(fileList).filter((f) => f.type.startsWith("image/"));
    if (!files.length) return;
    const loaded = await Promise.all(
      files.map(async (f) => ({ file: f, seconds: parseTimestampName(f.name), img: await loadImageEl(f) }))
    );
    commitDoc((d) => {
      const next = d.slots.map((s) => ({ ...s }));
      for (const { file, seconds, img } of loaded) {
        const slot = seconds != null ? next.find((s) => s.seconds === seconds) : null;
        if (slot) {
          slot.file = file; slot.img = img; slot.empty = false;
        } else {
          next.push({ id: nextId(), seconds, file, img, empty: false });
        }
      }
      return { ...d, slots: next };
    });
  }, [commitDoc]);

  // Swap the image in one slot, keeping its timestamp.
  const replaceImage = useCallback(async (id, file) => {
    if (!file || !file.type.startsWith("image/")) return;
    const img = await loadImageEl(file);
    commitDoc((d) => ({
      ...d,
      slots: d.slots.map((s) => (s.id === id ? { ...s, file, img, empty: false } : s)),
    }));
  }, [commitDoc]);

  // Discard a staged image entirely (used in the pre-build import tray).
  const discardImage = useCallback((id) => {
    commitDoc((d) => ({ ...d, slots: d.slots.filter((s) => s.id !== id) }));
  }, [commitDoc]);

  // Removing an image turns its slot into a placeholder — neighbours don't move.
  const removeImage = useCallback((id) => {
    commitDoc((d) => ({
      ...d,
      slots: d.slots.map((s) => (s.id === id ? { ...s, file: null, img: null, empty: true } : s)),
    }));
  }, [commitDoc]);

  // Fill a gap. LEAD_IN adds a new slot at 0; otherwise fill the empty slot.
  const fillGap = useCallback(async (name, file) => {
    if (!file || !file.type.startsWith("image/")) return;
    const img = await loadImageEl(file);
    commitDoc((d) => {
      if (name === LEAD_IN) {
        return { ...d, slots: [...d.slots, { id: nextId(), seconds: 0, file, img, empty: false }] };
      }
      return { ...d, slots: d.slots.map((s) => (s.id === name ? { ...s, file, img, empty: false } : s)) };
    });
  }, [commitDoc]);

  // Roll edit: move the boundary between an image and the next clip by setting
  // the next clip's slot start. buildTimeline re-derives both durations; total
  // length and every other slot are untouched. One commit = one undo step.
  const resizeBoundary = useCallback((id, seconds) => {
    commitDoc((d) => ({
      ...d,
      slots: d.slots.map((s) => (s.id === id ? { ...s, seconds: +seconds.toFixed(3) } : s)),
    }));
  }, [commitDoc]);

  // Read an uploaded transcript; parsing happens in a memo below so it re-syncs
  // if the audio length changes.
  const onCaptionFile = useCallback(async (file) => {
    if (!file) return;
    try {
      const text = await file.text();
      setCaptionRaw(text);
      setCaptionName(file.name);
      setCaptionsOn(true);
    } catch (e) { setError(e.message || String(e)); }
  }, []);
  const captionParse = useMemo(
    () => (captionRaw ? parseTranscript(captionRaw, audioDuration) : { cues: [], error: null }),
    [captionRaw, audioDuration]
  );
  const captionCues = captionParse.cues;
  const captionError = captionParse.error;

  // On load, reconnect to a render that's still running on the server.
  useEffect(() => {
    let alive = true;
    (async () => {
      const active = await getActiveRender();
      if (!alive || !active) return;
      setResume({ busy: true, progress: (active.percent || 0) / 100, url: null, error: null });
      try {
        const blob = await reconnectRender(active.jobId, (p) => {
          if (alive) setResume((r) => (r ? { ...r, progress: p } : r));
        });
        if (alive) setResume({ busy: false, progress: 1, url: URL.createObjectURL(blob), error: null });
      } catch (e) {
        if (alive) setResume({ busy: false, progress: 0, url: null, error: e.message || String(e) });
      }
    })();
    return () => { alive = false; };
  }, []);

  const setTransition = useCallback((name, type) => {
    commitDoc((d) => ({ ...d, transitionsByName: { ...d.transitionsByName, [name]: type } }));
  }, [commitDoc]);
  const applyTransitionAll = useCallback((type, clipNames) => {
    commitDoc((d) => {
      const next = {};
      // Skip the first clip — it has no incoming cut.
      for (let i = 1; i < clipNames.length; i++) next[clipNames[i]] = type;
      return { ...d, transitionsByName: next };
    });
  }, [commitDoc]);
  // Random mix: assign each cut a transition drawn randomly from `picks`
  // (no back-to-back repeats). One commit = one undo step.
  const applyTransitionMix = useCallback((picks, clipNames) => {
    const cutNames = clipNames.slice(1); // first image has no incoming transition
    const assigned = mixTransitions(picks, cutNames.length);
    commitDoc((d) => {
      const next = {};
      cutNames.forEach((name, i) => { next[name] = assigned[i]; });
      return { ...d, transitionsByName: next };
    });
  }, [commitDoc]);

  // Keyboard: Ctrl/Cmd+Z undo, Ctrl/Cmd+Shift+Z or Ctrl+Y redo.
  useEffect(() => {
    const onKey = (e) => {
      const tag = (e.target.tagName || "").toLowerCase();
      if (tag === "input" || tag === "select" || tag === "textarea") return;
      const meta = e.ctrlKey || e.metaKey;
      if (!meta) return;
      const k = e.key.toLowerCase();
      if (k === "z" && !e.shiftKey) { e.preventDefault(); undo(); }
      else if ((k === "z" && e.shiftKey) || k === "y") { e.preventDefault(); redo(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo]);

  const items = useMemo(
    () => slots.map((s) => ({
      name: s.id, seconds: s.seconds, empty: s.empty,
      label: (s.img && s.img.fileName) || (s.file && s.file.name) || s.id,
    })),
    [slots]
  );
  const imagesByName = useMemo(() => {
    const m = {};
    for (const s of slots) if (!s.empty && s.file) m[s.id] = s.file;
    return m;
  }, [slots]);
  const imageEls = useMemo(() => {
    const m = {};
    for (const s of slots) if (!s.empty && s.img) m[s.id] = s.img;
    return m;
  }, [slots]);
  const imageCount = useMemo(() => slots.filter((s) => !s.empty && s.img).length, [slots]);

  // Staged thumbnails for the pre-build import tray, ordered by timestamp
  // (files with no parseable timestamp sort last and are flagged).
  const tray = useMemo(
    () => slots
      .filter((s) => !s.empty && s.img)
      .map((s) => ({ id: s.id, url: s.img.url, name: s.img.fileName || (s.file && s.file.name) || "", seconds: s.seconds }))
      .sort((a, b) => (a.seconds == null ? Infinity : a.seconds) - (b.seconds == null ? Infinity : b.seconds)),
    [slots]
  );

  const sample = useMemo(() => {
    const imaged = slots
      .filter((s) => !s.empty && s.img && s.seconds != null)
      .sort((a, b) => a.seconds - b.seconds);
    const el = imaged[0] && imaged[0].img;
    return el ? { width: el.naturalWidth, height: el.naturalHeight } : null;
  }, [slots]);

  const dims = useMemo(() => resolveDimensions(aspect, sample), [aspect, sample]);
  const { clips, warnings } = useMemo(
    () => buildTimeline(items, audioDuration),
    [items, audioDuration]
  );

  // A new voiceover resets any prior trim to the full length.
  useEffect(() => { setTrimEnd(audioDuration); }, [audioDuration]);

  const exportDuration = trimEnd > 0 ? Math.min(trimEnd, audioDuration) : audioDuration;

  const ready = audioFile && clips.length > 0;
  const showEditor = built && ready;

  const cancelRef = useRef(false);
  const onCancel = useCallback(() => {
    cancelRef.current = true;
    cancelRender();
    setBusy(false);
    setProgress(0);
  }, []);

  const onRender = useCallback(async () => {
    cancelRef.current = false;
    setBusy(true); setError(null); setOutUrl(null); setProgress(0);
    try {
      const exportClips = trimClips(clips, exportDuration);
      const transitions = exportClips.map((c) => transitionsByName[c.name] || "cut");
      const captions = captionsOn && captionCues.length ? captionCues : null;
      const blob = await renderVideo({
        clips: exportClips, imagesByName, audioFile,
        width: dims.width, height: dims.height, fps,
        transitions, transitionDuration, fadeIn, fadeOut,
        captions, captionStyle, captionSize,
        onProgress: setProgress,
      });
      setOutUrl(URL.createObjectURL(blob));
    } catch (e) {
      if (!cancelRef.current) setError(e.message || String(e));
    } finally {
      if (!cancelRef.current) setBusy(false);
    }
  }, [clips, exportDuration, imagesByName, audioFile, dims, fps, transitionsByName, transitionDuration, fadeIn, fadeOut,
      captionsOn, captionCues, captionStyle, captionSize]);

  return (
    <main className="app">
      <header className={`bar${showEditor ? "" : " bar--onboard"}`}>
        <div className="brand">
          <span className="brand__dot" />
          <span className="brand__name"><span className="brand__pre">TryAIToday</span> AutoEditor</span>
          <span className="brand__tag">image · voiceover sync</span>
        </div>
        <div className="bar__actions">
          <a
            className="ext-link"
            href="https://chromewebstore.google.com/detail/bcmmekkamenpjoogmegiffgemlgikbgf?utm_source=item-share-cb"
            target="_blank"
            rel="noopener noreferrer"
            title="Get the TryAIToday Flow Automator Chrome extension"
          >
            <span className="ext-link__icon" aria-hidden="true">🧩</span>
            <span className="ext-link__text">Get the Extension</span>
          </a>
          <div className="bar__io">
            <Dropzone
              compact accept="audio/*" onFiles={onAudio} icon="♪"
              title="Import voiceover" filled={!!audioFile}
              filledLabel={audioFile ? audioFile.name : ""}
            />
            <Dropzone
              compact multiple accept="image/*" onFiles={addImages} icon="▦"
              title="Add images" filled={imageCount > 0}
              filledLabel={imageCount ? `${imageCount} images` : ""}
            />
          </div>
        </div>
      </header>

      {resume && (
        <div className={`resume${resume.url ? " resume--done" : resume.error ? " resume--bad" : ""}`}>
          {resume.busy && (
            <span className="resume__msg">
              <span className="resume__spin" aria-hidden="true" />
              A render is still running… {Math.round(resume.progress * 100)}%
            </span>
          )}
          {resume.url && (
            <span className="resume__msg">
              Your video finished rendering.
              <a className="resume__dl" href={resume.url} download="autoeditor.mp4">Download</a>
            </span>
          )}
          {resume.error && <span className="resume__msg">Last render failed: {resume.error}</span>}
          {!resume.busy && (
            <button className="resume__x" onClick={() => setResume(null)} aria-label="Dismiss">✕</button>
          )}
        </div>
      )}

      <div className="content">
      {!showEditor ? (
        <section className="onboard">
          <h1 className="onboard__h">Sync your images to a voiceover, automatically.</h1>
          <p className="onboard__p">
            Name each image with the second it appears — <code>0-03.png</code> cuts in at 0:03 —
            then import them with your voiceover. Review everything below, then build the timeline.
            Everything runs in your browser. Nothing is uploaded.
          </p>

          <div className="onboard__zones">
            <Dropzone
              accept="audio/*" onFiles={onAudio} icon="♪"
              title="Voiceover audio"
              hint="One MP3 or WAV — sets the total length"
              filled={!!audioFile}
              filledLabel={audioFile ? audioFile.name : ""}
            />
            <Dropzone
              multiple accept="image/*" onFiles={addImages} icon="▦"
              title={tray.length ? "Add more images" : "Storyboard images"}
              hint="Named by timestamp (0-00, 0-06…). Drop files or whole folders — even several at once."
              filled={false}
            />
          </div>

          {tray.length > 0 && (
            <div className="tray">
              <div className="tray__head">
                <span className="tray__count">{tray.length} image{tray.length > 1 ? "s" : ""} imported</span>
                <span className="tray__sub">ordered by timestamp — hover to remove</span>
              </div>
              <div className="tray__grid">
                {tray.map((t) => (
                  <div key={t.id} className={`thumb${t.seconds == null ? " thumb--notime" : ""}`} title={t.name}>
                    <img src={t.url} alt="" />
                    <span className="thumb__time">{t.seconds != null ? fmtTime(t.seconds) : "no time"}</span>
                    <button className="thumb__x" title="Remove this image" onClick={() => discardImage(t.id)}>✕</button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {imageCount > 0 && warnings.length > 0 && (
            <div className="notes">{warnings.map((w, i) => <div className="note" key={i}>{w}</div>)}</div>
          )}
          {error && <div className="note note--bad">{error}</div>}

          <div className="build-row">
            <button
              className="render build"
              disabled={!audioFile || tray.length === 0 || clips.length === 0}
              onClick={() => setBuilt(true)}
            >
              Build timeline →
            </button>
            <span className="build-hint">
              {tray.length === 0
                ? "Import your storyboard images to begin."
                : !audioFile
                  ? "Add a voiceover to build the timeline."
                  : `${tray.length} image${tray.length > 1 ? "s" : ""} · ready to build`}
            </span>
          </div>
        </section>
      ) : (
        <Editor
          clips={clips} imageEls={imageEls} audioUrl={audioUrl}
          duration={audioDuration} peaks={peaks} dims={dims}
          aspect={aspect} setAspect={setAspect} fps={fps} setFps={setFps}
          onRender={onRender} onCancel={onCancel} busy={busy} progress={progress}
          outUrl={outUrl} error={error} warnings={warnings}
          replaceImage={replaceImage} removeImage={removeImage} fillGap={fillGap}
          resizeBoundary={resizeBoundary}
          transitionsByName={transitionsByName} transitionDuration={transitionDuration}
          setTransition={setTransition} applyTransitionAll={applyTransitionAll}
          applyTransitionMix={applyTransitionMix}
          setTransitionDuration={setTransitionDuration}
          fadeIn={fadeIn} setFadeIn={setFadeIn}
          fadeOut={fadeOut} setFadeOut={setFadeOut}
          trimEnd={exportDuration} setTrimEnd={setTrimEnd} exportDuration={exportDuration}
          undo={undo} redo={redo} canUndo={canUndo} canRedo={canRedo}
          captionCues={captionCues} captionsOn={captionsOn} setCaptionsOn={setCaptionsOn}
          captionStyle={captionStyle} setCaptionStyle={setCaptionStyle}
          captionSize={captionSize} setCaptionSize={setCaptionSize}
          captionName={captionName} captionError={captionError} onCaptionFile={onCaptionFile}
        />
      )}
      </div>
    </main>
  );
}
