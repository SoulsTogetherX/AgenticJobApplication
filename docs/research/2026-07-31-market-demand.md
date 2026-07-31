# Market demand for full-stack / back-end roles, local store first (2026-07-31)

Researcher finding. Scope is `docs/application-limits.yaml` (full-stack and
back-end; remote or Las Vegas metro; ~2.5 years experience). The local
numbers below are **[verifiable]** — every one is reproducible against
`jobs/leads.db` with the commands given. The web numbers are **[asserted]**
and notably low-quality this session. Nothing here is a fact about the user;
the one action suggested is a question for the user to answer, routed
through `save-answer.mjs` only if the user confirms it.

## Local ground truth: the 141 stored leads

Store state (`select status, count(*) from leads group by status`):
**141 leads — 116 dismissed, 15 new, 8 applied, 2 recommended.**

Top demand across the WHOLE store (`lead_keywords`, count of leads naming
the skill; reproducible via a group-by over `lead_keywords`):

| Skill              | Leads | Profile status (keyword-coverage) |
| ------------------ | ----- | --------------------------------- |
| Observability      | 53    | **gap**                           |
| System design      | 42    | covered                           |
| AI/LLM integration | 40    | covered                           |
| Python             | 27    | covered                           |
| Incident response  | 24    | **gap**                           |
| Kubernetes         | 24    | **gap**                           |
| React              | 20    | covered                           |
| AWS                | 17    | covered                           |
| Java               | 17    | ask (same-area)                   |
| Docker             | 16    | covered                           |
| SQL                | 16    | covered                           |
| Mentoring          | 15    | not in profile scope              |
| TypeScript         | 15    | covered                           |

Among only the LIVE leads (new/applied/recommended, n=25): AI/LLM
integration 7, Python 5, React 5, System design 5, Incident response 4,
TypeScript 4. Command: join `lead_keywords` to `leads` excluding
`dismissed`.

`node scripts/profile/keyword-coverage.mjs --min-demand 1` (run 2026-07-31):
**covered=22, ask=21, gap=3** — and the three gaps are Incident response,
Observability, Kubernetes.

### The headline local finding

**The single most-demanded skill in the user's own lead store —
Observability, named by 53 of 141 postings — is a profile gap, as are #5
(Incident response) and #6 (Kubernetes).** Until a skill is recorded,
verify-claims R6 correctly keeps it off every resume, so these three are
invisible on every application regardless of keyword optimisation.

This is a question for the **user**, not a fact anyone may write:
monitoring/logging/alerting tools (Datadog, Grafana, Sentry, plain
structured logging) and on-call/debugging-in-production experience are
common in practice and easy to under-report. If — and only if — the user
confirms real experience, one `save-answer.mjs` line per skill unlocks the
top of the demand table. Route: surface in chat; never pre-fill. Owner:
manager, to raise with the user. (`keyword-coverage.mjs` prints the exact
ready-to-run lines.)

Second local finding: the demand profile of the whole store (Observability /
System design / Mentoring-heavy) is the demand profile of the **senior
postings that got dismissed**. The live, reachable subset skews to AI/LLM
integration, Python, React, TypeScript — all covered. The pipeline's gates
are doing their job; the coverage gap matters most if the user wants to
stretch upward.

## Where the store under-samples the actual local market

Structural, checkable against this repo: the sweep reaches six no-auth ATS
APIs, and `find-boards.mjs`'s own header records that Workday, iCIMS, Taleo
and Phenom — unreachable by slug probing — are what most large employers
**and nearly every local Las Vegas employer** run. So the 141-lead store
systematically over-represents remote startup/tech postings (Greenhouse/
Lever/Ashby ecosystems) and under-represents Las Vegas metro employers
(casinos/gaming, healthcare, logistics — the IGT lead in
`application-limits.yaml`'s comments is the exception that proves it). Any
"local market demand" read off the store inherits that skew. **The
disagreement between the store and the local market is the finding.**
Owner: `w5-leads` — reachability of tenant-hosted boards is the bottleneck,
already known; this quantifies why it also biases demand analysis.

## What the web adds (little, this session)

Searched "most in-demand backend full-stack developer skills 2026"; the
results were bootcamp/SEO content (nucamp, talent500, edstellar, 2026) —
**[asserted, low quality]**. Directionally they agree with the local store:
TypeScript adoption majority-and-rising (one claims ">80% of new projects",
no methodology), Docker/Kubernetes as baseline infra literacy, and AI/LLM
integration reframed from differentiator to baseline. Nothing contradicted
the local data; nothing added resolution to it.

**Incompleteness, stated plainly:** no high-quality neutral source (Indeed
Hiring Lab, Stack Overflow survey 2026, Ashby/Greenhouse posting-corpus
data) surfaced in this session's searches, and Las Vegas-specific demand
data was not searched for separately. A follow-up researcher session should
target those four sources by name. The Ashby 2026 Talent Trends stat
(applications per hire tripled since 2021, >300 per role — vendor report,
cited in the ATS-parsing finding) is the one macro number worth keeping: it
says the user's competition per posting is historically high, which favours
this pipeline's tailored-quality strategy over volume.

## Search record

Local commands run 2026-07-31: `keyword-coverage.mjs --min-demand 1 --json`
and `--min-demand 2`; SQL over `leads` and `lead_keywords` (status counts,
demand counts, live-subset demand). Web: one search as above. Not done:
Vegas-specific salary/demand sources; neutral posting-corpus studies.
