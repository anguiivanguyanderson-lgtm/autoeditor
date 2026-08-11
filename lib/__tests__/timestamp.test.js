import { describe, it, expect } from "vitest";
import { parseTimestampName } from "../timestamp.js";

describe("parseTimestampName", () => {
  it("parses mm-ss with dash", () => {
    expect(parseTimestampName("0-03.png")).toBe(3);
    expect(parseTimestampName("1-20.jpg")).toBe(80);
  });
  it("parses mm_ss with underscore", () => {
    expect(parseTimestampName("2_05.webp")).toBe(125);
  });
  it("parses hh-mm-ss", () => {
    expect(parseTimestampName("1-02-05.png")).toBe(3725);
  });
  it("parses 4-digit mmss", () => {
    expect(parseTimestampName("0003.png")).toBe(3);
    expect(parseTimestampName("0120.png")).toBe(80);
  });
  it("parses 3-digit mmss", () => {
    expect(parseTimestampName("120.png")).toBe(80);
  });
  it("parses 1-2 digit plain seconds", () => {
    expect(parseTimestampName("3.png")).toBe(3);
    expect(parseTimestampName("45.png")).toBe(45);
  });
  it("strips directories", () => {
    expect(parseTimestampName("imgs/0-09.png")).toBe(9);
  });
  it("returns null for unparseable names", () => {
    expect(parseTimestampName("hero.png")).toBeNull();
    expect(parseTimestampName("scene_a.png")).toBeNull();
    expect(parseTimestampName("")).toBeNull();
  });
});
