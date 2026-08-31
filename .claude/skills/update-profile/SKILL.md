---
name: update-profile
description: Merge a replaced or updated resume/cover letter PDF (or newly
  mentioned experience) into profile/profile.yaml without losing anything
  already there. Use when the user says they updated, replaced, or added to
  their resume, cover letter, or profile facts.
---

Keep `profile/profile.yaml` in sync with the source documents in
`profile/source/` (currently `Resume General.pdf` and `CS_Standard.pdf`).
The rule of this flow: **information is only added — never silently deleted or
rewritten.** The apply script enforces that deterministically.

## Steps

1. **Read** every PDF in `profile/source/` (read PDFs directly) plus the current
   `profile/profile.yaml` and `profile/answers.yaml`.

2. **Diff** sources against the profile:
   - Facts in a source that have no matching fact id → candidates to ADD.
   - Source facts that contradict an existing fact (different number, date,
     title, wording with changed meaning) → CONTRADICTIONS. Never resolve these
     yourself; list them for the user.

3. **Write the proposal** to `profile/profile.proposed.yaml`: a full copy of the
   current profile with new facts appended under the right sections, using the
   existing id conventions (`exp-*`, `prj-*`, `skill-*`, `edu-*`; bullets `-bN`).
   Do not remove or rewrite any existing fact in the proposal unless the user
   already approved that specific change.

4. **Review with the user**: list added facts (with ids), any contradictions,
   and open questions. Wait for approval.

5. **Apply**:

   ```bash
   node scripts/profile/apply-profile.mjs
   ```

   Add `--allow-edits` / `--allow-removals` ONLY for changes the user explicitly
   approved in step 4. The script backs up the old profile to
   `profile/profile.backup.yaml`, so a bad merge is always recoverable.

6. **Verify**: run `npm test` (the real-profile test catches duplicate ids and
   structural breakage). Report what was added.

Notes:

- If the user replaced a source PDF wholesale, that is fine — `profile/source/`
  only ever holds the _current_ documents; history lives in the profile itself.
- If a contradiction means the old fact is wrong (e.g. corrected metric), get
  explicit approval, put the corrected text in the proposal, and apply with
  `--allow-edits`.
