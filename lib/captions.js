// Captions: parse an uploaded timestamped transcript into short caption cues,
// draw them on the preview canvas, and build the ffmpeg drawtext chain that
// burns them into the render. Preview and render share the same font + styles
// so what you see is what you get.

// ---- style presets (shared by preview canvas + ffmpeg drawtext) ----
// `fill`/`stroke`/`box` drive the canvas preview; `dt(bw)` returns the
// drawtext colour/box options for the burn-in.
export const CAPTION_STYLES = {
  classic: {
    id: "classic", label: "Classic outline",
    fill: "#ffffff", stroke: "#000000", box: null,
    dt: (bw) => `fontcolor=white:borderw=${bw}:bordercolor=black@0.9`,
  },
  boxed: {
    id: "boxed", label: "Boxed",
    fill: "#ffffff", stroke: null, box: "rgba(0,0,0,0.6)",
    dt: (bw) => `fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=${Math.round(bw * 3.5)}`,
  },
  yellow: {
    id: "yellow", label: "Yellow classic",
    fill: "#ffd400", stroke: "#000000", box: null,
    dt: (bw) => `fontcolor=0xFFD400:borderw=${bw}:bordercolor=black@0.9`,
  },
};
export const CAPTION_STYLE_LIST = Object.keys(CAPTION_STYLES).map((id) => CAPTION_STYLES[id]);

export const CAPTION_SIZES = { sm: 0.042, md: 0.052, lg: 0.064 };
export const CAPTION_FONT = "caption.ttf";          // path in the ffmpeg FS
export const captionCueFile = (i) => `cap${i}.txt`;  // per-cue textfile in the FS

export function captionFontPx(height, sizeId) {
  return Math.round(height * (CAPTION_SIZES[sizeId] || CAPTION_SIZES.md));
}

const MAX_LINE = 42;       // chars before wrapping to a second line
const MAX_CUE_CHARS = 84;  // chars before starting a new caption cue
const MARGIN_FACTOR = 0.07;

// ---- timestamp helpers ----
function hms(str) {
  const m = String(str).match(/(?:(\d{1,2}):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?/);
  if (!m) return null;
  const h = +(m[1] || 0), mi = +m[2], se = +m[3];
  const ms = m[4] ? +m[4].padEnd(3, "0") : 0;
  return h * 3600 + mi * 60 + se + ms / 1000;
}

// SRT / VTT — cues carry explicit start AND end.
function parseArrow(text) {
  const out = [];
  for (const block of text.split(/\n{2,}/)) {
    const lines = block.split("\n").map((l) => l.trim())
      .filter((l) => l && l !== "WEBVTT" && !/^\d+$/.test(l));
    const tl = lines.find((l) => l.includes("-->"));
    if (!tl) continue;
    const ts = tl.match(/(?:\d{1,2}:)?\d{1,2}:\d{2}(?:[.,]\d{1,3})?/g);
    if (!ts || ts.length < 2) continue;
    const txt = lines.filter((l) => l !== tl).join(" ").trim();
    if (txt) out.push({ start: hms(ts[0]), end: hms(ts[1]), text: txt });
  }
  return out;
}

// NoteGPT-style range blocks: "HH:MM:SS - HH:MM:SS" then a paragraph.
function parseRanges(text) {
  const re = /^\s*((?:\d{1,2}:)?\d{1,2}:\d{2})\s*[-–—]\s*((?:\d{1,2}:)?\d{1,2}:\d{2})\s*$/;
  const out = [];
  let cur = null;
  for (const ln of text.split("\n")) {
    const m = ln.match(re);
    if (m) {
      if (cur && cur.text.trim()) out.push(cur);
      cur = { start: hms(m[1]), end: hms(m[2]), text: "" };
    } else if (cur) {
      const t = ln.trim();
      if (t) cur.text += (cur.text ? " " : "") + t;
    }
  }
  if (cur && cur.text.trim()) out.push(cur);
  return out;
}

// Inline: "[0:03] text" or "0:03 text" per line.
function parseInline(text) {
  const re = /^\s*\[?((?:\d{1,2}:)?\d{1,2}:\d{2}(?:[.,]\d{1,3})?)\]?\s+(.*\S)\s*$/;
  const out = [];
  for (const ln of text.split("\n")) {
    const m = ln.match(re);
    if (m) out.push({ start: hms(m[1]), end: null, text: m[2].trim() });
  }
  return out;
}

// Wrap a caption string onto (at most) two balanced lines.
function wrap(str) {
  if (str.length <= MAX_LINE) return str;
  const words = str.split(" ");
  const half = str.length / 2;
  let a = "", b = "";
  for (const w of words) {
    if (!b && a.length + w.length <= half) a = a ? `${a} ${w}` : w;
    else b = b ? `${b} ${w}` : w;
  }
  return b ? `${a}\n${b}` : a;
}

// Split one timed segment into caption cues, timed proportionally to length.
function chunkSegment(seg, cues) {
  const words = seg.text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  if (!words.length) return;
  const chunks = [];
  let cur = "";
  for (const w of words) {
    const cand = cur ? `${cur} ${w}` : w;
    if (cand.length > MAX_CUE_CHARS && cur) { chunks.push(cur); cur = w; }
    else cur = cand;
    if (/[.!?]["')]?$/.test(w) && cur.length >= MAX_CUE_CHARS * 0.5) { chunks.push(cur); cur = ""; }
  }
  if (cur) chunks.push(cur);

  const totalChars = chunks.reduce((a, c) => a + c.length, 0) || 1;
  const span = Math.max(0.2, seg.end - seg.start);
  let t = seg.start;
  for (const c of chunks) {
    const d = span * (c.length / totalChars);
    const end = c === chunks[chunks.length - 1] ? seg.end : t + d;
    cues.push({ start: t, end, text: wrap(c) });
    t = end;
  }
}

// Parse raw transcript text into caption cues. `duration` (audio length) is used
// only to close the final segment. Returns { cues, error }.
export function parseTranscript(raw, duration = 0) {
  if (!raw || !raw.trim()) return { cues: [], error: "The file is empty." };
  const text = raw.replace(/\r/g, "");

  let segs = text.includes("-->") ? parseArrow(text) : parseRanges(text);
  if (!segs.length) segs = parseInline(text);
  segs = segs.filter((s) => s.start != null && s.text);
  if (!segs.length) {
    return { cues: [], error: "No timestamps found — use an SRT/VTT or a timestamped transcript." };
  }

  segs.sort((a, b) => a.start - b.start);
  for (let i = 0; i < segs.length; i++) {
    const nextStart = i + 1 < segs.length
      ? segs[i + 1].start
      : (duration || segs[i].start + segs[i].text.split(/\s+/).length / 2.5);
    let end = segs[i].end != null ? Math.min(segs[i].end, nextStart) : nextStart;
    if (!(end > segs[i].start)) end = Math.max(nextStart, segs[i].start + 0.4);
    segs[i].end = end;
  }

  const cues = [];
  for (const s of segs) chunkSegment(s, cues);
  return { cues, error: cues.length ? null : "Could not build any caption lines." };
}

// Current caption text for time t (empty string if none).
export function captionAt(cues, t) {
  if (!cues) return "";
  for (let i = 0; i < cues.length; i++) {
    if (t >= cues[i].start && t < cues[i].end) return cues[i].text;
  }
  return "";
}

// ---- preview: draw the current caption onto the canvas ----
export function drawCaption(ctx, text, W, H, styleId, fontPx) {
  if (!text) return;
  const st = CAPTION_STYLES[styleId] || CAPTION_STYLES.classic;
  const lines = text.split("\n");
  const lh = fontPx * 1.16;
  const marginY = Math.round(H * MARGIN_FACTOR);
  const blockH = lines.length * lh;

  ctx.save();
  ctx.font = `700 ${fontPx}px "CaptionFont", system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";

  if (st.box) {
    let maxW = 0;
    for (const ln of lines) maxW = Math.max(maxW, ctx.measureText(ln).width);
    const padX = fontPx * 0.5, padY = fontPx * 0.28;
    const boxW = maxW + padX * 2, boxH = blockH + padY;
    ctx.fillStyle = st.box;
    ctx.fillRect((W - boxW) / 2, H - marginY - boxH, boxW, boxH);
  }

  const firstBase = H - marginY - blockH + fontPx * 0.82;
  for (let i = 0; i < lines.length; i++) {
    const y = firstBase + i * lh;
    if (st.stroke) {
      ctx.lineJoin = "round";
      ctx.miterLimit = 2;
      ctx.lineWidth = Math.max(2, fontPx / 7);
      ctx.strokeStyle = st.stroke;
      ctx.strokeText(lines[i], W / 2, y);
    }
    ctx.fillStyle = st.fill;
    ctx.fillText(lines[i], W / 2, y);
  }
  ctx.restore();
}

// ---- render: comma-joined drawtext filters, one per cue ----
export function drawtextChain(cues, styleId, width, height, sizeId) {
  const st = CAPTION_STYLES[styleId] || CAPTION_STYLES.classic;
  const fs = captionFontPx(height, sizeId);
  const bw = Math.max(2, Math.round(fs / 9));
  const marginV = Math.round(height * MARGIN_FACTOR);
  return cues.map((c, i) => {
    const s = c.start.toFixed(3), e = c.end.toFixed(3);
    return `drawtext=fontfile=${CAPTION_FONT}:textfile=${captionCueFile(i)}:${st.dt(bw)}` +
      `:fontsize=${fs}:line_spacing=${Math.round(fs * 0.16)}` +
      `:x=(w-text_w)/2:y=h-text_h-${marginV}:enable=between(t\\,${s}\\,${e})`;
  }).join(",");
}

// drawtext reads textfiles literally; strip chars its expander would choke on.
export function sanitizeCueText(text) {
  return String(text).replace(/\\/g, "").replace(/%/g, "percent");
}
