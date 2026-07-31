# Project reference

A complete walkthrough of this codebase: what every file is for, how control flows
through it, and every defect found in a full audit on 2026-07-29.

Written to be read top to bottom the first time, and dipped into afterwards.

## Read in this order

| #   | doc                                                | what you get                                                                      |
| --- | -------------------------------------------------- | --------------------------------------------------------------------------------- |
| 00  | [Overview](00-overview.md)                         | the mental model, where state lives, the truthfulness chain, the two-lexicon rule |
| 01  | [Control flow](01-control-flow.md)                 | the four pipelines, call by call, with the reasoning behind each ordering         |
| 02  | [`scripts/lib/`](02-lib.md)                        | the shared foundation — helpers, storage, the lexicon, untrusted input            |
| 03  | [`scripts/leads/`](03-leads.md)                    | discovery: 13 board fetchers, two ingest gates, the four-stage screen, ranking    |
| 04  | [`scripts/documents/`](04-documents.md)            | tailoring, the keyword plan, verify-claims, PDF rendering, ATS linting            |
| 05  | [`scripts/apply/`](05-apply.md)                    | the browser path: scanner, answer bank, fill plan, fill engine                    |
| 06  | [Record & feedback](06-record-and-feedback.md)     | applications, follow-ups, profile tools, store maintenance                        |
| 07  | [Guardrails & config](07-guardrails-and-config.md) | hooks, the 11 skills, the subagent, every config and policy file                  |
| 08  | [Tests](08-tests.md)                               | the test suite, and — importantly — what it does not cover                        |
| 09  | [Gotchas](09-gotchas.md)                           | the incident record — every trap that cost this project a real failure            |
| —   | **[AUDIT](AUDIT.md)**                              | **54 findings, each with a reproduction and a fix direction**                     |

> **This reference is a snapshot taken 2026-07-29.** Phase 1 of
> `docs/autonomy-plan.md` landed on 2026-07-30/31 and changed several of the
> files described here — most sharply `scripts/lib/untrusted.mjs` (rewritten,
> 171 → 1177 lines) and the browser path (`fill-page.js` deleted, the
> `addScriptTag` round-trip closed). Corrections are marked inline in the
> affected sections.
>
> **The manifest's `lines` column was re-derived with `wc -l` on 2026-07-31**
> (`doc-scribe`) — 24 entries were wrong, several by an order of magnitude
> (`untrusted.mjs` 171 → 1177, `fill-plan.mjs` 459 → 1389, `guard-bash.mjs`
> 94 → 504). The **rows themselves** have not been re-derived: the manifest still
> under-lists files added since 2026-07-29 — `scan-engine.mjs`,
> `fill-engine.mjs`, `browser.mjs`, `scripts/dev/`, `.github/workflows/test-gate.mjs`
> and the `docs/` files written during this build are all absent. Use it to find
> the doc for a file, not as a census.

## If you only read one thing

[AUDIT.md](AUDIT.md), and specifically **C3** — `keyword-plan` proposing terms
that `verify-claims` R6 then rejects. **C1 is closed** (`147eb68`); it is worth
reading anyway, because it is the clearest example in this file of a green test
suite over a defect that put a false claim on a real application.

## Audit summary

| severity     | count | meaning                                                                    |
| ------------ | ----- | -------------------------------------------------------------------------- |
| **Critical** | 6     | breaks a stated guarantee, or puts wrong information on a real application |
| **High**     | 14    | silently drops, mis-handles or fails to protect work                       |
| **Medium**   | 16    | wrong behaviour with a workaround, or a defence that does not hold         |
| **Low**      | 18    | correctness nits, dead code, documentation drift                           |

The three highest-value one-line fixes named on 2026-07-29 were **C5** (a stale
script path that disabled the truthfulness gate inside the tailoring subagent),
**H10** (the apply fast-path unreachable), and **M6** (one `".."`). **C5 and H10
are now closed** — see the table at the top of [AUDIT.md](AUDIT.md); M6 should be
assumed open until someone opens `status.mjs`.

---

# Complete file manifest

All 156 tracked files, with the doc that explains each.

## Root

| file                       | lines | purpose                                                                 | doc                               |
| -------------------------- | ----- | ----------------------------------------------------------------------- | --------------------------------- |
| `CLAUDE.md`                | 420   | the project's own operating manual, loaded every session                | [07](07-guardrails-and-config.md) |
| `README.md`                | 74    | public-facing summary                                                   | [07](07-guardrails-and-config.md) |
| `LICENSE`                  | 201   | Apache License 2.0                                                      | —                                 |
| `package.json`             | 39    | `type: module`; deps `js-yaml` + `marked`; `npm test` = the count gate  | [07](07-guardrails-and-config.md) |
| `package-lock.json`        | 75    | lockfile                                                                | —                                 |
| `.gitignore`               | 21    | `profile/*` (not `profile/`), `jobs/`, `.env`, `.playwright-mcp/`       | [07](07-guardrails-and-config.md) |
| `.gitattributes`           | 5     | `* text=auto eol=lf` — load-bearing for template-literal tests          | [07](07-guardrails-and-config.md) |
| `.prettierrc`              | 3     | `{ "semi": false }`                                                     | [07](07-guardrails-and-config.md) |
| `.prettierignore`          | 16    | two documented exceptions: the eval'd browser files, `job-sources.yaml` | [07](07-guardrails-and-config.md) |
| `.env.example`             | 12    | Adzuna credential template                                              | [07](07-guardrails-and-config.md) |
| `.mcp.json`                | 17    | the Playwright MCP server, with a persistent browser profile            | [07](07-guardrails-and-config.md) |
| `.github/workflows/ci.yml` | 135   | security gate first, then `npm test` × {ubuntu, windows} × {node 20, 22} | [07](07-guardrails-and-config.md) |

## `.claude/` — agent configuration

| file                                  | lines | purpose                                                               | doc                                                      |
| ------------------------------------- | ----- | --------------------------------------------------------------------- | -------------------------------------------------------- |
| `settings.json`                       | 50    | permissions + the four hook registrations                             | [07](07-guardrails-and-config.md)                        |
| `hooks/protect-profile.js`            | 41    | PreToolUse: deny writes to the fact base                              | [07](07-guardrails-and-config.md)                        |
| `agents/job-worker.md`                | 59    | the Sonnet-pinned per-job worker and its JSON contract                | [07](07-guardrails-and-config.md)                        |
| `skills/apply-job/SKILL.md`           | 345   | the full browser application flow                                     | [05](05-apply.md), [07](07-guardrails-and-config.md)     |
| `skills/apply-job/scan-page.js`       | 863   | the page scanner (runs in the page; eval'd, not a module)             | [05](05-apply.md)                                        |
| `skills/apply-job/scan.driver.mjs`    | 198   | installs + runs the scanner and probes dropdowns Playwright-side      | [05](05-apply.md)                                        |
| ~~`skills/apply-job/fill-page.js`~~   | —     | **DELETED 2026-07-31**; the engine is `scripts/apply/fill-engine.mjs` | [05](05-apply.md)                                        |
| `skills/pipeline-jobs/SKILL.md`       | 190   | batch processing, one subagent per lead                               | [07](07-guardrails-and-config.md)                        |
| `skills/find-jobs/SKILL.md`           | 103   | the sweep + four ways to ingest a user-supplied source                | [07](07-guardrails-and-config.md)                        |
| `skills/tailor-resume/SKILL.md`       | 94    | the 10-step tailoring flow                                            | [04](04-documents.md), [07](07-guardrails-and-config.md) |
| `skills/tailor-cover-letter/SKILL.md` | 64    | the same, sharing `context.json`                                      | [04](04-documents.md)                                    |
| `skills/manage-applications/SKILL.md` | 137   | read/write the application store                                      | [07](07-guardrails-and-config.md)                        |
| `skills/manage-sources/SKILL.md`      | 50    | add/remove/verify swept boards                                        | [07](07-guardrails-and-config.md)                        |
| `skills/update-profile/SKILL.md`      | 53    | merge a replaced source doc into the profile, add-only                | [07](07-guardrails-and-config.md)                        |
| `skills/check-applied/SKILL.md`       | 40    | history lookup                                                        | [07](07-guardrails-and-config.md)                        |
| `skills/follow-up/SKILL.md`           | 50    | nudge cadence + outcome recording                                     | [07](07-guardrails-and-config.md)                        |
| `skills/profile-gaps/SKILL.md`        | 45    | demand-vs-profile analysis                                            | [07](07-guardrails-and-config.md)                        |

## `docs/` — policy and working documents

| file                         | lines | purpose                                            | doc                               |
| ---------------------------- | ----- | -------------------------------------------------- | --------------------------------- |
| `application-limits.yaml`    | 287   | **user-owned** hard filters every job must pass    | [07](07-guardrails-and-config.md) |
| `job-sources.yaml`           | 81    | the 44 swept boards, one flow-style entry per line | [07](07-guardrails-and-config.md) |
| `tailoring-rules.md`         | 153   | the contract both tailoring skills load            | [04](04-documents.md)             |
| `board-candidates.yaml`      | 872   | output of `find-boards.mjs`, awaiting yield-gating | [07](07-guardrails-and-config.md) |
| `candidates/fortune500.yaml` | 146   | discovery input                                    | [07](07-guardrails-and-config.md) |
| `candidates/yc.yaml`         | 637   | discovery input, from the public yc-oss directory  | [07](07-guardrails-and-config.md) |
| `candidates/local-lv.yaml`   | 64    | discovery input, Las Vegas metro                   | [07](07-guardrails-and-config.md) |
| `improvement-plan.md`        | 429   | proposals and measurements (not a contract)        | [07](07-guardrails-and-config.md) |
| `next-session-plan.md`       | 262   | session hand-off notes                             | [07](07-guardrails-and-config.md) |

## `schemas/`, `templates/`, `profile/`

| file                           | lines | purpose                                            | doc                             |
| ------------------------------ | ----- | -------------------------------------------------- | ------------------------------- |
| `schemas/job.schema.json`      | 26    | shape of `jobs/<slug>/job.json`                    | [04](04-documents.md)           |
| `schemas/context.schema.json`  | 69    | shape of the shared `context.json`                 | [04](04-documents.md)           |
| `templates/document.css`       | 84    | the print stylesheet for both PDFs                 | [04](04-documents.md)           |
| `profile/profile.example.yaml` | 53    | sanitised template for the gitignored real profile | [06](06-record-and-feedback.md) |

## `scripts/lib/` — shared foundation

| file            | lines | purpose                                                                                           | doc             |
| --------------- | ----- | ------------------------------------------------------------------------------------------------- | --------------- |
| `lib.mjs`       | 480   | output mode, `mapPool`, HTTP/HTML, fact index, `evidenceText`, `techTermsIn`, jaccard, validators | [02](02-lib.md) |
| `db.mjs`        | 651   | the whole SQLite schema and every accessor                                                        | [02](02-lib.md) |
| `keywords.mjs`  | 468   | **the one skill lexicon**; `surface` vs `aliases`; written-form checks                            | [02](02-lib.md) |
| `untrusted.mjs` | 1177  | rule 0 in code — strip injection carriers from postings                                           | [02](02-lib.md) |

## `scripts/leads/` — discovery and screening

| file                  | lines | purpose                                                              | doc               |
| --------------------- | ----- | -------------------------------------------------------------------- | ----------------- |
| `find-jobs.mjs`       | 1554  | 13 board fetchers, both ingest gates, dedupe/repost, the CLI         | [03](03-leads.md) |
| `screen.mjs`          | 517   | scam/blocker/seniority/culture patterns over the four stages         | [03](03-leads.md) |
| `fit.mjs`             | 268   | L2 — required-vs-preferred split, stack overlap, senior scope        | [03](03-leads.md) |
| `enrich.mjs`          | 287   | per-posting description fetchers for the four ATS types without them | [03](03-leads.md) |
| `prep-queue.mjs`      | 263   | which leads to tailor ahead of time                                  | [03](03-leads.md) |
| `manage-sources.mjs`  | 250   | line-by-line editor for `job-sources.yaml`, with a live prescreen    | [03](03-leads.md) |
| `gate-audit.mjs`      | 240   | re-run every stage, diff against the baseline, exit 1 on regression  | [03](03-leads.md) |
| `risk.mjs`            | 242   | L3 — repost, evergreen, duplicate body, boilerplate ratio, injection | [03](03-leads.md) |
| `recommend.mjs`       | 214   | deterministic ranking against the profile                            | [03](03-leads.md) |
| `board-yield.mjs`     | 202   | which boards actually produce reachable roles                        | [03](03-leads.md) |
| `cluster.mjs`         | 195   | group near-duplicate postings so one resume serves several           | [03](03-leads.md) |
| `discover-boards.mjs` | 185   | propose new boards, yield-gated; never edits the source list         | [03](03-leads.md) |
| `find-boards.mjs`     | 275   | company NAME → public board slug, via API probing                    | [03](03-leads.md) |
| `stages.mjs`          | 109   | the L0–L3 registry and `evaluateStages`                              | [03](03-leads.md) |

## `scripts/documents/` — tailoring and verification

| file                | lines | purpose                                                            | doc                   |
| ------------------- | ----- | ------------------------------------------------------------------ | --------------------- |
| `keyword-plan.mjs`  | 419   | `must_use` / `blocked` / placement / title mirror, before drafting | [04](04-documents.md) |
| `ats-lint.mjs`      | 287   | will an ATS read the rendered PDF?                                 | [04](04-documents.md) |
| `verify-claims.mjs` | 263   | **R1–R8, the load-bearing truthfulness gate**                      | [04](04-documents.md) |
| `new-job.mjs`       | 279   | scaffold `jobs/<slug>/`, preferably from the lead store            | [04](04-documents.md) |
| `render-pdf.mjs`    | 142   | markdown → PDF via local Edge/Chrome headless                      | [04](04-documents.md) |
| `reuse-check.mjs`   | 127   | can an existing tailored resume be reused?                         | [04](04-documents.md) |

## `scripts/apply/` — form filling

| file                    | lines | purpose                                                       | doc               |
| ----------------------- | ----- | ------------------------------------------------------------- | ----------------- |
| `answer-bank.mjs`       | 950   | scan fields → answers, from the fact base only; never invents | [05](05-apply.md) |
| `fill-plan.mjs`         | 1389  | where the decisions happen; writes the plan and the bootstrap | [05](05-apply.md) |
| `pending-questions.mjs` | 317   | every unanswerable question, across all prepped jobs, once    | [05](05-apply.md) |
| `field-cache.mjs`       | 216   | remember the SHAPE of forms already seen (never the answers)  | [05](05-apply.md) |
| `ats/index.mjs`         | 65    | `detectAts` + the Workday hand-off list                       | [05](05-apply.md) |
| `ats/greenhouse.mjs`    | 35    | combo order, file fields, the country-picker alias            | [05](05-apply.md) |
| `ats/lever.mjs`         | 21    | mostly native selects                                         | [05](05-apply.md) |
| `ats/ashby.mjs`         | 19    | react-style dropdowns                                         | [05](05-apply.md) |
| `ats/generic.mjs`       | 20    | the fallback; `match: /.^/` never auto-matches                | [05](05-apply.md) |

## `scripts/applications/` — the application record

| file                     | lines | purpose                                                  | doc                             |
| ------------------------ | ----- | -------------------------------------------------------- | ------------------------------- |
| `applications.mjs`       | 195   | list / find / stats / remove `--confirm` / export        | [06](06-record-and-feedback.md) |
| `update-application.mjs` | 142   | record an outcome or a sent follow-up                    | [06](06-record-and-feedback.md) |
| `follow-ups.mjs`         | 100   | who is due a nudge (max 2, then cold)                    | [06](06-record-and-feedback.md) |
| `log-application.mjs`    | 79    | the only way to create a record, after the user confirms | [06](06-record-and-feedback.md) |
| `check-applied.mjs`      | 75    | have we been here before, and how long ago?              | [06](06-record-and-feedback.md) |

## `scripts/profile/` — fact base and feedback

| file                   | lines | purpose                                                            | doc                             |
| ---------------------- | ----- | ------------------------------------------------------------------ | ------------------------------- |
| `keyword-coverage.mjs` | 368   | covered / **ask** / gap — "you have this and never wrote it down"  | [06](06-record-and-feedback.md) |
| `profile-gaps.mjs`     | 222   | demand vs evidence, weighted toward rejections                     | [06](06-record-and-feedback.md) |
| `apply-profile.mjs`    | 117   | install a reviewed profile, refusing silent deletions and rewrites | [06](06-record-and-feedback.md) |
| `save-answer.mjs`      | 234   | the only sanctioned write into the fact base; records provenance   | [06](06-record-and-feedback.md) |

## `scripts/maintenance/` + root script

| file                         | lines | purpose                                                         | doc                             |
| ---------------------------- | ----- | --------------------------------------------------------------- | ------------------------------- |
| `maintenance/archive.mjs`    | 681   | fold closed workspaces into `documents`, verified byte-for-byte | [06](06-record-and-feedback.md) |
| `maintenance/migrate.mjs`    | 205   | flat, idempotent rebuild + keyword re-index                     | [06](06-record-and-feedback.md) |
| `maintenance/prune-jobs.mjs` | 151   | drop `.render.html` intermediates, dry-run by default           | [06](06-record-and-feedback.md) |
| `status.mjs`                 | 100   | the whole-pipeline digest in one call                           | [06](06-record-and-feedback.md) |

## `scripts/hooks/` — guardrails

| file              | lines | purpose                                   | doc                               |
| ----------------- | ----- | ----------------------------------------- | --------------------------------- |
| `guard-bash.mjs`  | 504   | git: `dev` branch only                    | [07](07-guardrails-and-config.md) |
| `prettify.mjs`    | 71    | prettier on every edited document         | [07](07-guardrails-and-config.md) |
| `guard-files.mjs` | 60    | never write outside the project directory | [07](07-guardrails-and-config.md) |

## `tests/`

[08-tests.md](08-tests.md) lists what each file covers, as of the 2026-07-29
snapshot — **36 files then, 66 now** (counted 2026-07-31 with
`find tests -name '*.test.mjs'`). Structure mirrors `scripts/` one for one, plus
two directories that did not exist at snapshot time: `tests/leads/` (19),
`tests/apply/` (13), `tests/security/` (8, the Phase 1 gate), `tests/documents/`
(7), `tests/profile/` (5), `tests/lib/` (4), `tests/hooks/` (4),
`tests/applications/` (3), `tests/maintenance/` (2), `tests/dev/` (1).

**The test total is not restated here on purpose.** `package.json`'s `testGate`
block holds the floor the gate asserts against — currently 946 full / 147
security — and a number copied into prose goes stale the day someone adds a test.
Read the floor, or run `npm test`.

### `tests/fixtures/` — 15 shared fixtures

| file                        | role                                                                                                                               |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `profile.yaml`              | the fake profile every test uses; real one is gitignored                                                                           |
| `answers.yaml`              | one work-authorization answer                                                                                                      |
| `answers-bank.yaml`         | a fuller bank for the `answer-bank` tests                                                                                          |
| `answers-exact-pick.yaml`   | entries that deliberately collide with a rule firing **before** the fuzzy lookup — that collision is the thing under test          |
| `answers-only-auth.yaml`    | work authorization but **no** sponsorship answer — pins the concept guard                                                          |
| `job.json`                  | a captured posting                                                                                                                 |
| `good-resume.md`            | must pass every resume rule                                                                                                        |
| `good-cover-letter.md`      | must pass cover-letter mode                                                                                                        |
| `bad-missing-annotation.md` | must fail **R1**                                                                                                                   |
| `bad-unknown-fact-id.md`    | must fail **R2**                                                                                                                   |
| `bad-invented-number.md`    | must fail **R3**                                                                                                                   |
| `bad-unknown-tech.md`       | must fail **R6**                                                                                                                   |
| `bad-cover-letter.md`       | must fail cover-letter mode                                                                                                        |
| `empty.md`                  | must fail **R7** (no annotated bullets)                                                                                            |
| `ats-links.md`              | link shapes for `ats-lint` / `atsPostProcess`, including one link whose text **already** shows the bare URL (the idempotence case) |

The `bad-*.md` set is the heart of the guardrail suite: each one exists to prove a
specific rule still fails a dishonest document. If you change `verify-claims.mjs`,
these are what tell you whether you weakened it.
