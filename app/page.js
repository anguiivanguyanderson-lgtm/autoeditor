"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./globals.css";
import { parseTimestampName } from "../lib/timestamp";
import { buildTimeline, trimClips, LEAD_IN } from "../lib/timeline";
import { resolveDimensions, capTo720 } from "../lib/dimensions";
import { getAudioDuration } from "../lib/audio";
import { getWaveformPeaks } from "../lib/waveform";
import { renderVideo, cancelRender, getActiveRender, reconnectRender, probeBackend } from "../lib/serverRender";
import { renderWebCodecs, webCodecsSupported, startKeepAwake } from "../lib/webcodecsRender";
import { DEFAULT_TRANSITION_DURATION, mixTransitions } from "../lib/transitions";
import { parseTranscript } from "../lib/captions";
import Dropzone from "../components/Dropzone";
import Editor from "../components/Editor";
import ProjectsHome from "../components/ProjectsHome";
import StorageRing from "../components/StorageRing";
import { DialogHost, showAlert, showPrompt } from "../components/Dialog";
import {
  requestPersist, storageEstimate, listProjects, getProject, saveProject,
  renameProject, deleteProject, getMedia, syncMedia, newId,
} from "../lib/projectStore";

function loadImageEl(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { img.url = url; img.fileName = file.name; resolve(img); };
    img.src = url;
  });
}

// Load a video clip as a still-poster Image (so the timeline/canvas draw it just
// like a photo) while carrying the video's URL + duration for the trim scrubber
// and export. img.url = poster (drawable), img.videoUrl = the actual video.
function loadVideoEl(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const finish = (posterSrc, w, h, dur) => {
      const img = new Image();
      img.onload = () => {
        img.url = posterSrc; img.fileName = file.name;
        img.isVideo = true; img.videoUrl = url; img.videoDuration = dur || 0;
        resolve(img);
      };
      img.onerror = () => { // poster failed — resolve a bare marker so it still imports
        img.url = null; img.fileName = file.name; img.isVideo = true;
        img.videoUrl = url; img.videoDuration = dur || 0; resolve(img);
      };
      img.src = posterSrc || url;
    };
    const v = document.createElement("video");
    v.preload = "metadata"; v.muted = true; v.playsInline = true; v.src = url;
    v.onloadeddata = () => {
      const grab = () => {
        try {
          const c = document.createElement("canvas");
          c.width = v.videoWidth || 1280; c.height = v.videoHeight || 720;
          c.getContext("2d").drawImage(v, 0, 0, c.width, c.height);
          finish(c.toDataURL("image/jpeg", 0.82), c.width, c.height, v.duration);
        } catch { finish(null, v.videoWidth, v.videoHeight, v.duration); }
      };
      v.onseeked = grab;
      try { v.currentTime = Math.min(0.1, (v.duration || 1) / 2); } catch { grab(); }
    };
    v.onerror = () => finish(null, 0, 0, 0);
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
  const reset = useCallback((present) => setHist({ past: [], present, future: [] }), []);
  return [
    hist.present, commit,
    { undo, redo, canUndo: hist.past.length > 0, canRedo: hist.future.length > 0, reset },
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
  const [renderQuality, setRenderQuality] = useState("full"); // "full" | "720p"
  const [transitionDuration, setTransitionDuration] = useState(DEFAULT_TRANSITION_DURATION);
  const [fadeIn, setFadeIn] = useState(0.5);          // opening fade seconds (0 = off)
  const [fadeOut, setFadeOut] = useState(0.6);        // ending fade seconds (0 = off)
  const [motionByName, setMotionByName] = useState({}); // clip name -> zoomin | zoomout
  const [motionAmount, setMotionAmount] = useState(0.08); // Ken Burns zoom depth (0–0.2)
  const [trimByName, setTrimByName] = useState({});   // video clip name -> in-point seconds
  const [volumeByName, setVolumeByName] = useState({}); // video clip name -> 0..1 (default 0.5)
  const [fitByName, setFitByName] = useState({});     // video clip name -> "fit" (fast-fwd, default) | "trim" (1x)
  const [trimEnd, setTrimEnd] = useState(0); // export end point (0 = untrimmed / full audio)
  const [captionRaw, setCaptionRaw] = useState(null); // uploaded transcript text
  const [captionName, setCaptionName] = useState(null);
  const [captionsOn, setCaptionsOn] = useState(false);
  const [captionStyle, setCaptionStyle] = useState("classic");
  const [captionSize, setCaptionSize] = useState("md");
  const [captionLineHeight, setCaptionLineHeight] = useState(null); // null = per-style default
  const [captionFontScale, setCaptionFontScale] = useState(null);   // null = use the size preset
  const [importing, setImporting] = useState(null);   // { done, total } while decoding imports
  const [built, setBuilt] = useState(false);          // committed images to the timeline?
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [outUrl, setOutUrl] = useState(null);
  const [error, setError] = useState(null);
  // A render that was already running when this tab loaded (e.g. reopened after
  // closing the browser mid-render). Shown as a banner and reconnected to.
  const [resume, setResume] = useState(null); // { busy, progress, url, error }
  // Projects: everything is stored client-side in IndexedDB (see lib/projectStore).
  const [view, setView] = useState("list");            // "list" (projects grid) | "editor"
  const [projects, setProjects] = useState([]);
  const [currentProject, setCurrentProject] = useState(null); // { id, name, createdAt }
  const [storage, setStorage] = useState({ usage: 0, quota: 0 });
  const [loadingProject, setLoadingProject] = useState(false);
  const saveRef = useRef(null);
  const idRef = useRef(0);
  const nextId = () => `s${idRef.current++}`;

  // Composition (undoable): slots + per-clip transition choices, snapshotted together.
  const [doc, commitDoc, { undo, redo, canUndo, canRedo, reset: resetDoc }] =
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
    const files = Array.from(fileList).filter((f) => f.type.startsWith("image/") || f.type.startsWith("video/"));
    if (!files.length) return;
    // Decoding many files (esp. video posters) takes a few seconds with no UI —
    // show live "loaded X of N" progress, ticking up as each file finishes.
    setImporting({ done: 0, total: files.length });
    try {
      const loaded = await Promise.all(
        files.map(async (f) => {
          const img = f.type.startsWith("video/") ? await loadVideoEl(f) : await loadImageEl(f);
          setImporting((p) => (p ? { ...p, done: p.done + 1 } : p));
          return { file: f, seconds: parseTimestampName(f.name), img };
        })
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
    } finally {
      setImporting(null);
    }
  }, [commitDoc]);

  // Swap the image/video in one slot, keeping its timestamp.
  const replaceImage = useCallback(async (id, file) => {
    if (!file) return;
    const isVid = file.type.startsWith("video/");
    if (!isVid && !file.type.startsWith("image/")) return;
    const img = isVid ? await loadVideoEl(file) : await loadImageEl(file);
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
    if (!file) return;
    const isVid = file.type.startsWith("video/");
    if (!isVid && !file.type.startsWith("image/")) return;
    const img = isVid ? await loadVideoEl(file) : await loadImageEl(file);
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

  const setMotion = useCallback((name, type) => {
    setMotionByName((prev) => ({ ...prev, [name]: type }));
  }, []);
  const setTrim = useCallback((name, seconds) => {
    setTrimByName((prev) => ({ ...prev, [name]: Math.max(0, +seconds || 0) }));
  }, []);
  const setVolume = useCallback((name, vol) => {
    setVolumeByName((prev) => ({ ...prev, [name]: Math.min(1, Math.max(0, +vol || 0)) }));
  }, []);
  const setFit = useCallback((name, mode) => {
    setFitByName((prev) => ({ ...prev, [name]: mode }));
  }, []);
  const applyMotionAll = useCallback((type, names) => {
    setMotionByName(() => { const next = {}; for (const n of names) next[n] = type; return next; });
  }, []);
  const applyMotionAlternate = useCallback((names) => {
    setMotionByName(() => {
      const next = {};
      names.forEach((n, i) => { next[n] = i % 2 === 0 ? "zoomin" : "zoomout"; });
      return next;
    });
  }, []);
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
  // Images and videos are uploaded on separate maps (the backend tells them apart
  // by extension anyway, but this keeps the client render spec explicit).
  const imagesByName = useMemo(() => {
    const m = {};
    for (const s of slots) if (!s.empty && s.file && !(s.img && s.img.isVideo)) m[s.id] = s.file;
    return m;
  }, [slots]);
  const videosByName = useMemo(() => {
    const m = {};
    for (const s of slots) if (!s.empty && s.file && s.img && s.img.isVideo) m[s.id] = s.file;
    return m;
  }, [slots]);
  // Video URL + duration per clip, for the trim scrubber in the inspector.
  const videoInfoByName = useMemo(() => {
    const m = {};
    for (const s of slots) if (!s.empty && s.img && s.img.isVideo) {
      m[s.id] = { url: s.img.videoUrl, duration: s.img.videoDuration || 0 };
    }
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
  // The resolution actually exported: capped to 720p when the faster option is on.
  const renderDims = useMemo(
    () => (renderQuality === "720p" ? capTo720(dims) : dims),
    [renderQuality, dims]
  );

  // On mobile (touch), default to the lighter settings — ~2x faster, far less
  // CPU/RAM load (which also helps avoid Termux connection drops). Runs once.
  useEffect(() => {
    try {
      if (window.matchMedia && window.matchMedia("(pointer: coarse)").matches) {
        setRenderQuality("720p");
        setFps(24);
      }
    } catch { /* ignore */ }
  }, []);
  const { clips, warnings } = useMemo(
    () => buildTimeline(items, audioDuration),
    [items, audioDuration]
  );

  // A new voiceover resets any prior trim to the full length.
  useEffect(() => { setTrimEnd(audioDuration); }, [audioDuration]);

  const exportDuration = trimEnd > 0 ? Math.min(trimEnd, audioDuration) : audioDuration;

  const ready = audioFile && clips.length > 0;
  const showEditor = built && ready;

  // --- Projects: client-side persistence (IndexedDB) ------------------------
  // On launch, ask for durable storage and load the saved projects list.
  useEffect(() => {
    (async () => {
      try {
        await requestPersist();
        setProjects(await listProjects());
        setStorage(await storageEstimate());
      } catch (_) {}
    })();
  }, []);

  const resetAllState = useCallback(() => {
    setAudioFile(null); setAudioUrl(null); setAudioDuration(0); setPeaks([]);
    setAspect("16:9"); setFps(30); setRenderQuality("full");
    setTransitionDuration(DEFAULT_TRANSITION_DURATION); setFadeIn(0.5); setFadeOut(0.6);
    setMotionByName({}); setMotionAmount(0.08); setTrimByName({}); setVolumeByName({}); setFitByName({});
    setTrimEnd(0);
    setCaptionRaw(null); setCaptionName(null); setCaptionsOn(false); setCaptionStyle("classic");
    setCaptionSize("md"); setCaptionLineHeight(null); setCaptionFontScale(null);
    setError(null); setOutUrl(null); setProgress(0);
    idRef.current = 0;
    resetDoc({ slots: [], transitionsByName: {} });
    setBuilt(false);
  }, [resetDoc]);

  const newProject = useCallback(() => {
    resetAllState();
    setCurrentProject({ id: newId(), name: "Untitled project", createdAt: Date.now() });
    setView("editor");
  }, [resetAllState]);

  // A small JPEG thumbnail from the first image, stored with the project.
  const makeThumb = useCallback(() => {
    const s = slots.find((x) => !x.empty && x.img);
    const img = s && s.img;
    if (!img) return null;
    try {
      const iw = img.naturalWidth || img.videoWidth || 320;
      const ih = img.naturalHeight || img.videoHeight || 180;
      const W = 320, H = Math.max(1, Math.round((W * ih) / iw));
      const c = document.createElement("canvas"); c.width = W; c.height = H;
      c.getContext("2d").drawImage(img, 0, 0, W, H);
      return c.toDataURL("image/jpeg", 0.7);
    } catch (_) { return (img.url && String(img.url).startsWith("data:")) ? img.url : null; }
  }, [slots]);

  // Serialize the edit state (no media bytes) for the projects store.
  const buildProjectData = useCallback(() => ({
    v: 1,
    settings: { aspect, fps, renderQuality, transitionDuration, fadeIn, fadeOut, motionAmount, trimEnd },
    maps: { motionByName, trimByName, volumeByName, fitByName },
    captions: { captionRaw, captionName, captionsOn, captionStyle, captionSize, captionLineHeight, captionFontScale },
    transitionsByName,
    slots: slots.map((s) => ({
      id: s.id, seconds: s.seconds, empty: !!s.empty,
      fileName: s.file ? s.file.name : (s.img && s.img.fileName) || null,
      isVideo: !!(s.img && s.img.isVideo),
    })),
    audioName: audioFile ? audioFile.name : null,
    idCounter: idRef.current,
    built,
  }), [aspect, fps, renderQuality, transitionDuration, fadeIn, fadeOut, motionAmount, trimEnd,
      motionByName, trimByName, volumeByName, fitByName,
      captionRaw, captionName, captionsOn, captionStyle, captionSize, captionLineHeight, captionFontScale,
      transitionsByName, slots, audioFile, built]);

  const saveCurrent = useCallback(async () => {
    const proj = currentProject;
    if (!proj) return;
    try {
      const rec = {
        id: proj.id, name: proj.name, createdAt: proj.createdAt || Date.now(),
        thumb: makeThumb(), durationSec: exportDuration, clipCount: clips.length,
        data: buildProjectData(),
      };
      await saveProject(rec);
      const wanted = new Map();
      if (audioFile) wanted.set("audio", audioFile);
      for (const s of slots) if (!s.empty && s.file) wanted.set(s.id, s.file);
      await syncMedia(proj.id, wanted);
      try { setStorage(await storageEstimate()); } catch (_) {}
    } catch (_) { /* storage full or unavailable — keep editing */ }
  }, [currentProject, makeThumb, exportDuration, clips.length, buildProjectData, audioFile, slots]);
  saveRef.current = saveCurrent;

  // Debounced autosave whenever the composition changes.
  useEffect(() => {
    if (view !== "editor" || !currentProject) return;
    const t = setTimeout(() => { if (saveRef.current) saveRef.current(); }, 1200);
    return () => clearTimeout(t);
  }, [view, currentProject, slots, transitionsByName, aspect, fps, renderQuality, transitionDuration,
      fadeIn, fadeOut, motionByName, motionAmount, trimByName, volumeByName, fitByName, trimEnd,
      captionRaw, captionName, captionsOn, captionStyle, captionSize, captionLineHeight, captionFontScale,
      audioFile, built]);

  const openProject = useCallback(async (id) => {
    const rec = await getProject(id);
    if (!rec) return;
    setLoadingProject(true);
    try {
      const d = rec.data || {};
      // Audio
      if (d.audioName) {
        const blob = await getMedia(id, "audio");
        if (blob) {
          const file = new File([blob], d.audioName, { type: blob.type || "audio/mpeg" });
          setAudioFile(file); setAudioUrl(URL.createObjectURL(file));
          try { setAudioDuration(await getAudioDuration(file)); } catch (_) {}
          getWaveformPeaks(file).then(setPeaks).catch(() => {});
        } else { setAudioFile(null); setAudioUrl(null); setAudioDuration(0); setPeaks([]); }
      } else { setAudioFile(null); setAudioUrl(null); setAudioDuration(0); setPeaks([]); }
      // Slots (rebuild images/videos from stored blobs)
      const newSlots = [];
      for (const sm of (d.slots || [])) {
        if (sm.empty) { newSlots.push({ id: sm.id, seconds: sm.seconds, file: null, img: null, empty: true }); continue; }
        const blob = await getMedia(id, sm.id);
        if (!blob) { newSlots.push({ id: sm.id, seconds: sm.seconds, file: null, img: null, empty: true }); continue; }
        const file = new File([blob], sm.fileName || sm.id, { type: blob.type || (sm.isVideo ? "video/mp4" : "image/png") });
        const img = sm.isVideo ? await loadVideoEl(file) : await loadImageEl(file);
        newSlots.push({ id: sm.id, seconds: sm.seconds, file, img, empty: false });
      }
      resetDoc({ slots: newSlots, transitionsByName: d.transitionsByName || {} });
      const st = d.settings || {};
      setAspect(st.aspect ?? "16:9"); setFps(st.fps ?? 30); setRenderQuality(st.renderQuality ?? "full");
      setTransitionDuration(st.transitionDuration ?? DEFAULT_TRANSITION_DURATION);
      setFadeIn(st.fadeIn ?? 0.5); setFadeOut(st.fadeOut ?? 0.6);
      setMotionAmount(st.motionAmount ?? 0.08); setTrimEnd(st.trimEnd ?? 0);
      const mp = d.maps || {};
      setMotionByName(mp.motionByName || {}); setTrimByName(mp.trimByName || {});
      setVolumeByName(mp.volumeByName || {}); setFitByName(mp.fitByName || {});
      const cp = d.captions || {};
      setCaptionRaw(cp.captionRaw ?? null); setCaptionName(cp.captionName ?? null);
      setCaptionsOn(!!cp.captionsOn); setCaptionStyle(cp.captionStyle ?? "classic");
      setCaptionSize(cp.captionSize ?? "md"); setCaptionLineHeight(cp.captionLineHeight ?? null);
      setCaptionFontScale(cp.captionFontScale ?? null);
      idRef.current = d.idCounter || newSlots.length;
      setBuilt(!!d.built);
      setError(null); setOutUrl(null); setProgress(0);
      setCurrentProject({ id: rec.id, name: rec.name, createdAt: rec.createdAt });
      setView("editor");
    } finally { setLoadingProject(false); }
  }, [resetDoc]);

  // navigator.storage.estimate() lags behind an IndexedDB delete/write, so re-poll
  // a few times to catch the freed/added space without needing a manual refresh.
  const refreshStorage = useCallback(() => {
    const tick = async () => { try { setStorage(await storageEstimate()); } catch (_) {} };
    tick();
    setTimeout(tick, 500);
    setTimeout(tick, 1500);
    setTimeout(tick, 3000);
  }, []);

  const backToProjects = useCallback(async () => {
    if (saveRef.current) await saveRef.current();
    setProjects(await listProjects());
    refreshStorage();
    setView("list");
  }, [refreshStorage]);

  const onRenameProject = useCallback(async (id, name) => {
    await renameProject(id, name);
    setCurrentProject((p) => (p && p.id === id ? { ...p, name } : p));
    setProjects(await listProjects());
  }, []);
  const onDeleteProject = useCallback(async (id) => {
    await deleteProject(id);
    setProjects(await listProjects());
    refreshStorage();
  }, [refreshStorage]);
  const renameCurrent = useCallback(async () => {
    if (!currentProject) return;
    const name = await showPrompt("Rename project", {
      title: "Rename project", defaultValue: currentProject.name || "Untitled project", okText: "Rename",
    });
    if (name && name.trim()) onRenameProject(currentProject.id, name.trim());
  }, [currentProject, onRenameProject]);

  const cancelRef = useRef(false);
  const onCancel = useCallback(() => {
    cancelRef.current = true;
    cancelRender();
    setBusy(false);
    setProgress(0);
  }, []);
  const wcCancelRef = useRef(false);
  const onWebCodecsCancel = useCallback(() => { wcCancelRef.current = true; }, []);

  const onRender = useCallback(async () => {
    cancelRef.current = false;
    setBusy(true); setError(null); setOutUrl(null); setProgress(0);
    try {
      const exportClips = trimClips(clips, exportDuration);
      const transitions = exportClips.map((c) => transitionsByName[c.name] || "cut");
      const motions = exportClips.map((c) => motionByName[c.name] || "none");
      // Per-clip video params (parallel to exportClips). Images get 0/1/none.
      // Default depends on length: a clip LONGER than its slot trims (1x + in-point,
      // extra cut off); a clip SHORTER slows to fill the slot ("fit"). An explicit
      // fitByName choice overrides the default.
      const modeOf = (c) => {
        const info = videoInfoByName[c.name];
        if (!info) return "fit";
        return fitByName[c.name] || ((info.duration || 0) > (c.duration || 0) ? "trim" : "fit");
      };
      const trims = exportClips.map((c) =>
        (videoInfoByName[c.name] && modeOf(c) === "trim") ? (trimByName[c.name] || 0) : 0);
      const speeds = exportClips.map((c) => {
        const info = videoInfoByName[c.name];
        if (!info) return 1;
        const dur = info.duration || 0, slot = c.duration || 0;
        return (modeOf(c) === "fit" && slot > 0 && dur > 0 && Math.abs(dur - slot) > 0.05) ? +(dur / slot).toFixed(4) : 1;
      });
      const volumes = exportClips.map((c) =>
        Object.prototype.hasOwnProperty.call(videosByName, c.name)
          ? (volumeByName[c.name] == null ? 0.5 : volumeByName[c.name]) : 0);
      const captions = captionsOn && captionCues.length ? captionCues : null;
      const blob = await renderVideo({
        clips: exportClips, imagesByName, videosByName, audioFile,
        width: renderDims.width, height: renderDims.height, fps,
        transitions, transitionDuration, motions, motionAmount, trims, volumes, speeds, fadeIn, fadeOut,
        captions, captionStyle, captionSize, captionLineHeight, captionFontScale,
        onProgress: setProgress,
      });
      setOutUrl(URL.createObjectURL(blob));
    } catch (e) {
      if (!cancelRef.current) setError(e.message || String(e));
    } finally {
      if (!cancelRef.current) setBusy(false);
    }
  }, [clips, exportDuration, imagesByName, videosByName, audioFile, renderDims, fps, transitionsByName, transitionDuration,
      motionByName, motionAmount, trimByName, volumeByName, fitByName, videoInfoByName, fadeIn, fadeOut,
      captionsOn, captionCues, captionStyle, captionSize, captionLineHeight, captionFontScale]);

  // --- SPIKE: WebCodecs GPU render (video-only, no audio). Proves the pipeline. ---
  const [wcBusy, setWcBusy] = useState(false);
  const [wcProgress, setWcProgress] = useState(0);
  const [wcOk, setWcOk] = useState(false);
  const [serverAvailable, setServerAvailable] = useState(false); // ffmpeg backend reachable?
  const [wcEnabled, setWcEnabled] = useState(true); // WebCodecs on by default (desktop)
  useEffect(() => {
    setWcOk(webCodecsSupported());
    probeBackend().then(setServerAvailable).catch(() => setServerAvailable(false));
  }, []);
  const onWebCodecsTest = useCallback(async () => {
    setWcBusy(true); setWcProgress(0);
    wcCancelRef.current = false;
    // Play inaudible audio for the duration so a backgrounded tab keeps rendering
    // at full speed (started here, inside the click gesture, so it's allowed).
    const stopKeepAwake = startKeepAwake();
    try {
      const exportClips = trimClips(clips, exportDuration);
      const transitions = exportClips.map((c) => transitionsByName[c.name] || "cut");
      const motions = exportClips.map((c) => motionByName[c.name] || "none");
      // Per-clip video params (parallel to exportClips), same rule as the ffmpeg
      // path: long clip → trim (1x + in-point), short clip → fit (slow to fill).
      const modeOf = (c) => {
        const info = videoInfoByName[c.name];
        if (!info) return "fit";
        return fitByName[c.name] || ((info.duration || 0) > (c.duration || 0) ? "trim" : "fit");
      };
      const trims = exportClips.map((c) =>
        (videoInfoByName[c.name] && modeOf(c) === "trim") ? (trimByName[c.name] || 0) : 0);
      const speeds = exportClips.map((c) => {
        const info = videoInfoByName[c.name];
        if (!info) return 1;
        const dur = info.duration || 0, slot = c.duration || 0;
        return (modeOf(c) === "fit" && slot > 0 && dur > 0 && Math.abs(dur - slot) > 0.05) ? +(dur / slot).toFixed(4) : 1;
      });
      const volumes = exportClips.map((c) =>
        Object.prototype.hasOwnProperty.call(videosByName, c.name)
          ? (volumeByName[c.name] == null ? 0.5 : volumeByName[c.name]) : 0);
      const blob = await renderWebCodecs(
        {
          clips: exportClips, width: renderDims.width, height: renderDims.height, fps,
          transitions, transitionDuration, motions, motionAmount, audioFile,
          videosByName, trims, speeds, volumes,
          cues: captionsOn && captionCues.length ? captionCues : null,
          captionStyle, captionSize, captionLineHeight, captionFontScale,
        },
        imagesByName,
        setWcProgress,
        () => wcCancelRef.current,
      );
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = "webcodecs-test.mp4"; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (e) {
      if (!(e && e.cancelled)) showAlert(e && e.message ? e.message : String(e), { title: "Fast render failed" });
    } finally {
      stopKeepAwake();
      setWcBusy(false);
      setWcProgress(0);
    }
  }, [clips, exportDuration, transitionsByName, motionByName, imagesByName, renderDims, fps, transitionDuration, motionAmount, audioFile,
      videosByName, videoInfoByName, fitByName, trimByName, volumeByName,
      captionsOn, captionCues, captionStyle, captionSize, captionLineHeight, captionFontScale]);

  if (view === "list") {
    return (
      <>
        <DialogHost />
        <ProjectsHome
          projects={projects}
          onNew={newProject}
          onOpen={openProject}
          onRename={onRenameProject}
          onDelete={onDeleteProject}
          storage={storage}
        />
      </>
    );
  }

  return (
    <>
    <DialogHost />
    <main className="app">
      {loadingProject && (
        <div className="importing" role="status" aria-live="polite">
          <span className="importing__spin" aria-hidden="true" />
          Opening project…
        </div>
      )}
      <header className="nav">
        <div className="nav__brand">
          <img className="brand__logo" src="/logo.svg" alt="" width="28" height="28" />
          <span className="brand__name"><span className="brand__pre">TryAIToday</span> AutoEditor</span>
          <span className="brand__tag">image + video · voiceover sync</span>
        </div>
        <div className="nav__links">
          <a
            className="dc-link"
            href="https://discord.gg/5sxVBf3kx8"
            target="_blank"
            rel="noopener noreferrer"
            title="Join the TryAIToday Discord"
          >
            <svg className="dc-link__icon" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
              <path d="M20.317 4.3698a19.7913 19.7913 0 0 0-4.8851-1.5152.0741.0741 0 0 0-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 0 0-.0785-.037 19.7363 19.7363 0 0 0-4.8852 1.515.0699.0699 0 0 0-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 0 0 .0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 0 0 .0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 0 0-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 0 1-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 0 1 .0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 0 1 .0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 0 1-.0066.1276 12.2986 12.2986 0 0 1-1.873.8914.0766.0766 0 0 0-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 0 0 .0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 0 0 .0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 0 0-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189z"/>
            </svg>
            <span className="dc-link__text">Discord</span>
          </a>
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
          <StorageRing storage={storage} />
        </div>
      </header>

      <div className={`projbar${showEditor ? "" : " projbar--onboard"}`}>
        <div className="projbar__id">
          <button className="brand__back" onClick={backToProjects} title="Back to your projects">←</button>
          <button className="brand__proj" onClick={renameCurrent} title="Rename project">
            {currentProject ? (currentProject.name || "Untitled project") : "AutoEditor"}
          </button>
        </div>
        <div className="bar__io">
          <Dropzone
            compact accept="audio/*" onFiles={onAudio} icon="♪"
            title="Import voiceover" filled={!!audioFile}
            filledLabel={audioFile ? audioFile.name : ""}
          />
          <Dropzone
            compact multiple accept="image/*,video/*" onFiles={addImages} icon="▦"
            title="Add media" filled={imageCount > 0}
            filledLabel={imageCount ? `${imageCount} clips` : ""}
          />
        </div>
      </div>

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

      {importing && (
        <div className="importing" role="status" aria-live="polite">
          <span className="importing__spin" aria-hidden="true" />
          Loading media… {importing.done} / {importing.total}
        </div>
      )}

      <div className="content">
      {!showEditor ? (
        <section className="onboard">
          <h1 className="onboard__h">Sync your images to a voiceover, automatically.</h1>
          <p className="onboard__p">
            Name each image or video clip with the second it appears — <code>0-03.png</code> or
            <code>0-03.mp4</code> cuts in at 0:03 — then import them with your voiceover. Video clips
            can be trimmed, zoomed, and their sound mixed under the narration. Review everything below,
            then build the timeline. Everything runs on your device. Nothing is uploaded.
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
              multiple accept="image/*,video/*" onFiles={addImages} icon="▦"
              title={tray.length ? "Add more media" : "Storyboard images & video"}
              hint="Images or video clips, named by timestamp (0-00, 0-06…). Drop files or whole folders — even several at once."
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
          renderQuality={renderQuality} setRenderQuality={setRenderQuality} renderDims={renderDims}
          onWebCodecsTest={onWebCodecsTest} onWebCodecsCancel={onWebCodecsCancel}
          wcBusy={wcBusy} wcProgress={wcProgress} wcAvailable={wcOk} serverAvailable={serverAvailable}
          wcEnabled={wcEnabled} setWcEnabled={setWcEnabled}
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
          motionByName={motionByName} setMotion={setMotion}
          applyMotionAll={applyMotionAll} applyMotionAlternate={applyMotionAlternate}
          motionAmount={motionAmount} setMotionAmount={setMotionAmount}
          videoInfoByName={videoInfoByName}
          trimByName={trimByName} setTrim={setTrim}
          volumeByName={volumeByName} setVolume={setVolume}
          fitByName={fitByName} setFit={setFit}
          trimEnd={exportDuration} setTrimEnd={setTrimEnd} exportDuration={exportDuration}
          undo={undo} redo={redo} canUndo={canUndo} canRedo={canRedo}
          captionCues={captionCues} captionsOn={captionsOn} setCaptionsOn={setCaptionsOn}
          captionStyle={captionStyle} setCaptionStyle={setCaptionStyle}
          captionSize={captionSize} setCaptionSize={setCaptionSize}
          captionLineHeight={captionLineHeight} setCaptionLineHeight={setCaptionLineHeight}
          captionFontScale={captionFontScale} setCaptionFontScale={setCaptionFontScale}
          captionName={captionName} captionError={captionError} onCaptionFile={onCaptionFile}
        />
      )}
      </div>
    </main>
    </>
  );
}
