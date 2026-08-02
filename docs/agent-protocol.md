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

## Dispatch discipline — the manager's own cost rules

**User decision 2026-07-31**, after a twelve-agent wave cost ~1.38M tokens.
These bind the **manager**, because most of that spend was ordered rather than
chosen by the agents.

**0. At most THREE agents at once, and prefer one. (User decision 2026-08-02.)**
A six-agent wave exhausted the session usage limit and killed all six mid-edit.
Recovery was cheap only by luck — every file happened to be syntactically whole,
and the one real failure was a test whose implementation had not been written
yet. That is not a margin to rely on twice.

The cap is not only about the limit. The roster was collapsed 16 → 5 the same
day because fine-grained file ownership only pays for itself when agents
genuinely run in parallel; at one-to-three concurrent it charges a routing tax
and buys nothing. **If you find yourself wanting a fourth agent, the work is
probably one brief, not four.**

**0b. Do it yourself when it is small and you already have the context.** Of 14
commits in the 2026-08-02 session, the manager wrote 7 directly — a doc split, a
config key, two plan corrections, a floor bump, a ~10-line decoder fix — and
those were the cheapest of the session. Briefing an agent costs the brief, the
orientation, the exploration and the report. Below roughly fifty lines, in a
file you have already read, dispatching is the more expensive option.

**1. Do not order a blanket read of the orientation files.** Every brief in that
wave opened with "read `agent-protocol.md` and `team-roster.md` first" —
~5,400 tokens each, twelve times, by manager order, and most agents needed one
line of it. Instead:

- **Put the rules the agent actually needs INTO the brief**, in a sentence each.
  A worker touching the fact base needs rule 2 and the exit codes; it does not
  need the staffing constraints.
- Point at `team-roster.md` for **one** purpose: verifying a contested ownership
  claim. Point at `roster-log.md` only to answer "why does this line say this?"
- `CLAUDE.md` is read by the agent harness already. Do not re-order it.

**2. One bounded task per agent.** If the work is three tasks, decide before
dispatching whether that is one wider brief or three jobs — do not discover it
mid-run. Agents in that wave ran to 150k–238k tokens and 80–144 tool calls;
several in the session before died at their limit **mid-edit**, which cost more
than the work saved.

**3. Reuse before re-hiring.** `SendMessage` to a live agent keeps its context
and costs nothing to re-orient. Dispatching a fresh agent for a small follow-up
pays the whole orientation and exploration cost again to save a few thousand
tokens of accumulated context. The clearing table in `team-roster.md` says when
to clear; the default for a _small follow-up_ is **resume, not replace**.

**4. Require the agent to stop rather than expand.** Scope found mid-run comes
back as a finding for the manager to route, not as extra work done quietly. Two
agents in that wave fixed real bugs outside their brief — good work, and
unbudgeted; the finding was the deliverable, the fix was a bonus that could have
gone the other way.

**5. State the falsifiable-report contract once, briefly.** It is three lines —
test count for a pass claim, command for a measurement, file and behaviour for a
fix, own incompleteness first — not three paragraphs.

The measured split, so nobody optimises the wrong term: orientation was **~7%**
of that wave. The dominant cost is **exploration and verification inside each
agent** — which is what rules 2, 3 and 4 target, and what the phase-boundary
rule below targets on the manager's side.

## When checking happens — at phase boundaries, not after every agent

**User decision 2026-07-31.** Verification is real work with a real cost, and
running it after every returned diff is how a wave triples its token spend
without tripling what it catches.

- **The manager verifies at the END OF A PHASE**, not after each agent. Land
  the wave, then check it as a unit.
- **Agents still cross-check each other continuously.** That is where the
  expensive defects were actually found this session, and it is not what this
  rule trims. What it trims is the manager re-running, a third time, a claim
  two agents have already confirmed.
- **Exception — check immediately, regardless of phase:** anything touching
  `profile/` (the fact base), the submit path, or a guardrail. A silent failure
  there costs the user a real application or a real fact about themselves, and
  a phase boundary is too late to find it.

The measured basis: a twelve-agent wave spent ~1.38M tokens, and the manager's
re-verification duplicated work the cross-check protocol had already done. The
protocol's premise — a self-report is a claim, not evidence — is satisfied by
**one** independent check, not two.

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

## The shared tree: never run a whole-tree git command

Ownership is exclusive **per file**, and that is what lets a wave run without
collisions. It does **not** protect the working tree, because agents in a wave
share one checkout. A command scoped to the repository rather than to a path
reaches straight past every ownership boundary.

**Forbidden to every agent, manager included, while any other agent is live:**
`git stash` (and `stash pop`), `git checkout .` / `git checkout -- .`,
`git reset --hard`, `git clean`, and `git add -A` / `git commit -a`. Each of
these silently takes another agent's in-flight work with it, and `stash pop`
can bring it back into a tree that has since moved.

Do this instead:

- To see your own changes: `git diff -- <your paths>`, never bare `git diff`.
- To compare against `HEAD`: `git show HEAD:<path>` into a scratch file, or
  read the committed version directly. Do not move the tree to look at it.
- To undo your own edit: `git checkout -- <the specific file you own>`.
- **Always run `git status` first** and stop if it shows modifications outside
  your file set — that means someone else is working, and it is a signal, not
  noise.

This was found the honest way, on 2026-07-31: `w3-resolution` used
`git stash` / `stash pop` in a tree `qa-adversary` was live-editing, then
verified afterwards that nothing had been lost and **reported it against
itself** — "riskier than it should have been; I should have checked
`git status` first." Nothing was damaged. The rule exists so the next one is
not luckier.

Only the manager commits, so an agent never needs a whole-tree operation to
finish its work.

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
