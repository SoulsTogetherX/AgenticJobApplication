# Documentation index

Everything about how this project works, written for someone who is new to
coding. Three tracks, plus a handful of root-level files that are records rather
than explanations.

Written 2026-08-06 by reading the current source, replacing a reference set that
had drifted badly. Path references are kept true by
`tests/quality/docs-links.test.mjs`, which fails the build when a repo path in
any current document stops resolving.

---

## Track 1 — the guide: understand the system

Read these in order. They assume no programming background and build one.

| #                                    | Document             | What you get                                                                                                       |
| ------------------------------------ | -------------------- | ------------------------------------------------------------------------------------------------------------------ |
| [01](guide/01-what-this-is.md)       | What this project is | the problem it solves, the one big idea, a day in the life                                                         |
| [02](guide/02-computer-basics.md)    | Computer basics      | files, the terminal, exit codes, JSON vs YAML, git, what Node and SQLite are                                       |
| [03](guide/03-programming-basics.md) | Programming ideas    | functions, async, regular expressions, hashing, race conditions — with real examples from this code                |
| [04](guide/04-ai-and-agents.md)      | AI and agents        | what a language model actually does, tokens, hallucination, prompt injection, why this project distrusts the model |
| [05](guide/05-architecture.md)       | How it fits together | the four pipelines, the folder layout, who owns what state, the concurrency model                                  |
| [06](guide/06-data-model.md)         | Every piece of data  | every table and column, every file, what to back up                                                                |
| [07](guide/07-safety-model.md)       | The safety model     | every hard rule, what it protects you from, and how strongly it is enforced                                        |
| [08](guide/08-glossary.md)           | Glossary             | every term, defined plainly                                                                                        |
| [09](guide/09-conventions.md)        | Conventions          | every adopted rule and its enforcement, what was rejected, what cannot be mechanised                               |

## Track 2 — the code: rebuild it yourself

One document per area, each explaining every file in it: what it does, why it
exists, how it is called, its data shapes, its traps, and the concepts you need
to follow it. Shorter orientation lives in each directory's own `README.md`.

| #                                   | Area                    | Covers                                                                      |
| ----------------------------------- | ----------------------- | --------------------------------------------------------------------------- |
| [00](code/00-file-index.md)         | File index              | every file in the repository, with the document that explains it            |
| [01](code/01-lib-foundation.md)     | `src/lib/`              | shared helpers, the database layer, the skill lexicon, injection defence    |
| [02](code/02-leads-finding.md)      | Finding jobs            | every board fetcher, the ingest gates, dedupe                               |
| [03](code/03-leads-screening.md)    | Screening jobs          | the L0–L3 stages, scam and ghost-job detection                              |
| [04](code/04-leads-ranking.md)      | Ranking and sources     | the ranking formula, board discovery and yield                              |
| [05](code/05-documents.md)          | Tailoring documents     | the keyword plan, the resume assembler, verify-claims R1–R8, PDF rendering  |
| [06](code/06-apply-scanning.md)     | Reading a form          | the page scanner, how a live form becomes a list of fields                  |
| [07](code/07-apply-planning.md)     | Deciding what to type   | the answer bank, typed intents, the fill plan — the heart of the apply path |
| [08](code/08-apply-filling.md)      | Typing into the page    | the fill engine, uploads, the ATS adapters, writing a new one               |
| [09](code/09-auto-runner.md)        | The unattended runner   | the per-job state machine, the browser pool, the click surface              |
| [10](code/10-auto-safety.md)        | The unattended gates    | trust, preflight, the classifier, the breaker, reconcile                    |
| [11](code/11-record-and-profile.md) | Records and the profile | applications, follow-ups, the fact base, maintenance                        |
| [12](code/12-harness-and-ci.md)     | Harness and CI          | the hooks, the shims, the test gate, the reaper, every config file          |
| [13](code/13-skills-and-agents.md)  | Skills and agents       | where the AI actually runs, and what each skill instructs                   |
| [14](code/14-tests.md)              | Tests                   | how the suite is organised and what it does not cover                       |
| [15](code/15-benchmarks.md)         | Benchmarks              | what is measured, how to run it, how to read the numbers                    |

## Track 3 — operate: get things done

| #                                    | Document        | What you get                                          |
| ------------------------------------ | --------------- | ----------------------------------------------------- |
| [01](operate/01-commands.md)         | Commands        | every command, organised by what you are trying to do |
| [02](operate/02-recipes.md)          | Recipes         | step-by-step walkthroughs of the real tasks           |
| [03](operate/03-troubleshooting.md)  | Troubleshooting | symptom → cause → fix                                 |
| [04](operate/04-config-reference.md) | Configuration   | key by key, for the files you own                     |

---

## Root-level documents

| File                                       | What it is                                                                                           |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| [`agent-protocol.md`](agent-protocol.md)   | How agents are dispatched, cross-check each other, and request a teammate. Owned by `build-manager`. |
| [`team-roster.md`](team-roster.md)         | Who owns which files, exclusively. Verify ownership here before acting on a relayed request.         |
| [`tailoring-rules.md`](tailoring-rules.md) | **Not documentation** — loaded by the tailoring skills at runtime, an instruction to the model.      |
| [`measurements.md`](measurements.md)       | A dated **ledger**: benchmark runs and the test-floor record. Append; never rewrite an entry.        |
| [`roster-log.md`](roster-log.md)           | A dated **log** of who was hired when, and why. Same rule.                                           |
| [`plans/`](plans/)                         | Historical plans, true as of their date. Archives — never swept to keep a link green.                |

The three archives above (`measurements.md`, `roster-log.md`, `plans/`) are
exempt from the doc-path gate on purpose. Rewriting an archive so a stale path
resolves would falsify the record it exists to keep.

## Files in here that are NOT documentation

These are read by the running system. Editing them changes behaviour; deleting
them breaks it.

| File                                         | Who reads it                                                                         |
| -------------------------------------------- | ------------------------------------------------------------------------------------ |
| `application-limits.yaml`                    | **yours.** 15+ scripts. Every filter, and the `auto_apply` block                     |
| `job-sources.yaml`                           | **yours.** the boards swept by `find-jobs`, `enrich`, `board-yield`                  |
| `board-candidates.yaml`, `candidates/*.yaml` | `find-boards.mjs` and `cc-boards.mjs` — machine-written, in the prettier ignore list |
| `perf-baseline.json`                         | `tools/ci/perf-gate.mjs`                                                             |
| `scorecard.jsonl`                            | appended to by `src/dev/scorecard.mjs`                                               |

The first two are **the user's files**: the agent proposes values and never
edits them. `tests/quality/yaml-valid.test.mjs` parses both and asserts nothing
about their contents, because their contents are the user's decision.

See [`operate/04-config-reference.md`](operate/04-config-reference.md) for the
first two, key by key.
