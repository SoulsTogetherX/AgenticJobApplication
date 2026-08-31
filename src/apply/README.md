# `src/apply/` — reading and filling a live form

**Owner:** `implementer`.

Everything between "here is an application page" and "here is what was typed
into it, and what was refused". The decisions live here; `src/auto/` only
sequences them.

## Entry points

| Command                   | What it does                                                           |
| ------------------------- | ---------------------------------------------------------------------- |
| `answer-bank.mjs`         | Resolves scanned fields against the fact base. Read-only.              |
| `fill-plan.mjs`           | Turns a scan into a deterministic plan. **The gate chain lives here.** |
| `pending-questions.mjs`   | Every question the fact base cannot answer, across all prepped jobs.   |
| `rebuild-plans.mjs`       | Re-derives stale plans from the saved scan.                            |
| `automatability.mjs`      | Could the machine apply to this posting alone?                         |
| `capture-post-submit.mjs` | Stage → review → promote a real confirmation page into the corpus.     |
| `auth-sync.mjs`           | Copies the MCP browser profile to the runner's own profile.            |

Libraries: `scan-engine.mjs` (installs the scanner, probes custom widgets),
`fill-engine.mjs` (executes a plan page-side), `intents.mjs` (typed intents),
`field-cache.mjs` (remembered form shapes), `longform.mjs`, `disclosure.mjs`,
`assent-policy.mjs` (the user's `unattended_assent` keys), `browser.mjs`, and
`ats/` — one adapter per board (`greenhouse`, `lever`, `ashby`, `generic`).

## What does not belong here

- **A click.** The click surface is two files, both in `src/auto/`:
  `submit.mjs` and `advance.mjs`. `tests/auto/click-surface.test.mjs` keeps it
  at two.
- A model. Throughput rises through an adapter, a probed option list, or a
  banked answer — never by having a model resolve an `UNKNOWN` field.
- Reading state back out of the page. Fill and scan run Playwright-side and
  report; nothing is read back out.

## Traps

- **Enter is a submit.** `type-enter` presses it only when the page reports a
  focused row, and `fillPage` holds a window-capture submit guard for its whole
  run. Never read `report.submitsBlocked > 0` as harmless.
- Non-upload fills retry on a stale locator, because Ashby remounts.
- `ok` never means a file reached the right field — attachments are reported from
  `report.uploads`, never from the plan.
- A fuzzy yes/no match can return the right concept with the **wrong truth
  value**. Defer; never auto-invert.
- The stemmer is **suffix-only** by design. English negates with prefixes, so a
  prefix rule would fold `unable` onto `able`.
- A checkbox or radio group never auto-acts unattended without a grant from the
  user's `unattended_assent` keys, and `confirm-widget` is a different marker
  from `confirm` on purpose.

Detail: [`../../docs/code/06-apply-scanning.md`](../../docs/code/06-apply-scanning.md),
[`07-apply-planning.md`](../../docs/code/07-apply-planning.md),
[`08-apply-filling.md`](../../docs/code/08-apply-filling.md).
