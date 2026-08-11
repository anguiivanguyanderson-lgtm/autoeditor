import { describe, it, expect } from "vitest";
import { buildTimeline } from "../timeline.js";

const item = (name, seconds) => ({ name, seconds });

describe("buildTimeline", () => {
  it("builds clips covering the full audio", () => {
    const { clips } = buildTimeline(
      [item("a", 0), item("b", 3), item("c", 9)],
      12
    );
    expect(clips).toEqual([
      { name: "a", start: 0, duration: 3 },
      { name: "b", start: 3, duration: 6 },
      { name: "c", start: 9, duration: 3 },
    ]);
  });

  it("sorts unordered items", () => {
    const { clips } = buildTimeline([item("c", 9), item("a", 0), item("b", 3)], 12);
    expect(clips.map((c) => c.name)).toEqual(["a", "b", "c"]);
  });

  it("forces the first clip to start at 0 and warns when it did not", () => {
    const { clips, warnings } = buildTimeline([item("a", 3), item("b", 6)], 10);
    expect(clips[0]).toEqual({ name: "a", start: 0, duration: 6 });
    expect(warnings.some((w) => /lead-in|starts at/i.test(w))).toBe(true);
  });

  it("drops items at or beyond the audio duration with a warning", () => {
    const { clips, warnings } = buildTimeline([item("a", 0), item("b", 20)], 10);
    expect(clips.map((c) => c.name)).toEqual(["a"]);
    expect(warnings.some((w) => /b/.test(w) && /beyond|duration/i.test(w))).toBe(true);
  });

  it("drops unparseable (null seconds) items with a warning", () => {
    const { clips, warnings } = buildTimeline([item("a", 0), item("bad", null)], 10);
    expect(clips.map((c) => c.name)).toEqual(["a"]);
    expect(warnings.some((w) => /bad/.test(w))).toBe(true);
  });

  it("warns and drops duplicate-timestamp zero-length clips", () => {
    const { clips, warnings } = buildTimeline(
      [item("a", 0), item("b", 5), item("c", 5)],
      10
    );
    expect(clips.length).toBe(2);
    expect(warnings.some((w) => /duplicate/i.test(w))).toBe(true);
  });

  it("returns empty clips with a warning when there are no valid items", () => {
    const { clips, warnings } = buildTimeline([], 10);
    expect(clips).toEqual([]);
    expect(warnings.length).toBeGreaterThan(0);
  });
});
