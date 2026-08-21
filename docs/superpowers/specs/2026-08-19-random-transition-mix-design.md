# Random transition mix — design

## Problem

The Transitions panel can set one transition on a selected cut, or apply one transition
to every cut. There is no way to give a video variety — a spread of different transitions
across its cuts — without setting each one by hand.

## Goal

Let the user pick a **set** of transitions from the available list and apply them
**randomly** across all the cuts. The random assignment must not follow the pick order,
and should avoid the same transition on back-to-back cuts. The picked set is ephemeral —
nothing is saved.

Decided during brainstorming:

- A **dedicated "Random mix" section** with its own multi-select chips (separate from the
  existing single-select chips).
- **Random, avoiding back-to-back repeats** (falls back to pure random if only one is
  picked).

## Pure core (testable)

Add to `lib/transitions.js`:

```js
// Assign a transition id to each of `n` cuts, chosen randomly from `picks`,
// avoiding the same id on consecutive cuts when possible. With a single pick,
// every cut gets it. rnd() is injectable for testing.
export function mixTransitions(picks, n, rnd = Math.random) {
  const out = [];
  if (!picks || !picks.length || n <= 0) return out;
  for (let i = 0; i < n; i++) {
    let pool = picks;
    if (picks.length > 1 && i > 0) pool = picks.filter((p) => p !== out[i - 1]);
    out.push(pool[Math.floor(rnd() * pool.length)]);
  }
  return out;
}
```

Unit-tested (new `lib/__tests__/transitions.test.js`) with a seeded/sequenced `rnd`:

- Empty picks or `n <= 0` → `[]`.
- Single pick → array of that id repeated `n` times.
- Multiple picks → no two adjacent entries equal; every entry is a member of `picks`.
- Deterministic output for a fixed `rnd` sequence.

## Wiring

### `app/page.js`

Add `applyTransitionMix(picks, clipNames)`, mirroring the scope of the existing
`applyTransitionAll` (cuts are clips `1..n-1`; the first image has no incoming
transition), and committing once so a single undo reverts the whole mix:

```js
const applyTransitionMix = useCallback((picks, clipNames) => {
  const cutNames = clipNames.slice(1);
  const assigned = mixTransitions(picks, cutNames.length);
  commitDoc((d) => {
    const next = {};
    cutNames.forEach((name, i) => { next[name] = assigned[i]; });
    return { ...d, transitionsByName: next };
  });
}, [commitDoc]);
```

Requires importing `mixTransitions` from `../lib/transitions` (alongside the existing
`DEFAULT_TRANSITION_DURATION` import). Pass `applyTransitionMix` to `<Editor>`.

### `components/Editor.js`

- Accept `applyTransitionMix`.
- Local state `mixPicks` — a `Set` of transition ids (ephemeral; not undoable, not saved).
  A `toggleMix(id)` handler adds/removes an id.
- Render a "Random mix" block at the bottom of the existing `.panel.transitions`:
  - a `mini-h` heading + one-line hint,
  - the `TRANSITION_LIST` rendered as chips (reusing `.transitions__chips` / `.trchip`),
    each `is-on` when its id is in `mixPicks`, toggling on click,
  - a footer row with a picked-count label and an **Apply random mix to video** button
    (reusing the `.trall` button style), disabled when `mixPicks.size === 0`.
- The button calls `applyTransitionMix([...mixPicks], clips.map((c) => c.name))`.
  Re-clicking reshuffles (fresh random each call).

### `app/globals.css`

- A light divider/heading for the mix block and a small count label. Reuse existing
  `.mini-h`, `.transitions__chips`, `.trchip`, `.trall` styles; add only a `.trmix-foot`
  (flex row: count on the left, button on the right) and a `.trmix-count` muted label.

## Data flow

```
tap chips → mixPicks Set (Editor local)
Apply → applyTransitionMix([...mixPicks], allClipNames)
      → mixTransitions(picks, cutCount) → per-cut ids (no adjacent repeats)
      → commitDoc rebuilds transitionsByName (undoable, one step)
      → preview + export read transitionsByName as usual
```

## Edge cases

- **`mixPicks` includes `cut` (None):** allowed — those cuts render as hard cuts. No
  special handling; `cut` is a normal id.
- **Zero cuts (single image):** `cutNames` is empty → `transitionsByName` becomes `{}`
  (clears any transitions); harmless. The button may still be enabled; applying is a no-op
  on transitions.
- **One transition picked:** every cut gets it (same as "apply to all"), via the
  single-pick branch — no attempt to avoid repeats.
- **Undo/redo:** one `commitDoc` per Apply, so Ctrl+Z reverts the entire mix in one step;
  the ephemeral `mixPicks` selection is unaffected by undo.
- **Interaction with the single-select chips:** independent. Selecting a cut and picking a
  single transition still works; the mix block does not change `selectedCut`/`currentType`.

## Testing

- **Unit:** `mixTransitions` cases above (`lib/__tests__/transitions.test.js`).
- **Manual:** build a timeline with several images; in Random mix, pick 3 transitions;
  Apply → cuts show a varied spread with no identical neighbors; the ◇ cut markers light
  up; play the preview to see different transitions; click Apply again → a different
  arrangement; Ctrl+Z reverts in one step; render an MP4 and confirm the varied
  transitions burn in.

## Out of scope (YAGNI)

- Saved mix presets.
- Per-transition weighting / probabilities.
- Guaranteeing every picked transition is used at least once.
- A separate reseed button (re-clicking Apply reshuffles).
