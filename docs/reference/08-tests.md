# 08 — The test suite, and what it does not cover

```bash
npm test                                  # the count-asserting gate — NOT `node --test`
npm run test:security                     # the same gate over the Phase 1 set
node --test tests/leads/fit.test.mjs      # a single file, while iterating
node --test "tests/**/*.test.mjs"         # a quoted glob — never a bare directory
```

> **Corrected 2026-07-31 (`doc-scribe`). The two sentences struck below were the
> exact belief the gotcha exists to kill, sitting in the doc about testing.**
>
> - ~~`npm test` is `node --test`, recurses~~ — it is
>   `node .github/workflows/test-gate.mjs full`. `node --test` **exits 0 on an
>   empty run**, so an exit code alone is not evidence that anything executed.
>   The gate expands directories itself, asserts the test count against
>   `package.json`'s `testGate` floor, caps `todo` at 0, and fails any skip that
>   carries no reason.
> - ~~`node --test` recurses, so nested files are discovered automatically~~ —
>   **on Node 24 it does not recurse.** It tries to load the directory as a
>   module and reports `Cannot find module`, which reads as a test failure, and
>   the obvious "fix" (dropping the argument) gives a green run over zero tests.
>   Node 20 and 22 do recurse, so the same command means different things across
>   the CI matrix. See [09-gotchas.md](09-gotchas.md).
>
> **The test total is deliberately not restated here.** It was "597 tests, 597
> pass, 0 fail, ~28 s" at the 2026-07-29 audit and it has moved several times
> since. The number that is actually enforced lives in `package.json`'s
> `testGate` block — a floor of **1697 full / 262 security** as of `d2a1dcf`
> (2026-08-02) — and a count copied into prose goes stale the day someone adds a
> test. **Read `package.json`, not this line.** The per-file counts in the tables
> below are from the snapshot and are indicative, not current.

**The two gates do not run the same files, and the security gate's list is
hand-written.** `testGate.full.paths` is just `tests`, so the full gate picks up
anything you add anywhere. `testGate.security.paths` is `tests/security/` plus
two named files — `tests/lib/untrusted.test.mjs` and
`tests/documents/verify-claims.test.mjs`. That second one is why the security
floor moved with the full floor in `d2a1dcf`: verify-claims gained its
durable-row tests, and they land on **both** gates. A security-relevant test
placed outside those paths runs on the full gate only, and nothing warns you.

`tests/` mirrors `scripts/` one for one, with shared fixtures in
`tests/fixtures/`. Discovery is the gate's job: `.github/workflows/test-gate.mjs`
walks the directories itself, so there is no manifest to keep in sync — but also
no version of `node --test <dir>` you can rely on.

**Tests never touch the real profile.** `profile/` is gitignored personal data;
every test points `--profile` / `--answers` / `--leads` / `--file` at a fixture. That
is why so many scripts honour an explicit path verbatim (`resolveLeadSource`,
`resolveApplicationSource`) — the fixture-pointing convention is a design
constraint, not a convenience.

---

## The test files, by area

_36 files at the 2026-07-29 snapshot; 66 as of 2026-07-31; **84** as of
2026-08-02 (`find tests -name '*.test.mjs' | wc -l`). The tables below cover the
original 36 plus the files added by Phase 1. Not listed: `tests/security/` (10,
the Phase 1 gate), `tests/dev/` (1), the rest of `tests/auto/` (9 files in all),
and `tests/apply/`, which has grown from 8 files to 13._

### `tests/lib/` (6 files, ~3742 lines)

| file                          | covers                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `untrusted.test.mjs` (1484)   | each injection pattern fires, invisible characters and hidden HTML are stripped, honest prose is **not** flagged, and the bypasses that are **asserted uncaught**                                                                                                                                                                                                                                                                        |
| `lock.test.mjs` (705)         | `acquire`/`withLock`, the one stale-break rule, and that concurrent writers no longer lose answers                                                                                                                                                                                                                                                                                                                                       |
| `db.test.mjs` (504)           | round-tripping leads and applications, `setLeadStatus` via `json_set`, keyword tables, `screens` composite key, `documents` blobs, `board_stats` accumulation incl. the first-sweep `last_qualifying_at` case, `healScreens` refusing to drop a populated table                                                                                                                                                                          |
| `verification.test.mjs` (466) | **what "verified" means.** That the digest covers both fact-base files in a fixed order; that a missing file hashes differently from an empty one; that editing `profile.yaml` **or** the resume invalidates an existing verification; that a cover-letter row does not vouch for the resume; that a recorded **failure** is not verification; and that both entry points **throw rather than fail open** when the check is not injected |
| `keywords.test.mjs` (361)     | that `TECH_TERMS` is still a superset of the pre-merge list, that `extractTech` output over the live store is unchanged, and — most importantly — the **negative corpus**                                                                                                                                                                                                                                                                |
| `lib.test.mjs` (222)          | `textSnippet` block boundaries, entity decoding, `parseDateRange`, `yearsOfExperience` overlap union, `evidenceText`, `jaccard`                                                                                                                                                                                                                                                                                                          |

`verification.test.mjs`'s most valuable case is the plainest one: _"a resume with
no passing row is not verified, however present the file is."_ That is the
deleted heuristic, pinned so it cannot come back.

### `tests/auto/` — the durable ledger (2 of 9 files)

| file                         | covers                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `submissions.test.mjs` (419) | the `(slug, mode)` key: a dry run does not consume the live claim, a **new run** cannot re-claim a slug an old run submitted, a mode-less row is stored as `live` so it cannot dodge the key, the acknowledgement is never dropped by the claim, and the old-key rebuild keeps every row — including a collision loser, carried into the survivor's `doc` under `superseded` |
| `queue.test.mjs` (368)       | a kill mid-run resumes at exactly the unprocessed slugs; two workers racing one slug produce **one** claim and the loser does not click; an `attempted` row is stranded rather than resumed; a deferral without a reason is **refused**; a dead worker's claim returns to the pool only after the lease; `withBusyRetry` is bounded and rethrows                             |

`keywords.test.mjs`'s negative corpus is the single most valuable test file here. It
pins down that "we go to production", "Spring 2027 internship", "a bun and coffee"
and "Section S3 of the handbook" do **not** register as Go, Spring, Bun and S3.
**Add to it whenever you add an alias.**

### `tests/leads/` (19 files, ~3400 lines)

The heaviest area, and rightly so.

| file                              | covers                                                                                                                                                                                             |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `find-jobs.test.mjs` (460)        | `passesLimits` across every branch, `dedupeLeads` incl. repost detection, `parseSalaryMax`, `parseWorkdayPostedOn`, `parseJobviteFeed`, `parseSuccessFactorsPage`, `loadEnv`, `normalizeAdzunaJob` |
| `body-gate.test.mjs` (365)        | Gate 2. The OSHA-safety-codes case, the Twilio three-contradictory-locations case, the Station Casinos maintenance case, relocation vs relocation-assistance, state carve-outs                     |
| `efficiency-tools.test.mjs` (357) | `recommend`, `prep-queue`, `status`, seniority extraction incl. the "1.5+ years" lookbehind                                                                                                        |
| `screen-blockers.test.mjs` (320)  | scam and clearance patterns, culture clustering, thin descriptions, `partial_description`                                                                                                          |
| `screen-cache.test.mjs` (262)     | the `screens` table, `--skip-screened`, `record` taking its id positionally                                                                                                                        |
| `enrich.test.mjs` (257)           | all four detail-URL derivations and all four description parsers, against fixtures                                                                                                                 |
| `fit.test.mjs` (251)              | `splitRequirements` on flattened single-line bodies, required-vs-preferred, the `min_required_terms` guard, senior scope                                                                           |
| `risk.test.mjs` (211)             | repost counting from both sources, `bodyFingerprint` whole-body behaviour, evergreen phrasing                                                                                                      |
| `prep-queue.test.mjs` (208)       | `buildQueue`, `DONE_STATUSES`, cluster `covers` attachment                                                                                                                                         |
| `cluster.test.mjs` (207)          | leader clustering, no chaining, `shared` narrowing                                                                                                                                                 |
| `manage-sources.test.mjs` (203)   | duplicate detection, per-ATS field order, line-by-line add/remove preserving comments                                                                                                              |
| `screen-stages.test.mjs` (168)    | `evaluateStages` ordering, short-circuit, flag threading                                                                                                                                           |
| `remote-location.test.mjs` (162)  | `US_WIDE_LOCATION` whole-string matching, "Tulsa, USA" still rejected                                                                                                                              |
| `gate-audit.test.mjs` (160)       | `diffAudit` newly-rejected / newly-accepted / stage-moved                                                                                                                                          |
| `aggregators.test.mjs` (140)      | jobicy / remotive / remoteok normalisation and `remote_source`                                                                                                                                     |
| `keyword-wiring.test.mjs` (113)   | that `rankLeads` actually consumes the keyword index                                                                                                                                               |
| `board-yield.test.mjs` (105)      | `scoreBoard` counting and the solid-vs-qualifying split                                                                                                                                            |
| `discover-boards.test.mjs` (121)  | `postsBelowSenior`, the yield gate                                                                                                                                                                 |
| `find-boards.test.mjs` (86)       | slug probing                                                                                                                                                                                       |

### `tests/documents/` (7 files, ~1224 lines)

| file                             | covers                                                                                                                                                                                                                                           |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `keyword-plan.test.mjs` (291)    | `buildPlan`, `cleanTitle`, `titleMirror`, `placementFor`, sanitisation before planning                                                                                                                                                           |
| `ats-lint.test.mjs` (247)        | `lintMarkdown`, `lintHtml`, `lintPdf`, `checkCoverage`                                                                                                                                                                                           |
| `new-job.test.mjs` (236)         | `--from-lead` matching by id/url/normalised-url, exit 4, `description=missing`                                                                                                                                                                   |
| `verify-claims.test.mjs` (407)   | the **guardrail failure cases** — five `bad-*.md` fixtures that must each fail — plus, since `d2a1dcf`, that a pass writes a durable `verifications` row and a fail writes one too. On the **security** gate's path list as well as the full one |
| `verify-coverage.test.mjs` (178) | R8 reporting without blocking                                                                                                                                                                                                                    |
| `reuse-check.test.mjs` (120)     | scoring and the REUSE/TAILOR verdict                                                                                                                                                                                                             |
| `render-pdf.test.mjs` (108)      | `atsPostProcess` bullet injection and link rewriting, `findBrowser`                                                                                                                                                                              |

The `bad-*.md` fixtures are the heart of the guardrail suite:
`bad-missing-annotation.md` (R1), `bad-unknown-fact-id.md` (R2),
`bad-invented-number.md` (R3), `bad-unknown-tech.md` (R6),
`bad-cover-letter.md` (cover-letter mode), plus `empty.md` (R7) and the
`good-*.md` pair that must pass.

### `tests/apply/` (8 files, ~1874 lines)

| file                                    | covers                                                                                                                                  |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `fill-plan.test.mjs` (414)              | `isConsent`, `buildPlan` for every field shape, `readiness`, the duplicate-combo skip, file-field matching, the Workday exit-3 hand-off |
| `fill-page.test.mjs` (377)              | the engine's decision table, executed against a stubbed `page`                                                                          |
| `answer-bank-universals.test.mjs` (254) | the contact/employment/education/question rules                                                                                         |
| `field-cache.test.mjs` (247)            | `fingerprint` stability, `applyCache` never overwriting live data, `hits`/`probed` accounting, `invalidate`                             |
| `pending-questions.test.mjs` (252)      | `mergeQuestions`, `questionsFromPlans`, `predictedFields`, consent exclusion                                                            |
| `answer-bank.test.mjs` (159)            | statuses, the concept guard, option matching                                                                                            |
| `answer-bank-exact.test.mjs` (144)      | exact-question lookup outranking the label rules                                                                                        |
| `ats-parsers.test.mjs` (121)            | `detectAts` and each adapter's shape                                                                                                    |

### `tests/applications/`, `tests/profile/`, `tests/maintenance/`, `tests/hooks/`

| file                              | covers                                                                                                                                                                                                                                                                                                                                                |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `applications.test.mjs` (213)     | the table, the YAML export, `updateApplication` merge                                                                                                                                                                                                                                                                                                 |
| `applications-cli.test.mjs` (122) | list / find / stats / remove `--confirm` / export                                                                                                                                                                                                                                                                                                     |
| `follow-ups.test.mjs` (200)       | the cadence, the 2-follow-up cap, closed statuses excluded                                                                                                                                                                                                                                                                                            |
| `keyword-coverage.test.mjs` (320) | the three buckets, `max(total, required)` gating, adjacency direction                                                                                                                                                                                                                                                                                 |
| `profile-gaps.test.mjs` (195)     | `computeGaps`, `jobWeight` doubling, `extractTech` false positives                                                                                                                                                                                                                                                                                    |
| `apply-profile.test.mjs` (157)    | refusing removals and edits without the flags, the backup                                                                                                                                                                                                                                                                                             |
| `save-answer.test.mjs` (155)      | duplicates, provenance, `--replace` refusing a user-stated answer, and refusing a legacy entry that predates provenance                                                                                                                                                                                                                               |
| `profile-validate.test.mjs` (45)  | fixture, example, and — if present — the **real** profile parse with unique ids                                                                                                                                                                                                                                                                       |
| `archive.test.mjs` (312)          | `classify`, `planArchive` refusals, verify-before-delete, byte-identical restore, regenerable rows                                                                                                                                                                                                                                                    |
| `prune-jobs.test.mjs` (67)        | `planPrune` targeting only `.render.html`                                                                                                                                                                                                                                                                                                             |
| `migrate.test.mjs` (173)          | that `migrate` creates `auto_queue` on a database that predates it and reports the state breakdown without changing it; that `--reset-queue` clears run state a dead process left behind but **REFUSES while a click is unaccounted for**; that the `documents` table is never touched, because it has no other copy; that `--dry-run` writes nothing |
| `guard-hooks.test.mjs` (240)      | every guard hook in **both** directions — deny the right things, allow the right things                                                                                                                                                                                                                                                               |
| `hook.test.mjs` (66)              | `protect-profile.js` deny paths                                                                                                                                                                                                                                                                                                                       |

`profile-validate.test.mjs` is a nice touch: it validates the user's **real**
profile when it exists, so a hand-edit that breaks the fact base fails the suite
locally without ever committing the data.

---

## What the suite does not cover

This matters as much as what it does. None of these are hypothetical — each maps to
a live defect in [AUDIT.md](AUDIT.md).

| gap                                                                                                                                                                                                                                    | consequence                                                                                                                                                                                                                            | AUDIT   |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| **No cross-module lexicon consistency test.** Nothing asserts that a term `keyword-plan` puts in `must_use` will survive `verify-claims` R6.                                                                                           | The two disagree, and following the plan produces R6 failures.                                                                                                                                                                         | **C3**  |
| **No test that R6 catches a lowercase claim.** All fixtures use canonical casing.                                                                                                                                                      | `techTermsIn` is case-sensitive, so "kubernetes" passes.                                                                                                                                                                               | **C4**  |
| **No test that `matchOption` refuses to upgrade a generic answer.** The tests check that a Yes/No _resolves_, not that it resolves to something _equivalent_.                                                                          | A banked "Yes" becomes "Yes, 5+ years professionally", marked OK.                                                                                                                                                                      | **C1**  |
| **No test that documented script paths exist.** Still true.                                                                                                                                                                            | The instance is fixed, the gap is not: `job-worker.md`, `README.md` and `package.json`'s `verify` script all name `scripts/documents/verify-claims.mjs` now, so **C5 is closed** — but nothing would catch the next move of that file. | **C5**  |
| **No test that `prep-queue` scores tech overlap.** `keyword-wiring.test.mjs` covers `rankLeads` in isolation, not its caller.                                                                                                          | `prep-queue` ranks on title alone.                                                                                                                                                                                                     | **H1**  |
| **No test that adapter `valueAliases` reaches the plan.** `ats-parsers` checks the adapter shape; `fill-plan.test.mjs` checks `comboStrategies` only.                                                                                  | `valueAliases` is dead code.                                                                                                                                                                                                           | **H8**  |
| **No test for `board_stats` consumers.** `db.test.mjs` proves it can be written.                                                                                                                                                       | Nothing reads it.                                                                                                                                                                                                                      | **H9**  |
| **No test that option lists survive the scan/cache round trip.**                                                                                                                                                                       | Silently truncated at 40, then 60.                                                                                                                                                                                                     | **H3**  |
| **No test that `render-pdf` fails when the render fails.**                                                                                                                                                                             | It reports success on a stale PDF.                                                                                                                                                                                                     | **H4**  |
| ~~**No test that a second injection of the same pattern is neutralised.**~~ **CLOSED** — `untrusted.test.mjs`'s _"EVERY occurrence is redacted, not just the first"_ asserts both copies are gone **and** that the finding count is 2. | Was: only the first was redacted, and the finding count understated the attempt.                                                                                                                                                       | **H11** |
| **No test for archive with a subdirectory.**                                                                                                                                                                                           | Subdirectories are deleted, never archived.                                                                                                                                                                                            | **H2**  |
| **No `prettier --check` in CI.**                                                                                                                                                                                                       | 36 files currently fail it.                                                                                                                                                                                                            | **M7**  |
| **No test that `employment.reject_types` is wired.** `body-gate.test.mjs` passes an inline limits object _with_ the key.                                                                                                               | The real limits file lacks it, so the gate never rejects.                                                                                                                                                                              | **H6**  |

That last one is the most instructive pattern in the suite: **several tests pass
inline `limits` objects containing keys the real `application-limits.yaml` does not
have.** The unit under test is correct; the wiring is not. Any test that supplies
config inline should be paired with one that loads the real file.
