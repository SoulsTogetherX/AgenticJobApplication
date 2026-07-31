# Measurement ledger

Owned by `innov-perf`. **Append-only** — never rewrite history; a dip that got
fixed should stay visible.

One hard rule: **no performance change merges without a before/after
measurement.** This exists because an audit found ~24 seconds of
`waitForTimeout` in the apply path that everyone had assumed was network time.
Assumption is the failure mode.

## How to read an entry

- **budget** — what the owning worker declared **before** starting. Some changes
  are meant to cost time (sanitising at ingest; a state machine before its
  batching lands). A change is judged against **its declared budget, not against
  zero**. "none declared" is recorded as-is and never invented retroactively.
- **numbers** — reported in three separate columns. A model turn costs seconds
  and a Node call costs milliseconds; collapsing them hides the largest term.
- **inconclusive** is a legitimate verdict. Two samples are not a trend.

## Measuring honestly

Same machine, same fixture, warm and cold runs distinguished. **Never measure
against a live employer's board** — use the local fake board under
`tests/fixtures/boards/`. Live boards vary and you would be measuring their
weather.

## Entry template

```
## <id> — <what changed>
- agent:    <owning agent>
- harness:  <exact command, copy-pasteable>
- baseline: <sha> — round_trips=<n> sleep_ms=<n> model_turns=<n> wall_ms=<n>
- after:    <sha> — round_trips=<n> sleep_ms=<n> model_turns=<n> wall_ms=<n>
- budget:   <declared up front, or "none declared">
- verdict:  improved | within budget | REGRESSION | inconclusive
- note:     <= 40 words
```

## Regression protocol

When a number moves the wrong way beyond its declared budget, `innov-perf`
files it against the sha and asks the owning worker one question: _is this the
expected mid-flight cost of an unfinished change, or a real regression?_

1. **Work in progress** → the worker names the commit where it should recover;
   re-measure there. This answer cannot be used twice for the same change.
2. **Real regression, fix known** → fix forward. Both numbers stay in the
   ledger so the dip is visible rather than erased.
3. **Real regression, no fix in hand** → request rollback. The manager reverts;
   the work returns to planning **with the ledger entry attached**, so the next
   attempt does not blindly retry the approach that just failed.
4. **Disagreement** → a second innovator with a different lens breaks the tie.

**Correctness outranks speed.** A declared security cost is never rolled back on
performance grounds alone.

---

## Baselines

### B0 — pre-autonomy baseline

- sha: `d7fc28d` (tag `baseline-pre-autonomy`)
- suite: **639 tests, 0 failures, 37.6s** (`npm test`)
- apply path: not yet instrumented — `qa-breaker` captures the first real
  numbers with `scripts/dev/bench-apply.mjs` before `w2-engine` or
  `w3-resolution` change anything.

Audit estimates to reproduce or refute (these are **estimates**, not
measurements, and become numbers only once the harness exists):

| Quantity                            | Estimate                        |
| ----------------------------------- | ------------------------------- |
| Scan probe sleep                    | ~6.8s (380ms × ≤18 dropdowns)   |
| Fill sleep, 14-combo form           | ~17s                            |
| Cover letter into `contenteditable` | up to 45s (15ms/char, uncapped) |
| Browser round trips per page        | 4                               |
| Model turns per page                | ~12                             |

---

## Entries

_None yet._
