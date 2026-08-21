// id -> ffmpeg xfade name (null = hard cut). Mirrors lib/transitions.js.
const XFADE = {
  cut: null, fade: "fade", fadeblack: "fadeblack",
  wipeleft: "wipeleft", wiperight: "wiperight",
  slideleft: "slideleft", slideright: "slideright",
  circleopen: "circleopen",
};
export const MIN_TRANSITION_DURATION = 0.15;
export const MAX_TRANSITION_DURATION = 1.0;
// Match the frontend: cut/unknown fall back to "fade" for the 1-frame xfade.
export function xfadeName(id) { return XFADE[id] || "fade"; }
