# Commands

Every deterministic script, by domain. **Split out of `CLAUDE.md` on
2026-07-31 (R6).** It lived there because it is genuinely useful; it moved
because every agent read all 196 lines of it at session start to use two or
three of them, and that orientation tax was measured as the largest avoidable
line item in a twelve-agent wave.

`CLAUDE.md` keeps the index. This file keeps the detail. If you are looking
for what a script _guarantees_ rather than how to call it, the domain files
(`03-leads.md`, `04-documents.md`, `05-apply.md`, `06-record-and-feedback.md`)
go deeper than either.

- Tests: `npm test` — the **count-asserting gate**, not a bare `node --test`.
  It expands directories itself, asserts the test count against a floor in
  `package.json`'s `testGate` block, caps `todo` at 0, and fails any skip that
  carries no reason — because `node --test` exits 0 on an empty run, so an exit
  code alone is not evidence that anything ran.
  `npm run test:security` is the same gate over the Phase 1 security set;
  `npm run verify` runs verify-claims (it pointed at a path that moved in the
  2026-07-29 reorg and did nothing at all until 2026-07-31).
  See the testing rule in Workflow below.
- `npm run reap` — the **scaffolding reaper**: fails the build when a
  development-only artifact outlives the phase it promised to leave in.
  Declarations sit in the file's leading frontmatter (`.md`) or leading `//`
  comment block (`.mjs`), and **every key must be at column 0** — `scaffolding:`
  indented is a nested key and is ignored on purpose, which is what lets a file
  show the convention as an example without flagging itself. Three keys:
  `scaffolding: true`, `remove_after: phase-N` (naming a phase in
  `package.json`'s `phases.order`; a typo'd phase fails rather than never
  expiring), and optional `owner:` — omitted, the report reads `UNASSIGNED`.
  Permanent artifacts omit all three. `npm run reap -- --self-test` proves the
  checker can still go red (5 cases, 3 of them expected failures).
- Verify a tailored doc: `node scripts/documents/verify-claims.mjs <resume|cover-letter> <file> [--job jobs/<slug>/job.json]`
- New job workspace: `node scripts/documents/new-job.mjs <slug> --company "X" --title "Y" [--url Z]`
  — or, preferred when the posting is already a stored lead,
  `node scripts/documents/new-job.mjs <slug> --from-lead <url|lead-id>`, which
  fills company/title/location/description from `leads.db` instead of having a
  model re-read the page. Prints `description=<chars>|missing`; exits **4** when
  no lead matches, which is the caller's cue to read the page instead.
- Save an answer: `node scripts/profile/save-answer.mjs "<question>" "<answer>" [--source user|model] [--replace]`
  — `--source model` records a form pick the agent chose and the user approved
  (default is `user`). `--replace` corrects such a pick and **refuses** to
  overwrite anything the user stated themselves.
  Exit codes: 0 saved, 1 conflict, 2 usage, **3** instruction-shaped label,
  **4** the answer looks like a government or financial identifier. There is no
  override flag for 4 by design — if a form truly needs an SSN it is the user's
  to type in the browser, because saving it would make it available to every
  future fill. Two-factor, so an honest answer is not refused: value-alone only
  for self-proving shapes (SSN grouping, IBAN mod-97, Luhn + issuer prefix);
  everything else needs the question to name it AND the answer to carry a datum.
  Details and the measured false-positive rate:
  [docs/reference/02-lib.md](docs/reference/02-lib.md).
- Build a deterministic fill plan for a scanned application form (runs
  answer-bank internally, picks the ATS adapter, writes `jobs/<slug>/fill-plan.js`,
  prints the browser bootstrap): `node scripts/apply/fill-plan.mjs <slug>`
  — prints `ready=true|false` (plus `reason=` when false): whether any model
  judgment is still needed before filling. On `ready=true` the path is
  scan → fill → hand over, with no model step in between.
- Resolve scanned application-form fields against the fact base (batch):
  `node scripts/apply/answer-bank.mjs < jobs/<slug>/scan-p1.json` (fields come from
  `.claude/skills/apply-job/scan-page.js`; never invents an answer). An answer
  saved for a question's **exact** label outranks the label rules, so a pick the
  user approved once resolves `OK` on every later application to that ATS.
- Every question the fact base cannot answer, across ALL prepped jobs, in one
  list: `node scripts/apply/pending-questions.mjs [<slug> ...] [--no-predict]`
  — `answers.yaml` is global, so asking once resolves the same field on every
  future application. Merges the defers of scanned forms and predicts what an
  unscanned job's board will ask from the remembered form shape; consent boxes
  are never listed (those stay the user's to tick in the browser).
- Can an existing tailored resume be reused for a new posting?
  `node scripts/documents/reuse-check.mjs <slug>` (recommends only; user approves reuse)
- Check application history: `node scripts/applications/check-applied.mjs "<company, title, or slug>"`
- Log a submitted application: `node scripts/applications/log-application.mjs <slug> --company "X" --title "Y"`
- Read/write the application store (list, find, stats, remove, export):
  `node scripts/applications/applications.mjs <list|find|stats|remove|export>`
- Rebuild `jobs/leads.db` from the on-disk sources (flat + idempotent, safe to
  re-run): `node scripts/maintenance/migrate.mjs`
- Board productivity audit (which swept boards actually yield reachable roles):
  `node scripts/leads/board-yield.mjs [--json]`
- Find a company's public board from its NAME (the front half of discovery):
  `node scripts/leads/find-boards.mjs --file docs/candidates/<list>.yaml [--append]`
  — probes candidate slugs against the six no-auth ATS APIs and writes
  `docs/board-candidates.yaml`. Candidate lists live in `docs/candidates/`
  (`fortune500.yaml`, `yc.yaml` built from the public yc-oss directory,
  `local-lv.yaml`). **It cannot reach Workday/iCIMS/Taleo/Phenom boards** —
  those need an opaque tenant host that no slug guess produces, and that is what
  most large employers and nearly every local Las Vegas employer uses.
- Propose NEW boards, yield-gated (never edits job-sources.yaml itself):
  `node scripts/leads/discover-boards.mjs --candidates docs/board-candidates.yaml`
- Prune `.render.html` intermediates (dry run by default):
  `node scripts/maintenance/prune-jobs.mjs [--apply]`
- Archive/restore job workspaces (files while live, rows once closed):
  `node scripts/maintenance/archive.mjs list|show <slug>|archive <slug>|archive --closed|restore <slug> [--to <dir>]|purge [--days N] [--apply] [--force]`
  — `archive --closed` only touches applications with a **recorded** closed
  outcome; `archive <slug>` is the manual path and refuses a still-live
  application without `--force`. Restore is byte-identical; PDFs are recorded
  as regenerable and rebuilt with `render-pdf.mjs`.
  — `purge` permanently deletes ARCHIVED `documents` rows whose **job posting's**
  date is older than `--days` (default: `docs/application-limits.yaml`'s
  `freshness.max_age_days`, currently 30) — never the archive date, never the
  application date. Dry run by default like `prune-jobs.mjs`; **irreversible**
  once `--apply` runs, because `documents` has no on-disk backup. Three things
  it refuses to delete: a record whose posting date cannot be resolved (checked
  on the archived job.json, then the matching lead by URL, then by exact
  company+title — an unknown date is not an old date), anything in
  `applications`, and any live `jobs/<slug>/`. It also **skips a slug whose
  application is still live** — including one with no recorded outcome at all,
  which is the normal state of a submitted application — because the age
  threshold reads the POSTING's clock while the thing being deleted is the
  tailored resume for an application that may still get a reply. `--force`
  overrides that guard but never the unresolvable-date skip.
- Apply a reviewed profile update: `node scripts/profile/apply-profile.mjs [--allow-edits] [--allow-removals]`
- Render PDF: `node scripts/documents/render-pdf.mjs <input.md> <output.pdf> [--letter]`
- Find job leads: `node scripts/leads/find-jobs.mjs search|import|list|mark ...`
  (filters through `docs/application-limits.yaml`, stores in `jobs/leads.db`;
  `search` sweeps boards in parallel — `--concurrency N`, default 8)
  — ingest runs **two gates**: `passesLimits` on the cheap list fields
  (title/location/date), then `bodyDisqualifiers` on the posting text. Between
  them, postings that survived the first gate get their description fetched
  (`--no-enrich` skips it); only survivors are fetched, so it is single digits
  of round trips, not one per posting swept.
- Backfill descriptions onto stored leads whose board list endpoint carried none
  (dry run by default, idempotent): `node scripts/leads/enrich.mjs [--apply]`
  — re-indexes keywords for every lead it fills, since keywords derive from the
  description.
- Manage swept boards: `node scripts/leads/manage-sources.mjs add|remove|verify|list`
  (prescreens on add, refuses duplicates; edits `docs/job-sources.yaml`)
- Follow-ups due: `node scripts/applications/follow-ups.mjs [--days N] [--json]`
- Record an outcome/follow-up the user reported:
  `node scripts/applications/update-application.mjs <slug-or-company> [--status s] [--followed-up]`
- Profile-gap report: `node scripts/profile/profile-gaps.mjs [--json] [--min-demand N]`
- **Qualifications you have but never recorded**:
  `node scripts/profile/keyword-coverage.mjs [--min-demand N] [--include-dismissed] [--job <job.json>] [--json]`
  — splits demanded skills into `covered` / **`ask`** / `gap`. The `ask` bucket
  is the point: demanded, NOT in the fact base, but close to something you do
  have — either `adjacent` (a hand-checked lexicon edge: React ⇒ Redux,
  Docker+nginx ⇒ Linux) or the weaker `same-area`. It prints a ready-to-run
  `save-answer.mjs` line and **never writes** — rule 2. Until a skill is
  recorded, verify-claims R6 forbids any resume from mentioning it, so an
  unrecorded skill is an invisible one.
  — Demand is counted **twice**: `required` (parsed live from each description
  with the same required-vs-nice-to-have splitter L2 uses) and `total` (from
  `lead_keywords`). Ranking is by `required`, because "you cannot apply without
  this" and "it would be nice" are different facts. Dismissed leads are excluded
  by default.
- **Per-job resume keyword plan** (run BEFORE tailoring):
  `node scripts/documents/keyword-plan.mjs <slug> [--json]`
  — writes `jobs/<slug>/keywords.json`: `must_use` (in the posting AND backed by
  the fact base — placing these invents nothing), `placement`, `ats_forms`
  (acronym _and_ expansion, since systems index one or the other),
  `title_mirror`, `density_cap`, and `blocked` (what the posting wants that the
  facts cannot back, each with the `save-answer` line that would unlock it).
- **Will an ATS read the rendered resume?**
  `node scripts/documents/ats-lint.mjs <resume.md> [--pdf <f.pdf>] [--html <f.render.html>]`
  — checks the markdown and the intermediate `.render.html` (Chrome's exact
  input) for the hazards that are invisible on the page: CSS `::marker` bullets
  that emit no text, links whose URL exists only as a PDF annotation, tables,
  images, leaked fact annotations. Also confirms the PDF has a text layer at
  all. It does **not** decode the PDF text layer — Chrome subsets fonts with
  Identity-H encoding and reading that back needs a CMap parser.
- Rank leads against the profile: `node scripts/leads/recommend.mjs [--top N]`
- Which leads to tailor ahead of time (keeps tailoring off the apply path):
  `node scripts/leads/prep-queue.mjs [--top N] [--cluster] [--json]`
- Group near-duplicate postings so one tailored resume serves several:
  `node scripts/leads/cluster.mjs [--status new|all] [--threshold 0.6] [--json]`
  — 50/50 title and stack overlap over `lead_keywords`, the same weighting
  `reuse-check.mjs` uses. Members are compared against the cluster **leader**,
  never against each other, so a cluster cannot chain its way from full-stack to
  platform engineering one hop at a time. Recommends only; the user approves
  reusing a resume across a cluster.
- **Four-stage screening** — every lead runs an ordered pipeline, cheapest
  first, stopping at the first rejection, and the stored verdict records WHICH
  layer decided (so "why did I never see this job?" is answerable):

  | Stage      | Reads                 | Decides                                                       |
  | ---------- | --------------------- | ------------------------------------------------------------- |
  | `l0` title | board list payload    | title keywords, hard/soft filter, location, freshness, salary |
  | `l1` body  | the description       | hard disqualifiers stated in the text                         |
  | `l2` fit   | the description       | can this profile do this job? **rejects** below a threshold   |
  | `l3` risk  | description + history | scam, ghost, repost, evergreen                                |

  Stages live in `scripts/leads/stages.mjs`; `l2` is `fit.mjs`, `l3` is
  `risk.mjs`. Run one in isolation with `screen.mjs --stage l2`.
  - **l2 rejects** (user decision 2026-07-29). What makes that safe: a posting
    naming fewer than `fit.min_required_terms` technologies in its REQUIRED
    section is unevaluable and can never be rejected, technologies under "nice
    to have" never count against the profile, thresholds live in
    `docs/application-limits.yaml`, and every rejection is visible in
    `gate-audit.mjs`.
  - **l3 needs reposting history**, which `dedupeLeads` used to destroy: a
    re-posted job arrives with a new board id, matched an existing lead on
    company+title, and was silently dropped. It now returns those sightings and
    ingest records `repost_count` on the stored lead.

- **Gate audit — run after ANY gate change**: `node scripts/leads/gate-audit.mjs [--json] [--no-save]`
  — re-runs every stage over the whole store and diffs against the last run.
  Newly REJECTED leads are listed in full every time (a job you never see is the
  worst failure here); exits 1 when there are any. This is the mechanical form
  of the "re-run the gate over the live store and check the reject list did not
  grow" discipline the body-gate gotcha below demands.
- Mechanical ghost/scam screen: `node scripts/leads/screen.mjs [--status new] [--skip-screened] [--no-record] [--stage l0|l1|l2|l3|all]`
  — records its verdicts to the `screens` table as `source: mechanical`.
  `--skip-screened` leaves out leads that already carry a **model** verdict.
- Record a model screening verdict (the expensive judgment pass, so it is never
  paid for twice): `node scripts/leads/screen.mjs record <lead-id> --verdict pass|caution|reject [--reason "..."] [--signals a,b]`
- Whole-pipeline digest: `node scripts/status.mjs`
  — includes the **auto section** (Phase 4.2): submissions in 24h, deferrals by
  typed `reason_kind` and by class, orphan count, queue depth and age p95,
  paused boards with the jobs they hold, `posted_at → submitted_at` p50/p95,
  STOP state, and a WARN per thing a human should look at.
  `--cadence-hours H` sets the staleness threshold; `--db` / `--stop-path` aim
  it at a fixture instead of the real store.
- Campaign benchmark (Phase 4.7): `node scripts/dev/bench-runner.mjs --apps 50 --concurrency 8 --board greenhouse,honest-greenhouse --runs 3 [--json|--ledger]`
  — N applications at concurrency C against the loopback fixture only, never an
  employer. Reports nine columns, each labelled `measured`/`derived`/`unmeasured`.
  It **re-execs itself** with `scripts/dev/spawn-counter.cjs` preloaded; that is
  not optional, and the reason is in that file's header. `--json` and `--ledger`
  refuse a dirty `MEASURED_FILES` tree (`--allow-dirty` to override, and say so
  wherever the number lands).
- Performance gate (Phase 4.8): `node .github/workflows/perf-gate.mjs [--update|--json]`
  — runs the above and compares five columns against `docs/perf-baseline.json`.
  `--update` re-takes the baseline. A PR body line `perf-budget: <col> +N`
  clears `sleep_ms` and `round_trips`; **`model_turns` has no override.**
- All scripts print compact output to agents (non-TTY) and prose to humans;
  `--verbose` / `--quiet` override, `--json` where supported.
