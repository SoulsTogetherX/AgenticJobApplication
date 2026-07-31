# How ATS products actually parse and rank, as of 2026-07-31

Researcher finding. Every claim below is marked **[verifiable]** (vendor
documentation, a published study, a court record, or checkable against this
repo) or **[asserted]** (blog tests, polls, marketing aggregations — allowed,
never to be conflated with the former). Sources carry their dates; an undated
claim is labelled as such.

No free text from any web page was carried in verbatim beyond short quoted
claims; the assembled findings were passed through `sanitizeUntrusted`
(`scripts/lib/untrusted.mjs`) before filing, and came back clean. Nothing in
this file is a fact about the user.

## 1. The rejection model: filters reject, rankers rank, parsers neither

**The single most load-bearing correction to folklore:** mainstream ATS
products do not auto-reject on résumé content. The only fully automatic
rejection mechanism is the **knockout question** (work authorization,
licence, hard years-minimum, location).

- The "75% of résumés are rejected by ATS" figure traces to a **2012 sales
  pitch by Preptel**, a résumé-optimisation vendor that shut down in 2013; no
  methodology was ever published. The citation chain that spread it was
  Forbes (2014) → CIO.com (2018) → CNBC (2019), none of which verified the
  origin. **[verifiable as a trace; the claim itself is folklore]** Sources:
  unchartedcareer.com trace; jobcannon.io/research (2025–26); The Interview
  Guys debunk (2025).
- Greenhouse does no automatic content filtering; knockout questions are the
  only auto-reject and humans review the rest. **[asserted — consistent
  across Jobscan's Greenhouse guide (2026) and recruiter-survey pieces;
  Greenhouse's own support docs say the same but I did not fetch them
  directly this session — flagging that as incompleteness]**
- Survey data points, all **[asserted]** (small n or self-selected):
  25-recruiter survey, 23/25 said rejections are manual or
  eligibility-triggered only (enhancv, 2025-26); LinkedIn poll of 630
  recruiters, 83% said their ATS does not auto-reject on content
  (undated, secondhand).
- The **Harvard Business School "Hidden Workers: Untapped Talent" study**
  (Fuller & Raman with Accenture, **September 2021**; 8,000 workers, 2,250
  executives) is the strongest published evidence and it points at
  **configured filters, not parsing**: ~99% of Fortune 500 firms use an
  ATS/RMS; **88% of employers say their own system screens out qualified
  candidates**; the filters doing it are degree requirements, >6-month
  employment gaps, and exact-credential matches. **[verifiable — published
  study, harvard.edu coverage 2021-09]** Note its age: it predates the LLM
  screening layer entirely.

**Consequence for this repo:** the highest-leverage anti-rejection work is
not keyword density — it is answering knockout questions correctly, which is
`w3-resolution`'s answer bank, and the polarity guard on yes/no questions
(work authorization is the #1 knockout). The pipeline is already aimed at the
right layer. Owner: `w3-resolution` (no change needed; this is confirmation).

## 2. The ranking layer is now real, AI-driven, and litigated

The two-gatekeeper model in `keyword-plan.mjs`'s header (literal keyword
layer + LLM layer on top) matches the world as of mid-2026:

- **Workday acquired HiredScore (March 2024)** and integrated it: applicants
  get an A–D grade on the recruiter dashboard. **[verifiable — vendor
  acquisition, widely documented]**
- **Mobley v. Workday** (N.D. Cal., 3:23-cv-00770): conditional nationwide
  ADEA collective certified **2025-05-16** (Judge Rita Lin); a **2025-07-07**
  order defined the collective as applicants whose applications were
  "scored, ranked, or screened" by Workday/HiredScore AI since 2020-09-24; a
  **2026-03-06** ruling rejected Workday's argument that the ADEA does not
  cover applicants. **[verifiable — court record, clearinghouse.net case
  44074]** Two readings matter here: (a) AI ranking at enterprise scale is
  real, not folklore; (b) vendors are under active legal pressure, which
  pushes them toward _ranking assist_ and away from _automated rejection_.
- "79.3% of Fortune 500 applicants pass through a platform with active AI
  ranking" — **[asserted]**, circulating in 2026 ATS-statistics blogs with no
  published methodology. Repeat only with this label.
- Ashby's 2026 Talent Trends report: applications per hire have roughly
  tripled since 2021, now above 300 per role. **[verifiable as a vendor
  report; vendor-selected data]** This volume pressure is _why_ the AI layer
  exists.
- Market share, all from 2026 aggregations (Pin.com market share report,
  ApplyMate stats page, Jobscan's ~12k-company dataset) — **[asserted;
  directionally consistent with each other]**: Greenhouse ~19–24% of tracked
  applications, Workday ~22% (and **~39% of the Fortune 500**), Ashby ~15%
  and fastest-growing, SAP SuccessFactors ~13% of F500. Locally checkable
  corroboration: this repo's own `find-boards.mjs` header records that
  Workday/iCIMS/Taleo/Phenom tenants are what "most large employers and
  nearly every local Las Vegas employer uses."

**Prompt injection against the LLM layer is an active research area.**
arXiv **2602.18514** ("Trojan Horses in Recruiting", submitted
**2026-02-19**) red-teamed indirect prompt injection via résumés against two
LLM screeners: simple injected instructions sometimes worked, and
reasoning-grade models sometimes _leaked the attack logic into their output_,
making the manipulation visible to humans. **[verifiable — published
preprint]** Two implications, stated with the boundary rule in mind:
(a) hidden-instruction résumés are now both studied and increasingly
_detectable_ — the technique this project refused to build
(`docs/autonomy-plan.md`, "Not building") is not only deceptive but
measurably risky to the sender; (b) the legitimate alternative — real
keywords in visible text, verified extraction — is the only strategy that
survives both gatekeepers. No ambiguous techniques were found this session
that needed a user ruling.

## 3. Parsing mechanics: what survives extraction

- **Text-layer PDF is broadly fine on the major systems.** Blog tests
  conflict — one 2026 test claims DOCX 97% vs text-PDF 76% average accuracy
  (resumeoptimizerpro, **[asserted, no methodology, sells a competing
  approach]**); another 2026 test (resumemate) finds a clean text-based PDF
  parses reliably everywhere it tried. Parser vendors (Textkernel) parse
  text PDFs as a matter of course. The consistent residual risk is
  **Workday's built-in parser**, repeatedly described as struggling with
  headers, footers, sidebars and tables **[asserted, multiple independent
  blogs 2025–26; no Workday vendor doc found this session]**. The PDF-only
  decision (user, 2026-07-29) does not need reversal on this evidence; a
  Workday-specific DOCX fallback is an _option to put to the user_, not a
  recommendation. Owner: `w6-documents`.
- **Two-column layouts are less fatal than folklore says, and single-column
  is still the zero-risk floor.** Textkernel states modern parsers detect
  the column separator and read each column separately, and that column
  handling raised their clean-render rate from 62% to 90% **[verifiable —
  parsing-vendor documentation, undated page]**; a 2026 enhancv test scored
  two-column 98% vs single-column 95% **[asserted]**. Older parsers and
  Workday remain the exception. Phase 4.2's single-column simplification is
  therefore _supported as the safe floor_, and `ats-lint.mjs` treating
  multi-column CSS as a warning rather than a problem is correctly
  calibrated — do not promote it to a problem.
- **Tables, text boxes, and header/footer contact details are the
  consistently-reported real hazards** across vendor and blog sources alike:
  parsers skip or reorder them. `ats-lint.mjs` already hard-fails tables and
  images; the render template should keep contact details in body text
  (it does). Owner: `w6-documents` (confirmation).
- **Standard section headings are a parser-segmentation fact, not a ranking
  hack.** Parsers turn the document into structured fields by segmenting on
  Experience/Education/Skills-class headings (Indeed career-advice
  guidance, maintained page, undated; HRLens explainer 2025-26)
  **[asserted, but mechanically consistent with how every parser vendor
  describes extraction]**. No study was found quantifying a _ranking_ effect
  of heading wording — the risk is losing a section entirely, which is what
  `ats-lint.mjs`'s `EXPECTED_SECTIONS` warning already covers. What I could
  not find: any evidence that heading wording beyond the standard set
  matters once parsing succeeds.
- **Acronym + expansion is real, and the mechanism is recruiter search, not
  parser magic.** Recruiters search the ATS database for either the acronym
  or the expansion ("MBA" vs the full phrase); a résumé carrying only one
  form is invisible to searches for the other (Indeed's ATS guidance;
  createresume.io 2026; consistent across sources) **[asserted, but the
  mechanism — literal search over parsed text — is vendor-documented
  behaviour]**. Pairing **once** is sufficient; repeating the pair reads as
  padding. `keywords.mjs`'s deliberately short `FORM_PAIRS` list and
  `ats_forms` design match this exactly. Owner: `w1-security` (lexicon) —
  no change needed; this validates the current design.
- **The keyword-stuffing penalty is mostly a human/LLM-layer phenomenon.**
  I found no vendor documentation of a mechanical stuffing detector in any
  major ATS; what exists is AI-layer downweighting and human recruiters
  reading stuffed documents as low quality **[asserted]**. `DENSITY_CAP = 3`
  in `keyword-plan.mjs` remains sensible — for the human reader and the LLM
  layer — but its comment's "actively detected" framing is stronger than the
  evidence found. Cosmetic; owner `w6-documents` if the comment is ever
  touched.

## 4. What this project has wrong or should adjust

1. **Nothing in the Phase 4.2 direction contradicts the evidence.** Making
   `ats-lint.mjs` blocking, single-column template, and the ground-truth
   extraction check are all supported. The extraction-survives-rendering
   check is precisely the control the conflicting PDF test data argues for:
   it replaces the unresolvable "PDF vs DOCX accuracy" debate with a per-
   document proof. Owner: `w6-documents`.
2. **Knockout questions outrank keywords.** If effort must be prioritised,
   the answer bank and pending-questions flow beat further keyword work.
   Owner: `w3-resolution` (confirmation, no change).
3. **Workday is the one system where this pipeline's documents face a
   weaker parser AND an AI grader, and it is also the system the lead sweep
   cannot reach by slug probing.** These compound: the local Las Vegas
   employers the user most plausibly interviews with are the least-tested
   surface. Worth a user conversation, not a code change today. Owners:
   `w6-documents` (format), `w5-leads` (reachability).
4. **The "75%" figure must never appear in this repo's docs as fact.** If
   quoted, quote it as the 2012 Preptel marketing claim it is. Owner:
   `doc-scribe`.

## Search record

Searches run 2026-07-31: "ATS market share 2025 Workday Greenhouse iCIMS
Lever Ashby"; "does an ATS automatically reject resumes myth Greenhouse
Lever knockout questions"; ""75% of resumes" ATS rejected claim origin
Preptel"; "Harvard Business School Hidden Workers Fuller 2021 ATS filters";
"resume parser PDF vs DOCX two-column tables headers footers Textkernel";
"Mobley v Workday lawsuit 2025 AI screening ADEA"; "recruiter keyword search
ATS acronym vs spelled out section headings"; "AI resume screening 2026 LLM
ranking Workday HiredScore Greenhouse AI Ashby". Plus one direct fetch:
arXiv abs/2602.18514. Not fetched this session (incompleteness): Greenhouse
and Workday first-party support documentation; the Ashby Talent Trends
primary PDF.
