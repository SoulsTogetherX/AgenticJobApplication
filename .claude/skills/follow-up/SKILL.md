---
name: follow-up
description: Track application outcomes and follow-ups - list applications due
  a nudge, draft the follow-up note for the user to send, and record responses.
  Use when the user asks what needs following up, says they heard back / got
  rejected / got an interview or offer, or says they sent a follow-up.
---

Keep logged applications from going cold. The application log
(`profile/applications.yaml`) is the fact base: this skill NEVER edits it
directly — every change goes through `src/applications/update-application.mjs`, and
only records what the user explicitly reported in chat.

## What's due

```bash
node src/applications/follow-ups.mjs [--days N]
```

Default cadence: first follow-up 10 days after applying, second (final) one
10 days later, then the lead stops appearing — two unanswered nudges means
move on. Responded applications (interviewing/offer/rejected/withdrawn) never
appear.

## Drafting a follow-up (per due application)

1. Load `jobs/<slug>/context.json` and `job.json` if they exist for specifics
   (role title, one thing emphasized in the tailored resume).
2. Draft a SHORT note (4-6 sentences max, no groveling, no "just checking
   in" filler): restate interest in the specific role, add ONE concrete,
   profile-verifiable hook (a fact from `profile/profile.yaml` relevant to
   the posting), and a soft close. Facts only — same truthfulness rule as
   resumes.
3. Show the draft. **The user sends it themselves** (email or LinkedIn — the
   agent never sends anything). Offer light edits.
4. Only after the user says they sent it:
   ```bash
   node src/applications/update-application.mjs <slug> --followed-up
   ```

## Recording responses ("Acme rejected me", "got an interview at X")

```bash
node src/applications/update-application.mjs <slug-or-company> --status rejected|interviewing|offer|withdrawn
```

Confirm what was recorded. On a rejection, optionally note it feeds the
profile-gaps analysis (rejected jobs' requirements count double there). On an
interview/offer, congratulate briefly and offer interview prep against the
job's captured posting.
