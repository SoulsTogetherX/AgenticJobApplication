# `scripts/dev/` — measuring performance

This document is about the four programs in this repository whose only job is to
produce **numbers**: how long an application takes, how much of that time is the
code sitting still waiting, how many times the pipeline crosses into the browser,
how often a test fails when nothing changed, and how many real forms the machine
could handle without a human. None of them help you apply for a job. All of them
exist so that "it got slower" and "that test is flaky" stop being opinions and
start being measurements with a sample size attached.

That matters more here than in most projects. The owner of this repository
benchmarks this pipeline against a commercial job-application service and treats
slowness as a **defect**, not a preference — so a change that makes the pipeline
half a second slower per application is a bug in the same sense that a wrong
answer in a form is a bug. The house rule, written at the top of
`docs/measurements.md`, is blunt:

> **no performance change merges without a before/after measurement.**

The rest of this document explains how those measurements are taken, what each
number means, where they are written down, and which parts of the machinery are
currently broken.

**What you will learn**

- What a **benchmark** actually is, and the difference between measuring a thing
  and guessing at it convincingly.
- Why you measure **before and after** a change, and why a single run is not a
  measurement.
- What **contention** means when several programs share one computer, and why it
  can make the same code look 2× slower with no code change at all.
- The three labels this project puts on every number — `measured`, `derived`,
  `unmeasured` — and why the third one exists.
- `bench-apply.mjs`: what it measures for **one** application, every flag, the
  fake browser it runs against, and how to read its output.
- `bench-runner.mjs`: what it measures for a **run of 50** applications, and the
  `--require` preload trick that makes the model-usage counter honest.
- `perf-gate.mjs`: the CI check that compares today's numbers against a committed
  baseline, exactly what turns it red, and how to update the baseline.
- `flake-rate.mjs`: what a **flaky test** is, why "1 failure in 3 runs" is not
  evidence, and what a **Wilson confidence interval** buys you.
- `bench-green-prevalence.mjs`: a census of real form shapes — and why it does
  not run today.
- Where the numbers are written down (`docs/measurements.md`,
  `docs/perf-baseline.json`) and the paste-ready entries two of these tools emit.
- An honest assessment of `bench-apply.mjs`'s ~2,950 lines: what is dead, what is
  duplicated, and what is just large.

**Before this**

You can read this document cold, but these help:

- [`../guide/02-computer-basics.md`](../guide/02-computer-basics.md) — processes,
  exit codes, standard output, environment variables.
- [`../guide/03-programming-basics.md`](../guide/03-programming-basics.md) —
  functions, JSON, async/await.
- [`06-apply-scanning.md`](06-apply-scanning.md) and
  [`08-apply-filling.md`](08-apply-filling.md) — the code these benchmarks time.
- [`12-harness-and-ci.md`](12-harness-and-ci.md) — the CI pipeline the
  performance gate is one job of.

**The files covered here**

| file                                     | lines | one-line purpose                                                                 |
| ---------------------------------------- | ----- | -------------------------------------------------------------------------------- |
| `scripts/dev/bench-apply.mjs`            | 2,953 | times one application end to end: serve → scan → plan → fill                     |
| `scripts/dev/bench-runner.mjs`           | 923   | times a **campaign** of N applications at concurrency C                          |
| `scripts/dev/spawn-counter.cjs`          | 183   | the preload that counts child processes and outbound network requests            |
| `scripts/dev/flake-rate.mjs`             | 292   | runs one test file N times and reports a failure rate with a confidence interval |
| `scripts/dev/bench-green-prevalence.mjs` | 652   | a census: how many remembered real form shapes could be fully automated          |
| `.github/workflows/perf-gate.mjs`        | 345   | the CI gate: compares a fresh run against `docs/perf-baseline.json`              |
| `docs/perf-baseline.json`                | 32    | the committed "this is what good looks like" numbers                             |
| `docs/measurements.md`                   | 1,236 | the append-only ledger where every measurement is written down                   |

---

# Part 0 — The ideas, before the code

If you have never done performance work before, this part is the one that makes
the rest legible. Everything here is a general idea, illustrated with something
that actually happened in this repository.

## 0.1 What a benchmark is

A **benchmark** is a program that runs some other code under conditions you
control, and reports how expensive that run was. "Expensive" can mean seconds of
wall-clock time, but it can equally mean "how many times did we talk to the
browser" or "how many separate programs did we start".

The word "under conditions you control" is doing most of the work. If you time
the pipeline against a real employer's website, you are partly measuring their
web server, their content delivery network, and whatever the internet is doing
at that moment. Run it again tomorrow and you get a different number for reasons
that have nothing to do with your code. `docs/measurements.md` puts it this way:

> Live boards vary and you would be measuring their weather.

So every benchmark in this repository points at **`tests/fixtures/boards/server.mjs`**,
a small fake job board that runs on your own machine (see Part 1). It is
predictable, it is free, and it is incapable of reaching an employer.

A benchmark is **not** a test. A test asks "is this correct?" and answers yes or
no. A benchmark asks "what did this cost?" and answers with a number. They fail
differently, too: a broken test usually goes red, whereas a broken benchmark
usually goes **quiet** — it reports a small, plausible number for work that never
happened. Several sections below are entirely about refusing to do that.

## 0.2 Why you measure before _and_ after

Suppose you delete a one-second delay from the form-filling code and announce
that applications are now one second faster. Are they? Maybe the delay was on a
branch that never runs. Maybe removing it made the code retry twice, costing two
seconds. Maybe your computer was busier the first time you looked.

The only way to know is to have a **before** number, taken with the same harness
on the same fixture, and an **after** number taken the same way. The difference
between them is the claim. Without the "before", you have a number and a story.

This project has a scar that explains why the rule is written down. The very
first line of `docs/measurements.md`'s hard rule says:

> This exists because an audit found ~24 seconds of `waitForTimeout` in the apply
> path that everyone had assumed was network time. Assumption is the failure
> mode.

`waitForTimeout(450)` means "sit still for 450 milliseconds". Twenty-four seconds
of those had accumulated across the apply path, and because nobody had ever
separated _waiting on the network_ from _waiting on a timer_, the whole 24
seconds was described as "the board being slow". It was not the board. It was a
number in our own source code.

## 0.3 Why one run is not a measurement

Run the same benchmark twice and you will get two different numbers. Computers
are not metronomes: the operating system schedules other work, memory gets moved
around, a file lands in a cache. This variation is called **noise**.

The standard defence is to run several times and describe the _shape_ of the
results rather than quoting one of them:

| statistic              | what it means                                       | why you would use it                                               |
| ---------------------- | --------------------------------------------------- | ------------------------------------------------------------------ |
| **mean** (average)     | add them all up, divide by how many                 | simple, but one freak slow run drags it upward                     |
| **median** (p50)       | sort them, take the middle one                      | the typical case; ignores one freak run entirely                   |
| **p95**                | sort them, take the value 95% of runs came in under | the slow tail — what a user notices when it happens                |
| **standard deviation** | roughly, how spread out the numbers are             | large spread means the median is not telling the whole story       |
| **min / max**          | fastest and slowest observed                        | sanity bounds; a huge max often means something else was happening |

Both benchmark harnesses compute these. `bench-apply.mjs`'s `stats()` returns
`{n, min, max, median, mean, stddev}` and the human report prints
`median of 5; stddev 66.81` so you can see immediately whether the median is
trustworthy. `bench-runner.mjs`'s `pct(values, p)` computes a percentile by
**nearest rank** — sort the values, take the one at position
`ceil(p/100 × count)`. That is the simplest honest definition of a percentile,
and it returns `null` on an empty list rather than `0`, because "no samples" and
"zero milliseconds" are very different facts.

There is a subtlety here that the ledger states as a standing caveat, and it is
worth understanding because it looks like a contradiction:

> `round_trips` and `model_turns` are DERIVED, not clocked… They are
> deterministic. `--runs 7` therefore gives **one** sample of those two columns
> repeated seven times, not seven samples.

Repeating a calculation seven times does not give you seven measurements of it.
Only the columns that come off a clock actually vary. See §0.5.

## 0.4 Contention: several programs, one machine

**Contention** is what happens when two or more programs want the same resource
at the same time — the processor, the disk, a database file — and have to take
turns. Each one then takes longer than it would alone, even though neither
changed.

This is not a theoretical concern in this repository; it is the single largest
source of bogus numbers here. Two examples, both recorded rather than
hypothesised:

1. **The test suite.** `CLAUDE.md`'s token-discipline section records that the
   same test tree, measured while other agents were editing files, reported
   **4 → 6 → 0** failures across three identical runs, and that the duration
   inflated from **75s to 150s** purely from contention. A doubling, with no code
   change.
2. **The benchmark instrument itself.** `docs/measurements.md` M9 records that
   turning on the process counter (§3.3) moved `wall_ms_p95` from ~1328 ms to
   ~1565 ms — an 18% cost from the act of measuring. The published baseline is
   therefore taken **with** the instrument switched on, so before and after are
   never compared across it.

Two rules follow, and both are implemented in code rather than left to
discipline:

- **A number taken on a busy machine is not comparable to one taken on a quiet
  machine.** Say which you had.
- **A number taken from a tree with uncommitted edits is not comparable to
  anything**, because you cannot say afterwards which bytes produced it. This is
  the _dirty tree refusal_ in §3.6, and it fires constantly during normal work.

`flake-rate.mjs` goes further and makes contention a **dial** rather than an
excuse: `--load N` runs N copies of the same test file simultaneously and reports
the failure rate at that load, which turns "flaky on my machine" into "fails
above N concurrent writers".

## 0.5 `measured`, `derived`, `unmeasured` — the three labels

Every number these harnesses print carries a label saying how it was obtained.
This is unusual and it is the most important design decision in the whole area.

| label        | means                                                                                          | example                                                         |
| ------------ | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `measured`   | produced by **executing** real code or real I/O in this run                                    | `sleep_ms` — the actual argument the fill engine passed         |
| `derived`    | **computed** from a documented protocol plus this run's own output, with the source line cited | `round_trips` in `bench-apply` — counted from the skill's steps |
| `unmeasured` | genuinely needs something this run did not have; reported as `null` **with a reason**          | what a conditional wait costs before the page satisfies it      |

The third label is the point. When a harness cannot measure something, the
tempting move is to print a plausible estimate, because a table with a gap in it
looks unfinished. `bench-apply.mjs` refuses:

> `unmeasured` — genuinely needs a browser. Reported as null with a reason,
> NEVER as an estimate. An estimate printed in a measurement column is exactly
> what Rule C exists to stop.

Every run prints the full list of what it is _not_ claiming, produced by
`unmeasuredList()`. There are six entries, and a run with `--browser` closes five
of them and marks them `closed_by: "--browser"`. The sixth —
`react_select_behaviour`, "which combo strategy a real react-select actually
accepts" — stays open on purpose, because the fake board's dropdowns are the fake
board's, and reporting them as if they were a real website's would be exactly the
estimate the harness exists to refuse.

## 0.6 Provenance: which bytes produced this number?

**Provenance** means the record of where something came from. For a measurement,
provenance answers: _if I want to reproduce this number, what exactly do I check
out?_

A git commit id alone is not enough, because during normal development several
files are edited but not yet committed. So `provenance()` in `bench-apply.mjs`
records three things:

```js
export const MEASURED_FILES = [
  ".claude/skills/apply-job/scan-page.js",
  ".claude/skills/apply-job/scan.driver.mjs",
  "scripts/apply/scan-engine.mjs",
  "scripts/apply/fill-engine.mjs",
  "scripts/apply/fill-plan.mjs",
  "scripts/apply/answer-bank.mjs",
  "scripts/apply/field-cache.mjs",
]
```

1. `sha` — the short git commit id (`git rev-parse --short HEAD`).
2. `dirty_measured_files` — the output of `git status --porcelain` **restricted
   to the list above**, so you learn whether any file whose cost is being
   reported has uncommitted edits.
3. `file_sha1` — the first 12 characters of a **SHA-1 hash** of each of those
   files' bytes. A hash is a short fingerprint computed from content: change one
   character and the fingerprint changes completely. It pins the exact bytes,
   which a commit id cannot do while the tree is dirty.

This is not decorative. Running the benchmark twice a few minutes apart while
other work was in flight produced these two fingerprints for the same file:

```
scripts/apply/fill-engine.mjs   b9517e4782e8      (first run)
scripts/apply/fill-engine.mjs   4a3ed5be610e      (second run, minutes later)
```

Two different programs, two numbers, one label. Without `file_sha1` there would
be no way to tell afterwards.

## 0.7 The house rule, and what it costs

Putting §0.2 to §0.6 together gives the workflow the ledger prescribes:

1. Before you change anything, run the harness and record the numbers, the
   command, and the provenance.
2. Declare a **budget** — what you expect the change to cost — _before_ you start.
   `docs/measurements.md` insists on this: "A change is judged against **its
   declared budget, not against zero**." Some changes are supposed to cost time;
   sanitising untrusted text at ingest is one. What is not allowed is deciding
   afterwards that the slowdown was always expected.
3. Make the change.
4. Run the harness again the same way, on a comparably quiet machine.
5. Write both numbers into `docs/measurements.md`, append-only. "Append-only —
   never rewrite history; a dip that got fixed should stay visible."
6. `inconclusive` is a legal verdict. Two samples are not a trend.

---

# Part 1 — The fake board every benchmark points at

Before the harnesses themselves: they all run against
`tests/fixtures/boards/server.mjs`, a small web server that impersonates job
application forms. Three facts about it matter here.

**It cannot reach the internet.** It binds `127.0.0.1` — the address that means
"this computer" — and `assertLoopback()` refuses anything else. `bench-apply.mjs`
states the consequence plainly: "THE ONLY BOARD THIS EVER TOUCHES is
tests/fixtures/boards/server.mjs, which binds loopback and refuses anything else.
Never a live employer."

**It can pretend to be several different employers at once.**
`start({ origins: 8 })` opens eight separate ports; `applyUrls(50)` hands back 50
job URLs spread across those eight origins and eight `fixture-emp-<n>` tenants.
This matters for `bench-runner.mjs`, which needs many distinct sites to exercise
its concurrency (see §3.5).

**It carries a declared latency model, and it is off by default.**
`DEFAULT_LATENCY` is `{ nav_ms: 300, xhr_ms: 150 }`, but the server only applies
it when asked (`--latency`). Left off, a page costs whatever a loopback socket
costs, which is nearly nothing. That is deliberate: a loopback number and a
modelled-latency number are two different populations and the ledger forbids
merging them.

The board serves several named routes. The ones the benchmarks use are
`greenhouse`, `lever`, `ashby` and `honest-greenhouse`; there are also a dozen
deliberately hostile variants used by the security tests. Alongside the live
pages, `tests/fixtures/boards/scans/` holds committed **scan files** —
`greenhouse-step1.scan.json` and friends — which are recordings of what the
scanner saw on those pages. A benchmark can start from a recording instead of a
live page, which is much faster and completely deterministic.

---

# Part 2 — `bench-apply.mjs`: one application, timed

## 2.1 Exactly what it measures

`bench-apply.mjs` runs a single job application through the pipeline and reports
**three costs, kept separate**:

| column        | what it counts                                                          |
| ------------- | ----------------------------------------------------------------------- |
| `round_trips` | how many times the flow crosses from the agent into the browser         |
| `sleep_ms`    | how many milliseconds the code spends deliberately doing nothing        |
| `model_turns` | how many separate turns of the language model the prescribed flow costs |

Why three and not one total? Because they are wildly different sizes:

> A model turn costs seconds, a browser round trip costs tens to hundreds of
> milliseconds, and a Node call costs milliseconds. Adding them produces a number
> whose largest term is invisible, which is how ~24s of waitForTimeout spent
> years being described as "network time".

Add them together and the biggest term hides inside the total. Keep them apart
and you can see which one to attack.

## 2.2 How to run it

```bash
# the default: the Greenhouse fixture, five samples, human-readable report
node scripts/dev/bench-apply.mjs --board greenhouse

# a synthetic 14-dropdown form under the worst-case widget behaviour
node scripts/dev/bench-apply.mjs --shape combo14 --profile worst

# the full record as JSON, for a script to read
node scripts/dev/bench-apply.mjs --board greenhouse --runs 7 --json

# a paste-ready docs/measurements.md entry
node scripts/dev/bench-apply.mjs --ledger

# open a real browser and close five of the six unmeasured entries
node scripts/dev/bench-apply.mjs --board greenhouse --browser
```

Every flag:

| flag               | default      | what it does                                                                      |
| ------------------ | ------------ | --------------------------------------------------------------------------------- |
| `--board <name>`   | `greenhouse` | which fixture board (`greenhouse`, `lever`, `ashby`, `honest-greenhouse`)         |
| `--shape <kind>`   | none         | a synthetic form instead of a fixture: `combo14`, `combo23`, `richtext`, `gate-*` |
| `--profile <name>` | `typical`    | widget behaviour model: `best`, `typical`, `worst` (§2.5)                         |
| `--all-profiles`   | off          | run all three and print the range                                                 |
| `--page N`         | `1`          | which page of a multi-page form                                                   |
| `--runs N`         | `5`          | how many samples — "a single one is not a measurement"                            |
| `--gate`           | off          | run the seven-row gate matrix and print what each gate costs (§2.6)               |
| `--verbs`          | off          | per-verb unit costs (what one dropdown, one upload, one text field costs)         |
| `--real-sleep`     | off          | actually sleep instead of accounting for it (§2.4)                                |
| `--browser`        | off          | run the real-Chromium legs (§2.9)                                                 |
| `--browser-fill`   | off          | run the fill engine in real Chromium, with one real file upload (§2.9)            |
| `--json`           | off          | the full record                                                                   |
| `--ledger`         | off          | a paste-ready `docs/measurements.md` entry                                        |
| `--help` / `-h`    | —            | print usage                                                                       |

**Exit codes.** `0` normally. `2` for an unrecognised flag (it prints the usage
text rather than a stack trace). `3` when the fill did not complete — see §2.8,
which is the most interesting exit code in the file.

## 2.3 The four legs

A "leg" is one stage of the run, timed separately so you can see where the time
went.

| leg       | function       | what actually happens                                                               |
| --------- | -------------- | ----------------------------------------------------------------------------------- |
| **serve** | `benchServe()` | a real HTTP `fetch` of a real fixture page; records ms, bytes, status, CSP header   |
| **scan**  | `benchScan()`  | runs **both** scanner twins against the instrumented page and reports the drift     |
| **plan**  | `benchPlan()`  | starts `scripts/apply/fill-plan.mjs` as a **real subprocess** against a temp folder |
| **fill**  | `benchFill()`  | loads the **generated** `jobs/<slug>/fill-plan.js` the way the browser tool does    |

Three details in there are load-bearing.

**The scan leg runs two twins on purpose.** There are two copies of the scanning
logic: `scripts/apply/scan-engine.mjs`, which is an ordinary imported module, and
`.claude/skills/apply-job/scan.driver.mjs`, which is the version that actually
executes inside the browser today. `benchScan` runs both and reports
`twin_drift`, the difference in their sleep costs. This is not paranoia:

> That drift is not hypothetical: the sleep removal landed on the engine while
> the driver kept all three flat sleeps, and the driver is the twin that runs.

The driver is loaded exactly the way the real browser tool loads it —
`vm.runInContext("(" + source + ")")` — so it is measured under the same
conditions. `unwrapScan()` copes with the fact that the two twins return
different shapes (`{scan, vouchedLabels}` versus a bare scan) and **throws** if it
sees a third shape, rather than reporting zeros for a leg that did not run.

**The plan leg is a real subprocess.** `benchPlan` builds a temporary job folder,
writes `scan-p1.json` into it, and runs the real
`node scripts/apply/fill-plan.mjs <slug> --json` with `--jobs-dir`, `--url`,
`--profile`, `--answers` and `--no-cache`. Nothing is simulated; `plan_ms` is a
clock reading of a real program. It points at `tests/fixtures/profile.yaml` and a
generated answers file, never at the owner's real `profile/`.

**The fill leg runs the generated artifact, not the module.** When the pipeline
fills a form it does not import a module — it generates a self-contained
JavaScript file at `jobs/<slug>/fill-plan.js` with the engine and the plan baked
in as text, and hands that to the browser. `benchFill` loads _that file_ the same
way, so the leg also proves the generated bootstrap parses and runs. Importing
`fill-engine.mjs` directly would not.

There is a fifth, separate measurement: `benchVerbCosts()` (`--verbs`) prices one
field at a time — one `fill`, one `combo`, one `type` of a 3,000-character cover
letter, one `upload` — subtracting the single 450 ms end-of-fill settle so the
numbers are comparable per field. It carries a standing note that
`how: "type"` is currently **unreachable** through the planner, because
`answer-bank.mjs` lists `richtext` in its skip types, so every rich-text box
defers. The harness measures it anyway rather than dropping it: "the difference
between a known ceiling and a forgotten one."

## 2.4 The instrumented page: a recorder, not a browser

Here is the trick that makes the default run take milliseconds instead of
minutes.

`instrumentedPage()` builds a **test double** — a stand-in object that offers the
same functions a real Playwright browser page offers (`click`, `fill`,
`waitForTimeout`, `keyboard.type`, `locator`, `evaluate`, …) but does not do any
of them. What it does instead is **record the cost**:

```js
const waitForTimeout = async (ms) => {
  cost.sleep_unconditional_ms += ms
  cost.calls.push(["waitForTimeout", ms])
  if (realSleep) await asleep(ms)
}
```

Called with `450`, it adds 450 to a counter and returns immediately. The engines
running against it are the **real, unmodified** engines; only the browser is
faked. So every branch taken is a branch the real engine chose, and the recorded
450 is the exact argument the real engine passed.

This is why the file insists:

> SLEEP IS ACCOUNTED, NOT SLEPT… That is not a shortcut around the measurement —
> the recorded value IS the argument the engine passed, on the branch it took.

And it is falsifiable: `--real-sleep` makes the double actually sleep, and
`wall_ms` then absorbs the same total. That equivalence is asserted in
`tests/apply/bench-apply.test.mjs`. If accounting and sleeping ever disagreed,
the test would say so.

The double keeps **four** separate sleep counters, and the distinction between
them is worth understanding because it recurs everywhere:

| counter                        | meaning                                                                     |
| ------------------------------ | --------------------------------------------------------------------------- |
| `sleep_unconditional_ms`       | flat `waitForTimeout(n)` — paid in full, every time, no matter what         |
| `sleep_typing_ms`              | `characters × delay` for every simulated keystroke                          |
| `sleep_conditional_ceiling_ms` | the **timeout** of every "wait until X happens" — the most it could cost    |
| `sleep_conditional_hit_ms`     | the subset of those the behaviour model says never fire, i.e. actually paid |

An **unconditional** wait always costs its full amount and is removable by
editing code. A **conditional** wait ("wait up to 1000 ms for this element to
disappear") costs whatever the real page takes, which the code cannot tell you.
The harness reports the ceiling and says explicitly that a ceiling is not a cost.
Closing that gap is the entire reason the browser legs exist (§2.9).

What the double deliberately **cannot** do is be a web page. It has no DOM, so it
cannot tell you whether the scanner picks the right label for a field or whether
a React dropdown really opens. Those are in the unmeasured list, by name, with
reasons.

## 2.5 Behaviour profiles: measuring a range, not a point

The cost of filling a dropdown depends on which technique the widget accepts.
The engine tries several in order — type-and-press-Enter, type-and-click-the-row,
click-the-row-directly — and every technique that fails before the winning one is
paid for in full. Which one wins is a property of the _website_, not of our code.

So the harness models three worlds:

| profile   | menu renders? | winning combo strategy | rich text accepts `fill()`? | upload input detaches? |
| --------- | ------------- | ---------------------- | --------------------------- | ---------------------- |
| `best`    | yes           | `type-enter` (first)   | yes                         | yes                    |
| `typical` | yes           | `type-click` (second)  | yes                         | yes                    |
| `worst`   | **no**        | `click-option` (last)  | **no**                      | **no**                 |

`typical` is not a guess — its comment records what a live Greenhouse run
actually did: "type-enter resolved 16 of 19 dropdowns, the education selects
needed type-click". `--all-profiles` runs all three so the report shows a range
rather than a single number that quietly assumes the best case.

## 2.6 Synthetic shapes and the gate matrix

The fixture boards are honest replicas, which makes them **small** — the
Greenhouse replica has exactly one dropdown. The costs worth worrying about are
on big forms, so `syntheticScan()` builds those on demand:

| shape      | what it is                                                                  |
| ---------- | --------------------------------------------------------------------------- |
| `combo14`  | 14 dropdowns, each with a recorded option list and a matching stored answer |
| `combo23`  | 23 dropdowns with **no** option lists — exercises the probe cap of 18       |
| `richtext` | one contenteditable box holding a ~3,000-character cover letter             |

These are labelled SYNTHETIC everywhere they appear. A synthetic shape run
through the real engine still measures the real engine; it just does not prove
that any particular website has 14 dropdowns.

The **gate matrix** (`--gate`) is a different and rather elegant idea. The
pipeline has rules that stop an application and ask a human: a `CONFIRM` (a
question the user must _assert_ rather than state, like work authorisation) and a
`confirm-widget` (any checkbox or radio group, because ticking a box carries
_assent_, not just a value). Those rules cost turns. How many?

You cannot answer that by reading the code. So `GATE_MATRIX` runs seven
configurations that differ by **exactly one field**, and compares each to a named
neighbour:

| row              | what it adds to the row before it                     | compared against |
| ---------------- | ----------------------------------------------------- | ---------------- |
| `greenhouse-p1`  | the real fixture, page 1                              | —                |
| `greenhouse-p2`  | the real fixture, page 2                              | —                |
| `gate-base`      | three profile facts only; nothing fires; `ready=true` | —                |
| `gate-select`    | the same question rendered as a `<select>`            | `gate-base`      |
| `gate-radio-opt` | the same question as an **optional** radio group      | `gate-select`    |
| `gate-radio-req` | the same question as a **required** radio group       | `gate-select`    |
| `gate-confirm`   | an assertion-class question as plain text             | `gate-base`      |

`gate-select` versus `gate-radio-*` is the whole experiment: identical question,
identical stored answer, identical resolution — only the **widget** differs. So
whatever those two rows differ by _is_ the cost of the widget rule, with nothing
else moving. Comparing everything to one global baseline instead would blame the
widget rule for the fixture boards' own unrelated blockers.

## 2.7 `PROTOCOL`: how the derived columns are counted

`round_trips` and `model_turns` in `bench-apply.mjs` are **derived**, and this is
what that means concretely. `PROTOCOL` is a list of the steps the apply skill
prescribes, each one tagged:

```js
{
  id: "scan-to-disk",
  browser: true,     // does this cross into the browser?
  turn: true,        // does this cost one assistant turn?
  cite: "scan-engine.mjs:252 / scan.driver.mjs:146 — …",
  when: () => true,  // does it happen on THIS run?
}
```

`protocolCost(ctx)` filters the list against the facts of the run just performed
— was the plan already `ready`? were there unknown fields? is there a `next`
button? — and counts what survives. So a form that comes back ready genuinely
reports fewer turns than one that does not. The number is computed, not asserted.

The design intent is falsifiability: each step cites the line that prescribes it,
so a reader who thinks a step is unnecessary can name it. Two problems with that
today:

> **Known defect (2026-08-05 audit, re-verified 2026-08-06).** The citations are
> **line numbers**, and `SKILL.md` has moved underneath them. `docs/measurements.md`
> M4 recorded 11 of 15 citations stale as of 2026-07-31; they have drifted
> further since (`SKILL.md` is now 518 lines, and cited line 66 —
> `browser_navigate to the URL` — is now a sentence about the database). Every
> step still lands in the right _section_, so the counts are recoverable, but a
> citation that does not resolve cannot be recounted, which is the one property a
> derived column depends on.

> **Known defect (2026-08-06).** The `handoff` step still models the pre-2026-08-03
> flow: `cite: "SKILL.md:307 only a submit button is left — stop and summarize"`,
> tagged `browser: false`. Hard rule 6 changed that — the agent now clicks submit
> when the user supplies a posting URL, and `SKILL.md` §F today says "write the
> summary below FIRST, then click", followed by a post-submit capture step. So
> the last page of a form now costs at least one browser round trip and one or
> more extra turns that `PROTOCOL` does not count. `round_trips` and
> `model_turns` from `bench-apply` are therefore **under-counts** on the final
> page.

`bench-runner.mjs` (Part 3) exists partly because of this class of problem: it
**clocks** both columns instead of deriving them.

## 2.8 What it refuses to do

Three refusals, each installed after a specific wrong number got published.

**Refusing to measure the wrong page.** `fixtureScanPath(boardName, page)` looks
for `<board>-step<page>.scan.json`, falls back to `<board>.scan.json` **only for
page 1**, and otherwise throws:

```
no scan fixture for board=ashby page=3 (looked for ashby-step3.scan.json).
Refusing to measure a different page under this page's label.
Available: ashby-step1.scan.json, ashby-step2.scan.json
```

Before this, `--page 2` moved the protocol column (page 1 pays a navigate) but
kept measuring page 1's form — reporting page 1's numbers under page 2's label.

**Refusing to bank a truncated fill.** This one has a name, `M6`, and it is the
most instructive failure in the area. For eleven days,
`node scripts/dev/bench-apply.mjs --board greenhouse` printed
`fill: ok=2 failed=1 deferred=3` and exited `0`. The single failure was the page
guard aborting the _whole_ fill — so every field after the abort contributed
nothing, and the harness reported the truncated wall time as the baseline.

> A measurement of a run that did not complete its fill is not a baseline, it is
> a smaller number — the fill stopped early, so every leg after the stop
> contributed nothing and `wall_ms` looks good for the worst possible reason.

`fillCompleteness()` now produces a verdict per sample, `collectIncomplete()`
gathers them, and `main()` sets `process.exitCode = 3` and refuses to emit a
`--ledger` entry. Exit **3** specifically, because `1` is what an unhandled crash
already gives, and "the harness crashed" and "the harness worked and the fill did
not" are different facts.

Critically, **deferrals are not failures**. A deferred field is the safety gate
working correctly. A run with three deferrals and no failures is a complete,
measurable fill. Only `failed` disqualifies.

> **Known defect (2026-08-05 audit).** `--gate` skips this guard. `main()` returns
> from the `if (opts.gate)` branch before `collectIncomplete()` is ever computed,
> so the gate matrix can still print a sleep number for a fill that aborted, and
> exit `0` — on exactly the path the defect was originally found on, and on which
> M1, M2 and M3 were taken.

**Refusing to report a shape it does not recognise.** `benchScan`'s inner `leg()`
throws if a twin returns something whose `fields` is not an array, rather than
reporting zeros: "Refusing to report zeros for a leg that did not run."

## 2.9 The two browser legs

The accounted harness can tell you the _argument_ of a wait and the _ceiling_ of
a conditional one. It cannot tell you what a conditional wait costs. Two opt-in
legs close that gap by running the real engines in a real headless Chromium
against the same loopback fixture.

The instrument is `clockedPage()`, and the distinction from
`instrumentedPage()` is exact and worth internalising:

- `instrumentedPage()` is a **double**. It replaces the browser and records what
  it was asked to do.
- `clockedPage()` is a **recorder**. It wraps a real browser page in a JavaScript
  `Proxy` — an object that intercepts every property access — forwards every call
  through to the real thing, and times the ones that wait.

`clockedPage` keeps `slept_ms` (flat sleeps) and `conditional_ms` (waits that
end when the page is ready) in separate buckets, plus `by_target`, an uncapped
map keyed `selector::state` so a caller can total a _subset_ of waits without the
recorder needing to know what an upload is.

**`--browser`** runs: a real navigation; 20 `page.evaluate(() => 1)` pings to
price a single browser round trip; the real scan through the clock; a
fixture-versus-live **label drift** check; the page-side probe path neither
engine takes; and a Content-Security-Policy check that _executes_ a rule the
project otherwise only asserts (on the Ashby fixture, `addScriptTag` must be
refused while `page.evaluate` still works — both halves recorded, because one
without the other proves nothing).

The label-drift check has a lovely piece of documented reasoning about its join
key. Three obvious choices were tried and each produced a confident, false
answer: `f.label` (the wire key is `l`) reported nine phantom mismatches; `f.k`
is assigned in DOM order so one inserted field renames everything after it; `f.sel`
is missing on React dropdowns so two different fields collapse into one. The
answer is "selector if there is one, else the control's name, else the label" —
and the count of fields that could not be joined is reported, "because a join
that silently drops rows is the same failure again."

**`--browser-fill`** runs the fill engine in Chromium including **one real file
upload**, and reports its wait columns separately: `fill_wall_ms`,
`unconditional_sleep_ms`, and `settle_ms` — the settle stage's own wall clock,
read off the engine's `report.settle` rather than reconstructed here, with
`settle_quiet` / `settle_uploads` saying which arm ended it. **A ceiling paid in
full is not a settle time**, and those two flags are what keep the two apart.
It then reads `input[type=file].files.length` back out of the real DOM, because
"setInputFiles fails silently often enough that this had to be checked rather
than trusted". If nothing attached, the settle column is still real but the
upload columns flip to `null` with a reason rather than reporting a cost for an
upload that did not happen.

`post_upload_remount_ms` — the per-upload `detached` wait, attributed by selector
out of `by_target` — is **`null` and unmeasured since 2026-08-10**: B1 measured
that wait timing out on every board in every run, so the engine no longer issues
one and there is nothing left to attribute (M11). The attribution code is kept
rather than deleted, so that if a per-upload wait ever returns it is priced the
day it does instead of arriving unmeasured.

> **Known defect (2026-08-05 audit).** `benchBrowserFill`'s `page` parameter is
> destructured, copied into the result as `page: pageNo`, and never used again —
> the leg always navigates to `board.pageUrl(boardName)`. `--browser-fill --page 2`
> would report `page: 2` attached to a page-1 measurement, which is precisely the
> mislabelling `fixtureScanPath` was written to refuse. (`main()` never passes it,
> so today it is inert rather than actively wrong.)

## 2.10 Reading the output

Here is a real run, taken on 2026-08-10 against the Greenhouse fixture:

```
bench-apply — board=greenhouse profile=typical runs=2

column          value    method      note
------------------------------------------------------------------------------
round_trips     5        derived     navigate, scan, scan-to-disk, fill, advance
sleep_ms        450      measured    unconditional + typing, on the path taken
  worst_case    830      measured    + every conditional ceiling (380)
model_turns     12       derived     12 prescribed steps
wall_ms         210.1    measured    median of 2; stddev 17.94

per leg (sleep ms: unconditional / typing / conditional ceiling)
  scan_engine         0 /      0 /    380   cdp_calls=14 typed_chars=0
  scan_driver         0 /      0 /    380   cdp_calls=15 typed_chars=0
  fill              450 /      0 /      0   cdp_calls=46 typed_chars=0

twin drift (driver - engine): none — the two scan twins cost the same
plan: ready=false items=6 defer=3 probe_needed=1 reason=3 deferred field(s) need a human
gate: confirm=1 confirm-widget=0 (required 0) consent=0 other=2  [f1:unknown, f8:unknown, g1:confirm]
fill: ok=6 failed=0 deferred=3

legs (ms, median):
  serve_ms               18.15  (6.25–30.05, sd 11.9)
  scan_engine_ms          2.54  (1.82–3.27, sd 0.72)
  scan_driver_ms          0.61  (0.39–0.82, sd 0.21)
  plan_ms               159.72  (158–161.44, sd 1.72)
  fill_ms                 3.87  (2.96–4.78, sd 0.91)
```

Reading it top to bottom:

- **`sleep_ms 450`** — the whole accounted flow's flat sleep, all of it the
  end-of-fill settle. It is the same 450 the old flat pre-verify sleep cost,
  and deliberately so: the settle polls the page in 90 ms gaps, which divide
  its 450 ms ceiling evenly, so this column stays comparable across that change
  and the perf gate's baseline keeps its meaning (M11).
- **`worst_case 830`** adds every conditional ceiling; if no page ever satisfied
  any conditional wait, this run would cost 830 ms of waiting instead of 450.
  **This number was 2,830 before 2026-08-10**, and the 2,000 ms that left was the
  fill's two per-upload `detached` waits — measured never to exit early on any
  fixture, and now gone (M11).
- **The per-leg table** attributes it: both scanners contribute 0 flat sleep and
  a 380 ms ceiling; the fill contributes the whole 450 ms and, since M11, **no
  conditional ceiling at all** — its settle is a poll loop, so its waiting is
  accounted as flat sleep rather than as a ceiling. The headroom that used to be
  named here has been taken.
- **`twin drift: none`** — the two scanner copies currently cost the same. This
  line going non-zero means one twin has been optimised and the other has not.
- **`plan: ready=false … defer=3`** — three fields need a human. **`gate:`**
  breaks that down: one `confirm` (an assertion-class question), two `unknown`
  fields. This is the safety machinery working, not a fault.
- **`fill: ok=6 failed=0 deferred=3`** — six fields filled, none failed. `failed=0`
  is what makes this run a legitimate baseline (§2.8).
- **`legs (ms, median)`** — where the wall time went. Note `plan_ms 160` dwarfs
  everything else, because the plan leg starts a whole separate Node process.
  Also note `serve_ms` swings 6 ms → 30 ms across two samples; that is noise, and
  the `sd 11.9` tells you so.

The `--ledger` form of the same run:

```
- harness:  node scripts/dev/bench-apply.mjs --board greenhouse --profile typical --runs 2
- baseline: 0a82d75 (+6 uncommitted measured file(s)) — round_trips=5 sleep_ms=450 model_turns=12 wall_ms=193.19
- worst:    sleep_ms=2830 (unconditional 450 + conditional ceiling 2380) board=greenhouse
- method:   round_trips/model_turns derived (PROTOCOL citations); sleep measured by executing the engines; conditional-wait actuals unmeasured (no browser leg in this run)
- bytes:    64baaccab1e6 scan-page.js  73a0ca449d97 scan.driver.mjs  00a585c90316 scan-engine.mjs  b9517e4782e8 fill-engine.mjs  c7282804c1a5 fill-plan.mjs  ff97e0810356 answer-bank.mjs  3f7055894985 field-cache.mjs
```

That block is designed to be pasted straight into `docs/measurements.md` under
the entry template in §5.1. Two details:

- The `method:` line is **computed**, not fixed. It used to say
  "conditional-wait actuals unmeasured (no browser)" unconditionally, which would
  have become a false claim the moment `--browser` started working. "A provenance
  line that lies about its method is worse than a missing number."
- `(+6 uncommitted measured file(s))` is the dirty-tree warning. Unlike
  `bench-runner`, `bench-apply --ledger` does **not** refuse; it labels. Do not
  bank a number carrying that annotation.

## 2.11 Is any of those 2,950 lines dead or duplicated?

The assignment asks this directly, so here is the honest audit.

**Composition.** 2,954 lines total: 2,254 lines of code, 596 lines of comment
(20%), 104 blank. The comment fraction is high because most comments record a
wrong number that was once published and why. That is the most valuable content
in the file and should not be trimmed.

**Genuinely dead code:** almost none. Every exported symbol is reachable, either
from `main()` or from `tests/apply/bench-apply.test.mjs`,
`tests/dev/b1-browser-fill.test.mjs` or `tests/apply/edge-cases.test.mjs`. The
one exception is the `page` parameter of `benchBrowserFill` documented above.
Six constants — `COVER_LETTER_CHARS`, `GATE_BASE_FIELDS`, `GATE_DATUM_Q`,
`GATE_DATUM_A`, `GATE_DATUM_OPTS`, `GATE_ASSERTION_Q`, `BENCH_ANSWER_ID_BASE` —
are `export`ed but used only inside this file. Exporting them is harmless and
arguably documents the shapes; it is not dead code.

**Genuine duplication:**

1. **The placeholder-attachment block appears three times.** Creating
   `resume.pdf` and `cover-letter.pdf` with `"%PDF-1.4 bench placeholder\n"` in a
   temp folder is written out in `runOnce`, in `benchBrowserFill`, and again in
   `bench-runner.mjs`'s `oneJob`. Roughly six lines each; a shared helper would
   remove two copies.
2. **`round()` is defined three times across the harnesses** with three different
   precisions — `bench-apply.mjs` (2 decimals), `bench-runner.mjs` (2 by
   default, parameterised), `flake-rate.mjs` (3). Harmless, but it means "rounded
   to 2dp" is not a property of the codebase, it is a property of whichever file
   you are reading.
3. **`bench-runner.mjs`'s `oneJob` re-implements the middle of `runOnce`** —
   write answers, scan, make placeholder files, plan, fill, sum the sleep. That
   duplication is _reasoned about_ in `bench-runner`'s header (it needs the queue
   state machine wrapped around it, which `runOnce` knows nothing about), so it is
   deliberate rather than accidental; it is still about 40 lines that move
   together.
4. **`printBrowser` and `printBrowserFill`** are structurally parallel formatters.
   Cosmetic.

**Wasted work rather than dead code**, and this is the biggest item:

> **Known defect (2026-08-05 audit).** `bench-runner.mjs` calls `benchScan`, which
> deliberately runs **both** scanner twins so that `bench-apply` can report twin
> drift — but `bench-runner` reads only `scanLeg.driver.cost` and never looks at
> `scanLeg.engine`. Half of every scan is discarded. At the CI gate's workload
> (`--apps 50 --runs 3`) that is 150 wasted full scans, plus 150 re-reads and
> `vm` compiles of `scan.driver.mjs`, because `loadScanDriver()` runs inside every
> `benchScan`. The fix is a `{twins: "driver"}` option; drift stays
> `bench-apply`'s job.

> **Known defect (2026-08-05 audit).** `--gate --runs 7` runs seven full samples
> of each of the seven matrix rows — 49 subprocess spawns — but `summarize()`
> reads `round_trips`, `model_turns`, `plan`, `gate` and `fill_report` from
> `samples[0]` only, and `printGate` prints nothing else. Forty-two of the 49
> samples contribute nothing to the human report.

> **Known defect (2026-08-05 audit).** Every `GATE_MATRIX` row carries a
> free-text `claim` ("0 added turns: an OPTIONAL widget defer is exempt from
> readiness") and `printGate` prints the claim and the measured delta as
> _unrelated lines_. Nothing compares them, so deciding whether the run confirmed
> or refuted the claim is left to whoever reads the table. `bench-runner` already
> does this properly with `concurrency_ok` and `ledger.ok`.

> **Known defect (2026-08-05 audit).** None of the four harnesses honours the
> repo's terse-for-agents convention. `scripts/lib/lib.mjs` exports
> `outputMode()` / `isTerse()`, used everywhere else to print compact records
> when the output is not a terminal — and `isTTY` appears nowhere under
> `scripts/dev/`. An agent running `bench-apply` receives the full forty-line
> prose report plus the six-entry unmeasured list plus seven hash lines.

**Verdict on the size.** The file is large because it holds four genuinely
different measurement rigs (accounted, per-verb, gate matrix, two browser legs)
plus a 365-line browser double plus its own statistics, formatting, provenance
and CLI. It could reasonably be three files —
the double, the legs, and the CLI — but there is no significant volume of code
in it that does nothing.

---

# Part 3 — `bench-runner.mjs`: a whole campaign

## 3.1 What it measures, and how it differs from `bench-apply`

`bench-apply` measures **one** application. `bench-runner` measures a **run** of
them: N applications at concurrency C, through the real queue, with the real
plan and fill engines, and reports the numbers the CI gate is written against.

The governing rule for this file is stated in its header and is the reason it can
be trusted:

> IT DRIVES PRODUCT CODE AND DECIDES NOTHING. The scan engine, fill-plan, the
> fill engine, the queue state machine, the taxonomy and the classifier are all
> the shipped modules. What this file supplies is only the parts a benchmark must
> supply anyway — a worker pool, a clock, and a fixture. It contains no policy:
> no retry rule, no backoff, no trust decision, and NO CLICK.

In dry-run it writes the same durable database row the real path would write and
stops there.

The columns:

| column                    | meaning                                                            |
| ------------------------- | ------------------------------------------------------------------ |
| `submitted_per_hour`      | completed submissions, extrapolated to an hourly rate              |
| `deferred_per_hour`       | deferrals, same extrapolation — reported **separately**, see below |
| `defer_rate`              | fraction of applications that deferred                             |
| `defer_rate_by_class`     | that fraction split by _kind_ of deferral                          |
| `model_turns_per_app`     | **clocked** foreign process spawns + non-loopback network requests |
| `sleep_ms_per_app`        | flat sleep + typing time, per application                          |
| `edge_spacing_ms_per_app` | the courtesy wait between requests to one site (zero unless asked) |
| `wall_ms_p95` / `_p50`    | the slow tail and the typical case                                 |
| `spawns_per_app`          | **every** child process, unfiltered                                |
| `round_trips_per_app`     | browser operations, off the instrumented page's own counter        |
| `failure_rate_p`          | failure rate per board — the number the safety breaker rests on    |

Two of those choices deserve explanation.

**Throughput is reported as two columns, not one.** Applications-per-hour alone
is gameable: deferring more _raises_ it, because a deferral is fast. Splitting
submitted from deferred makes that impossible to hide.

**`defer_rate_by_class` splits by class, not by kind**, because an engineer
needs to know whether a number is theirs to move. The `understanding` class
(the machine did not understand the page) shrinks with better adapters and more
banked answers. The `assent` class (a checkbox, a consent tickbox, a question the
user must assert) must **not** shrink — that is the safety gate. A single
`defer_rate` cannot say which you are looking at.

## 3.2 How to run it

```bash
# the CI gate's exact workload
node scripts/dev/bench-runner.mjs --apps 50 --concurrency 8 \
  --board greenhouse,honest-greenhouse --runs 3 --json

# a quick look while working
node scripts/dev/bench-runner.mjs --apps 8 --concurrency 4

# a paste-ready docs/measurements.md entry
node scripts/dev/bench-runner.mjs --apps 50 --concurrency 8 --ledger
```

| flag                  | default      | what it does                                                        |
| --------------------- | ------------ | ------------------------------------------------------------------- |
| `--apps N`            | `8`          | how many applications                                               |
| `--concurrency N`     | `4`          | how many at a time                                                  |
| `--board a,b`         | `greenhouse` | comma list; jobs round-robin across it                              |
| `--origins N`         | auto         | how many distinct fake sites (defaults to `min(concurrency, apps)`) |
| `--runs N`            | `1`          | how many complete campaigns                                         |
| `--profile <name>`    | `typical`    | the widget behaviour model, same three as `bench-apply`             |
| `--real-sleep`        | off          | actually sleep                                                      |
| `--edge-spacing-ms N` | `0`          | courtesy wait per origin before each job                            |
| `--latency <spec>`    | off          | switch the fixture's modelled-latency mode on                       |
| `--json`              | off          | the machine-readable record                                         |
| `--ledger`            | off          | the paste-ready ledger entry                                        |
| `--allow-dirty`       | off          | bypass the dirty-tree refusal (§3.6) — for one purpose only         |

**Exit codes.** `0` normally. `1` if the run did not reach the requested
concurrency (§3.5). `2` for the dirty-tree refusal.

There is no `--mode` flag: `runCampaign` accepts `mode` and defaults it to
`"dry_run"`, and the CLI never sets it. A campaign is always a dry run.

## 3.3 The instrument: why `model_turns` needed a `--require` preload

This is the most subtle piece of engineering in the area, and it is worth
following because the failure mode it avoids is invisible.

The CI gate's one hard, no-override rule is `model_turns_per_app === 0`. Green
tier is _defined_ as having removed the language model from the unattended apply
path (hard rule 6). So the counter behind that column has to be right — because
a counter that silently reports `0` turns the rule into a permanent green light,
which is worse than having no rule at all.

The obvious implementation is to reach into Node's `child_process` module from
inside the harness and replace `execFileSync` with a counting wrapper. It counts
**zero**. So does patching before a dynamic `import()`. So does patching the
default-imported namespace. All three were tried, and the results are in the
file:

```
node -e '...'  patch-then-static-import   -> 0
               patch-then-dynamic-import  -> 0
               --require preload          -> 1   <- this file
```

The reason is a real property of JavaScript modules: a module that wrote
`import { execFileSync } from "node:child_process"` is bound to the _export the
builtin published at startup_, not to the property you are reassigning
afterwards. Rebinding the property changes nothing for anyone who already
imported it.

A `--require` **preload** is a file Node loads _before_ anything else, so the
wrapping happens before any module can capture the original. That is
`scripts/dev/spawn-counter.cjs`. It patches seven `child_process` functions,
`http.request`/`get`, `https.request`/`get`, and global `fetch`, incrementing
counters. It never blocks, never rewrites arguments, and never fails a call.

Then there is a second, worse trap. The plan leg **shells out** to
`scripts/apply/fill-plan.mjs` once per application. A model call added _there_
happens in a process the parent cannot see, and parent-only counting scored that
exact mutation as zero. So the preload follows the work down: the campaign sets
`NODE_OPTIONS=--require <preload>` plus `AJ_COUNTER_FILE`, every descendant
process loads it, and each appends **one JSON line on exit** to that file.
`readChildCounters()` sums every row that is not the parent's own process id.
A JSON-lines file is used because a child's in-memory counters die with the
child, and its standard output belongs to whatever the child was actually doing.
Appends of a few hundred bytes are atomic, so eight concurrent workers cannot
lose each other's rows.

Two final touches. The CLI **re-executes itself** with the preload
(`reexecWithCounters()`) if it was not started with it, so nobody has to
remember the flag — output and exit code pass straight through. And the campaign
**restores** `NODE_OPTIONS` and `AJ_COUNTER_FILE` afterwards, because "a
benchmark that leaves NODE_OPTIONS set has changed the machine it was measuring."

If the preload is somehow absent, the affected columns report `null` with a
stated reason rather than `0`. An unmeasured column and a measured zero must
never look alike.

## 3.4 Why `model_turns` is narrower than its own specification

The specification for this column says "process spawns plus outbound HTTP to any
non-loopback host". Taken literally that is red on every run **by construction**,
because the harness spawns `node scripts/apply/fill-plan.mjs` once per
application — a deterministic local script, and precisely the thing the design
wants _more_ of.

A gate that fires on the sanctioned behaviour acquires a permanent override line
within a week, which defeats the gate. So the counting is split:

- **`spawns_per_app`** counts **every** spawn, unfiltered, as a column in its own
  right. A regression in process count shows up here.
- **`model_turns`** counts a spawn only when it is **not** this repository's own
  `node` running a file under `scripts/` — plus every non-loopback request.

`isRepoScript()` in the preload implements that test: same executable as
`process.execPath`, and the first non-flag argument resolves inside
`<repo>/scripts/`. A real model call cannot hide from this. Either it is an HTTPS
request to a provider (counted), or it shells out to some other command-line tool
(counted — not our node, or not a repo script). The only thing excluded is the
case that is provably not a model.

`LOOPBACK` in the preload matches `127.x.x.x`, `localhost`, `::1` and `0.0.0.0`,
so the fixture board's own traffic is counted as `loopback_requests` and not as a
model turn.

## 3.5 The concurrency assertion, and why it is a hard failure

**Concurrency** here means: how many applications are genuinely in flight at
once. Asking for 8 does not make 8 happen. The pool this harness uses —
`runPool()` from `scripts/auto/pool.mjs`, the **shipped** pool, not a copy —
enforces an **origin exclusion rule**: at most one job at a time per website,
because two tabs on one site share upload and draft state. So a queue of 50 jobs
all pointing at one site will run one at a time no matter what number you asked
for.

The harness therefore **observes** the maximum in-flight count rather than
assuming it, and reports:

```js
concurrency_ok: x.maxInFlight === Math.min(x.concurrency, x.apps)
```

When that is false the run exits `1`, the human report shouts, and the CI gate
emits a failure before comparing any column, because:

> observed max-in-flight did not reach the requested concurrency — every
> throughput number in this run is reported under a label the run did not run at,
> so none of them may be compared or banked

This is why the fixture is started with several origins (`--origins`, defaulting
to `min(concurrency, apps)`). It is also why the harness switched from its own
local worker loop to the shipped pool: the local loop had no origin exclusion, so
it could report `max_in_flight: 8` on a queue the real runner would serialise to
1 — and CI would then have been enforcing a throughput number no production run
could ever reach.

## 3.6 The ledger invariant, and the dirty-tree refusal

**The ledger invariant** is a correctness check read off the database at the end
of every campaign, while the fixture store still exists:

```
durable_rows === reached_authorized   AND   rows_in_state_attempted === 0
```

The first half says the durable submission rows account for exactly the
applications that got as far as clicking. The second is the sharp one: a job left
in state `attempted` at run end is an **orphan** — a click was issued and nothing
ever recorded what happened next. In a benchmark that means the harness lost
track of a job. On the real path it would mean an application may already be
sitting in an employer's system with nobody knowing.

**The dirty-tree refusal** distinguishes _looking_ at a number from _banking_
one:

```
$ node .github/workflows/perf-gate.mjs
refusing to bank a number from a dirty tree — uncommitted changes in:
  M .claude/skills/apply-job/scan-page.js
   M scripts/apply/answer-bank.mjs
   M scripts/apply/fill-engine.mjs
   M scripts/apply/fill-plan.mjs
   M scripts/apply/scan-engine.mjs
Commit them, or pass --allow-dirty and say so wherever the number lands.
```

Looking is what you do while working, and a harness you cannot run mid-change is
a harness nobody runs — so the plain human report always works. Banking (`--json`
for the gate, `--ledger` for the ledger) compares against a baseline, and a
comparison across a tree with uncommitted edits compares a number against itself
plus an unknown. The comment records that "three readings this build were
correctly discarded for exactly this."

`--allow-dirty` exists for exactly one use: proving the gate can go red by
deliberately mutating a measured file. Anything printed under that flag is
evidence about the **gate**, never a number to bank.

> **Minor defect (2026-08-06).** The refusal message prints **twice** — once
> because `execFileSync` forwards the child's standard error to the parent by
> default, and once because `perf-gate.mjs`'s own handler prints `e.stderr`. The
> gate's header says it prints the harness's message so a correct refusal is not
> mistaken for a broken gate; printing it twice does not defeat that, but it is
> untidy. Exit status is a correct `2`.

## 3.7 Reading the output

A small campaign, run 2026-08-06:

```
bench-runner greenhouse,honest-greenhouse apps=6/6 concurrency=3/3 origins=3 mode=dry_run runs=1
  submitted_per_hour         9592.71     measured (mean over the run)
  deferred_per_hour          9592.71     measured (mean over the run)
  defer_rate                 0.5         measured (mean)
  defer_rate_by_class        assent=0.5  measured (mean)
  model_turns_per_app        0           measured (mean) — clocked: non-repo spawns + non-loopback requests
  sleep_ms_per_app           450         measured (mean)
  edge_spacing_ms_per_app    0           measured (mean) — no spacing configured; the runner's policy is Phase 5's
  wall_ms_p95                566.23      measured (p95)
  wall_ms_p50                559.24      measured (p50)
  spawns_per_app             1           measured (mean)
  round_trips_per_app        61          measured (mean) — cdp_calls off the instrumented page
  failure_rate_p             greenhouse:fixture-emp-1=0 … measured (mean per board_key)
  detail submitted=3 deferred=3 failed=0 spawns=6 foreign=0 outbound=0
  sha=0a82d75 dirty=6
```

- `apps=6/6 concurrency=3/3` — completed all six, and genuinely reached three at
  once. If the second number were `3/1` every rate below would be meaningless.
- `defer_rate 0.5` with `assent=0.5` — half the applications deferred, and _all_
  of those deferrals are the assent class. Nothing here is an engineering
  backlog item; the `greenhouse` fixture carries a consent tickbox, and
  `honest-greenhouse` does not. That is the deliberate 50/50 mix (§4.2).
- `model_turns_per_app 0`, `foreign=0 outbound=0` — no model on the path. This is
  a security property, measured.
- `spawns_per_app 1` — one child process per application: the fill planner.
- `round_trips_per_app 61` — the committed baseline is `60`, so on this tree the
  number has moved by one. **That is not a gate verdict**: this is a 6-app run on
  a dirty tree, not the gate's 50-app workload, so it is a hint to investigate,
  not evidence.
- `sha=0a82d75 dirty=6` — six measured files uncommitted. Do not bank this.

The `--ledger` form emits GitHub-flavoured Markdown ready to paste:

```markdown
## M? — bench-runner: 4 applications at concurrency 2

**Command.** `node scripts/dev/bench-runner.mjs --apps 4 --concurrency 2 --board greenhouse,honest-greenhouse --runs 1 --json`

**Legs.** loopback fixture, 2 origins, mode `dry_run`, profile `typical`, 1 run(s). Latency model: loopback.

| column                | value   | method   | statistic         | note                                             |
| --------------------- | ------- | -------- | ----------------- | ------------------------------------------------ |
| `submitted_per_hour`  | 3787.19 | measured | mean over the run |                                                  |
| `defer_rate`          | 0.5     | measured | mean              |                                                  |
| `model_turns_per_app` | 0       | measured | mean              | clocked: non-repo spawns + non-loopback requests |
| `sleep_ms_per_app`    | 450     | measured | mean              |                                                  |
| `round_trips_per_app` | 61      | measured | mean              | cdp_calls off the instrumented page              |

**Provenance.** `0a82d75`, 6 dirty measured file(s).

- `.claude/skills/apply-job/scan-page.js` `64baaccab1e6`
- `scripts/apply/fill-engine.mjs` `4a3ed5be610e`
  …

**Concurrency assertion:** observed max-in-flight 2 vs requested 2 — PASS.
```

(Abridged; the real output lists all eleven columns and all seven hashes. The
literal `M?` in the heading is a placeholder — you replace it with the next
number in `docs/measurements.md`.)

> **Known defect (2026-08-05 audit).** `writeBenchAnswers()` is called **inside**
> `oneJob`, once per application, and always writes the same path
> `<jobsDir>/bench-answers.yaml` with `fs.writeFileSync`, which truncates the file
> before writing it. With up to 8 jobs in flight, one worker can truncate that
> file while another worker's `fill-plan.mjs` subprocess is reading it. The parse
> error becomes state `failed` / `plan-error` — a fabricated entry in
> `failure_rate_p`, which is the column the safety breaker's calibration rests
> on. The content is identical every time, so hoisting the call into
> `runCampaign` before the pool starts removes the race and saves 49 writes per
> run.

---

# Part 4 — `perf-gate.mjs`: the check that runs on every push

## 4.1 What it is

`.github/workflows/perf-gate.mjs` is one of five jobs in the continuous
integration pipeline (the full pipeline is described in
[`12-harness-and-ci.md`](12-harness-and-ci.md) §3.4, which covers the same file
from the CI side; this section covers it as the _consumer of the benchmark_).

**Continuous integration** means: every time code is pushed, someone else's
computer checks out the repository from scratch and runs a fixed set of checks.
The performance gate's check is: run the benchmark, compare five numbers against
a committed baseline, fail the build if any of them got worse.

It runs on Ubuntu only, with a 20-minute limit. Ubuntu-only is deliberate: a
baseline is only meaningful against one platform. The test matrix proves the code
_runs_ everywhere; this job proves it did not get _slower_.

## 4.2 What it compares

The workload is fixed in the source, not passed in:

```js
export const GATE_ARGS = [
  "--apps",
  "50",
  "--concurrency",
  "8",
  "--board",
  "greenhouse,honest-greenhouse",
  "--runs",
  "3",
  "--json",
]
```

> The gate's own command. Fixed here rather than passed in, because a gate whose
> workload is a parameter is a gate whose baseline means nothing.

The board **mix** is equally deliberate. `--board greenhouse` alone gives
`defer_rate = 1.0` by construction, because that fixture carries a consent
tickbox and every application defers on it — so submitted throughput is
structurally zero and the defer-rate rule can never move in either direction.
"A gate whose columns cannot move is not a gate."

`--runs 3` exists so the comparison can be made on the **median** of three runs
(`acrossRuns`), which discards a single freak reading.

## 4.3 What makes it go red

| column                | statistic                      | severity | overridable?  | limit                     |
| --------------------- | ------------------------------ | -------- | ------------- | ------------------------- |
| `model_turns_per_app` | mean over the run              | **fail** | **never**     | `0`                       |
| `sleep_ms_per_app`    | mean                           | fail     | `sleep_ms`    | `baseline × 1.1 + budget` |
| `round_trips_per_app` | mean                           | fail     | `round_trips` | `baseline + budget`       |
| `defer_rate`          | mean                           | fail     | **never**     | `baseline + 0.02`         |
| `wall_ms_p95`         | p95, on the median of the runs | **warn** | never         | `baseline × 1.25`         |

Plus two structural failures checked before any column:

- **concurrency** — if the observed max-in-flight did not reach what was
  requested, everything below it is mislabelled (§3.5).
- **the ledger invariant** — durable rows must equal the applications that
  reached the point of clicking, and nothing may be left in `attempted` (§3.6).

The severities differ **on purpose**, and each rule carries its own `why` string
explaining itself:

- **`model_turns` is hard with no override**, because green tier is _defined_ as
  removing the model from the path. A model turn there is not a regression in
  degree — it is the property being gone. Its test is
  `v === null || v > limit`, so a _missing_ measurement also fails: "an
  unmeasured column cannot clear a hard gate."
- **`sleep_ms` and `round_trips` are overridable**, because both sometimes have
  to rise for a real reason — a board that genuinely needs a settle, a page that
  genuinely needs a second read. The override is one line in the pull request
  body, so the rise is a thing somebody wrote down rather than a thing that
  happened.
- **`defer_rate` is hard**, because a rising defer rate is the machine
  understanding _less_, and the sanctioned ways to move it all point the other
  way: an adapter, a probed option list, or a banked answer.
- **`wall_ms_p95` is warn-only**, because it is the noisiest column and the one
  most affected by whatever else the build machine is doing. "A hard rule on it
  would teach people to ignore red, which costs more than the regressions it
  would catch."

**The budget override** is parsed out of the pull request description by
`parseBudget()`:

```
perf-budget: sleep_ms +150
```

One line, one column, a number. It raises that rule's limit for this pull
request only. There is no way to write such a line for `model_turns` or
`defer_rate` — those rules simply never consult the budget.

Every gated column also **names the statistic it compares on**, in the rule, in
the failure message and in the baseline file, because "'sleep went up' is not a
claim until you know whether that is a mean, a min or a p50."

**Falsifiability, proved by mutation rather than argued.** Before this gate was
wired, both halves were demonstrated by deliberately breaking things
(`docs/measurements.md` M9):

| mutation                                                               | result                            |
| ---------------------------------------------------------------------- | --------------------------------- |
| add `waitForTimeout(200)` after the fill engine's verify blur          | `sleep_ms` 450 → 650, **FAIL**    |
| the same, with `perf-budget: sleep_ms +200` in the PR body             | **PASS** — budget applied         |
| add an HTTPS request to a model provider at the top of `fill-plan.mjs` | `model_turns` 0 → 1, **FAIL**     |
| the same, with `perf-budget: model_turns +99` in the PR body           | **FAIL** — no override, by design |

There is a recorded false start in there worth remembering: the first attempt put
the extra sleep in `openCombo`, which this workload does not reach, and the gate
stayed green — correctly. A mutation proof on a code path the run does not take
proves nothing, and looks exactly like a broken gate.

## 4.4 How the baseline is updated

`docs/perf-baseline.json` is a committed file. It is written by one command:

```bash
node .github/workflows/perf-gate.mjs --update
```

That runs the same fixed workload, takes the median of the runs for each rule,
and writes:

```json
{
  "taken_at": "2026-08-03T04:28:54.530Z",
  "command": "node scripts/dev/bench-runner.mjs --apps 50 --concurrency 8 --board greenhouse,honest-greenhouse --runs 3 --json",
  "runs": 3,
  "statistic": {
    "model_turns_per_app": "mean over the run",
    "sleep_ms_per_app": "mean",
    "round_trips_per_app": "mean",
    "defer_rate": "mean",
    "wall_ms_p95": "p95, compared on the median of the runs"
  },
  "columns": {
    "model_turns_per_app": 0,
    "sleep_ms_per_app": 450,
    "round_trips_per_app": 60,
    "defer_rate": 0.5,
    "wall_ms_p95": 1565.31
  },
  "provenance": {
    "sha": "9905681",
    "dirty_measured_files": [],
    "file_sha1": { "…": "…" }
  }
}
```

The practical procedure for changing it:

1. **Land the change first**, so the tree is clean. `--update` runs the harness
   with `--json`, and the harness refuses a dirty tree (§3.6). This is a feature:
   a baseline taken from uncommitted work cannot be reproduced.
2. Run `--update` on a **quiet** machine. Contention inflates `wall_ms_p95` and
   you would be baking someone else's build into the ceiling.
3. Read what it printed. It echoes the new `columns` block.
4. Commit `docs/perf-baseline.json` **together with** a `docs/measurements.md`
   entry saying what changed, what the old numbers were and what the new ones
   are. The baseline file records _what_; the ledger records _why_.

If a column is missing from the baseline entirely, the gate emits a **warning**
("no baseline for X — nothing to compare against (run --update)"), never a silent
pass.

`docs/perf-baseline.json` is also read by `tests/hooks/perf-gate.test.mjs`, which
asserts that every rule key is present, every statistic label matches, the command
string is right and the provenance carries a sha. So a baseline file that has
drifted out of shape fails the test suite, not only the gate.

---

# Part 5 — `flake-rate.mjs`: turning "that test is flaky" into a number

## 5.1 What a flaky test is, and why it is dangerous

A **flaky** test is one that sometimes passes and sometimes fails on identical
code. The usual causes are timing and shared resources: two tests writing the
same database file, two headless browsers competing for memory, a wait that is
just long enough on a quiet machine.

A flaky test is worse than a failing test, because of what people do with it. A
build that goes red for no reason gets **re-run** instead of read. Once that
becomes a habit, a genuine failure gets re-run too, and the gate is effectively
gone. The file's header puts the threshold precisely: "Two flaky tests is the
point where a red build gets re-run instead of read."

## 5.2 Why "1 failure in 3 runs" is not evidence

Two tests here were reported as intermittent, with "3 failures in 7 runs" and "1
failure in 3 runs". Right instinct, wrong evidence — because those small samples
are consistent with an enormous range of true failure rates. Computed by this
tool's own `wilson()`:

| observed        | point estimate | 95% interval  |
| --------------- | -------------- | ------------- |
| 1 failure / 3   | 33.3%          | 6.1% – 79.2%  |
| 3 failures / 7  | 42.9%          | 15.8% – 75.0% |
| 0 failures / 10 | 0%             | 0% – 27.8%    |
| 0 failures / 20 | 0%             | 0% – 16.1%    |

A **confidence interval** is the range of true values consistent with what you
observed. Read the first row: after seeing one failure in three runs, the real
failure rate could be 6% or it could be 79%. A fix that removes four fifths of
the flakiness and a fix that does nothing at all look identical from inside that
interval.

The tool uses the **Wilson score interval** rather than the textbook normal
approximation, and the reason is in rows three and four. At zero observed
failures, the normal approximation reports `[0, 0]` — certainty, derived from an
absence of evidence. That is exactly the error this file exists to prevent.
Wilson stays honest: twenty clean runs bound the true rate below about 16%, and
no lower.

`runsToRuleOut(rate)` prices the other half of the argument — the "I ran it
again and it passed" move. It computes `ln(0.05) / ln(1 - rate)`: how many
consecutive passes you need before a clean streak is evidence rather than luck.
At a true 10% rate that is **29 consecutive passes**. At the 41.7% rate this tool
once measured, six. At a rate of zero it correctly returns `Infinity`.

## 5.3 How to run it

```bash
node scripts/dev/flake-rate.mjs tests/lib/db.test.mjs --runs 20
node scripts/dev/flake-rate.mjs tests/lib/db.test.mjs --runs 12 --load 4
node scripts/dev/flake-rate.mjs tests/documents/render-pdf.test.mjs --runs 6 --json
```

| flag              | default | meaning                                                            |
| ----------------- | ------- | ------------------------------------------------------------------ |
| _(positional)_    | —       | the test file or directory to run                                  |
| `--runs N`        | `10`    | how many batches                                                   |
| `--load N`        | `1`     | copies of the target to run **at the same time** per batch         |
| `--alongside <f>` | none    | also run a **different** file concurrently — load, but not counted |
| `--json`          | off     | the full record                                                    |
| `--help`          | —       | usage                                                              |

`--load` and `--alongside` are the contention dials from §0.4, and the header
insists they are the point, not a setting: both known flakes in this repository
_are_ contention, so "the rate is meaningless without saying what else was
running."

They count differently, and correctly. Under `--load 4`, all four copies are
recorded — one failure in a batch of four is one failure in four runs, not one in
one; conflating them would overstate the rate fourfold. Under `--alongside`, the
competing file is started and awaited but **not counted** — it is the load, not
the sample.

Two implementation details that were bugs first:

- **TAP output is forced**, not assumed: `node --test --test-reporter=tap`.
  Node 24 defaults to a human-readable reporter even when output is piped, so the
  `not ok` parser matched nothing and every failure was attributed to
  `<file-level>` — a rate with no test name is half a measurement. Measured
  2026-08-01: a 41.7% flake rate that could not be attributed until that flag
  existed.
- **The failure pattern allows leading whitespace** (`/^[ \t]*not ok \d+ - (.+)$/gm`),
  because TAP indents nested tests and an anchored `^not ok` misses every one of
  them. There is a fallback parser for the other reporter, deduplicated because
  that reporter prints each failing name twice.

Each run is also classified by cause where possible: `SQLITE_BUSY` (database
contention) or `timeout`.

## 5.4 How to read the output

```
  run   1  pass  1204ms
  run   2  FAIL  1890ms  SQLITE_BUSY
  …

flake rate — tests/lib/db.test.mjs  (load=4)
------------------------------------------------------------------------
  failures        3 / 48
  rate            6.2%  [95% CI 2.1% – 17.0%]
  a clean re-run  proves nothing until 47 consecutive passes
  even at 0/48, the true rate could still be as high as 17.0%
  wall ms         min 1104  median 1355  max 2019
  causes          SQLITE_BUSY
  failed 3x       auto_queue claims are exclusive
```

The three lines that do the real work are the interval, the
"proves nothing until N consecutive passes" line, and the
"even at 0/N" line. Together they stop both bad arguments: "I fixed it, look, it
passes" and "it's fine, it hasn't failed lately".

`wall ms` is there so that a fix which trades flakiness for slowness is visible
rather than invisible.

> **Known defect (2026-08-05 audit).** The target file is chosen as
> `argv.find((a) => !a.startsWith("--"))` — the first argument that is not a
> flag. So any flag placed **before** the filename donates its value as the
> target. `node scripts/dev/flake-rate.mjs --runs 20 tests/lib/db.test.mjs` runs
> `node --test --test-reporter=tap 20`, which fails every time, and the tool
> confidently reports a **100% flake rate with a Wilson interval** for a file it
> never executed. Every documented example puts the target first, so the bug
> hides. Until it is fixed: **always put the file first.**
> `tests/dev/flake-rate.test.mjs` covers `wilson()` and `runsToRuleOut()` and
> never the command line.

> **Known defect (2026-08-05 audit).** `--alongside` is implemented and parsed
> but absent from the usage text.

> **Known defect (2026-08-05 audit).** Unlike the two bench harnesses,
> `flake-rate` has no `--ledger`, so its ledger entries have been composed by
> hand from the human report — a model turn per measurement and a source of
> format drift. It already computes everything an entry needs.

---

# Part 6 — `bench-green-prevalence.mjs`: a census, not a benchmark

## 6.1 The question it answers

This tool measures no time at all. It answers a supply question: **of the real
application forms this machine has actually seen, how many could ever be fully
automated?** A form is disqualified permanently if it contains a checkbox or
radio group (which carries assent, not a value), or a consent tickbox, or a field
that resolves to `CONFIRM`.

The corpus is small and the file says so loudly. The plan that commissioned it
assumed "the already-stored scans of the 141 leads"; there are no such scans.
What exists is `jobs/.field-cache.json` — remembered form shapes — and a handful
of scans in individual job workspaces.

The most important design property is that **it re-implements no rules**. Every
verdict comes from the shipped functions: `shapeBlockers()` and `classify()` from
`automatability.mjs`, `resolveFields()` from `fill-plan.mjs`, `predictedFields()`
from `pending-questions.mjs`. This file only **buckets** the strings those
functions returned, via `CATEGORIES` — a list of regular expressions matching the
literal blocker messages. And if it sees a blocker it does not recognise it
**throws**, rather than quietly under-counting:

```js
throw new Error(
  `bench-green-prevalence: unrecognised blocker from shapeBlockers() — ` +
    `the rules moved and this tally would silently under-count: ${blocker}`,
)
```

It also runs the **shipped** `fill-plan.mjs` command line against a **copy** of
the jobs tree in a temporary directory, so the artifact is measured rather than a
reconstruction of it, and nothing in the real `jobs/` tree is touched.

The published result (`docs/measurements.md` M7) was **1 of 7** remembered form
shapes could reach the fully-automated tier, with 5 of 7 permanently blocked by a
widget or consent rule. The entry refuses to turn seven into a percentage.

## 6.2 How to run it — and the fact that you currently cannot

```bash
node scripts/dev/bench-green-prevalence.mjs              # human report
node scripts/dev/bench-green-prevalence.mjs --json
node scripts/dev/bench-green-prevalence.mjs --self-check # validates the bucketer
node scripts/dev/bench-green-prevalence.mjs --no-scans   # undocumented; skips the scan legs
```

`--self-check` runs five synthetic cases through the real rules and confirms the
bucketer still speaks the product's language. It works today:

```
ok   checkbox defers on shape even when required and answerable -> [confirm-widget]
ok   consent tickbox defers on topic -> [consent]
ok   a shape recording no requiredness is not evidence -> [req-not-recorded]
ok   empty shape blocks -> [no-fields]
ok   stale shape blocks -> [stale-shape]
```

The main report does not.

> **Known defect (verified 2026-08-06).** `node scripts/dev/bench-green-prevalence.mjs --json`
> **crashes** before printing anything, at the deliberate throw in `bucket()`:
>
> ```
> Error: bench-green-prevalence: unrecognised blocker from shapeBlockers() —
> the rules moved and this tally would silently under-count: "Are you at least 18
> years of age?*" resolves to an assertion the user confirms
> (assertion/inferred (eligibility_attestation)) — the planner defers it whether
> or not the form marks it required
> ```
>
> This is the safety mechanism working exactly as designed — the rules grew a new
> blocker kind and the tally refuses to under-count — but the consequence is that
> the census cannot be re-taken until `CATEGORIES` grows a matching bucket.

> **Known defect (2026-08-05 audit).** Even past that, the run would exit `1`.
> `SCANS` hard-codes four workspace scans including
> `affirm-swe-backend-pba-growth/scan-p2.json` and `scan-p3.json`, and that folder
> now contains only `scan-p1.json`. `main()` refuses to report a partial corpus.
> Discovering scans by pattern (`jobs/*/scan-p*.json`) would fix it.

> **Known defect (2026-08-05 audit).** The report prints a hard-coded provenance
> sentence — `"raw JSON.parse — loadCache() would discard v:2 against
CACHE_VERSION 4"` — and the header says the corpus is seven shapes. The live
> `jobs/.field-cache.json` is **v:4 with 13 forms**, so `loadCache()` would not
> discard it and the stated justification for bypassing `loadCache()` has
> evaporated. Compute the sentence from `cache.v` and `CACHE_VERSION`.

> **Known defect (2026-08-05 audit).** The temporary directory is built from a
> hand-rolled fallback ending in `"."`, so with no temp environment variable set
> the script creates `green-prev-XXXXXX/` **in the repository root**. `os.tmpdir()`
> already does this correctly and is not imported. Worse, `tmpRoot` is never
> removed, so every run leaves a recursive copy of real job workspaces —
> including tailored resumes, cover letters and rendered PDFs — sitting in temp.
> Both bench harnesses clean up in a `finally` block; this one should too.

> **Known defect (2026-08-05 audit).** The second `analyseCache` pass labelled
> `_AS_SHIPPED_CLI` exists to reproduce a finding (passing `profile: null` reached
> `fs.existsSync(null)` and loaded an empty fact base) that has since been fixed
> in `answer-bank.mjs`. The leg now returns the same numbers as the first pass
> while the report still tells the reader it demonstrates an empty fact base —
> and pays for a second full resolution over the corpus. Delete it, or convert it
> into an assertion that the two passes agree.

---

# Part 7 — Where the numbers live

## 7.1 `docs/measurements.md` — the ledger

1,236 lines, append-only, and the closest thing this project has to a lab
notebook. Its structure:

- **How to read an entry** — budget, three separate columns, and the fact that
  `inconclusive` is a legitimate verdict.
- **Measuring honestly** — same machine, same fixture, warm and cold runs
  distinguished, never against a live employer's board.
- **The entry template:**

  ```
  ## <id> — <what changed>
  - agent:    <owning agent>
  - harness:  <exact command, copy-pasteable>
  - baseline: <sha> — round_trips=<n> sleep_ms=<n> model_turns=<n> wall_ms=<n>
  - after:    <sha> — round_trips=<n> sleep_ms=<n> model_turns=<n> wall_ms=<n>
  - budget:   <declared up front, or "none declared">
  - verdict:  improved | within budget | REGRESSION | inconclusive
  - note:     <= 40 words
  ```

- **A regression protocol** — what happens when a number moves the wrong way:
  work-in-progress (name the commit where it recovers; this answer cannot be used
  twice for the same change), fix forward with both numbers left visible, or
  request a rollback with the ledger entry attached so the next attempt does not
  blindly retry the approach that just failed. "Correctness outranks speed. A
  declared security cost is never rolled back on performance grounds alone."
- **Standing caveats** — read before quoting anything (§0.3 quotes the sharpest).
- **Entries M1 through M10.** Several are worth reading in full; M1 records the
  harness defect that **withdrew** every prior latency number, M6 the truncated
  fill, M9 the campaign baseline and the mutation proofs.

A note on culture, because it is unusual and it is the reason these documents are
trustworthy: M1's verdict is "inconclusive → prior numbers withdrawn", and it
explains that the answer bank's gate had never once fired, so the pre-existing
gate "measured as free **because it never ran**". Nobody deleted the old numbers;
they are still there with a note saying they are wrong.

## 7.2 `docs/perf-baseline.json` — the machine-readable baseline

Thirty-two lines, described in §4.4. Written only by
`perf-gate.mjs --update`, read by CI on every pull request and by
`tests/hooks/perf-gate.test.mjs`. Unlike the ledger it is **not** append-only —
it holds the current expectation and nothing else. The history of how it moved
belongs in the ledger.

---

# Part 8 — The defect list, in one place

Everything marked above, collected so you can see the shape of the area's health.
Full evidence for each is in [`../audit-2026-08-05.md`](../audit-2026-08-05.md).

| where                                | defect                                                                             | severity                       |
| ------------------------------------ | ---------------------------------------------------------------------------------- | ------------------------------ |
| `bench-green-prevalence.mjs`         | crashes in `bucket()` — a new blocker kind the CATEGORIES list does not know       | **blocking** — cannot be run   |
| `bench-green-prevalence.mjs` `SCANS` | two of four hard-coded corpus scans no longer exist; run refuses partial corpus    | **blocking**                   |
| `bench-green-prevalence.mjs`         | temp dir can be created in the repo root and is never cleaned up                   | leaks copies of job workspaces |
| `bench-green-prevalence.mjs`         | hard-coded provenance sentence is now false (cache is v:4, 13 forms)               | misleading output              |
| `bench-green-prevalence.mjs`         | superseded `_AS_SHIPPED_CLI` leg duplicates work and prints a false claim          | wasted work + false claim      |
| `flake-rate.mjs`                     | a flag before the filename becomes the target; reports 100% flake for a bad run    | **silently wrong numbers**     |
| `flake-rate.mjs`                     | `--alongside` undocumented; no `--ledger`                                          | minor                          |
| `bench-apply.mjs` `PROTOCOL`         | citations are line numbers and have drifted; `handoff` models the pre-rule-6 flow  | derived columns under-count    |
| `bench-apply.mjs` `--gate`           | skips the M6 completeness guard the gate matrix motivated                          | can print a truncated baseline |
| `bench-apply.mjs` `--gate --runs N`  | spawns 7×N subprocesses, reports `samples[0]`                                      | wasted work                    |
| `bench-apply.mjs` `--page N`         | serves and times page 1 while measuring page N's scan                              | mislabelled leg                |
| `bench-apply.mjs` `benchBrowserFill` | dead `page` parameter that would mislabel output                                   | latent                         |
| `bench-apply.mjs` `GATE_MATRIX`      | `claim` is prose nothing compares against the measured delta                       | judgement left to the reader   |
| `bench-runner.mjs`                   | runs both scan twins, uses one — 150 wasted scans at the gate workload             | wasted work                    |
| `bench-runner.mjs`                   | `writeBenchAnswers` races: one worker truncates a file another is reading          | **fabricates failure rows**    |
| all four harnesses                   | ignore `isTerse()` / `outputMode()`; always print the full prose report            | agent token cost               |
| `perf-gate.mjs` `GATE_ARGS`          | the Ashby fixture — the slowest board, with the 700 ms remount — is not in the mix | a blind spot in the gate       |
| `perf-gate.mjs`                      | prints the dirty-tree refusal twice                                                | cosmetic                       |
| `package.json`                       | the 9.5 KB `testGate.full.measured` changelog belongs in `docs/measurements.md`    | orientation cost               |

Two patterns are worth naming. First, **the harnesses are more careful than the
things they measure** — nearly every defect above is wasted work, a stale label
or a documentation drift, not a wrong number, because each harness refuses in the
one direction that matters. Second, the two that _do_ produce wrong numbers —
`flake-rate`'s argument order and `bench-runner`'s answers-file race — both
produce numbers that look completely normal. That is the failure mode this whole
area is built to prevent, and it still got in twice.

---

# Where to go next

- [`12-harness-and-ci.md`](12-harness-and-ci.md) — the CI pipeline the
  performance gate is one job of, plus the test gate, the hooks and every
  configuration file. It covers `perf-gate.mjs` from the CI side.
- [`14-tests.md`](14-tests.md) — the test suite `flake-rate.mjs` measures the
  reliability of, and where each harness's own tests live
  (`tests/apply/bench-apply.test.mjs`, `tests/dev/bench-runner.test.mjs`,
  `tests/dev/flake-rate.test.mjs`, `tests/dev/green-prevalence.test.mjs`,
  `tests/dev/b1-browser-fill.test.mjs`, `tests/hooks/perf-gate.test.mjs`).
- [`06-apply-scanning.md`](06-apply-scanning.md) and
  [`08-apply-filling.md`](08-apply-filling.md) — the scan and fill engines whose
  sleep, round trips and verbs everything in Part 2 is timing.
- [`09-auto-runner.md`](09-auto-runner.md) — the unattended runner, its queue
  state machine and `runPool`, which `bench-runner.mjs` drives.
- [`10-auto-safety.md`](10-auto-safety.md) — the defer taxonomy behind
  `defer_rate_by_class`, and why the `assent` class must never shrink.
- [`../guide/07-safety-model.md`](../guide/07-safety-model.md) — hard rule 6, the
  reason `model_turns_per_app` is a hard, no-override gate rather than a
  performance preference.
- [`../operate/03-troubleshooting.md`](../operate/03-troubleshooting.md) — what
  to do when the gate goes red on your pull request.
- [`../audit-2026-08-05.md`](../audit-2026-08-05.md) — the full audit, with
  evidence for every defect listed in Part 8.
