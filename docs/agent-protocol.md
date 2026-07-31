# Agent cross-check protocol

Every agent keeps every other agent honest. This file is the contract; each
agent definition names its specific duties.

## The premise

**A self-report is a claim, not evidence.** An agent saying it fixed something
is not the same as the fix existing. This is not distrust of any individual — it
is that nobody can verify their own work, because the same blind spot that
caused the miss also hides it.

The failure this exists to catch was observed in this project on 2026-07-30: a
background run reported status **`completed`** while all six of its agents had
errored and done nothing. The summary said success. Only the failure block said
otherwise. A confident report over an empty result is the shape to watch for.

## Rules

1. **Verify against artifacts, never against the report.** Read the diff, run
   the command, open the file. "The report says it passes" is not verification.
2. **Every claim must be falsifiable.** An agent reporting `suite: pass` states
   the **test count**. An agent reporting a measurement states the **command**.
   An agent reporting a fix names the **file and the behaviour that changed**.
3. **"Nothing found" requires saying how you looked.** A clean check with no
   method described is indistinguishable from not checking, and is treated as
   not checking.
4. **No log-rolling.** Never trade approvals — no "pass mine and I'll pass
   yours", no approving work you did not examine because the other agent seems
   competent. An approval is a statement about evidence you personally saw.
5. **Report your own incompleteness first.** Finding your own gap costs nothing.
   Having a checker find a gap you knew about and did not report is the one
   thing treated as bad faith.
6. **Escalate, don't fix.** A checker files the finding to the owner; it does
   not edit another agent's files. Two independent confirmations make it the
   manager's decision.
7. **Checking is not optional work.** An agent that ships its own task and skips
   its check duty has not finished.

## Slacking signatures

Concrete things to look for. Each has been seen in real codebases; several are
live risks in this one.

**In product code**

- A fix claimed in the report that is absent from the diff.
- The hard part left as a `TODO` while the task is reported complete.
- A file edited outside the agent's owned set.
- A comment claiming behaviour the code does not have.
- A guard added where the shape is wrong — the fourth guard on a matcher that
  already has three.

**In tests**

- An assertion weakened, deleted, or `.skip`ped to make a suite green.
- A test that passes because it asserts nothing meaningful.
- A test that cannot fail — verify by breaking the thing on purpose and
  confirming it goes red.
- A test asserting the mock rather than the behaviour.
- A fixture that quietly stopped being loaded.

**In CI**

- `continue-on-error`, `|| true`, or a swallowed exit code.
- A green run that executed zero tests. `node --test` exits 0 on an empty run —
  so the **count** is asserted, not just the exit code.
- A matrix leg that silently skips instead of skipping loudly with a reason.

**In measurements**

- A number reported as measured that was estimated.
- A before/after with no stated harness command.
- A single sample presented as a trend.
- A budget invented retroactively to make a regression look expected.

**In documentation**

- A doc describing code that has since changed.
- A defence described as stronger than it is.
- A capability documented that does not exist.

## Who checks whom

No node is unchecked, including the manager.

| Agent              | Verifies                                                        | Is verified by                        |
| ------------------ | --------------------------------------------------------------- | ------------------------------------- |
| `build-manager`    | Every returned diff against its owned set; the suite; the gate  | the three innovators; the CI pipeline |
| `innov-architect`  | That rewrites buy a named property; roster distribution         | `innov-perf`, `innov-resilience`      |
| `innov-perf`       | Every performance claim; that budgets were declared up front    | `innov-architect`, `qa-breaker`       |
| `innov-resilience` | That security fixes are structural, not just currently-unbroken | `innov-architect`, `qa-adversary`     |
| `w1-security`      | `w5-leads`' injection gate actually rejects                     | `qa-adversary`, `innov-resilience`    |
| `w2-engine`        | `w3-resolution` applied the bootstrap spec unmodified           | `qa-adversary`, `qa-breaker`          |
| `w3-resolution`    | `w2-engine`'s engine contract still holds at the plan boundary  | `qa-breaker`, `innov-resilience`      |
| `w4-autonomy`      | That blast-radius controls survive the other agents' changes    | `innov-resilience`, `qa-breaker`      |
| `w5-leads`         | That gate changes did not grow the reject list                  | `qa-adversary`, `innov-perf`          |
| `w6-documents`     | That no rendered document carries hidden text                   | `qa-adversary`, `doc-scribe`          |
| `ci-engineer`      | That every agent's tests actually run in the pipeline           | `qa-breaker` (canary), `innov-perf`   |
| `doc-scribe`       | That every doc matches the code it describes                    | every file owner it documents         |
| `qa-adversary`     | That security fixes stop attacks at the consumer                | `w1-security`, `innov-resilience`     |
| `qa-breaker`       | That CI fails when it should; that edge cases are handled       | `ci-engineer`, `innov-perf`           |
| `researcher`       | That the pipeline's assumptions about hiring are still true     | `w6-documents`, `qa-adversary`        |

**Why `researcher` is checked by `w6-documents` and `qa-adversary`
specifically.** It is the only agent whose primary input is the open web, so
its two failure modes are distinct from everyone else's: laundering folklore
into the repository as though it were fact, and carrying a page's own text
inward. `w6-documents` owns the résumé pipeline that would consume a bad
keyword recommendation; `qa-adversary` is the agent that assumes text from
outside is hostile. A researcher finding that survives both is worth acting on.

### Two checks that matter more than the rest

**`qa-breaker` canaries the pipeline.** A CI config that cannot fail is the
purest form of slacking, and it hides everyone else's. Periodically introduce a
deliberate failure — a broken assertion, a removed fixture — and confirm the
build goes **red**, then revert it. A pipeline nobody has ever seen fail is
unverified.

**Every file owner checks `doc-scribe`.** Documentation drift is invisible to
its author and obvious to the person who owns the code. When a doc describes
your file wrongly, say so — that is the cheapest correction in the system.

## Escalation

1. Checker files the finding to the owner with a reproduction.
2. Owner fixes forward, or explains why it is not a defect.
3. Disagreement → a second checker with a different lens.
4. Still unresolved → the manager decides and records it in
   `docs/team-roster.md`.

Repeated confirmed slacking is a staffing matter under the roster's rules. **A
single reverted commit is never that** — a rollback is a cheap experiment
ending, and treating it as a failure teaches agents to hide problems, which is
the opposite of what this file is for.

## Routing, and the manager's duty to announce

Agents mostly **cannot reach each other**: `SendMessage` by name fails once an
agent has finished, so a cross-agent finding travels through the manager. Two
duties follow, and both are the manager's.

**Announce every hire and every fire to all active agents** (user decision
2026-07-31) — who joined or left, which file set moved, and who owns it now. A
roster change made silently leaves workers holding a stale map: they send to an
agent that no longer exists, duplicate work that was just reassigned, or file a
finding against an owner who cannot act on it. If a live agent's scope changes,
it gets the correction directly rather than finishing on a superseded brief.

**Any agent may ask for a teammate to be hired** (user decision 2026-07-31).
When your work is blocked or bounded by something outside your file set, say so
rather than working around it or leaving it quietly undone. Name what is
blocked, which file set the new agent would own, and why it cannot be you —
ownership or capability, never effort. The manager adjudicates, may consult an
innovator when the request is really an architecture question, and **owes an
answer either way**: hired, declined, reassigned, or deferred, with the reason.
A request that vanishes is a manager failure. The same route carries the
opposite report: a file set with no owner, or an owner nobody can reach.

**Name the file set when relaying, not just the agent.** The recipient verifies
ownership against `team-roster.md` rather than trusting the relay. **Refusing
work outside your owned set is correct behaviour**, not obstruction — return it
as a request and say which roster line makes it someone else's. This happened on
2026-07-31: two messages meant for `qa-adversary` were misrouted to
`w1-security`, which proved from the roster that every artifact named was
outside its set and filed the work back rather than touching it. That is the
protocol working, and the cost of the error was the manager's to absorb.
