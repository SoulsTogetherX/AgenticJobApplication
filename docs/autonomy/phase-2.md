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
