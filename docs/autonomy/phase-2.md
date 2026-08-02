### Phase 2 — Typed intents (R3)

**Capability:** an answer whose truth value is wrong can no longer be produced, because the matcher
returns a typed intent rather than a string that happens to contain the right concept.

**Why it is a prerequisite and not a priority.** This is C6. A fuzzy match can find the right
concept with the wrong polarity — "authorized to work _without_ sponsorship" — and the same form
question appears on hundreds of boards. It is the single item whose _severity class_, not merely
its ordering, the user's decision altered.

| #   | Work item                                                                                                                                                                                                                                                                                                                                                                                              | Owner           | State |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------- | ----- |
| 2.1 | The answer-bank ladder **shall** be replaced by typed intents per `autonomy-plan.md:433-454`, such that a resolution carries `{concept, polarity, class, provenance}` and a polarity that cannot be established **defers**, never inverts. **Budget: declare before pickup** (C11).                                                                                                                    | `w3-resolution` | SHALL |
| 2.2 | Bank-sourced **free-text** answers over a length threshold **shall** defer on the unattended path. `SKIP_TYPES` (`answer-bank.mjs:402`) skips only `file` and `richtext`, so a textarea labelled "Anything else we should know?" is a fillable target today. This defers a **field**, not an application. **Budget: declare before pickup.**                                                           | `w3-resolution` | SHALL |
| 2.3 | A per-form **disclosure declaration**: the plan **shall** name the bank ids it will disclose, and an unusual set defers. The read side of the fact base is currently a lookup keyed on an attacker-chosen string (`answer-bank.mjs:712`, `normalizeQuestion` over the page's own label) and nothing counts how many distinct facts one form pulls. **Budget: declare before pickup.**                  | `w3-resolution` | SHALL |
| 2.4 | **DONE 2026-08-02** (`build-manager`, in rule 6 under "Throughput may only rise through deterministic understanding"). The prohibition **shall** be written into `CLAUDE.md` rule 6: unattended throughput may rise **only** through deterministic understanding — adapters, probed option lists, banked answers via `save-answer.mjs` — and **never** through model resolution of an `UNKNOWN` field. | `doc-scribe`    | SHALL |

**2.1–2.3 landed 2026-08-02 in `31661d3`** (`implementer`); 2.4 in `66937e0`. The falsifiable
check is green: `tests/apply/intents-polarity.test.mjs` carries **17 pairs** across all eight named
topics (≥12 required), asserted twice — matcher and whole bank — with count assertions so an
all-defer implementation fails. `grep -n "UNKNOWN" scripts/auto/*.mjs` returns nothing; deps are
`js-yaml` and `marked`, dev `playwright-core` and `prettier`. Gate 1740 full / 262 security.

**Delegate, not rewrite** — `scripts/apply/intents.mjs` is a pure core the bank calls — **but the
retirement is real:** `CONCEPTS`/`conceptOf`, the concept-constrained fuzzy pass and the whole
`polarityMismatch` guard are deleted, and the surviving token-similarity tier is fenced in both
directions. The second fence is the load-bearing one: an untyped label fuzzy-matching a banked
sponsorship answer is the same string copy, so a one-way fence lets the bug back in sideways.

**The corpus found one more live inversion in shipped code**: _"Have you **not** previously been
employed at Globex?"_ resolved `OK "No"` — the exact shape 2.1 exists to kill, ignoring the
negation because the ladder had nowhere to put a polarity.

**Three things carried forward, none of them blocking.**

- **2.3's threshold rests on 3 forms, not a distribution.** `disclosureFloor: 20` is bracketed by
  measurement (6 and 9 distinct bank ids on the two real scans, 14 on the densest synthetic this
  repo can build) and by the plan's own named 40-fact threat. `jobs/.shape-history.jsonl` — the
  real distribution — **is empty**, so the number could not be fitted to real data. Configurable,
  and the module comment says so. The same empty file is what 0.12 named as the honest path to a
  prevalence figure over all 141 leads: it accumulates for free as applications are made.
- **No end-to-end CLI run on an unmodified real scan.** Both scans in `jobs/` carry a CAPTCHA
  signal, so `buildPlan` short-circuits before examining a field — the same finding 0.12 reported
  as 4 of 4. Verified on a temp copy with the signal stripped (`items=14 defer=10 disclose=2/20`).
- **Three optional `auto_apply` keys are proposed, not applied** — `max_freetext_chars: 200`,
  `disclosure_budget: 20`, `disclosure_fraction: 0.25`. `docs/application-limits.yaml` is the
  user's file; absent keys behave exactly as the constants do today.

**On 2.4, and why it costs a paragraph now.** The unlimited-volume requirement creates direct
pressure to shrink the defer list, and the cheapest-looking reading of "make fewer things defer" is
"let a model resolve the UNKNOWNs" — which is the single change that puts attacker text and the
fact base in one context window on an unattended path. Naming it now costs a paragraph; discovering
it after a wave costs the rule. _(Endorsed by `attack:correctness` as the one place the plan
resists volume pressure correctly. Unchanged.)_

**Falsifiable check.** `tests/apply/` gains a polarity corpus: for each of ≥12 question pairs
differing only in negation, assert the resolution is either the correct typed intent or a defer —
**never** a confident inversion. The test asserts a count so an empty run cannot pass.
`grep -n "UNKNOWN" scripts/auto/*.mjs` shows no model call anywhere on that path, and `node -e`
over `package.json` shows no LLM SDK in dependencies.

---
