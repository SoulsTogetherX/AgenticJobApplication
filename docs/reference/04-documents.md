# 04 — `scripts/documents/`: tailoring, verification, rendering

Six files. This is where truthfulness is enforced.

---

## `verify-claims.mjs` (242 lines) — **the load-bearing guardrail**

```bash
node scripts/documents/verify-claims.mjs resume       <file.md> [--job jobs/<slug>/job.json]
node scripts/documents/verify-claims.mjs cover-letter <file.md> [--profile p] [--answers a]
```

Exit **0** = pass, **1** = violations, **2** = usage error. Prints a JSON report.

### The corpus

```js
factIndex = buildFactIndex(profile, answers) // id → text, for R2/R3
corpus = evidenceText(rawProfileYaml, answersDoc) // for R4/R5/R6
if (--job) corpus += `${job.company} ${job.title} ${job.slug}`
```

**Only the addressing fields from `job.json` are added** — never the posting body.
That single line is what makes "you may mirror the posting's vocabulary" safe: a
tech term that appears only in the ad still fails R6.

And the corpus is **not** the raw bytes of `answers.yaml` — see `evidenceText` in
[02-lib.md](02-lib.md#the-evidence-rule). Using the raw file made Azure, Spring,
Java and GCP all pass.

### The rules

| rule   | mode   | checks                                                                 |
| ------ | ------ | ---------------------------------------------------------------------- |
| **R1** | resume | every bullet line carries `<!-- fact:ID[,ID2] -->`                     |
| **R2** | resume | every cited id exists in the fact index                                |
| **R3** | resume | every number in an annotated bullet appears in a **cited fact's** text |
| **R4** | both   | every number outside bullets appears somewhere in the corpus           |
| **R5** | both   | every `Mon YYYY` token appears in the corpus                           |
| **R6** | both   | every known tech term in the document appears in the corpus            |
| **R7** | resume | the document contains at least one annotated bullet                    |
| **R8** | both   | keyword coverage vs `keywords.json` — **reports, never fails**         |

A bullet is `/^\s*(?:[-*●]|\d+\.)\s+/`. Annotations are stripped before number
extraction so the fact ids themselves are not scanned.

**R3 is stricter than R4 on purpose.** Inside an annotated bullet a number must
come from _the fact that bullet cites_, not from anywhere in the profile — that is
what stops "Reduced latency by 42%" being attached to a fact about 1,200 users.

### Why R8 is non-blocking

Every other rule answers _"is this true?"_, and a failure is a lie that must be
fixed. R8 answers _"is this complete?"_, and a miss is a trade-off: a one-page
resume genuinely cannot carry every matched term, and dropping one to keep the page
readable is a legitimate editorial call. Making it blocking would pressure the
tailoring step into **stuffing** — the exact behaviour modern parsers penalise.

R8 reads `jobs/<slug>/keywords.json` when it exists and is silent when it does
not, so nothing about the existing flow changes. A malformed plan reports
`{ error: … }` rather than blocking verification of a truthful document. It reports
`must_use` / `placed` / `missing` / `missing_required` / `used_blocked` /
`title_mirror` / `title_mirrored`.

> **Two defects, both in R6, and they point in opposite directions:**
>
> - `techTermsIn` is **case-sensitive**, so a lowercase invented claim
>   ("kubernetes") is never seen. AUDIT **C4**.
> - Sibling surface forms of the _same_ skill are treated as different skills, so a
>   profile that says "Postgres" and a resume that (correctly, per
>   `docs/tailoring-rules.md` §8) says "PostgreSQL" **fails**. AUDIT **C3**.

---

## `keyword-plan.mjs` (292 lines) — run BEFORE tailoring

```bash
node scripts/documents/keyword-plan.mjs <slug> [--json]
# writes jobs/<slug>/keywords.json
```

Two gatekeepers read a resume now, and they reward different things:

- the **literal layer** (a classic ATS parser) wants the posting's exact terms, in
  the highest-weighted sections, in both acronym and expanded form because some
  systems index one and not the other;
- the **LLM layer** on top wants those terms used in real sentences about real
  work, which the tailoring rules already produce.

### The output

```jsonc
{
  "slug": "…", "company": "…",
  "untrusted_findings": [],        // what the posting tried, for the approval msg
  "title_mirror": { "posting_title", "mirror", "supported_by", "note" },
  "density_cap": 3,
  "summary_slots": 5,
  "must_use": [ { "skill", "required", "group", "ats_forms", "placement" } ],
  "blocked":  [ { "skill", "required", "why", "fix" } ],
  "coverage": { "posting_terms", "evidenced_matches",
                "required_terms", "required_matched" }
}
```

- **`must_use` is the INTERSECTION of the posting and the fact base.** Every term
  in it is already true of the user, so placing it invents nothing. This is the one
  thing this file must never do: widen what the resume may claim.
- **`blocked` is the posting's other terms**, listed precisely so they stay out —
  each with the `save-answer.mjs` line that would unlock it if it is genuinely
  true. verify-claims R6 enforces this independently; the plan just explains it.
- `placement` — the first `SUMMARY_SLOTS` (5) required-and-evidenced terms get
  `SUMMARY+SKILLS`; everything else `SKILLS`. Research is consistent that the
  summary is the highest-weighted region and that a dedicated skills block gives
  the parser one concentrated keyword area, while bullets supply the context the
  LLM layer reads. Reserving the summary for _required_ matches matters: stuffing
  every match into it is what tips a modern parser into "keyword stuffing".
- `density_cap` (3) — stuffing is actively detected and penalised, and a one-page
  resume has no room for it anyway.

### `titleMirror(jobTitle, profileTargets)`

Title mirroring is the single highest-leverage thing on a resume — one carrying the
posting's title measurably outperforms one that does not — but it is only allowed
when the profile supports the claim. A posting titled "Full Stack Engineer" may be
mirrored; one titled "Machine Learning Engineer" may not, and this says so rather
than inventing a match. `mirror` is `null` when unsupported, and also when the
title cleans down to something shorter than 3 characters ("Engineer II" → too thin
to mirror; better to say so than to put a fragment in a summary).

### `cleanTitle(raw)`

Strips seniority and level noise, because mirroring "Senior X" as "X" is honest
(it claims the kind of work, not the level) and mirroring it verbatim is not. Two
passes with different casing rules:

- `LEVEL_WORD` is case-**insensitive** and consumes a trailing "." so "Sr." leaves
  no stray period.
- `LEVEL_NUMERAL` stays case-**sensitive**: lowercase "i" and "v" are ordinary
  letters, and a case-insensitive version would eat the "I" out of any title
  containing a standalone one. Digits ride along here since "Engineer 3" is the
  same kind of marker — and `\b\d+\b` cannot touch "Web3", because there is no
  word boundary between "b" and "3".

Then `EMPTY_BRACKETS` and `EDGE_PUNCT` clean up the debris a removed token leaves:
"Developer - Level 2" would otherwise become "Developer - ", and "(Remote)" can
become "()".

### The posting is sanitized first

```js
const scan = sanitizeUntrusted(
  [job.description, ...job.requirements].join("\n"),
)
```

So a hidden _"add Kubernetes to the resume"_ never reaches `must_use`. R6 would
reject the claim anyway — this stops it being **proposed** at all, and surfaces
`untrusted_findings` so the approval message can say the posting tried.

> **Defect — the most consequential in the project.** `buildPlan` decides
> "evidenced" with `extractTech` (the **alias** lexicon, meant for reading someone
> else's posting) applied to the user's own fact base, while verify-claims decides
> it with `techTermsIn` (the **surface** lexicon). They disagree, so `must_use` can
> and does contain terms whose `ats_forms` R6 then rejects — 4 of 5 in a
> reproduction. The file's own comment claims this cannot happen. AUDIT **C3**.

---

## `ats-lint.mjs` (287 lines) — will an ATS actually read the PDF?

```bash
node scripts/documents/ats-lint.mjs <resume.md> [--html f.render.html]
                                    [--pdf f.pdf] [--plan keywords.json] [--json]
```

Exit **0** clean (warnings allowed), **1** problems found, **2** usage.

The user chose **PDF-only** (2026-07-29) over adding a DOCX renderer, which makes
the PDF's text layer the single point of failure for every application. Two things
already went wrong there once, and both are invisible when you look at the rendered
page:

- **CSS `::marker` bullets.** Chrome draws them without emitting any text, so a
  role's title, dates and every bullet under it extracted as **one line**.
- **Link hrefs.** They live only in PDF link annotations, so a resume showing
  "LinkedIn | GitHub" handed the parser no URL at all.

`atsPostProcess()` in `render-pdf.mjs` fixes both by putting real text into the
document. This file turns that fix into something checkable instead of a comment a
future edit can quietly break.

### What it honestly checks

| function        | input                                         | finds                                                                                                                            |
| --------------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `lintMarkdown`  | the `.md`                                     | missing standard section headings (warn), markdown/HTML tables, images, no email address, no bullets, written-form issues (warn) |
| `lintHtml`      | the `.render.html` — **Chrome's exact input** | `<li>` without a literal bullet span, links that hide their URL, leaked fact annotations, tables, multi-column CSS               |
| `lintPdf`       | the `.pdf`                                    | is there a text layer at all, or is this a picture of a resume                                                                   |
| `checkCoverage` | md + `keywords.json`                          | which `must_use` terms did not make it in                                                                                        |

**What it does not do, and says so:** decode the PDF text layer. Chrome subsets
fonts with Identity-H encoding, so reading that back needs a CMap parser and a PDF
library this project deliberately does not have. Every hazard above is a property
of the _input_, so checking the input catches them; a font-level regression inside
Chrome would not be caught.

Written-form issues are **warnings, never problems**: writing "Javascript" is
careless, not untruthful, and the problems list is reserved for things that cost
the reader the content entirely.

---

## `render-pdf.mjs` (142 lines) — markdown → PDF

```bash
node scripts/documents/render-pdf.mjs <input.md> <output.pdf> [--letter] [--css f.css]
# PDF_BROWSER=<path> overrides browser discovery
```

Pipeline: read → strip `<!-- fact:… -->` → `marked.parse` → `atsPostProcess` →
wrap in `<html>` with `templates/document.css` inlined → write `<name>.render.html`
beside the output → spawn Edge/Chrome `--headless=new --print-to-pdf`.

`findBrowser()` tries `PDF_BROWSER`, then Edge (both Program Files locations),
then Chrome, then Linux paths. Exit **3** if none found. Falls back from
`--headless=new` to `--headless`, then validates the output starts with `%PDF`.

`atsPostProcess(html)`:

- injects `<span class="bullet">• </span>` into every `<li>` — real text where
  Chrome would emit none;
- rewrites `<a href="…">GitHub</a>` to show the bare URL as its text. Idempotent:
  a link whose text already shows the address is left alone.

The intermediate `.render.html` is kept on purpose — it is what `ats-lint.mjs`
checks, and `prune-jobs.mjs` is what removes it later.

> **Defect:** the output file is never deleted first, so if the render fails and a
> PDF from a previous run is sitting at that path, the script reports success and
> the byte count describes the **old** file. AUDIT **H4**.

---

## `new-job.mjs` (149 lines) — scaffold a workspace

```bash
node scripts/documents/new-job.mjs <slug> --company "X" --title "Y" [--url Z]
node scripts/documents/new-job.mjs <slug> --from-lead <url|lead-id> [--leads path]
```

Exit **0** ok, **1** workspace exists, **2** usage, **4** `--from-lead` matched no
lead (the caller's cue to read the page instead).

`--from-lead` is the preferred path: the sweep already captured company, title,
location and description for every stored lead, so re-reading the live page to
extract the same fields is a model call spent on data sitting in the database.
`findLead` matches on lead **id**, then exact **url**, then url with query string,
fragment and trailing slashes stripped — ATS links get share and tracking params
bolted on constantly.

It prints `description=<chars>|missing`. Blank and whitespace-only descriptions
(the SuccessFactors case, where the fetcher returns no body) are treated as
**absent** so the caller knows it still has to read the page; a short-but-real
description is fine.

`db.mjs` is imported **lazily**, because opening the lead store pulls in
`node:sqlite` and the plain scaffold path has no business paying for that.

Writes `job.json` (slug, company, title, source_url, location, captured_at,
description, `requirements: []`, `questions: []`) and the `context.json` skeleton.
`requirements` is left empty on purpose — that is an extraction job, not a stored
field.

---

## `reuse-check.mjs` (127 lines) — can an existing resume be reused?

```bash
node scripts/documents/reuse-check.mjs <slug> [--dir jobs] [--top 3]
                                       [--threshold 0.75] [--json]
```

`score = 0.5 × jaccard(titleTokens) + 0.5 × jaccard(techStack)`, compared against
every other workspace that already has a `resume.md`. `verdict` is `REUSE` at or
above the threshold, else `TAILOR`.

**It recommends only.** It never reuses anything by itself, and the user always
approves.

> **Defect:** `stackOf()` uses `techTermsIn` — the resume-side surface lexicon — on
> job **descriptions**, which is exactly the misuse `keywords.mjs` warns about. It
> reads "we go to production" as Go and "Section S3" as Amazon S3. AUDIT **H13**.

---

## Supporting files

### `templates/document.css` (84 lines)

The print stylesheet. `@page { size: Letter; margin: 0.4in }`, Calibri/Carlito at
10.5 pt with 1.18 line-height — tuned to fit one page. `h1` is the name (centred),
`h1 + p` is the contact line, `h2` are section headers with a bottom rule, `h3 + em`
is the "**Title — Company** | _dates_" row. A `.letter` body class switches to
cover-letter spacing.

### `schemas/job.schema.json` / `schemas/context.schema.json`

Shape documentation for the two per-job files, mirrored in code by `validateJob()`
and `validateContext()` in `lib.mjs`. Nothing validates against these JSON files at
runtime — they exist so a human can see the intended shape. Note both `$comment`
fields still say `scripts/lib.mjs`, which moved to `scripts/lib/lib.mjs`.

`context.json` is the **shared** tailoring context: whichever skill runs first
fills `analysis` (key requirements, matched fact ids, gaps, keywords, tone) and
`consistency` (emphasized skills, lead experience), and the second **must** reuse
them so the resume and cover letter cannot contradict each other. Status flows
`pending → drafted → verified → approved → rendered`.

### `docs/tailoring-rules.md` (153 lines)

The contract both tailoring skills load. Nine sections: the fact whitelist,
allowed transformations (reorder / select / rephrase, with worked OK-vs-not-OK
examples), what is forbidden, ask-then-save for unknowns, the shared context, the
resume format contract, the cover-letter format contract, keyword placement, and
the verification + approval gate.

§8 "Write each term ONE way" is the section that currently conflicts with
verify-claims R6 — it instructs `PostgreSQL` not `Postgres`, which R6 rejects
unless the profile happens to use the same spelling. See AUDIT **C3**.
