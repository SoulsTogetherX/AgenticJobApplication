# Shared Tailoring Rules

Both skills (`tailor-resume`, `tailor-cover-letter`) MUST follow these rules.
They exist so the two documents are truthful and consistent with each other.

## 1. Fact sources (whitelist)

- `profile/profile.yaml` — the approved master profile. Every fact has an `id`.
- `profile/answers.yaml` — user-provided answers collected over time.
- `jobs/<slug>/job.json` — **company name and title only**, for addressing
  (e.g. "the Full-Stack Engineer role at Acme"). The posting body is NOT a fact
  source: do not echo its tech names, numbers, or requirements back — the
  verifier whitelists only the company and title from it.

Nothing else. If it isn't in these files, it does not go in the document.

## 2. Allowed transformations

- **Reorder**: put the most job-relevant experience/projects/skills first.
- **Select/drop**: omit facts irrelevant to the posting (e.g. drop game-jam
  placements for a fintech role). The target is a one-page resume.
- **Rephrase**: reword a fact for flow or to mirror the posting's vocabulary,
  as long as meaning, scope, numbers, dates, and tech names are unchanged.
  - OK: "Built and deployed production web and Android applications…" →
    "Shipped production web and Android apps…"
  - NOT OK: adding "led a team", changing "45+ stars" to "50+ stars",
    upgrading "used AWS EC2" to "architected AWS infrastructure".

## 3. Forbidden

- Inventing skills, tools, employers, titles, dates, metrics, certifications.
- Claiming experience with tech mentioned only in the job posting.
- Strengthening quantifiers (turning "supported" into "led", "helped" into "owned").
- Inferring seniority, team size, or responsibilities not stated in the profile.

## 4. Unknown information → ask, then save

If the tailoring (or an application form) needs information not in the fact
sources — salary expectations, work authorization, relocation, notice period,
"why this company", years-of-experience with a specific tool — STOP and ask the
user in chat. Then persist it:

```bash
node scripts/save-answer.mjs "<question>" "<the user's answer>"
```

Never guess. Never leave the answer only in conversation memory.

## 5. Shared context (`jobs/<slug>/context.json`)

- Whichever skill runs first creates it (via `scripts/new-job.mjs` skeleton) and
  fills `analysis`: key requirements, matched fact ids, gaps, tone, keywords.
- The second skill MUST read it and stay consistent: same emphasized skills,
  same framing of experience, no contradictions (e.g. resume leads with React
  while the letter brags about Python-only work).
- Update your section's `status` (`pending → drafted → verified → approved → rendered`)
  and record `facts_used` as you go.

## 6. Resume format contract

- Output `jobs/<slug>/resume.md`. Every bullet line ends with `<!-- fact:ID -->`
  (comma-separate multiple ids if a bullet merges facts). The renderer strips these.
- Contact header, SUMMARY, EXPERIENCE, PROJECTS, TECHNICAL SKILLS, EDUCATION —
  same one-page structure as the user's current resume. Keep date ranges verbatim.

## 7. Cover letter format contract

- Output `jobs/<slug>/cover-letter.md`. Keep the user's voice and structure from
  `profile/source/CS_Standard.pdf` (greeting → interest → experience →
  strengths → close), one page max, addressed to the company from `job.json`.
- No fact annotations required, but verify-claims (cover-letter mode) must pass:
  all numbers, dates, and tech terms must exist in profile/answers (the job's
  company and title are also allowed, for addressing).

## 8. Verification & approval gate

1. Run `node scripts/verify-claims.mjs <mode> <file> --job jobs/<slug>/job.json`.
2. Fix every violation — do not weaken the verifier, ever.
3. Show the user: what was emphasized, dropped, and rephrased + any gaps
   (requirements the profile can't cover — these are listed, never papered over).
4. Only after user approval: render PDF and mark status `rendered`.
