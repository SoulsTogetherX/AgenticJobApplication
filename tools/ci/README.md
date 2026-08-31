# `tools/ci/` — build helpers

**Owner:** `ci-engineer`.

Four Node programs the build and CI call. They moved here from
`.github/workflows/` in the 2026-08-27 re-layout; their `ROOT` arithmetic is
unchanged because `tools/ci/` sits at the same depth the workflows directory did.

| File                     | What it does                                                         |
| ------------------------ | -------------------------------------------------------------------- |
| `test-gate.mjs`          | Runs the suite and asserts the run **proves** tests executed.        |
| `scaffolding-reaper.mjs` | Fails the build when dev-only code outlives its declared phase.      |
| `perf-gate.mjs`          | Fails the build on a measured performance or model-usage regression. |
| `report-browsers.mjs`    | Prints which browser this machine has, so a skip is attributable.    |

Invoked as `npm test` → `node tools/ci/test-gate.mjs full`, `npm run
test:security`, `npm run reap`, and as steps in `.github/workflows/ci.yml`.

## Why `test-gate.mjs` exists at all

`node --test` **exits 0 on an empty run**. An exit code alone is therefore not
evidence that anything ran — a glob that stopped matching after a directory
rename produces a green build over zero tests. The gate expands the directories
itself, counts what ran, and asserts the count against a floor in
`package.json`'s `testGate`.

**Raise a floor only** to a number two consecutive honest runs produced on a
quiescent tree, record those runs in `docs/measurements.md` ("Test-floor
ledger"), and **never lower one to make a change green.** The prose ledger that
used to live in `package.json` moved to that document on 2026-08-27; the rule
did not move with it.

## The scaffolding contract

Anything temporary declares it in frontmatter:

```yaml
scaffolding: true
remove_after: phase-2
```

The reaper fails the build when a declared artifact outlives its phase, which is
what makes "we'll remove it later" a check rather than a promise. Permanent
things omit both fields — and something is not permanent merely because removing
it later would be inconvenient.

## What does not belong here

- Product code. Nothing in `src/` may import from this directory.
- A gate that should be a counted test. The `tests/quality/*` gates run under
  `npm test` **and** in CI precisely so a local run catches them; a CI-only check
  is discovered after the push.
- `npx` or a `.cmd` shim in a spawn. Use `process.execPath` and the plain-JS bin
  (`node_modules/eslint/bin/eslint.js`) — the shim path fails `EINVAL` on
  Windows, which is this repo's primary platform.

Detail: [`../../docs/code/12-harness-and-ci.md`](../../docs/code/12-harness-and-ci.md),
[`../../docs/guide/09-conventions.md`](../../docs/guide/09-conventions.md).
