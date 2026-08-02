## 8. What is still off

`docs/application-limits.yaml` ships `auto_apply.enabled: false, dry_run: true`. It is the user's
file; this plan proposes values in §6 and edits nothing.

**The invariant to check is not which files are present but this: nothing in this repository opens a
browser unattended, and nothing on the auto path contains a click.** It is true at `fa192a1` and in
the current working tree — `grep -rn "\.click(" scripts/ --include=*.mjs` returns only
`fill-engine.mjs`, `scan-engine.mjs` and `bench-apply.mjs`, re-verified this pass — and it stays true
until Phase 5 W1 lands `scripts/auto/submit.mjs` and §4.2c lands `scripts/auto/advance.mjs`. Guards
existing is not the capability existing.

**And one thing the enable decision must be told, added on review:** `dry_run` **structurally cannot
observe** challenge incidence, silent dismissal, per-IP reputation effects or confirmation-email
delivery, because it never clicks. A clean dry-run report is evidence that the machine's internal
contracts hold. It is not evidence about the external world, and the first live night is the first
measurement of that dimension — which is why those columns are first-class in the live run report
from night one (Phase 5), and why W2 exists so that at least the _code path_ has run before an
employer sees it.

Until the runner ships **and** the user enables it, the user is on the submit button for every
application. That is the operative rule today, not a preference.
