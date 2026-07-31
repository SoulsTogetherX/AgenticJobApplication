# Team roster

Who exists, what they exclusively own, and every hire/fire with its reason.
Maintained by `build-manager`. Without this, "who was supposed to own
`field-cache.mjs`?" is unanswerable after the fact.

**Ownership is exclusive.** Two agents must never be able to write the same
path in one wave. A file set left unowned at integration time is an error, not
a silent gap.

## Roles and privileges

| Role      | Agent tool | Playwright | Commits | Writes product code |
| --------- | ---------- | ---------- | ------- | ------------------- |
| manager   | **yes**    | no         | **yes** | no                  |
| innovator | no         | no         | no      | no (harnesses only) |
| worker    | no         | no         | no      | yes                 |
| QA        | no         | no         | no      | tests only          |

The Agent tool is a manager-only privilege. That is what keeps the tree bounded
and makes "no subagent ever drives a real employer's form" structural rather
than aspirational.

## Staffing constraints

1. **Floor:** at least one manager, one worker, one QA, one innovator at all
   times.
2. Managers may hire managers. **Depth cap: two manager levels.**
3. **Ceiling: 16 concurrent agents**, plus a token budget the manager tracks.
4. Consult an innovator before restructuring the roster — `innov-architect` for
   splitting a domain, `innov-perf` for whether parallelism is the bottleneck.

Firing releases the file set back to the pool. A rollback is not a verdict on
an agent; firing follows these rules and this log, never a single reverted
commit.

## Current roster

| Agent              | Role      | Model   | Owns (exclusive)                                                                                   |
| ------------------ | --------- | ------- | -------------------------------------------------------------------------------------------------- |
| `build-manager`    | manager   | Opus    | Process only: this file, the git history, the decision to ship                                     |
| `innov-architect`  | innovator | Fable 5 | Nothing. Structure, rewrite backlog, deletion candidates                                           |
| `innov-perf`       | innovator | Opus    | `scripts/dev/bench-*.mjs`, `docs/measurements.md`                                                  |
| `innov-resilience` | innovator | Opus    | Nothing. Failure modes, concurrency, security architecture                                         |
| `w1-security`      | worker    | Opus    | `lib/untrusted.mjs`, `lib/lib.mjs`, `documents/verify-claims.mjs`, `profile/save-answer.mjs`       |
| `w2-engine`        | worker    | Opus    | `apply/fill-engine.mjs`, `apply/scan-engine.mjs`, `apply/browser.mjs`, `tests/apply/fill-page.*`   |
| `w3-resolution`    | worker    | Sonnet  | `apply/fill-plan.mjs`, `answer-bank.mjs`, `field-cache.mjs`, `pending-questions.mjs`, `apply/ats/` |
| `w4-autonomy`      | worker    | Opus    | `scripts/auto/*`, `lib/lock.mjs`, `lib/db.mjs`, `apply/automatability.mjs`, `apply/auth-sync.mjs`  |
| `w5-leads`         | worker    | Sonnet  | `scripts/leads/*`, `scripts/recruiters/*`, `docs/candidates/*`                                     |
| `w6-documents`     | worker    | Fable 5 | `documents/*` (not verify-claims), `templates/*`, `docs/*`, `.claude/skills/*`                     |
| `qa-adversary`     | QA        | Fable 5 | `tests/security/`, `tests/fixtures/boards/`, `tests/fixtures/hostile/`                             |
| `qa-breaker`       | QA        | Opus    | `tests/apply/` (not fill-page), `tests/auto/`, `scripts/dev/bench-apply.mjs`                       |
| `job-worker`       | worker    | Sonnet  | Pre-existing. Per-job runtime worker for `pipeline-jobs`; not part of this build                   |

### Contested paths, resolved

- `scripts/apply/fill-plan.mjs` — **`w3-resolution` owns it.** `w2-engine`
  delivers the replacement `buildDriverSource()` as a spec.
- `scripts/leads/risk.mjs` — **`w5-leads` owns it.** `w1-security` sends the
  `injection_attempt` spec.
- `scripts/documents/verify-claims.mjs` — **`w1-security` owns it**, not
  `w6-documents`, because its evidence corpus is a security control.
- `docs/measurements.md` — `innov-perf`. `docs/team-roster.md` —
  `build-manager`. All other `docs/` — `w6-documents`.

## Model assignment

A starting hypothesis, not a fact. Fable 5 holds the generative roles
(architecture proposals, hostile fixture invention, template and prose); Opus
holds security, engine and autonomy work where a subtle mistake is expensive;
Sonnet holds mechanical file-by-file work per the token-discipline rule in
CLAUDE.md.

`innov-perf` measures per-role model performance the same way it measures
everything else, and the manager re-staffs on the numbers.

## Log

| Date       | Change                                    | Reason                                                                   |
| ---------- | ----------------------------------------- | ------------------------------------------------------------------------ |
| 2026-07-30 | Hired the initial 11 (3 innov, 6 w, 2 QA) | Autonomy build kickoff; file sets carved disjoint from the plan's phases |
