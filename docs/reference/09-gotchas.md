# 09 — Gotchas: the incident record

Every entry here exists because something broke. They were in `CLAUDE.md` until
2026-07-31, when they moved out so the file re-read on every turn of every
session got shorter (rewrite backlog **R6**). `CLAUDE.md` keeps a one-line
pointer to each; this file keeps the full account.

**Do not tidy these away.** A paragraph saying "this broke the fill step on a
live application" or "six false positives in nine probes" is a regression guard
written in prose. Correct one that has become false; never delete one that
records a failure that actually happened.

---

## Environment

### PDF rendering shells out to a local browser

Windows machine; `render-pdf.mjs` drives local Edge/Chrome headless. The
`PDF_BROWSER` env var overrides the browser path.

### `node --test <directory>` no longer recurses on Node 24

It tries to load the directory **as a module** and reports `Cannot find module`,
which _looks like a test failure_:

```
$ node --test tests/security/
Error: Cannot find module '...\tests\security'
tests 1   fail 1
```

The plan's own Phase 1 gate command was written that way and therefore ran
**zero** security tests. The obvious "fix" — dropping the directory argument —
would have produced a green run over nothing at all, which is the exact failure
mode `docs/agent-protocol.md` lists first under **In CI**.

Node 20 and 22 _do_ recurse, so the same command means different things across
the CI matrix. Always use the quoted glob:

```bash
node --test "tests/security/**/*.test.mjs"
```

`npm test` and `npm run test:security` go through
`.github/workflows/test-gate.mjs`, which expands directories itself, so they are
not affected — this bites hand-written `node --test` invocations.

### The Playwright MCP browser profile holds real session cookies

`--user-data-dir .playwright-mcp/profile` in `.mcp.json` keeps ATS logins alive
between sessions. It is gitignored; never commit it. Changing `.mcp.json` needs
a session restart to take effect.

### `profile/` and `jobs/` are gitignored on purpose

Personal data. Tests use fixtures in `tests/fixtures/`, never the real profile.

### `profile.yaml` `meta.approved_by_user` must be `true`

Before tailoring for real applications. If it is false, warn the user first.

---

## Lead ingest and the gates

### Not every board's list endpoint returns a description

Greenhouse, Ashby and Lever include one; `oracle_cloud`, `smartrecruiters`,
`successfactors` and `workday` return none, and Adzuna returns a ~500-char
teaser. **That teaser is not flagged at ingest** — nothing sets
`partial_description` there; `screen.mjs` computes it at screen time from
`!captured?.description`, which is a different question and, per AUDIT **H5**,
true for nearly every lead. Do not rely on the flag to tell you a description is
a teaser. Those four boards need a per-posting
detail fetch — `scripts/leads/enrich.mjs`, one fetcher per ATS, URLs derived
from the lead's own `url`/`id` rather than from `job-sources.yaml`.

This mattered more than the count suggests: those boards are Caesars, Station
Casinos, Boyd, IGT and CVS, i.e. the **local Las Vegas employers**, which are
the highest-value leads because on-site is in scope for them — so the least
examinable leads were also the most important. A lead with no description can be
neither keyword-indexed nor blocker-screened.

### The body gate's "is this a software job?" test is easy to get wrong

Job-posting prose is full of near-misses for software words: the first version
matched bare `code` and read "Be familiar with OSHA safety **codes**" as
evidence that a building-maintenance job was a software job. `application` (job
application), `rest` (the rest of the team), `framework` (regulatory framework),
`library` and `server` all fail the same way.

`SOFTWARE_BODY` in `find-jobs.mjs` therefore only contains multi-word or
unmistakable terms, and `NON_SOFTWARE_BODY` says "maintain cleanliness" not
"cleanliness" (code cleanliness) and "beverage server" not "server". When adding
a term, re-run the gate over the whole live store and check the reject list did
not grow — `gate-audit.mjs` is the mechanical form of that discipline.

### The body gate rejects only on unambiguous evidence and flags everything else

Because a false reject is a job the user never sees. Twilio's postings are the
reason: one carries three contradictory location sentences pasted in sequence
("based in our San Francisco office" / "remote, based on the East Coast" / "not
eligible to be hired in CA, CT, IL…"), so in-office language only ever produces
an `onsite_conflict` flag. A state carve-out is decisive only when it names the
user's own state.

### Slug probing can find the wrong company

`find-boards.mjs` tries "spring" for "Spring Mobile" and "ultimate" for
"Ultimate Fighting Championship"; a board with that slug may belong to someone
else entirely. This is contained because `discover-boards.mjs` reports the
company and live counts, and the user approves each addition — never auto-add.

### `textSnippet` preserves block boundaries

It used to collapse every run of whitespace including newlines, so a Greenhouse
body arrived as one 4,000-character line and the L2 fit stage found a
requirements heading in **0 of 92** stored leads. Block-level tags now become
newlines; inline markup still collapses to a space. Section splitting in
`fit.mjs` also matches headings INLINE, because leads stored before this change
are still flat.

---

## The keyword lexicon

### `lead_keywords` goes stale the moment the lexicon changes

It is indexed once at ingest, so a skill added to `keywords.mjs` afterwards has
zero rows however often postings demand it. Re-index with
`node scripts/maintenance/migrate.mjs` — it only ADDS leads that are missing and
rebuilds keywords from what is already in the database, so it is safe on a live
store (268 → 443 links after the lexicon was unified, 0 leads touched).

Anything ranking on those counts should gate on `max(required, total)`, not
`total`: `keyword-coverage.mjs` dropped System design at a required-demand of 8
because the index predated the term.

### One lexicon, two name fields, and they are not interchangeable

`scripts/lib/keywords.mjs` is the single source for "what technology is named
here?". Each skill carries `surface` (literal strings watched inside the USER'S
OWN documents — drives verify-claims R6) and `aliases` (what the skill looks
like in SOMEONE ELSE'S posting — drives `lead_keywords`).

Folding `surface` into the detection regex was tried and matched "we **go** to
production", "**Spring** 2027 internship", "a **bun** and coffee", "Section
**S3** of the handbook" — **six false positives in nine probes**. A
negative-corpus test (`tests/lib/keywords.test.mjs`) pins this down; add to it
whenever you add an alias.

### One written form per skill

`checkWrittenForm()` in `keywords.mjs` catches "Javascript"/"NodeJS"/"Postgres"
and acronyms used without their expansion ("AWS" but never "Amazon Web
Services"). It excludes URLs and emails — "github.com" is correct lowercase —
and the pair list is deliberately short: a first draft flagged API/SQL/UI/UX and
produced eight warnings on a good resume, and a checker that cries wolf gets
ignored.

---

## Evidence and the fact base

### `answers.yaml` question text is NOT evidence

It stores each application form question beside its answer, and forms ask things
like "which of these do you have? [4 = Spring / Spring Boot; 5 = Cloud (AWS,
Azure, or GCP)]". Using the raw file as the verifier corpus made **Azure,
Spring, Java and GCP** all pass R6 — including Spring, which the user explicitly
did not select.

Use `evidenceText()` in `lib.mjs`: an answer always counts, a question only
counts when the answer is an unambiguous yes, and a question evidences only the
clause actually asked (up to the first `?`) — otherwise "Authorized to work in
the US? This role uses Kubernetes." answered `Yes` whitelisted Kubernetes
forever.

### A fuzzy-matched yes/no answer can find the right CONCEPT and still return the wrong TRUTH VALUE

`answer-bank.mjs`'s `CONCEPTS` guard stops a question being answered out of the
wrong bucket, but a label can name the right concept and still negate it. Ramp
asks "are you authorized to work in the U.S. **without** company sponsorship?";
that shares nearly every token with the banked "Will you now or in the future
require sponsorship?" → `No`, so the matcher copied `No` verbatim at 0.75 and
reported **OK** — asserting the opposite of the truth on the highest-stakes
field on the form.

The polarity guard (`NEGATION_RE` / `isNegated` / `polarityMismatch`, just above
`resolve`) compares negation between the field label and the matched bank
question; a mismatch on a yes/no-shaped answer defers to `NEEDS-CHOICE`. It
never auto-inverts — a double negative would flip straight back, so deferring is
strictly preferred. This guards the FUZZY tier only; saving an exact-label
answer (`save-answer.mjs`) still resolves `OK` and is the permanent fix.

---

## The browser path

### The bootstrap loads by `filename`, never `addScriptTag`

`page.addScriptTag({ path })` injects a real inline `<script>`, which a
nonce-based CSP board (Ashby) refuses outright — **this broke the fill step on a
live application.** Page-side injection therefore goes through
`page.evaluate((s) => { (0, eval)(s) }, s)`, which drives the page over CDP
(`Runtime.evaluate`) and is not gated by the page's CSP the way a `<script>` tag
is — the same reason DevTools can run code on a CSP-locked page. Confirmed live
on Greenhouse and Ashby. **Do not "fix" this back to `addScriptTag`.**

`fill-plan.mjs`'s `buildDriverSource()` reads the engine text off disk itself
(`engineSandboxSource()` in `scripts/apply/browser.mjs`, from
`scripts/apply/fill-engine.mjs`) and embeds the engine and the plan as strings
into `jobs/<slug>/fill-plan.js`, loaded via `browser_run_code_unsafe
{ filename }`.

Related: that vm context can never use dynamic `import()` — playwright-core's
`runCode.ts` calls `vm.runInContext` with no `importModuleDynamically` callback,
so `await import("node:fs")` throws `ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING` —
and `require` is undefined. File reads for the browser side must happen in
ordinary Node, never inside the injected driver.

### The fill engine runs Playwright-side and never enters the page

`scripts/apply/fill-engine.mjs` is an ordinary ES module whose every statement is
a Playwright call. The generated bootstrap `eval`s its text host-side and calls
`runFill(page, PLAN)`; the plan travels as an argument, not through `window`.

The version this replaced stringified itself into `window.__ajFillSrc`, and the
bootstrap read that value **back out of the page** and eval'd it where `page`
lives. A job-application page is third-party content, so any script on it that
defined `__ajFillSrc` as a getter chose what ran with a live `page` handle — it
could navigate, read everything already filled in, `setInputFiles` the user's
`.env` into its own form, and click Submit. Values that come back from the page
are DATA and are only ever read as data: never eval'd, never dispatched on.

The scanner is the one thing that genuinely must run in the page, and it goes in
over CDP as above, from text read off our own disk.

### Non-upload fills retry once on a stale/detached locator

Ashby's resume-autofill remounts the form ASYNCHRONOUSLY, after the upload
settle delay, so the remount can land between `locate()` and the interaction
that follows — a live run logged `f3` as failed while its value had in fact
landed. `fill-engine.mjs`'s loop (`actOn` / `isStaleError`) re-resolves and
replays that one item once before recording a failure; safe because
fill/select/check are idempotent.

### The scan is not read back out of the page either

`window.__ajLastScan` was written into the page and read back out to produce
`scan-p1.json`. It is data rather than code, so the RCE fix did not cover it —
but a getter on that global returns whatever the board likes, including a
`labelExact` vouch on wording nobody approved. Every vouch is now stripped from
the stashed copy: the page-visible scan can never carry one.

Relatedly, `scan-engine.mjs` used to ask the page whether `window.__ajScan` was
already a function and skip installing when it was. A board defining that global
was therefore "ready", the real scanner never loaded, and the board supplied the
whole scan. The scanner now installs unconditionally and is called through a
local binding, never through the global. The check saved about 1ms.

`scan.driver.mjs` — the MCP path — **cannot** be fixed the same way, and it is
worth knowing which file you are reading. That driver runs inside
`browser_run_code_unsafe`'s vm, which has no `fs`, so it has no scanner text to
install and no local binding to call: it must go through `window.__ajScan` and
cannot know whose function answered. So it does the only thing left — records
whether the global was pre-owned, strips every `labelExact` off the scan
Playwright-side, and appends a `scan not vouched` signal. Reading the
unconditional-install rule as covering both files is the mistake; only
`scan-engine.mjs` gets the strong version.

### A checkbox or radio group never auto-acts unattended

A `datum` classification licenses filling a **text field**. It says nothing
about whether ticking a control the **board** owns is safe with nobody watching,
because a checkbox or radio group is an act rather than a value — the fact that
the answer bank could answer the underlying question is not a licence to perform
the act.

This was measured, not reasoned about. Against the real 49-entry fact base, on a
page where every label and option was wording the user had banked verbatim
(Country, Gender, Veteran Status — all classified `datum`), **all 34 non-CONFIRM
check-verb fields auto-ticked** before the guard landed. Now 0.

So `buildPlan`'s check-verb branch defers **every** check-verb resolution,
whatever `r.status` and whatever the class said, and with no exemption for a
group offering only two or three options: a hostile board defeats an
option-count exemption by adding decoy options to the one box it cares about,
which is the same one-line bypass the class gate alone had.

**The marker is `why: "confirm-widget"`, and it is a different string from the
class gate's `why: "confirm"` on purpose.** An earlier draft of the readiness
exemption keyed on `why === "confirm"` — the marker `resolveFields()` stamps on
an assertion-class bank answer it stopped short of auto-acting on — and that
re-marked a page whose only defer was an **unreviewed work-authorisation
assertion** as `ready: true`. Do not merge the two markers.

`readiness()` exempts a `confirm-widget` defer only when the form itself does
**not** mark the field required (`d.why === "confirm-widget" && !d.req`), on the
same reasoning as a consent box: it sits there unticked on a form the user is
already looking at, at zero extra model turns. A **required** `confirm-widget`
defer is not rescued — the form insists on an answer and nobody has reviewed
one, so it blocks like any other unresolved required field. `submitReadiness()`
is blocked by both kinds, as it is by every defer.

---

## Files with formatting contracts

### `scan-page.js` and `scan.driver.mjs` are eval'd as bare function expressions

Not modules — so they are in `.prettierignore`, because prettier's
leading-semicolon guard would make them unparseable. `scan-page.js` is the
single source of truth; the driver loads it off disk.

### `docs/job-sources.yaml` is also in `.prettierignore`, for a different reason

`manage-sources.mjs` edits it LINE BY LINE to preserve its comments, which only
works while every board is one flow-style entry on one line. Prettier reflows
the longer `workday`/`oracle_cloud` entries into block style and silently breaks
that contract.

### The `SCHEMA` string in `scripts/lib/db.mjs` is a template literal

A backtick anywhere in its SQL comments ends the string and the file stops
parsing. Quote identifiers in those comments with plain words, not backticks.

---

## The database

### `openDb` sets `PRAGMA busy_timeout` BEFORE `journal_mode = WAL`

The order is load-bearing: switching the journal mode takes a brief exclusive
lock, so with the pragmas the other way round, **four processes opening the
store at once have three die** on the WAL statement itself — before the timeout
they were about to set could apply. This is what makes the pipeline's subagent
fan-out safe. Do not reorder these two lines.
