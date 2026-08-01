# Next session — start prompt

Paste everything below the line into a fresh session.

---

Continue implementing `docs/autonomy-plan.md`. It is **already approved — implement it, do not re-plan it.**

You are `build-manager`. Read `docs/agent-protocol.md` and `docs/team-roster.md`
first (both were cut roughly in half on 2026-07-31; the history moved to
`docs/roster-log.md` and the command catalogue to
`docs/reference/10-commands.md`).

## Two standing rules from the user, 2026-07-31 — follow these from turn one

1. **Staff the smallest team that can do the work.** A twelve-agent wave cost
   ~1.38M tokens. The 16-agent ceiling is a limit, not a target. Prefer
   widening an existing brief to hiring, and never spawn a fresh agent for a
   follow-up small enough that rebuilding its context costs more than the fix.
2. **Verify at PHASE BOUNDARIES, not after every agent.** Agents still
   cross-check each other continuously — that is where the expensive defects
   were found. What is cut is the manager re-running, a third time, a claim two
   agents already confirmed. **Exception:** anything touching `profile/`, the
   submit path, or a guardrail is checked immediately.

## The tree: HEAD is `718a0f0`, and TWO files are deliberately uncommitted

```
?? scripts/lib/lock.mjs        DEFECTIVE — do not commit, do not adopt
?? tests/lib/lock.test.mjs     green at 17/17 and cannot fail on its own subject
 M docs/application-limits.yaml  THE USER'S FILE — see below
```

`npm test` → **1325 tests, 1323 pass, 1 fail, 1 reasoned skip** (floor 1324).

**The one failure is a real open finding, not a broken test.** `E8 BREAKS` asserts
no scanned field carries a `section`. The scanner now emits one — and
`grep -rn "section" scripts/apply/` returns **zero hits**. So the heading is
captured and _nothing consumes it_; two inputs both labelled "Attach" are still
told apart by document order alone. Owner: `qa-breaker` rewrites the assertion,
`w3-resolution` consumes the field. `ci-engineer` also filed that the test's
name uses `[owner]` where the gate's `OWNED_RE` expects `FINDING (owner):`, so
an owned red is mis-bucketed as unowned — `qa-adversary`'s file.

## `scripts/lib/lock.mjs` — why it is held

`innov-resilience` proved by execution (A/B on one variable, four reps,
20 writers × 5 trials) that its **pid-liveness stale test is destructive**:

```
verbatim                          LOST 7,2,13,9   MUTEX-VIOLATIONS 43,28,25,33
identical, holderIsGone -> false  LOST 0,0,0,0    MUTEX-VIOLATIONS  0, 0, 0, 0
```

Instrumented at the moment of every break, 112 breaks: the pid leg fired
**112/112**, the age leg **0**, and `sameLock: false` **112/112** — every single
break destroyed a **different, live** holder's lock, with `ageMs: 0`. The age
check was saying "do not break" and the pid leg overrode it, because the legs
are `||` and there is no identity re-check between the read and the rename.

Four rulings, all binding:

- **Delete the pid probe entirely.** Not gate it, not add a third test. The
  inference _"the pid that wrote this record is dead" ⟹ "this lockfile is
  abandoned"_ is **invalid for short-lived processes** — a healthy CLI writer's
  pid dies milliseconds after acquiring, and the lockfile you are looking at may
  no longer be its. Guarding an invalid inference does not repair it.
- **Keep the mtime age test ON as the primary leg.** Verified to recover all
  three orphan classes (dead local pid, foreign host, empty record).
- **Assert `timeoutMs > staleMs` at `acquire()`.** Shipped defaults are
  `timeout 10s` / `stale 30s`, so **a default caller can never reach the
  staleness window** — measured `ELOCKTIMEOUT after 10153ms` with the orphan
  still present. That inversion is _why_ the destructive leg looked
  load-bearing. The fact-base writer already gets this right (20s > 10s).
- **`heartbeatMs` is inert on `withLock`.** It is a `setInterval`; `withLock` is
  synchronous by design and a sync body blocks the event loop. Measured: mtime
  advanced **0ms** over a 1500ms hold. Either delete it or make `withLock`
  refuse it — a mitigation that silently does nothing is worse than an absent
  one, because it gets budgeted on.

**Convergence direction: `lock.mjs` adopts the fact-base writer's semantics,
never the reverse.** `scripts/profile/save-answer.mjs:708-740` renames,
**re-ages what it actually took**, and restores if it turned out fresh;
`lock.mjs:157-170` does not. That difference is the entire 43-vs-0 result.
Adopting `lock.mjs` today would import the defect into the fact-base writer and
undo the fix committed at `fc05da5`.

`tests/lib/lock.test.mjs` passes 17/17 **and is a test that cannot fail on its
own subject**: it holds the critical section 60ms and polls at 5ms, so a
waiter's read/kill pair never straddles a holder's exit. The one real consumer
holds it for single-digit ms and does file I/O inside. Independently, both
`qa-adversary` and `ci-engineer` saw it **flake** on Windows. Rewrite it around
a short, I/O-heavy critical section.

## Also open: an EPERM defect in COMMITTED code

On win32, `openSync(path,"wx")` returns **EPERM**, not EEXIST, when the path is
delete-pending — i.e. during a normal release. Both lock implementations
special-case only `EEXIST` and rethrow: measured **8.0% of attempts**, and 3 raw
stack traces out of 100 live writer processes. `EPERM`/`EACCES`/`EBUSY` all mean
"could not create exclusively right now" and belong on the poll path. Committed
at `fc05da5` (the fact-base writer, ~line 764) and present in the held
`lock.mjs:217`. It fails loudly rather than losing data, so it is a defect and
not an emergency. **The user chose to defer this to this session.**

Two more from the same review: **`AUTO_RUN_LOCK` and `LEADS_LOCK` have zero call
sites**, so the measured `upsertLeads` lost update is still live in the tree;
and `recordSubmission` runs _after_ the click, so a crash in between undercounts
every cap — write the intent row in `preSubmitCheck` instead, which the existing
`PRIMARY KEY (run_id, slug)` already supports.

## `docs/application-limits.yaml` — ASK THE USER FIRST

It carries an uncommitted `auto_apply` block (`enabled: false`, `dry_run: true`,
`per_run_max: 999`, `per_day_max: 999`, `per_company_max_per_week: 5`). **Nobody
established whether the user wrote it or an agent did.** The file is the user's
and no agent may edit it, so if an agent wrote it that is a guardrail breach to
revert; if the user wrote it, reverting destroys their work. **Do not touch it
until they say which.**

## The trust gate: `innov-resilience` overturned the question

Rule 6 permits auto-submit on a board passing a _mechanical_ trust gate. The
board-identity half is constructible and sound — an allowlist keyed on
`detectAts(url)` + `boardKey(url)` reads the **URL we navigated to**, from
`leads.db`, not from the page's content. That is a genuine second key.

**But rule 6's real predicate is "did anything here require a judgement?", and
that resolves to the page's own DOM.** Every blocking predicate — confirm-widget
defer, consent tickbox, UNKNOWN field — reads the widget type, and
`scan-page.js:606` computes it as `el.type`: the attacker's attribute. A board
serving `<input type="text" name="agree_arbitration" aria-label="Full name">`,
styled as a checkbox and read server-side as assent, defeats the
widget-never-auto-acts rule **without rewording anything**. Same shape as the
consent allowlist, one layer down.

So: **build the board allowlist, and do not let it carry the weight of "nothing
needed a judgement."** State plainly that auto-submit cannot be made safe
against a hostile board by inspecting the board — the load-bearing control is a
list of boards the user typed, and everything downstream is defence in depth.

## Smaller open items, with owners

| item                                                                                                                                                        | owner                                                         |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Consume `section` in `scripts/apply/`; rewrite `E8 BREAKS`                                                                                                  | `w3-resolution` / `qa-breaker`                                |
| Shape F: `role=menuitemcheckbox`, `role=option`, bare `span[tabindex]` return to blindness                                                                  | `w2-engine`, pending an `innov-resilience` ruling on the axis |
| `SKILL.md` step C gates 3 scan-derived decisions on a defer-derived flag (`ready`) — same class as `readiness()` counting consent defers                    | `doc-scribe`                                                  |
| 11 of 15 `PROTOCOL` citations stale (+4 to +34)                                                                                                             | `qa-breaker`                                                  |
| `preflight.mjs` unbuilt — nothing rescans the bank for sensitive values already stored. Must call `findSensitiveValues`, must NOT re-implement key matching | `w4-autonomy`                                                 |
| `auth-sync.mjs` unbuilt — no profile isolation between MCP and auto Chromium                                                                                | `w4-autonomy`                                                 |
| Two comments in `scripts/auto/` claim `recordSubmission` **refuses** an unchecked submit; it records anyway and raises STOP. Code right, comments wrong     | `w4-autonomy`                                                 |
| Chromium uninstall when build work ends (`node node_modules/playwright-core/cli.js uninstall`) — sends 3 browser legs back to skipping                      | user's call                                                   |

## The CI pipeline has never run

`origin/dev` is **53 commits behind** local `dev`. The security-gate, matrix,
reaper and ci-gate jobs all arrived in unpushed commits, so every pipeline claim
is verified by running the same scripts locally on win32/node24 — never by a
real Actions run. `qa-breaker`'s standing canary duty (deliberately break it,
confirm red, revert) **cannot be discharged until `dev` is pushed**, and pushing
is the user's call. `gh` is not installed here, so Actions history could not be
checked from the other side either.

## Things measured, so nobody re-derives them

- **The orientation tax is ~7%, not the dominant cost.** The three files agents
  read at startup went 88,856 → 54,497 chars (~8,600 tokens saved per agent).
  The larger term is each agent running 80–144 tool calls re-deriving context.
- **`npm test` is not reproducible in a live shared tree** — three identical
  runs gave 4 → 6 → 0 failures; duration inflated 75s → 150s from contention.
  A gate number taken mid-wave is not evidence.
- **A parse is not a run.** `node --check` passes on a scope error; a deleted
  `const` killed every write to the fact base while the file "parsed fine".
- **The bench was measuring nothing** — answer ids did not match `BANK_ID_RE`,
  so a `CONFIRM` was structurally unreachable and the class gate read as free
  because it had never once run.
- **The required-widget defer costs +1 model turn, not +4.** Three of the four
  belong to step C's skip predicate.
- **`ready:true` ≠ "green".** Green means removing the model entirely via a
  runner that does not exist. 12 → 6 turns is what Phase 2 promised; the manager
  conflated the two and was corrected by `innov-perf`.
