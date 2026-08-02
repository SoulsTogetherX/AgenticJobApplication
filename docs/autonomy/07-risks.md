## 7. Risks, ranked

**R-1 — The user's real `profile.yaml` bullets are not résumé-shaped, and Phase 3 stalls.** Phase 3
rests on a file I have not read and cannot read. _Mitigation:_ `w6-documents` runs the assembler
against the real fact base **as the first task of Phase 3**, before writing selection logic, and
reports the gap as a list of bullets needing the user's edit. **Owner: `w6-documents`; the edit is
the user's.**

**R-2 — A systematically wrong answer goes out hundreds of times.** _Mitigation:_ Phase 2 is a
shipping prerequisite, with the ≥12-pair polarity corpus as its gate; typed intents defer rather than
invert. **Owner: `w3-resolution`; gate `qa-breaker`.**

**R-3 — The breaker halts healthy runs, and the response is to weaken it.** _Mitigation:_ §4.6's
correlation keying is N-invariant (simulated: 0.00% run-stop at both N=3 and N=999 at p=5%), the
remaining single-sample proofs are invariant breaches rather than environmental outcomes (C13), and
transient kinds now retry before they can count. **Owner: `w4-autonomy`; verified by
`innov-resilience`.** _Residual, now quantified:_ board pauses strand ~0.3% of applications at p=5%
and ~2.8% at p=15%, and **`p` has never been measured** — Phase 4.7 tracks it.

**R-4 — A duplicate application to one cross-listed req.** _Mitigation:_ §4.11 test 4, on a
multi-location fixture, before the runner goes live. **Owner: `w5-leads`.**

**R-5 — The user's saved passwords and payment cards sit in the profile that visits hundreds of
third-party pages.** _Mitigation:_ Phase 0.4's allowlist, **and** §4.2's non-persistent lane, which
means the recommended launch boards touch no user profile at all. **Owner: `w4-autonomy`.**

**R-6 — Attacker text reaches a model through the deferral report.** The first convenience feature
that breaks rule 0 unattended is named and not hypothetical: _"summarise last night's run."_
_Mitigation:_ Phase 0.3 sanitises before the string is written. **Owner: `w4-autonomy`; corpus
`w1-security`.**

**R-7 — A silent STOP blocks every future run and nobody sees it.** _Mitigation:_ Phase 4.2 and 4.3,
plus §4.9's **scoped** `raiseStop` — only the four invariant breaches take `global`. **Owner:
`w4-autonomy` and the `status.mjs` owner per §0.3.**

**R-8 — Lead supply never reaches the volume the runner can handle. PROMOTED: this is now the most
likely reason the requirement is missed.** 141 leads lifetime, 82.3% dismissed; the measured
per-board yield implies an achievable ceiling closer to ~100 applications/day than 999 even after
board expansion (C12). _Mitigation:_ **Phase 0.11 measures it before six phases are built on an
assumption about it**, Phase 0.12 measures what fraction of real forms can reach green at all, Phase
0.13 recovers the 40% of leads currently lost to aggregator and embedded URLs, and Phase 6.1 gets a
numeric completion criterion. **Owner: `w5-leads`.** _Accepted:_ the runner will be idle-capable
before supply catches up, and that is the correct order.

**R-9 — Silent quality-tiering by the employer side, and challenge incidence rising with volume.**
_Mitigation:_ the fact-grounded, per-posting-tailored document is exactly what survives a
quality-scoring inbox — that is the thesis, not a hedge — plus Phase 4.4's challenge incidence as the
applicant-observable proxy, Phase 0.7's identity-field invariance, and §4.2b's arrival shaping
bounded by the recency SLA. **Owner: `w3-resolution`, `w4-autonomy`, `researcher`.** _Unresolved and
honest:_ whether Real Talent aggregates spam signals **across** customers is not answered by any
public document. Nobody should claim it is settled.

**R-10 — ~50 half-filled applications sit under the user's name.** _Mitigation:_ §4.2c's navigate
verb plus explicit draft abandonment in W3 — **not** by deferring every multi-page form, which would
have been a volume loss dressed as a correctness win. **Owner: `w3-resolution`, `w2-engine`.**

**R-11 — Ashby and Lever remain unmeasurable.** `bench-apply --board ashby` dies at
`bench-apply.mjs:1215`; all fixture scans are greenhouse- or shape-derived. Ashby's nonce CSP and
700ms remount is the worst latency case the runner will meet. _Mitigation:_ Phase 0.10, now **before**
anything touches the fill path. **Owner: `qa-adversary`.**

**R-12 — A runner baseline is frozen against a broken measurement.** Today's greenhouse browser run
reports `fill_report ok:2 failed:1 deferred:3` — the fill aborted — and the harness passes; `--gate`
still charges +4 model turns when the ruling was +1. _Mitigation:_ M6 and M2 fixed in Phase 0.9,
**before any fill-path change lands, not merely before the runner baseline** (C11). **Owner:
`qa-breaker`; ledger `innov-perf`.**

**R-13 — NEW. Cross-tenant state leakage between concurrent tabs sends the wrong document.** The
failure C9 describes is silent, irreversible, and invisible to a design that never reads anything back
out of the page. _Mitigation:_ origin-scoped exclusion, per-job contexts on the cookie-free lane, and
§4.11 test 7 — the isolation regression test. **Owner: `w4-autonomy`, `w2-engine`.**

**R-14 — NEW. The classifier corpus is thin and the first live night is where it is tested.** W2
reduces this to "thin corpus" from "no corpus", but a corpus assembled from attended applies will
under-represent tenant-configured strictness variants. _Mitigation:_ `unclassified` is the one
remaining hard STOP precisely because an unrecognised page is the case that must stop; every
classification is recorded so the corpus grows from real runs. **Owner: `w4-autonomy`;
`qa-adversary` cross-checks.**

---
