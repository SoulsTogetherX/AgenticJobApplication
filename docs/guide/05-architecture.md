# How the whole system fits together

The four documents before this one explained the ideas: what the project is for,
how a computer runs a program, what the code is made of, and where the AI sits.
This one is the assembly drawing. It shows every moving part in one picture,
walks each of the four pipelines call by call with the real file names, says who
is allowed to write each piece of stored information, explains how several things
can run at once without corrupting each other, and finally follows a single job
from "a board listed it" to "the application is on file."

The goal is that after reading this you could redraw the diagram from memory and
explain, for any arrow in it, which file does that work and why it is a separate
file at all. That is the level of understanding you need to rebuild this.

**What you will learn**

- **The whole pipeline in one diagram**, with every arrow labelled by the script
  that performs it — so you can point at any step and know what to open.
- **The four pipelines**, walked call by call: discovery/screening,
  tailoring/verification, the attended apply, and the unattended runner. For each
  one: what starts it, what it reads, what it writes, and every place it can
  legitimately stop.
- **The repository, folder by folder** — what belongs in each directory and, more
  usefully, what must never go in it.
- **Who owns what state.** A table of every piece of stored information in the
  system, which component may write it, and which may only read it — including
  why `jobs/leads.db` is the store of record and `profile/applications.yaml` is a
  generated export that you must never hand-edit.
- **The concurrency model**: the board sweep's worker pool, the origin-keyed
  browser pool, per-job subagents, and the three things that keep shared state
  intact — a file lock, a database claim, and the reason a claim returning `0` is
  the normal case rather than an error.
- **One job end to end**, as a numbered narrative using a real slug from this
  repository, so the abstractions land on something concrete.

Throughout, anything that is broken or unwired today is marked
`> **Known defect (2026-08-05 audit).**` — those come from the full audit in
[`../audit-2026-08-05.md`](../audit-2026-08-05.md), and they are here because an
architecture document that only describes the intended shape teaches you the
wrong thing.

---

## 1. The whole system in one picture

### 1.1 Six words you need before the diagram

The diagram uses six pieces of this project's vocabulary. Each gets a full
treatment later; here is enough to read the picture.

- **Lead** — one job posting that the system has heard about and stored. Not an
  application, not a commitment; just a row saying "this posting exists, here is
  what we know about it."
- **Slug** — a short, filesystem-safe name for one job, made of lowercase letters
  and hyphens: `render-postgres-product-engineer`. Filenames cannot contain
  spaces or slashes safely, so every job gets a slug and the slug is how every
  part of the system refers to that job.
- **Workspace** — the directory `jobs/<slug>/`, which holds everything produced
  for one specific job: the captured posting, the tailored résumé, the rendered
  PDF, the form scan, the fill plan.
- **Fact base** — `profile/profile.yaml` and `profile/answers.yaml` together.
  Everything true about you that the system is allowed to state. Nothing else
  counts as a fact, and no program in `src/` may write to it.
- **Defer** — to decline one specific thing and say why. Not an error. It is the
  designed outcome whenever the system meets something it does not
  deterministically understand.
- **Store of record** — for any piece of information, the one copy that is
  authoritative. Everything else is a copy, a cache, or an export, and if a copy
  disagrees with the store of record, the copy is wrong.

### 1.2 The diagram

Read it top to bottom. Boxes are stages; the text on an arrow is the file that
performs that step. `▓` marks a place the flow can stop.

```
        YOU OWN THESE. Scripts read them; nothing in src/ writes them.
   ┌──────────────────────────────────────────────────────────────────────┐
   │  docs/job-sources.yaml         44 company boards to sweep            │
   │  docs/application-limits.yaml  the rules a job must pass, + caps     │
   │  profile/profile.yaml          your facts, cited by id               │
   │  profile/answers.yaml          your banked form answers              │
   └──────────────────────────────────────────────────────────────────────┘
                │                │                          │
                │ loadSources()  │ loadLimits()             │ createResolver()
                ▼                ▼                          ▼

╔═════════ PIPELINE 1 — DISCOVERY AND SCREENING ══════════════════════════╗
║                                                                         ║
║  SOURCES                                                                ║
║  ┌─────────────────┐                                                    ║
║  │ 44 ATS boards   │──┐                                                 ║
║  │ greenhouse ×24  │  │  fetchBoard(), pooled 8 at a time               ║
║  │ ashby ×8        │  │  src/leads/find-jobs.mjs                    ║
║  │ workday ×3 …    │  │                                                 ║
║  ├─────────────────┤  │                                                 ║
║  │ Hacker News     │──┤  fetchHackerNews()   find-jobs.mjs              ║
║  │ "Who is hiring" │  │                                                 ║
║  ├─────────────────┤  │                                                 ║
║  │ Adzuna API      │──┘  fetchAdzuna()       find-jobs.mjs              ║
║  └─────────────────┘                                                    ║
║           │                                                             ║
║           │  dedupeLeads()          find-jobs.mjs                       ║
║           ▼                                                             ║
║  ┌──────────────────────────────────────────────┐                       ║
║  │ L0  title / location / date / salary         │─▓ rejected, dropped   ║
║  │     passesLimits()      find-jobs.mjs        │                       ║
║  └──────────────────┬───────────────────────────┘                       ║
║                     │  enrichDescriptions()     src/leads/enrich.mjs║
║                     │  sanitizeHtmlSnippet()    src/lib/untrusted.mjs
║                     │  canonicalizeLeads()      src/leads/canonical.mjs
║                     ▼                                                   ║
║  ┌──────────────────────────────────────────────┐                       ║
║  │ L1  hard disqualifiers in the body           │─▓ rejected, dropped   ║
║  │     bodyDisqualifiers()  find-jobs.mjs       │                       ║
║  └──────────────────┬───────────────────────────┘                       ║
║                     │  withLock(LEADS_LOCK) → saveLeads()               ║
║                     │  find-jobs.mjs / src/lib/lock.mjs             ║
║                     ▼                                                   ║
║           ┌───────────────────────┐  indexKeywords()  find-jobs.mjs     ║
║           │  leads table          │◄──────────────────────────────      ║
║           │  lead_keywords table  │                                     ║
║           │  in jobs/leads.db     │                                     ║
║           └───────────┬───────────┘                                     ║
║                       │  evaluateStages()   src/leads/stages.mjs    ║
║                       ▼        ├─ L2 scoreFit()   src/leads/fit.mjs ║
║           ┌───────────────────┐└─ L3 scoreRisk()  src/leads/risk.mjs║
║           │  screen.mjs       │──▓ verdict "reject" — lead stays but is ║
║           │  writes `screens` │    marked, never tailored               ║
║           └─────────┬─────────┘                                         ║
║                     │  rankLeads()        src/leads/recommend.mjs   ║
║                     ▼                                                   ║
║           ┌───────────────────────────────────┐                         ║
║           │  a ranked shortlist               │                         ║
║           │  prep-queue.mjs picks what to     │                         ║
║           │  tailor ahead of time             │                         ║
║           └─────────────────┬─────────────────┘                         ║
╚═════════════════════════════│═══════════════════════════════════════════╝
                              │
                              │  new-job.mjs --from-lead <url>
                              ▼
╔═════════ PIPELINE 2 — TAILORING AND VERIFICATION ═══════════════════════╗
║                                                                         ║
║   ┌───────────────────────────────────────────────────┐                 ║
║   │  jobs/<slug>/  THE WORKSPACE                      │                 ║
║   │    job.json      the posting, sanitised           │                 ║
║   │    context.json  shared state for both skills     │                 ║
║   └───────────────────────┬───────────────────────────┘                 ║
║                           │ keyword-plan.mjs → keywords.json            ║
║                           ▼                                             ║
║   ┌───────────────────────────────────────────────────┐                 ║
║   │  DRAFT resume.md (+ cover-letter.md)              │                 ║
║   │  either  assemble-resume.mjs   (no model at all)  │                 ║
║   │  or      the tailor-resume skill (a model drafts) │                 ║
║   │  every bullet carries  <!-- fact:ID -->           │                 ║
║   └───────────────────────┬───────────────────────────┘                 ║
║                           │ verify-claims.mjs  R1–R7                    ║
║                           ▼                                             ║
║   ┌───────────────────────────────────────────────────┐                 ║
║   │  VERIFY                                           │─▓ exit 1: a     ║
║   │  writes a row in `verifications` keyed by         │   claim the     ║
║   │  (slug, mode, doc_sha256) + profile_sha256        │   facts cannot  ║
║   └───────────────────────┬───────────────────────────┘   back          ║
║                           │ YOU approve (hard rule 5)                   ║
║                           ▼                                             ║
║   ┌───────────────────────────────────────────────────┐                 ║
║   │  render-pdf.mjs → resume.pdf, cover-letter.pdf    │                 ║
║   │  shells out to local Edge/Chrome                  │                 ║
║   └───────────────────────┬───────────────────────────┘                 ║
╚═══════════════════════════│═════════════════════════════════════════════╝
                            │
        ┌───────────────────┴────────────────────┐
        ▼                                        ▼
╔══ PIPELINE 3 — ATTENDED APPLY ═══╗   ╔══ PIPELINE 4 — UNATTENDED RUNNER ══╗
║  you give the agent a URL        ║   ║  a scheduler runs cycle.mjs        ║
║                                  ║   ║                                    ║
║  scan.driver.mjs  (via Playwright║   ║  auto-apply.mjs                    ║
║  MCP browser_run_code_unsafe)    ║   ║   │ preflight()  preflight.mjs ──▓ ║
║   │ installs scan-page.js        ║   ║   │ selectEligible()               ║
║   ▼                              ║   ║   ▼                                ║
║  scan-p<N>.json                  ║   ║  runPool()  pool.mjs               ║
║   │ fill-plan.mjs                ║   ║   │ ≤ N workers, 1 per origin      ║
║   │  ├ resolveFields()           ║   ║   ▼                                ║
║   │  │   answer-bank.mjs         ║   ║  runJob()  job.mjs — per slug      ║
║   │  ├ applyCache()              ║   ║   │ claimAutoJob()  ──▓ 0 = taken  ║
║   │  │   field-cache.mjs         ║   ║   │ trustBoard()  trust.mjs ──▓    ║
║   │  └ buildPlan()               ║   ║   │ walkPages()   multipage.mjs    ║
║   ▼                              ║   ║   │   ├ scan  scan-engine.mjs      ║
║  fill-plan.js + fill-plan.json   ║   ║   │   ├ plan  fill-plan.mjs  ──▓   ║
║   │ page.evaluate + eval         ║   ║   │   ├ fill  fill-engine.mjs      ║
║   ▼                              ║   ║   │   └ next  advance.mjs          ║
║  fill-engine.mjs runs IN the page║   ║   │ authorizeSubmit() authorize ──▓║
║   │ returns report.uploads,      ║   ║   │ setAutoJobState('attempted')   ║
║   │ verify.mismatch, defer[]     ║   ║   ▼                                ║
║   ▼                              ║   ║  submitOnce()  submit.mjs          ║
║  THE AGENT reads the report,     ║   ║   │ 11 preconditions ─────────▓    ║
║  names every actuated control,   ║   ║   │ THE CLICK                      ║
║  then browser_click submit       ║   ║   ▼                                ║
║   │                              ║   ║  classify()  classify.mjs          ║
║   ▼                              ║   ║   │ unclassified ────────────▓     ║
║  capture-post-submit.mjs stage   ║   ║   ▼                                ║
╚═══════════════│══════════════════╝   ╚═══════════════│════════════════════╝
                │                                      │
                │ log-application.mjs                  │ audit.mjs
                │ (only after YOU confirm)             │ recordSubmission()
                ▼                                      ▼
   ┌────────────────────────────┐        ┌──────────────────────────────┐
   │ applications table         │        │ auto_submissions  (the claim)│
   │  in jobs/leads.db          │        │ auto_runs                    │
   │        │                   │        │ jobs/.auto/runs/*.jsonl      │
   │        │ exportApplications│        │  (the copy that survives)    │
   │        ▼      Yaml()       │        └──────────────────────────────┘
   │ profile/applications.yaml  │
   │  GENERATED — never edit    │
   └────────────┬───────────────┘
                │ dueFollowUps()  follow-ups.mjs
                │ alreadyApplied() check-applied.mjs
                │ buildAutoStatus() digest.mjs → src/status.mjs
                ▼
        what to chase, what not to re-apply to, is the machine working
```

### 1.3 How to read that

Four things are worth noticing straight away, because they are the shape of the
whole design rather than details of it.

**The user's files sit at the top and nothing writes back to them.** Every arrow
out of that top box points down. There is no arrow back up. That is enforced by
hooks, not by convention — see §4.3.

**Every stage can stop.** The `▓` marks are not error paths bolted on afterwards;
they are the point. A pipeline that can only succeed is a pipeline that will
eventually succeed at doing the wrong thing. Counting them: discovery has two
(L0, L1) plus a screening verdict, tailoring has one (verification), the attended
apply has one per deferred field, and the unattended runner has eight or so, of
which any single one ends the application.

**The two apply pipelines share almost all their machinery.** `scan-engine.mjs`,
`fill-plan.mjs`, `answer-bank.mjs`, `fill-engine.mjs` and `field-cache.mjs` are
the same files in both columns. What differs is who decides to click and what
gates stand in front of that decision. That is deliberate: the deterministic
parts should behave identically whether or not you are watching, because a bug
that only appears when nobody is looking is the worst kind.

**The record has two halves that never merge.** An application recorded because
you said you submitted it goes in the `applications` table. An application the
unattended runner aimed at an employer goes in `auto_submissions`. They answer
different questions — "what have I applied to?" versus "what did the machine try
to send?" — and merging them would let a machine attempt become a human-confirmed
application, which is exactly the provenance failure hard rule 2 exists to
prevent.

---

## 2. The four pipelines, call by call

### 2.1 Pipeline 1 — Discovery and screening

**What triggers it.** One of three things: you say something like "find me jobs"
(the `find-jobs` skill runs the command), you run it yourself, or
`src/auto/cycle.mjs` runs it as step 1 of a scheduled cycle.

```bash
node src/leads/find-jobs.mjs search --source all --query "full stack"
```

**What it reads.** `docs/job-sources.yaml` (the 44 boards),
`docs/application-limits.yaml` (your rules), `.env` (Adzuna credentials, if you
have them), and the existing lead store so it can tell a new posting from one it
has already seen.

**What it writes.** The `leads` and `lead_keywords` tables in `jobs/leads.db`,
plus one `board_stats` row per board swept.

#### The walk

**1. `cmdSearch()` in `src/leads/find-jobs.mjs`** parses the flags and
resolves the search query in a fixed order: an explicit `--query` wins, then
`roles.search_query` from your limits file, then the built-in
`DEFAULT_SEARCH_QUERY` of `"full stack"`.

**2. `loadSources()`** reads `docs/job-sources.yaml` and returns 44 board
descriptors. A descriptor is a small object like
`{ type: "greenhouse", slug: "anthropic", company: "Anthropic" }`. The `type`
selects which fetcher runs.

**3. `mapPool(boards, 8, fetchBoard)`** — the sweep's worker pool, from
`src/lib/lib.mjs`. Eight boards are in flight at once. `fetchBoard()`
dispatches on `board.type` to one of a dozen functions: `fetchGreenhouse()`,
`fetchLever()`, `fetchAshby()`, `fetchSmartRecruiters()`, `fetchWorkable()`,
`fetchRecruitee()`, `fetchWorkday()`, `fetchOracleCloud()`, `fetchJobvite()`,
`fetchSuccessFactors()`, `fetchJobicy()`, `fetchRemotive()`, `fetchRemoteOk()`.
Each one knows the shape of that vendor's public JSON API. Every fetch is bounded
by `FETCH_TIMEOUT_MS = 15000`, because a board that accepts the connection and
never answers used to hold one of the eight workers until the operating system
gave up on the TCP connection — minutes, for one dead board.

A board that throws is caught **per board**: the failure becomes a line in a
`failures` array and the other 43 boards still return. One broken board never
costs you a sweep.

**4. `fetchHackerNews()` and `fetchAdzuna()`** run after the pool, one after the
other.

> **Known defect (2026-08-05 audit).** Those two run serially after the pooled
> board sweep rather than inside the pool, so their round trips are added to the
> wall clock instead of overlapping with the boards'. Paged boards also fetch
> their pages one after another.

**5. `ingest(candidates, limits)`** is where screening starts.

- `dedupeLeads(candidates, store.leads, applied)` removes postings already in the
  store and already applied to. It also detects **repost sightings** — the same
  posting appearing again — and returns them separately.
- **L0: `passesLimits(job, limits, now)`** for each candidate. This is the cheap
  gate and it sees only what the board's list endpoint gave us: title, location,
  posted date, sometimes salary. It answers "is this in scope at all?" A rejection
  here discards the candidate. Most candidates die here, which is the design:
  everything after it is more expensive.
- `enrichDescriptions(survivors)` — for the four board types whose list payload
  carries no description, `src/leads/enrich.mjs` fetches the per-posting
  detail endpoint, pooled again.
- The fetched HTML goes through `sanitizeHtmlSnippet()` in
  `src/lib/untrusted.mjs` before it is stored. **This is the rule-0
  boundary**: the point where third-party text stops being markup and starts
  being a string this project is willing to keep. What it removes and what it
  merely flags is the subject of
  [`./07-safety-model.md`](./07-safety-model.md).
- `canonicalizeLeads(survivors, { network: false })` stamps each lead's
  `apply_url` — the ATS-hosted address the trust gate will later need — using
  only what the board API already told us. The network tier exists behind
  `canonical.mjs --network` and is deliberately off here: it was measured at 0
  useful resolutions out of 21 on the two aggregators this store actually uses,
  so paying an HTTP request per lead on every sweep would buy a measured nothing.
- **L1: `bodyDisqualifiers(s, limits)`** now that there is a body to read.
  Required relocation, a security clearance, senior-only language. A rejection
  here discards the lead.

**6. The locked commit.** Everything above is planning; nothing has been written.
Then:

```js
const { committed, backfilled } = withLock(lockPath, (handle) => {
  const fresh = loadLeads(leadsFile) // re-read INSIDE the lock
  …
  if (!handle.stillHeld()) throw new Error("LEADS_LOCK was broken while ingest held it …")
  saveLeads(fresh, leadsFile)
  return { committed: freshKept, backfilled: backfilledNow }
})
```

The re-read inside the lock is the whole point and §5.5 explains why. There is no
network access below this line — a lock held across a slow HTTP request is a lock
held for minutes.

**7. `indexKeywords(committed)`** extracts technology terms from each newly
committed lead's title and description and writes them to `lead_keywords`. Doing
it once at ingest rather than re-parsing descriptions on every later analysis is
what makes "what do the jobs I get rejected from keep asking for?" a `GROUP BY`
instead of a text scan.

**8. `recordSweep(results, limits, now)`** appends one row per board to
`board_stats`, so pruning an unproductive board can be driven by history rather
than by one bad day.

> **Partly closed (P6, 2026-08-17).** `board_stats` now has a reader —
> `board-yield.mjs --history` — and two additive counters (`sweeps`,
> `zero_streak`) so a dry spell is countable rather than inferred. Still open:
> `recordSweep` ignores the `--leads` flag and writes to the real database even
> when a test points the store elsewhere, and `leads_produced` accumulates
> pre-dedupe counts so it is not a lead count.

#### Then screening proper

L0 and L1 ran during ingest. **L2 and L3 run later**, in `src/leads/screen.mjs`:

```bash
node src/leads/screen.mjs --status new
```

`main()` builds a **stage context** once — your years of experience from
`profile.yaml`, the technology terms in your profile, the keyword index, and a
history of every lead ever stored (dismissed ones included, because a lead
dismissed three weeks ago is the evidence that today's identical posting is a
repost). Then for each lead it calls two things:

- `screenJob(job, limits, now, profileYears)` — the pattern screen: scam signals,
  culture signals, years-required extraction.
- `evaluateStages(job, ctx, stages)` from `src/leads/stages.mjs` — the ordered
  funnel. `stages.mjs` holds a `REGISTRY` mapping each stage id to a function:
  `l0` → `passesLimits`, `l1` → `bodyDisqualifiers`, `l2` → `scoreFit`
  (`src/leads/fit.mjs`), `l3` → `scoreRisk` (`src/leads/risk.mjs`). It
  runs them in order and stops at the first rejection.

The registration lives in `stages.mjs` rather than in each check's own file for a
concrete reason stated in its comment: if `fit.mjs` registered itself, it would
have to import `stages.mjs`, which imports `fit.mjs` — a **circular import**, two
files each waiting for the other. Keeping the checks as pure functions and the
order in one place breaks the cycle.

The verdicts are stored in the `screens` table, keyed `(lead_id, source)` where
source is `'mechanical'` or `'model'`. The two are kept apart on purpose: a cheap
regex verdict must never satisfy a caller that asked for the expensive
model-reviewed one.

**Where it can stop:** L0 rejection (dropped), L1 rejection (dropped), an L3
rejection (the lead survives but is marked and the unattended runner refuses it),
or the whole sweep failing because no lead store exists yet (`exit 2`).

**Then ranking.** `src/leads/recommend.mjs`'s `rankLeads()` scores each lead:
technology overlap with your profile, role-title fit from
`roles.title_rank`, freshness, a salary signal, minus risk flags. It is a
**weighted linear model** — multiply each signal by a weight, add them up — which
is the simplest thing that can rank, has no training data, and can be explained
line by line. `isFlatRanking()` exists as an honesty guard: if every returned lead
ties, the "ranking" fell through to alphabetical-by-company and is not a ranking
however it is labelled.

`src/leads/prep-queue.mjs` then picks which of the ranked leads are worth
tailoring **before** you sit down, so tailoring is not on the critical path with
you watching.

> **Known defect (2026-08-05 audit).** `prep-queue.mjs` ranks on titles alone,
> ignoring the keyword index and `title_rank`; and `rankLeads` ignores eleven of
> the fifteen risk flags the pipeline computes.

### 2.2 Pipeline 2 — Tailoring and verification

**What triggers it.** The `tailor-resume` or `tailor-cover-letter` skill, the
`pipeline-jobs` skill fanning out one `job-worker` subagent per job, or step 4 of
`src/auto/cycle.mjs`.

**What it reads.** The lead store (for the posting), `profile/profile.yaml` and
`profile/answers.yaml` (the only permitted source of facts), and
`docs/tailoring-rules.md`.

**What it writes.** Files inside `jobs/<slug>/`, and one row per verification in
the `verifications` table.

#### The walk

**1. `node src/documents/new-job.mjs <slug> --from-lead "<url>"`** creates the
workspace. It matches on lead id, then URL, then URL with tracking parameters and
trailing slashes stripped. It writes exactly two files:

- `job.json` — `{ slug, company, title, source_url, location, captured_at,
description, untrusted_findings?, requirements: [], questions: [] }`
- `context.json` — the shared state both tailoring skills read and write, so the
  résumé and the cover letter cannot drift apart.

The two description paths have different trust stories, and the header comment
spells them out. `--from-lead` takes text the sweep already sanitised, and
re-sanitising it would double-count the findings; so it copies forward
`untrusted_findings` instead — a list of `{kind, count, fingerprint, shape}`
records that carry **no payload**. `--description` takes raw text a model just
read off a live page, which nothing has inspected yet, so that path runs
`sanitizeHtmlSnippet()` before writing.

Exit codes: `0` ok, `1` workspace exists, `2` usage, `4` `--from-lead` matched no
lead (the caller falls back to reading the page).

> **Known defect (2026-08-05 audit).** `--from-lead` drops the salary range,
> posting age and remote flag the sweep already captured; and a flag value placed
> before the slug is taken as the slug.

**2. `node src/documents/keyword-plan.mjs <slug>`** writes `keywords.json`.
Its job is to give the drafting step a truthful target for both gatekeepers that
read a résumé: the classic ATS parser doing literal keyword matching, and the LLM
layer that summarises whatever survives. The critical property is stated in its
header: `must_use` is the **intersection** of the posting's terms and the fact
base, so every term in it is already true of you and placing it invents nothing.
`blocked` is the posting's other terms, listed precisely so they stay out.

**3. The draft.** Two routes exist.

- **`node src/documents/assemble-resume.mjs <slug>`** — deterministic, no
  model at all. It emits each selected fact's text **verbatim, byte for byte**,
  with its `<!-- fact:ID -->` annotation. Verbatim emission cannot invent a skill,
  an employer, a date or a metric, so the verification rules hold by construction
  rather than by inspection. This is what makes the whole unattended cycle
  possible: a tailoring step that needed a model could not be scheduled.
- **The `tailor-resume` skill** — a model drafts, reorders and rephrases, still
  citing `<!-- fact:ID -->` on every bullet.

> **Known defect (2026-08-05 audit).** The attended skill drafts the résumé by
> hand and never calls `assemble-resume.mjs`, so the deterministic assembler is
> unused on the path a human actually takes.

**4. `node src/documents/verify-claims.mjs <slug>`** is the gate. It is an
ordinary program, not a prompt, and it runs seven rules:

| Rule | What it requires                                                                |
| ---- | ------------------------------------------------------------------------------- |
| R1   | every bullet line carries `<!-- fact:ID[,ID2] -->`                              |
| R2   | every cited fact id exists in the profile or answer bank                        |
| R3   | every number in an annotated bullet appears in one of that bullet's cited facts |
| R4   | every number outside bullets appears somewhere in the fact corpus               |
| R5   | every `Mon YYYY` date token appears in the corpus                               |
| R6   | every known technology term in the document appears in the corpus               |
| R7   | the document contains at least one annotated bullet                             |

Cover-letter mode runs R4–R6 only, and its corpus additionally includes the job
posting — with the deliberate exception that technology terms appearing **only**
in the posting still fail R6. That is the anti-mirroring rule: a posting asking
for Kubernetes must not become a résumé claiming Kubernetes.

On success it writes a row into `verifications` keyed
`(slug, mode, doc_sha256)` and carrying `profile_sha256`. Both hashes matter:
`doc_sha256` pins the exact bytes checked, so editing the résumé invalidates its
own verification; `profile_sha256` pins the fact base they were checked against,
so you editing `profile.yaml` invalidates every outstanding verification at once.
A résumé verified against yesterday's facts is not verified today.

It exits `1` on any violation. Hard rule 4 says nothing may be rendered or shown
as final until this passes.

**5. Your approval** (hard rule 5) — the agent shows what it emphasised, dropped
and rephrased versus the general résumé.

**6. `node src/documents/render-pdf.mjs jobs/<slug>/resume.md jobs/<slug>/resume.pdf`**
converts markdown to PDF by shelling out to your locally installed Edge or
Chrome. `PDF_BROWSER` overrides discovery; exit `3` means no browser was found.
It leaves a `.render.html` intermediate behind, which `prune-jobs.mjs` always
deletes.

**Where it can stop:** no matching lead (`new-job.mjs` exit 4), a verification
violation (`verify-claims.mjs` exit 1), you declining the draft, or no browser for
rendering (`render-pdf.mjs` exit 3).

### 2.3 Pipeline 3 — The attended apply

**What triggers it.** You give the agent a posting URL. The `apply-job` skill
(`.claude/skills/apply-job/SKILL.md`) is the program the model follows.

**What it reads.** The lead store, the fact base, the workspace, the rendered
PDFs, and the live page through the Playwright MCP browser tools.

**What it writes.** `jobs/<slug>/scan-p<N>.json`, `fill-plan.js`,
`fill-plan.json`, updates to `jobs/.field-cache.json`, then — only after you
confirm — an `applications` row, and optionally a staged capture in
`jobs/.auto/post-submit/`.

Hard rule 6 governs this path, and it is worth restating exactly: **when you hand
over a URL, the application is sent.** The agent does not stop at the submit
button. What has not changed is that a field the fact base cannot answer is still
deferred — the failure being prevented is a _wrong_ application, not an
application.

#### The walk

**Phase 1 — set up, no browser.**

1. Check preconditions: Playwright MCP tools available, and
   `profile.yaml` has `meta.approved_by_user: true`.
2. `node src/documents/new-job.mjs <slug> --from-lead "<url>"`. If it prints
   `description=<n>`, the sweep already captured the posting and **no page read
   happens at all**. If it prints `description=missing` or exits 4, the model
   reads the page for the body only.
3. `node src/applications/check-applied.mjs "<Company>"` — the duplicate
   guard.

**Phase 2 — read the form before tailoring.** The order is deliberate: the form
decides whether a cover letter is needed, whether PDFs are needed at all, and what
unknown questions exist, and all of that belongs in one approval message rather
than three.

4. **The scan.** One MCP call:
   `browser_run_code_unsafe { filename: ".claude/skills/apply-job/scan.driver.mjs" }`.
   That installs `.claude/skills/apply-job/scan-page.js` as `window.__ajScan` for
   the whole session and returns a page inventory: every field with its label and
   required flag, **every dropdown's options — native and custom, opened for
   you**, classified buttons, and page-level signals. Every element is stamped
   with a `data-aj="<key>"` attribute so `[data-aj="f7"]` is a valid target for
   any later Playwright call.

   Re-scanning afterwards costs about thirty tokens:
   `browser_evaluate () => window.__ajScan(false)`, where `false` means "do not
   re-open the dropdowns."

   The scan is loaded **by filename**, never with `addScriptTag`. Ashby serves a
   Content-Security-Policy with a nonce — a one-time token that inline scripts
   must carry — and an injected script tag without it is refused outright. A
   DevTools-protocol evaluation is not subject to that check. This looks like a
   pointless indirection and is load-bearing.

5. The scan's `kind` is acted on first: `ad` → click the start button and re-scan;
   `form` → continue; `login` → stop and ask you to log in; `confirm` → the
   application is already in; `unknown` → read the heading and ask.

6. **`node src/apply/fill-plan.mjs <slug>`** — the single most important
   command on this path. It:
   - reads `jobs/<slug>/scan-p<N>.json`,
   - runs `detectAts(url)` from `src/apply/ats/index.mjs` to pick an adapter
     (`greenhouse`, `lever`, `ashby`, `generic`; `workday` sets `handoff` and the
     script exits **3**, because Workday requires creating an account),
   - loads `jobs/.field-cache.json` and calls `applyCache(scan, cachedEntry)` to
     fill in remembered dropdown options,
   - calls `resolveFields(scan.fields, { profile, answers })` from
     `src/apply/answer-bank.mjs`, which is the only thing that turns a form
     label into a value, and only from the fact base,
   - calls `buildPlan({...})` to produce the plan.

   It writes two files: `fill-plan.json` (the plan data, for you and for tests)
   and `fill-plan.js` (a self-contained bootstrap holding the plan **and** the
   source of `src/apply/fill-engine.mjs`, read off disk here in an ordinary
   Node process).

   It prints, in terse machine form:
   - `ready=true|false` — is any model judgement still required?
   - `submitReady=true|false` — the stricter twin, which answers a question about
     the **unattended** runner, not this path.
   - `items=<n>` — fields that will be filled with no model involvement.
   - one `defer` line per field a human must answer.

   A plan item is `{ k, how, sel, value, label }` where `how` is the verb the
   engine will execute: `fill`, `select`, `check`, `type`, `combo`, `upload`, or
   `skip`. A plan can express no other action — **there is no click verb** — which
   is why an injected plan cannot submit an application.

   Real deferral reasons include `confirm`, `confirm-widget`, `consent`,
   `disclosure-budget`, `long-free-text`, `no option matched the resolved value`,
   `no value resolved`, and a specific one for a résumé-parser upload slot:
   `profile-import control, not an attachment slot`.

> **Known defect (2026-08-05 audit).** The defer reasons documented in
> `SKILL.md` do not match the set `fill-plan.mjs` actually prints, and two records
> it emits for rule-0 and rule-6 purposes are undocumented entirely.

7. **Phase 4 — one approval message.** The tailoring summary, the numbered unknown
   questions with their options, every pick the model made for a
   `NEEDS-CHOICE`/`MAYBE` field, and a statement of what the plan **intends** to
   fill. That last part must read as intent — "will attach", never "attached" —
   because nothing has touched the page yet.

   Your reply is banked with `node scripts/profile/save-answer.mjs "<question>" "<answer>"`,
   using the form's **exact** label as the question, because `answer-bank.mjs`
   matches saved questions exactly ahead of its label rules. A pick the model made
   and you approved is saved with `--source model`, marking it derived-and-approved
   rather than user-stated. **This is the only thing on this path that compounds:**
   the defer list shrinks as you apply.

**Phase 5 — fill.**

8. The bootstrap is loaded into the page and `fillPage(page, plan)` from
   `src/apply/fill-engine.mjs` runs **inside the browser**. It executes each
   item's verb, then runs a verify pass and returns a report:
   `report.uploads` (one entry per attachment, with `{k, tag, file, match, how,
target, attached, seen, seenFile}`), `verify.mismatch`, `verify.requiredEmpty`,
   `revealed` (fields that appeared only after something was filled), `failures`,
   and `defer`.

   Attachments are reported **only** from `report.uploads`, never from the plan.
   The plan says what was attempted; which input actually received a file is
   decided during the fill from the page's own structure, and it once went the
   other way on Greenhouse — cover letter attached on top of the résumé — while
   the plan said what it always says.

9. **Advance or submit.** If a `r: "next"` button exists, the agent clicks it and
   goes back to step 4 for the next page. If only `r: "submit"` remains, the agent
   writes the summary **first** and then clicks it. Every consent tickbox and
   `confirm-widget` it actuated on your behalf is named in that summary with its
   label quoted — you are delegating assent, not waiving the record of it.

10. `node src/applications/log-application.mjs <slug> --company "…" --title "…" --url "…"`
    once you confirm.

11. `node src/apply/capture-post-submit.mjs stage --url … --html-file … --board … --slug …`
    on the page that comes back. This is the **only lawful source** for the
    unattended classifier's corpus, and §2.4 explains why that matters so much.
    It redacts against `profile/` plus generic identifier patterns and refuses to
    write anything if an identifier survives. Promotion into the corpus requires
    `--user-approved` and is your decision, not the agent's.

**Where it can stop:** Workday (`fill-plan.mjs` exit 3), a login wall, a CAPTCHA
signal, any `UNKNOWN` field, an unprobed dropdown, a failed fill, a
`verify.mismatch`, or an unapproved document. Each of those is a **stated
deferral** — say which one and stop — not a hand-off.

### 2.4 Pipeline 4 — The unattended runner

**What triggers it.** `src/auto/cycle.cmd` from a Windows scheduled task, or
`node src/auto/cycle.mjs` by hand, or `node src/auto/auto-apply.mjs`
directly.

**What it reads.** `docs/application-limits.yaml`'s `auto_apply` block, the lead
store, the `verifications` table, the rendered documents, and the live page.

**What it writes.** `auto_queue`, `auto_submissions`, `auto_runs`, `board_pauses`,
and the append-only JSONL in `jobs/.auto/runs/<runid>.jsonl`.

#### The cycle

`src/auto/cycle.mjs` is the join nobody had before it. Five steps, each a
child process, so one lead whose keyword plan throws cannot take the other nine
down with it:

1. `find-jobs.mjs` — new leads
2. `screen.mjs` — L0/L1/L3 verdicts
3. `prep-queue.mjs` — which leads deserve documents
4. per lead: `new-job.mjs` → `keyword-plan.mjs` → `assemble-resume.mjs` →
   `verify-claims.mjs` → `render-pdf.mjs`
5. `auto-apply.mjs` — the runner

Step 4 has no model in it. That is the property that makes the whole thing
schedulable, and it is worth stating plainly: **autonomy here comes from the
deterministic assembler, not from the runner.**

`cycle.mjs` spawns; `auto-apply.mjs` deliberately does not. Four process spawns
per application across 999 applications is roughly 198 seconds of pure startup
serialised behind every browser tab, so the runner **imports** its stages instead.
`cycle.mjs` runs twice a day over a handful of leads, where a spawn per stage
costs nothing measurable and buys crash isolation.

#### The runner's walk

**1. `main()` in `src/auto/auto-apply.mjs`** parses arguments, reads the
limits file, and runs `preflight()` from `src/auto/preflight.mjs`. Preflight
answers "would a run start right now?" with six checks: `stop_switch`,
`auto_apply_caps`, `auto_submit_authorised`, `profile_approved`,
`answer_bank_scan`, `profile_fact_scan`. It supplies **no defaults** for anything
in your file — an absent setting is a refusal, not a guess.

> **Known defect (2026-08-05 audit).** `preflight()` never checks
> `board_allowlist`, even though `allowlistProblems()` in `trust.mjs` exists
> precisely to answer "why is nothing being submitted" in one line at startup. A
> typo like `greenhosue` passes preflight, passes the run, and shows up only as N
> jobs deferring `board-untrusted`.

**2. `selectEligible()`** picks which leads go into the queue, and
`enqueueAutoJobs()` writes them to `auto_queue` in state `queued`.

**3. `launchBrowser()`** from `src/apply/browser.mjs` opens one Chromium. Then
`makeOpenPage(session)` builds a per-job page factory with two lanes:

- **non-persistent** (the default): `browser.newContext()` per job — genuine
  per-job cookie and localStorage isolation, nothing on disk.
- **persistent**: one page on a shared profile directory, for boards that need a
  logged-in session. Chromium takes an exclusive on-disk lock on that directory,
  which is what stops two processes sharing it.

> **Known defect (2026-08-05 audit).** `makeOpenPage` accepts a `localOnly` option
> and ignores it, so `assertAllowedTarget()` — the guard that keeps a fixture run
> from reaching the public internet — is never called on this path.

**4. `runCampaign()`** opens the run record via `startRun()` in
`src/auto/audit.mjs`, releases stale claims, and hands the queue to
`runPool()`.

**5. `runPool({ jobs, runOne, concurrency, shouldStop, onSkip })`** in
`src/auto/pool.mjs` runs at most `concurrency` jobs at once and **at most one
per origin**. §5.3 explains why the exclusion key is the origin.

**6. `runJob()`** in `src/auto/job.mjs` is the per-job state machine, and it
is the file to read if you read only one. Its states:

```
queued → claimed → planned → authorized → attempted
                                        → submitted | challenged | deferred | failed
```

Every transition is a durable database write. Nothing lives in process memory
across a job boundary that cannot be re-derived from the database. A hard kill at
any point leaves a row saying exactly how far that job got. The sequence:

- `claimAutoJob(db, slug, …)` — returns `1` if this worker now owns the slug, `0`
  otherwise. On `0` the worker returns `NOT_CLAIMED` and touches nothing. §5.6.
- `trustBoard({ lead, limits, screening, recordedOrigin })` from
  `src/auto/trust.mjs` — **before the browser opens**, deliberately, so an
  untrusted board costs one row and no page load. Trust is mechanical: the board's
  host must be on your `board_allowlist` and the declared ATS must name an adapter
  this repository ships. The gate never infers the ATS from the URL, because a
  board that puts "greenhouse" in its own path would otherwise be trusted as
  Greenhouse.
- `openPage(applyUrl)` with a bounded retry (`navRetries`, default 1, with
  backoff). A 404 or 410 becomes `posting-gone` — routine at hundreds of leads,
  and the board's event, not a malfunction.
- `walkPages(page, {...})` from `src/auto/multipage.mjs` — the walk. One page
  or several; the single-page case is the same code path with the loop running
  once. Per page it runs the scan stage (`scan-engine.mjs`), the plan stage
  (`fill-plan.mjs`'s `buildPlan`), the fill stage (`fill-engine.mjs`), and between
  pages `advanceOnce()` from `src/auto/advance.mjs`. `MAX_PAGES = 8`. A token
  is minted per page, so a brake pulled while a worker is on page 2 of 4 stops it
  there. `mergePages()` combines the per-page plans and reports into one.
- `classifyPlanDefers(plan.defer, …)` — everything the machine did not understand,
  as one typed reason from the closed taxonomy.
- `authorizeSubmit({...})` from `src/auto/authorize.mjs` — the only thing that
  can produce permission to click. It runs the checks in `SUBMIT_CHECKS` and
  either defers with a named failing check or mints a single-use token.
- `setAutoJobState(db, slug, "attempted")` — **before** `submitOnce`. Of the two
  possible orderings this one can only ever over-report, and over-reporting an
  attempt costs a human one look at a URL while under-reporting one costs a
  duplicate application.
- `submitOnce(page, {...})` from `src/auto/submit.mjs` — eleven named
  preconditions (`token_live`, `token_slug`, `token_plan_sha`, `token_mode`,
  `page_origin`, `queue_claimed`, `durable_attempt`, `plan_clean`, `stop_clear`,
  `board_trusted`, `document_verified`), then the durable `(slug, mode)` row, then
  `locator.click()`. That is one of the two `.click(` calls anywhere under
  `src/auto/`, and `tests/auto/click-surface.test.mjs` asserts there are
  exactly two.
- `classify(url, html)` from `src/auto/classify.mjs` on the page that comes
  back.

**7. The classifier is deliberately blind on every real board.** This is the most
important thing in this section and the easiest to mistake for a bug.

`classify()` is a pure function over `(url, html)` returning one of seven types.
Every rule in it declares where its evidence came from, and that provenance bounds
where it may fire:

- `evidence.source === 'fixture'` — justified by a page this repository wrote. It
  may fire **only on loopback** (`127.0.0.1`).
- `evidence.source === 'capture'` — justified by a real post-submit page from an
  attended apply, redacted and promoted by you. It may fire on the hosts its
  capture came from.

Today `tests/fixtures/post-submit/corpus.json` contains `{"samples": []}` and all
six shipped rules are fixture-sourced. **So every real board classifies as
`unclassified`, and `unclassified` is the one remaining hard stop.** That is not a
gap to route around. Writing a plausible-looking regex instead — "if the page says
'Thank you for applying' it is a confirmation" — is exactly the guess rule 0
forbids, with the model removed and this repository's imagination left in. It
fails silently in the one direction that cannot be recovered: a page misread as a
confirmation records an application that was never sent, and nothing later
corrects it.

The asymmetry is stated in the file's own header. Saying `confirmation` when
nothing was submitted loses an application permanently. Saying anything else when
it _was_ a confirmation costs one human look at one URL, and cannot cause a
duplicate, because the `(slug, mode)` row was written before the click.

> **Known defect (2026-08-05 audit).** When the classifier says `unclassified`,
> `submit.mjs` has the page's HTML in hand and discards it — while
> `capture-post-submit.mjs` exists and would stage exactly those bytes. The one
> path that could grow the corpus unattended throws away the material.

**8. What the runner has actually done.** Reading the database today:

| table              | rows | meaning                             |
| ------------------ | ---- | ----------------------------------- |
| `auto_runs`        | 5    | five live-mode runs on 2026-08-04   |
| `auto_submissions` | 0    | **no click has ever been recorded** |
| `auto_queue`       | 3    | three jobs, all `deferred`          |

The three deferrals: one `consent-tickbox` and two `confirm-field`, all at stage
`plan`. Every run reported `submitted=0`. The machine is armed and has never sent
anything, because every job it planned hit a field that carries assent rather than
a value.

> **Known defect (2026-08-05 audit).** `CLAUDE.md` rule 6 and the header comments
> in `guard.mjs`, `audit.mjs` and `authorize.mjs` all state that the runner ships
> off, that there is no `board_allowlist`, and that "there is still no runner."
> `docs/application-limits.yaml` now reads `enabled: true`, `dry_run: false` and a
> four-entry allowlist, `auto-apply.mjs` launches a real Chromium, and
> `makeStages()` supplies a real classifier. Those comments are stale. The project's
> own audit names the failure mode: _a control stated as fact gets believed in
> instead of implemented._

**Where it can stop.** Every one of these ends the application with a typed reason
from the closed taxonomy in `src/lib/db.mjs`:

| stage       | stop                                      | reason kind                                          |
| ----------- | ----------------------------------------- | ---------------------------------------------------- |
| before run  | `jobs/.auto/STOP` exists                  | the run refuses to open                              |
| claim       | another worker owns the slug              | `not-claimed` (not a defer — no row is written)      |
| claim       | board not on the allowlist                | `board-untrusted`                                    |
| claim       | the lead carries an L3 rejection          | `l3-rejected`                                        |
| plan        | navigation failed after its retries       | `nav-timeout`                                        |
| plan        | the posting is 404/410                    | `posting-gone`                                       |
| plan        | any consent tickbox                       | `consent-tickbox`                                    |
| plan        | any checkbox or radio group               | `confirm-widget`                                     |
| plan        | an assertion the fact base infers         | `confirm-field`                                      |
| plan        | a field nothing understood                | `unknown-field`                                      |
| plan        | a dropdown whose options were never read  | `unprobed-dropdown`                                  |
| plan        | more than 8 pages, or a page unresolvable | `multipage-unresolvable`                             |
| authorize   | a company or run cap reached              | `cap-company`                                        |
| authorize   | no passing verification for these bytes   | `doc-unverified`                                     |
| authorize   | the limits file changed mid-run           | `fact-base-changed`                                  |
| post-submit | the board answered with a challenge       | `captcha` / `bot-challenge` / `email-code-challenge` |
| post-submit | the page did not classify                 | `post-submit-unclassified` (a **failure** kind)      |

---

## 3. The repository, folder by folder

```
AgenticJobApplication/
├── .claude/            the agent's own configuration
│   ├── agents/         7 subagent definitions (job-worker, qa, architect, …)
│   ├── hooks/          YOURS ALONE — protect-profile.js, guard-profile-shell.mjs
│   ├── skills/         11 skills, each a directory with a SKILL.md
│   └── settings.json   YOURS ALONE — wires every hook
├── .github/workflows/  ci.yml + test-gate.mjs, perf-gate.mjs, scaffolding-reaper.mjs
├── docs/               configuration you own + documentation
├── jobs/               ALL GENERATED, gitignored — the store and the workspaces
├── logs/               machine-local cycle logs, gitignored
├── profile/            YOUR FACTS, gitignored except the example
├── schemas/            context.schema.json, job.schema.json
├── src/            all the deterministic code — no LLM calls anywhere
├── templates/          document.css, the print stylesheet for rendered PDFs
├── tests/              mirrors src/ one for one
├── CLAUDE.md           the hard rules, loaded into every session
└── package.json        two runtime dependencies: js-yaml and marked
```

### 3.1 `src/` — the deterministic core

Grouped by domain. Nothing in here calls a language model; that is the definition
of the directory.

| Directory           | What lives there                                                                                                                                                                                                                                                                                                                                                  |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/`          | The foundation everything imports: `db.mjs` (schema and every accessor), `lib.mjs` (output mode, `mapPool`, HTTP), `lock.mjs` (the file lock), `untrusted.mjs` (the rule-0 sanitiser), `keywords.mjs`, `verification.mjs`                                                                                                                                         |
| `src/leads/`        | Finding and judging postings: `find-jobs.mjs`, `enrich.mjs`, `screen.mjs`, `stages.mjs`, `fit.mjs`, `risk.mjs`, `recommend.mjs`, `prep-queue.mjs`, `cluster.mjs`, `canonical.mjs`, `gate-audit.mjs`, `manage-sources.mjs`, `find-boards.mjs`, `discover-boards.mjs`, `board-yield.mjs`                                                                            |
| `src/documents/`    | Producing and checking documents: `new-job.mjs`, `keyword-plan.mjs`, `letter-plan.mjs`, `assemble-resume.mjs`, `verify-claims.mjs`, `render-pdf.mjs`, `reuse-check.mjs`, `ats-lint.mjs`                                                                                                                                                                           |
| `src/apply/`        | Reading and filling a live form: `scan-engine.mjs`, `fill-plan.mjs`, `fill-engine.mjs`, `answer-bank.mjs`, `field-cache.mjs`, `intents.mjs`, `disclosure.mjs`, `longform.mjs`, `browser.mjs`, `auth-sync.mjs`, `pending-questions.mjs`, `capture-post-submit.mjs`, `automatability.mjs`, and `ats/` (one adapter per board)                                       |
| `src/auto/`         | The unattended runner and its guardrails: `cycle.mjs`, `auto-apply.mjs`, `job.mjs`, `pool.mjs`, `stages.mjs`, `multipage.mjs`, `advance.mjs`, `submit.mjs`, `authorize.mjs`, `trust.mjs`, `caps.mjs`, `breaker.mjs`, `guard.mjs`, `classify.mjs`, `taxonomy.mjs`, `audit.mjs`, `digest.mjs`, `reconcile.mjs`, `preflight.mjs`, `notify.mjs`, `untrusted-text.mjs` |
| `src/applications/` | The record: `log-application.mjs`, `update-application.mjs`, `applications.mjs`, `check-applied.mjs`, `follow-ups.mjs`                                                                                                                                                                                                                                            |
| `scripts/profile/`  | The fact base's only doors: `save-answer.mjs`, `apply-profile.mjs`, `profile-gaps.mjs`, `keyword-coverage.mjs`                                                                                                                                                                                                                                                    |
| `src/maintenance/`  | `archive.mjs`, `migrate.mjs`, `prune-jobs.mjs`                                                                                                                                                                                                                                                                                                                    |
| `src/dev/`          | Benchmarks and measurement, never on any application path: `bench-apply.mjs`, `bench-runner.mjs`, `bench-green-prevalence.mjs`, `flake-rate.mjs`                                                                                                                                                                                                                  |
| `src/hooks/`        | Agent-editable guardrails: `guard-bash.mjs`, `guard-files.mjs`, `prettify.mjs`                                                                                                                                                                                                                                                                                    |
| `src/status.mjs`    | The whole-pipeline digest, at the root because it belongs to no one domain                                                                                                                                                                                                                                                                                        |

The grouping is not filing — it is a dependency direction. `lib/` imports nothing
from the others. Everything imports `lib/`. `auto/` imports `apply/` (it reuses
the scanner and the planner) and `lib/`, but nothing in `apply/` imports `auto/`.
If you ever find yourself adding an import that points the other way, that is the
signal a decision is in the wrong file.

### 3.2 `jobs/` — everything the machine produced

Entirely gitignored, and the `.gitignore` entry is anchored (`/jobs/`) rather than
bare (`jobs/`) — a bare pattern matches a directory of that name at _any_ depth,
and it once silently swallowed eight test fixtures in `tests/documents/assemble/jobs/`.

```
jobs/
├── leads.db                     THE STORE OF RECORD (SQLite, 12 tables)
├── leads.db-wal, leads.db-shm   SQLite's write-ahead log sidecars
├── .field-cache.json            remembered form shapes, keyed by fingerprint
├── .auto/
│   ├── runs/<runid>.jsonl       append-only run ledger — THE COPY THAT SURVIVES
│   ├── post-submit/             staged captures awaiting your review
│   ├── STOP                     the global kill switch (a file; delete to clear)
│   ├── stops/{run,board,company}/<key>   scoped brakes
│   └── INBOX.md                 things the runner needs a human to see
└── <slug>/                      one directory per job
    ├── job.json                 the posting, sanitised
    ├── context.json             shared state for both tailoring skills
    ├── keywords.json            the keyword plan
    ├── resume.md, cover-letter.md
    ├── resume.pdf, cover-letter.pdf
    ├── scan-p1.json             the form inventory, one per page
    ├── fill-plan.json           the plan, readable
    └── fill-plan.js             the plan + engine, as an injectable bootstrap
```

### 3.3 `docs/` — configuration and documentation

Two of the files in here are **configuration the code reads**, not documentation:
`docs/application-limits.yaml` and `docs/job-sources.yaml`. They are yours. The
agent proposes values and never edits them.

> **Known defect (2026-08-05 audit).** `docs/application-limits.yaml` is
> user-owned by policy and guarded by neither hook. Nothing mechanically stops an
> agent editing it; only the written rule does.

The rest is documentation, and most of it is being replaced by the set you are
reading. `docs/reference/`, `docs/autonomy/`, the two `autonomy-plan*.md` files
and the old `README.md` are stale — treat them as leads to verify, never as
sources of truth.

### 3.4 `tests/` — mirrors `src/` one for one

124 test files across twelve directories: `applications` (3), `apply` (24),
`auto` (27), `dev` (4), `documents` (12), `hooks` (7), `leads` (22), `lib` (6),
`maintenance` (3), `profile` (5), `security` (11), plus `fixtures/` (data, not
tests).

`npm test` runs `node tools/ci/test-gate.mjs full`, not a bare
`node --test`. The difference matters: `node --test` exits `0` on an empty run, so
an exit code alone is not evidence that anything ran. The gate expands the
directories itself and asserts the count against a floor in `package.json` —
currently 2314 for the full suite and 262 for the security suite.

---

## 4. Who owns what state

This is the section to reread when something has gone wrong and you cannot work
out which copy of a fact to trust.

### 4.1 The table

"Writer" means: this component may create or change this state. "Reader" means:
may look at it and must never change it. A state with two writers is a bug unless
the writes are coordinated, and this table is where you check.

| State                     | Where it lives                                               | Who may WRITE it                                                                                                                                           | Who may only READ it                                                                                              | If it is lost                                             |
| ------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| **Lead store**            | `leads`, `lead_keywords` in `jobs/leads.db`                  | `find-jobs.mjs` (under `LEADS_LOCK`), `screen.mjs` (status only), `recommend.mjs` (status)                                                                 | everything else: `recommend`, `prep-queue`, `cluster`, `automatability`, `auto-apply`, `status`                   | re-derivable — run another sweep                          |
| **Screening verdicts**    | `screens` (key `(lead_id, source)`)                          | `screen.mjs`, `screen.mjs record` for model verdicts                                                                                                       | `screen.mjs --skip-screened`, `authorize.mjs`, `job.mjs`                                                          | re-derivable — re-screen                                  |
| **Board productivity**    | `board_stats`                                                | `find-jobs.mjs`'s `recordSweep()`                                                                                                                          | nothing, today (see the defect above)                                                                             | re-derivable                                              |
| **Per-job workspace**     | `jobs/<slug>/`                                               | `new-job.mjs`, `keyword-plan.mjs`, `assemble-resume.mjs`, `render-pdf.mjs`, `fill-plan.mjs`, the tailoring skills, `job-worker`                            | `verify-claims.mjs`, `reuse-check.mjs`, `ats-lint.mjs`, `auto-apply.mjs`, `screen.mjs`                            | re-derivable, but the drafts are lost                     |
| **Archived workspace**    | `documents` table (key `(slug, name)`)                       | `archive.mjs` only                                                                                                                                         | `archive.mjs list/show/restore`                                                                                   | **NOT re-derivable — no on-disk source. Back up the .db** |
| **Fact base**             | `profile/profile.yaml`, `profile/answers.yaml`               | **you**, and `save-answer.mjs` / `apply-profile.mjs` acting on your explicit approval                                                                      | everything: `answer-bank`, `verify-claims`, `keyword-plan`, `assemble-resume`, `preflight`, `capture-post-submit` | **NOT re-derivable. Gitignored — back it up yourself**    |
| **Application record**    | `applications` table in `jobs/leads.db`                      | `writeApplication()` in `db.mjs`, called only by `log-application.mjs` and `update-application.mjs` after you confirm                                      | `check-applied`, `follow-ups`, `status`, `find-jobs` (dedupe), `profile-gaps`                                     | recoverable from the YAML export via `migrate.mjs`        |
| **Application export**    | `profile/applications.yaml`                                  | `exportApplicationsYaml()` **only** — regenerated after every write                                                                                        | you, by eye; `migrate.mjs` as a bootstrap input                                                                   | regenerate: `applications.mjs export`                     |
| **Verification record**   | `verifications` (key `(slug, mode, doc_sha256)`)             | `verify-claims.mjs`                                                                                                                                        | `submit.mjs` precondition 11, `auto-apply.mjs`, `prep-queue.mjs`                                                  | re-derivable — re-verify                                  |
| **Field cache**           | `jobs/.field-cache.json`                                     | `fill-plan.mjs` (attended CLI) and `stages.mjs` (unattended plan/fill), both through `field-cache.mjs`'s locked `updateCache` (`recordCache`, `recordVia`) | `pending-questions.mjs`, `automatability.mjs`, `bench-green-prevalence.mjs`                                       | re-derivable — the next scan re-probes, slowly            |
| **Workspace stack cache** | `workspace_stacks` (key `slug`, invalidated by `job_sha256`) | `reuse-check.mjs`                                                                                                                                          | `reuse-check.mjs`                                                                                                 | re-derivable                                              |
| **Auto queue**            | `auto_queue` (key `slug`)                                    | `claimAutoJob`, `setAutoJobState`, `enqueueAutoJobs`, `releaseStaleAutoClaims` — all in `db.mjs`, called from `job.mjs` and `auto-apply.mjs`               | `digest.mjs`, `status.mjs`, `audit.mjs`                                                                           | the resume set is lost; jobs re-plan from scratch         |
| **Submission ledger**     | `auto_submissions` (key `(slug, mode)`)                      | `recordAutoSubmission` / `acknowledgeAutoSubmission` in `db.mjs`, called from `audit.mjs`                                                                  | `caps.mjs`, `digest.mjs`, `reconcile.mjs`                                                                         | **cap arithmetic and duplicate protection are lost**      |
| **Audit trail**           | `auto_runs` **and** `jobs/.auto/runs/<runid>.jsonl`          | `audit.mjs` only — it writes both, and neither is derived from the other                                                                                   | `digest.mjs`, `status.mjs`, you                                                                                   | the JSONL is the copy that survives                       |
| **Board pauses**          | `board_pauses` (scoped by `run_id`)                          | `breaker.mjs` via `recordBoardPause` / `clearBoardPause`                                                                                                   | `digest.mjs`                                                                                                      | expires anyway — a pause is per-run                       |
| **The brakes**            | `jobs/.auto/STOP`, `jobs/.auto/stops/**`                     | `raiseStop()` in `guard.mjs`; cleared **only by a human deleting the file**                                                                                | `preflight`, `authorize`, `audit`, `submit`                                                                       | the brake is released, which is the dangerous direction   |
| **Post-submit corpus**    | `tests/fixtures/post-submit/`                                | you, via `capture-post-submit.mjs promote --user-approved`                                                                                                 | `classify.mjs`                                                                                                    | the classifier goes blind — which it already is           |
| **Config**                | `docs/application-limits.yaml`, `docs/job-sources.yaml`      | **you.** `manage-sources.mjs` edits the sources file line-by-line on your instruction                                                                      | `find-jobs`, `screen`, `trust`, `caps`, `authorize`, `preflight`, `disclosure`, `recommend`                       | **NOT re-derivable — these are your decisions**           |

### 4.2 Store of record versus generated export

`jobs/leads.db`'s `applications` table is the store of record.
`profile/applications.yaml` is a **generated export** — a copy written for you to
read, regenerated in full after every single write. Its header says so in the file
itself:

```
# APPLICATION LOG — GENERATED, do not edit.
# Source of truth is the `applications` table in jobs/leads.db.
# Regenerate: node src/applications/applications.mjs export
```

If you edit that YAML file by hand, your edit survives until the next application
is logged and then vanishes without a trace, because `exportApplicationsYaml()`
writes the whole file from the table. This is the single most common way to lose
data in a system with an export, and it is why the header is shouting.

The direction matters too. The export is a **recovery input**, not a record:
`migrate.mjs` will import it into an empty `applications` table to bootstrap a
fresh database. It never merges, and it never wins against existing rows.

The same shape appears three more times:

- `leads` is the store of record; there is no standing `jobs/leads.json`.
- `verifications` is the store of record for "was this checked"; the presence of a
  `resume.md` on disk proves nothing.
- `auto_runs` and `jobs/.auto/runs/*.jsonl` are **two independent records**, not a
  record and its export. Neither is derived from the other, and a record present
  in one and absent from the other is itself a finding. The JSONL survives because
  it is append-only text and `jobs/` is gitignored with no other source; the table
  exists because JSONL cannot be queried, and "how many applications went to this
  company this week?" must be answered cheaply before the next submit.

And one true cache: `workspace_stacks` is derived data, keyed by the sha256 of the
`job.json` it was computed from. A cached row is used only when that hash still
matches, so an edited posting recomputes and a stale row can never be believed.

### 4.3 The two ownership rules that are enforced rather than written

**The agent may not write the fact base.** Two hooks stand across it:

- `.claude/hooks/protect-profile.js` on the `Edit|Write|NotebookEdit` path
- `.claude/hooks/guard-profile-shell.mjs` on the `Bash|PowerShell` path

A **hook** here is a program the harness runs _before_ a tool call and whose
verdict the model cannot argue with. Between the two, `profile/` has no unguarded
writer. `scripts/profile/save-answer.mjs` is the only door, and it refuses to run
against the real `profile/` without `--file <temp>`, `--user-approved` or
`--rescan`. Its exit codes are a contract: `3` for an instruction-shaped label,
`4` for a government or financial identifier, and `4` has no override by design.

**The files under `.claude/hooks/` and `.claude/settings*.json` are yours alone**,
sealed on both the edit path and the shell path. `settings.json` is included
because it _wires_ every hook — a guard that can be unwired is not a guard.
`src/hooks/*` is a different matter: those are agent-editable, because they
implement project conventions rather than protect your data.

---

## 5. The concurrency model

### 5.1 Why any of this exists

Two facts drive every decision in this section.

**Almost all the time is spent waiting on the network.** Fetching 44 boards one
after another means 44 round trips added end to end; fetching them eight at a time
means roughly an eighth of the wall clock. JavaScript runs on a single thread, so
these are not running in parallel in the sense of using more processors — they are
**concurrent**: while one request waits for a reply, the thread runs another. CPU
work does not overlap. Network waiting does. That distinction explains why the
board sweep pools and the tailoring does not.

**Several things really can write the same file at once.** `pipeline-jobs` fans
out one subagent per job; the runner drives eight workers; you might have a
terminal open. Two writers on one file is a **race condition** — the outcome
depends on which one finishes last — and the classic form is a **lost update**:
both read, both change their copy, both write, and the first one's change is gone
with nothing anywhere saying so.

### 5.2 The board sweep's worker pool

`mapPool(items, limit, fn)` in `src/lib/lib.mjs` is nineteen lines and worth
reading in full, because it is the whole pattern:

```js
export async function mapPool(items, limit, fn) {
  const out = new Array(items.length)
  let next = 0
  const workers = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    async () => {
      for (;;) {
        const i = next++
        if (i >= items.length) return
        out[i] = await fn(items[i], i)
      }
    },
  )
  await Promise.all(workers)
  return out
}
```

`limit` worker functions are started at once. Each takes the next index off a
shared counter, does the work, and loops. `out[i] = …` rather than `out.push(…)`
is the detail that matters: results land at their **input position**, so the
returned array is in the original order even though the work finished out of
order. Reconstructing order afterwards is a classic pool bug and this avoids it by
never losing the order in the first place.

The cap is not only about speed. Eight is polite. Unbounded concurrency against
one vendor's API is indistinguishable from an attack, and this project relies on
those APIs staying open to it.

`mapPool` is used by `find-jobs.mjs` (the sweep, default `--concurrency 8`),
`enrich.mjs` (per-posting detail fetches), `canonical.mjs`, `board-yield.mjs`,
`find-boards.mjs` and `discover-boards.mjs`.

### 5.3 The origin-keyed browser pool

`runPool()` in `src/auto/pool.mjs` is a different shape, because browsers
share state in a way HTTP requests do not.

An **origin** is scheme + host + port: `https://boards.greenhouse.io` is one
origin. Cookies and `localStorage` are scoped to the origin. So two browser tabs
on two different Greenhouse tenants — Coinbase and Tebra, say — are on the _same_
origin and share the same cookie jar and the same storage area.

Revision 1 of the design keyed exclusion on `board_key`, which is tenant-scoped.
The comment at the top of `pool.mjs` names exactly what that permitted:

> Greenhouse's embed flow holds upload and draft state per origin, so one tab's
> resume upload token is overwritable by another's, and the Coinbase application
> goes out carrying the Tebra-tailored resume — irreversibly, and with nothing in
> any log saying so.

So the rule is: **at most one job in flight per registrable origin, always.**
Concurrency is recovered structurally instead — cookie-free boards get their own
`browser.newContext()` per job, which is genuine per-job storage isolation.

Three details are worth carrying into anything you build:

**A job with no known origin is serialised under one shared key**, not let through
unbounded. That shared key is `NO_ORIGIN` in `src/auto/pool.mjs`, and its
value is the NUL character followed by `no-origin`. The NUL is written as a
six-character JavaScript escape — backslash, `u`, then four zeros — and never as
a raw NUL byte in the file. A raw one passes prettier and
`node --check` untouched, is invisible in every editor, and makes ripgrep classify
the file as binary so a codebase-wide search silently skips it. Two files in
`src/` had already been broken that way.

**A blocked job is left in place, not moved to the back of the queue.** Reordering
by origin contention would silently de-prioritise exactly the boards you have most
leads for.

**The pool reports the observed maximum in flight, never the configured one.** A
pool capable of eight that serialises on its exclusion key would otherwise report
`N=8` throughput while achieving `N=1`. `originCount(jobs)` is printed next to it,
because 50 jobs at concurrency 8 across 3 origins can never exceed 3, and without
that number it reads as the pool underperforming.

**N is a resource limit, never a volume limit.** Every queued job is still applied
to; N bounds only the rate. A queue holding 200 jobs on one origin runs them one
at a time and finishes all 200.

### 5.4 Per-job subagents

The third kind of concurrency is not processes at all — it is model context.

The `pipeline-jobs` skill fans out one **subagent** per job. A subagent is a
separate model session with its own context window, defined by a file in
`.claude/agents/`. `job-worker.md` pins `model: sonnet` and declares
`tools: Bash, Read, Write, Edit, Glob, Grep, WebFetch, WebSearch` — that list is a
**capability allowlist**: a tool absent from it cannot be called at all, which is
why `job-worker` cannot drive a browser and therefore cannot submit anything.

The reason is cost. Every turn of a conversation re-sends the whole history, so a
long session is quadratically expensive. Ten jobs processed in one session means
job 10 pays for jobs 1 through 9 on every turn. Ten subagents means each pays only
for its own job, and the orchestrator sees ten short JSON results instead of ten
transcripts.

Each subagent opens its own SQLite connection. That is the concurrency the
`busy_timeout` in `openDb()` exists for.

### 5.5 What protects shared state, part 1: the file lock

`src/lib/lock.mjs` implements a **lock file**: a small file whose existence
means "someone is writing; wait." `acquire()` creates it exclusively — the
create-if-not-exists operation is atomic at the OS level, so two processes racing
it cannot both succeed.

Three problems a naive lock has, and how this one answers them:

**A crashed holder wedges the resource forever.** If the writer is killed, the
lock file remains and nothing can ever write again. The answer is a **stale
timeout**: `DEFAULT_STALE_MS = 10_000`, and a lock whose modification time is older
than that may be broken by a waiter. Ten seconds is a thousandfold margin over a
healthy write.

**Probing the holder's process id does not work.** The first version broke a lock
when `process.kill(holder.pid, 0)` said the process was gone — and it broke locks
whose holders had acquired them 11, 13 and 18 milliseconds earlier. A healthy
writer's process finishes milliseconds after acquiring, so "the process is gone" is
not evidence the lock is abandoned. Age is.

**A dispossessed holder can still publish.** If your lock was broken while you held
it, you must not write. `withLock` post-checks, but that fires only after the
function returns — too late to stop a write that already ran. So `ingest()` checks
`handle.stillHeld()` **immediately before** `saveLeads()`, in addition:

```js
if (!handle.stillHeld()) {
  throw new Error("LEADS_LOCK was broken while ingest held it — …")
}
saveLeads(fresh, leadsFile)
```

And the shape that makes the lock worth having at all: **re-read inside the lock.**
`ingest()` does all its planning against a copy read before the lock, then inside
the lock re-reads the store, applies this call's changes to that fresh copy, and
writes. Writing the pre-lock copy would restore whatever another writer had already
committed — a lost update with a lock around it, which is worse than no lock
because it looks safe.

`LEADS_LOCK` guards `jobs/leads.db`. `save-answer.mjs` uses the same primitives for
`answers.yaml`, with a measurement in its header: without the lock, 6 concurrent
writers lost updates; with it, 20 writers × 5 trials lost 0 of 100.

> **Known defect (2026-08-05 audit).** `AUTO_RUN_LOCK` is exported from `lock.mjs`
> and no code anywhere takes it.

### 5.6 What protects shared state, part 2: the SQLite claim

Inside the database, coordination does not use a lock file. It uses a single SQL
statement, which is atomic by definition — no other writer can observe it half
done.

`claimAutoJob(db, slug, opts)` is that statement:

```sql
INSERT INTO auto_queue (slug, run_id, board_key, origin, state, attempt_no, …)
VALUES ($slug, …, 'claimed', 1, …)
ON CONFLICT(slug) DO UPDATE SET
  state = 'claimed',
  attempt_no = auto_queue.attempt_no + 1,
  …
WHERE auto_queue.state = 'queued'
```

Read it in three parts. **`INSERT`** succeeds if no row exists for this slug.
**`ON CONFLICT(slug) DO UPDATE`** handles the case where a row does exist. **`WHERE
auto_queue.state = 'queued'`** is the guard that makes the whole thing work: the
update fires _only_ for a row nobody has claimed. For every other state — claimed
by someone, already attempted, already terminal — it degrades to doing nothing.

The function returns `.changes`: the number of rows the statement altered.

Writing it as a guarded `DO UPDATE` rather than a bare `DO NOTHING` is what makes a
**pre-planned queue** possible at all. With a bare `DO NOTHING`, a slug enqueued as
`queued` could never be claimed by anybody, because the row would already be there.

### 5.7 Why a `0` from `claimAutoJob` is normal, not an error

This is the piece most likely to be "fixed" back into a bug, so it gets its own
section.

When eight workers pull from one queue, several may reach the same slug. Exactly
one of their `INSERT … WHERE state = 'queued'` statements finds the row in
`queued`; that one changes 1 row. Every other worker's statement matches nothing
and changes 0 rows. `job.mjs` handles it in four lines:

```js
if (claimAutoJob(db, slug, { run_id: run.id, board_key, origin }) !== 1) {
  // 0 changes means another worker owns it, or it is already terminal. Either
  // way this worker touches nothing — writing a reason here would overwrite
  // the owner's.
  return done(NOT_CLAIMED, null)
}
```

**`0` means "somebody else owns this slug; do not click."** In a fan-out it is the
ordinary result for every worker but one. It is not an anomaly, it is not logged as
a failure, and — importantly — the losing worker writes **nothing**, because
writing a reason would overwrite the reason the winner is about to write.

This is **optimistic concurrency control**: rather than asking permission first,
each worker attempts the change with an ownership condition attached, and the row
count tells it whether it won. It is cheaper than locking and it is exactly right
when losing is harmless.

`recordAutoSubmission(db, sub)` uses the same trick on `auto_submissions`, keyed
`(slug, mode)`:

```sql
INSERT INTO auto_submissions (…) VALUES (…)
ON CONFLICT(slug, mode) DO UPDATE SET …
WHERE auto_submissions.outcome = 'reconciled-not-sent'
```

Here `1` means this caller owns the submit and `0` means the slug already has a row
in this mode and **this caller must not click**.

**Same return value, different meaning, depending on where it happens.** A `0` from
`claimAutoJob` is ordinary. A `0` from `recordAutoSubmission` _inside_
`beginSubmit()` is an anomaly, because the queue claim should already have made it
impossible — so `audit.mjs` raises a company-scoped STOP and throws. Understanding
that difference is understanding the whole coordination design.

Three more details that are load-bearing:

**The key is `(slug, mode)`, never `(run_id, slug)` and never `(slug)` alone.**
`(run_id, slug)` would let the same posting be submitted once per run with no
conflict — the ledger could not refuse a second application tomorrow. `(slug)`
alone is wrong the other way: dry-run rows live in this same table on purpose, so a
rehearsal would pre-consume the live claim forever.

**`mode` is `NOT NULL DEFAULT 'live'`** because SQLite permits NULLs in the columns
of a non-INTEGER primary key, and a NULL `mode` would therefore conflict with
nothing — an unlimited number of un-refusable duplicate rows.

**Exactly one outcome releases the claim: `reconciled-not-sent`.** It means
`reconcile.mjs` went and looked at the board and the board says no application
exists. Without that exception the row would occupy `(slug, mode)` forever, so the
slug would report 0 changes on every future run, fail as `db-write-failed` each
time, and after two consecutive failures pause the whole board. A posting nobody
applied to would become permanently unappliable, loudly, forever. Widening that
exception list re-opens the same deadlock.

> **Known defect (2026-08-05 audit).** `reconcileAll` and `reconcileOne` in
> `src/auto/reconcile.mjs` are imported only by their own test. No file under
> `src/` imports that module. So `reconciled-not-sent`, and the entire
> release-the-claim path, cannot fire in production today.

### 5.8 The four brakes, side by side

They are easy to confuse and they behave very differently.

| Mechanism       | Where                                        | Lifetime           | Cleared by                       | Scope                     |
| --------------- | -------------------------------------------- | ------------------ | -------------------------------- | ------------------------- |
| **Global STOP** | `jobs/.auto/STOP`                            | durable, forever   | a human deleting the file        | everything                |
| **Scoped STOP** | `jobs/.auto/stops/{run,board,company}/<key>` | durable, forever   | a human deleting the file        | one run / board / company |
| **Board pause** | `breaker.mjs` memory + a `board_pauses` row  | one run, 5 minutes | expiry plus one successful probe | one board                 |
| **Defer**       | `auto_queue.reason_kind`                     | this job only      | nothing — it _is_ the answer     | one application           |

There is deliberately no `clearStop()` function at any scope. And `raiseStop()`
**throws** when given a non-global scope with no key, rather than widening to
global — that refusal is the load-bearing half, because a bug that silently
escalates a company brake to a global one looks like extra safety and is actually
a denial of service on your own job search.

> **Known defect (2026-08-05 audit).** Scoped STOPs are invisible to
> `src/status.mjs`: `digest.mjs` computes stop status from the global path
> only. A company brake — the kind only a human can clear — never appears in the
> one command that answers "is the machine working?"

---

## 6. One job, end to end

A realistic walk using a slug that actually exists in this repository:
`render-postgres-product-engineer`. Values below are illustrative where the real
ones would contain personal data.

**1. The sweep runs.** `node src/leads/find-jobs.mjs search --source all`.
`loadSources()` returns 44 boards; `mapPool` fetches them eight at a time.
Render's Ashby board answers with its current postings, one of which is titled
"Product Engineer, Postgres".

**2. L0 judges it in memory.** `passesLimits()` checks the title against
`roles.title_keywords` in your limits file, the location against the
no-relocation rule, and the posting date against `freshness.max_age_days`. It
passes with no flags. Roughly 95% of the day's candidates die at this step; this
one does not.

**3. The body is fetched and sanitised.** Ashby's list endpoint carries no
description, so `enrich.mjs` fetches the detail endpoint. The HTML goes through
`sanitizeHtmlSnippet()` before anything stores it. Nothing suspicious is found, so
no `untrusted_findings` are recorded.

**4. `canonicalizeLeads()`** stamps `apply_url` as the Ashby-hosted application
address — the address the trust gate will later check against your allowlist.

**5. L1 judges the body.** `bodyDisqualifiers()` looks for required relocation, a
clearance requirement, senior-only language. Clean.

**6. The lead is committed.** `withLock(LEADS_LOCK, …)` re-reads the store,
appends the lead, checks `handle.stillHeld()`, and writes. The lead now has
`id`, `status: "new"`, `found_at`, `company: "Render"`, `title`, `url`,
`apply_url`, `description`, `flags: []`. Then `indexKeywords()` writes its
technology terms to `lead_keywords`: `postgres`, `go`, `kubernetes`, and so on.

**7. Screening.** `node src/leads/screen.mjs --status new` runs
`evaluateStages()`. L2 (`scoreFit`) compares the posting's stack against your
profile's and produces a fit score. L3 (`scoreRisk`) looks for scam signals, ghost
signals, and repost history. Both pass. A row lands in `screens` with
`source: 'mechanical'` and `verdict: 'keep'`.

**8. Ranking.** `rankLeads()` scores it: technology overlap plus title rank plus
freshness plus a salary signal minus risk flags. It lands in the top ten, so
`prep-queue.mjs` queues it for tailoring ahead of time.

**9. The workspace is created.**
`node src/documents/new-job.mjs render-postgres-product-engineer --from-lead "<url>"`
prints `description=4180 untrusted=none` and writes
`jobs/render-postgres-product-engineer/job.json` and `context.json`. **No page was
read** — the sweep already had everything.

**10. The keyword plan.** `keyword-plan.mjs` writes `keywords.json` with
`must_use` — the intersection of the posting's terms and your fact base — and
`blocked`, the posting's other terms.

**11. The draft.** `assemble-resume.mjs` emits each selected fact verbatim with
its `<!-- fact:ID -->` annotation, writing `resume.md`. A cover letter is drafted
too, because the Ashby form has a cover-letter field.

**12. Verification.** `verify-claims.mjs render-postgres-product-engineer` runs
R1–R7 and exits 0. A row lands in `verifications` with
`(slug, 'resume', doc_sha256)`, carrying the `profile_sha256` those bytes were
checked against.

**13. You approve, and PDFs are rendered.** `render-pdf.mjs` shells out to Edge,
producing `resume.pdf` and `cover-letter.pdf`, plus a `.render.html` intermediate
that `prune-jobs.mjs` will delete.

**14. The form is scanned.** You give the agent the URL. One MCP call runs
`scan.driver.mjs`, which installs `scan-page.js` as `window.__ajScan` and returns
the page inventory. Every element gets a `data-aj` stamp. The scan is written to
`jobs/render-postgres-product-engineer/scan-p1.json`.

**15. The plan is built.** `node src/apply/fill-plan.mjs render-postgres-product-engineer`
detects Ashby, loads `jobs/.field-cache.json`, resolves every field through
`answer-bank.mjs`, and writes `fill-plan.json` and `fill-plan.js`. The real plan
from this workspace has this shape (a value redacted):

```json
{
  "items": [
    {
      "k": "f3",
      "how": "upload",
      "labelMatch": "resume|\\bcv\\b",
      "paths": ["…/jobs/render-postgres-product-engineer/resume.pdf"]
    },
    {
      "k": "f4",
      "how": "fill",
      "sel": "#_systemfield_name",
      "value": "<your name, from profile.yaml>",
      "label": "Name"
    },
    {
      "k": "f5",
      "how": "skip",
      "label": "Pronouns",
      "why": "optional and not in the fact base (unknown)"
    }
  ],
  "defer": [
    {
      "k": "g1",
      "why": "confirm",
      "value": "Yes",
      "pick": "f14",
      "label": "Are you legally authorized to work in the United States of America?",
      "classInfo": "assertion/inferred (work_authorization)"
    },
    {
      "k": "g2",
      "why": "confirm",
      "value": "No",
      "pick": "f17",
      "label": "Will you now or in the future require visa sponsorship …?",
      "classInfo": "assertion/inferred (work_authorization)"
    }
  ]
}
```

Note what the deferrals are. The fact base _can_ answer both questions. They are
deferred anyway because they are **assertions you make**, not values about you —
`classInfo` says `assertion/inferred`. That distinction between a value and an act
of assent is the reason the two paths diverge here.

**16. One approval message.** The tailoring summary, the two work-authorisation
answers with their inferred values for you to confirm, and a statement that the
plan will attach `resume.pdf` and `cover-letter.pdf` and leave "Pronouns" blank —
written as intent, because nothing has touched the page yet.

**17. You reply.** The answers are banked:
`node scripts/profile/save-answer.mjs "Are you legally authorized to work in the United States of America?" "Yes"`.
That exact question text now resolves on every future Ashby form.

**18. The fill runs.** The bootstrap is injected and `fillPage()` executes each
verb inside the page. It returns `report.uploads` with two entries — each naming
the file, the target input's own `id`, and how it was matched — plus `verify` with
empty `mismatch` and `requiredEmpty` arrays.

**19. The summary, then the click.** The agent writes what the fill **observed**:
`resume.pdf → _systemfield_resume (label match)`,
`cover-letter.pdf → _systemfield_coverLetter (label match)`, both work-authorisation
radios named with their labels quoted, and "Pronouns" left blank with its reason.
Then `browser_click` on the submit control.

**20. The post-submit page is captured.**
`node src/apply/capture-post-submit.mjs stage --url … --html-file … --board ashby --slug render-postgres-product-engineer`
redacts and stages it. You review it and decide whether to promote it. If you do,
the unattended classifier gains one real Ashby confirmation page and stops being
blind on that host.

**21. The record.**
`node src/applications/log-application.mjs render-postgres-product-engineer --company "Render" --title "Product Engineer, Postgres" --url "<url>"`
writes a row to the `applications` table and immediately regenerates
`profile/applications.yaml` from the whole table.

**22. Afterwards.** `check-applied.mjs` will now refuse a duplicate.
`follow-ups.mjs` will list this application when it is due a nudge.
`src/status.mjs` folds it into the whole-pipeline digest. And
`archive.mjs archive --closed` will eventually fold the whole workspace into the
`documents` table, one row per file with its exact bytes and sha256, and remove
the directory — so `ls jobs/` shows live work only.

**What would have happened on the unattended path instead.** Steps 1–13 are
identical, run by `cycle.mjs`. Then `runJob()` claims the slug, `trustBoard()`
passes because `jobs.ashbyhq.com` is on your allowlist, `walkPages()` produces the
same plan — and `classifyPlanDefers()` sees `confirm` deferrals and terminates the
job as `deferred` with `reason_kind: 'confirm-field'` at stage `plan`. No browser
click. That is precisely what happened to `render-swe-compute-infra` and
`render-user-auth-experience` in the run recorded on 2026-08-04.

---

## 7. The five shapes worth keeping if you rebuild this

If you throw away every line of this code and start again, these are the decisions
that were expensive to learn and cheap to re-adopt.

**1. Facts come from one place and a separate program checks them.** Not a
carefully worded instruction to the model — a program with seven rules that exits
non-zero. The check must hash both the document and the fact corpus, so editing
either invalidates the result.

**2. Third-party text is data at a named boundary.** One function, called at one
place, with a test suite full of hostile inputs. And know what your sanitiser
cannot do: reworded and non-English instructions walk through a pattern list by
design, which is why the load-bearing control is rule 1, not the pattern list.

**3. Every refusal is typed and countable.** A closed enum, validated at write
time, rejecting anything unknown. "Unprobed dropdown" and "dropdown was not
probed" are the same loss and two buckets, and a taxonomy that admits new members
silently is a free-text column with extra steps.

**4. Coordination is one atomic statement whose row count is the answer.** No
distributed lock, no lease server. An `INSERT … ON CONFLICT … WHERE
state = 'queued'`, and `0 changes` means somebody else owns it. Then be extremely
careful about which key that statement is on.

**5. State the current capability, never a file inventory.** Every paragraph in
this repository that said "there is no runner" or "the click is unreachable" is
now false, and each one was written by someone who had just checked. Capability
claims decay within hours; write the claim as a test if it matters, and as a
present-tense observation if it does not.

---

## Where to go next

- **[`./06-data-model.md`](./06-data-model.md)** — the natural next step: every
  table and column in `jobs/leads.db`, every file in a workspace, and the exact
  shape of a lead, a plan, a scan and a fill report.
- **[`./07-safety-model.md`](./07-safety-model.md)** — all ten hard rules, the
  hooks that enforce them, the trust gate, the eleven submit preconditions and the
  post-submit classifier, as one interlocking system.
- **[`./08-glossary.md`](./08-glossary.md)** — every term used here, defined in one
  place, for when you meet one cold.
- **[`../code/00-file-index.md`](../code/00-file-index.md)** — every file in the
  repository with one line on what it does. The index to open when the diagram
  says a name you do not recognise.
- **[`../code/02-leads-finding.md`](../code/02-leads-finding.md)** and
  **[`../code/03-leads-screening.md`](../code/03-leads-screening.md)** — pipeline 1
  in full: every board fetcher, and the L0–L3 stages line by line.
- **[`../code/05-documents.md`](../code/05-documents.md)** — pipeline 2 in full:
  `keyword-plan.mjs`, `assemble-resume.mjs`, `verify-claims.mjs` and `render-pdf.mjs`.
- **[`../code/06-apply-scanning.md`](../code/06-apply-scanning.md)**,
  **[`../code/07-apply-planning.md`](../code/07-apply-planning.md)** and
  **[`../code/08-apply-filling.md`](../code/08-apply-filling.md)** — pipeline 3 in
  full: the scanner, the planner and the engine.
- **[`../code/09-auto-runner.md`](../code/09-auto-runner.md)** and
  **[`../code/10-auto-safety.md`](../code/10-auto-safety.md)** — pipeline 4 in full:
  the state machine, the pool, the click surface, and every guardrail around it.
- **[`../code/11-record-and-profile.md`](../code/11-record-and-profile.md)** — the
  application record, `save-answer.mjs`, and the archive.
- **[`../code/01-lib-foundation.md`](../code/01-lib-foundation.md)** — `db.mjs`,
  `lock.mjs`, `lib.mjs` and `untrusted.mjs`, which everything above sits on.
- **[`../operate/01-commands.md`](../operate/01-commands.md)** and
  **[`../operate/02-recipes.md`](../operate/02-recipes.md)** — the commands for
  each pipeline, and step-by-step recipes for the things you do often.
- **[`../operate/03-troubleshooting.md`](../operate/03-troubleshooting.md)** — what
  to do when a pipeline stops where this document says it can stop.
- **[`../operate/04-config-reference.md`](../operate/04-config-reference.md)** —
  every key in `docs/application-limits.yaml` and `docs/job-sources.yaml`.
- **[`../audit-2026-08-05.md`](../audit-2026-08-05.md)** — the full audit every
  "Known defect" note above is drawn from.
