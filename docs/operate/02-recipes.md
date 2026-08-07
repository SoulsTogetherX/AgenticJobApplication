# Recipes: how to actually do things

This document is the "how do I do X" half of the operating manual. Every other
document in `docs/` explains what a piece of this system **is**; this one walks
you through the twelve tasks you will actually perform, in order, with the exact
commands, the output you should see at each step, the one line that tells you it
worked, and what to do when it does not. Each recipe stands alone — you can jump
straight to the one you need — and each one explains why the step exists before
telling you to type it, because a command you do not understand is a command you
cannot debug.

**What you will learn**

- How to run a **daily job sweep** and read the ranked shortlist it produces
  (recipe 1), and how to work out **why a job you expected never appeared**
  (recipe 12) — the two halves of the same skill.
- The **full document pipeline** for one job: workspace → keyword plan →
  tailored resume → truthfulness check → your approval → rendered PDF (recipe
  2), including exactly what the approval message must show you and why.
- How an application is **filled and submitted in a real browser** (recipe 3),
  what the fill report means, and which lines of it you must read rather than
  trust.
- How to **answer a question the pipeline could not answer** and bank the answer
  so it is never asked again (recipe 4) — with `save-answer.mjs`'s five exit
  codes and the shell guard's three flags explained one at a time.
- How to **record an application and its outcome** (recipe 5), and what
  "provenance" means in practice.
- How to see **what needs a follow-up nudge** and send one (recipe 6).
- How to **add a company's job board** properly (recipe 7) — finding the board's
  slug with `find-boards.mjs`, yield-gating it with `discover-boards.mjs`, and
  adding it with `manage-sources.mjs` instead of editing YAML by hand.
- How to **change what counts as an in-scope job title** and re-audit the gates
  afterwards (recipe 8), so a widened filter cannot silently narrow something
  else.
- How to **back up and restore your data** (recipe 9), including the one table
  that no backup except a file copy can save.
- How to **turn the unattended runner on and off**, and how to read a dry-run
  report before you trust it (recipe 10). The runner is **armed on this machine
  today** — see the defect note in that recipe.
- How to **add support for a new applicant tracking system** (recipe 11), and
  where the detailed adapter reference lives.

**Conventions used in every recipe**

- Commands are shown for a shell at the **repository root** — the folder
  containing `package.json`, `scripts/` and `docs/`. If a command reports "no
  such file", check where you are first (`pwd` in Git Bash, `Get-Location` in
  PowerShell).
- Every script is run with `node <path>`. `node` is the JavaScript runtime; these
  scripts are ordinary programs, not part of any framework.
- A **flag** is an option that starts with `--`, like `--json` or `--top 5`. A
  **positional argument** is a bare value whose meaning comes from its position,
  like the `<slug>` in `node scripts/documents/keyword-plan.mjs my-slug`. Several
  scripts in this repository parse flags in a way that breaks when a flag comes
  **before** the positional argument; where that is true, the recipe says so.
- An **exit code** is a number a program hands back to whatever ran it. `0` means
  success and anything else means a specific kind of failure. You rarely see it,
  but a script chained with `&&` only runs the next command when the previous one
  exited `0`. Where a script's exit codes carry meaning, the recipe lists them.
- **Scripts print two different formats.** When output goes to a terminal you are
  looking at, they print sentences. When output goes to a pipe, a file, or an AI
  agent — technically, when standard output is not a "TTY" — they print short
  machine-readable records with `|` or tab separators. The recipes below show the
  compact form, because that is what you will see if you copy output into a chat
  window, and the prose form where it differs materially.
- `--json` where supported prints a full structured record instead. Use it when
  you want every field; use the default when you want to read the result.

---

## Recipe 1 — Find new jobs today, and see the best ones

### When to use it

Once a day, or whenever you want fresh leads. This is the entry point to
everything else: nothing can be tailored, applied to, or ranked until it is in
the lead store.

### Why it works this way

A "job board API" here means a public web address that returns a company's open
positions as structured data rather than as a web page. Greenhouse, Lever, Ashby
and several others publish one for every employer that uses them, with no login
and no scraping. `docs/job-sources.yaml` is your list of those boards.

The sweep does four things in order, and the order is the whole design:

1. **Fetch** every board in your list, plus Hacker News' "who is hiring" posts,
   plus the Adzuna aggregator if you have configured credentials in `.env`.
2. **Filter** every result through `docs/application-limits.yaml` — your title
   keywords, your location rules, your freshness limit. This is the cheap gate
   and it discards thousands of postings for free.
3. **Enrich** only the survivors. Four board types return a list with no job
   description at all, so the description has to be fetched one posting at a
   time. Doing that only for postings that already passed the cheap gate is the
   difference between a handful of extra requests and hundreds.
4. **Store** what is left in `jobs/leads.db`, skipping anything already stored
   and anything you have already applied to.

Ranking is a **separate** command, run against the store. That separation matters:
you can re-rank a hundred times without touching the network.

### Step 1 — Sweep

```bash
node scripts/leads/find-jobs.mjs search --source all
```

`--source all` means boards + Hacker News + Adzuna. You can narrow it to
`--source boards`, `--source hn` or `--source adzuna`. Two other flags are worth
knowing: `--query "full stack"` overrides the search phrase (which otherwise
comes from `roles.search_query` in your limits file, falling back to a built-in
default), and `--max-age 14` tightens the freshness limit for this run only.

**What you should see.** One `+` line per lead that was stored, then a summary:

```
+greenhouse:northwind:8098945|Northwind Logistics|Full Stack Engineer|Remote - US
+ashby:orbital:1f2e...|Orbital Systems|Software Engineer, Platform|Las Vegas, NV|unknown_age
stored=6 rejected=1183
```

The trailing field after the location, when present, is a **flag** — a note that
something about the posting could not be confirmed but was not bad enough to
reject it. `unknown_age` means the board published no date; `unknown_location`
means no location string. Flags survive into screening, which is where they get
resolved.

A ratio like `stored=6 rejected=1183` is normal and healthy. The gate is doing
its job. If `rejected` is large and `stored` is **zero every single day**, jump
to recipe 12.

If a board is down you will see a warning on the error channel and the sweep will
continue:

```
warn: source failed: greenhouse:northwind — HTTP 404
```

That is deliberate. One dead board must never lose you the other forty.

### Step 2 — Screen

```bash
node scripts/leads/screen.mjs
```

Screening is a mechanical first pass for scam signals, ghost-job signals and
obvious misfits. It is not the same thing as the ingest filter: ingest asks "is
this in scope at all", screening asks "is this posting real, and could this
profile plausibly do it".

**What you should see.** One line per lead, `verdict|stage|id|company|reasons`:

```
reject|-|smartrecruiters:wynnresorts:744000140519797|Wynn Resorts|over_bar_7y,title_watch:security,title_loose,posting_thin
caution|-|greenhouse:cloudflare:8050386|Cloudflare|unknown_location,posting_thin,repost
reject|l0|adzuna:5785687007|Saksoft|over_bar_5y,stale_36d,employment:contract-to-hire
```

The three verdicts are `reject` (a hard signal), `caution` (worth a closer look)
and `pass`. The second column is the **stage** that rejected it, when one did:
`l0` title/location/date, `l1` body disqualifiers, `l2` profile fit, `l3`
scam/ghost risk, and `-` when the rejection came from screening's own overlay
checks rather than from a stage.

Verdicts are cached in a `screens` table so a later re-screen can skip them with
`--skip-screened`.

### Step 3 — See the best ones

```bash
node scripts/leads/recommend.mjs --top 5
```

This ranks stored leads against your profile with no AI involvement at all. The
score is technology overlap with your profile, plus role-title fit, plus
freshness, plus a salary signal, minus risk flags.

**What you should see.** One line per lead, highest score first:

```
30|jobicy:148197|Lingraphica|Software Engineer - Unity|match:AI/LLM integration,AWS,Agile,CI/CD,Git,Node.js,PostgreSQL,Python,React|gap:C#,Firebase,Jira,Vercel|https://jobicy.com/jobs/148197-software-engineer-unity
25|greenhouse:twilio:8098945|Twilio|Software Engineer (L4)|match:AI/LLM integration,C++,CI/CD,Git,Java,JavaScript,React,Testing|gap:Kotlin,Mentoring|https://job-boards.greenhouse.io/twilio/jobs/8098945
ranked=5 of=56
```

`match:` is what the posting asks for that your profile already evidences.
`gap:` is what it asks for that your profile does not. A long `gap:` list is not
a reason to skip a job — it is the honest picture of what the tailoring step will
have to work around, and it is what feeds `profile-gaps.mjs` later.

`--status` controls which leads are considered: `new` (the default),
`recommended`, or `all`.

### Step 4 (optional) — Queue documents ahead of time

```bash
node scripts/leads/prep-queue.mjs --top 10
```

This picks which leads are worth a tailored resume **before** you sit down to
apply, so the documents already exist when you do.

**What you should see.** Tab-separated columns — score, reason, slug, company,
title, URL:

```
16	no_workspace	-	Northwind Logistics	Full Stack Engineer	https://job-boards.greenhouse.io/northwind/jobs/8098945
14	no_resume	orbital-platform-engineer	Orbital Systems	Software Engineer, Platform	https://jobs.ashbyhq.com/orbital/1f2e...
queued=3 ranked=20
```

`no_workspace` means nothing has been created for this lead yet; `no_resume`
means a workspace exists but has no tailored resume in it.

### How to tell the whole recipe worked

```bash
node scripts/status.mjs
```

```
leads total=194 dismissed=120 recommended=2 applied=16 new=56
applications total=26 applied=26 awaiting=26
followups due=2 northwind-full-stack-engineer(11d) orbital-platform-engineer(10d)
```

`leads total` should have gone up (or stayed level if nothing new was posted).
That is the check.

### When it does not work

| Symptom                                       | Cause                                                  | What to do                                                                                                                                                       |
| --------------------------------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stored=0 rejected=0`                         | Every board fetch failed, or your source list is empty | Run `node scripts/leads/manage-sources.mjs verify` — it live-checks every board and prints `BROKEN <name> — <reason>` for each failure                           |
| `adzuna — ... (skipped)`                      | No Adzuna credentials                                  | Copy `.env.example` to `.env` and fill `ADZUNA_APP_ID` / `ADZUNA_APP_KEY`, free from Adzuna's developer site. Never paste those values into a chat or a document |
| `stored=0` but `rejected` is in the thousands | The gate is rejecting everything                       | Recipe 12                                                                                                                                                        |
| Sweep takes minutes                           | Boards are fetched at concurrency 8 by default         | `--concurrency 12` raises it; be polite, these are other people's servers                                                                                        |

> **Known defect (2026-08-05 audit).** `dedupeLeads` in
> `scripts/leads/find-jobs.mjs` records a "repost sighting" whenever a
> candidate's company + title matches a stored lead and the candidate's own id is
> not yet stored — and then drops the candidate, so its id **never** enters the
> store and the same live posting is counted again on every subsequent sweep.
> `scripts/leads/risk.mjs` sets `repost_reject: 3`, so at the third sweep the L3
> stage rejects the lead outright. Two consequences you will actually see: a
> company with two genuinely different openings under the same title can only
> ever store one of them, and a legitimate posting that sits on a board for three
> days is destroyed as a "repost". If a job you know is real vanishes after a few
> days with an `l3` reason mentioning reposting, this is why.

> **Known defect (2026-08-05 audit).** `scripts/leads/prep-queue.mjs` calls the
> shared ranking function without the keyword map and without your limits
> document, so technology overlap contributes almost nothing to its order and a
> custom `roles.title_rank` in `docs/application-limits.yaml` does not affect it
> at all. `recommend.mjs` was fixed for exactly this and `prep-queue.mjs` was
> not. Treat `recommend.mjs`'s order as the real one; treat `prep-queue`'s as a
> rough "these need documents" list.

---

## Recipe 2 — Tailor a resume and cover letter for one job

### When to use it

When you have picked a lead and want documents for it. This recipe takes you from
a URL or a lead id all the way to an approved PDF.

### Why it works this way

Hard rule 1 of this project is that a tailored document may contain **only** facts
from `profile/profile.yaml` and `profile/answers.yaml`. Rephrasing and reordering
are allowed; inventing a skill, an employer, a date, a metric or a technology is
forbidden. Everything below exists to make that rule mechanical rather than
hopeful:

- The **keyword plan** computes `must_use` as the _intersection_ of what the
  posting asks for and what your fact base can back. A term in `must_use` is
  already true of you, so placing it invents nothing. Everything else the posting
  asks for goes on a `blocked` list.
- Every tailored resume bullet carries an HTML comment naming the profile facts
  it came from: `<!-- fact:exp-nn-b1 -->`. That is hard rule 3.
- **`verify-claims` must pass** before anything is rendered or shown as final
  (hard rule 4). It checks seven rules, and it is a program, not a judgement.
- **You approve before the PDF is rendered** (hard rule 5), and the approval
  message must show what was emphasised, dropped and rephrased against your
  general resume.

### Step 1 — Create the workspace

A **workspace** is the folder `jobs/<slug>/`, and a **slug** is a short
lowercase-with-hyphens name you choose for the job. It is used as a folder name
and as a key in the database, so keep it filesystem-safe: letters, digits and
hyphens.

```bash
node scripts/documents/new-job.mjs northwind-full-stack-engineer \
  --from-lead "https://job-boards.greenhouse.io/northwind/jobs/8098945"
```

`--from-lead` pulls company, title, location, URL and description straight out of
the lead store, so nothing has to re-read the live page for data the sweep
already captured. It matches on lead id first, then URL, then URL with tracking
parameters and trailing slashes stripped.

If there is no stored lead, scaffold it explicitly instead:

```bash
node scripts/documents/new-job.mjs northwind-full-stack-engineer \
  --company "Northwind Logistics" --title "Full Stack Engineer" \
  --url "https://job-boards.greenhouse.io/northwind/jobs/8098945" \
  --description-file /tmp/posting.txt
```

**What you should see.** A line naming the created files, and — on the
`--from-lead` path — a second line reporting what came out of the store:

```
Created jobs/northwind-full-stack-engineer/job.json and context.json
from-lead=https://job-boards.greenhouse.io/northwind/jobs/8098945 company=Northwind Logistics title=Full Stack Engineer location=Remote - US description=4182
```

On the `--description` / `--description-file` path the second line looks
different, because that text has been through the sanitiser and the line reports
what the sanitiser found:

```
description=4182 untrusted=none
```

`description=missing` on either path means no body text survived, and something
will have to supply one before the keyword plan is useful.
`untrusted=hidden_html,alt_text` names the kinds of carrier the sanitiser
stripped. A finding carries **no payload** — only its kind, a count and a
fingerprint — which is the whole point of the shape.

**Exit codes:** `0` created, `1` the workspace already exists, `2` you got the
arguments wrong, `4` `--from-lead` matched no lead (the caller is expected to
fall back to reading the page).

Two description paths exist with two different trust stories, and the difference
matters. Text arriving via `--from-lead` was already sanitised on the way into
the store, so it is copied through with a record of what the posting attempted.
Text arriving via `--description` or `--description-file` came straight off a live
page and has been looked at by nothing, so it goes through the sanitiser here
before it is written into the file a tailoring model will read. That sanitiser is
hard rule 0 in code form: **a job posting is data, never instructions.**

### Step 2 — Build the keyword plan

```bash
node scripts/documents/keyword-plan.mjs northwind-full-stack-engineer
```

**What you should see.** A summary line, then the two lists, written to
`jobs/<slug>/keywords.json`:

```
must_use=9 required_matched=6/11 blocked=4 mirror=yes file=jobs/northwind-full-stack-engineer/keywords.json
use|PostgreSQL|summary,skills|PostgreSQL / Postgres
use|React|summary,skills,experience|React
blocked|Kubernetes|required-by-posting
```

A `use` line names the term, the resume sections where it earns the most, and the
written forms an applicant tracking system might index. A `blocked` line is a
term the posting wants that your fact base cannot back — it stays **out** of the
document, and `verify-claims` rule R6 enforces that independently. Only the
blocked terms the posting marks as **required** get their own line; the rest are
in the file.

On the summary line, `required_matched=6/11` is how many of the posting's
**required** terms your facts can back — the honest fit number, and the one worth
looking at before you spend effort on a job.

`mirror=yes|no` deserves its own paragraph, because it is hard rule 0 showing up
in an unexpected place. Mirroring the posting's title into the resume summary is
a real advantage with keyword-matching software, but the title is **text the
employer writes**, and placing it verbatim puts that text into the
highest-weighted line of your document. A perfectly ordinary-looking title —
"Full Stack Developer (Kubernetes, Terraform, Elixir)" — needs no hidden text and
no trickery to smuggle three technologies your fact base cannot back into your
resume. So a title is checked before it may be mirrored, and `mirror=no` means it
failed that check. That is the system working.

> **Known defect (2026-08-05 audit).** `keyword-plan.mjs` finds the slug with
> `args.find(a => !a.startsWith("--"))` while its flag reader does not remove the
> flag's value from the list. Writing `node scripts/documents/keyword-plan.mjs
--jobs-dir jobs my-slug` therefore treats `jobs` as the slug. **Always put the
> slug first**, before any flag. The same shape affects `ats-lint.mjs` and
> `assemble-resume.mjs`.

### Step 3 — Produce the resume

There are two ways to get `jobs/<slug>/resume.md`, and they have genuinely
different properties.

**Deterministic assembly** emits each selected fact **verbatim**, byte for byte,
with its `<!-- fact:ID -->` annotation. It cannot invent anything, because it
performs no writing operation at all — the posting influences only _which_ of
your own sentences are selected, never a word of text:

```bash
node scripts/documents/assemble-resume.mjs northwind-full-stack-engineer
```

**Model tailoring** is what happens when you ask the agent to tailor a resume (the
`tailor-resume` skill). It rephrases within the fact base, which reads better and
can lie, which is why `verify-claims` runs afterwards either way. For a cover
letter this is the only path: cover letters stay model-authored deliberately, on
the evidence that tailored letters lift callbacks meaningfully over generic ones.

For a cover letter, ask for one only when the form has a cover-letter field, the
form accepts attachments beyond the resume, or the posting explicitly asks. Recipe
3 step 2 is where you find that out.

### Step 4 — Verify

```bash
node scripts/documents/verify-claims.mjs resume \
  jobs/northwind-full-stack-engineer/resume.md \
  --job jobs/northwind-full-stack-engineer/job.json
```

The seven rules, in plain terms:

| Rule | What it requires                                                         |
| ---- | ------------------------------------------------------------------------ |
| R1   | Every bullet line carries `<!-- fact:ID -->`                             |
| R2   | Every cited fact id actually exists in your profile or answers           |
| R3   | Every number in an annotated bullet appears in one of the facts it cites |
| R4   | Every number outside bullets appears somewhere in the fact base          |
| R5   | Every "Mon YYYY" date token appears in the fact base                     |
| R6   | Every known technology term in the document appears in the fact base     |
| R7   | The document has at least one annotated bullet                           |

Cover-letter mode runs R4–R6 only. Its evidence corpus gains the company and the
title (so the letter can address them) but **never** the posting body — so a
technology that appears only in the posting still fails R6.

**What you should see.** A JSON report, and exit code `0`:

```json
{
  "mode": "resume",
  "file": "jobs/northwind-full-stack-engineer/resume.md",
  "ok": true,
  "checked": ["annotatedBullets", "lines"],
  "violations": []
}
```

A failure looks the same with `"ok": false` and one entry per violation naming
the rule and the offending line. Exit code is `1`. **Do not render a PDF from a
document that has not passed.**

Verification also writes a durable row recording the exact bytes checked and the
exact fact base they were checked against, so editing either afterwards
invalidates the record rather than silently keeping it. Pass `--no-record` to
skip that (tests use it).

> **Known defect (2026-08-05 audit).** R6 is case-sensitive against a controlled
> lexicon in two ways that bite. It rejects some spellings the project's own
> tailoring guidance tells a writer to use, and it is blind to lowercase forms —
> so a lowercase invention can pass R6 that its capitalised twin would fail. If
> `verify-claims` rejects a term you know is in your profile, check the exact
> spelling in `profile/profile.yaml` before assuming the document is wrong.

### Step 5 — Lint for machine readability

```bash
node scripts/documents/ats-lint.mjs jobs/northwind-full-stack-engineer/resume.md
```

An applicant tracking system reads the **text layer** of a PDF, not the picture
of the page. Two things have already gone wrong there in this project and both
are invisible when you look at the rendered page: CSS list markers that Chrome
draws without emitting any text (so a whole role extracted as one line), and link
addresses that live only in PDF annotations (so "LinkedIn | GitHub" handed the
parser no address at all).

**What you should see.**

```
warn|"AWS" appears without its partner form; write "AWS (Amazon Web Services)" once — pair it once so a system indexing "Amazon Web Services" also matches
ok=true problems=0 warnings=2 bullets=15/15
```

`ok=true problems=0` is the pass. Warnings are advice, not failures. Exit `0`
clean, `1` problems found, `2` usage error.

> **Known defect (2026-08-05 audit).** `ats-lint.mjs` picks the file to lint with
> the same non-removing flag parser described above, so `--plan`, `--html` or
> `--pdf` placed **before** the markdown path makes that flag's value the file it
> lints. If the value happens to be a real file, you get a confident, detailed
> report about the wrong document. Put the resume path first.

### Step 6 — Check whether you should reuse an existing resume

```bash
node scripts/documents/reuse-check.mjs northwind-full-stack-engineer
```

```
orbital-platform-engineer	0.55	t=0.6	s=0.5	Orbital Systems	Software Engineer, Platform
meridian-backend-engineer	0.36	t=0.5	s=0.22	Meridian Data	Backend Engineer
# verdict=TAILOR best=orbital-platform-engineer score=0.55
```

The score is half title similarity (`t=`) and half technology-stack overlap
(`s=`), against every other workspace that already has a `resume.md`. `verdict`
is `REUSE` above the threshold (0.75 by default) and `TAILOR` below it. **It
recommends; it never reuses anything by itself**, and you always approve a reuse.

### Step 7 — The approval message

This is the human checkpoint, and hard rule 5 defines what it must contain. When
the agent is driving, you get **one** message per application containing all five
of these:

1. **The tailoring summary** — what was emphasised, what was dropped, and what
   was rephrased, each measured against your general resume. Not a description of
   the job; a description of the edit.
2. **Every unknown question the form asks**, numbered, each with the options the
   form offers.
3. **Every pick the agent made** for a field where the fact base offered a near
   match rather than an exact one — the field, the options, and the value chosen
   — so you can correct any of them. A pick you never saw is never saved.
4. **The reuse offer**, if step 6 flagged one, with its score.
5. **What the plan intends to fill and what it will leave blank.** This is a
   statement of intent and reads as one: "will attach", never "attached".
   Nothing has touched the page at this point.

Point 5 has a deliberate omission that is worth understanding. The approval
message **does not** tell you which file will land on which form field, even
though the plan names one. Which input actually receives a file is decided during
the fill from the page's own structure, and it once went the other way on
Greenhouse — the cover letter attached on top of the résumé and the cover-letter
field left empty — while the plan said what it always says. The real pairing is
reported after the fill, from what the page did. Keeping the two summaries
distinguishable is the point: one is what was asked for, the other is what
happened.

> **Known defect (2026-08-05 audit).** The `apply-job` skill instructs the agent
> to carry `tailor.summary` out of `jobs/<slug>/context.json` when a job was
> pre-tailored, but nothing ever writes that key into `context.json`. On a
> pre-tailored job the tailoring summary in the approval message will therefore
> be missing or reconstructed. If item 1 above is thin or absent, ask for it
> explicitly before approving.

### Step 8 — Render the PDF

Only after you approve, and only if the form actually needs a file:

```bash
node scripts/documents/render-pdf.mjs \
  jobs/northwind-full-stack-engineer/resume.md \
  jobs/northwind-full-stack-engineer/resume.pdf
```

Rendering shells out to a local copy of Microsoft Edge or Google Chrome running
headless (no visible window) and prints the page to PDF. Fact annotations are
stripped first. Add `--letter` for US Letter paper; `--css <file>` overrides the
stylesheet, which defaults to `templates/document.css`. `PDF_BROWSER=<path to
msedge.exe or chrome.exe>` in the environment overrides browser discovery if it
cannot find one.

**What you should see.**

```
Rendered C:\...\jobs\northwind-full-stack-engineer\resume.pdf (98431 bytes). Intermediate HTML kept at C:\...\resume.render.html
```

The script reads back the first five bytes of the output and refuses anything
that is not `%PDF`, so a browser that exited without writing a real file is
caught here rather than at the employer.

### How to tell the whole recipe worked

`jobs/<slug>/` contains `job.json`, `context.json`, `keywords.json`, `resume.md`
and `resume.pdf`; `verify-claims` exited `0`; and you have seen and approved a
message covering all five points above.

### When it does not work

| Symptom                                    | Cause                                                | What to do                                                                                               |
| ------------------------------------------ | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `verify-claims` fails R2 (unknown fact id) | The document cites a fact that is not in the profile | Fix the document. Do not add the fact to the profile to make the check pass — that inverts the guardrail |
| `verify-claims` fails R6 on a real skill   | Spelling mismatch against the lexicon                | Check `profile/profile.yaml`'s exact spelling; see the R6 defect note above                              |
| `render-pdf` says "PDF was not produced"   | No Edge or Chrome found, or it crashed               | Set `PDF_BROWSER` to the full path of `msedge.exe` or `chrome.exe`                                       |
| `Output exists but is not a valid PDF`     | The browser wrote something else                     | Same fix; check the intermediate `.render.html` opens correctly in a browser                             |
| `new-job.mjs` exits 1                      | The workspace exists already                         | Use a different slug, or work in the existing folder                                                     |

Housekeeping: `node scripts/maintenance/prune-jobs.mjs --apply` deletes the
`*.render.html` intermediates, which are waste at every moment after the render.

---

## Recipe 3 — Apply to a job in the browser, end to end

### When to use it

When you have a posting URL and want the application sent. This is the
**user-directed** path: you hand over a URL, and the agent applies. It is
governed by hard rule 6, which the owner of this repository has now stated twice
in their own words: _"if I give you a URL to apply to, you should apply no matter
what"_.

### Why it works this way

Two design rules explain every step:

- **Batch by phase, not by field.** Scan the whole page in one call, resolve
  every answer in one call, decide in one pass, fill in one call, verify once.
  Never inspect-then-fill field by field. That is what makes an application take
  seconds rather than minutes.
- **Spend human attention once.** You are asked exactly once per application, in
  one approval message. Everything that can be learned before that message —
  including what the form actually asks — is learned first so it can ride along
  in it.

The **filling is done by scripts, not by an AI model**. A model reads the page's
structure once, and a deterministic planner resolves every field against your
approved facts. A field the fact base cannot answer is **deferred**, never
guessed. That is not a performance choice; it is the whole safety design, because
the alternative puts attacker-controlled page text and your fact base in one
context window.

### Step 0 — Preconditions

- The Playwright browser tools must be available to the agent. Playwright is a
  library that drives a real browser under program control.
- `profile/profile.yaml` must have `meta.approved_by_user: true`.
- Check for a duplicate first:

```bash
node scripts/applications/check-applied.mjs "Northwind Logistics"
```

```json
{
  "query": "Northwind Logistics",
  "checked": 26,
  "job_already_applied": false,
  "matches": []
}
```

`job_already_applied` is the field to read. If it is `true`, the agent reports it
and gets your go-ahead before continuing.

### Step 1 — Workspace and posting

As recipe 2 step 1. If `--from-lead` prints `description=<n>`, **the live page is
never read for the description at all** — the sweep already captured it.

### Step 2 — Open the form and read it, before tailoring anything

This is the ordering that saves the most time. The form decides whether a cover
letter is needed, whether PDFs are needed at all, and what unknown questions
exist — and all three belong in the single approval message.

The agent navigates to the URL and runs a page scanner. The scanner is installed
once per browser session and stamps every element it finds with an attribute
`data-aj="f7"`, so every field has a stable address for the rest of the session.
It returns the page's inventory: fields with labels and required flags, **all
dropdown options including custom ones it opens for you**, classified buttons,
and signals.

The scan reports a `kind` for the whole page, and that is acted on before
anything else:

| `kind`    | Meaning                        | What happens                                                              |
| --------- | ------------------------------ | ------------------------------------------------------------------------- |
| `ad`      | The posting page, not the form | Click the "Apply" button, re-scan                                         |
| `form`    | The application form           | Continue                                                                  |
| `login`   | A login wall                   | Stop and ask you to log in in the browser window, then re-scan            |
| `confirm` | Already submitted              | Skip to the record-keeping step                                           |
| `unknown` | Nothing recognisable           | Read the heading and buttons; ask you if there is genuinely nothing to do |

Two signals override everything: a CAPTCHA signal means hand off to you (the
agent never solves one), and an iframe signal means navigate to the embedded URL
directly, because Greenhouse, Lever and Ashby embeds cannot be scanned or filled
through the parent page.

**Which system is this?** Detection happens inside the planner. Greenhouse, Lever
and Ashby have adapters and take the fully deterministic path. **Workday** is
detected and deliberately refused with a hand-off message — applying there
requires creating an account, which the agent is not permitted to do. Anything
else is treated as `generic`: the same mechanism and the same scripts, with more
fields deferred to you.

### Step 3 — Build the fill plan

```bash
node scripts/apply/fill-plan.mjs northwind-full-stack-engineer
```

This reads the saved scan, resolves every field against `profile/profile.yaml`
and `profile/answers.yaml` only, and writes two files:
`jobs/<slug>/fill-plan.json` (the plan, for you and for tests) and
`jobs/<slug>/fill-plan.js` (a self-contained bootstrap that carries both the plan
and the fill engine's source, to be loaded into the browser in one call).

**What you should see.** A summary line, then one record per deferred field:

```
ats=greenhouse ready=false reason="1 unknown field" submitReady=false items=17 defer=4 skip=0 checked=0 cache=6/6 miss=0 fp=a91c3e disclose=6/20
defer	f12	consent	I agree to Northwind's candidate privacy notice
defer	f18	confirm-widget	Are you legally authorized to work in the United States?
defer	f22	unknown	How did you hear about this role?
defer	f25	needs-choice	Highest level of education completed
plan=jobs/northwind-full-stack-engineer/fill-plan.js
```

Read that summary line field by field, because every part of it means something
specific:

| Field          | Meaning                                                                                                                                                                                                                                                                                                              |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ats=`         | Which adapter was selected                                                                                                                                                                                                                                                                                           |
| `ready=`       | Whether **a model still has to think** before the engine can run. `false` means at least one field needs a decision                                                                                                                                                                                                  |
| `reason=`      | Why `ready` is false                                                                                                                                                                                                                                                                                                 |
| `submitReady=` | The stricter twin, and it answers a question about the **unattended runner**, not about this path. It is `false` for every actuated widget by design. Do **not** read `submitReady=false` as "do not submit" here                                                                                                    |
| `items=`       | Fields that will be filled with no model involvement                                                                                                                                                                                                                                                                 |
| `defer=`       | Fields a human must handle                                                                                                                                                                                                                                                                                           |
| `cache=`       | Dropdown shapes served from the remembered form shape, out of the total. `6/6` means the whole form was already known and no dropdown had to be opened                                                                                                                                                               |
| `disclose=`    | How many **distinct banked answers** this one form pulls, against a budget. The budget is `max(20, a quarter of your bank)`. A form that exceeds it defers the **whole application**, because pulling far more of your fact base than a normal form does is itself the signal. Two real scanned forms pulled 6 and 9 |

The five defer reasons:

- **`consent`** — an agreement. Always yours to accept. Nothing ticks it for you
  unattended; on this path the agent may tick it and **must name it in the final
  report with the label quoted**.
- **`confirm-widget`** — a checkbox or radio group. This defers on the _shape_ of
  the control, not on whether the fact base has an answer: it defers even when the
  answer resolved fine. A tick carries **assent on a control the employer owns**,
  not a value. Re-running the planner can never clear one.
- **`confirm`** — an assertion the fact base would have filled, but which you
  _assert_ rather than _state_: work authorisation, arbitration, background
  check, relocation.
- **`unknown`** — nothing understood the field. This is the one that blocks on
  every path, including the user-directed one, because filling it would require a
  guess.
- **`needs-choice`** / **`maybe`** — the fact base has something related and the
  agent picks from the offered options; the pick goes in the approval message.

A required `confirm-widget` makes `ready=false`. A **non-required** one does not,
and neither does a consent box on its own — you are looking at the form anyway.

If PDFs are not rendered yet, the attachment rows defer with `no rendered
resume`. That is expected before approval; re-run after rendering.

### Step 4 — Batch the questions across every prepped job

```bash
node scripts/apply/pending-questions.mjs
```

`profile/answers.yaml` is **global**: answering "Do you require sponsorship?"
once resolves it for every application you will ever make. This command merges
the deferred questions of every prepped workspace, drops consent boxes (those
stay in the browser), drops anything the fact base can already answer, and
**predicts** what other jobs' boards will ask from the remembered form shapes.

```
q	plan+predicted	northwind-full-stack-engineer,orbital-platform-engineer	unknown	How did you hear about this role?
opts	LinkedIn | Job board | Referral | Company website | Other
q	plan	northwind-full-stack-engineer	needs-choice	Highest level of education completed
opts	High School | Associate's | Bachelor's | Master's | Doctorate
```

The `plan+predicted` marker means the question is certain for the first slug and
likely for the others. Folding this list into the one approval message is what
makes the defer list shrink over time.

### Step 5 — The one approval message

As recipe 2 step 7. Then save both your answers and the picks you approved
(recipe 4 covers `save-answer.mjs` in full), then render the PDFs, then re-run
`fill-plan.mjs` — but **only** because you rendered files or saved answers, which
are the two inputs a re-run can pick up. With all inputs unchanged you get
byte-identical output and waste a turn.

### Step 6 — Fill and verify, in one call

The agent loads `jobs/<slug>/fill-plan.js` into the page in a single call. That
file carries the engine source and the plan together, and it is loaded whole from
disk rather than injected as a `<script>` tag — a nonce-based content security
policy (Ashby uses one) refuses an injected script outright, while driving the
page over the browser's debugging protocol is not gated by the page's policy at
all. Do not "fix" that back.

The engine does uploads first (they remount the form and invalidate every stamped
attribute), then fills, retrying once on a stale-element error because a React
remount can land between locating a field and touching it, then verifies. It
returns only what is not right:

```json
{
  "ok": 24,
  "failed": 0,
  "deferred": 12,
  "ms": 5100,
  "failures": [],
  "uploads": [
    {
      "k": "f9",
      "tag": "u1",
      "file": "resume.pdf",
      "match": "resume",
      "how": "label",
      "target": "resume",
      "attached": true,
      "seen": "gone"
    }
  ],
  "verify": {
    "mismatch": [],
    "errors": [],
    "requiredEmpty": [],
    "landed": [],
    "revealed": []
  },
  "revealed": [],
  "reconciled": [],
  "defer": [],
  "next": { "btn": "b34", "label": "Submit application", "role": "submit" }
}
```

**`uploads` is the only part of that report that says anything about a file.**
`ok` is a count, and a count cannot tell a correct run from the cover letter
attached on top of the résumé — on a test fixture that exact misroute returned
`ok=6 failed=0 failures=[]`. Read `uploads`; never describe attachments from the
plan.

Reading an `uploads` entry:

| Field              | What it tells you                                                                                                                                             |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `how: "label"`     | The input was identified by the text around it. Nothing extra to say                                                                                          |
| `how: "order"`     | Placed **by position**, because nothing told the file inputs apart. Right until a board reorders its inputs — worth saying out loud                           |
| `attached: false`  | It did not attach. The matching `failures` entry says why. Report it as a blank                                                                               |
| `seen: "gone"`     | The input was replaced by the page's attached-file view. **Normal — Greenhouse does this on every successful upload.** Not a warning                          |
| `seen: "empty"`    | The input is still there with nothing on it. Treat as not attached                                                                                            |
| `seen: "attached"` | The page still holds the file, and `seenFile` is the name **the page** reports. If it differs from `file`, that is the wrong file on a real submission — stop |

Three further keys carry information the fill itself could not know:
**`revealed`** is required controls the fill _created_ ("if yes, explain") that
were in no scan and no plan — treat each as a new deferral; **`reconciled`** is
items that threw on a detached element and whose value the verify pass then found
on the page anyway (already counted in `ok`, listed so the promotion is never
silent); **`verify.landed`** is the keys whose value is genuinely on the page.

> **Known defect (2026-08-05 audit).** An upload that demonstrably did not attach
> is counted as `ok`. `fill-engine.mjs` marks `attached = true` and increments
> `ok` when the browser call merely does not throw; the independent DOM check
> immediately afterwards records `seen: "empty"` when the input is still present
> holding zero files, and **nothing promotes that to a failure and no gate reads
> it**. An application can go out with no resume attached while the report says
> `ok`. **Read `uploads[].seen` yourself on every application.** `"empty"` means
> not attached.

> **Known defect (2026-08-05 audit).** `failed`, `failures`, `verify.mismatch`
> and `verify.requiredEmpty` are computed at real cost but reach no gate: the
> readiness check reads only `report.revealed`, and on multi-page forms the
> page-merging step rebuilds the report as `{ uploads, revealed }` and discards
> the rest before anything can see it. A page where three required dropdowns
> failed merges into a report with no evidence of it. On a multi-page
> application, read each page's report as it comes back rather than the merged
> one.

### Step 7 — Advance, or submit

- If a `next` button exists, click it and go back to the scan step. New unknowns
  on a later page get their own batched question round.
- If only a `submit` button is left: **write the summary first, then click it.**
  You gave the URL; the application gets sent.

**What stops the click, and each of these means a field would be a guess:** any
`UNKNOWN` field, an unprobed dropdown, a failed fill, a `verify.mismatch`, an
unapproved document. The agent says which one and stops. That is a stated
deferral, not a hand-off.

**The final summary is the guardrail, not a status line.** Every line in it must
come from what the fill _observed_, not from what the plan intended. It must name
**every control actuated on your behalf** — each consent tickbox, each
`confirm-widget`, each `confirm` defer answered from the fact base — **with its
label quoted**. You are delegating assent, not waiving the record of it.

One line per attachment, filename and target field on the same line, so a swapped
pair is visible at a glance:

```
resume.pdf → resume (label match)
cover-letter.pdf → cover_letter (label match)
```

> **Known defect (2026-08-05 audit).** The `next` button in the report comes from
> the page's own global scanner — page-controlled text — and the agent clicks it.
> The engine deliberately has no click verb of its own (a plan can never click
> anything, so an injected plan cannot submit an application), but the _choice_ of
> control to advance to is influenced by the page. Sanity-check the `next` label
> in the report before an advance on an unfamiliar board.

> **Known defect (2026-08-05 audit).** Two answer-bank rules are wrong in ways
> that put a false statement on a form. A field labelled "Position Applied For"
> is filled with your **current** job title rather than the role being applied
> for. And the prior-employment question ("Have you previously worked for
> us?") can answer "No" when the question names the company by pronoun, which the
> matcher does not resolve. Check both in the fill plan's `items` count region if
> a form asks either.

### Step 8 — Record it

```bash
node scripts/applications/log-application.mjs northwind-full-stack-engineer \
  --company "Northwind Logistics" --title "Full Stack Engineer" \
  --url "https://job-boards.greenhouse.io/northwind/jobs/8098945"
```

Recipe 5 covers this in full.

### When it does not work

| Symptom                                                  | What it means                                           | What to do                                                                             |
| -------------------------------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `fill-plan.mjs` exits 3                                  | Workday                                                 | It needs an account. Open it yourself; your answers are in `profile/answers.yaml`      |
| `cache=0/8` on a board you have used before              | The form changed shape, or the cache version was bumped | Re-scan with dropdown probing on; the cache re-learns in one pass                      |
| `defer` line with `unknown` you cannot answer truthfully | Rule 1                                                  | Say so and stop. A wrong application is the failure being prevented, not a missing one |
| CAPTCHA signal                                           | A bot wall                                              | You solve it. The agent never does                                                     |
| `login` kind                                             | Session expired                                         | Log in in the browser window, then re-scan                                             |
| Fill returns `failed > 0` twice                          | Something structural                                    | Two automatic retries, then it comes to you                                            |

Full mechanical detail on the fill engine — every control type, the upload
routing rules, the stale-locator retry, the readback — is in
[../code/08-apply-filling.md](../code/08-apply-filling.md). The scanner and the
plan are in [../code/06-apply-scanning.md](../code/06-apply-scanning.md) and
[../code/07-apply-planning.md](../code/07-apply-planning.md).

---

## Recipe 4 — Answer a deferred question and bank it forever

### When to use it

Whenever recipe 3 shows a `defer` line with reason `unknown`, `needs-choice` or
`maybe`, or whenever `pending-questions.mjs` lists something. This is the only
thing in the whole pipeline that **compounds**: every banked answer permanently
shrinks the defer list on every future application.

### Why it works this way

`profile/answers.yaml` is your fact base's question-and-answer half. Four
properties of it explain every guard below:

- It is **permanent** — nothing expires an entry.
- It is **global** — every future application reads it, not only this employer's.
- It is part of the **`verify-claims` evidence corpus**, which decides whether a
  claim may appear on your resume.
- It is the **supply of everything this pipeline types into other people's
  forms**.

A hostile form label is therefore worth more to an attacker than a hostile job
description: the description influences one tailoring run, an entry in
`answers.yaml` influences all of them. And because a form's field meaning is
decided on the employer's server, a control labelled "Phone number" can post to a
column called `ssn` and no scanner can tell. The blast radius of that class of
attack is exactly the contents of this file.

Hence: **`save-answer.mjs` is the only way anything enters the fact base**, and
the agent never edits `profile/` directly — a hook blocks it.

### Step 1 — Save the answer

```bash
node scripts/profile/save-answer.mjs \
  "How did you hear about this role?" "Company website" --user-approved
```

**What you should see.**

```
Saved a-050 (source: user, class: datum): "How did you hear about this role?" -> profile/answers.yaml (default)
```

That one line carries four things you should check every time: the new id, the
provenance, the class, and **the target path**. The path is printed on every
success, not only when you passed one, because the incident that motivated this
was a dropped flag: the run reported success and the operator had no way to see
it had written the real fact base instead of a temporary file.

### The flags, one at a time

| Flag                           | What it does                                                                                                                                                                              |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--user-approved`              | **Required by the shell guard** when writing the real fact base. It asserts that you approved this answer in chat. It changes nothing about what is written; it makes the intent explicit |
| `--file <path>`                | Writes to a different file. **Required by the shell guard** when the write is a test, so it cannot touch `profile/`                                                                       |
| `--rescan`                     | Read-only audit of what is already stored. Needs neither of the above, because it cannot write                                                                                            |
| `--id a-050`                   | Force a specific id instead of the next free one                                                                                                                                          |
| `--source user\|model`         | Provenance. `user` (the default) means you said it in chat. `model` means the agent picked an option off a form and **you approved that pick in the approval message**                    |
| `--class datum\|assertion`     | Override the automatic classification (see below)                                                                                                                                         |
| `--replace`                    | Overwrite an existing entry for the same question — **only** when that entry is `source: model`. A user-stated answer is never overwritten by this script                                 |
| `--set-class datum\|assertion` | Reclassify an existing entry without changing its answer                                                                                                                                  |

### The shell guard, and why it exists

A hook at `.claude/hooks/guard-profile-shell.mjs` inspects every shell command
before it runs. If the command executes `save-answer.mjs` (or
`apply-profile.mjs`) and carries **none** of `--file`, `--user-approved` or
`--rescan`, it is denied with this message:

```
This writes the REAL fact base, and says neither that it is a test nor that the user approved it.
  - testing?       add `--file <temp path>` so it cannot touch profile/
  - user said yes? add `--user-approved`, only after they approved it in chat
```

The threat model is **accident, not a determined agent**. Two real incidents on
2026-07-31 were the same typo: an agent verifying the script passed `--answers
<tempfile>`, the script silently ignored the unknown flag, the path fell through
to the default, and test values landed in the real `answers.yaml` stamped
`source: user`. One of them was a fabricated phone number saved under the label
"Phone number" — which resolves on nearly every application form and would have
been typed into a real application as fact. The script now exits `2` on any
unrecognised flag, which closes that typo; the hook closes the whole class.

Reads stay allowed. Agents read the fact base constantly, and only write
_operations_ are matched, never the mere mention of a path.

### `datum` versus `assertion`

Every answer is classified automatically, and the class governs what may be done
with it unattended.

- A **datum** is a fact about you: an email address, a city, a skill, a salary
  figure. Typing it into a form commits you to nothing.
- An **assertion** is something you _assert_ or _agree to_: authorisation to
  work, willingness to relocate, consent to a background check, an electronic
  signature. It must never be acted on unattended, whatever widget an employer
  renders it as.

The class lives with the **answer**, not with the control, and that is
deliberate: an employer authors the page and can defeat any test of the page, but
cannot change what kind of thing you recorded.

When an assertion is saved you get a note on the error channel saying so,
because it changes what happens on every future application — that answer will be
presented to you, not auto-acted.

### The exit codes

| Code | Meaning                                                                                                  | What to do                                                                                                                                  |
| ---- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | Saved                                                                                                    | Nothing                                                                                                                                     |
| `1`  | Conflict — the question is already answered                                                              | The message names the existing id and answer. Use `--replace` if it is a model-derived pick; edit the file yourself if it is one you stated |
| `2`  | Usage error, including any unrecognised flag                                                             | Fix the command                                                                                                                             |
| `3`  | **Instruction-shaped text** — the question or the answer contains something written to steer an AI agent | Do not work around it. Quote the field and decide what to record                                                                            |
| `4`  | **A government or financial identifier** — an SSN, a bank account, a passport number, a card number      | **No override exists, by design.** Type it yourself, in the browser, on the page you are looking at                                         |
| `5`  | Another writer held the lock; nothing was written                                                        | Retryable. Run it again                                                                                                                     |

Exit 3's message explains itself:

> Refusing to save: this text is instruction-shaped. A form label is written by
> the employer and answers.yaml is permanent, global, and part of the
> verify-claims evidence corpus — so it is not somewhere to file a neutralised
> attack.

Exit 4 has no override and no flag. The reasoning, from the script itself: this
is your own data on your own machine, so the refusal is not about trusting you.
It is about where the value would end up. `answers.yaml` is read by a script that
types it into third-party forms, a form can label a field one thing while the
value lands somewhere else server-side, and nothing on this side can see that. So
the pipeline must never be in a position to type a government or financial
identifier into someone else's form — which means never holding one.

### Saving a pick the agent made

```bash
node scripts/profile/save-answer.mjs \
  "Highest level of education completed" "Bachelor's" --source model --user-approved
```

Use the form's **exact** field label as the question and the **exact** option
text as the answer. The answer bank matches saved questions exactly, ahead of its
label rules, so that field comes back resolved on every future application to
that system. `--source model` marks it derived-and-approved rather than
user-stated, which is what makes a wrong one findable and reversible later.

**Never save a pick you did not see in an approval message.** Saving what you
approved is not a new trust assumption; saving a silent guess is.

> **Known defect (2026-08-05 audit).** The `apply-job` skill shows two
> `save-answer.mjs` calls chained with `&&`. If the first one hits an existing
> question it exits `1`, and `&&` then **silently skips the second** — so a pick
> you approved is never saved and you are asked again next time. Run them as
> separate commands, or check each result.

### Auditing what is already banked

```bash
node scripts/profile/save-answer.mjs --rescan
```

Everything above is a **write-time** control, and the bank predates all of them.
`--rescan` is the read-time counterpart: it re-runs every check on this boundary
against what is already stored and prints a report. **It never writes.** There is
no `--fix` and no `--apply`, because an auditor that repairs the fact base is a
writer wearing a different hat.

```
Rescan of profile/answers.yaml — 49 entries, nothing written.

REVIEW (2) — normal in a healthy bank; these are for you to read, not faults:
  a-014   high_reach: this answer is read on every application
          -> node scripts/profile/save-answer.mjs "..." --set-class assertion

0 error, 2 review. This tool NEVER edits profile/answers.yaml — corrections are yours to make.
```

Exit `0` clean, `1` findings. Every finding prints the command **a human** would
run. When run in a real terminal it may show the stored value; when piped or read
by an agent it never does — the first version of this printed a home address into
an agent transcript, where nobody needed it and nothing forgets.

---

## Recipe 5 — Record an application, and later record the outcome

### When to use it

Immediately after you submit an application, and again whenever you hear
anything back.

### Why it works this way — provenance

> An application is recorded **only when you say you submitted it**. An outcome
> is recorded **only when you report it**. Removing a record corrects a mistake;
> it never rewrites history.

"Provenance" means "where did this fact come from". The rule is not about which
file the data sits in — the storage moved from a text file to a database on
2026-07-29 and the rule did not change. It is about who is allowed to be the
source.

If an application record could appear as a side effect of something else —
rendering a PDF, filling a form, clicking a button — then every downstream
calculation would be reasoning about applications that may never have been sent.
The duplicate guard would refuse a job you never applied to. The follow-up clock
would tell you to nudge a recruiter who received nothing. The gap analysis would
double-weight a "rejection" that never happened.

So there is exactly one way in, one way to change an outcome, and one way to
delete.

**Where it lives.** The `applications` table in `jobs/leads.db` is the record.
`profile/applications.yaml` is a **generated export**, rewritten from the table
after every change, carrying a header that says so. It exists because `jobs/` is
excluded from version control and a plain-text copy is cheap disaster recovery.

### Step 1 — Record the submission

```bash
node scripts/applications/log-application.mjs northwind-full-stack-engineer \
  --company "Northwind Logistics" \
  --title "Full Stack Engineer" \
  --url "https://job-boards.greenhouse.io/northwind/jobs/8098945"
```

`--date YYYY-MM-DD` overrides today's date; `--notes "..."` attaches a note.
`--file <yaml>` forces the legacy YAML-only path and is what tests use — do not
pass it in normal operation.

**What you should see.** A confirmation naming the slug and the date. Verify with:

```bash
node scripts/applications/applications.mjs stats
```

```
total=26 companies=15 first=2026-07-27 latest=2026-08-07 applied=26
```

`total` should have gone up by one, and `latest` should be today.

### Step 2 — Later, record what happened

```bash
node scripts/applications/update-application.mjs northwind-full-stack-engineer --status interviewing
```

The key can be a slug **or** a company name. The six statuses are `applied`,
`followed_up`, `interviewing`, `offer`, `rejected`, `withdrawn`. This command
**never creates** an entry and **never deletes** one.

To record that you sent a nudge:

```bash
node scripts/applications/update-application.mjs northwind-full-stack-engineer --followed-up
```

Add `--date YYYY-MM-DD` if it was not today. Flags combine.

### Step 3 — Read the record back

```bash
node scripts/applications/applications.mjs list --status interviewing
node scripts/applications/applications.mjs find "Northwind"
node scripts/applications/applications.mjs export
```

`export` regenerates `profile/applications.yaml` from the table. You will rarely
need it — every write regenerates it — but it is there if the export ever drifts.

### Correcting a mistake

```bash
node scripts/applications/applications.mjs remove northwind-full-stack-engineer --confirm
```

The `--confirm` flag is required on the same command line, not as a second
prompt. In the words of the comment in the script: deleting an application
destroys a record of something you actually did, so it takes an explicit flag
rather than a bare command.

### How to tell it worked

`node scripts/status.mjs` shows the new totals, and the by-status breakdown
matches what you expect:

```
applications total=27 applied=26 interviewing=1 awaiting=26
```

### When it does not work

| Symptom                                    | Cause                                                                | Fix                                                                                  |
| ------------------------------------------ | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `no logged application matches "X"`        | Wrong slug or company spelling                                       | `node scripts/applications/applications.mjs find "X"` to see what is actually stored |
| An outcome does not appear in `status.mjs` | Statuses that show a response are excluded from "awaiting" by design | That is correct behaviour, not a bug                                                 |
| A duplicate record                         | Logged twice                                                         | `remove <slug> --confirm`, then log once                                             |

> **Known defect (2026-08-05 audit).** A race-safe merge function for the
> applications table exists in `scripts/lib/db.mjs` and **nothing calls it**.
> Two processes writing an application at the same instant can therefore lose
> one. In practice you log applications one at a time by hand, so this is
> unlikely to bite — but do not script a bulk import that writes concurrently.

> **Known defect (2026-08-05 audit).** Two skill documents describe
> `profile/applications.yaml` as the fact base and invite hand-editing it. It is
> a **generated export**; a hand edit is overwritten by the next write. Edit
> through `update-application.mjs`, or edit the database.

---

## Recipe 6 — See what needs following up, and send a nudge

### When to use it

Weekly, or whenever `status.mjs` shows a non-zero `followups due` count.

### Why it works this way

The policy is deliberately restrained: a follow-up becomes due **10 days** after
the application (or after the previous follow-up), there are **at most two** per
application, and after that the lead is considered cold and stops appearing. Two
unanswered nudges means move on. Applications whose status shows a response —
`interviewing`, `offer`, `rejected`, `withdrawn` — never appear at all.

The script **never writes anything.** Recording a sent follow-up goes through
`update-application.mjs`, and only after you say you sent it. And **the agent
never sends the message** — it drafts, you send.

### Step 1 — See what is due

```bash
node scripts/applications/follow-ups.mjs
```

```
meridian-backend-engineer|Meridian Data|Backend Engineer|days=11|sent=0
northwind-full-stack-engineer|Northwind Logistics|Full Stack Engineer|days=10|sent=0
orbital-platform-engineer|Orbital Systems|Software Engineer, Platform|days=10|sent=1
due=3 threshold=10
```

`days=` is days since the last touch — the application date, or the last
follow-up if there was one. `sent=` is how many nudges have already gone out;
when it reaches 2 the row disappears for good.

`--days N` changes the cadence for this run. `--json` gives the structured form.

### Step 2 — Draft the note

Ask the agent for a draft, or write one yourself. The shape that works:

1. Read `jobs/<slug>/context.json` and `job.json` for specifics — the exact role
   title, and one thing the tailored resume emphasised.
2. Four to six sentences. No grovelling, no "just checking in" filler.
3. Restate interest in the **specific** role; add **one** concrete hook that is
   verifiable from your profile and relevant to the posting; soft close.
4. Facts only. The same truthfulness rule that governs resumes governs this.

### Step 3 — Send it yourself, then record it

You send the message, by email or on LinkedIn. Then:

```bash
node scripts/applications/update-application.mjs northwind-full-stack-engineer --followed-up
```

### Step 4 — Record any response when it comes

```bash
node scripts/applications/update-application.mjs "Northwind" --status rejected
```

A rejection is not wasted data. `profile-gaps.mjs` weights the requirements of
rejected jobs **double**, so recording rejections is what makes the gap analysis
honest:

```bash
node scripts/profile/profile-gaps.mjs
```

### How to tell it worked

Re-run `follow-ups.mjs`. The row you nudged should be gone (its clock reset by 10
days) and `sent=` should have incremented on the next appearance.

### When it does not work

| Symptom                                      | Cause                                                                               | Fix                                                                             |
| -------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `due=0` and you expected rows                | The 10-day threshold has not passed, or every open application already has 2 nudges | `--days 7` to check; the two-nudge cap is intentional                           |
| A row you already nudged still shows         | You did not record it                                                               | `update-application.mjs <slug> --followed-up`                                   |
| A row with an unparseable date never appears | The date could not be read                                                          | Unparseable anchors are skipped rather than guessed. Fix the `applied_at` value |

---

## Recipe 7 — Add a new company's job board

### When to use it

When you want a specific employer's openings swept every day.

### Why it works this way

`docs/job-sources.yaml` is the sweep list. Three rules govern changes to it:

- **Never hand-edit it.** `manage-sources.mjs` edits it line by line (entries are
  single-line flow maps) so the file's comments survive every change, and it
  **prescreens** every addition with a live API call so the daily sweep only ever
  hits boards that are known to work.
- **A board must earn its slot.** Every board costs sweep time forever, and its
  postings bury the reachable leads in noise. On one measured day, 41 tracked
  boards carried 8,576 live postings and yielded 18 reachable ones — and 28 of
  those boards yielded zero.
- **Adding is your call.** Nothing in this pipeline adds a board on its own.

### Step 1 — Find the board's slug

A **slug** here is the short name a company has inside an applicant tracking
system: in `https://boards.greenhouse.io/northwind/jobs/8098945`, `northwind` is
the slug. The six big systems all publish a no-authentication endpoint keyed on
that slug, and the slug is usually a predictable squashing of the company name.
So: generate candidate slugs, ask each system, keep what answers.

```bash
node scripts/leads/find-boards.mjs --names "Vercel,Figma,Notion" --append
```

```
found|greenhouse|vercel|Vercel|live=41
found|ashby|notion|Notion|live=63
probed=3 found=2 already_tracked=0 no_public_board=1 ms=4200 out=docs/board-candidates.yaml
```

**What this does not do, measured rather than assumed.** Probing 16 companies
found Vercel, Figma and Notion in 4.2 seconds and found **nothing** for Konami
Gaming, Everi, Zappos, Switch, Scientific Games, PlayAGS, Sightline Payments,
Southwest Gas or NV Energy. Those are Las Vegas employers on Workday, iCIMS,
Taleo and Phenom, whose board addresses contain an opaque tenant host that cannot
be guessed from a name. **Slug probing reaches startups and tech companies; the
local market needs per-company research or an aggregator.** "No public board
found" does not mean "not hiring".

> **Known defect (2026-08-05 audit).** A run **without** `--append` overwrites
> the whole candidates file. The merge with existing candidates is gated on
> `--append`, but the file write is not: a single `find-boards.mjs --names
"Acme"` that resolves one board replaces every existing candidate with that
> one, silently and with no backup. **Always pass `--append`.**

### Step 2 — Yield-gate the candidates

```bash
node scripts/leads/discover-boards.mjs --candidates docs/board-candidates.yaml
```

This fetches each candidate and applies the same yield bar the audit applies to
existing boards: does it produce a role this profile could actually take? It
**reports only** — it never edits the sweep list — and it prints the exact
`manage-sources.mjs add` command for each survivor.

`--min-solid 1` sets the bar (default is one qualifying posting). `--query` and
`--concurrency` work as elsewhere.

### Step 3 — Add the survivors

```bash
node scripts/leads/manage-sources.mjs add --type greenhouse --slug vercel --company "Vercel"
```

```
Added Vercel (greenhouse:vercel) — prescreen OK, 41 posting(s) visible right now.
```

The prescreen is a real live fetch. If the board does not answer with a job list,
the add is refused and nothing is written.

Host-based systems need more than a slug:

```bash
# Workday: host + tenant + site
node scripts/leads/manage-sources.mjs add --type workday --company "Acme Corp" \
  --host acme.wd5.myworkdayjobs.com --tenant acme --site Careers

# Oracle Recruiting Cloud: host + site
node scripts/leads/manage-sources.mjs add --type oracle_cloud --company "Acme Resorts" \
  --host edmn.fa.us2.oraclecloud.com --site CX_1

# SuccessFactors: host only (the career-site hostname)
node scripts/leads/manage-sources.mjs add --type successfactors --company "Acme Gaming" \
  --host jobs.acmegaming.com
```

### Step 4 — Confirm and sweep

```bash
node scripts/leads/manage-sources.mjs list
node scripts/leads/manage-sources.mjs verify
```

`list` prints every tracked board:

```
Anthropic  (greenhouse:anthropic)
Cloudflare  (greenhouse:cloudflare)
Vercel  (greenhouse:vercel)
```

`verify` live-checks each one and exits `1` if any is broken:

```
BROKEN  Acme Corp (workday:acme.wd5.myworkdayjobs.com) — HTTP 404

39 ok, 1 broken.
```

Then run recipe 1 and watch for leads from the new company.

### Removing a board

```bash
node scripts/leads/manage-sources.mjs remove "Vercel"
```

Matches on company name or slug. Removing a board does **not** remove the leads
it already produced — enrichment derives its addresses from the stored lead's own
URL, deliberately, so a board leaving the sweep list never orphans its leads.

### When it does not work

| Symptom                                            | Cause                                                    | Fix                                               |
| -------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------- |
| `unknown type "X"`                                 | Typo in `--type`                                         | The message lists the known types                 |
| `prescreen failed: no job list returned`           | The slug is wrong, or that company is not on that system | Re-run `find-boards.mjs` for that name            |
| `duplicate: "X" is already tracked`                | Already in the list                                      | `list` to confirm                                 |
| `workday boards need --host, --tenant, and --site` | Host-based type with a slug only                         | Take the three values out of the careers-page URL |

> **Known defect (2026-08-05 audit).** The duplicate check identifies a board by
> slug, falling back to tenant, then site. A SuccessFactors entry has **none** of
> the three (it is identified by host), so its identity is the empty string and
> **every second SuccessFactors employer is refused as a duplicate**. The same
> shape hits Oracle Recruiting Cloud, whose identity is the site name: one board
> is tracked with site `CX_1`, which is Oracle's stock default, so any other
> Oracle employer using the default site is also refused. If an add is refused as
> a duplicate and you know it is not one, this is why. Host-based boards should
> be identified by host **and** site.

> **Known defect (2026-08-05 audit).** `discover-boards.mjs` prints an
> `add` command that `manage-sources.mjs` rejects for host-based board types,
> because the printed form uses `--slug`. Translate it to `--host`/`--site` by
> hand for Workday, Oracle Recruiting Cloud and SuccessFactors candidates.

---

## Recipe 8 — Change what counts as an in-scope job title, then re-audit

### When to use it

When the search is missing a title family you would take, or storing titles you
would not. Also whenever you retarget: this pipeline is deliberately not
software-only, and role specificity lives in configuration you own, never in the
scripts.

### Why it works this way

`docs/application-limits.yaml` is **yours**. The pipeline reads it and asks
before changing it. `roles.title_keywords` is the authoritative list of in-scope
titles, and it is wider than any summary of it anywhere in the documentation.

The important asymmetry: **a job you never see is the worst failure in this
system.** Widening a filter is cheap and visible — you get more leads. Narrowing
one is invisible: the leads stop arriving and nothing tells you. So every
gate change is followed by an audit that re-runs every stage over the whole stored
lead set and reports what changed, with newly _rejected_ leads listed in full
every time and newly _accepted_ ones summarised in one line.

### Step 1 — Take the baseline

```bash
node scripts/leads/gate-audit.mjs --save
```

This records the current verdict for every stored lead into
`jobs/.gate-baseline.json`. Do this **before** you edit, so there is something to
diff against.

### Step 2 — Edit the file

Open `docs/application-limits.yaml` and edit `roles.title_keywords`. It is a
plain list of lowercase phrases; a title must **contain** one of them to be
stored. The existing file carries the reasoning for each addition in comments,
and keeping that habit is worth the thirty seconds:

```yaml
roles:
  title_keywords:
    - full-stack
    - full stack
    - fullstack
    - back-end
    - backend
    - software engineer
    - web developer
    # Added 2026-08-07: platform engineering is the same work under a
    # different name at infrastructure companies.
    - platform engineer
```

Two neighbouring keys interact with this one and are worth knowing:

- **The hard filter** below `title_keywords` rejects a title containing any of
  its terms, matched as **whole words**, case-insensitive. So `sr` matches "Sr."
  but not "usr", and `lead` matches "Lead" but not "leading". Seniority terms
  live here.
- **`roles.title_rank`** controls **ranking**, not admission. It is a list of
  groups, highest first; an entry may be a single phrase or an array of synonyms
  that tie at that rank. Position derives the weight, so a differently-sized list
  changes the spread without new numbers. Leaving it out reproduces the built-in
  software ladder byte for byte.
- **`roles.search_query`** is the phrase sent to boards that filter server-side.
  Absent, it falls back to a built-in default.

### Step 3 — Re-audit

```bash
node scripts/leads/gate-audit.mjs
```

```
REGRESSION|l0|ashby:openai:eefeb527|OpenAI|stale: posted 31 days ago (max 30)
REGRESSION|l3|adzuna:5817552160|Nava Software Solutions|l3: same company and title seen 4 times before — reposting is the strongest ghost-job signal
audited=194 passing=103 l0=80 l1=2 l2=1 l3=8 compared=159 newly_rejected=4 newly_accepted=0 ms=289
```

Read the summary line right to left. **`newly_rejected` is the number that
matters.** `newly_accepted` going up is the win you were aiming for.
`l0/l1/l2/l3` are how many leads each stage is currently rejecting.

Every `REGRESSION` line names the stage and the exact reason a lead is now being
thrown out. If your change should not have affected any of them, look hard: a
change to one gate can move a lead into a _different_ gate's path.

**Exit codes:** `0` clean or improvements only, `1` leads became newly rejected,
`2` usage error or missing store.

The audit saves a new baseline by default. `--no-save` audits without moving the
baseline, which is what you want while iterating. `--json` gives the full record.
`--status all|new|...` narrows the lead set.

### Step 4 — Prove the change did what you wanted

```bash
node scripts/leads/find-jobs.mjs search --source boards
node scripts/leads/recommend.mjs --top 10
```

New titles should appear. If nothing does, recipe 12.

### When it does not work

| Symptom                               | Cause                                                     | Fix                                                                                                              |
| ------------------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `newly_rejected` > 0 after a widening | Your change moved leads into another gate                 | Read each `REGRESSION` line; the stage id says which gate                                                        |
| No change at all                      | The keyword does not literally appear in any stored title | The match is a substring on the lowercased title. Check the actual titles with `find-jobs.mjs list --status all` |
| `exit 2, missing store`               | No `jobs/leads.db`                                        | Run a sweep first, or recipe 9                                                                                   |

> **Known defect (2026-08-05 audit).** `gate-audit.mjs` runs **only** the four
> staged gates. It never calls `screen.mjs`'s own overlay checks, so the scam
> patterns, the clearance/polygraph blockers and the years-of-experience
> seniority gate are **outside the audit** — yet all three produce `reject`
> verdicts and all three are gates a person would edit. Tighten the seniority
> gate and `gate-audit` will report "no lead became newly rejected" while
> `screen.mjs` silently discards dozens. **After any change to those, also run
> `node scripts/leads/screen.mjs` and compare the reject count by hand.**

> **Known defect (2026-08-05 audit).** `gate-audit` and `screen.mjs` judge
> **different text**. `screen.mjs` folds in the captured posting from
> `jobs/<slug>/job.json` and stamps a `partial_description` flag; `gate-audit`
> passes the raw stored lead. For any lead that has a workspace, the audit sees a
> shorter body than the live screen does, so a lead can pass the audit and be
> rejected by the screen, or the reverse. The audit's baseline can therefore be
> honestly wrong about a lead you have already worked on.

---

## Recipe 9 — Back up your data, and restore it

### When to use it

Before any risky change, before a machine move, and on a schedule you can live
with. Also read this once **now**, because one part of it is not recoverable by
any other means.

### Why it works this way — what is and is not recoverable

Everything the pipeline knows lives in three places, and they have very different
recoverability:

| Where                                                               | What is in it                   | Could you rebuild it?                                                                      |
| ------------------------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------ |
| `jobs/leads.db` → `leads` table                                     | Every job lead found            | **Yes** — run a sweep again. Boards are public                                             |
| `jobs/leads.db` → `applications` table                              | Every application you sent      | **Yes** — `profile/applications.yaml` is the on-disk copy                                  |
| `jobs/leads.db` → `documents` table                                 | Archived job workspaces         | **No.** There is no on-disk source. Once the folder was archived, the row is the only copy |
| `jobs/leads.db` → `auto_submissions`, `verifications`, `auto_queue` | Run records                     | **No** on-disk source                                                                      |
| `jobs/<slug>/` folders                                              | Active workspaces, drafts, PDFs | Only from a file copy                                                                      |
| `profile/`                                                          | Your fact base                  | Only from a file copy. **Gitignored and user-owned**                                       |
| `.env`                                                              | API credentials                 | Only from a file copy. **Never goes into chat, a document or a commit**                    |

Two consequences follow directly:

1. **Backing up this system means copying `jobs/leads.db` itself.** Copying
   `profile/applications.yaml` backs up your application list and nothing else.
2. The schema is flat — no version table, no migration chain — so a copy of the
   `.db` file is a complete, self-describing backup. There is no upgrade step to
   worry about.

### Step 1 — The backup

Stop anything that might be writing (an unattended run, an apply session), then
copy three things.

PowerShell:

```powershell
$stamp = Get-Date -Format yyyy-MM-dd
New-Item -ItemType Directory -Force "D:\backups\ajp-$stamp"
Copy-Item "jobs\leads.db" "D:\backups\ajp-$stamp\"
Copy-Item -Recurse "profile" "D:\backups\ajp-$stamp\profile"
Copy-Item ".env" "D:\backups\ajp-$stamp\"
```

Git Bash:

```bash
STAMP=$(date +%F)
mkdir -p "/d/backups/ajp-$STAMP"
cp jobs/leads.db "/d/backups/ajp-$STAMP/"
cp -r profile "/d/backups/ajp-$STAMP/profile"
cp .env "/d/backups/ajp-$STAMP/"
```

If you also want the active workspaces (drafts, rendered PDFs, scans), copy the
whole `jobs/` folder rather than only the database. It is larger; it is the only
way to keep in-progress work.

**One caution about copying a live SQLite file.** SQLite here runs in
write-ahead-logging mode, which means recent changes may live in a sidecar file
next to the database. Copying while nothing is writing avoids the problem
entirely. If you cannot be sure, copy `jobs/leads.db`, `jobs/leads.db-wal` and
`jobs/leads.db-shm` together when they exist.

### Step 2 — A second, text-shaped copy of the leads

```bash
node scripts/maintenance/migrate.mjs --export backups/leads-2026-08-07.json
```

```
exported 194 lead(s) to backups/leads-2026-08-07.json
```

This is a point-in-time snapshot of the `leads` table as readable JSON. It is not
written automatically on every change — at roughly 3 KB per lead that would
reintroduce the whole-file rewrite the database migration removed — so take one
when you want one.

`profile/applications.yaml` is already the text copy of your applications and is
regenerated on every write. Force one with:

```bash
node scripts/applications/applications.mjs export
```

### Step 3 — Restore

**Full restore, and this is the one that actually restores everything:** copy the
files back.

```powershell
Copy-Item "D:\backups\ajp-2026-08-07\leads.db" "jobs\leads.db"
Copy-Item -Recurse -Force "D:\backups\ajp-2026-08-07\profile\*" "profile\"
Copy-Item "D:\backups\ajp-2026-08-07\.env" ".env"
```

**Partial rebuild from the text copies**, when the database is gone or corrupt:

```bash
node scripts/maintenance/migrate.mjs --dry-run \
  --leads-json backups/leads-2026-08-07.json
```

```
leads:        194 from backups/leads-2026-08-07.json
applications: 26 from profile/applications.yaml
dry run — nothing written
```

Then without `--dry-run`:

```
built jobs/leads.db: 194 leads (+194 imported), 26 applications (bootstrapped from yaml), 1512 keyword links
auto_queue:   0 row(s) of run state (empty)
verified: applications match the YAML and new records round-trip
documents and auto_submissions untouched — neither has an on-disk source
sources left untouched; delete the .db to roll back
```

Four things in that output are worth understanding:

- **Leads are only ever added**, never overwritten. The database _is_ the live
  store once it exists, and the snapshot is frozen; re-importing wholesale would
  roll every lead status back to snapshot time.
- **Applications are imported only to bootstrap an empty table.** Re-importing
  over a populated table would undo every outcome recorded since the export was
  written.
- **The import verifies itself.** Every snapshot lead must be present afterwards,
  and every newly inserted record must round-trip field for field, or the whole
  thing throws.
- **`documents` and `auto_submissions` are never touched**, because neither has
  an on-disk source. `migrate.mjs` cannot restore them and does not pretend to.

`--reset-queue` clears run state a dead process left behind — and **refuses**
while any queued row is in the `attempted` state, because an attempted row means
a click may already have reached an employer and erasing it would disarm the one
brake between a crash and a second application to the same company.

### Step 4 — Verify the restore

```bash
node scripts/status.mjs
node scripts/applications/applications.mjs stats
```

Lead and application totals should match what you backed up.

### Archiving, which is not backing up

```bash
node scripts/maintenance/archive.mjs list
node scripts/maintenance/archive.mjs archive northwind-full-stack-engineer
node scripts/maintenance/archive.mjs restore northwind-full-stack-engineer
node scripts/maintenance/archive.mjs archive --closed --dry-run
```

Archiving folds a closed job folder into the `documents` table, verified byte for
byte, and **then removes the directory**. From that moment the row holds the only
copy. `restore` writes it back out. `archive --closed` archives every workspace
whose application reached a finished outcome — `--dry-run` first, always.

`purge --days N --apply` **deletes** archived rows whose job posting is older than
N days. It is dry-run by default and it is irreversible. Do not run it with
`--apply` unless you have a file copy of `leads.db`.

### When it does not work

| Symptom                                                     | Cause                            | Fix                                                                          |
| ----------------------------------------------------------- | -------------------------------- | ---------------------------------------------------------------------------- |
| `migration failed: N snapshot lead(s) missing after import` | The import did not round-trip    | The database was not written. Nothing is lost; investigate the snapshot file |
| `--reset-queue refused: N job(s) are 'attempted'`           | A run crashed after a click      | Check each named page yourself, resolve it, re-run                           |
| Restored database has no `documents` rows                   | They were never in a text export | Only a file copy of `leads.db` carries them                                  |
| `status.mjs` shows zero everything after a restore          | You restored to the wrong path   | The database must be at `jobs/leads.db`                                      |

---

## Recipe 10 — Turn the unattended runner on or off, and read a dry-run report

### When to use it

When you want applications to go out on a schedule without you at the keyboard —
and, more importantly, when you want to check whether that is currently happening.

### The state of this machine, first

> **Known defect (2026-08-05 audit).** `CLAUDE.md`'s rule 6 states that "nothing
> opens a browser unattended", that `auto-apply.mjs` does not launch Chromium,
> and that your limits file has neither `enabled: true` nor a board allowlist.
> **All three are false today.** `auto-apply.mjs` calls its stage builder and
> launches a browser, and `docs/application-limits.yaml` currently reads:
>
> ```yaml
> auto_apply:
>   enabled: true
>   dry_run: false
>   per_run_max: 10
>   per_day_max: 10
>   per_company_max_per_week: 5
>   board_allowlist:
>     boards.greenhouse.io: greenhouse
>     job-boards.greenhouse.io: greenhouse
>     jobs.lever.co: lever
>     jobs.ashbyhq.com: ashby
> ```
>
> With `dry_run: false`, the runner's mode resolves to **`live`**. The unattended
> path is **armed**. Rule 6 itself warns that this paragraph "has already been
> wrong four times that way", which is exactly why this recipe tells you to check
> the file rather than trust any prose about it.

**So: check the file, always, before assuming anything.**

```bash
node -e "const y=require('js-yaml'),f=require('fs');const d=y.load(f.readFileSync('docs/application-limits.yaml','utf8'));console.log(JSON.stringify(d.auto_apply,null,2))"
```

### The two switches, and why there are two

`enabled` answers **"may this machine run at all"**. `dry_run` answers **"does it
click"**. They are separate on purpose, and a dry run still requires `enabled:
true` — reading `enabled: false` as "dry runs are fine" would make the off switch
mean nothing.

| `enabled` | `dry_run` | Result                                                                   |
| --------- | --------- | ------------------------------------------------------------------------ |
| `false`   | anything  | Every job defers at the authorization gate. Nothing runs                 |
| `true`    | `true`    | Full rehearsal. Browsers open, forms are planned, **nothing is clicked** |
| `true`    | `false`   | **Live.** Applications are sent                                          |

`enabled` must be **strictly `true`**. Absent, `null`, the string `"yes"` and the
number `1` all defer.

### Turning it OFF

Edit `docs/application-limits.yaml` and set `enabled: false`. That is the switch.
Nothing else is needed and nothing else is sufficient.

For an **immediate** halt that does not require editing configuration, there is a
kill switch: a file at `jobs/.auto/STOP`. Creating it halts every run at its
checkpoints; deleting it allows the next run. The message a halted run prints
tells you the exact path to delete.

```powershell
New-Item -ItemType Directory -Force "jobs\.auto"
Set-Content "jobs\.auto\STOP" "paused by hand 2026-08-07"
```

A STOP can also be **scoped** — to one board, or one company — in which case only
that scope is held back. A scoped STOP is a **durable brake that only a human
clears**, and it is a different thing from the circuit breaker's board pause,
which is a timed backoff cleared by one success. Do not confuse them.

### Turning it ON, the safe order

1. Set `enabled: true` and `dry_run: true`.
2. Confirm the board allowlist lists only domains you recognise. The allowlist
   maps a domain to the adapter id that must handle it, and the gate checks the
   **declared** system rather than inferring one from the address — a board that
   puts "greenhouse" in its own path would otherwise be trusted as Greenhouse.
3. Run a dry run and read the report (below).
4. Only then set `dry_run: false`.

**What the allowlist can and cannot do.** Every Greenhouse tenant is
same-origin with every other Greenhouse tenant, and tenancy on these systems is
self-service. So the allowlist answers "is this the vendor's software", while the
gate is being asked "is this party safe to submit to unattended". The allowlist
can never be load-bearing against a hostile tenant. The controls that survive that
are structural: the unattended path carries no session cookie and reads nothing
back out of the page.

### Doing a dry run

```bash
node scripts/auto/auto-apply.mjs --limit 5 --concurrency 1
```

Flags:

| Flag                               | Meaning                                                            |
| ---------------------------------- | ------------------------------------------------------------------ |
| `--limit N`                        | How many queued jobs this invocation may work. Default 25          |
| `--concurrency N`                  | Workers. At most one job per origin regardless. Default 1          |
| `--enqueue`                        | Select eligible jobs into the queue and **stop**                   |
| `--json`                           | Machine-readable output                                            |
| `--db` / `--limits` / `--jobs-dir` | Override paths                                                     |
| `--fixture`                        | Loopback test mode. **Refuses to run against the real lead store** |

**Without `--enqueue` this command writes nothing**, deliberately. The first
version selected and enqueued unconditionally and then refused to run, leaving
queue rows in the real store as a side effect of a command that had said no.
Selection is a read; queueing is a decision, and a decision you did not ask for
should not survive a refusal.

**What you should see, per job, on the error channel:**

```
  northwind-full-stack-engineer: deferred (confirm-field)
  orbital-platform-engineer: deferred (consent-tickbox)
```

**And then the summary line:**

```
run=2026-08-07T14-22-09-118Z-c1900f mode=dry_run outcome=ok submitted=0 deferred=0 failed=0
```

> **Known defect (2026-08-05 audit).** The three counters on that summary line
> are **structurally always zero**. The campaign function returns no `submitted`,
> `deferred` or `failed` keys, and both this line and `cycle.mjs` read them with a
> `?? 0` fallback. A run that sent five applications prints `submitted=0`.
> **Do not read that line as a result.** Use `node scripts/status.mjs` (below)
> or `--json`, which carries the real per-job results.

### Reading the real report

```bash
node scripts/status.mjs
```

```
auto run=2026-08-04T02-55-53-304Z-c1900f outcome=ok stop=clear
auto submitted 24h=0 total=0 challenged=0 orphans=0
auto queue outstanding=0 queued=0 claimed=0 planned=0 authorized=0 age_p95_queued=- age_p95_claimed=- age_unknown=0
auto deferrals total=3 failures=0 confirm-field=2 consent-tickbox=1
auto class assent=3
auto latency n=0 p50h=- p95h=-
auto paused none
```

Line by line:

- **`run=... outcome=... stop=`** — the last run and whether the kill switch is
  set. `stop=clear` means no brake is applied.
- **`submitted 24h= total= challenged= orphans=`** — real submission counts.
  `challenged` is how many boards presented a bot wall. **`orphans`** is the
  number to watch: an orphan is an attempt recorded before a click where the
  acknowledgement was never written, so an application may exist at an employer
  with nothing able to say whether it does. A non-zero orphan count needs a human
  to look at that one posting.
- **`queue outstanding= queued= claimed= planned= authorized=`** — queue depth by
  state. **A depth that is not falling is the single clearest statement this path
  can make about itself.** A digest that reported only "3 applications in the last
  24 hours" would be compatible with a queue of 900 that has not moved since
  Tuesday.
- **`deferrals total= failures=`** and the per-reason breakdown — what stopped
  each application. In dry run every application defers; that is the point.
- **`latency n= p50h= p95h=`** — hours from queueing to submission.
- **`paused`** — boards the circuit breaker has backed off from.

Every unattended run also writes an append-only text record at
`jobs/.auto/runs/<runid>.jsonl`. That copy is the one that **survives**: the
database is excluded from version control and a database file is exactly the
thing that is unreadable at the moment you need it most. Neither copy is derived
from the other, and a record present in one and absent from the other is itself a
finding.

### What blocks a submit on the unattended path

Each of these blocks the click and defers the application, because each means
something on the page was not understood:

- any field resolved `confirm` — an answer you _assert_ rather than state;
- any `confirm-widget` defer — a checkbox or radio group, which carries assent
  rather than a value, whatever the answer's class;
- any consent tickbox;
- any `unknown` field, unprobed dropdown, or failed fill;
- `verify-claims` not passing, or the document not yet approved by you;
- the board failing the trust gate, or the lead carrying a screening rejection;
- **the post-submit classifier returning `unclassified`.**

That last one deserves a sentence, because it is the current hard stop. After a
submit the runner has to decide whether the page that came back is a confirmation.
The classifier's rules are bounded by their evidence: a rule justified by a test
fixture may fire **only on loopback**, so a real applicant tracking system
classifies as `unclassified`. That is not a gap to route around. Writing a
plausible-looking pattern instead fails silently in the one direction that cannot
be recovered — a page misread as a confirmation records an application that was
never sent, and nothing later corrects it. The only lawful way to fill that corpus
is `scripts/apply/capture-post-submit.mjs` on your own attended applies.

### Scheduling it

`scripts/auto/cycle.mjs` is one whole cycle — search, screen, prep, tailor, apply
— and `scripts/auto/cycle.cmd` is the Windows Task Scheduler wrapper for it. The
wrapper exists because Task Scheduler runs an action with no shell, no reliable
PATH, and a working directory it picks; all three matter, because this pipeline
resolves `jobs/`, `profile/` and the limits file relative to the repository root,
and a run started elsewhere silently reads a different fact base or none at all.
The wrapper pins the directory and writes a dated log to `logs/cycle.log`.

**Registering the scheduled task is your act, not the agent's** — it changes a
system setting.

```bash
node scripts/auto/cycle.mjs --top 10 --skip-apply
```

`--skip-apply` prepares documents and stops before the runner, which is the safe
way to try it. `--skip-search` reuses leads already in the store. The cycle is
idempotent: run it twice and the second run does almost nothing.

### When it does not work

| Symptom                                       | Cause                                                        | What to do                                                                                                               |
| --------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `preflight refused (exit N)`                  | A gate said no; each failing check is listed with its reason | Read the list. Exit 4 means a sensitive value in the fact base — see recipe 4                                            |
| `allowlist: ...` warnings                     | A typo in `board_allowlist`                                  | A misconfigured allowlist reads as "every board is untrusted", which sends you looking at boards instead of at your typo |
| `nothing eligible (N considered, M rejected)` | Nothing passed selection                                     | Normal when documents are not prepared. Run `prep-queue` and the tailoring steps                                         |
| `could not start a browser`                   | Chromium is not installed                                    | `npm run browser:install`                                                                                                |
| A run halts naming a STOP path                | The kill switch, global or scoped                            | Delete the named file when you are ready                                                                                 |

> **Known defect (2026-08-05 audit).** A crash-resumed job loses its posting
> address. The queue table has no column for it, so a resumed slug that was not
> also selected in the current invocation gets a null address, the trust gate
> fails with "the lead carries no apply_url", and the job is written as a
> **terminal** deferral that is never retried — blaming address canonicalisation
> for what is actually a missing seed. If a slug is stuck deferred with a trust
> reason you cannot explain, this is a strong candidate.

> **Known defect (2026-08-05 audit).** `per_run_max` can be overshot at
> concurrency above 1, and a deferral written for a job whose queue row has no
> run id is silently dropped — leaving the job in `queued` with no reason
> recorded, which is exactly the invisible-loss bucket the surrounding code says
> must not exist. Run at `--concurrency 1` until both are fixed.

---

## Recipe 11 — Add support for a new applicant tracking system

### When to use it

When you keep meeting a board the planner labels `generic` and it defers far more
fields than a supported board does.

### Why it works this way

An **adapter** here contributes only **knowledge, never behaviour**. The fill
engine contains no system-specific code at all, which is why an unrecognised
board still works — it defers more fields, and that is the only difference. An
adapter tells the planner three kinds of thing:

- which strategy to try first on a custom dropdown,
- which file field takes which document,
- where the system renders a value differently from the option text it was chosen
  by.

That narrowness is the safety property. An adapter cannot make the engine do
something new; it can only make the engine's existing behaviour better informed.
And **throughput may only rise through deterministic understanding** — an
adapter, a probed option list read off the live form, or an answer you banked.
Never by having a model resolve an unknown field.

### The registry

`scripts/apply/ats/index.mjs` holds three things:

```js
export const ADAPTERS = [greenhouse, lever, ashby]

export const HANDOFF = [
  {
    id: "workday",
    match: /myworkdayjobs\.com|\.workday\.com/i,
    reason:
      "Workday requires creating an account to apply — the agent cannot do that. ...",
  },
]
```

plus `detectAts(url)`, which checks the hand-off list against the URL's
**hostname**, then each adapter, then falls back to `generic`.

**Workday is detected and deliberately not adapted.** Applying there requires
creating an account, which the agent is not permitted to do. Naming it explicitly
produces an honest hand-off instead of a confusing stall at a login wall. If a
new system has that property, add it to `HANDOFF` rather than writing an adapter.

### The steps

1. **Apply to one posting by hand, attended, and capture the form.** You need a
   real scan of a real page. Recipe 3's scan step writes it to
   `jobs/<slug>/scan-p1.json`.
2. **Write the adapter** at `scripts/apply/ats/<name>.mjs`, following
   `greenhouse.mjs` as the model. Read
   [../code/08-apply-filling.md](../code/08-apply-filling.md) first — it is the
   detailed reference for every control type, the combo-box strategy ladder, the
   upload routing rules and the report shape, and an adapter written without it
   will encode assumptions the engine does not share.
3. **Register it** in `ADAPTERS` in `index.mjs`. Order matters: the first
   adapter whose pattern matches wins.
4. **Add a fixture** under `tests/fixtures/` — a saved copy of the form — and a
   test under `tests/apply/`. New features need tests covering the success case
   **and** the failure and boundary cases.
5. **Run the one test file while iterating:**

   ```bash
   node --test tests/apply/<name>.test.mjs
   ```

   Never pass a bare directory to `node --test`: on Node 24 it does not recurse,
   it reports "Cannot find module", and that looks like a test failure. Use a
   quoted glob if you need several: `node --test "tests/apply/**/*.test.mjs"`.

6. **Run the full gate once, before committing:**

   ```bash
   npm test
   ```

   That is not a bare `node --test` — it expands the directories itself and
   asserts the test count against a floor in `package.json`, because `node --test`
   exits `0` on an empty run. An exit code alone is not evidence that anything
   ran.

7. **Only then consider the allowlist.** Adding the new system's domain to
   `auto_apply.board_allowlist` in `docs/application-limits.yaml` is what lets the
   unattended runner touch it, and that is your decision, made after you have seen
   the adapter work attended.

### How to tell it worked

`fill-plan.mjs` reports your adapter's id and a smaller defer count on the same
form:

```
ats=northwind-ats ready=true submitReady=false items=21 defer=2 skip=0 checked=0 cache=0/5 miss=5 fp=7d21ab disclose=7/20
```

`ats=` naming your adapter instead of `generic` is the proof it was selected.
`defer=` falling is the proof it helped.

### When it does not work

| Symptom                          | Cause                                      | Fix                                                                                                  |
| -------------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `ats=generic` still              | The pattern does not match                 | Test the pattern against the real URL in isolation                                                   |
| A dropdown still defers          | The engine does not know that widget shape | That is the engine's business, not the adapter's. See the combo-box section of `08-apply-filling.md` |
| `npm test` count below the floor | A test file did not run                    | The gate prints which directories it expanded; check your new file is under `tests/`                 |

> **Known defect (2026-08-05 audit).** Adapter selection matches the **whole
> URL**, not the hostname. Only the hand-off list was tightened to hostname-only
> matching (after a tracking parameter containing `myworkdayjobs.com` on a real
> Greenhouse posting forced a Workday hand-off). So a board can still steer
> adapter choice with a URL substring. Write adapter patterns to be as specific
> as you can — anchor on a full hostname, not a bare product name.

---

## Recipe 12 — Investigate why a job you expected never appeared

### When to use it

You saw a posting you would apply to, and it is not in your leads. Work through
these in order; each step is cheap and each rules out a whole class of cause.

### Why it works this way

Postings are discarded at four progressively more expensive stages, cheapest
first, stopping at the first rejection:

| Stage | Name                    | What it reads                                                                      | Cost                                   |
| ----- | ----------------------- | ---------------------------------------------------------------------------------- | -------------------------------------- |
| `l0`  | title / location / date | The board list payload only                                                        | Free. Discards thousands               |
| `l1`  | body disqualifiers      | The description — which for four board types costs one fetch per surviving posting | Cheap, because L0 already cut the list |
| `l2`  | profile fit             | L1's text                                                                          | Free                                   |
| `l3`  | scam / ghost risk       | Stored history                                                                     | Free                                   |

Before any of that, the posting has to have been **fetched at all**. So the first
question is never "which gate rejected it" — it is "was it ever seen".

### Step 1 — Is it in the store at all?

```bash
node scripts/leads/find-jobs.mjs list --status all | grep -i "northwind"
```

If it **is** there with a status of `dismissed`, you or a screen dismissed it; go
to step 4. If it is not there at all, continue.

### Step 2 — Is the company's board even being swept?

```bash
node scripts/leads/manage-sources.mjs list
```

If the company is absent, that is your answer — recipe 7. If it is present:

```bash
node scripts/leads/manage-sources.mjs verify
```

A `BROKEN` line means the board stopped answering. A company that changes systems
keeps its old address returning 404 or an empty list, and the sweep will keep
finding nothing forever without complaining loudly.

### Step 3 — Is the board producing anything?

```bash
node scripts/leads/board-yield.mjs
```

```
greenhouse:twilio|Twilio|live=173|solid=8|unconfirmed=0|yield=4.6%|hard=131|loc=17|title=10
ashby:render|Render|live=33|solid=5|unconfirmed=0|yield=15.2%|hard=16|loc=0|title=5
greenhouse:anthropic|Anthropic|live=388|solid=0|unconfirmed=0|yield=0%|hard=257|loc=99|title=32
oracle_cloud:ejfh.fa.us6.oraclecloud.com|Station Casinos|live=275|solid=1|unconfirmed=0|yield=0.4%|hard=40|loc=0|title=232
```

This is the single most informative diagnostic in the system, because it breaks
the loss down by cause:

| Column         | Meaning                                                                   |
| -------------- | ------------------------------------------------------------------------- |
| `live=`        | Postings the board currently returns                                      |
| `solid=`       | Postings that would clear every gate                                      |
| `unconfirmed=` | Postings that pass but carry an unresolved flag                           |
| `yield=`       | `solid / live`                                                            |
| `hard=`        | Rejected by the **hard title filter** — seniority terms, mostly           |
| `loc=`         | Rejected on **location**                                                  |
| `title=`       | Rejected because the title matched **no** entry in `roles.title_keywords` |

Read the three loss columns against each other. `Station Casinos` above loses 232
of 275 on `title=` — that board posts almost nothing this profile searches for.
`Anthropic` loses 257 on `hard=` — nearly everything there is senior. Those are
completely different problems with completely different fixes, and the summary
number `yield=0%` hides both.

### Step 4 — Which gate rejected it, exactly?

```bash
node scripts/leads/gate-audit.mjs --no-save
```

Every rejected lead in the store is shown with its stage and reason:

```
REGRESSION|l0|ashby:openai:eefeb527|OpenAI|stale: posted 31 days ago (max 30)
REGRESSION|l3|adzuna:5817552160|Nava Software Solutions|l3: same company and title seen 4 times before — reposting is the strongest ghost-job signal
audited=194 passing=103 l0=80 l1=2 l2=1 l3=8
```

And screening's own overlay reasons:

```bash
node scripts/leads/screen.mjs --no-record | grep -i "northwind"
```

```
reject|-|greenhouse:northwind:8098945|Northwind Logistics|over_bar_7y,title_watch:platform,posting_thin
```

The vocabulary you will see most:

| Reason                             | Meaning                                                                                |
| ---------------------------------- | -------------------------------------------------------------------------------------- |
| `over_bar_Ny`                      | The posting states N years minimum, above the profile's bar plus its stretch allowance |
| `stale_Nd`                         | Posted N days ago, past `freshness.max_age_days`                                       |
| `title_watch:<term>`               | A soft-filter term flagged the title for a body read rather than rejecting it          |
| `title_loose`                      | The title matched a keyword loosely                                                    |
| `posting_thin`                     | Very little description text                                                           |
| `employment:contract-to-hire`      | An employment shape excluded by your limits                                            |
| `unknown_location` / `unknown_age` | Not stated by the board; kept and flagged                                              |
| `remote_unverified`                | The posting says remote but the location field does not confirm it                     |
| `fit_weak`                         | Low technology overlap with the profile                                                |

### Step 5 — Which titles are being thrown away?

```bash
node scripts/leads/find-jobs.mjs search --source boards --explain
```

`--explain` prints the most common software-ish titles that were rejected purely
by `roles.title_keywords`, most frequent first:

```
Top 30 software-ish titles rejected by roles.title_keywords (of 412 distinct):
    28  Site Reliability Engineer
    19  Platform Engineer
    14  Infrastructure Engineer
```

That list is the direct input to recipe 8. A title appearing 19 times that you
would take is a keyword worth adding.

### Step 6 — The remaining causes, in order of likelihood

1. **You already applied.** The sweep dedupes against application history.
   `node scripts/applications/check-applied.mjs "Northwind"`.
2. **It was stored on an earlier sweep and dismissed.**
   `find-jobs.mjs list --status dismissed`.
3. **The board type carries no description in its list endpoint** — Oracle
   Recruiting Cloud, SmartRecruiters, SuccessFactors and Workday all do this — so
   a posting that fails L1 for lack of text is a fetch problem, not a policy one.
4. **The posting is not on a public board at all.** Many large and most local
   employers run systems whose addresses cannot be discovered from a company
   name. Nothing will find those automatically.

### The two things that will mislead you

> **Known defect (2026-08-05 audit).** L3's injection-based rejection **cannot
> fire on any stored lead**, so a posting carrying instruction-shaped text will
> not be rejected by the stage that exists to reject it. It is still flagged as a
> screening signal, and the load-bearing control is unchanged — `verify-claims`
> rule R6 means a claim the fact base cannot back never reaches a document. But do
> not read a clean L3 as proof a posting was checked for that.

> **Known defect (2026-08-05 audit).** `partial_description` is set true for
> nearly every lead, which disables two screening signals that depend on it. So a
> lead that "passed" screening may have passed because two checks did not run.

---

## Where to go next

**Operating**

- [01-commands.md](01-commands.md) — the full command catalogue, every script with
  every flag. Use it as a lookup once you know which recipe you are in.
- [03-troubleshooting.md](03-troubleshooting.md) — symptom-first index for
  failures these recipes do not cover.
- [04-config-reference.md](04-config-reference.md) — every key in
  `docs/application-limits.yaml`, `docs/job-sources.yaml` and `.env`, with what
  reads it.

**Understanding what you were operating**

- [../guide/01-what-this-is.md](../guide/01-what-this-is.md) — the system in plain
  language, if any of the above assumed too much.
- [../guide/05-architecture.md](../guide/05-architecture.md) — how the pieces fit
  together and why the boundaries fall where they do.
- [../guide/06-data-model.md](../guide/06-data-model.md) — every table and column,
  which recipe 9 depends on.
- [../guide/07-safety-model.md](../guide/07-safety-model.md) — the hard rules,
  what each one prevents, and the incidents behind them.
- [../guide/08-glossary.md](../guide/08-glossary.md) — every term used above.

**Rebuilding it**

- [../code/00-file-index.md](../code/00-file-index.md) — every file, one line each.
- [../code/02-leads-finding.md](../code/02-leads-finding.md) and
  [../code/03-leads-screening.md](../code/03-leads-screening.md) — recipes 1, 8
  and 12 in full mechanical detail.
- [../code/05-documents.md](../code/05-documents.md) — recipe 2's pipeline.
- [../code/06-apply-scanning.md](../code/06-apply-scanning.md),
  [../code/07-apply-planning.md](../code/07-apply-planning.md) and
  [../code/08-apply-filling.md](../code/08-apply-filling.md) — recipes 3 and 11.
- [../code/09-auto-runner.md](../code/09-auto-runner.md) and
  [../code/10-auto-safety.md](../code/10-auto-safety.md) — recipe 10.
- [../code/11-record-and-profile.md](../code/11-record-and-profile.md) — recipes
  4, 5, 6 and 9.
- [../code/14-tests.md](../code/14-tests.md) — the test suite and the count-asserting
  gate that recipe 11 step 6 runs.
