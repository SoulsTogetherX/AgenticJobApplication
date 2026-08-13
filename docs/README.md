# Documentation

Everything about how this project works, written for someone who is new to
coding. There are three tracks and you do not have to read them in order — but
if you are starting from nothing, read the guide track top to bottom first.

Written 2026-08-06, replacing a reference set that had drifted badly out of date.
Every document in here was written by reading the current source, not by editing
the old documents.

---

## Track 1 — the guide: understand the system

Read these in order. They assume no programming background and build one.

| #                                    | document             | what you get                                                                                                       |
| ------------------------------------ | -------------------- | ------------------------------------------------------------------------------------------------------------------ |
| [01](guide/01-what-this-is.md)       | What this project is | the problem it solves, the one big idea, a day in the life                                                         |
| [02](guide/02-computer-basics.md)    | Computer basics      | files, the terminal, exit codes, JSON vs YAML, git, what Node and SQLite are                                       |
| [03](guide/03-programming-basics.md) | Programming ideas    | functions, async, regular expressions, hashing, race conditions — with real examples from this code                |
| [04](guide/04-ai-and-agents.md)      | AI and agents        | what a language model actually does, tokens, hallucination, prompt injection, why this project distrusts the model |
| [05](guide/05-architecture.md)       | How it fits together | the four pipelines, who owns what state, the concurrency model                                                     |
| [06](guide/06-data-model.md)         | Every piece of data  | every table and column, every file, what to back up                                                                |
| [07](guide/07-safety-model.md)       | The safety model     | every hard rule, what it protects you from, and how strongly it is enforced                                        |
| [08](guide/08-glossary.md)           | Glossary             | every term, defined plainly                                                                                        |

## Track 2 — the code: rebuild it yourself

One document per area, each explaining every file in it: what it does, why it
exists, how it is called, its data shapes, its traps, and the concepts you need
to follow it.

| #                                   | area                    | covers                                                                      |
| ----------------------------------- | ----------------------- | --------------------------------------------------------------------------- |
| [00](code/00-file-index.md)         | File index              | every file in the repository, with the document that explains it            |
| [01](code/01-lib-foundation.md)     | `scripts/lib/`          | shared helpers, the database layer, the skill lexicon, injection defence    |
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
| [12](code/12-harness-and-ci.md)     | Harness and CI          | the hooks, the test gate, the reaper, every config file                     |
| [13](code/13-skills-and-agents.md)  | Skills and agents       | where the AI actually runs, and what each skill instructs                   |
| [14](code/14-tests.md)              | Tests                   | how the suite is organised and what it does not cover                       |
| [15](code/15-benchmarks.md)         | Benchmarks              | what is measured, how to run it, how to read the numbers                    |

## Track 3 — operate: get things done

| #                                    | document        | what you get                                          |
| ------------------------------------ | --------------- | ----------------------------------------------------- |
| [01](operate/01-commands.md)         | Commands        | every command, organised by what you are trying to do |
| [02](operate/02-recipes.md)          | Recipes         | step-by-step walkthroughs of the twelve real tasks    |
| [03](operate/03-troubleshooting.md)  | Troubleshooting | symptom → cause → fix                                 |
| [04](operate/04-config-reference.md) | Configuration   | key by key, for the files you own                     |

---

## The audit

[audit-2026-08-05.md](audit-2026-08-05.md) — a full read of every source file in
the repository, with 77 correctness defects and 121 improvement findings, each
carrying quoted evidence. Six of the defects that put wrong information on a real
application were fixed on 2026-08-05/06; the report marks which.

## Files in here that are NOT documentation

These are read by the running system. Editing them changes behaviour; deleting
them breaks it.

| file                                         | who reads it                                                            |
| -------------------------------------------- | ----------------------------------------------------------------------- |
| `application-limits.yaml`                    | **yours.** 15+ scripts. Every filter, and the `auto_apply` block        |
| `job-sources.yaml`                           | **yours.** the boards swept by `find-jobs`, `enrich`, `board-yield`     |
| `tailoring-rules.md`                         | loaded by the tailoring skills at runtime — an instruction to the model |
| `board-candidates.yaml`, `candidates/*.yaml` | `find-boards.mjs`                                                       |
| `perf-baseline.json`                         | `.github/workflows/perf-gate.mjs`                                       |
| `measurements.md`                            | appended to by the benchmark harnesses                                  |

See [operate/04-config-reference.md](operate/04-config-reference.md) for the
first two, key by key.

## Historical

`autonomy-plan.md`, `autonomy-plan-v2.md`, `next-session-plan.md`,
`agent-protocol.md`, `team-roster.md` and `roster-log.md` are kept because code
and test comments cite them for the reasoning behind specific decisions. They are
design history, not current documentation — where they disagree with the three
tracks above, the tracks are right.
