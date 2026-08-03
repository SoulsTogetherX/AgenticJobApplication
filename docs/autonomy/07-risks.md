## 7. Risks, ranked

**R-1 — The user's real `profile.yaml` bullets are not résumé-shaped, and Phase 3 stalls.** Phase 3
rests on a file I have not read and cannot read. _Mitigation:_ `implementer` runs the assembler
against the real fact base **as the first task of Phase 3**, before writing selection logic, and
reports the gap as a list of bullets needing the user's edit. **Owner: `implementer`; the edit is
the user's.**

**R-2 — A systematically wrong answer goes out hundreds of times.** _Mitigation:_ Phase 2 is a
shipping prerequisite, with the ≥12-pair polarity corpus as its gate; typed intents defer rather than
invert. **Owner: `implementer`; gate `qa`.**

**R-3 — The breaker halts healthy runs, and the response is to weaken it.** _Mitigation:_ §4.6's
correlation keying is N-invariant (simulated: 0.00% run-stop at both N=3 and N=999 at p=5%), the
remaining single-sample proofs are invariant breaches rather than environmental outcomes (C13), and
transient kinds now retry before they can count. **Owner: `implementer`; verified by
`architect`.** _Residual, now quantified:_ board pauses strand ~0.3% of applications at p=5%
and ~2.8% at p=15%, and **`p` has never been measured** — Phase 4.7 tracks it.

**R-4 — A duplicate application to one cross-listed req.** _Mitigation:_ §4.11 test 4, on a
multi-location fixture, before the runner goes live. **Owner: `implementer`.**

**R-5 — The user's saved passwords and payment cards sit in the profile that visits hundreds of
third-party pages.** _Mitigation:_ Phase 0.4's allowlist, **and** §4.2's non-persistent lane, which
means the recommended launch boards touch no user profile at all. **Owner: `implementer`.**

**R-6 — Attacker text reaches a model through the deferral report.** The first convenience feature
that breaks rule 0 unattended is named and not hypothetical: _"summarise last night's run."_
_Mitigation:_ Phase 0.3 sanitises before the string is written. **Owner: `implementer`; corpus
`qa`.**

**R-7 — A silent STOP blocks every future run and nobody sees it.** _Mitigation:_ Phase 4.2 and 4.3,
plus §4.9's **scoped** `raiseStop` — only the four invariant breaches take `global`. **Owner:
`implementer`, which now owns `status.mjs` too (§0.3).**

**R-8 — Lead supply never reaches the volume the runner can handle. PROMOTED: this is now the most
likely reason the requirement is missed.** 141 leads lifetime, 82.3% dismissed; the measured
per-board yield implies an achievable ceiling closer to ~100 applications/day than 999 even after
board expansion (C12). _Mitigation:_ **Phase 0.11 measures it before six phases are built on an
assumption about it**, Phase 0.12 measures what fraction of real forms can reach green at all, Phase
0.13 recovers the 40% of leads currently lost to aggregator and embedded URLs, and Phase 6.1 gets a
numeric completion criterion. **Owner: `implementer`.** _Accepted:_ the runner will be idle-capable
before supply catches up, and that is the correct order.

> **0.11 MEASURED, 2026-08-02 (`build-manager`, at `0b6db30`). The estimate above was optimistic by
> roughly an order of magnitude, and the shape of the problem is worse than its size.**
>
> **≈5–7 new qualifying leads per day from the 44 configured boards** (not 46 — `docs/job-sources.yaml`
> has 44). Two live sweeps: the first stored 9 and rejected 6576; a second, 13 minutes later, stored
> **0** and rejected the same 6576. Wall time 31s.
>
> **"Per sweep" is not a rate, and that correction is the measurement.** The 9 was the accrual since
> the previous sweep. The store's own `found_at` history gives the real quantity — 66 on 2026-07-27
> (first-ever sweep, a backlog harvest), 33 on 07-28, 3 on 07-29, 36 on 07-30, 3 on 07-31, 8 on 08-02,
> 9 on 08-03. Git shows the board list reached 44 on 07-29 and has not moved since, so 07-30's 36 is
> the three boards added on 07-29 discharging their backlog, not a daily yield. Excluding both cold
> starts leaves **20 leads over 07-31..08-03**.
>
> **The board count for 999 qualifying leads/day: ~6,600 at 6.7/day, ~8,800 at 5/day.** Against 44
> today, that is **150x–200x**. This supersedes the "~100 applications/day even after board expansion"
> figure above, which was an inference rather than a measurement.
>
> **Both caveats push the number UP, not down.** (1) Linear scaling assumes the marginal board yields
> like the current ones; the current 44 are hand-picked tech employers and the 6,601st will not be
> Cloudflare. (2) **Adding boards buys a one-time backlog and then a trickle** — visible twice above,
> at 66 for the first sweep and ~12 per board for the three added 07-29. So a scale-up to thousands
> produces a large one-time harvest and then reverts. **999/day _sustained_ is a categorically
> different ask from 999 once, and this plan does not distinguish them anywhere.** It should.
>
> **What binds today, at the user's own settings:** `auto_apply.per_day_max` is 10, and supply is 5–7.
> Supply is already the binding constraint at the configured cap — the runner Phase 5 builds will be
> idle most of the time on arrival. That is the accepted order, but it is now a number rather than an
> expectation.
>
> **One more, unexplained:** the gates reject **6576 of 6585** fetched postings (99.86%), identically
> across both sweeps. More boards multiply both sides of that ratio. Whether widening the funnel is
> cheaper than widening the gates is an answerable question nobody has asked. The rejection breakdown
> by reason is **not** captured here — it prints only in human mode, and CLAUDE.md forbids passing
> `--verbose` from a tool call, so it needs a purpose-built script rather than a flag.
>
> **USER DECISION 2026-08-02: accept burst-then-idle.** R-8 is therefore **not** mitigated by reaching
> a sustained 999/day, and should stop being scored as though it were. The risk it now names is
> narrower and more tractable: **that a harvested burst expires before it is applied to.** At
> `per_day_max: 10` against `max_age_days: 30`, anything beyond ~230 leads in a batch is harvested and
> wasted — so the failure mode is a board-expansion campaign that looks successful by lead count and
> converts a small fraction of it. _Mitigation:_ Phase 6.1 gains a batch-size rule (~19 boards at a
> time at today's caps) and a second completion criterion measuring **conversion before expiry**, not
> only sustained rate. _Accepted:_ the runner is idle much of the time between bursts, and under this
> decision that is a correct state rather than a symptom.

**R-9 — Silent quality-tiering by the employer side, and challenge incidence rising with volume.**
_Mitigation:_ the fact-grounded, per-posting-tailored document is exactly what survives a
quality-scoring inbox — that is the thesis, not a hedge — plus Phase 4.4's challenge incidence as the
applicant-observable proxy, Phase 0.7's identity-field invariance, and §4.2b's arrival shaping
bounded by the recency SLA. **Owner: `implementer`; outward research `architect`.** _Unresolved and
honest:_ whether Real Talent aggregates spam signals **across** customers is not answered by any
public document. Nobody should claim it is settled.

**R-10 — ~50 half-filled applications sit under the user's name.** _Mitigation:_ §4.2c's navigate
verb plus explicit draft abandonment in W3 — **not** by deferring every multi-page form, which would
have been a volume loss dressed as a correctness win. **Owner: `implementer`.**

**R-11 — Ashby and Lever remain unmeasurable.** `bench-apply --board ashby` died in the accounted
arm's scan loader for want of a committed scan; all fixture scans were greenhouse- or shape-derived.
Ashby's nonce CSP and 700ms remount is the worst latency case the runner will meet. _Mitigation:_
Phase 0.10, now **before** anything touches the fill path. **Owner: `qa`.** _Status 2026-08-02:_
`ashby-step1.scan.json` and `lever-step1.scan.json` are committed in
`tests/fixtures/boards/scans/`, so the throw's precondition is gone — but **nobody has re-run
`--board ashby` and recorded the number**, so the risk is not closed, only unblocked.

**R-12 — A runner baseline is frozen against a broken measurement.** Today's greenhouse browser run
reports `fill_report ok:2 failed:1 deferred:3` — the fill aborted — and the harness passes; `--gate`
still charges +4 model turns when the ruling was +1. _Mitigation:_ M6 and M2 fixed in Phase 0.9,
**before any fill-path change lands, not merely before the runner baseline** (C11). **Owner: `qa`**
— the harness and the `docs/measurements.md` ledger entry are the same agent's now.

**R-13 — NEW. Cross-tenant state leakage between concurrent tabs sends the wrong document.** The
failure C9 describes is silent, irreversible, and invisible to a design that never reads anything back
out of the page. _Mitigation:_ origin-scoped exclusion, per-job contexts on the cookie-free lane, and
§4.11 test 7 — the isolation regression test. **Owner: `implementer`.**

**R-14 — NEW. The classifier corpus is thin and the first live night is where it is tested.** W2
reduces this to "thin corpus" from "no corpus", but a corpus assembled from attended applies will
under-represent tenant-configured strictness variants. _Mitigation:_ `unclassified` is the one
remaining hard STOP precisely because an unrecognised page is the case that must stop; every
classification is recorded so the corpus grows from real runs. **Owner: `implementer`;
`qa` cross-checks.**

---
