"use client";
import { useCallback, useMemo, useState } from "react";
import "./globals.css";
import { parseTimestampName } from "../lib/timestamp";
import { buildTimeline } from "../lib/timeline";
import { resolveDimensions } from "../lib/dimensions";
import { getAudioDuration } from "../lib/audio";
import { getWaveformPeaks } from "../lib/waveform";
import { renderVideo } from "../lib/ffmpegRender";
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

export default function Home() {
  const [audioFile, setAudioFile] = useState(null);
  const [audioUrl, setAudioUrl] = useState(null);
  const [audioDuration, setAudioDuration] = useState(0);
  const [peaks, setPeaks] = useState([]);
  const [imagesByName, setImagesByName] = useState({}); // name -> File
  const [imageEls, setImageEls] = useState({});         // name -> HTMLImageElement (with .url)
  const [aspect, setAspect] = useState("16:9");
  const [fps, setFps] = useState(30);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [outUrl, setOutUrl] = useState(null);
  const [error, setError] = useState(null);

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

  // Merge imported images into the existing set (same filename overwrites).
  const addImages = useCallback(async (fileList) => {
    const files = Array.from(fileList).filter((f) => f.type.startsWith("image/"));
    if (!files.length) return;
    const loaded = await Promise.all(files.map(async (f) => [f.name, f, await loadImageEl(f)]));
    setImagesByName((prev) => {
      const next = { ...prev };
      for (const [name, file] of loaded) next[name] = file;
      return next;
    });
    setImageEls((prev) => {
      const next = { ...prev };
      for (const [name, , img] of loaded) {
        if (next[name] && next[name].url) URL.revokeObjectURL(next[name].url);
        next[name] = img;
      }
      return next;
    });
  }, []);

  // Swap the image for one timeline slot, keeping the original name (timestamp).
  const replaceImage = useCallback(async (name, file) => {
    if (!file || !file.type.startsWith("image/")) return;
    const img = await loadImageEl(file);
    setImagesByName((prev) => ({ ...prev, [name]: file }));
    setImageEls((prev) => {
      if (prev[name] && prev[name].url) URL.revokeObjectURL(prev[name].url);
      return { ...prev, [name]: img };
    });
  }, []);

  const removeImage = useCallback((name) => {
    setImagesByName((prev) => { const n = { ...prev }; delete n[name]; return n; });
    setImageEls((prev) => {
      if (prev[name] && prev[name].url) URL.revokeObjectURL(prev[name].url);
      const n = { ...prev }; delete n[name]; return n;
    });
  }, []);

  const items = useMemo(
    () => Object.keys(imagesByName).map((name) => ({ name, seconds: parseTimestampName(name) })),
    [imagesByName]
  );
  const imageCount = items.length;

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

          {imageCount > 0 && warnings.length > 0 && (
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
          replaceImage={replaceImage} removeImage={removeImage} addImages={addImages}
        />
      )}
    </main>
  );
}
