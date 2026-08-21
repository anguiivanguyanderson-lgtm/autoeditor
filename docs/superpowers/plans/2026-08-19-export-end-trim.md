# Export End-Trim Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user drag a handle on the timeline to set an end point, so the exported MP4 (video and audio) stops there instead of running the full audio length.

**Architecture:** A single `trimEnd` seconds value lives in `page.js` as plain state (like `fadeIn`/`fadeOut`, not undoable). A new pure `trimClips(clips, end)` helper produces the clip list actually rendered; feeding it to the existing `renderVideo` makes `total` become `trimEnd`, so no ffmpeg code changes. The `Timeline` keeps showing the full length but gains a draggable trim handle + shaded region; the `Editor` preview clamps playback and the fade/length readouts to `trimEnd`.

**Tech Stack:** Next.js (React client components), ffmpeg.wasm, Vitest.

---

## File Structure

- `lib/timeline.js` — add pure `trimClips(clips, end)` helper (co-located with `buildTimeline`).
- `lib/__tests__/timeline.test.js` — add `trimClips` unit tests.
- `app/page.js` — `trimEnd` state, reset-on-new-audio effect, trimmed clips in `onRender`, pass props down.
- `components/Timeline.js` — trim handle + shaded region, drag with clamp + boundary snap.
- `components/Editor.js` — playback clamp at `trimEnd`, transport/length readouts, fade anchor, forward props to `Timeline`.
- `app/globals.css` — styles for the trim handle and shaded region.

---

## Task 1: `trimClips` pure helper (TDD)

**Files:**
- Modify: `lib/timeline.js`
- Test: `lib/__tests__/timeline.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `lib/__tests__/timeline.test.js` (after the existing `describe` block; the file already imports from `../timeline.js` — extend that import):

```js
import { buildTimeline, trimClips, LEAD_IN } from "../timeline.js";

const clip = (name, start, duration, gap = false) => ({ name, start, duration, gap });

describe("trimClips", () => {
  const clips = [
    clip("a", 0, 5),
    clip("b", 5, 5),
    clip("c", 10, 5), // ends at 15
  ];

  it("returns clips unchanged when end is at or beyond the total length", () => {
    expect(trimClips(clips, 15)).toBe(clips);
    expect(trimClips(clips, 99)).toBe(clips);
  });

  it("returns clips unchanged when end is falsy or non-positive", () => {
    expect(trimClips(clips, 0)).toBe(clips);
    expect(trimClips(clips, undefined)).toBe(clips);
    expect(trimClips(clips, -3)).toBe(clips);
  });

  it("drops clips that start at or after end", () => {
    // end exactly on b's start: b and c both dropped, a runs full
    expect(trimClips(clips, 5)).toEqual([clip("a", 0, 5)]);
  });

  it("truncates the clip straddling end to stop exactly at end", () => {
    expect(trimClips(clips, 7)).toEqual([
      clip("a", 0, 5),
      clip("b", 5, 2),
    ]);
  });

  it("preserves gap and other fields on a truncated clip", () => {
    const withGap = [clip("a", 0, 5), clip("x", 5, 5, true)];
    expect(trimClips(withGap, 8)).toEqual([
      clip("a", 0, 5),
      clip("x", 5, 3, true),
    ]);
  });

  it("keeps the same object reference for clips left unchanged", () => {
    const out = trimClips(clips, 7);
    expect(out[0]).toBe(clips[0]); // 'a' fully inside → not reallocated
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd story-to-video && npx vitest run lib/__tests__/timeline.test.js`
Expected: FAIL — `trimClips is not a function` (or import undefined).

- [ ] **Step 3: Implement `trimClips`**

Append to `lib/timeline.js`:

```js
// Clip an ordered clip list to [0, end] for export. Clips starting at or after
// `end` are dropped; the clip straddling `end` is truncated so it stops exactly
// there. `end` falsy / non-positive / at-or-beyond the total is a no-op that
// returns the original array (and unchanged clips keep their object identity).
export function trimClips(clips, end) {
  if (!(end > 0)) return clips;
  const total = clips.length ? clips[clips.length - 1].start + clips[clips.length - 1].duration : 0;
  if (end >= total) return clips;

  const out = [];
  for (const c of clips) {
    if (c.start >= end) continue;
    const dur = +(end - c.start).toFixed(3);
    out.push(dur >= c.duration ? c : { ...c, duration: dur });
  }
  return out;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd story-to-video && npx vitest run lib/__tests__/timeline.test.js`
Expected: PASS (all `trimClips` cases plus the existing `buildTimeline` cases).

- [ ] **Step 5: Commit**

```bash
git add story-to-video/lib/timeline.js story-to-video/lib/__tests__/timeline.test.js
git commit -m "feat: add trimClips helper for export end-trim"
```

---

## Task 2: `trimEnd` state, reset, and trimmed export in `page.js`

**Files:**
- Modify: `app/page.js`

No unit test — this is React wiring verified manually in Task 6. Keep each edit minimal.

- [ ] **Step 1: Import `trimClips`**

In `app/page.js`, change the timeline import (currently line 5):

```js
import { buildTimeline, trimClips, LEAD_IN } from "../lib/timeline";
```

- [ ] **Step 2: Add `trimEnd` state**

After the `fadeOut` state line (`const [fadeOut, setFadeOut] = useState(0.6);`), add:

```js
  const [trimEnd, setTrimEnd] = useState(0); // export end point (0 = untrimmed / full audio)
```

- [ ] **Step 3: Reset `trimEnd` when audio length changes**

After the `const { clips, warnings } = useMemo(...)` block (around line 243), add an effect that resets the trim to the full length whenever the audio duration changes:

```js
  // A new voiceover resets any prior trim to the full length.
  useEffect(() => { setTrimEnd(audioDuration); }, [audioDuration]);

  const exportDuration = trimEnd > 0 ? Math.min(trimEnd, audioDuration) : audioDuration;
```

- [ ] **Step 4: Use trimmed clips in `onRender`**

In `onRender`, replace the transitions/render section so it renders the trimmed clip list. Change:

```js
      const transitions = clips.map((c) => transitionsByName[c.name] || "cut");
      const captions = captionsOn && captionCues.length ? captionCues : null;
      const blob = await renderVideo({
        clips, imagesByName, audioFile,
```

to:

```js
      const exportClips = trimClips(clips, exportDuration);
      const transitions = exportClips.map((c) => transitionsByName[c.name] || "cut");
      const captions = captionsOn && captionCues.length ? captionCues : null;
      const blob = await renderVideo({
        clips: exportClips, imagesByName, audioFile,
```

Then add `exportDuration` to the `onRender` `useCallback` dependency array (it currently starts with `[clips, imagesByName, audioFile, dims, fps, ...]`):

```js
  }, [clips, exportDuration, imagesByName, audioFile, dims, fps, transitionsByName, transitionDuration, fadeIn, fadeOut,
      captionsOn, captionCues, captionStyle, captionSize]);
```

- [ ] **Step 5: Pass trim props to `Editor`**

In the `<Editor ... />` render, add these props next to `fadeOut={fadeOut} setFadeOut={setFadeOut}`:

```js
          trimEnd={exportDuration} setTrimEnd={setTrimEnd} exportDuration={exportDuration}
```

- [ ] **Step 6: Verify the app still builds and untrimmed render is unchanged**

Run: `cd story-to-video && npx vitest run`
Expected: PASS (no test regressions).

Then confirm the dev server compiles: `cd story-to-video && npx next build` (or a running `npm run dev` compiles with no errors). Expected: compiles cleanly.

- [ ] **Step 7: Commit**

```bash
git add story-to-video/app/page.js
git commit -m "feat: track trimEnd and render trimmed clip list"
```

---

## Task 3: Trim handle + shaded region in `Timeline.js`

**Files:**
- Modify: `components/Timeline.js`

- [ ] **Step 1: Accept the new props and a clip-boundary list**

In `components/Timeline.js`, add `trimEnd` and `onTrimChange` to the destructured props of `Timeline` (the object after `transitionsByName, selectedName, onSelect,`):

```js
export default function Timeline({
  clips, imageEls, duration, time, peaks, activeName, badClips,
  transitionsByName, selectedName, onSelect,
  onSeek, onOpen, onAdd,
  trimEnd, onTrimChange,
}) {
```

- [ ] **Step 2: Add the trim-drag handler**

Inside the component, after the existing `onScrubDown` `useCallback` (around line 60), add a handler that converts pointer x → seconds, clamps to `[MIN_TRIM, duration]`, and snaps to a nearby clip boundary:

```js
  const MIN_TRIM = 1;      // never allow a zero-length export
  const SNAP_PX = 8;       // snap to a clip boundary within this many pixels

  const trimAt = useCallback((clientX) => {
    const el = trackRef.current;
    if (!el || !duration || !onTrimChange) return;
    const r = el.getBoundingClientRect();
    const x = Math.min(Math.max(clientX - r.left, 0), r.width);
    let secs = (x / r.width) * duration;

    // Snap to the nearest clip start/end boundary when the pointer is close.
    const snapSecs = (SNAP_PX / r.width) * duration;
    let best = null, bestD = snapSecs;
    for (const c of clips) {
      for (const edge of [c.start, c.start + c.duration]) {
        const d = Math.abs(edge - secs);
        if (d <= bestD) { bestD = d; best = edge; }
      }
    }
    if (best != null) secs = best;

    secs = Math.min(Math.max(secs, MIN_TRIM), duration);
    onTrimChange(+secs.toFixed(3));
  }, [duration, clips, onTrimChange]);

  const onTrimDown = useCallback((e) => {
    e.stopPropagation();
    trimAt(e.clientX);
    const move = (ev) => trimAt(ev.clientX);
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }, [trimAt]);
```

- [ ] **Step 3: Render the shaded region and handle**

The effective trim position (falls back to full length when untrimmed). Just before the `return (`, add:

```js
  const trimPos = trimEnd > 0 && trimEnd < duration ? trimEnd : duration;
  const trimmed = trimPos < duration;
```

Then, inside the `<div className="tl__track" ref={trackRef}>`, add the shade and handle immediately **after** the `<div className="tl__playhead" ...>` block (still inside `tl__track`):

```js
          {trimmed && (
            <div
              className="tl__trim-shade"
              style={{ left: pct(trimPos), width: pct(duration - trimPos) }}
              aria-hidden="true"
            />
          )}
          <div
            className="tl__trim"
            style={{ left: pct(trimPos) }}
            onPointerDown={onTrimDown}
            title="Drag to set where the export ends"
            role="slider"
            aria-label="Export end"
            aria-valuemin={0}
            aria-valuemax={Math.round(duration)}
            aria-valuenow={Math.round(trimPos)}
          >
            <span className="tl__trim-grip" />
          </div>
```

- [ ] **Step 4: Verify it compiles and renders**

Run: `cd story-to-video && npx next build` (or confirm `npm run dev` recompiles with no errors).
Expected: compiles cleanly. (Visual verification happens in Task 6.)

- [ ] **Step 5: Commit**

```bash
git add story-to-video/components/Timeline.js
git commit -m "feat: add draggable export-trim handle to timeline"
```

---

## Task 4: Preview clamp + readouts in `Editor.js`

**Files:**
- Modify: `components/Editor.js`

- [ ] **Step 1: Accept the new props**

In `components/Editor.js`, add to the destructured `Editor` props (after `fadeIn, setFadeIn, fadeOut, setFadeOut,`):

```js
  trimEnd, setTrimEnd, exportDuration,
```

- [ ] **Step 2: Add a ref that always holds the current `trimEnd`**

After the existing `useRef` declarations near the top of the component (e.g. after `const pending = useRef(null);`), add:

```js
  const trimEndRef = useRef(exportDuration);
  useEffect(() => { trimEndRef.current = exportDuration; }, [exportDuration]);
```

- [ ] **Step 3: Anchor the ending fade to the export end in `draw`**

In the `draw` callback, change the ending-fade start from the full duration to the export duration. Replace:

```js
    const outStart = duration - fadeOut;
```

with:

```js
    const outStart = exportDuration - fadeOut;
```

Add `exportDuration` to the `draw` `useCallback` dependency array (which currently ends with `captionsOn, captionCues, captionStyle, captionSize]`):

```js
  }, [clips, imageEls, transitionsByName, transitionDuration, fadeIn, fadeOut, duration, exportDuration,
      captionsOn, captionCues, captionStyle, captionSize]);
```

- [ ] **Step 4: Clamp playback at the trim point**

In the audio-listener effect, change the RAF `loop` so playback pauses when it reaches the trim point. Replace:

```js
    const loop = () => { setTime(a.currentTime); rafRef.current = requestAnimationFrame(loop); };
```

with:

```js
    const loop = () => {
      const end = trimEndRef.current;
      if (end > 0 && a.currentTime >= end) {
        a.pause();
        a.currentTime = end;
        setTime(end);
        return;
      }
      setTime(a.currentTime);
      rafRef.current = requestAnimationFrame(loop);
    };
```

- [ ] **Step 5: Show the export length in the transport**

In the transport, change the total readout from the full duration to the export duration. Replace:

```js
              <span className="time__total">{tc(duration)}</span>
```

with:

```js
              <span className="time__total">{tc(exportDuration)}</span>
```

- [ ] **Step 6: Update the Export panel "Length" spec + trimmed hint**

In the `<dl className="specs">` block, replace the Length row:

```js
            <div className="spec"><dt>Length</dt><dd>{tc(duration)}</dd></div>
```

with:

```js
            <div className="spec">
              <dt>Length</dt>
              <dd>
                {tc(exportDuration)}
                {exportDuration < duration && (
                  <span className="spec__trim"> · trimmed from {tc(duration)}</span>
                )}
              </dd>
            </div>
```

- [ ] **Step 7: Forward trim props to `Timeline`**

In the `<Timeline ... />` render, add these props (e.g. after `onAdd={askAdd}`):

```js
          trimEnd={trimEnd}
          onTrimChange={setTrimEnd}
```

- [ ] **Step 8: Verify tests and build**

Run: `cd story-to-video && npx vitest run`
Expected: PASS.
Run: `cd story-to-video && npx next build` (or confirm dev recompiles cleanly).
Expected: compiles cleanly.

- [ ] **Step 9: Commit**

```bash
git add story-to-video/components/Editor.js
git commit -m "feat: clamp preview and readouts to export trim point"
```

---

## Task 5: Styles for the trim handle and shade

**Files:**
- Modify: `app/globals.css`

- [ ] **Step 1: Find the existing timeline/playhead styles**

Run: `cd story-to-video && grep -n "tl__playhead\|tl__track\|spec__" app/globals.css`
Expected: locate the `.tl__playhead` / `.tl__track` rules so the new rules can sit beside them and reuse the same coordinate conventions (absolute, `%` left).

- [ ] **Step 2: Add the trim styles**

Add near the `.tl__playhead` rules in `app/globals.css` (match the file's existing color/variable conventions — use the same accent variable the playhead grip uses if there is one; otherwise the literal colors below are fine):

```css
.tl__trim-shade {
  position: absolute;
  top: 0;
  bottom: 0;
  background: repeating-linear-gradient(
    -45deg,
    rgba(0, 0, 0, 0.28),
    rgba(0, 0, 0, 0.28) 6px,
    rgba(0, 0, 0, 0.14) 6px,
    rgba(0, 0, 0, 0.14) 12px
  );
  pointer-events: none;
  z-index: 3;
}

.tl__trim {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 12px;
  margin-left: -6px;
  cursor: ew-resize;
  z-index: 5;
  display: flex;
  justify-content: center;
  touch-action: none;
}

.tl__trim::before {
  content: "";
  width: 2px;
  height: 100%;
  background: #f5a623;
}

.tl__trim-grip {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  width: 10px;
  height: 22px;
  border-radius: 3px;
  background: #f5a623;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.4);
}

.spec__trim {
  opacity: 0.7;
  font-weight: 400;
}
```

- [ ] **Step 3: Verify the styles load**

Run: `cd story-to-video && npx next build` (or confirm dev recompiles).
Expected: compiles cleanly, no CSS errors.

- [ ] **Step 4: Commit**

```bash
git add story-to-video/app/globals.css
git commit -m "style: trim handle, shaded region, and trimmed-length hint"
```

---

## Task 6: Manual end-to-end verification

**Files:** none (verification only).

- [ ] **Step 1: Run the dev server**

Run: `cd story-to-video && npm run dev`
Open the app in the browser.

- [ ] **Step 2: Set up a trim scenario**

Import a voiceover several minutes long and a handful of timestamp-named images that only cover roughly the first third of it. Click "Build timeline →".

- [ ] **Step 3: Verify the handle**

- The timeline shows the full audio length, with the last image's frozen tail visible.
- An orange trim handle sits at the far right (untrimmed).
- Drag the handle left to where the last image begins — confirm it **snaps** to that clip boundary, and the region to its right is shaded.

- [ ] **Step 4: Verify preview clamps**

- Press Play (or Space). Confirm playback **stops** at the trim point, not the full length.
- Confirm the transport total and the Export panel "Length" both read the trimmed length, with a "trimmed from M:SS" hint.

- [ ] **Step 5: Verify the export**

- Click "Render MP4", wait for completion, download, and confirm the MP4 length equals the trim point, audio is cut there, and the ending fade lands at the new end.
- Drag the handle back to the far right (full length) and re-render; confirm the output matches the original full-length behaviour (untrimmed no-op).

- [ ] **Step 6: Final full test run**

Run: `cd story-to-video && npx vitest run`
Expected: PASS.

---

## Self-Review Notes

- **Spec coverage:** `trimClips` (Task 1) ↔ spec "Export"; `trimEnd` state + reset + trimmed render (Task 2) ↔ spec "app/page.js"; handle + shade + clamp + snap (Task 3) ↔ spec "Timeline.js"; playback clamp + readouts + fade anchor (Task 4) ↔ spec "Editor.js"; styles (Task 5); edge cases + manual test (Task 6) ↔ spec "Edge cases"/"Testing". No ffmpegRender changes, per spec.
- **Naming consistency:** `trimClips`, `trimEnd`, `exportDuration`, `onTrimChange`/`setTrimEnd`, `trimAt`/`onTrimDown`, `tl__trim`/`tl__trim-shade`/`tl__trim-grip`, `spec__trim` used consistently across tasks. `page.js` passes `trimEnd={exportDuration}` (the clamped value) so `Editor`'s ref and readouts see the effective length; `Editor` forwards raw `trimEnd` + `setTrimEnd` as `onTrimChange` to `Timeline`.
- **No placeholders:** every code step shows complete code.
