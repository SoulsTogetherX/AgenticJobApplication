# Autonomy plan v2 — unlimited volume

**Supersedes phases 3 and 4 of [`docs/autonomy-plan.md`](autonomy-plan.md).** Everything in
that document before `## Phase 3 — Autonomy` (context, decisions taken, the design principle,
the team, the rewrite backlog, phases 1 and 2) still stands. Where this document contradicts
it, this document wins, and the contradiction is recorded in
[§1.4](autonomy/01-invalidated.md) rather than edited away.

**Author:** `innov-architect`, 2026-08-01, at `fa192a1` plus a dirty working tree
([§0.2](autonomy/00-how-to-read.md)). **Revision 2, 2026-08-01**, after adversarial review by
`attack:correctness`, `attack:feasibility` and `attack:outside-reality`. Every correction the
review forced is recorded in place, in §0.0 and in the marked notes it points at.

**This file is an index.** It was 153 KB of prose in one file until 2026-08-01, and every
worker read all of it to use about 3 KB. The split below is **mechanical** — sections were
moved verbatim by line range and the byte totals reconcile exactly (151,609 extracted + 1,271
header and preamble = 152,880 original), so nothing was rewritten, dropped or summarised in
the move. Section numbers are unchanged, so a citation like "§4.11" or "§0.2 row 10" still
resolves; the tables below say which file to open.

---

## Read only what your task needs

**If you are a worker with a phase item: read your phase file and nothing else.** The report
contract and the ownership rules reach you in your brief. You do not need the runner
specification to do Phase 0, and you do not need the provenance table to do Phase 3.

| Read this                                                  | When                                                               |
| ---------------------------------------------------------- | ------------------------------------------------------------------ |
| [`autonomy/phase-N.md`](autonomy/)                         | You have a work item in phase N. **Usually the only file needed.** |
| [`autonomy/02-thesis.md`](autonomy/02-thesis.md)           | You need to know why the plan is shaped this way                   |
| [`autonomy/00-how-to-read.md`](autonomy/00-how-to-read.md) | You are citing the plan's own evidence, or auditing a claim in it  |
| [`autonomy/01-invalidated.md`](autonomy/01-invalidated.md) | You are about to rely on something carried over from v1            |
| [`autonomy/04-runner-spec.md`](autonomy/04-runner-spec.md) | You are building the runner (**Phase 5 only**)                     |

## The phases

Seven phases. Each states its goal **as a capability**, its work items with the owning agent
from [`docs/team-roster.md`](team-roster.md), and a **falsifiable check** — a command or test
that can go red. A phase whose check is "the code is written" is not acceptable and none
appear below.

Phases 0–4 are sequential. Phase 5 is gated on 0–4. Phase 6 may start any time after Phase 3
and does not gate the runner — **except 0.11, which is hoisted into Phase 0 precisely because
it gates the plan's own arithmetic.**

| Phase                    | Goal, as a capability                                                     |
| ------------------------ | ------------------------------------------------------------------------- |
| [0](autonomy/phase-0.md) | Class removers, and the measurements everything else is priced against    |
| [1](autonomy/phase-1.md) | State: a durable ledger, and a real definition of "verified"              |
| [2](autonomy/phase-2.md) | Typed intents (R3)                                                        |
| [3](autonomy/phase-3.md) | Deterministic document assembly                                           |
| [4](autonomy/phase-4.md) | Observability, the defer taxonomy, and the measurement gate               |
| [5](autonomy/phase-5.md) | The runner — full spec in [04-runner-spec.md](autonomy/04-runner-spec.md) |
| [6](autonomy/phase-6.md) | Supply and the outcome loop                                               |

## The rest

| Section                                | What is in it                                                                       |
| -------------------------------------- | ----------------------------------------------------------------------------------- |
| [§0.0, §0](autonomy/00-how-to-read.md) | What review changed; how to read this document, including the §0.2 provenance table |
| [§1](autonomy/01-invalidated.md)       | What changed, and what it invalidates                                               |
| [§2](autonomy/02-thesis.md)            | The thesis                                                                          |
| [§4](autonomy/04-runner-spec.md)       | The runner specification                                                            |
| [§5](autonomy/05-deleting.md)          | What we are deleting                                                                |
| [§6](autonomy/06-open-questions.md)    | Open questions for the user                                                         |
| [§7](autonomy/07-risks.md)             | Risks, ranked                                                                       |
| [§8](autonomy/08-still-off.md)         | What is still off                                                                   |
