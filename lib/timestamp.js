// Parse an image filename into a start time in seconds, or null if it doesn't
// encode a timestamp. Naming is colon-free (Windows-safe): mm-ss / mm_ss,
// hh-mm-ss, bare mmss (3-4 digits), or bare seconds (1-2 digits).
export function parseTimestampName(filename) {
  if (!filename || typeof filename !== "string") return null;
  // strip directory prefix and extension
  const base = filename.split(/[\\/]/).pop().replace(/\.[^.]+$/, "").trim();

  let m;
  // hh-mm-ss
  if ((m = base.match(/^(\d+)[-_](\d{1,2})[-_](\d{1,2})$/))) {
    return (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]);
  }
  // mm-ss
  if ((m = base.match(/^(\d+)[-_](\d{1,2})$/))) {
    return (+m[1]) * 60 + (+m[2]);
  }
  // bare digits
  if ((m = base.match(/^\d+$/))) {
    if (base.length >= 3) {
      const secs = +base.slice(-2);
      const mins = +base.slice(0, -2);
      return mins * 60 + secs;
    }
    return +base; // 1-2 digits → plain seconds
  }
  return null;
}
