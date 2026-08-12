import { describe, it, expect } from "vitest";
import { buildTimeline, LEAD_IN } from "../timeline.js";

const item = (name, seconds) => ({ name, seconds });

describe("buildTimeline", () => {
  it("builds clips covering the full audio", () => {
    const { clips } = buildTimeline(
      [item("a", 0), item("b", 3), item("c", 9)],
      12
    );
    expect(clips).toEqual([
      { name: "a", start: 0, duration: 3, gap: false },
      { name: "b", start: 3, duration: 6, gap: false },
      { name: "c", start: 9, duration: 3, gap: false },
    ]);
  });

  it("sorts unordered items", () => {
    const { clips } = buildTimeline([item("c", 9), item("a", 0), item("b", 3)], 12);
    expect(clips.map((c) => c.name)).toEqual(["a", "b", "c"]);
  });

  it("emits a lead-in gap instead of stretching the first image to 0", () => {
    const { clips } = buildTimeline([item("a", 3), item("b", 6)], 10);
    expect(clips).toEqual([
      { name: LEAD_IN, start: 0, duration: 3, gap: true },
      { name: "a", start: 3, duration: 3, gap: false },
      { name: "b", start: 6, duration: 4, gap: false },
    ]);
  });

  it("keeps an empty slot as a gap without extending its neighbours", () => {
    const { clips } = buildTimeline(
      [item("a", 0), { name: "x", seconds: 5, empty: true }, item("c", 8)],
      12
    );
    expect(clips).toEqual([
      { name: "a", start: 0, duration: 5, gap: false },
      { name: "x", start: 5, duration: 3, gap: true },
      { name: "c", start: 8, duration: 4, gap: false },
    ]);
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
