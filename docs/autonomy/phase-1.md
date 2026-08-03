### Phase 1 — State: a durable ledger, and a real definition of "verified"

**Capability:** the run stops being the unit of anything. A kill at application #437 of 999 loses
nothing, duplicates nobody, and the next invocation resumes at 437 by reading the database.
Separately: no document reaches the submit path on the strength of a file merely existing.

**Why now.** No per-application state exists anywhere. `auto_runs` holds counters and
`auto_submissions` gets a row only at click time, so a crash at #437 leaves no queryable answer to
"which 436 were done". And the idempotency key is wrong by construction — `PRIMARY KEY (run_id,
slug)` (verified in `db.mjs`'s `auto_submissions` CREATE TABLE, both at `fa192a1` and in the
worktree) means the same slug can be submitted once **per run** with no conflict, and
`ON CONFLICT DO UPDATE` overwrites rather than refuses. That is exactly backwards for a row whose job
is to be a claim. **This paragraph describes the tree before 1.2 landed** — at HEAD the key is
`PRIMARY KEY (slug, mode)` and the cited shape no longer exists. It is kept as the diagnosis, not as
a description of today.

| #       | Work item                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Owner         | State |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ----- |
| 1.1     | `auto_queue(slug PRIMARY KEY, run_id, board_key, origin, state, attempt_no, plan_sha256, reason_kind, reason_detail, claimed_at, updated_at)` **shall** exist, with states `queued → claimed → planned → authorized → attempted → submitted \| challenged \| deferred \| failed`. The claim is `INSERT ... ON CONFLICT DO NOTHING`; **0 changes means another worker owns it and this one must not click.** `origin` is added for §4.2's exclusion key.                                                                                                                                  | `implementer` | SHALL |
| 1.2     | **REVISED (C8).** `auto_submissions` **shall** be re-keyed `PRIMARY KEY (slug, mode)` with `ON CONFLICT DO NOTHING` — **not `(slug)`**, because dry-run rows live in the same table and a rehearsal would otherwise pre-consume the live claim forever. `countAutoSubmissions` and `companySubmissionBreakdown` **shall** keep reading both modes: the comment above `companySubmissionBreakdown` in `db.mjs` says the cap counts rehearsals deliberately and that is correct. `plan_sha256` is copied into the claim row so a retry with a _different_ plan is a visibly different act. | `implementer` | SHALL |
| 1.3     | `verify-claims` **shall** write a durable row `(slug, doc_sha256, mode, verdict, profile_sha256, verified_at)`. `hasVerifiedResume` **shall** mean "a passing row exists whose `doc_sha256` matches the file on disk **and** whose `profile_sha256` matches the current fact base". Today a résumé verified against yesterday's fact base is still "verified" after the user edits `profile.yaml`.                                                                                                                                                                                       | `implementer` | SHALL |
| 1.4     | The file-existence heuristic in `automatability.mjs` — the `fs.existsSync(resume)` branch behind `hasVerifiedResume` — **shall** be deleted outright, and the model-written `context.json` `resume_status` **shall** stop being load-bearing for tier classification.                                                                                                                                                                                                                                                                                                                    | `implementer` | SHALL |
| 1.5     | `updateApplication` (`scripts/lib/db.mjs`) **shall** wrap its SELECT → parse → merge → upsert in one transaction or lock. Today two concurrent callers lose one patch entirely — a manual outcome update made during a multi-hour run is silently discarded.                                                                                                                                                                                                                                                                                                                             | `implementer` | SHALL |
| 1.6     | The durable `attempted` row write — **and only it** — **shall** be wrapped in a bounded retry on `SQLITE_BUSY`. Change nothing else about the SQLite configuration.                                                                                                                                                                                                                                                                                                                                                                                                                      | `implementer` | SHALL |
| 1.7     | `migrate.mjs` **shall** gain a rebuild path for `auto_queue`, and the `documents` table's no-on-disk-source status **shall** be restated in its header.                                                                                                                                                                                                                                                                                                                                                                                                                                  | `implementer` | SHALL |
| **1.8** | **NEW (review, missing). DONE 2026-08-02** (`build-manager`) — the policy is below. A retention policy for the two things that grow per application: `auto_submissions.doc` (verify block, consent labels, screenshots) and `jobs/<slug>/`. **Shall** state a measured per-row and per-workspace byte cost, a 30-day projection at the rate 0.11 establishes, and a `prune-jobs`/`archive` cadence. §6.5's per-run DB copy is priced against that projection, not against today's size.                                                                                                  | `implementer` | SHALL |

**1.1–1.7 landed 2026-08-02 in `d2a1dcf`** (`implementer`), all four falsifiable checks green:
`tests/auto/queue.test.mjs` (checks 1 and 2), `tests/lib/verification.test.mjs` +
`tests/auto/automatability.test.mjs` (check 3), `tests/auto/submissions.test.mjs` (check 4).
Gate 1697 full / 262 security, verified by two agents independently. 1.8 is below.

**Two things Phase 5 inherits, neither of them a defect today.**

- **An abandoned `(slug, 'live')` row cannot be re-claimed.** `abandonAttempt` resolves the claim
  by writing `outcome: 'abandoned'` into the row that holds the key, so a later `beginSubmit` for
  that slug reports 0 changes, raises STOP and throws. That is fail-closed and deliberate, but it
  sits awkwardly beside the reason `abandoned` exists at all: it does not consume cap budget
  precisely because transient click-site failures were expected to be common, and each one now
  poisons its slug permanently. It is not reachable today — `auto_queue` leaves the slug terminal
  and `enqueueAutoJobs` will not re-queue it — but `migrate.mjs --reset-queue` clears that guard.
  **Phase 5 owns the retry policy and must rule on this explicitly rather than discover it.**
- **`withBusyRetry` is proven as a policy, not as a detector.** Its tests inject a throwing
  function; nothing has exercised it against a genuinely `SQLITE_BUSY` database, because real
  contention costs a 5s `busy_timeout` wait per assertion. The predicate that recognises a
  node:sqlite busy error is therefore unverified.

**Explicitly out of scope for Phase 1:** connection pooling, WAL tuning, and reordering the
`busy_timeout` / `journal_mode` pragmas. **Note on the evidence, accepted from
`attack:feasibility`:** the cited concurrency measurement is 3-4 writers, and this project's own
settled lesson is that the lock defect was invisible at 6 and needed 20 to show — so that evidence
is thin. The conclusion survives on independent arithmetic: 8 workers × 7 durable transitions per
job ÷ ~45s per job ≈ 1.24 writes/s against a cited 0.24ms/write, three orders of magnitude of
headroom. Out of scope, on the better argument.

**Falsifiable check.** A test in `tests/auto/` that inserts 50 queue rows, processes 20, simulates
process death mid-job, reopens the DB, and asserts the resume selection is exactly the 30
unprocessed slugs and zero of the 20 done. A second that two workers racing one slug produce
exactly one successful claim and the loser returns without clicking. A third that a `resume.md`
whose `doc_sha256` has no passing verification row classifies as `blocked`, and that editing
`profile.yaml` invalidates an existing verification. **A fourth (C8): a slug with a `dry_run` row
still admits a `live` attempted insert reporting 1 change, and a second `live` insert on the same
slug reports 0.**

---

#### 1.8 — the retention policy, with its measurements

Taken 2026-08-02 at `d2a1dcf`, on this machine (win32 / node 24.13.1). Reproduce with the
commands named against each number.

**The rate this is projected at is NOT 0.11's.** 0.11 was to produce qualifying leads per board
per sweep and an extrapolation to 999/day; it produced no number, and a projection anchored on a
measurement nobody took is not a projection. This is anchored instead on `auto_apply.per_day_max`
in `docs/application-limits.yaml`, which the user set to **10** on 2026-08-02 — a cap the user
chose beats an extrapolation nobody ran. The plan's 999/day aspiration is carried as the upper
bracket so the conclusion can be checked at both ends.

**Per-row cost — the database.** `auto_submissions` holds zero rows (nothing has ever
auto-submitted, correctly: `auto_apply.enabled` is `false`), so there is no observed row to
measure and the figure below is **constructed from real components**, not sampled:

| Component                             | Bytes                              | Where it came from                                                                    |
| ------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------- |
| verify block                          | 352                                | a real `verify-claims resume` run on `coinbase-software-engineer`                     |
| consent labels                        | ~110–410 each, 1–3 per form        | the real labels in `tests/fixtures/boards/pages/*.html` (min 44, median 109, max 407) |
| the ten scalar columns                | 289                                | measured on the constructed row                                                       |
| **`auto_submissions` total**          | **~1.3 KB typical, ~2.5 KB worst** |                                                                                       |
| `auto_queue` row                      | ~300                               | all short scalars, no `doc`                                                           |
| `verifications` row                   | ~200                               | two 64-char hashes plus slug/mode/verdict/timestamp; 7 real rows                      |
| **Per application, all three tables** | **≈1.8 KB**                        |                                                                                       |

**The row does not carry the screenshots.** `screenshots` is a pair of **paths**
(`{before, after}`, asserted by `tests/auto/audit.test.mjs:55`), not inline data. That single
design fact is what keeps the database cheap and pushes the whole problem onto the filesystem —
and it is the fact the rest of this policy turns on.

**Per-workspace cost — the filesystem.** 8 workspaces, 38 files, 282,278 bytes total: mean
**35,285**, median 14,669, max 121,832 (`coinbase-software-engineer`). By extension:

| Extension      | Bytes   | Share | What `archive.mjs`'s `classify()` does with it                |
| -------------- | ------- | ----- | ------------------------------------------------------------- |
| `.pdf`         | 129,350 | 45.8% | `regenerable` — a row with no content; render-pdf rebuilds it |
| `.json`        | 75,817  | 26.9% | `store`                                                       |
| `.md`          | 35,105  | 12.4% | `store`                                                       |
| `.js`          | 29,572  | 10.5% | `store`                                                       |
| `.render.html` | 12,434  | 4.4%  | `drop`                                                        |

So of 35,285 mean bytes, **17,562 would actually be stored** — the two largest categories by
share are the two the existing classifier already declines to keep. That part is already right.

**Screenshots, measured, and the caveat that matters more than the number.** Nothing in this
repository produces one yet, so these were taken against the loopback fixture boards with real
Chromium (`playwright-core` + Edge, 1280×900): greenhouse 29,675, honest-greenhouse 25,422,
hostile-consent 43,676, hostile-escalated 16,392, ashby 21,732, lever 27,198 — mean **~26 KB**,
so **~52 KB per application** for the before/after pair. `fullPage` and viewport were
byte-identical on all six, because these pages fit in one viewport.

**Treat 26 KB as a floor, not an estimate.** The fixture pages carry no logo, no photography and
no long description; a real Greenhouse or Lever posting carries all three, and a full-page shot of
one is plausibly 150–400 KB. Nobody has measured one. That measurement belongs with 0.9's
`--browser-fill` leg, which now exists and drives a real browser — it should capture a real board
once and replace this bracket.

**30-day projection.**

| Rate                                | Apps / 30d | DB growth | Workspaces on disk | leads.db if screenshots were archived |
| ----------------------------------- | ---------- | --------- | ------------------ | ------------------------------------- |
| **10/day** — the user's cap today   | 300        | 0.55 MB   | ~26 MB             | +15.6 MB                              |
| **999/day** — the plan's aspiration | 29,970     | 54 MB     | ~2.6 GB            | +1.6 GB                               |

`jobs/leads.db` is **1,163,264 bytes** today. Disk figures use the fixture floor for screenshots;
at a plausible real-board 300 KB/pair the workspace column becomes ~100 MB and ~10 GB.

**The ruling §6.5 asked for: the per-run DB copy stays cheap, and it stays cheap only because
the screenshots are paths.** At 10/day the store reaches ~1.7 MB in 30 days and a copy is free.
At 999/day it reaches ~55 MB, and a copy of that is well under a second on SSD — §6.5 survives
even at the aspirational rate, which is the question that was actually being asked. **But
`classify()` returns `store` for any extension it does not recognise, and `.png` is one of them.**
Archive a run's screenshots and the dominant filesystem term moves into the one file that gets
copied on every run: ~1.6 GB at 999/day, and §6.5 inverts from free to prohibitive. This is a
latent defect, not a live one — nothing writes a `.png` into a workspace yet.

**Cadence, and the one change it needs.**

1. **`prune-jobs` after every run.** It removes regenerable intermediates; measured on today's 8
   workspaces it reclaims 12,434 bytes across 2 files (`--json` reports `prune=2 bytes=12434`).
   Small, but it is the cheapest possible call and it never touches a stored artifact.
2. **`archive --closed` weekly.** It archives only workspaces whose application carries a closed
   outcome (`rejected`/`closed`/`withdrawn`/`no_response`) and refuses a live one, so it needs no
   judgement and cannot archive something the user is still waiting on.
3. **`archive purge --days 90 --apply` monthly.** A workspace with no resolvable date is skipped,
   never purged — an unknown date is not an old date.
4. **`classify()` must gain a `.png` case before anything writes one** (`implementer`,
   `scripts/maintenance/archive.mjs`). Recommended: `drop` for the pre-submit shot, `store` for
   the confirmation shot. The confirmation is the evidence a user needs to withdraw an
   application; the before-shot is debugging material with a short useful life. That halves the
   dominant term and keeps the ruling above true at 999/day.
