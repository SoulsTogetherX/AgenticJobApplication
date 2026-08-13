# When something goes wrong

This is the document you open when the pipeline did something you did not
expect. It is organised **symptom first**, because that is the only thing you
have when a problem starts: a command that printed the wrong thing, a document
that would not render, a job that never appeared. Each entry names the symptom
in the words you would use, explains the **cause** — what the machine was
actually doing and why it decided that was correct — and then gives the **fix**,
with the exact command to run and the exact output that tells you it worked.

Almost every entry below is a real incident. This system has been debugged for
several weeks, and the failures that took the longest to understand were the
ones where the machine was working correctly and looked broken, or was broken
and looked fine. Those two categories are the whole reason this document is
symptom-first rather than component-first: you do not know which component to
open, because if you did you would not be reading this.

**One habit that will save you more time than anything else in this file:**
before you change any code, work out whether the machine is reporting a problem
or having one. A large fraction of what looks like a bug here is a deliberate
refusal — a gate saying "I do not understand this and will not guess." Those
refusals are the product. Fixing them by loosening the gate is how you turn a
system that tells you the truth into one that quietly does not.

**What you will learn**

- Why a test run can say **`Cannot find module`** when nothing is missing, and
  why `npm test` asserts a **count** rather than trusting an exit code — the two
  failures that let a green build mean nothing.
- How to read a **`verify-claims` failure**, rule by rule (R1 through R8), with a
  real violation printed for each one and the edit that fixes it.
- What to do when a **claim you know is true** is rejected, and the one
  sanctioned way to add it to the fact base.
- How to read a **deferred form field** — where the reason is printed, what each
  reason means, and the **three** ways you are permitted to make a field stop
  deferring (there is a fourth that looks obvious and is forbidden; the entry
  explains why).
- Why an **upload can report success** while the application goes out with no
  resume, and which field of the fill report is the actual evidence.
- How to walk the **whole lead funnel** when a job you wanted never appeared,
  with the command that shows each stage's verdict.
- Why **every real job board classifies as `unclassified`** after a submit, why
  that is correct, and the only lawful way to change it.
- What a **stuck lock file** means, what an **orphaned submit attempt** is, and
  how a crashed run brakes one employer instead of everything.
- Where the **audit trail** lives, which scripts speak `--json`, and how to read
  a run log line by line.

---

## How to read this document

### The shape of every entry

Each entry has three parts and they are always in this order.

**Symptom** — what you saw. Written the way you would describe it, not the way a
programmer would classify it.

**Cause** — what was actually happening. This section is longer than you might
expect, on purpose. A fix you do not understand is a fix you cannot repeat, and
several of the fixes here look wrong until you know the incident behind them.

**Fix** — the commands, in order, with the output that means it worked.

### Conventions used throughout

- **Commands are run from the repository root** — the folder that contains
  `package.json`, `scripts/` and `docs/`. If a command reports "no such file",
  check where you are first (`pwd` in Git Bash, `Get-Location` in PowerShell).
- An **exit code** is a number a program hands back to whatever ran it when it
  finishes. `0` means success; anything else identifies a specific kind of
  failure. You do not normally see it, but you can print it: in Git Bash,
  `echo $?` right after the command; in PowerShell, `$LASTEXITCODE`. Several
  scripts here use exit codes as their primary answer, and those entries list
  what each number means.
- **Scripts print two different formats.** When output goes to a terminal a
  person is looking at, they print sentences. When output goes to a pipe, a file,
  or an AI agent — technically, when standard output is not a "TTY", which is the
  operating system's name for an interactive terminal — they print short
  machine-readable records separated by `|` or tab characters. Both forms carry
  the same facts. Where the compact form is what you will actually see (because
  you copied the output into a chat window), the entry shows that one.
- **`--json`** is supported by many scripts and prints a complete structured
  record instead of either format. The last section of this document lists which
  scripts have it.
- Where something is **broken or not connected to anything**, it is marked with a
  quoted callout beginning **Known defect (2026-08-05 audit)**. Those come from a
  full read of every source file in the repository on that date. They are stated
  rather than hidden because a gap you know about costs one sentence and a gap
  found later costs a whole investigation.

### The two questions to ask first

Before opening any entry below, answer these two. They route you faster than any
index.

**1. Did a program crash, or did it refuse?** A crash prints a stack trace — a
list of file names and function names, the machine's account of where it was when
it gave up. A refusal prints a sentence explaining a decision. This system
refuses constantly and deliberately. Refusals live in Parts 2 through 6; crashes
usually live in Part 1.

**2. Is the thing you are looking at derived, or is it the record?** Several
files here are **generated** — rebuilt from something else, so editing them
changes nothing. `profile/applications.yaml` is generated from the `applications`
table in `jobs/leads.db`. `jobs/<slug>/fill-plan.js` is generated from
`fill-plan.json` plus the fill engine's source. `jobs/.gate-baseline.json` is
generated by `gate-audit.mjs`. If you are about to edit one of those, you are
about to fix the shadow instead of the object. [06-data-model.md](../guide/06-data-model.md)
has the full ownership table.

---

## Part 1 — The test suite and the build

The four entries in this part share one theme: **a tool reporting success is not
evidence that the thing you care about happened.** Each of these was a real
incident where every gate was green and something important was not running.

### Symptom: a test run says `Cannot find module` and nothing is missing

You ran a test command against a directory and got something like this:

```
$ node --test tests/security/
Error: Cannot find module 'C:\Users\...\AgenticJobApplication\tests\security'
tests 1
fail 1
```

The directory exists. The test files inside it exist. The error names the
directory itself as a missing "module".

#### Cause

`node --test` is Node.js's built-in test runner. On **Node 20 and Node 22**,
handing it a directory made it walk into that directory and run every test file
it found. On **Node 24**, which is what this project runs on, that behaviour was
removed: a directory argument is now treated as a **module** — a single file of
code to load — and a directory is not a file, so loading it fails.

The two consequences are worth separating, because only one of them is obvious.

The obvious one is the error message. `Cannot find module` reads like a broken
import inside your code, so the natural reaction is to go looking for a typo in
an `import` statement. There is no typo. The argument on the command line is the
problem.

The dangerous one is what happens if you "fix" it by removing the argument. Node
then falls back to its own default discovery, finds whatever it finds, and very
possibly exits `0` having run tests you did not mean to run — or, in the
project's own history, having run **zero** security tests while reporting
success. The project's Phase 1 security gate was written with a bare directory
argument for exactly this reason and therefore ran nothing at all.

The third consequence is that the same command **means different things on
different versions of Node**. A command that recurses on Node 22 and fails on
Node 24 is not a command; it is a coin flip.

#### Fix

Use a **quoted glob**. A glob is a pattern with wildcards: `*` matches any run of
characters inside one path segment, and `**` matches any number of nested
directories.

```bash
node --test "tests/security/**/*.test.mjs"
```

The quotes matter and are not decoration. Without them, your shell tries to
expand the pattern itself before Node ever sees it, and shells disagree with each
other about `**`. With the quotes, the pattern is handed to Node intact and
Node's own matcher expands it — the same way on every platform and every shell.

For one file while you are iterating, name the file:

```bash
node --test tests/apply/fill-plan.test.mjs
```

**What you should see.** A run that found files prints a TAP summary at the end
(TAP is a plain-text format test runners emit; you only need to read the
numbers):

```
# tests 262
# suites 0
# pass 262
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

If `tests` is `0` or absurdly small, the pattern matched nothing and you have the
green-over-nothing failure rather than a passing suite.

**Note that `npm test` is unaffected by this.** It does not call `node --test`
with a directory; it runs `.github/workflows/test-gate.mjs`, which expands the
configured directories into a file list itself. This bites hand-written
`node --test` invocations only. See the next entry for what the gate does with
that list.

---

### Symptom: `npm test` reports success and you are not sure anything ran

The command finished, printed a summary, exited `0`. You have no idea whether it
proved anything.

#### Cause — and this is the reason the gate exists at all

`node --test` **exits `0` when it runs zero tests.** That is not a bug in Node;
"no failures" is a defensible reading of "nothing failed". But it makes the exit
code worthless as evidence on its own. A build whose only assertion is "the test
runner did not error" reports success for:

- a test suite that was accidentally deleted;
- a directory that was renamed and no longer matches the pattern;
- a glob that silently stopped matching after a refactor;
- a failing test converted to `todo` (a marker meaning "known to fail, do not
  count it") — the cheapest possible way to fake a green build.

So `npm test` does not run `node --test` directly. It runs
`.github/workflows/test-gate.mjs`, and that program asserts what a green run must
**prove**. Its configuration lives in `package.json` under the `testGate` key:

```json
"testGate": {
  "full": {
    "floor": 2314,
    "maxTodo": 0,
    "requireDirs": ["tests", "tests/security"],
    "paths": ["tests"]
  },
  "security": {
    "floor": 262,
    "maxTodo": 0,
    "requireDirs": ["tests/security"],
    "paths": ["tests/security/", "tests/lib/untrusted.test.mjs",
              "tests/documents/verify-claims.test.mjs"]
  }
}
```

Read that as a set of promises. The gate **fails the build** when:

- a directory in `requireDirs` is missing, or contains no test files. This is
  what makes an absent `tests/security/` a **failure** rather than a pass;
- the runner produced no TAP summary at all, which means it crashed or was
  killed;
- any test failed or was cancelled;
- **fewer tests ran than `floor`.** This is the count assertion. The floor is a
  number two honest runs actually produced, not the best number ever seen;
- more tests are `todo` than `maxTodo`, which is `0` — you cannot park a failure;
- any test **skipped without a reason**. A skip is legitimate (a machine with no
  Edge or Chrome installed cannot run the PDF tests) but it must be explicit and
  attributed. An unattributed skip is indistinguishable from a test that quietly
  stopped running.

There is no `|| true` anywhere in it — no path that swallows a failure. Every
exit is either `0` with the counts printed, or `1` with the reason printed.

#### Fix

Run the real gate and read the count:

```bash
npm test
```

**What you should see.** A summary naming the file count, the test count, and the
skips with their reasons. The state of the tree when the 2026-08-05 audit was
written was:

```
123 files, 2263 tests, 2260 pass, 0 fail, 3 documented skips, 194s
```

The floor is currently `2314`, raised after the audit remediation landed.

**If the gate fails on the floor**, read the message before touching the number.
Two very different things produce it:

1. **Tests genuinely stopped running.** A file was deleted or renamed, or a
   pattern stopped matching. This is the failure the floor exists to catch. Find
   the missing file; do not lower the floor.
2. **You deliberately removed tests.** Then lowering the floor is correct — but
   lower it to exactly what the gate reports, and say so. The `measured` field in
   `package.json` is a long append-only note recording every floor change, the
   two runs that agreed on the number, and whether the tree was quiet when it was
   measured. That note exists because a count taken while other work is in
   progress is not evidence: three identical runs of one tree once produced 4, 6
   and 0 failures purely from processes competing for the machine.

**A caution about measuring anything on a busy machine.** Duration and failure
counts both inflate under contention. If a number surprises you, take it again on
a quiet tree before believing it.

For the security subset alone, which is faster:

```bash
npm run test:security
```

---

### Symptom: `node --check` says the file is fine, and running it dies immediately

You checked a script's syntax, got no complaint, and then every single invocation
of that script threw an error before doing anything.

#### Cause

`node --check <file>` proves exactly one thing: **the file parses.** Node reads
the bytes and confirms they form grammatically valid JavaScript. It does **not**
load the module, does not resolve identifiers, and does not run a line of it.

So a file that references a variable that no longer exists — because someone
deleted the `const` that declared it and left one use behind — passes `--check`
cleanly and then throws `ReferenceError` at module load, on every invocation,
forever.

That exact thing happened to `scripts/profile/save-answer.mjs`. The file "checked
fine" while being dead on arrival. `save-answer.mjs` is the **only** sanctioned
way anything enters the fact base, so the practical failure mode was "the user
cannot record an answer at all", and the tool everyone reached for to confirm the
file was healthy was structurally incapable of noticing.

The general shape of this — and it recurs — is: **two tools agreeing a file is
fine is not two pieces of evidence when neither tool looks for the thing that is
wrong.**

#### Fix

Run the thing, or run its test file. Either is a real load.

```bash
# Load the module and see it refuse politely rather than crash:
node scripts/profile/save-answer.mjs
# (prints its usage banner and exits 2 — that is a successful load)

# Or run the file's tests, which import it:
node --test tests/profile/save-answer.test.mjs
```

A green `--check` is not evidence the module loads. Treat it as a spell-checker,
not a compiler.

One wrinkle if you are watching an AI agent try this: the shell guard
(`.claude/hooks/guard-profile-shell.mjs`) refuses any agent-issued
`node ... save-answer.mjs` that does not carry `--file <temp>`, `--user-approved`
or `--rescan`, so the agent cannot run the bare form above. **You** can, in your
own terminal — the guard constrains the agent, not you. An agent checking whether
the module loads should run its test file instead.

---

### Symptom: a file looks correct, behaves strangely, and searches skip it

You searched the codebase for a string you can see with your own eyes in a file,
and the search either found nothing or printed something like:

```
Binary file scripts/auto/pool.mjs matches
```

— a hit with no line and no detail.

#### Cause

The file contains a **NUL byte**: the byte whose numeric value is zero. It is a
legal character inside a JavaScript string literal, so:

- **prettier** reformats the file without complaint;
- **`node --check`** parses it as valid;
- the unit tests pass, because the _value_ is correct;
- `git diff` shows nothing unusual, because a NUL is invisible.

What it breaks is **search**. ripgrep (the tool behind the `Grep` facility and
`rg` on the command line) classifies any file containing a NUL as binary and
skips its contents. So a codebase-wide search silently stops covering that file,
and the message it prints reads like a match rather than a warning.

This has happened twice in this repository. Two files under `scripts/` —
`pool.mjs` and `untrusted.mjs` — carried a raw NUL inside a string sentinel
(`origin ?? "\0no-origin"` written with the literal byte instead of the escape).
The second cost was worse than the search one: the same invisible sentinel was
written out twice in one file, once in a pool exclusion key and once in a
counter, and **two invisible literals that must match exactly is a bug nobody can
review**, because the thing they have to agree on cannot be seen.

#### Fix

**Detect it.** A byte scan is the only thing that finds it:

```bash
node -e "console.log(require('fs').readFileSync(process.argv[1]).includes(0))" scripts/lib/db.mjs
```

Prints `true` if the file contains a NUL, `false` otherwise. (The `-e` flag runs
a one-line program; `readFileSync` without an encoding gives raw bytes, and
`.includes(0)` asks whether any of them is zero.)

**Prevent it.** `tests/security/source-bytes.test.mjs` is the standing check. It
walks `scripts`, `tests` and `docs` and fails on a raw control character. It
deliberately does **not** scan the whole repository: `node_modules`, `.git` and
`jobs/` hold third-party and generated bytes nobody here reviews, and a test that
fails on those is one people learn to ignore.

**The rule it enforces:** a control character may appear in source as an
**escape** — `\u0000`, `\x00`, `\0` — which is legible, searchable and
reviewable. Never as a raw byte.

**Related trap, same family.** The `SCHEMA` constant in `scripts/lib/db.mjs` is a
**template literal** — a string delimited by backtick characters. A backtick
anywhere inside its SQL, including inside a comment, ends the string early and
the file stops parsing. When you write comments in that SQL, quote identifiers
with plain words rather than backticks.

---

### Symptom: prettier reformatted a file you did not want touched

You edited a file, and when you looked again the formatting had changed —
indentation, line breaks, quote style, a semicolon at the start of a line.

#### Cause

`scripts/hooks/prettify.mjs` is a **PostToolUse hook**: a small program the AI
harness runs automatically after any file is written or edited. It runs prettier
(a code formatter) on the file. This is deliberate — hard rule 8 in `CLAUDE.md` —
and it keeps formatting from becoming something anybody argues about.

The hook is careful about two things. It only touches extensions it knows
(`.md`, `.json`, `.js`, `.mjs`, `.cjs`, `.ts`, `.mts`, `.yaml`, `.yml`, `.css`,
`.html`, `.htm`). And it passes `--ignore-path .prettierignore` explicitly,
because prettier 3 otherwise also inherits `.gitignore` — and `jobs/` is
gitignored on purpose while its documents must still be formatted.

The escape hatch is `.prettierignore`. Most of its entries are ordinary
housekeeping (`node_modules/`, `package-lock.json`, `profile/`, `jobs/*/*.pdf`,
`.playwright-mcp/`). **Three entries are deliberate contracts** and each carries
its reason as a comment in the file:

| Path                                       | Why prettier must not touch it                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.claude/skills/apply-job/scan-page.js`    | Loaded and evaluated as a **bare function expression**, not as a module. Prettier's leading-semicolon guard — the `;` it inserts at the start of certain lines to protect against a real ambiguity — makes the file unparseable in that context.                                                                                        |
| `.claude/skills/apply-job/scan.driver.mjs` | Same reason. It loads `scan-page.js` off disk; `scan-page.js` is the single source of truth for the page scanner.                                                                                                                                                                                                                       |
| `docs/job-sources.yaml`                    | `scripts/leads/manage-sources.mjs` edits this file **line by line**, so that the explanatory comments survive an add or a remove. That only works while every board is one flow-style entry on one line. Prettier reflows the longer `workday` and `oracle_cloud` entries into multi-line block style and silently breaks the contract. |

#### Fix

- **If the file is one of those three and it got reformatted anyway**, check
  whether `.prettierignore` still lists it, and check the exact path — the two
  scanner files live under `.claude/skills/apply-job/`, not under `scripts/`.
- **If it is a normal source file**, do not fight the formatting. Hard rule 8
  exists because formatting arguments are pure cost. Change the content, let the
  hook shape it.
- **If you have a genuinely new file that must not be formatted**, add it to
  `.prettierignore` **with a comment saying why**. Every existing deliberate
  entry has one, and an entry without a reason will eventually be deleted by
  someone tidying up.

> **Known defect (2026-08-05 audit).** `docs/application-limits.yaml` is the
> user's own file — the one that decides which jobs are in scope and whether the
> unattended runner may run — and it is guarded by **neither** of the two hooks
> that protect user-owned files. Nothing mechanically stops an agent editing it.
> The convention (propose values, never edit) is currently held by instructions
> alone.

---

## Part 2 — Documents that will not render

### Symptom: the resume will not render, and `verify-claims` exits 1

You asked for a PDF and were told the document has not passed verification, or
you ran the verifier yourself and it printed a list of violations and exited `1`.

#### Cause

`scripts/documents/verify-claims.mjs` is the deterministic truthfulness checker,
and hard rule 4 says it must pass before any document is rendered or shown as
final. "Deterministic" here means it is an ordinary program with no AI in it: the
same document and the same fact base produce the same verdict every time.

Its job is narrow and worth stating precisely. It does not judge whether your
resume is good. It checks that **every specific claim in the document can be
traced to something in your fact base** — `profile/profile.yaml` and
`profile/answers.yaml`. Rephrasing and reordering your own facts is allowed;
introducing a fact the profile does not contain is not.

It runs eight rules. Seven of them block. The eighth reports and does not block.

```bash
node scripts/documents/verify-claims.mjs resume jobs/<slug>/resume.md \
  --job jobs/<slug>/job.json
```

**Output** is a JSON report on standard output. **Exit codes:** `0` pass,
`1` violations, `2` a usage error (a missing file, a bad argument).

A passing run looks like this — this is real output against the repository's own
test fixtures:

```json
{
  "mode": "resume",
  "file": "tests/fixtures/good-resume.md",
  "ok": true,
  "checked": { "annotatedBullets": 6, "lines": 30 },
  "violations": []
}
```

`ok: true` and an empty `violations` array is the whole signal. `checked` tells
you what it looked at, which is how you catch the case where it passed because it
found nothing to check.

There is one more thing the verifier does that matters later: **it writes a
durable row**. Passing leaves a record in the `verifications` table in
`jobs/leads.db` holding two hashes — `doc_sha256`, the exact bytes that were
checked, and `profile_sha256`, the exact fact base they were checked against (see
`scripts/lib/verification.mjs`). Editing the document invalidates its own
verification. The user editing `profile.yaml` invalidates **every** outstanding
verification at once, because the corpus the rules compared against no longer
exists. Before this row existed, the only evidence a document had been checked
was that the file existed, so a draft nobody ever verified read as verified.

`--no-record` skips writing the row; `--db` and `--jobs-dir` redirect it. A row is
only written for a document inside a job workspace (`jobs/<slug>/<file>`), because
a scratch file has no slug to vouch for.

#### Fix — rule by rule

Each rule below shows a **real violation** produced by running the verifier
against the repository's fixtures, then the edit that resolves it.

---

**R1 — every bullet line must carry a fact annotation.**

_What it means._ A "fact annotation" is an HTML comment of the form
`<!-- fact:ID -->` at the end of a bullet. It names the entry in
`profile/profile.yaml` that the bullet came from. HTML comments do not appear in
the rendered PDF; `render-pdf.mjs` strips them.

_Real violation:_

```json
{
  "rule": "R1",
  "line": 6,
  "detail": "Bullet has no <!-- fact:ID --> annotation: \"- Led a team of engineers to rewrite the billing system.\""
}
```

_Fix._ Find the profile fact that supports the bullet and cite it. If more than
one supports it, list them comma-separated:

```markdown
- Led a team of engineers to rewrite the billing system. <!-- fact:exp-acme-b1 -->
- Cut deploy time and cost together. <!-- fact:exp-acme-b1,exp-acme-b3 -->
```

_If no fact supports it_, that is not an annotation problem. The bullet is a
claim the fact base cannot back, and the answer is either to delete it or to add
the fact properly — see the next entry in this document.

---

**R2 — every cited fact id must exist.**

_What it means._ You cited an id that is not in the profile. Usually a typo, or a
fact id that was renamed.

_Real violation:_

```json
{
  "rule": "R2",
  "line": 5,
  "detail": "Unknown fact id \"exp-nonexistent-b9\""
}
```

_Fix._ Open `profile/profile.yaml` and find the real id. Ids are stable strings
you choose; the fixture profile uses forms like `exp-acme-b1` (experience, the
company, bullet 1). Correct the annotation to match.

---

**R3 — every number in an annotated bullet must appear in a cited fact.**

_What it means._ Numbers are the easiest thing to invent and the most damaging
thing to get wrong on a resume, so they get their own rule. A number inside an
annotated bullet must appear in the **text of one of the facts that bullet
cites** — not merely somewhere in the profile.

_Real violation:_

```json
{
  "rule": "R3",
  "line": 5,
  "detail": "Number \"5000\" not present in cited fact(s) [exp-acme-b1]"
}
```

_Fix._ Three legitimate resolutions, in order of preference:

1. **The number is in a different fact.** Add that fact's id to the annotation:
   `<!-- fact:exp-acme-b1,exp-acme-metrics -->`.
2. **The number is wrong.** Correct it to what the profile says.
3. **The number is real but not recorded.** It belongs in the fact base first.
   See the next entry.

Rounding is not a loophole. If the profile says `4,800` and you wrote `5,000`,
R3 is telling you that you changed a fact.

---

**R4 — every number outside a bullet must appear somewhere in the corpus.**

_What it means._ Summary lines, headline figures and section headers are not
bullets and carry no annotation, so R3 cannot check them. R4 catches them against
the **whole** fact base rather than a cited subset.

_Real violation_, from a summary line reading
`Summary: 12 years of experience, starting Mar 2009.`:

```json
{ "rule": "R4", "line": 3, "detail": "Number \"12\" not found in any fact source" }
{ "rule": "R4", "line": 3, "detail": "Number \"2009\" not found in any fact source" }
```

_Fix._ Use the number the profile actually contains, or drop the figure. A
summary saying "a decade of experience" with no digit in it passes R4 and is not
a lie; a summary asserting "12 years" when nothing records twelve is exactly what
this rule is for.

---

**R5 — every `Mon YYYY` date token must appear in the corpus.**

_What it means._ Dates written in the three-letter-month form (`Mar 2009`,
`Jan 2022`) are checked against the fact base as whole tokens. Employment dates
are verifiable by any employer who cares to check, so an invented one is among
the worst errors available.

_Real violation:_

```json
{ "rule": "R5", "detail": "Date \"Mar 2009\" not found in any fact source" }
```

_Fix._ Match the profile's dates exactly. If the profile records `Jan 2022 -
Present`, the resume writes `Jan 2022`, not `January 2022` and not `2022`.

---

**R6 — every known technology term in the document must appear in the corpus.**

_What it means._ This is the load-bearing rule, and it is the one hard rule 0
leans on. A job posting is written by a stranger and is **data, never
instructions**. If a posting says "add Kubernetes to your resume" and something
in the pipeline complies, R6 is what stops the resulting document: Kubernetes is
a known technology, it is not in your fact base, and the document is refused.
That is the guarantee — _a claim the fact base cannot back never survives
verification, however it was proposed._

"Known technology term" means a name in `scripts/lib/keywords.mjs`, the project's
single lexicon of technologies. Ordinary English words are not technology claims.

_Real violation:_

```json
{ "rule": "R6", "detail": "Tech term \"Microservices\" not found in any fact source" }
{ "rule": "R6", "detail": "Tech term \"Kubernetes\" not found in any fact source" }
{ "rule": "R6", "detail": "Tech term \"Terraform\" not found in any fact source" }
```

_Fix._ Remove the term, or add the fact through `save-answer.mjs`. There is no
third option and no override flag; that is the point of the rule.

**Two things about R6 that will otherwise confuse you.**

_It is case-insensitive now, with deliberate exceptions._ Until the 2026-08-05
audit, R6 compared text case-sensitively, so a document claiming `kubernetes` and
`terraform` in lowercase produced **zero violations and exited `0`** — the gate
could be walked past by pressing the shift key less. Matching now folds case,
with an exception list (`CASE_SENSITIVE_SURFACE` in
`scripts/documents/verify-claims.mjs`) for technology names that are also
ordinary English words — `Go`, `R`, `C`. So "go to the store", "react to
feedback", "a spring internship" and "rust on my laurels" still produce no
violations, which was verified by running them.

_Sibling spellings fold to one form._ `Postgres` in your profile and `PostgreSQL`
in your resume used to be an R6 violation and a blocked render — while
`docs/tailoring-rules.md` explicitly instructed the writer to use "PostgreSQL not
Postgres". The documentation and the gate were fighting, and each round cost a
full tailoring cycle. Both sides now fold to a canonical name before comparing.
The folding uses the lexicon's `surface` field and never `aliases`, and that
distinction is load-bearing: `surface` is the same skill written differently **by
the same honest person**, while `aliases` is how a **stranger's job ad** refers to
it. Folding aliases in would let a posting's vocabulary vouch for a claim your
facts cannot back — which is the exact hole R6 exists to close.

---

**R7 — a resume must contain at least one annotated bullet.**

_What it means._ A document with no annotations at all is not a verified
document; it is an unverified document that no rule happened to fire on. R7 turns
that silence into a failure.

_Real violation_, from a file containing only a heading and a summary paragraph:

```json
{
  "rule": "R7",
  "detail": "Document contains no annotated bullets — nothing is traceable to the profile"
}
```

_Fix._ Write the experience section with annotated bullets. If you genuinely meant
to verify a cover letter, use cover-letter mode instead — see below.

---

**R8 — keyword coverage. Reports; does not block.**

_What it means._ Every other rule answers _"is this true?"_, and a failure there
is a falsehood that must be fixed. R8 answers _"is this complete?"_ — did the
document actually use the terms the keyword plan said to use? A miss is a
**trade-off**, not a lie: a one-page resume genuinely cannot carry every matched
term, and dropping one to keep the page readable is a legitimate editorial call.

R8 is deliberately non-blocking, and the reason is worth internalising. Making it
blocking would pressure the tailoring step into keyword **stuffing** — cramming
terms in regardless of readability — which is the exact behaviour modern
applicant-tracking systems penalise. A gate that pushes you toward the thing it
is supposed to prevent is worse than no gate.

_How to see it._ R8 only appears when a keyword plan exists. Pass `--job` and the
verifier looks for `jobs/<slug>/keywords.json` beside `job.json`:

```bash
node scripts/documents/verify-claims.mjs resume jobs/<slug>/resume.md \
  --job jobs/<slug>/job.json
```

The report then carries a `coverage` object with `must_use` (how many terms the
plan asked for), `placed`, `missing`, `missing_required`, `used_blocked`,
`title_mirror` and `title_mirrored`.

_Fix._ Read `missing_required` first — those are terms the plan marked as
important. Work them in where they are true. Ignore the rest if the page is
already full. `used_blocked` is different in kind: those are terms the plan told
you **not** to use, and they are a truthfulness matter — R6 catches them against
the corpus independently, and R8 lists them again so the message names the plan.

---

**Cover-letter mode.** Verifying a cover letter runs **R4, R5 and R6 only** —
there are no annotated bullets in a letter, so R1, R2, R3 and R7 do not apply:

```bash
node scripts/documents/verify-claims.mjs cover-letter jobs/<slug>/cover-letter.md \
  --job jobs/<slug>/job.json
```

The corpus for a letter additionally includes the job's **company and title**, so
you may address the company by name. It **never** includes the posting body, so a
technology that appears only in the posting still fails R6. That asymmetry is
deliberate and is the same principle as the `surface`/`aliases` split above: the
employer's vocabulary is not evidence about you.

---

### Symptom: a tailored claim was rejected and you know it is true

R6 refused a technology you have genuinely used, or R3 refused a number you
genuinely achieved. The document is being blocked over something that is not a
lie.

#### Cause

The verifier is not asserting the claim is false. It is asserting that **the fact
base does not contain it**, which is a different and much narrower statement. The
fact base is `profile/profile.yaml` and `profile/answers.yaml`, and it is the
only thing the verifier can see.

This is working as designed, and the design is worth understanding before you
route around it. The whole system rests on one boundary: documents that go out
with your name on them contain only facts from a file **you** approved. If a
claim could enter a document because a model believed it, the boundary would be
"whatever the model believed", and the guarantee would be worth nothing. So the
verifier's answer to "but it is true" is always the same: _then record it, and I
will accept it._

#### Fix

**The claim must go into the fact base, and there is exactly one sanctioned door
for the agent.**

`scripts/profile/save-answer.mjs` is that door. Hard rule 2 says the agent never
edits `profile/` directly, and a PreToolUse hook (`.claude/hooks/protect-profile.js`)
blocks it on the file-editing path while `.claude/hooks/guard-profile-shell.mjs`
blocks it on the shell path. You, the owner, may edit those files by hand
whenever you like — they are yours. The restriction is on the agent, not on you.

```bash
node scripts/profile/save-answer.mjs \
  "Have you used Kubernetes in production?" \
  "Yes — ran a 12-node cluster for the reporting service at Acme, 2023-2024." \
  --user-approved
```

**The flags that matter:**

- `--source user` (the default) means you said it in chat. `--source model` means
  the agent picked an option off a form and **you approved that pick in the
  approval message** — still approved, but derived, so a wrong one has to be
  findable and reversible. A silent guess is never written.
- `--class datum` or `--class assertion`. A **datum** is a fact about you (an
  email, a city, a skill, a salary figure); typing it into a form commits you to
  nothing. An **assertion** is something you _assert or agree to_ — work
  authorisation, willingness to relocate, consent to a background check, an
  e-signature — and it must never be acted on unattended, whatever widget a board
  renders it as. The classification lives with the **answer**, not with the
  control, because a board authors its own page and can defeat any test of the
  page, but it cannot change what kind of thing you recorded.
- `--replace` overwrites an existing entry for the same question, but **only**
  when that entry is `source: model`. A user-stated answer is never overwritten
  by this script; correcting one is a deliberate edit of the file by its owner.
- `--file <path>` writes somewhere other than the real bank. Use it for testing.

**Exit codes, which are the script's real output:**

| Code | Meaning                                                                                                  |
| ---- | -------------------------------------------------------------------------------------------------------- |
| `0`  | Saved.                                                                                                   |
| `1`  | Conflict — an entry for this question already exists and `--replace` was not given or was not permitted. |
| `2`  | Usage error, including an unrecognised flag.                                                             |
| `3`  | The **question text** is instruction-shaped. Refused.                                                    |
| `4`  | The **answer** is a government or financial identifier. Refused, with **no override by design**.         |
| `5`  | The bank was locked by another writer and nothing was written. Retryable.                                |

**Why 3 and 4 exist**, because they will look like the script being difficult:

_Exit 3._ The answer's text comes from you. The **question** does not — it is a
form label copied off an employer's application page by the scanner. Under
`--source model` the answer is an option label off that same page. Both land in
`answers.yaml`, which is permanent, global (every future application reads it),
and part of the verify-claims evidence corpus that decides what may appear on
your resume. A hostile label is therefore worth more to an attacker than a
hostile job description: the description influences one tailoring run, an entry
in the bank influences all of them. So an instruction-shaped label is **refused**
rather than stored with the dangerous part removed — a permanent record is not
the place to keep a neutralised attack, and you are in the conversation and can
be told.

_Exit 4._ The bank is not only a place text gets **in**; it is the supply of
everything this pipeline types **out** into other people's forms. A field's
meaning is decided on the employer's server, so a control labelled "Phone number"
can post to a column called `ssn` and no scanner can tell the difference. That
makes the blast radius of every mislabelled-field attack exactly the contents of
this file. A government or financial identifier is refused here and you type it
yourself, in the browser, on the page you are looking at.

**After saving, re-verify:**

```bash
node scripts/documents/verify-claims.mjs resume jobs/<slug>/resume.md --job jobs/<slug>/job.json
```

Note that adding to the fact base **invalidates every outstanding verification**,
because `profile_sha256` changes. Documents you verified earlier need verifying
again. That is not overhead; it is the mechanism that stops a stale "verified"
verdict outliving the facts it was about.

**If the claim belongs in `profile.yaml` rather than `answers.yaml`** — a job,
a date, a bullet, a skill in your skills list — edit `profile/profile.yaml`
yourself. `save-answer.mjs` writes the answer bank; the profile is a document you
own and maintain. `profile/profile.example.yaml` shows the shape.

---

## Part 3 — Jobs that do not appear

### Symptom: a board returns no jobs

You know a company is hiring, its board is in your source list, and the sweep
brings back nothing from it.

#### Cause

There are four different failures wearing the same clothes, and they need
different fixes. In order of how often they occur:

1. **The board is broken or moved.** A company changed applicant-tracking system,
   renamed its board slug, or the API URL changed. The sweep is deliberately
   tolerant here — one dead board must never lose you the other forty — so it
   prints a warning on the error channel and keeps going:
   ```
   warn: source failed: greenhouse:northwind — HTTP 404
   ```
   That line goes to standard **error**, not standard output, so it is easy to
   miss if you are only reading the summary.
2. **The board is fine and everything it returned was filtered out.** This is by
   far the most common case and it is not a failure. `docs/application-limits.yaml`
   is a cheap gate applied to every result: your title keywords, your location
   rules, your freshness limit. A ratio like `stored=6 rejected=1183` is normal
   and healthy.
3. **The board genuinely has nothing open** that matches your query.
4. **The board's list endpoint returns no description**, so the posting could not
   be examined. Four board types do this — `oracle_cloud`, `smartrecruiters`,
   `successfactors` and `workday` — and Adzuna returns only a ~500-character
   teaser. Those need a per-posting detail fetch (`scripts/leads/enrich.mjs`,
   one fetcher per system). This matters more than the count suggests: those four
   types are the **local Las Vegas employers** — casinos, gaming, a large
   pharmacy chain — which are the highest-value leads precisely because on-site
   is in scope for them. The least examinable leads are also the most important.

#### Fix

**Step 1 — live-check every board.** This is a network probe of each entry in
`docs/job-sources.yaml`:

```bash
node scripts/leads/manage-sources.mjs verify
```

A board that answers with an HTTP error or an unparseable body is the case 1
failure. Fix it with `manage-sources.mjs remove` and a fresh `add`, or leave it
and accept the warning. Never hand-edit `docs/job-sources.yaml`: the script edits
it line by line to preserve its comments, and that only works while the file
keeps its exact one-entry-per-line format.

**Step 2 — measure the board's yield.** This fetches each board and reports how
many of its postings survive the cheap gate:

```bash
node scripts/leads/board-yield.mjs --query "full stack" --json
```

A board with a healthy API and zero qualifying postings is case 2 or case 3, and
the number tells you which: if it returned two hundred postings and none passed,
the gate is the reason.

**Step 3 — find out which gate.** `gate-audit.mjs` re-runs every screening stage
over your whole stored lead set and reports which stage rejected what. It is
covered in full in the next entry.

**Step 4 — if the board type returns no description**, confirm that enrichment
ran. A lead with no description can be neither keyword-indexed nor
blocker-screened, so it will look unattractive for reasons that have nothing to
do with the job.

> **Known defect (2026-08-05 audit).** The `partial_description` flag — which is
> supposed to mark a lead whose description is a teaser rather than the full text
> — is set true for nearly every lead, which disables two screening signals that
> depend on it. So a lead that "passed" screening may have passed because two
> checks did not run. Do not read that flag as telling you a description is
> complete.

> **Known defect (2026-08-05 audit).** The duplicate check collides for
> `successfactors` boards and for `oracle_cloud` sites that share a default site
> name, so two different employers can be treated as the same board.

---

### Symptom: a job you wanted never appeared

You saw a posting somewhere else, or you know a company posted a role you would
have applied to, and it is nowhere in your recommendations.

#### Cause

The lead funnel has six places a posting can be discarded, and before
`gate-audit.mjs` existed, **"why did I never see this job?" was not an answerable
question.** The stages are now named and ordered, and each rejection records
which stage decided.

The order is cheapest-first, and every stage stops at the first rejection — an
expensive check only ever sees what the cheap ones let through.

| Stage     | Name                    | What it sees                                                                            | Cost                      |
| --------- | ----------------------- | --------------------------------------------------------------------------------------- | ------------------------- |
| **fetch** | the board list          | —                                                                                       | one request per board     |
| **L0**    | title / location / date | the board's list payload: title, location, date, salary                                 | free. Discards thousands. |
| **L1**    | body disqualifiers      | the full description — which for four board types costs one fetch per surviving posting | one fetch each            |
| **L2**    | profile fit             | can this profile actually do this job                                                   | free, given L1's text     |
| **L3**    | scam / ghost risk       | is this posting real                                                                    | free                      |
| **store** | —                       | —                                                                                       | writes to `jobs/leads.db` |

After storing, `screen.mjs` runs its own overlay checks and `recommend.mjs`
ranks. A lead can also be dropped at store time for two ordinary reasons: it is
already stored, or you have already applied to it.

#### Fix — walk the funnel

Run these in order. Each one answers a different question.

**1. Is the company's board even in your list?**

```bash
node scripts/leads/manage-sources.mjs list
```

If the company is absent, that is your answer. Add it — but add it properly:
find the slug with `find-boards.mjs`, yield-gate it with `discover-boards.mjs`,
add it with `manage-sources.mjs add`. Slug probing can find the **wrong**
company: `find-boards.mjs` will try "spring" for "Spring Mobile" and "ultimate"
for "Ultimate Fighting Championship", and a board with that slug may belong to
someone else entirely. This is contained because `discover-boards.mjs` reports
the company name and live counts and **you approve each addition** — nothing
auto-adds.

**2. Is it in the store at all?**

```bash
node scripts/leads/recommend.mjs --status all --top 50
```

`--status all` includes leads already dismissed or recommended. If the job is
here, it was found and stored, and your problem is ranking, not discovery — skip
to step 5.

**3. Which stage rejected it?** This is the command the whole entry exists for:

```bash
node scripts/leads/gate-audit.mjs
```

`gate-audit.mjs` re-runs every stage over every stored lead and **diffs the
result against the last recorded run**. The asymmetry in its output is
deliberate: a newly **accepted** lead is a win and gets one line; a newly
**rejected** lead is the dangerous direction — the project's stated worst failure
is a job you never see — so those are listed in full, with the stage and the
reason, every time.

Compact output looks like this:

```
REGRESSION|l1|greenhouse:northwind:8098945|Northwind Logistics|l1:onsite_required
recovered|was=l2|ashby:orbital:1f2e|Orbital Systems
audited=312 passing=48 l0=201 l1=39 l2=18 l3=6 compared=298 newly_rejected=1 newly_accepted=1 ms=412
```

Read the summary line as: 312 leads audited, 48 pass every stage, 201 died at L0,
39 at L1, 18 at L2, 6 at L3, compared against 298 leads in the baseline.

Prose output (what you see in an interactive terminal) spells the same thing out
and lists each newly-rejected lead with its company, title, stage and reasons.

**Exit codes:** `0` clean or improvements only, `1` when leads became newly
rejected, `2` usage or a missing store. The `1` exists so an automated caller
notices.

**Flags worth knowing:** `--json` for the full structure; `--status all|new` to
narrow which leads are audited; `--no-save` to audit without updating the
baseline. Saving is the **default**, because an audit whose result is not
recorded gives the next change nothing to diff against.

**The discipline this encodes:** run `gate-audit.mjs` after **any** change to a
gate. A widened filter can silently narrow something else, and the loss is
invisible.

**4. If the job is not in the store and no stage rejected it**, it was never
fetched. Go back to the previous entry: the board failed, or the query did not
match, or the posting is older than your freshness limit and was dropped at
ingest before any stage ran.

**5. If it is stored and ranked low**, look at the `gap:` list:

```bash
node scripts/leads/recommend.mjs --status all --top 20
```

```
30|jobicy:148197|Lingraphica|Software Engineer - Unity|match:AI/LLM integration,AWS,CI/CD,Git,Node.js,PostgreSQL,React|gap:C#,Firebase,Jira|https://...
```

`match:` is what the posting asks for that your profile already evidences.
`gap:` is what it asks for that your profile does not. A long `gap:` list is not
a reason to skip a job — it is the honest picture of what tailoring will have to
work around.

**6. Check you have not already applied.**

```bash
node scripts/applications/check-applied.mjs "Northwind Logistics"
```

Prints JSON with `job_already_applied` and matching records with `days_ago`.

> **Known defect (2026-08-05 audit).** `prep-queue.mjs` ranks leads on titles
> alone, ignoring keyword overlap and title rank — so the queue order it produces
> is weaker than `recommend.mjs`'s. Prefer `recommend.mjs` when choosing what to
> work on.

> **Known defect (2026-08-05 audit).** `gate-audit.mjs` audits the four staged
> gates (L0–L3) but **not** `screen.mjs`'s own overlay checks, which can also
> reject. A lead rejected by those will not appear in the audit's stage
> breakdown.

> **Known defect (2026-08-05 audit).** `repost_count` counts **sweeps**, not
> reposts — every time a sweep sees the same still-open posting, the counter goes
> up. L3 rejects a lead at three, so an ordinary posting that stays open across
> three sweeps can be rejected as a suspected repost.

---

## Part 4 — The application form

### Symptom: a form field deferred and you think it should not have

The fill plan reported the form is not ready, and one of the deferred fields is
something the pipeline seems like it should have known.

#### Cause

A **defer** means: nothing deterministic in this system could answer this field,
so it is being handed to you rather than guessed at. It is not an error and it is
not the machine being lazy. It is hard rule 1 — a field the fact base cannot
answer truthfully is deferred, because the failure being prevented is a **wrong**
application, not a missing one.

Defers fall into five classes, and the class tells you whether the defer is
yours to remove. `scripts/auto/taxonomy.mjs` defines them:

| Class             | Meaning                                                                | Can engineering shrink it?                                                                               |
| ----------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| **understanding** | The machine did not understand the page.                               | **Yes.** This is the only class that shrinks with engineering, and the only sanctioned throughput lever. |
| **assent**        | A human has to say yes.                                                | **No — and it must not.** Shrinking this is the exact failure hard rule 6 is written to prevent.         |
| **environment**   | The board or the posting declined.                                     | No. Not ours, not a bug. Rising incidence is a signal about them.                                        |
| **policy**        | Our own rules said no: caps, trust, screening, an unverified document. | No. Working as intended.                                                                                 |
| **malfunction**   | Something failed.                                                      | This is the only class worth waking up for.                                                              |

#### Fix — step 1: read the reason

The reason is printed. Two places carry it.

**From the plan, compact form** (what you see when output is piped or read by an
agent) — one tab-separated record per deferred field:

```
defer	f7	unknown	Which of the following describe you?	demographics
defer	f9	confirm-widget	I certify the information above is accurate
defer	f12	consent	I agree to the privacy policy
```

The columns are: literal `defer`, the field key, the **reason**, the label the
form showed, and the page's own `name` attribute for that control (which is
blank when the page did not give one). The last column is there so a label that
lies about the field it sits on is visible.

**From the plan, prose form** (an interactive terminal):

```
ATS: greenhouse
Not ready — 3 deferred field(s) need a human.
14 field(s) will be filled automatically.

3 left for you:
  - Which of the following describe you? [name="demographics"] (unknown)
  - I certify the information above is accurate (confirm-widget)
  - I agree to the privacy policy (consent)

Plan written to jobs/<slug>/fill-plan.js
```

**From the file:** `jobs/<slug>/fill-plan.json` holds the same data structurally.

**Across every prepped job at once**, which is the fastest way to clear a backlog
of questions:

```bash
node scripts/apply/pending-questions.mjs
```

`profile/answers.yaml` is **global** — "Do you require sponsorship?" answered once
resolves it for every application ever. But the flow asks per job, while you are
waiting at a form, so the same question gets asked N times and N−1 of those are
pure latency. This script collects them all so you answer once. It reads two
sources: defers already computed for scanned forms, and **predicted** defers —
required fields remembered in the field cache for boards these jobs use, that the
fact base still cannot resolve. The second kind is available before any browser
is opened.

It deliberately never lists consent, terms or e-signature fields: those are yours
to tick in the browser, not questions with storable answers.

#### Fix — step 2: read what the reason means

The reasons you will actually see, with what each one is telling you:

| Reason (`why`)                                   | What happened                                                                                                                                             | Class         |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| `unknown` / `no value resolved`                  | Nothing in the profile or the answer bank matched this label.                                                                                             | understanding |
| `needs-choice`                                   | Something matched, but more than one bank entry could apply and the system will not pick for you.                                                         | understanding |
| `no option matched the resolved value`           | An answer resolved, but none of the dropdown's options is that answer.                                                                                    | understanding |
| `confirm`                                        | An **assertion**-class bank answer exists — work authorisation, arbitration, background check, relocation — and the system stopped short of acting on it. | assent        |
| `confirm-widget`                                 | A checkbox or radio group. **Always** deferred on the unattended path, whatever the answer's class.                                                       | assent        |
| `consent`                                        | A consent tickbox. Never auto-ticked on any path that runs today.                                                                                         | assent        |
| `long-free-text`                                 | A long free-text box (an essay question).                                                                                                                 | assent        |
| `disclosure-budget`                              | The form asked for more facts about you than the configured per-application disclosure budget allows.                                                     | assent        |
| `needs a document or long-form text`             | The field wants a file or a written passage that is not yet rendered.                                                                                     | understanding |
| `picker half of a composite widget`              | A phone-country selector beside a number box, for instance. The text input carries the value; this half is skipped deliberately.                          | —             |
| `profile-import control, not an attachment slot` | A file input that runs the **board's** resume parser rather than attaching a document. See the upload entry below.                                        | —             |
| `not applicable — this is the current role`      | A question about a previous position, on a row describing the current one.                                                                                | —             |

**Two reasons look identical and are deliberately different strings.**
`confirm` and `confirm-widget` are separate markers on purpose. `confirm` means
"an assertion-class answer exists and was not acted on". `confirm-widget` means
"this is a checkbox or radio group, which carries **assent rather than a
value**". An earlier draft merged them and re-marked a form whose only outstanding
issue was an **unreviewed work-authorisation assertion** as ready to fill. Do not
merge them.

**Why a checkbox never auto-acts unattended, whatever the class.** This was
measured, not reasoned about. Against the real 49-entry fact base, on a page
where every label and option was wording the user had banked **verbatim** —
Country, Gender, Veteran Status, all classified `datum` — **all 34 non-`confirm`
check-verb fields auto-ticked** before the guard landed. Now zero. A `datum`
classification licenses filling a **text field**; it says nothing about whether
performing an act on a control the board owns is safe with nobody watching. And
the guard has no exemption for a group offering only two or three options,
because a hostile board defeats an option-count exemption by adding decoy options
to the one box it cares about.

**Why a consent box defers on its shape as well as its topic.** There are two
doors into the consent branch. `isConsent(label)` is a **topic** match — words
like "agree", "certify", "privacy policy". A topic list is a wording race the
board always wins: the 26th rephrasing of the same agreement is free for them to
write and costs this repository a code change every time. So
`looksLikeAgreementProse()` is a second door matching on **shape**: a checkbox
with exactly one option whose label is at least eight words and ends in `.` or
`!`. That is what agreement prose looks like regardless of language. Neither
function auto-ticks anything; entry to the branch is only entry.

#### Fix — step 3: the three sanctioned ways to teach it

There are exactly three ways to make a field stop deferring. This is not a
stylistic preference; it is written into hard rule 6.

**1. A banked answer.** You answer the question once and it is stored:

```bash
node scripts/profile/save-answer.mjs \
  "Which of the following describe you?" "Decline to self-identify" --user-approved
```

An exact-label match resolves that field to `OK` on every future application to
any board that asks it the same way. This is the fix for `unknown` and
`needs-choice`.

**2. A probed option list.** The scanner opens a custom dropdown, waits for the
menu to render, reads the real options and closes it again. That turns "no option
matched" into a match, because the system now knows what the page actually
offers. Rescan with probing enabled and rebuild the plan. If the plan is being
served a **stale** remembered option list, drop it:

```bash
node scripts/apply/fill-plan.mjs <slug> --invalidate
```

`--invalidate` drops the remembered shape of this form. Use it when the fill
engine reports a verify mismatch on a field whose options came from the cache.

**3. An adapter.** A small module in `scripts/apply/ats/` that knows a specific
board's shape. Five exist today: `ashby.mjs`, `greenhouse.mjs`, `lever.mjs`,
`generic.mjs` and the dispatcher `index.mjs`. An adapter is the right fix when a
board's markup is unusual in a way that repeats — a label that starts
mid-sentence, a combobox whose options can be neither read nor set, an answer row
that reports as a phantom field. Four such defects on one board (Oracle
Recruiting Cloud) were fixed this way in a single change.

**The fourth way, which is forbidden.** Do not have a model read the field and
decide. That is the single change that puts attacker-controlled page text and
your fact base in one context window, on a path with nobody watching. An
`UNKNOWN` field is not a gap in the system's knowledge to be filled in — it is
the system correctly reporting that nothing deterministic understood the page.
The answer is to teach it deterministically or to defer, never to guess fluently.
If a design starts to want the model there, that is the signal to stop and ask.

The pressure runs the other way, which is why this is written down: unlimited
application volume creates direct pressure to shrink the defer list, and the
cheapest-looking reading of "make fewer things defer" is exactly the forbidden
one.

> **Known defect (2026-08-05 audit).** Two answer-bank rules answer questions
> they should defer. A label matching `title` or `position` is answered with your
> **current job title**, so `"Position Applied For"` gets filled with the job you
> already have; a label matching `company`/`employer`/`organisation` is answered
> with your **current employer**, so `"Company you are applying to"` gets filled
> with where you work now. Both resolve `OK`, which means they are filled and
> submitted with no review. A guard was added and an adversarial reviewer drove
> 35 realistic labels through it and found **17 still wrong**, including
> `"Requisition Title"` and `"Hiring Company"`. Check any field whose label
> mentions a title, a position, a company or an employer before submitting.

> **Known defect (2026-08-05 audit).** `"Have you ever worked for our company
before?"` is answered **"No"** automatically. The rule reads the company name
> out of the question, gets the literal string `"our company"`, finds no such
> entry in your employment history, and concludes the answer is no. If you _have_
> worked there, a false statement is filled and submitted. The correctly-named
> form of the same question (`"...worked for Globex before?"`) defers properly.

---

### Symptom: an upload appears to succeed and the application has no resume

The fill report said `ok`, the plan said `resume.pdf → Résumé`, and the submitted
application has no attachment — or has the wrong document in the slot.

#### Cause

This is the single most instructive bug in this repository, and it happened on a
real application.

`fillPage` used to report only **counts**: `ok=6 failed=0 failures=[]`. A count
cannot be wrong about which file is on which input, because a count does not know
which file is on which input. On the Greenhouse fixture — both attachment inputs
inside one `<form>` element — the routing walked up the page looking for a
container whose text mentioned "cover letter", matched the `<form>` that wraps
**both** inputs (its text reads "… Resume Attach Cover Letter Attach …"),
re-stamped the résumé input, and wrote `cover-letter.pdf` on top of `resume.pdf`.
The cover-letter field got nothing. The report said everything was fine.

Nothing downstream could contradict it. The verify pass excludes uploads in both
of its passes on purpose. The revealed-fields sweep skips file inputs. The
scanner reports no filename for a file field. And the apply skill built its
approval message **from the plan** — so the user was shown
`resume.pdf → Résumé, cover-letter.pdf → Cover Letter` while the page held the
opposite.

**A control that reports intent as observation is not a control.**

Three rules now hold the routing, and each one alone would have prevented the
incident. Do not relax any of them:

1. The walk stops at the **nearest discriminating** ancestor. A container holding
   two file inputs describes both and identifies neither, and nothing above it
   can be narrower. Nearest depth wins, so the result does not depend on the
   order elements appear in.
2. A stamp is a **claim**: an input already carrying the marker, or already
   holding a file, is not a candidate for anything.
3. The fallback does what its comment always said — the first input **still
   awaiting a file**, not "the first input" unconditionally.

And there is now an independent readback: after `setInputFiles`, the engine asks
the page what each file input actually holds.

#### Fix — read `report.uploads`, never the plan

`report.uploads` is the record of where each file **actually** went. Anything
that tells you what was attached must read that. It carries `file`, `target`,
`how`, `seen` and `seenFile`.

**`seen` is the field that matters, and its three values mean genuinely different
things:**

| `seen`       | Meaning                                                     | Is it a problem?                                                                                                                                                         |
| ------------ | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `"attached"` | The input is still on the page and holds at least one file. | Good — **but see the filename check below.**                                                                                                                             |
| `"gone"`     | The input is no longer on the page.                         | **Not an error.** This is what a _successful_ Greenhouse upload looks like: the board swaps the file input for an attached-file view. Must not be reported as a failure. |
| `"empty"`    | The input is still on the page and holds **zero** files.    | **Unambiguous failure.** The file did not attach.                                                                                                                        |

`seen: "empty"` is now demoted from `ok` to a fill failure, with a reason that
begins with a tag so it survives the 140-character cap on messages that reach
you:

```
upload-readback-empty: the file input is still on the page holding no file —
resume.pdf did not attach; attach it by hand
```

**`seen: "attached"` is checked too, and this is newer.** "Some file is here" was
all `attached` ever meant. Measured on three live Ashby applications: those forms
carry a **third** file input labelled "Name" that matches neither resume nor
cover-letter pattern, so it fell to the positional fallback, consumed the first
document in order, and was planned the résumé — planning the résumé twice. A
document landing in a slot nobody meant it for was counted as a clean fill. The
engine now compares the page's own report of which file landed against the file
this run sent, by **membership, not equality** (a board that appends to an
already-populated input leaves your file present beside another one, which is not
a mis-target; your file being **absent** is the defect):

```
upload-wrong-file: the input holds a file this run did not send it —
resume.pdf is not attached here; attach it by hand
```

**`how: "order"` is worth saying out loud.** It means routing fell back to
document position rather than matching a label. That is correct until a board
reorders its inputs, and it is exactly the case that produced the Ashby incident.

**The commands:**

```bash
# The plan, including which files it intends to route where:
node scripts/apply/fill-plan.mjs <slug> --json

# After a fill, read the engine's report — the uploads array is the evidence:
#   jobs/<slug>/fill-report.json   (written by the caller)
```

**If an upload failed:** attach the file by hand in the browser. That is what the
message tells you to do, and it is the right answer — the alternative is retrying
an operation whose failure you do not understand, against a live application.

**One upload deferral that looks like a bug and is not.** A file input whose
label matches a resume pattern is sometimes **not** an attachment slot. Oracle
Recruiting Cloud renders a control labelled "Import your profile from resume"
beside the real "Upload Resume" slot, and the resume pattern matched both.
Uploading to it fired the **board's** resume parser, which rewrote the Experience
and Education sections from the PDF text and remounted the form mid-run — writing
fields the fact base never approved. That control is now deferred with the reason
`profile-import control, not an attachment slot`.

> **Known defect (2026-08-05 audit).** The verify pass decides whether a filled
> value "landed" using loose substring containment — the exact rule that was
> removed elsewhere after it put `"Protected Veteran"` on a submitted form in
> response to a request for `"Veteran"`. A field that threw an error and left a
> wrong-but-containing value on the page can be reported as a clean fill.

---

## Part 5 — Caches, locks and crashes

### Symptom: the field cache seems to have forgotten everything

Applications that used to be fast are slow again. Every dropdown is being probed.
Every board reports as if it has never been seen before.

#### Cause

The **field cache** remembers the _shape_ of a form you have already filled:
which widget each field is, what options it offers, and which strategy actually
worked on it. It never stores answers — only structure. Answers live in
`profile/answers.yaml`.

It exists because the expensive half of a page scan is probing custom dropdowns.
The scanner opens each one, waits for the menu to render, reads the options and
closes it again — up to fifteen per form, in the browser, every time. Everything
it learns is identical on the next application to the same board. The audit
measured the cost at **1.5 to 2.5 seconds per dropdown, up to 18 per form**, paid
on every single application.

The cache file is `jobs/.field-cache.json` and it carries a version number.
`CACHE_VERSION` in `scripts/apply/field-cache.mjs` is currently `4`. When the
number on disk does not match the number in the build, **every remembered form is
discarded** — which is correct, because the shape of the data changed and
re-serving it would mean serving wrong data, not merely stale data.

Version 4 was reached for a real reason worth knowing. Under version 3, the cache
key was built from the applicant-tracking system's id plus the form's required
labels. That is cross-tenant **by construction**: every employer on the same
system whose required fields carry the same labels — name, email, resume, which
is the common case — shared one key. So employer B was served employer A's
remembered option lists. A "How did you hear about us?" list is written per
employer; the cache was re-serving one company's list on another company's form.
Version 4 adds the **host** to the key.

**The failure this entry is really about** was that the discard used to be
**silent**. Found live: `jobs/.field-cache.json` sat at version 2 while
`CACHE_VERSION` had moved to 3, so all seven of its real remembered forms were
thrown away on every load with **nothing printed anywhere**. Every board read as
"no remembered form shape" — which is the same message a board this pipeline had
genuinely never seen would produce — so the whole pipeline sat at the amber
readiness tier and nobody could tell the two cases apart from the output.

The discard was correct. Only its silence was the bug.

#### Fix

It now announces itself on the error channel:

```
field-cache: discarding 7 remembered form(s) — cache is v2, this build expects v4 (jobs/.field-cache.json)
```

and the count also travels on the return value as a `discarded` object, so a
caller can act on it without scraping console output. An unreadable or
unparseable file produces the sibling message:

```
field-cache: could not read jobs/.field-cache.json — starting clean
```

**What to do:**

1. **Check for that line** in the error output of whatever ran. If it is there,
   the discard is your explanation and there is nothing to fix — the cache
   rebuilds itself as you apply to boards again.
2. **If you see it repeatedly**, the file on disk is being written by a build
   with a different `CACHE_VERSION`. That should not happen on one machine;
   check you are not running from two checkouts.
3. **If there is no such line and the cache still misses**, the key is not
   matching. The key is a fingerprint of the applicant-tracking system's id, the
   **host** the form was served from, and the **required** field labels, sorted.
   Optional fields (equal-opportunity blocks especially) come and go between
   postings and are excluded on purpose. Two postings by the same employer on the
   same host share a key; two employers on the same host do **not** get separated
   by the host alone — path-based tenancy (`.../<employer>/jobs/<id>`) still
   collides. Closing that would over-fragment embedded forms into a cache that
   never hits, which is the same silent-amber failure described above. That
   trade-off is named rather than taken quietly.
4. **To drop one form's remembered shape deliberately**:
   ```bash
   node scripts/apply/fill-plan.mjs <slug> --invalidate
   ```
   Use it when the fill engine reports a verify mismatch on a field whose options
   came from the cache.
5. **To skip the cache for one run** without dropping anything: `--no-cache`.

**Reading the cache statistics.** The plan's summary line carries them:

```
cache=4/7 miss=1 fp=a1b2c3d4e5f60718 disclose=3/8
```

`cache=hits/total`, then `miss=N`. The `miss` count exists because a field the
cache has never seen **and** this scan did not probe used to vanish from the ratio
entirely — so a brand-new form and an all-text form both printed `cache=0/0` and
were indistinguishable.

---

### Symptom: a lock file is stuck, or a command times out with `ELOCKTIMEOUT`

A script hangs for twenty seconds and then reports it could not acquire a lock,
or you can see a `.lock` file sitting in `jobs/` with nothing running.

#### Cause

A **lock** here is a small file whose existence means "one process is currently in
the middle of a read-modify-write and nobody else may start one".

The mechanism is one system call: `fs.openSync(path, "wx")` — create this file
**exclusively**, or fail. That single call's atomicity _is_ the lock. Nothing else
about it is clever.

It exists because of a measurement, not a theory. Six concurrent
`save-answer.mjs` writers over five trials lost between one and three of the six
answers in four of them, and **every process exited `0`**. Read-modify-write over
a whole file has no serialisation of its own: the last writer wins and the losers
report success. The same shape is live in the lead store, where `upsertLeads`
rewrites every lead in one transaction, so a manual sweep overlapping a scheduled
one silently drops a set of counters. SQLite's own busy timeout does not help
there, because both writers are individually well-formed transactions — the loss
is in the **read** that preceded them.

**The failure a lock introduces** is a lock file that outlives its holder and
wedges the resource forever. So staleness recovery is not a nicety; it is what
makes the lock survivable. A guard that wedges the fact base gets deleted by its
owner, and a deleted guard protects nothing.

**Exactly one rule breaks a lock:** a lock whose modification time is older than
`staleMs` is abandoned and may be broken. **Nothing else breaks a lock.**

That is worth stating so bluntly because the obvious second mechanism caused the
exact bug the lock exists to prevent. The first version also broke a lock when
asking the operating system "is the process that wrote this still alive?" got the
answer no. A/B test on that single variable, 20 writers × 5 trials, four
repetitions:

```
with the process probe    LOST 7,2,13,9    MUTEX-VIOLATIONS 43,28,25,33
without it (age only)     LOST 0,0,0,0     MUTEX-VIOLATIONS  0, 0, 0, 0
```

Instrumented over 112 breaks: the process-probe branch fired 112 times out of
112, the age branch zero times, and in every one of the 112 the record read
before the break was **not** the record the break took. Every single break
destroyed a _different, live_ holder's lock, at an age of zero milliseconds.

The probe was not lying about the process. What was wrong was the **inference**:
"the process that wrote this record is no longer running" does not imply "this
lock file is abandoned", because a short-lived command-line writer's process ends
milliseconds after it acquires, and the lock file you are looking at may already
belong to a different holder. An invalid inference cannot be repaired by guarding
it, so the probe was deleted rather than gated.

**The cost, stated plainly:** a holder killed mid-operation blocks other waiters
for up to `staleMs` instead of for milliseconds. That is the price of not letting
the recovery path cause the bug it recovers from.

#### Fix

**The defaults** (in `scripts/lib/lock.mjs`):

| Constant             | Value    | Meaning                                     |
| -------------------- | -------- | ------------------------------------------- |
| `DEFAULT_STALE_MS`   | `10_000` | A lock older than 10 seconds may be broken. |
| `DEFAULT_TIMEOUT_MS` | `20_000` | Give up waiting after 20 seconds.           |
| `DEFAULT_POLL_MS`    | `12`     | How often a waiter re-checks.               |

**Timeout must exceed staleness, and `acquire` asserts it.** Shipping a 10-second
timeout with a 30-second staleness window meant a default caller could never
reach the staleness window at all — measured as `ELOCKTIMEOUT after 10153ms` with
the orphaned lock still sitting there untouched. That inversion is why the
destructive process-probe looked load-bearing: it was covering for a recovery
path that could not run.

**The lock paths:**

| Constant              | Path                  |
| --------------------- | --------------------- |
| `lockPathFor(target)` | `<target>.lock`       |
| `LEADS_LOCK`          | `jobs/leads.db.lock`  |
| `AUTO_RUN_LOCK`       | `jobs/.auto/run.lock` |

**What to do:**

1. **Wait ten seconds and retry.** The overwhelming majority of the time this
   resolves itself, because the holder is alive and finishing.
2. **If it does not resolve**, check nothing is running. On Windows, look for
   `node.exe` processes in Task Manager. If a real writer is running, waiting is
   correct.
3. **If nothing is running and the file persists**, you may delete it yourself.
   You are the one mechanism that is allowed to judge a lock dead on evidence
   other than age, because you can look:
   ```bash
   rm jobs/leads.db.lock
   ```
4. **If `save-answer.mjs` exits `5`**, that is the lock timing out and **nothing
   was written**. It is retryable and safe to repeat.

**One implementation detail worth knowing if you rebuild this.** Breaking a lock
is done by **renaming** it to a unique name, not by deleting it. When N waiters
all judge the same lock stale, exactly one rename succeeds and the other N−1 get
a "no such file" error and go back to polling. Nobody ever unlinks a path another
waiter may have just re-created. And the breaker **re-ages what it actually
took**: between the check that judged the lock old and the rename that takes it,
the holder may have released and a new writer acquired — a file that turns out to
be fresh goes straight back via an atomic create-or-fail link, so the restore can
never clobber a lock created since.

---

### Symptom: a run crashed mid-application, and now one company is blocked

A run stopped unexpectedly. Now a file has appeared under `jobs/.auto/stops/` and
that company's jobs will not run.

#### Cause

This is an **orphaned submit attempt**, and the machinery around it is one of the
more carefully reasoned parts of the system.

`scripts/auto/submit.mjs` writes the durable "I am about to click" row **before**
the click, because _an attempt is a submission until proven otherwise_. So a
process killed between the click returning and the acknowledgement being written
leaves a row saying an application **may** exist at an employer, with nothing able
to say whether it does.

The realistic scenario is mundane: Windows Task Scheduler has a one-hour
execution limit, and it kills the process one second after a submit click. The
application is now sitting in the employer's system. Nothing acknowledged it,
nothing closed the run — and without a brake, the next run would find "not yet
applied" and apply again. **Carpet-bombing one employer is the reputational
damage that actually costs you something**, and it would arrive through a crash
rather than through a bug in the caps.

`assertNoOrphanAttempts()` in `scripts/auto/audit.mjs` runs at the **start** of
every run and files a brake. Two outcomes:

- **The orphan names a company.** A **company-scoped** STOP is filed at
  `jobs/.auto/stops/company/<key>`. That company's jobs will not run. Every other
  company keeps running.
- **The orphan names no company.** A **global** STOP is filed at
  `jobs/.auto/STOP` and the run throws. A brake has to be filed against
  something, and "we do not know which employer may hold an application" is not a
  case to be optimistic about.

The company scoping is a deliberate narrowing. This used to raise a global STOP
unconditionally, so one undecidable orphan on one employer halted every future
invocation until a human deleted a file — right at three applications a night and
badly wrong at nine hundred, because the blast radius of the halt scaled with the
run and the trigger did not. **Nothing about the actual protection is weaker:**
the damage being prevented is a second application to _the same_ employer, and a
company-scoped brake blocks exactly that, for exactly as long.

**There is deliberately no `clearStop()`, at any scope.** Self-disabling is the
real rollback — an application cannot be unsent — so re-enabling is your act, by
deleting the file. Code that can clear its own brake does not have one.

#### Fix

**Step 1 — find out what is braked.**

```bash
node scripts/status.mjs
```

The digest reports active board pauses, active stops and queue depth. Or look
directly:

```bash
ls jobs/.auto/STOP jobs/.auto/stops/company/ jobs/.auto/stops/board/ 2>/dev/null
```

**Step 2 — read the brake file.** It is plain text and it tells you exactly what
happened and what to do:

```
STOPPED 2026-08-04T02:22:45.121Z
scope: company
key: Northwind Logistics (filed as northwind-logistics)
a submit attempt from a run that never finished may already be an application at Northwind Logistics:
  - northwind-fullstack (Northwind Logistics, live) attempted 2026-08-04T02:21:58.004Z at https://boards.greenhouse.io/northwind/jobs/8098945
Check that page, log or withdraw as appropriate, then delete this file. Other companies are unaffected and will keep running.

The unattended runner set this itself. Jobs on this company will not run until this file is deleted.
```

**Step 3 — go and look.** Open the URL in the brake file. This is the step no
program can do for you, and the reason is in the next section.

**Step 4 — record what you find.**

- **The application went through:** log it, so the caps and the already-applied
  check know about it.
  ```bash
  node scripts/applications/log-application.mjs <slug>
  ```
- **It did not:** nothing to log.

**Step 5 — delete the brake file.** That is the only way it clears.

```bash
rm "jobs/.auto/stops/company/northwind-logistics"
```

**The scoped STOP is not the same thing as the breaker's board pause**, and
confusing them will cost you time. The **pause** is a timed backoff the anomaly
breaker applies to a board, and it clears itself after one success. A **scoped
STOP** is a durable brake that only a human clears. They live in different
places and mean different things.

#### Why a program cannot do step 3 for you

`scripts/auto/reconcile.mjs` exists to resolve an orphan by re-reading the
board — and it ships **descoped to the boards that can answer**, which on the
recommended allowlist is **none of them**:

- **Lever** hosted boards: no candidate login, no already-applied state.
- **Ashby** hosted boards: the same.
- **Greenhouse**: exposes it only through a MyGreenhouse account, which needs
  exactly the logged-in session the design excludes as a structural security
  control (the browser carries no session cookie to a board, on purpose).

So `reconcile()` returns `undecidable` for all of them, which brakes **one
company** and lets the other 998 run — the real win, and the only one available.

Two rules bound it, and both matter. **It never clicks a control** — it re-opens
a URL and reads; a reconciler that could click could re-submit the very
application it was sent to ask about, which is the one irreversible mistake in
this subsystem, and `tests/auto/click-surface.test.mjs` enforces the absence.
**It never resolves optimistically** — `undecidable` is the default and every
error path lands on it: a navigation timeout, an unparseable page, a board with
no probe, a probe that throws. Resolving an orphan to "not sent" releases the
claim and lets the runner apply to that posting again, so guessing "probably not
sent" is guessing in the direction of a duplicate application.

Even `posting-gone` reads as `undecidable`, and that is not conservatism for its
own sake: a job requisition taken down **after** a successful submit looks
identical to one taken down **before** it.

> **Known defect (2026-08-05 audit).** `reconcile.mjs` has **no command-line
> interface and no production caller**. A search for `reconcileAll` or
> `reconcileOne` across the whole repository finds only the module itself and its
> test file. The orphan handling that actually runs today is
> `assertNoOrphanAttempts()` at run start, described above, which brakes
> companies and tells you which page to check. Do not read `reconcile.mjs` in a
> file listing and conclude orphans are automatically resolved.

> **Known defect (2026-08-05 audit).** A job resumed after a crash loses its
> apply URL. The `auto_queue` table has no `apply_url` and no `company` column,
> and the only source of the URL is the current invocation's selection — which
> diverges from the resumed set when a crashed 25-job run is restarted with a
> smaller limit. A resumed slug with no URL fails the trust gate with "the lead
> carries no apply_url" and is written as a **terminal** deferral that is never
> retried, blaming URL canonicalisation for what is actually a missing column.

---

## Part 6 — The unattended runner

### Symptom: every real board classifies as `unclassified`

A submit went through, the page came back, and the classifier said
`unclassified`. The run stopped. This happens on every real board, every time.

#### Cause — this is correct, and it is the one remaining hard stop

`scripts/auto/classify.mjs` types the page that comes back after a submit click.
It is a **pure function** over `(url, html)`: no network, no database, no model,
no clock. Same bytes in, same answer out, forever.

It can return exactly seven kinds:

```
confirmation, identity-verification, bot-challenge, email-code-challenge,
posting-gone, error, unclassified
```

**The asymmetry that decides every rule in it.** The two ways to be wrong are not
equally bad:

- **Saying `confirmation` when nothing was submitted loses an application
  silently.** The queue row goes to "submitted", the caps count it, the digest
  reports it as sent, and you never apply to that posting again. **There is no
  later signal that corrects this.** It is the worst outcome available.
- **Saying anything else when it _was_ a confirmation costs one human look at one
  URL.** It cannot cause a duplicate application, because the claim row was
  written before the click and a second attempt on that slug is refused.

So `confirmation` is the hardest kind to earn, every blocking signal is tested
before it, and `unclassified` is the **default**.

**Why every rule carries its evidence.** The design requires the classifier's
corpus to be **real** confirmation, identity-verification, bot-challenge,
email-code, error and not-a-confirmation pages. Writing _"if the HTML says 'thank
you for applying' it is a confirmation"_ from memory is the forbidden guess with
the model removed and this repository's imagination left in — and it fails
**silently** instead of expensively.

So every rule declares where its evidence came from, and that provenance **bounds
where it may fire** (`ruleApplies` in `scripts/auto/classify.mjs`):

- `evidence.source === "fixture"` — justified by a page in `tests/fixtures/`,
  which this repository wrote. It may fire **only on loopback** (`127.0.0.1`,
  `localhost`). It is evidence about the fixture and about nothing else.
- `evidence.source === "capture"` — justified by a real post-submit page from an
  attended apply, redacted and promoted into the corpus by you. It may fire on
  the hosts its capture came from.

**Every shipped rule today is `fixture`-sourced.** You can check:

```bash
cat tests/fixtures/post-submit/corpus.json
```

```json
{ "samples": [] }
```

The corpus is empty. So on a real board, `ruleApplies` returns false for every
rule, no rule is even evaluated, and you get:

```json
{
  "kind": "unclassified",
  "rule": null,
  "why": "no rule with evidence for this host recognised the page after the click — this repository holds no captured post-submit page for boards.greenhouse.io, so nothing may conclude what it says"
}
```

That message is the system correctly reporting that **nothing in this repository
has ever seen what that board says after a submit**.

The loopback restriction is itself carefully drawn: the host match is a whole-host
match, never a prefix. `127.0.0.1.evil.test` _starts with_ `127.` and is an
ordinary domain somebody can register a subdomain of; under a prefix check it
would read as loopback and a fixture-sourced rule — this repository's guess about
what a confirmation says — could decide a page served by a stranger.

#### Fix — capture a real post-submit page

The only lawful source is **your own attended applies**. You are on the submit
button for every application today, so the pages exist; they are simply not being
kept. `scripts/apply/capture-post-submit.mjs` keeps them.

**It is three steps, and one step would be simpler and wrong.** A confirmation
page carries your name, your email, often your phone and address, and an
application reference that identifies you to that employer. The committed corpus
lives in git and goes wherever this repository goes. So the boundary between "on
this machine" and "in the repository" is a step **you** take deliberately, after
reading the bytes.

**Step 1 — stage.** Right after your click. This redacts, writes to a gitignored
directory under `jobs/`, and **refuses** if any known identifier survived the
redaction:

```bash
node scripts/apply/capture-post-submit.mjs stage \
  --url "https://boards.greenhouse.io/northwind/confirmation" \
  --html-file /path/to/saved-page.html \
  --board greenhouse --slug northwind-fullstack
```

```
staged 2026-08-07T16-24-32-c99c45 (48210 bytes, redacted)
  3x email
  1x phone

Read it before promoting:
  node scripts/apply/capture-post-submit.mjs review 2026-08-07T16-24-32-c99c45
```

Redaction is **checked, not assumed**: the script re-reads its own output and
throws if any identifier from the fact base is still present. A redactor that
silently missed a pattern is worse than no redactor, because the staging
directory's whole purpose is to be the thing that was safe to look at.

**Step 2 — review.** This prints the redacted page's visible text, so you read
what you are about to publish rather than trusting a summary of it:

```bash
node scripts/apply/capture-post-submit.mjs review <id>
```

With no id, it lists everything staged.

**Step 3 — promote.** This copies it into the committed corpus, and only with an
explicit flag. **You say which kind it is** — "what does this page mean" is
exactly the judgement that is kept away from anything automatic:

```bash
node scripts/apply/capture-post-submit.mjs promote <id> \
  --kind confirmation --user-approved
```

Staged captures live in `jobs/.auto/post-submit/` (gitignored). The corpus lives
in `tests/fixtures/post-submit/` with its manifest at `corpus.json`.

Once a capture is promoted, a `capture`-sourced rule can be written for the hosts
that capture came from, and that board stops classifying as `unclassified`.

#### What NOT to do

Do not write a plausible-looking regular expression. It is the same guess rule 0
forbids, with the model removed, and it fails in the one direction that cannot be
recovered: a page misread as a confirmation records an application that was never
sent, and **nothing later corrects it**.

> **Known defect (2026-08-05 audit).** The redaction step never reads your banked
> answers, because it looks for a `value:` key in `profile/answers.yaml` while
> every entry — real and fixture — carries `answer:`. So a banked mailing address
> or second email is never in the identifier list, and the "redaction is checked,
> not assumed" guarantee cannot catch it either. Read the staged text carefully
> at the review step until this is fixed.

#### A related note on what the runner's state actually is

> **Known defect (2026-08-05 audit).** `CLAUDE.md`'s rule 6 asserts that nothing
> opens a browser unattended, that `auto-apply.mjs` does not launch Chromium, and
> that the limits file has neither `enabled: true` nor a board allowlist. **All
> three are now false.** `auto-apply.mjs` calls `makeStages()` and
> `launchBrowser()`, which launches Chromium; and `docs/application-limits.yaml`
> reads `enabled: true` / `dry_run: false` with four allowlisted domains
> (`boards.greenhouse.io`, `job-boards.greenhouse.io`, `jobs.lever.co`,
> `jobs.ashbyhq.com`), so the mode resolves to `live`. Rule 6 itself warns that
> this paragraph "has already been wrong four times that way". State capability
> from the code, not from that paragraph. The limits file is yours; nothing here
> proposes editing it.
>
> What still holds regardless: the post-submit classifier is the hard stop
> described above, and `submit.mjs` refuses a live submit outright without one.

---

## How to get more detail

### Scripts that speak `--json`

`--json` prints one complete structured record instead of either the prose or the
compact form. Use it when you want every field, when you want to save the output,
or when a compact line has clearly dropped something you need.

These accept it:

**Leads** — `find-boards.mjs`, `discover-boards.mjs`, `board-yield.mjs`,
`canonical.mjs`, `cluster.mjs`, `gate-audit.mjs`, `prep-queue.mjs`,
`recommend.mjs`, `screen.mjs`

**Documents** — `assemble-resume.mjs`, `ats-lint.mjs`, `keyword-plan.mjs`,
`letter-plan.mjs`, `reuse-check.mjs`. (`verify-claims.mjs` always prints JSON.)

**Apply** — `answer-bank.mjs`, `auth-sync.mjs`, `automatability.mjs`,
`fill-plan.mjs`, `pending-questions.mjs`

**Auto** — `auto-apply.mjs`, `cycle.mjs`, `preflight.mjs`

**Applications and profile** — `applications.mjs`, `follow-ups.mjs`,
`save-answer.mjs`, `keyword-coverage.mjs`, `profile-gaps.mjs`

**Maintenance and whole-pipeline** — `archive.mjs`, `prune-jobs.mjs`,
`status.mjs`

**Benchmarks** — `bench-apply.mjs`, `bench-green-prevalence.mjs`,
`bench-runner.mjs`, `flake-rate.mjs`

**Never pass `--verbose` from an automated tool call.** Scripts are terse for
agents automatically; asking for prose from a tool call is pure cost.

### Where the audit trail lives

There are **five** durable records, and each answers a different question.

**1. `jobs/.auto/runs/<run-id>.jsonl` — the run log.** Append-only text, one JSON
object per line, flushed per event (not batched, because a run that dies is
precisely the run whose last event matters most). **This is the copy that
survives**: `jobs/leads.db` is gitignored, has no on-disk source for anything it
alone holds, and a database file is exactly the thing that is unreadable at the
moment you need it most.

**2. The `auto_runs` and `auto_submissions` tables in `jobs/leads.db`.** These
exist because the run log cannot be **queried**, and "how many applications have
gone to this company in the last seven days?" has to be answered cheaply, before
the next submit, or the per-company weekly cap is decoration.

**Neither copy is derived from the other. A record present in one and absent from
the other is itself a finding.**

`auto_submissions` is keyed `(slug, mode)`. Both obvious alternatives have been
tried and both are wrong in opposite directions, so do not "simplify" it back:
`(run_id, slug)` let the same posting be submitted **once per run** with no
conflict at all — backwards for a row whose job is to refuse a duplicate;
`(slug)` alone breaks the rehearsal, because dry-run rows live in this table on
purpose so their cap arithmetic is the same code a live run uses, and under a
bare slug key a dry run would **pre-consume the live claim forever**.

**3. The `verifications` table.** Which documents passed `verify-claims`, against
which exact bytes and which exact fact base. This is what makes "verified" a
checkable claim rather than an assurance.

**4. `jobs/.gate-baseline.json`.** The last `gate-audit.mjs` result, so the next
gate change has something to diff against. Lives under `jobs/` because that
directory is already gitignored and this is derived state about your own lead
store, not project source.

**5. `jobs/.auto/INBOX.md`.** The alert channel. Every brake writes here, whether
or not the brake was already set — the second STOP of a run is the one most
likely to be the serious one, and it is the one the brake file will never
mention.

### How to read a run log

Every unattended run writes one file. They are plain text; open one in any
editor, or read the first few lines:

```bash
ls jobs/.auto/runs/
head -6 "jobs/.auto/runs/2026-08-07T16-24-32-417Z-c99c45.jsonl"
```

Here is a real, complete run — a one-job dry run against a loopback fixture,
lightly wrapped for reading:

```json
{"at":"2026-08-07T16:24:32.430Z","t":"run.start","run_id":"2026-08-07T16-24-32-417Z-c99c45",
 "mode":"dry_run","profile":{"profile.yaml":"b43ff166…","answers.yaml":"59418120…"},
 "meta":{"concurrency":1,"queued":1}}

{"at":"2026-08-07T16:24:32.452Z","t":"job.begin","run_id":"…-c99c45",
 "slug":"fixture-analytics-fullstack","company":"Fixture Analytics","tier":null}

{"at":"2026-08-07T16:24:35.994Z","t":"submit.attempt","run_id":"…-c99c45",
 "slug":"fixture-analytics-fullstack","company":"Fixture Analytics","title":"Full-Stack Engineer",
 "mode":"dry_run","plan_sha256":"b0c57759…",
 "apply_url":"http://127.0.0.1:52623/boards.greenhouse.io/fixture-analytics/jobs/2000001",
 "outcome":"attempted","submitted_at":"2026-08-07T16:24:35.993Z",
 "authorized":{"nonce":"ea3aba7e…","issued_at":"2026-08-07T16:24:35.986Z"}}

{"at":"2026-08-07T16:24:36.004Z","t":"submit.rehearsed","run_id":"…-c99c45","mode":"dry_run",
 "checks":["token_live","token_slug","token_plan_sha","token_mode","page_origin","queue_claimed",
           "durable_attempt","plan_clean","stop_clear","board_trusted","document_verified"],
 "rehearsal":true,"confirmation_url":null,"outcome":"submitted"}

{"at":"2026-08-07T16:24:36.053Z","t":"run.finish","run_id":"…-c99c45","outcome":"ok",
 "planned":1,"submitted":1,"deferred":0,"failed":0,"unresolved_attempts":[],
 "profile":{"profile.yaml":"b43ff166…","answers.yaml":"59418120…"},"profile_mutated":false}
```

**How to read it:**

- `t` is the **event type**. `run.start`, `job.begin`, `submit.attempt`,
  `submit.rehearsed` (or the live equivalent), `run.finish`.
- `mode` is `dry_run` or `live`. A dry run rehearses everything including the
  gates and writes the same rows; it does not click.
- **`profile` appears at both ends of the run**, holding a hash of each fact-base
  file. Comparing `run.start` to `run.finish` is what makes `profile_mutated:
false` a **checkable claim** rather than an assurance. Nothing on this path
  writes `profile/`; the hashes exist so that statement can be verified.
- **`submit.attempt` is written BEFORE the click.** `outcome: "attempted"` is the
  durable intent. If the log ends here, you have an orphan — see the crash entry
  above.
- **`checks`** on the submit event lists every gate that passed, by name. Eleven
  of them in this run. If a submit was refused, the refusal names which check
  said no.
- `unresolved_attempts` on `run.finish` is the list of orphans. Empty is good.
- `plan_sha256` and `nonce` bind the click to the exact plan that was authorised:
  a token minted for one plan cannot authorise a different one.

**Every string in this file has been scrubbed of instruction-shaped text before
being written** (`scripts/auto/untrusted-text.mjs`). The reason is hard rule 0:
this record is the one artefact of an unattended run that a human later hands to
a model, and rule 0 does not stop applying because the page text has been through
a database.

### The whole-pipeline digest

```bash
node scripts/status.mjs
node scripts/status.mjs --json --days 7
```

`status.mjs` reports **progress, not recency**, and the distinction is the whole
point. A digest saying "3 applications submitted in the last 24 hours" is
compatible with a queue of 900 that has not moved since Tuesday, a board paused
since 02:14, and a STOP nobody noticed. The most informative number in it is
**queue depth**: a depth that is not falling is the clearest statement the
unattended path can make about itself.

It decides nothing. It reads rows and computes statistics; the brake, the caps
and the trust gate live elsewhere and are not consulted.

### One-line index of the diagnostic commands

| Question                                   | Command                                                                                 |
| ------------------------------------------ | --------------------------------------------------------------------------------------- |
| Is anything broken right now?              | `node scripts/status.mjs`                                                               |
| Did my change lose me any jobs?            | `node scripts/leads/gate-audit.mjs`                                                     |
| Are my job boards alive?                   | `node scripts/leads/manage-sources.mjs verify`                                          |
| Is this board worth keeping?               | `node scripts/leads/board-yield.mjs --json`                                             |
| Is this document truthful?                 | `node scripts/documents/verify-claims.mjs resume <file> --job <job.json>`               |
| What will be filled, and what defers?      | `node scripts/apply/fill-plan.mjs <slug> --json`                                        |
| What questions am I owed, across all jobs? | `node scripts/apply/pending-questions.mjs`                                              |
| Did I already apply here?                  | `node scripts/applications/check-applied.mjs "<company>"`                               |
| Does the suite actually prove anything?    | `npm test`                                                                              |
| Does this file contain an invisible byte?  | `node -e "console.log(require('fs').readFileSync(process.argv[1]).includes(0))" <file>` |

---

## Where to go next

**Operating**

- [01-commands.md](01-commands.md) — the full command catalogue: every script,
  every flag, every exit code. The lookup to pair with this document's
  diagnoses.
- [02-recipes.md](02-recipes.md) — the twelve tasks you actually perform, start
  to finish. Recipe 12 walks the lead funnel in more depth than Part 3 here.
- [04-config-reference.md](04-config-reference.md) — every key in
  `docs/application-limits.yaml`, `docs/job-sources.yaml` and `.env`, and what
  reads each one. Several fixes above end in a configuration change; this is
  where you check what a key actually does before changing it.

**Understanding the thing that broke**

- [../guide/07-safety-model.md](../guide/07-safety-model.md) — the hard rules,
  what each one prevents, and the incidents behind them. Read this before
  loosening any gate described above.
- [../guide/06-data-model.md](../guide/06-data-model.md) — every table and
  column, and which files are the record versus generated exports. Essential
  before you edit anything under `jobs/` or `profile/`.
- [../guide/05-architecture.md](../guide/05-architecture.md) — how the pieces
  fit and why the boundaries fall where they do.
- [../guide/08-glossary.md](../guide/08-glossary.md) — every term used above,
  defined once.
- [../guide/03-programming-basics.md](../guide/03-programming-basics.md) — exit
  codes, standard output versus standard error, globs, hashes, and the other
  mechanics this document assumed.

**Fixing it properly**

- [../code/05-documents.md](../code/05-documents.md) — `verify-claims.mjs` rule
  by rule, in full mechanical detail, plus the keyword lexicon behind R6 and R8.
- [../code/07-apply-planning.md](../code/07-apply-planning.md) — `fill-plan.mjs`,
  the answer bank and every defer reason.
- [../code/08-apply-filling.md](../code/08-apply-filling.md) — the fill engine,
  the upload readback and the verify pass.
- [../code/06-apply-scanning.md](../code/06-apply-scanning.md) — the page
  scanner, dropdown probing and the field cache.
- [../code/03-leads-screening.md](../code/03-leads-screening.md) — the four
  stages and `gate-audit.mjs`.
- [../code/10-auto-safety.md](../code/10-auto-safety.md) — the classifier, the
  stop scopes, the breaker, the orphan path and `reconcile.mjs`.
- [../code/12-harness-and-ci.md](../code/12-harness-and-ci.md) — the hooks, the
  test gate and the CI workflows.
- [../code/14-tests.md](../code/14-tests.md) — what the suite covers and, more
  usefully, what it does not.
- [../code/00-file-index.md](../code/00-file-index.md) — every file in the
  repository, one line each, when you know the symptom but not the file.
