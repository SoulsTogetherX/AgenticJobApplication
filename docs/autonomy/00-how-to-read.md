## 0.0 What review changed

The attack stage did real work. It found **six fatal defects**, all six accepted, three of which
would each on their own have produced a runner that either never submits, submits the wrong
document, or stops the user's campaign on its first healthy night.

| #   | Found by        | Defect                                                                                                                                                                                                                                                                                                                                                                                                                                       | Where the fix lands                                          |
| --- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| F1  | correctness     | Slug-keyed `auto_submissions` + dry-run rows written to the same table means every rehearsed slug pre-consumes its own claim, so `submitOnce`'s precondition 7 refuses **forever** after the rehearsal. The plan as drafted produced a runner that could never submit anything live.                                                                                                                                                         | §1.4 **C8**, Phase 1.2, §4.10 item 7                         |
| F2  | correctness     | "One persistent context is forced" is false (`browser.mjs:169-170` has a non-persistent branch), and the mitigation for its stated cost was keyed on `board_key`, which is **tenant**-scoped, while cookies and storage are **origin**-scoped. Eight concurrent Greenhouse tenants share one cookie jar; a résumé upload token from one tab can be spent by another.                                                                         | §1.4 **C9**, §4.2 rewritten                                  |
| F3  | correctness     | Every validation widening was `dry_run`, and `dry_run` never clicks. The click, the confirmation classifier, the `attempted → submitted` transition and two of the four hard STOPs would all execute for the first time against a real employer.                                                                                                                                                                                             | §1.4 **C10**, Phase 5 **W2** (new)                           |
| F4  | feasibility     | The harness that would judge the plan's perf-sensitive changes was built in Phase 4, **after** five changes had landed on the fill path — so the first fill baseline would silently absorb every un-budgeted change before it. This is the 24s-of-`waitForTimeout` failure with the calendar rearranged.                                                                                                                                     | §1.4 **C11**, Phase 0.9/0.10, budgets in every affected item |
| F5  | feasibility     | The supply arithmetic does not close, by an order of magnitude, using the plan's own screening rate — and the measurement that would have said so on day one was scheduled last and made non-gating.                                                                                                                                                                                                                                         | §1.4 **C12**, Phase 0.11, §2, Phase 6.1 numeric criterion    |
| F6  | outside-reality | Hard STOP #1 ("post-submit page is not a confirmation") is **wrong about the launch board**. Greenhouse documents Invisible reCAPTCHA on careers-page integrations 1-4, analysing mouse and typing patterns, which may dismiss a submission or demand an email code. A Playwright fill emits near-zero input events, so a non-confirmation page is an **expected environmental outcome whose probability rises with N** — C2 one layer down. | §1.4 **C13**, §4.6, §4.10 classifier                         |

Material defects accepted and fixed: the heartbeat single-flight non-sequitur (§4.3, now
deleted rather than replaced); the breaker's missing retry/backoff/re-admission (§4.6); stranded
`board-paused` jobs invisible to the taxonomy (§4.6, Phase 4.1); reconcile-to-`failed` dead-ending
against the slug claim (§4.9); the multi-page "resolve before the first keystroke" requirement
being unsatisfiable without a navigate verb (§4.2c, a new module and a real cost); a mid-run
fact-base edit mass-deferring every remaining job (§4.6, new kind); Phase 3's network-egress
check being green by construction (Phase 3 check rewritten); the CI gate's
`durable_attempted_rows != apps_started` contradicting its own state machine (§Phase 4 gate);
`model_turns` and `round_trips` being **derived** from a static PROTOCOL list rather than
observed, which makes the one no-override gate the one that can never fire (Phase 4.7); the
fixture forcing concurrency 1 in the two commands used as proof of concurrency 8 (Phase 4.6);
the N=8 knee being transplanted from a workload 76× shorter and then proposed to the user as
measured (§6.1, number withdrawn); per-edge spacing stated as "seconds" with no number and no
crossover (§4.2b); §5.3's factually false basis for rejecting human-pacing (decision kept,
grounds corrected); §6.4's "majority of current leads" (measured: 39%, §6.4); the SmartRecruiters
precision fix (§6.5); and the provenance failure in the plan's own credibility table (§0.2,
which cited one function that does not exist yet and another already deleted, under one sha).

Added from "missing entirely": arrival shaping across the day bounded by the recency SLA
(§4.2b); the confirmation email as an evidence channel (§6.7, a consent decision); green-tier
prevalence measured from stored scans before anything is built (Phase 0.12); storage growth and
workspace retention at volume (Phase 1.8, Phase 4.2); a taken-down posting as its own outcome
(§4.6); STOP's blast radius across the new resumable shape (§4.9); per-job failure rate `p` as a
tracked column (Phase 4.7); ledger-writing as an actual work item (Phase 4.8).

**Rejected, with reasons, in one line each** — full reasoning at each site: descoping multi-page
boards instead of building a navigate verb (§4.2c); deleting the orphan row in reconciliation
rather than giving it a terminal outcome (§4.9); re-deriving the runner's requirements downward
from a ~100/day supply ceiling (§1.4 C12); and one arithmetic correction to a critic
(median halt is job 292, not 380 — the critic is right, the draft was wrong, §1.4 C2).

**Nothing in the review touched the thesis (§2), the refusal to model-resolve `UNKNOWN` fields,
the `submitOnce` precondition list, Phase 0.1's origin binding, Phase 1.3's `profile_sha256`
clause, or the deletion list.** All were specifically endorsed by at least one critic against
artifacts. They are not churned here.

---

## 0. How to read this document

### 0.1 The tense convention, and why it is a rule

The v1 plan wrote specifications in the indicative. Three times, a control that did not exist
was believed in because a plan sentence described it as though it did — `INBOX.md`, the 26h
staleness heartbeat, and the "guards are structurally unskippable" claim in
`scripts/auto/guard.mjs:20-22`. All three read as descriptions of the system. All three were
descriptions of an intention.

So, in this document:

- **EXISTS** — the thing is in the tree, followed by the command that settles it and **the tree
  state that command was run against**. If the command comes back empty, the claim is false and
  this document is wrong.
- **SHALL** — the thing does not exist. Every unbuilt component is written as "shall", with no
  exceptions, including ones that feel inevitable.

A sentence in this plan is never evidence that code exists. The command next to it is.

### 0.2 Status of this document, and its gaps — stated first

**CORRECTION (review, F-material, `attack:feasibility` and `attack:correctness` concurring).**
Revision 1's table was stamped "at `fa192a1`" and was run against a **dirty, partly untracked
tree**. Two of its citations describe code in a tree state that exists nowhere: §4.9 cited
`assertNoOrphanAttempts` at `audit.mjs:189-217`, which does **not** exist at `fa192a1`; §4.10
argued at length about `preSubmitCheck`, which exists at `fa192a1` and has **already been
deleted** by the in-flight wave. A document that makes provenance a rule in §0.1 and then breaks
it in the table that establishes its credibility is worse than one that never claimed it. The
table is re-run and re-marked below.

**RE-RUN — `doc-scribe`, 2026-08-01, against commit `9e0a159` (Phase 0.8), which is the tree
state for every row below except row 11.** This discharges the obligation the previous revision
of this section booked and Phase 0.8 repeats. Every command is written so it reads the committed
blob rather than the working tree, because five agents are editing this repository right now and
a `sed` over the worktree cites bytes nobody else can reproduce — the exact way revision 1's
table went wrong.

**Why `file_sha1` and not just the commit sha.** A commit sha says which tree; a file sha says
which bytes were read. The column is the first 12 hex of the sha1 of the file's content, the same
digest `bench-apply.mjs`'s `provenance()` computes over `MEASURED_FILES` (`scripts/dev/bench-apply.mjs:1999-2036`),
which exists in this repo because M2 and M6 were both destroyed by an uncommitted edit landing
mid-measurement. Reproduce the whole column with:

```sh
for f in <paths>; do echo "$f $(git show 9e0a159:$f | sha1sum | cut -c1-12)"; done
```

That digest was checked against the worktree digest for all eleven files. Ten matched, which is
the evidence that `git show | sha1sum` and `provenance()` compute the same thing. The eleventh —
`scripts/status.mjs` — did **not**, and that is the column earning its keep on its first run:
see row 5.

| #   | Claim                                                                  | Command (all read commit `9e0a159`, not the worktree)                                                          | `file_sha1`                                                                              | Result                                                                                                                                                                                                                                                         |
| --- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `auto_submissions` is keyed `(run_id, slug)`                           | `git show 9e0a159:scripts/lib/db.mjs \| sed -n '232,246p'`                                                     | `db.mjs` `ad72e99f0f40`                                                                  | **HOLDS** — `PRIMARY KEY (run_id, slug)` at `:244`                                                                                                                                                                                                             |
| 2   | Dry-run rows go in the same table and **count toward caps on purpose** | `git show 9e0a159:scripts/lib/db.mjs \| sed -n '210,246p'`; same file `\| sed -n '880,902p'`                   | `db.mjs` `ad72e99f0f40`                                                                  | **HOLDS** — `:216` "A dry-run row is recorded too, with mode 'dry_run'"; `:892` "The cap counts dry-run rows on purpose". F1's premise is intact                                                                                                               |
| 3   | `AUTO_RUN_LOCK` has zero callers                                       | `git grep -n "AUTO_RUN_LOCK" 9e0a159 -- scripts tests`                                                         | `lock.mjs` `c2428348a629`                                                                | **HOLDS** — one line, `scripts/lib/lock.mjs:176`, its own definition                                                                                                                                                                                           |
| 4   | `INBOX_PATH` has zero writers and zero readers                         | `git grep -n "INBOX" 9e0a159 -- scripts tests`                                                                 | `guard.mjs` `fe64d25d898a`                                                               | **HOLDS** — one line, `scripts/auto/guard.mjs:76`, its own definition. Revision 1 said `:65`; the symbol moved 11 lines and the claim did not                                                                                                                  |
| 5   | `status.mjs` surfaces nothing about the auto path                      | `git show 9e0a159:scripts/status.mjs \| grep -c "auto_runs\|INBOX"`                                            | `status.mjs` `f02daf59c8f5` — worktree is `b3c9b9f7aee3`                                 | **HOLDS at `9e0a159`** (`0`), and **the file is dirty right now.** The claim is true of the committed bytes and unverified of whatever is in flight. C4 and Phase 4 must re-run this row before they rely on it                                                |
| 6   | `hasVerifiedResume` is file-existence, not verification                | `git show 9e0a159:scripts/apply/automatability.mjs \| sed -n '454,473p'`                                       | `automatability.mjs` `ca21ae16dd94`                                                      | **HOLDS** — `fs.existsSync(resume)` at `:464`; the comment at `:454-455` says it outright, "verify-claims writes nothing durable". Revision 1's `450,478` range is four lines high at this commit                                                              |
| 7   | A non-persistent browser branch exists                                 | `git show 9e0a159:scripts/apply/browser.mjs \| grep -n "newContext\|launchPersistentContext\|chromium.launch"` | `browser.mjs` `0d760f2cfd9d`                                                             | **HOLDS** — `:167` persistent, `:169-170` `chromium.launch` + `browser.newContext()`. F2 and C9's replacement still rest on a branch that exists                                                                                                               |
| 8   | `boardKey` is tenant-scoped, not origin-scoped                         | `git show 9e0a159:scripts/apply/automatability.mjs \| sed -n '126,139p'`                                       | `automatability.mjs` `ca21ae16dd94`                                                      | **HOLDS** — hostname + first path segment + `for=` employer param. F2                                                                                                                                                                                          |
| 9   | `fill-engine` cannot express a button click                            | `git show 9e0a159:scripts/apply/fill-engine.mjs \| sed -n '103,105p'`                                          | `fill-engine.mjs` `6ba5b7ad4314`                                                         | **HOLDS** — "there is deliberately no verb that clicks a button… a thing it cannot express", immediately above `fillPage` at `:105`                                                                                                                            |
| 10  | The fixture has exactly one greenhouse route                           | `git show 9e0a159:tests/fixtures/boards/server.mjs \| grep -n greenhouse`                                      | `server.mjs` `8e1df5bae8d7`                                                              | **FALSE.** Two routes: `:108` `/boards.greenhouse.io/fixture-widgets/jobs/1000001` and `:137` `/boards.greenhouse.io/fixture-analytics/jobs/2000001` (`honest-greenhouse`). See the note below — the conclusion the row was cited for survives, and gets worse |
| 11  | Lead host distribution                                                 | `node -e` over `jobs/leads.db` (read-only, `node:sqlite`), parsing `leads.doc`                                 | **not pinnable** — gitignored and mutating; `271143daeddb`, mtime `2026-08-02T02:06:37Z` | **CHANGED.** 149 leads (was 141), 116 dismissed = **77.9%** (was 82.3%); adzuna 50, greenhouse 35, ashbyhq 17, coinbase 10, jobicy 8, oraclecloud 8, igt 7, smartrecruiters 5, samsara 4, lever 4, myworkdayjobs 1, **recruitee 0**                            |
| 12  | The user's caps                                                        | `git show 9e0a159:docs/application-limits.yaml \| grep -n "auto_apply" -A 6`                                   | `application-limits.yaml` `7e8447969088`                                                 | **HOLDS** — `:289-295`, `enabled: false`, `dry_run: true`, `per_run_max: 999`, `per_day_max: 999`, `per_company_max_per_week: 5`, `cache_max_age_days: 30`                                                                                                     |

**Row 10 is false, and is left false.** It is not re-worded to match what was found, because the
row's job is to fail when the tree moves. What it was cited for — that the fixture cannot
distinguish a **tenant** from an **origin** — is unchanged, and the second greenhouse route makes
the problem sharper rather than smaller. Run against the two fixture URLs, `boardKey` returns
`127.0.0.1/boards.greenhouse.io` for **both**: two Greenhouse tenants, one `board_key`, and — since
every route in this fixture is served from one loopback host and one ephemeral port
(`server.mjs:360`, `host = "127.0.0.1"`) — **one origin for every fixture board, Lever and Ashby
included.** So a fixture-backed test of §4.2's replacement key cannot show concurrency at all: keyed
on registrable origin, the whole fixture serialises to one in-flight job. That is a gap in the test
substrate, not in the design, and it is filed to the owner of `tests/fixtures/` rather than patched
here.

**Row 11 cannot satisfy §0.1's rule and should stop pretending to.** `jobs/leads.db` is gitignored
(`.gitignore:6`), so there is no commit that pins it and no `file_sha1` that means anything a day
later — the digest and mtime above are a snapshot, not a citation. The dismissal rate moved from
82.3% to 77.9% between two reads eighteen hours apart while the dismissed **count** stayed at 116,
which is exactly what a live denominator does. **C12's supply arithmetic uses the ~82% figure**;
whether ~78% changes its conclusion is `w5-leads`'s to redo under Phase 0.11, not something to
re-derive in a footnote here.

**The three "WORKING TREE ONLY" bullets are resolved — all three settled at `9e0a159`.** They are
recorded rather than deleted, because the fact that a whole section of this plan rested on an
**untracked** file is the failure mode worth keeping visible: at revision 1 the safest-looking
citations in the document pointed at bytes that existed on one machine.

- **`scripts/auto/authorize.mjs` is tracked and committed** (`git ls-tree 9e0a159 -- scripts/auto/`
  → blob `6e6c0de2`; content `8a030f1c5963`, 573 lines). Two corrections that follow from finally
  being able to read it at a fixed tree: the two citations `:427` and `:443-480` appear **nowhere
  else in this document** — the bullet claiming to list "every citation of it" listed two that do
  not exist. And `authorize.mjs:305-315`, cited by Phase 0.3 as where the raw third-party label
  enters a defer reason, is the **wrong location**: at `9e0a159` those lines are the trust-gate and
  screening pushes. The label reaches the reason string at **`:342-352`**, `d?.label` at `:348`.
  Phase 0.3's finding is unaffected; only its line number is. Correcting that row is `w4-autonomy`'s
  or the plan owner's call, and it is filed, not silently edited.
- **`assertNoOrphanAttempts` is committed** — `git grep -n "assertNoOrphanAttempts" 9e0a159 -- scripts tests`
  → `scripts/auto/audit.mjs:139` (call site) and `:192` (definition), in `19fce3042058`. Revision 1
  cited `:136`/`:189` from the worktree; three lines out, and at `fa192a1` the symbol did not exist
  at any line.
- **`preSubmitCheck` is gone.** `git grep -n "preSubmitCheck" 9e0a159 -- scripts tests` returns
  nothing. §4.10's rationale is now stated against a shape that exists rather than one mid-deletion.

**What `doc-scribe` did not verify, stated first because it is the part most likely to be assumed.**
This pass verified the twelve rows above and nothing else. No test was run, no board opened, no
browser launched. Rows 1-10 and 12 are text-presence checks against committed blobs — they show the
code **says** what the claim says, not that it **behaves** that way; only row 8's `boardKey` and row
10's route table were executed. Every citation elsewhere in this document — §4.x's line numbers, the
Phase tables, C8-C13's supporting greps — is **outside this pass and unverified at `9e0a159`**; the
two errors found in the three bullets above are reason to expect more.

**What the previous author did not verify** (their pass, at `fa192a1`, kept verbatim). Every
number in §2 and §7 that came from the survey — the browser and
SQLite timings, the market and ATS-behaviour findings, the concurrency knee at N=8 — is another
agent's measurement, and I re-ran none of it. I ran no tests and opened no board. I could **not**
reproduce `attack:feasibility`'s ~28 leads/day figure: `leads.doc` carries no `first_seen` or
`discovered_at` key and my query bucketed all 141 rows under an empty date. Their lead **count**
and **dismissal rate** I reproduced exactly; their **daily rate** I take on their word and it is
the reason Phase 0.11 exists. The 999 × 45s ÷ 8 composite in revision 1 is **withdrawn**, not
revised — F2 invalidated its isolation model and F4 showed the fill leg is unmeasured, so there
is currently no defensible wall-clock estimate in this document at all.

### 0.3 An unowned file set — flagged, not resolved

`docs/team-roster.md` assigns every path I checked **except two**: `scripts/status.mjs` and
`scripts/maintenance/*` appear nowhere in the roster (`grep -n "status\.mjs\|maintenance"
docs/team-roster.md` returns no ownership row). This plan requires edits to both — the progress
digest in Phase 4, the `migrate.mjs` rebuild path in Phase 1, and now **workspace retention at
volume** (Phase 1.8), which is a `prune-jobs`/`archive` concern and is the directory that grows
fastest under this plan. **`build-manager` must assign them before Phase 1 opens.** My
recommendation is unchanged and now has a third reason: both to `w4-autonomy`, on the reasoning
the roster used for `scripts/applications/*` — they are readers of `scripts/lib/db.mjs`, which
`w4-autonomy` already owns, and splitting a reader from its schema is what let
`check-applied.mjs` drift.

---
