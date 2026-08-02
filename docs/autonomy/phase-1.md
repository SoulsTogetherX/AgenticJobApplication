### Phase 1 — State: a durable ledger, and a real definition of "verified"

**Capability:** the run stops being the unit of anything. A kill at application #437 of 999 loses
nothing, duplicates nobody, and the next invocation resumes at 437 by reading the database.
Separately: no document reaches the submit path on the strength of a file merely existing.

**Why now.** No per-application state exists anywhere. `auto_runs` holds counters and
`auto_submissions` gets a row only at click time, so a crash at #437 leaves no queryable answer to
"which 436 were done". And the idempotency key is wrong by construction — `PRIMARY KEY (run_id,
slug)` (verified, `db.mjs:232-246`, both at `fa192a1` and in the worktree) means the same slug can
be submitted once **per run** with no conflict, and `ON CONFLICT DO UPDATE` overwrites rather than
refuses. That is exactly backwards for a row whose job is to be a claim.

| #       | Work item                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Owner                        | State |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- | ----- |
| 1.1     | `auto_queue(slug PRIMARY KEY, run_id, board_key, origin, state, attempt_no, plan_sha256, reason_kind, reason_detail, claimed_at, updated_at)` **shall** exist, with states `queued → claimed → planned → authorized → attempted → submitted \| challenged \| deferred \| failed`. The claim is `INSERT ... ON CONFLICT DO NOTHING`; **0 changes means another worker owns it and this one must not click.** `origin` is added for §4.2's exclusion key.                                                                                       | `w4-autonomy`                | SHALL |
| 1.2     | **REVISED (C8).** `auto_submissions` **shall** be re-keyed `PRIMARY KEY (slug, mode)` with `ON CONFLICT DO NOTHING` — **not `(slug)`**, because dry-run rows live in the same table and a rehearsal would otherwise pre-consume the live claim forever. `countAutoSubmissions` and `companySubmissionBreakdown` **shall** keep reading both modes: `db.mjs:866-874` counts rehearsals toward caps deliberately and that is correct. `plan_sha256` is copied into the claim row so a retry with a _different_ plan is a visibly different act. | `w4-autonomy`                | SHALL |
| 1.3     | `verify-claims` **shall** write a durable row `(slug, doc_sha256, mode, verdict, profile_sha256, verified_at)`. `hasVerifiedResume` **shall** mean "a passing row exists whose `doc_sha256` matches the file on disk **and** whose `profile_sha256` matches the current fact base". Today a résumé verified against yesterday's fact base is still "verified" after the user edits `profile.yaml`.                                                                                                                                            | `w1-security`, `w4-autonomy` | SHALL |
| 1.4     | The file-existence heuristic at `automatability.mjs:454-473` **shall** be deleted outright, and the model-written `context.json` `resume_status` **shall** stop being load-bearing for tier classification.                                                                                                                                                                                                                                                                                                                                   | `w4-autonomy`                | SHALL |
| 1.5     | `updateApplication` (`db.mjs:589-597`) **shall** wrap its SELECT → parse → merge → upsert in one transaction or lock. Today two concurrent callers lose one patch entirely — a manual outcome update made during a multi-hour run is silently discarded.                                                                                                                                                                                                                                                                                      | `w4-autonomy`                | SHALL |
| 1.6     | The durable `attempted` row write — **and only it** — **shall** be wrapped in a bounded retry on `SQLITE_BUSY`. Change nothing else about the SQLite configuration.                                                                                                                                                                                                                                                                                                                                                                           | `w4-autonomy`                | SHALL |
| 1.7     | `migrate.mjs` **shall** gain a rebuild path for `auto_queue`, and the `documents` table's no-on-disk-source status **shall** be restated in its header.                                                                                                                                                                                                                                                                                                                                                                                       | owner per §0.3               | SHALL |
| **1.8** | **NEW (review, missing).** A retention policy for the two things that grow per application: `auto_submissions.doc` (verify block, consent labels, screenshots) and `jobs/<slug>/`. **Shall** state a measured per-row and per-workspace byte cost, a 30-day projection at the rate 0.11 establishes, and a `prune-jobs`/`archive` cadence. §6.5's per-run DB copy is priced against that projection, not against today's size.                                                                                                                | owner per §0.3               | SHALL |

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
