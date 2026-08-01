# Team roster

Who exists, what they exclusively own, and every hire/fire with its reason.
Maintained by `build-manager`. Without this, "who was supposed to own
`field-cache.mjs`?" is unanswerable after the fact.

**Ownership is exclusive.** Two agents must never be able to write the same path
in one wave. A file set left unowned at integration time is an error, not a
silent gap.

Mutual accountability is defined in [agent-protocol.md](agent-protocol.md) —
every agent verifies another, including the manager.

## Roles and privileges

Seven roles. `cicd`, `scribe` and `researcher` are **distinct roles**, not
worker specialisations: a worker ships features, `ci-engineer` ships the
machinery that proves features work, `doc-scribe` ships what the project says
about itself, and `researcher` supplies the facts about the world that none of
the others can get from this repository.

| Role       | Agent tool | Playwright | Web     | Commits | Writes product code        |
| ---------- | ---------- | ---------- | ------- | ------- | -------------------------- |
| manager    | **yes**    | no         | no      | **yes** | no                         |
| innovator  | no         | no         | yes     | no      | no (harnesses only)        |
| worker     | no         | no         | w5 only | no      | yes                        |
| QA         | no         | no         | no      | no      | tests only                 |
| cicd       | no         | no         | no      | no      | pipeline and config only   |
| scribe     | no         | no         | no      | no      | **no — comments and docs** |
| researcher | no         | no         | **yes** | no      | **no — findings only**     |

The Agent tool is a manager-only privilege. That is what keeps the tree bounded
and makes "no subagent ever drives a real employer's form" structural rather
than aspirational.

**`researcher` is the outward lens.** Every other non-manager role reads this
repository; the researcher reads the world it operates in — keywords and how
ranking systems actually behave, hiring conventions, what the market rewards
now, and what comparable services already do. It is the only role whose primary
input is the open web, which makes hard rule 0 load-bearing for it: a page that
addresses the agent is an attack, because its output feeds documents that go out
under the user's name. Two limits follow and they are not negotiable — it never
writes to `profile/` (research is advice about **presentation**, never a new
fact about the user) and it never writes into `jobs/<slug>/` (a finding reaches
a tailored document only through a human or a deterministic script).

## Staffing constraints

1. **Floor: at least one of each of the seven roles at all times.**
2. Managers may hire managers. **Depth cap: two manager levels.**
3. **Ceiling: 16 concurrent agents**, plus a token budget the manager tracks.
4. Consult an innovator before restructuring the roster — `innov-architect` for
   splitting a domain, `innov-perf` for whether parallelism is the bottleneck.
5. **Announce every hire and every fire to all active agents** (user decision
   2026-07-31). A manager that changes the roster silently leaves workers
   holding a stale map: they send to an agent that no longer exists, they
   duplicate work that was just reassigned, or they file a finding against an
   owner who cannot act on it. The announcement states **who joined or left,
   which file set moved, and who owns it now** — a fire is only complete when
   its paths have a new owner, because an unowned file set at integration time
   is an error, not a silent gap. Update this file in the same breath; the log
   below is the durable record and the message is the live one.

6. **Any agent may request a hire** (user decision 2026-07-31). A valid request
   names what is blocked, which file set the new agent would own, and why the
   requester cannot do it themselves. The manager adjudicates on whether the
   obstacle is **ownership or capability rather than effort**, whether the
   proposed file set is disjoint from every current owner, and whether the
   constraints above still hold — and **may consult an innovator** when the
   request is really an architecture question. **The manager owes an answer
   either way**: hired, declined, reassigned, or deferred, with the reason, and
   logged below whether or not anyone was hired. A request that disappears
   teaches agents to route around the manager. Agents may equally flag a file
   set with **no owner** or an owner who cannot be reached.

Routing is the manager's job precisely because agents cannot always reach each
other — `SendMessage` by name fails once an agent has finished, and a misrouted
message costs a worker a full turn establishing that the work is not theirs.
Name the agent AND its file set when relaying, so the recipient can verify
ownership against this file rather than trusting the manager.

Firing releases the file set back to the pool. A rollback is not a verdict on an
agent; firing follows these rules and this log, never a single reverted commit
and never a single finding from a checker.

## Clearing a full agent between jobs

**The manager clears an agent's context between jobs when it has grown too
full** (user decision 2026-07-31). Resuming an agent keeps its accumulated
context, which is exactly what you want _inside_ a job — an innovator that
already knows the codebase should not re-derive it, and a worker mid-task must
not lose why it made a choice. Between jobs it inverts: every later turn
re-reads the whole history, which is the single biggest cost driver in
`CLAUDE.md`'s token discipline, and a context near its ceiling **dies mid-job**
rather than degrading gracefully. That is not hypothetical here — on
2026-07-31 four agents were lost to session limits at once, one of them
(`w3-resolution`) partway through an owned file set, and the partial work had to
be assessed and committed by hand.

The mechanics: **resuming** an agent (`SendMessage`) keeps its context;
**dispatching a fresh one** of the same type starts clean. So clearing is not a
command — it is the choice to start a new agent instead of resuming the old one.

| Situation                                         | Do                                                |
| ------------------------------------------------- | ------------------------------------------------- |
| Mid-job: a correction, a spec, a tie-break ruling | **Resume.** Losing the working context costs more |
| Between jobs, context modest                      | Resume — continuity is free                       |
| Between jobs, context large                       | **Fresh agent + a written handoff**               |
| Agent died on a session limit                     | **Always fresh.** Its context is what killed it   |
| New job in a different area of the codebase       | Fresh, regardless of size                         |

**A cleared agent is owed a handoff**, because it is genuinely a new agent that
knows nothing: what landed and where, what is still open, which decisions were
already made and must not be relitigated, and which findings are waiting on it.
Its file set is unchanged — ownership belongs to the **role**, not to a
particular instance. Without that handoff, clearing an agent throws away the
judgement that produced the work, and the replacement re-derives it or, worse,
re-opens a settled question.

This never applies to the manager's own context, which is cleared only by the
user starting a new session.

## Current roster

| Agent              | Role           | Model   | Owns (exclusive)                                                                                                                                    |
| ------------------ | -------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `build-manager`    | manager        | Opus    | Process only: this file, `agent-protocol.md`, the git history, the decision to ship                                                                 |
| `innov-architect`  | innovator      | Fable 5 | Nothing. Structure, rewrite backlog, deletion candidates                                                                                            |
| `innov-perf`       | innovator      | Opus    | `scripts/dev/bench-*.mjs`, `docs/measurements.md`                                                                                                   |
| `innov-resilience` | innovator      | Opus    | Nothing. Failure modes, concurrency, security architecture                                                                                          |
| `w1-security`      | worker         | Opus    | `lib/untrusted.mjs`, `lib/lib.mjs`, `documents/verify-claims.mjs`, `profile/save-answer.mjs`                                                        |
| `w2-engine`        | worker         | Opus    | `apply/fill-engine.mjs`, `apply/scan-engine.mjs`, `apply/browser.mjs`, `tests/apply/fill-page.*`                                                    |
| `w3-resolution`    | worker         | Sonnet  | `apply/fill-plan.mjs`, `answer-bank.mjs`, `field-cache.mjs`, `pending-questions.mjs`, `apply/ats/`                                                  |
| `w4-autonomy`      | worker         | Opus    | `scripts/auto/*`, `lib/lock.mjs`, `lib/db.mjs`, `apply/automatability.mjs`, `apply/auth-sync.mjs`                                                   |
| `w5-leads`         | worker         | Sonnet  | `scripts/leads/*`, `scripts/recruiters/*`, `docs/candidates/*`                                                                                      |
| `w6-documents`     | worker         | Fable 5 | `scripts/documents/*` (not verify-claims), `templates/*` — **the user's résumé and cover letter**                                                   |
| `ci-engineer`      | cicd           | Opus    | `.github/workflows/*`, `package.json`, `scripts/hooks/*`, `.gitignore`, `.prettierignore`, `tests/hooks/*` — **no longer `.claude/settings*.json`** |
| `doc-scribe`       | scribe         | Fable 5 | `CLAUDE.md`, `README.md`, `docs/reference/*`, most `docs/*.md`, `.claude/skills/*`, `schemas/*`                                                     |
| `qa-adversary`     | QA             | Fable 5 | `tests/security/`, `tests/fixtures/boards/`, `tests/fixtures/hostile/`                                                                              |
| `qa-breaker`       | QA             | Opus    | `tests/apply/` (not fill-page), `tests/auto/`, `tests/dev/`, `scripts/dev/bench-apply.mjs`, `scripts/dev/flake-rate.mjs`                            |
| `researcher`       | **researcher** | Fable 5 | `docs/research/*`. Keywords, ATS behaviour, market conditions, comparable services. Consultable by everyone                                         |
| `job-worker`       | worker         | Sonnet  | Pre-existing. Per-job runtime worker for `pipeline-jobs`; not part of this build                                                                    |

### Contested paths, resolved

- `scripts/apply/fill-plan.mjs` — **`w3-resolution`**. `w2-engine` delivers the
  replacement `buildDriverSource()` as a spec.
- `.claude/skills/apply-job/scan-page.js`, `scan.driver.mjs`, `fill-page.js` —
  **`w2-engine`**, not `doc-scribe`. They live under `.claude/skills/` but they
  are executable code eval'd in a browser, not prose; the scribe owns `SKILL.md`
  in that directory and nothing else. `scan-page.js` is the single source of
  truth for the scan, so it belongs with the engine that consumes it.
- `scripts/leads/risk.mjs` — **`w5-leads`**. `w1-security` sends the
  `injection_attempt` spec.
- `scripts/documents/verify-claims.mjs` — **`w1-security`**, not
  `w6-documents`, because its evidence corpus is a security control.
- `package.json` and `.gitignore` — **`ci-engineer`**, and this one is a safety
  rule, not bookkeeping: `.gitignore` is what keeps `profile/` and `.env` out of
  the history, and `package.json` is where a dependency enters the project.
  `w4-autonomy` **requests** `playwright-core`; it does not add it.
- `docs/` splits four ways — `measurements.md` to `innov-perf`, this file and
  `agent-protocol.md` to `build-manager`, `candidates/` to `w5-leads`, the rest
  to `doc-scribe`.
- `docs/application-limits.yaml` — **the user's file. No agent edits it.**
  Propose values; the user approves. `researcher` reads it constantly (it is
  the scope of every market question) and edits it never.
- `scripts/dev/flake-rate.mjs` and `tests/dev/` — **`qa-breaker`**, which built
  them and flagged them as unclaimed. `innov-perf` owns `scripts/dev/bench-*`,
  and flake rate is not a `bench-*` file: it measures **test reliability**, a QA
  property, rather than product speed. `tests/dev/` is the one-for-one mirror of
  `scripts/dev/`, so it follows its author.
- `docs/research/*` — **`researcher`**, a new directory so nothing was taken
  from anyone. Findings only. `docs/tailoring-rules.md` stays with `doc-scribe`
  and `scripts/lib/keywords.mjs` stays with `w1-security`: the researcher says
  what the lexicon is missing, the owner decides what goes in it. That split is
  deliberate — it keeps a claim sourced from the open web from becoming a term
  this pipeline will place in a résumé without an owner having agreed to it.
- `.claude/hooks/*` and `.claude/settings*.json` — **nobody. The user's alone**
  (user decision 2026-07-31). `protect-profile.js` always denied writes to its
  own directory on the Edit/Write path; the manager then probed the SHELL path
  and found it open — `"probe" | Out-File .claude/hooks/__probe.txt` succeeded,
  so an agent could have rewritten the guard denying it. Both hooks were
  extended: the shell guard now covers `.claude/hooks/` and
  `.claude/settings*.json`, and `protect-profile.js` now covers
  `settings*.json` too.

  `settings.json` is in scope for a reason that is easy to miss: it **wires**
  every hook, so a guard is disabled by deleting one line there without ever
  touching a protected file. Flagged independently by `ci-engineer` and by
  `guard-profile-shell.mjs`'s own residuals note — two confirmations.

  **Cost, accepted knowingly:** `ci-engineer` can no longer wire a hook, add a
  permission or change a matcher; those come to the user. That is the trade,
  because `settings.json` is precisely where a guardrail gets switched off.
  Known false positive: `git commit -m` whose MESSAGE names a guarded path and
  contains `rm`/`install` is denied — use `git commit -F <file>`.

- **Comments** — owned by whoever owns the file, _except_ in a post-merge
  comment window granted to `doc-scribe`, who may then edit comments and
  docstrings only, never executable code.

## Skills and scaffolding

`doc-scribe` owns `.claude/skills/*` and may add skills that help development or
the shipped product. Development-only skills declare it in frontmatter:

```yaml
scaffolding: true
remove_after: phase-2
```

`ci-engineer` **fails the build** when a scaffolding artifact outlives its phase.
"We'll remove it when we're done" is a promise; this makes it a check.

## Model assignment

A starting hypothesis, not a fact. Fable 5 holds the generative roles
(architecture proposals, hostile fixture invention, prose and templates); Opus
holds security, engine, autonomy and pipeline work where a subtle mistake is
expensive; Sonnet holds mechanical file-by-file work per the token-discipline
rule in CLAUDE.md.

`innov-perf` measures per-role model performance the same way it measures
everything else, and the manager re-staffs on the numbers.

## Log

| Date       | Change                                                             | Reason                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-07-30 | Hired the initial 11 (3 innovators, 6 workers, 2 QA)               | Autonomy build kickoff; file sets carved disjoint from the plan's phases                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 2026-07-30 | Added `cicd` and `scribe` as **distinct roles**                    | User decision: CI/CD and documentation are their own disciplines, not worker sidelines                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 2026-07-30 | `w6-documents` gave up `docs/` and `.claude/skills/`               | Collided with `doc-scribe`. w6 keeps the user's résumé pipeline; the scribe takes the prose                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 2026-07-30 | `ci-engineer` took `package.json` and `.gitignore`                 | Previously unowned. Single owner because uncoordinated edits leak personal data                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 2026-07-30 | Adopted the cross-check protocol                                   | User decision: agents keep each other in check. Prompted by a run reporting `completed` over six errored agents                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 2026-07-31 | `w2-engine` took the three `apply-job/*.js` files                  | Unowned in the original carve-up. They are eval'd browser code, not docs; `doc-scribe` keeps `SKILL.md` there                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 2026-07-31 | **`w2-engine` runs BEFORE `w3-resolution`**, not beside it         | User decision. 147eb68 is the evidence: run concurrently, w2's spec cannot reach w3 in time and the RCE survived a green suite                                                                                                                                                                                                                                                                                                                                                                                                     |
| 2026-07-31 | Tie-break invoked: `w2-engine` vs `qa-adversary` on `labelExact`   | First use of the third-lens rule. `innov-resilience` ruled **patch, not structural**, and proved it by running `buildPlan` rather than arguing. Neither side was overruled by the manager                                                                                                                                                                                                                                                                                                                                          |
| 2026-07-31 | Hired `innov-resilience` mid-wave                                  | Worker-vs-QA disagreement needed a third lens; announced late, which is the gap the announce rule now closes                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 2026-07-31 | Hired `doc-scribe` mid-wave                                        | Three documents had begun describing behaviour the code no longer had, and drift is invisible to its author                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 2026-07-31 | Roster changes must be **announced**; agents may **request hires** | User decisions. A silent change leaves workers with a stale map; a worker blocked outside its file set had no route but to work around it                                                                                                                                                                                                                                                                                                                                                                                          |
| 2026-07-31 | Hired `researcher` as a **seventh role**; role floor 6 → 7         | User decision. Every other non-manager role reads this repository; nobody was reading the market it operates in. Owns the new `docs/research/`, so no file set was taken from anyone                                                                                                                                                                                                                                                                                                                                               |
| 2026-07-31 | `qa-breaker` took `tests/dev/` and `scripts/dev/flake-rate.mjs`    | Previously unowned and flagged by its author. Flake rate measures test reliability, a QA property, so it is not an `innov-perf` `bench-*` file                                                                                                                                                                                                                                                                                                                                                                                     |
| 2026-07-31 | **Hire request from `qa-breaker`: browser-leg agent — DEFERRED**   | Need is real (6 quantities and 2 fixtures need a browser) but blocked three ways: no `playwright-core` until Phase 3.1, the agent registry is fixed at session start, and "no non-manager gets Playwright" is a plan-level rule the user must amend. File set pre-approved for when it unblocks                                                                                                                                                                                                                                    |
| 2026-07-31 | **Hard rule 6 rewritten: auto-submit permitted, off by default**   | User decision. Was "never auto-submit". Now: submit on a board passing a mechanical trust gate when nothing needed a judgement, defer everything else **with a stated reason**. Ships `enabled: false, dry_run: true`; none of it is built. Manager edited `CLAUDE.md` DIRECTLY, which is `doc-scribe`'s file — an exception taken knowingly because a hard-rule rewrite is a policy record, not documentation, and paraphrase risk on a safety rule outweighs the ownership ceremony. `doc-scribe` owes a sweep of dependent docs |
| 2026-07-31 | `.claude/settings*.json` left `ci-engineer` for the user           | Follows the guardrail sealing above. Hook and permission changes now come to the user                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 2026-07-31 | Manager owns advancing `package.json`'s `phases.current`           | `ci-engineer` flagged it unowned: the scaffolding reaper compares `remove_after` against it, so nothing ever expires until it moves. The manager owns the decision to ship a phase, so the marker follows                                                                                                                                                                                                                                                                                                                          |
| 2026-07-31 | Manager **clears a full agent's context between jobs**             | User decision. Resuming keeps context, which is right mid-job and wrong between jobs; four agents died on session limits at once, one partway through an owned file set. A cleared agent is owed a handoff — ownership belongs to the role, not the instance                                                                                                                                                                                                                                                                       |
