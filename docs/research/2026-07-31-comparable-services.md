# Comparable services: what Jobright, Simplify, Teal and LazyApply actually do (2026-07-31)

Researcher finding. Claims marked **[verifiable]** or **[asserted]**; all
sources are 2025–26 review/comparison pages plus the vendors' own marketing,
so treat feature lists as vendor-stated and reliability reports as
user-reported. The assembled text was passed through `sanitizeUntrusted`
before filing and came back clean. Nothing here is a fact about the user.

## Jobright (the user's stated benchmark)

Vendor-stated feature set **[asserted — vendor marketing, corroborated by
multiple 2026 reviews]**:

- Matching against **8M+ aggregated listings** with a per-job match score.
- Resume AI: per-posting tailoring with ATS-oriented formatting/keywords.
- Chrome-extension autofill across many ATS platforms.
- "Orion" conversational copilot; an "Agent" tier claiming "90% job search
  automation" — tailor, fill, submit, track.

User-reported reality, from 2026 reviews and Reddit reports aggregated by
wobo.ai, resumehog, jobhire.ai **[asserted, but consistent across
independent reviewers]**:

- The auto-apply Agent is narrower than the headline: waitlist-gated for
  some users, limited board coverage.
- Tailored resumes read as templated keyword insertion, and — the finding
  that matters most here — **users report hallucinated content: skills and
  experience the user does not have, inserted by the tailoring AI.**

**Where Jobright beats this pipeline:** lead volume (8M aggregated listings
vs 44 swept boards / 141 stored leads — the local numbers are checkable with
`node scripts/status.mjs`), insider-connection surfacing, polished UX, and
zero setup cost for the user.

**Where this pipeline beats Jobright, verifiably:** the exact failure users
report — invented skills — is structurally impossible here: hard rule 1,
per-bullet `fact:ID` provenance annotations, and `verify-claims.mjs` R6 reject any claim
the fact base cannot back, mechanically, before rendering. No comparable
service found this session advertises provenance-verified truthfulness.
Second opening: none of them can answer "why did I never see this job?" —
this repo's four-stage screen records which gate rejected every lead
(`gate-audit.mjs`). Owners: none (competitive context); `w6-documents` may
quote the hallucination finding when the user asks why tailoring is slower
here than in Jobright.

## Simplify

- Free tier: autofill + application tracking; it fills forms on company ATS
  portals but **does not submit for you**. AI tailoring, cover letters and
  custom Q&A answers are paywalled at **$39.99/month** (Simplify+).
  **[asserted — 2026 comparison pages, consistent]**
- Closest architectural cousin to this repo's `fill-plan.mjs` path. Their
  advantage is breadth of ATS adapter coverage built over years; this
  repo's adapter set is small. Their model answers Q&A fields with AI;
  this repo refuses to invent an answer (`answer-bank.mjs` defers instead)
  — slower, but never wrong on a knockout question, which per the ATS
  finding is the only true auto-reject. Owner: `w3-resolution`
  (confirmation of design; no change).

## Teal

- Tracker/CRM-first: unlimited free job tracking from 40+ boards via
  extension, statuses, contacts, follow-up reminders; resume builder with
  per-job keyword matching; premium ~$9/week. **Not an auto-apply tool.**
  **[asserted — 2026 comparisons]**
- Functional overlap with this repo's `applications` table +
  `follow-ups.mjs` + `keyword-plan.mjs`. Nothing found that Teal does which
  this repo lacks structurally, except polish and the contact-per-company
  CRM angle — which Phase 4.1 (recruiters table, records only) already
  plans. Owner: `w5-leads` (Phase 4.1 confirmation).

## LazyApply

- Mass-apply Chrome extension for LinkedIn/Indeed/ZipRecruiter "Easy Apply"
  buttons; same resume to every job, no tailoring, no match scoring; from
  $99/year. **[asserted — consistent across reviews]** Philosophically the
  opposite of this pipeline; also outside this repo's ethics boundary
  (LinkedIn/Indeed automation, which this project explicitly avoids).

## The market direction, and one number to distrust

2026 comparison pieces converge on "quality over volume": recruiters
increasingly discount mass applications, and new tools advertise fewer,
tailored submissions. A widely-quoted Huntr statistic — 11–20 targeted
applications yield a 9.25% interview rate vs 2.58% for 100+ — supports this
but is **[asserted]** vendor data with obvious selection bias (people who
target carefully differ from people who spray). The direction, not the
number, is the finding — and it favours this pipeline's design.

## Search record

Searches run 2026-07-31: "Jobright.ai features 2026 AI job matching agent
auto apply resume tailoring review"; "Simplify vs Teal vs LazyApply 2026
auto-apply autofill resume tailoring comparison". Not done (incompleteness):
hands-on testing of any service; pricing verified against the vendors' own
pages rather than comparison blogs; coverage of newer entrants (Sonara,
Massive, AIApply and similar were named in results but not investigated).
