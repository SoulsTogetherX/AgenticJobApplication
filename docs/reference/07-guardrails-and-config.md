# 07 — Guardrails, skills, agents, and every config file

---

## The hooks — how the guardrails are actually enforced

Wired in `.claude/settings.json`:

| event       | matcher                     | hook                               | enforces                    |
| ----------- | --------------------------- | ---------------------------------- | --------------------------- |
| PreToolUse  | `Edit\|Write\|NotebookEdit` | `.claude/hooks/protect-profile.js` | the fact base is user-owned |
| PreToolUse  | `Edit\|Write\|NotebookEdit` | `scripts/hooks/guard-files.mjs`    | filesystem boundary         |
| PreToolUse  | `Bash\|PowerShell`          | `scripts/hooks/guard-bash.mjs`     | git: `dev` branch only      |
| PostToolUse | `Edit\|Write\|NotebookEdit` | `scripts/hooks/prettify.mjs`       | formatting                  |

All four share one non-obvious rule, stated in every file:

> **No `process.exit()` after writing.** On Windows, exiting immediately after
> `console.log` drops buffered pipe output — which for a deny hook silently disables
> the deny.

They also all strip a UTF-8 BOM before `JSON.parse`, because PowerShell pipes add
one and a parse failure would fail open.

### `.claude/hooks/protect-profile.js` (41 lines)

Denies Edit/Write to:

```
/profile/profile.yaml      /profile/answers.yaml
/profile/applications.yaml /profile/source/
/.claude/hooks/
```

The agent's only sanctioned write path into the fact base is `save-answer.mjs`.

**What it does not protect, and this is important:** `scripts/hooks/` and
`.claude/settings.json`. CLAUDE.md documents the first half honestly. The
consequence is that three of the four guard scripts, and the file that wires all
four up, are editable by the agent. See AUDIT **M2**.

Its patterns also all require a leading `/`, so a relative path fails open — AUDIT
**M4**.

### `scripts/hooks/guard-files.mjs` (60 lines)

Denies any write **outside the project directory**, with three exceptions: the OS
temp dir, Claude's own session-memory dir (`~/.claude/projects/*/memory/`), and
`~/.claude/plans/` (without which the plan-approval dialog renders empty).

File creation and removal **inside** the project is allowed (user decision,
2026-07-27) — interactive development needs it. The job-application flows are
restricted to `jobs/<slug>/` by their **skill instructions**, not here.

Note it correctly resolves relative paths against `input.cwd` before comparing —
which is what `protect-profile.js` should also do.

### `scripts/hooks/guard-bash.mjs` (94 lines)

Hard rule 7: only `dev`. It denies

- switching to or creating any branch that is not `dev`;
- `git branch` create/delete/rename for anything but `dev`;
- `git push … main|master`, always — the ref check is scoped to the push clause
  (`[^;&|]*`) so the word "main" in a commit message does not false-positive;
- any state-changing git command (`commit merge rebase cherry-pick revert reset am
apply tag push`) while HEAD is not on `dev`.

`currentBranch` uses `git branch --show-current`, which works even on a freshly
initialised (unborn) branch and prints empty on detached HEAD; both `rev-parse`
variants error there. An unknown branch **allows** rather than denies.

> **Defect:** it is a regex over the command string, and 5 of 7 probed bypasses were
> allowed — including `git.exe checkout main`, which matters because this is a
> Windows project. AUDIT **M3**.

### `scripts/hooks/prettify.mjs` (71 lines)

Runs prettier `--write` on every file the agent edits, for a whitelist of 13
extensions. Non-blocking: a formatting hiccup reports a `systemMessage` but never
fails the edit, and a missing prettier binary is a silent no-op.

`--ignore-path .prettierignore` is deliberate: prettier 3 defaults to inheriting
`.gitignore`, and `jobs/` is gitignored on purpose but its documents must still be
formatted.

> Because the path is relative, it depends on the hook's cwd being the repo root. If
> it is not, `.prettierignore` is not found and `scan-page.js` / `job-sources.yaml`
> get reformatted — which the CLAUDE.md gotchas say breaks both.

---

## `.claude/skills/` — the eleven entry points

A skill is a markdown instruction sheet with YAML frontmatter (`name`,
`description`). Claude Code matches the user's request against the `description`,
then loads the body as instructions for the turn.

| skill                   | lines | what it orchestrates                                                          |
| ----------------------- | ----- | ----------------------------------------------------------------------------- |
| **apply-job**           | 326   | the full browser flow: scan → plan → tailor → approve → fill → hand off       |
| **pipeline-jobs**       | 190   | batch: `prep-queue` → one `job-worker` subagent per lead → one approval round |
| **find-jobs**           | 103   | the sweep, plus the four ways to ingest a user-supplied source                |
| **tailor-resume**       | 94    | the 10-step tailoring flow, gated on verify-claims                            |
| **tailor-cover-letter** | 64    | the same, sharing `context.json`                                              |
| **manage-applications** | 137   | read/write the application store                                              |
| **manage-sources**      | 50    | add/remove/verify swept boards                                                |
| **update-profile**      | 53    | merge a replaced source doc into the profile, add-only                        |
| **check-applied**       | 40    | history lookup                                                                |
| **follow-up**           | 50    | nudge cadence and outcome recording                                           |
| **profile-gaps**        | 45    | demand-vs-profile analysis, honest recommendations only                       |

### `apply-job` — the two design rules worth internalising

1. **Batch by phase, not by field.** Scan the whole page in one call, resolve every
   answer in one call, decide in one pass, fill in one call, verify once. Never
   inspect-then-fill field by field.
2. **Spend human attention once.** The user is asked exactly **twice** per
   application: one approval message (tailoring + unknown questions + the picks made
   - reuse offer, together), and the final Submit click. Everything learnable before
     that message — including what the form actually asks — is learned first so it can
     ride along in it.

Its cost expectation is explicit: **2 browser calls per page** on a recognised ATS,
plus one click to advance. The baseline before it existed was ~30 browser calls and
~8 minutes for one Greenhouse form. The skill ends by listing the symptoms of having
left the flow (per-field calls, accessibility snapshots, re-pasting the scanner,
verifying after the engine already verified, asking questions one at a time).

The hard boundaries are stated as things the flow _cannot_ express rather than rules
it follows — never click `r:"submit"`, never click `r:"start"` on a page that already
has fields, never click `r:"auth"`, never solve a CAPTCHA, never derive a number
(years of experience, salary, notice period) that is not in the profile.

### `pipeline-jobs` — the fan-out contract

Default cap **5 jobs per run**, fanned out in **one wave** rather than waves of
three. That cap is what bounds concurrency; each `job-worker` owns exactly one
`jobs/<slug>/`, and the lead store now opens every connection willing to wait on a
busy writer (see the pragma ordering in [02-lib.md](02-lib.md)), so a barrier between
batches buys nothing but wall-clock.

**Cover letters are automatic, not asked about.** Per job, the subagent tailors one
only if the form has a cover-letter field, accepts attachments beyond the resume, or
the posting explicitly asks. Otherwise it reports `"skipped (no slot)"`. The user
never decides this per job.

Stage A's model verdict is the expensive part of the whole flow — it fetches the live
posting — so it is written down every time via `screen.mjs record`, and
`--skip-screened` never pays for it twice. **Recording the verdict and dismissing the
lead are separate**: the verdict says what was judged and why, the status says what to
do about it.

### `find-jobs` — the source ethics

Stated as hard boundaries, not preferences: only documented JSON APIs, public careers
pages, and pages the user explicitly points at. Never log in, create accounts, bypass
CAPTCHAs, or scrape sites whose ToS forbid it — **LinkedIn, Indeed and Glassdoor are
off limits**. One polite pass per site.

The LinkedIn flow is the interesting one: never fetch the URL; pull what the slug
reveals, WebSearch for the same posting on the employer's own ATS board (most
LinkedIn ads are syndicated from one), capture from that canonical source, and store
the LinkedIn URL in `notes` for provenance. If no public canonical source exists, ask
the user to paste the text.

> **Stale:** this skill's frontmatter and two body lines still say the store is
> `jobs/leads.json`. AUDIT **M16**.

---

## `.claude/agents/job-worker.md` (58 lines)

```yaml
model: sonnet
tools: Bash, Read, Write, Edit, Glob, Grep, WebFetch, WebSearch
```

The per-job worker. Job searching, screening, applying and recording outcomes do not
need a frontier model, and per-job cost is the whole point of the pipeline — so this
agent is **pinned to Sonnet**. It restates the five non-negotiable rules, the token
discipline, and a strict JSON return format: _"your reply is data for the
orchestrator, not prose for a human"_. No posting text, no document contents, no
browsing logs in the reply.

> **Defect:** rule 3 tells it to run `node scripts/verify-claims.mjs`, which does not
> exist — the file is at `scripts/documents/verify-claims.mjs`. This is the agent that
> does all per-job tailoring, so hard rule 4 does not actually run inside it. AUDIT
> **C5**. Its word limits also disagree with the same contract in
> `pipeline-jobs/SKILL.md` — AUDIT **M16**.

---

## Config files, one by one

### `package.json`

Type `module`. Dependencies are exactly two: `js-yaml` and `marked`. Dev: `prettier`.
`npm test` is `node --test`, which recurses, so nested test files are discovered
automatically.

> **Defect:** the `verify` script points at `scripts/verify-claims.mjs`. AUDIT **C5**.

### `.claude/settings.json`

The hook wiring above, plus a permissions allowlist (`npm test*`, `npm install*`,
`node scripts/*`, `node scripts/**`, `node --test*`). `deny` is empty.

`.claude/settings.local.json` (untracked) holds two allowlist entries pointing at the
pre-reorganisation `scripts/find-jobs.mjs` — dead but harmless.

### `.mcp.json`

One server: `npx -y @playwright/mcp@latest` with

- `--user-data-dir .playwright-mcp/profile` — a persistent browser profile so ATS
  logins survive between sessions instead of stalling the flow on a login wall. **It
  holds real session cookies**; gitignored, never commit it.
- `--codegen none` — suppresses the "Ran Playwright code" echo in every browser tool
  result. The executed source is already echoed into agent context whether passed
  inline or by filename, so the codegen block is pure cost.

Changing this file needs a session restart.

> **Concern:** `-y @latest` auto-installs whatever is newest, unreviewed, with access
> to that cookie-bearing profile — and this project depends on precise Playwright
> behaviours documented at length in `fill-page.js`. AUDIT **M13**.

### `.gitignore`

```
profile/*                  ← NOT profile/, deliberately
!profile/profile.example.yaml
jobs/
.env
node_modules/  *.log
.playwright-mcp/
*.pdf  *.html  !templates/*.html
```

The comment explains the first line: git never descends into a fully ignored
directory, which would make the example-file negation dead.

### `.gitattributes`

`* text=auto eol=lf`. Load-bearing: tests compare multiline JS template literals
(always LF — the spec normalises CRLF in literals) against file contents read raw
from disk, and CRLF checkouts silently break those comparisons on Windows.

### `.prettierrc` / `.prettierignore`

`{ "semi": false }`. The ignore list is `node_modules`, `package-lock.json`,
`profile/`, `jobs/*/*.pdf`, `.playwright-mcp/`, plus two documented exceptions:

- `scan.driver.mjs` and `scan-page.js` — eval'd as **bare function expressions**, not
  modules; prettier's leading-semicolon guard would make them unparseable.
- `docs/job-sources.yaml` — `manage-sources.mjs` edits it **line by line** to preserve
  its comments, which only works while every board is one flow-style entry on one
  line. Prettier reflows the longer Workday/Oracle entries into block style and
  silently breaks that contract.

### `.github/workflows/ci.yml`

`npm ci && npm test` on a matrix of ubuntu/windows × Node 20/22, on push to `dev` and
PRs to `dev`/`main`. The comment explains why a green run means something: the suite
includes guardrail failure-mode tests, so both directions (hooks must deny the right
things **and** allow the right things) behaved.

> **Gap:** it never runs `prettier --check`, and 36 files currently fail it. AUDIT
> **M7**.

### `.env.example`

Template for `.env` (gitignored): `ADZUNA_APP_ID`, `ADZUNA_APP_KEY`, optional
`ADZUNA_COUNTRY`. Never print `.env` contents into chat, docs or commits.

---

## The user-owned policy files

### `docs/application-limits.yaml` (287 lines)

**The user owns this file; the agent reads it but asks before changing it.** It is
the contract every lead, tailoring job and application must pass.

| block           | key settings                                                                                                                                                   |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `location`      | base `North Las Vegas, NV`, `relocation: false`, `remote_ok: true`, `onsite_allowed` (north las vegas / las vegas / henderson), `remote_synonyms` (20 entries) |
| `freshness`     | `max_age_days: 30`                                                                                                                                             |
| `compensation`  | `min_salary: null` (gate off), `flag_missing: true`                                                                                                            |
| `experience`    | `stretch_years: 2`; `max_years_required` commented out                                                                                                         |
| `fit`           | `min_required_terms: 4`, `reject_below: 0.2`, `caution_below: 0.45`, `senior_phrase_reject: 3`                                                                 |
| `ghost_signals` | `repost_age_days: 30`                                                                                                                                          |
| `roles`         | `title_keywords` (17), `hard_filter` (43), `soft_filter` (68)                                                                                                  |

The comments are the valuable part, because they record the evidence behind each
number. The seniority hard-filter list is not guesswork — it comes from the stated
minimums in the 47 postings read on 2026-07-28: Senior/Sr. 4–10 yrs (median 5–6, the
lowest bar seen all day was 4+), Staff 7–12, Principal 8–12, Lead/Manager 6–8 +
people leadership, Architect 4+ and a certification. Against ~2.5 years, none is
reachable — which is why every one of those 47 leads was rejected, and why filtering
them at ingest is what stops the pipeline paying to read them again.

`soft_filter` records the titles that proved **misleading**: the motivating case is
Chainguard's "Software Engineer (Libraries Platform)", which carried no seniority word
at all yet the body said "join as a Senior Software Engineer" and asked for 5+ years.

> Two things to know: `employment.reject_types` is **absent**, which disables the
> contract/temp gate (AUDIT **H6**); and `title_keywords` is broader than CLAUDE.md's
> "Full-Stack and Back-End" claim — it also admits front-end and game roles (AUDIT
> **M16**).

### `docs/job-sources.yaml` (81 lines)

44 board entries in one-line flow style, plus a commented FORMAT RULE explaining why.
Composition: 24 greenhouse, 7 ashby, 3 workday, 2 lever, 2 smartrecruiters, 2
oracle_cloud, 1 jobvite, 1 successfactors, 1 jobicy, with remotive and remoteok
commented out (they measured 0 kept).

The mix is deliberate: national tech boards for remote roles, plus the **local Las
Vegas employers** (Boyd, MGM, Caesars, Station Casinos, Wynn, IGT, AGS, Light &
Wonder, Aristocrat, Allegiant) because on-site is in scope for them.

### `docs/candidates/` + `docs/board-candidates.yaml`

Input and output of the board-discovery front half: `fortune500.yaml` (146 lines),
`yc.yaml` (637, built from the public yc-oss directory), `local-lv.yaml` (64).
`board-candidates.yaml` (872) is what `find-boards.mjs` wrote — probe results waiting
for `discover-boards.mjs` to yield-gate them.

### `docs/improvement-plan.md` (429) and `docs/next-session-plan.md` (262)

Working documents: proposals, measurements and session hand-offs. Not contracts —
`improvement-plan.md` is where the DOCX-renderer proposal lives, which is why
`scripts/documents/render-docx.mjs` shows up in a path scan without existing.

### `README.md`

The public-facing summary: design principles, layout, setup, usage. Accurate except
that its layered-guardrails list still cites `scripts/verify-claims.mjs`.

### `CLAUDE.md` (429 lines)

The project's own operating manual, loaded into every session: commands, the ten hard
rules, structure, the code-change workflow, token discipline, and a long **Gotchas**
section. It is unusually good — most of the "why" in this reference is distilled from
it and from the source comments.

Two of its claims are no longer true: that Adzuna leads are "already flagged
`partial_description`" (nothing sets that field at ingest), and that
`title_keywords` is limited to full-stack and back-end. See AUDIT **H5**, **M16**.
