## 2. The thesis

**This is not an auto-applier. It is a provenance machine that happens to submit.**

Every comparable service surveyed **generates**: a model writes plausible résumé prose and a bot
pushes it through a form. That architecture has one failure mode and it is fatal at volume — the
output degrades exactly when attention is scarcest, which is precisely when volume is high.
Jobright's dominant complaint pattern is hallucinated metrics; LazyApply sits at 2.5/5 with
wrong-field fills; the one honest volume self-report is 819 applications for a 0.6% interview rate.

This repository **selects**. Content is drawn verbatim from an approved fact base, each résumé
sentence carries a fact id, `verify-claims` R6 rejects anything the base cannot back, the fill
pipeline has no model on the critical path (`package.json` carries no LLM SDK — deps are `js-yaml`
and `marked`), and a hostile posting is rejected at screening rather than argued with.

The property that follows is the edge, and it is real:

> **Per-application quality is invariant to volume.** Quality is a function of the fact base and
> the gates, not of how much attention was available that night. The 400th application of the
> night is byte-for-byte the standard of the first.

**CORRECTION (review, `attack:outside-reality`, accepted).** That claim holds for document
**content** and does **not** hold for submission **behaviour**. The behavioural layer is exactly
where volume degrades outcome: reCAPTCHA scoring consumes IP reputation and event-stream absence,
both of which worsen with concentration; a burst of hundreds of submissions from one residential
IP inside two hours is the canonical mass-application fingerprint. So the honest thesis is
**quality-of-content invariant to volume, quality-of-outcome contingent on submission shape** —
which is why §4.2b (arrival shaping, bounded by the recency SLA) and Phase 4.4 (challenge
incidence as a first-class measured column) exist. Saying it the other way would have been the
same class of error as the fatal above: mistaking a property of the documents for a property of
the system.

That matters now in a way it did not two years ago. Greenhouse's Real Talent quality-tiers
applications and blocklists by IP and email domain; Ashby reports 300+ applications per opening.
The market is building a filter whose input is _"does this look mass-produced"_. A pipeline whose
documents are assembled from one real person's verified facts, tailored per posting, is the shape
that survives that filter. The honesty rule and the efficacy argument point the same way, which is
rare and worth saying out loud: keyword stuffing, the classic gaming move, is explicitly listed by
employer-side tooling as a spam signal.

Two capabilities nobody in the surveyed field has, both already latent here: **a deferral with a
stated reason**, and **a local store of record** the user keeps if the project dies. Add the
volume decision and a third becomes available: at hundreds of applications a day the system
generates enough outcome data to _learn_ what it should be targeting. Volume stops being spray and
becomes measurement.

**The direction, in one sentence:** the only job-application system that can send 500 applications
and, for every one of them, name the fact behind each sentence, the reason it declined the ones it
declined, and the durable record of exactly what went out.

**The two binding constraints, stated together.** First, the model is still on the document path,
so until Phase 3 lands the runner can never apply to more jobs than a human sat through a model
batch for. Second — and this is new in revision 2 — **lead supply is very likely the harder
constraint**: the measured yield implies an achievable ceiling closer to ~100 applications/day than
999 even after board expansion (C12). Neither is engineered around by lowering the requirement.
Phase 0.11 measures the second one **before** six phases are built on an assumption about it.

> **0.11 has now measured it (2026-08-02, `build-manager`; full derivation and caveats in §7 R-8), and
> the second constraint is not merely the harder one — it is the only one with no known path to the
> requirement.** From the 44 configured boards: **≈5–7 new qualifying leads per day**. Reaching 999/day
> needs **~6,600–8,800 boards**, a 150x–200x expansion, and both caveats on that figure push it up
> rather than down.
>
> Two things follow for this document's own argument. **The "~100/day even after board expansion"
> figure above was an inference and is superseded by a measurement an order of magnitude below it.**
> And the sequencing principle still holds, but its meaning changes: Phase 3 lifts the _first_
> constraint, and when it does, the runner is not throughput-bound — it is **supply-bound, at the
> user's current `per_day_max` of 10, immediately.** That is the correct order and it was measured
> before six phases were built on it, which is exactly what 0.11 existed to do.
>
> **The distinction this plan has been missing:** 999 applications/day _sustained_ requires 999
> qualifying leads/day _arriving_. Adding boards yields a one-time backlog and then a trickle, so a
> large expansion produces a burst and reverts. Nothing in this document currently separates the
> burst from the steady state, and the requirement is a steady-state one.

**The sequencing principle:** everything before the first real click is cheap and reversible;
everything after it is irreversible and signed with the user's name. Order accordingly — state
before behaviour, correctness-of-content before volume-of-content, volume last, because volume
multiplies whatever is true when it arrives. **And measure before you build on the number** — F4
and F5 were both this principle applied to measurement, which revision 1 exempted from it.

---
