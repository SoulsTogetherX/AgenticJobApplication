### Phase 3 — Deterministic document assembly

**Capability:** documents are produced without a human in the session. The ceiling on applications
stops being "how many documents a supervised model batch produced" and becomes "how many leads
exist". **This is the phase that lifts the first binding constraint of §2.**

**The one property this buys that patching cannot:** the pipeline becomes unattended along its
entire length, and the only operation in the document pipeline that _can_ lie is removed rather
than checked.

| #   | Work item                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Owner                         | State |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | ----- |
| 3.1 | `scripts/documents/assemble-resume.mjs` **shall** exist: `(job.json, profile.yaml, answers.yaml)` → `buildPlan`'s `must_use` → select fact ids by coverage under a length budget → emit each fact's text **verbatim** with its `<!-- fact:ID -->` annotation, in the `good-resume.md` shape. Passes R1-R7 by construction. Zero model turns. Only `keyword-plan` reads the posting and it already sanitizes.                                                                                                                                                                                                      | `w6-documents`                | SHALL |
| 3.2 | A model rephrase pass **shall** remain available as an **optional, re-verified** step in attended sessions — never as the only path, and never on the unattended path.                                                                                                                                                                                                                                                                                                                                                                                                                                            | `w6-documents`                | SHALL |
| 3.3 | Cover letters **shall** stay model-authored and **shall** be authored per reuse cluster, not per job (`scripts/leads/cluster.mjs` EXISTS). Do not degrade the letter to a template: the only field experiment (ResumeGo, n=7,287, ~2020) puts tailored letters at 16.4% callbacks against 12.5% generic. If letter throughput is the bottleneck, scale the clustering, not the quality. **Shall** state a per-cluster token/dollar estimate — this is the only remaining model cost in the system and it is currently unpriced.                                                                                   | `w6-documents`                | SHALL |
| 3.4 | `verify-claims.mjs` and `reuse-check.mjs` **shall** be refactored from top-level scripts into exported pure functions with thin CLI wrappers (`grep -c "^export"` returns `0` on both today). The fact index **shall** be built once per run; each workspace's tech-stack set **shall** be cached in the DB so `reuse-check` becomes a join rather than a readdir plus a lexicon scan of every sibling on every call. **This is a signature change, not a rewrite.** **Budget: declare a target before pickup** — this item is sold as a speed-up and currently has no number attached in either direction (C11). | `w1-security`, `w6-documents` | SHALL |
| 3.5 | Hard rule 5's approval message **shall** become a mechanical selection diff — which fact ids were included, which dropped, and why — rather than a model's self-report of what it emphasised.                                                                                                                                                                                                                                                                                                                                                                                                                     | `w6-documents`, `doc-scribe`  | SHALL |

**Cost, stated plainly.** ~250 lines plus a golden-file test per profile section, plus 3.4's
signature change, plus **a register change the user must accept**: résumés will read in the user's
own approved sentences rather than posting-matched prose. That is Open question §6.2.

**The honest risk.** This requires that profile bullets are usable verbatim in a résumé.
`buildFactIndex` (`lib.mjs:147-183`) stores exactly that shape, and the passing fixture
(`tests/fixtures/good-resume.md:13`) is a profile fact's text plus its annotation. But the user's
real `profile.yaml` is gitignored and I have not read it. If its bullets are note-shaped rather
than résumé-shaped, this becomes a one-time fact-base editing pass **by the user** — never by the
agent, rule 2 — and that pass is on the critical path.

**Falsifiable check. REVISED (review, both critics concurring).** Revision 1 asked for "the absence
of any network egress", which is green by construction — `assemble-resume.mjs` is a pure local
script and `package.json` carries no LLM SDK, so the check could never go red for the property it
claimed to establish, and it would stay green if a later change routed rephrasing through an
`execFileSync` of a model CLI in the _caller_. Replaced by three checks that can fail:

1. For ≥6 job fixtures spanning different tech stacks, the assembler's output is **byte-identical
   to a committed golden file**, passes `verify-claims resume <out>` with exit 0, and every
   sentence appears verbatim in `profile.yaml` or `answers.yaml`.
2. A **static assertion on the import graph** of `assemble-resume.mjs`: no `child_process`, no
   `fetch`/`undici`, no LLM SDK — plus a runtime spawn counter via a monkeypatched
   `child_process` in the test.
3. **A throughput number**: documents-per-hour for the assembler versus the current attended path,
   recorded as a ledger entry in `docs/measurements.md`. This is the number Phase 3 exists to move
   and it is currently unmeasured in both directions.

Plus the rule-0 check, unchanged: for a posting containing an instruction-shaped payload, the
assembled résumé is byte-identical to the one assembled from the same posting with the payload
removed. **The campaign-level `model_turns === 0` assertion moves to Phase 4.7's runner harness,
where it can actually observe the whole path.**

---
