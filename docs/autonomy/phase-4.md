### Phase 4 — Observability, the defer taxonomy, and the measurement gate

**Capability:** the user can tell, in one command, whether the machine is working — and engineering
effort is allocated by measured application-loss rather than intuition.

**Deferral-driven development.** Every deferral already carries a reason. Type those reasons,
aggregate them across a campaign, and the defer log becomes the product's own backlog generator:
_"`unprobed-dropdown` on Workday cost 61 applications this week; building the Workday option-probe
unlocks them."_ The only sanctioned throughput lever — the machine understanding more — becomes a
measured, prioritised list. This requires the reasons to be **typed values, not strings**. A
free-text reason cannot be aggregated and will be reworded past on the first try; that is string
matching where a type belongs, and it is why 4.1 comes before 4.2.

| #       | Work item                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Owner                      | State |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | ----- |
| 4.1     | A closed **defer/failure taxonomy** (§4.6) **shall** be defined as typed kinds with a `stage` and a `board_key`, written to `auto_queue.reason_kind`, with the sanitised human detail in `reason_detail`. **Including `board-paused`**, written to every job a board pause strands — revision 1 left those jobs in `queued` with no kind, so the largest single loss bucket in a degraded run was invisible to the digest and to the defer-rate gate that the whole phase rests on (`attack:feasibility`, accepted).                                                                                                                  | `w4-autonomy`              | SHALL |
| 4.2     | `status.mjs` **shall** gain an auto section reporting **progress, not recency**: submissions in the last 24h, deferrals grouped by `reason_kind`, orphan count, STOP set yes/no with its reason, `posted_at → submitted_at` p50/p95, **and — added on review — queue depth and age p95 for `queued`/`claimed`, the list of currently paused `board_key`s with their held counts, `challenged` (unconfirmed) count, and a WARN when any row has been queued longer than one scheduler cadence.** A queue depth that is not falling is the single most informative number the auto path has, and revision 1's digest could not show it. | owner per §0.3             | SHALL |
| 4.3     | `INBOX.md` **shall** become an append-only alert channel that `raiseStop` and every security-class finding writes to, **kept separate from STOP's brake.** `raiseStop`'s first-reason-wins rule is correct for the run record and wrong for notification: a benign STOP at job 3 buries a credential-exposure STOP at job 400. A Windows toast **shall** fire on STOP.                                                                                                                                                                                                                                                                | `w4-autonomy`              | SHALL |
| 4.4     | **Challenge incidence** — CAPTCHA, `bot-challenge`, `email-code-challenge` — **shall** be aggregated per board per run, and a challenge appearing on a previously challenge-free board **shall** be an anomaly-breaker input. Employer-side flagging is silent, so rising challenge incidence is the only applicant-observable proxy for being scored down.                                                                                                                                                                                                                                                                           | `w4-autonomy`              | SHALL |
| 4.5     | _(Moved to Phase 0.9 — C11.)_                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | —                          | MOVED |
| 4.6     | _(Moved to Phase 0.10 — C11.)_                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | —                          | MOVED |
| 4.7     | `scripts/dev/bench-runner.mjs` **shall** exist and track **nine** numbers: **submitted**-applications-per-hour and **deferred**-applications-per-hour reported separately, defer-rate by reason class, model-turns-per-application, unconditional-sleep-ms-per-application, edge-spacing-wait-ms-per-application, p95 per-application wall, spawns-per-application, round-trips-per-application, and **per-job failure rate `p` per board**.                                                                                                                                                                                          | `qa-breaker`, `innov-perf` | SHALL |
| **4.8** | **NEW (review, missing).** Every number this plan produces **shall** land in `docs/measurements.md` as a ledger entry with its command, its legs and its shas. Revision 1 had seven phases, a CI gate, six tracked columns and a user-facing concurrency proposal, and not one work item that wrote a ledger entry — which is exactly how the 7.74/7.92 knee, the 240ms/1823ms SQLite figures and the 87.89ms probe reached this document with no command attached to any of them.                                                                                                                                                    | `innov-perf`               | SHALL |

**On 4.7, and why the column list changed. (`attack:feasibility`, accepted.)** In this repo
`model_turns` and `round_trips` are **derived, not observed**: `bench-apply.mjs:228-231` computes
`model_turns` as `PROTOCOL.filter(s => s.when(c)).length`, a static model of the prescribed MCP
flow, and `docs/measurements.md:88-95` records this as a standing caveat — M4 further records that
11 of 15 PROTOCOL citations had gone stale. Making a **derived** column the one hard, no-override
gate means the criterion the plan calls absolute is the one that can never fire. So `bench-runner`
**shall clock these, not derive them**: `model_turns` from an observed count (process spawns plus
outbound HTTP to any non-loopback host, both trivially instrumentable in-process), `round_trips`
from `clockedPage`'s existing `cdp_calls` counter (`bench-apply.mjs:1653`). Every column in the
harness output **shall** be labelled `measured` or `derived`, as `bench-apply` already does.

**Applications-per-hour alone is the wrong primary metric because it is gameable: deferring more
raises it, since a deferral is fast.** Revision 2 goes further and requires submitted and deferred
throughput as **separate columns**, because "how fast is a deferral" was never measured and without
it nobody can tell whether a defer-rate change moved the number for good reasons or bad ones.

**The CI gate, implementable as written** (`ci-engineer` wires it, `qa-breaker` owns the harness):

```
node scripts/dev/bench-runner.mjs --apps 50 --concurrency 8 --board greenhouse --runs 3 --json
```

against the loopback fixture in `dry_run` with a fixture submit endpoint, **against the
parameterised employer segment from Phase 0.10** — without it, every fixture job shares one
`board_key` and one origin, the exclusion rule serialises all 50, and the command reports N=1
throughput under the label N=8 (verified: `tests/fixtures/boards/server.mjs:104-113` defines a
single greenhouse path). `bench-runner` **shall** assert that observed max-in-flight equals the
requested concurrency and fail the run if it does not.

**FAIL** on: `sleep_ms_per_app > baseline × 1.10` unless the PR body carries
`perf-budget: sleep_ms +N`; `model_turns > 0` on any green-tier lead (hard, no override — green is
_defined_ as removing the model, and 4.7 makes this column observed so the gate can actually fire);
`round_trips_per_app > baseline` (budget-overridable); `defer_rate > baseline + 2pp`;
**`durable_attempted_rows === apps_that_reached_authorized`** and **`rows_in_state('attempted') === 0`
at run end**. **WARN ONLY** on `wall_ms_p95 > baseline × 1.25`. Each gated column **shall** state
which statistic it compares on (mean, min or p50) — unstated for all five in revision 1, and
`--runs 3` gives variance control on `wall_ms` only, since derived columns repeat identically.
Refuse to compare across a dirty `MEASURED_FILES` tree.

**CORRECTION (review, `attack:feasibility`, accepted).** Revision 1's gate contained
`durable_attempted_rows != apps_started` as a hard FAIL, which contradicts its own state machine:
deferrals exit at `planned` or `authorized`, **before** the attempted row is written, and the
taxonomy lists 14 pre-attempt kinds. The gate would have been red on every run by construction —
and within a week the team would be passing it with an override line, which is the exact failure
mode the plan reasons about correctly for `wall_ms_p95` and then reintroduced here.

**Falsifiable check.** `node scripts/status.mjs --json` emits an `auto` object with every field in
4.2, and a test asserts a fixture DB containing an orphan, a paused board with stranded jobs, and a
STOP produces all three in the output. The CI gate is proven by a deliberately-regressed branch: a
PR adding a `waitForTimeout(200)` to `fill-engine.mjs` must turn the gate red without a
`perf-budget` line, **and** a PR adding a real model call to the fill path must turn the
`model_turns` gate red — the second check exists because revision 1's derived column would have
stayed green.

---
