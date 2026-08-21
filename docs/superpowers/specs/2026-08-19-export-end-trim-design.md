# Export end-trim — design

## Problem

The timeline length is driven entirely by the imported voiceover. `buildTimeline`
stretches the **last** image to the end of the audio, so an 8-minute voiceover with
images placed only up to 2:30 produces an 8-minute video whose final 5.5 minutes is a
frozen last frame. There is currently no way to export just the meaningful 2:30.

## Goal

Let the user set an **end point** for the export by dragging a handle on the timeline,
so the rendered MP4 (video *and* audio) stops at that point instead of running the full
audio length.

Scope is deliberately narrow (decided during brainstorming):

- **End point only** — no start/in-point.
- **Draggable handle on the timeline** — no numeric time field, no separate
  "trim to last image" button (boundary snapping covers that need).

## Model

A single value `trimEnd` (seconds).

- Default: equals the full audio length (`audioDuration`) → no trim.
- Range: clamped to `[MIN_TRIM, audioDuration]`, where `MIN_TRIM` is ~1s so the export
  is never zero-length.
- Resets to `audioDuration` whenever a new audio file is loaded.
- It is an **export setting**, like `fadeIn`/`fadeOut` — held as plain React state in
  `page.js`, **not** part of the undo/redo composition history.

`exportDuration = trimEnd` is the effective length used by the export, the transport
readout, the "Length" spec, and the preview's ending-fade anchor.

## Components & changes

### `lib/timeline.js` — new pure helper (unit-tested)

```js
export function trimClips(clips, end) {
  // Return clips clipped to [0, end]. Clips starting at/after `end` are dropped;
  // the clip straddling `end` is truncated so it stops exactly at `end`.
}
```

Rules:

- `end` falsy / `<= 0` / `>= totalLength` → return `clips` unchanged (no trim).
- A clip with `start >= end` is dropped.
- A clip with `start < end < start + duration` is returned with
  `duration = +(end - start).toFixed(3)`.
- A clip fully inside `[0, end]` is returned unchanged (same object reference when the
  duration is unchanged, to stay allocation-light).
- Preserves `name`, `gap`, and every other field.

This keeps the render and editor thin and matches the existing "pure lib + vitest"
pattern. Tests live in `lib/__tests__/timeline.test.js`.

### `app/page.js`

- Add `trimEnd` state.
- Effect: when `audioDuration` changes, set `trimEnd = audioDuration`.
- `onRender`: build `exportClips = trimClips(clips, trimEnd)` and use it in place of
  `clips` for both the `transitions` array and the `renderVideo` call. Because the
  trimmed clip list's last clip ends at `trimEnd`, `renderVideo`'s computed `total`
  becomes `trimEnd` — the concat path (`-shortest`) and the xfade path (`-t total`)
  then both cut audio and video at the trim point, and the ending fade re-anchors to
  `trimEnd`. **No changes to `lib/ffmpegRender.js` are required.**
- Pass `trimEnd`, `setTrimEnd`, and `exportDuration` down to `Editor`.

### `components/Timeline.js`

- Timeline continues to render the **full** `duration` (so the frozen-last-frame tail
  stays visible and draggable against).
- New props: `trimEnd`, `onTrimChange`.
- **Shaded region**: a `div` spanning `[trimEnd, duration]` marking "won't export"
  (`pointer-events: none`).
- **Trim handle**: a draggable vertical grip positioned at `pct(trimEnd)`. Pointer-drag
  reuses the existing scrubber pattern (`pointerdown` → track `pointermove`/`pointerup`
  on `window`), calling `onTrimChange(seconds)`. `stopPropagation` on its `pointerdown`
  so it doesn't also scrub the playhead.
- **Clamping + snapping**: the dragged value is clamped to `[MIN_TRIM, duration]` and
  snaps to a nearby clip boundary (`clip.start` / `clip.start + clip.duration`) when
  within a few pixels — this makes landing exactly where the last image begins (the
  2:30 case) easy.

### `components/Editor.js`

- New props: `trimEnd`, `setTrimEnd`, `exportDuration`.
- **Playback clamp**: in the RAF loop, when `audio.currentTime >= trimEnd`, pause and
  set `time = trimEnd`. `trimEnd` is read via a ref so the audio-listener effect does
  not need to re-subscribe on every drag.
- **Transport**: total shows `tc(exportDuration)` instead of `tc(duration)`.
- **Draw**: the ending-fade `outStart` uses `exportDuration - fadeOut` (not
  `duration - fadeOut`) so the previewed fade matches the export.
- **Export panel "Length"**: shows `tc(exportDuration)`; when `trimEnd < audioDuration`,
  add a small hint line (e.g. `trimmed from {tc(duration)}`).
- Forward `trimEnd` / `onTrimChange` to `Timeline`.

## Data flow

```
audioDuration ──┐
                ├─> buildTimeline ─> clips (full) ─> Timeline (full view + handle)
trimEnd  ───────┘                              └─> Editor preview (playback clamp)

onRender: trimClips(clips, trimEnd) ─> exportClips ─> renderVideo ─> MP4 cut at trimEnd
```

## Edge cases

- **No trim (default)**: `trimEnd === audioDuration` → `trimClips` returns clips
  unchanged → identical to today's behaviour.
- **Trim before the first image / into the lead-in gap**: `MIN_TRIM` clamp prevents a
  zero-length export; a trimmed lead-in gap simply renders black, as it does today.
- **Images entirely after `trimEnd`**: dropped from the export. Expected; no warning.
- **New audio loaded after trimming**: `trimEnd` resets to the new full length.
- **Trim landing mid-transition (xfade path)**: xfade offsets are anchored to
  `clip.start` values that are all `< trimEnd`, and `-t total` truncates the output at
  `trimEnd`; the last transition may be cut off, which is acceptable.

## Testing

- **Unit** (`lib/__tests__/timeline.test.js`): `trimClips` — no-op when `end >=` total
  or falsy; drops clips starting past `end`; truncates the straddling clip to the exact
  boundary; preserves `gap`/`name`; leaves fully-inside clips unchanged.
- **Manual**: import audio + images up to 2:30 of a longer track; drag the handle to
  2:30 (verify snap to the last image boundary); confirm playback stops at 2:30, the
  "Length" reads 2:30, and the exported MP4 is 2:30 with audio cut and faded correctly.

## Out of scope (YAGNI)

- Start-trim / in-point.
- Numeric time-entry field.
- A dedicated "trim to last image" button (snapping covers it).
