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

Six roles. `cicd` and `scribe` are **distinct roles**, not workers: a worker
ships features, `ci-engineer` ships the machinery that proves features work, and
`doc-scribe` ships what the project says about itself.

| Role      | Agent tool | Playwright | Commits | Writes product code        |
| --------- | ---------- | ---------- | ------- | -------------------------- |
| manager   | **yes**    | no         | **yes** | no                         |
| innovator | no         | no         | no      | no (harnesses only)        |
| worker    | no         | no         | no      | yes                        |
| QA        | no         | no         | no      | tests only                 |
| cicd      | no         | no         | no      | pipeline and config only   |
| scribe    | no         | no         | no      | **no — comments and docs** |

The Agent tool is a manager-only privilege. That is what keeps the tree bounded
and makes "no subagent ever drives a real employer's form" structural rather
than aspirational.

## Staffing constraints

1. **Floor: at least one of each of the six roles at all times.**
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

## Current roster

| Agent              | Role      | Model   | Owns (exclusive)                                                                                                                     |
| ------------------ | --------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `build-manager`    | manager   | Opus    | Process only: this file, `agent-protocol.md`, the git history, the decision to ship                                                  |
| `innov-architect`  | innovator | Fable 5 | Nothing. Structure, rewrite backlog, deletion candidates                                                                             |
| `innov-perf`       | innovator | Opus    | `scripts/dev/bench-*.mjs`, `docs/measurements.md`                                                                                    |
| `innov-resilience` | innovator | Opus    | Nothing. Failure modes, concurrency, security architecture                                                                           |
| `w1-security`      | worker    | Opus    | `lib/untrusted.mjs`, `lib/lib.mjs`, `documents/verify-claims.mjs`, `profile/save-answer.mjs`                                         |
| `w2-engine`        | worker    | Opus    | `apply/fill-engine.mjs`, `apply/scan-engine.mjs`, `apply/browser.mjs`, `tests/apply/fill-page.*`                                     |
| `w3-resolution`    | worker    | Sonnet  | `apply/fill-plan.mjs`, `answer-bank.mjs`, `field-cache.mjs`, `pending-questions.mjs`, `apply/ats/`                                   |
| `w4-autonomy`      | worker    | Opus    | `scripts/auto/*`, `lib/lock.mjs`, `lib/db.mjs`, `apply/automatability.mjs`, `apply/auth-sync.mjs`                                    |
| `w5-leads`         | worker    | Sonnet  | `scripts/leads/*`, `scripts/recruiters/*`, `docs/candidates/*`                                                                       |
| `w6-documents`     | worker    | Fable 5 | `scripts/documents/*` (not verify-claims), `templates/*` — **the user's résumé and cover letter**                                    |
| `ci-engineer`      | cicd      | Opus    | `.github/workflows/*`, `package.json`, `scripts/hooks/*`, `.claude/settings*.json`, `.gitignore`, `.prettierignore`, `tests/hooks/*` |
| `doc-scribe`       | scribe    | Fable 5 | `CLAUDE.md`, `README.md`, `docs/reference/*`, most `docs/*.md`, `.claude/skills/*`, `schemas/*`                                      |
| `qa-adversary`     | QA        | Fable 5 | `tests/security/`, `tests/fixtures/boards/`, `tests/fixtures/hostile/`                                                               |
| `qa-breaker`       | QA        | Opus    | `tests/apply/` (not fill-page), `tests/auto/`, `scripts/dev/bench-apply.mjs`                                                         |
| `job-worker`       | worker    | Sonnet  | Pre-existing. Per-job runtime worker for `pipeline-jobs`; not part of this build                                                     |

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
  Propose values; the user approves.
- `.claude/hooks/protect-profile.js` — **nobody.** That path denies writes to
  itself, deliberately.
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

| Date       | Change                                                             | Reason                                                                                                                                                                                    |
| ---------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-07-30 | Hired the initial 11 (3 innovators, 6 workers, 2 QA)               | Autonomy build kickoff; file sets carved disjoint from the plan's phases                                                                                                                  |
| 2026-07-30 | Added `cicd` and `scribe` as **distinct roles**                    | User decision: CI/CD and documentation are their own disciplines, not worker sidelines                                                                                                    |
| 2026-07-30 | `w6-documents` gave up `docs/` and `.claude/skills/`               | Collided with `doc-scribe`. w6 keeps the user's résumé pipeline; the scribe takes the prose                                                                                               |
| 2026-07-30 | `ci-engineer` took `package.json` and `.gitignore`                 | Previously unowned. Single owner because uncoordinated edits leak personal data                                                                                                           |
| 2026-07-30 | Adopted the cross-check protocol                                   | User decision: agents keep each other in check. Prompted by a run reporting `completed` over six errored agents                                                                           |
| 2026-07-31 | `w2-engine` took the three `apply-job/*.js` files                  | Unowned in the original carve-up. They are eval'd browser code, not docs; `doc-scribe` keeps `SKILL.md` there                                                                             |
| 2026-07-31 | **`w2-engine` runs BEFORE `w3-resolution`**, not beside it         | User decision. 147eb68 is the evidence: run concurrently, w2's spec cannot reach w3 in time and the RCE survived a green suite                                                            |
| 2026-07-31 | Tie-break invoked: `w2-engine` vs `qa-adversary` on `labelExact`   | First use of the third-lens rule. `innov-resilience` ruled **patch, not structural**, and proved it by running `buildPlan` rather than arguing. Neither side was overruled by the manager |
| 2026-07-31 | Hired `innov-resilience` mid-wave                                  | Worker-vs-QA disagreement needed a third lens; announced late, which is the gap the announce rule now closes                                                                              |
| 2026-07-31 | Hired `doc-scribe` mid-wave                                        | Three documents had begun describing behaviour the code no longer had, and drift is invisible to its author                                                                               |
| 2026-07-31 | Roster changes must be **announced**; agents may **request hires** | User decisions. A silent change leaves workers with a stale map; a worker blocked outside its file set had no route but to work around it                                                 |
