---
name: tailor-cover-letter
description: Tailor Xavier's cover letter to a specific job posting using only
  approved facts from profile/profile.yaml, staying consistent with the tailored
  resume via the shared job context. Use when the user asks to write, tailor, or
  customize a cover letter for a job, posting, or application.
---

Tailor the cover letter for one job posting. Follow @docs/tailoring-rules.md
exactly — it is the contract; violations of it are bugs.

## Steps

1. **Load facts**: read `profile/profile.yaml`, `profile/answers.yaml`, and the
   voice/structure base `profile/source/CS_Standard.pdf` (read the PDF directly).
   If `meta.approved_by_user` is false, warn the user and get explicit
   confirmation before continuing.

2. **Application history**: if the tailor-resume skill hasn't already checked
   this job, run `node scripts/applications/check-applied.mjs "<Company>"` and surface any
   prior application (what/when) before continuing.

3. **Job workspace**: resolve the job slug. If `jobs/<slug>/` doesn't exist,
   create it (`node scripts/documents/new-job.mjs …`) and capture the posting into
   `job.json` as described in the tailor-resume skill.

4. **Shared context first** — read `jobs/<slug>/context.json`:
   - If the resume skill already ran, its `analysis` and `consistency` entries
     are binding: same emphasized skills, same lead experience, same framing.
     The letter must not praise anything the resume doesn't support.
   - If this skill runs first, fill `analysis` and `consistency` (see
     tailor-resume step 4) so the resume skill can reuse them.

5. **Draft** `jobs/<slug>/cover-letter.md` per the format contract (§7):
   - Keep the user's voice and paragraph structure from the base letter.
   - Address the company/role from `job.json`; connect 2–3 profile facts to the
     posting's top requirements (record them in `cover_letter.facts_used`).
   - Only facts from the whitelist; the posting's company/title may be used for
     addressing, but never echo posting tech or requirements as claims. One page max.

6. **Unknowns** (e.g. "why do you want to work here?" needs a real motivation):
   ask the user in chat, then persist:

   ```bash
   node scripts/profile/save-answer.mjs "<question>" "<answer>"
   ```

7. **Verify** (must pass):

   ```bash
   node scripts/documents/verify-claims.mjs cover-letter jobs/<slug>/cover-letter.md --job jobs/<slug>/job.json
   ```

   Fix violations in the draft, never in the verifier. Set
   `cover_letter.status: "verified"`.

8. **Approval gate**: show the user the letter plus a note on which facts it
   leans on and how it aligns with the resume. Wait for approval → `"approved"`.

9. **Render**:
   ```bash
   node scripts/documents/render-pdf.mjs jobs/<slug>/cover-letter.md "jobs/<slug>/Xavier Alvarez Cover Letter - <Company>.pdf" --letter
   ```
   Set `status: "rendered"` and tell the user the path.
