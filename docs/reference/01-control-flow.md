# 01 — Control flow: the four pipelines

Every user request enters through a **skill** (`.claude/skills/<name>/SKILL.md`),
which is a markdown instruction sheet Claude Code loads when the request matches
its `description`. A skill orchestrates Bash calls to deterministic scripts and
Playwright MCP calls to the browser. **No script ever calls a model**; the model
never manipulates the database directly.

---

## Pipeline 1 — Discovery: posting → stored lead

Entry point: `/find-jobs`, or "find me some jobs".

```
node scripts/leads/find-jobs.mjs search --source all --query "full stack"
│
├─ loadSources()          docs/job-sources.yaml → 44 board entries
├─ loadLimits()           docs/application-limits.yaml → the user's hard filters
│
├─ mapPool(boards, 8, fetchBoard)        ← 8 boards fetched in parallel
│   └─ BOARD_FETCHERS[board.type](board, query)
│        greenhouse | lever | ashby | smartrecruiters | workable | recruitee
│        workday | oracle_cloud | jobvite | successfactors
│        jobicy | remotive | remoteok
│      each returns  { id, source, company, title, location, url, posted_at,
│                      description?, remote?, salary_max? }
│
├─ fetchHackerNews(query)                ← HN Algolia, tags=job
├─ fetchAdzuna(query, limits)            ← credentialed, .env
│
├─ recordSweep()          → board_stats  (write-only today; see AUDIT H9)
│
└─ ingest(candidates, limits)
    │
    ├─ backfillDescriptions()   fill text onto leads stored before the sweep had it
    ├─ dedupeLeads()            drop known ids/urls/company+title
    │                           ...and RETURN the drops as `reposts`
    ├─ record repost sightings onto the already-stored lead
    │
    ├─ GATE 1  passesLimits(c, limits)      ← cheap: title, location, date, salary
    │          rejects thousands. Reads only the board's list payload.
    │
    ├─ enrichDescriptions(survivors)        ← ONE http fetch per survivor,
    │                                         only for the 4 ATS types whose list
    │                                         endpoint carries no description
    │
    ├─ GATE 2  bodyDisqualifiers(s, limits) ← needs the text: relocation, state
    │                                         carve-out, seniority hidden in the
    │                                         body, employment shape, is-this-even-
    │                                         a-software-job
    │
    ├─ store.leads.push(...kept); saveLeads()
    └─ indexKeywords(kept)      extractTech(title+description+requirements)
                                → lead_keywords rows
```

**Why the gates are in that order.** Gate 1 reads fields the board already handed
over, so it is free. Only what survives it is worth one HTTP round trip for its
description, and only once a description exists can Gate 2 read it. Reversed, the
sweep would fetch a detail page for every posting it was about to throw away.

### The four-stage screen

`passesLimits` and `bodyDisqualifiers` are not only used by ingest. They are
registered as stages **L0** and **L1** in `scripts/leads/stages.mjs`, alongside
two more that only run later:

| Stage | Module                              | Reads                       | Decides                                                       |
| ----- | ----------------------------------- | --------------------------- | ------------------------------------------------------------- |
| `l0`  | `find-jobs.mjs` `passesLimits`      | board list payload          | title keywords, hard/soft filter, location, freshness, salary |
| `l1`  | `find-jobs.mjs` `bodyDisqualifiers` | the description             | hard disqualifiers stated in the text                         |
| `l2`  | `fit.mjs` `scoreFit`                | the description             | can this profile do this job? **rejects** below a threshold   |
| `l3`  | `risk.mjs` `scoreRisk`              | description + store history | scam, ghost, repost, evergreen, injection attempt             |

`evaluateStages()` runs them in order and **stops at the first rejection**, so an
expensive check only ever sees what the cheap ones let through. It returns
`{ ok, stage, reasons, flags, stages }` — and `stage` is the answer to "why did I
never see this job?", which was previously unanswerable.

Registration lives in `stages.mjs` rather than in each check's own module,
deliberately: letting `fit.mjs` self-register would need it to import `stages.mjs`
which imports it back — a cycle.

```
node scripts/leads/screen.mjs [--stage l2]        run the stages over the store
node scripts/leads/gate-audit.mjs                 re-run ALL of them, diff vs baseline
```

`gate-audit.mjs` is the mechanical form of the discipline CLAUDE.md demands after
any gate change: it re-runs every stage over the whole store, lists every
**newly rejected** lead in full, and exits 1 if there are any. (Its baseline
handling has a footgun — AUDIT **H14**.)

### Ranking and queueing

```
node scripts/leads/recommend.mjs --top 10     score = tech overlap×2 + title fit
                                              + freshness + salary − flag penalties
node scripts/leads/cluster.mjs                group near-duplicate postings
node scripts/leads/prep-queue.mjs --cluster   which leads to tailor ahead of time
node scripts/leads/board-yield.mjs            which boards actually produce leads
node scripts/leads/find-boards.mjs            company NAME → public board slug
node scripts/leads/discover-boards.mjs        propose new boards, yield-gated
```

---

## Pipeline 2 — Preparation: lead → verified documents

Entry point: `/tailor-resume`, `/tailor-cover-letter`, or `/pipeline-jobs` for a
batch.

```
1. new-job.mjs <slug> --from-lead <url>      create jobs/<slug>/
   │  fills company/title/location/description FROM THE LEAD STORE,
   │  so no model re-reads the page for data already captured
   │  prints  description=<chars>|missing
   │  exit 4 = no lead matched → the caller must read the page
   └─ writes job.json + context.json

2. check-applied.mjs "<Company>"             have we been here before?

3. keyword-plan.mjs <slug>                   ← BEFORE drafting
   │  sanitizeUntrusted(posting)             strip injection carriers
   │  splitRequirements(body)                required vs nice-to-have
   │  postingTech = extractTech(title+body)  what the ad wants
   │  evidenced   = extractTech(profileBlob) what the facts back
   │  must_use = posting ∩ evidenced         ← placing these invents nothing
   │  blocked  = posting − evidenced         ← forbidden, with the unlock command
   └─ writes jobs/<slug>/keywords.json

4. the MODEL drafts resume.md / cover-letter.md
   following docs/tailoring-rules.md; every bullet ends <!-- fact:ID -->

5. verify-claims.mjs resume jobs/<slug>/resume.md --job jobs/<slug>/job.json
   R1 every bullet carries an annotation
   R2 every cited fact id exists
   R3 every number in an annotated bullet is in a cited fact
   R4 every number outside bullets is somewhere in the corpus
   R5 every "Mon YYYY" token is in the corpus
   R6 every known tech term in the doc is in the corpus   ← the real gate
   R7 the document cites at least one fact
   R8 keyword coverage — REPORTS, never fails
   → exit 0 pass / 1 violations / 2 usage.  context.json resume.status = verified

6. THE USER APPROVES  (hard rule 5: show emphasized / dropped / rephrased)

7. render-pdf.mjs jobs/<slug>/resume.md "<...>.pdf"
   marked → HTML → atsPostProcess → Edge/Chrome --headless --print-to-pdf
   leaves the intermediate .render.html beside the PDF

8. ats-lint.mjs jobs/<slug>/resume.md        will an ATS actually read it?
```

**The corpus in step 5 is not the raw `answers.yaml`.** That file stores each
form question next to its answer, and forms ask things like _"which of these do
you have? [... 4 = Spring / Spring Boot; 5 = Cloud (AWS, Azure, or GCP)]"_.
Using the raw file as evidence made **Azure, Spring, Java and GCP** all pass R6 —
including Spring, which the user explicitly did not select. `evidenceText()` in
`lib.mjs` is the fix: an answer always counts; a question counts only when the
answer is an unambiguous yes.

---

## Pipeline 3 — Application: verified documents → a form ready to submit

Entry point: `/apply-job <url>`. This is the only pipeline that touches a
browser, via the Playwright MCP server declared in `.mcp.json`.

The design goal is **2 browser calls per page** and **2 human touchpoints per
application**. The baseline before it existed was ~30 browser calls and ~8
minutes for one Greenhouse form.

```
PHASE 1  set up (no browser)
   new-job.mjs --from-lead …   |  check-applied.mjs

PHASE 2  read the form BEFORE tailoring
   A. ONE browser call:
      browser_run_code_unsafe { filename: ".claude/skills/apply-job/scan.driver.mjs" }
      │
      │  scan.driver.mjs (runs Playwright-side, has real locators)
      │  ├─ addInitScript + addScriptTag  scan-page.js → window.__ajScan
      │  ├─ __ajScan(false)               inventory the page, stamp data-aj="fN"
      │  └─ for each combo with no options:
      │         real Playwright click → read [class*='__option'] → Escape
      │         (a programmatic el.click() from page context does NOT open
      │          react-select; only a real input event does)
      └─ returns { url, heading, kind, fields[], btns[], iframes, signals }

      `kind` drives the next move:
        ad → click r:"start", re-scan | form → continue | login → hand off
        confirm → already submitted   | unknown → ask the user

   B. ONE Bash call:
      node scripts/apply/fill-plan.mjs <slug>
      │
      ├─ detectAts(url) → greenhouse | lever | ashby | generic
      │                   workday → exit 3, hand off (needs an account)
      ├─ applyCache(scan, cache)      reuse the remembered shape of this form
      ├─ resolveFields()  ─spawn─►  answer-bank.mjs --fields <json> --json
      │     exact banked question  →  OK
      │     contact / employment / education rule  →  OK
      │     EEO question  →  the "decline to answer" option
      │     fuzzy bank match ≥0.70 → OK, ≥0.45 → MAYBE
      │     nothing  →  UNKNOWN
      ├─ buildPlan()
      │     isConsent(label)          → ALWAYS defer (never agree for the user)
      │     file field                → upload, matched by label then order
      │     UNKNOWN/NEEDS-CHOICE/MAYBE→ defer if required, skip if optional
      │     otherwise                 → { how: fill|select|check|combo|type }
      ├─ recordCache()                remember this form for next time
      └─ writes fill-plan.js (window.__ajPlan = …) + fill-plan.json
         prints  ready=true|false  reason=…  items=N defer=N cache=H/T
         and the exact browser bootstrap for step D

   C. decide (0 calls)  cover letter needed? PDFs needed? reuse an existing resume?
      node scripts/apply/pending-questions.mjs   ← every unanswerable question,
                                                   across ALL prepped jobs, once

PHASE 3  tailor — delegated to the Sonnet-pinned `job-worker` agent
PHASE 4  THE ONE APPROVAL MESSAGE
         tailoring summary + unknown questions + the picks made + reuse offer
         → on reply: save-answer.mjs for each, then render PDFs

PHASE 5  fill and verify — ONE browser call
   browser_run_code_unsafe { filename: "jobs/<slug>/fill-plan.js" }
   │
   │  fill-plan.js is GENERATED: fill-plan.mjs read fill-engine.mjs's text
   │  off its own disk and embedded engine + plan as string literals. The
   │  engine is eval'd Playwright-side and never enters the page; nothing is
   │  read back out of the page. (The old version injected the engine and
   │  read window.__ajFillSrc back — a hostile board owned the browser.)
   │
   │  fill-engine.mjs
   │  ├─ urlGuard          refuse if the page is not the one planned against
   │  ├─ UPLOADS FIRST     they remount the form and void every data-aj stamp
   │  ├─ locate: sel first (app-owned, survives remounts), data-aj as fallback
   │  ├─ kindOf()          refuse to touch anything that is not a form control
   │  ├─ fill / select / check / type / combo
   │  │    combo tries the ATS's strategy order:
   │  │    type-enter → type-click → click-option, verifying after each
   │  └─ verify ONCE       read every field back, sweep the page's own error text
   └─ returns { ok, failed, deferred, failures, verify, defer, next }

   F. `next` is reported but there is deliberately NO verb that clicks a button.
      Advancing is an explicit browser_click you make. Submitting is the user.

AFTER  log-application.mjs <slug> --company … --title …   (only once the user
                                                            confirms they sent it)
```

**Why uploads go first.** `locator.setInputFiles()` makes React swap the input
for the attached-file view, which remounts the form — and `data-aj` attributes do
not survive a remount. Filling first and uploading last would corrupt everything
already entered.

---

## Pipeline 4 — Record and feedback

```
log-application.mjs <slug>            create a record (user confirmed only)
update-application.mjs <slug> --status rejected   record an outcome
follow-ups.mjs --days 10              who needs a nudge (max 2, then cold)
applications.mjs list|find|stats|remove|export
status.mjs                            the whole-pipeline digest in one call

profile-gaps.mjs                      demanded but not evidenced → learning gaps
keyword-coverage.mjs                  demanded, not evidenced, but ADJACENT to
                                      something you have → "you probably have
                                      this and never wrote it down"
archive.mjs archive --closed          fold closed workspaces into `documents`
prune-jobs.mjs --apply                drop .render.html intermediates
migrate.mjs                           rebuild the db / re-index keywords
```

`keyword-coverage.mjs` is the interesting one. `profile-gaps.mjs` answers the
harsh question ("what is demanded and not evidenced?") and treats every miss as a
learning gap. But most of that list is not a gap at all: someone who has shipped
React and Node has almost certainly written an Express route and run Jest — those
facts just never made it into `profile.yaml`. And because verify-claims R6
forbids any resume from mentioning an unrecorded skill, **an unrecorded skill is
an invisible skill**. So `keyword-coverage` splits the demand into `covered` /
`ask` / `gap`, where `ask` is the payload: demanded, not recorded, but adjacent to
something that is. It prints the `save-answer.mjs` line and never writes.

---

## How a skill actually gets invoked

```
user message
   │
   ▼
Claude Code matches the request against each SKILL.md `description`
   │
   ▼
the SKILL.md body is loaded into the turn as instructions
   │
   ├─ Bash  → PreToolUse hook scripts/hooks/guard-bash.mjs   (git branch policy)
   ├─ Edit/Write → PreToolUse .claude/hooks/protect-profile.js (fact base)
   │              PreToolUse scripts/hooks/guard-files.mjs    (project boundary)
   │              PostToolUse scripts/hooks/prettify.mjs      (formatting)
   ├─ Agent → .claude/agents/job-worker.md (pinned to Sonnet)
   └─ mcp__playwright__* → the MCP server from .mcp.json
```

Hooks are wired in `.claude/settings.json`. A PreToolUse hook that prints
`permissionDecision: "deny"` blocks the call. Note that none of these hooks
writes `process.exit()` after `console.log` — on Windows, exiting immediately
after a write drops buffered pipe output, which would silently disable the deny.

---

## Output conventions every script shares

- **Terse for agents, prose for humans, automatically.** `outputMode()` in
  `lib.mjs` checks `process.stdout.isTTY`. A pipe (which is what a tool call
  gets) produces compact `key=value` records; a terminal gets sentences.
  `--verbose` / `--quiet` override. **Never pass `--verbose` from a tool call.**
- `--json` where supported, for machine consumption.
- Exit codes are meaningful: `0` ok, `1` a real failure, `2` usage/missing input,
  `3` ATS needs a human (`fill-plan`), `4` no lead matched (`new-job`).
- Every script ends with the same `isMain` guard so it can be imported by tests
  without running:
  ```js
  const isMain =
    process.argv[1] &&
    import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
  ```
