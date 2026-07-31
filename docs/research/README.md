# Research findings

Owned by the `researcher` agent. Everything here is a **finding about the
outside world** — how applicant tracking systems behave, what the job market
currently rewards, which résumé conventions are real and which are folklore,
and what comparable services already do.

Nothing here is a fact about the user. That distinction is the whole point of
keeping it in its own directory.

## What belongs here

- Keyword and ATS-behaviour findings, with the source and its date
- Market conditions for the roles in `docs/application-limits.yaml`
- Competitive analysis of comparable services
- Answers to questions other agents asked, kept so they are not re-researched

## What does not

- **Anything asserting a skill, employer, date or metric about the user.** Those
  live in `profile/`, and only the user puts them there via
  `scripts/profile/save-answer.mjs`. A researcher that writes to `profile/` has
  invented a qualification, which is hard rule 1.
- **Text copied out of a web page unsanitised.** Run it through
  `scripts/lib/untrusted.mjs` first. A finding carries a conclusion and a
  citation, not a payload.
- **Techniques that deceive an employer** — hidden text, invisible keywords,
  instructions addressed to a screening model. See "Not building: hidden prompt
  injections in resumes" in `docs/autonomy-plan.md` for why, and for the
  legitimate alternative that replaced it.

## How a finding earns its place

The hiring-advice internet is full of confident claims with no traceable
source. A finding is worth keeping when it says:

1. **What was claimed**, and **who claimed it, when**.
2. Whether it is **verifiable** — vendor documentation, a published study, or
   something checkable against this repo's own stored leads — or merely
   **asserted**. Both are allowed; conflating them is not.
3. **Which owner should act**, if anyone. `w6-documents` for the résumé
   pipeline, `w5-leads` for sources and boards, `w3-resolution` for form
   answering, `doc-scribe` for `docs/tailoring-rules.md`.

Prefer what can be checked locally. This repository holds a live store of real
postings and a real lexicon, so "N of the stored leads require X" outranks any
article about what employers want.
