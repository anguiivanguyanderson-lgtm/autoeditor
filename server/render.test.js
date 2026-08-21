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

  it("routes a video clip through the graph path with -ss trim and a fit-to-slot filter", () => {
    const vio = { ...io, paths: ["img0.png", "clip1.mp4", "img2.png"] };
    const p = buildRenderPlan(
      { ...base, clips, transitions: ["cut", "cut", "cut"], trims: [0, 1.5, 0], volumes: [0, 0.5, 0] },
      { ...vio, audible: [false, true, false] }
    );
    expect(p.mode).toBe("graph");
    // input seeked to the trim in-point
    expect(p.args.join(" ")).toContain("-ss 1.500 -i clip1.mp4");
    const fc = filterText(p);
    // clone-last-frame fill + cut to the slot
    expect(fc).toContain("tpad=stop_mode=clone");
    expect(fc).toContain("trim=duration=");
    // clip audio delayed to its start (3s) and volume-scaled, then mixed
    expect(fc).toContain("volume=0.500");
    expect(fc).toContain("adelay=3000|3000");
    expect(fc).toContain("amix=inputs=2");
  });

  it("skips the audio mix for a video clip with no audio track (audible=false)", () => {
    const vio = { ...io, paths: ["img0.png", "clip1.mp4", "img2.png"] };
    const p = buildRenderPlan(
      { ...base, clips, transitions: ["cut", "cut", "cut"], trims: [0, 0, 0], volumes: [0, 0.7, 0] },
      { ...vio, audible: [false, false, false] }
    );
    const fc = filterText(p);
    expect(fc).not.toContain("amix");
    expect(fc).not.toContain("adelay");
  });

  it("fast-forwards a longer clip to fit its slot (video setpts + audio atempo)", () => {
    const vio = { ...io, paths: ["img0.png", "clip1.mp4", "img2.png"] };
    const p = buildRenderPlan(
      // clip 'b' has a 3s slot; speed 2 = an ~6s clip fit into it
      { ...base, clips, transitions: ["cut", "cut", "cut"], trims: [0, 0, 0], volumes: [0, 0.5, 0], speeds: [1, 2, 1] },
      { ...vio, audible: [false, true, false] }
    );
    const fc = filterText(p);
    expect(fc).toContain("setpts=(PTS-STARTPTS)/2.0000");
    expect(fc).toContain("atempo=2.0"); // audio sped to match
  });

  it("applies a zoom to a video clip via zoompan (per-frame d=1)", () => {
    const vio = { ...io, paths: ["clip0.mp4", "img1.png", "img2.png"] };
    const p = buildRenderPlan(
      { ...base, clips, transitions: ["cut", "cut", "cut"], motions: ["zoomin", "none", "none"], trims: [0, 0, 0], volumes: [0, 0, 0] },
      { ...vio, audible: [false, false, false] }
    );
    const fc = filterText(p);
    expect(fc).toContain("zoompan=");
    expect(fc).toContain(":d=1:");
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
