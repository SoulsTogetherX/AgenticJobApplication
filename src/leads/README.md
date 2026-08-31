# `src/leads/` — finding and judging postings

**Owner:** `implementer`.

Everything between "sweep the boards" and "here is a ranked list worth your
time". No LLM calls: every gate here is a deterministic rule over stored text.

## Entry points

| Command               | What it does                                                              |
| --------------------- | ------------------------------------------------------------------------- |
| `find-jobs.mjs`       | The daily sweep, plus `import`, `list` and `mark`. Writes `leads`.        |
| `enrich.mjs`          | Fetches the descriptions four boards' list endpoints do not return.       |
| `screen.mjs`          | The mechanical first pass — ghost-job, scam and vagueness signals.        |
| `gate-audit.mjs`      | Re-runs every stage over the whole stored set and diffs against baseline. |
| `recommend.mjs`       | Ranks stored leads against the profile.                                   |
| `prep-queue.mjs`      | What is worth tailoring before you sit down.                              |
| `cluster.mjs`         | Which leads are the same job wearing different company names.             |
| `canonical.mjs`       | Resolves an aggregator link to the ATS-hosted posting behind it.          |
| `manage-sources.mjs`  | The only writer of `docs/job-sources.yaml`.                               |
| `find-boards.mjs`     | Given company names, find their public boards.                            |
| `discover-boards.mjs` | Is a candidate board worth sweeping?                                      |
| `board-yield.mjs`     | Scores the boards already swept by live-posting yield.                    |
| `cc-boards.mjs`       | Enumerates board slugs from the Common Crawl URL index.                   |

Libraries with no command line: `stages.mjs` (the screening pipeline as an
ordered list), `fit.mjs` (L2 — profile fit), `risk.mjs` (L3 — is this job real?),
`applicability.mjs` (how far the machine can carry a lead).

## What does not belong here

- Anything that opens a browser to **apply**. That is `src/apply/`.
- Anything that writes a document. That is `src/documents/`.
- Editing `docs/application-limits.yaml` or `docs/job-sources.yaml` by hand —
  the first is the user's, and the second has exactly one writer,
  `manage-sources.mjs`, which edits line by line to preserve the comments a
  YAML round-trip would delete.

## Read before changing a gate

**Run `node src/leads/gate-audit.mjs` after any gate change.** A job the user
never sees is the worst failure in this system, and the body gate in particular
**flags rather than rejects** — a change that looks conservative can turn a flag
into a rejection across the whole store.

Four more traps: four boards' list endpoints carry no description at all
(`enrich.mjs` exists for them); slug probing can find the wrong company;
`textSnippet` deliberately keeps block boundaries; and `lead_keywords` goes stale
whenever the lexicon changes.

Detail: [`../../docs/code/02-leads-finding.md`](../../docs/code/02-leads-finding.md),
[`03-leads-screening.md`](../../docs/code/03-leads-screening.md),
[`04-leads-ranking.md`](../../docs/code/04-leads-ranking.md).
