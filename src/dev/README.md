# `src/dev/` — measurement and audit

**Owners:** `qa` owns `bench-*.mjs` and the harness tests; `implementer` owns the
rest.

Nothing in here is on an application path. These are the tools that turn "it
feels slow" and "that test is flaky" into numbers, plus one audit that answers a
question the ledger alone cannot.

| Command                      | What it does                                                       |
| ---------------------------- | ------------------------------------------------------------------ |
| `audit-submissions.mjs`      | Did the clicks this repo recorded as submissions actually submit?  |
| `bench-apply.mjs`            | Times scan → plan → fill against the local fake ATS.               |
| `bench-runner.mjs`           | The campaign harness: a whole run, end to end.                     |
| `bench-green-prevalence.mjs` | How many forms could the machine complete alone, by widget shape?  |
| `flake-rate.mjs`             | Turns "that test is flaky" into a rate with an interval.           |
| `scorecard.mjs`              | One JSON line per run, appended to `docs/scorecard.jsonl`.         |
| `spawn-counter.cjs`          | Not a command — a `--require` preload that counts child processes. |

## `audit-submissions.mjs` is the one to know

Every live click this pipeline has made is consistent with two very different
worlds: the board confirmed and the classifier could not read it, or the submit
never completed. This command lays the ledger next to the staged post-click
pages and prints a `needs inbox check` column.

**It does not touch the ledger, by design.** A staged capture is a candidate, not
evidence — the same rule that governs promotion into the classifier's corpus.
Corrections go through `applications.mjs remove <slug> --confirm`, which is hard
rule 2's sanctioned path. Following up on a job you never applied to is a real
cost, which is why this runs **before** any follow-up.

## What does not belong here

- Anything the pipeline imports at runtime. If a product path needs it, it
  belongs in its domain.
- A benchmark that writes to the real store. Benchmarks use fixtures; a ledger
  entry is opt-in (`--ledger`).
- A measurement taken while other agents are editing the tree. Three identical
  gate runs once gave 4 → 6 → 0 failures and 75s → 150s purely from contention.

`docs/measurements.md` is the ledger these harnesses append to. It is a dated
record: append, never rewrite.

Detail: [`../../docs/code/15-benchmarks.md`](../../docs/code/15-benchmarks.md).
