# 03 — `scripts/leads/`: discovery and screening

Fourteen files. This is where the pipeline is widest (thousands of postings in)
and where most of the hard-won knowledge lives.

---

## `find-jobs.mjs` (1553 lines) — the sweep

The biggest file in the project. Four commands:

```bash
node scripts/leads/find-jobs.mjs search [--source all|hn|boards|adzuna]
                                        [--query "…"] [--max-age N]
                                        [--concurrency 8] [--no-enrich]
                                        [--explain [N]]
node scripts/leads/find-jobs.mjs import <file.json>
node scripts/leads/find-jobs.mjs list [--status new|recommended|dismissed|applied|all]
node scripts/leads/find-jobs.mjs mark <id-or-url> --status <s> [--notes "…"]
```

### Gate 1 — `passesLimits(job, limits, now)`

Reads only what a board's list payload gives you: title, location, date, salary.
Returns `{ ok, reasons[], flags[] }`. **Reasons reject; flags do not.**

Order matters. The **hard filter** runs first and returns immediately — a title
above the experience bar or in the wrong discipline is not worth geocoding,
dating or storing. Then the **soft filter**, which only marks
`title_watch:<term>` so screening reads the body before effort is spent.

**Location** is where the subtlety is:

- `OPAQUE_LOC` — Workday collapses a multi-site posting to the literal string
  `"2 Locations"`, which carries no geography. Treating that as a location
  rejected it, and multi-site postings skew towards exactly the roles worth
  seeing. It flags `unknown_location` instead.
- `US_WIDE_LOCATION` / `matchesAny` — location strings that state **who may be
  hired** rather than where to move. A remote posting open to the whole country
  writes "USA", not "Remote". Without this the gate read `location: "USA"` as a
  relocation and on 2026-07-29 threw out **35 of 35 Remotive, 50 of 50 Jobicy and
  100 of 100 RemoteOK** postings. The test is anchored to the **whole string** —
  a substring match would read "Tulsa, USA" as country-wide remote. Overridable
  via `location.remote_synonyms`.
- `NON_US` vs `US_MARK` — "Remote (Europe)" is still a relocation.
- `remote_source` — a board whose _entire corpus_ is remote roles has already
  answered the question; its postings should not each be re-doubted.

**`title_loose`** is the local-latitude escape hatch. A commutable posting is rare
enough to be worth a look even when its title misses the keyword list — Caesars'
"Staff Engineer - Booking Engine" is a real Las Vegas software job that matched
none of them. Remote postings are **not** given this latitude: there are thousands
and the gate is what keeps them manageable. `LOOSE_TECH_TITLE` widens the net,
`TRADES_TITLE` subtracts the trades — a casino's "engineers" are overwhelmingly
painters, electricians, plumbers and stationary engineers, and "General Engineer"
is a facilities title.

### Gate 2 — `bodyDisqualifiers(job, limits)`

Reads the description. Same return shape, so ingest treats both gates
identically. **A lead with no description passes** — a gate can only speak to text
it actually has.

| check                                 | verdict                                                           | notes                                                    |
| ------------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------- |
| `SOFTWARE_BODY` / `NON_SOFTWARE_BODY` | reject only if non-software evidence **and** no software evidence | otherwise `body_not_technical` flag                      |
| `RELOCATION_REQUIRED`                 | reject                                                            | "must relocate", never "relocation assistance available" |
| `SENIOR_IN_BODY`                      | reject                                                            | a seniority bar the title hid                            |
| `STATE_EXCLUSION`                     | reject **only** if it names the user's own state                  | a list excluding California says nothing about Nevada    |
| `EMPLOYMENT_SHAPE`                    | reject if in `limits.employment.reject_types`, else flag          | contract / temp / part-time / seasonal                   |
| `ONSITE_BODY`                         | flag `onsite_conflict` only                                       | never rejects                                            |

**The "is this a software job?" test is the single easiest thing here to get
wrong.** Job-posting prose is full of near-misses for software words. The first
version matched bare `code` and read Station Casinos' _"Be familiar with OSHA
safety **codes**"_ as evidence that a building-maintenance job was a software job.
`application` (job application), `rest` (the rest of the team), `framework`
(regulatory framework), `library` and `server` all fail the same way and are
excluded on purpose. `SOFTWARE_BODY` therefore contains only multi-word or
unmistakable terms. `NON_SOFTWARE_BODY` says "maintain cleanliness" not
"cleanliness" (code cleanliness) and "beverage server" not "server".

> **When you add a term here, re-run `gate-audit.mjs` and confirm the reject list
> did not grow.** A false reject is a job the user never sees — the worst failure
> this pipeline has.

**Why `ONSITE_BODY` only ever flags:** Twilio's postings carry three mutually
contradictory location sentences pasted in sequence — _"based in our San
Francisco, California office"_, _"remote, based on the East Coast"_, and _"not
eligible to be hired in CA, CT, IL…"_. Any single-sentence match is as likely to
be stale boilerplate as the real requirement.

> **Defect:** `limits.employment.reject_types` does not exist in
> `application-limits.yaml`, so the employment gate can never reject. See AUDIT
> **H6**. `SENIOR_IN_BODY` also false-rejects on ordinary prose — AUDIT **H7**.

### The thirteen board fetchers

Each normalises to `{ id, source, company, title, location, url, posted_at }`
plus optional `description`, `remote`, `remote_source`, `salary_max`.

| type              | endpoint                                                      | description in list?          | paging              |
| ----------------- | ------------------------------------------------------------- | ----------------------------- | ------------------- |
| `greenhouse`      | `boards-api.greenhouse.io/v1/boards/<slug>/jobs?content=true` | **yes** (double-encoded HTML) | none                |
| `lever`           | `api.lever.co/v0/postings/<slug>?mode=json`                   | **yes**                       | none                |
| `ashby`           | `api.ashbyhq.com/posting-api/job-board/<slug>`                | **yes**                       | none                |
| `smartrecruiters` | `api.smartrecruiters.com/v1/companies/<slug>/postings`        | no                            | offset, 100/page    |
| `workable`        | `apply.workable.com/api/v1/widget/accounts/<slug>`            | no                            | none                |
| `recruitee`       | `<slug>.recruitee.com/api/offers/`                            | yes                           | none                |
| `workday`         | `<host>/wday/cxs/<tenant>/<site>/jobs` (POST)                 | no                            | offset, **20/page** |
| `oracle_cloud`    | `<host>/hcmRestApi/…/recruitingCEJobRequisitions`             | partial                       | offset, 200/page    |
| `jobvite`         | XML feed at `app.jobvite.com/CompanyJobs/Xml.aspx?c=<eid>`    | **yes**                       | none                |
| `successfactors`  | HTML scrape of `<host>/search/?…&startrow=N`                  | no                            | 25/page             |
| `jobicy`          | `jobicy.com/api/v2/remote-jobs`                               | yes                           | 50 fixed            |
| `remotive`        | `remotive.com/api/remote-jobs?category=…`                     | yes                           | none                |
| `remoteok`        | `remoteok.com/api`                                            | yes (~500 chars)              | none                |

Hard-won details:

- **Workday reports `total` on the first page only**; every later page reports 0.
  Trusting it each time set `total=0` on page two and ended the loop at 40 of 90 —
  a partial fix that looked like a working one. It also caps a response at 20, so
  unpaged it saw 20 of Light & Wonder's 90 and 20 of Aristocrat's 170: the boards
  looked alive while most of their jobs were invisible.
- **Oracle's `expand=requisitionList` is mandatory.** Without it the response
  still carries an accurate `TotalJobsCount` but an empty list, so the board reads
  as "found, but empty" rather than as a broken query.
- **Jobvite exposes no JSON job list at all.** The only public surface is an
  unauthenticated XML feed, and the feed key (`companyEId`) is **not** the URL
  slug, so it is read once off the careers page. Cloudflare throttles the feed to
  roughly one request per 30 s, which a daily sweep never notices.
- **SuccessFactors renders server-side** — verified by network capture, not
  assumed. `parseSuccessFactorsPage` slices from one title anchor to the next so
  fields cannot bleed across rows, and strips the multi-site suffix
  ("Las Vegas, NV, US, 89113 +1 more…") that would otherwise land in the location.
- **Adzuna's page number is a path segment**, so `search/1` is literally page one;
  the local Las Vegas results were being cut off at 50.
- **RemoteOK row 0 is a legal notice**, not a posting.

`MAX_PAGES = 50` is a runaway backstop only — every paged fetcher stops at the
reported total. 50 pages is ~1000 postings, well clear of the largest board seen
(MGM, 505).

### `dedupeLeads(candidates, existingLeads, applied)`

Returns fresh candidates, **and** — via a `reposts` property on the returned
array — the ones dropped because the store already holds that company+title.

That second return value is not bookkeeping. **Reposting is the strongest
ghost-job signal there is, and this function is where the evidence was being
destroyed:** a posting taken down and put back up arrives with a fresh board id
and a fresh date, matches an existing lead on company+title, and was silently
discarded. The lead store therefore contained **zero** repeated company+title
pairs by construction, so L3's repost check had nothing to read. Ingest now
records the sighting against the lead already stored (`repost_count`,
`first_seen_at`, `last_seen_at`, `last_reposted_at`).

The "array with extras" shape is deliberate: every existing caller destructures or
iterates this as the list of fresh candidates, and changing the shape would touch
the import path, board-yield, discover-boards and three tests for no gain.

### Other exported helpers

```js
matchesAny(value, list)            whole-string, punctuation-insensitive
matchTitleKeyword(title, kws)      \b-anchored; substring would make "sr" hit "usr"
parseSalaryMax(text)               "$150K – $220K" → 220000; <1000 means $K
parseWorkdayPostedOn(text, now)    "Posted 30+ Days Ago" → an ISO date, +15 days
workdayLocationFromPath(path)      "/job/US-CA-Santa-Clara/…" → "US CA Santa Clara"
normUrl(u)                         origin+pathname, lowercased, no trailing slash
loadEnv(file)                      minimal .env parser
backfillDescriptions(cands, leads) fill text onto already-stored leads
```

`parseWorkdayPostedOn` maps "30+" **past** the default freshness gate on purpose —
a month-old posting is stale _and_ a repost/ghost signal.

> **Defect:** `loadEnv` never surfaces a variable that exists only in the real
> environment, contradicting its own comment. AUDIT **H12**.

---

## `stages.mjs` (109 lines) — the pipeline as a registry

```js
STAGE_IDS = ["l0", "l1", "l2", "l3"]
STAGE_LABELS
registerStage(id, run)
evaluateStages(job, ctx, (only = STAGE_IDS))
```

`ctx` carries `{ limits, now, profileYears, profileTech, keywords, history }`.
Each stage sees the flags every earlier stage raised — L1's "did this arrive on a
loose title match?" test depends on L0's flags — which is why `evaluateStages`
threads a growing flag set through `{ ...job, flags: [...flags] }`.

Registration happens here rather than in each check's module to avoid an import
cycle. The checks stay pure functions; this file is the only thing that knows the
order.

---

## `fit.mjs` (268 lines) — L2, "can this profile do this job?"

L0 reads the title. L1 catches hard disqualifiers. Neither can tell a full-stack
role that wants React and Node from one that wants Scala, Spark and a Kafka
cluster — both are titled "Software Engineer", both are remote, both are fresh.
That judgment was being paid for with a model read, per lead, forever.

Three things it does that nothing upstream could:

1. **Required vs preferred.** The whole description used to be one blob, so a
   Kubernetes mention under "Nice to have" counted exactly as much as one under
   "Minimum qualifications". Most postings list an aspirational preferred section;
   scoring against it rejects jobs the user could do.
2. **Responsibility level.** "Define the technical roadmap", "mentor the team",
   "set architectural direction" is a senior posting whatever the title says and
   whatever years it does or does not state.
3. **Stack overlap as a ratio, not a count.** Matching 3 of 4 required
   technologies is a good fit; 3 of 30 is not, and a raw count calls them equal.

### `splitRequirements(text)` → `{ required, preferred, general }`

Section headings are matched **inline, not line-anchored**, because stored
descriptions come from `textSnippet()` and older ones are still flat. A
line-anchored version matched a heading in **0 of 92** real stored leads, which
silently turned the whole required-vs-preferred split into a no-op.

Two tiers:

- **STRONG** — multi-word and unambiguous ("Minimum Qualifications", "What You'll
  Need", "Nice to Have", "Equal Employment Opportunity"). Matches anywhere.
- **WEAK** — a single common word that also appears in prose. "Requirements" is
  the motivating case: _"gathering requirements from stakeholders"_ is a
  **responsibility**, and treating it as the start of the required-skills section
  would score the job against the wrong half of its own description. These count
  only when a `:` or newline marks them as a heading.

Headings are collected by **position** and sliced between, then nested ones are
dropped (the weak "Qualifications" inside a strong "Minimum Qualifications").
Text before the first heading, and text under an unrecognised heading, both land
in `general` rather than being dropped — losing text here would shrink the
required set and make the `min_required_terms` guard fire when it should not.

### The reject, and what makes it safe

L2 **rejects** (user decision, 2026-07-29) rather than only cautioning. Four
things make that acceptable:

- A description naming fewer than `min_required_terms` (default **4**)
  technologies in its required section can **never** be rejected here, however low
  the overlap. A thin description is _unevaluated_, not a bad match. This is the
  single most important number in the file.
- Technologies named only under "nice to have" never count against the profile.
- Every threshold lives in `docs/application-limits.yaml`, which the user owns.
- Every rejection is visible in `gate-audit.mjs`.

```
overlap = matched / requiredTech.size
overlap < reject_below (0.20)                        → REJECT
senior signals ≥ 3 AND overlap < caution_below (.45) → REJECT
overlap < caution_below                              → flag fit_weak
senior signals ≥ 3 alone                             → flag senior_scope
```

Senior scope alone never rejects — plenty of mid-level postings borrow the
language. Senior scope **and** a weak stack match is a different claim.

`indexed` (the lead's `lead_keywords`) is unioned in only to **add** evidence of a
match, never to enlarge the required set — otherwise a preferred-section
Kubernetes would sneak back in as a requirement.

---

## `risk.mjs` (227 lines) — L3, "is this job real?"

Industry research puts ghost jobs at 18–40% of live listings and names
**reposting** as the strongest signal. The pipeline could not see it, because
`dedupeLeads` was destroying the evidence (fixed — see above).

```js
repostKey(job)                  "company::title", normalized
bodyFingerprint(text)           the WHOLE normalized description, ≥200 chars
buildHistory(leads, {now})      { byKey, byFingerprint, now }
scoreRisk(job, history, opts)
RISK_DEFAULTS = { repost_caution: 1, repost_reject: 3, min_substance: 2,
                  min_length_for_ratio: 600, duplicate_body_reject: 3 }
```

**`bodyFingerprint` deliberately fingerprints the whole body, not a prefix.** A
prefix was tried and matched 49 of 102 stored leads — because Coinbase, Grafana
Labs, Twilio and IGT all open every posting with the same company paragraph.
Sharing a boilerplate intro is evidence of a marketing department, not a ghost
job. Two postings whose **entire** body matches are a real signal, and different
roles at the same company always differ once the requirements section is included.

Repost count comes from **two sources**, because they see different halves of the
same thing: `job.repost_count` (sightings recorded at ingest — the real signal,
since the store cannot hold two leads with the same company+title) and
`history.byKey` (near-duplicates that slipped past dedupe, e.g. a hand-imported
lead).

Other checks: `EVERGREEN` phrasing (only `no_current_opening` and `pipeline_req`
reject — the posting telling you outright), `duplicate_body`, a
**boilerplate-to-substance ratio** on descriptions ≥600 chars, and an
`injection_attempt` flag from `sanitizeUntrusted`.

`EVERGREEN` is deliberately narrow: "ongoing recruitment" and "we are growing
fast" are **not** here, because plenty of real postings say them.

> **Defects:** `repost_caution: 1` never fires at exactly 1 (the code uses `>`),
> and the duplicate-body count includes the lead itself while the repost count
> excludes it. AUDIT **L2**, **L3**.

---

## `screen.mjs` (517 lines) — the mechanical screen + the verdict cache

```bash
node scripts/leads/screen.mjs [--status new] [--skip-screened] [--no-record]
                              [--stage l0|l1|l2|l3|all] [--json]
node scripts/leads/screen.mjs record <lead-id> --verdict pass|caution|reject
                              [--reason "…"] [--signals a,b] [--source model]
```

`screenJob()` layers a pattern pass **over** the four stages:

| set                                                          | effect                                                                                                                                                  |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SCAM_PATTERNS`                                              | reject — pay-to-apply, asks for SSN/bank details, offsite chat interview, "no experience needed" + a dollar figure, urgency pressure, guaranteed income |
| `BLOCKER_PATTERNS`                                           | reject — a security clearance is sponsored by an employer you already work for; you cannot obtain one to get the job                                    |
| seniority bar                                                | reject if `extractYearsRequired > profileYears + stretch_years`                                                                                         |
| stale ≥ `repost_age_days`                                    | caution                                                                                                                                                 |
| `CULTURE_PATTERNS` ≥ 3                                       | caution — one is noise, the cluster is the signal                                                                                                       |
| `no_salary` / `unknown_location` / `remote_unverified` flags | caution                                                                                                                                                 |
| thin description / unidentified company                      | caution                                                                                                                                                 |

**`extractYearsRequired` has a load-bearing lookbehind.** With a plain `\b`,
"1.5+ years" matched the "5" (a decimal point is a word boundary) and read an
entry-level 1.5-year bar as a 5-year one — which rejected precisely the junior
postings this profile is looking for. It also requires an experience-ish word
nearby and skips "18 years of age", so a legal-minimum question is never read as a
seniority bar.

`DEFAULT_STRETCH_YEARS = 2`. It was 3, which put the ceiling at 5.5 years for a
2.5-year profile — so the single most common bar in practice, "5+ years", did not
even raise a signal. Of 47 postings read on 2026-07-28 the sweep produced **zero**
seniority rejects while every one of them was in fact out of reach.

The `record` subcommand takes the lead id **positionally**, not as "the first bare
word": scanning for one picked up the _value_ of `--verdict` when the id was left
off, and cheerfully recorded a screen against a lead called "pass".

> **Defect:** `partial_description` is set to `!captured?.description`, which is
> true for nearly every lead, disabling the `thin_description` signal store-wide.
> AUDIT **H5**.

---

## `gate-audit.mjs` (240 lines) — run this after ANY gate change

```bash
node scripts/leads/gate-audit.mjs [--json] [--status all] [--no-save]
```

Re-runs every stage over the whole store and diffs against the last recorded run.
The asymmetry is deliberate: a newly **accepted** lead is a win and gets one line;
a newly **rejected** lead is the dangerous direction, so those are listed in full
with the stage and reason that killed them, every time. Exits **1** when any lead
became newly rejected, so a CI-ish caller notices.

`diffAudit(previous, current)` returns `newlyRejected`, `newlyAccepted`,
`stageMoved`, `gone`, `compared`. A first sighting is neither a regression nor a
win. The baseline lives at `jobs/.gate-baseline.json` — under `jobs/` because that
directory is already gitignored and this is derived state about the user's own
store, not project source.

> **Defect:** saving is the default, so a second run absorbs the regression into
> the baseline and exit 1 never fires again. AUDIT **H14**.

---

## `enrich.mjs` (273 lines) — descriptions for the boards that withhold them

Four of the swept ATS types return a list endpoint with **no description at all**:
`oracle_cloud`, `smartrecruiters`, `successfactors`, `workday`. On 2026-07-29 that
was 19 of 102 stored leads — and not a random 19. Those boards are **Caesars,
Station Casinos, Boyd Gaming, IGT and CVS**, i.e. the local Las Vegas employers,
which are the _highest-value_ leads for a North Las Vegas applicant precisely
because on-site is in scope for them. So the least examinable leads were also the
most important.

What it cost to not have this: Station Casinos' "Junior Engineer - Palace" passed
the title gate on local latitude and sat in the store as a software lead. Its
description is _"Pick up supplies and parts from vendors. Perform all repairs,
maintenance and part replacements… preventive maintenance schedule"_ — a
building-maintenance job. Nothing in the pipeline could see that, because nothing
had the text.

```js
oracleDetailUrl / smartRecruitersDetailUrl / workdayDetailUrl
oracleDescription / smartRecruitersDescription /
successFactorsDescription / workdayDescription
canEnrich(lead)
enrichDescriptions(leads, { concurrency = 6, fetchers })
```

URLs are derived from the **stored lead's own** `url`/`id` rather than from
`job-sources.yaml`, so enrichment also works for a hand-imported lead and a board
removed from the sweep does not orphan the leads it produced. Workday's tenant is
not in the page URL, so it comes from the lead id (`workday:cvshealth:R0977981`).

Latency discipline: these are N extra round trips, one per posting, so they run
**only** for postings that already survived Gate 1 — single digits per sweep, not
the hundreds the list endpoints return. Failures are per-posting and swallowed
(flagging `no_description`): a detail endpoint that 404s must never lose a lead the
sweep already found.

The CLI (`--apply`, dry-run by default) backfills already-stored leads and
**re-indexes their keywords**, since keywords derive from the description and a
lead that just gained one would otherwise have the whole fetch wasted.

`smartRecruitersDescription` drops `companyDescription`: it is identical on every
posting from the board and would crowd the 4000-char snippet cap with boilerplate.

---

## Ranking, grouping and board management

### `recommend.mjs` (214 lines)

```
score = (tech overlap × 2) + titleScore + freshnessScore
        + 2 if salary_max − Σ FLAG_PENALTY
titleScore:     full-stack 6, back-end 4, generic dev 2, else 0
freshnessScore: ≤3d 4, ≤7d 3, ≤14d 2, ≤21d 1, else 0
FLAG_PENALTY:   remote_unverified 3, unknown_location 2, no_salary 1, unknown_age 1
```

Passing `indexed` (the lead's `lead_keywords`) matters more than it looks. Without
it `scoreLead` sees only `lead.title` and `lead.job_text` — and `job_text` exists
only where a job workspace has been created. With no live workspaces (the normal
state, since closing an application folds its directory into `documents`), every
lead was ranked on its title alone while 268 indexed keyword rows sat unread.

### `cluster.mjs` (195 lines)

`similarity = 0.5 × jaccard(titles) + 0.5 × jaccard(keywords)` — the same 50/50
split `reuse-check.mjs` uses, for the same reason: title alone groups a back-end
role with a front-end one because both say "Engineer", and stack alone groups a
senior architect with a junior dev because both say "React".

Greedy **leader** clustering: each lead joins the first cluster whose _leader_ it
resembles. Compared against the leader deliberately, never against any member —
chaining (A~~B, B~~C, A a stranger to C) is how a cluster drifts from "React/Node
full-stack" to "Go platform engineer" one hop at a time, and the resume tailored
for the leader is the one every member would actually be sent with. Order in,
order out: pass ranked leads and the best-scoring lead leads.

> **Defect:** the no-keyword fallback uses `techTermsIn` — the resume-side
> lexicon — on job descriptions. AUDIT **H13**.

### `prep-queue.mjs` (263 lines)

Which leads to tailor **before** the user sits down to apply. Tailoring costs a
subagent several minutes; doing it at apply time puts that on the critical path
with the user watching. A lead is queued when it ranks well, has not been applied
to, and has no verified tailored resume (`DONE_STATUSES` = verified / approved /
rendered).

`--cluster` collapses near-duplicates so a group one resume can serve costs one
queue slot, not four. A covered lead is attached to its leader's `covers` array
**before** the `top` cut-off, not after: a cluster's members rank below its leader
by construction, so stopping at the cut-off would hide exactly the postings the
queued run already serves.

> **Defect:** it never passes `keywords` to `rankLeads` and never calls
> `withJobText`, so tech overlap contributes **zero** to every score. AUDIT **H1**.

### `board-yield.mjs` (202 lines)

Scores every board by how many of its **live** postings actually pass the limits.
A board that lists 200 reqs and none this profile could take is not neutral — it
costs sweep time on every run and buries the reachable leads in noise that then
costs a model read to reject. On 2026-07-28, 41 boards carried 8,576 live postings
and yielded 18 reachable ones (0.21%); 28 boards yielded zero.

`solid` is the number that matters, not `qualifying`: `passesLimits` lets
`remote_unverified` and `unknown_location` through as flags, and every such lead
checked (OpenAI, Ramp) turned out to be Hybrid SF/NYC — a relocation. Counting
them as yield would make office-bound boards look productive.

Reports only. Removing a board is the user's call.

> **Defect:** it re-fetches every board live and never reads the `board_stats`
> history the sweep has been accumulating. AUDIT **H9**.

### `find-boards.mjs` (275 lines)

The **front half** of discovery: company NAME → public board slug. Probes
candidate slugs against the six no-auth ATS APIs and writes
`docs/board-candidates.yaml`. Candidate lists live in `docs/candidates/`
(`fortune500.yaml`, `yc.yaml` from the public yc-oss directory, `local-lv.yaml`).

**It cannot reach Workday / iCIMS / Taleo / Phenom boards** — those need an opaque
tenant host that no slug guess produces, and that is what most large employers and
nearly every local Las Vegas employer uses.

> Slug probing can find the **wrong company**: it tries "spring" for "Spring
> Mobile" and "ultimate" for "Ultimate Fighting Championship", and a board with
> that slug may belong to someone else entirely. Contained because
> `discover-boards.mjs` reports the company and live counts and the user approves
> each addition — never auto-add.

### `discover-boards.mjs` (185 lines)

Proposes new boards, **yield-gated**. Deliberately not a bulk slug crawler: a
candidate must clear the same bar the audit applies to existing boards
(`--min-solid`, default 1) before it is even proposed. `postsBelowSenior()` is the
single best cheap predictor of whether a company is reachable at ~2.5 years — if a
company has never posted below Senior, brand does not matter.

Rejects are printed too, because a silent cap reads as "nothing was out there".
Never edits `job-sources.yaml`.

### `manage-sources.mjs` (250 lines)

```bash
manage-sources.mjs add --type <ats> --slug <s> --company "Name"
manage-sources.mjs remove "<company or slug>"
manage-sources.mjs verify | list
```

`add` **prescreens** with a live API call and refuses duplicates, so the daily
sweep only ever hits boards known to work. A duplicate is the same company name,
_or_ the same type + board identity — and the identity field varies by ATS (`slug`
for most, `tenant` for Workday, `site` for Oracle).

`ENTRY_FIELDS` gives a field order per ATS and **omits** missing fields rather
than writing the string `"undefined"` — which is what silently produced two dead
entries that still prescreened OK.

`docs/job-sources.yaml` is edited **line by line** so its explanatory comments
survive. That only works while every board is one flow-style entry on one line,
which is why the file is in `.prettierignore`: prettier reflows the longer
Workday/Oracle entries into block style and silently breaks the contract.
`writeSourcesText` refuses to persist anything YAML cannot parse back into a board
list.
