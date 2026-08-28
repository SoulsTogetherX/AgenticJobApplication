# `src/auto/` — the unattended runner and its brakes

**Owner:** `implementer`.

The only directory in this repository that contains a click. Read
[`../../docs/guide/07-safety-model.md`](../../docs/guide/07-safety-model.md)
before changing anything here — every file is either a gate or the thing the
gates constrain.

## Entry points

| Command          | What it does                                                                  |
| ---------------- | ----------------------------------------------------------------------------- |
| `cycle.mjs`      | One whole cycle: find → screen → prep → tailor → apply. **Can send.**         |
| `auto-apply.mjs` | The runner itself: claims queue rows, drives the state machine. **Can send.** |
| `preflight.mjs`  | Would an unattended run be allowed right now? Read-only, says so itself.      |
| `requeue.mjs`    | Puts one stranded queue row back to work — and refuses `attempted`.           |
| `cycle.cmd`      | The Windows Scheduler wrapper; pins the repo root, appends `logs/cycle.log`.  |

Everything else is a library with no command line: `job.mjs` (per-job state
machine), `pool.mjs` (origin-keyed worker pool), `stages.mjs`, `multipage.mjs`,
`advance.mjs`, `submit.mjs`, `authorize.mjs`, `trust.mjs`, `caps.mjs`,
`breaker.mjs`, `guard.mjs`, `classify.mjs`, `taxonomy.mjs`, `audit.mjs`,
`digest.mjs`, `reconcile.mjs`, `notify.mjs`, `untrusted-text.mjs`.

## The click surface is exactly two files

`submit.mjs` (the submit) and `advance.mjs` (a `next`-role control, never a
submit). `.click(` appearing anywhere else under this directory fails
`tests/auto/click-surface.test.mjs`. That is the invariant; widening it is a
decision, not a refactor.

## What does not belong here

- **Deciding what to type.** That is `src/apply/`. This directory sequences and
  refuses; it does not resolve a field.
- Anything that reads a capability off prose. Which hosts the classifier can
  read is a fact about `classify.mjs` — call `sightedHosts()`.
- A model, on any path.

## Traps

- `auto_submissions` is keyed **`(slug, mode)`**. `(run_id, slug)` lets one slug
  be submitted once per run; `(slug)` alone lets a dry run eat the live claim.
- A **0** from `claimAutoJob`/`recordAutoSubmission` means another worker owns
  the slug and this one must not click. That is the normal fan-out result, not
  an error. The one outcome that does not hold the claim is
  `reconciled-not-sent`; widening that list re-opens the permanent-deadlock bug.
- A **scoped STOP is not the breaker's board pause.** The pause is a timed
  backoff cleared by one success; a scoped STOP is a durable brake only a human
  clears. `raiseStop` **throws** on a non-global scope with no key rather than
  widening to global — that refusal is the load-bearing half.
- Classifier rules are bounded by their **evidence**: a fixture-sourced rule
  fires on loopback only. A real board reading `unclassified` is the system
  working. The only lawful cure is a captured page via
  `src/apply/capture-post-submit.mjs`.
- A confirmed live click resolves its own ledger row (`run.recordSubmission`).

Detail: [`../../docs/code/09-auto-runner.md`](../../docs/code/09-auto-runner.md),
[`10-auto-safety.md`](../../docs/code/10-auto-safety.md).
