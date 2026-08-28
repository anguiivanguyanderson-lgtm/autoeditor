// Parse an image filename into a start time in seconds, or null if it doesn't
// encode a timestamp. Naming is colon-free (Windows-safe): mm-ss / mm_ss,
// hh-mm-ss, bare mmss (3-4 digits), or bare seconds (1-2 digits).
export function parseTimestampName(filename) {
  if (!filename || typeof filename !== "string") return null;
  // Strip the directory prefix, then take the leading stem (everything before the first
  // dot). The timecode always leads the name, so this drops single AND stacked/embedded
  // extensions that would otherwise hide it — e.g. a Flow round-trip like
  // "0-00.png_213412342134.jpeg.mp4" → "0-00".
  let base = filename.split(/[\\/]/).pop().split(".")[0].trim();

  // Flow projects downloaded directly append a download datetime stamp after the
  // timecode, e.g. "10-24_202608272310" → keep the "10-24". A trailing separator
  // followed by 8+ digits is a datestamp, never a real timecode component (ss,
  // hh/mm are ≤2 digits; bare mmss has no leading separator), so drop it.
  base = base.replace(/[-_]\d{8,}$/, "");

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
