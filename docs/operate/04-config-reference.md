# The configuration files you own

Almost every decision this pipeline makes — which job titles are worth storing,
how old a posting may be, which company boards get swept each morning, whether
an unattended run is allowed to click a submit button at all — is not written
into the code. It is written into a handful of small text files under `docs/`,
and **those files are yours**. The code reads them. The agent reads them,
proposes changes to them in chat, and is forbidden from editing them. This
document is the key-by-key reference for what every one of those keys does, what
reads it, and what changes the moment you edit it.

The reason for that split is worth stating before anything else. A rule that
lives in code can only be changed by editing a program, which means only someone
who can program controls their own job search. A rule that lives in a
configuration file can be changed by opening a text editor. That is the whole
point of the design: the numbers that decide which jobs you ever see should be
readable and editable by you, not buried three function calls deep in a file
called `find-jobs.mjs`.

The honest counterpart to that promise is that some of the numbers **are** still
buried in the code, and one key in your file is read by nothing at all. Those
are marked plainly below. They are defects, not features.

**What you will learn**

- What YAML is, how the two styles in these files differ, and the small number
  of ways a YAML edit can go wrong silently.
- Every key in `docs/application-limits.yaml` — its type, its default, the exact
  script and function that reads it, and what changes if you edit it.
- Why `roles.title_keywords` is the single most consequential list in the
  repository, and why no script is ever allowed to decide a title is out of
  scope on its own reasoning.
- The difference between a key that **rejects** a job and one that only
  **flags** it — the distinction the whole screening design turns on.
- Five ghost-job thresholds that exist only in code and are invisible from your
  file, and one key in your file that the file it claims to configure never
  reads.
- What the `auto_apply` block actually authorises, what your file says today,
  and what still stops a live unattended submit.
- The entry shape for every board type in `docs/job-sources.yaml`, with a real
  example of each, and why you should add boards with a command rather than by
  hand.
- What the five smaller files under `docs/` are for, including the one that is
  read by an AI model rather than by a script.
- The single most damaging way to misconfigure this system, why it fails
  silently, and the command that exists to catch it.

**Before this**

If any term below is unfamiliar, these come first:

- [`../guide/02-computer-basics.md`](../guide/02-computer-basics.md) — files,
  paths, the terminal, running a command.
- [`../guide/03-programming-basics.md`](../guide/03-programming-basics.md) —
  strings, lists, booleans, regular expressions.
- [`../guide/07-safety-model.md`](../guide/07-safety-model.md) — why some files
  are the owner's and sealed against the agent.
- [`01-commands.md`](01-commands.md) — how to run any of the commands quoted
  here.
- [`../guide/08-glossary.md`](../guide/08-glossary.md) — if a word here is new.

The code that reads these files is documented in
[`../code/02-leads-finding.md`](../code/02-leads-finding.md) (the sweep and its
gates), [`../code/03-leads-screening.md`](../code/03-leads-screening.md) (fit and
ghost-job scoring), [`../code/04-leads-ranking.md`](../code/04-leads-ranking.md)
(ranking and board management) and
[`../code/10-auto-safety.md`](../code/10-auto-safety.md) (the trust gate and the
caps).

---

## Part 0 — Things to understand before you edit anything

### 0.1 What YAML is

**YAML** is a text format for writing structured data — lists, and
name-to-value pairs — in a way a human can read. All three configuration files
here are YAML. The file extension is `.yaml`, and the program that reads it is
the `js-yaml` library, called from `loadLimits()` and `loadSources()` in
`scripts/leads/find-jobs.mjs`.

Four ideas cover everything these files use.

**A key and a value.** A line like

```yaml
max_age_days: 30
```

says "the key `max_age_days` has the value `30`". The colon-space is required.
`max_age_days:30` without the space is not the same thing.

**Nesting by indentation.** Indented lines belong to the key above them:

```yaml
freshness:
  max_age_days: 30
```

Here `freshness` is a block containing one key. In the code this is read as
`limits.freshness.max_age_days`. Indentation must be **spaces, never tab
characters** — a tab is a parse error in YAML, and because a tab is invisible
this is the single most common way to break one of these files by hand.

**Lists.** A line starting with `- ` is one item in a list:

```yaml
onsite_allowed:
  - north las vegas
  - las vegas
  - henderson
```

That is a list of three strings. In the code it is
`limits.location.onsite_allowed`, an array of three strings.

**Types.** YAML guesses the type from how a value is written:

| Written           | Becomes                        |
| ----------------- | ------------------------------ |
| `30`              | a number                       |
| `"30"`            | a string                       |
| `true` / `false`  | a boolean (a yes/no value)     |
| `null` or nothing | null — "no value"              |
| `north las vegas` | a string (quotes are optional) |
| `- a` `- b`       | a list                         |

That guessing matters in one real place in these files. In
`application-limits.yaml`'s `soft_filter` list you will find:

```yaml
- ii
- iii
- iv
- "2"
- "3"
```

The `"2"` is quoted deliberately. Written bare as `- 2`, YAML would produce the
**number** 2 rather than the text "2". As it happens the one function that reads
this list, `matchTitleKeyword`, converts every entry with `String(k)` before
using it, so a bare `- 2` would still work today. The quotes state the intent —
these are text patterns to find in a job title, not quantities — and they protect
the list from any future reader that does not convert. Being deliberate about
which of these is a number and which is text is a habit worth having in every
YAML file, because the mistake does not announce itself.

**Comments.** A `#` starts a comment — everything after it on that line is
ignored by the program. Both of the main files here are more comment than
configuration, on purpose: each number carries the story of why it is that
number. Those comments are the most valuable thing in the files and there is
tooling built specifically to avoid destroying them (see §2.4).

**Block style versus flow style.** The two ways to write the same list:

```yaml
# block style — one item per line
- type: greenhouse
  slug: anthropic
  company: Anthropic
```

```yaml
# flow style — the whole item on one line, in braces
- { type: greenhouse, slug: anthropic, company: Anthropic }
```

Both parse to exactly the same data. `application-limits.yaml` uses block style
throughout; `job-sources.yaml` uses flow style for every board entry, and that is
a hard requirement rather than a preference (§2.4).

### 0.2 Which files are yours, and what "yours" means

Three levels of ownership exist in this repository, and they are enforced by
different mechanisms.

| Files                                          | Owner              | How it is enforced                                                                                                                                       |
| ---------------------------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `profile/profile.yaml`, `profile/answers.yaml` | You, absolutely    | A **PreToolUse hook** blocks the agent from writing them at all. The only sanctioned write path is `scripts/profile/save-answer.mjs`.                    |
| `.claude/hooks/*`, `.claude/settings*.json`    | You, absolutely    | Sealed on both the file-editing and the shell path.                                                                                                      |
| `docs/application-limits.yaml`                 | You, by discipline | **No hook stops an edit.** The rule lives in `CLAUDE.md` and is repeated in the code's own comments; the agent proposes values and asks you to set them. |
| `docs/job-sources.yaml`                        | You, with tooling  | `scripts/leads/manage-sources.mjs` exists so add/remove is a command, not a hand edit.                                                                   |

> **State this at the top of any conversation about limits:**
> `docs/application-limits.yaml` is the owner's file. The agent reads it,
> proposes values in chat, and does not edit it. `scripts/auto/preflight.mjs`
> puts that sentence into its own refusal text — when the `auto_apply` block is
> missing, the remedy it prints is _"the user adds the block; no agent edits
> docs/application-limits.yaml. Propose values, never write them."_

The distinction is not decorative. These files decide which jobs you are shown.
A system that could quietly widen or narrow its own filters is a system whose
results you cannot trust, because you would have no way of knowing whether "no
good jobs today" meant the market was quiet or the filter had moved.

### 0.3 Configuration layering: three places a value can come from

Every setting in this system resolves in the same three-step order, and knowing
the order explains most surprises.

1. **A built-in default in the code.** Used when your file does not mention the
   key at all.
2. **Your file.** Overrides the default.
3. **A command-line flag.** Overrides both, for that one run.

Concretely, for posting age:

```js
// scripts/leads/find-jobs.mjs, passesLimits()
const maxAge = limits.freshness?.max_age_days ?? 30
```

The `??` is JavaScript's "if the thing on the left is missing, use the thing on
the right". So:

- Delete the `freshness` block entirely → the gate uses **30 days**.
- Write `max_age_days: 14` → the gate uses **14 days**.
- Run `node scripts/leads/find-jobs.mjs search --max-age 7` → **7 days**, just
  for that run. (`cmdSearch` writes the flag value into the in-memory limits
  object before the gates run; your file on disk is untouched.)

Two variations on this pattern appear in these files and are worth naming
because they behave differently from each other:

**Merge** — used by `fit` and `ghost_signals`. The code holds a complete object
of defaults and your keys are laid over it one at a time:

```js
// scripts/leads/fit.mjs, scoreFit()
const cfg = { ...FIT_DEFAULTS, ...(opts.limits?.fit ?? {}) }
```

Setting `fit.reject_below` changes only that number; the other three keep their
code defaults. You never have to write the whole block.

**Replace** — used by `location.remote_synonyms` and `roles.exclude_body`. If
you set the key, your list takes over completely and the built-in list is not
consulted at all:

```js
// scripts/leads/find-jobs.mjs, passesLimits()
matchesAny(loc, limits.location?.remote_synonyms ?? US_WIDE_LOCATION)
```

The file's own comment states this explicitly: _"Leave this key out entirely to
use the built-in list ... setting it REPLACES the built-in list."_ The practical
consequence is that a replace-style list written short is a list that lost
entries. If you edit `remote_synonyms` down to three entries, the other eighteen
are gone.

### 0.4 How to check you did not break the file

YAML fails in two different ways and only one of them is loud.

**Loud:** a syntax error — a tab, a missing colon, a bad indent. Every script
that reads the file will crash with a parse error. You will not miss it.

**Quiet:** valid YAML that means something other than what you intended. A key
misspelled `title_keyword` instead of `title_keywords` parses perfectly and is
then read by nobody; the code falls back to `?? []`, the empty list, and — for
`title_keywords` specifically — an empty list means **every title passes**,
because `passesLimits` starts with `!kws.length ||`. Nothing warns you.

Two checks, in order of how much they tell you:

```bash
# 1. Does it still parse, and is the key where you think it is?
node -e "const y=require('js-yaml'),f=require('fs');const d=y.load(f.readFileSync('docs/application-limits.yaml','utf8'));console.log(d.roles.title_keywords.length,'title keywords')"
```

```bash
# 2. Did the change reject any job that used to pass? THIS is the real check.
node scripts/leads/gate-audit.mjs
```

`gate-audit.mjs` re-runs every screening stage over every lead you have ever
stored and diffs the verdicts against the last recorded run. Part 4 of this
document is about why that command exists and why it is not optional.

---

## Part 1 — `docs/application-limits.yaml`

This is the policy file: what counts as a job worth pursuing. It is loaded by a
single function,

```js
// scripts/leads/find-jobs.mjs
export function loadLimits(file = LIMITS_PATH) {
  return yaml.load(fs.readFileSync(file, "utf8")) ?? {}
}
```

which every other consumer imports rather than re-reading the file itself:
`screen.mjs`, `gate-audit.mjs`, `board-yield.mjs`, `discover-boards.mjs`,
`manage-sources.mjs`, `archive.mjs`, `recommend.mjs`. The `auto/` runner and the
`documents/` scripts load the same path through their own YAML reads. There is
one file and one meaning of it.

The blocks, and the one-line version of what each decides:

| Block           | Decides                                                   | Primary reader                                                              |
| --------------- | --------------------------------------------------------- | --------------------------------------------------------------------------- |
| `location`      | where a job may be, and what counts as "remote"           | `find-jobs.mjs` `passesLimits` / `bodyDisqualifiers`                        |
| `freshness`     | how old a posting may be                                  | `find-jobs.mjs`, `archive.mjs`, the Adzuna query                            |
| `compensation`  | the salary floor, and whether a missing salary is flagged | `find-jobs.mjs` `passesLimits`                                              |
| `experience`    | the years-of-experience ceiling                           | `screen.mjs`                                                                |
| `fit`           | how much of a posting's required stack you must evidence  | `fit.mjs` `scoreFit`                                                        |
| `ghost_signals` | how old a posting must be to read as a ghost job          | `screen.mjs` (see the defect in §1.6)                                       |
| `roles`         | which job titles are in scope, and which are out          | `find-jobs.mjs`, `keyword-plan.mjs`, `assemble-resume.mjs`, `recommend.mjs` |
| `auto_apply`    | whether an unattended run may click submit, and how much  | `preflight.mjs`, `authorize.mjs`, `caps.mjs`, `trust.mjs`                   |

### 1.1 `location`

```yaml
location:
  base: "North Las Vegas, NV"
  relocation: false
  remote_ok: true
  travel_ok: occasional
  onsite_allowed:
    - north las vegas
    - las vegas
    - henderson
  remote_synonyms:
    - usa
    - u.s.
    # ... 19 more
```

**`base`** — string. Default when absent: the literal `"base"` appears in a
reject message, and `"Las Vegas"` is used for the Adzuna query. Three separate
things read it, and each uses it differently:

1. `passesLimits` puts it in the rejection reason so the record says _`location:
"Austin, TX" would require relocating away from North Las Vegas`_ rather than
   an anonymous "rejected".
2. `bodyDisqualifiers` parses the **two-letter state code** out of it with the
   pattern `/,\s*([A-Z]{2})\b/`, falling back to `NV`. That state is then used to
   decide whether a posting's "not eligible for hire in ..." sentence names your
   state. A base written without a comma and a capitalised state code — say
   `north las vegas nevada` — silently falls back to `NV`, which happens to be
   right here and would be wrong after a move.
3. `fetchAdzuna` sends it as the `where` parameter with `distance: "50"` (miles),
   so `base` is literally the centre of the 50-mile radius Adzuna searches.

**`relocation`** — boolean, currently `false`.

> **Known defect (2026-08-05 audit).** No code reads `location.relocation` or
> `location.travel_ok`. A repository-wide search for `location?.relocation` and
> `travel_ok` under `scripts/` and `.claude/` returns nothing. Both keys are read
> by humans and by the model when a skill quotes the file, and by no script.
> Relocation is actually enforced two other ways — by `onsite_allowed` in
> `passesLimits`, and by the `RELOCATION_REQUIRED` regular expression in
> `bodyDisqualifiers`, which is hard-coded and not configurable. Setting
> `relocation: true` would change nothing.

**`remote_ok`** — boolean. Default when absent: `true`. Read in `passesLimits`:

```js
const remoteOk =
  (limits.location?.remote_ok ?? true) && (remoteText || remoteFlagged)
```

Set it to `false` and remote postings stop qualifying on their remoteness — only
`onsite_allowed` can save them. Given that remote roles are most of the reachable
market for this profile, this is a large lever.

**`travel_ok`** — string, currently `occasional`. Documentary only; see the
defect note above.

**`onsite_allowed`** — list of strings. Default when absent: the empty list,
which means **no on-site location is acceptable** and every posting with a real
city in it that is not also remote gets rejected. Matched two ways in two
places, which is worth knowing because they behave differently:

- In `passesLimits`, as a **substring** of the lowercased location string:
  `loc.includes("las vegas")`. So a posting located `Las Vegas, NV` matches, and
  so does `North Las Vegas` (it contains `las vegas`).
- In `bodyDisqualifiers`, as a **whole-word regular expression** over the
  posting body, used only to decide whether an "in-office" sentence conflicts
  with your base. That check only ever produces the flag `onsite_conflict`; it
  never rejects.

Worked example. A Greenhouse posting arrives with `location: "Henderson, NV"`.
`loc` becomes `henderson, nv`. `onsiteOk` is true because `henderson` is a
substring. The lead is stored, and `local` is set true — which additionally
grants it the **local title latitude** described in §1.7.

**`remote_synonyms`** — list of strings, replace-style. Default when absent: the
21-entry `US_WIDE_LOCATION` constant in `find-jobs.mjs`. Your file currently
declares a list that is identical to that constant entry for entry, so today it
changes nothing — but the moment you edit it, your version is the only one in
effect.

What this list is _for_ is one of the more instructive stories in the codebase. A
company board writes a location as a place: `Austin, TX`. A remote-only job site
writes it as an **eligibility statement**: `USA` means "we can hire anyone in the
United States", not "move to the United States". Until 2026-07-29 the location
gate read `USA` as a place you would have to move to, and threw out 35 of 35
Remotive postings, 50 of 50 Jobicy postings and 100 of 100 RemoteOK postings. The
comment in the file records those counts.

Matching is by **whole string**, not substring, after normalisation:

```js
// matchesAny() in find-jobs.mjs
const norm = (s) =>
  String(s ?? "")
    .toLowerCase()
    .replace(/[().,\-–—/]+/g, " ") // punctuation becomes a space
    .replace(/\s+/g, " ")
    .trim() // runs of spaces collapse
```

So `Remote (US)`, `remote - us` and `remote, us` all normalise to `remote us`
and hit the same entry. And `Tulsa, USA` normalises to `tulsa usa`, which
matches no entry at all — it is still an on-site Tulsa role, which is exactly the
behaviour a substring match would have destroyed. The whole-string rule is
load-bearing.

Alongside this runs a hard-coded `NON_US` pattern (`france|germany|...|mexico`).
A location naming a non-US country with no US marker is not remote-eligible
whatever this list says, and that pattern is not configurable.

### 1.2 `freshness`

```yaml
freshness:
  max_age_days: 30
```

**`max_age_days`** — number of days. Default when absent: `30`. Three readers:

1. `passesLimits` rejects a posting older than this, with the reason `stale:
posted 47 days ago (max 30)`. A posting whose date cannot be parsed is **kept
   and flagged** `unknown_age` rather than rejected — the flag/reject asymmetry
   again.
2. `fetchAdzuna` sends it to Adzuna's API as `max_days_old`, so for that one
   source the filtering happens on their server before anything is downloaded.
3. `scripts/maintenance/archive.mjs` uses it as the default age for pruning old
   leads out of the store, on the reasoning that the number you reject at ingest
   is the number worth pruning at.

Lowering it to `14` makes the daily sweep noticeably stricter and is the single
cheapest way to cut noise if you find yourself looking at postings that have
plainly been up for a month. Raising it above 30 works against `ghost_signals`
(§1.6), where age past 30 days is itself a ghost-job indicator.

### 1.3 `compensation`

```yaml
compensation:
  min_salary: null
  flag_missing: true
```

**`min_salary`** — a number in annual US dollars, or `null`. Default: `null`,
which **disables the gate entirely**. When set, `passesLimits` rejects any lead
whose parsed `salary_max` is below it:

```js
const minSalary = limits.compensation?.min_salary
if (minSalary != null) {
  if (job.salary_max != null) {
    if (job.salary_max < minSalary) reasons.push(`salary: tops out at ...`)
  } else if (limits.compensation?.flag_missing !== false) {
    flags.push("no_salary")
  }
}
```

Note carefully: the comparison is against `salary_max`, the **top** of a stated
range, parsed by `parseSalaryMax` from strings like `$150K – $220K`. Setting
`min_salary: 90000` rejects a posting advertising `$70K – $85K` and keeps one
advertising `$70K – $120K`. That is deliberately generous; a range's top is what
is negotiable.

The great majority of postings state no salary at all. With `min_salary: null`
this costs nothing. With a number set, every one of those becomes a `no_salary`
flag, which is a large amount of new flagging — which is why the key ships
disabled.

**`flag_missing`** — boolean, default effectively `true`. Only the exact value
`false` turns the flagging off (`!== false`). It does nothing at all while
`min_salary` is `null`, because the whole branch is inside the `minSalary !=
null` test.

### 1.4 `experience`

```yaml
experience:
  stretch_years: 2
  # max_years_required: 5
```

Read by `scripts/leads/screen.mjs` — the L1 screening stage — not by the sweep.

**`stretch_years`** — number. Default when absent: `DEFAULT_STRETCH_YEARS = 2` in
`screen.mjs`. The ceiling is computed as your tenure plus this:

```js
const ceiling =
  limits.experience?.max_years_required ??
  profileYears + (limits.experience?.stretch_years ?? DEFAULT_STRETCH_YEARS)
if (demanded > ceiling) {
  signals.push(`over_bar_${demanded}y`)
  verdict = "reject"
}
```

`profileYears` comes from `yearsOfExperience()` computed off your profile — about
2.5 years at the time the file's comment was written — so `stretch_years: 2` puts
the ceiling at 4.5 years, which catches the "5+ years" band where Senior roles
actually sit. `demanded` is the **highest** "N+ years" demand the screener can
find in the posting body.

This **rejects** rather than cautions, and the file explains why: on 2026-07-28
every single cautioned posting of this kind was read and then rejected anyway, so
the caution was pure cost.

**`max_years_required`** — number, currently commented out. When set it pins an
absolute ceiling and `stretch_years` is ignored entirely (it is the left-hand
side of the `??`). Use it if your tenure figure in the profile is one you do not
want the gate keyed to.

### 1.5 `fit`

```yaml
fit:
  min_required_terms: 4
  reject_below: 0.2
  caution_below: 0.45
  senior_phrase_reject: 3
```

Read by `scripts/leads/fit.mjs` — the L2 "can I actually do this job?" stage —
merged over `FIT_DEFAULTS` in both `scoreFit()` and `isEvaluable()`.

L2 splits a posting into required / preferred / general sections and compares
only the **required** technologies against what your profile evidences.
Technologies under "nice to have" never count against you.

**`min_required_terms`** — number, default `4`. If the required section names
fewer than this many technologies, the posting is treated as **unevaluated**, not
as a bad match. The file calls this "the most important number here" and
`fit.mjs`'s own comment calls it "the single most important safety number in the
file", for one reason: a thin, badly-written job description must not be able to
reject a job. Raise it if you suspect good jobs are being dropped.

**`reject_below`** — number between 0 and 1, default `0.2`. Below 20% overlap
with the required stack, and only when the posting is evaluable, the lead is
rejected.

**`caution_below`** — default `0.45`. Between `reject_below` and this, the lead
is kept and flagged `fit_weak`.

**`senior_phrase_reject`** — number, default `3`. Senior-scope phrases ("own the
roadmap", "mentor the team", "set technical direction") are counted; this many
**combined with** an overlap below `caution_below` rejects. Senior language alone
never rejects, because mid-level postings borrow it constantly.

There is a fifth key in `FIT_DEFAULTS` your file does not declare:
**`long_body_chars`**, default `2000`. It distinguishes "the required section was
thin because the posting is thin" from "the required section was thin because our
technology lexicon could not read a long posting" — producing the flag
`posting_thin` in the first case and `lexicon_blind` in the second. Unlike the
five in §1.6 it is genuinely a diagnostic-labelling knob rather than an
accept/reject threshold, but it is equally invisible from your file.

### 1.6 `ghost_signals` — and two things wrong with it

```yaml
ghost_signals:
  repost_age_days: 30
```

A **ghost job** is a posting for a role that is not actually being filled — a
pipeline-warming advertisement. Industry research puts them at 18–40% of live
listings and names repeated reposting as the strongest indicator. L3
(`scripts/leads/risk.mjs`) is the stage that looks for them.

**`repost_age_days`** — number, currently `30`. It is read in exactly one place:

```js
// scripts/leads/screen.mjs
const ghostAge = limits.ghost_signals?.repost_age_days ?? 45
if (days >= ghostAge) {
  signals.push(`stale_${days}d`)
  if (verdict === "pass") verdict = "caution"
}
```

Note the default is `45` in the code and `30` in your file, so your file is
currently the stricter of the two.

> **Known defect (2026-08-05 audit).** `repost_age_days` lives under a block
> named `ghost_signals`, whose comment says _"Screening treats it as a strong
> reject signal"_. Neither half is accurate. It is not read by `risk.mjs` — the
> ghost-job stage — at all; it is read by `screen.mjs`, and it only ever raises a
> verdict from `pass` to `caution`. It never rejects anything. The key is
> effectively "a posting this old gets a `stale_Nd` note attached", filed under
> the wrong heading with the wrong description.

> **Known defect (2026-08-05 audit).** The five numbers that actually decide
> whether a repost rejects or merely flags exist **only as code defaults** and are
> invisible from the file you own. `scripts/leads/risk.mjs` exports:
>
> ```js
> export const RISK_DEFAULTS = {
>   repost_caution: 1,
>   repost_reject: 3,
>   min_substance: 2,
>   min_length_for_ratio: 600,
>   duplicate_body_reject: 3,
> }
> ```
>
> and merges your block over them — `{ ...RISK_DEFAULTS, ...(opts.limits?.ghost_signals ?? {}) }`
> — so all five **are** overridable by writing them under `ghost_signals`. There
> is simply nothing in your file, or in its comments, telling you they exist. The
> audit's proposed fix, which is a proposal for you and not an edit anyone should
> make on your behalf, is to add the five keys with their current values and
> correct the `repost_age_days` comment to say "caution".

Since they are undocumented in the file, here is what each one does today:

| Key                     | Default | What it controls                                                                                                                                                                                      |
| ----------------------- | ------: | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `repost_caution`        |     `1` | Above this many prior sightings of the same company+title, the lead is flagged `repost`. At the default, two or more prior sightings flag.                                                            |
| `repost_reject`         |     `3` | At this many prior sightings the lead is **rejected**, with the reason naming reposting as the strongest ghost signal.                                                                                |
| `min_substance`         |     `2` | The minimum count of "actual work" verbs (`you will`, `build`, `ship`, `debug`, `deploy`, …) a long description needs. Below it, **and** with boilerplate present, the lead is flagged `vague_scope`. |
| `min_length_for_ratio`  |   `600` | Descriptions shorter than this many characters skip the boilerplate check entirely — a short description has no meaningful ratio.                                                                     |
| `duplicate_body_reject` |     `3` | An identical description reused across this many of one company's postings flags `duplicate_body`.                                                                                                    |

Two details that surprise people. `repost_caution` uses `>` and
`repost_reject` uses `>=`, so at the defaults a count of exactly 1 does nothing,
2 flags, and 3 rejects. And `duplicate_body_reject`, despite the name, only ever
**flags** — it pushes to `flags`, not to `reasons`.

There is a further honesty point about the repost count itself, from the same
audit: it is incremented when a re-swept posting is dropped as a duplicate, which
means it partly counts sweeps rather than genuine re-postings. That is analysed in
[`../code/02-leads-finding.md`](../code/02-leads-finding.md); it is a reason to be
cautious about lowering `repost_reject`, not a reason to raise it blindly.

### 1.7 `roles.title_keywords` — the authoritative list

This is the most consequential list in the repository.

```yaml
roles:
  title_keywords:
    - full-stack
    - full stack
    - fullstack
    - back-end
    - backend
    - back end
    - front-end
    - frontend
    - front end
    - software developer
    - software engineer
    - web developer
    - game mathematician
    - mathematician
    - game developer
    - gameplay
    - game engineer
    - product engineer
    - forward deployed engineer
    - qa engineer
    - qa automation
    - sdet
    - software development engineer in test
    - test engineer
    - test automation
    - automation engineer
    - quality engineer
```

Twenty-seven entries covering three role families: full-stack/web development,
games, and QA automation / SDET.

**This list is the definition of "in scope", and nothing else is.** Not a
sentence in `CLAUDE.md`, not a skill description, not a summary in any document
including this one, and above all not a model's judgement about what your job
search is. `CLAUDE.md` states the rule in its own opening paragraph and marks it
`AUDIT M16`: never decide a title is out of scope from any sentence in that file,
because `roles.title_keywords` is the authoritative list, the user owns it, and it
is wider than any summary of it.

The reason this needs saying at all is a failure mode that has already happened.
A summary says "Full-Stack Developer roles", an agent reads the summary rather
than the file, and quietly stops surfacing the game-mathematician and SDET roles
that are sitting right there in the list. The user never sees them and never
learns they existed. Two entries in this list — `product engineer` and
`forward deployed engineer` — were added on 2026-08-02 precisely because a
diagnosis of ~2,700 read titles found they were the only two that cleared every
other gate and failed **only** the literal keyword match. Eight more were added on
2026-08-03 when the search widened to QA automation. The list grows because you
grow it.

**How the matching works, exactly.** Unlike the two filter lists below,
`title_keywords` is a plain **substring** test, case-insensitive:

```js
// passesLimits()
const title = String(job.title ?? "").toLowerCase()
const kws = limits.roles?.title_keywords ?? []
const titleHit =
  !kws.length || kws.some((k) => title.includes(String(k).toLowerCase()))
```

Three consequences:

1. `mathematician` matches `Game Mathematician`, `Senior Mathematician` and
   `Mathematician II` alike. Substring matching is deliberately loose here,
   because the hard filter runs first and catches the seniority cases.
2. Word boundaries are **not** applied. An entry of `sdet` would match a title
   containing `sdetector` if such a title existed. In practice the entries are
   long enough that this has not bitten.
3. **An empty or missing list accepts every title.** `!kws.length ||` is the
   first clause. Deleting the list does not shut the pipeline down; it opens it
   completely. This is the opposite of what most people expect from a filter and
   is worth remembering before you comment anything out "just to test".

**Who else reads it.** Three scripts beyond the sweep:

- `scripts/documents/keyword-plan.mjs` — `limits.roles?.title_keywords ?? []`
  becomes the `targets` used when planning which keywords a tailored résumé
  should cover.
- `scripts/documents/assemble-resume.mjs` — the same, for deterministic
  résumé assembly.
- `scripts/leads/find-jobs.mjs` `bodyDisqualifiers` — a posting whose title
  matches none of these entries counts as a "loose arrival" and gets the extra
  body scrutiny described below.

So editing this list changes not only which jobs you see, but which words your
tailored documents aim at.

**The local latitude exception.** A commutable posting whose title misses every
keyword is not rejected outright:

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

`local` is true only when `onsite_allowed` matched. The motivating case was
Caesars' "Staff Engineer - Booking Engine" — a real Las Vegas software job that
matched no keyword. Remote postings get no such latitude: there are thousands of
them and the keyword gate is what keeps them manageable. `LOOSE_TECH_TITLE` and
`TRADES_TITLE` are both hard-coded regular expressions, not configuration.

### 1.8 `roles.hard_filter` — rejected at ingest

Forty-one entries, in three groups: seniority above reach (`senior`, `sr`,
`staff`, `principal`, `architect`, `lead`, `manager`, `director`, `vp`,
`founding`, …), non-software roles (`technician`, `recruiter`, `sales`,
`designer`, `business analyst`, …), and wrong career stage (`intern`,
`internship`, `apprentice`).

A title matching any of these is **rejected immediately**, before location is
checked, before the date is parsed, before anything is stored:

```js
const hardHit = matchTitleKeyword(title, limits.roles?.hard_filter)
if (hardHit)
  return {
    ok: false,
    reasons: [`title: "${hardHit}" is hard-filtered`],
    flags: [],
  }
```

**Matching is by whole word**, which is a different rule from `title_keywords`:

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

`\b` is a **word boundary** — the position between a letter/digit and a
non-letter. So `sr` matches `Sr.` but not `usr`, and `lead` matches `Lead` but
not `leading`. The `.replace(...)` escapes any regular-expression punctuation in
your entry, which is why you can safely write `.net` and `c#` in the soft filter
without them being interpreted as patterns.

The seniority terms are not guesses. The file records the stated minimums from 47
postings read on 2026-07-28: Senior/Sr. 4–10 years, Staff 7–12, Principal 8–12,
Lead/Manager 6–8 plus people leadership, Architect 4+ plus certification. Against
~2.5 years none of those is reachable, and every one of those 47 leads was
rejected by hand before the filter existed.

**Order matters.** `Lead Software Engineer` contains `software engineer`, which
is in `title_keywords`, and `lead`, which is in `hard_filter`. The hard filter
runs first and returns immediately, so the posting is rejected. If you ever want
lead roles, removing `lead` from this list is the edit — adding something to
`title_keywords` will not help.

### 1.9 `roles.soft_filter` — flagged, never rejected

Sixty-odd entries in five groups: ambiguous level markers (`ii`, `iii`, `iv`,
`"2"`, `"3"`), adjacent disciplines (`devops`, `sre`, `platform`, `mobile`,
`ml`, `qa`, `test`, `automation`, …), stacks outside the profile (`php`, `.net`,
`c#`, `java`, `ruby`, `golang`, `rust`, `unity`, `unreal`, …), clearance and
regulated work (`clearance`, `ts/sci`, `polygraph`, `federal`, `defense`), and
employment shapes (`contract`, `temporary`, `part-time`).

```js
const softHit = matchTitleKeyword(title, limits.roles?.soft_filter)
if (softHit) flags.push(`title_watch:${softHit}`)
```

Same whole-word matching as the hard filter. The lead is **kept** and flagged
`title_watch:<term>`, which tells the screening stage to read the posting body
before any tailoring effort is spent.

The motivating case is recorded in the file: Chainguard's "Software Engineer
(Libraries Platform)" carried no seniority word in the title at all, yet the body
said "join as a Senior Software Engineer" and asked for 5+ years. No title filter
can catch that; only reading the description can.

There is a deliberate interaction between this list and `title_keywords` that is
easy to mistake for a bug. `qa`, `test` and `automation` appear in **both** —
`qa engineer` is a targeted title, and `qa` is a soft-filter term. A posting
titled "QA Engineer" therefore passes the keyword gate **and** gets flagged
`title_watch:qa`. That is intentional: the flag makes screening read the body and
keep the automation-engineering roles while dropping the manual-testing ones. The
file says so in a comment; do not "fix" the overlap.

### 1.10 Three `roles` keys the code reads that your file does not declare

These are supported, documented in code comments, and absent from your file — so
today each falls back to its built-in default. They exist for retargeting: if the
job search moves to a different field, these are the keys that move with it.

**`roles.exclude_body`** — a list of plain phrases, replace-style. Read by
`excludeBodyPattern()` in `find-jobs.mjs`. When absent, the built-in
`NON_SOFTWARE_BODY` regular expression is used — casino facilities vocabulary
(`preventive maintenance`, `slot machines`, `hvac`), hospitality vocabulary
(`banquet`, `beverage server`, `guest services`) and back-office finance
(`accounts payable`, `general ledger`). A posting matching that pattern **and**
containing no software vocabulary is rejected outright, with no caution step.

Two design decisions in that function are worth understanding before touching it.
It is a **term list and never a boolean**: a `skip_body_gate: true` escape hatch
would let a retarget switch the whole control off, whereas a term list only lets
you say _what_ it rejects on, never _that_ it rejects. And an **empty list is
treated as absent**, not as "reject on nothing" — because `exclude_body: []`
would otherwise be exactly the off-switch the key exists to refuse, spelled as a
list. Entries are matched as literal phrases with word boundaries, so you write
plain words, not patterns.

**`roles.search_query`** — a string. Default: `DEFAULT_SEARCH_QUERY = "full stack"`.
Read by `cmdSearch` in `find-jobs.mjs` and by `searchQuery()` in
`manage-sources.mjs`. Resolution order is `--query` flag, then this key, then the
default. It only matters for the sources where the query is a **server-side
filter** — Workday, Adzuna and Hacker News — rather than a local one; for a
Greenhouse board the whole list is fetched regardless. Having one shared source
of this string is why a board's prescreen count agrees with what the daily sweep
later finds for it.

**`roles.title_rank`** — a list of groups, used for ranking rather than
filtering. Read by `titleScore()` in `scripts/leads/recommend.mjs`. Default:

```js
const DEFAULT_TITLE_RANK = [
  ["full-stack", "full stack", "fullstack"],
  ["back-end", "back end", "backend"],
  ["software engineer", "web developer", "developer"],
]
```

Each entry is one rank, highest first; an entry may be a single phrase or an
array of synonyms that tie at that rank. Position derives the weight — rank _i_
of _n_ groups scores `(n - i) * 2`, so these three groups produce exactly
6 / 4 / 2 / 0. The first matching group wins, so a title naming both "full-stack"
and "developer" scores as full-stack rather than the sum.

The comment above it records the bug it replaces: it used to _claim_ to come from
`application-limits.yaml` while not reading that file at all, and after a retarget
four identically-scored nursing leads fell through to alphabetical-by-company and
were presented as a "ranked" list.

### 1.11 `employment.reject_types` — the employment-type gate

Also absent from your file, and read by `bodyDisqualifiers`:

```js
const rejectTypes = (limits.employment?.reject_types ?? []).map((t) =>
  String(t).toLowerCase(),
)
if (rejectTypes.includes(kind))
  reasons.push(`body: ${kind}, not full-time permanent`)
else flags.push(`employment:${kind}`)
```

`kind` is produced by the `EMPLOYMENT_SHAPE` patterns, which look for an
explicit declaration ("Employment type: Contract", "This is a 6-month contract",
"fixed-term position", "contract-to-hire"). The values it can produce are:

`contract`, `contract-to-hire`, `temporary`, `temp`, `part-time`, `seasonal`,
`intern`, `internship`, `fixed-term`

The patterns are deliberately anchored on a type declaration or a duration, so
the bare word "contract" inside "contract law" or "contract negotiation" cannot
trip them.

With the key absent — the state today — **nothing is rejected for employment
type**; every match becomes a flag such as `employment:contract`. That matches
your stated preference recorded in memory that contract work is acceptable. If
you ever want to exclude, say, internships and seasonal work outright, the edit is:

```yaml
employment:
  reject_types:
    - internship
    - seasonal
```

### 1.12 The `auto_apply` block

```yaml
auto_apply:
  enabled: true
  dry_run: false
  per_run_max: 10
  per_day_max: 10
  per_company_max_per_week: 5
  cache_max_age_days: 30

  board_allowlist:
    boards.greenhouse.io: greenhouse
    job-boards.greenhouse.io: greenhouse
    jobs.lever.co: lever
    jobs.ashbyhq.com: ashby
```

This block governs the **unattended** path only — a runner that works through
stored leads without you watching. It is entirely separate from you handing the
agent a posting URL and asking it to apply, which is governed by `CLAUDE.md` hard
rule 6 and not by this block.

**No defaults are supplied for any of these.** That is unusual in this codebase
and it is deliberate. `scripts/auto/caps.mjs` says it plainly: a missing cap reads
as "not configured" and the check returns a refusal, "because an unattended
process inventing its own blast radius is precisely the failure the block exists
to prevent."

**`enabled`** — boolean. Must be **strictly** `true`. Absent, `null`, `"yes"`
and `1` all fail (`scripts/auto/authorize.mjs`, check `enabled`). It answers "may
this machine run at all".

**`dry_run`** — boolean. It answers a different question: "does it click".
`scripts/auto/auto-apply.mjs` resolves the run mode with

```js
const mode = auto?.dry_run === false ? "live" : "dry_run"
```

so anything other than an explicit `false` means dry run. A dry run still
requires `enabled: true`; reading `enabled: false` as "dry runs are fine" was
considered and rejected, because rehearsing a dry run you trust is precisely how
you decide whether to enable the live path. Dry-run submissions are recorded in
the `auto_submissions` table with `mode = 'dry_run'` and **count toward the caps
on purpose** — the rehearsal must exercise the same arithmetic the live run will.

**`per_run_max`** — number, currently `10`. The most applications one invocation
may send. Checked first in `capCheck()` against an in-memory count, before any
database read.

**`per_day_max`** — number, currently `10`. Applications in the trailing 24
hours, counted from the `auto_submissions` ledger rather than from a counter the
runner keeps in memory — a counter resets when a process dies and forgets what it
sent this morning; a ledger does not.

**`per_company_max_per_week`** — number, currently `5`. Applications to one
company in the trailing 7 days, counted **by company name**. A lead carrying no
company name cannot be counted and is refused rather than waved through. When
this cap trips, the refusal is itemised by source — `3 auto-submitted, 2 from dry
runs (rehearsals, counted on purpose)` — because an unitemised version once sent
a user hunting through a ledger for "manual applications" that did not exist.

All three must be finite numbers and not negative, and `enabled`/`dry_run` must
be actual booleans, or `preflight.mjs` refuses the run and names the malformed
keys.

> These caps are the anomaly brake, not a volume throttle. Application volume in
> this project is deliberately unlimited; what these numbers bound is how much
> damage a single misbehaving unattended run can do before you notice.

**`cache_max_age_days`** — number, currently `30`.

> **Known defect (2026-08-05 audit).** Nothing reads it. A repository-wide search
> for `cache_max_age_days` finds it in your file, in a test fixture that copies
> your file's shape (`tests/auto/preflight.test.mjs`), and in documentation —
> and in no script. The form-field cache it appears to describe
> (`scripts/apply/field-cache.mjs`) invalidates entries by a `CACHE_VERSION`
> mismatch, not by age. Setting this to any value changes nothing.

**`board_allowlist`** — a map of `domain: ats-id`. Read by
`scripts/auto/trust.mjs` (`normalizeAllowlist`, `allowlistProblems`,
`allowlistEntry`) and by `auto-apply.mjs` at startup.

It is **nested under `auto_apply` on purpose**. Both readers look for
`auto_apply.board_allowlist`; the same four lines written at the top level of the
file are read by nothing, and the gate then refuses every board. That mistake was
made once and fixed on 2026-08-03.

The value is an **ATS identifier**, and it must name an adapter this repository
actually ships. Today those are exactly three: `greenhouse`, `lever`, `ashby`
(`ADAPTERS` in `scripts/apply/ats/index.mjs`). A typo — `greenhosue` — is
reported at startup by `allowlistProblems()` as a plain sentence rather than
showing up as every job mysteriously deferring `board-untrusted`.

Two shapes are accepted, because you write this by hand: the map form above, or a
list of `{domain, ats}` objects. A **bare list of domain strings is deliberately
refused**, because it would leave the ATS to be inferred from the URL — and a
board that happens to put "greenhouse" in its own path would then be trusted as
Greenhouse.

Domain matching is exact, or a dot-delimited subdomain:

```js
return h === d || h.endsWith(`.${d}`)
```

The dot is what stops `evilgreenhouse.io` matching an entry of `greenhouse.io`. A
bare `endsWith` would accept it, and that is the entire bug the function exists
not to have.

**What this list can and cannot do.** The file's own comment is the clearest
statement of it, and it is worth reading as written: every Greenhouse tenant is
same-origin with every other Greenhouse tenant, and ATS tenancy is self-service.
So the allowlist answers "is this the vendor's software", while the gate is being
asked "is this party safe to submit to unattended". Those are not the same
question. The allowlist can never be load-bearing against a hostile tenant; the
controls that survive that are structural — the browser carries no session
cookie, and nothing is read back out of the page.

> **Known defect (2026-08-05 audit).** `CLAUDE.md` states that the runner "ships
> `enabled: false, dry_run: true`" and that "the user's file has neither
> [`enabled: true`] nor a `board_allowlist`, so the trust gate refuses every
> board today." **That is no longer true of the committed file.** As it stands
> today `enabled: true`, `dry_run: false`, and four ATS domains are allowlisted,
> so `mode` resolves to `live` and the trust gate passes those four boards. The
> audit records the same finding and adds that `auto-apply.mjs` does now launch a
> browser (`launchBrowser()` → `chromium.launch()`), contradicting a second
> sentence in the same paragraph. You should know plainly: **the unattended path
> is armed in configuration.**
>
> What still stops a live unattended submit is not this block. It is the
> **post-submit classifier** in `scripts/auto/classify.mjs`. Every rule there
> declares where its evidence came from, and a rule justified by a fixture page
> in this repository may fire **only on loopback** (`127.0.0.1`, `localhost`).
> Every rule today is fixture-sourced, so a real employer's page classifies as
> `unclassified`, which is a hard STOP. That is the honest current state: a real
> board is stopped by the absence of evidence, not by the settings in this block.
> If you do not want the unattended path armed, `dry_run: true` is the one-word
> edit, and it is yours to make.

---

## Part 2 — `docs/job-sources.yaml`

### 2.1 What it is

The list of company job boards swept by `node scripts/leads/find-jobs.mjs
search`. Forty-four entries at present: 24 Greenhouse, 8 Ashby and 2 Lever
boards (mostly technology companies), then a block of Las Vegas gaming and
hospitality employers — 3 Workday, 2 Oracle, 2 SmartRecruiters, 1 Jobvite,
1 SuccessFactors — and 1 remote-only aggregator.

It is loaded by:

```js
export function loadSources(file = SOURCES_PATH) {
  if (!fs.existsSync(file)) return DEFAULT_BOARDS
  const doc = yaml.load(fs.readFileSync(file, "utf8"))
  return doc?.boards?.length ? doc.boards : DEFAULT_BOARDS
}
```

`DEFAULT_BOARDS` is two entries — Anthropic on Greenhouse, OpenAI on Ashby. So a
missing file, or a file whose `boards:` list is empty, does not produce an error
or an empty sweep; it silently sweeps two boards. If a morning's sweep returns a
suspiciously small number of leads and only from those two companies, this is the
first thing to check.

Each entry produces one call to `fetchBoard(board, query)`, which dispatches on
`type` through the `BOARD_FETCHERS` map. An unknown `type` throws
`unknown board type "..."` for that board and does not stop the sweep.

### 2.2 The entry shape for each board type

The required fields differ by type, because the ATS vendors identify a customer
differently. Three patterns cover all of them.

**Pattern A — slug-based.** The company is a short name in the URL. Types:
`greenhouse`, `lever`, `ashby`, `workable`, `recruitee`, `smartrecruiters`,
`jobvite`.

```yaml
- { type: greenhouse, slug: anthropic, company: Anthropic }
- { type: lever, slug: palantir, company: Palantir }
- { type: ashby, slug: linear, company: Linear }
- { type: smartrecruiters, slug: BoydGaming, company: Boyd Gaming }
- { type: jobvite, slug: agscareer, company: AGS }
```

Required: `type`, `slug`, `company`. The `slug` is what appears in the board's
own URL — for `https://boards.greenhouse.io/anthropic` the slug is `anthropic`.
Note that SmartRecruiters slugs are **case-sensitive** (`BoydGaming`, not
`boydgaming`).

Jobvite accepts one optional extra, `eid`. The fetcher can bootstrap it by
reading the careers page, but pinning it saves a request and survives a
careers-page redesign:

```yaml
- { type: jobvite, slug: agscareer, company: AGS, eid: eqX9Vfwd }
```

**Pattern B — host + tenant + site (Workday only).**

```yaml
- {
    type: workday,
    company: "Light & Wonder",
    host: lnw.wd5.myworkdayjobs.com,
    tenant: lnw,
    site: LightWonderExternalCareers,
  }
```

Required: `type`, `company`, `host`, `tenant`, `site` — and **no `slug`**. All
three come straight out of the careers URL, which has the form
`https://<tenant>.wdN.myworkdayjobs.com/<site>`. For Light & Wonder's
`https://lnw.wd5.myworkdayjobs.com/LightWonderExternalCareers`: tenant `lnw`,
host `lnw.wd5.myworkdayjobs.com`, site `LightWonderExternalCareers`. The `wd5`
part is which Workday data centre the customer is on and cannot be guessed —
it must be read off the real URL.

**Pattern C — host + site (Oracle Recruiting Cloud) and host only
(SuccessFactors).**

```yaml
- {
    type: oracle_cloud,
    company: Caesars Entertainment,
    host: edmn.fa.us2.oraclecloud.com,
    site: CX_1,
  }
- { type: successfactors, company: IGT, host: jobs.igt.com }
```

Oracle requires `type`, `company`, `host`, `site` — the host is an opaque
four-letter tenant code plus a data-centre region (`edmn.fa.us2`), and the site is
usually `CX_1` but not always (`StationCasinos` for Station Casinos).
SuccessFactors requires only `type`, `company`, `host`, where the host is the
career-site hostname.

> **The two long examples above are wrong on purpose, and instructively so.**
> This document is formatted by prettier, which broke the Workday and Oracle
> entries across several lines because they exceed its width limit. **In
> `job-sources.yaml` each of those must be a single line**, exactly as it appears
> in the real file. This is precisely the reformatting that `.prettierignore`
> exists to prevent there, and §2.4 explains what silently breaks when it
> happens.

**Aggregators.** Three remote-only job sites, which are not company boards at
all — their entire corpus is remote roles:

```yaml
- { type: jobicy, company: Jobicy (remote US), geo: usa, industry: engineering }
# - { type: remotive, company: "Remotive (remote)", category: software-dev }
# - { type: remoteok, company: "RemoteOK (remote)" }
```

`jobicy` takes optional `geo` (default `usa`) and `industry` (default
`engineering`); `remotive` takes optional `category` (default `software-dev`);
`remoteok` takes nothing. Their fetchers set `remote_source: true` on every
posting, which is what tells `passesLimits` to read a location of `USA` as an
eligibility statement rather than a relocation (§1.1). They also return the full
description in the list response, so the body gate runs without a second fetch
per posting.

Two of the three are commented out, with the measurement recorded in the file:
Jobicy yielded 5 kept of 50 on 2026-07-29 — a better rate than every company board
tracked except Render — while Remotive yielded 0 of 35 and RemoteOK 0 of 100.
Uncommenting either lets `board-yield.mjs` judge them again on fresh evidence.

**Adzuna** is deliberately not in this file. It is a credential-based aggregator
— it needs an API key, kept in `.env` as `ADZUNA_APP_ID` and `ADZUNA_APP_KEY` —
and it is always included in `search --source all` when those are configured,
without needing an entry here.

**Summary table.**

| `type`            | Required fields                     | Optional          | Example identity    |
| ----------------- | ----------------------------------- | ----------------- | ------------------- |
| `greenhouse`      | `slug`, `company`                   | —                 | `anthropic`         |
| `lever`           | `slug`, `company`                   | —                 | `palantir`          |
| `ashby`           | `slug`, `company`                   | —                 | `linear`            |
| `workable`        | `slug`, `company`                   | —                 | —                   |
| `recruitee`       | `slug`, `company`                   | —                 | —                   |
| `smartrecruiters` | `slug`, `company`                   | —                 | `BoydGaming`        |
| `jobvite`         | `slug`, `company`                   | `eid`             | `agscareer`         |
| `workday`         | `company`, `host`, `tenant`, `site` | —                 | tenant `lnw`        |
| `oracle_cloud`    | `company`, `host`, `site`           | —                 | site `CX_1`         |
| `successfactors`  | `company`, `host`                   | —                 | host `jobs.igt.com` |
| `jobicy`          | `company`                           | `geo`, `industry` | —                   |
| `remotive`        | `company`                           | `category`        | —                   |
| `remoteok`        | `company`                           | —                 | —                   |
| `hackernews`      | (not a board entry — a `--source`)  | —                 | —                   |

### 2.3 Adding and removing boards with `manage-sources.mjs`

You can edit this file by hand. You should not, and the reason is not tidiness —
it is that the command does three things a hand edit cannot.

```bash
# add a board
node scripts/leads/manage-sources.mjs add --type greenhouse --slug figma --company "Figma"

# a Workday board
node scripts/leads/manage-sources.mjs add --type workday --company "Acme Corp" \
  --host acme.wd1.myworkdayjobs.com --tenant acme --site AcmeCareers

# remove one, by company name or by slug
node scripts/leads/manage-sources.mjs remove "Figma"

# live-check every board in the file
node scripts/leads/manage-sources.mjs verify

# list what is tracked
node scripts/leads/manage-sources.mjs list
```

What `add` does that you cannot do by hand:

**It validates the shape for that type.** `oracle_cloud` without `--host` and
`--site` is refused with a message naming an example of each. `workday` without
all three is refused. Any slug-based type without `--slug` is refused. This
matters because a missing field written as the literal string `undefined` is
valid YAML that then prescreens fine and silently fetches nothing — which is
exactly how two dead entries got into the file once.

**It refuses duplicates.** `findDuplicate()` treats a board as already tracked if
the company name matches, **or** if the type plus board identity matches — where
identity is `slug ?? tenant ?? site`, whichever that type uses.

**It prescreens with a live API call.** The board must answer with a job list
before it earns a slot:

```
Added Figma (greenhouse:figma) — prescreen OK, 41 posting(s) visible right now.
```

A board that is live but currently empty is still added, with a note saying so. A
board that does not answer is not added at all. The query used for the prescreen
is the same one the daily sweep uses (`searchQuery()` reads
`roles.search_query`, §1.10), so a prescreen count and a sweep count are
comparable.

`verify` runs that same live check across every entry and reports:

```
ok      greenhouse:anthropic (73 postings)
ok      ashby:linear (12 postings)
BROKEN  workday:aristocrat — HTTP 404

43 ok, 1 broken.
```

It exits non-zero when anything is broken, so it can be run as a check rather
than read as prose. Boards do break — a company migrates ATS, or changes its
slug — and a broken board contributes zero leads every morning without saying
anything.

`remove` deletes by company name **or** by identity, matching on a normalised
(trimmed, lowercased) comparison, and reports how many lines it removed.

### 2.4 Why one flow-style entry per line, and why the file is in `.prettierignore`

This is the constraint that makes the tooling above possible, and breaking it
breaks the tooling quietly.

`manage-sources.mjs` edits the file **line by line**, not by parsing it and
writing it back out. `removeEntryFromText` walks the lines, and for each line
matching `/^\s*-\s*\{.*\}\s*$/` it parses that one line as YAML to see whether it
is the entry being removed. `addEntryToText` appends one formatted line.

The reason it works that way is the comments. A full YAML round-trip — read the
whole document into memory, modify it, write it back — **deletes every comment in
the file**, because comments are not data and the parser does not keep them. This
particular file's comments include the format rule, the required fields for every
board type, the measured yield of three aggregators, and the note explaining why
two of them are commented out. Losing that to an automated add is a bad trade.

That only works while every board is one flow-style entry on one line. Which
brings in the second half:

```
# .prettierignore
# manage-sources.mjs edits this file LINE BY LINE, to preserve the explanatory
# comments a full yaml round-trip would delete. That only works while every
# board is one flow-style entry on one line, which the file's own FORMAT RULE
# states. Prettier reflows the longer workday and oracle_cloud entries into
# multi-line block style, which silently breaks that contract.
docs/job-sources.yaml
```

**Prettier** is the automatic code formatter this project runs on every file the
agent edits, via a PostToolUse hook. Left to itself it would reflow the long
Workday and Oracle entries — which exceed its line-width limit — into multi-line
block style. That is still valid YAML and every board would still be swept, so
nothing would appear broken. But `removeEntryFromText`'s single-line regex would
no longer match those entries, and `manage-sources.mjs remove "MGM Resorts
International"` would report `no tracked board matches` for a board that is
plainly in the file.

Hence the `.prettierignore` entry. `CLAUDE.md` lists it among a small set of
`.prettierignore` entries that are contracts rather than preferences, alongside
two browser scripts that must not receive prettier's leading-semicolon guard.

One safety net does exist: `writeSourcesText()` re-parses whatever it is about to
write and throws `internal error: edited job-sources.yaml no longer parses` if the
result is not a document with a `boards` array. That catches a corrupted write,
not a reformatted one.

---

## Part 3 — The smaller files

### 3.1 `docs/board-candidates.yaml` — a work queue, not configuration

Boards discovered by `scripts/leads/find-boards.mjs` and **not yet swept**. 872
lines, 217 candidates, each `{type, slug, company, pool}`. Its header says
plainly: run `discover-boards.mjs` to yield-gate these, then add the survivors
with `manage-sources`. Nothing here touches `job-sources.yaml`.

It is written but never read back — `find-boards.mjs` uses it as the default
`--out` target and no script reads it as input. Deleting it would lose a work
queue and break no script and no test.

> **Known defect (2026-08-05 audit).** `find-boards.mjs` writes this file
> unconditionally whenever it resolves any board, while the merge of existing
> candidates is gated on `--append`. A single
> `find-boards.mjs --names "Acme"` that resolves one board replaces all 217
> entries with one, with no warning and no backup. Only git history mitigates it.
> Always pass `--append`.

> **Known defect (2026-08-05 audit).** The `pool` field conveys nothing.
> `discover-boards.mjs` exports `POOLS = ["local", "levelled", "remote"]` with a
> ten-line comment describing it as a priority order, but nothing sorts or filters
> on it, and `find-boards.mjs` hard-codes `pool: "levelled"` for every candidate
> it writes — so all 217 rows carry the same value.

### 3.2 `docs/candidates/*.yaml` — research lists

Three hand-curated lists of company names, passed explicitly to `find-boards.mjs`
with `--file`. Nothing reads them by default and no test reads them.

- **`local-lv.yaml`** — Las Vegas metro employers, the highest-value pool for
  this profile because on-site is in scope here, so the whole board counts rather
  than only its remote requisitions. Its header carries a measured negative
  result worth more than the list: nine named local employers (Konami Gaming,
  Everi, Zappos, Switch, Scientific Games, PlayAGS, Sightline, Southwest Gas, NV
  Energy) were probed against all six no-auth ATS APIs and **none** resolved.
  They are on Workday, iCIMS, Taleo or Phenom, whose board URLs contain an opaque
  tenant host that cannot be derived from a company name. Each needs its careers
  URL read once by hand, the way the existing Workday and Oracle entries were.
- **`fortune500.yaml`** — large enterprises, with a measured warning about their
  board yield.
- **`yc.yaml`** — from the public yc-oss directory. Its header records why
  `workatastartup.com` is not swept, which is the reusable part.

### 3.3 `docs/perf-baseline.json` — the performance gate's reference numbers

JSON, not YAML, and load-bearing for continuous integration. It records what a
benchmark run looked like when the numbers were last accepted as good:

```json
{
  "taken_at": "2026-08-03T04:28:54.530Z",
  "command": "node scripts/dev/bench-runner.mjs --apps 50 --concurrency 8 --board greenhouse,honest-greenhouse --runs 3 --json",
  "columns": {
    "model_turns_per_app": 0,
    "sleep_ms_per_app": 450,
    "round_trips_per_app": 60,
    "defer_rate": 0.5,
    "wall_ms_p95": 1565.31
  },
  "provenance": { "sha": "9905681", "file_sha1": { ... } }
}
```

Read by `.github/workflows/perf-gate.mjs` (`BASELINE_PATH`), which runs a fresh
benchmark and fails the build on a regression, and by
`tests/hooks/perf-gate.test.mjs`. `model_turns_per_app: 0` is the number worth
noticing: the fill path is meant to cost **zero** AI model turns per application,
and this file is what keeps it that way. Updating it is a deliberate act — see
[`../code/15-benchmarks.md`](../code/15-benchmarks.md).

### 3.4 `docs/tailoring-rules.md` — configuration for a model, not a script

This one is different in kind from everything else in this document, and the
difference is the point.

It is Markdown, not YAML, and it is **loaded at runtime by three skills** —
`tailor-resume`, `tailor-cover-letter` and `pipeline-jobs` — using the `@` file
reference in their `SKILL.md`. So it is read by an **AI model**, as instructions,
every time a document is tailored. No script parses it.

It contains the fact-source whitelist (`profile/profile.yaml`,
`profile/answers.yaml`, and from `jobs/<slug>/job.json` the company name and
title **only**), the list of allowed transformations (reorder, select/drop,
rephrase) with worked OK/not-OK examples, the forbidden list (inventing skills,
strengthening quantifiers, claiming tech mentioned only in the posting), and the
rule that unknown information means stopping and asking rather than guessing.

Editing it changes how the model writes. That is real leverage and also real
risk: the deterministic verifier `scripts/documents/verify-claims.mjs` is what
actually enforces truthfulness, and this file only guides the model toward
passing it. Loosening a rule here does not loosen the verifier.

> **Known defect (2026-08-05 audit).** Two places where this file and the code
> disagree. §8 instructs the writer to spell a skill "PostgreSQL not Postgres",
> while `verify-claims`' rule R6 compares raw surface strings — so a profile
> saying "Postgres" plus a résumé saying "PostgreSQL" is an R6 violation and exit
>
> 1. The document and the gate actively fight each other. Separately, §8 says
>    _"Never exceed `density_cap` repeats of a term. Keyword stuffing is actively
>    detected and penalised now"_ — no code counts repeats. `verify-claims` checks
>    presence and absence only, and `ats-lint` never counts term frequency.

### 3.5 `docs/measurements.md` — the append-only measurement ledger

Not configuration at all; a record. 1,236 lines, append-only by rule — a
performance dip that was later fixed stays visible. Its governing rule is that no
performance change merges without a before/after measurement, which exists
because an audit once found roughly 24 seconds of fixed waiting in the apply path
that everyone had assumed was network time.

No script reads it. It is cited in comments by the benchmark tools, by
`ci.yml`, and by four tests, and two of the benchmark tools emit a paste-ready
entry for it so that recording a measurement is one command. Its "Measuring
honestly" section carries one rule worth repeating here: never measure against a
live employer's board — use the local fake board under `tests/fixtures/boards/`,
because live boards vary and you would be measuring their weather.

---

## Part 4 — What happens if you get it wrong

Every configuration file has a worst case. For this system the worst case is
specific, and it is not the one people expect.

**It is not an error.** An error is the good outcome. A tab character in the
YAML, a missing colon, an `ats` id you spelled `greenhosue` — every one of those
produces something visible: a crash, a startup warning, a board reporting
`BROKEN`. You find out immediately and fix it.

**The worst case is a silent narrowing.** You add a term to `hard_filter`, or
raise `fit.reject_below`, or lower `freshness.max_age_days`, or delete a
`title_keywords` entry that looked redundant. Tomorrow's sweep runs. It reports a
smaller number. Everything looks healthy. And the jobs you would have wanted are
now rejected before you ever see a title.

That failure is invisible from the outside because a rejected lead produces no
output. `CLAUDE.md` names it directly — _a job you never see is the worst failure
in this system_ — and it is the reason for the flag-versus-reject asymmetry
running through the whole design. A flag costs you a glance. A reject costs you a
job, and you will never know it happened.

Two structural defences exist.

**First, the code's own bias.** Nearly every gate is written to flag when it is
uncertain and reject only on unambiguous evidence. `min_required_terms` exists so
a thin description cannot reject a job. `unknown_location`, `unknown_age`,
`no_salary`, `remote_unverified`, `title_watch`, `title_loose`, `fit_weak`,
`vague_scope` are all flags, not rejections. `risk.mjs` states the reasoning in
one sentence: _a ghost job costs an application; a false reject costs a job. They
are not symmetric._

**Second, `gate-audit.mjs`.** Run it after any change to
`application-limits.yaml`. Not "after a big change" — after **any** change.

```bash
node scripts/leads/gate-audit.mjs
```

It re-runs every screening stage over your entire stored lead set and diffs the
verdicts against the last recorded run, saved in `jobs/.gate-baseline.json`. Its
output is deliberately asymmetric, exactly like the gates it audits:

- A newly **accepted** lead is a win and gets one line.
- A newly **rejected** lead is the dangerous direction and is listed **in full**,
  with the stage and the reason that killed it, every time.

Its exit codes are built for this too: `0` when clean or when only improvements
happened, **`1` when leads became newly rejected** so a script can notice, `2` for
usage errors.

A worked example. Suppose you decide `mathematician` is too broad and remove it
from `title_keywords`, keeping only `game mathematician`. You run the audit:

```
Audited 149 lead(s) through 4 stages in 812 ms.

  38 pass every stage
  71 rejected at l0 (title/location/date)
  22 rejected at l1 (body disqualifiers)
  18 rejected at l2 (profile fit)

Compared against 149 lead(s) in the baseline.

!! 1 lead(s) NEWLY REJECTED — check each one:

  Aristocrat — Mathematician II
    l0: title: not a targeted role
```

That is a real Las Vegas gaming-industry role that used to be visible and now is
not. You have the information to decide whether the narrowing was what you
wanted — and if it was not, restoring one line to the file undoes it. (The exact
counts above are illustrative; the line shapes are the ones the script prints.
Run in a terminal you get this prose; run from a program you get one
`REGRESSION|stage|id|company|reasons` line per regression instead.)

Without the audit, the same edit produces no output at all. Tomorrow's sweep just
finds one fewer job, and there is no way to tell that from a quiet Tuesday.

`CLAUDE.md` lists `gate-audit.mjs` among the three commands worth knowing without
looking anything up, with the reason attached: run it after **any** gate change.
This document's version of that advice is the same one, said once more because it
is the single habit that protects everything else here.

---

**Where to go next**

- [`01-commands.md`](01-commands.md) — the full catalogue of commands, including
  `find-jobs.mjs search`, `gate-audit.mjs` and `manage-sources.mjs` with their
  flags and sample output.
- [`02-recipes.md`](02-recipes.md) — start-to-finish walkthroughs that use these
  settings in anger.
- [`03-troubleshooting.md`](03-troubleshooting.md) — when the sweep returns
  nothing, when a board goes quiet, when a job you expected does not appear.
- [`../code/02-leads-finding.md`](../code/02-leads-finding.md) — the sweep and
  the two ingest gates in full, board fetcher by board fetcher.
- [`../code/03-leads-screening.md`](../code/03-leads-screening.md) — `screen.mjs`,
  `fit.mjs` and `risk.mjs`, which read `experience`, `fit` and `ghost_signals`.
- [`../code/04-leads-ranking.md`](../code/04-leads-ranking.md) —
  `recommend.mjs` and `manage-sources.mjs`, which read `roles.title_rank` and
  `job-sources.yaml`.
- [`../code/10-auto-safety.md`](../code/10-auto-safety.md) — the trust gate, the
  caps, the classifier and everything the `auto_apply` block feeds.
- [`../guide/07-safety-model.md`](../guide/07-safety-model.md) — why ownership of
  these files is a safety property and not an administrative one.
