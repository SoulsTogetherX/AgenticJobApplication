# Next session — start prompt

Paste everything below the line into a fresh session.

---

Continue implementing `docs/autonomy-plan.md`. It is **already approved — implement it, do not re-plan it.**

You are `build-manager`. Read `docs/agent-protocol.md` and `docs/team-roster.md` first; they are earned from real incidents. **Only the manager commits, to `dev` only.**

## Decide this first (edit before pasting if you disagree)

**Do NOT build the runner yet.** Have `innov-resilience` review the blast-radius design first — `w4-autonomy` requested that review two waves ago and it never happened, because `SendMessage` cannot reach a finished agent and the manager did not re-hire. Every piece the runner depends on now exists, so this is the last cheap moment to find a design flaw. Once the runner exists, flipping one flag sends real applications, and an application cannot be unsent.

## State — verified, not assumed

Branch `dev`, HEAD `1aec38a`, **working tree clean**, pushed. Gate green on a quiet tree: **1428 tests, 1426 pass, 0 fail, 2 skips both carrying reasons**, floor 1428, ~87s.

**Phases 1 and 2 are effectively closed.** Phase 3 has every piece of substrate — `lock.mjs`, `scripts/auto/{guard,audit,preflight}.mjs`, `automatability.mjs`, `auth-sync.mjs`, `tests/auto/` — and **no runner**.

**The invariant to check, and state it by capability rather than by file list:** nothing in this repository opens a browser unattended, and nothing contains a click. Re-verified at `1aec38a` by grepping `scripts/auto/` and `auth-sync.mjs` for `chromium.launch|launchPersistent|\.click\(|playwright` — the only hits are path strings. Guards existing is not the capability existing.

## Rules that cost real money to relearn

- **Do not over-staff** (user instruction). Twelve agents burned ~1.4M tokens in one wave; four well-scoped agents did more. Never spawn a fresh agent for a follow-up smaller than the context it would rebuild — do those yourself.
- **Verify at phase boundaries, not after every agent** (user instruction). Per-agent re-verification on top of the cross-check protocol was triple-reading the same artifacts.
- **`npm test` is not reproducible in a live shared tree.** Three identical runs gave 4 → 6 → 0 failures; duration inflated 56% purely from contention. A gate number taken mid-wave is not evidence. Run single files while iterating.
- **Never pass a bare directory to `node --test`** — Node 24 does not recurse and reports `Cannot find module`, which looks like a test failure. Use a quoted glob.
- **A parse is not a run.** `node --check` passes on a scope error. A deleted `const` shipped inside a file that parsed fine and killed every invocation of the fact-base writer.
- **Never run a whole-tree git command** while agents are live — no `stash`, `checkout .`, `reset --hard`, `add -A`, `clean`. Path-scoped only, `git status` first.
- **`git commit -m` is denied** when the message names a guarded path and contains a mutator word. Use `git commit -F <file>`. This has bitten repeatedly.
- **`git worktree` is blocked entirely** by the branch guard, including `remove` and `prune`. Delete the directory and `.git/worktrees/<name>` by hand instead.
- Commit messages carry the reasoning, not just the change. This project's history is its documentation.

## Settled — do not relitigate

- **A checkbox or radio group never auto-acts unattended, whatever the answer's class.** A tick carries assent, not a value. Measured 34 auto-ticks → 0 against the real 49-entry bank. Defers use `why: "confirm-widget"`, deliberately a different string from the class gate's `why: "confirm"`; `readiness()` exempts only non-required ones. Do **not** narrow it to "groups with fewer than 3 options carry a value" — decoy options defeat that.
- **The pid-liveness staleness probe is deleted, not disabled.** It fired 112/112 and destroyed a _different live holder's_ lock every time. The inference is invalid for short-lived processes. Do not reintroduce it in any form.
- **`save-answer.mjs` keeps its own acquire loop on purpose.** Full adoption of `lock.mjs` regresses a committed `AJ_LOCK_TIMEOUT_MS=200` contract. The open question, for anyone who wants to finish it: the ordering invariant `timeoutMs > staleMs` is **stricter than the fact** — a waiter can recover an orphan _already stale on arrival_ whatever its timeout, so the ordering only matters for one going stale _while_ you wait.
- **`docs/application-limits.yaml` is the user's file. No agent edits it.** They set the `auto_apply` block themselves: `enabled: false`, `dry_run: true`, `per_run_max: 999`, `per_day_max: 999`, `per_company_max_per_week: 5`.
- **`.claude/hooks/*` and `.claude/settings*.json` are the user's alone**, sealed on both the Edit/Write and shell paths.
- **Chromium stays installed** until the whole project is finished (user instruction). Uninstalling sends three browser legs back to skipping.

## Open, with owners

| item                                                                                                                                                                          | owner                        |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| Blast-radius review of the Phase 3 substrate — **do this first**                                                                                                              | `innov-resilience`           |
| `E6 RESIDUAL` — a required file input revealed by a fill reaches neither `revealed` nor `verify.requiredEmpty`                                                                | `w2-engine`                  |
| `MAX_WIDGET=25` pushes a signal `fill-plan.mjs` ignores; it blocks only on the CAPTCHA signal                                                                                 | `w3-resolution`              |
| Shape F residual: a stateless `role="link"`/`menuitem`, or a `<summary>`-based consent, is still unreported                                                                   | `w2-engine` + `qa-adversary` |
| `lever` and `ashby` have no scan fixtures, so **ashby cannot be benchmarked at all** — nonce CSP and a 700ms remount make it the most interesting latency fixture in the repo | `qa-adversary`               |
| 14 stale `PROTOCOL` citation renumbers in `bench-apply.mjs`; 3 `when` predicates still key on `!c.ready` after `SKILL.md` stopped doing so                                    | `qa-breaker`                 |
| `--browser` measures scan, not fill — post-upload remount cost still unmeasured                                                                                               | `qa-breaker`                 |
| `gate-audit.mjs` wiring — needs a committed fixture lead store                                                                                                                | `w5-leads`                   |
| Phase 4 entirely: recruiter contacts, document format, sweep-everything                                                                                                       | `w5-leads` / `w6-documents`  |

## Measured, so nobody re-derives it

- **The ~6.8s scan probe was never an unconditional cost** — it is a ceiling. Real Chromium prices the actual wait at **87.89ms**. One of the four numbers this project quoted for weeks was a worst case being read as a cost.
- **Six of Phase 2's nine fix-table rows had already shipped** and nobody knew. What was missing was evidence, not code.
- **`ready: true` is not "green".** Green means removing the model entirely via a runner that does not exist; 12 → 6 model turns is exactly what Phase 2 promised. The manager conflated these once and `innov-perf` corrected it.
- **A required `confirm-widget` defer costs +1 model turn, not +4.** The other three were a `SKILL.md` predicate gating scan-derived decisions on a defer-derived flag. Fixed.
- **At 6 concurrent writers the lock defect is invisible** — 0 violations even with the broken probe in. Only 20 writers separates the builds. "It passed at 6" was never evidence.
- **`w2-engine`'s browser numbers use a reconstructed "before" arm, not a git checkout.** `qa-breaker` deliberately kept them out of `docs/measurements.md` for exactly that reason. Preserve the separation.
- `CLAUDE.md` is **254 lines** (was 517). R6 is done; the command catalogue moved to `docs/reference/10-commands.md`. Keep it small — every agent reads it at startup, and that was the single largest avoidable cost measured.

## The failure shape to keep watching

Every expensive defect this project has found was **green when it was wrong**: a silent loss of saved answers with every process exiting 0; a benchmark whose `CONFIRM` was structurally unreachable, so the gate read as free because it had never once run; a test asserting on an argument the fix never touches; a doc asserting a directory's absence that decayed within the hour. Prefer behavioural assertions over source greps — three source-grep tests broke on wording this session while the behaviour was fine. Canary anything you rewrite: break it on purpose, confirm red, restore.
