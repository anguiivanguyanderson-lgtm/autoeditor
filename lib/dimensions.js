// Resolve output frame size (even numbers, required by libx264) from the chosen
// aspect. "auto" matches a sample image's natural size.
const even = (n) => Math.max(2, Math.floor(n / 2) * 2);

export function resolveDimensions(aspect, sample) {
  if (aspect === "9:16") return { width: 1080, height: 1920 };
  if (aspect === "auto" && sample && sample.width && sample.height) {
    return { width: even(sample.width), height: even(sample.height) };
  }
  return { width: 1920, height: 1080 }; // 16:9 default (and auto fallback)
}
