# Random Transition Mix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user pick a set of transitions and apply them randomly across all cuts (no back-to-back repeats), from a dedicated "Random mix" section in the Transitions panel.

**Architecture:** A pure `mixTransitions(picks, n, rnd)` helper generates the per-cut assignment; `page.js` `applyTransitionMix` commits it into `transitionsByName` via the existing undoable `commitDoc`; `Editor` holds the ephemeral picked set and renders the mix UI. No render-pipeline changes — the mix just writes normal per-cut transition ids.

**Tech Stack:** Next.js (React client components), Vitest.

---

## File Structure

- `lib/transitions.js` — add pure `mixTransitions(picks, n, rnd)`.
- `lib/__tests__/transitions.test.js` — new test file for `mixTransitions`.
- `app/page.js` — add `applyTransitionMix(picks, clipNames)`; import `mixTransitions`; pass to `Editor`.
- `components/Editor.js` — `mixPicks` state + `toggleMix`; render the "Random mix" block; wire Apply.
- `app/globals.css` — small styles for the mix footer/count (reuse existing chip/button styles).

---

## Task 1: `mixTransitions` pure helper (TDD)

**Files:**
- Modify: `lib/transitions.js`
- Create: `lib/__tests__/transitions.test.js`

- [ ] **Step 1: Write the failing tests**

Create `lib/__tests__/transitions.test.js`:

```js
import { describe, it, expect } from "vitest";
import { mixTransitions } from "../transitions.js";

// A deterministic rnd() that yields the given fractions in order, then repeats.
const seq = (...vals) => {
  let i = 0;
  return () => vals[(i++) % vals.length];
};

describe("mixTransitions", () => {
  it("returns [] for empty picks or non-positive n", () => {
    expect(mixTransitions([], 5)).toEqual([]);
    expect(mixTransitions(["fade"], 0)).toEqual([]);
    expect(mixTransitions(["fade"], -2)).toEqual([]);
    expect(mixTransitions(null, 3)).toEqual([]);
  });

  it("repeats the single pick across all cuts", () => {
    expect(mixTransitions(["fade"], 4)).toEqual(["fade", "fade", "fade", "fade"]);
  });

  it("never places the same transition on adjacent cuts (2+ picks)", () => {
    // rnd always returns 0 → would pick index 0 every time without the guard;
    // the adjacent-repeat filter must force variation.
    const out = mixTransitions(["a", "b", "c"], 6, () => 0);
    for (let i = 1; i < out.length; i++) expect(out[i]).not.toBe(out[i - 1]);
    for (const id of out) expect(["a", "b", "c"]).toContain(id);
    expect(out.length).toBe(6);
  });

  it("is deterministic for a fixed rnd sequence", () => {
    // picks=[a,b]; first pick uses full pool [a,b], later picks use the pool
    // with the previous id filtered out (length 1), so rnd value maps directly.
    // rnd: 0.0 → index 0 of [a,b] = a; then pool=[b] → b; pool=[a] → a; pool=[b] → b
    const out = mixTransitions(["a", "b"], 4, seq(0.0));
    expect(out).toEqual(["a", "b", "a", "b"]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they FAIL**

Run: `cd story-to-video && npx vitest run lib/__tests__/transitions.test.js`
Expected: FAIL — `mixTransitions is not a function` / undefined import.

- [ ] **Step 3: Implement `mixTransitions`**

Append to `lib/transitions.js` (after the `transitionOf` function):

```js
// Assign a transition id to each of `n` cuts, chosen randomly from `picks`,
// avoiding the same id on consecutive cuts when possible. With a single pick,
// every cut gets it. rnd() is injectable for deterministic tests.
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

- [ ] **Step 4: Run the tests to verify they PASS**

Run: `cd story-to-video && npx vitest run lib/__tests__/transitions.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Full suite**

Run: `cd story-to-video && npx vitest run`
Expected: PASS (39 tests total: 35 existing + 4 new).

- [ ] **Step 6: Commit** — SKIP (leave uncommitted; user standing rule).

---

## Task 2: `applyTransitionMix` in `page.js`

**Files:**
- Modify: `app/page.js`

- [ ] **Step 1: Import `mixTransitions`**

The current import is:

```js
import { DEFAULT_TRANSITION_DURATION } from "../lib/transitions";
```

Change to:

```js
import { DEFAULT_TRANSITION_DURATION, mixTransitions } from "../lib/transitions";
```

- [ ] **Step 2: Add `applyTransitionMix`**

The existing `applyTransitionAll` callback ends at:

```js
  const applyTransitionAll = useCallback((type, clipNames) => {
    commitDoc((d) => {
      const next = {};
      // Skip the first clip — it has no incoming cut.
      for (let i = 1; i < clipNames.length; i++) next[clipNames[i]] = type;
      return { ...d, transitionsByName: next };
    });
  }, [commitDoc]);
```

Immediately AFTER it, add:

```js
  // Random mix: assign each cut a transition drawn randomly from `picks`
  // (no back-to-back repeats). One commit = one undo step.
  const applyTransitionMix = useCallback((picks, clipNames) => {
    const cutNames = clipNames.slice(1); // first image has no incoming transition
    const assigned = mixTransitions(picks, cutNames.length);
    commitDoc((d) => {
      const next = {};
      cutNames.forEach((name, i) => { next[name] = assigned[i]; });
      return { ...d, transitionsByName: next };
    });
  }, [commitDoc]);
```

- [ ] **Step 3: Pass it to `<Editor>`**

The `<Editor>` JSX currently has:

```js
          setTransition={setTransition} applyTransitionAll={applyTransitionAll}
```

Change to:

```js
          setTransition={setTransition} applyTransitionAll={applyTransitionAll}
          applyTransitionMix={applyTransitionMix}
```

- [ ] **Step 4: Verify**

Run: `cd story-to-video && npx vitest run`
Expected: PASS (39 tests).
Re-read edits for syntax. Do NOT run `npx next build`.

- [ ] **Step 5: Commit** — SKIP (leave uncommitted).

---

## Task 3: Random mix UI in `Editor.js`

**Files:**
- Modify: `components/Editor.js`

- [ ] **Step 1: Accept the new prop**

In the destructured `Editor({ ... })` props, find:

```js
  transitionsByName, transitionDuration, setTransition, applyTransitionAll, setTransitionDuration,
```

Change to:

```js
  transitionsByName, transitionDuration, setTransition, applyTransitionAll, applyTransitionMix, setTransitionDuration,
```

- [ ] **Step 2: Add mix state + toggle**

After the existing `useState` declarations near the top of the component (e.g. after `const [pendUrl, setPendUrl] = useState(null);`), add:

```js
  const [mixPicks, setMixPicks] = useState(() => new Set()); // ephemeral: chosen transitions for the random mix
  const toggleMix = useCallback((id) => {
    setMixPicks((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);
```

(`useState`/`useCallback` are already imported.)

- [ ] **Step 3: Render the "Random mix" block**

In the `.panel.transitions` block, the "apply to all" button currently ends the panel:

```js
          <button
            type="button" className="trall"
            onClick={() => applyTransitionAll(currentType, clips.map((c) => c.name))}
          >
            Apply “{transitionOf(currentType).label}” to all cuts
          </button>
        </div>
```

Replace that with (keeps the existing button, appends the mix block before the panel's closing `</div>`):

```js
          <button
            type="button" className="trall"
            onClick={() => applyTransitionAll(currentType, clips.map((c) => c.name))}
          >
            Apply “{transitionOf(currentType).label}” to all cuts
          </button>

          <div className="trmix">
            <div className="mini-h">Random mix</div>
            <div className="cap-hint">Pick a few, then apply them randomly across the cuts — no two neighbours alike.</div>
            <div className="transitions__chips">
              {TRANSITION_LIST.map((tr) => (
                <button
                  key={tr.id}
                  type="button"
                  className={`trchip ${mixPicks.has(tr.id) ? "is-on" : ""}`}
                  onClick={() => toggleMix(tr.id)}
                >
                  <span className="trchip__icon">{tr.icon}</span>{tr.label}
                </button>
              ))}
            </div>
            <div className="trmix-foot">
              <span className="trmix-count">
                {mixPicks.size ? `Picked ${mixPicks.size}` : "None picked"}
              </span>
              <button
                type="button" className="trall trmix-apply"
                disabled={mixPicks.size === 0}
                onClick={() => applyTransitionMix([...mixPicks], clips.map((c) => c.name))}
              >
                Apply random mix to video
              </button>
            </div>
          </div>
        </div>
```

- [ ] **Step 4: Verify**

Run: `cd story-to-video && npx vitest run`
Expected: PASS (39 tests).
Re-read: confirm the mix block is inside `.panel.transitions`, `mixPicks` toggling and the disabled guard are correct, and JSX is balanced. Do NOT run `npx next build`.

- [ ] **Step 5: Commit** — SKIP (leave uncommitted).

---

## Task 4: styles for the mix block

**Files:**
- Modify: `app/globals.css`

- [ ] **Step 1: Locate the transitions/`.trall` styles**

Run: `cd story-to-video && grep -n "\.trall\|\.transitions\b\|\.trchip\|\.mini-h\|\.cap-hint" app/globals.css`
Expected: find `.trall` and the transitions panel rules so the new rules sit beside them and match conventions.

- [ ] **Step 2: Add the mix styles**

Add near the `.trall` rule in `app/globals.css` (match the file's spacing/variable conventions):

```css
.trmix { margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--line-soft); }
.trmix .transitions__chips { margin-top: 8px; }
.trmix-foot { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-top: 10px; }
.trmix-count { font-size: 12.5px; color: var(--muted); }
.trmix-apply { margin: 0; }
.trmix-apply:disabled { opacity: .5; cursor: default; }
```

Note: if `.trall` already has a `margin-top` that would double up, `.trmix-apply { margin: 0; }` neutralises it inside the footer. If `--line-soft` is not a defined variable in this file, use `var(--line)` instead (check via the grep in Step 1).

- [ ] **Step 3: Verify**

Run: `cd story-to-video && npx vitest run`
Expected: PASS (39 tests).
Confirm CSS braces are balanced.

- [ ] **Step 4: Commit** — SKIP (leave uncommitted).

---

## Task 5: build + manual verification

**Files:** none.

- [ ] **Step 1: Full production build**

Run: `cd story-to-video && rm -rf .next && npx next build`
Expected: `✓ Compiled successfully` and a completed build listing the `/` route.

- [ ] **Step 2: Manual check**

Run: `cd story-to-video && npm run dev`, open the app, import audio + several images, Build timeline.

Verify:
- The Transitions panel shows a "Random mix" section with all transition chips.
- Tapping several chips toggles them on; the count updates ("Picked 3"); the Apply button enables only when ≥1 is picked.
- Clicking **Apply random mix to video** sets a varied spread across the ◇ cut markers with no identical neighbours; playing the preview shows different transitions.
- Clicking Apply again produces a different arrangement.
- Ctrl+Z reverts the whole mix in one step.
- Picking a single transition and applying makes every cut use it.
- Render an MP4 and confirm the varied transitions burn in.

- [ ] **Step 3: Final test run**

Run: `cd story-to-video && npx vitest run`
Expected: PASS (39 tests).

---

## Self-Review Notes

- **Spec coverage:** `mixTransitions` + tests (Task 1) ↔ spec "Pure core"; `applyTransitionMix` + import + prop (Task 2) ↔ spec "app/page.js"; `mixPicks`/`toggleMix` + Random mix block + Apply wiring (Task 3) ↔ spec "components/Editor.js"; footer/count styles (Task 4) ↔ spec "app/globals.css"; build + manual (Task 5) ↔ spec "Testing". Back-to-back-repeat avoidance, single-pick fallback, undoable single-commit, ephemeral picks, and cut-scope (clips 1..n-1) all covered.
- **Naming consistency:** `mixTransitions` (lib) → `applyTransitionMix` (page + Editor prop) → `mixPicks`/`toggleMix` (Editor) → `.trmix`/`.trmix-foot`/`.trmix-count`/`.trmix-apply` (CSS). `clips.map((c) => c.name)` used for clip names exactly as the existing "apply to all" button does.
- **No placeholders:** every code step shows complete code.
- **Commit steps:** intentionally SKIPPED per the user's standing no-commit rule.
