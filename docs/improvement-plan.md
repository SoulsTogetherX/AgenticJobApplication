# Improvement plan — keyword-aware tailoring, layered screening, wider sources

> **STATUS: implemented 2026-07-29.** Results are in "Outcome" at the bottom.
> Decisions taken before implementation: all four phases; **no DOCX renderer**
> (PDF only, plus `ats-lint.mjs`); board expansion **yield-gated conservative**;
> **L2 rejects** below a hard threshold rather than only cautioning.

Written 2026-07-29 against `dev` (uncommitted body-gate work in the tree).
Every number below was measured on this machine today, not estimated.

**Read `CLAUDE.md` first.** Its hard rules are unchanged and are load-bearing
here — in particular rule 1 (truthfulness), rule 2 (the agent never edits the
fact base) and rule 10 (application limits are user-owned).

---

## 0. Measured baseline

| Thing                                  | Measured                                                       |
| -------------------------------------- | -------------------------------------------------------------- |
| `npm test`                             | **378 pass, 0 fail, 36.7 s**                                   |
| Full board sweep (41 boards, conc. 8)  | **20.6 s**, 8,622 live postings                                |
| Sweep yield                            | **19 reachable leads (0.22%)**; **27 of 41 boards yield zero** |
| Mechanical screen over the whole store | **0.16 s**                                                     |
| Lead store                             | 102 leads — 88 dismissed, 8 applied, 4 new, 2 recommended      |
| Leads with a description               | 92 / 102                                                       |
| Leads with ≥1 indexed keyword          | **72 / 102** (268 `lead_keywords` rows)                        |
| `screens` table                        | 105 `mechanical` rows, **0 `model` rows**                      |
| Applications                           | 12                                                             |

Read that table as one sentence: **the sweep is fast and the screen is free;
what is expensive is everything downstream of a lead that should never have
been stored.** Every proposal below is aimed at that.

---

## 1. Bugs found while researching (fix these first)

### 1.1 The location gate false-rejects US-remote jobs — verified live

`passesLimits` treats a location string as a relocation unless it contains the
word "remote" or a Las Vegas city. A remote-only board that states its location
as `"USA"` — which is how Remotive, Jobicy and RemoteOK all express "US-remote" —
is therefore rejected with:

```
location: "USA" would require relocating away from North Las Vegas, NV
```

Measured: **every one of 35 Remotive, 50 Jobicy and 100 RemoteOK postings was
rejected**, most of them on this. After normalizing US-wide location strings and
letting a source declare itself remote-only, Jobicy went from **0 → 5 kept out of
50 (10%)**, including a _Graduate Software Engineer_ — a better yield than any
board currently swept except Render (8.8%).

This is a false reject, which CLAUDE.md already calls the worst failure mode
here: a job the user never sees.

**Fix:** a `US_WIDE` location pattern (`USA`, `United States`, `Anywhere`,
`North America`, `Remote - US`, `Flexible / Remote`, …) read as remote-eligible,
plus an optional `remote_only: true` on a board definition. The synonym list goes
in `docs/application-limits.yaml` under `location.remote_synonyms` because the
user owns that policy (rule 10).

### 1.2 `recommend.mjs` never reads `lead_keywords`

`scoreLead` re-derives tech from `lead.title + lead.job_text`, and `job_text`
only exists when a job workspace exists. For the 102 stored leads there are
currently **no live workspaces**, so ranking is running on **titles alone** while
268 indexed keyword rows sit unused. `keywordMap(db)` already exists in
`db.mjs` and nothing calls it.

### 1.3 `profile-gaps.mjs` weights leads at 0.5 using titles only

Same root cause — `gatherJobs` pushes `text: l.title` for every lead. The gap
report is blind to 92 stored descriptions.

### 1.4 Two tech lexicons that drift

| Lexicon                          | Where                      | Used by                                      |
| -------------------------------- | -------------------------- | -------------------------------------------- |
| `TECH_TERMS` (flat strings)      | `scripts/lib/lib.mjs`      | `techTermsIn` → **verify-claims R6**         |
| `TECH_LEXICON` (regex + aliases) | `profile/profile-gaps.mjs` | `extractTech` → `lead_keywords`, `recommend` |

They disagree already (`TECH_LEXICON` knows "Svelte", "Kafka", "Observability";
`TECH_TERMS` knows "Cognito", "EventBridge", "Monte Carlo"). Any keyword feature
built on top of this inherits the drift.

---

## 2. Keywords in the resume, and recommending the ones you forgot to record

### 2.1 Unify the lexicon — `scripts/lib/keywords.mjs`

One entry per skill:

```js
{ canonical: "CI/CD",
  aliases:   ["ci/cd", "cicd", "continuous integration", "github actions", "jenkins"],
  ats_forms: ["CI/CD", "continuous integration and delivery", "GitHub Actions"],
  group:     "Practices",
  adjacent:  ["Git", "Testing", "Docker"] }
```

- `ats_forms` is new. Research finding: ATS keyword matching is often literal and
  some systems index the acronym but not the expansion (or vice versa), so a
  resume should carry **both** forms on first use.
- `adjacent` is new. It drives the "you probably have this, want to record it?"
  bucket in §2.2 — deterministically, from a static map, never from a model.
- `lib.mjs` `TECH_TERMS`/`techTermsIn` and `profile-gaps.mjs`
  `TECH_LEXICON`/`extractTech` become thin re-exports. **verify-claims R6 keeps
  its exact current semantics** — this is the truthfulness guardrail and it does
  not move.
- The list grows from ~46 to ~140 terms (Jest, Vitest, Playwright, Prisma, tRPC,
  Redux, Tailwind, Zod, Storybook, Webpack, OpenAPI, JWT, OAuth2, RBAC, SSR/SSG,
  DynamoDB, Firebase, Supabase, Sentry, Jira, Kanban, code review, on-call,
  incident response, accessibility/WCAG, i18n, …).

### 2.2 `scripts/profile/keyword-coverage.mjs` — "don't forget a qualification"

```bash
node scripts/profile/keyword-coverage.mjs [--min-demand 2] [--top 30] [--json]
```

Demand side: `lead_keywords`, already indexed at ingest — a `GROUP BY`, not a
re-parse. Supply side: `profile.yaml` + `answers.yaml`. Three buckets:

| Bucket    | Meaning                                                                  | What it prints                        |
| --------- | ------------------------------------------------------------------------ | ------------------------------------- |
| `covered` | demanded and evidenced → free to use in a resume                         | count only                            |
| `ask`     | demanded, **not** in the profile, but **adjacent** to something you have | a ready-to-run `save-answer.mjs` line |
| `gap`     | demanded, not in the profile, not adjacent                               | genuine learning gap (today's report) |

The `ask` bucket is the feature requested: you have React + Node, so Express,
Jest and REST API are things you very likely _do_ have and simply never wrote
down. It **never writes** — rule 2. It prints the command; you confirm in chat;
`save-answer.mjs --source user` records it. Once recorded, verify-claims R6 lets
the resume use it.

### 2.3 `scripts/documents/keyword-plan.mjs <slug>` — the resume-side half

Runs **before** tailoring; writes `jobs/<slug>/keywords.json`:

| Field          | Contents                                                                                  |
| -------------- | ----------------------------------------------------------------------------------------- |
| `must_use`     | terms in **both** the posting and the profile — free ATS points, truthful by construction |
| `title_mirror` | the posting's exact title, plus the closest profile-truthful phrasing                     |
| `ats_forms`    | acronym **and** expansion for each must-use term                                          |
| `blocked`      | posting terms **not** in the profile, each with the `save-answer` fix line                |
| `placement`    | SUMMARY / SKILLS / a named EXPERIENCE bullet                                              |
| `density_cap`  | max repeats per term                                                                      |

The placement field is not decoration. Research: the summary is the
highest-weighted keyword region and a resume containing the job title performs
dramatically better than one that does not; a dedicated skills block gives the
parser one concentrated keyword region while bullets supply the context the
newer LLM ranking layer reads. `density_cap` exists because keyword stuffing is
now actively detected and penalized.

### 2.4 Rules and skills

- `docs/tailoring-rules.md` gains §9 "Keyword placement": read `keywords.json`,
  place every `must_use` term, mirror the title in SUMMARY when a truthful
  phrasing exists, never exceed `density_cap`, and **never** use a `blocked`
  term (R6 already enforces this; the rule now explains why).
- `tailor-resume/SKILL.md` gains step 4.5 (run `keyword-plan.mjs`) and reports
  the coverage number in the approval message at step 8.

### 2.5 verify-claims R8 — coverage report, non-blocking

Report `must_use` terms that did not make it into the document. **Non-blocking**:
one page is a real constraint and a missing keyword is a trade-off, not a lie.
R1–R7 are unchanged and stay blocking.

---

## 3. Other AI-screening help

### 3.1 DOCX alongside PDF

2026 cross-ATS testing: **DOCX ≈ 97% parse accuracy, text PDF ≈ 76%, designed
PDF ≈ 53%.** Workday in particular mangles headers, footers and anything
multi-column.

`templates/document.css` uses `float: right` for role dates. `atsPostProcess`
already fixes the two known text-layer holes (CSS `::marker` bullets emit no
text; link hrefs live only in annotations) — the float is the remaining hazard.

**Proposal:** `scripts/documents/render-docx.mjs`, same markdown in, single
column, tab stop instead of float, no tables. The apply flow uploads `.docx`
when the form accepts it and PDF otherwise. `render-pdf.mjs` is untouched.

### 3.2 `scripts/documents/ats-lint.mjs` — did the ATS actually see it?

Extracts the PDF/DOCX text layer and asserts: section headers survive, every
bullet is its own line, dates are attached to the right role, contact links
carry visible URLs, and `must_use` coverage. This turns the current
`atsPostProcess` comment block into a regression test instead of a hope.

---

## 4. Layered screening

Four named stages, each separately runnable, each recording **which layer
decided** — so "why did I never see this job?" becomes answerable.

| Stage        | Runs on                   | Cost         | Decides                                                                                   |
| ------------ | ------------------------- | ------------ | ----------------------------------------------------------------------------------------- |
| **L0 title** | board list payload        | free         | title keywords, hard/soft filter, location, freshness, salary (`passesLimits`, unchanged) |
| **L1 body**  | description, L0 survivors | 1 fetch      | hard disqualifiers in the text (`bodyDisqualifiers`, exists, uncommitted)                 |
| **L2 fit**   | description               | free         | **NEW** — can this profile actually do this job?                                          |
| **L3 risk**  | description + history     | free / model | scam, ghost, employer reality                                                             |

### L2 `fit` — new, deterministic

- stack overlap: `lead_keywords` ∩ profile terms, weighted
- stated years vs profile tenure (`extractYearsRequired` already exists)
- **required-vs-preferred split**: parse "Requirements"/"Must have" separately
  from "Nice to have", so a Kubernetes ask in the preferred list is not counted
  as a blocker — today all description text is one blob
- **responsibility-level phrasing**: "mentor the team", "own the roadmap",
  "define the architecture", "set technical direction" — a seniority signal that
  neither the title filter nor the years gate can see
- emits `fit_score` + `pass|caution|reject`

### L3 `risk` — ghost detection gets the signal it was missing

Industry research puts ghost jobs at **18–40%** of listings, and names
**reposting** as the strongest single signal. The pipeline cannot currently see
it: a re-swept posting arrives with a new board id and looks brand new.

- On ingest, key on `company::title`. If it has been seen before (including
  dismissed leads), record `repost_count` and `first_seen_at` **on the new
  lead's doc**. No new table, no schema change.
- New mechanical signals: evergreen phrasing, boilerplate ratio, a description
  reused verbatim across ≥3 of the same company's postings, and the existing
  no-salary + vague-scope + no-team-detail cluster.
- The model half (pipeline-jobs Stage A) is unchanged and stays cached in
  `screens`.

### Storage and CLI

`screens.doc` is a verbatim-JSON column by design, so `stage` and `fit_score` go
**inside `doc`** — no schema change, no repeat of the `healScreens` problem.

```bash
node scripts/leads/screen.mjs --stage l0|l1|l2|l3|all [--explain]
```

---

## 5. Sources

### 5.1 What the auto-apply companies actually do

Jobright scrapes company career pages directly and also ingests LinkedIn/Indeed;
LazyApply and similar drive LinkedIn/Indeed/ZipRecruiter/Glassdoor Easy-Apply.
**This project already does the better half of that** (direct no-auth ATS APIs).
The gap is breadth of boards, not method.

### 5.2 `scripts/leads/find-boards.mjs` — candidate generator

Takes company names and probes candidate slugs against the six public no-auth
ATS APIs (Greenhouse, Lever, Ashby, SmartRecruiters, Workable, Recruitee),
emitting `docs/board-candidates.yaml` for the existing `discover-boards.mjs`,
which already yield-gates and never edits `job-sources.yaml` itself.

Prototyped today: 16 companies probed in **4.2 s**. It found
`greenhouse:vercel(79)`, `greenhouse:figma(177)`, `ashby:notion(115)` — and
**zero** public boards for Konami Gaming, Everi, Zappos, Switch, Scientific
Games, PlayAGS, Sightline Payments, Southwest Gas or NV Energy. Those local
employers are on Workday / iCIMS / Taleo / Phenom with non-guessable hosts, so
slug probing cannot reach them; they need per-company research or an aggregator.

Inputs: `docs/candidates/fortune500.yaml`, `docs/candidates/yc.yaml` (built from
`yc-oss.github.io/api/companies/*.json` — 6,093 companies, refreshed daily),
`docs/candidates/local-lv.yaml`.

### 5.3 Honest expectation for Fortune 500

Today: 41 boards → 8,622 postings → **19 reachable**. Fortune 500 boards are
overwhelmingly Workday/Taleo/iCIMS and skew senior. Expect a low hit rate.
That is exactly why every candidate goes through `discover-boards.mjs` first:
it reports each board's live/reachable counts and whether it **ever posts below
Senior**, which is the single best predictor of reachability at 2.5 years. The
yield gate decides, with numbers, and nothing lands in the sweep list without
your approval via `manage-sources`.

### 5.4 workatastartup.com / Y Combinator

`workatastartup.com/jobs` is a login-walled Inertia app: the HTML carries no job
payload, `?x-inertia` returns 409, and `/companies/fetch` returns rendered
fragments with no job links. Scraping it means defeating a login wall.

The workable route is the public YC company directory
(`yc-oss.github.io/api`, no auth, 6,093 companies) → `find-boards.mjs` → most YC
companies turn out to be on Greenhouse/Lever/Ashby, which the sweep already
speaks. Same coverage, no login wall.

### 5.5 Aggregators — measured, not guessed

| Source     | Descriptions in list? | Measured after the §1.1 fix                                                                      | Verdict               |
| ---------- | --------------------- | ------------------------------------------------------------------------------------------------ | --------------------- |
| **Jobicy** | yes, ~6 k chars       | **5 kept / 50 (10%)**, incl. a Graduate SWE                                                      | **add**               |
| Remotive   | yes, ~2.8 k chars     | 0 / 35 — category is unreliable, page capped at 35                                               | offer, off by default |
| RemoteOK   | thin, ~500 chars      | 0 / 100                                                                                          | offer, off by default |
| The Muse   | yes, ~10 k chars      | **0 / 200** — "entry level SWE" is SpaceX production technicians; 93% stale; no remote locations | **do not add**        |
| Arbeitnow  | yes                   | German/EU corpus                                                                                 | do not add            |

Their own category taxonomies are unusable (The Muse filed "Geotechnical Lead"
and "Car Wash Attendant Lead" under Software Engineering; Remotive filed
"Patient Care Specialist" under software-dev). The existing title gate already
catches that — which is the argument for doing §4 and §5 together: **adding
volume and hardening description-based screening are the same project.**

---

## 6. Efficiency

1. **Wire `recommend.mjs` and `profile-gaps.mjs` to `lead_keywords`** (§1.2, §1.3).
   Correctness fix first, speed second: removes a full regex pass over every
   stored description on every call.
2. **Sweep concurrency.** 41 boards / conc. 8 = 20.6 s. Wall-clock is bounded by
   the slowest board once the pool is full, so ~20 more boards at concurrency 12
   should cost roughly the same. Measure and report the number, don't assume it.
3. **`node scripts/leads/gate-audit.mjs`** — re-runs every gate over the whole
   live store and diffs the reject list against the previous run. CLAUDE.md
   already warns that widening a gate can silently grow the reject list; this
   makes that check a command instead of a discipline. Required after every gate
   change in this plan.
4. **`screens` has 0 model rows.** The expensive cache has never actually been
   exercised end to end. Verify the Stage A record path works before building
   more on top of it.

---

## 7. Sequencing

| Phase | Contents                                                                                       | Why here                                     |
| ----- | ---------------------------------------------------------------------------------------------- | -------------------------------------------- |
| **A** | US-remote location fix, unified lexicon, keyword wiring for recommend/profile-gaps, gate-audit | bug fixes + the foundation everything reads  |
| **B** | L2 fit, L3 risk + repost detection, stage recording, `screen.mjs --stage`                      | must land before the sweep widens            |
| **C** | keyword-coverage, keyword-plan, tailoring rules §9, R8, ats-lint, DOCX                         | the resume half                              |
| **D** | find-boards, candidate files, run discover-boards, jobicy source, report yields                | last, so new volume meets hardened screening |

## 8. Verification

- `npm test` — **378 is the floor.** Every new script gets success **and**
  failure/boundary tests.
- Regression tests specifically for: `"USA"` passing the location gate while
  `"London, UK"` still fails; the keyword `ask`/`gap` split; `blocked` terms
  staying out of a rendered resume; DOCX single-column extraction; gate-audit
  diffing.
- After every gate change: `gate-audit.mjs` over the live store, and report the
  reject-list delta.
- Report wall-clock and lead counts as numbers, before and after.

---

## Outcome (measured 2026-07-29, after implementation)

| Metric                          | Before | After  | Note                                          |
| ------------------------------- | ------ | ------ | --------------------------------------------- |
| `npm test`                      | 378    | 554    | 0 failures                                    |
| Boards swept                    | 41     | 44     | +Confluent, +Wynn Resorts, +Jobicy            |
| Live postings seen              | 8,622  | 8,841  |                                               |
| **Reachable leads per sweep**   | **19** | **27** | +42%                                          |
| Sweep wall-clock                | 20.6 s | 20.2 s | unchanged — pool-bound, not board-count-bound |
| Leads with a usable tech signal | 21/102 | 74/102 | `lead_keywords` finally read by ranking       |
| Terms claimable in a resume     | 42     | 37     | 5 were never true — see below                 |
| Full gate audit over the store  | —      | 65 ms  |                                               |

**Three defects found and fixed that were not in the original plan:**

1. **verify-claims R6 accepted claims the user cannot make.** Its corpus was the
   raw bytes of `answers.yaml`, which stores each application-form QUESTION
   beside its answer. Form question a-030 enumerates "4 = Spring / Spring Boot;
   5 = Cloud Technologies (AWS, Azure, or GCP)" — so **Azure, Spring, Java and
   GCP all passed R6**, and a tailored resume could have claimed Spring Boot
   experience the user explicitly did _not_ select. Fixed centrally with
   `evidenceText()`. This was a live violation of hard rule 1.
2. **`dedupeLeads` destroyed the ghost-job evidence.** A re-posted job arrives
   with a new board id, matched an existing lead on company+title, and was
   dropped — so the store held zero repeated company+title pairs _by
   construction_ and repost detection had nothing to read.
3. **The lexicon had two pre-existing false positives**, inherited from the old
   `TECH_LEXICON`: "do not go off the **rails**" → Ruby, and "deliver **express**
   service to every guest" → Express.

**The honest finding on adding companies.** 223 candidate boards were probed and
yield-gated: 114 Fortune 500 names, 34 local Las Vegas employers, 622 YC
companies (183 of which resolved to a board). Those 217 reachable boards carried
**11,833 live postings and produced 3 boards with any reachable role** — two of
which clear the conservative bar and were added.

The breakdown says why, and it is not a coverage problem:

| Postings rejected because…    | Count  |
| ----------------------------- | ------ |
| title is above this level     | 7,060  |
| location requires relocating  | 4,260  |
| title is the wrong discipline | 465    |
| **qualifying**                | **16** |

**So sweeping more companies is close to exhausted as a strategy.** 60% of the
market at this level is filtered on seniority alone. The levers that remain are
(a) local employers, where on-site is in scope — but they sit on Workday/iCIMS/
Taleo behind opaque tenant hosts that slug-probing cannot reach, so each needs
its careers URL read once by hand (`docs/candidates/local-lv.yaml` is that
list), and (b) recording more qualifications, which is what
`keyword-coverage.mjs` now surfaces — it currently has three waiting
(Microservices, Linux, REST APIs).

## Sources

- [ATS Resume Keywords Guide: What Actually Works in 2026](https://www.uppl.ai/ats-resume-keywords)
- [AI Resume Screening in 2026: How It Works & How to Pass](https://atsverification.com/blog/ai-resume-screening-2026/)
- [How to Write an ATS Resume That Gets Past the Bots in 2026 — Jobscan](https://www.jobscan.co/blog/ats-resume/)
- [PDF vs DOCX Resume: Why PDF Fails ATS Parsing (2026 Data)](https://resumeoptimizerpro.com/blog/why-not-to-use-pdf)
- [Resume Scanner PDF vs DOCX (ATS parsing rules)](https://www.jobshinobi.com/blog/resume-scanner-pdf-vs-docx-which-is-better)
- [Ghost Jobs Explained: Why 1 in 3 Job Listings Are Fake in 2026](https://jobstrack.io/blog/ghost-jobs-2026)
- [Ghost Jobs in 2026: Statistics and How to Spot Them](https://mintcareer.ai/ghost-jobs-guide)
- [6 ATS Platforms with Public Job Posting APIs](https://fantastic.jobs/article/ats-with-api)
- [Comparing the job-posting APIs of Workday, Greenhouse, Lever, Ashby, SmartRecruiters, Recruitee (2026)](https://bebee.com/us/jobs/comparing-the-job-posting-apis-of-workday-greenhouse-lever-ashby-smartrecruiters-and-recruitee-2026---techmap_us_4440015861)
- [Greenhouse Job Board API](https://developers.greenhouse.io/job-board.html)
- [2025's Best Auto-Apply Tools for Tech Job Seekers — Jobright](https://jobright.ai/blog/2025s-best-auto-apply-tools-for-tech-job-seekers/)
- [JobWizard vs LazyApply vs Simplify vs Massive](https://jobwizard.ai/blog/jobwizard-vs-lazyapply-vs-simplify-vs-massive-complete-job-application-tool-comparison)
- [yc-oss/api — public API for YC-funded companies](https://github.com/yc-oss/api)
- [CareerBERT: Matching Resumes to ESCO Jobs in a Shared Embedding Space](https://arxiv.org/pdf/2503.02056)
