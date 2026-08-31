# The test suite

This document is about the 123 files under `tests/` and the one program that
decides whether a run of them counts as evidence. Every other document in the
`code/` set explains code that does something — finds a posting, fills a form,
writes a row. This one explains the code that checks the other code, and the
reason it exists is simple: you are going to change this repository, an AI agent
is going to change it for you, and neither of you can hold 88 script files in
your head at once. The suite is what tells you, in about two minutes, whether
the change you just made broke something you were not looking at.

The suite is also unusual in two ways that are worth knowing before you read
any of it. First, `npm test` is **not** a test run — it is a **gate** that runs
the tests and then refuses to believe the result unless the run proves that
tests actually executed. Second, several tests here assert properties of the
**source code itself** rather than of its behaviour, because some of this
project's safety rules ("only two files may contain a click") cannot be observed
by running anything.

**What you will learn**

- What a test, an assertion, a fixture, a golden file and a boundary case
  actually are — each explained with a real example from this repository, with
  its input and its output.
- Why tests are the thing that lets you change code without fear, told through
  two real incidents in this repository where they worked and one where a
  green suite meant nothing.
- Why `npm test` runs a program called `test-gate.mjs` instead of running the
  tests directly: `node --test` exits with a success code on a run that
  executed **zero** tests, so an exit code alone is not evidence.
- What `floor`, `maxTodo`, `requireDirs` and `paths` mean in `package.json`'s
  `testGate` block, and the project's rule that a floor must be a number **two
  honest runs produced on a quiescent tree** — including the run that once
  reported 4, then 6, then 0 failures on identical code.
- What is in each of the eleven directories under `tests/`, and what the
  handful of individually famous tests are for.
- What every fixture corpus is, including the deliberately hostile ones, and
  the one corpus that is deliberately **empty**.
- Which scripts have no test at all, derived by listing both trees and
  comparing them rather than by asking anyone.
- How to run the whole gate, the security gate, and one file — and the one
  command shape that looks like a test failure but is not.

If you have not read [`../guide/03-programming-basics.md`](../guide/03-programming-basics.md),
read the parts about functions, modules and exit codes first; this document
assumes you know that a program can end with a number that means "fine" or
"not fine".

---

# Part 1 — The vocabulary, with real examples

## 1.1 What a test is

A **test** is a small piece of code that runs some of your real code with a
known input and then states what the answer must be. If the answer is what it
said, the test passes. If not, the test fails and prints the difference.

That is genuinely all it is. There is no magic. A test is an ordinary program
that calls your ordinary program.

Node.js — the thing that runs all the JavaScript in this repository — has a test
runner built in, so there is no testing library to install. A test file is an
ordinary `.mjs` module that imports `test` from `node:test`, and every file in
this suite starts the same way:

```js
import test from "node:test"
import assert from "node:assert/strict"
```

Here is a complete, real test, from
[`tests/lib/lib.test.mjs`](../../tests/lib/lib.test.mjs). It exercises
`extractNumbers`, a function in `src/lib/lib.mjs` that pulls every number
out of a piece of text so that `verify-claims.mjs` can later check whether a
number on your resume appears anywhere in your fact base:

```js
test("extractNumbers normalizes separators and suffixes", () => {
  const n = extractNumbers(
    "Served 1,200 users, 99.9% uptime, 45+ stars, C++17, ≤250 ms, GPA 3.75",
  )
  assert.deepEqual(
    [...n].sort(),
    ["1200", "17", "250", "3.75", "45", "99.9"].sort(),
  )
})
```

Read it as three parts:

1. **A name.** `"extractNumbers normalizes separators and suffixes"`. This is
   not decoration — when the test fails, this string is what gets printed, and
   it is what the gate in Part 2 counts and reports. A good name says what must
   be true; a bad name says what the test does.
2. **An arrangement and a call.** One string goes in, one `Set` of numbers
   comes out.
3. **An assertion.** The next section.

Notice what the input is doing. `1,200` has a thousands separator that must be
stripped. `99.9%` is a percentage. `45+` has a trailing plus. `C++17` is a
programming-language name with a number glued to it. `≤250 ms` has a non-ASCII
symbol in front. `GPA 3.75` is a decimal. Every one of those is a shape that
appeared on a real resume and confused an earlier version of the function. A
test's input is a record of what has gone wrong before.

You can run this one file by itself:

```
node --test tests/lib/lib.test.mjs
```

and a passing run prints a line per test with a check mark, then a summary
block that looks like this (this is the real shape Node prints):

```
ℹ tests 0
ℹ suites 0
ℹ pass 0
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 13.3121
```

Hold on to that block. The numbers above are from a run in an **empty
directory** — zero tests, zero failures, and an exit code of `0`, which means
success. That is not a quirk to skim past; it is the entire reason Part 2
exists.

## 1.2 What an assertion is

An **assertion** is the sentence in a test that must be true. If it is true,
nothing happens and the test continues. If it is false, the assertion throws an
error, which fails the test and prints both what it got and what it expected.

This suite imports `node:assert/strict`. The `/strict` matters: it makes the
comparisons exact, so `"5"` is never considered equal to `5`. Without it, a
function that starts returning text instead of numbers could keep passing.

Four assertion forms cover almost everything in this repository:

| assertion               | means                                            | real use                                                                    |
| ----------------------- | ------------------------------------------------ | --------------------------------------------------------------------------- |
| `assert.equal(a, b)`    | `a` is exactly `b` (a single value)              | `assert.equal(detectAts("https://jobs.ashbyhq.com/vanta/abc").id, "ashby")` |
| `assert.deepEqual(a,b)` | `a` and `b` have the same contents, item by item | comparing two arrays of extracted numbers                                   |
| `assert.ok(x)`          | `x` is truthy — "this is the case"               | `assert.ok(found.includes("C++"))`                                          |
| `assert.throws(fn)`     | calling `fn` raises an error                     | proving a guard refuses rather than silently allowing                       |

The third argument of every one of these is an optional message. This suite uses
it heavily, and you should too, because a failure message is read by a person
six months later who has no idea what the test was for. From
[`tests/auto/click-surface.test.mjs`](../../tests/auto/click-surface.test.mjs):

```js
assert.deepEqual(
  offenders,
  [],
  `these files under src/auto/ contain a click and are not permitted to: ` +
    `${offenders.join(", ")}. The click surface is exactly ` +
    `${[...PERMITTED.keys()].join(" and ")} (§4.10, §4.11).`,
)
```

`assert.deepEqual(offenders, [])` says "the list of offending files must be
empty". The message says what an offender **is** and why the rule exists. A bare
failure would have printed `[ 'newfile.mjs' ] !== []`, which tells the reader
nothing.

One more real assertion, because it shows the shape that catches the
subtlest bugs — asserting the **absence** of something:

```js
// "React Native" must not also report bare "React"
assert.ok(!found.includes("React"))
```

`techTermsIn` finds technologies named in a piece of text. If it reports both
"React Native" and "React" for the phrase "React Native", then a resume could
claim React on the strength of a React Native fact. The `!` in front makes this
an assertion that something did **not** happen, and those are frequently the
important ones in a safety-critical suite.

## 1.3 What a fixture is

A **fixture** is a fixed, committed piece of input data that tests run against.
The word comes from "fixed" — it does not change between runs, so a test that
uses it gives the same answer today and next year.

Fixtures matter more here than in most projects for one specific reason: your
real fact base, `profile/profile.yaml` and `profile/answers.yaml`, is
**gitignored** and holds your actual name, address, phone number and salary
answers. Tests cannot read it. If they did, the suite would pass on your
machine and fail on every other one, and it would be impossible to run in CI at
all.

So the suite has a stand-in. [`tests/fixtures/profile.yaml`](../../tests/fixtures/profile.yaml)
opens with a comment saying exactly what it is:

```yaml
# Fake profile used ONLY by tests (real profile is gitignored).
meta:
  version: 1
  target_role: Full-Stack Developer
  approved_by_user: true

contact:
  name: Jane Test
  location: "Springfield, IL"
```

"Jane Test" from "Springfield" is invented. Every fixture in this suite that
looks like personal data is invented in the same way, and
`tests/hooks/repo-hygiene.test.mjs` has a test called `"nothing under tests/ is
gitignored"` that fails the build if a fixture ever stops being committable —
because a fixture that git refuses to store is a test that nobody else can run.

Fixtures in this repository come in three grades, and the difference is worth
naming:

- **A tiny inline fixture** written in the test file itself. Best when it is
  three lines and only one test needs it.
- **A shared file fixture**, like `tests/fixtures/job.json` — a fake job posting
  for WidgetCo, used by every test that needs "a posting" without caring which
  one.
- **A corpus** — a whole directory of them, curated, with a README explaining
  what each one proves. Part 4 covers the six corpora this suite has.

## 1.4 What a golden file is

A **golden file** (also called a snapshot) is a committed copy of the exact
output your code is supposed to produce. The test runs the code and compares the
result to the file, byte for byte. If a single character differs, the test
fails.

The analogy that fits: it is a photograph of the expected result, taken once by
someone who checked it carefully, kept so that later runs can be compared
against it. Where the analogy stops: a photograph is a record of the past,
whereas a golden file is a **promise about the future**, and it is only as good
as the review it got the day it was created.

This suite's goldens live in
[`tests/documents/assemble/golden/`](../../tests/documents/assemble/golden/) —
nine Markdown files, one per job fixture:

```
cloud-platform.md          graphql-api.md      python-data.md
fullstack-generalist.md    node-backend.md     react-frontend.md
fullstack-generalist--default-budget.md
fullstack-hostile.md       fullstack-hostile-clean.md
```

Each is a complete tailored resume that `src/documents/assemble-resume.mjs`
produced for the matching job in `tests/documents/assemble/jobs/`. The test in
[`tests/documents/assemble-resume.test.mjs`](../../tests/documents/assemble-resume.test.mjs)
is named
`"six job fixtures across different stacks assemble byte-identically to their goldens"`,
and its core is one line:

```js
assert.equal(markdown, golden, `${slug} drifted from its golden file`)
```

Why goldens are the right tool here, and not just a nice-to-have: the assembler
is **deterministic** — the same profile and the same posting must always produce
the same resume, with no model involved. "Deterministic" is exactly the property
a byte-for-byte comparison tests. If someone later adds a random tiebreak, a
timestamp, or a model call to the assembler, every one of these nine files
fails at once.

Two details in that file show how a golden test is made honest:

- **`GOLDEN_BUDGET = 1400`**, deliberately tighter than the real
  `DEFAULT_BUDGET`. A budget is how many characters of bullets the resume may
  carry. If the budget were generous, every job would fit every bullet, every
  golden would be the same document, and the files would prove nothing about
  **selection**. Squeezing the budget forces the assembler to choose, and the
  goldens then pin the choices.
- **Two independent verbatim rules**, called Rule S and Rule V in the file's
  header. Rule S says every annotated line must equal its profile fact exactly.
  Rule V says every span of every line must decompose into either a declared
  structural label or a verbatim substring of the fact base. The header records
  that both were **mutation-proved** before landing: a word not in the fact
  base was inserted and Rule V caught it; a bullet was reworded and Rule S
  caught it. That is the discipline that separates a golden test from a
  rubber stamp — you must prove the test can fail before you trust it passing.

**The failure mode of golden files**, which you will meet: someone makes a
legitimate improvement, nine tests go red, and the temptation is to regenerate
all nine files and commit. That is not always wrong — but it must be a decision
made after **reading the diff**, not a reflex. A regenerated golden that nobody
read is a test that has been switched off.

It happened on 2026-08-17, and it is worth having the record. Skills groups
started competing for budget instead of all being mandatory, and **five** of the
nine goldens moved — `cloud-platform`, `graphql-api`, `node-backend`,
`python-data`, `react-frontend` — the four `fullstack-*` files and the
default-budget one byte-identical. The change was predicted per file _before_
regenerating (a table of "this group out, this bullet in"), each diff was read
against the prediction, and every one was exactly one or two zero-relevance
`- Group: …` lines out and one real bullet in. That is what "regenerate after
reading" looks like in practice.

The same change also needed a fixture the existing one could not provide:
`profile.yaml` has **one** summary variant, and with one there is nothing to
choose. `profile-multi.yaml` has five, ordered so a tie is observable, and
`tests/documents/assemble-variants.test.mjs` is the suite over it — one variant
emitted, the others dropped with a mechanical reason, a tie going to profile
order and not to cost, a posting no variant addresses **refused** (exit 3,
nothing written), a hostile posting unable to steer the pick, and a hand-built
proof that a skills group never seeds coverage.

## 1.5 What a boundary case is

A **boundary case** is an input at the edge of what the code is supposed to
handle: empty, zero, one, the maximum, one past the maximum, negative, missing,
duplicated. Bugs cluster at edges because the middle of a range is what the
author was picturing while writing, and the edges are what they were not.

The simplest one in this suite sits directly under the `extractNumbers` test
quoted earlier:

```js
test("extractNumbers on empty text returns empty set", () => {
  assert.equal(extractNumbers("no digits here").size, 0)
})
```

That looks trivial. It is not. Without it, a rewrite that returned `null`
instead of an empty set for text with no numbers would pass every other test in
the file, and then crash — or worse, silently skip a check — at the one moment
`verify-claims` ran over a resume with no numbers in it.

Three more from this repository, each pinning a real bug:

**Empty is not the same as "one thing that happens to be nothing."** From the
Ashby fixture README: a dropdown that has not loaded renders a `No results` box
and declares no options. The scanner stored `["No results"]` as the **complete**
option list, the field cache remembered it, and every future application for
that field then resolved as "the real answer is not on offer". The boundary here
is zero options versus one meaningless option, and
`tests/apply/ashby-combo-probe.test.mjs` is what holds the line.

**One past the end of a prefix.** `tests/apply/answer-bank-prefix-guard.test.mjs`
exists because `matchOption` used to accept any dropdown option that merely
**started with** the resolved answer. "Yes" then matched "Yes, with restrictions",
which is a different answer to a legal question, submitted under your name.

**Zero as a signal, not an error.** `claimAutoJob` and `recordAutoSubmission`
return `0` when another worker already owns the job. That is not a failure — it
is the normal result of running eight workers at once, and it means "do not
click". `tests/auto/submissions.test.mjs` and `tests/auto/concurrency.test.mjs`
pin the distinction, because code that treats that `0` as an error would retry
and double-apply.

The habit to take away: when you write a test for a new function, write the
ordinary case first, then immediately ask "what does this do with nothing, with
one, and with too many?" — and write those three.

## 1.6 Why tests are what let you change code without fear

The honest version of the argument has nothing to do with correctness proofs.
It is about **what you are allowed to forget**.

Without tests, every change you make requires you to personally remember every
other place that could be affected. That works for a week-old project. At 88
scripts and roughly 43,000 lines, it does not work for anyone, and it certainly
does not work when an AI agent is making some of the changes and cannot ask you
what you were thinking in July.

A suite converts remembering into checking. You make a change, you run one
command, and two minutes later a machine has re-verified several thousand
statements about the system that you no longer have to hold in your head. The
courage to delete a function, rename a column, or rewrite a gate comes entirely
from that.

Two real episodes from this repository, both recorded in `package.json`'s
`measured` field:

**The suite doing its job.** On 2026-08-02 two consecutive gate runs on a
quiescent tree both reported exactly 1549 tests. The first was **red** — one
failure, `untrusted-text.mjs` was scanning URLs without decoding them first,
which meant a posting URL of the form `?next=Ignore+all+previous+instructions`
read as clean. The second run, after the fix, was green with the same count.
Nobody found that by reading code. A test found it, named it, and the count
being identical across both runs is what proved the fix did not delete the test
instead of fixing the bug.

**The suite being green over a real hole.** `src/auto/` once shipped with a
literal NUL byte inside a string sentinel (`origin ?? "\0no-origin"`). Prettier
formatted the file and left it alone. `node --check` parsed it. Every unit test
passed, because the **value** was correct. `git diff` showed nothing unusual.
What it broke was search: ripgrep classifies a file containing NUL as binary and
skips its contents, so a codebase-wide grep silently stopped covering that file
— and the same invisible sentinel was written out twice in it, so two literals
that had to match exactly could not be seen by any reviewer. The lesson written
into [`tests/security/source-bytes.test.mjs`](../../tests/security/source-bytes.test.mjs)
is the one to carry: **a green suite is evidence about the properties it
asserts, and about nothing else.** When you find a bug that the suite did not
catch, the fix has two halves, and the second half is a test.

## 1.7 Two things this suite does that most suites do not

**It asserts properties of the source text.** Hard rule 6 says the click surface
is exactly two files. You cannot observe that by running anything — a file that
is never called still contains the click, and the day someone calls it is the
day it matters. So `tests/auto/click-surface.test.mjs` reads every `.mjs` under
`src/auto/`, strips comment lines (so that a future author quoting
`locator.click()` in an explanation does not fail the build and then get the
test loosened to accommodate them), and matches `/\.click\s*\(/` against what is
left. Its own header is careful about when this is legitimate:

> because the property under test IS a property of the source

That caveat is real. The same file records that three earlier source-grep tests
in this repository broke on **wording** while the behaviour was fine, which is
the failure mode of this style. The rule of thumb: grep the source only when the
property is about the source, and pair it with a behavioural test — which
`click-surface.test.mjs` does, by also asserting that `advance.mjs` **refuses** a
submit-role control rather than merely lacking the code to click one.

**A test can be committed deliberately red.** The convention is a test name of
the form `FINDING (<owner>): <what is broken>`. During a phase of work, several
of those are failing at once on purpose, pinning live defects so they cannot be
forgotten. The gate reports them in a separate block from unexpected failures —
but, and the gate's own comment is emphatic about this, **it does not exempt
them**. The verdict is `counts.fail > 0 → fail`, with no escape hatch. A
regression renamed to look like a FINDING would still fail the build; the only
thing the naming can corrupt is which list it prints in.

---

# Part 2 — `npm test` is a gate, not a test run

## 2.1 The problem, demonstrated

Run Node's test runner in a directory containing no tests. Here is the actual
output, captured on this machine:

```
$ node --test
ℹ tests 0
ℹ suites 0
ℹ pass 0
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 13.3121
EXIT CODE = 0
```

Exit code `0` means success. A build pipeline whose only check is "did the test
command succeed?" reports **green** for:

- a suite that was deleted,
- a directory that was renamed,
- a glob pattern that stopped matching,
- a test file that failed to import and got skipped,
- and — the case this project cares about most — a `tests/security/` directory
  that is simply not there.

That last one is not hypothetical. The security suite is the gate on the entire
autonomy phase. If it vanished, the most dangerous outcome is not a red build.
It is a green one.

So `npm test` does not run `node --test`. It runs a program that runs
`node --test` and then interrogates the result:

```json
"scripts": {
  "test": "node tools/ci/test-gate.mjs full",
  "test:security": "node tools/ci/test-gate.mjs security"
}
```

[`tools/ci/test-gate.mjs`](../../tools/ci/test-gate.mjs)
states its purpose in its first paragraph: `node --test` exits 0 when it runs
zero tests, so the exit code alone is worthless as evidence.

(It lives in `.github/workflows/` because GitHub Actions loads only `*.yml` and
`*.yaml` from that directory and ignores everything else, so a `.mjs` file there
is inert to Actions while sitting beside the workflow that calls it. That is an
ownership convenience, not a requirement — the file's own header notes that
moving it to `src/ci/` would be a two-line change.)

## 2.2 What the gate actually asserts

The gate fails the build when **any** of these is true:

| condition                                    | why it is a failure                                                              |
| -------------------------------------------- | -------------------------------------------------------------------------------- |
| a required directory is missing              | an absent security suite must be a failure, not a pass                           |
| a required directory exists but has no tests | an empty suite proves nothing                                                    |
| a configured test path does not exist        | a gate cannot pass over paths that are not there                                 |
| the runner produced no TAP summary           | it crashed or was killed; a run that did not report its counts is not evidence   |
| any test failed                              | including tests named `FINDING (owner)` — reporting is split, the verdict is not |
| any test was cancelled                       | a timeout or crash mid-test                                                      |
| fewer tests ran than the **floor**           | tests were deleted, renamed out of discovery, or the floor is stale              |
| more `todo` tests than **maxTodo**           | converting a failing test to `todo` is the cheapest way to fake green            |
| any test skipped **without a reason**        | indistinguishable from a test that quietly stopped running                       |
| a `--require-ran` test skipped or was absent | see below                                                                        |
| the runner exited non-zero with 0 failures   | treat as a failure, not noise                                                    |

A note on skips, because this is the subtlest rule. Skipping is legitimate: the
PDF-rendering tests shell out to a local Edge or Chrome, and a Linux CI runner
genuinely has neither. The gate's rule is that a skip must **say why**:

```js
test("browser bound", (t) => t.skip("no Edge/Chrome on this machine"))
```

and every attributed skip is printed by name on every run, so coverage loss is
visible rather than silent. A bare `t.skip()` with no reason fails the build.

`--require-ran` is the sharp edge on that. It is passed per-invocation, never as
a gate-wide setting, and only on a CI leg that was **built** to run the named
test. The security-gate leg installs Chromium and then runs:

```
npm run test:security -- \
  --require-ran "color:transparent must not be vouched for" \
  --require-ran "the honest boxes on the same page still behave" \
  --require-ran "nonce CSP is ENFORCED, not merely sent"
```

On that one leg, "no browser available" is an honest skip reason **and** a
broken install, and those two are otherwise indistinguishable in a summary.
Absence fails too — a renamed or deleted test cannot satisfy "did not skip" by
not existing.

## 2.3 The `testGate` block, field by field

The gate's configuration lives in `package.json` under `"testGate"`. There are
two gates. Stripped of the enormous `measured` field (see 2.5), they are:

```json
"testGate": {
  "full": {
    "floor": 2208,
    "maxTodo": 0,
    "requireDirs": ["tests", "tests/security"],
    "paths": ["tests"]
  },
  "security": {
    "floor": 262,
    "maxTodo": 0,
    "requireDirs": ["tests/security"],
    "paths": [
      "tests/security/",
      "tests/lib/untrusted.test.mjs",
      "tests/documents/verify-claims.test.mjs"
    ]
  }
}
```

**`floor`** — the minimum number of tests the run must report. This is the
single most important field, and it is what turns "the tests passed" into "the
tests **ran**". If the run reports fewer, the gate prints:

```
only 2186 tests ran, floor is 2208. Either tests were deleted/renamed out of
discovery, or the floor in package.json "testGate" is stale. node --test exits
0 on an empty run, which is why this is checked.
```

A floor cannot be zero or missing: the gate refuses to start, with `a gate with
no floor cannot prove tests ran`.

**`maxTodo`** — the cap on tests marked `todo`. It is `0` on both gates, and the
reasoning is in the gate's own error message: _converting a failing test to todo
is not a fix._ `todo` is a legitimate marker for a test written before the
feature exists; it is also the cheapest possible way to make a red build green
without changing any behaviour, so the cap is zero and raising it should feel
like a decision.

**`requireDirs`** — directories that must exist **and** contain at least one
`*.test.mjs` file. This is the rule that makes a deleted `tests/security/` a
failure rather than a pass. Note that it is checked before anything runs, so a
missing directory fails fast with a clear message instead of showing up as a
low count later.

**`paths`** — what to hand the runner. An empty list means "use Node's own
default discovery"; a non-empty list is expanded by the gate itself into an
explicit list of files (see 2.4). The full gate passes `["tests"]`, so it runs
everything. The security gate passes three entries, and that list is a
deliberate statement about which tests are the security gate's business:
everything in `tests/security/`, plus the sanitiser tests and the
truthfulness-verifier tests that live elsewhere.

**`measured`** — a long prose string that no code reads. It is the audit trail
for the floor: who raised it, from what to what, on which platform, with how
many runs agreeing, and what was dirty in the tree at the time. It is the most
valuable and the most awkward thing in the file, and 2.5 is about both halves of
that.

## 2.4 Why the gate expands directories itself

`node --test <directory>` is **not portable across Node versions**. Node 20 and
22 recurse into a directory argument. Node 24 — which is what this machine runs
(`v24.13.1`) — treats it as a module path. Here is the real result:

```
$ node --test tests/security
Error: Cannot find module 'C:\...\AgenticJobApplication\tests\security'
    ...
  code: 'MODULE_NOT_FOUND'
✖ tests\security (93.3418ms)
ℹ tests 1
ℹ suites 0
ℹ pass 0
ℹ fail 1
```

Exit code `1`. Look carefully at what that says: **one test, one failure.** Not
"I could not find your tests" — an ordinary-looking red build. The eleven
security test files did not run at all, and nothing in that output says so.

Now imagine the natural reaction: someone sees a red build, notices the
directory argument, deletes it, and gets a green run over zero security tests.
That is the exact chain this gate exists to break, so the gate never passes a
directory to Node. Its `expandPaths()` walks the directory itself and hands Node
an explicit list of files. Same behaviour on every Node version, and the file
list becomes reportable evidence — the gate prints `files  119 test file(s)
after expansion` on every run.

## 2.5 The rule about floors: two honest runs on a quiescent tree

The project's rule, stated inside `package.json` itself, is:

> the floor is a number two honest runs actually produced, not the best one seen

with the corollary, from an earlier entry in the same field:

> a floor above an honest run teaches people to ignore it

Three words in that rule need unpacking.

**"Two runs"** — because a single run is a sample, not a measurement. The
`measured` field records the drift directly: an early measurement saw 1322 three
times, then 1325 three times, on a tree where the only difference was
uncommitted work.

**"Honest"** — the count must come from a normal run of the gate, not from
adding up what you think you added. Several entries in the field record counts
that were observed and then **not banked** because they could not be attributed:
"three intermediate readings this session (1565, 1578, 1600) were each taken
with another agent's files dirty and were correctly reported as non-attributable
rather than banked."

**"Quiescent tree"** — nothing else is editing files or competing for the
machine while you measure. This is the part that sounds like superstition and is
not. From the field, verbatim in substance:

> an earlier wave saw the same tree report 4 → 6 → 0 failures purely from
> contention

Three runs. Identical code. Four failures, then six, then none. In the same
episode, duration inflated from 75 seconds to 150 seconds. The cause is
mundane — several agents editing files and launching Chromium instances on one
laptop while the suite reads those files and launches its own — but the
consequence is not: **a count taken while the tree is being edited is not
evidence of anything**, and a floor set from one is a trap for the next person.

So the procedure for raising a floor honestly is:

1. Stop everything else. No other agent running, no editor saving, nothing else
   heavy on the machine.
2. Commit or stash so you know exactly what tree you are measuring. If you must
   measure with uncommitted work in the tree, **say so** — five separate entries
   in `measured` carry that caveat, and one carries a correction because the
   caveat was not enough.
3. Run `npm test` twice. If the two counts differ, you do not have a number yet.
4. Set the floor to the number both runs produced.
5. Append a paragraph to `measured`: the old number, the new number, the two
   durations, the file count, the pass/fail/skip counts, and — this is the part
   people skip — **attribution**: which new test files account for the delta.

The gate helps with step 4. When a run finishes 25 or more tests above the
floor, it prints:

```
NOTE: 84 tests above the floor. Raise "testGate.full.floor" in package.json to
1967 so deletions below today's count are caught.
```

> **Known defect (2026-08-05 audit).** The working tree carries
> `"floor": 2208`, but `git show HEAD:package.json` reports `2186`, and the
> `measured` field's last entry ends at "RAISED 2181 -> 2186". A 22-test raise
> was made with no measurement entry, breaking the file's own stated rule. There
> is a second, older silent jump: the entries run `1883 -> 1967` and then
> `RAISED 2158 -> 2181`, leaving 191 tests unattributed. The practical risk is
> concrete — four `*.test.mjs` files under `tests/apply/` are currently
> untracked (`ashby-combo-probe`, `ashby-required-class`, `combo-commit`,
> `intents`), so a clean checkout that does not include them would run fewer
> tests than 2208 and fail with `only N tests ran, floor is 2208` for a reason
> that has nothing to do with the code. The fix is one of: commit the tests and
> the floor together with a `measured` entry, or lower the floor to what the
> gate reports and say so.

> **Known defect (2026-08-05 audit).** `testGate.full.measured` is roughly 9,500
> characters — about 84% of `package.json`'s 11.3 KB. The provenance is
> genuinely valuable and must not be deleted, but `package.json` is one of the
> first files anyone reads to orient, it cannot be partially read the way a
> Markdown file can, and `loadGateConfig()` parses the whole thing on every gate
> run. The recommended fix is to move the history to `docs/measurements.md`
> (which already exists for this purpose) and leave a one-line pointer plus the
> current measurement. `tests/hooks/test-gate.test.mjs` asserts `floor`,
> `maxTodo` and `paths` but never `measured`, so nothing breaks.

> **Known defect (2026-08-05 audit).** `testGate.security.paths` does not include
> `tests/auto/trust.test.mjs` or `tests/leads/canonical.test.mjs`. Those two
> modules decide **which host may receive an unattended submit** and how a URL
> is canonicalised before that decision is made. A regression that widened the
> trust gate would pass `npm run test:security` green — and that is the gate CI
> blocks on first. The `measured` field flags this twice and declines to act on
> it unilaterally; it is still open.

> **Known defect (2026-08-05 audit) — CLOSED 2026-08-30.** The matrix was
> `node: [20, 22]` with no `engines` field, while this machine runs Node
> v24.13.1 and the `expandPaths()` workaround in section 2.4 exists **only**
> because Node 24 diverges from 20 and 22 — so the code path that keeps the
> security suite from silently running zero tests was exercised by no CI leg.
> The matrix is now `[22, 24]` and `engines` says `>=22.5.0`. The audit called
> adding 24 "a one-token change"; removing 20 turned out to be the load-bearing
> half. `src/lib/db.mjs` imports `node:sqlite`, which exists from 22.5, so the
> Node 20 legs were testing a runtime this product cannot run on — visible as
> four `import-x/no-unresolved` errors, because that rule asks the RUNNING node
> what its core modules are. Found by CI on the dev-to-main merge.

## 2.6 The gate tests itself

[`tests/hooks/test-gate.test.mjs`](../../tests/hooks/test-gate.test.mjs) is
worth reading once even if you never touch CI, because it is the clearest
statement in the repository of what "a check that can fail" means. Its header:

> The gate's entire job is to make a green run mean something, so the property
> under test is "it can fail".

Every case builds a throwaway directory with a handful of tiny test files,
runs the real gate against it, and asserts the verdict. The names are the
documentation:

- `a run that executed ZERO tests fails the gate`
- `a test file with no tests in it counts as one passing test, so only the floor catches gutting`
- `deleting tests fails the gate even though the runner is green`
- `a failure named FINDING (<owner>) still fails the build`
- `an unowned failure is reported separately and first`
- `a skip WITH a reason passes and is reported by name`
- `a skip WITHOUT a reason fails the gate`
- `a todo test fails the gate at the default cap of zero`

Nothing is mocked. The gate is spawned as a real process against real Node test
runs, because the failure being guarded against lives in the runner's exit code
and not in any wrapper around it.

For the gate's remaining internals — the exact flags, its TAP parsing, the CI
pipeline that invokes it, and the other three `.github/workflows/` programs —
see [`12-harness-and-ci.md`](12-harness-and-ci.md), Part 2.

---

# Part 3 — What is in `tests/`, directory by directory

`tests/` mirrors `src/` one-for-one: `tests/leads/` tests `src/leads/`,
and so on. Three directories break the mirror and each has a reason —
`tests/security/`, `tests/hooks/` and `tests/fixtures/`.

**123 test files** in total, as of this writing.

| directory             | files | what it covers                                                              | notable files                                                                                                             |
| --------------------- | ----- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `tests/lib/`          | 6     | the shared foundation: SQLite access, the lexicon, the sanitiser, locking   | `db.test.mjs`, `untrusted.test.mjs`, `verification.test.mjs`, `lock.test.mjs`                                             |
| `tests/leads/`        | 22    | finding postings, the L1–L3 screening ladder, ranking, board management     | `risk.test.mjs` (L3), `fit.test.mjs` (L2), `gate-audit.test.mjs`, `canonical.test.mjs`, `body-gate.test.mjs`              |
| `tests/documents/`    | 12    | tailoring, truthfulness verification, PDF rendering, reuse clustering       | `verify-claims.test.mjs` (rules R1–R7), `assemble-resume.test.mjs` (goldens), `assemble-purity.test.mjs`                  |
| `tests/apply/`        | 25    | scanning a form, planning the fill, the answer bank, board-specific defects | `fill-plan.test.mjs`, `fill-page.test.mjs`, `scan-page.test.mjs`, `oracle-orc.test.mjs`, `upload-import-control.test.mjs` |
| `tests/auto/`         | 27    | the unattended runner: queue, pool, trust, submit, classify, resume         | `submit.test.mjs`, `click-surface.test.mjs`, `runner-resume.test.mjs`, `concurrency.test.mjs`, `browser-leg.test.mjs`     |
| `tests/security/`     | 11    | the Phase 1 gate — hostile input asserted at the consumer                   | all eleven; see 3.1                                                                                                       |
| `tests/applications/` | 3     | the application record: logging, checking, follow-ups                       | `applications.test.mjs`, `follow-ups.test.mjs`                                                                            |
| `tests/profile/`      | 5     | the only sanctioned way into the fact base, plus gap analysis               | `save-answer.test.mjs`, `profile-validate.test.mjs`                                                                       |
| `tests/maintenance/`  | 3     | migration, pruning and archiving — the operations that lose data if wrong   | `migrate.test.mjs`, `archive.test.mjs`                                                                                    |
| `tests/hooks/`        | 7     | the guardrail hooks **and** the CI machinery (by ownership, not by kind)    | `test-gate.test.mjs`, `repo-hygiene.test.mjs`, `scaffolding-reaper.test.mjs`, `perf-gate.test.mjs`                        |
| `tests/dev/`          | 4     | the benchmark harness and its statistics                                    | `bench-runner.test.mjs`, `flake-rate.test.mjs`                                                                            |
| `tests/fixtures/`     | 0     | not tests — the shared input corpora. Part 4.                               | —                                                                                                                         |

`tests/hooks/` holding CI tests is deliberate and is explained inside
`test-gate.test.mjs`: the directory is owned by whoever owns the pipeline, and
the gate is theirs. The file's own comment says it plainly — _it is not a hook._

## 3.1 The security gate: `tests/security/`

Eleven files, and the only suite in this repository that has its own gate
command. Every one of them treats third-party text — a job description, a form
label, a page served by an employer — as hostile input, which is hard rule 0
turned into assertions.

| file                        | lines | what it proves                                                                                                                                                                                                                                  |
| --------------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fake-board.test.mjs`       | 308   | the local fake ATS server itself is safe: it binds loopback only, and `server.mjs` contains no outbound primitive at all. If this is red, nothing else here means anything, because every other suite reasons about bytes this server produced. |
| `bypass-corpus.test.mjs`    | 400   | 25 ways an instruction can be smuggled into a posting, each asserted **at the consumer** — did the claim reach `jobs/<slug>/keywords.json`, not "did the sanitiser flag it". See 4.4.                                                           |
| `hostile-forms.test.mjs`    | 2006  | a hostile **form**: a poisoned label reaching `answers.yaml`, a mislabelled control reaching the fill plan, a destructive button that the option probe might click.                                                                             |
| `corpus-poisoning.test.mjs` | 262   | a stranger cannot authorise a claim on your resume by choosing a **job title**. `verify-claims` joins company/title/slug as addressing fields, and a resume claiming Kubernetes once failed without `--job` and passed with it.                 |
| `rce-round-trip.test.mjs`   | 592   | the fill engine's code never round-trips through the page. The bootstrap used to read `window.__ajFillSrc` back out and evaluate it Playwright-side, where `page` and `process` live — a board only had to define a getter to own the browser.  |
| `browser-vouch.test.mjs`    | 179   | the one carrier a fake DOM cannot express: **CSS**. An honest label and a `color: transparent` one have identical markup; only `getComputedStyle` can tell them apart. This is the suite's only real-Chromium evidence.                         |
| `honest-board.test.mjs`     | 285   | **the control.** Every other file asserts something hostile is stopped. This one asserts something honest is **not** — a pipeline that deferred every field on every page would pass all the others.                                            |
| `board-fidelity.test.mjs`   | 415   | the fixtures are faithful: each label in a scan JSON is re-derived from the HTML actually served, so the HTML and its scan cannot drift apart.                                                                                                  |
| `scan-fidelity.test.mjs`    | 312   | the stronger version of the same: every scan fixture is deep-compared against what the **real** `scan-page.js` produces for its page — `sel`, `t`, `lSeen`, `labelExact`, field order and all.                                                  |
| `fixture-origins.test.mjs`  | 449   | the concurrency gate's denominator: eight fixture employers on one loopback port are eight **tenants**, not eight **origins**, and the in-flight exclusion key is the registrable origin.                                                       |
| `source-bytes.test.mjs`     | 139   | no raw control byte appears in any text file under `src/`, `tests/` or `docs/`. The NUL-byte incident from 1.6, made mechanical.                                                                                                                |

Two things to notice about how this suite is written.

**Assertions are at the consumer, not at the defence.** `bypass-corpus.test.mjs`
says it directly: `tests/lib/untrusted.test.mjs` calls `sanitizeUntrusted()` in
every one of its tests, and not one of them asserts that any **caller** invokes
it. A sanitiser test proves the function works. A consumer test proves the
function is **called**, on the path that matters, before the text reaches a
model. Both are needed; only the second one is a safety claim.

**The suite includes its own control.** `honest-board.test.mjs` exists because a
suite made only of attacks cannot tell "safe" from "broken". It is deliberately
owned by the same person who writes the attacks, so that the cost of each new
defence shows up in the same place the defence does.

## 3.2 A few individually famous tests

**`tests/auto/submit.test.mjs`** — the eleven preconditions on the one click,
one test each, and **every one of them asserts the click did not happen**. The
names read as a specification: `token_live`, `token_slug`, `token_plan_sha`,
`token_mode`, `page_origin`, `queue_claimed`, `durable_attempt`, `plan_clean`,
`stop_clear`, `board_trusted`, `document_verified`. A twelfth test —
`every one of the eleven is named in the closed list` — makes the list itself
closed, so a precondition cannot be quietly dropped.

**`tests/auto/runner-resume.test.mjs`** — a `SIGKILL` at each queue state must
leave a resumable database and never a duplicate. It spawns
`tests/fixtures/auto/kill-at.mjs` as a **separate process** and hard-kills it,
because that is the only way to get a real kill: the point is that nothing runs
on the way out — no `finally` block, no flush, no tidy-up. As the fixture's own
header says, an in-process simulation of a crash tests the tidying code, which
is exactly the code a crash skips.

**`tests/auto/concurrency.test.mjs`** — 50 jobs at concurrency 8, the falsifiable
check for the runner's parallel path.

**`tests/auto/isolation.test.mjs`** — two concurrent jobs on the same origin
cannot observe each other's cookies or localStorage.

**`tests/auto/browser-leg.test.mjs`** — the one end-to-end test: a real Chromium,
the real runner, a real form served by the fake board.

**`tests/apply/scan-page.test.mjs`** — `scan-page.js` runs **inside** the job
application page, so it cannot be imported. This test reads its real text off
disk and runs it against a hand-built DOM. The repository deliberately has
neither jsdom nor Playwright as a general dependency (a 3 MB dev dependency and
a browser download for one file), and the fake DOM supports exactly the selector
shapes the scanner uses — unsupported ones return nothing rather than
pretending.

**`tests/documents/assemble-purity.test.mjs`** — proves the resume assembler
cannot reach a model. Not by reading the code and being satisfied, but by
installing a **loader hook** (`tests/documents/helpers/cp-spy.mjs`) that
intercepts every import of `node:child_process` and counts every call through
it. Then: `loading the assembler's whole graph resolves child_process zero
times`, `a full assembly spawns nothing and fetches nothing`, and — the test
that makes the other two mean something — `the spawn counter is wired — a real
spawn is counted`. The helper's header records why the obvious approach fails:
patching the module namespace object after import is invisible to
`import { spawnSync }`, and the interception count stayed at zero when they
tried it.

---

# Part 4 — `tests/fixtures/`

79 files, no tests. This is the shared input to everything above, and the
directory is organised by **what kind of thing the input is**, not by which test
uses it.

| corpus                             | contents                                                                              | what it is for                                                      |
| ---------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| the fact-base fixtures             | `profile.yaml`, five `answers*.yaml`, `job.json`                                      | a fake candidate and a fake posting, so tests never read `profile/` |
| the document fixtures              | `good-resume.md`, `good-cover-letter.md`, five `bad-*.md`, `empty.md`, `ats-links.md` | one file per truthfulness rule the verifier must catch              |
| `boards/`                          | a loopback ATS server, 8 form pages, 16 scan JSONs, a DOM harness                     | the whole browser path, testable without an employer                |
| `hostile/`                         | 11 forms, 2 postings, 2 answer banks, `bypasses.mjs`                                  | attacks, kept as data                                               |
| `ashby/`, `greenhouse/`, `oracle/` | 4 HTML pages reproducing real board defects                                           | one reproduction per defect met on a live application               |
| `post-submit/`                     | `corpus.json` (empty), `captures/` (empty), a README                                  | the classifier's evidence, deliberately unpopulated                 |
| `auto/kill-at.mjs`                 | a runner that kills itself at a named state                                           | the crash-resumption test's other half                              |
| `tests/documents/assemble/`        | 8 job JSONs, a profile, an answers file, 9 goldens                                    | the deterministic assembler's golden corpus (lives beside its test) |

## 4.1 The fact-base fixtures

`tests/fixtures/profile.yaml` is the fake candidate — Jane Test of Springfield —
with `meta.approved_by_user: true` so that tests exercise the real path rather
than the "not approved yet" refusal. `tests/fixtures/job.json` is a fake posting
for a WidgetCo Full-Stack Engineer role.

There are five answer-bank fixtures, and the reason there are five rather than
one is instructive: each isolates a **different rule** in the answer bank, and a
single combined file would let a rule pass by accident because another rule
happened to fire first.

| file                          | isolates                                                                                                                    |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `answers.yaml`                | the minimal case — one work-authorisation answer                                                                            |
| `answers-bank.yaml`           | the general bank used by the main answer-bank tests                                                                         |
| `answers-only-auth.yaml`      | authorisation answered, sponsorship **not** — the pair that must not be conflated                                           |
| `answers-exact-pick.yaml`     | every entry deliberately collides with a rule that fires **before** the fuzzy lookup; the collision is the thing under test |
| `answers-polarity-exact.yaml` | a negated phrasing saved under its own exact label must keep resolving; the polarity guard applies to the fuzzy path only   |

Each carries a header comment saying it is fake and that the real bank is
gitignored.

## 4.2 The `bad-*.md` set: one file per truthfulness rule

These five files plus `empty.md` are the smallest, clearest corpus in the
repository. Each is a resume or cover letter containing exactly one kind of lie,
and each pins one numbered rule in `src/documents/verify-claims.mjs`.

| fixture                     | what is wrong with it                                                               | rule it proves                                                                                                    |
| --------------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `bad-missing-annotation.md` | a bullet with no `<!-- fact:ID -->` comment: _"Led a team of engineers…"_           | **R1** — every bullet must cite a fact                                                                            |
| `bad-unknown-fact-id.md`    | cites `fact:exp-nonexistent-b9`, which is not in the profile                        | **R2** — the cited id must exist                                                                                  |
| `bad-invented-number.md`    | the fact says 1,200 users; the bullet says 5,000                                    | **R3** — numbers in a cited bullet must come from that fact                                                       |
| `bad-cover-letter.md`       | _"7 years… 2,000,000 requests per day"_ / _"AWS certification in Aug 2021"_ / Rust  | **R4** numbers, **R5** dates, **R6** technologies — a letter has no per-line citations, so all three fire at once |
| `bad-unknown-tech.md`       | _"Deployed microservices on Kubernetes with Terraform"_ — neither is in the profile | **R6** — every technology named must trace to the fact base                                                       |
| `empty.md`                  | a zero-byte file                                                                    | **R7** — a document with nothing traceable fails rather than vacuously passing                                    |

The matching `good-resume.md` and `good-cover-letter.md` are the controls: they
must pass, because a verifier that rejects everything is as broken as one that
accepts everything. `ats-links.md` is a narrower control for `ats-lint.mjs` —
it checks that bullet characters survive into the PDF text layer and that link
text is not left as a bare URL.

The corresponding assertions read exactly as you would hope:

```js
test("invented number in a cited bullet fails (R3)", () => {
  const { status, report } = verify("resume", "bad-invented-number.md")
  assert.equal(status, 1)
  assert.ok(
    report.violations.some((v) => v.rule === "R3" && v.detail.includes("5000")),
  )
})
```

Two assertions, not one: the exit status **and** the specific rule and detail. A
test that only checked `status === 1` would pass if the verifier failed for
completely the wrong reason.

## 4.3 `tests/fixtures/boards/` — the local fake ATS

This is the reason the browser path is testable at all, and the reason the suite
never touches a live employer's board.

`server.mjs` is a small Node HTTP server serving static replicas of Greenhouse,
Lever and Ashby application forms — plus hostile variants, an Oracle
import-parse page, and eight post-submit pages. Its README is blunt about what
it is:

> **Nothing in this tree is a tool.** The hostile pages are real attack strings.

What makes them safe to keep in a repository is `assertLoopback()`, which throws
on `0.0.0.0`, on a LAN address, and on a hostname — plus
`tests/security/fake-board.test.mjs`, which asserts the **absence** of every
outbound primitive in `server.mjs`. There is no proxy, no upstream fetch, no
redirect off-host.

Four details worth knowing:

- **`listen(0)`** — an ephemeral port, read off the listener, never hardcoded. CI
  runs legs in parallel, and a fixed port is a flake waiting for a second job.
- **`--origins 8`** produces eight distinct loopback origins, which is what
  `fixture-origins.test.mjs` needs to prove a 50-application run really spans
  eight origins rather than eight tenants on one.
- **The latency contract.** By default the server adds no delay, because loopback
  costs what loopback costs. `--latency` turns on a declared model instead
  (`nav_ms: 300`, `xhr_ms: 150`). The README's warning is a measurement rule
  worth internalising: a latency-modelled number and a loopback number are
  **different populations** — never average, sum, or merge them, and never
  compare a baseline from one mode against a run in the other.
- **`ASHBY_REMOUNT_MS = 700`** — the fixture reproduces Ashby's habit of
  remounting its form mid-fill, which is why non-upload fills retry on a stale
  locator.

`pages/` holds the eight served forms. `scans/` holds sixteen `*.scan.json`
files — the scanner's output for those pages, committed so that tests which do
not have a browser can still feed real product code a real scan.
`board-fidelity.test.mjs` and `scan-fidelity.test.mjs` (3.1) are what stop those
JSONs from quietly drifting away from the HTML they claim to describe, and
`dom.mjs` is the harness that makes the stronger of those two possible: a DOM
small enough to be hand-written, faithful about exactly the inputs the label
waterfall uses, hosting the **real** `scan-page.js`.

> **Known defect (2026-08-05 audit).** The performance gate pins its measured
> run to `--board greenhouse,honest-greenhouse`, excluding the Ashby fixture —
> the one carrying the 700 ms remount, which the fixture README calls the
> longest wait on the worst board. A regression in the remount retry path
> therefore cannot move the gated numbers.

## 4.4 `tests/fixtures/hostile/`

**`bypasses.mjs`** exports 25 entries, each a way to smuggle an instruction past
`src/lib/untrusted.mjs`. Every entry carries the same fields — `id`,
`carrier`, `payload`, `plain`, `html`, `claim`, `consumer` — and every one aims
at the same outcome on purpose: get the word **Kubernetes** onto a document
signed with your name. Uniform target, so the assertion is falsifiable ("did the
claim enter the corpus?") rather than mushy ("did the sanitiser notice?").

The carriers, grouped:

- **Invisible codepoints** (B01–B07): the Unicode Tags block, variation
  selectors and their astral-plane supplement, Hangul fillers, the Braille blank,
  supplementary-plane private-use characters. All render as nothing or as
  whitespace, and several defeat a regex character class that was written for
  the BMP only.
- **Homoglyphs and rewrites** (B08–B11): fullwidth Latin, mathematical bold,
  Cyrillic lookalikes, leetspeak.
- **Language and encoding** (B12–B15): the same instruction in Spanish and in
  Chinese, and base64 in two variants.
- **Structure** (B16–B17): a Markdown fence faking a conversational turn; a
  second occurrence after a benign first one.
- **HTML at ingest** (B18–B24): a class-hidden span, an off-screen inline style,
  near-white text, `alt` and `title` attributes, an unclosed hidden element,
  numeric character references. These target `textSnippet` — they matter because
  it **flattens them into visible prose** before the sanitiser ever runs, so
  detection has to happen at ingest.
- **Reflection** (B25): the finding report itself. The sanitiser records a
  sample of what it found, and that sample is text the attacker wrote.

The corpus also exports `PLAIN_INSTRUCTION` and `PLAIN_CONTROL`, and the suite
asserts the **plain ASCII version is still caught**. That is the corpus's own
calibration: several entries are only interesting because the plain version is
caught, so if `plain` stops being caught, the corpus is measuring nothing.

Read alongside this: CLAUDE.md's rule 0 says outright that non-English and
reworded instructions walk through the pattern list **by design**, and that the
suite asserts that they do, so nobody mistakes silence for coverage. The
load-bearing control is rule 1 plus `verify-claims` R6 — a claim the fact base
cannot back never survives verification, however it was proposed.

**`postings/`** holds two whole-payload fixtures. `hidden-carriers.json` is a
board list-endpoint response whose description is HTML, exactly as Greenhouse,
Ashby and Lever return it, carrying three carriers that `textSnippet` flattens
into prose. `title-poisoning.json` is the subtler one: no hidden text, no
injection phrasing — just a normal-looking **job title** that used to smuggle a
technology into the evidence corpus.

**`forms/`** holds eleven hostile HTML forms, each paired with a scan JSON in
`boards/scans/`: `label-injection`, `mislabelled-inputs`,
`mislabelled-escalated`, `escalated-tickbox-yes`, `escalated-radio-yesno`,
`escalated-aria-checkbox`, `consent-decoupled`, `destructive-combobox`,
`button-pair-destructive`, `fillsrc-getter`, `remount-mid-fill`.

**`answers-label-poisoned.yaml`** and **`answers-unseen-wordings.yaml`** are fake
answer banks. The first is the attack where an employer writes a compound
question, you answer "Yes" once, and that question becomes permanent evidence
for a technology on every future resume. The second exists to defeat
**word-reading defences**: every entry is the same attack on the same page,
differing only in wording, and the property asserted is that the check-verb defer
in `fill-plan.mjs` reads **no words at all** — it refuses on the widget's shape,
whatever the bank answer says. As its header puts it: every previous defence
read one string the attacker chose, so every previous defence had a 26th
rewording.

## 4.5 The board-defect reproductions

Three directories, four HTML pages, all hand-written from real applications the
owner drove by hand — **not** copies of employers' pages. What is reproduced is
the **shape**.

**`ashby/ashby-toggle-combo.html`** (2026-08-04) reproduces three shapes from a
live Ashby form: a required marker carried only as a CSS-module class
(`_required_f7cvd_91`) with the asterisk coming from CSS `::after`, so no
`required` attribute and no `aria-required` exist; a dropdown whose menu opens
from a chevron `<button>` beside the box rather than from the combobox itself;
and an async typeahead that renders `No results` and declares no
`[role=option]`. The README's cost table is worth reading, because it separates
**loud** failures from **silent** ones — the first shape made a required field
read as optional and the submit proceed with it empty. The page also carries a
`Withdraw application` button as the deliberate **bound**: it is a `<button>` in
the same container as a combobox, so if the chevron search is ever loosened,
this test fails before anything reaches a real board.

**`greenhouse/combo-commit.html`** reproduces a dropdown that reports as filled
while being empty, measured on a real Greenhouse form on 2026-08-04.

**`greenhouse/portal-menu-combo.html`** reproduces react-select as Greenhouse
renders it, measured on a live Coinbase application on 2026-08-07 where 13 of 19
required combos failed to probe. Two defects: the `aria-controls` /
`aria-expanded` the probe reads live on the **inner** `input.select__input`, not
on the `.select__control` shell the scanner stamps, so both reads returned
`null`; and `.select__menu` renders in a **portal** outside the control, so
container-scoped lookups miss it.

Three things in that fixture are load-bearing, and the first version of it
passed against the broken code without them: the menu is **mounted on open and
unmounted on close** (a merely-hidden menu is already attached, so the fallback
wait returns instantly and the read happens before the menu exists); it renders
**asynchronously**, inside the probe's 300 ms ceiling (a menu that appears
synchronously is readable by any means at all); and a **phone country-code list
is always present and visible**, which is what turns a too-early or unscoped read
into a _wrong_ list rather than an empty one. The third field is the bound: it
names its own menu while a decoy sits visible in the portal, so the named menu
must win. Pinned by `tests/apply/greenhouse-portal-combo.test.mjs`.

**`oracle/orc-email-gate.html`** and **`oracle/orc-questionnaire.html`**
reproduce four Oracle Recruiting Cloud defects: a required consent checkbox at
`opacity: 0` that was reported nowhere; a question label that started
mid-sentence because of a parenthetical `(e.g. H-1B status, etc)` and thereby
**inverted the question's meaning**; combobox options that could neither be read
nor set; and answer rows reported as N loose phantom fields. The questionnaire
page carries a `<script>` implementing the combobox's real behaviour, because
one half of that defect is a behaviour and not a shape.

Both READMEs explain why these are **not** in `tests/fixtures/boards/pages/`:
that directory is the **honest board corpus**, over which `fill-page.test.mjs`
runs the real scanner and asserts the aria sweep contributes not one field, as a
broad false-positive check. Putting a deliberate defect reproduction in there
would make it look like a scanner regression.

## 4.6 `tests/fixtures/post-submit/` — the corpus that is empty on purpose

`corpus.json` contains exactly `{"samples": []}`. `captures/` contains nothing.
This is the most important fixture directory in the repository, and its README
opens by saying so:

> **This directory is currently empty of real samples, and that is the accurate
> state of the evidence rather than a TODO nobody got to.**

The post-click classifier reads a page after a submit and decides whether it is
a confirmation, an error, a bot challenge, or something else. `classify.mjs` may
only carry a rule that **cites a sample in this corpus**, and such a rule fires
only on the hosts its sample came from. With no samples, every real board
classifies as `unclassified` — which is the one remaining hard STOP.

Do not confuse this empty corpus with
`tests/fixtures/boards/pages/post-submit/`, which is **not** empty: it holds
eight hand-written pages — `confirmation.html`, `not-a-confirmation.html`,
`error.html`, `posting-gone.html`, `bot-challenge.html`,
`email-code-challenge.html`, `identity-verification.html`, `submit-form.html` —
served by the fake board so `tests/auto/classify.test.mjs` can exercise the
classifier at all. Those are fixtures, so the rules they justify may fire **on
loopback only**. That is why a real ATS reading `unclassified` is the system
working rather than a gap to route around, and why nobody should "fix" it.

The asymmetry is what makes an empty corpus the right answer rather than a gap:

- A **confirmation misread as something else** costs one human look at one URL,
  and cannot cause a duplicate: the `(slug, mode)` row in `auto_submissions` is
  written **before** the click, and its `ON CONFLICT DO NOTHING` refuses the
  second claim.
- A **page misread as a confirmation** records an application that was never
  sent. The caps count it, the digest reports it as sent, the user never applies
  to that posting again, and **nothing later corrects it**.

Writing a plausible regex from an idea of what Greenhouse says after a submit is
rule 0's forbidden guess with the model removed and this repository's
imagination left in. The only lawful way to fill this corpus is the user's own
attended applies, through `src/apply/capture-post-submit.mjs`: **stage**
(redacts against `profile/` and generic identifier patterns, and refuses to
write anything if an identifier survived) → **review** (a human reads the
redacted text) → **promote** `--kind confirmation --user-approved`. Promoting a
sample does not create a rule; a human still reads it and writes one, citing it.

---

# Part 5 — Coverage gaps, derived mechanically

## 5.1 The method

Rather than trust any document, list both trees and compare them:

```bash
find scripts -name '*.mjs' | sort      # 88 files
find tests  -name '*.test.mjs' | sort  # 123 files
```

Then, for each script, ask two questions:

1. Is there a test file with the matching name — `src/leads/risk.mjs` →
   `tests/leads/risk.test.mjs`?
2. Failing that, does **any** file under `tests/` reference it — by import path
   (`../../src/leads/risk.mjs`), by spawn path
   (`path.join(ROOT, "scripts", "leads", "risk.mjs")`), or by name?

Question 1 alone is misleading in both directions. Several scripts have no
same-named test and are thoroughly covered: `src/apply/fill-engine.mjs` is
referenced by eleven test files and `src/apply/browser.mjs` by nine — they
are libraries, and their behaviour is asserted wherever it matters rather than
in one place. Conversely, a same-named test file that only checks the CLI's
usage message is not coverage.

(The counts below come from matching two reference shapes in each test file: the
import path `apply/fill-engine.mjs`, and the spawn form
`"apply", "fill-engine.mjs"` that `path.join` produces. Matching only one of
those undercounts.)

## 5.2 The result

**Three scripts have no test coverage of any kind.** No same-named test file, no
importer under `tests/`, no spawn.

| script                    | size / role                                                                                    | status                                                                                                                                                                                                                                                   |
| ------------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/apply/longform.mjs`  | 199 lines exporting `parseLengthDemand`, `longFormPrompt`, `describeNeed`, `draftShortfall`    | **dead.** A repo-wide search finds no importer anywhere in `src/`, `.claude/` or `tests/` — only mentions in documentation. It has a 35-line header arguing carefully why it is lawful under rule 1, and it is wired to nothing and asserted by nothing. |
| `src/auto/cycle.mjs`      | ~420 lines; the only end-to-end unattended entry point (find → screen → prep → tailor → apply) | **live but unasserted.** Invoked by `src/auto/cycle.cmd` for a scheduler. Its header states two testable contracts — "a stage that fails for one lead does not change the exit code" and "IDEMPOTENT ON PURPOSE" — and nothing proves either.            |
| `src/apply/ats/lever.mjs` | one adapter in the ATS registry                                                                | reached only through the registry — read the qualification below before calling this a gap.                                                                                                                                                              |

The third row needs an honest qualification, and it is the reason a raw
"no test file" list is never the whole answer. `ashby.mjs` and `lever.mjs` are
imported by `src/apply/ats/index.mjs`, and six test files import that
registry. `tests/apply/fill-plan.test.mjs` asserts both by URL:

```js
assert.equal(detectAts("https://jobs.lever.co/allegiantair/abc").id, "lever")
assert.equal(detectAts("https://jobs.ashbyhq.com/vanta/abc").id, "ashby")
```

So both modules load, and their URL matching is asserted. What has no dedicated
test file is each adapter's own `fileFields` and `knownFields` detail — and that
detail is exactly what produced the profile-import upload defect that
`tests/apply/upload-import-control.test.mjs` was written for, where a
`resume|cv` pattern matched an Oracle "Import your profile from resume" control
as well as the real upload slot. Ashby now has two dedicated files
(`ashby-combo-probe`, `ashby-required-class`) because a live application forced
the issue; Lever has none, and Lever's adapter detail is therefore asserted only
where a fixture happens to touch it.

> **Known defect (2026-08-05 audit), `src/apply/longform.mjs`.** A module
> that exists but never runs is the shape that later gets mistaken for a live
> control. A reader assumes prose prompts are handled, and they are not. The
> audit's recommendation is to wire it into `fill-plan.mjs`'s defer path — which
> currently hardcodes `why: "needs a document or long-form text"` — **with
> tests**, or to delete it.

> **Known defect (2026-08-05 audit), `src/auto/cycle.mjs`.** The one
> scheduled entry point has no test file. A concrete failing input exists today:
> a lead whose `keyword-plan` stage exits non-zero should leave the other leads
> processed and the cycle exit 0, and nothing proves it does.

**Twenty-one further scripts have no same-named test file but are referenced by
at least one test.** Most are fine. The ones worth naming, with the count of
test files that touch them:

| script                      | referenced by | how                                                                               |
| --------------------------- | ------------- | --------------------------------------------------------------------------------- |
| `src/apply/fill-engine.mjs` | 11            | imported by the fill and scan tests, and by the security suite                    |
| `src/apply/browser.mjs`     | 9             | imported wherever a real or fake page is driven                                   |
| `src/apply/ats/index.mjs`   | 8             | `detectAts` / `ADAPTERS` — six of those are direct imports                        |
| `src/apply/scan-engine.mjs` | 7             | imported by the scan and fidelity tests                                           |
| `src/leads/screen.mjs`      | 3             | `efficiency-tools` and `screen-blockers` import it; `screen-cache` spawns the CLI |
| `src/leads/recommend.mjs`   | 3             | `efficiency-tools`, `keyword-wiring`, `title-rank`                                |
| `src/leads/stages.mjs`      | 3             | `automatability`, `gate-audit`, `screen-stages`                                   |
| `src/status.mjs`            | 3             | `digest`, `bench-runner`, `efficiency-tools`                                      |
| `src/auto/caps.mjs`         | 1             | via `audit.test.mjs`                                                              |
| `src/auto/notify.mjs`       | 1             | via `inbox.test.mjs`                                                              |
| `src/auto/stages.mjs`       | 1             | via `browser-leg.test.mjs`                                                        |
| `src/hooks/guard-files.mjs` | 1             | via `guard-hooks.test.mjs`                                                        |
| `src/hooks/prettify.mjs`    | 1             | via `guard-hooks.test.mjs`                                                        |

The pattern in the last five: one test file covering several small modules. That
is a reasonable choice for a hook or a helper. It becomes a problem when the
module grows, and the honest signal is the count — a 1 in that column next to a
module that is doing real work is worth a second look. `src/leads/screen.mjs`
is the row to watch: it is the screening CLI, and three of the four files whose
names contain "screen" reference it only in comments, testing the separate
`fit.mjs` and `risk.mjs` modules instead.

**And one gap that is not about scripts at all:** `loadPhases` in
`tools/ci/scaffolding-reaper.mjs` has no test. Its self-test uses a
hardcoded phase list, which is why nobody noticed that `package.json` declares
`"current": "phase-5"` while `"order"` stops at `phase-4` — making
`order.indexOf(current)` return `-1` forever and silently disabling every
expiry the reaper is supposed to enforce. Details in
[`12-harness-and-ci.md`](12-harness-and-ci.md).

## 5.3 The honest reading of these numbers

123 test files against 88 scripts is a high ratio, and the directories where
mistakes are expensive — `tests/auto/` (27 files), `tests/apply/` (23),
`tests/leads/` (22) — carry the most. The gaps are not randomly distributed:
they are a dead module, a scheduled entry point that was written last and tested
never, and one board adapter that has not yet failed in production. That is a
recognisable and fairly ordinary shape. It is not a crisis, and it is also not
something to leave unwritten.

---

# Part 6 — How to run the tests

## 6.1 The full gate

```
npm test
```

This is `node tools/ci/test-gate.mjs full`. It takes roughly two
minutes on this machine (the most recent measurements in `package.json` record
119.6 s, 120.4 s and 146.1 s — the spread is contention, per 2.5). It prints a
per-test spec report as it goes, then a summary block. The shape is fixed by the
gate's reporting code; the numbers below are the ones `package.json` records for
the last fully attributable run, on 2026-08-04:

```
test-gate: full — PASS
  platform    win32 / node v24.13.1
  paths       tests
  files       119 test file(s) after expansion
  tests       2186   (floor 2186)
  pass        2183
  fail        0
  skipped     3
  todo        0   (cap 0)
  duration    119.6s
  not executed on this leg (3):
    [SKIP] <test name> — no usable Chromium: <reason>
```

The file count will read higher than 119 on the current tree, which now holds
123 test files — four of them untracked. That difference is the subject of the
first Known defect in 2.5.

Exit code 0 with counts printed, or 1 with a reason printed. There is no
`|| true` path anywhere in it.

## 6.2 The security gate

```
npm run test:security
```

Roughly six to seven seconds. Runs the eleven files in `tests/security/` plus
`tests/lib/untrusted.test.mjs` and `tests/documents/verify-claims.test.mjs`, and
fails if `tests/security/` is missing or empty. This is the gate CI blocks on
first, and it is the one to run after touching anything on the untrusted-input
path.

## 6.3 One file, while you are iterating

```
node --test tests/apply/fill-plan.test.mjs
```

This is what you should use while writing code — the gate is for **before you
commit**, not for every save. The project's token-discipline rule is explicit
about this: test when there is finished code that needs testing, never
mid-implementation, never after a comment tweak, and never on unchanged code
that just passed.

You can narrow further by test name:

```
node --test --test-name-pattern="polarity" tests/apply/answer-bank-polarity.test.mjs
```

## 6.4 The one command shape that looks like a failure and is not

**Never pass a bare directory to `node --test`.** On Node 24 — which is what
this machine runs — it does not recurse. It treats the directory as a module
path, fails to load it, and reports that as **one failing test**:

```
$ node --test tests/security
Error: Cannot find module 'C:\...\tests\security'
  code: 'MODULE_NOT_FOUND'
✖ tests\security (93.3418ms)
ℹ tests 1
ℹ pass 0
ℹ fail 1
```

Exit code 1. Nothing in that output says "your eleven test files did not run".
If you meet this, you have not found a bug in the tests — you have found this
gotcha.

Use a **quoted glob** instead:

```
node --test "tests/apply/**/*.test.mjs"
```

The quotes matter: they stop your shell from expanding the pattern (which
shells do inconsistently, and which PowerShell does not do at all), so Node
receives the pattern and expands it itself, correctly and recursively.

And this is precisely why the gate expands directories in its own code rather
than delegating to Node — same behaviour on every version, and the expanded file
count printed as evidence.

## 6.5 One command not to use

```
npm run test:raw     # node --test, no assertions about the run
```

This is a bare runner over Node's default discovery: no floor, no failure
assertion, no skip attribution. It is one keystroke away from `npm test` and it
is exactly the command the gate's header says is not evidence.

> **Known defect (2026-08-05 audit).** `test:raw` is referenced by nothing in the
> repository except one documentation table. The audit's recommendation is to
> delete it or rename it to something that cannot be typed by accident.

## 6.6 Two failures that are the environment, not your change

Both are recorded in `package.json`'s `measured` field, and both will otherwise
cost you an hour.

**In a git worktree**, two tests fail because a worktree has no `node_modules`
under its root: the prettify-in-place case and the run-script-points-at-a-file
case. They fail identically with and without any change, and pass from the main
repository. Re-verify there before reading them as anything else.

**`tests/auto/browser-leg.test.mjs`** can fail with `EOUTSIDEJOBS` on the
**first** run in a fresh worktree, because such a tree has no `jobs/` directory
and `assertInsideJobs` then resolves the nearest existing ancestor — the
worktree root — which is outside the `jobs/` base it compares against. It passes
on every later run, once some earlier test has created `jobs/`. This was first
recorded as a contention flake and later corrected to what it is: a test-ordering
dependency on an untracked directory.

---

**Where to go next**

- [`12-harness-and-ci.md`](12-harness-and-ci.md) — the gate's internals, its
  flags and worked output, the CI pipeline that invokes it, the scaffolding
  reaper and the performance gate. The natural companion to Part 2 here.
- [`../guide/07-safety-model.md`](../guide/07-safety-model.md) — the ten hard
  rules that most of `tests/security/` and `tests/auto/` exist to assert.
- [`05-documents.md`](05-documents.md) — `verify-claims.mjs` and its rules
  R1–R8, which the `bad-*.md` corpus in Part 4.2 pins one file at a time.
- [`10-auto-safety.md`](10-auto-safety.md) — the trust gate, the submit gate and
  the classifier, which are what `tests/auto/submit.test.mjs` and
  `tests/fixtures/post-submit/` are about.
- [`00-file-index.md`](00-file-index.md) — every file in the repository with a
  one-line description, if you are trying to find where something lives.
- [`../operate/03-troubleshooting.md`](../operate/03-troubleshooting.md) — what
  to do when a run goes wrong in ordinary use rather than in the suite.
- the 2026-08-05 audit report (**not in the tree** — deleted 2026-08-06; recoverable from git history at `3d4a18e`) — the full audit these
  "Known defect" boxes are drawn from, with 247 findings and their evidence.
