import { describe, it, expect } from "vitest";
import { buildRenderPlan } from "./render.js";

const base = {
  width: 1920, height: 1080, fps: 30,
  transitionDuration: 0.4, fadeIn: 0, fadeOut: 0,
};
const io = { paths: ["img0.png", "img1.png", "img2.png"], audioName: "audio.mp3", capChain: "" };
const clips = [
  { name: "a", start: 0, duration: 3, gap: false },
  { name: "b", start: 3, duration: 3, gap: false },
  { name: "c", start: 6, duration: 4, gap: false }, // total 10
];

// The filtergraph now lives in files, not on the command line.
const filterText = (p) => p.filterFiles.map((f) => f.text).join("\n");

describe("buildRenderPlan", () => {
  it("total is the last clip's start + duration", () => {
    const p = buildRenderPlan({ ...base, clips, transitions: ["cut", "cut", "cut"] }, io);
    expect(p.total).toBe(10);
  });

  it("uses concat mode with a video filter script when there are no non-cut transitions", () => {
    const p = buildRenderPlan({ ...base, clips, transitions: ["cut", "cut", "cut"] }, io);
    expect(p.mode).toBe("concat");
    expect(p.args).toContain("concat.txt");
    expect(p.args).toContain("-shortest");
    expect(p.args.join(" ")).toContain("-i audio.mp3");
    // filter read from a file, not passed inline
    expect(p.args).toContain("-filter_script:v");
    const vf = p.filterFiles.find((f) => f.name === "vf.txt");
    expect(vf).toBeTruthy();
    expect(vf.text).toContain("scale=1920:1080");
  });

  it("uses a filter_complex script with an xfade anchored to clip.start when a transition is set", () => {
    const p = buildRenderPlan({ ...base, clips, transitions: ["cut", "fade", "wipeleft"] }, io);
    expect(p.mode).toBe("graph");
    expect(p.args).toContain("-filter_complex_script");
    const fc = filterText(p);
    expect(fc).toContain("xfade=transition=fade");
    expect(fc).toContain("xfade=transition=wipeleft");
    expect(fc).toContain("offset=3.000");
    expect(fc).toContain("offset=6.000");
    expect(p.args).toContain("output.mp4");
  });

  it("adds video fades in the filter file and audio fades on the command line", () => {
    const p = buildRenderPlan(
      { ...base, clips, transitions: ["cut", "cut", "cut"], fadeIn: 0.5, fadeOut: 0.6 }, io
    );
    const vf = filterText(p);
    expect(vf).toContain("fade=t=in:st=0:d=0.500");
    expect(vf).toContain("fade=t=out:st=9.400:d=0.600");
    const s = p.args.join(" ");
    expect(s).toContain("afade=t=in");
    expect(s).toContain("afade=t=out");
  });

  it("puts the caption drawtext chain in the filter file, not the command line", () => {
    const p = buildRenderPlan(
      { ...base, clips, transitions: ["cut", "cut", "cut"] },
      { ...io, capChain: "drawtext=fontfile=caption.ttf:textfile=cap0.txt" }
    );
    expect(filterText(p)).toContain("drawtext=fontfile=caption.ttf");
    // and NOT inline in the args
    expect(p.args.join(" ")).not.toContain("drawtext");
  });
});
