### Phase 6 — Supply and the outcome loop

**Capability:** the lead supply can feed the runner, and the pipeline gets better at targeting with
every hundred applications sent.

**Why last, and why it is nonetheless the largest number in the system.** Supply solved _first_
buys nothing — leads that cannot become documents unattended are leads that sit. Documents first
(Phase 3) gives a working unattended loop that scales linearly the moment boards are added.
**But its measurement is hoisted to Phase 0.11 (C12), because revision 1 scheduled six phases of
build ahead of the number that says whether they reach the target.**

| #       | Work item                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Owner         | State |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ----- |
| 6.1     | `discover-boards.mjs` / `find-boards.mjs` **shall** scale board discovery from the 44 boards in `docs/job-sources.yaml` toward the count 0.11 derives. **Completion criterion is numeric: qualifying leads per 12h sweep ≥ X, sustained over 4 sweeps**, where X comes from 0.11 — revision 1's "tracked over four sweeps" carried no target and therefore could not go red. Greenhouse + Ashby + Lever direct boards are both trust-gate-friendly and ban-free.                                                                                                                                                                                                                                                                                                                | `implementer` | SHALL |
| 6.2     | Recruitee boards **shall** be added, and Recruitee's documented, unauthenticated Careers Site submit endpoint (`POST /offers/:offer_slug/candidates`, verified at docs.recruitee.com 2026-08-01, explicitly "from candidate perspective") **shall** be the pilot no-browser submit lane. **Zero Recruitee leads exist today** (measured, §0.2), so this pays off only after 6.1. As the only lane with zero bot-scoring exposure it is, if anything, undersold.                                                                                                                                                                                                                                                                                                                 | `implementer` | SHALL |
| 6.3     | When multiple green leads share a company, `recommend.mjs` **shall** order them by title-similarity to the profile target before the weekly window fills. This spends the user's chosen 5/week on the strongest set **without lowering any cap.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | `implementer` | SHALL |
| 6.4     | Outcomes recorded via `update-application.mjs` **shall** feed back as priors into `fit.mjs` scoring.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `implementer` | SHALL |
| **6.5** | **REVISED (review).** `architect` **shall** record in `docs/research/`: the ToS posture (candidate self-automation on ATS-hosted forms is contractually unaddressed; LinkedIn/Indeed prohibit it and stay out of the submit path); that competitor-blog "reviews" are marketing and must not be cited as user evidence; **the Greenhouse reCAPTCHA doc as a vendor-primary source (article 115005448066)**; **that SmartRecruiters documents a public Application API (`POST /postings/:uuid/candidates`) which is customer-token-gated and therefore not candidate-usable** — recorded so nobody re-surveys it and concludes the survey was sloppy; and **MyGreenhouse's "quickly apply" flow as an unresearched possible candidate-side lane**, assigned rather than assumed. | `architect`   | SHALL |
| **6.6** | **NEW (review, missing).** Outcome recording at volume. §6.4's priors depend entirely on data the plan has no mechanism to collect once the user is receiving hundreds of responses. **Shall** specify at minimum a bulk outcome-entry path; the confirmation-email ingestion option is §6.7 and is the user's consent decision, not an assumption.                                                                                                                                                                                                                                                                                                                                                                                                                             | `implementer` | SHALL |

> **USER DECISION 2026-08-02: accept the burst-then-idle pattern.** 0.11 established that adding
> boards buys a one-time backlog and then a trickle, and asked whether to reframe the 999/day
> requirement as sustained or to accept bursts. **The user chose bursts.** That is now a constraint on
> 6.1 rather than an open question, and it has a consequence 6.1 must be built around.
>
> **Bursts are capped by staleness, not by ambition.** `max_age_days: 30` rejects a posting older
> than 30 days, and `auto_apply.per_day_max` is 10. A burst of N leads takes N / per_day_max days to
> consume, so a burst is only fully usable while **N ≤ per_day_max × usable_days** — and usable_days
> is under 30, because leads arrive already partly aged. Everything above that line goes stale
> unapplied. It is harvested, stored, counted, and wasted.
>
> The cold-start yield measured in 0.11 is **~12 leads per board** (the three boards added 2026-07-29
> produced 36 on the next sweep). That gives a batch size:
>
> **boards per batch ≈ (per_day_max × usable_days) / 12**
>
> | `per_day_max` | usable window | burst consumable | **boards to add at once** |
> | ------------- | ------------- | ---------------- | ------------------------- |
> | 10 (today)    | ~23 days      | ~230 leads       | **~19**                   |
> | 100           | ~23 days      | ~2,300 leads     | ~190                      |
> | 999           | ~23 days      | ~23,000 leads    | ~1,900                    |
>
> **So at today's settings, 6.1 should add boards roughly 19 at a time and then wait**, not scale to
> thousands in one pass. Adding 500 boards at `per_day_max: 10` would harvest ~6,000 leads and let
> roughly 96% of them expire. Each batch also permanently raises the idle-phase floor: 19 more boards
> on top of 44 lifts the trickle from ~5–7/day to roughly ~8–10/day.
>
> **6.1's completion criterion changes shape accordingly.** "Qualifying leads per 12h sweep ≥ X
> sustained over 4 sweeps" measures the trickle, which under this decision is explicitly **not** the
> thing being optimised. It needs a second criterion for the burst: **what fraction of a batch's
> harvest was applied to before it went stale.** A batch that yields 300 leads and converts 40 is a
> failure that the sustained-rate criterion would score as a success.
>
> **What this does not change:** reaching a sustained 999/day still needs ~6,600–8,800 boards (§7
> R-8). Bursts change _when_ throughput arrives, not the board count the steady state requires.

**Falsifiable check.** 6.1: **qualifying leads per sweep against the numeric X from 0.11**, tracked
over four sweeps. 6.3: a test that ten same-company green leads yield the five most title-similar
first. 6.4: a backtest asserting that priors derived from a fixture outcome set change `fit.mjs`'s
ranking in the expected direction on held-out leads.

**6.4 costs time, not code.** It needs several hundred applications with recorded outcomes before
the signal is worth anything. That is why it is last, and why the volume decision is what makes it
possible at all.

---
