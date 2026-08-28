# `src/documents/` — producing and checking documents

**Owner:** `implementer`.

The tailoring chain. **There is no model in it.** `assemble-resume.mjs` emits
each approved fact verbatim with its `<!-- fact:ID -->` annotation, which is why
hard rule 1 holds by construction and why the whole pipeline can be scheduled
unattended — that property, not the runner, is what makes autonomy possible.

## Entry points

| Command               | What it does                                                                |
| --------------------- | --------------------------------------------------------------------------- |
| `new-job.mjs`         | Scaffolds `jobs/<slug>/{job.json, context.json}`.                           |
| `keyword-plan.mjs`    | The honest keyword target, read from the sanitised posting.                 |
| `assemble-resume.mjs` | Deterministic tailoring: selects and orders approved facts, never rewrites. |
| `letter-plan.mjs`     | Cover letters per reuse cluster rather than per job.                        |
| `verify-claims.mjs`   | **The truthfulness gate.** R1–R8; nothing renders until it passes.          |
| `reverify.mjs`        | Re-runs verification for documents whose recorded row went stale.           |
| `render-pdf.mjs`      | Markdown to PDF via local Edge/Chrome headless.                             |
| `reuse-check.mjs`     | Can an already-tailored résumé serve this posting?                          |
| `ats-lint.mjs`        | Will an ATS actually be able to parse this?                                 |

## What does not belong here

- Deciding **whether** to tailor for a lead — that is `src/leads/prep-queue.mjs`.
- Anything that types into a live form — that is `src/apply/`.
- Any call to a language model. If a change here starts to want one, the answer
  is a deterministic rule or a deferral, not a model.

## Traps

- **PDF rendering shells out** to a locally installed Edge or Chrome; override
  with `PDF_BROWSER`. A missing browser is a skipped test, not a failure, so
  read what `tools/ci/report-browsers.mjs` printed before believing a green run.
- `checkWrittenForm`'s pair list is deliberately short — every entry is a
  measured false-negative, and adding speculative pairs costs correct documents.
- **`answers.yaml` question text is not evidence.** Use `evidenceText()`; the
  question came off an employer's page, and treating it as corroboration lets a
  poisoned label vouch for a claim.
- Verify-claims R6 flags a technology you name even to **deny** it, and a
  lexicon company name in a `Re:` line. That is the gate working.

Detail: [`../../docs/code/05-documents.md`](../../docs/code/05-documents.md).
Rule-by-rule fixes: [`../../docs/operate/03-troubleshooting.md`](../../docs/operate/03-troubleshooting.md).
