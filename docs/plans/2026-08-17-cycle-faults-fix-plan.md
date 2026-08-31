# Fix plan — faults found by the 2026-08-17 morning digest

Written 2026-08-17 from a run that tried to apply and could not. Every item
below names the file and line where the fault was **observed in code or by
execution**, not inferred from a description. Ordered by what unblocks
applications soonest. Nothing here has been implemented; this is the plan.

The user has approved, in chat on 2026-08-17, the three assertion answers the
two Render jobs defer on: work-authorized **Yes**, sponsorship needed **No**,
Race **Decline to self-identify**. Those values already live in
`profile/answers.yaml` (`work_authorization`); the approval is what lets the
user-directed path actuate them. It does not change the unattended defer list.

---

## 0. Ground truth established this session (do not re-derive)

- `launchBrowser()` from `scripts/apply/browser.mjs` launches fine as `xalva`,
  headless, from an interactive shell (2026-08-17). `playwright-core@1.62.1`
  in `node_modules` (installed 2026-07-31); browsers `chromium-1234` +
  `chromium_headless_shell-1234` in `%LOCALAPPDATA%\ms-playwright`
  (installed 2026-08-09, before both failing cycles).
- The registered Windows task is a **single** task `AgenticJobApplication`,
  user `xalva`, logon Interactive, action `scripts\auto\cycle.cmd` **with no
  arguments**, `DisallowStartIfOnBatteries = True`, LastRun 2026-08-17 07:31
  result `0x800710E0`, next 19:00. So: it is not `--skip-apply`, and it fires
  twice a day (7:00 and 19:00 — the 19:00 log entries are this same task).
- `auto_queue` has 3 rows, all `deferred`, all from run `2026-08-04T02-55`,
  `attempt_no=1`, never retried. `auto_submissions` is empty.
- Both Render fill plans (`jobs/render-*/fill-plan.json`) are dated
  **2026-08-06**; the Ashby `typeaheadFields` fix that un-defers Location
  landed **2026-08-07** (`fed2778`). Their resume + cover letter verify `pass`
  against the current profile hash (re-verified 2026-08-17T04:23Z).
- `scripts/auto/classify.mjs` carries **capture**-sourced confirmation rules for
  `job-boards.greenhouse.io` (10 real captures) and `jobs.ashbyhq.com` (3),
  promoted 2026-08-13. CLAUDE.md rule 6 still says every real ATS reads
  `unclassified`. It does not.

---

## 1. `cycle.mjs` prep stage fails `origin_stable` for every board lead — HIGHEST VALUE

**Observed:** `scripts/auto/cycle.mjs:387` calls
`trustBoard({ lead, limits, screening })` with **no `recordedOrigin`**.
`scripts/auto/trust.mjs:363` then adds `origin_stable=false` with "no origin
was recorded for this job when it was queued". Result: every Greenhouse/Ashby
lead is skipped **before a workspace is created**, so `prepared=0` on every
cycle since the check was added, and the runner never sees them. The Adzuna
leads fail earlier on `allowlist` (no `apply_url`), so the cycle has been
preparing nothing at all.

**Fix (one function, reused, not a second copy):**

1. Extract the per-lead resolution in `scripts/auto/auto-apply.mjs:216-262`
   (`detectAts` → `adapter.applicationUrl` → `submitOrigin` → `trustBoard`
   with `recordedOrigin`) into an exported helper, e.g.
   `resolveAndTrust(lead, { limits, screening, allowLoopbackHttp })` in
   `trust.mjs` or a new `scripts/auto/select.mjs`.
2. Call that helper from both `selectEligible` (auto-apply) and the cycle's prep
   loop (`cycle.mjs:384-406`). The cycle currently hands `trustBoard` the
   posting URL, not the application URL, which is the same mismatch the
   auto-apply comment at line 219 describes.
3. Test: `tests/auto/cycle*.test.mjs` — a Greenhouse lead with a valid
   `apply_url` and a `pass` screening must be **prepared**, not skipped;
   assert the skip reason list never contains `origin_stable` for a lead with
   an http(s) apply_url. Run `gate-audit.mjs` after (rule: any gate change).

**Why it matters:** this single check is why the top-20 recommendations
contain seven automatable board leads and zero of them have a workspace.

## 2. Windows task: wrong arguments, wrong power policy — USER'S ACT

**Observed:** see §0. The user's decision of 2026-08-13 was a 7:00
prepare-only run (`--skip-apply`); the registered task passes nothing, so it
runs the full cycle including the runner, twice a day, and is refused on
battery.

**Fix — the user runs this (registration is a system setting; the agent must
not):** in an elevated PowerShell,

```powershell
$act = New-ScheduledTaskAction -Execute "C:\Users\xalva\Documents\Projects\VibeCoded\AgenticJobApplication\scripts\auto\cycle.cmd" -Argument "--skip-apply"
$trg = New-ScheduledTaskTrigger -Daily -At 07:00
$set = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 2)
Register-ScheduledTask -TaskName "AgenticJobApplication" -Action $act -Trigger $trg -Settings $set -User $env:USERNAME -RunLevel Limited -Force
```

Then verify with `Get-ScheduledTask AgenticJobApplication | Get-ScheduledTaskInfo`.

**Repo-side fix (agent may do):** `scripts/auto/cycle.cmd` line 13 says the
registration command "is in the header of cycle.mjs" — it is not (grep for
`schtasks|Register-ScheduledTask` finds nothing outside `db.mjs`). Put the
command above into the `cycle.mjs` header and into
`docs/operate/01-commands.md`, so the next re-registration does not depend on
session notes.

**Decision needed from the user:** should the 19:00 run continue to exist at
all, and if so as `--skip-apply` too? The 2026-08-13 split named only 7:00.

## 3. `cycle.mjs` throws away the error that explains a failed stage

**Observed:** `scripts/auto/cycle.mjs:80-96` (`step()`): `detail` is the
**last three lines** of stderr, capped at 300 chars, and `r.signal` /
`r.error` are never read. Two consequences seen in `logs/cycle.log`:

- `apply: FAILED — ║ … ║ <3 Playwright Team ║ ╚═══╝` — the runner writes
  `auto-apply: could not start a browser — <message>` on its **first** stderr
  line (`auto-apply.mjs:697`) and Playwright's boxed hint follows; the slice
  keeps only the box's bottom edge, so the actual reason is gone. It launched
  fine interactively today, so the cause is environmental to the task run
  (candidates: a `PLAYWRIGHT_BROWSERS_PATH`/`LOCALAPPDATA` difference under
  Task Scheduler, or the pre-08-09 state on 08-13 that persisted for reasons
  the log cannot show). Fixing the logging is the prerequisite to knowing.
- `search: FAILED` with **empty** detail on 2026-08-16. `find-jobs.mjs`
  writes `e.message` to stderr on any crash (`find-jobs.mjs:1811`) — empty
  stderr + non-zero `ok` is the signature of the **600 s `spawnSync` timeout**
  (`cycle.mjs:237`), where `status` is `null` and `signal` is `SIGTERM`. The
  Common Crawl slug enumeration added 2026-08-13 (`f6c669f`) is the likely new
  cost. Unverifiable until the signal is logged.

**Fix:**

1. In `step()`, build `detail` from: `r.error?.message` if present, else
   `timed out after ${timeout}ms (${r.signal})` when `r.status === null`,
   else the **first** non-empty stderr line + the last two (first line is
   where this repo's scripts put the reason; the tail is where Playwright
   puts its box). Keep the 300-char cap for the summary line.
2. On failure, append the **full** stderr (capped at, say, 40 lines) to
   `logs/cycle.log` under an indented `stderr:` block, after the summary. The
   summary line stays one line; the log gains the reason.
3. Test: `tests/auto/cycle*.test.mjs` — a stub child that (a) exits non-zero
   with a multi-line stderr, (b) exceeds a tiny timeout — assert `detail`
   names the first line / the timeout respectively.
4. Then re-run one cycle by hand (`node scripts/auto/cycle.mjs --skip-search
--skip-apply` for prep; the apply leg only after §1) and read the real
   reason before touching the browser path at all.

## 4. Deferred `auto_queue` rows are never re-planned after code changes

**Observed:** the two Render rows have been `deferred` for 13 days with
`attempt_no=1`. Their plans predate the typeahead fix (§0), so the Location
deferral is **already fixed in code and still blocking in data**.
`readResumableAutoJobs` (`auto-apply.mjs:378`) is the only re-entry and the
runner has not launched since 08-04, so nothing has re-planned them.

**Fix:**

1. `auto-apply.mjs`: when a resumable row's `plan_sha256` differs from a
   freshly built plan (or when the row is `deferred` and its `reason_kind` is
   `needs-choice`/`confirm-field`, i.e. non-terminal), rebuild the fill plan
   before deciding. Cheap to gate: rebuild when `updated_at` is older than
   the newest commit touching `scripts/apply/` — or simply always rebuild on
   claim; the plan is deterministic and a stale one is never right by luck.
2. `status.mjs`: report queue rows whose `updated_at` is older than N days as
   `stale_deferred=N` — the digest said `outstanding=0` this morning while
   three rows had been sitting since 08-04, because `deferred` is not counted
   as outstanding. It should be surfaced, even if not counted.
3. Test: a deferred row + a changed adapter → next run re-plans and, if the
   defer reason is gone, proceeds; a row whose reason is terminal
   (`unknown-field`, `doc-unverified`) is not re-planned into a submit.

## 5. `prep-queue.mjs` default window is score-first, so aggregator leads crowd out every automatable one

**Observed:** `scripts/leads/prep-queue.mjs:270-282` ranks
`max(top*4, 20)` leads **by score first** and only then partitions by
applicability (`preferApplicable`). At the default `--top 5`, the 20-by-score
window contains **zero** automatable leads (Adzuna leads score 14–20 in this
ranking; the best board lead scores 8), so the queue prints
`manual_only=5, automatable=0`. With `--top 20` the window is the whole store
and `automatable=17, manual_only=0`. The cycle's own selection is a separate
path (via `recommend.mjs`) and is not affected, but any human or agent
reading the default queue is told there is nothing to do.

Also observed, not diagnosed: `recommend.mjs` scores Torc Robotics **19** and
`prep-queue.mjs` scores the same lead **5**. Two rankers, two numbers, one
lead. Worth one look at what `rankLeads` is being handed differently.

**Fix:**

1. Partition **before** windowing: rank all candidates, `preferApplicable`,
   then slice to the window / `top`. Or window per tier. Either keeps
   `preferApplicable`'s "must run before clustering" contract intact.
2. Print the tier tally against the **whole** ranked set, not the window, so
   `manual_only=5` cannot read as "that is all there is".
3. Test: a store with 20 high-scoring `apply_url`-less leads and one
   low-scoring Greenhouse lead → default queue contains the Greenhouse lead.

## 6. Adzuna leads without `apply_url` outrank everything and cannot be applied to

**Observed:** four of the top five recommendations are Adzuna redirect links
that Phase 0.13 canonicalization never resolved to a board; the cycle skips
them on `allowlist` and `prep-queue` grades them `manual-only`.

**Fix — two halves, both deterministic:**

1. **Canonicalize harder.** `enrich.mjs` / `canonical.mjs`: follow the Adzuna
   `/land/ad/<id>` redirect (one HEAD/GET, respecting the polite spacing added
   in `e75cc30`) and, when the final host is a known ATS, set `apply_url`.
   Many of these are staffing agencies whose real posting is on Dice/Jobvite
   and will still resolve to nothing — that is fine and should be recorded
   (`apply_url=null, canonical_tried_at=<ts>`) so it is not retried daily.
2. **Rank what can be sent.** `recommend.mjs` should carry the applicability
   tier the same way `prep-queue.mjs` does (it already returns `apply_url`
   since the fix noted at `recommend.mjs:130`), and the daily digest should
   print the top-5 **automatable** list separately from the top-5 by fit. The
   score is not wrong; the presentation is.

## 7. CLAUDE.md rule 6 is stale on the classifier (sixth time)

**Observed:** §0. Rule 6 says "every real ATS still classifies as
`unclassified`, and that is a hard STOP" and tells the agent to verify that
first. Verified: false for both allowlisted hosts.

**Fix (doc-scribe):** replace the capability sentence with the mechanical
check it already recommends — "run `node --test tests/auto/classify*.test.mjs`
and read `scripts/auto/classify.mjs`'s `capture`-sourced rules for the host
you are about to submit to" — and drop the assertion about what they say. A
capability paragraph that has been wrong six times should stop making
capability claims and start pointing at the test.

## 8. Harness permission for the runner (user's call, not a code change)

The interactive session that found all of the above could not run
`node scripts/auto/auto-apply.mjs` — the Claude Code permission classifier
denied it twice, once as "Stage 2 classifier error", once flat. If the user
wants the digest session (or any interactive session) to be able to drive the
runner, a Bash allow rule for that path is the mechanism; nothing in this
repo can grant it. Until then, the runner is reachable only from the Windows
task (§2) and from a terminal the user drives.

---

## Order of work

1. §3 (logging) — 30 min, no risk, and everything after it becomes
   diagnosable from the log instead of from a session.
2. §1 (origin_stable in cycle) — the fix that makes the cycle prepare
   anything; run `gate-audit.mjs` after.
3. §2 (task re-registration) — user's act, five minutes, can happen any time.
4. §4 (re-plan stale deferred rows) — makes the two Render jobs live again
   without a hand-run.
5. §5, §6 — presentation and canonicalization; the pipeline works without
   them but the human keeps being shown the wrong five jobs.
6. §7 — doc; do it in the same commit as §4 so the classifier claim and the
   code that depends on it move together.

Each code item is one `implementer` task with its own test; §7 is
`doc-scribe`. None of them changes a gate's decision — §1 hands the gate the
value it was already designed to compare against; §4 re-asks a question the
gate already answers. `npm test` once at the end, then commit on `dev` if the
user asks.
