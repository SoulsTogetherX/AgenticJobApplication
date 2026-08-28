---
name: tailor-resume
description:
  Tailor the user's resume to a specific job posting using only approved
  facts from profile/profile.yaml. Use when the user asks to tailor, customize,
  or generate a resume for a job, posting, or application. Arguments may be a
  job slug, URL, or pasted posting text.
---

Tailor the resume for one job posting. Follow @docs/tailoring-rules.md exactly —
it is the contract; violations of it are bugs.

## Steps

1. **Load facts**: read `profile/profile.yaml` and `profile/answers.yaml`.
   If `meta.approved_by_user` is false, warn the user and get explicit
   confirmation before continuing.

2. **Application history**: before creating anything, check for prior
   applications (see the check-applied skill):

   ```bash
   node src/applications/check-applied.mjs "<Company>"
   ```

   If this job or company was already applied to, report what/when and get the
   user's go-ahead before continuing.

3. **Job workspace**: determine the job slug (`<company>-<short-title>`,
   kebab-case). If `jobs/<slug>/` doesn't exist:

   ```bash
   node src/documents/new-job.mjs <slug> --company "<Company>" --title "<Title>" [--url <url>]
   ```

   Then fill `jobs/<slug>/job.json` `description` with the verbatim posting text
   (from $ARGUMENTS, a pasted posting, or the browser) and list its explicit
   `requirements`.

4. **Shared context**: read `jobs/<slug>/context.json`.
   - If `analysis` is empty, fill it: key requirements, profile fact ids that
     match each, gaps (requirements the profile can't truthfully cover — never
     hide these), posting keywords, tone. Also set `consistency.emphasized_skills`
     and `consistency.lead_experience`.
   - If the cover-letter skill already filled it, REUSE its analysis and
     consistency choices — do not contradict them.

5. **Keyword plan** (before drafting — it tells you what to place and, just as
   importantly, what you may not):

   ```bash
   node src/documents/keyword-plan.mjs <slug>
   ```

   Writes `jobs/<slug>/keywords.json`. Follow §8 of the rules: place every
   `must_use` term in its `placement` section, write `ats_forms` in both
   acronym and expanded form on first mention, mirror `title_mirror.mirror`
   in the SUMMARY when it is non-null, stay under `density_cap`, and treat
   `blocked` as forbidden. If a blocked term is genuinely true of the user,
   ask them and record it with `save-answer.mjs` BEFORE using it.

6. **Draft** `jobs/<slug>/resume.md` per the format contract (§6 of the rules):
   reorder/select/rephrase only; every bullet annotated `<!-- fact:ID -->`;
   one page; keep dates and numbers verbatim from facts.

7. **Unknowns**: if anything needed is not in the fact sources, ask the user in
   chat, then persist EVERY new answer:

   ```bash
   node scripts/profile/save-answer.mjs "<question>" "<answer>"
   ```

8. **Verify** (must pass before showing the draft as final):

   ```bash
   node src/documents/verify-claims.mjs resume jobs/<slug>/resume.md --job jobs/<slug>/job.json
   ```

   Fix violations by correcting the draft — never by weakening the verifier.
   The report also carries a non-blocking `coverage` block: it names any
   `must_use` keyword that did not make it in. Placing a missed one is usually
   free; dropping it for space is a legitimate call, but make it deliberately.
   Set `resume.status: "verified"` and record `facts_used`.

9. **Approval gate**: show the user (a) which facts were emphasized and why,
   (b) what was dropped, (c) notable rephrasings, (d) the gaps list, and
   (e) keyword coverage (placed/total) plus anything `blocked` they could
   unlock by recording an answer. Wait for approval → `status: "approved"`.

10. **Render**:
    ```bash
    node src/documents/render-pdf.mjs jobs/<slug>/resume.md "jobs/<slug>/<Full Name> Resume - <Company>.pdf"
    ```
    Confirm the PDF opens/exists, set `status: "rendered"`, and tell the user the path.
