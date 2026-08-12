"use client";
import { useCallback, useMemo, useRef, useState } from "react";
import "./globals.css";
import { parseTimestampName } from "../lib/timestamp";
import { buildTimeline, LEAD_IN } from "../lib/timeline";
import { resolveDimensions } from "../lib/dimensions";
import { getAudioDuration } from "../lib/audio";
import { getWaveformPeaks } from "../lib/waveform";
import { renderVideo } from "../lib/ffmpegRender";
import { DEFAULT_TRANSITION_DURATION } from "../lib/transitions";
import Dropzone from "../components/Dropzone";
import Editor from "../components/Editor";

function loadImageEl(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { img.url = url; resolve(img); };
    img.src = url;
  });
}

function revoke(slot) {
  if (slot && slot.img && slot.img.url) URL.revokeObjectURL(slot.img.url);
}

// A slot is one point on the timeline: { id, seconds, file, img, empty }.
// Empty slots are placeholders (a removed image or the lead-in you filled out).
export default function Home() {
  const [audioFile, setAudioFile] = useState(null);
  const [audioUrl, setAudioUrl] = useState(null);
  const [audioDuration, setAudioDuration] = useState(0);
  const [peaks, setPeaks] = useState([]);
  const [slots, setSlots] = useState([]);
  const [aspect, setAspect] = useState("16:9");
  const [fps, setFps] = useState(30);
  const [transitionsByName, setTransitionsByName] = useState({}); // clip name -> transition id
  const [transitionDuration, setTransitionDuration] = useState(DEFAULT_TRANSITION_DURATION);
  const [motionByName, setMotionByName] = useState({}); // clip name -> zoomin | zoomout
  const [motionAmount, setMotionAmount] = useState(0.08);
  const [fadeIn, setFadeIn] = useState(0.5);          // opening fade seconds (0 = off)
  const [fadeOut, setFadeOut] = useState(0.6);        // ending fade seconds (0 = off)
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [outUrl, setOutUrl] = useState(null);
  const [error, setError] = useState(null);
  const idRef = useRef(0);
  const nextId = () => `s${idRef.current++}`;

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
    setSlots((prev) => {
      const next = prev.map((s) => ({ ...s }));
      for (const { file, seconds, img } of loaded) {
        const slot = seconds != null ? next.find((s) => s.seconds === seconds) : null;
        if (slot) {
          revoke(slot);
          slot.file = file; slot.img = img; slot.empty = false;
        } else {
          next.push({ id: nextId(), seconds, file, img, empty: false });
        }
      }
      return next;
    });
  }, []);

  // Swap the image in one slot, keeping its timestamp.
  const replaceImage = useCallback(async (id, file) => {
    if (!file || !file.type.startsWith("image/")) return;
    const img = await loadImageEl(file);
    setSlots((prev) => prev.map((s) => {
      if (s.id !== id) return s;
      revoke(s);
      return { ...s, file, img, empty: false };
    }));
  }, []);

  // Removing an image turns its slot into a placeholder — neighbours don't move.
  const removeImage = useCallback((id) => {
    setSlots((prev) => prev.map((s) => {
      if (s.id !== id) return s;
      revoke(s);
      return { ...s, file: null, img: null, empty: true };
    }));
  }, []);

  // Fill a gap. LEAD_IN adds a new slot at 0; otherwise fill the empty slot.
  const fillGap = useCallback(async (name, file) => {
    if (!file || !file.type.startsWith("image/")) return;
    const img = await loadImageEl(file);
    if (name === LEAD_IN) {
      setSlots((prev) => [...prev, { id: nextId(), seconds: 0, file, img, empty: false }]);
    } else {
      setSlots((prev) => prev.map((s) => (s.id === name ? { ...s, file, img, empty: false } : s)));
    }
  }, []);

  const setTransition = useCallback((name, type) => {
    setTransitionsByName((prev) => ({ ...prev, [name]: type }));
  }, []);
  const applyTransitionAll = useCallback((type, clipNames) => {
    setTransitionsByName(() => {
      const next = {};
      // Skip the first clip — it has no incoming cut.
      for (let i = 1; i < clipNames.length; i++) next[clipNames[i]] = type;
      return next;
    });
  }, []);

  const setMotion = useCallback((name, type) => {
    setMotionByName((prev) => ({ ...prev, [name]: type }));
  }, []);
  const applyMotionAll = useCallback((type, imageNames) => {
    setMotionByName(() => {
      const next = {};
      for (const name of imageNames) next[name] = type;
      return next;
    });
  }, []);
  const applyMotionAlternate = useCallback((imageNames) => {
    setMotionByName(() => {
      const next = {};
      imageNames.forEach((name, i) => { next[name] = i % 2 === 0 ? "zoomin" : "zoomout"; });
      return next;
    });
  }, []);

  const items = useMemo(
    () => slots.map((s) => ({ name: s.id, seconds: s.seconds, empty: s.empty })),
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

  const ready = audioFile && clips.length > 0;

  const onRender = useCallback(async () => {
    setBusy(true); setError(null); setOutUrl(null); setProgress(0);
    try {
      const transitions = clips.map((c) => transitionsByName[c.name] || "cut");
      const motions = clips.map((c) => motionByName[c.name] || "none");
      const blob = await renderVideo({
        clips, imagesByName, audioFile,
        width: dims.width, height: dims.height, fps,
        transitions, transitionDuration,
        motions, motionAmount, fadeIn, fadeOut,
        onProgress: setProgress,
      });
      setOutUrl(URL.createObjectURL(blob));
    } catch (e) { setError(e.message || String(e)); }
    finally { setBusy(false); }
  }, [clips, imagesByName, audioFile, dims, fps, transitionsByName, transitionDuration, motionByName, motionAmount, fadeIn, fadeOut]);

  return (
    <main className="app">
      <header className="bar">
        <div className="brand">
          <span className="brand__dot" />
          <span className="brand__name">AutoReel</span>
          <span className="brand__tag">image · voiceover sync</span>
        </div>
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
      </header>

      <div className="content">
      {!ready ? (
        <section className="onboard">
          <h1 className="onboard__h">Sync your images to a voiceover, automatically.</h1>
          <p className="onboard__p">
            Name each image with the second it appears — <code>0-03.png</code> cuts in at 0:03 —
            then drop it in with your voiceover. AutoReel builds the timeline for you.
            Everything runs in your browser; nothing is uploaded.
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
              title="Storyboard images"
              hint="Named by timestamp, e.g. 0-00, 0-06, 0-12"
              filled={imageCount > 0}
              filledLabel={imageCount ? `${imageCount} images ready` : ""}
            />
          </div>

          {audioFile && imageCount > 0 && warnings.length > 0 && (
            <div className="notes">{warnings.map((w, i) => <div className="note" key={i}>{w}</div>)}</div>
          )}
          {error && <div className="note note--bad">{error}</div>}

          <ol className="steps">
            <li><b>1</b> Drop a voiceover — it defines the timeline length.</li>
            <li><b>2</b> Drop images named by their timestamp.</li>
            <li><b>3</b> Scrub, check the cuts, and render your MP4.</li>
          </ol>
        </section>
      ) : (
        <Editor
          clips={clips} imageEls={imageEls} audioUrl={audioUrl}
          duration={audioDuration} peaks={peaks} dims={dims}
          aspect={aspect} setAspect={setAspect} fps={fps} setFps={setFps}
          onRender={onRender} busy={busy} progress={progress}
          outUrl={outUrl} error={error} warnings={warnings}
          replaceImage={replaceImage} removeImage={removeImage} fillGap={fillGap}
          transitionsByName={transitionsByName} transitionDuration={transitionDuration}
          setTransition={setTransition} applyTransitionAll={applyTransitionAll}
          setTransitionDuration={setTransitionDuration}
          motionByName={motionByName} setMotion={setMotion}
          applyMotionAll={applyMotionAll} applyMotionAlternate={applyMotionAlternate}
          motionAmount={motionAmount} setMotionAmount={setMotionAmount}
          fadeIn={fadeIn} setFadeIn={setFadeIn}
          fadeOut={fadeOut} setFadeOut={setFadeOut}
        />
      )}
      </div>
    </main>
  );
}
