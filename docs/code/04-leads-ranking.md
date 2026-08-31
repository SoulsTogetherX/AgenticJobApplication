# Ranking and sources: choosing what to do next

Somewhere in `jobs/leads.db` there are a few dozen job leads. Some are worth
your afternoon and most are not. Two of the six scripts in this document answer
"which of these should I look at, and which deserve a tailored resume written in
advance?" The other four answer the question one level up: "where are these
leads even coming from, and which of those sources are earning their keep?"
Everything here is **deterministic** — plain arithmetic and string matching, no
AI model anywhere in the six files. That is deliberate. The model used to read
every stored lead to pick favourites, which was slow and expensive; now a script
produces a short ranked list and the model only interprets it.

**What you will learn here**

- The exact scoring formula that decides which jobs you are shown — every term,
  every weight, every penalty, and what happens when two leads tie.
- Why a "ranked" list can secretly be an alphabetical list, and the guard that
  now announces it when that happens.
- How a resume gets tailored _before_ you sit down to apply, and why "queued"
  does not mean "applicable".
- The full board-discovery chain: company **name** → board **slug** → yield
  check → an entry in your sweep list.
- How board productivity is measured, and the 0.21% number that the entire
  source pipeline was built around.
- Six real defects that are live in this code today, each marked plainly.

**Before this**

These documents are written to stand alone, but they will land better in this
order:

- [../guide/03-programming-basics.md](../guide/03-programming-basics.md) — what
  a function, a flag and an exit code are.
- [../guide/05-architecture.md](../guide/05-architecture.md) — how the pipeline
  fits together end to end.
- [../guide/06-data-model.md](../guide/06-data-model.md) — the `leads` table and
  the rest of `jobs/leads.db`.
- [01-lib-foundation.md](01-lib-foundation.md) — `mapPool`, `isTerse`,
  `jaccard`, and the other shared helpers this document leans on.
- [02-leads-finding.md](02-leads-finding.md) — the sweep, `passesLimits`, and
  the board fetchers. Half of this document calls into that one.
- [03-leads-screening.md](03-leads-screening.md) — the screening stages that run
  between finding a lead and ranking it.

**The files covered here**

| File                            | Lines | One-line purpose                                                                      |
| ------------------------------- | ----- | ------------------------------------------------------------------------------------- |
| `src/leads/recommend.mjs`       | 291   | Scores every stored lead against your profile and prints the top N in score order.    |
| `src/leads/prep-queue.mjs`      | 263   | Picks which highly-ranked leads should get a resume tailored _before_ you sit down.   |
| `src/leads/find-boards.mjs`     | 275   | Turns company **names** into `{type, slug}` board candidates by probing six ATS APIs. |
| `src/leads/board-yield.mjs`     | 202   | Measures how many of each tracked board's live postings you could actually take.      |
| `src/leads/discover-boards.mjs` | 185   | Yield-gates candidate boards and proposes only the ones that clear the bar.           |
| `src/leads/manage-sources.mjs`  | 282   | The only program that edits `docs/job-sources.yaml` — add, remove, verify, list.      |

---

## The two pipelines, drawn

There are two separate flows here that happen to live in the same directory.

**The ranking pipeline — which jobs you see:**

```text
jobs/leads.db  ──(leads table)──────────┐
               ──(lead_keywords table)──┤
profile/profile.yaml ───────────────────┤──► recommend.mjs ──► ranked list (top N)
docs/application-limits.yaml ───────────┤
jobs/<slug>/job.json (captured text) ───┘

recommend.mjs's rankLeads() ──► prep-queue.mjs ──► tailoring queue (top N)
                                    ▲
                                    ├── jobs/<slug>/context.json (resume status)
                                    ├── applications table (already applied?)
                                    └── cluster.mjs (near-duplicate postings)
```

**The source pipeline — where leads come from:**

```text
company NAMES (docs/candidates/*.yaml)
        │
        ▼
find-boards.mjs      "does Acme have a public board? which ATS? what slug?"
        │  writes docs/board-candidates.yaml
        ▼
discover-boards.mjs  "would that board actually produce a job I could take?"
        │  prints proposals only — never edits anything
        ▼
manage-sources.mjs   "add it" — live prescreen, duplicate refusal, line-by-line edit
        │  writes docs/job-sources.yaml
        ▼
find-jobs.mjs search (the daily sweep — documented in 02-leads-finding.md)
        │
        ▼
board-yield.mjs      "which of the boards I already track are dead weight?"
                     prints proposed removals — never edits anything
```

Notice the deliberate asymmetry at the bottom: **only `manage-sources.mjs`
writes `docs/job-sources.yaml`.** `board-yield.mjs`, `discover-boards.mjs` and
`find-boards.mjs` all end their runs by _printing a shell command for you to
run_. That is stated in all three files' headers. `docs/job-sources.yaml` is
your policy file — which employers this pipeline watches is your decision, in
exactly the same spirit as `docs/application-limits.yaml`.

> A note on jargon before we start. An **ATS** is an "applicant tracking system"
> — the software a company rents to run its hiring. Greenhouse, Lever, Ashby,
> Workday and about nine others each host thousands of employers' job boards.
> A **slug** is the short, URL-safe name a company gets inside one of those
> systems: Anthropic's Greenhouse board lives at
> `boards-api.greenhouse.io/v1/boards/anthropic/jobs`, so its slug is
> `anthropic`. Some ATSs instead key on a **tenant** and a **host** (Workday) or
> a **host** and a **site** (Oracle Cloud), which is why the board entries in
> this system are not all the same shape.

---

## 1. `src/leads/recommend.mjs` — the ranking formula

### 1.1 What it is and why it exists

This file reads every stored job lead, gives each one a whole number as a score,
sorts by that number, and prints the best few. Its own header states the formula
in shorthand:

```js
// Score = tech overlap with the profile + role-title fit + freshness
//         + salary signal - risk flags.
```

Without it, "which of my 51 stored leads should I look at?" is a job for the AI
model — which means feeding every stored lead's title, description and location
into the model's context on every single run. The header records exactly that
reasoning:

```js
// Rank stored leads against the profile — deterministically, no LLM. This is
// the job the model used to do by reading every lead; now it only interprets
// a short ranked list (or nothing at all, if the user just runs it).
```

`CLAUDE.md`'s token-discipline rule names it directly: _"Never hand-read the
lead store, re-rank leads, or re-derive status."_ And the `find-jobs` skill
tells the agent, under "Recommending": _"Rank deterministically first — do not
read the lead store by hand ... Add judgment only on top of that ranking."_

It is also the scoring engine for `prep-queue.mjs`, which imports `rankLeads`
from here. So this one file decides both **what you are shown** and **what gets
a resume tailored for it.**

### 1.2 How you run it

```bash
node src/leads/recommend.mjs --top 10
node src/leads/recommend.mjs --status all --json
```

Here is a real run against the live store, three leads deep:

```console
$ node src/leads/recommend.mjs --top 3
26|jobicy:148197|Lingraphica|Software Engineer - Unity|match:AI/LLM integration,AWS,Agile,Git,Node.js,PostgreSQL,Python,React,React Native|gap:C#,CI/CD,Data modeling,Firebase,Jira,Machine Learning,REST APIs,Vercel|https://jobicy.com/jobs/148197-software-engineer-unity
22|adzuna:5828399177|Shyra tech LLC|Full Stack .NET Developer|match:Git,JavaScript,React,Testing,TypeScript|gap:Angular,Azure,C#,CI/CD,HTML/CSS,Microservices,REST APIs,SQL,Security|https://www.adzuna.com/land/ad/5828399177?...
20|adzuna:5828111802|Analytics Solutions|Full stack Engineer- W2|match:AI/LLM integration,Node.js,React,Testing|gap:CI/CD,Microservices|https://www.adzuna.com/land/ad/5828111802?...
ranked=3 of=51
```

That compact, pipe-separated shape is **terse mode**. Every script in this
domain picks one of three output shapes the same way, via `isTerse()` in
`src/lib/lib.mjs`:

| Mode     | Selected when                                       | Shape                                                          |
| -------- | --------------------------------------------------- | -------------------------------------------------------------- |
| `--json` | `--json` is present                                 | `JSON.stringify(x, null, 2)` — machine-readable.               |
| terse    | stdout is a pipe (an agent), or `--quiet` is passed | one delimited record per row, then a `key=value` summary line. |
| human    | stdout is a terminal, or `--verbose` is passed      | prose, padding, explanations.                                  |

"stdout is a pipe" means the output is going into another program rather than to
your screen. Node reports this as `process.stdout.isTTY` being false. Because an
AI agent always reads a script's output through a pipe, agents get the compact
form automatically — which is why `CLAUDE.md` says **never pass `--verbose` from
a tool call**.

The same run in a terminal prints three lines per lead instead:

```text
[26] Lingraphica — Software Engineer - Unity
  Remote (USA) | matches: AI/LLM integration, AWS, Agile, Git, Node.js, ...
  https://jobicy.com/jobs/148197-software-engineer-unity

Top 3 of 51 lead(s) with status "new".
```

**As a library.** `src/leads/prep-queue.mjs` does
`import { rankLeads } from "./recommend.mjs"`. That is possible because of the
guard at the bottom of the file:

```js
const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (isMain) main()
```

`process.argv[1]` is the file path you typed on the command line. The guard says
"run `main()` only if _this_ file is the one that was launched." Without it,
importing `rankLeads` into `prep-queue.mjs` would also fire off the whole
command-line program as a side effect.

### 1.3 Everything it exposes

**Exported functions.** ("Exported" means other files may `import` it. A
"signature" is the function's name plus the parameters it accepts, in order.)

| Signature                                            | Returns                                       | What it does                                                  |
| ---------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------- |
| `titleScore(title, opts = {})`                       | number                                        | Role-title fit. `opts.limits` may carry a custom rank ladder. |
| `freshnessScore(postedAt, now = new Date())`         | number 0–4                                    | Points for how recently the job was posted.                   |
| `scoreLead(lead, profileTech, now, indexed, limits)` | a scored row object                           | The whole formula for one lead.                               |
| `rankLeads(leads, profileBlob, opts = {})`           | array of scored rows, sorted and cut to `top` | Score everything, sort, slice.                                |
| `isFlatRanking(ranked)`                              | boolean                                       | True when every returned lead scored the same — see §1.6.     |

`FLAG_PENALTY` and `DEFAULT_TITLE_RANK` are constants inside the file and are
**not** exported.

**CLI flags.**

| Flag                             | Default                       | Meaning                                                                                     |
| -------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------- |
| `--top N`                        | `10`                          | How many leads to print.                                                                    |
| `--status new\|recommended\|all` | `"new"`                       | Which stored leads to consider. `all` disables the filter; anything else is exact-match.    |
| `--json`                         | off                           | Dump the ranked array as JSON. Skips the flat-ranking warning on purpose (§1.6).            |
| `--leads <path>`                 | `resolveLeadSource().file`    | Which lead store to read. An explicit path is honoured verbatim, so tests can use fixtures. |
| `--profile <path>`               | `<repo>/profile/profile.yaml` | The fact base supplying "what tech do I know".                                              |
| `--jobs-dir <path>`              | `<repo>/jobs`                 | Where per-job workspaces live, for the captured-posting enrichment.                         |

**Exit codes.** An exit code is the number a program hands back to whatever
launched it; `0` means success by universal convention.

| Code | When                                                                      |
| ---- | ------------------------------------------------------------------------- |
| `0`  | Ranked and printed — including a ranking that turned out entirely flat.   |
| `2`  | `profile not found at <path>`                                             |
| `2`  | `no lead store at <path> — run a search first`                            |
| `2`  | `no leads with status "<status>"` — the store exists but nothing matched. |

There is deliberately **no** exit code for "the keyword index was unavailable" or
"application-limits.yaml was unreadable". Both print a `warn:` line to stderr
and the run continues on fallback values. A missing optional input must not cost
you your whole ranking.

### 1.4 The formula, term by term

This is the section that matters most in this document. The entire computation
is five lines inside `scoreLead()`:

```js
let score = 0
score += overlap.length * 2 // TERM 1
score += titleScore(lead.title, { limits }) // TERM 2
score += freshnessScore(lead.posted_at, now) // TERM 3
if (lead.salary_max) score += 2 // TERM 4
for (const f of lead.flags ?? []) score -= FLAG_PENALTY[f] ?? 0 // TERM 5
```

Exactly five terms. Nothing else contributes. The score is a whole number and is
unbounded above — a posting naming twenty technologies you have scores +40 from
term 1 alone.

#### Term 1 — tech overlap, `+2` per matched technology

```js
const text = [lead.title, lead.job_text].filter(Boolean).join("\n")
const leadTech = new Set([...extractTech(text), ...(indexed ?? [])])
const overlap = [...leadTech].filter((t) => profileTech.has(t))
const missing = [...leadTech].filter((t) => !profileTech.has(t))
score += overlap.length * 2
```

A **`Set`** is a JavaScript collection that holds each value at most once, so
building one from two sources merges them and removes duplicates in one step.

Three pieces feed this:

- **`profileTech`** — `extractTech(profileBlob)`, where `profileBlob` is every
  string anywhere in `profile/profile.yaml` flattened into one newline-joined
  blob by `profileText()`. That function recursively walks the YAML structure
  and collects every string it finds; it lives in
  `src/profile/profile-gaps.mjs`.
- **`extractTech`** — in `src/lib/keywords.mjs`. It walks a curated table of
  `{ name, re }` pairs — a canonical skill name and a loose **regular
  expression** (a compact pattern language for describing text to search for;
  `\d{4}` means "four digits in a row") that matches how that skill shows up in
  somebody else's job posting, so `k8s` finds Kubernetes. It returns a `Set` of
  canonical names.
- **`indexed`** — the lead's pre-extracted keywords from the `lead_keywords`
  table, computed once at ingest from title + description + requirements.

That third input is load-bearing, and its comment explains a real measured
failure:

```js
// `indexed` is the lead's keyword set from the lead_keywords table, extracted
// once at ingest from title + description + requirements. Passing it in matters
// more than it looks: without it this function sees only `lead.title` and
// `lead.job_text`, and job_text exists ONLY where a job workspace has been
// created. With no live workspaces — the normal state, since closing an
// application folds its directory into the documents table — every lead was
// being ranked on its title alone while 268 indexed keyword rows sat unread.
//
// The two sources are unioned rather than one preferred: the index covers leads
// that have no workspace, and a captured posting is richer than the description
// snippet the sweep stored.
```

The measured effect of fixing that, recorded in
`tests/leads/keyword-wiring.test.mjs`: leads contributing no tech signal fell
from **81 of 102 to 28**, and the top-ranked lead changed.

`missing` — the technologies the posting wants that your profile does not
evidence — is computed and reported but **contributes nothing to the score**. It
is output only, so you can see the gap.

#### Term 2 — role-title fit, `titleScore()`

```js
export function titleScore(title, opts = {}) {
  const groups = opts.limits?.roles?.title_rank ?? DEFAULT_TITLE_RANK
  const t = String(title ?? "")
  const n = groups.length
  for (let i = 0; i < n; i++) {
    const terms = Array.isArray(groups[i]) ? groups[i] : [groups[i]]
    if (matchTitleKeyword(t, terms)) return (n - i) * 2
  }
  return 0
}
```

**The weight is derived from position, not written down anywhere.** A list of
`n` groups scores rank `i` at `(n - i) * 2`. The built-in fallback ladder:

```js
const DEFAULT_TITLE_RANK = [
  ["full-stack", "full stack", "fullstack"],
  ["back-end", "back end", "backend"],
  ["software engineer", "web developer", "developer"],
]
```

Three groups, so the scores are **6 / 4 / 2 / 0**:

| Title                         | Score | Why                     |
| ----------------------------- | ----- | ----------------------- |
| `Senior Full-Stack Developer` | 6     | group 0 → `(3 - 0) * 2` |
| `Backend Engineer`            | 4     | group 1 → `(3 - 1) * 2` |
| `Software Engineer`           | 2     | group 2                 |
| `Web Developer`               | 2     | group 2                 |
| `Developer`                   | 2     | group 2                 |
| `Marketing Manager`           | 0     | nothing matched         |

Every one of those six is asserted in `tests/leads/title-rank.test.mjs`.

**First match wins — the scores are mutually exclusive.** `Full-Stack Developer`
contains both "full-stack" _and_ "developer" and scores **6, not 8**:

```js
// Checked in rank order and the FIRST group to match wins (mutually
// exclusive, matching the old if/else-if chain): a title naming both
// "full-stack" and "developer" scores as full-stack, not their sum.
```

**Retargeting.** The whole ladder can be replaced by `roles.title_rank` in
`docs/application-limits.yaml`. Setting it **replaces** the built-in; it never
merges. The test proves this by checking that `Full-Stack Developer` scores **0**
under a nursing ladder. And because the weight comes from list length, a
five-group list produces a 10/8/6/4/2 spread with no numbers you have to invent.

> **As of 2026-08-05, `roles.title_rank` is NOT present in
> `docs/application-limits.yaml`.** So the software ladder above is what is
> actually in force today. The same is true of `roles.search_query`, which
> `manage-sources.mjs` looks for (§6.3).

The word matching is done by `matchTitleKeyword`, imported from
`src/leads/find-jobs.mjs`:

```js
export function matchTitleKeyword(title, keywords) {
  return (keywords ?? []).find((k) => {
    const esc = String(k)
      .toLowerCase()
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    return new RegExp(`\\b${esc}\\b`, "i").test(title)
  })
}
```

`\b` is a **word boundary** — the invisible seam between a letter and a
non-letter. Without it, substring matching would make `"sr"` hit `"usr"` and
`"lead"` hit `"leading"`. The `.replace(...)` line escapes any regex-special
characters in the keyword, so a keyword like `"c++"` is searched for literally
rather than being interpreted as a pattern. Note that this builds a brand new
`RegExp` object on every call for every keyword, which inside the ranking loop
means one compile per (lead × title-rank group).

> **This comment is the best single lesson in the repository. Read it twice.**
>
> ```js
> // THE BUG THIS REPLACES: this comment used to claim the ladder "comes from
> // docs/application-limits.yaml". It did not read that file at all — four
> // identically-scored nursing leads (a retarget) silently fell through to
> // alphabetical-by-company and were shown as a "ranked" list. Fixed by
> // actually reading it, with the software ladder preserved as the fallback.
> ```
>
> A comment described behaviour the code did not have, and nothing failed
> loudly. The list still printed. It was simply alphabetical, wearing a
> ranking's clothes. This is why the accuracy rule for this whole documentation
> set is "describe what the code does today, not what a comment says it should".

#### Term 3 — freshness, a step function on posting age

A **step function** is one that returns a fixed value across a whole band of
inputs and then jumps, rather than sliding smoothly.

```js
export function freshnessScore(postedAt, now = new Date()) {
  if (!postedAt) return 0
  const d = new Date(postedAt)
  if (Number.isNaN(d.getTime())) return 0
  const days = (now.getTime() - d.getTime()) / 86400000
  if (days <= 3) return 4
  if (days <= 7) return 3
  if (days <= 14) return 2
  if (days <= 21) return 1
  return 0
}
```

| Age of posting                               | Points |
| -------------------------------------------- | ------ |
| 0–3 days                                     | +4     |
| more than 3, up to 7 days                    | +3     |
| more than 7, up to 14 days                   | +2     |
| more than 14, up to 21 days                  | +1     |
| 22+ days, or no date, or an unparseable date | 0      |

`86400000` is the number of milliseconds in a day (24 × 60 × 60 × 1000).
`Number.isNaN(d.getTime())` is how JavaScript detects "this string was not a
date": an invalid `Date` object still exists as an object, it just reports `NaN`
("not a number") for its timestamp.

A lead older than 30 days would normally never reach the store at all —
`passesLimits` in `find-jobs.mjs` rejects on `freshness.max_age_days`, which is
`30` in `docs/application-limits.yaml`. So this term discriminates inside a
0–30-day window only.

#### Term 4 — salary signal, a flat `+2` for _having_ a number

```js
if (lead.salary_max) score += 2
```

That is the whole term. It rewards the **presence** of a `salary_max` field, not
its size. A $65,000 posting and a $260,000 posting score identically here.
Because `if (lead.salary_max)` is a **truthiness** test (JavaScript treats `0`,
`""`, `null` and `undefined` as false), a `salary_max` of literal `0` scores
nothing — which is the behaviour you want.

`salary_max` is populated by the Adzuna aggregator path and by boards that
publish compensation. Most company boards do not, so this term is mostly a
tiebreaker between aggregator leads and board leads.

#### Term 5 — risk flags, subtractive

```js
const FLAG_PENALTY = {
  remote_unverified: 3,
  unknown_location: 2,
  no_salary: 1,
  unknown_age: 1,
}
// ...
for (const f of lead.flags ?? []) score -= FLAG_PENALTY[f] ?? 0
```

The `?? 0` at the end means **any flag not in that table subtracts nothing**, and
does so silently. What the four that do count mean:

| Flag                | Penalty | Meaning                                                                                                         |
| ------------------- | ------- | --------------------------------------------------------------------------------------------------------------- |
| `remote_unverified` | −3      | The board's own flag says remote, but the location string names an office city.                                 |
| `unknown_location`  | −2      | The location field carried no geography at all — Workday's literal `"2 Locations"`, or Cloudflare's `"Hybrid"`. |
| `no_salary`         | −1      | Only ever set when you have configured `compensation.min_salary`. That is `null` today, so this never fires.    |
| `unknown_age`       | −1      | No posting date, or one that would not parse.                                                                   |

`remote_unverified` carries the biggest penalty because it is the most expensive
lie. `board-yield.mjs`'s own comment records the measurement: _"on 2026-07-28
every such lead checked (OpenAI, Ramp) turned out to be Hybrid SF/NYC — a
relocation."_

**Flags that exist but carry no ranking penalty.** `passesLimits` also produces
`title_watch:<keyword>` and `title_loose`; the body gate adds
`body_not_technical`, `employment:<kind>` and `onsite_conflict`;
`src/leads/fit.mjs` adds `fit_unknown`, `lexicon_blind`, `posting_thin`,
`fit_weak`, `senior_scope`; `src/leads/risk.mjs` adds `repost`,
`duplicate_body`, `evergreen`, `injection_attempt`, `vague_scope`. None of them
change a score. `title_watch:` could not match this table even if you added it,
because the flag string embeds the matched keyword (`title_watch:qa`) and a
plain object-key lookup only matches the exact string.

### 1.5 The sort and the tiebreak

```js
export function rankLeads(
  leads,
  profileBlob,
  { top = 10, now = new Date(), keywords = null, limits = null } = {},
) {
  const profileTech = extractTech(profileBlob)
  return leads
    .map((l) => scoreLead(l, profileTech, now, keywords?.get(l.id), limits))
    .sort((a, b) => b.score - a.score || a.company.localeCompare(b.company))
    .slice(0, top)
}
```

- **Primary sort:** `b.score - a.score` — descending by score. A **comparator**
  is a function that takes two items and returns a negative number if the first
  should come earlier, positive if later, zero if they tie.
- **Tiebreak:** `a.company.localeCompare(b.company)` — ascending alphabetical by
  company name. The `||` fires only when the first comparison produced `0`.
- **There is no third tiebreak.** Two leads with the same score at the same
  company keep whatever order the store handed over — which for SQLite's
  `SELECT * FROM leads` with no `ORDER BY` is formally unspecified.
- `.slice(0, top)` cuts to N **after** sorting, not before.
- `profileTech` is computed **once** for the whole run and reused for every
  lead. That is the only caching in the file.
- `keywords?.get(l.id)` uses **optional chaining** (`?.`): if `keywords` is
  `null`, the whole expression evaluates to `undefined` instead of crashing, and
  `scoreLead`'s `indexed ?? []` then treats it as an empty set.

### 1.6 The flat-ranking honesty guard

This is the most important non-obvious thing in the file.

```js
export function isFlatRanking(ranked) {
  return ranked.length > 1 && ranked.every((r) => r.score === ranked[0].score)
}
```

with its comment:

```js
// Honest-output guard for the ranking-honesty interim (P2): when every lead in
// the returned list ties, sorting fell through entirely to
// alphabetical-by-company, and the list is NOT a ranking, however it is
// labelled. Measured cause: four nursing leads scored 4, 4, 4, 4 — identical —
// because DEFAULT_TITLE_RANK's software vocabulary matches nothing in a
// retargeted title, so titleScore contributes 0 to every one of them, same as
// every OTHER scoring input tying. Pure length/score check, not tied to any
// one cause, so it still catches a flat list for a reason nobody anticipated.
```

`length > 1` is deliberate: a one-item list has nothing to fall through _to_, so
it is never "flat".

What it does in each output mode:

- **human** — prints a multi-line `NOTE:` beginning _"every lead below scored
  identically ... this is NOT a ranking, it fell through to alphabetical order
  by company"_, and appends `— UNRANKED (all tied)` to the summary line.
- **terse** — appends `flat=true` to the `ranked=N of=M` summary.
- **`--json`** — deliberately skipped, with the reason stated in the code:
  _"a raw data dump for a caller who has the scores themselves and can compute
  this the same way."_

### 1.7 A worked example: two contrasting leads

Say the store holds these leads with `status: "new"`. `now` is
`2026-08-05T12:00:00Z`. Your profile evidences
`{React, Node.js, TypeScript, PostgreSQL, AWS, Playwright, Python}`. There is no
`roles.title_rank` in `application-limits.yaml`, so `DEFAULT_TITLE_RANK` applies.

**Lead A** — a good one.

```json
{
  "id": "gh:4411",
  "company": "Airtable",
  "title": "Full Stack Engineer",
  "location": "Remote (US)",
  "url": "https://boards.greenhouse.io/airtable/jobs/4411",
  "posted_at": "2026-08-03T00:00:00Z",
  "salary_max": 210000,
  "flags": []
}
```

with `lead_keywords` for `gh:4411` =
`{React, TypeScript, PostgreSQL, GraphQL, Kubernetes}`.

| Term              | Working                                                             | Points |
| ----------------- | ------------------------------------------------------------------- | ------ |
| 1 — tech overlap  | overlap = `{React, TypeScript, PostgreSQL}` = 3 matches, × 2        | **+6** |
| 2 — title fit     | `"Full Stack Engineer"` matches group 0 (`"full stack"`), `(3-0)*2` | **+6** |
| 3 — freshness     | 2 days old → the `days <= 3` band                                   | **+4** |
| 4 — salary signal | `salary_max` is 210000, which is truthy                             | **+2** |
| 5 — risk flags    | no flags                                                            | **−0** |
|                   | **TOTAL**                                                           | **18** |

`missing_tech` reports `{GraphQL, Kubernetes}` — visible in the output, worth
zero points.

**Lead B** — a plausible-looking one that the formula correctly demotes.

```json
{
  "id": "ashby:9c2",
  "company": "Ramp",
  "title": "Software Engineer, Backend",
  "location": "New York, NY",
  "url": "https://jobs.ashbyhq.com/ramp/9c2",
  "posted_at": "2026-07-25T00:00:00Z",
  "flags": ["remote_unverified"]
}
```

with `lead_keywords` = `{TypeScript, AWS, Go}`.

| Term              | Working                                                                            | Points |
| ----------------- | ---------------------------------------------------------------------------------- | ------ |
| 1 — tech overlap  | overlap = `{TypeScript, AWS}` = 2 matches, × 2                                     | **+4** |
| 2 — title fit     | contains `"backend"` (group 1) **and** `"software engineer"` (group 2); first wins | **+4** |
| 3 — freshness     | 11 days old → the `days <= 14` band                                                | **+2** |
| 4 — salary signal | no `salary_max` field                                                              | **+0** |
| 5 — risk flags    | `remote_unverified` → −3                                                           | **−3** |
|                   | **TOTAL**                                                                          | **7**  |

**What the contrast teaches.** The gap between 18 and 7 is not one big factor —
it is four small ones stacking. Airtable wins on tech (+2), on title (+2),
on freshness (+2), on having published a salary (+2), and Ramp loses another 3
on a location claim the board could not back up. Term 2 is where a careful reader
should stop: `Software Engineer, Backend` scores 4 rather than 6 because
"backend" outranks "software engineer" in the ladder, and rather than 6 (4 + 2)
because the ladder is mutually exclusive. Get either of those wrong when
rebuilding and every backend role quietly outranks every full-stack one.

Sorted output: **Airtable (18), then Ramp (7).** No tie, so `localeCompare` never
fires and `isFlatRanking` is false.

**The tie scenario, to make §1.6 concrete.** Change both titles to
`Registered Nurse`, remove the dates, salaries and flags, and give neither any
recognised tech. Both scores become **0**. The sort falls entirely through to
`localeCompare`, producing Airtable → Ramp — alphabetical order wearing a
ranking's clothes. `isFlatRanking` returns true, and the CLI says so out loud.
That is exactly the incident the guard was built for.

### 1.8 What it reads and writes

**It writes nothing.** It issues only `SELECT` statements and closes the database
in a `finally` block (a `finally` block runs whether or not the code before it
threw an error, which is how you guarantee a resource is released).

| Source                                  | What it takes                                                                                                                                                                                                                                                                                                            |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `jobs/leads.db` → `leads` table         | Columns `id`, `status`, `company`, `title`, `posted_at`, `doc`. The five named columns are denormalized copies for indexing; **`doc` holds the complete lead object as JSON text.** `readLeadStore` runs `SELECT * FROM leads` and returns `{ leads: rows.map(rowToLead) }`, where `rowToLead` is `JSON.parse(row.doc)`. |
| `jobs/leads.db` → `lead_keywords` table | `lead_id TEXT NOT NULL, keyword TEXT NOT NULL, PRIMARY KEY (lead_id, keyword)`. Loaded whole by `keywordMap(db)` in one query — `SELECT lead_id, keyword FROM lead_keywords ORDER BY lead_id` — into a `Map<lead_id, Set<keyword>>`.                                                                                     |
| `profile/profile.yaml`                  | Read with `loadYamlFile`, flattened by `profileText`. Never modified — `CLAUDE.md` rule 2 forbids the agent editing `profile/`, and a hook blocks it.                                                                                                                                                                    |
| `docs/application-limits.yaml`          | Via `loadLimits()`. Only `roles.title_rank` is consulted here. Failure is non-fatal.                                                                                                                                                                                                                                     |
| `jobs/<slug>/job.json`                  | Via `withJobText`. Reads `source_url`, `description`, `requirements`.                                                                                                                                                                                                                                                    |

One query for the whole keyword table rather than one per lead is worth naming:
issuing N+1 database queries where 1 would do is a classic performance mistake,
and with 51 leads it is the difference between one round trip and 52.

**The JSON shape from `scoreLead`**, which is what `--json` prints, one per lead:

```json
{
  "id": "gh:4411",
  "company": "Airtable",
  "title": "Full Stack Engineer",
  "location": "Remote (US)",
  "url": "https://boards.greenhouse.io/airtable/jobs/4411",
  "posted_at": "2026-08-03T00:00:00Z",
  "score": 18,
  "matched_tech": ["PostgreSQL", "React", "TypeScript"],
  "missing_tech": ["GraphQL", "Kubernetes"],
  "flags": []
}
```

`matched_tech` and `missing_tech` are both sorted with a bare `.sort()`, which in
JavaScript compares by UTF-16 code unit rather than by dictionary order. That is
why the real output above reads `AI/LLM integration, AWS, Agile` — capital `W`
sorts before lowercase `g`. Cosmetic, but do not "fix" it into a locale sort
without knowing that the tests read these arrays.

### 1.9 Traps and things not to "fix"

**(a) The keyword index is best-effort, and its absence is warned but not
fatal.**

```js
let keywords = null
if (String(leadsPath).endsWith(".db")) {
  try {
    /* openDb, keywordMap, close */
  } catch (e) {
    console.error(`warn: keyword index unavailable (${e.message})`)
  }
}
```

A JSON fixture store — what the tests point at — has no `lead_keywords` table, so
the `.endsWith(".db")` guard skips the whole block and scoring degrades to
title-plus-`job_text`. The comment says this is intended.

**(b) `withJobText` joins on the URL, not on a slug.**

```js
return leads.map((l) => ({ ...l, job_text: texts.get(l.url) }))
```

The join key is `job.source_url === lead.url`, **exact string equality**. A URL
that differs by a trailing slash or a tracking parameter will not join. The
function reads every workspace directory from disk on every run whether or not
any lead matches, and its `catch {}` swallows a corrupt `job.json` rather than
crashing — one broken workspace must not hide every lead.

**(c) `--top` with no value silently shows one lead.** The argument parser is
five lines:

```js
function flag(args, name) {
  const i = args.indexOf(name)
  return i !== -1 ? (args[i + 1] ?? true) : null
}
```

If `--top` is the last word you typed, `args[i + 1]` is `undefined` and the `??`
substitutes the boolean `true`. Then `Number(flag(args, "--top") || 10)` is
`Number(true)`, which is **1**. So `recommend.mjs --top` prints one lead, not
ten. `board-yield.mjs`, `discover-boards.mjs`, `find-boards.mjs` and
`manage-sources.mjs` all use a different helper with the same job that falls back
to the documented default instead:

```js
function getFlag(args, name, fallback = null) {
  const i = args.indexOf(name)
  return i !== -1 && args[i + 1] !== undefined ? args[i + 1] : fallback
}
```

Two spellings of the same idea live side by side in one directory, and the
difference is observable. The second is the better one.

**(d) Defaults resolve through `resolveLeadSource()`, which prefers SQLite.**

```js
export function resolveLeadSource(explicit = null) {
  if (explicit)
    return { kind: explicit.endsWith(".db") ? "db" : "json", file: explicit }
  if (fs.existsSync(DB_PATH)) return { kind: "db", file: DB_PATH }
  return { kind: "json", file: JSON_PATH }
}
```

`CLAUDE.md` warns: _"There is no standing `jobs/leads.json`."_ The JSON path is
a legacy fallback for an unmigrated repo and for test fixtures.

**(e) It never marks anything.** Ranking does not change a lead's `status`.
Marking a lead `recommended` or `dismissed` is a separate command:
`node src/leads/find-jobs.mjs mark <id> --status recommended`.

**(f) `--status` is an exact string match** unless it is `all`. There is no "new
or recommended" mode. The default is `"new"`, so a lead already marked
`recommended` disappears from the default view.

### 1.10 Dependencies and dependents

**Imports:** `node:fs`, `node:path`, `node:url`; `../lib/lib.mjs`
(`loadYamlFile`, `isTerse`); `../profile/profile-gaps.mjs` (`extractTech`,
`profileText` — `extractTech` is itself re-exported from `../lib/keywords.mjs`);
`../lib/db.mjs` (`readLeadStore`, `resolveLeadSource`, `openDb`, `keywordMap`);
`./find-jobs.mjs` (`matchTitleKeyword`, `loadLimits`).

**Imported by:** `src/leads/prep-queue.mjs` (`rankLeads`);
`tests/leads/title-rank.test.mjs`, `tests/leads/keyword-wiring.test.mjs`,
`tests/leads/efficiency-tools.test.mjs`.

---

## 2. `src/leads/prep-queue.mjs` — what to tailor in advance

### 2.1 What it is and why it exists

Tailoring a resume takes a subagent several minutes. If that happens while you
are sitting at the application form, those minutes are on the critical path with
you watching a blank screen. If it happens during the overnight sweep instead,
applying becomes a fill-and-review step. This script picks the targets. The
header is the argument in full:

```js
// Tailoring a resume takes a subagent a few minutes. Doing it at apply time
// puts that on the critical path with the user watching; doing it during the
// nightly sweep makes applying a fill-and-review step instead. This script
// picks the targets — it does no tailoring itself (that needs a model).
//
// A lead is queued when it ranks well, has not been applied to, and has no
// verified tailored resume yet.
```

This is the clearest example in the whole codebase of "script first, model
second": the _selection_ is deterministic and free, the _tailoring_ is the one
irreducibly model-shaped step.

### 2.2 How you run it

```bash
node src/leads/prep-queue.mjs --top 5 --cluster --json
```

Three things call it by name:

1. `.claude/skills/pipeline-jobs/SKILL.md` — the exact command above, followed by
   a table mapping each row's `reason` to what the subagent should do.
2. `src/auto/cycle.mjs` — the unattended cycle runs it as stage 3 and parses
   its JSON:

   ```js
   const prep = step("src/leads/prep-queue.mjs", [
     "--top",
     String(top),
     "--cluster",
     "--json",
   ])
   // ...
   queue = JSON.parse(prep.stdout || "[]")
   ```

3. `.claude/skills/apply-job/SKILL.md` — cited as what keeps apply-time latency
   down.

### 2.3 Everything it exposes

**Exported functions.**

| Signature                       | Returns                  | What it does                                                       |
| ------------------------------- | ------------------------ | ------------------------------------------------------------------ |
| `indexWorkspaces(jobsDir)`      | `Map<source_url, entry>` | Index every job workspace by the posting URL it was created from.  |
| `buildQueue(rankedLeads, opts)` | array of queue entries   | The filter loop: drop covered, applied and already-tailored leads. |

`indexWorkspaces` requires a `job.json` in each subdirectory — a directory
without one is not a workspace and is skipped. Its comment explains the design:
_"Index every job workspace by the posting URL it was created from, so a lead
can be told apart from an untouched one without guessing at slug naming."_ It
produces:

```js
{
  slug,                                  // the directory name
  company: job.company,
  title: job.title,
  resume_status: ctx?.resume?.status ?? null,
  cover_status: ctx?.cover_letter?.status ?? null,
}
```

keyed by `job.source_url`. A workspace whose `job.json` has no `source_url` is
computed but never inserted. A corrupt `job.json` skips to the next directory; a
corrupt `context.json` leaves `ctx = null`, so the statuses read as `null`.

`buildQueue`'s signature and defaults:

```js
export function buildQueue(
  rankedLeads,
  { workspaces = new Map(), applied = [], top = 5, covered = new Map() } = {},
) { ... }
```

Each returned entry:

```js
{ id, company, title, url, score, slug, covers: [...], reason }
```

The `reason` field is the interesting one — it tells the caller what work is
outstanding:

| `reason`          | Meaning                                              | What the pipeline does                |
| ----------------- | ---------------------------------------------------- | ------------------------------------- |
| `no_workspace`    | No `jobs/<slug>/` directory exists for this posting. | Run `new-job.mjs` first, then tailor. |
| `no_resume`       | Workspace exists but `context.json` has no status.   | Go straight to the tailoring stage.   |
| `resume_<status>` | A draft exists but never passed `verify-claims`.     | Finish it.                            |

**CLI flags.**

| Flag                    | Default                            | Meaning                                                                                   |
| ----------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------- |
| `--top N`               | `5`                                | Maximum queue size. Note the ranking runs at `Math.max(top * 4, 20)` first, then filters. |
| `--status new\|all`     | `"new"`                            | Lead status filter, same semantics as `recommend.mjs`.                                    |
| `--json`                | off                                | `JSON.stringify(queue, null, 2)`. This is the mode `cycle.mjs` parses.                    |
| `--leads <path>`        | `resolveLeadSource().file`         | Lead store.                                                                               |
| `--profile <path>`      | `<repo>/profile/profile.yaml`      | Fact base for the ranking.                                                                |
| `--jobs-dir <path>`     | `<repo>/jobs`                      | Where workspaces live.                                                                    |
| `--applications <path>` | `<repo>/profile/applications.yaml` | Application history. **Silently ignored at its default value — see §2.6(b).**             |
| `--cluster`             | off                                | Collapse near-duplicate postings so a group one resume can serve costs one queue slot.    |
| `--threshold N`         | `0.6`                              | Cluster similarity threshold; only meaningful with `--cluster`.                           |

**Exit codes** (stated in the header: `// Exit codes: 0 ok, 2 usage / missing store.`):

| Code | When                                           |
| ---- | ---------------------------------------------- |
| `0`  | Ran, including "nothing to pre-tailor".        |
| `2`  | `no lead store at <path> — run a search first` |
| `2`  | `profile not found at <path>`                  |

Note the check order is the reverse of `recommend.mjs`: the lead store is
checked first here, the profile second.

### 2.4 How it works, step by step

1. Parse argv (using the same five-line `flag` helper as `recommend.mjs`, with
   the same `--top` quirk).
2. Existence checks → exit 2 on failure.
3. `readLeadStore(leadsPath).leads ?? []`, filtered by `status`.
4. **Rank generously, then filter:**

   ```js
   // Rank generously, then filter — the top few by score are often already
   // tailored, and we still want a full queue underneath them.
   const ranked = rankLeads(leads, profileText(loadYamlFile(profilePath)), {
     top: Math.max(top * 4, 20),
   })
   ```

   With `--top 5` this ranks the best **20**. (What is missing from that call is
   a live defect — §2.6(a).)

5. Read the application history via `readApplications`.
6. Optionally cluster:

   ```js
   // Clustering runs over the RANKED list so the best-scoring posting of each
   // group leads it — that is the one worth tailoring for.
   covered = coveredBy(clusterLeads(ranked, { threshold, keywords }))
   ```

7. `buildQueue(ranked, { workspaces, applied, top, covered })`.
8. Compute the reporting numbers:

   ```js
   const attached = queue.reduce((n, q) => n + q.covers.length, 0)
   const suppressed = covered.size - attached
   ```

   with the comment: _"Cluster members whose leader did not make the queue
   (already applied to, already tailored, or below the cut-off) are served by an
   existing resume and are not silently gone — they are counted here."_

9. Emit in one of the three output modes.

**About the clustering** (`src/leads/cluster.mjs`, documented fully
elsewhere, summarized here because `--cluster` changes what this script
returns). Two postings are compared by

```js
similarity(a, b) = 0.5 * jaccard(titleTokens) + 0.5 * jaccard(keywords)
```

**Jaccard similarity** is the size of the overlap divided by the size of the
union — if two postings name 6 technologies between them and share 3, they score
0.5. `jaccard` returns 0 when either set is empty, because _"two postings we know
nothing about are not evidence of a match."_ Each lead joins the highest-scoring
cluster whose **leader** it resembles at or above the threshold, or starts its
own. Comparing against the leader rather than any member is deliberate:

```js
// Chaining (A~B, B~C, A a stranger to C) is how a cluster drifts from
// "React/Node full-stack" to "Go platform engineer" one hop at a time
```

`coveredBy` then returns `Map<member_id, leader_id>` for every member **after the
first**.

### 2.5 The filter loop — the load-bearing part

```js
for (const lead of rankedLeads) {
  const leader = covered.get(lead.id)
  if (leader) {
    // Checked before the `top` cut-off, not after: a cluster's members are
    // ranked below its leader by construction, so stopping at the cut-off
    // would hide exactly the postings the queued run already serves.
    byLeader.get(leader)?.covers.push({ id, company, title, url })
    continue
  }
  if (queue.length >= top) continue
  if (appliedKeys.has(companyTitleKey(lead))) continue
  const ws = workspaces.get(lead.url)
  if (ws && DONE_STATUSES.has(ws.resume_status)) continue
  // ...push...
}
```

Five things to take from this loop:

1. **Covered-member handling comes first**, before the size cut-off, for the
   reason quoted above.
2. **`continue`, not `break`, at the cut-off.** Once the queue is full the loop
   keeps running, so later cluster members can still be attached to leaders
   already in the queue.
3. **The "already applied" check uses a normalized company+title key**, not a
   URL:

   ```js
   const norm = (s) =>
     String(s ?? "")
       .trim()
       .toLowerCase()
   const companyTitleKey = (x) => `${norm(x.company)}::${norm(x.title)}`
   ```

   So `"  co1 "` + `"FULL STACK ENGINEER"` matches `"Co1"` +
   `"Full Stack Engineer"`. The `::` separator prevents `"ab" + "c"` colliding
   with `"a" + "bc"`.

4. **`DONE_STATUSES` is what "already tailored" means:**

   ```js
   // "verified" is the status verify-claims sets once a tailored doc passes; only
   // then is there nothing left to pre-compute. "rendered"/"approved" are later
   // states and equally done.
   const DONE_STATUSES = new Set(["verified", "approved", "rendered"])
   ```

   The full status ladder in `src/lib/lib.mjs` is
   `["pending", "drafted", "verified", "approved", "rendered"]`, so `pending`
   and `drafted` are **not** done and stay queued.

5. **`--top` is applied after filtering, not before** — two already-verified
   leads are skipped without consuming slots.

**Worked example.** Ranked list from step 4: `gh:1 Co1 (score 9)`,
`gh:2 Co2 (8)`, `gh:3 Co3 (7)`, `gh:4 Co4 (6)`. You pass `--top 2`. Clustering
found `gh:4` similar to `gh:1`, so `covered = Map{ "gh:4" → "gh:1" }`. `Co3` has
a workspace whose `resume_status` is `"verified"`.

| Lead   | Covered? | Queue full? | Applied? | Workspace done? | Outcome                                     |
| ------ | -------- | ----------- | -------- | --------------- | ------------------------------------------- |
| `gh:1` | no       | 0 < 2       | no       | no workspace    | **queued**, `reason: "no_workspace"`        |
| `gh:2` | no       | 1 < 2       | no       | no workspace    | **queued**, `reason: "no_workspace"`        |
| `gh:3` | no       | **2 ≥ 2**   | —        | —               | skipped by the cut-off                      |
| `gh:4` | **yes**  | —           | —        | —               | attached to `gh:1`'s `covers`, never queued |

Result: 2 entries; `gh:1.covers = [gh:4]`; `attached = 1`;
`suppressed = 1 - 1 = 0`. The human output ends with _"2 lead(s) ready to
pre-tailor, covering 1 further posting(s) with the same resume."_

Now change one thing: `gh:1` was already applied to. `gh:1` is skipped, so
`byLeader` never gets an entry for it, and `gh:4`'s
`byLeader.get("gh:1")?.covers.push(...)` short-circuits on the `?.` and does
nothing at all. `attached = 0`, `suppressed = 1`, and the output adds _"1 more
are covered by a resume that already exists."_

### 2.6 Traps and known defects

> **Known defect (2026-08-05 audit) — (a) `prep-queue` ranks on titles alone.**
>
> ```js
> const ranked = rankLeads(leads, profileText(loadYamlFile(profilePath)), {
>   top: Math.max(top * 4, 20),
> })
> ```
>
> Three things are missing from that call. No `keywords`, so `scoreLead`'s
> `indexed` is `null`. No `limits`, so a custom `roles.title_rank` retargets
> `recommend.mjs` but not this script. And `withJobText` is never called, so
> `lead.job_text` is always `undefined` and `text` is the title only.
>
> **Result: the queue that decides what gets tailored is ordered by title
> keyword, freshness, salary presence and flag penalties only — term 1 of the
> formula contributes almost nothing.** `recommend.mjs` fixed exactly this bug
> and documents it in a ten-line comment; `prep-queue` calls the same function
> and did not get the fix. The repository's own audit files this as **H1**.
>
> The fix is small: this file **already** opens the database and builds
> `keywordMap` — but only inside the `--cluster` branch, _after_ the ranking has
> happened. Hoist that block above the `rankLeads` call and pass
> `{ keywords, limits }` through.

> **Known defect (2026-08-05 audit) — (b) `--applications` is ignored at any
> path ending in `applications.yaml`.**
>
> ```js
> const applied = readApplications(
>   appsPath.endsWith("applications.yaml") ? null : appsPath,
> )
> ```
>
> `readApplications(null)` resolves to the real store (`jobs/leads.db` when it
> exists). So a caller pointing at a _fixture_ named `applications.yaml`
> silently reads your real application history. Filed as **L5**, and the same
> pattern appears in `profile-gaps.mjs`, `check-applied.mjs` and
> `follow-ups.mjs`.

**(c) `--cluster` opens the database without a `try` around `openDb`.**

```js
if (leadsPath.endsWith(".db")) {
  const db = openDb(leadsPath)
  try {
    keywords = keywordMap(db)
  } finally {
    db.close()
  }
}
```

Unlike `recommend.mjs`, which wraps the whole block and warns, a failure to open
here throws and crashes the run with a stack trace — the `finally` only guards
the inner work. Also, on a JSON store `keywords` stays `undefined`, and
`clusterLeads` then falls back to re-extracting terms from `lead.description`, a
field most stored leads do not carry.

**(d) The ranking depth is a magic number.** `Math.max(top * 4, 20)` — four times
oversampling with a floor of 20. Not configurable.

**(e) `covers` is always present, even when empty.** Downstream code can iterate
it without a null check; the test asserts `assert.deepEqual(q[1].covers, [])`.

**(f) `suppressed` is derived, not measured.** It is `covered.size - attached`, a
subtraction. Correct in practice, but it is arithmetic rather than a set
difference, so treat it as an indicator.

**(g) `readApplications` is a store-of-record read, and the record is
provenance-gated.** `CLAUDE.md` rule 2: an application row exists only because
you confirmed you submitted it, through `log-application.mjs`. `prep-queue` only
reads it; it must never create one.

**(h) THE BIG ONE — "queued" does not mean "applicable".** This is the most
expensive lesson in this file's history, and it is recorded not here but in
`src/auto/cycle.mjs`:

> MEASURED, first real cycle (2026-08-03): prep-queue ranks on FIT and knows
> nothing about where a posting lives, so it picked ten leads of which every
> single one was refused by the runner a step later — eight on `www.adzuna.com`
> (an aggregator, not an ATS, so it is not on the user's board_allowlist and
> never will be) and two on a Workday tenant. The cycle had assembled, verified
> and rendered a PDF for each. A pipeline that spends its whole budget tailoring
> documents nothing can submit LOOKS like it is working: every stage reports ok,
> `prepared=10`, and zero applications go out.

The fix went into `cycle.mjs`, not here: it now asks `trustBoard` **before** the
document work. That is the right shape — `prep-queue` answers "is this a good
job for me", and applicability is a different question with a different owner.
Do not add board-trust logic to this file; a second copy of "is this board
applicable" is a copy that drifts.

### 2.7 What it reads and writes

**Reads:** the `leads` table (via `readLeadStore`); `lead_keywords` (only inside
the `--cluster` branch); the `applications` table
(`slug TEXT PRIMARY KEY, company, title, applied_at, status, doc TEXT NOT NULL`)
via `readApplications`; `profile/profile.yaml`; and per-workspace
`jobs/<slug>/job.json` plus `jobs/<slug>/context.json`.

**Writes nothing.** It emits a queue on stdout; the caller acts on it.

Terse output, one line per queued lead, tab-separated:

```text
<score>\t<reason>\t<slug|->\t<company>\t<title>\t<url>[\tcovers=N]
covers\t<id>\t<company>\t<title>\t<url>
queued=N ranked=M[ clustered=A covered_elsewhere=S]
```

Empty queue, human mode: `"Nothing to pre-tailor — the top leads already have
verified resumes."` The `pipeline-jobs` skill adds: _"An empty queue means the
top leads are already prepped — say so and stop; do not re-tailor to look busy."_

### 2.8 Dependencies and dependents

**Imports:** `node:fs`, `node:path`, `node:url`; `../lib/lib.mjs`
(`loadYamlFile`, `isTerse`); `../profile/profile-gaps.mjs` (`profileText`);
`./recommend.mjs` (`rankLeads`); `./cluster.mjs` (`clusterLeads`, `coveredBy`);
`../lib/db.mjs` (`openDb`, `keywordMap`, `readLeadStore`, `resolveLeadSource`,
and — on a second `import` line for the same module — `readApplications`).

**Depended on by:** `src/auto/cycle.mjs` (spawns it and parses its JSON);
`.claude/skills/pipeline-jobs/SKILL.md`; `tests/leads/prep-queue.test.mjs`.

---

## 3. `src/leads/find-boards.mjs` — company name → board slug

This is the first link of the board discovery chain.

### 3.1 What it is and why it exists

You have a list of company names. You need `{type, slug}` pairs before anything
downstream can fetch a board. The header:

```js
// This is the missing front half of board discovery. discover-boards.mjs already
// decides whether a candidate board is worth sweeping ... but it needs
// a {type, slug} to start from, and getting those by hand is why the board list
// sat at 41 entries.
//
// Method: the six big ATSs all publish a no-auth JSON board endpoint keyed on a
// company slug, and the slug is almost always a predictable squashing of the
// company name. So: generate candidate slugs, ask each ATS, keep what answers.
```

**And then the honest limit, which belongs in any documentation of this file:**

```js
// WHAT THIS DOES NOT DO, measured rather than assumed. Probing 16 companies
// found Vercel, Figma and Notion in 4.2 seconds and found NOTHING for Konami
// Gaming, Everi, Zappos, Switch, Scientific Games, PlayAGS, Sightline Payments,
// Southwest Gas or NV Energy. Those are Las Vegas employers on Workday, iCIMS,
// Taleo and Phenom, whose board URLs contain an opaque tenant host that cannot
// be guessed from a name. Slug probing reaches startups and tech companies; the
// local market needs per-company research or an aggregator. Saying so in the
// output matters, because "no board found" reads as "not hiring" otherwise.
```

Read that against the stated Vegas-first location rule and you get the shape of
the problem: **this tool is strongest exactly where your priority is weakest.**
That is not a bug to fix in this file; it is a fact about how large employers
host their boards.

### 3.2 How you run it

```bash
node src/leads/find-boards.mjs --names "Acme,Globex" [--out docs/board-candidates.yaml]
node src/leads/find-boards.mjs --file docs/candidates/fortune500.yaml [--limit 100]
# plus [--concurrency 6] [--json] [--append]
```

Candidate name lists live in `docs/candidates/`: `fortune500.yaml`,
`local-lv.yaml`, `yc.yaml`.

### 3.3 Everything it exposes

**Exports:** `PROBES`, `slugsFor(name)`, `findBoard(name, opts)`. No other script
imports this file; only `tests/leads/find-boards.test.mjs` does.

**`PROBES` — the six ATS endpoints.** Each entry is a URL builder plus a "did
this board answer with jobs?" reader. Every one is public and unauthenticated.

| `type`            | URL built from slug `s`                                              | How it counts jobs                |
| ----------------- | -------------------------------------------------------------------- | --------------------------------- |
| `greenhouse`      | `https://boards-api.greenhouse.io/v1/boards/${s}/jobs`               | `j?.jobs?.length ?? 0`            |
| `lever`           | `https://api.lever.co/v0/postings/${s}?mode=json`                    | `Array.isArray(j) ? j.length : 0` |
| `ashby`           | `https://api.ashbyhq.com/posting-api/job-board/${s}`                 | `j?.jobs?.length ?? 0`            |
| `smartrecruiters` | `https://api.smartrecruiters.com/v1/companies/${s}/postings?limit=1` | `j?.totalFound ?? 0`              |
| `workable`        | `https://apply.workable.com/api/v1/widget/accounts/${s}`             | `j?.jobs?.length ?? 0`            |
| `recruitee`       | `https://${s}.recruitee.com/api/offers/`                             | `j?.offers?.length ?? 0`          |

Two details worth noticing: SmartRecruiters asks for `?limit=1` and reads
`totalFound`, so it does not need to download the postings at all; and Recruitee
puts the slug in the **subdomain** rather than the path.

**`slugsFor(name) → string[]`** — the guessing rule.

```js
export function slugsFor(name) {
  const cleaned = String(name ?? "")
    .toLowerCase()
    .replace(
      /\b(inc|llc|ltd|corp|corporation|company|co|holdings|group|the|plc|sa|nv|gmbh)\b/g,
      " ",
    )
    .replace(/[&+]/g, " ")
    .trim()
  const words = cleaned.split(/\s+/).filter(Boolean)
  if (!words.length) return []
  return [
    ...new Set([
      words.join(""), // acmewidgets
      words.join("-"), // acme-widgets
      words[0], // acme
      words.map((w) => w[0]).join(""), // aw  (initialisms like ibm, ags)
    ]),
  ].filter((s) => s.length >= 2)
}
```

Its comment: _"Suffixes are stripped because no ATS slug contains them:
'Fanatics Betting & Gaming, Inc.' is 'fanaticsfbg' or 'fanatics', never
'fanaticsbettinggaminginc'."_

Real outputs, produced by actually calling the function:

| Input                         | Output                                                                                                                   |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `"Vercel"`                    | `["vercel"]` — all four candidates collapse to the same string, and the initialism `"v"` is dropped by the length filter |
| `"Acme Widgets"`              | `["acmewidgets", "acme-widgets", "acme", "aw"]`                                                                          |
| `"Fanatics Betting & Gaming"` | `["fanaticsbettinggaming", "fanatics-betting-gaming", "fanatics", "fbg"]`                                                |
| `"Applied Gaming Solutions"`  | `["appliedgamingsolutions", "applied-gaming-solutions", "applied", "ags"]`                                               |
| `"Konami Gaming"`             | `["konamigaming", "konami-gaming", "konami", "kg"]`                                                                      |
| `"Everi Holdings, Inc."`      | `["everi,.", "everi-,-.", "everi", "e,."]` — **see the defect note below**                                               |
| `""`, `"Inc."`                | `[]` — a junk name yields nothing rather than probing garbage                                                            |

**`findBoard(name, { timeoutMs = 8000 })`** — the probe walk.

```js
// Find the board for one company. Stops at the first hit: a company has one
// real board, and continuing costs round trips for nothing.
export async function findBoard(name, { timeoutMs = 8000 } = {}) {
  for (const slug of slugsFor(name)) {
    for (const probe of PROBES) {
      const hit = await probeOne(slug, probe, timeoutMs)
      if (hit) return { company: name, ...hit }
    }
  }
  return { company: name, type: null, slug: null, live: 0 }
}
```

Two nested loops, both fully sequential — `await` inside a `for` loop means each
request finishes before the next begins. Up to 4 slugs × 6 probes = **24
sequential HTTP round trips** for a company with no public board. **A miss is the
expensive case**, and the local-Vegas list is almost entirely misses.

The private `probeOne` collapses every failure to `null`:

```js
async function probeOne(slug, probe, timeoutMs) {
  const ctl = AbortSignal.timeout(timeoutMs)
  try {
    const r = await fetch(probe.url(slug), {
      headers: { "user-agent": UA, accept: "application/json" },
      signal: ctl,
    })
    if (!r.ok) return null
    const n = probe.count(await r.json())
    return n > 0 ? { type: probe.type, slug, live: n } : null
  } catch {
    return null
  }
}
```

`UA` is `"agentic-job-application/0.1 (personal job search tool)"` — the tool
identifies itself honestly to every server it touches. `AbortSignal.timeout(8000)`
cancels a request that hangs longer than eight seconds. A 404 (not found), a 500
(server error), a 429 (rate limited — "you are asking too often, slow down"), a
timeout, a malformed JSON body, and a real board with zero open roles all produce
exactly the same `null`. There is no retry and no way to tell them apart.

**CLI flags.**

| Flag                             | Default                             | Meaning                                                                                                                                            |
| -------------------------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--names "A,B,C"`                | —                                   | Comma-separated inline names. Takes precedence over `--file`.                                                                                      |
| `--file <companies.yaml\|.json>` | —                                   | Name list. Accepts a bare array, `{ companies: [...] }` or `{ names: [...] }`; each element may be a string or an object with `company` or `name`. |
| `--limit N`                      | all names                           | Probe only the first N.                                                                                                                            |
| `--concurrency N`                | `6`                                 | How many companies to probe at once.                                                                                                               |
| `--out <file>`                   | `<repo>/docs/board-candidates.yaml` | Where the candidates file is written.                                                                                                              |
| `--append`                       | off                                 | Merge into the existing out-file instead of replacing it. **Not optional in practice — see §3.6(a).**                                              |
| `--json`                         | off                                 | Print `{ ms, probed, found, dupes, missing }`. **Returns before the file write.**                                                                  |

Exit: `0` normally; `2` with a usage line when no names were supplied; `1` if
`main()` throws (for instance `--file` pointing at a missing path).

### 3.4 How it works, step by step

1. `loadNames(args)` — inline `--names` wins over `--file`; returns `null` when
   neither is present, which triggers the usage error and exit 2.
2. Build a `known` set from `loadSources()`, so a board already in the sweep list
   is never re-proposed:

   ```js
   const known = new Set(
     loadSources().map(
       (b) => `${b.type}:${(b.slug ?? b.tenant ?? b.host ?? "").toLowerCase()}`,
     ),
   )
   ```

3. `mapPool(names.slice(0, limit), concurrency, (n) => findBoard(n))` — six
   companies in flight at once, each doing its own sequential slug × probe walk.
   `mapPool` is the shared bounded-concurrency helper; see §4.4.
4. Partition the results: `found` (a type was resolved), `fresh` (found and not
   already tracked), `dupes = found.length - fresh.length`, `missing` (no type).
5. If `--json`, print and **return** — no file is written in this mode.
6. Otherwise, when `fresh.length > 0`, write the candidates file.
7. Print the report.

### 3.5 Worked example

```bash
node src/leads/find-boards.mjs --names "Vercel,Konami Gaming" --append
```

- **Vercel** → `slugsFor` gives `["vercel"]`. Probe 1 is
  `GET https://boards-api.greenhouse.io/v1/boards/vercel/jobs`, which answers 200
  with `{ jobs: [ ...61 items ] }`. `count = 61 > 0`, so it is a hit, and
  `findBoard` returns
  `{ company: "Vercel", type: "greenhouse", slug: "vercel", live: 61 }` after
  **one** round trip.
- **Konami Gaming** → `slugsFor` gives
  `["konamigaming", "konami-gaming", "konami", "kg"]`. All 4 × 6 = 24 probes
  return 404 or time out, so it returns
  `{ company: "Konami Gaming", type: null, slug: null, live: 0 }`.

But Vercel is **already** in `docs/job-sources.yaml`, so `dupes = 1`,
`fresh = []`, and — because the file write sits inside `if (fresh.length)` — **no
file is written at all.** Output:

```text
Probed 2 compan(ies) in 9.4s.

No new boards found.

1 were already in the sweep list.

No public board for 1 compan(ies). That does NOT mean they
are not hiring — Workday, iCIMS, Taleo and Phenom boards live behind an
opaque tenant host that cannot be guessed from a company name, and that is
what most large and most local employers use:
  Konami Gaming
```

### 3.6 What it reads and writes

**Reads:** the `--file` name list; `docs/job-sources.yaml` (through
`loadSources`); six live ATS APIs.
**Writes:** `docs/board-candidates.yaml` (or `--out`), with this exact header:

```yaml
# Board candidates discovered by src/leads/find-boards.mjs.
# NOT swept yet — run discover-boards.mjs to yield-gate these, then add
# the survivors with manage-sources. Nothing here touches job-sources.yaml.
candidates:
  - type: smartrecruiters
    slug: servicenow
    company: ServiceNow
    pool: levelled
```

That file currently holds **217 candidates in 872 lines**, every one tagged
`pool: levelled`.

### 3.7 Traps and known defects

> **Known defect (2026-08-05 audit) — (a) without `--append`, the out-file is
> silently replaced.** The merge block is gated on `args.includes("--append")`,
> but `fs.writeFileSync(outPath, ...)` runs unconditionally whenever
> `fresh.length > 0`. A run of
> `node src/leads/find-boards.mjs --names "Acme"` that finds one new board
> **replaces all 217 existing candidates with that one.** There is no backup and
> no warning. The file is tracked in git, so it is recoverable — but only if it
> had been committed. Until this is fixed, treat `--append` as mandatory.

> **Known defect (2026-08-05 audit) — (b) `slugsFor` does not strip
> punctuation.** `"Everi Holdings, Inc."` produces
> `["everi,.", "everi-,-.", "everi", "e,."]`. Only the third of those is a real
> slug; the other three are probed anyway, costing 18 guaranteed-miss HTTP
> requests per punctuated name. The existing test passes because it only asserts
> that `"everi"` is present and that no candidate contains `"inc"` or
> `"holdings"`. A `.replace(/[^a-z0-9\s-]/g, " ")` before the split would fix it.

**(c) `--json` produces no file.** `if (asJson) { return console.log(...) }` sits
_above_ the write block. An agent that runs with `--json` — which this project's
output conventions encourage — gets the data on stdout but leaves
`board-candidates.yaml` untouched. Not wrong, but undocumented and surprising.

**(d) `pool` is hardcoded to `"levelled"` for every candidate**, discarding which
input list the company came from:

```js
.map((r) => ({ type: r.type, slug: r.slug, company: r.company, pool: "levelled" }))
```

So companies probed from `docs/candidates/local-lv.yaml` — the _local_ pool, the
stated priority — are written as `levelled`. All 217 rows in the live file are
`levelled`, confirming nothing else has ever been written. This is what makes
`discover-boards`' three-pool design inert (§5.6(c)).

**(e) `live` is measured and then thrown away.** `probeOne` already downloaded
the board's full JSON and counted its postings, `findBoard` returns `live: n`,
and the terse output prints `live=61` — but the candidates file records only
`{type, slug, company, pool}`. `discover-boards.mjs` then re-fetches the same
board from scratch. **Every discovered board is fetched twice.**

**(f) Slug probing can find the wrong company — and this one is load-bearing.**
The incident record puts it plainly:

> `find-boards.mjs` tries "spring" for "Spring Mobile" and "ultimate" for
> "Ultimate Fighting Championship"; a board with that slug may belong to someone
> else entirely. This is contained because `discover-boards.mjs` reports the
> company and live counts, and the user approves each addition — **never
> auto-add.**

That human approval step is the containment for a fuzzy-matching tool. Do not
remove it, and do not add an "auto-add everything that clears the bar" flag.

**(g) No retry, and every failure looks identical.** A 429 rate-limit is
indistinguishable from "this company has no board". With concurrency 6 × 6
probes, hammering one ATS is plausible; be conservative with `--concurrency`.

**(h) It never touches `docs/job-sources.yaml`.** Stated in the header: _"adding
a board stays the user's call via manage-sources (CLAUDE.md rule 10 territory:
the sweep list is user policy)."_

### 3.8 Dependencies and dependents

**Imports:** `node:fs`, `node:path`, `node:url`, `js-yaml`; `../lib/lib.mjs`
(`isTerse`, `mapPool`, `UA`); `./find-jobs.mjs` (`loadSources`).
**Depended on by:** `tests/leads/find-boards.test.mjs` only. No script imports
it; `docs/operate/01-commands.md` catalogues it as a command.

---

## 4. `src/leads/board-yield.mjs` — is a board earning its keep?

This section comes before `discover-boards.mjs` because that file imports
`scoreBoard` from here.

### 4.1 What it is and why it exists

It fetches every board currently listed in `docs/job-sources.yaml`, runs the real
application-limits gate over its live postings, and reports how many of each
board's postings you could actually take. Its header is the argument the whole
source pipeline rests on:

```js
// Why this exists: a board that lists 200 reqs and none this profile could take
// is not neutral — it costs sweep time on every run and buries the reachable
// leads in noise that then costs a model read to reject. On 2026-07-28 a sweep
// of 41 boards produced 47 leads and every single one was unreachable. Board
// count is not a number to pick; it is an output of this measurement.
//
// Reports only. Removing a board is the user's call (docs/job-sources.yaml is
// user-facing), so this prints proposals and never edits anything.
```

"Board count is not a number to pick; it is an output of this measurement" is the
sentence to remember.

### 4.2 How you run it

```bash
node src/leads/board-yield.mjs [--json]
node src/leads/board-yield.mjs --query "full stack" --concurrency 6 --min-qualifying 0
```

| Flag                 | Default        | Meaning                                                                                                                                      |
| -------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `--query "<text>"`   | `"full stack"` | Search text passed to `fetchBoard`. **Only Workday uses it as a server-side filter**; the other twelve fetchers ignore it or filter locally. |
| `--concurrency N`    | `6`            | How many boards to fetch at once.                                                                                                            |
| `--min-qualifying N` | `0`            | A board with `solid <= N` is reported as dead and gets a proposed removal command. At the default this means `solid === 0`.                  |
| `--json`             | off            | `{ ms, totals, rows }` pretty-printed.                                                                                                       |

Exit codes: `0` normally; `1` if `main()` throws (for example `loadLimits` cannot
read `docs/application-limits.yaml`). A board that fails to fetch does **not**
fail the run — it becomes a row with `error` set.

**Its main-guard is different from every other file in this domain:**

```js
const invoked = process.argv[1] && process.argv[1].endsWith("board-yield.mjs")
if (invoked) {
  main().catch((e) => {
    console.error(e.message)
    process.exit(1)
  })
}
```

A string suffix test rather than the `pathToFileURL` comparison the others use.
It works today — importing it from `discover-boards.mjs` leaves `process.argv[1]`
pointing at `discover-boards.mjs` — but it is a weaker check: any script path
ending in those fifteen characters would trigger it.

### 4.3 `scoreBoard(board, postings, limits, now)` — the row, field by field

```js
const label = `${board.type}:${board.slug ?? board.tenant ?? board.host ?? ""}`
```

| Field           | Meaning                                                                                                                                           |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `label`         | `type:identity`, e.g. `greenhouse:airtable`, `workday:mgmresorts`, `oracle_cloud:edmn.fa.us2.oraclecloud.com`. Falls back `slug → tenant → host`. |
| `company`       | `board.company ?? label`                                                                                                                          |
| `type`          | The ATS type string.                                                                                                                              |
| `live`          | `postings.length` — everything the board returned.                                                                                                |
| `qualifying`    | Postings for which `passesLimits(...).ok === true`.                                                                                               |
| `solid`         | Qualifying postings whose location is **confirmed** — carrying neither `remote_unverified` nor `unknown_location`.                                |
| `hard_filtered` | Rejected because the first reason contains `"hard-filtered"` (over-level or wrong discipline).                                                    |
| `location`      | Rejected with a reason starting `"location:"`.                                                                                                    |
| `title`         | Rejected with a reason starting `"title:"`.                                                                                                       |
| `stale`         | Reason starts `"stale"` or contains `"older than"`.                                                                                               |
| `other`         | Any other rejection reason.                                                                                                                       |
| `error`         | `null`, or the fetch error message.                                                                                                               |
| `samples`       | Up to 3 **solid** posting titles.                                                                                                                 |
| `yield`         | `Math.round((solid / live) * 1000) / 10` — a percentage to one decimal place; `0` when `live === 0`, which guards division by zero.               |

**Why `solid` exists rather than just `qualifying`.** This is the counter-intuitive
one, and its comment records the measurement:

```js
// Of those, the ones whose location is actually CONFIRMED. passesLimits
// lets "remote_unverified" and "unknown_location" through as flags rather
// than rejects, and on 2026-07-28 every such lead checked (OpenAI, Ramp)
// turned out to be Hybrid SF/NYC — a relocation. Counting them as yield
// would make office-bound boards look productive, so they are split out.
```

and, at the line that computes the percentage:

```js
// Yield is measured on confirmed-location postings: an unverified "remote"
// that is really a hybrid office is not a lead this profile can act on.
```

The rejection-reason bucketing reads only `v.reasons[0]` — the **first** reason —
and classifies by string prefix. Its purpose, per the comment: _"this is what
distinguishes a board that is simply senior-only from one that is merely in the
wrong city."_

### 4.4 `auditBoards(boards, limits, opts)` and `mapPool`

```js
export async function auditBoards(boards, limits, opts = {}) {
  const { query = "full stack", concurrency = DEFAULT_CONCURRENCY } = opts
  const now = opts.now ?? new Date()
  return mapPool(boards, concurrency, async (board) => {
    try {
      const postings = await fetchBoard(board, query)
      return scoreBoard(board, postings, limits, now)
    } catch (e) {
      const row = scoreBoard(board, [], limits, now)
      row.error = e.message
      return row
    }
  })
}
```

**A failed board becomes an all-zero row with an error string, never an
exception.** One unreachable ATS must not abort the audit of the other 43. This
pattern — catching an error and turning it into an ordinary data value — is worth
naming: "errors as values". It is what lets the report be complete.

`mapPool` lives in `src/lib/lib.mjs` and is re-exported here with the comment
_"Shared with the sweep — one implementation, in lib.mjs. Re-exported so the
existing tests and importers keep working."_ Its own comment:

```js
// Bounded-concurrency map, preserving input order. Board sweeps are entirely
// network-bound, so running them one at a time was leaving the wall clock on
// the table; the cap keeps us from hammering any ATS.
```

The implementation starts `min(limit, items.length)` async workers, each of which
pulls the next index off a shared counter (`const i = next++`) until the list is
exhausted, and writes results into a pre-allocated array **by index**. So the
output order matches the input order even though the completion order does not.
"Network-bound" means the program spends its time waiting for other people's
servers, not calculating — which is exactly when running several requests at once
is free speed, and exactly when an unbounded fan-out becomes rude.

### 4.5 The `main()` flow, and a worked example

1. Parse flags.
2. `loadLimits()` and `loadSources()`.
3. Time the audit with `Date.now()` either side of `auditBoards`.
4. Sort with a three-level tiebreak:

   ```js
   // Ranked on confirmed-reachable postings, not on raw qualifying: a board
   // whose only "hits" are unverified-remote is not a productive board.
   rows.sort(
     (a, b) => b.solid - a.solid || b.yield - a.yield || b.live - a.live,
   )
   ```

5. Partition: `dead = rows.filter(r => !r.error && r.solid <= minQualifying)`,
   `broken = rows.filter(r => r.error)`. A board with an `error` has `solid = 0`
   and sinks to the bottom next to the genuinely dead ones, but is reported
   separately.
6. Total up `live`, `qualifying` and `solid`.
7. Emit.

**Worked example.** Board `{ type: "greenhouse", slug: "airtable", company: "Airtable" }`
returns 9 postings:

| Posting                                                  | `passesLimits` result                                         | Effect on the row                                                  |
| -------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------ |
| 4 titled `Senior ...` / `Staff ...`                      | `ok:false`, `reasons[0] = 'title: "senior" is hard-filtered'` | `hard_filtered += 4`                                               |
| 2 × `Full Stack Engineer`, `Remote (US)`                 | `ok:true`, no location flags                                  | `qualifying += 2`, `solid += 2`, both titles captured in `samples` |
| 1 × `Software Engineer`, `San Francisco`, `remote: true` | `ok:true` but flagged `remote_unverified`                     | `qualifying += 1`, `solid` unchanged                               |
| 1 × `Product Designer`                                   | `reasons[0] = "title: not a targeted role"`                   | `title += 1`                                                       |
| 1 × `Full Stack Engineer` posted 45 days ago             | `reasons[0] = "stale: posted 45 days ago (max 30)"`           | `stale += 1`                                                       |

Row: `live 9, qualifying 3, solid 2, hard_filtered 4, title 1, stale 1,
yield 22.2`.

Human output row:

```text
Airtable                      9     2    1       22.2%   4 over-level/wrong-role, 1 off-target title, 1 stale
```

Terse output row:

```text
greenhouse:airtable|Airtable|live=9|solid=2|unconfirmed=1|yield=22.2%|hard=4|loc=0|title=1
```

with a trailing summary line of the form
`boards=44 live=8576 solid=18 unconfirmed=29 dead=28 broken=1 ms=12480`.

A dead board's proposal block:

```text
28 board(s) produced no reachable posting. Proposed removals (review first — nothing was changed):
  node src/leads/manage-sources.mjs remove "Palantir"   # 214 live, 0 reachable
```

That printed command is correct as-is, because `removeEntryFromText` matches on
company name (§6.4).

### 4.6 What it reads and writes

**Reads:** `docs/job-sources.yaml` (via `loadSources`),
`docs/application-limits.yaml` (via `loadLimits`), and the live HTTP APIs of
every board.
**Writes: nothing at all** — stdout only.

The board entry shapes it must understand, straight from
`docs/job-sources.yaml`:

```yaml
- { type: greenhouse, slug: anthropic, company: Anthropic }
- { type: ashby, slug: openai, company: OpenAI }
- { type: smartrecruiters, slug: BoydGaming, company: Boyd Gaming }
- {
    type: workday,
    company: "Light & Wonder",
    host: lnw.wd5.myworkdayjobs.com,
    tenant: lnw,
    site: LightWonderExternalCareers,
  }
- {
    type: oracle_cloud,
    company: Caesars Entertainment,
    host: edmn.fa.us2.oraclecloud.com,
    site: CX_1,
  }
- { type: jobvite, slug: agscareer, company: AGS }
- { type: successfactors, company: IGT, host: jobs.igt.com }
- { type: jobicy, company: Jobicy (remote US), geo: usa, industry: engineering }
```

There are **44 board entries live today**, plus two commented out. Thirteen board
types are supported — `BOARD_TYPES` is the list of keys of `BOARD_FETCHERS` in
`find-jobs.mjs`: `greenhouse, lever, ashby, smartrecruiters, workable, recruitee,
workday, oracle_cloud, jobvite, successfactors, jobicy, remotive, remoteok`.

### 4.7 Traps and things not to "fix"

**(a) The DEFAULT mode refetches every board live on every run — that is
correct, and `--history` is the mode that does not.** `jobs/leads.db` has a
`board_stats` table with almost exactly the columns this script computes, plus
two counters the live audit cannot produce:

```sql
CREATE TABLE IF NOT EXISTS board_stats (
  board_id TEXT PRIMARY KEY, type TEXT, slug TEXT, company TEXT,
  last_swept TEXT, live_postings INTEGER DEFAULT 0, qualifying INTEGER DEFAULT 0,
  solid INTEGER DEFAULT 0, leads_produced INTEGER DEFAULT 0, last_qualifying_at TEXT,
  sweeps INTEGER DEFAULT 0, zero_streak INTEGER DEFAULT 0
);
```

The schema comment states the intent: _"A single audit is a snapshot; pruning a
board should be driven by history, so every sweep appends its counts here."_

> **Closed (P6, 2026-08-17).** `board-yield.mjs --history` now imports
> `readBoardStats` from `db.mjs`, reads the table offline and proposes removals
> from it — 5 ms against the live audit's 22.6 s on 57 boards. Do **not**
> "simplify" the two modes into one: the live audit and the history read answer
> different questions, and folding history into the live path would put a network
> fetch behind a question that does not need one.
>
> **Still open — the second-order problem in what is written.**
> `leads_produced` is accumulated with `leads_produced + excluded.leads_produced`
> over pre-dedupe counts, so postings the sweep had already stored are counted
> again every time: the number grows without bound and does not mean "leads
> produced". `proposeRemovals` deliberately keys off `zero_streak`, `sweeps` and
> `last_qualifying_at` instead, none of which have that flaw.

**(b) `passesLimits` is the same gate the real sweep uses.** That is what makes
the yield number honest. This file deliberately does not reimplement the gate; it
imports it. Any change to the gate changes yield, which is why `CLAUDE.md` says
to run `gate-audit.mjs` after **any** gate change.

**(c) The body gate does not run here.** `passesLimits` reads only title,
location and date. The much stricter body gate runs later in the real sweep, so
`solid` is an **upper bound** on what a board would actually contribute.

**(d) `yield` is a percentage of `live`, not of `qualifying`.** A board with 200
postings and 2 solid reads 1.0%.

**(e) A board that fetches fine but returns 0 postings reads as `dead`.**
`manage-sources add` deliberately _tolerates_ that at add time ("the board is
live but currently empty; it stays in the daily sweep"), so the two tools
disagree about an empty board, by design.

**(f) There are two different `label` functions with different fallbacks.**

- `board-yield.mjs`: `` `${board.type}:${board.slug ?? board.tenant ?? board.host ?? ""}` ``
- `manage-sources.mjs`: `` `${b.type}:${b.slug ?? b.tenant ?? b.site ?? b.company}` ``

For Caesars this yields `oracle_cloud:edmn.fa.us2.oraclecloud.com` in one and
`oracle_cloud:CX_1` in the other. Cosmetic here, but it is part of what makes
`discover-boards`' printed `add` command wrong for host-based boards (§5.6(a)).

### 4.8 Dependencies and dependents

**Imports:** `./find-jobs.mjs` (`loadSources`, `loadLimits`, `passesLimits`,
`fetchBoard`); `../lib/lib.mjs` (`isTerse`, `mapPool`).
**Exports:** `mapPool` (re-export), `scoreBoard`, `auditBoards`.
**Depended on by:** `src/leads/discover-boards.mjs` imports `scoreBoard`;
`tests/leads/board-yield.test.mjs` imports `scoreBoard` and `mapPool`.

---

## 5. `src/leads/discover-boards.mjs` — the yield bar

### 5.1 What it is and why it exists

It takes candidate boards — a file, or one `--type`/`--slug` pair — fetches each
one live, and proposes for adoption only those that produce at least one posting
you could actually take. The header carries the number the whole source pipeline
is built around:

```js
// This is deliberately NOT a bulk slug crawler. On 2026-07-28 the 41 boards
// already tracked carried 8,576 live postings and yielded 18 reachable ones
// (0.21%), and 28 boards yielded zero. Adding companies indiscriminately makes
// that worse twice over: every junk board costs sweep time forever, and its
// postings bury the reachable leads in noise that then costs a model read to
// reject. So a candidate must clear the same yield bar the audit applies to
// existing boards before it is proposed at all.
//
// Reports only — it never edits docs/job-sources.yaml. Adding a board is the
// user's call, via manage-sources.
```

**0.21%.** Eighteen usable jobs out of 8,576 postings. That is why "add more
boards" is not a free action and why this gate exists at all.

Two later measurements sharpen it further, and both belong here:

- A live sweep on 2026-08-02 measured **≈5–7 new qualifying leads per day from
  the 44 configured boards**, with the gates rejecting **6,576 of 6,585** fetched
  postings (99.86%). The board count needed for 999 qualifying leads a day would
  be roughly 6,600–8,800 — 150× to 200× the current list.
- **Adding boards buys a one-time backlog and then a trickle.** The first-ever
  sweep harvested 66 leads; three boards added on 2026-07-29 produced 36 on the
  next sweep and then subsided. Cold-start yield is about **12 leads per board**.
  Since `max_age_days: 30` throws away anything older than a month, a burst you
  cannot consume before it ages out is harvested, stored, counted, and wasted.
  The batch-size rule the autonomy plan derives from that is
  **`boards per batch ≈ (per_day_max × usable_days) / 12`** — roughly 19 boards
  at a time at today's `per_day_max: 10`, not five hundred.

### 5.2 How you run it

```bash
node src/leads/discover-boards.mjs --candidates docs/board-candidates.yaml
node src/leads/discover-boards.mjs --type greenhouse --slug acme --company "Acme"
```

| Flag                                  | Default                | Meaning                                                 |
| ------------------------------------- | ---------------------- | ------------------------------------------------------- |
| `--candidates <file.yaml\|file.json>` | —                      | Batch input.                                            |
| `--type <ats>` + `--slug <slug>`      | —                      | Single candidate. Both are required together.           |
| `--company "Name"`                    | falls back to the slug | Display name for the single-candidate form.             |
| `--min-solid N`                       | `1`                    | The bar: a candidate is **accepted** when `solid >= N`. |
| `--concurrency N`                     | `6`                    | Parallel fetches.                                       |
| `--query "<text>"`                    | `"full stack"`         | Passed through to `fetchBoard`.                         |
| `--json`                              | off                    | `{ ms, accepted, rejected, broken, dupes }`.            |

| Exit | When                                                                                                                                                                      |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | Ran, whether or not anything was accepted.                                                                                                                                |
| `2`  | Neither `--candidates` nor a complete `--type` + `--slug` was given. Prints `usage: discover-boards.mjs --candidates <file> \| --type <ats> --slug <slug> [--company X]`. |
| `1`  | `main()` threw — for example `loadCandidates` found no candidates, or `loadLimits` failed.                                                                                |

### 5.3 Everything it exposes

```js
export const POOLS = ["local", "levelled", "remote"]
export function postsBelowSenior(postings)
export function evaluateCandidate(candidate, postings, limits, now)
```

**`POOLS`** documents the priority order for where to look for boards likely to
clear the bar:

```js
//   local     Las Vegas metro. On-site is acceptable, so the WHOLE board
//             counts rather than only its remote reqs, and local employers
//             hire across all levels.
//   levelled  companies that demonstrably post Engineer I/II, Associate,
//             Junior or New Grad titles. If a company has never posted below
//             Senior, brand does not matter — it cannot yield.
//   remote    genuinely remote-US companies (verified from the posting, not
//             from a location field that says "Remote" over an office city).
```

It is exported and a test asserts its contents, but **no code path reads it** —
see §5.6(c).

**`postsBelowSenior(postings) → boolean`**

```js
const JUNIOR_TITLE =
  /\b(junior|jr\.?|associate|entry|new ?grad|graduate|apprentice|intern|i{1,3}\b|[123]\b)\b/i

export function postsBelowSenior(postings) {
  return postings.some((p) => JUNIOR_TITLE.test(String(p.title ?? "")))
}
```

Its comment: _"Does this board ever post below Senior? Cheap, and it is the
single best predictor of whether a company is reachable at ~2.5 years."_ It
matches "Software Engineer II", "Junior Developer", "Associate Engineer", "New
Grad Engineer", and is false for a Senior/Staff/Principal-only board and for an
empty list. Be aware the `[123]\b` alternative is loose — it would also match a
title containing "Tier 1".

**`evaluateCandidate(candidate, postings, limits, now) → row`** — calls
`scoreBoard` from `board-yield.mjs`, then adds exactly two fields:

```js
row.pool = candidate.pool ?? null
row.posts_below_senior = postsBelowSenior(postings)
```

**`loadCandidates(file)`** (private) is deliberately permissive about the input
shape — a bare array, `{ candidates: [...] }`, or `{ boards: [...] }`, in YAML or
JSON:

```js
const doc = file.endsWith(".json") ? JSON.parse(raw) : yaml.load(raw)
const list = Array.isArray(doc) ? doc : (doc?.candidates ?? doc?.boards ?? [])
if (!Array.isArray(list) || !list.length)
  throw new Error(`no candidates found in ${file}`)
```

### 5.4 How it works, step by step

1. Parse flags; build `candidates` from `--candidates` or from `--type`/`--slug`.
2. **De-duplicate against what is already swept:**

   ```js
   const boardId = (b) =>
     `${b.type}:${b.slug ?? b.tenant ?? b.host ?? ""}`.toLowerCase()
   // Never re-propose something already swept.
   const known = new Set(loadSources().map(boardId))
   const fresh = candidates.filter((c) => !known.has(boardId(c)))
   const dupes = candidates.length - fresh.length
   ```

   Note the `.toLowerCase()` here, which `board-yield`'s `label` does not do.

3. `mapPool(fresh, concurrency, ...)` — fetch and evaluate each, converting a
   fetch exception into a row with `error` set, the same "errors as values"
   pattern as `auditBoards`.
4. Partition and sort:

   ```js
   const accepted = rows.filter((r) => !r.error && r.solid >= minSolid)
   const rejected = rows.filter((r) => !r.error && r.solid < minSolid)
   const broken = rows.filter((r) => r.error)
   accepted.sort((a, b) => b.solid - a.solid || b.yield - a.yield)
   ```

5. Emit. **Rejects are printed too**, and the comment says why:

   ```js
   // Rejects are printed too: a silent cap reads as "nothing was out there".
   ```

### 5.5 Worked example

Suppose a run over three candidates with the default `--min-solid 1`:

- `{ type: greenhouse, slug: databricks, company: Databricks, pool: levelled }` —
  180 live postings, 172 hard-filtered as Senior and above, 6 rejected on
  location, 2 solid (`Software Engineer - Full Stack`, `Software Engineer II`).
  `solid 2 >= 1` → **ACCEPTED**, `yield = 1.1`, `posts_below_senior = true`.
- `{ type: ashby, slug: snowflake, company: Snowflake, pool: levelled }` — 240
  live, 0 solid → **rejected**, printed with its breakdown.
- `{ type: greenhouse, slug: okta, company: Okta, pool: levelled }` — already in
  `job-sources.yaml` → filtered out before any fetch, counted in `dupes`.

Human output for the accepted one:

```text
ACCEPTED — 1 board(s) cleared the bar:

  Databricks (greenhouse:databricks)
    180 live, 2 reachable (1.1%), posts below Senior
    e.g. Software Engineer - Full Stack
    node src/leads/manage-sources.mjs add --type greenhouse --slug databricks --company "Databricks"
```

Terse output:

```text
ACCEPT|greenhouse:databricks|Databricks|live=180|solid=2|yield=1.1%|below_senior=true
reject|ashby:snowflake|Snowflake|live=240|solid=0|hard=231|loc=9
candidates=3 skipped_known=1 accepted=1 rejected=1 broken=0 ms=3120
```

### 5.6 Traps and known defects

> **Known defect (2026-08-05 audit) — (a) the printed `add` command is wrong for
> host-based boards.**
>
> ```js
> ;`    node src/leads/manage-sources.mjs add --type ${r.type} --slug ${r.label.split(":")[1]} --company "${r.company}"\n`
> ```
>
> It always emits `--slug <label-part>`. Workday needs `--host --tenant --site`,
> Oracle Cloud needs `--host --site`, SuccessFactors needs `--host`. A Workday
> candidate `{ type: "workday", tenant: "mgmresorts", ... }` has
> `label = "workday:mgmresorts"`, so the printed command is
> `add --type workday --slug mgmresorts --company "..."`, and `manage-sources`
> throws `workday boards need --host, --tenant, and --site`. Filed as **L7**.
> Narrow in practice — all six `find-boards` probes are slug-based — but reachable
> through a hand-written candidates file. Note also that `r.label.split(":")[1]`
> takes only the **second** colon-separated segment; `.slice(1).join(":")` would
> be safer.

**(b) `posts_below_senior` is computed and printed but never gates acceptance.**
The header argues _"If a company has never posted below Senior, brand does not
matter — it cannot yield"_, yet `accepted` is filtered on `solid >= minSolid`
alone. In practice `passesLimits` hard-filters senior titles, so any `solid`
posting is already non-senior and the field is largely redundant with
`solid >= 1` — but the printed line `, NEVER posts below Senior` can therefore
appear on an **accepted** board, which reads as a contradiction.

**(c) The `pool` concept is inert.** `POOLS` is exported and never read;
`row.pool` is echoed through but never used for ordering, filtering or reporting
priority; and every one of the 217 rows in `docs/board-candidates.yaml` carries
`pool: levelled` because `find-boards.mjs` hardcodes it (§3.7(d)). **The
three-pool design documented in this file's comment does not exist at runtime.**

**(d) A candidate with an unknown `type` becomes a `broken` row, not a usage
error.** `fetchBoard` throws `unknown board type "<x>"`, which the `catch`
converts into `row.error`. So a typo in a candidates file is reported at the
bottom of the run under "Could not fetch", not up front.

**(e) The de-duplication is by `type:identity`, lowercased — not by company
name.** The same company on two different ATSs is two distinct candidates and
both would be proposed. (Contrast `manage-sources`' `findDuplicate`, which _does_
match on company name — §6.4.)

### 5.7 Dependencies and dependents

**Imports:** `node:fs`, `node:url`, `node:path`, `js-yaml`; `../lib/lib.mjs`
(`isTerse`, `mapPool`); `./find-jobs.mjs` (`loadSources`, `loadLimits`,
`fetchBoard`); `./board-yield.mjs` (`scoreBoard`).
**Depended on by:** `tests/leads/discover-boards.test.mjs`; referenced as a shell
command by `find-boards.mjs` and by `docs/operate/01-commands.md`.

---

## 6. `src/leads/manage-sources.mjs` — the only writer

### 6.1 What it is and why it exists

This is the only program in the repository that edits `docs/job-sources.yaml`. It
adds a board (after a live prescreen and a duplicate check), removes one,
live-checks them all, or lists them.

```js
// Deterministic manager for docs/job-sources.yaml (no LLM calls).
// `add` PRESCREENS the board with a live API call and refuses duplicates, so
// the daily sweep only ever hits boards that are known to work.
// ...
// docs/job-sources.yaml is edited line-by-line (entries are single-line flow
// maps) so the file's comments survive every add/remove.
```

**The comment-preservation requirement is a real constraint, not a nicety.**
`docs/job-sources.yaml` opens with 22 lines of instructions for you, and its
aggregator block at the bottom carries a measurement (_"jobicy measured 5 kept of
50 (10%) on 2026-07-29"_) plus two commented-out entries that are meant to stay
commented-out and re-testable. The obvious implementation — load the YAML into
memory, change the data, write it back out — would erase every one of those
comments, because comments are not part of the parsed data. That is why
`.prettierignore` lists `docs/job-sources.yaml` as a contract, and why the file's
own header states a **FORMAT RULE: one entry per line, flow style**.

A YAML **flow map** is the `{ key: value, key: value }` form written on a single
line, as opposed to block style with one key per indented line. Keeping every
entry on one line is what makes a purely textual, line-by-line edit possible.

### 6.2 How you run it

```bash
node src/leads/manage-sources.mjs add --type <ats> --slug <slug> --company "Name"
node src/leads/manage-sources.mjs add --type workday --company "Name" \
  --host x.wd5.myworkdayjobs.com --tenant x --site SiteName
node src/leads/manage-sources.mjs remove "<company or slug>"
node src/leads/manage-sources.mjs verify            # live-check every board
node src/leads/manage-sources.mjs list
```

The dispatcher is a plain chain of comparisons:

```js
async function main() {
  const [cmd, ...args] = process.argv.slice(2)
  if (cmd === "add") await cmdAdd(args)
  else if (cmd === "remove") cmdRemove(args)
  else if (cmd === "verify") await cmdVerify()
  else if (cmd === "list") cmdList()
  else {
    console.error(
      "usage: manage-sources.mjs <add|remove|verify|list> [options]",
    )
    process.exit(2)
  }
}
```

**Exit codes.**

| Code                        | When                                                                                                                                                                       |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`                         | Success.                                                                                                                                                                   |
| `1`                         | Any thrown error — unknown type, missing required flag, duplicate, prescreen failure, no match on remove, or the write-back safety check. The message goes to stderr.      |
| `1` (as `process.exitCode`) | `verify` sets `process.exitCode = 1` when any board is broken, but **finishes printing first** rather than exiting early. That is why it uses `exitCode` and not `exit()`. |
| `2`                         | Unknown or missing subcommand.                                                                                                                                             |

### 6.3 Everything it exposes

**Exports:** `searchQuery`, `findDuplicate`, `formatEntry`, `boardLabel`,
`removeEntryFromText`, `addEntryToText`. Only
`tests/leads/manage-sources.test.mjs` imports them.

**`searchQuery(limitsFile = undefined) → string`**

```js
export function searchQuery(limitsFile = undefined) {
  try {
    return (
      loadLimits(...(limitsFile ? [limitsFile] : [])).roles?.search_query ??
      DEFAULT_SEARCH_QUERY
    )
  } catch {
    return DEFAULT_SEARCH_QUERY
  }
}
```

`DEFAULT_SEARCH_QUERY` is `"full stack"`. The comment explains why this function
exists at all:

```js
// The same query cmdSearch actually sweeps with — a THIRD independently
// hardcoded "software engineer" used to sit here (alongside fetchBoard's own
// default), which meant a board's prescreen count could disagree with what
// the daily sweep finds for it, on the one fetcher of thirteen (Workday)
// where the query is a server-side filter (P5, retarget-readiness audit
// 2026-08).
// `limitsFile` exists so a test can point this at a fixture instead of the
// real docs/application-limits.yaml — without it, a test asserting the
// fallback would silently start failing the day the user actually adds
// roles.search_query, since it would then read their real, non-default value.
```

The odd-looking `...(limitsFile ? [limitsFile] : [])` is how you pass **no
argument at all** (so `loadLimits`' own default path applies) versus passing an
explicit path. A plain ternary cannot express "omit this argument"; spreading an
empty array can. `roles.search_query` is not present in the live
`docs/application-limits.yaml`, so `"full stack"` is what runs today.

### 6.4 The pure text-editing functions

**`findDuplicate(boards, entry) → board | null`**

```js
const identity = (b) => norm(b.slug ?? b.tenant ?? b.site)

export function findDuplicate(boards, entry) {
  return (
    boards.find(
      (b) =>
        norm(b.company) === norm(entry.company) ||
        (b.type === entry.type && identity(b) === identity(entry)),
    ) ?? null
  )
}
```

with the comment: _"A duplicate is the same company name, or the same type +
board identity — one entry per employer per board. The identity field varies by
ATS: slug for most, tenant for workday, site for oracle_cloud."_

Two independent rules, OR'd together:

1. Same company name, case- and whitespace-insensitive, regardless of ATS.
2. Same `type` **and** same identity.

The tests confirm the intended behaviour: `{ type: "lever", slug: "anthropic-x",
company: "ANTHROPIC" }` is a duplicate of the Greenhouse Anthropic board by rule
1; `{ type: "lever", slug: "openai" }` is **not** a duplicate of
`{ type: "ashby", slug: "openai" }`, because the same slug on a different ATS is
a different board.

**`formatEntry(entry) → string`**

```js
const ENTRY_FIELDS = {
  workday: ["type", "company", "host", "tenant", "site"],
  oracle_cloud: ["type", "company", "host", "site"],
  successfactors: ["type", "company", "host"],
  // eid is optional: the fetcher bootstraps it from the careers page, but
  // pinning it saves a request and survives a careers-page redesign.
  jobvite: ["type", "slug", "company", "eid"],
}
const DEFAULT_ENTRY_FIELDS = ["type", "slug", "company"]

export function formatEntry(entry) {
  const q = (v) =>
    /[:#'"{}\[\],&*?|>%@`]|^\s|\s$/.test(v) ? JSON.stringify(v) : v
  const fields = ENTRY_FIELDS[entry.type] ?? DEFAULT_ENTRY_FIELDS
  const body = fields
    .filter(
      (f) => entry[f] !== undefined && entry[f] !== null && entry[f] !== "",
    )
    .map((f) => `${f}: ${q(String(entry[f]))}`)
    .join(", ")
  return `  - { ${body} }`
}
```

Two load-bearing details:

1. **Field order is per-ATS and fixed**, so the file stays visually consistent.
2. **Absent fields are omitted, never written as the string "undefined"**, with a
   comment recording the incident:

   ```js
   // Host-based boards carry no slug, and a missing field
   // must be omitted rather than written as the string "undefined" — that is what
   // silently produced two dead entries that still prescreened OK.
   ```

   That is a nasty failure mode: the entry looked fine, the prescreen passed
   because the fetcher never read the bogus field, and the board simply produced
   nothing forever after. The test asserts that no `"undefined"` appears in an
   `oracle_cloud` line built from an entry with `slug: undefined`.

The quoting predicate `q` wraps a value in `JSON.stringify` — double quotes with
proper escaping — when it contains any YAML-significant character
(`: # ' " { } [ ] , & * ? | > % @` or a backtick) or begins or ends with
whitespace. Verified live:

```text
formatEntry({type:'greenhouse',slug:'acme',company:'Acme: Iron & Co'})
  → '  - { type: greenhouse, slug: acme, company: "Acme: Iron & Co" }'
```

**`boardLabel(b) → string`**

```js
export const boardLabel = (b) =>
  `${b.type}:${b.slug ?? b.tenant ?? b.site ?? b.company}`
```

Fallback chain `slug → tenant → site → company`. **Different from
`board-yield.mjs`'s label**, which falls back `slug → tenant → host` (§4.7(f)).

**`removeEntryFromText(text, key) → { text, removed }`** — this is the
comment-preservation mechanism in full:

```js
// Delete the single line whose flow map matches company or slug/tenant.
export function removeEntryFromText(text, key) {
  const lines = text.split("\n")
  const kept = []
  let removed = 0
  for (const line of lines) {
    if (/^\s*-\s*\{.*\}\s*$/.test(line)) {
      let entry = null
      try {
        entry = yaml.load(line.replace(/^\s*-\s*/, ""))
      } catch {}
      if (
        entry &&
        (norm(entry.company) === norm(key) || identity(entry) === norm(key))
      ) {
        removed++
        continue
      }
    }
    kept.push(line)
  }
  return { text: kept.join("\n"), removed }
}
```

It **never parses the document.** It walks lines, and only lines matching the
single-line flow-map shape `^\s*-\s*\{.*\}\s*$` are even considered. Every other
line — comments, the `boards:` key, blank lines — is copied through untouched.
`removed` is a count, so `remove` can report how many entries went and error when
it is zero.

**`addEntryToText(text, entry) → string`**

```js
export function addEntryToText(text, entry) {
  const line = formatEntry(entry)
  const out = text.endsWith("\n") ? text : text + "\n"
  return out + line + "\n"
}
```

It appends at the very end of the file. See §6.6(b).

### 6.5 The four commands, step by step

#### `add`

```js
const entry = {
  type: getFlag(args, "--type"),
  company: getFlag(args, "--company"),
  slug: getFlag(args, "--slug") ?? undefined,
  eid: getFlag(args, "--eid") ?? undefined,
  host: getFlag(args, "--host") ?? undefined,
  tenant: getFlag(args, "--tenant") ?? undefined,
  site: getFlag(args, "--site") ?? undefined,
}
```

Then a validation ladder, each rung throwing a specific message:

| #   | Check                                                                   | Error message                                                                               |
| --- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| 1   | `--type` and `--company` are both present                               | `usage: add --type <ats> --company Name [--slug s \| --host h --tenant t --site s]`         |
| 2   | `type` is one of the 13 in `BOARD_TYPES`                                | `unknown type "<x>" (known: greenhouse, lever, ashby, ...)`                                 |
| 3   | `oracle_cloud` has `--host` **and** `--site`                            | `oracle_cloud boards need --host (e.g. edmn.fa.us2.oraclecloud.com) and --site (e.g. CX_1)` |
| 4   | `workday` has `--host`, `--tenant` **and** `--site`                     | `workday boards need --host, --tenant, and --site`                                          |
| 5   | `successfactors` has `--host`                                           | `successfactors boards need --host (e.g. jobs.igt.com), the career-site hostname`           |
| 6   | every non-host-based type has `--slug` (`HOST_BASED` = the three above) | `<type> boards need --slug`                                                                 |
| 7   | `findDuplicate(loadSources(), entry)` returns null                      | `duplicate: "<company>" (<label>) is already tracked`                                       |
| 8   | **the prescreen** — `fetchBoard(entry, searchQuery())` returns an array | `prescreen failed: no job list returned`                                                    |

Then it writes and reports:

```js
writeSourcesText(addEntryToText(readSourcesText(), entry))
console.log(
  `Added ${entry.company} (${boardLabel(entry)}) — prescreen OK, ${jobs.length} posting(s) visible right now.`,
)
if (jobs.length === 0) {
  console.log(
    "note: the board is live but currently empty; it stays in the daily sweep.",
  )
}
```

**The write-back safety check** is what makes textual editing safe:

```js
function writeSourcesText(text) {
  // Refuse to persist anything yaml can't parse back into a board list.
  const doc = yaml.load(text)
  if (!Array.isArray(doc?.boards)) {
    throw new Error("internal error: edited job-sources.yaml no longer parses")
  }
  fs.writeFileSync(SOURCES_PATH, text)
}
```

Because the edit is done as text, nothing else would catch a malformed line. This
is a **validation round trip**: parse what you are about to write, and refuse if
it does not come back the right shape. It is the safety net under `formatEntry`'s
quoting rules.

#### `remove`

```js
const key = args.find((a) => !a.startsWith("--"))
if (!key) throw new Error('usage: remove "<company or slug>"')
const { text, removed } = removeEntryFromText(readSourcesText(), key)
if (!removed) throw new Error(`no tracked board matches "${key}"`)
writeSourcesText(text)
console.log(`Removed ${removed} board(s) matching "${key}".`)
```

The key is "the first argument that is not a flag". There is no prescreen and no
confirmation. Removing more than one entry in a single call is possible, and the
count is reported.

#### `verify`

Walks every board in `loadSources()` **strictly one at a time** — `await` inside
a `for` loop — calling `fetchBoard`. Prints `ok      <label> (<n> postings)` in
human mode (terse mode reports only what needs action), or
`BROKEN  <label> — <message>` on a failure, then `N ok, M broken.` and sets
`process.exitCode = 1` if anything is broken.

#### `list`

`for (const b of loadSources()) console.log(\`${b.company}  (${boardLabel(b)})\`)`.
No terse variant; the output is identical either way.

### 6.6 Worked example — adding Databricks

```console
node src/leads/manage-sources.mjs add --type greenhouse --slug databricks --company "Databricks"
```

1. `entry = { type: "greenhouse", company: "Databricks", slug: "databricks",
eid/host/tenant/site: undefined }`.
2. `"greenhouse"` is in `BOARD_TYPES`. Not host-based, and `--slug` is present,
   so rungs 2–6 pass.
3. `findDuplicate` over the 44 loaded boards: no company named "databricks", and
   no `greenhouse` board with identity `"databricks"` → `null`.
4. `fetchBoard(entry, "full stack")` hits `boards-api.greenhouse.io` and returns
   an array of 180 normalized postings. Prescreen passes.
5. `formatEntry` → `- { type: greenhouse, slug: databricks, company: Databricks }`
   (no quoting needed — no special characters).
6. `addEntryToText` appends it after the file's final newline.
7. `writeSourcesText` parses the whole result; `doc.boards` is an array of 45, so
   it writes.
8. Prints
   `Added Databricks (greenhouse:databricks) — prescreen OK, 180 posting(s) visible right now.`

### 6.7 Traps and known defects

> **Known defect (2026-08-05 audit) — (a) `identity()` collides for
> `successfactors`, and can collide for `oracle_cloud`.**
>
> ```js
> const identity = (b) => norm(b.slug ?? b.tenant ?? b.site)
> ```
>
> A SuccessFactors board has **none** of `slug`, `tenant` or `site` — its
> `ENTRY_FIELDS` entry is `["type", "company", "host"]` and `cmdAdd` requires
> only `--host`. So `identity(b)` is the empty string for every SuccessFactors
> board, and `findDuplicate`'s second clause becomes
> `b.type === "successfactors" && "" === ""` → always true. Verified live: with
> the tracked `{ type: successfactors, company: IGT, host: jobs.igt.com }` in the
> list, adding **any** second SuccessFactors employer fails with
> `duplicate: "IGT" (successfactors:IGT) is already tracked`.
>
> The same shape threatens `oracle_cloud`, whose identity is `site`. Caesars uses
> `site: CX_1`, which is Oracle's stock default site name — so a second Oracle
> Cloud employer on a completely different host with the same default site is
> also refused as a duplicate. Verified live.
>
> The correct identity for a host-based board is `host` + `site`, not `site`
> alone.

> **Known defect (2026-08-05 audit) — (b) `add` always appends at end-of-file,
> under the aggregator comment block.** `docs/job-sources.yaml` ends with:
>
> ```yaml
> # --- remote-only aggregators ------------------------------------------------
> # Not a company board: the whole corpus is remote roles ...
> - {
>     type: jobicy,
>     company: Jobicy (remote US),
>     geo: usa,
>     industry: engineering,
>   }
> # - { type: remotive, company: "Remotive (remote)", category: software-dev }
> # - { type: remoteok, company: "RemoteOK (remote)" }
> ```
>
> A newly added Greenhouse board lands on the next line — that is, _inside_ the
> "remote-only aggregators" section, under a heading that does not describe it.
> Functionally harmless, since `loadSources` reads `doc.boards` regardless, but
> it degrades the very file the line-by-line design exists to keep readable.
> Filed as **L13**.

**(c) `verify` is sequential where `board-yield` is pooled.** Forty-four boards,
one at a time, each a full network round trip, some of them paged.
`board-yield.mjs` audits the same 44 with `mapPool(boards, 6, ...)`. Latency is a
stated priority in this project; this is the obvious place to spend a small fix.

**(d) `add` refuses a board it cannot reach right now.** A transient outage at an
ATS makes the add fail, and there is no `--force`. That is deliberate, per the
header: _"the daily sweep only ever hits boards that are known to work."_

**(e) `add` accepts a live-but-empty board deliberately** — with the printed note
— while `board-yield` would call the same board dead. The two tools disagree on
purpose: adding is about "does this board work", auditing is about "is it
producing".

**(f) `remove` needs no confirmation and can remove several lines at once.** Its
`removed` count is the only feedback you get.

**(g) The `getFlag` here is the safer `!== undefined` variant.** `--slug` with no
value falls back to `null`, then `?? undefined` omits the field entirely, so the
"boards need --slug" check fires with a clear message rather than writing a
garbage slug.

**(h) The `manage-sources` skill duplicates this file's job in prose.**
`.claude/skills/manage-sources/SKILL.md` step 1 tells the model to probe the six
ATS APIs by hand — listing the very same six URLs that `find-boards.mjs`'s
`PROBES` already contains — and never mentions `find-boards.mjs`. If you are
adding boards, prefer the script.

### 6.8 Dependencies and dependents

**Imports:** `node:fs`, `node:path`, `node:url`, `js-yaml`; `./find-jobs.mjs`
(`fetchBoard`, `BOARD_TYPES`, `loadSources`, `loadLimits`,
`DEFAULT_SEARCH_QUERY`); `../lib/lib.mjs` (`isTerse`).
**Depended on by:** `tests/leads/manage-sources.test.mjs`. No script imports it.
Two scripts (`board-yield.mjs`, `discover-boards.mjs`) print shell commands
invoking it, and one skill drives it.

---

## 7. The board discovery chain, end to end

Here is one company followed the whole way, so the four files fit together.

**Goal: get Databricks into the daily sweep.**

**Step 1 — name → slug (`find-boards.mjs`).**

```bash
node src/leads/find-boards.mjs --names "Databricks" --append
```

`slugsFor("Databricks")` → `["databricks"]` (all four generated candidates
collapse to the same word, and the initialism `"d"` is dropped for being shorter
than two characters). The first probe,
`GET https://boards-api.greenhouse.io/v1/boards/databricks/jobs`, answers 200
with a `jobs` array, so `findBoard` stops immediately and returns
`{ company: "Databricks", type: "greenhouse", slug: "databricks", live: 180 }`.
Because `greenhouse:databricks` is not in the `known` set built from
`docs/job-sources.yaml`, it is `fresh`, and this row is appended to
`docs/board-candidates.yaml`:

```yaml
- type: greenhouse
  slug: databricks
  company: Databricks
  pool: levelled
```

The `live: 180` is printed and then discarded (§3.7(e)).

**Step 2 — is it worth sweeping? (`discover-boards.mjs`).**

```bash
node src/leads/discover-boards.mjs --candidates docs/board-candidates.yaml
```

The board is fetched **again** — this is the duplicated work — and every posting
is run through `passesLimits`, the same gate the real sweep uses. `scoreBoard`
(borrowed from `board-yield.mjs`) buckets the results: 172 hard-filtered as
Senior and above, 6 rejected on location, 2 **solid**. `solid 2 >= min-solid 1`,
so Databricks is **ACCEPTED** at a yield of 1.1%, and the tool prints an `add`
command for you.

Note what happened to the sibling candidates: Snowflake had 240 live postings and
0 solid, so it was rejected — and printed anyway, because _"a silent cap reads as
'nothing was out there'."_ Okta was already tracked and never fetched at all.

**Step 3 — you decide (`manage-sources.mjs`).**

```bash
node src/leads/manage-sources.mjs add --type greenhouse --slug databricks --company "Databricks"
```

Validation ladder, duplicate check, a live prescreen, then one line appended to
`docs/job-sources.yaml`, then a parse-back check before the write is committed to
disk. **This is the only step that changes the sweep list, and it is the only one
you run by hand.** Nothing upstream can add a board on its own — the two proposal
tools print commands and stop, because slug probing is fuzzy (§3.7(f)) and the
containment for fuzzy matching is a human looking at the company name.

**Step 4 — later, is it still earning its keep? (`board-yield.mjs`).**

```bash
node src/leads/board-yield.mjs
```

Every tracked board is refetched and scored. Boards whose `solid` count is at or
below `--min-qualifying` (default 0) are listed as dead, with a proposed
`manage-sources remove` command — again, printed, never executed.

**The shape of the whole chain in one sentence:** discovery is cheap and fuzzy,
the gate is deterministic and strict, and the single mutation is yours.

---

## If you were rebuilding this

Three decisions in this area actually matter. Everything else is detail you
could rediscover.

**1. A ranking that can go flat must say so.** The naive version of `rankLeads`
sorts by score with an alphabetical tiebreak and prints the top ten, and that is
what this code did for a while. It is correct right up until every score ties —
at which point it emits an alphabetical list under a heading that says "ranked",
and nothing anywhere fails. The measured incident was four nursing leads scoring
4, 4, 4, 4 after a retarget, because the built-in title ladder is software
vocabulary and matched none of them. `isFlatRanking` is nine words of code and it
is the difference between a tool that is honest about its own limits and one that
lies quietly. If you rebuild this, write that check before you write the sort.

The same lesson has a second half: **a comment is not evidence.** The comment
above `titleScore` claimed for months that the ladder came from
`docs/application-limits.yaml`. It did not read that file at all. Any rebuild
should assume its own comments are wrong until a test says otherwise.

**2. Board count is an output of measurement, not an input you choose.** The
tempting design is a bulk slug crawler: generate ten thousand slugs, keep
everything that answers, sweep them all. The measured reality is 8,576 live
postings yielding 18 reachable ones — **0.21%** — with 28 of 41 boards yielding
exactly zero. A junk board is not neutral: it costs sweep time forever and its
postings bury the reachable leads in noise that then costs a model read to
reject. So the pipeline is deliberately three stages with a **yield bar** in the
middle, and the bar is enforced with the same `passesLimits` gate the real sweep
uses rather than a reimplementation — because a second copy of the gate is a copy
that drifts, and it drifts toward accepting boards the sweep will then throw
away.

Two refinements you would get wrong naively. **Yield must be measured on
confirmed-location postings** (`solid`), not on everything that passes the gate
(`qualifying`) — every "remote" posting checked on 2026-07-28 that had an
unverified location turned out to be a hybrid office in another city, and
counting those would make office-bound boards look productive. And **adding
boards buys a one-time backlog and then a trickle**: about 12 leads per new
board, once. With a 30-day staleness limit and a 10-per-day application cap, a
burst larger than roughly 230 leads simply expires unapplied. Add boards ~19 at a
time and wait, rather than scaling to thousands in one pass.

**3. Exactly one program may write the sweep list, and it edits text, not data.**
`docs/job-sources.yaml` is your policy file. Two tools measure it and propose
changes; both end their runs by _printing a shell command_. Only
`manage-sources.mjs` writes, and it does so by walking lines rather than by
parsing and re-serializing — because the file's 22-line header, its per-section
explanations, its recorded measurements and its two deliberately commented-out
entries are the most valuable content in it, and a `yaml.load` → mutate →
`yaml.dump` round trip would erase all of them without a word. The safety net
under textual editing is the parse-back check in `writeSourcesText`: refuse to
persist anything that does not read back as a board list.

The failure that taught the field-formatting rule is worth carrying too: a
missing field written as the literal string `"undefined"` produced two entries
that looked valid, **prescreened OK**, and then silently produced nothing
forever. Omit absent fields; never stringify them.

Finally, on defects: this area has six live ones documented above (`prep-queue`
ranking on titles alone; `--applications` ignored at its default; the wrong `add`
command printed for host-based boards; `find-boards` replacing its output file
without `--append`; `slugsFor` leaving punctuation in slugs; `identity()`
colliding for host-based ATSs). None of them makes the system unusable and all of
them are quiet, which is exactly what makes them worth writing down. A rebuild
that fixes only the loud problems ships all six again.
