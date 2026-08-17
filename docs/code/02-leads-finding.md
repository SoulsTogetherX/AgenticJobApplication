# Finding jobs: the sweep

This is the front door of the whole system. Once a day (or whenever you ask for
it), this code goes out to the internet, asks about fifteen different job-board
services "what jobs do you have right now?", turns every answer into one common
shape, throws away the overwhelming majority that could never work for you, and
saves what is left into the local database `jobs/leads.db` as **leads**. Every
later part of the pipeline — screening, ranking, tailoring a résumé, filling in
an application form — reads leads that this code put there. If this part is
broken, nothing downstream has anything to work on.

Nothing here talks to an AI model. It is all ordinary, deterministic code:
given the same postings and the same rules, it makes the same decisions every
time. That is a deliberate project rule, and it is also what makes the sweep
cheap enough to run daily over thousands of postings.

**What you will learn here**

- What a "board fetcher" is, and exactly what all fifteen sources request, get
  back, and keep — one by one, with the real URLs.
- The two cheap gates every posting must pass (`passesLimits` and
  `bodyDisqualifiers`), what each one rejects, and — just as important — what
  each one only _flags_ and why that distinction is load-bearing.
- How a lead's `id` is built, how duplicates are detected, and why a
  re-posted job is a signal worth capturing rather than noise worth discarding.
- Why the write to the database happens inside a lock and the network fetches
  do not.
- What `docs/job-sources.yaml` is, and how you would add a company to it.
- Why five of the board types hand over a job listing with no description text
  at all, what `enrich.mjs` does about four of them, and which one is still a
  hole.
- The real defects an audit found in this area, stated plainly.

**Before this**

If any of the words below are unfamiliar, these companion documents cover them
first:

- [`../guide/03-programming-basics.md`](../guide/03-programming-basics.md) —
  functions, objects, arrays, `async`/`await`, regular expressions.
- [`../guide/05-architecture.md`](../guide/05-architecture.md) — how the stages
  of the pipeline fit together end to end.
- [`../guide/06-data-model.md`](../guide/06-data-model.md) — the `leads` table
  and what a "lead" actually is.
- [`01-lib-foundation.md`](01-lib-foundation.md) — the shared helpers this code
  leans on: `fetchJson`, `mapPool`, `textSnippet`, the file lock, the database
  wrapper, and the untrusted-text scrubber.
- [`../guide/08-glossary.md`](../guide/08-glossary.md) — if a term here is new.

What happens _after_ the sweep is covered in
[`03-leads-screening.md`](03-leads-screening.md) (the deeper checks) and
[`04-leads-ranking.md`](04-leads-ranking.md) (deciding what to show you first).

**The files covered here**

| File                          | Lines | One-line purpose                                                                                                                          |
| ----------------------------- | ----: | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/leads/find-jobs.mjs` | 1,726 | The sweep itself: all board fetchers, the two ingest gates, dedupe, the locked commit, and the `search` / `import` / `list` / `mark` CLI. |
| `scripts/leads/enrich.mjs`    |   287 | The follow-up fetch. Four ATS types hand over a job list with no description; this fetches one description per surviving posting.         |
| `scripts/leads/stages.mjs`    |   109 | A tiny registry naming the four screening stages `l0`–`l3` and running them in order, so a rejection can say _which_ check rejected it.   |

A quick note on vocabulary that recurs throughout:

> **ATS** stands for _Applicant Tracking System_ — the software a company buys
> to run its hiring. Greenhouse, Lever, Ashby, Workday and the rest are ATS
> vendors. A company does not usually build its own job board; it rents one.
> That is the single fact that makes this whole approach possible: there are
> maybe a dozen ATS vendors covering thousands of employers, so writing a dozen
> adapters gets you thousands of career pages.

> **API** stands for _Application Programming Interface_. Here it means: a web
> address that returns structured data (usually JSON) instead of a web page
> designed for a human to look at. `https://boards-api.greenhouse.io/v1/boards/anthropic/jobs`
> returns a machine-readable list of Anthropic's open jobs. Asking for it is one
> HTTP request, the same kind your browser makes, and the answer needs no
> guessing about where on the page the job title lives.

---

# Part 1 — `scripts/leads/find-jobs.mjs`

## 1.1 What it is and why it exists

This is the only thing in the repository that creates leads from the outside
world. (There is one other way in — a hand-captured JSON file fed through the
`import` subcommand — but it runs through the identical code and the identical
gates, so it is not an exception so much as a second doorway into the same
room.)

Without it there is no input to the pipeline at all. Everything else operates on
rows in the `leads` table.

It also carries the **two cheapest filters in the system**, and that is the
other half of why it matters. On a real sweep it looks at a few thousand
postings and stores single digits. If those filters ran later — after fetching
each posting's full description, say, or after asking a model to read them —
every daily sweep would cost hundreds of times more. The design principle
stated in `stages.mjs` is the one to remember:

```
//   L0 title  board list payload only (title, location, date, salary).
//             Free. Discards thousands.
//   L1 body   hard disqualifiers stated in the description. Needs the text,
//             which for four ATS types costs one fetch per surviving posting.
```

The file's own header comment is worth reading, with one correction:

```js
// Deterministic job-lead finder (no LLM calls). Sweeps the public,
// integration-friendly job APIs listed in docs/job-sources.yaml (Greenhouse,
// Lever, Ashby, SmartRecruiters, Workable, Recruitee, Workday CXS) plus
// Hacker News, filters every hit through docs/application-limits.yaml,
// dedupes against stored leads and application history, and maintains the
// lead store at jobs/leads.json.
```

> **Stale comment (verified 2026-08-05).** The last clause is out of date: the
> store has been the SQLite database `jobs/leads.db` since 2026-07-29.
> `jobs/leads.json` survives only as a fallback the code will read if no `.db`
> file exists. The list of board types in that header is also incomplete — the
> file supports thirteen types today, not the seven it names. The code is
> right; the comment was not updated.

## 1.2 How you run it

Four subcommands. The one you will use is `search`.

```bash
# The daily sweep: every board in docs/job-sources.yaml, plus Hacker News,
# plus Adzuna if credentials are configured.
node scripts/leads/find-jobs.mjs search --source all --query "full stack"

# Just the company boards, nothing else, and skip the per-posting description
# fetch (faster, but the body gate then has nothing to read on 5 board types).
node scripts/leads/find-jobs.mjs search --source boards --no-enrich

# Feed in postings captured by hand (a pasted LinkedIn ad, a Playwright
# capture) through exactly the same gates.
node scripts/leads/find-jobs.mjs import captured.json

# Look at what is stored.
node scripts/leads/find-jobs.mjs list --status new

# Change one lead's status.
node scripts/leads/find-jobs.mjs mark greenhouse:vercel:1234567 --status recommended
```

### What the output actually looks like

The output changes shape depending on who is reading it. `isTerse()` (from
`scripts/lib/lib.mjs`) checks whether standard output is a terminal:

> A **TTY** is a terminal — a window where a human is watching. When a program's
> output is piped somewhere else (into a file, or into an AI agent's tool
> result), it is not a TTY. This project uses that difference to print compact
> records to agents and readable prose to humans, without needing a flag.

A real run of `list` (agent form, because the output was piped):

```
adzuna:5828399177|new|Shyra tech LLC|Full Stack .NET Developer|US|2026-08-04|https://www.adzuna.com/land/ad/5828399177?se=…
adzuna:5828219911|new|QUANTUM TECHNOLOGIES LLC|Java Full Stack Developer ( React )|US|2026-08-04|https://www.adzuna.com/land/ad/5828219911?se=…
count=51 total=178
```

The field order is
`id|status|company|title|location|posted(first 10 chars)|url`, and the trailing
line is `count=<matching> total=<all leads>`.

A `search` prints one line per lead it stored, then a tally:

```
+greenhouse:vercel:1234567|Vercel|Full Stack Engineer|Remote - US|remote_unverified
stored=3 rejected=2841
enriched=4/6
```

The `+` line is `+id|company|title|location|flags`. `enriched=4/6` means six
surviving postings had no description in the board's list response and four
detail fetches succeeded (see [Part 2](#part-2--scriptsleadsenrichmjs)).

For a human at a terminal the same run reads:

```
Swept 44 board(s) at concurrency 8 in 31.4s.
+ Vercel — Full Stack Engineer (Remote - US)  [remote_unverified]

Stored 3 new lead(s); rejected 2841 (title: 2610, location: 198, stale: 33).
Fetched descriptions for 4 of 6 posting(s) whose board list endpoint carries none.
```

### Exit codes

| Code | Meaning                                                                              |
| ---: | ------------------------------------------------------------------------------------ |
|  `0` | Success.                                                                             |
|  `1` | Any error thrown anywhere. The message is printed (no stack trace) and the run ends. |
|  `2` | Unknown subcommand — you typed something other than `search`/`import`/`list`/`mark`. |

Note what is **not** an error: a single board failing. Each board fetch is
wrapped so a failure becomes an empty result plus a warning line
(`warn: source failed: greenhouse:acme — HTTP 404 for …`), and the sweep
continues. One dead board must never lose you the other forty-three.

## 1.3 Everything it exposes

### Command-line flags

| Flag             | Subcommands        | Default                                                      | What it does                                                                                                                                                  |
| ---------------- | ------------------ | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--source`       | `search`           | `all`                                                        | `boards` = every entry in `docs/job-sources.yaml`; `hn` = Hacker News; `adzuna` = the credentialed aggregator; `all` = all three.                             |
| `--query`        | `search`           | `roles.search_query` in the limits file, else `"full stack"` | The search phrase. **Read carefully — see the trap in §1.11: only Workday, Hacker News and Adzuna use this at all.**                                          |
| `--max-age`      | `search`           | `freshness.max_age_days` from the limits file (30)           | Overrides the freshness cut-off _in memory for this run only_: `if (maxAge) (limits.freshness ??= {}).max_age_days = Number(maxAge)`. The file is not edited. |
| `--concurrency`  | `search`           | `8`                                                          | How many boards are fetched at the same time.                                                                                                                 |
| `--leads <path>` | `search`, `import` | the real store                                               | Redirects **both the store and its lock file** to a scratch path. The header says "for tests only; omit it in normal use".                                    |
| `--no-enrich`    | `search`, `import` | off                                                          | Skips the per-posting description fetch.                                                                                                                      |
| `--explain [N]`  | `search`, `import` | off                                                          | After the run, prints the top N (default 30) _software-ish job titles that were rejected only for missing your keyword list_. See §1.6.                       |
| `--status`       | `list`, `mark`     | `new` for `list`; required for `mark`                        | One of `new`, `recommended`, `dismissed`, `applied` — plus `all`, which `list` alone accepts.                                                                 |
| `--notes`        | `mark`             | none                                                         | Free text stored on the lead.                                                                                                                                 |

Flag parsing is one four-line helper, not a library:

```js
function getFlag(args, name, fallback = null) {
  const i = args.indexOf(name)
  return i !== -1 && args[i + 1] !== undefined ? args[i + 1] : fallback
}
```

A flag value is literally "the word after `--name`". Boolean flags are tested
with `args.includes("--no-enrich")`. This is worth knowing because it explains a
real sharp edge documented in §1.11.

### Exported functions and constants

These are exported so other scripts and the test suite can reuse the logic
without running a whole sweep.

| Export                                                      | Signature / type                              | What it gives you                                                                                                             |
| ----------------------------------------------------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `DEFAULT_BOARDS`                                            | `[{type, slug, company}]`                     | The two-board fallback (Anthropic on Greenhouse, OpenAI on Ashby) used only when `docs/job-sources.yaml` is missing entirely. |
| `loadSources(file = SOURCES_PATH)`                          | → board array                                 | Parses `docs/job-sources.yaml`; returns `doc.boards` when non-empty, else `DEFAULT_BOARDS`.                                   |
| `loadLimits(file = LIMITS_PATH)`                            | → object                                      | Parses `docs/application-limits.yaml` (your policy file), or `{}`.                                                            |
| `US_WIDE_LOCATION`                                          | `string[]` (20 entries)                       | Location strings that mean "anyone in the US may be hired" rather than "move here".                                           |
| `matchesAny(value, list)`                                   | → `boolean`                                   | Whole-string, punctuation-insensitive membership test.                                                                        |
| `matchTitleKeyword(title, keywords)`                        | → the matched keyword, or `undefined`         | Whole-**word** match, used by the hard and soft title filters.                                                                |
| `passesLimits(job, limits, now = new Date())`               | → `{ok, reasons[], flags[]}`                  | **Gate L0** — the cheap title/location/date/salary gate.                                                                      |
| `excludeBodyPattern(limits = {})`                           | → `RegExp`                                    | The non-software body vocabulary, replaceable by `roles.exclude_body`.                                                        |
| `bodyDisqualifiers(job, limits = {})`                       | → `{ok, reasons[], flags[]}`                  | **Gate L1** — the description gate.                                                                                           |
| `parseSalaryMax(text)`                                      | → number \| `null`                            | Largest `$` amount ≥ 10,000 found in a string. `"$150K – $220K • 0.15%"` → `220000`.                                          |
| `parseWorkdayPostedOn(text, now = new Date())`              | → ISO date string \| `null`                   | `"Posted 3 Days Ago"` → a real date.                                                                                          |
| `workdayLocationFromPath(externalPath)`                     | → string                                      | `"/job/US-CA-Santa-Clara/Engineer_JR1"` → `"US CA Santa Clara"`.                                                              |
| `normUrl(u)`                                                | → string                                      | `origin + pathname`, lowercased, no trailing slash, query string and `#fragment` dropped.                                     |
| `dedupeLeads(candidates, existingLeads = [], applied = [])` | → array **with an extra `.reposts` property** | New candidates worth storing; `.reposts` is `[{lead, candidate}]`.                                                            |
| `parseJobviteFeed(xml, board)`                              | → lead array                                  | Exported "so the brittle bit is unit-testable against a fixture".                                                             |
| `parseSuccessFactorsTotal(html)`                            | → number \| `Infinity`                        | Reads the `of <b>142</b>` out of "Results 1 - 25 of 142".                                                                     |
| `parseSuccessFactorsPage(html, board)`                      | → lead array                                  | Scrapes one page of an SAP SuccessFactors career site.                                                                        |
| `loadEnv(file = ROOT/.env)`                                 | → `{KEY: value}`                              | Minimal `.env` parser for the Adzuna credentials.                                                                             |
| `normalizeAdzunaJob(j)`                                     | → lead                                        | One Adzuna record → the common lead shape.                                                                                    |
| `BOARD_TYPES`                                               | `string[]`                                    | `Object.keys(BOARD_FETCHERS)` — the thirteen supported board types.                                                           |
| `DEFAULT_SEARCH_QUERY`                                      | `"full stack"`                                | "THE single hardcoded default query anywhere in this file".                                                                   |
| `fetchBoard(board, query = DEFAULT_SEARCH_QUERY)`           | → lead array                                  | One entry point for every board type. Throws `unknown board type "..."` for an unsupported `type`.                            |
| `backfillDescriptions(candidates, leads)`                   | → count                                       | Copies descriptions onto already-stored leads that lack one. Mutates `leads` in place.                                        |
| `textSnippet`, `SNIPPET_MAX`                                | re-exported from `lib.mjs`                    | Kept here purely so older importers keep working.                                                                             |

Everything else in the file — the individual fetchers, `ingest`, `cmdSearch`,
`indexKeywords`, `recordSweep`, `summarize` — is module-private.

## 1.4 `docs/job-sources.yaml` — the board list you own

This file is the list of companies swept every day. It is **yours**: the code
reads it and never rewrites it behind your back, and the tooling that does edit
it (`manage-sources.mjs`) is something you run on purpose.

> **YAML** is a text format for configuration. `key: value` pairs, `- ` for list
> items, `#` for comments. `{ type: greenhouse, slug: anthropic }` is "flow
> style" — a whole object written on one line, which matters here for a reason
> given below.

The shape:

```yaml
boards:
  - { type: greenhouse, slug: anthropic, company: Anthropic }
  - { type: ashby, slug: linear, company: Linear }
  - { type: smartrecruiters, slug: BoydGaming, company: Boyd Gaming }
  - {
      type: workday,
      company: MGM Resorts International,
      host: mgmresorts.wd5.myworkdayjobs.com,
      tenant: mgmresorts,
      site: MGMCareers,
    }
  - {
      type: oracle_cloud,
      company: Station Casinos,
      host: ejfh.fa.us6.oraclecloud.com,
      site: StationCasinos,
    }
  - { type: successfactors, company: IGT, host: jobs.igt.com }
  - { type: jobvite, slug: agscareer, company: AGS }
  - {
      type: jobicy,
      company: Jobicy (remote US),
      geo: usa,
      industry: engineering,
    }
```

(In the real file each of those is genuinely on one physical line; they are
wrapped here only for readability.)

As of today the file holds **44 active entries**: 24 Greenhouse, 8 Ashby, 3
Workday, 2 Lever, 2 SmartRecruiters, 2 Oracle Cloud, 1 Jobvite, 1
SuccessFactors, 1 Jobicy. Two more (Remotive, RemoteOK) are commented out with
a note explaining that they measured zero useful results and can be switched
back on if you want them re-judged.

### What each board type needs

| Type                                                                       | Required keys                                 | Where the values come from                                                                                     |
| -------------------------------------------------------------------------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `greenhouse`, `lever`, `ashby`, `workable`, `recruitee`, `smartrecruiters` | `type`, `slug`, `company`                     | The `slug` is the company's name in its careers URL, e.g. `https://boards.greenhouse.io/**vercel**`.           |
| `workday`                                                                  | `type`, `company`, `host`, `tenant`, `site`   | From a careers URL of the form `https://<tenant>.wdN.myworkdayjobs.com/<site>`; `host` is that whole hostname. |
| `oracle_cloud`                                                             | `type`, `company`, `host`, `site`             | e.g. `host: edmn.fa.us2.oraclecloud.com`, `site: CX_1` — both visible in the careers-site URL.                 |
| `successfactors`                                                           | `type`, `company`, `host`                     | The career-site hostname, e.g. `jobs.igt.com`.                                                                 |
| `jobvite`                                                                  | `type`, `slug`, `company`; optional `eid`     | Without `eid` the code discovers it by reading the careers page once (see §1.5.9).                             |
| `jobicy`                                                                   | `type`, `company`; optional `geo`, `industry` | Defaults `geo: usa`, `industry: engineering`.                                                                  |
| `remotive`                                                                 | `type`, `company`; optional `category`        | Default `category: software-dev`.                                                                              |
| `remoteok`                                                                 | `type`, `company`                             | Takes no parameters at all.                                                                                    |

### Adding a board

Do it with the tool, not by hand, because the tool checks the board is real
before it writes:

```bash
node scripts/leads/manage-sources.mjs add --type ashby --slug acme --company "Acme Inc"
node scripts/leads/manage-sources.mjs add --type workday --company "Big Co" \
  --host bigco.wd5.myworkdayjobs.com --tenant bigco --site BigCoCareers
node scripts/leads/manage-sources.mjs remove "Acme Inc"
node scripts/leads/manage-sources.mjs verify     # re-checks every board is still alive
node scripts/leads/manage-sources.mjs list
```

`add` calls the very same `fetchBoard()` this file exports, live, before writing
the line — so a typo in the slug fails immediately with an HTTP error instead of
becoming a board that silently returns nothing for months. It also refuses
duplicates, and refuses an entry missing the keys its type needs (for example:
`workday boards need --host, --tenant, and --site`).

> **Do not run prettier on this file, and do not reformat it by hand.**
> `docs/job-sources.yaml` is listed in `.prettierignore`, and the reason is
> recorded there: `manage-sources.mjs` edits this file **line by line** to
> preserve the explanatory comments that a full YAML round-trip would delete.
> That only works while every board is one flow-style entry on one line.
> Prettier reflows the longer `workday` and `oracle_cloud` entries into
> multi-line block style, which silently breaks that contract. The file states
> the rule itself: "FORMAT RULE: one entry per line, flow style ({ ... })".

## 1.5 The board fetchers, one by one

A **fetcher** is one function per ATS type. Its whole job is: make the right web
request, and turn whatever comes back into one common object shape. Everything
downstream — both gates, dedupe, the database — only ever sees that common
shape, which is why adding a fourteenth board type does not require touching any
other part of the system.

`BOARD_FETCHERS` is the lookup table, and it is the definitive list of supported
types:

```js
const BOARD_FETCHERS = {
  greenhouse: fetchGreenhouse,
  lever: fetchLever,
  ashby: fetchAshby,
  smartrecruiters: fetchSmartRecruiters,
  workable: fetchWorkable,
  recruitee: fetchRecruitee,
  workday: fetchWorkday,
  oracle_cloud: fetchOracleCloud,
  jobvite: fetchJobvite,
  successfactors: fetchSuccessFactors,
  jobicy: fetchJobicy,
  remotive: fetchRemotive,
  remoteok: fetchRemoteOk,
}
```

`fetchHackerNews` and `fetchAdzuna` are **not** in that table. They are not
board types you can put in the YAML file; they are separate `--source` values
driven directly from `cmdSearch`.

### The common lead shape

Every fetcher returns an array of objects like this:

```js
{
  id: "greenhouse:vercel:1234567",     // globally unique, see below
  source: "greenhouse:vercel",         // which board it came from
  company: "Vercel",
  title: "Full Stack Engineer",
  location: "Remote - US",
  url: "https://job-boards.greenhouse.io/vercel/jobs/1234567",
  posted_at: "2026-07-30T12:00:00Z",   // ISO-8601 timestamp, or null

  // …plus these, only when the board actually supplies them:
  remote: true,                        // the board's own remote flag
  remote_source: true,                 // aggregators only — see §1.5.11
  salary_max: 190000,
  description: "…up to 4000 characters…",
  untrusted_findings: [ … ],           // OMITTED entirely when the posting is clean
}
```

> **ISO-8601** is the international standard way to write a timestamp:
> `2026-07-30T12:00:00Z` means 30 July 2026, 12:00, UTC. It sorts correctly as
> plain text, which is why it is used everywhere here instead of "July 30th".

### How a lead's `id` is formed

The `id` is the primary key in the database — the one value that must be unique
across every posting from every source, forever. It is built from strings the
board itself gave us, joined with colons:

| Source shape                                                                          | `id` pattern                                 | Real example                        |
| ------------------------------------------------------------------------------------- | -------------------------------------------- | ----------------------------------- |
| `greenhouse`, `lever`, `ashby`, `smartrecruiters`, `workable`, `recruitee`, `jobvite` | `<type>:<slug>:<board's own posting id>`     | `ashby:linear:8f2c-…`               |
| `workday`                                                                             | `workday:<tenant>:<reqId or externalPath>`   | `workday:mgmresorts:JR12345`        |
| `oracle_cloud`                                                                        | `oracle_cloud:<site>:<Id>`                   | `oracle_cloud:StationCasinos:22314` |
| `successfactors`                                                                      | `successfactors:<slug or host>:<numeric id>` | `successfactors:jobs.igt.com:98765` |
| `jobicy`, `remotive`, `remoteok`, `adzuna`, `hn`                                      | `<source>:<posting id>` — **two parts only** | `adzuna:5828399177`, `hn:41234567`  |

Two consequences of this design that matter:

1. Because the first segment is always the board type, `enrich.mjs` can recover
   which ATS a stored lead came from just by splitting the `id` (or `source`) on
   `:` and taking `[0]`. No lookup table, no dependence on the YAML file still
   listing that board.
2. Because the board's own posting id is in there, the same live posting
   produces the same lead id on every sweep — which is exactly what makes
   deduplication work.

### Master table: what every source gives you

This is the table to come back to. "Description in list?" is the single most
consequential column: it decides whether the body gate has anything to read
without a second network request per posting.

| Type              | Method | Paged?           | Description in the list response? | Salary?                    | Remote flag?            | Needs `enrich.mjs`?       |
| ----------------- | ------ | ---------------- | --------------------------------- | -------------------------- | ----------------------- | ------------------------- |
| `greenhouse`      | GET    | no               | **yes** (`?content=true`)         | no                         | no                      | no                        |
| `lever`           | GET    | no               | **yes**                           | `salaryRange.max`          | `workplaceType`         | no                        |
| `ashby`           | GET    | no               | **yes**                           | parsed from a text summary | `isRemote`              | no                        |
| `smartrecruiters` | GET    | yes, 100/page    | **no**                            | no                         | `location.remote`       | **yes**                   |
| `workable`        | GET    | no               | **no** (`?details=false`)         | no                         | `telecommuting`         | **no — see defect**       |
| `recruitee`       | GET    | no               | **yes**                           | no                         | `remote`                | no                        |
| `workday`         | POST   | yes, **20**/page | **no**                            | no                         | no                      | **yes**                   |
| `oracle_cloud`    | GET    | yes, 200/page    | partial (three fields)            | no                         | `WorkplaceType` (regex) | in principle — see defect |
| `jobvite`         | GET ×2 | no               | **yes** (XML feed)                | no                         | no                      | no                        |
| `successfactors`  | GET    | yes, 25/page     | **no** (HTML scrape)              | no                         | no                      | **yes**                   |
| `jobicy`          | GET    | no (50 fixed)    | **yes**                           | `salaryMax`                | forced `true`           | no                        |
| `remotive`        | GET    | no               | **yes**                           | parsed from text           | forced `true`           | no                        |
| `remoteok`        | GET    | no               | **yes** (~500 chars)              | `salary_max`               | forced `true`           | no                        |
| `hn`              | GET    | no               | **no** (never captured)           | no                         | from the title text     | no                        |
| `adzuna`          | GET    | yes, 50/page     | teaser only                       | `salary_max`               | no                      | no                        |

### The paging constants

> **Paging** (or pagination): an API that has 500 jobs will not hand you all 500
> in one response. It hands you the first N and expects you to ask again with an
> `offset` — "give me the next N starting at number 20". Getting this wrong is
> the single most common way to silently miss most of a board.

```js
const MAX_PAGES = 50 // runaway backstop for a board that never reports a total
const WORKDAY_PAGE = 20 // Workday's own hard cap per response
const ADZUNA_PAGE = 50
const ORACLE_PAGE = 200 // Oracle silently clamps anything above this
const SF_PAGE = 25 // SuccessFactors search page size
const JOBICY_COUNT = 50
```

The comment on `MAX_PAGES` explains its size: "50 pages is ~1000 postings per
board — well clear of the largest board seen (MGM, 505) while still bounding a
board that never reports a total."

---

### 1.5.1 `fetchGreenhouse(board)` — 24 of the 44 boards

- **Request:** `GET https://boards-api.greenhouse.io/v1/boards/{slug}/jobs?content=true`
- **Response shape:** `{ jobs: [ { id, title, location: {name}, absolute_url, first_published, updated_at, company_name, content } ] }`
- **Paging:** none. One request returns the whole board.

| Lead field    | Comes from                                      |
| ------------- | ----------------------------------------------- |
| `id`          | `greenhouse:{slug}:{j.id}`                      |
| `source`      | `greenhouse:{slug}`                             |
| `company`     | `j.company_name \|\| board.company`             |
| `title`       | `j.title`                                       |
| `location`    | `j.location?.name`                              |
| `url`         | `j.absolute_url`                                |
| `posted_at`   | `j.first_published \|\| j.updated_at \|\| null` |
| `description` | `untrustedSnippet(j.content)`                   |

The `?content=true` on the end of the URL is what asks for the description; drop
it and you get titles only. Greenhouse **double-encodes** its HTML (the text
contains `&amp;lt;p&amp;gt;` rather than `<p>`), which is why the shared
`textSnippet` helper runs its entity decoder twice.

No salary, no remote flag, no department. Location is a plain string.

### 1.5.2 `fetchLever(board)`

- **Request:** `GET https://api.lever.co/v0/postings/{slug}?mode=json`
- **Response shape:** a **top-level JSON array**, not an object — hence the
  `Array.isArray(data) ? data : []` guard.

| Lead field    | Comes from                                                                                                      |
| ------------- | --------------------------------------------------------------------------------------------------------------- |
| `id`          | `lever:{slug}:{j.id}`                                                                                           |
| `company`     | `board.company` (Lever's payload does not name it)                                                              |
| `title`       | `j.text` — note the odd field name                                                                              |
| `location`    | `j.categories?.location`                                                                                        |
| `remote`      | `j.workplaceType === "remote"`                                                                                  |
| `url`         | `j.hostedUrl`                                                                                                   |
| `posted_at`   | `new Date(j.createdAt).toISOString()` — `createdAt` is **epoch milliseconds**, a plain number                   |
| `salary_max`  | `j.salaryRange?.max`                                                                                            |
| `description` | `j.descriptionPlain ?? j.description`, plus every entry of `j.lists` rebuilt as `Heading: contents` — see below |

> **Epoch milliseconds**: many APIs express a moment in time as the number of
> milliseconds since 1 January 1970 UTC. `1785456000000` is a date. JavaScript's
> `new Date(n)` turns it back into one.

That last row is worth reading closely. Lever splits a posting into a prose
description plus a set of named `lists` ("Requirements", "Nice to have"), and
the fetcher rebuilds them so the structure survives into the stored snippet:

```js
...untrustedSnippet(
  j.descriptionPlain ?? j.description,
  (j.lists ?? []).map((l) => `${l.text}: ${l.content}`).join("\n"),
),
```

### 1.5.3 `fetchAshby(board)` — 8 of the 44 boards

- **Request:** `GET https://api.ashbyhq.com/posting-api/job-board/{slug}?includeCompensation=true`
- **Response shape:** `{ jobs: [ { id, title, location, secondaryLocations: [{location}], isRemote, isListed, jobUrl, applyUrl, publishedAt, compensation: {compensationTierSummary}, descriptionPlain, descriptionHtml } ] }`
- **Filter:** `.filter((j) => j.isListed !== false)` — unlisted (draft/internal)
  postings are dropped before anything else looks at them.

| Lead field    | Comes from                                                                             |
| ------------- | -------------------------------------------------------------------------------------- |
| `id`          | `ashby:{slug}:{j.id}`                                                                  |
| `location`    | `[j.location, ...secondaryLocations.map(s => s.location)].filter(Boolean).join(" / ")` |
| `remote`      | `j.isRemote === true`                                                                  |
| `url`         | `j.jobUrl \|\| j.applyUrl`                                                             |
| `posted_at`   | `j.publishedAt`                                                                        |
| `salary_max`  | `parseSalaryMax(j.compensation?.compensationTierSummary)`                              |
| `description` | `untrustedSnippet(j.descriptionPlain ?? j.descriptionHtml)`                            |

The salary line is the interesting one. Ashby does not hand over a number; it
hands over a human-readable summary like `"$150K – $220K • 0.15%"`, and
`parseSalaryMax` digs the largest dollar figure out of it:

```js
export function parseSalaryMax(text) {
  const matches = [
    ...String(text ?? "").matchAll(/\$\s*([\d,.]+)\s*(k)?/gi),
  ].map(([, num, k]) => {
    let n = Number(num.replace(/,/g, ""))
    if (k || n < 1000) n *= 1000
    return n
  })
  const valid = matches.filter((n) => Number.isFinite(n) && n >= 10000)
  return valid.length ? Math.max(...valid) : null
}
```

> **Regular expression** (regex): a compact pattern language for describing text
> you want to find. `/\$\s*([\d,.]+)\s*(k)?/gi` reads as: a literal `$`, then
> optional whitespace, then **capture** one or more digits/commas/dots, then
> optional whitespace, then optionally the letter `k`. The `g` flag means "find
> every match, not just the first"; `i` means "ignore case". `matchAll` returns
> all matches with their captured pieces.

The `n < 1000` rule means a bare `$220` is read as $220,000, and the `>= 10000`
filter throws away things like `$50` (a stipend) that were never a salary.

### 1.5.4 `fetchSmartRecruiters(board)` — paged

- **Request:** `GET https://api.smartrecruiters.com/v1/companies/{slug}/postings?limit=100&offset={offset}`
- **Response shape:** `{ totalFound, content: [ { id, name, company: {name}, location: {city, region, country, remote}, releasedDate } ] }`
- **Paging:** `total` is taken from `data.totalFound` whenever it is a number;
  the loop runs while `page < MAX_PAGES && offset < total`, advancing
  `offset += content.length`, and stops early if a page comes back empty.

| Lead field  | Comes from                                                          |
| ----------- | ------------------------------------------------------------------- |
| `id`        | `smartrecruiters:{slug}:{j.id}`                                     |
| `company`   | `j.company?.name \|\| board.company`                                |
| `title`     | `j.name`                                                            |
| `location`  | `[city, region, country].filter(Boolean).join(", ")`                |
| `remote`    | `j.location?.remote === true`                                       |
| `url`       | **built by hand:** `https://jobs.smartrecruiters.com/{slug}/{j.id}` |
| `posted_at` | `j.releasedDate`                                                    |

**No description.** This is one of the four types `enrich.mjs` exists for.

### 1.5.5 `fetchWorkable(board)`

- **Request:** `GET https://apply.workable.com/api/v1/widget/accounts/{slug}?details=false`
- **Response shape:** `{ name, jobs: [ { shortcode|code|id, title, city, state, country, telecommuting, url, published_on } ] }`

| Lead field  | Comes from                                                   |
| ----------- | ------------------------------------------------------------ |
| `id`        | `workable:{slug}:{j.shortcode ?? j.code ?? j.id}`            |
| `company`   | `data.name \|\| board.company`                               |
| `location`  | `[city, state, country].filter(Boolean).join(", ")`          |
| `remote`    | `j.telecommuting === true`                                   |
| `url`       | `j.url \|\| https://apply.workable.com/{slug}/j/{shortcode}` |
| `posted_at` | `j.published_on`                                             |

> **Known defect (2026-08-05 audit). A Workable lead can never have a
> description — ever.** The URL asks for `?details=false`, so the list response
> carries no body text, and `enrich.mjs`'s fetcher table has no `workable` key,
> so nothing ever fetches one later. The consequences cascade: the lead is not
> keyword-indexed, the body gate L1 passes it unexamined (an empty description
> always passes), the fit stage L2 has nothing to score, and it is not even
> flagged `no_description` — that flag is only set by `enrichDescriptions`,
> which never looks at Workable leads. `enrich.mjs`'s own header says "four of
> the swept ATS types return a list endpoint with no description"; the true
> count is five. The fix is either `?details=true` or a `workable` entry in
> `enrich.mjs`'s `FETCHERS`. There is no Workable board in
> `docs/job-sources.yaml` today, so this is latent rather than currently
> costing you leads — but it will bite the moment one is added.

### 1.5.6 `fetchRecruitee(board)`

- **Request:** `GET https://{slug}.recruitee.com/api/offers/` — note the slug is
  the **subdomain**, not a path segment.
- **Response shape:** `{ offers: [ { id, title, city, country, remote, careers_url, published_at, created_at, description, requirements } ] }`
- **Description:** `untrustedSnippet(j.description, j.requirements)` — both
  parts, concatenated.

### 1.5.7 `fetchWorkday(board, query)` — paged, POST, and the one server-side filter

- **Request:** `POST https://{host}/wday/cxs/{tenant}/{site}/jobs`
- **Body:** `{ appliedFacets: {}, limit: 20, offset, searchText: query ?? "" }`
- **Response shape:** `{ total, jobPostings: [ { title, externalPath, locationsText, postedOn, bulletFields: [reqId] } ] }`

> **GET vs POST.** A GET request asks for something and puts its parameters in
> the URL. A POST sends a body of data along with the request. Workday's search
> takes a JSON body, so this is the one fetcher here that POSTs. `fetchJson`
> switches automatically: `method: body ? "POST" : "GET"`.

| Lead field  | Comes from                                                             |
| ----------- | ---------------------------------------------------------------------- |
| `id`        | `workday:{tenant}:{j.bulletFields?.[0] ?? j.externalPath}`             |
| `title`     | `j.title`                                                              |
| `location`  | `workdayLocationFromPath(j.externalPath) \|\| j.locationsText \|\| ""` |
| `url`       | `https://{host}/en-US/{site}{j.externalPath}`                          |
| `posted_at` | `parseWorkdayPostedOn(j.postedOn)`                                     |

Two paging comments here are load-bearing, and both record a real failure:

> "Workday caps a response at 20 postings and reports the real count in `total`,
> so a single request silently returns the first page only. Left unpaged this
> saw 20 of Light & Wonder's 90 and 20 of Aristocrat's 170 — the boards looked
> alive while most of their jobs were invisible."

> "Workday reports `total` on the FIRST page only; every later page reports 0.
> Trusting it each time set total=0 on page two and ended the loop at 40 of 90 —
> a partial fix that looked like a working one."

That second one is the trap: the fix that _looks_ like it works. The code
therefore only reads `total` when `page === 0`:

```js
if (page === 0 && typeof data.total === "number" && data.total > 0) {
  total = data.total
}
```

Location is dug out of the URL path rather than the location field, because the
path is more reliable:

```js
// "/job/US-CA-Santa-Clara/Senior-Engineer_JR123" → "US CA Santa Clara"
export function workdayLocationFromPath(externalPath) {
  const m = /\/job\/([^/]+)\//.exec(String(externalPath ?? ""))
  return m ? m[1].replace(/-/g, " ") : ""
}
```

And the date arrives as human text, not a timestamp:

```js
export function parseWorkdayPostedOn(text, now = new Date()) {
  const t = String(text ?? "").toLowerCase()
  let days = null
  if (/today/.test(t)) days = 0
  else if (/yesterday/.test(t)) days = 1
  else {
    const m = /(\d+)\s*\+?\s*days?\s+ago/.exec(t)
    if (m) days = Number(m[1]) + (t.includes("+") ? 15 : 0)
  }
  if (days == null) return null
  return new Date(now.getTime() - days * 86400000).toISOString()
}
```

The `+ 15` is deliberate and is documented: `"Posted 30+ Days Ago"` becomes 45
days ago, which is past the default 30-day freshness limit. The comment says why:
"'30+' maps past the default freshness gate on purpose — a month-old posting is
stale AND a repost/ghost signal." Do not "fix" that to 30.

**No description** → enriched. **This is also the only fetcher where `--query`
does anything at the server** — see the trap in §1.11.

### 1.5.8 `fetchOracleCloud(board)` — paged, and the mandatory parameter

- **Request:**

```
GET https://{host}/hcmRestApi/resources/latest/recruitingCEJobRequisitions
      ?onlyData=true
      &expand=requisitionList.secondaryLocations
      &finder=findReqs;siteNumber={site},limit=200,offset={n},sortBy=POSTING_DATES_DESC
```

- **Response shape:** unusual — the whole page lives inside `data.items[0]`:
  `{ items: [ { TotalJobsCount, requisitionList: [ { Id, Title, PrimaryLocation, secondaryLocations: [{Name}], WorkplaceType, WorkplaceTypeCode, PostedDate, ShortDescriptionStr, ExternalResponsibilitiesStr, ExternalQualificationsStr } ] } ] }`

| Lead field    | Comes from                                                                                            |
| ------------- | ----------------------------------------------------------------------------------------------------- |
| `id`          | `oracle_cloud:{site}:{j.Id}`                                                                          |
| `location`    | `[j.PrimaryLocation, ...secondaryLocations.map(s => s.Name)].join(" / ")`                             |
| `remote`      | `/remote/i.test(j.WorkplaceType ?? j.WorkplaceTypeCode ?? "")`                                        |
| `url`         | `https://{host}/hcmUI/CandidateExperience/en/sites/{site}/job/{j.Id}`                                 |
| `posted_at`   | `j.PostedDate`                                                                                        |
| `description` | `untrustedSnippet(j.ShortDescriptionStr, j.ExternalResponsibilitiesStr, j.ExternalQualificationsStr)` |

The load-bearing comment:

> "`expand=requisitionList` is MANDATORY: without it the response still carries
> an accurate TotalJobsCount but an empty list, so the board reads as 'found,
> but empty' rather than as a broken query."

That failure mode — a request that looks successful and returns nothing — is the
worst kind, because no error is raised and the board just appears to have no
jobs. Two large Las Vegas employers live on this ATS (Caesars Entertainment and
Station Casinos), and the comment records that they "were invisible to the
sweep" before this fetcher existed.

### 1.5.9 `fetchJobvite(board)` — two requests, and XML

Jobvite is the awkward one, and the comment explains why the awkwardness is
worth it:

> "Jobvite exposes no JSON job list at all — the only public surface is an XML
> feed, but it is unauthenticated, unpaginated, and carries full descriptions
> and absolute apply URLs. The feed key is NOT the URL slug, so it is read once
> from the careers page. Cloudflare throttles the feed to roughly one request
> per 30s, which a daily sweep never notices."

**Step 1** (only when the board entry has no `eid`): fetch the careers page as
HTML and pull the feed key out of it.

```js
const html = await fetchText(`https://jobs.jobvite.com/${board.slug}/search`)
eid = /companyEId:\s*['"]([A-Za-z0-9]+)['"]/.exec(html)?.[1]
if (!eid)
  throw new Error(`could not read companyEId for jobvite slug "${board.slug}"`)
```

**Step 2:** `GET https://app.jobvite.com/CompanyJobs/Xml.aspx?c={eid}`, which
returns XML.

> **XML** is another structured text format, older than JSON and tag-based:
> `<job><title>Engineer</title></job>`. **CDATA** is an XML wrapper —
> `<![CDATA[ …raw text… ]]>` — used to carry text that would otherwise confuse
> the parser. The `cdata()` helper in this file strips that wrapper and decodes
> HTML entities.

`parseJobviteFeed(xml, board)` is exported separately, and the comment says
exactly why: "Exported so the brittle bit is unit-testable against a fixture: a
feed format change should fail a test, not silently return an empty board." It
splits on `<job>…</job>`, then reads:

| Lead field    | XML tag                                               |
| ------------- | ----------------------------------------------------- |
| id part       | `<id>` or, failing that, `<requisitionid>`            |
| `title`       | `<title>`                                             |
| `location`    | `<location>`                                          |
| `url`         | `<detail-url>` or `<apply-url>`                       |
| `posted_at`   | `<date>`, parsed as US `MM/DD/YYYY` by `parseUsDate`  |
| `description` | `untrustedSnippet(<briefdescription>, <description>)` |

`parseUsDate` returns `null` rather than guessing on any format it does not
recognise — a lead with an unknown date gets flagged `unknown_age`, which is far
safer than a lead with a wrong date.

### 1.5.10 `fetchSuccessFactors(board)` — HTML scraping, paged

- **Request:** `GET https://{host}/search/?q=&sortColumn=referencedate&sortDirection=desc&startrow={page * 25}`
- **Response:** an HTML web page. There is no API.

> "SAP SuccessFactors career sites (RMK) render results server-side and expose
> no JSON — verified by network capture, not assumed."

That last clause matters: somebody actually opened the browser's network tab and
checked, rather than assuming. **Scraping** — reading a page meant for humans and
pulling data out of the markup — is always the last resort, because a site
redesign breaks it silently.

The code contains two defences against that silence. First, both parsers are
exported so tests pin their behaviour against a saved fixture page. Second, the
row parser is written to be structurally safe:

> "Each result is a title anchor followed by its location and date spans, so
> slice from one anchor to the next and the fields cannot bleed across rows."

```js
const rowRe =
  /<a[^>]+class="[^"]*jobTitle-link[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>([\s\S]*?)(?=<a[^>]+class="[^"]*jobTitle-link|$)/g
```

The `(?=…)` at the end is a **lookahead** — "stop here, at the point where the
next job title link begins, but do not consume it". That is what keeps row 3's
location from being attached to row 2's title.

The total count is read off the page text (`parseSuccessFactorsTotal` looks for
`of <b>142</b>`) and returns `Infinity` if not found, so a parse failure means
"keep paging until the pages run out" rather than "stop at page one".

One more real detail: the location cell carries a multi-site suffix that would
otherwise be stored as part of the location, so it is stripped:

```
"Las Vegas, NV, US, 89113 +1 more…"   →   "Las Vegas, NV, US, 89113"
```

**No description** → enriched.

### 1.5.11 The remote-only aggregators — `jobicy`, `remotive`, `remoteok`

These three are not company boards. They are sites whose _entire_ catalogue is
remote jobs, aggregated from many employers. The block comment states the one
difference that matters:

> "These differ from every board above in one way that matters: their entire
> corpus is remote roles, so a posting's location field states WHO MAY BE HIRED
> ('USA', 'Anywhere') rather than where an office is. `remote_source: true`
> tells passesLimits to read it that way — without it the location gate called
> every one of them a relocation and threw the lot out."

That is why all three set `remote: true, remote_source: true` unconditionally on
every posting. It is not laziness; it is the fetcher asserting a fact about the
source that the individual posting's text cannot express.

> "They also return the FULL description in the list endpoint, so the body gate
> and keyword indexing work with no per-posting enrich round trip."

| Source     | Request                                                                                                             | Measured result (2026-07-29)                                                                                                                                  |
| ---------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `jobicy`   | `GET https://jobicy.com/api/v2/remote-jobs?count=50&geo={geo}&industry={industry}` (defaults `usa` / `engineering`) | **5 kept of 50 (10%)** — "Better than every tracked board except Render (8.8%)". Swept by default.                                                            |
| `remotive` | `GET https://remotive.com/api/remote-jobs?category={category}` (default `software-dev`)                             | 0 of 35 — "category filter is unreliable ('Patient Care Specialist' filed under software-dev) and the free tier caps a category at ~35 rows". Commented out.  |
| `remoteok` | `GET https://remoteok.com/api`                                                                                      | 0 of 100 — "~500-char descriptions, titles skew senior". Commented out. **Row 0 of the returned array "is a legal notice, not a posting"** and is sliced off. |

Field mappings differ per source, and they are worth having written down because
every aggregator names things differently:

| Lead field   | jobicy                             | remotive                        | remoteok                 |
| ------------ | ---------------------------------- | ------------------------------- | ------------------------ |
| `id`         | `jobicy:{j.id}`                    | `remotive:{j.id}`               | `remoteok:{j.id}`        |
| `company`    | `j.companyName`                    | `j.company_name`                | `j.company`              |
| `title`      | `j.jobTitle`                       | `j.title`                       | `j.position`             |
| `location`   | `j.jobGeo`                         | `j.candidate_required_location` | `j.location`             |
| `url`        | `j.url`                            | `j.url`                         | `j.url \|\| j.apply_url` |
| `posted_at`  | `j.pubDate`                        | `j.publication_date`            | `j.date`                 |
| `salary_max` | `Number(j.salaryMax)`              | `parseSalaryMax(j.salary)`      | `Number(j.salary_max)`   |
| description  | `j.jobDescription ?? j.jobExcerpt` | `j.description`                 | `j.description`          |

Two sources were evaluated and deliberately **not** added, and the reasoning is
in the code so nobody re-litigates it: The Muse (0 kept of 200 sampled — its
"entry level software engineering" category is dominated by SpaceX production
technicians and 93% were stale) and Arbeitnow (a German/EU catalogue the
location gate rejects wholesale).

### 1.5.12 `fetchHackerNews(query)`

- **Request:** `GET https://hn.algolia.com/api/v1/search_by_date?tags=job&query={q}&hitsPerPage=50`
- **Response shape:** `{ hits: [ { objectID, title, url, created_at } ] }`

Hacker News job posts are just titles and links, so company and location are
guessed out of the title text:

```js
// "Acme (YC W25) Is Hiring Full Stack Engineers (SF)" → company + location hint
const company = title
  .split(/\s+is hiring/i)[0]
  .replace(/\s*\(YC [^)]*\)\s*/i, " ")
  .trim()
const locMatch = /\(([^)]{2,40})\)\s*$/.exec(title)
```

So `"Acme (YC W25) Is Hiring Full Stack Engineers (SF)"` yields
`company: "Acme"`, `location: "SF"` — or `"Remote"` if the word "remote" appears
anywhere in the title, which takes priority. **No description is captured at
all**, and there is no enricher for it.

### 1.5.13 `fetchAdzuna(query, limits, env = loadEnv())`

Adzuna is a commercial job aggregator covering thousands of employers, including
many with no public feed of their own. It needs credentials.

- **Credentials:** `ADZUNA_APP_ID` / `ADZUNA_APP_KEY`, read from `.env`. The
  longer spellings `ADZUNA_APPLICATION_ID` / `ADZUNA_APPLICATION_KEY` are
  accepted as aliases "because Adzuna's own docs call these Application ID/Key".
  Missing credentials throw:
  `"not configured — copy .env.example to .env and set ADZUNA_APP_ID / ADZUNA_APP_KEY"`.

> A **`.env` file** is a plain text file of `KEY=value` lines holding secrets, kept
> out of version control. This project's `.env` is gitignored and never leaves
> the machine. `loadEnv()` is a 12-line parser: `#` comments are skipped,
> surrounding quotes are stripped.

- **Request:**

```
GET https://api.adzuna.com/v1/api/jobs/{country}/search/{page}
      ?app_id=…&app_key=…&results_per_page=50&max_days_old={maxAge}
      &what=…&where=…&distance=…
```

- **Two passes**, run one after the other and merged:

```js
const queries = [
  { what: query, where: base, distance: "50" }, // near your base, 50 miles
  { what: `${query} remote` }, // anywhere, remote
]
```

The comment on the end says why merging is safe: "cross-query duplicates fall out
in dedupeLeads".

- **A trap recorded in the code:** "The page number is a path segment, so
  'search/1' is literally page one and nothing else — the local Las Vegas
  results were being cut off at 50." Most APIs take the page as a query
  parameter; Adzuna puts it in the path, and the original code hard-coded `1`.

- **Description:** a teaser only, roughly 500 characters. The comment is candid:
  "Adzuna only returns a teaser, so this is deliberately partial".

> **Known defect (2026-08-05 audit).** That teaser is never marked as one.
> Nothing sets a `partial_description` field at ingest — `normalizeAdzunaJob`
> has a comment referring to `partial_description` handling but does not set it.
> The only thing that sets that field is `screen.mjs`, computing it later from a
> different question (`!captured?.description`). So downstream code cannot tell
> an Adzuna teaser from a complete Greenhouse description. Do not rely on the
> flag to tell you a description is a teaser.

> **Known defect (2026-08-05 audit): `loadEnv` cannot see variables that exist
> only in the real environment**, despite its comment saying "Real environment
> variables win over .env values". The override loop is
> `for (const k of Object.keys(out))` — it only iterates keys the `.env` file
> already contained. Setting `ADZUNA_APP_ID` purely as a shell environment
> variable, with no `.env` line, has no effect.

---

## 1.6 Gate L0 — `passesLimits(job, limits, now)`

This is the cheap gate. It reads only what a board's list response already gave
us — title, location, date, and salary if present — and it is what discards
thousands of postings per sweep for free.

It returns `{ ok, reasons[], flags[] }`, and the single most important line in
the whole function is the last one:

```js
return { ok: reasons.length === 0, reasons, flags }
```

**A reason rejects. A flag never rejects.** A flag is a breadcrumb — a note
attached to the lead that later stages read. Adding a `flags.push(...)` is
always safe. Adding a `reasons.push(...)` makes jobs invisible, and the project's
own instructions call that "the worst failure in this system". After changing
anything in this function, run:

```bash
node scripts/leads/gate-audit.mjs
```

which lists every lead each stage removed and why.

### The steps, in order

**Step 1 — the hard title filter.** `matchTitleKeyword(title, limits.roles?.hard_filter)`.
If any term matches, the function returns immediately:

```js
return {
  ok: false,
  reasons: [`title: "${hardHit}" is hard-filtered`],
  flags: [],
}
```

The comment explains the ordering: "Hard filter runs before everything else: a
title above the experience bar or in the wrong discipline is not worth geocoding,
dating, or storing."

The hard-filter list lives in `docs/application-limits.yaml` and is yours. Today
it contains seniority terms (`senior`, `sr`, `staff`, `principal`, `lead`,
`manager`, `director`, …), wrong-discipline terms (`technician`, `recruiter`,
`sales`, `designer`, `business analyst`, …) and wrong-career-stage terms
(`intern`, `apprentice`). The file records why the seniority list is what it is:
those bars come from the stated minimums in 47 postings read on a single day,
where the lowest "Senior" bar seen all day was 4+ years.

Matching is **whole word**, and the comment says why:

```js
// Whole-word title matching. Substring matching would make "sr" hit "usr" and
// "lead" hit "leading", so every hard/soft filter term is anchored on \b.
export function matchTitleKeyword(title, keywords) {
  return (keywords ?? []).find((k) => {
    const esc = String(k)
      .toLowerCase()
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    return new RegExp(`\\b${esc}\\b`, "i").test(title)
  })
}
```

> `\b` is a **word boundary** — the invisible position between a letter and a
> non-letter. `\blead\b` matches "Lead Engineer" but not "leading". The
> `.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")` line is **regex escaping**: your
> keyword `.net` contains a `.`, which means "any character" in a regex, so it
> is escaped to a literal dot first. Without that, a keyword could accidentally
> become a pattern.

**Step 2 — the soft title filter.** Same matching, but it only adds a flag:

```js
if (softHit) flags.push(`title_watch:${softHit}`)
```

"Soft filter never rejects — it marks the lead so screening reads the body before
any tailoring effort is spent."

**Step 3 — location.** This is the subtle part. First, three shapes of location
string that carry no geography at all are flagged rather than rejected:

```js
const OPAQUE_LOC = /^\d+\s*locations?$/i
const WORK_ARRANGEMENT_ONLY = /^(in[-\s]?office|on[-\s]?site|office|hybrid)$/i
if (!loc || OPAQUE_LOC.test(loc) || WORK_ARRANGEMENT_ONLY.test(loc)) {
  flags.push("unknown_location")
}
```

- Empty → nothing to judge.
- `"2 Locations"` → Workday's way of collapsing a multi-site posting. The
  comment: "Treating that as a location rejected it as a relocation — and
  multi-site postings skew towards exactly the roles worth seeing."
- `"Hybrid"` / `"In-Office"` → some Greenhouse boards (Cloudflare, measured
  2026-08-02) put the _work arrangement_ in the location field. The comment is
  precise about why this is matched on shape (the entire trimmed value) rather
  than by hard-coding two literals: `"Hybrid - San Francisco, New York"` still
  names real cities and falls through to the real check below. And
  `"Remote"` is **deliberately excluded** from this list — unlike "Hybrid", it
  _is_ informative, and it is read by the remote check instead.

Otherwise, five booleans are computed:

| Name             | Definition                                                                                                                                  |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `nonUsOnly`      | matches `NON_US` (france, germany, london, apac, canada, india, …) and does **not** match `US_MARK` (`united states\|usa?\|u.s.\|america`). |
| `onsiteOk`       | the location text contains one of `limits.location.onsite_allowed` (`north las vegas`, `las vegas`, `henderson`).                           |
| `usWide`         | `matchesAny(loc, limits.location?.remote_synonyms ?? US_WIDE_LOCATION)` — a whole-string match against the "who may be hired" list.         |
| `remoteBySource` | `job.remote_source === true` (the aggregators).                                                                                             |
| `remoteText`     | `(/\bremote\b/.test(loc) \|\| usWide) && !nonUsOnly`                                                                                        |
| `remoteFlagged`  | `(job.remote === true \|\| remoteBySource) && !nonUsOnly`                                                                                   |

And the verdict:

```js
const remoteOk =
  (limits.location?.remote_ok ?? true) && (remoteText || remoteFlagged)
if (!remoteOk && !onsiteOk) {
  reasons.push(
    `location: "${job.location}" would require relocating away from ${limits.location?.base ?? "base"}`,
  )
} else if (remoteOk && !remoteText && !remoteBySource && !onsiteOk) {
  flags.push("remote_unverified")
}
local = onsiteOk
```

That `remote_unverified` flag is the "the board says remote but the location text
does not agree" case — kept, but marked so screening confirms it.

The reason this is written so carefully is recorded in full:

> "Without this the gate read `location: "USA"` as 'would require relocating away
> from North Las Vegas' and threw the posting out. That is how every remote-only
> aggregator expresses US-remote, and on 2026-07-29 it rejected 35 of 35
> Remotive, 50 of 50 Jobicy and 100 of 100 RemoteOK postings — a false reject,
> which is the worst failure this pipeline has, aimed squarely at the remote
> roles that are most of the reachable market."

And the reason `matchesAny` is a whole-string test rather than a substring test:

> "A substring match would read 'Tulsa, USA' as country-wide remote, which it
> plainly is not — the point is that the location field names no city at all."

`matchesAny` normalises punctuation before comparing, so `"Remote (US)"` and
`"remote - us"` both land on the same list entry:

```js
const norm = (s) =>
  String(s ?? "")
    .toLowerCase()
    .replace(/[().,\-–—/]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
```

**Step 4 — the title keyword match.** Note the asymmetry with steps 1 and 2:

```js
const titleHit =
  !kws.length || kws.some((k) => title.includes(String(k).toLowerCase()))
```

This is a plain **substring** test, not a whole-word one, and that is on purpose:
`title_keywords` contains multi-word phrases like `"full stack"` and
`"software engineer"` where whole-word anchoring adds nothing, and substring
matching lets `"backend"` catch "Backend Developer, Payments".

If the title misses the keyword list, there is one escape hatch:

```js
if (
  !titleHit &&
  local &&
  LOOSE_TECH_TITLE.test(title) &&
  !TRADES_TITLE.test(title)
) {
  flags.push("title_loose")
} else if (!titleHit) {
  reasons.push("title: not a targeted role")
}
```

Read that carefully: the latitude requires `local`, meaning the job is in
commuting distance. The comment:

> "A commutable posting is rare enough to be worth a look even when its title
> misses the keyword list — Caesars' 'Staff Engineer - Booking Engine' is a real
> Las Vegas software job that matched none of them. Remote postings are NOT
> given this latitude: there are thousands and the gate is what keeps them
> manageable."

`LOOSE_TECH_TITLE` widens the net (`software|developer|programmer|engineer|architect|analyst|application|web|data|technical|systems?`).
`TRADES_TITLE` then subtracts, because:

> "A casino's 'engineers' are overwhelmingly facilities staff: painters,
> electricians, plumbers, stationary engineers. Stems, not whole words:
> `\bplumb\b` does not match 'Plumber'. 'General Engineer' is a casino
> facilities title, not a software one."

That is why `TRADES_TITLE` uses stems like `plumb\w*`, `paint\w*`, `electric\w*`
rather than whole words — `\w*` means "zero or more word characters", so
`plumb\w*` catches "plumber", "plumbing" and "plumb".

**Step 5 — freshness.**

```js
const maxAge = limits.freshness?.max_age_days ?? 30
```

- No `posted_at` → flag `unknown_age` (kept).
- Unparseable `posted_at` → flag `unknown_age` (kept).
- Older than `maxAge` → reject `stale: posted 42 days ago (max 30)`.

**Step 6 — salary.** Only active when `compensation.min_salary` is a number. In
your file today it is `null`, so this gate is switched off. When it is on, a
`salary_max` below the minimum rejects; a missing salary flags `no_salary`
unless `compensation.flag_missing` is explicitly `false`.

### A worked example

Input, straight out of `fetchAshby` on the `linear` board:

```js
{
  id: "ashby:linear:8f2c…",
  source: "ashby:linear",
  company: "Linear",
  title: "Product Engineer",
  location: "United States (Remote)",
  remote: true,
  url: "https://jobs.ashbyhq.com/linear/8f2c…",
  posted_at: "2026-07-30T00:00:00Z",
  salary_max: 220000,
  description: "You will build…"
}
```

Walking the gate on 2026-08-04:

1. **Hard filter** — no match. `senior`, `staff`, `manager` etc. are absent.
   Continue.
2. **Soft filter** — no match. No flag.
3. **Location** — `loc` is `"united states (remote)"`. Not empty, not
   `N Locations`, not arrangement-only, so the real check runs.
   `nonUsOnly` = false. `onsiteOk` = false (no Las Vegas in the string).
   `usWide`: `matchesAny` normalises the value to `"united states remote"`,
   which is **not** in the synonym list — so `usWide` is false. But
   `/\bremote\b/` matches the string, so `remoteText` is true, so `remoteOk` is
   true. No reason, no flag. `local` = false.
4. **Title** — `"product engineer"` is in `roles.title_keywords` (added
   2026-08-02), so `titleHit` is true. No latitude needed.
5. **Freshness** — 5 days old, under 30. Fine.
6. **Salary** — `min_salary` is `null`. Gate inactive.

Result: `{ ok: true, reasons: [], flags: [] }`. The posting becomes a survivor.

### `--explain`, and why it exists

When a title is rejected only for missing `roles.title_keywords`, that is
information about your keyword list, not about the job. `--explain` collects
those, filters them to software-ish titles, and ranks them:

```
Top 30 software-ish titles rejected by roles.title_keywords (of 412 distinct):
    18  Game Mathematician
    11  Gameplay Engineer
     7  Systems Developer
```

The comment on the filter says what this bought:

> "Tuning the keyword list by guesswork is what let 'Game Mathematician' sit
> unseen on a board for weeks; this makes the question answerable from data."

The flag is read straight out of `process.argv` inside `ingest`, so it works for
both `search` and `import`.

## 1.7 Gate L1 — `bodyDisqualifiers(job, limits)`

This gate reads the description. It runs **after** enrichment, because for five
board types the description does not exist until then.

The header comment is the clearest statement of why this gate exists:

> "passesLimits above reads only the title, location and date the board hands
> over in its list payload — the cheap fields. Everything that actually
> disqualifies a posting tends to be a sentence in its body, and until
> 2026-07-29 nothing in the sweep read that body at all."

The three real cases that forced it into existence, all named in the source:

1. **Station Casinos "Junior Engineer - Palace"** — passed the title gate on
   local latitude; its body is "Pick up supplies and parts from vendors. Perform
   all repairs, maintenance and part replacements… preventive maintenance
   schedule". A building-maintenance job sitting in the store as a software lead.
2. **Fusion HCR "Full Stack Developer"** — clean title, body says
   "Type: Contract (Through End of Year)".
3. **Twilio** — the board says remote; the body says both "This role will be
   based in our San Francisco, California office" _and_ "This role will be
   remote, but is not eligible to be hired in CA, CT, IL, …".

And the design rule, stated explicitly and worth internalising:

> "Precision over recall throughout. A false reject here is a job the user never
> sees, which is worse than a flag they can dismiss, so anything ambiguous FLAGS
> and leaves the judgment to screening. Only the unambiguous cases reject."

**A lead with no description passes**, unconditionally:

```js
const text = [job.description, ...(job.requirements ?? [])]
  .filter(Boolean)
  .join("\n")
if (!text) return { ok: true, reasons, flags }
```

A gate can only speak to text it actually has.

### The six checks

| #   | Check                                  | Verdict                                                                                                                                       |
| --- | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `SOFTWARE_BODY` vs `NON_SOFTWARE_BODY` | **reject** only if non-software vocabulary present AND no software vocabulary; **flag** `body_not_technical` if merely no software vocabulary |
| 2   | `RELOCATION_REQUIRED`                  | **reject**                                                                                                                                    |
| 3   | `SENIOR_IN_BODY`                       | **reject**, but only when the title states no level                                                                                           |
| 4   | `STATE_EXCLUSION`                      | **reject**, but only when the carve-out names your own state                                                                                  |
| 5   | `EMPLOYMENT_SHAPE`                     | **reject** if the kind is in `limits.employment.reject_types`, else **flag** `employment:<kind>`                                              |
| 6   | `ONSITE_BODY`                          | **flag** `onsite_conflict` only — never rejects                                                                                               |

**Check 1 — "is this a software job at all?"** Three pieces cooperate.

`SOFTWARE_BODY` is a list of phrases that only appear in postings about building
software. The comment explains the pitfall better than any paraphrase:

> "the first version of this matched bare 'code' and read Station Casinos' 'Be
> familiar with OSHA safety codes' as evidence of a software job. 'application'
> (job application), 'rest' (the rest of the team), 'framework' (regulatory
> framework) and 'library' all fail the same way and are excluded on purpose."

`NON_SOFTWARE_BODY` is three groups drawn from live postings — casino
facilities, hospitality/floor work, back-office finance — and every term is
chosen to be unambiguous inside a software posting:

> "'maintain cleanliness' not 'cleanliness' (code cleanliness), 'beverage
> server' not 'server', 'guest services' not 'guest'."

`explicitTech` is the trust shortcut: a title that names the discipline outright
skips this check entirely.

```js
const explicitTech =
  /\b(full[-\s]?stack|back[-\s]?end|front[-\s]?end|software (developer|engineer)|web developer|game (developer|engineer|mathematician))\b/i.test(
    title,
  )
const looseArrival =
  (job.flags ?? []).includes("title_loose") ||
  !titleKws.some((k) => title.includes(String(k).toLowerCase()))

const nonSoftwareBody = excludeBodyPattern(limits)
if (!explicitTech && (looseArrival || nonSoftwareBody.test(text))) {
  if (!SOFTWARE_BODY.test(text) && nonSoftwareBody.test(text)) {
    reasons.push("body: not a software role (no software work described)")
  } else if (!SOFTWARE_BODY.test(text)) {
    flags.push("body_not_technical")
  }
}
```

> **Known gap (2026-08-05).** `explicitTech` has not kept pace with your keyword
> list. It does not include the QA/SDET family (`qa engineer`, `sdet`,
> `test engineer`, `automation engineer`, `quality engineer`, added 2026-08-03)
> or `product engineer` / `forward deployed engineer` (added 2026-08-02). Those
> titles therefore do not get the "trusted discipline" shortcut here — they fall
> through to the full non-software check. That does not necessarily reject them
> (a QA posting will almost certainly match `SOFTWARE_BODY`), but it is a
> divergence between code and the config file you own, and the same divergence
> exists in `LOOSE_TECH_TITLE`, `TRADES_TITLE`, `SOFTWARE_BODY` and the
> `TECHY`/`NOT_TECHY` pair used by `--explain`. `excludeBodyPattern` shows the
> pattern for fixing it properly.

**Check 3 — a seniority bar the title hid.** The motivating case is
Chainguard's "Software Engineer (Libraries Platform)", whose body said "join as
a Senior Software Engineer". It only fires when the title states no level, with
the comment explaining why: "a posting titled 'Senior Backend Engineer' is
already rejected by the hard title filter, and reporting 'the title hid it'
about those would be plainly wrong."

> **Known defect (2026-08-05 audit).** `SENIOR_IN_BODY`'s alternation ends with
> a bare `as\s+an?`, which is far too loose. Ordinary prose in a genuinely
> mid-level posting — "You will pair with senior folks in roles such as a Senior
> Software Engineer" — matches it and the lead is **rejected**. That is a false
> reject, the failure mode this gate's own header calls the worst one available.

**Check 4 — state exclusions.** A global regex finds every "not eligible to be
hired in …" phrase, and the match is only decisive when the list names your
state:

```js
const base = String(limits.location?.base ?? "") // "North Las Vegas, NV"
const st = /,\s*([A-Z]{2})\b/.exec(base)?.[1] ?? "NV" // "NV"
const stateName =
  { NV: "nevada", CA: "california", AZ: "arizona", UT: "utah" }[st] ?? null
```

"a list that excludes California says nothing about Nevada." The state-name
table is deliberately tiny — it covers your state and its neighbours, and
returns `null` for anything else, in which case only the two-letter code is
matched.

**Check 5 — employment shape.** An array of `[regex, labelFn]` pairs turns a
matched phrase into a kind (`contract`, `temporary`, `part-time`, `seasonal`,
`internship`, `contract-to-hire`, `fixed-term`). The patterns are anchored on an
explicit type declaration or a duration:

> "so the word 'contract' inside 'contract law' or 'contract negotiation' (common
> in the analyst postings) cannot trip it."

There is a `break` after the first match, so a posting gets at most one
employment verdict.

> **Known defect (2026-08-05 audit): this check can never reject today.** It
> rejects only when the matched kind appears in `limits.employment?.reject_types`,
> and `docs/application-limits.yaml` has **no `employment:` block at all**. So
> the Fusion HCR "Full Stack Developer / Type: Contract" case — one of the three
> cases this whole gate was built for — is flagged `employment:contract` and
> stored as a normal `new` lead. Adding an `employment: reject_types: [contract, temporary]`
> block to that file would switch it on, but that file is yours; the fix is to
> propose it, not to make it. (The unit tests pass an inline limits object that
> _does_ contain `reject_types`, so the logic is proven correct while the wiring
> is absent.)

**Check 6 — on-site language.** Flags, never rejects, and the reason is Twilio:

> "the Twilio posting carries three mutually contradictory location sentences
> pasted one after another, so any single-sentence match is as likely to be
> stale boilerplate as it is to be the real requirement."

### `excludeBodyPattern(limits)` — the one user-overridable pattern

```js
export function excludeBodyPattern(limits = {}) {
  const custom = (limits.roles?.exclude_body ?? []).filter(
    (t) => String(t ?? "").trim() !== "",
  )
  if (!custom.length) return NON_SOFTWARE_BODY
  const alts = custom
    .map((t) =>
      String(t)
        .toLowerCase()
        .trim()
        .replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    )
    .sort((a, b) => b.length - a.length)
  return new RegExp(`\\b(?:${alts.join("|")})\\b`, "i")
}
```

Four decisions here are all deliberate and all documented:

1. **It replaces, never merges with, the built-in list** — the same convention
   `location.remote_synonyms` already uses. Leave the key out to use the
   built-in.
2. **It is a term list, never a boolean.** The comment is emphatic about why:
   "A `roles.skip_body_gate: true` escape hatch would let a retarget switch that
   whole control off; a term list only ever lets the user say WHAT it rejects
   on, never THAT it rejects."
3. **An empty array counts as absent.** "`exclude_body: []` would otherwise be
   exactly the off-switch this key exists to refuse, just spelled as a list
   instead of a boolean."
4. **Longest alternatives first.** In a regex alternation `(a|b|c)`, the first
   match wins, so a short term ("guest") would shadow a longer one it prefixes
   ("guest services"). Sorting by descending length prevents that.

Note also that terms are matched as literal phrases with word boundaries — never
as regex fragments — "so a user editing this list writes plain words, not
patterns."

## 1.8 Dedupe, and the repost signal

`dedupeLeads(candidates, existingLeads, applied)` answers two questions at once:
which candidates are genuinely new, and which of the dropped ones are evidence
that a job is being repeatedly re-posted.

The key used for the second question:

```js
const companyTitleKey = (x) =>
  `${String(x.company ?? "").toLowerCase()}::${String(x.title ?? "").toLowerCase()}`
```

The algorithm builds a `Set` (a collection with fast "is this in here?"
lookups) holding, for every already-stored lead: its `id`, its `normUrl(url)`,
**and** its `company::title` key. It also builds a `Map` from `company::title`
to the lead itself. Applied jobs contribute their `company::title` to a second
set.

Then for each candidate:

```js
const ct = companyTitleKey(c)
const keys = [c.id, c.url ? normUrl(c.url) : null, ct].filter(Boolean)
if (keys.some((k) => seen.has(k))) {
  // A DIFFERENT posting id for a company+title already stored is a repost.
  // The same id arriving again is just the same posting still being live,
  // which says nothing.
  const existing = byCompanyTitle.get(ct)
  if (existing && c.id && existing.id !== c.id && !seen.has(c.id)) {
    reposts.push({ lead: existing, candidate: c })
  }
  continue
}
if (appliedKeys.has(ct)) continue
keys.forEach((k) => seen.add(k))
fresh.push(c)
```

`normUrl` is what makes URL matching robust: it reduces a URL to
`origin + pathname`, lowercased, with the trailing slash and all query
parameters stripped. So
`https://Jobs.Example.com/careers/123/?utm_source=x` and
`https://jobs.example.com/careers/123` are recognised as the same posting.

### Why reposts are captured at all

This is one of the most valuable comments in the repository:

> "Reposting is the strongest ghost-job signal there is, and this function is
> where the evidence was being destroyed: a posting taken down and put back up
> arrives with a fresh board id and a fresh date, matches an existing lead on
> company+title, and was silently discarded. The lead store therefore contained
> ZERO repeated company+title pairs by construction, so L3's repost check had
> nothing to read. The sighting is the signal; ingest records it against the
> lead already stored."

> A **ghost job** is a posting that is not really being hired for — kept open to
> collect résumés, to look like the company is growing, or through simple
> neglect. Applying to one is wasted effort, so detecting them matters.

And the deliberate non-signal: "The same id arriving again is just the same
posting still being live, which says nothing."

### The return shape, and why not to tidy it

```js
fresh.reposts = reposts
return fresh
```

This is an **array with an extra property attached** — unusual JavaScript, and
the comment pre-empts the urge to clean it up:

> "Array-with-extras: every existing caller destructures or iterates this as the
> list of fresh candidates, and changing that shape would touch the import path,
> board-yield, discover-boards and three tests for no gain."

### What a repost sighting does to the stored lead

Inside the locked commit (§1.9), each sighting is applied to the fresh copy of
the already-stored lead:

```js
freshLead.repost_count = (freshLead.repost_count ?? 0) + 1
freshLead.first_seen_at ??= freshLead.found_at ?? now.toISOString()
freshLead.last_seen_at = now.toISOString()
if (candidate.posted_at) freshLead.last_reposted_at = candidate.posted_at
```

`repost_count` is read by stage L3 (`scripts/leads/risk.mjs`), where
`repost_caution = 1` and `repost_reject = 3`. At three, the lead is **rejected**
as a probable ghost job.

> **Known defect (2026-08-05 audit): `repost_count` counts sweeps, not
> reposts.** Trace it: a candidate whose `company::title` matches a stored lead
> but whose own `id` is new records a repost sighting — and is then dropped
> (`continue`), so its id is never added to the store. On the next sweep, the
> _same live posting_ arrives again, its id is still not stored, and it is
> counted as a repost again. And again.
>
> Failing input: Acme has two genuinely different openings both titled "Software
> Engineer" (`greenhouse:acme:111` already stored, `greenhouse:acme:222` live and
> new). Sweep 1 sets `repost_count: 1`; sweep 2, `2`; sweep 3, `3` — and L3 now
> rejects the stored lead as a ghost job. Meanwhile the second, entirely real
> opening was never storable in the first place, because the store cannot hold
> two leads with the same company+title.
>
> The fix has a clear shape: keep the set of distinct foreign ids seen per lead
> (`repost_ids`) and increment only on an id not seen before.

> **Related gap (not a defect, but a missed signal).** A same-id re-sighting is
> discarded entirely. It says two things worth money: the posting is still open
> today (which, with `found_at`, gives the days-open number
> `ghost_signals.repost_age_days: 30` is asking for), and a lead that _stops_
> appearing has been filled or pulled — exactly the application not worth
> sending. Stamping `last_seen_at` on every stored lead whose id appeared in
> this sweep would capture both.

## 1.9 `ingest()` — the heart of the file, and the locked commit

`async function ingest(candidates, limits, { enrich = true, leadsFile = null } = {})`

The order of operations, and the reason for each:

1. **Choose the lock path.** `lockPathFor(resolveLeadSource(leadsFile).file)`
   when `--leads` was given, else the module-level `LEADS_LOCK` (which is
   `jobs/leads.db.lock`).
2. **Read the store, unlocked, to plan.** `loadLeads(leadsFile)` and
   `loadApplied()`.
3. **Dedupe.** `dedupeLeads(candidates, store.leads, applied)`.
4. **Gate L0** over the deduped candidates. Rejects collect into `rejected`
   (with their reasons); survivors carry L0's flags forward.
5. **Enrich** — the network step. `await enrichDescriptions(survivors)`, unless
   `--no-enrich`.
6. **Canonicalize.** `await canonicalizeLeads(survivors, { network: false })`
   stamps `apply_url`, `apply_ats` and `apply_url_via` (or
   `apply_url_unresolved`) so the auto-apply trust gate later has an ATS-hosted
   URL to check. Offline on this path, deliberately:

   > "the network tier resolves aggregator links and was measured at 0/21 on the
   > two aggregators this store actually uses (M10), so paying a per-lead HTTP
   > request on every sweep would buy a measured nothing."

7. **Gate L1** over the survivors. Whatever passes becomes `kept`, stamped:

   ```js
   kept.push({
     ...s,
     flags: [...new Set([...(s.flags ?? []), ...body.flags])],
     status: "new",
     found_at: now.toISOString(),
     notes: "",
   })
   ```

8. **The locked commit.**
9. `indexKeywords(committed, leadsFile)`.
10. `summarize(committed, rejected, …)` plus the enrichment and backfill counts.

### Why the lock is where it is

> A **file lock** is a small marker file that says "I am working on this data
> right now". Any other process that wants to write checks for it first and
> waits. Without one, two processes that both read, both change, and both write
> will have one silently overwrite the other's changes — a **race condition**.

The comment on `ingest` is the single most important explanation in this file,
and it is quoted here nearly in full because the reasoning is what stops someone
"tidying" it into a bug:

> "**THE COMMIT IS LOCKED, THE FETCHES ARE NOT.** `store` below is read once,
> unlocked, purely to plan this call's work: which candidates are new (worth
> screening/enriching) and which are repost sightings against what THIS process
> currently believes is stored. That plan does not need to be millisecond-fresh
> — being a few ms stale just means an occasional repost goes undetected until
> the next sweep, which is the pre-existing precision of this signal.
>
> What must never run on stale data is the WRITE. `writeLeadStore` upserts every
> lead object it is given, doc column and all — so committing an in-memory copy
> read before another process's write clobbers whatever that process changed in
> the interim (a status set by `mark`, a repost counter from another sweep, a
> screening verdict). … The fix is to re-read fresh, apply this call's changes
> to THAT copy, and write it back — all inside LEADS_LOCK, and with nothing
> added to the critical section that doesn't need to be there.
>
> Board fetches happen before `ingest` is even called; `enrichDescriptions` runs
> inside it but stays OUTSIDE the lock deliberately — those requests can run long
> enough to vastly exceed the lock's staleMs, and holding the lock across them
> would make a concurrent writer legitimately break this one as abandoned
> mid-sweep."

That last point is the subtle one. The lock can be broken by another process if
it looks abandoned (older than `DEFAULT_STALE_MS`, 10 seconds). A slow network
fetch inside the lock would therefore _cause_ the very takeover the lock exists
to prevent.

### Inside the critical section

```js
const { committed, backfilled } = withLock(lockPath, (handle) => {
  const fresh = loadLeads(leadsFile)                              // 1. re-read
  const backfilledNow = backfillDescriptions(candidates, fresh.leads) // 2. backfill

  for (const { lead, candidate } of repostSightings) {            // 3. reposts
    const freshLead = fresh.leads.find((l) => l.id === lead.id)
    if (!freshLead) continue        // lead vanished between the plan and the commit
    freshLead.repost_count = (freshLead.repost_count ?? 0) + 1
    …
  }

  const existingKeys = new Set()                                  // 4. cheap re-check
  for (const l of fresh.leads) {
    if (l.id) existingKeys.add(l.id)
    if (l.url) existingKeys.add(normUrl(l.url))
  }
  const freshKept = kept.filter(
    (k) => !existingKeys.has(k.id) && !existingKeys.has(normUrl(k.url)),
  )
  fresh.leads.push(...freshKept)

  if (!handle.stillHeld()) {                                      // 5. still mine?
    throw new Error("LEADS_LOCK was broken while ingest held it — …")
  }
  saveLeads(fresh, leadsFile)                                     // 6. write
  return { committed: freshKept, backfilled: backfilledNow }
})
```

Step 5 deserves its own note, because it looks redundant:

> "the explicit `stillHeld()` check below is on purpose IN ADDITION to
> withLock's own post-check — that one fires only AFTER `fn` returns, which is
> too late to stop a write that already ran. Checking immediately before
> `saveLeads` is what actually prevents a dispossessed holder from publishing
> over the process that replaced it."

Step 4 is the second safety net: a concurrent sweep might have inserted one of
these same candidates between the planning dedupe and this commit. This check is
deliberately cheap (id and URL only, not the full company+title dedupe) and
changes nothing in the normal uncontended case.

Step 3's `if (!freshLead) continue` handles the lead having been deleted between
plan and commit.

## 1.10 What it reads and writes

**Reads:**

| Path                                   | What for                                                                                                                                                                                                                                                                                                                                                        |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/job-sources.yaml`                | The board list (`loadSources`).                                                                                                                                                                                                                                                                                                                                 |
| `docs/application-limits.yaml`         | Your policy (`loadLimits`). Keys used: `location.base`, `location.remote_ok`, `location.onsite_allowed`, `location.remote_synonyms`, `freshness.max_age_days`, `compensation.min_salary`, `compensation.flag_missing`, `roles.title_keywords`, `roles.hard_filter`, `roles.soft_filter`, `roles.exclude_body`, `roles.search_query`, `employment.reject_types`. |
| `.env`                                 | `ADZUNA_APP_ID`, `ADZUNA_APP_KEY`, `ADZUNA_COUNTRY` only. Never printed, never committed.                                                                                                                                                                                                                                                                       |
| `jobs/leads.db` (table `leads`)        | Everything already stored, twice per ingest (plan, then commit).                                                                                                                                                                                                                                                                                                |
| `jobs/leads.db` (table `applications`) | To avoid re-storing a job you already applied to.                                                                                                                                                                                                                                                                                                               |

> **Never edit `docs/application-limits.yaml` on the user's behalf.** It is
> yours; the code reads it and the agent proposes values to you. Note also that
> `roles.exclude_body`, `roles.search_query` and the whole `employment:` block
> are **optional and currently absent** — the code handles their absence, which
> is why the employment gate cannot reject today.

**Writes:**

| Table / path         | What                                                                                                                                                                                                 |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `leads`              | One row per lead. Columns: `id` (primary key), `status`, `company`, `title`, `posted_at`, `doc`.                                                                                                     |
| `lead_keywords`      | `(lead_id, keyword)` — one row per tech term found in the lead's title + description + requirements.                                                                                                 |
| `board_stats`        | One row per board, upserted per sweep: `board_id`, `type`, `slug`, `company`, `last_swept`, `live_postings`, `qualifying`, `solid`, `leads_produced`, `last_qualifying_at`, `sweeps`, `zero_streak`. |
| `jobs/leads.db.lock` | The lock file, created and removed by `withLock`.                                                                                                                                                    |

The `leads` table's shape is unusual and deliberate: four denormalized columns
for indexing, plus `doc TEXT NOT NULL` holding the complete lead object as JSON,
verbatim. The reason, from `db.mjs`:

> "This shape was chosen after a column-per-field version failed its own
> round-trip check on 73 of 99 real leads: mapping fields by hand cannot
> distinguish `flags: []` from no flags, or `notes: ""` from `notes: null` …
> Keeping the document verbatim makes fidelity structural."

> An **UPSERT** is "insert this row, or if a row with the same primary key
> already exists, update it instead". SQL spells it
> `INSERT … ON CONFLICT(id) DO UPDATE SET …`. `writeLeadStore` upserts every
> lead in the array it is given, inside one transaction (`BEGIN` … `COMMIT`, so
> either all of it lands or none of it does).

`lead_keywords` exists so that later analysis is a database `GROUP BY` rather
than re-parsing every stored description:

> "Extract each new lead's tech keywords once, at ingest, so later analysis is a
> GROUP BY instead of re-parsing every stored description."

Note `indexKeywords` includes `requirements` in the text it scans, with a reason:
an imported lead (captured by hand) carries its qualifications as a separate
array rather than folded into the description, "and those bullets are precisely
where the demanded stack is named."

> **Half-closed (P6, 2026-08-17). `board_stats` now HAS a reader:**
> `board-yield.mjs --history` reads the table offline and proposes removals from
> it, and the table gained `sweeps` + `zero_streak` so a dry spell is countable
> instead of merely implied by `last_qualifying_at` failing to move. Measured on
> 57 boards: 5 ms offline vs 22.6 s for the live audit, which is why history is
> the default and `--live` is opt-in.
>
> **The second-order bug in what is WRITTEN is still open.** `recordSweep`
> computes `solid` by re-running `passesLimits` over the raw postings _before_
> dedupe, stores that as `leads_produced`, and `recordBoardStats`
> **accumulates** it
> (`leads_produced = board_stats.leads_produced + excluded.leads_produced`). So
> postings already in the store are counted again every sweep, and
> `leads_produced` grows without bound and does not mean "leads produced". Read
> that column as "how often this board has had something reachable on it", never
> as a lead count — and note the removal rules deliberately do **not** key off
> it for exactly this reason.

> **Known defect (2026-08-05 audit): `recordSweep` ignores `--leads`.** It calls
> `resolveLeadSource()` with no argument, so
> `find-jobs.mjs search --leads /tmp/scratch.db` still writes `board_stats` rows
> into the real `jobs/leads.db`. The function twenty lines above it,
> `indexKeywords`, carries a long comment about that exact bug having been fixed
> _there_ — "this used to always resolve the default (real) store regardless of
> a `--leads` override, which meant a scratch-store run (any test using
> `--leads`) quietly wrote keyword rows into the real jobs/leads.db." The same
> fix was never applied to `recordSweep`.

Both `indexKeywords` and `recordSweep` swallow their own errors
(`console.error("warn: …")`) rather than throwing, because "a keyword-index
failure must never lose a lead that was already saved."

## 1.11 Traps and things not to "fix"

**T1 — Flags never reject; reasons always do.** `ok` is literally
`reasons.length === 0`. Adding a `flags.push` is safe. Adding a `reasons.push`
makes jobs invisible. Run `node scripts/leads/gate-audit.mjs` after any gate
change.

**T2 — `US_WIDE_LOCATION` is matched against the WHOLE string.** A substring
match would read "Tulsa, USA" as country-wide remote.

**T3 — The two title lists are matched differently, on purpose.** `hard_filter`
and `soft_filter` go through `matchTitleKeyword`, which is whole-word
(`\b`-anchored). `title_keywords` goes through plain `title.includes(...)`,
which is substring. This is not an oversight; the lists contain different kinds
of term.

**T4 — `parseWorkdayPostedOn("Posted 30+ Days Ago")` returns 45 days ago, not 30.** Deliberate: "a month-old posting is stale AND a repost/ghost signal."

**T5 — Workday's `total` is trustworthy only on page 0.** Re-reading it on later
pages sets it to 0 and ends the loop early, which is a bug that looks like a fix.

**T6 — `--query` is a server-side filter on Workday and nothing else.** This one
is worth understanding fully, because it silently shapes what you see. The
comment on `DEFAULT_SEARCH_QUERY` explains:

> "Workday is the one fetcher of thirteen where the query is a server-side
> filter (searchText), so any caller that omitted the query (this file's own
> tests, manage-sources.mjs, a diagnostic script) silently got a different
> result set than production ever runs with."

Every other board returns its entire list and is filtered locally against your
27-entry `roles.title_keywords`. Workday filters **before** this code sees
anything.

> **Consequence worth knowing (2026-08-05).** The three Workday boards are Light
> & Wonder, Aristocrat and MGM Resorts — the Las Vegas gaming employers, i.e.
> exactly the second track of your two-track search. On those three boards a "QA
> Engineer", "SDET", "Game Mathematician", "Gameplay Engineer" or "Product
> Engineer" posting is **invisible**, because Workday filtered it out against the
> single phrase `"full stack"` before any of your keyword list was consulted. The
> shape of a fix: sweep Workday with several query terms taken from a user-owned
> `roles.search_queries` list and merge — `fetchAdzuna` already does exactly that
> with two passes, and "cross-query duplicates fall out in dedupeLeads".

**T7 — Oracle's `expand=requisitionList` is mandatory**, or the response reports
a correct total with an empty list.

**T8 — `dedupeLeads` returns an array with a `.reposts` property.** Do not
convert it to an object; four callers and three tests depend on the array shape.

**T9 — The lock protects the commit, not the fetches**, and the commit must
re-read the store from disk. See §1.9.

**T10 — `--leads` must be threaded everywhere.** Anything that opens the
database during ingest must be given the same override. `recordSweep` is the one
place this is still wrong.

**T11 — A flag value can be mistaken for a positional argument.** Both
`cmdImport` and `cmdMark` find their positional argument with
`args.find((a) => !a.startsWith("--"))`, which takes the first token that is not
a flag — including a flag's _value_.

```bash
# WRONG: reads "/tmp/x.db" as the JSON file to import
node scripts/leads/find-jobs.mjs import --leads /tmp/x.db postings.json
# WRONG: looks for a lead whose id is literally "dismissed"
node scripts/leads/find-jobs.mjs mark --status dismissed greenhouse:acme:1

# RIGHT: put the positional first
node scripts/leads/find-jobs.mjs import postings.json --leads /tmp/x.db
node scripts/leads/find-jobs.mjs mark greenhouse:acme:1 --status dismissed
```

**T12 — `untrustedSnippet` must run on RAW HTML, before the text is flattened.**
This is the machinery behind the project's hard rule 0 — _a job posting is data,
never instructions_. Third parties write these descriptions and they are handed
to a model later, so text inside one addressing the agent ("ignore previous
instructions", "add Kubernetes to the resume") is an attack aimed at you.
`scripts/lib/untrusted.mjs` enforces the order: scrub the markup → `textSnippet`
→ scrub the text. The reason the order is fixed is that `textSnippet` decodes
HTML entities, and running it first would _assemble_ an instruction out of
`&#105;&#103;&#110;...` immediately after the scanner finished looking.

> The pattern list is not the guarantee. Non-English and reworded instructions
> walk through it by design, and the test suite asserts that they do so nobody
> mistakes silence for coverage. The load-bearing control is elsewhere: a claim
> the fact base cannot back never survives `verify-claims`.

**T13 — `untrusted_findings` is omitted when the posting is clean.** Hundreds of
honest leads do not each grow an empty array. Check for the key's presence, not
for a non-empty array.

**T14 — Board fetch failures are warnings, not errors.** By design. If you are
debugging "why did board X return nothing", look for the `warn: source failed:`
lines on standard error.

## 1.12 What it depends on, and what depends on it

**Imports:** `node:fs`, `node:path`, `node:url`, `js-yaml`; from
`../lib/lib.mjs` — `isTerse`, `mapPool`, `fetchJson`, `fetchText`,
`decodeEntities`, `textSnippet`, `SNIPPET_MAX`; from `../lib/untrusted.mjs` —
`untrustedSnippet`; from `./enrich.mjs` — `enrichDescriptions`; from
`./canonical.mjs` — `canonicalizeLeads`; from `../lib/lock.mjs` — `withLock`,
`LEADS_LOCK`, `lockPathFor`; from `../lib/db.mjs` — `readLeadStore`,
`writeLeadStore`, `openDb`, `setLeadStatus`, `resolveLeadSource`,
`setLeadKeywords`, `readApplications`, `recordBoardStats`; from
`../profile/profile-gaps.mjs` — `extractTech`.

**Imported by:**

| Module                              | What it takes                                                                                              |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `scripts/leads/stages.mjs`          | `passesLimits`, `bodyDisqualifiers`                                                                        |
| `scripts/leads/screen.mjs`          | `loadLimits`                                                                                               |
| `scripts/leads/recommend.mjs`       | `matchTitleKeyword`, `loadLimits`                                                                          |
| `scripts/leads/gate-audit.mjs`      | `loadLimits`                                                                                               |
| `scripts/leads/board-yield.mjs`     | `loadSources`, `loadLimits`, `passesLimits`, `fetchBoard`                                                  |
| `scripts/leads/discover-boards.mjs` | `loadSources`, `loadLimits`, `fetchBoard`                                                                  |
| `scripts/leads/find-boards.mjs`     | `loadSources`                                                                                              |
| `scripts/leads/manage-sources.mjs`  | `fetchBoard`, `BOARD_TYPES`, `loadSources`, `loadLimits`, `DEFAULT_SEARCH_QUERY`                           |
| `scripts/maintenance/archive.mjs`   | `loadLimits`                                                                                               |
| `scripts/auto/cycle.mjs`            | Spawns the CLI: `step("scripts/leads/find-jobs.mjs", ["search", "--source", "all"], { timeout: 600_000 })` |
| `.claude/skills/find-jobs/SKILL.md` | Runs `search --source all --query "full stack"`                                                            |

---

# Part 2 — `scripts/leads/enrich.mjs`

## 2.1 What it is and why it exists

Four ATS types hand over a list of jobs with no description text whatsoever. For
those, this module makes one extra request per surviving posting to the job's
own detail page or detail API, and fills in `lead.description`.

Its header is the clearest statement of value anywhere in this domain:

> "Why this exists: four of the swept ATS types return a _list_ endpoint with no
> description at all (oracle_cloud, smartrecruiters, successfactors, workday).
> On 2026-07-29 that was 19 of 102 stored leads — and not a random 19: those
> boards are Caesars, Station Casinos, Boyd Gaming, IGT and CVS, i.e. the local
> Las Vegas employers, which are the highest-value leads for a North Las Vegas
> applicant precisely because on-site is in scope for them. A lead with no
> description cannot be keyword-indexed and cannot be blocker-screened, so those
> leads were the least examinable and the most important at once."

> "What it cost to not have this: Station Casinos' 'Junior Engineer - Palace'
> passed the title gate on local latitude and sat in the store as a software
> lead. Its description is 'Pick up supplies and parts from vendors. Perform all
> repairs, maintenance and part replacements…' — a building-maintenance job.
> Nothing in the pipeline could see that, because nothing had the text."

That is the answer to "why do four ATS types need this": **their list endpoint
does not carry a description, and the description is where every real
disqualifier lives.** A job title tells you almost nothing. The gate that would
have caught "Junior Engineer - Palace" — L1's non-software body check — cannot
run without text, and returns `ok: true` on an empty description by design.

The fifth is `workable`, which also carries no description in its list response
and which this module does **not** handle — see the defect note in §1.5.5.

And the cost discipline, which explains why this runs where it does in `ingest`:

> "Latency discipline: these are N extra round trips, one per posting, so they
> run ONLY for postings that already survived the cheap title/location/freshness
> gates. That is single digits per sweep, not the hundreds the list endpoints
> return. Failures are per-posting and swallowed: a detail endpoint that 404s
> must never lose a lead the sweep already found."

## 2.2 How you run or use it

**As a library** — this is the main path. `find-jobs.mjs`'s `ingest` calls it:

```js
let enriched = { filled: 0, attempted: 0, failures: [] }
if (enrich && survivors.length) {
  enriched = await enrichDescriptions(survivors)
}
```

**As a CLI** — for backfilling leads that were stored before their board had a
detail fetcher:

```bash
node scripts/leads/enrich.mjs            # dry run: prints "would-fetch <id>" per candidate
node scripts/leads/enrich.mjs --apply    # actually fetches and writes
```

It is **dry by default** (`const dry = !args.includes("--apply")`), which is the
right default for anything that makes network requests and writes to the
database.

Real output from a dry run just now:

```
enriched=0/0
```

(That means every stored lead that _could_ be enriched already has text — which
is the normal state.) With candidates present it prints one `would-fetch <id>`
line each, then `candidates=7 apply=false`.

> "Flat and idempotent: a lead that already has a description is skipped, so
> re-running costs nothing."

> **Idempotent** means running it twice does the same thing as running it once.
> That property is what makes a backfill script safe to re-run without thinking
> about it.

Exit codes: `0` on success, `1` on any thrown error (printed as
`error: <message>`). It throws `"no lead database to enrich"` if the store
resolves to the legacy JSON file rather than SQLite.

## 2.3 Everything it exposes

| Export                                                              | Signature                           | What it does                                                                                                                                                 |
| ------------------------------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `oracleDetailUrl(url)`                                              | → detail URL or `null`              | Rewrites a candidate-experience page URL into the REST detail URL. See below.                                                                                |
| `smartRecruitersDetailUrl(url)`                                     | → URL or `null`                     | `https://jobs.smartrecruiters.com/{co}/{id}` → `https://api.smartrecruiters.com/v1/companies/{co}/postings/{id}`                                             |
| `workdayDetailUrl(url, id = "")`                                    | → URL or `null`                     | `/{lang}/{site}{externalPath}` → `/wday/cxs/{tenant}/{site}{externalPath}`                                                                                   |
| `oracleDescription(payload)`                                        | → `{text, findings, clean}`         | Concatenates four fields from `payload.items[0]`.                                                                                                            |
| `smartRecruitersDescription(payload)`                               | → `{text, findings, clean}`         | `jobAd.sections.jobDescription.text`, `.qualifications.text`, `.additionalInformation.text`                                                                  |
| `successFactorsDescription(html)`                                   | → `{text, findings, clean}`         | Slices the `class="…jobdescription…"` span out of the page.                                                                                                  |
| `workdayDescription(payload)`                                       | → `{text, findings, clean}`         | `jobPostingInfo.jobDescription` + `jobPostingInfo.jobRequisitionLocation.descriptor`                                                                         |
| `canEnrich(lead)`                                                   | → boolean                           | `!lead?.description && Boolean(FETCHERS[<source prefix>])`                                                                                                   |
| `enrichDescriptions(leads, {concurrency = 6, fetchers = FETCHERS})` | → `{filled, attempted, failures[]}` | The main entry point. **Mutates the leads in place.**                                                                                                        |
| `decodeEntities`                                                    | re-export from `lib.mjs`            | **Dead.** Nothing imports it from here; the three real users import it from `scripts/lib/lib.mjs` directly. The import and the re-export are both removable. |

### The URL derivations, with real values

The comment above them explains a design choice worth copying:

> "Deliberately derived from the stored lead's own url/id rather than from
> docs/job-sources.yaml: enrichment then also works for an imported lead, and a
> board removed from the sweep list does not orphan the leads it produced."

**Oracle.** From:

```
https://ejfh.fa.us6.oraclecloud.com/hcmUI/CandidateExperience/en/sites/StationCasinos/job/22314
```

to:

```
https://ejfh.fa.us6.oraclecloud.com/hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails
  ?onlyData=true&expand=all&finder=ById;Id=%2222314%22,siteNumber=%22StationCasinos%22
```

(`%22` is a URL-encoded double quote — Oracle's `finder` syntax wants the values
quoted.)

**SmartRecruiters.** `https://jobs.smartrecruiters.com/BoydGaming/3743990013989186`
→ `https://api.smartrecruiters.com/v1/companies/BoydGaming/postings/3743990013989186`.

**Workday.** The careers page and the JSON its own front end calls differ only in
the path prefix — but the tenant is not in the page URL, so it is taken from the
lead's `id`:

```js
const tenant = String(id).split(":")[1] || host.split(".")[0]
```

`"workday:cvshealth:R0977981"` → `cvshealth`. The fallback (`host.split(".")[0]`)
is correct for the standard `tenant.wdN.myworkdayjobs.com` hostname and wrong for
anything else — a limitation worth knowing if you ever import a Workday lead by
hand without a properly-shaped id.

### The description parsers

Each returns `{ text, findings, clean }`, never a plain string, and the comment
explains why that matters:

> "These four functions used to return `textSnippet(...)`'s plain string. They
> now return `sanitizeHtmlSnippet(...)`'s `{ text, findings, clean }` — this is
> a detail-page fetch, i.e. RAW HTML from a third party, reaching the pipeline
> for the first time here, and it needs the same markup-aware scrub the list
> endpoints get in find-jobs.mjs (`untrustedSnippet`). Returning textSnippet's
> flattened string first would destroy the display:none the scrubber needs to
> see, exactly the ordering bug 1.3 exists to close."

This is the same hard rule 0 machinery as trap T12 above: hidden text is a
prompt-injection carrier, and the scrubber can only see `display:none` while the
markup still exists.

Two smaller decisions worth keeping:

- **Oracle concatenates four fields.** "Oracle splits a posting across four
  fields and only some are populated per tenant, so all of them are
  concatenated. Qualifications matter most: that is where the years-of-experience
  bar and the degree demand live."
- **SmartRecruiters drops `companyDescription`.** "it is identical on every
  posting from the board and would crowd the snippet cap with boilerplate that
  says nothing about the role." (`SNIPPET_MAX` is 4,000 characters — a fixed
  budget, so what you spend it on matters.)

## 2.4 How it works, step by step

The dispatch table is keyed on the prefix of the lead's `source` (or `id`):

```js
const FETCHERS = {
  oracle_cloud: async (lead) => {
    const u = oracleDetailUrl(lead.url)
    return u ? oracleDescription(await fetchJson(u)) : NOTHING
  },
  smartrecruiters: …,
  successfactors: async (lead) =>
    lead.url ? successFactorsDescription(await fetchText(lead.url)) : NOTHING,
  workday: …,
}
```

`NOTHING` is a shared sentinel:

```js
const NOTHING = { text: null, findings: [], clean: true }
```

> A **sentinel** is a single shared "nothing here" value. The comment says what
> it buys: "the fill loop below can treat every fetcher's result as the same
> three-field shape without a null-check of its own."

`enrichDescriptions` then:

1. Picks its targets: leads with no `description` whose source prefix has a
   fetcher.
2. Runs them through `mapPool(targets, 6, …)` — at most six requests in flight
   at once.
3. On success **with text**: sets `lead.description = res.text`, and — only when
   `res.clean` is false — sets `lead.untrusted_findings = res.findings`.
4. On success with **no** text: adds the flag `no_description`.

   > "Reached the endpoint but found no body: the parse is stale or the posting
   > genuinely has none. Flagged so screening knows the blocker check ran against
   > nothing rather than against a clean posting."

5. On a thrown error: the same flag, **plus** a `failures` entry
   `"${lead.source} — ${e.message}"`. **The lead is never lost.**
6. Returns `{ filled, attempted: targets.length, failures }`, which `ingest`
   prints as `enriched=4/6`.

### A worked example

A stored lead from the Station Casinos Oracle board:

```js
{
  id: "oracle_cloud:StationCasinos:22314",
  source: "oracle_cloud:StationCasinos",
  url: "https://ejfh.fa.us6.oraclecloud.com/hcmUI/CandidateExperience/en/sites/StationCasinos/job/22314",
  title: "Junior Engineer - Palace",
  description: undefined,
}
```

1. Prefix is `"oracle_cloud"` → `FETCHERS.oracle_cloud`.
2. `oracleDetailUrl(lead.url)` builds the REST URL shown in §2.3.
3. `fetchJson` returns
   `{items: [{ShortDescriptionStr: "…", ExternalQualificationsStr: "…"}]}`.
4. `oracleDescription` concatenates and sanitises →
   `{ text: "Pick up supplies and parts from vendors. Perform all repairs…", findings: [], clean: true }`.
5. `lead.description` is set.
6. Back in `ingest`, gate L1 now has text to read, and rejects the lead with
   `"body: not a software role (no software work described)"`.

That is the whole point of the module in one trace: without step 5, step 6 could
not happen, and a building-maintenance job would sit in your lead store looking
like a software role.

### The CLI's write path

```js
const rows = db.prepare("SELECT id, doc FROM leads").all()
const leads = rows.map((r) => JSON.parse(r.doc))
const targets = leads.filter(canEnrich)
…
const update = db.prepare("UPDATE leads SET doc = ? WHERE id = ?")
db.exec("BEGIN")
try {
  for (const l of targets) {
    update.run(JSON.stringify(l), l.id)
    setLeadKeywords(db, l.id, [...extractTech(
      [l.title, l.description, ...(l.requirements ?? [])].filter(Boolean).join("\n"),
    )])
  }
  db.exec("COMMIT")
} catch (e) {
  db.exec("ROLLBACK")
  throw e
}
```

Two comments to keep:

> "node:sqlite, so BEGIN/COMMIT explicitly — there is no db.transaction()
> wrapper here the way better-sqlite3 provides one."

> "Keywords are derived from the description, so a lead that just gained one has
> to be re-indexed or the whole point of the fetch is lost."

> A **transaction** groups several database writes so that either all of them
> land or none do. `ROLLBACK` on error is what makes a half-finished backfill
> impossible.

Note also that the CLI loads `db.mjs`, `profile-gaps.mjs` and `lib.mjs` with
**dynamic `import()`** inside `main()` rather than at the top of the file. They
are needed only when the file is run as a program, so the sweep path — which
imports this module as a library — does not pay to load them.

## 2.5 What it reads and writes

- **Reads (in memory):** `lead.url`, `lead.id`, `lead.source`,
  `lead.description`, `lead.flags`.
- **Reads (CLI):** `SELECT id, doc FROM leads`.
- **Writes (in memory, by mutation):** `lead.description`,
  `lead.untrusted_findings`, `lead.flags`.
- **Writes (CLI):** `UPDATE leads SET doc = ? WHERE id = ?`, plus the
  `lead_keywords` rows via `setLeadKeywords`.
- **Network:** one request per target lead, to the ATS's own detail endpoint.

## 2.6 Traps and things not to "fix"

- **A failed detail fetch must never lose a lead.** Errors are collected into
  `failures` and reported, never thrown.
- **The four description functions must return the `{text, findings, clean}`
  triple**, not a string. Sanitisation has to see raw markup.
- **`canEnrich` gates on `!lead.description`.** A lead that has _any_
  description — even a two-sentence teaser — is permanently skipped.

  > **Known defect (2026-08-05 audit): an Oracle list teaser blocks the detail
  > fetch that carries the qualifications.** `fetchOracleCloud` maps three fields
  > from the _list_ response into a description. `oracleDescription` reads
  > **four** fields from the _detail_ endpoint, including `ExternalDescriptionStr`
  > which the list does not carry. Because `canEnrich` requires no description at
  > all, any Oracle tenant that populates even one of those three list fields
  > leaves the lead with the teaser forever — on precisely the two boards this
  > module's header calls "the highest-value leads for a North Las Vegas
  > applicant" (Caesars, Station Casinos), and for precisely the text it calls
  > most valuable ("Qualifications matter most"). A fix would compare lengths, or
  > give the list-teaser sources a distinct marker.

- **`workdayDetailUrl` needs the tenant from the lead id.** An imported Workday
  lead whose id is not shaped `workday:<tenant>:…` falls back to the hostname's
  first label, which is right for `tenant.wdN.myworkdayjobs.com` and wrong
  otherwise.
- **Only four board types are handled.** Workable is missing (§1.5.5) and Hacker
  News has no description path at all.
- **The `isMain` guard is not a top-level `await`**, deliberately: "this module
  is imported by find-jobs.mjs on the sweep path, and top-level await in a
  dependency delays the whole import graph."

## 2.7 What it depends on, and what depends on it

**Imports:** `node:path`, `node:url`; from `../lib/lib.mjs` — `fetchJson`,
`fetchText`, `mapPool`, and `decodeEntities` (unused); from
`../lib/untrusted.mjs` — `sanitizeHtmlSnippet`. Dynamically, in the CLI only:
`../lib/db.mjs`, `../profile/profile-gaps.mjs`, `../lib/lib.mjs`.

**Depended on by:** `scripts/leads/find-jobs.mjs` (for `enrichDescriptions`),
and `tests/leads/enrich.test.mjs`, which covers every URL-derivation and
description-parsing function, sanitisation of a hidden instruction in a detail
payload, failure flagging, and idempotence.

---

# Part 3 — `scripts/leads/stages.mjs`

## 3.1 What it is and why it exists

109 lines that give the screening pipeline a shared vocabulary. It names four
stages, registers the function that implements each, and runs a lead through
them in order — stopping at the first rejection and recording **which** stage
decided.

The header says what it was like before:

> "Before this, the same decisions were spread across three places with no
> shared vocabulary: `passesLimits` and `bodyDisqualifiers` ran inside
> find-jobs.mjs' `ingest()`, screen.mjs ran a separate mix of scam/seniority/ghost
> checks afterwards, and nothing recorded WHICH check had discarded a posting.
> 'Why did I never see this job?' was not an answerable question."

That question — _why did I never see this job?_ — is the whole reason this file
exists, and it is why `gate-audit.mjs` can now answer it.

The ordering rationale, verbatim:

```
//   L0 title  board list payload only (title, location, date, salary).
//             Free. Discards thousands.
//   L1 body   hard disqualifiers stated in the description. Needs the text,
//             which for four ATS types costs one fetch per surviving posting.
//   L2 fit    can this profile actually do this job? Free, given L1's text.
//   L3 risk   is this job real? scam / ghost / repost signals. Free.
```

## 3.2 How you run or use it

This is a **library only** — no CLI, no `isMain` guard. Three callers:

| Caller                             | Call                                                                                               |
| ---------------------------------- | -------------------------------------------------------------------------------------------------- |
| `scripts/leads/screen.mjs`         | `evaluateStages(job, { limits, now, profileYears, profileTech, keywords, history }, stages)`       |
| `scripts/leads/gate-audit.mjs`     | `evaluateStages(l, { … })` — the "why did I never see this job?" audit                             |
| `scripts/apply/automatability.mjs` | `evaluateStages(lead, { limits, now }, ["l0", "l1", "l3"])` — the auto-apply path, **skipping L2** |

## 3.3 Everything it exposes

| Export                                            | Signature / value                                                                                 | Meaning                                             |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `STAGE_IDS`                                       | `["l0", "l1", "l2", "l3"]`                                                                        | The canonical order. Iteration always follows this. |
| `STAGE_LABELS`                                    | `{l0: "title/location/date", l1: "body disqualifiers", l2: "profile fit", l3: "scam/ghost risk"}` | Human-readable names for reports.                   |
| `registerStage(id, run)`                          | throws `unknown stage id "x"` for anything outside `STAGE_IDS`                                    | Puts `run` into the module-level `REGISTRY` map.    |
| `evaluateStages(job, ctx = {}, only = STAGE_IDS)` | → `{ok, stage, reasons[], flags[], stages{}, ...extra}`                                           | Runs the pipeline.                                  |

The four registrations, which is where the checks are actually wired up:

```js
registerStage("l0", (job, ctx) => passesLimits(job, ctx.limits, ctx.now))
registerStage("l1", (job, ctx) => bodyDisqualifiers(job, ctx.limits))
registerStage("l2", (job, ctx) =>
  scoreFit(job, ctx.profileTech ?? new Set(), {
    limits: ctx.limits,
    indexed: ctx.keywords,
  }),
)
registerStage("l3", (job, ctx) =>
  scoreRisk(job, ctx.history ?? null, { limits: ctx.limits }),
)
```

Why registration lives here rather than inside each check's own module:

> "Letting fit.mjs and risk.mjs self-register would mean importing this file from
> there and this file importing them back — a cycle. The checks stay pure
> functions in their own modules; this file is the only thing that knows the
> order they run in."

> A **circular import** is A importing B while B imports A. JavaScript will often
> tolerate it, but one of the two modules ends up half-initialised at the moment
> the other reads it, and the resulting bugs depend on which file happened to
> load first. Avoiding cycles by putting the wiring in one place is a general
> pattern worth learning.

## 3.4 How it works, step by step

```js
export function evaluateStages(job, ctx = {}, only = STAGE_IDS) {
  const flags = new Set(job.flags ?? [])
  const stages = {}
  let extra = {}

  for (const id of STAGE_IDS) {
    if (!only.includes(id)) continue
    const run = REGISTRY.get(id)
    if (!run) continue // stage not registered

    const {
      ok,
      reasons = [],
      flags: newFlags = [],
      ...rest
    } = run({ ...job, flags: [...flags] }, ctx)
    newFlags.forEach((f) => flags.add(f))
    stages[id] = { ok, reasons, flags: newFlags, ...rest }
    extra = { ...extra, ...rest }

    if (!ok) {
      return {
        ok: false,
        stage: id,
        reasons: reasons.map((r) => (r.includes(":") ? r : `${id}: ${r}`)),
        flags: [...flags],
        stages,
        ...extra,
      }
    }
  }
  return {
    ok: true,
    stage: null,
    reasons: [],
    flags: [...flags],
    stages,
    ...extra,
  }
}
```

Four details that matter:

1. **Iteration is over `STAGE_IDS`, not over `only`.** Passing
   `["l3", "l0"]` still runs L0 first. `only` filters; it never reorders.
2. **Flags accumulate across stages**, and each stage receives a copy of the job
   with every flag raised so far:

   > "Each stage sees the flags every earlier stage raised — l1's 'did this
   > arrive on a loose title match?' test depends on l0's flags."

   This is the mechanism behind `bodyDisqualifiers`'s `looseArrival` check
   reading the `title_loose` flag that `passesLimits` raised.

3. **Reason prefixing is conditional** —
   ``reasons.map((r) => (r.includes(":") ? r : `${id}: ${r}`))``. L0 and L1
   reasons already contain a colon (`"title: …"`, `"body: …"`) so they are left
   alone; a bare reason from L2 or L3 gets `l2: ` / `l3: ` prepended.
4. **`...rest` is spread twice** — once into `stages[id]`, once into the flat
   `extra`. That is how `fit_score` and `repost_count` end up at the top level of
   the result, where `screen.mjs` reads them as `staged.fit_score` and
   `staged.repost_count`.

### A worked example

`evaluateStages(lead, {limits, now, profileTech, keywords, history})` for a lead
that L0 flagged `title_loose`:

1. L0 runs, returns `{ok: true, reasons: [], flags: ["title_loose"]}`. The
   accumulated flag set is now `{title_loose}`.
2. L1 receives `{...job, flags: ["title_loose"]}`, so its `looseArrival` test is
   true, so the non-software body check applies. The body is casino maintenance
   boilerplate → `{ok: false, reasons: ["body: not a software role (no software work described)"]}`.
3. `evaluateStages` returns immediately:

   ```js
   {
     ok: false,
     stage: "l1",
     reasons: ["body: not a software role (no software work described)"],
     flags: ["title_loose"],
     stages: { l0: {…}, l1: {…} },
   }
   ```

4. `screen.mjs` records `verdict: "reject"`, `stage: "l1"` into the `screens`
   table; `gate-audit.mjs` can then report "N rejected at l1 (body
   disqualifiers)".

## 3.5 What it reads and writes

Nothing on disk. It is pure in-memory computation: it reads `job.flags` and
whatever the caller put in `ctx`
(`{ limits, now, profileYears, profileTech, keywords, history }`), and returns an
object. Persisting the result is the caller's job (`screen.mjs` writes it to the
`screens` table).

## 3.6 Traps and things not to "fix"

- **Order is fixed by `STAGE_IDS`**, and cheap-before-expensive is the entire
  point. Reordering so that L1 runs before L0 would mean paying a network request
  per posting the sweep was going to discard anyway.
- **An unregistered stage is skipped, not an error** (`if (!run) continue`).
  Deliberate, so a partially-built pipeline still runs.
- **`registerStage` throws on an unknown id**, so a typo cannot silently create a
  fifth stage that nothing ever runs.
- **No cycle:** `stages.mjs` imports the checks; the checks never import
  `stages.mjs`. Keep it that way.
- **`evaluateStages` never mutates `job`.** It spreads a fresh copy per stage.

## 3.7 What it depends on, and what depends on it

**Imports:** `./find-jobs.mjs` (`passesLimits`, `bodyDisqualifiers`),
`./fit.mjs` (`scoreFit`), `./risk.mjs` (`scoreRisk`).

**Depended on by:** `scripts/leads/screen.mjs`, `scripts/leads/gate-audit.mjs`,
`scripts/apply/automatability.mjs` (and therefore `scripts/auto/auto-apply.mjs`
indirectly), plus `tests/leads/screen-stages.test.mjs`,
`tests/leads/gate-audit.test.mjs`, `tests/auto/automatability.test.mjs` and
`tests/auto/browser-leg.test.mjs`.

---

# The whole path in one list

```
docs/job-sources.yaml
   → loadSources()
   → mapPool(boards, 8, fetchBoard)          ← 44 boards, 8 at a time
   → normalized candidates
   → recordSweep()                            ← board_stats
   → fetchHackerNews(), fetchAdzuna()         ← sequentially, after the pool
   → ingest():
        dedupeLeads()                         ← + repost sightings
        L0 passesLimits()                     ← discards thousands
        enrichDescriptions()                  ← network, OUTSIDE the lock
        canonicalizeLeads({network: false})   ← stamps apply_url
        L1 bodyDisqualifiers()
        withLock { re-read, backfill, repost counters, insert, write }
        indexKeywords()
        summarize()
```

Later, `screen.mjs` re-runs L0–L3 through `stages.mjs` over the stored leads and
writes `screens` rows; `recommend.mjs` ranks; `gate-audit.mjs` explains what each
stage removed.

---

# If you were rebuilding this

Three decisions here carry almost all the weight. Get these right and the rest is
mechanical; get them wrong and no amount of polish elsewhere recovers.

**1. Reject cheap, and separate "reject" from "flag" at the type level.**

The instinct when building a job-search tool is to fetch everything, then decide.
That is exactly backwards: the description fetch is the expensive step, so the
decision has to happen on the free fields first. Two gates in the right order —
one on the list payload, one on the description — is what makes a daily sweep of
44 boards affordable, and it is why `stages.mjs` exists as an explicit ordered
registry rather than a chain of `if` statements.

The second half of this is the `{ok, reasons[], flags[]}` return shape. It looks
like a nicety. It is the safety mechanism. **A false reject is a job you never
see**, and you will never find out it happened; a false flag is a note you can
dismiss in a second. Making "reject" and "note" two different arrays, with
`ok = reasons.length === 0`, means the difference is visible in every line of
every check, and adding a check that only ever flags is a one-line change that
cannot possibly hide a job from you. A naive version returns a boolean, and then
every future refinement is a coin-flip between "too strict" and "useless".

**2. Never confuse "where the office is" with "who may be hired".**

The single most expensive bug in this file's history was the location gate
reading `location: "USA"` as a relocation demand and rejecting 35 of 35 Remotive,
50 of 50 Jobicy and 100 of 100 RemoteOK postings — the entire remote market, in
one silent stroke. A naive location filter is a substring search for your city.
The real problem has at least four distinct shapes: a real address, a
country-level "who may be hired" string, a work-arrangement word in the location
field, and a literal `"2 Locations"` placeholder. Each needs its own treatment,
and two of them need to _flag_ rather than decide.

The related lesson: some facts belong to the **source**, not the posting. That is
what `remote_source: true` is — a fetcher asserting "everything from this site is
remote", which no amount of parsing an individual posting's location field could
have told you.

**3. Lock the write, not the work; and re-read inside the lock.**

The tempting shape is "take the lock, do the whole job, release the lock". It is
wrong twice over. It holds the lock across network requests that can run for a
minute, which makes a concurrent process legitimately conclude the lock is
abandoned and break it. And if you take the lock but write the copy of the data
you read _before_ taking it, the lock has bought you nothing — you will still
overwrite whatever another process changed in between.

The correct shape is the one here: plan on a possibly-stale read outside the
lock, then inside the lock re-read fresh, re-apply your changes to _that_ copy,
check you still hold the lock, and only then write. The extra `stillHeld()` call
immediately before the write looks redundant next to `withLock`'s own check —
it is not, because that one fires after the function returns, which is too late
to stop a write that already happened.

**A fourth, smaller one, which is really about honesty.** The board fetchers are
full of comments recording what a wrong version _did_: "saw 20 of Light &
Wonder's 90", "ended the loop at 40 of 90 — a partial fix that looked like a
working one", "read 'OSHA safety codes' as evidence of a software job". Those
comments are worth more than the code they sit above, because the code is
re-derivable and the failure is not. If you rebuild this, write those down as you
find them. The bug you fix today is the bug someone re-introduces in four months
because the fix looked arbitrary.
