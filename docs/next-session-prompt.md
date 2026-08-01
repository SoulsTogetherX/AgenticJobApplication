# Next session — start prompt

Paste everything below the line into a fresh session.

---

Continue implementing `docs/autonomy-plan.md`. It is **already approved — implement it, do not re-plan it.**

You are `build-manager`. Delegate per `docs/team-roster.md` ownership. **Only the manager commits, to `dev` only.** Read `docs/agent-protocol.md` and `docs/team-roster.md` first — they are earned from real incidents, not preferences.

## READ THIS FIRST: the tree is RED and that is expected

Three agents died simultaneously on a session limit, two of them **mid-edit**. Their partial work is **deliberately left uncommitted** — do not revert it, and do not "clean up" the working tree.

```
 M scripts/apply/fill-plan.mjs        (+62)   w3-resolution, value-carrying-act rule
 M tests/apply/fill-plan.test.mjs     (+51)   w3-resolution — NOT ITS FILE, see below
 M scripts/profile/save-answer.mjs    (+265)  w1-security, locking. HALF DONE
```

All three **parse**. Test state as left:

| file                                 | result                                   |
| ------------------------------------ | ---------------------------------------- |
| `tests/profile/save-answer.test.mjs` | 35 tests, **18 fail** — genuinely broken |
| `tests/apply/fill-plan.test.mjs`     | 98 tests, 6 fail — fails SAFE, see below |
| `tests/security/**`                  | 138 tests, 2 fail                        |

**Why the tree was not reverted.** `SendMessage` to a dead agent resumes it from its transcript. Reverting would leave a resumed agent working from the false belief that its edits exist. The partial work is worth more than a green `git status`.

**The `fill-plan` failures are the rule working, not breaking.** Tests 26/27/59/68 encode the PRE-rule policy ("ordinary checkboxes stay on the normal path", "end dates are dropped once the current-role box is ticked") and fail because checkboxes now defer. 97/98 pin the pre-rule numbers. Those belong to `qa-breaker` and need updating, not reverting.

**One failure is a WIN and must not be "fixed" back.** `tests/security` #111 —
`LANDS (shapes B/C, reworded)` — asserts the reworded-assertion attack
_succeeds_. It now FAILS, meaning the value-carrying-act rule closes the hole
`innov-resilience` proved reclassification could never close. The rule reads no
words, so a wording the pattern list misses cannot get past it. Have
`qa-adversary` rewrite it to pin the fix.

**`save-answer.mjs` is the dangerous one.** Half-inserted locking in the writer
for the user's fact base. The shell guard denies it without
`--file` / `--user-approved` / `--rescan`, so accidental real-bank writes are
blocked — but do not run it against anything real until `w1-security` finishes.

**Ownership violation to resolve:** `w3-resolution` edited
`tests/apply/fill-plan.test.mjs`, which is `qa-breaker`'s, contrary to its brief.
Assess the edit on merit; do not assume it is wrong. Then re-state the boundary.

## Where things stand

Branch `dev`, HEAD `fa97436`, **5 commits this session**:

| commit    | what                                                      |
| --------- | --------------------------------------------------------- |
| `e19e87e` | Guardrails sealed on the shell path, not just Edit/Write  |
| `9a3eaef` | `--rescan`: audit the fact base already stored            |
| `d945871` | The consent gate wired at the consumer                    |
| `3f67326` | An unrun browser test is now a failure; reaper wired      |
| `fa97436` | Hard rule 6 replaced: auto-submit allowed, off by default |

Last green gate, on a quiet tree: **1186 tests, 1185 pass, 0 fail, 1 reasoned skip.** Floors are set to 1186 / 224.

**Chromium is installed** (~701MB, `%LOCALAPPDATA%\ms-playwright`). All three browser legs run and pass, including Ashby's nonce CSP — previously an assumption. **The user wants it uninstalled when the build work is done**: `node node_modules/playwright-core/cli.js uninstall`. Removing it sends those three back to skipping, so it is a real trade, not just cleanup.

## The finding that dominates everything else

`innov-resilience`, verified by execution against the real 49-entry bank:

> **A `datum` classification licenses the agent to tick a control the BOARD owns, and a tick carries no value — it carries assent.**

On a page whose labels are all wordings the user banked, wired to `agree_arbitration`: **34 of 49 entries auto-tick, `ready: true`, no model step.** The class gate that shipped in `d945871` removed 14 of 48 (29%) — a real gain — and reclassifying answers closes **none** of the remaining 34.

The fix, mid-implementation in the working tree: **a checkbox or radio group never auto-acts unattended, whatever the answer's class.** Measured 34 → 0.

**Two things about it that must not be re-derived or weakened:**

1. **Its defers MUST use a distinct `why` — `"confirm-widget"`, not `"confirm"`.** `innov-resilience` nearly shipped a readiness exemption keyed on `why === "confirm"`, which is the class gate's own marker; it re-marked the arbitration pages as `ready: true`. Only `confirm-widget` defers on **non-required** fields are non-blocking.
2. **Do NOT narrow it to "groups with fewer than 3 options carry a value."** Defeated by a board adding two decoy options. `innov-resilience` pre-rejected this and said it would file against it.

Latency cost, measured: **0** added model turns on both real Greenhouse fixtures, 0 on an optional EEO block, 0 on selects, **1** on a form with a required radio/checkbox group the bank can answer.

## User decisions from this session

- **Hard rule 6 is rewritten** (`fa97436`). Auto-submit is permitted on a board passing a **mechanical** trust gate when nothing needed a judgement; everything else defers **with a stated reason**. Ships `enabled: false, dry_run: true`. None of it is built.
- **Priority: start Phase 2 and Phase 3.** Fix security holes as they surface; run a **full Phase 1 security sweep at the end**, not now. The user's reasoning is borne out by this session — every serious finding came from building, not auditing.
- **Real-job testing: not yet.** The user deferred to the recommendation to land the value-carrying-act rule first.
- **`.claude/hooks/` and `.claude/settings*.json` are the user's**, sealed on both paths. Hook and permission changes go to them.
- **`zz-test-co` removed** from the application store: 12 applications, 10 companies.

## Open, with owners

| item                                                                                                | owner           |
| --------------------------------------------------------------------------------------------------- | --------------- |
| Finish the locking; fix `--rescan --source model` exiting 0; stale comment at `save-answer.mjs:169` | `w1-security`   |
| Finish the value-carrying-act rule                                                                  | `w3-resolution` |
| Shape E (`div[role=checkbox]` scans as nothing) + E1/E3/E4/E5/E6/E8                                 | `w2-engine`     |
| E7 — the planner plans a login wall as if it were a form                                            | `w3-resolution` |
| Rewrite security #111 to pin the fix                                                                | `qa-adversary`  |
| Update 26/27/59/68/97/98 for the new policy                                                         | `qa-breaker`    |
| An honest single-page fixture that reaches `ready: true`                                            | `qa-adversary`  |
| `bench-apply` never produces a `CONFIRM`, so the gate's latency cost is unmeasured                  | `qa-breaker`    |
| Sweep docs for rule 6; `npm run reap`, `--self-test`, column-0 frontmatter                          | `doc-scribe`    |
| Wire `gate-audit.mjs` — needs a committed fixture lead store                                        | `w5-leads`      |

## Things measured this session, so nobody re-derives them

- **`npm test` is not reproducible in a live shared tree.** Three consecutive identical runs: 4 fail → 6 fail → 0 fail. Separately, duration inflated 56% (59.8s → 93.3s) purely from contention. **A gate number taken mid-wave is not evidence.**
- **Concurrent `save-answer.mjs` writers silently lose answers.** 6 writers, 5 trials, 4 lost 1–3 of 6 — every process exiting 0. Reproduced independently by the manager.
- **Zero honest board fixtures reach `ready: true` today.** All four that do are hostile and minimal. Phase 2's headline item has never been demonstrated firing on an honest form — that reframes what Phase 2 is optimising.
- **`--rescan` cannot detect well-formed fabrication.** Two of the four entries that actually contaminated the bank pass it silently. It validates shape, never truth.
- **The classifier's inferred leg is a pattern list and every real entry takes it.** Four wordings of "are you authorized to work here" classify two ways. Rates measured at 11/13 and 5/13 on different question sets — **the rate is unestablished; the hole is not.**
- **`.claude/hooks/` was open on the shell path.** Found by probing, after reading the files produced the wrong conclusion twice.

## Standing rules that cost something to relearn

- **Clear a full agent's context between jobs; an agent that died on a session limit is ALWAYS cleared** — except where its transcript holds mid-edit work, as now. A cleared agent is owed a handoff; ownership belongs to the role, not the instance.
- **Never run a whole-tree git command** while agents are live — no `stash`, `checkout .`, `reset --hard`, `add -A`. Path-scoped only; `git status` first.
- **A self-report is a claim, not evidence.** Every significant finding this session was verified by re-running it, and two agents caught errors in their own work that way.
- **Use the third lens.** It was used once here and overturned the question rather than answering it.
- **An auxiliary assertion placed before a finding assertion masks the finding.**
- **A `git commit -m` whose message names `.claude/hooks/` and contains a mutator word is denied** by the new guard. Use `git commit -F <file>`. This is documented, deliberate, and it already bit twice.
- **Commit messages carry the reasoning, not just the change.** This project's history is its documentation.
