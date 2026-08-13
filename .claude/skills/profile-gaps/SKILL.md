---
name: profile-gaps
description: Analyze what the pursued jobs keep demanding that the profile
  doesn't evidence, weighted toward rejections and silences, and recommend
  honest next steps. Use when the user asks what they're missing, why they
  aren't getting responses, what to learn next, or for a gap analysis.
---

Answer "what is the market telling me?" with data from this pipeline, then
recommend only HONEST fixes.

## Run the analysis

```bash
node scripts/profile/profile-gaps.mjs --json
```

It scans every captured job workspace and stored lead, extracts tech terms,
compares them against everything evidenced in `profile/profile.yaml`, and
double-weights jobs that ended in rejection or silence-after-follow-up (those
are the ones that demonstrably didn't convert). More captured jobs = better
signal — if fewer than ~5 jobs were analyzed, say the sample is thin.

## Interpret (the judgment layer)

1. Group the gaps: frontend / backend / data / infra / AI. Ignore noise terms
   that clearly came from irrelevant leads.
2. For the top 2-3 gaps, decide which case applies — ASK THE USER, don't
   assume:
   - **They actually have it, profile just doesn't say so** → route through
     `node scripts/profile/save-answer.mjs` or the update-profile skill so it becomes
     citable fact. This is the cheapest win.
   - **They genuinely don't have it** → suggest the smallest real project
     that would evidence it (e.g. "add a Docker deploy + CI workflow to an
     existing side project" rather than "learn Kubernetes"). Concrete,
     finishable in days.
3. NEVER suggest adding an unevidenced skill to the resume. That violates
   hard rule 1 and gets people burned in interviews.

## Report format

Short: gaps table (tech, demand, evidenced?), the 2-3 recommendations, and
one line on what's already well-covered (so the user knows their strengths
are landing on paper). If outcome data exists, note which gap shows up most
in rejected/ignored applications.
