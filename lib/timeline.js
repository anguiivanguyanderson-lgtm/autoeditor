// Build an ordered clip list that fully covers [0, audioDuration] from parsed
// items ({ name, seconds }). Returns { clips, warnings }.
export function buildTimeline(items, audioDuration) {
  const warnings = [];
  const valid = [];

  for (const it of items || []) {
    if (it.seconds == null || Number.isNaN(it.seconds)) {
      warnings.push(`Ignored "${it.name}": filename has no readable timestamp.`);
      continue;
    }
    if (it.seconds < 0) {
      warnings.push(`Ignored "${it.name}": negative timestamp.`);
      continue;
    }
    if (audioDuration > 0 && it.seconds >= audioDuration) {
      warnings.push(`Ignored "${it.name}": timestamp is beyond the audio duration.`);
      continue;
    }
    valid.push({ ...it });
  }

  valid.sort((a, b) => a.seconds - b.seconds);

  if (valid.length === 0) {
    warnings.push("No usable images. Check that filenames encode timestamps.");
    return { clips: [], warnings };
  }

  if (valid[0].seconds > 0) {
    warnings.push(
      `First image "${valid[0].name}" starts at ${valid[0].seconds}s; it will cover the lead-in from 0s.`
    );
  }

  const clips = [];
  for (let i = 0; i < valid.length; i++) {
    const start = i === 0 ? 0 : valid[i].seconds;
    const end = i + 1 < valid.length ? valid[i + 1].seconds : audioDuration;
    const duration = +(end - start).toFixed(3);
    if (duration <= 0) {
      warnings.push(`Duplicate/overlapping timestamp for "${valid[i].name}" — skipped.`);
      continue;
    }
    clips.push({ name: valid[i].name, start: +start.toFixed(3), duration });
  }

  return { clips, warnings };
}
