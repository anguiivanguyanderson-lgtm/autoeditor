# Draggable Image Durations (Roll Edit) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user drag the right edge of an image clip on the timeline to change how long it holds, moving the boundary with the next clip (roll edit) while total length and all other images stay fixed.

**Architecture:** A clip's duration is derived by `buildTimeline` from slot start times, so dragging image A's right edge to time `b` == setting the next clip's slot `seconds = b`. `Timeline` handles the drag with live visual override and commits once on release via a new `resizeBoundary` in `page.js` (one undoable step). No new data model, no changes to the render pipeline.

**Tech Stack:** Next.js (React client components), Vitest.

---

## File Structure

- `app/page.js` — add `resizeBoundary(id, seconds)` (updates a slot's `seconds` via the existing undoable `commitDoc`); pass it to `Editor`.
- `components/Editor.js` — accept `resizeBoundary`, forward it to `<Timeline onResizeBoundary=... />`.
- `components/Timeline.js` — right-edge resize grip on interior image clips, drag with live geometry override, commit on release.
- `app/globals.css` — `.clip__resize` grip styles (+ always-visible on touch).

---

## Task 1: `resizeBoundary` in `page.js`

**Files:**
- Modify: `app/page.js`

- [ ] **Step 1: Add the `resizeBoundary` callback**

In `app/page.js`, the existing `fillGap` callback ends with:

```js
  }, [commitDoc]);
```

Immediately AFTER the `fillGap` callback's closing `}, [commitDoc]);`, add a new callback. (For reference, `fillGap` is the callback that begins `const fillGap = useCallback(async (name, file) => {`.)

```js
  // Roll edit: move the boundary between an image and the next clip by setting
  // the next clip's slot start. buildTimeline re-derives both durations; total
  // length and every other slot are untouched. One commit = one undo step.
  const resizeBoundary = useCallback((id, seconds) => {
    commitDoc((d) => ({
      ...d,
      slots: d.slots.map((s) => (s.id === id ? { ...s, seconds: +seconds.toFixed(3) } : s)),
    }));
  }, [commitDoc]);
```

- [ ] **Step 2: Pass it to `<Editor>`**

In the `<Editor ... />` JSX, find the line:

```js
          replaceImage={replaceImage} removeImage={removeImage} fillGap={fillGap}
```

and change it to:

```js
          replaceImage={replaceImage} removeImage={removeImage} fillGap={fillGap}
          resizeBoundary={resizeBoundary}
```

- [ ] **Step 3: Verify**

Run: `cd story-to-video && npx vitest run`
Expected: PASS, 35 tests, no regressions.
Re-read the two edits for balanced syntax. Do NOT run `npx next build` (a later task builds).

- [ ] **Step 4: Commit** — SKIP. Do NOT commit; leave changes uncommitted (user standing rule: no commits without explicit request).

---

## Task 2: forward `resizeBoundary` through `Editor.js`

**Files:**
- Modify: `components/Editor.js`

- [ ] **Step 1: Accept the prop**

In `components/Editor.js`, the destructured `Editor({ ... })` props include the line:

```js
  replaceImage, removeImage, fillGap,
```

Change it to:

```js
  replaceImage, removeImage, fillGap, resizeBoundary,
```

- [ ] **Step 2: Forward it to `<Timeline>`**

In the `<Timeline ... />` JSX, the props currently end with (added by the trim feature):

```js
          onAdd={askAdd}
          trimEnd={trimEnd}
          onTrimChange={setTrimEnd}
```

Change to:

```js
          onAdd={askAdd}
          onResizeBoundary={resizeBoundary}
          trimEnd={trimEnd}
          onTrimChange={setTrimEnd}
```

- [ ] **Step 3: Verify**

Run: `cd story-to-video && npx vitest run`
Expected: PASS, 35 tests.
Re-read edits for syntax. Do NOT run `npx next build`.

- [ ] **Step 4: Commit** — SKIP (leave uncommitted).

---

## Task 3: resize grip + drag in `Timeline.js`

**Files:**
- Modify: `components/Timeline.js`

- [ ] **Step 1: Import `useState`**

The current import line is:

```js
import { useCallback, useRef } from "react";
```

Change to:

```js
import { useCallback, useRef, useState } from "react";
```

- [ ] **Step 2: Accept the `onResizeBoundary` prop**

The `Timeline` signature currently ends:

```js
  onSeek, onOpen, onAdd,
  trimEnd, onTrimChange,
}) {
```

Change to:

```js
  onSeek, onOpen, onAdd, onResizeBoundary,
  trimEnd, onTrimChange,
}) {
```

- [ ] **Step 3: Add resize state + drag handlers**

Immediately AFTER the `onTrimDown` callback (the block ending `}, [trimAt]);`) and BEFORE the `// A clip opens the inspector only on a clean tap` comment, add:

```js
  const MIN_CLIP = 0.3; // never let a clip collapse below this many seconds
  const [drag, setDrag] = useState(null); // { index, sec } during a right-edge resize

  // Map a pointer x to the clamped boundary between clip i and clip i+1.
  const boundaryAt = useCallback((clientX, i) => {
    const el = trackRef.current;
    if (!el || !duration) return null;
    const a = clips[i], b = clips[i + 1];
    if (!a || !b) return null;
    const r = el.getBoundingClientRect();
    const x = Math.min(Math.max(clientX - r.left, 0), r.width);
    const secs = (x / r.width) * duration;
    const lo = a.start + MIN_CLIP;
    const hi = (b.start + b.duration) - MIN_CLIP;
    return Math.min(Math.max(secs, lo), Math.max(lo, hi));
  }, [duration, clips]);

  const onResizeDown = useCallback((e, i) => {
    e.stopPropagation();
    setDrag({ index: i, sec: clips[i + 1].start });
    const move = (ev) => {
      const s = boundaryAt(ev.clientX, i);
      if (s != null) setDrag({ index: i, sec: s });
    };
    const up = (ev) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      const s = boundaryAt(ev.clientX, i);
      setDrag(null);
      // Only commit a real change, so a plain click on the grip adds no history.
      if (s != null && onResizeBoundary && Math.abs(s - clips[i + 1].start) > 0.001) {
        onResizeBoundary(clips[i + 1].name, s);
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }, [boundaryAt, clips, onResizeBoundary]);
```

- [ ] **Step 4: Override the two adjacent clips' geometry during a drag**

In the video-lane clip map, change the map signature and the geometry line. Currently:

```js
            {clips.map((c) => {
              const style = { left: pct(c.start), width: pct(c.duration) };
```

Change to:

```js
            {clips.map((c, i) => {
              let cStart = c.start, cDur = c.duration;
              if (drag) {
                if (i === drag.index) cDur = drag.sec - c.start;
                else if (i === drag.index + 1) { cStart = drag.sec; cDur = (c.start + c.duration) - drag.sec; }
              }
              const style = { left: pct(cStart), width: pct(cDur) };
```

- [ ] **Step 5: Show the live duration in the gap clip's readout**

Still in the gap branch, the readout currently uses `c.duration`. Replace, in the gap branch only:

```js
                    title={`Empty · ${label(c.start)} · ${c.duration.toFixed(1)}s`}
```

with:

```js
                    title={`Empty · ${label(cStart)} · ${cDur.toFixed(1)}s`}
```

and

```js
                      <span className="clip__meta clip__meta--gap">{c.duration.toFixed(1)}s</span>
```

with

```js
                      <span className="clip__meta clip__meta--gap">{cDur.toFixed(1)}s</span>
```

- [ ] **Step 6: Show the live duration + add the grip on image clips**

In the image return path, the block currently is:

```js
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
```

Replace it with (updates the readouts to the live `cDur`, and adds a right-edge grip on every image clip except the last):

```js
                <div
                  key={c.name}
                  className={cls.join(" ")}
                  style={{ ...style, backgroundImage: el && el.url ? `url(${el.url})` : undefined }}
                  title={`${el && el.fileName ? el.fileName + " · " : ""}${label(cStart)} · ${cDur.toFixed(1)}s — click to preview / replace`}
                  onPointerDown={(e) => { downRef.current = { x: e.clientX, y: e.clientY }; }}
                  onClick={(e) => onClipClick(c.name, e)}
                >
                  <span className="clip__meta">{cDur.toFixed(1)}s</span>
                  {fname && <span className="clip__name">{fname}</span>}
                  {i < clips.length - 1 && (
                    <span
                      className="clip__resize"
                      title="Drag to change how long this image holds"
                      onPointerDown={(e) => onResizeDown(e, i)}
                    />
                  )}
                </div>
```

- [ ] **Step 7: Verify**

Run: `cd story-to-video && npx vitest run`
Expected: PASS, 35 tests (no test targets Timeline drag; none should break).
Re-read the whole clip-map block: confirm `cStart`/`cDur` are used consistently, the map uses `(c, i)`, the grip is inside the image `<div>` and guarded by `i < clips.length - 1`, and all braces/JSX are balanced. Do NOT run `npx next build`.

- [ ] **Step 8: Commit** — SKIP (leave uncommitted).

---

## Task 4: `.clip__resize` styles

**Files:**
- Modify: `app/globals.css`

- [ ] **Step 1: Confirm the clip is a positioned ancestor**

`.clip` is already `position: absolute; overflow: hidden;` (around line 329), so an absolutely-positioned grip anchored to its right edge works. No change needed there.

- [ ] **Step 2: Add the grip styles**

Add near the other `.clip` rules in `app/globals.css` (e.g. after the `.clip--gap` rule around line 354):

```css
/* Right-edge grip to roll the boundary with the next clip (change hold time). */
.clip__resize {
  position: absolute; top: 0; right: 0; bottom: 0; width: 12px;
  cursor: ew-resize; touch-action: none; z-index: 4;
  display: flex; align-items: center; justify-content: flex-end;
}
.clip__resize::after {
  content: ""; width: 3px; height: 42%; margin-right: 3px; border-radius: 2px;
  background: rgba(255, 255, 255, .55);
  opacity: 0; transition: opacity .12s;
}
.clip:hover .clip__resize::after,
.clip__resize:hover::after { opacity: 1; }
```

- [ ] **Step 3: Always show the grip on touch (no hover)**

In the existing `@media (max-width: 640px)` block (the one that already sets `.thumb__x { opacity: 1; }` is at 860px; the 640px block styles the timeline), add inside the `@media (max-width: 640px)` block:

```css
  .clip__resize::after { opacity: 1; }
```

- [ ] **Step 4: Verify**

Run: `cd story-to-video && npx vitest run`
Expected: PASS, 35 tests.
Confirm the CSS braces are balanced.

- [ ] **Step 5: Commit** — SKIP (leave uncommitted).

---

## Task 5: build + manual verification

**Files:** none.

- [ ] **Step 1: Full production build**

Run: `cd story-to-video && rm -rf .next && npx next build`
Expected: `✓ Compiled successfully` and a completed build with the `/` route listed. (Clearing `.next` avoids a stale-chunk false failure.)

- [ ] **Step 2: Manual check in the browser**

Run: `cd story-to-video && npm run dev`, open the app, import a voiceover + several timestamp-named images, Build timeline.

Verify:
- Hovering an interior image shows a grip on its right edge (`ew-resize` cursor).
- Dragging the grip right: that image gets longer, the next image starts later and gets shorter, later images and the total length are unchanged; the clip's `N.Ns` readout updates live.
- Dragging left: the reverse; neither clip can collapse (stops ~0.3s before either disappears).
- Clicking a clip (not the grip) still opens the inspector; clicking the grip does not.
- Ctrl+Z reverts a completed resize in one step; Ctrl+Shift+Z redoes it.
- A transition set on the moved boundary still plays after resizing.
- Render an MP4 and confirm the new hold times are reflected.

- [ ] **Step 3: Final test run**

Run: `cd story-to-video && npx vitest run`
Expected: PASS, 35 tests.

---

## Self-Review Notes

- **Spec coverage:** `resizeBoundary` (Task 1) ↔ spec "app/page.js"; forward through Editor (Task 2) ↔ spec "components/Editor.js"; grip + `boundaryAt` clamp + `onResizeDown` live override + commit-on-release + grip only on non-last image clips (Task 3) ↔ spec "components/Timeline.js" and "Clamping"/"Interaction"; styles + touch (Task 4) ↔ spec "app/globals.css"; build + manual (Task 5) ↔ spec "Testing". Roll-edit semantics, right-edge-only, MIN_CLIP=0.3, single-undo-per-drag, no-op-click guard all present.
- **Naming consistency:** `resizeBoundary` (page) → `onResizeBoundary` (Editor→Timeline prop) → `onResizeDown`/`boundaryAt`/`drag`/`MIN_CLIP` (Timeline) → `.clip__resize` (CSS), used consistently across tasks. Geometry override vars `cStart`/`cDur` used in both the gap and image branches.
- **No placeholders:** every code step shows complete code.
- **Commit steps:** intentionally SKIPPED per the user's standing no-commit rule; work is left uncommitted for the user to review.
