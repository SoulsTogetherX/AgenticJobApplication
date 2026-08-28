# The harness: guardrails, configuration and the build

Every other document in this set describes code that does the job — finding
postings, tailoring documents, filling forms. This document describes the code
that keeps that code honest. It covers five **hooks** (small programs that can
refuse a tool call before it happens), the **test gate** that refuses to believe
a green test run without counting the tests, the **CI pipeline** that runs all
of it on someone else's computer every time you push, and the dozen small
configuration files that decide what gets committed, what gets formatted and
what a browser session is allowed to remember.

None of this makes the product work. All of it makes the product _provable_.
The recurring theme, stated in half a dozen different code comments in half a
dozen different words, is this: **a check that cannot fail is not a check**, and
the most dangerous failure in the whole repository is a green light over
something nobody looked at.

**What you will learn here**

- What a hook is, why it is enforcement an AI cannot argue with, and exactly
  what each of the five hooks denies and lets through.
- Why `src/hooks/*` may be edited by an agent while `.claude/hooks/*` and
  `.claude/settings.json` may not — and why `settings.json` in particular is
  sealed.
- Why `npm test` is not `node --test`, what the `testGate` floors in
  `package.json` mean, and how to raise a floor honestly.
- What each of the six CI jobs does, including the scaffolding reaper's
  `scaffolding: true` / `remove_after` contract and the performance gate's
  five rules.
- What every dotfile is for, and which three lines in them are load-bearing
  contracts you must not "tidy up".
- The defects that exist in this area right now, marked as such.

**Before this**

You do not need any of these to follow this document, but they help:

- [`../guide/02-computer-basics.md`](../guide/02-computer-basics.md) — files,
  paths, processes, exit codes.
- [`../guide/03-programming-basics.md`](../guide/03-programming-basics.md) —
  functions, JSON, regular expressions.
- [`../guide/04-ai-and-agents.md`](../guide/04-ai-and-agents.md) — what a
  "tool call" is and why an agent needs guardrails at all.
- [`../guide/07-safety-model.md`](../guide/07-safety-model.md) — the ten hard
  rules these hooks enforce mechanically.
- [`14-tests.md`](14-tests.md) — the test suite the gate in this document
  measures.

**The files covered here**

| file                                    | lines | one-line purpose                                                                |
| --------------------------------------- | ----- | ------------------------------------------------------------------------------- |
| `.claude/hooks/protect-profile.js`      | 55    | denies Edit/Write to the fact base and to the guardrail machinery               |
| `.claude/hooks/guard-profile-shell.mjs` | 239   | denies the same targets when reached through a shell command instead            |
| `src/hooks/guard-bash.mjs`              | 608   | denies any git command that leaves, or acts outside, the `dev` branch           |
| `src/hooks/guard-files.mjs`             | 60    | denies any write whose path lands outside the project directory                 |
| `src/hooks/prettify.mjs`                | 71    | runs prettier on every file the agent edits (never blocks)                      |
| `.claude/settings.json`                 | 54    | wires all five hooks and holds the permission allowlist                         |
| `package.json`                          | 74    | npm manifest, the `testGate` floors, and the phase list the reaper reads        |
| `tools/ci/test-gate.mjs`                | 505   | runs the suite and asserts the run _proves_ tests executed                      |
| `.github/workflows/ci.yml`              | 324   | the GitHub Actions pipeline: six jobs, one required check                       |
| `tools/ci/scaffolding-reaper.mjs`       | 592   | fails the build when temporary dev-only code outlives its declared phase        |
| `tools/ci/perf-gate.mjs`                | 345   | fails the build on a measured performance or model-usage regression             |
| `tools/ci/report-browsers.mjs`          | 41    | prints which browser this machine has, so a skipped PDF test is attributable    |
| `.gitignore`                            | 61    | keeps personal data and cookies out of git — and keeps test inputs in           |
| `.gitattributes`                        | 5     | forces LF line endings in every working tree, on every platform                 |
| `.prettierrc`                           | 4     | two settings: no semicolons, LF line endings                                    |
| `.prettierignore`                       | 37    | five housekeeping entries plus the rest, each a contract with its reason        |
| `.mcp.json`                             | 17    | declares the Playwright browser server and its persistent profile               |
| `.env.example`                          | 12    | the committed template for the never-committed `.env`                           |
| `eslint.config.mjs`                     | 309   | ESLint 10, hand-picked rules only — never a preset, and never `no-process-exit` |
| `eslint-suppressions.json`              | —     | the frozen ratchet baseline: 128 files, shrink-only, never widened              |
| `.markdownlint-cli2.jsonc`              | —     | the markdown rule set and corpus, tuned with the measured counts recorded       |
| `scripts/hooks/*.mjs`                   | 10–14 | forwarding shims for the three hook paths the user's sealed config pins         |

The `tests/quality/*` gates that assert all of this — formatting, lint, doc-path
truth, structure, shim parity, YAML validity, markdown — are a decision record in
their own right: [`../guide/09-conventions.md`](../guide/09-conventions.md) says
what each enforces, what was rejected, and what cannot be mechanised at all.

---

# Part 1 — Hooks: enforcement the AI cannot talk its way around

## 1.1 What a hook is

When Claude Code (the program the agent runs inside) is about to use a tool —
edit a file, run a shell command, write a notebook — it can first run a small
program of your choosing and ask it for permission. That small program is a
**hook**.

The mechanics are deliberately simple, and they are the same for all five hooks
in this repository:

1. Claude Code starts the hook as an ordinary operating-system process, exactly
   as if you had typed `node src/hooks/guard-bash.mjs` at a terminal.
2. It writes a small blob of **JSON** (a plain-text data format: `{"key":
"value"}`) into the hook's **standard input** — the same channel you would
   feed with `cat file.txt | some-program`. The blob describes the tool call
   that is about to happen: which tool, which file, which command, which working
   directory.
3. The hook reads that, thinks, and writes **one line of JSON to standard
   output** — the channel that normally shows text in your terminal, but which
   here is a pipe leading back to Claude Code.
4. If that line says `"permissionDecision": "deny"`, the tool call **does not
   happen**. The agent receives the hook's reason as a message instead of a
   result.
5. **If the hook prints nothing at all, the call proceeds.** Silence means "no
   opinion".

There are two events these hooks attach to:

| event         | when it runs                 | can it block?                           |
| ------------- | ---------------------------- | --------------------------------------- |
| `PreToolUse`  | before the tool call         | **yes** — this is the enforcement point |
| `PostToolUse` | after the tool call finished | no — the action already happened        |

This is the whole reason hooks matter. Every other rule in this project lives in
`CLAUDE.md`, a document the model reads and is asked to follow. A model can
misread a document, or be talked out of it by text on a web page, or lose the
relevant paragraph off the end of its context window. A hook is a separate
process with its own code, run by the harness, whose verdict the model never
sees until after it has been made. **It is the one layer that does not depend on
the model behaving.**

The deny message every one of the four `PreToolUse` hooks prints has this exact
shape:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "the prose the agent will see"
  }
}
```

There is no "approve" verdict anywhere in this repository. Every hook either
denies or stays quiet.

### How to test a hook yourself

Because a hook is just a program that reads JSON from standard input, you can
drive one by hand. This is the fastest way to answer "would this be blocked?"
without finding out the hard way. Write a tiny driver in a scratch directory:

```js
// probe-hook.mjs
import { spawnSync } from "node:child_process"

const ROOT = "C:/path/to/AgenticJobApplication"
const payload = JSON.stringify({
  tool_name: "Bash",
  cwd: ROOT,
  tool_input: { command: "git checkout main" },
})
const res = spawnSync(process.execPath, [ROOT + "/src/hooks/guard-bash.mjs"], {
  input: payload,
  encoding: "utf8",
})
console.log(res.stdout.trim() || "(nothing printed = allowed)")
```

Running that prints the real deny payload:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "Only the `dev` branch may be used, but this would move to \"main\". Switch with `git checkout dev` (or `git checkout -b dev`)."
  }
}
```

Every worked example in Part 1 of this document was produced this way, against
the real files, on 2026-08-05.

## 1.2 The two patterns every hook shares

### Pattern one: never call `process.exit()` after printing

Four of the five hook files carry this comment, in these words:

> `// NOTE: no process.exit() after writing — on Windows, exiting immediately`
> `// after console.log drops buffered pipe output, which silently disables the deny.`

This is the single most important mechanical fact in this part of the codebase,
and it is worth understanding rather than memorising.

`console.log` does not put bytes on the far end of the pipe. It hands them to
Node, which flushes them when the event loop next gets a chance. On Windows, a
pipe write is buffered and completed asynchronously. So this code:

```js
console.log(JSON.stringify(denyPayload))
process.exit(0) // <-- WRONG
```

tears the process down while the bytes are still in the buffer. They are
discarded. Claude Code sees **empty output**, reads that as "the hook had no
opinion", and **allows the tool call**. The guard tests perfectly on Linux and
fails open on the machine this project actually runs on.

`guard-profile-shell.mjs` adds one sentence that tells you this is not
theoretical: _"protect-profile.js and guard-bash.mjs both carry this note; it was
a real bug."_

The correct pattern, used by all five: print, then let the function return and
the process end naturally when the event loop drains.

### Pattern two: read all of stdin, strip the BOM, fail open on garbage

Every hook has the same skeleton:

```js
let raw = ""
process.stdin.on("data", (d) => (raw += d))
process.stdin.on("end", () => {
  let input = {}
  try {
    input = JSON.parse(raw.replace(/^\uFEFF/, ""))
  } catch {
    return
  }
  // ... decide ...
})
```

Three things are going on.

- **Input arrives in chunks.** The `data` event fires many times with partial
  text; `end` fires once, when the writer closes the pipe. You cannot parse
  until `end`, because until then you may be holding half a JSON document.
- **`raw.replace(/^\uFEFF/, "")` strips a byte-order mark.** A BOM is an
  invisible marker character some Windows programs put at the start of text.
  PowerShell pipes add one, and `JSON.parse` throws on it. `\uFEFF` is the
  _escape_ spelling of that character. `guard-profile-shell.mjs` explains why it
  is written that way: _"the literal is invisible in a diff and does not reliably
  survive being copied through a chat window, which is how this file now reaches
  the user for hand-application."_ (The two `src/hooks/` files still use the
  literal character. Same behaviour, worse readability.)
- **`catch { return }` means fail OPEN.** If the payload does not parse, the hook
  says nothing and the call proceeds. `guard-profile-shell.mjs` states the
  trade-off under a heading called KNOWN RESIDUALS: _"Fails OPEN on unparseable
  input, matching the sibling hook. A guard that denied every shell command on a
  malformed payload would be worse."_

  `guard-bash.mjs` is the exception in one specific place: if the payload parses
  but its own command _tokenizer_ throws, it falls back to blunt patterns and
  fails **closed**. Those are different situations — a broken payload is the
  harness misbehaving, a command the tokenizer cannot read is exactly the kind of
  input a bypass would look like.

## 1.3 The ownership split — and why `settings.json` is sealed

The five hooks do not have one owner. This is the most important governance fact
in the repository, and it is stated in `CLAUDE.md`:

> The guardrails have two owners. `src/hooks/*` is `ci-engineer`'s and
> **agent-editable**; `.claude/hooks/*` and `.claude/settings*.json` are **the
> user's alone**, sealed on the Edit/Write _and_ shell paths since `e19e87e` —
> `settings.json` included, because it **wires** every hook.

Concretely:

| path                                                                           | an agent may edit it? | sealed on Edit/Write by | sealed on shell by        |
| ------------------------------------------------------------------------------ | --------------------- | ----------------------- | ------------------------- |
| `src/hooks/guard-bash.mjs`                                                     | **yes**               | —                       | —                         |
| `src/hooks/guard-files.mjs`                                                    | **yes**               | —                       | —                         |
| `src/hooks/prettify.mjs`                                                       | **yes**               | —                       | —                         |
| `.claude/hooks/**` (any file, existing or new)                                 | no                    | `protect-profile.js`    | `guard-profile-shell.mjs` |
| `.claude/settings.json`, `.claude/settings.local.json`                         | no                    | `protect-profile.js`    | `guard-profile-shell.mjs` |
| `profile/profile.yaml`, `answers.yaml`, `applications.yaml`, `profile/source/` | no                    | `protect-profile.js`    | `guard-profile-shell.mjs` |

Why is a configuration file on the same footing as the guards themselves?
`protect-profile.js` answers that in its own header, and it is worth quoting in
full because the reasoning is not obvious:

> ```
> // .claude/settings.json is protected for a reason worth stating, because it is
> // not obvious: it WIRES every hook. Disabling a guard never required editing a
> // guard — deleting one line here does it without touching a protected file at
> // all. Sealing .claude/hooks/ while leaving this writable relocates the lock
> // and leaves the door (user decision 2026-07-31, after ci-engineer and
> // guard-profile-shell.mjs's own residuals note flagged it independently).
> //
> // COST, ACCEPTED KNOWINGLY: ci-engineer owns .claude/settings*.json and can no
> // longer edit it. Wiring a new hook, adding a permission, or changing a matcher
> // now needs the user. That is the intended trade — settings.json is precisely
> // where a guardrail gets switched off, so it belongs on the same footing as the
> // guards themselves.
> ```

The other half of the seal was found by _probing_ rather than by reading.
`guard-profile-shell.mjs` records it:

> ```
> // This file was moved from src/hooks/ into .claude/hooks/ so that
> // protect-profile.js would deny agent Edit/Write to it. That move was real but
> // PARTIAL, and the gap was found by probing rather than by reading: the manager
> // ran `"probe" | Out-File .claude/hooks/__probe.txt` and it SUCCEEDED. The
> // Edit/Write door was locked and the shell door was standing open, so an agent
> // could have blanked or rewritten the very guard denying it.
> ```

Two doors, both now locked: the Edit/Write tool path and the shell path. That
pairing is the design idea to carry away — **a protected resource has as many
doors as there are tools that can reach it**, and locking one is locking none.

### The consequence for the 2026-08-27 re-layout: four shims and two carve-outs

Sealing `settings.json` has a cost that only showed up when the code moved.
`settings.json` invokes the three hooks as `node scripts/hooks/<name>.mjs`, and
an agent cannot repoint it. So the hooks live at `src/hooks/` and
`scripts/hooks/` holds three **forwarding shims**:

```js
process.argv[1] = fileURLToPath(target) // BEFORE the import
await import(target.href)
```

**A bare re-export shim silently no-ops and exits 0** — measured 2026-08-27.
`export * from "../../src/hooks/guard-bash.mjs"` runs nothing, because the
target's entry-point guard compares `process.argv[1]` against its own path and
concludes it was merely imported. Exit 0 is what a PreToolUse hook returns to
mean "allowed", so that shape would disarm branch protection while every run
looked normal. Rewriting `process.argv[1]` first is what makes the forward
indistinguishable from direct invocation. The deprecation notice goes to
**stderr**, never stdout — stdout is the hook protocol channel.

A fourth shim — a batch wrapper that used to sit under `scripts/auto/` — did the
same job for the Windows Scheduled Task. It was **deleted on 2026-08-28**, the
same hour the user repointed that task at `src\auto\cycle.cmd`: the intended end
of a shim's life, and the reason the set here is now three. (Its path is written
without an extension on purpose — `docs-links.test.mjs` resolves every path
token in this file, and a deleted file named in full would dangle.)

The two `scripts/profile/*.mjs` files are **not** shims. `guard-profile-shell.mjs`
matches the literal path `scripts/profile/(save-answer|apply-profile).mjs` to
decide that a shell command is a sanctioned fact-base write and then demands
`--file`, `--user-approved` or `--rescan`. A moved file does not match that
regex, does not match the hook's second stage either (which looks for
`profile/answers.yaml` as an operand, not `save-answer.mjs`), and the hook
returns **without denying**. So moving them would not relocate the guard, it
would remove it.

`tests/quality/shims.test.mjs` asserts parity for as long as the shims live —
against a **denial**, not an allowed command, because an adversarial pass showed
a shim that ran nothing still passed the allow-probe (a do-nothing hook also
exits 0 with empty stdout). `tests/quality/structure.test.mjs` asserts `scripts/`
holds exactly that set. Full account:
[`../../scripts/README.md`](../../scripts/README.md).

---

## 1.4 `.claude/hooks/protect-profile.js`

### What it is and why it exists

A `PreToolUse` hook on `Edit|Write|NotebookEdit` that blocks the agent from
writing to the user-owned fact base and to the guardrail machinery.

Without it, hard rule 1 (documents may contain only facts from
`profile/profile.yaml` and `profile/answers.yaml`) would be circular: the agent
could invent a fact, write it into the fact base, and then "verify" the tailored
resume against the file it just edited. The verifier must not be able to edit
what it verifies.

Note the extension: `.js`, not `.mjs`, and it contains no `import` statements at
all. It works regardless of what `package.json`'s `"type"` field says, which
matters for a file that must keep working even if the project's module settings
change.

### How you run or use it

You do not. Claude Code runs it, wired by `.claude/settings.json`. You can probe
it by hand with the driver in §1.1, sending `tool_input.file_path`.

### Everything it exposes

No exports, no flags, no exit codes that matter (it always ends normally). Its
entire interface is the list of protected patterns:

| pattern                                      | blocks                                                                 |
| -------------------------------------------- | ---------------------------------------------------------------------- |
| `/\/profile\/profile\.yaml$/i`               | the fact base                                                          |
| `/\/profile\/answers\.yaml$/i`               | the answer bank                                                        |
| `/\/profile\/applications\.yaml$/i`          | the generated application export                                       |
| `/\/profile\/source\//i`                     | anything under the source-document folder                              |
| `/\/\.claude\/hooks\//i`                     | **any** file in the hooks directory, including files that do not exist |
| `/\/\.claude\/settings(?:\.local)?\.json$/i` | the wiring, and personal wiring overrides                              |

(A _regular expression_ — "regex" — is a compact pattern language for describing
text. `\/profile\/answers\.yaml$` means "the literal text `/profile/answers.yaml`
at the very end of the string"; the trailing `i` means upper/lower case does not
matter.)

### How it works, step by step

1. Collect standard input, strip a BOM, `JSON.parse`. On a parse failure,
   return silently.
2. `const file = String(input.tool_input?.file_path ?? "").replace(/\\/g, "/")` —
   read the target path and **turn every backslash into a forward slash**. This
   is why one list of patterns covers both `C:\...\profile\answers.yaml` and
   `/home/x/profile/answers.yaml`.
3. If the path is empty, return.
4. If any pattern matches, print the deny payload.

Worked example. The agent tries to edit `C:\proj\profile\answers.yaml`:

```
FILE: C:/proj/profile/answers.yaml
OUT : {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny",
       "permissionDecisionReason":"\"C:/proj/profile/answers.yaml\" is part of the user-owned
       fact base / guardrails. Ask the user to edit it, or use
       `node scripts/profile/save-answer.mjs` for new answers."}}
```

Three more real results from the same probe:

```
FILE: C:/proj/src/leads/screen.mjs        OUT: (nothing printed = allowed)
FILE: C:/proj/.claude/hooks/evil-new-hook.js  OUT: denied
FILE: C:/proj/profile-notes.md                OUT: (nothing printed = allowed)
```

The middle one is the interesting one: `evil-new-hook.js` does not exist. The
guard is on the **directory**, not on a list of filenames, so an agent cannot
add a hook of its own alongside the real ones. The last one shows the patterns
require the `/profile/` **directory** segment — a file merely named
`profile-notes.md` is ordinary and stays editable.

### What it reads and writes

Reads: standard input only. Writes: one line of JSON to standard output. It
touches no files.

### Traps and things not to "fix"

- **The deny message names the sanctioned alternative.** That is deliberate: a
  guard that only says "no" trains the agent to look for a way around. This one
  points at `scripts/profile/save-answer.mjs`, which is the only supported way
  anything enters the fact base.

> **Known defect (2026-08-05 audit), inherited from AUDIT M4 and still live.**
> Every pattern begins with `\/`, so a **relative** path with no leading
> separator matches none of them. Probed on 2026-08-05: a `file_path` of
> `profile/answers.yaml` is **allowed**. Claude Code sends absolute paths in
> practice, so this is latent rather than exploited, but it is a fail-open
> default in the project's strictest control. `guard-files.mjs` does the correct
> thing — `path.resolve(root, file)` before comparing — and this hook should too.

### What it depends on, and what depends on it

Depends on nothing (no imports). Wired first in `.claude/settings.json`'s
`Edit|Write|NotebookEdit` list. Tested by `tests/hooks/hook.test.mjs`, and
`tests/hooks/repo-hygiene.test.mjs` asserts it is still wired.

---

## 1.5 `.claude/hooks/guard-profile-shell.mjs`

### What it is and why it exists

The shell-side twin of `protect-profile.js`. It is a `PreToolUse` hook on
`Bash|PowerShell` that denies shell commands which would write to the fact base
or to the guardrail machinery.

Its 75-line header is the best incident write-up in the repository, and the
reason it exists is a pair of real accidents:

> ```
> // protect-profile.js blocks Edit/Write to profile/*.yaml, and guard-bash.mjs
> // guards Bash — but only for git branch policy. A shell command that wrote to
> // the fact base therefore passed BOTH: the Edit guard never saw it (there is no
> // file_path on a Bash call) and the Bash guard did not look. So
> // `node scripts/profile/save-answer.mjs ...` was completely unguarded.
> //
> // Both incidents were the same typo. save-answer.mjs took `--file <path>` and
> // SILENTLY IGNORED unknown flags, so an agent verifying the script's behaviour
> // passed `--answers <tmpfile>`, the flag was dropped, the path fell through to
> // the default, and test values landed in the REAL profile/answers.yaml stamped
> // `source: user`. Four entries across the two incidents. One was a fabricated
> // phone number saved under the label "Phone number" — which resolves OK on
> // nearly every application form, and would have been typed into a real
> // application as fact.
> ```

Read that last sentence again, because it is the whole point of this project's
safety model. The failure was not "a file got dirty". The failure was that a
made-up value acquired the label of a fact, and the pipeline that fills
application forms would have typed it into a real employer's form under the
user's name.

The header is equally clear about what this hook is **not**:

> ```
> // THE THREAT MODEL IS ACCIDENT, NOT A DETERMINED AGENT. Both incidents were
> // agents doing legitimate verification work who never intended to touch the
> // real file. So the rule is that writing to the real fact base must be
> // something you SAY you are doing: `--user-approved` marks the one sanctioned
> // path (the user approved this answer in chat), and a test writes to its own
> // `--file`. Neither incident carried either, so both are denied here. A
> // determined agent could pass the flag — that is what review and CLAUDE.md hard
> // rule 2 are for, and no hook substitutes for them.
> ```

And why reads are untouched:

> `// READS STAY ALLOWED, deliberately and load-bearingly. Agents read the fact`
> `// base constantly — keyword-coverage, answer-bank and verify-claims all do.`
> `// Only write OPERATIONS are matched, never the mere mention of a path.`

### How you run or use it

Claude Code runs it on every `Bash` and `PowerShell` call. Probe it by hand with
the driver in §1.1.

### Everything it exposes

No exports and no flags. Its interface is two sections of matching rules.

**Section 1 — the sanctioned writers.** If the command _executes_ one of the two
scripts that are allowed to write `profile/`:

```js
;/\bnode(?:\.exe)?\b[^|;&]*\bsrc\/profile\/(?:save-answer|apply-profile)\.mjs/i
```

then it must carry at least one of these three flags, or it is denied:

| flag              | pattern                                       | means                                   |
| ----------------- | --------------------------------------------- | --------------------------------------- |
| `--file <path>`   | `/(?:^  \| \s)--file[\s=]/`                   | "this is a test; write somewhere else"  |
| `--user-approved` | `/(?:^  \| \s)--user-approved(?:[\s=] \| $)/` | "the user approved this answer in chat" |
| `--rescan`        | `/(?:^  \| \s)--rescan(?:[\s=]        \| $)/` | "read-only audit of the existing bank"  |

**Section 2 — raw shell writes.** First it decides whether the command names a
protected path at all, using a leading _boundary class_ `(?:^|[\s"'=(,;|&>])` —
the path must start the command or follow whitespace, a quote, `=`, `(`, `,`,
`;`, `|`, `&` or `>`, so that an unrelated word ending in `profile/` cannot
trigger it. Two booleans result:

- `namesProfile` — `profile/profile.yaml`, `profile/answers.yaml`,
  `profile/applications.yaml`, or anything under `profile/source/`;
- `namesGuard` — anything under `.claude/hooks/`, or
  `.claude/settings.json` / `.claude/settings.local.json`.

If neither is true, the hook returns and the command proceeds. If one is true, it
then looks for a **write operation** in four families:

| family             | matched by                                                                                                                                                                                                                               | denial message begins                                                  |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| shell redirection  | `/\d?>>?\s*(?:"\|')?(?:[^\s"']*\/)?(?:profile\/\|\.claude\/(?:hooks\/\|settings))/i`                                                                                                                                                     | "Shell redirection into a protected path."                             |
| POSIX mutators     | `rm mv cp tee truncate shred dd install` as whole words, plus `sed … -i` and `perl … -i`                                                                                                                                                 | "A shell command that writes, moves or deletes files…"                 |
| PowerShell cmdlets | `Set-Content Add-Content Out-File Clear-Content Remove-Item Move-Item Copy-Item New-Item Set-ItemProperty`                                                                                                                               | "A PowerShell cmdlet that writes or removes files…"                    |
| inline programs    | a write API (`writeFileSync`, `appendFileSync`, `createWriteStream`, `writeFile`, `appendFile`, `truncateSync`, `unlinkSync`, `rmSync`, `renameSync`, `copyFileSync`) **and** an interpreter (`node`, `python`/`python3`, `deno`, `bun`) | "An inline program names a protected path and calls a file-write API." |

Every denial ends with one of two explanations, chosen by which target was named:

```js
const OWNED =
  "profile/ is the user-owned fact base (CLAUDE.md hard rule 2). " +
  "Only the user decides what is true about them."

const GUARDED =
  ".claude/hooks/ holds the guardrails and .claude/settings.json wires them. " +
  "An agent that can rewrite either can switch off every other rule, " +
  "so both are the user's alone."
```

### How it works, step by step, with real output

All of the following was produced by probing the real hook on 2026-08-05.

**The exact command shape that caused both 2026-07-31 incidents:**

```
CMD : node scripts/profile/save-answer.mjs --label "Willing to relocate" --value "Yes"
OUT : denied —
      "This writes the REAL fact base, and says neither that it is a test nor that the
       user approved it. profile/ is the user-owned fact base (CLAUDE.md hard rule 2).
       Only the user decides what is true about them.
         - testing?       add `--file <temp path>` so it cannot touch profile/
         - user said yes? add `--user-approved`, only after they approved it in chat
       Two agents wrote fabricated answers into the real file on 2026-07-31 with exactly
       this shape of command. One was a phone number that would have been typed into a
       real application as fact."
```

**The three sanctioned shapes, all allowed:**

```
CMD : node scripts/profile/save-answer.mjs --file /tmp/t.yaml --label X --value Y
OUT : (nothing printed = allowed)

CMD : node scripts/profile/save-answer.mjs --rescan
OUT : (nothing printed = allowed)
```

**Reading is untouched:**

```
CMD : cat profile/answers.yaml                          OUT : allowed
CMD : grep -n label scripts/profile/save-answer.mjs     OUT : allowed
```

That second one is not an accident. The header records that matching a bare
mention of the script denied a `grep` _within a minute of the hook being
written_, and draws the general lesson:

> `// guard-bash.mjs learned the identical lesson when it denied`
> `// git branch --show-current; an over-matching guard gets switched off.`

**Raw writes, all denied:**

```
CMD : echo hi > profile/answers.yaml
OUT : "Shell redirection into a protected path. profile/ is the user-owned fact base…"

CMD : bash -c "rm profile/answers.yaml"
OUT : "A shell command that writes, moves or deletes files names a protected path…"

CMD : Remove-Item .claude/hooks/protect-profile.js
OUT : "A PowerShell cmdlet that writes or removes files names a protected path.
       .claude/hooks/ holds the guardrails and .claude/settings.json wires them…"
```

### What it reads and writes

Standard input in, one line of JSON out. No files. It does normalise
backslashes to forward slashes first (`const c = cmd.replace(/\\/g, "/")`) so
Windows and POSIX paths match the same rules.

### Traps and things not to "fix"

The header lists its own limits under KNOWN RESIDUALS, and they should be
reproduced rather than paraphrased:

> ```
> //   - Fails OPEN on unparseable input, matching the sibling hook. A guard that
> //     denied every shell command on a malformed payload would be worse.
> //   - An arbitrary compiled program that opens a protected file is only caught
> //     when its command line names the path AND a write call (the `node -e`
> //     case). A purpose-built binary is out of scope; see the threat model.
> //   - Neither hook can stop a command that never names the path — a script
> //     that computes it at runtime, or an editor launched interactively.
> //   - A KNOWN FALSE POSITIVE, left in deliberately: `git commit -m "..."`
> //     whose MESSAGE names a guarded path and also contains a mutator word
> //     ("rm", "install") is denied, because the message is part of the command
> //     line and this guard cannot parse shell grammar. Workaround that costs
> //     nothing: `git commit -F <file>`, verified unaffected. Exempting
> //     `git commit` was considered and REJECTED — it would equally exempt
> //     `git commit -m "x" && rm .claude/hooks/y`, which is the whole attack.
> ```

Two more things not to change:

- **`--rescan` is allowed without `--file`, and that is a trust coupling.** The
  comment names the weak point rather than hiding it: _"the hook is trusting
  save-answer.mjs to keep refusing writes under --rescan. If that ever stops
  being true, this line is the hole."_ It was verified before being allowed —
  `answers.yaml`'s checksum is unchanged across a `--rescan` run.
- **`cp`/`mv` match a protected path appearing anywhere on the line**, not only
  as the last argument, _"because it is the DESTINATION that matters and quoting
  makes last-argument parsing unreliable. Copying OUT of profile/ for a backup is
  rare enough that an explained denial beats a silent overwrite."_

### What it depends on, and what depends on it

No imports. Wired second in `.claude/settings.json`'s `Bash|PowerShell` list.
Tested by `tests/hooks/guard-profile-shell.test.mjs`, which includes two cases
about the file's own location: that it exists at the agent-unwritable path, and
that it is inside the directory `protect-profile.js` defends.

---

## 1.6 `src/hooks/guard-bash.mjs`

### What it is and why it exists

A `PreToolUse` hook on `Bash|PowerShell` that enforces hard rule 7: **only the
`dev` branch may be used**. It is by far the largest file in this area (608
lines), and almost all of that length is a hand-written, quote-aware **shell
tokenizer** plus a header that reads as a changelog of everything the simpler
versions got wrong.

The policy in the header's own words:

> `// Only the dev branch may be used: switching/creating any other branch is`
> `// denied, state-changing git commands are denied unless HEAD is already on`
> `// dev, and pushing to main/master is always denied. The user controls how dev`
> `// merges into main.`

And what it deliberately stopped doing:

> `// File create/delete shell commands are no longer blocked here (user decision,`
> `// 2026-07-27): interactive development may manage files freely. The`
> `// job-application flows are restricted to jobs/<slug>/ by their skill`
> `// instructions instead.`

That last sentence matters: the "only write inside `jobs/<slug>/`" rule is
**prose in the skills, not code in a hook**.

### Why it is a tokenizer and not a set of patterns

The first version matched patterns against the raw command string. It failed in
both directions at once:

> ```
> // The regex form over-matched and under-matched at the same time:
> //   OVER — `git branch --show-current` (a read-only query) was denied with
> //   "Branch create/delete/rename is blocked", because the branch rule matched
> //   any `git branch` followed by a dash. Observed in a real session.
> //   UNDER — three ways to leave `dev` slipped through:
> //     git checkout -B main   (-B/-C force-create were not in the create list)
> //     git -C . checkout main (a global option before the subcommand)
> //     git.exe checkout main  (the program-name match required a bare `git`)
> ```

The over-match matters as much as the under-match, and the header says why in
the sibling file: _"an over-matching guard gets switched off"_. A guard that
denies ordinary work is a guard someone will delete.

The rewrite's payoff is stated as an invariant, not a patch:

> `// That also retires a whole bug class the old comment had to warn about:`
> `// "main" inside a commit message is now an argument of commit, not a candidate`
> `// push ref, by construction rather than by a [^;&|]* scoping trick.`

The `git branch` flag lists were **probed against real git**, not read from the
manual:

> `//   - git branch -v probe CREATES branch probe — -v does not imply list mode,`
> `//     so a positional after it is a branch name, not a pattern.`
> `//   - git branch --contains HEAD / --merged=HEAD x / --format x consume their`
> `//     value and never create, so those queries stay allowed.`
> `// Anything not on the allowlist is denied: a guardrail fails closed.`

A second rewrite on 2026-08-03 fixed a subtler error: the guard was asking the
**wrong repository** which branch it was on.

> ```
> //   OVER — a session whose cwd was a worktree on claude/... ran
> //   `git -C <main-checkout> commit`. The main checkout was on dev, i.e. exactly
> //   what this policy wants, and it was denied anyway. The workaround was to
> //   prefix `git -C <main> checkout dev` — a no-op that only set switchedToDev —
> //   so the guardrail was satisfied by a trick rather than by the invariant it
> //   asserts.
> //   UNDER — the mirror, and the one that matters: from a session cwd on dev,
> //   `git -C /other/repo commit` was allowed no matter which branch it was on.
> ```

### Everything it exposes

No exports. Its interface is a set of constants and one decision function.

| constant             | contents                                                                                                   | role                                                                      |
| -------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `INTERPRETERS`       | `bash sh zsh ksh dash ash pwsh powershell ssh su sudo env xargs eval source iex Invoke-Expression`         | a heredoc opened by one of these holds commands, not data                 |
| `SEPARATORS`         | `; \| & \n \r ( ) `` `                                                                                     | characters that end a clause                                              |
| `GIT_PROG`           | `/^(?:.*[\\/])?git(?:\.exe)?$/i`                                                                           | recognises `git`, `git.exe`, `/usr/bin/git`, `C:\Program Files\…\git.exe` |
| `GIT_GLOBAL_VALUE`   | `-C -c --git-dir --work-tree --namespace --exec-path --config-env --super-prefix`                          | options that swallow the next token when looking for the subcommand       |
| `GIT_DIR_OPTS`       | `-C --git-dir --work-tree`                                                                                 | the subset that decides which repository is acted on                      |
| `CREATE_FLAGS`       | `-b -B -c -C --create --force-create --orphan`                                                             | the next token is a new branch name                                       |
| `BRANCH_RO_SHORT`    | `a r v q l i`                                                                                              | read-only single letters for `git branch`                                 |
| `BRANCH_RO_LONG`     | 21 long flags including `--show-current`, `--list`, `--contains`, `--format`                               | read-only long flags                                                      |
| `BRANCH_VALUE_LONG`  | `--sort --format --points-at --contains --no-contains --merged --no-merged --abbrev`                       | these consume the following token as a value                              |
| `BRANCH_LIST_MODE`   | `-l --list --show-current -a --all -r --remotes --contains --no-contains --merged --no-merged --points-at` | in list mode a trailing word is a pattern, not a new branch               |
| `STATE_CHANGING`     | `commit merge rebase cherry-pick revert reset am apply tag push pull`                                      | denied unless HEAD is on `dev`                                            |
| `WORKTREE_MUTATIONS` | `add move remove repair`                                                                                   | denied outright                                                           |

Internal functions worth knowing by name:

| function                     | what it does                                                                         |
| ---------------------------- | ------------------------------------------------------------------------------------ |
| `maskHeredocs(cmd)`          | blanks out heredoc and PowerShell here-string bodies, preserving newlines            |
| `splitClauses(cmd)`          | quote-aware split into clauses of tokens                                             |
| `gitInvocation(tokens)`      | returns `{sub, args, dirOpts}` or `null` if this clause is not a git call            |
| `repoDir(dirOpts, cwd)`      | resolves which repository the command acts on; `null` when it cannot tell            |
| `currentBranch(cwd)`         | `git branch --show-current` in that directory; `null` on detached HEAD or not-a-repo |
| `checkoutTarget(args)`       | the branch a checkout/switch would land on, or `null` if it changes no branch        |
| `branchIsReadOnly(args)`     | whether a `git branch` invocation only queries                                       |
| `pushTouchesProtected(args)` | `--mirror`, `--all`, or any argument containing `main`/`master`                      |
| `fallbackDecision(cmd)`      | blunt last-resort patterns, used only when the tokenizer throws                      |
| `decide(cmd, cwd)`           | the whole policy; returns a deny reason string or `null`                             |

### How it works, step by step

1. **Cheap exit.** `if (!/git/i.test(cmd)) return` — the 99% of commands that
   never touch git cost one regex test.
2. **Mask heredocs.** A _heredoc_ is the shell syntax `cat > f <<'EOF' … EOF`
   that feeds a block of literal text to a command. Its body is **data**, not
   commands. This step blanks the body out (replacing every non-newline
   character with a space, so line structure is unchanged).

   The reason is a real incident:

   > ```
   > // 2026-07-31, found by the build-manager when this hook denied their own
   > // commit: newline is a clause separator, so every line of
   > //     cat > /tmp/msg.txt <<'EOF'
   > //     ...prose quoting `git checkout -B main` as an example...
   > //     EOF
   > //     git commit -F /tmp/msg.txt -- <paths>
   > // was analysed as if it were a command, and the quoted PROSE tripped the branch
   > // rule. This repo's commit messages quote commands as a matter of style, so it
   > // would have recurred on nearly every commit.
   > ```

   Two rules stop the masking from becoming a bypass, _"both erring towards
   over-denial"_: if the terminator never appears, nothing is skipped; and if the
   opening line runs an interpreter (`bash <<'EOF'`), the body **is** commands
   and is left alone.

3. **Split into clauses and tokens**, respecting quotes. Newline, `;`, `|`, `&`,
   `(`, `)` and backtick all end a clause — so `$(git branch --show-current)` is
   read as the harmless query it is.
4. **Per-repository bookkeeping.** Two structures: a `Set` of directories that
   this command line has already switched to `dev`, and a lazily-filled `Map`
   from directory to current branch (at most one `git` subprocess per
   repository). Both keyed by resolved directory, _"because `git -C /a checkout
dev` must not unlock `git -C /b commit`"_.
5. **For each clause, dispatch on the parsed subcommand:**
   - `checkout` / `switch` → `checkoutTarget(args)`. `null` means no branch
     change (a `--` pathspec restore, or `-p`). `"dev"` records the switch —
     unless the arguments contain `--`, because `git checkout dev -- file`
     restores a file _from_ dev without moving HEAD. Anything else denies, naming
     the target.
   - `branch` → deny unless `branchIsReadOnly(args)`.
   - `worktree` → deny on `add|move|remove|repair`, _"a worktree is another way
     to check out a branch that is not dev"_.
   - `push` → deny if `pushTouchesProtected(args)`.
   - anything in `STATE_CHANGING` → resolve the repository, allow if it was
     switched to `dev` on this line, otherwise read its branch and deny unless it
     is `dev`. (`git tag` with only flags is a listing and is skipped.)

### Worked examples, from the real hook

```
CMD : git checkout main
OUT : Only the `dev` branch may be used, but this would move to "main".
      Switch with `git checkout dev` (or `git checkout -b dev`).

CMD : git branch --show-current
OUT : (nothing printed = allowed)

CMD : git.exe checkout -B main
OUT : Only the `dev` branch may be used, but this would move to "main". …

CMD : git -C .. commit -m x
OUT : HEAD of C:\…\<parent folder> is on "main" but only the `dev` branch may be
      modified. Run `git -C C:\…\<parent folder> checkout dev` first.

CMD : npm test
OUT : (nothing printed = allowed)
```

The fourth is the 2026-08-03 fix working: the command targets a different
repository, the guard resolved that repository, read _its_ branch, and named it
in the message. The wording only mentions a directory when it is not the session
directory — which is what makes the over-denial case diagnosable instead of
mysterious.

### The repository-resolution rules, probed against git 2.54

This comment is the only place these precedence rules are written down, and one
of them is a trap:

> ```
> //   git -C ../b branch --show-current        -> b's branch   (-C moves cwd)
> //   git -C .. -C b branch --show-current     -> b's branch   (-C repeats, each
> //                                                             resolved against
> //                                                             the previous one)
> //   git --git-dir=../b/.git ...              -> b's branch
> //   git --git-dir=.git -C ../b ...           -> b's branch   (EVERY -C applies
> //                                                             first, whatever
> //                                                             the order on the
> //                                                             command line)
> //   git --work-tree=../b ...                 -> the CWD repo's branch  <-- trap
> //   git -C '' ...                            -> no-op
> // --work-tree relocates the files a command reads and writes, NOT the HEAD it
> // moves: git --work-tree=/other commit still commits on the cwd repo's branch.
> // So it is parsed and its value consumed, but it must not redirect this check —
> // doing so would re-create the very over-match this resolution step exists to fix.
> ```

When `repoDir` cannot `statSync` the resolved path it returns `null`, and the
hook denies with: _"Cannot resolve which repository `-C /x` refers to, so the
dev-branch check cannot run. Denied rather than assumed safe."_ A guardrail that
cannot tell which branch it is protecting must fail closed.

### Traps and things not to "fix"

- **`maskHeredocs` must run before `splitClauses`.** Reverse them and heredoc
  prose is analysed as commands again.
- **`checkoutTarget` returns the string `"-"` for `git checkout -`, not `null`.**
  The comment: _"`git checkout -` / `git switch -` returns to the PREVIOUS
  branch, which is exactly the branch the agent was told to leave. Not a flag."_
- **`currentBranch` uses `--show-current` on purpose.** It works on a
  freshly-initialised repository with no commits yet and prints empty on a
  detached HEAD; both `rev-parse` alternatives error in those cases.
- **An unknown branch allows.** `currentBranch` returning `null` (detached HEAD,
  or not a repository) does not deny. That is a deliberate leniency, not an
  oversight.
- **`fallbackDecision` is reachable only from the `catch`.** Its blunt patterns
  exist so that a tokenizer crash denies rather than allows: _"Over-denial is
  recoverable; a missed `git push origin main` is not."_

> **Known limitation (verified 2026-08-05).** A whole command hidden inside a
> quoted argument is not re-tokenized. Probed: `bash -c "git checkout main"` is
> **allowed**, because `splitClauses` keeps the quoted text as one token and
> `GIT_PROG` does not match `git checkout main`. This is consistent with the
> stated threat model — accident, not a determined agent — and the sibling
> `guard-profile-shell.mjs` catches the analogous shape for `profile/` because it
> matches the raw string instead of tokenizing. Two guards, two parsing
> strategies, opposite failure modes: the tokenizer is precise and can be
> wrapped, the raw matcher is noisy and cannot.

### What it depends on, and what depends on it

Imports `node:child_process` (`spawnSync`), `node:fs`, `node:path`. Wired first
in `.claude/settings.json`'s `Bash|PowerShell` list. Tested by
`tests/hooks/guard-hooks.test.mjs`, whose cases include `-C` composition,
`--git-dir` versus `--work-tree`, heredocs, quoted commit messages and an
unresolvable `-C`.

---

## 1.7 `src/hooks/guard-files.mjs`

### What it is and why it exists

A `PreToolUse` hook on `Edit|Write|NotebookEdit` that denies any write whose
target resolves **outside the project directory**. It is hard rule 9, the
filesystem boundary. Without it an agent could edit another repository, your
Documents folder, or a system file.

### Everything it exposes

No exports, no flags. One `deny(reason)` helper and the logic below.

### How it works, step by step

1. Read standard input, parse, fail open on garbage.
2. `const file = String(input.tool_input?.file_path ?? input.tool_input?.notebook_path ?? "")`
   — it accepts **both** key names, because the `NotebookEdit` tool uses
   `notebook_path`.
3. If empty, return.
4. The boundary test:

   ```js
   const root = path.resolve(input.cwd || process.cwd())
   const abs = path.resolve(root, file)
   const rel = path.relative(root, abs)
   const outside = rel.startsWith("..") || path.isAbsolute(rel)
   if (!outside) return
   ```

   `path.relative(root, abs)` answers "how do I get from `root` to `abs`?". If
   the answer begins with `..`, you have to go **up out of** the project to get
   there. The second half of the test is a Windows detail: when the two paths sit
   on different drive letters (`C:` and `D:`) there is no relative route at all,
   so `path.relative` returns an absolute path instead.

5. Three named exceptions, each for a real reason:

   | exception  | test                                                       | why                                                                                                         |
   | ---------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
   | `inTmp`    | the path is under `os.tmpdir()`                            | the scratchpad — the documented place for temporary work                                                    |
   | `inMemory` | `/[\\/]\.claude[\\/]projects[\\/][^\\/]+[\\/]memory[\\/]/` | Claude's own cross-session memory files                                                                     |
   | `inPlans`  | `/[\\/]\.claude[\\/]plans[\\/]/`                           | plan mode writes its plan there; without this the approval dialog renders empty (user decision, 2026-07-27) |

   Both regexes use the character class `[\\/]` — "a backslash or a forward
   slash" — so one pattern covers Windows and POSIX paths.

6. Otherwise deny: `"<file>" is outside the project directory. This project only
edits its own files.`

Real probe output:

```
FILE: C:/…/AgenticJobApplication/src/leads/screen.mjs   OUT : allowed
FILE: C:/Users/<you>/Documents/other-repo/x.mjs             OUT : denied
FILE: D:/somewhere/x.mjs                                    OUT : denied
```

### Traps and things not to "fix"

- **`root` is the session working directory, not a marker file.** If Claude Code
  is started in a subdirectory of the project, everything above that
  subdirectory becomes "outside". That is why the setup instructions say to start
  it in the project folder.
- **File creation and deletion _inside_ the project are allowed.** That was a
  user decision on 2026-07-27, and the header says where the narrower rule now
  lives: _"The job-application flows are still restricted to jobs/<slug>/ — that
  rule lives in the skill instructions (pipeline-jobs / apply-job / find-jobs),
  not here."_ Do not add it back here without discussing it; interactive
  development needs the freedom.
- The Windows `process.exit` rule from §1.2 applies.

### What it depends on, and what depends on it

Imports `node:os` and `node:path`. Wired second in the `Edit|Write|NotebookEdit`
list, after `protect-profile.js`. Tested by `tests/hooks/guard-hooks.test.mjs`.

---

## 1.8 `src/hooks/prettify.mjs`

### What it is and why it exists

The only `PostToolUse` hook. After the agent edits or writes a file, this runs
**prettier** (an automatic code formatter) on it. It cannot block anything —
the edit already happened.

It exists for hard rule 8. Without it, every agent would reformat to its own
taste and every change would be half whitespace, which makes review useless.

### How it works, step by step

1. Read standard input, parse, fail open.
2. `const file = String(input.tool_input?.file_path ?? input.tool_response?.filePath ?? "")`
   — a `PostToolUse` payload also carries `tool_response`, so both shapes are
   accepted.
3. Three silent early returns:
   - the file is missing or the path is empty;
   - the extension is not in `SUPPORTED`;
   - `node_modules/prettier/bin/prettier.cjs` does not exist —
     `// prettier not installed: never block edits`.
4. Spawn prettier:

   ```js
   spawnSync(
     process.execPath,
     [
       PRETTIER_BIN,
       "--write",
       "--log-level",
       "silent",
       "--ignore-path",
       ".prettierignore",
       file,
     ],
     { encoding: "utf8" },
   )
   ```

5. If prettier exited non-zero **and** printed to standard error, emit an
   advisory message and nothing more:

   ```js
   // Non-blocking: report but never fail the edit over a formatting hiccup.
   console.log(
     JSON.stringify({
       systemMessage: `prettier could not format ${file}: ${res.stderr.trim().slice(0, 200)}`,
     }),
   )
   ```

   Note the different output shape: `systemMessage`, not `hookSpecificOutput`.
   A `PostToolUse` hook has no permission decision to make.

`SUPPORTED` is thirteen extensions: `.md .markdown .json .js .mjs .cjs .ts .mts
.yaml .yml .css .html .htm`.

### Traps and things not to "fix"

- **`--ignore-path .prettierignore` is load-bearing**, and the comment says why:

  > `// --ignore-path: don't inherit .gitignore (prettier 3 default) — jobs/ is`
  > `// gitignored on purpose but its documents must still be formatted.`

  Prettier 3 reads `.gitignore` **in addition to** `.prettierignore` unless you
  pass `--ignore-path`. `jobs/` is gitignored because it holds personal data, so
  without this flag prettier would refuse to format the tailored resume drafts
  that live there. Passing `--ignore-path .prettierignore` replaces the ignore
  list entirely.

- **`.prettierignore` is passed as a relative path**, so it resolves against the
  hook process's working directory. In normal use that is the project root. If
  it were not, the three contract files in §4.4 would get reformatted and break.
- **`PRETTIER_BIN` is resolved relative to this file**, not to the working
  directory:

  ```js
  const PRETTIER_BIN = fileURLToPath(
    new URL("../../node_modules/prettier/bin/prettier.cjs", import.meta.url),
  )
  ```

  In a git **worktree** (a second checkout of the same repository in another
  folder) there is no `node_modules` under the worktree root, so the binary is
  missing and this hook silently does nothing. That is exactly one of the two
  worktree test failures recorded in `package.json`'s `measured` field — see
  §2.1.

- **It never blocks.** Every failure path is a silent return or an advisory
  message. Keep it that way: a formatting hiccup that fails an edit would be a
  worse bug than a badly formatted file.

### What it depends on, and what depends on it

Imports `node:child_process`, `node:fs`, `node:path`, `node:url`. Requires the
`prettier` devDependency (currently 3.9.6). Wired as the only `PostToolUse` hook,
with `"statusMessage": "Running prettier"` — the spinner text you see while it
runs. Tested by `tests/hooks/guard-hooks.test.mjs`, including a case that asserts
an in-place reformat produces exactly `"# Title\n\n- item one\n- item two\n"`.

---

## 1.9 `.claude/settings.json`

### What it is and why it exists

The project configuration Claude Code reads at session start. Two things live in
it: a **permission allowlist** and the **wiring for all five hooks**. Nothing
else in the repository loads a hook, which is why this file is sealed alongside
the hooks themselves (§1.3).

`tests/hooks/repo-hygiene.test.mjs` asserts it is valid JSON, with a message
worth remembering: _"settings.json must be valid JSON or Claude Code loads NO
hooks at all"_. One stray comma silently disarms every guard in this document.

### Everything it exposes

```json
{
  "permissions": {
    "allow": [
      "Bash(npm test*)",
      "Bash(npm install*)",
      "Bash(node src/*)",
      "Bash(node src/**)",
      "Bash(node --test*)"
    ],
    "deny": []
  },
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Edit|Write|NotebookEdit",
        "hooks": [
          {
            "type": "command",
            "command": "node .claude/hooks/protect-profile.js"
          },
          { "type": "command", "command": "node src/hooks/guard-files.mjs" }
        ]
      },
      {
        "matcher": "Bash|PowerShell",
        "hooks": [
          { "type": "command", "command": "node src/hooks/guard-bash.mjs" },
          {
            "type": "command",
            "command": "node .claude/hooks/guard-profile-shell.mjs"
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Edit|Write|NotebookEdit",
        "hooks": [
          {
            "type": "command",
            "command": "node src/hooks/prettify.mjs",
            "statusMessage": "Running prettier"
          }
        ]
      }
    ]
  }
}
```

| key                 | meaning                                                                                                                  |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `permissions.allow` | patterns that pre-approve a tool call so you are not asked. `Bash(npm test*)` covers `npm test` and `npm test -- --foo`. |
| `permissions.deny`  | the opposite list; empty here                                                                                            |
| `matcher`           | a `\|`-separated list of tool names the hooks below it apply to                                                          |
| `type: "command"`   | the hook is an external process; the payload arrives on its standard input                                               |
| `statusMessage`     | the text shown while the hook runs                                                                                       |

There is also an untracked `.claude/settings.local.json` on this machine holding
three extra allow entries for specific lead-search commands. It is ignored by a
**global** git ignore rule (`**/.claude/settings.local.json` in the user's own
`~/.config/git/ignore`), not by this repository's `.gitignore`, and it is covered
by the same protection patterns as `settings.json`.

### Invariants pinned by tests

`tests/hooks/repo-hygiene.test.mjs` asserts, against the real file:

- it parses as JSON;
- there are at least four command hooks;
- **every hook command names a file that exists on disk**. Its header explains
  why: when `guard-profile-shell.mjs` moved from `src/hooks/` to
  `.claude/hooks/` and this file was repointed by hand, a missed edit would have
  meant _"the guard is simply GONE: Claude Code cannot run a file that is not
  there, and nothing else in the suite reads settings.json… A guardrail that
  silently stopped being loaded is the worst kind of green."_
- `Edit` is covered by `protect-profile.js`;
- **both `Bash` and `PowerShell`** are covered by `guard-profile-shell.mjs` —
  _"This project uses both shell tools; guarding one is guarding none"_;
- the shell guard is wired from `.claude/hooks/`, not `src/hooks/` —
  _"it must be the copy agents cannot rewrite"_;
- `Bash` is also covered by `guard-bash.mjs`.

### Traps

- **The allowlist is broad.** `Bash(npm install*)` pre-approves installing
  arbitrary npm packages with no prompt. That is a live supply-chain surface;
  narrow it if that trade stops being worth it to you.
- Both hooks under a matcher run; either can deny. Order affects only which
  reason you see first.

---

## 1.10 One edit, end to end

Put together, here is what happens when the agent edits
`src/leads/screen.mjs`.

1. Claude Code matches the `Edit` tool against the first `PreToolUse` entry and
   runs **two** hooks in order.
2. `protect-profile.js` receives:

   ```json
   {
     "tool_name": "Edit",
     "cwd": "C:\\...\\AgenticJobApplication",
     "tool_input": { "file_path": "C:\\...\\src\\leads\\screen.mjs" }
   }
   ```

   It normalises backslashes, tests the six protected patterns, matches none,
   prints nothing → allow.

3. `guard-files.mjs` resolves the path against the session root, computes
   `rel = src\leads\screen.mjs`, sees it neither starts with `..` nor is
   absolute → allow.
4. The edit happens.
5. `PostToolUse` runs `prettify.mjs`, which spawns prettier with `--write` and
   `--ignore-path .prettierignore`. The file comes back formatted with no
   semicolons.

Change the target to `profile/answers.yaml` and step 2 denies; the edit never
runs, and the message points the agent at `save-answer.mjs`. Change it to a
shell command like `node scripts/profile/save-answer.mjs --label "Willing to
relocate" --value "Yes"` and the second `PreToolUse` entry fires instead:
`guard-bash.mjs` sees no `git` and returns immediately, then
`guard-profile-shell.mjs` denies with the two-incident explanation.

---

# Part 2 — `npm test` is a gate, not a test run

## 2.1 `package.json`

### What it is and why it exists

The npm manifest: the project's name, its dependencies, and the short command
names (`npm test`, `npm run reap`) that stand in for longer command lines. In
this repository it carries two more things that are not standard npm: the
`testGate` block that configures the test gate, and the `phases` block that
configures the scaffolding reaper.

Without `testGate`, the gate has nothing to assert against and **refuses to
run**: `die('gate "…" has no usable floor')`.

### How you use it

You do not run `package.json`; things read it.

| reader                                                  | reads                            |
| ------------------------------------------------------- | -------------------------------- |
| `npm test` / `npm run …`                                | `scripts`                        |
| `test-gate.mjs` → `loadGateConfig(name)`                | `testGate[name]`                 |
| `scaffolding-reaper.mjs` → `loadPhases(root, override)` | `phases.order`, `phases.current` |
| `tests/hooks/test-gate.test.mjs`                        | asserts the contents directly    |

### Everything it contains

| key               | value                                                | note                                             |
| ----------------- | ---------------------------------------------------- | ------------------------------------------------ |
| `name`            | `agentic-job-application`                            |                                                  |
| `version`         | `0.1.0`                                              |                                                  |
| `private`         | `true`                                               | npm will refuse to publish this package          |
| `type`            | `module`                                             | modern `import` syntax everywhere, not `require` |
| `scripts`         | six, below                                           |                                                  |
| `phases`          | `{ order: [phase-1 … phase-4], current: "phase-5" }` | see the defect note below                        |
| `testGate`        | two gates, `full` and `security`                     | §2.2                                             |
| `dependencies`    | `js-yaml ^4.1.0`, `marked ^12.0.0`                   | needed to run the product                        |
| `devDependencies` | `playwright-core ^1.62.1`, `prettier ^3.9.6`         | needed only to develop it                        |

(`^4.1.0` is a _semver range_: "4.1.0 or any later 4.x", but not 5.0.0.
`dependencies` are installed for anyone using the project; `devDependencies` only
for people working on it.)

The scripts:

| script            | command                                                     | meaning                                                                      |
| ----------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `test`            | `node tools/ci/test-gate.mjs full`                          | **the** gate. Not a bare `node --test`.                                      |
| `test:raw`        | `node --test`                                               | a bare runner with no floor and no assertions — a diagnostic, never evidence |
| `test:security`   | `node tools/ci/test-gate.mjs security`                      | the Phase 1 security gate                                                    |
| `reap`            | `node tools/ci/scaffolding-reaper.mjs`                      | fails if a dev-only artifact outlived its phase                              |
| `browser:install` | `node node_modules/playwright-core/cli.js install chromium` | downloads the exact Chromium build `playwright-core` pins                    |
| `verify`          | `node src/documents/verify-claims.mjs`                      | the truthfulness checker (hard rule 4)                                       |

Two of those carry history worth keeping.

**`browser:install` uses the local CLI on purpose.** `ci.yml` explains:
_"`npx playwright install` would fetch the full `playwright` package as an
undeclared extra dependency, which is exactly the postinstall this project
avoided."_ The dependency is `playwright-core` — never `playwright` — because
the latter downloads roughly 150MB of browsers on install, on every machine.

**`verify` is pinned by a test**, because it once silently stopped working:

> `// Every npm script must name a file that exists — the defect the reorg left`
> `// behind, generalised so the next move is caught the same day.`

A directory reorganisation on 2026-07-29 moved `verify-claims.mjs` and the script
kept pointing at the old path, so `npm run verify` did nothing at all for two
days. `tests/hooks/test-gate.test.mjs` now asserts every script names a file that
exists, and asserts specifically that `verify` names
`src/documents/verify-claims.mjs`.

### The `measured` field — a changelog that outgrew its JSON string

**Moved 2026-08-27.** `testGate.full.measured` used to be a single JSON string of
roughly 9,500 characters of prose — about **84% of `package.json`** — and it is
now one sentence pointing at
[`../measurements.md`](../measurements.md), section "Test-floor ledger", where
the entries live in markdown. `test-gate.mjs` never read the field, which is what
made the move safe; verify that before ever putting prose back in there.

The **rule** did not move with it: raise a floor only to a number two consecutive
honest gate runs produced on a quiescent tree, record those runs, and never lower
one to make a change green.

What the ledger is for: each entry records who raised a floor, when, on what
machine, over how many files, how many runs agreed, and what caveats applied. A
representative fragment:

> _"RAISED 1549 → 1610 by build-manager 2026-08-02, and this one carries NO
> caveat: the tree was fully committed and every agent had retired, so for the
> first time in this build the count is attributable rather than merely observed.
> That matters because three intermediate readings this session (1565, 1578, 1600) were each taken with another agent's files dirty and were correctly
> reported as non-attributable rather than banked."_

The distinction that runs through all of it is between a number that was
**observed** and a number that is **attributable** — one you can say what
produced. Two other pieces of real operational knowledge live in there and
nowhere else:

- **Git worktrees break two tests for environmental reasons.** _"the
  prettify-in-place case and the run-script-points-at-a-file case both look for
  node_modules under the worktree root, which a git worktree does not have."_ If
  you see those two red in a worktree, re-run from the main checkout before
  believing them.
- **`tests/auto/browser-leg.test.mjs` has a test-ordering dependency on an
  untracked directory.** It fails on the _first_ run in a fresh worktree because
  such a tree has no `jobs/` folder yet, and passes on every later run once some
  earlier test has created one.

Numbers move every week, so read the latest entry in the ledger rather than a
figure quoted here. `package.json`'s `testGate` floors are the current contract;
the ledger says how each one was earned.

### Traps and known defects

> **Known defect (2026-08-05 audit): `phases.current` is not in `phases.order`.**
> `order` is `["phase-1","phase-2","phase-3","phase-4"]` and `current` is
> `"phase-5"`. The reaper computes `nowIdx = order.indexOf(current)`, which is
> `-1`, so its rule 1 — the one its own header calls "the point", an artifact
> whose `remove_after` phase is already past — **can never fire**. Its other two
> rules still work. It is latent rather than live today only because the
> repository currently declares zero scaffolding artifacts. The honest fix is to
> add `phase-5` to `order`. See §3.3.

> **Known defect (2026-08-05 audit): `testGate.full.floor` has lost its
> provenance.** The floor is `2208`. The `measured` changelog's final entry
> raises it to `2186`, and there is a second undocumented jump earlier
> (`1967 → 2158`). So today's floor is 22 above the last number anyone wrote down
> having measured. Three test files are currently untracked in the working tree,
> which plausibly supply the difference — but "plausibly" is the exact word the
> `measured` discipline exists to eliminate. Re-measure on a clean tree and
> either write the entry or lower the floor.

Other things not to change:

- **Floors ratchet up only.** `tests/hooks/test-gate.test.mjs` asserts
  `security.floor >= 147` and `full.floor >= 946` — historical low-water marks
  that can never be crossed downward.
- **`testGate.security.paths` is pinned to its exact three entries** by the same
  test, so nobody can quietly narrow the security gate.
- **There is no `engines` field**, so nothing declares which Node versions are
  supported. CI tests Node 20 and 22; the development machine runs Node 24.

---

## 2.2 `tools/ci/test-gate.mjs`

### What it is and why it exists

This is the most important 500 lines in this document. It runs the test suite and
then asserts that the run **proves** the suite executed.

Here is the problem it solves, in one line: **`node --test` exits 0 when it runs
zero tests.** An exit code by itself reports success for a suite that was
deleted, a directory that was renamed, or a file pattern that stopped matching.
The header:

> ```
> // Why this exists: node --test exits 0 when it runs ZERO tests, so the exit
> // code alone is worthless as evidence. A pipeline whose only assertion is
> // "the runner did not error" reports success for a suite that was deleted,
> // a directory that was renamed, or a glob that stopped matching. This gate
> // asserts the COUNT, the failure count, and that every skip is attributed.
> ```

Without this file, deleting `tests/security/` entirely would make the pipeline
greener **and** faster.

It also solves a portability problem that looks like an ordinary test failure:

> ```
> // Node 20/22 recurse into a directory argument; Node 24 treats it as a
> // module path, fails with "Cannot find module .../tests/security", and
> // reports that as ONE FAILING TEST — so the plan's Phase 1 command runs none
> // of tests/security on Node 24 while looking like an ordinary red. Deleting
> // the directory argument to "fix" that red would produce a green run over
> // zero security tests.
> ```

So the gate expands directories into explicit file lists itself and hands node
the files. Same behaviour on every Node version, and the file list becomes
reportable evidence.

One more note explains why the file lives in a workflows directory rather than in
`src/`:

> `// GitHub Actions only loads *.yml/*.yaml from this directory and ignores`
> `// everything else, so a .mjs here is inert to Actions.`

### How you run it

```bash
npm test                       # = node tools/ci/test-gate.mjs full
npm run test:security          # = ... test-gate.mjs security
node tools/ci/test-gate.mjs --floor 10 --path tests/lib --quiet
node tools/ci/test-gate.mjs security -- --require-ran "nonce CSP is ENFORCED"
```

### Everything it exposes

| flag                            | argument               | effect                                              | default       |
| ------------------------------- | ---------------------- | --------------------------------------------------- | ------------- |
| _(a bare word)_                 | gate name              | loads `package.json` → `testGate[name]`             | none          |
| `--floor N`                     | number                 | overrides the configured floor                      | from config   |
| `--max-todo N`                  | number                 | overrides the todo cap                              | `0`           |
| `--path P`                      | path (repeatable)      | overrides the configured path list                  | from config   |
| `--require-dir D`               | path (repeatable)      | overrides the required-directory list               | from config   |
| `--require-ran S`               | substring (repeatable) | that test must be present **and not skipped**       | none          |
| `--cwd D`                       | directory              | what paths and required directories resolve against | the repo root |
| `--label L`                     | string                 | the name printed in the report                      | the gate name |
| `--quiet`                       | —                      | suppress the human-readable reporter                | off           |
| anything else starting with `-` | —                      | `die("unknown option …")`                           | —             |

The gate configuration keys, per gate, in `package.json`:

| key           | type     | meaning                                                                                        |
| ------------- | -------- | ---------------------------------------------------------------------------------------------- |
| `floor`       | number   | the **minimum** number of tests that must run. Fewer is a build failure.                       |
| `maxTodo`     | number   | maximum tests marked `todo`. Both gates set **0**.                                             |
| `requireDirs` | string[] | directories that must exist **and hold at least one test file**. A missing suite is a FAILURE. |
| `paths`       | string[] | what to run. Directories are expanded by the gate, never handed to `node --test`.              |
| `measured`    | string   | free-text provenance for the floor (§2.1).                                                     |
| `requireRan`  | string[] | accepted if present, though neither gate sets one — the flag is meant to be per-invocation.    |

The two configured gates today:

```json
"full":     { "floor": 2208, "maxTodo": 0,
              "requireDirs": ["tests", "tests/security"],
              "paths": ["tests"] }
"security": { "floor": 262,  "maxTodo": 0,
              "requireDirs": ["tests/security"],
              "paths": ["tests/security/",
                        "tests/lib/untrusted.test.mjs",
                        "tests/documents/verify-claims.test.mjs"] }
```

**Exit codes:** `0` = pass with the counts printed. `1` = fail with every reason
printed as an `ERROR:` line, or a `die()` for a bad option, an unknown gate name,
or a missing floor. There is no third code, and the header states the absolute
rule: _"It never hides a failure: there is no `|| true` path."_

Internal functions, by name:

| function                            | returns                  | role                                                                                                                   |
| ----------------------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `die(msg)`                          | never                    | writes `test-gate: <msg>` to standard error and exits 1                                                                |
| `parseArgs(argv)`                   | options object           | the flag table above                                                                                                   |
| `loadGateConfig(name)`              | the gate config          | reads `package.json`; `die`s listing the gates that do exist                                                           |
| `findTestFiles(dir)`                | `string[]`               | recursive walk matching `/\.test\.(c                                           \| m)?js$/`, sorted with`localeCompare` |
| `expandPaths(paths, cwd, problems)` | `string[]`               | resolves each path; records a problem for a missing path or an empty directory                                         |
| `tapCount(tap, key)`                | `number \| null`         | pulls `# tests 2186`-style summary lines out of the TAP text                                                           |
| `collectDirectives(tap)`            | `{name, kind, reason}[]` | every `# SKIP` / `# TODO`                                                                                              |
| `collectNames(tap)`                 | `string[]`               | every reported test name (used only by `--require-ran`)                                                                |
| `collectFailures(tap)`              | `{name, owner}[]`        | every `not ok`, deduplicated, with any `FINDING (owner)` parsed out                                                    |

### How it works, step by step

**TAP** is the Test Anything Protocol — a plain-text format test runners emit,
where each result is a line like `ok 3 - adds two numbers` and the run ends with
summary lines like `# tests 2186`. The gate parses that.

1. Parse the arguments; load the gate config if a gate name was given. Explicit
   flags win over configuration.
2. **Refuse to run without a floor.** `if (!Number.isFinite(floor) || floor < 1)
die('gate "…" has no usable floor (got …). A gate with no floor cannot prove
tests ran.')`
3. **Check `requireDirs`.** Each must exist, be a directory, and contain at
   least one test file. The two error strings are worth quoting because they are
   the gate's thesis:

   > _"A missing suite is a FAILURE, not a pass — this gate exists so the Phase 1
   > security tests cannot be 'green' by being absent."_
   >
   > _"An empty suite proves nothing."_

4. **Expand the paths to explicit files** (only if step 3 found no problems).
5. **Run the suite** with two reporters:

   ```js
   const args = [
     "--test",
     "--test-reporter=tap",
     `--test-reporter-destination=${tapFile}`,
   ]
   if (!opts.quiet)
     args.push("--test-reporter=spec", "--test-reporter-destination=stdout")
   args.push(...files)
   ```

   `spec` is the readable stream for humans; `tap` is the machine-readable
   stream written to a temporary file the gate then parses. Node pairs each
   `--test-reporter` with the `--test-reporter-destination` that follows it, in
   order.

6. **Delete `NODE_TEST_CONTEXT` from the child's environment.** This is subtle
   and load-bearing:

   > ```
   > // NODE_TEST_CONTEXT must not be inherited. Node sets it on every test-file
   > // subprocess, and a node --test that sees it switches to the internal
   > // v8-serializer reporter and IGNORES --test-reporter — so the TAP file comes
   > // out empty and the gate reports "no TAP summary". Observed while writing
   > // tests/hooks/test-gate.test.mjs, which runs this gate from inside a test.
   > ```

7. Read the TAP file (an unreadable file becomes an empty string, which then
   fails at the next step rather than crashing).
8. **Evaluate.** Every one of these adds a problem, and any problem means exit 1:

   | condition                              | message, abbreviated                                                                         |
   | -------------------------------------- | -------------------------------------------------------------------------------------------- |
   | no `# tests` line at all               | "the runner produced no TAP summary … not evidence that anything ran"                        |
   | `fail > 0`                             | "N test(s) FAILED" — **no exemption of any kind**                                            |
   | `cancelled > 0`                        | "were CANCELLED (timeout or crash)"                                                          |
   | `tests < floor`                        | "Either tests were deleted/renamed out of discovery, or the floor … is stale"                |
   | `todo > maxTodo`                       | "Converting a failing test to todo is not a fix."                                            |
   | a SKIP or TODO with an empty reason    | "A skip must say WHY … or it is indistinguishable from a test that silently stopped running" |
   | a `--require-ran` name matched nothing | "A test that is not there cannot have passed."                                               |
   | a `--require-ran` name skipped         | "This leg was configured to RUN it … a skip here means the setup did not work"               |
   | runner exited non-zero with 0 failures | "treat as a failure, not noise"                                                              |

9. **Report** to standard output, and additionally append a markdown table to
   `$GITHUB_STEP_SUMMARY` when that environment variable exists (GitHub Actions
   sets it). That write is wrapped in `try/catch` with the comment _"a summary
   write failure must never change the verdict"_.
10. Delete the temporary directory; `process.exit(problems.length ? 1 : 0)`.

### Worked examples, real output

A three-test throwaway suite where one test skips with a stated reason, run with
`--floor 3`:

```
test-gate: demo — PASS
  platform    win32 / node v24.13.1
  paths       suite
  files       1 test file(s) after expansion
  tests       3   (floor 3)
  pass        2
  fail        0
  skipped     1
  todo        0   (cap 0)
  duration    0.1s
  not executed on this leg (1):
    [SKIP] renders a PDF — no Edge/Chrome on this machine
```

Exit code 0. Now the same suite with `--floor 5`:

```
test-gate: demo — FAIL
  …
  tests       3   (floor 5)
  …
  ERROR: only 3 tests ran, floor is 5. Either tests were deleted/renamed out of
  discovery, or the floor in package.json "testGate" is stale. node --test exits 0
  on an empty run, which is why this is checked.
```

Exit code 1. And the same suite again with the skip's reason removed —
`t.skip()` instead of `t.skip("no Edge/Chrome on this machine")`:

```
test-gate: demo — FAIL
  …
  not executed on this leg (1):
    [SKIP] renders a PDF — NO REASON GIVEN
  ERROR: SKIP without a reason: "renders a PDF". A skip must say WHY
  (e.g. t.skip("no Edge/Chrome on this machine")) or it is indistinguishable
  from a test that silently stopped running.
```

That third one is the heart of the design. A skip is legitimate — a machine with
no browser genuinely cannot run the PDF tests. A skip with no reason is
indistinguishable from a test that quietly stopped running, so it is a failure.

### How to raise a floor honestly

When a run exceeds the floor by 25 or more, the report prints a nudge:

```
  NOTE: 43 tests above the floor. Raise "testGate.full.floor" in package.json
  to 2229 so deletions below today's count are caught.
```

That is the ratchet. But the number you write down is governed by a discipline
the code cannot enforce, recorded in `measured`:

> _"Floor set to the observed MINIMUM (1324), not the maximum: the count drifts
> by ~1 under load and a floor above an honest run teaches people to ignore it."_
>
> _"the floor is a number two honest runs actually produced, not the best one
> seen."_

The procedure, in order:

1. **Commit or stash everything.** A count taken while other work is dirty is not
   attributable. `CLAUDE.md`'s token discipline records why: _"three identical
   runs gave 4 → 6 → 0 failures, and duration inflated 75s → 150s purely from
   contention."_
2. Run the gate at least twice and require the counts to agree exactly.
3. Set the floor to that agreed number — the minimum of honest runs, never the
   best one seen.
4. **Append an entry to `measured`** saying who measured it, on what date and
   platform, over how many files, how many runs agreed, and any caveat (for
   example "measured on a tree holding uncommitted work"). If the work does not
   land, lower the floor by exactly what the gate reports and say so.

### Traps and things not to "fix"

- **`node --test <dir>` does not recurse on Node 24.** That is the whole reason
  `expandPaths` exists. If you write a `node --test` command by hand, use the
  quoted glob: `node --test "tests/security/**/*.test.mjs"`.
- **An empty `paths` list means "let node do default discovery"**, which node
  does recurse correctly. That branch is only reachable via `--floor N` with no
  `--path`.
- **A test file containing zero tests counts as one passing test** in Node's TAP
  output. Gutting a file's contents is therefore caught only by the floor, which
  is one more reason the floor exists.
- **The `FINDING (<owner>)` convention is reporting only.** A test named
  `FINDING (w3-resolution): a reworded consent box is not recognised` is
  committed red on purpose to pin a known live defect. The gate sorts failures
  into "UNEXPECTED (nobody owns these)" and "known-red, named and owned", and
  prints the unexpected ones first. The comment is emphatic:

  > `// This classification is REPORTING ONLY. It cannot make a red run green: the`
  > `// verdict below is counts.fail > 0 → fail, with no exemption of any kind. A`
  > `// regression renamed to look like a FINDING would still fail the build.`

  Its origin: _"see 147eb68: this repo learned that a green suite can read as
  'RCE closed' while the hole is open."_

- **`--require-ran` is opt-in per invocation, never a gate-wide setting.** The
  reasoning is the sharpest paragraph in the file:

  > `// The gate's normal rule is that a skip is fine as long as it names a`
  > `// reason. That rule is right for the PDF tests… It is wrong for a test on a`
  > `// leg that was BUILT to run it. … "no browser available" printed on the one`
  > `// leg whose job is to have a browser is a broken install, not an attributed`
  > `// skip — and the difference between those two is invisible in the summary,`
  > `// which is precisely the quiet-coverage-loss shape this gate exists to prevent.`

### What it depends on, and what depends on it

Imports only Node built-ins: `node:child_process`, `node:fs`, `node:os`,
`node:path`, `node:url`. Depended on by `package.json`'s `test` and
`test:security` scripts, by `ci.yml` on all five test-running legs, and by
`tests/hooks/test-gate.test.mjs`, which spawns it against throwaway fixture
directories in both directions.

---

# Part 3 — Continuous integration

**Continuous integration** (CI) means: every time you push code, a fresh
computer somewhere else checks out your repository from scratch, installs
everything, and runs your checks. It catches the class of bug where something
works on your machine because of a file, a tool or a setting that only exists on
your machine.

## 3.1 `.github/workflows/ci.yml`

### What it is and why it exists

The GitHub Actions pipeline. Five jobs, one of which (`ci-gate`) is a single
stable check name meant to be marked "required" in the repository's branch
protection settings.

Without it, every gate in this document is something a human has to remember to
run. The `security-gate` job's own comment says exactly that: _"It used to be
enforced by someone remembering to run the command; this is the mechanical
form."_

### Triggers, permissions, concurrency

```yaml
on:
  push: { branches: [dev] }
  pull_request: { branches: [dev, main] }
  workflow_dispatch: # manual trigger
permissions:
  contents: read
concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true
```

- `workflow_dispatch` lets you start a run by hand. Its comment: _"Without this
  no run could be started by hand, so a pipeline change could only be tested by
  pushing."_
- `permissions: contents: read` is least privilege — the workflow may read the
  repository and nothing else.
- `concurrency` with `cancel-in-progress` means a new push cancels the run
  already in flight for the same branch, so you are not paying for stale runs.

### The six jobs

**1. `security-gate`** — Ubuntu, Node 22, 15-minute timeout.

Steps: checkout → set up Node with the npm cache → `npm ci --prefer-offline
--no-audit --fund=false` → cache `~/.cache/ms-playwright` → `npm run
browser:install` → the security gate with three `--require-ran` names.

(`npm ci` is not `npm install`: it deletes `node_modules` and installs exactly
what `package-lock.json` pins, so the run is reproducible.)

This is the **only** leg that installs a real browser, and the comment explains
why that is worth 150MB:

> ```
> // tests/security/browser-vouch.test.mjs drives a real Chromium against our
> // own loopback fixture (tests/fixtures/boards/), never a live employer's
> // board. It is the only real-browser evidence in the suite, and it covers the
> // one carrier a fake DOM cannot express: CSS. The markup of an honest label
> // and of a label rendered `color: transparent` is IDENTICAL — the difference
> // is what getComputedStyle returns, so the only way to know whether the
> // scanner vouches for an unreadable label is to render it.
> ```

The browser cache is keyed on `hashFiles('package-lock.json')` because
_"playwright-core pins one exact Chromium revision, so a version bump must miss
the cache rather than launch a browser the library does not speak to."_ And the
install step has no `|| true`: _"if the download fails, this leg goes red here,
which is a clearer failure than three tests skipping later for a stated reason."_

The three `--require-ran` substrings, which turn an attributed skip into a
failure on this leg only, are:

- `"color:transparent must not be vouched for"`
- `"the honest boxes on the same page still behave"`
- `"nonce CSP is ENFORCED, not merely sent"`

All three exist today in `tests/security/browser-vouch.test.mjs`, and
`tests/hooks/test-gate.test.mjs` asserts they still do.

**2. `lint`** — Ubuntu, Node 22, 10-minute timeout, added 2026-08-27 with the
enforcement layer. Three steps after `npm ci`: `npm run lint` (ESLint 10 with
`--pass-on-unpruned-suppressions`, so **fixing** a suppressed violation never
reddens the build), `npm run format:check` (prettier over the whole repo), and
`npm run lint:md` (markdownlint-cli2, invoked with **no arguments** so its corpus
has exactly one definition — `.markdownlint-cli2.jsonc`).

Where prettier and markdownlint disagree about the same bytes, **prettier wins**
and the conflicting markdownlint rule is off with its reason recorded in that
config. Every one of these also runs as a counted test under `tests/quality/`, so
a local `npm test` catches them before the push; the reasoning for each rule is
in [`../guide/09-conventions.md`](../guide/09-conventions.md).

**3. `test`** — the matrix: `os: [ubuntu-latest, windows-latest]` ×
`node: [20, 22]`, so four legs, `fail-fast: false` (one red leg does not cancel
the others), 20-minute timeout. Steps: checkout → set up Node → `npm ci` →
`node tools/ci/report-browsers.mjs` → `npm test`.

Why Windows is in the matrix: _"Windows is the primary platform (the user's
machine) and PDF rendering shells out to a local Edge/Chrome, so a Linux-only
pipeline would prove very little about the shipped path."_

Why no browser here: _"one ~150MB download instead of four, with the
real-browser evidence produced on the blocking gate rather than nowhere. If you
want it on a matrix leg, add the same cache + install pair; **there is no silent
middle option.**"_

**3. `scaffolding`** — Ubuntu, Node 22, 5 minutes, no `npm ci` needed. Two steps:
`scaffolding-reaper.mjs --self-test`, then `npm run reap`. The rationale is the
recurring one: _"a checker with nothing to check must be distinguishable from a
broken one. The `--self-test` step is how."_

**4. `perf-gate`** — Ubuntu only, Node 22, 20 minutes. `npm ci`, then
`node tools/ci/perf-gate.mjs` with `PR_BODY` piped in from
`github.event.pull_request.body`. Ubuntu only _"because the numbers are compared
against a baseline, and a baseline is only meaningful against one platform. The
matrix proves the code runs everywhere; this proves it did not get slower."_

**5. `ci-gate`** — `if: always()`, `needs: [security-gate, test, scaffolding,
perf-gate]`. A shell block that echoes each result, emits a GitHub `::error::`
annotation for any result that is not `success`, and exits non-zero if any
failed.

Its comment states an honest limit rather than implying a guarantee:

> `// HONEST LIMIT: a workflow file cannot make itself required. Branch`
> `// protection is a repository setting; until someone ticks ci-gate there,`
> `// this is blocking for the RUN's conclusion but not for merging.`

### The job that is deliberately not wired

```yaml
# * `gate-audit.mjs` — the whole-store regression check that exits 1 when a
#   lead became newly REJECTED, which is the worst failure in this system
#   (a job the user never sees). It opens jobs/leads.db, which is gitignored
#   because it holds personal data, so on a clean checkout there is no store
#   to diff against... Wiring it would need a committed fixture store.
```

The framing matters as much as the fact: _"NOT wired, on purpose — and stated
here rather than wired vacuously, because a job that always passes reads as
coverage that does not exist."_

### Invariants pinned by tests

`tests/hooks/test-gate.test.mjs` reads the real `ci.yml` and asserts:

- it contains none of `continue-on-error`, `|| true`, `exit 0 #`, `|| exit 0`
  (comment lines are stripped before the check);
- it contains `workflow_dispatch` and `npm run test:security`;
- **every job defined in the file appears in `ci-gate`'s `needs` list** — derived
  by parsing the YAML with `js-yaml`, not from a hardcoded list, _"because a
  hardcoded list is exactly what goes stale"_. The first attempt matched job
  names with a regex and matched `push:` under `on:`; the fix note reads _"a test
  that goes red over its own parser teaches people to delete it."_
- no job or step sets `continue-on-error: true`, and no step outside `ci-gate`
  has an `if:` containing `always()`.

### Traps

> **Known gap (inherited from AUDIT M7, still true on 2026-08-05).** CI never
> runs `prettier --check`. Hard rule 8 is enforced only by the `PostToolUse`
> hook, which by construction only touches files the agent edits. Files created
> before that hook existed, or edited by hand, can drift and nothing notices.

---

## 3.2 `tools/ci/report-browsers.mjs`

### What it is and why it exists

A 41-line diagnostic that prints which Edge or Chrome executable exists on this
machine. It is **not a gate** and never fails the build.

> ```
> // It exists so that a skipped PDF test is attributable — "skipped because this
> // runner has no Chrome" is a fact somebody can check, "skipped" on its own is
> // indistinguishable from a test that quietly stopped running.
> // It is NOT a gate and never fails the build: the gate is npm test, which
> // rejects any skip that carries no reason.
> ```

And why it is a file rather than an inline one-liner in the YAML:

> `// Written as a file rather than an inline node -e in the workflow because`
> `// the Windows paths below contain backslashes and spaces, and this same step`
> `// runs under PowerShell on the windows-latest legs.`

### How you run it, and what it prints

```bash
node tools/ci/report-browsers.mjs
```

Real output from the development machine:

```
platform: win32 / node v24.13.1
PDF browser present: C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe,
                     C:\Program Files\Google\Chrome\Application\chrome.exe
=> render-pdf and ats-lint PDF tests should RUN on this leg.
```

On a runner with none, it prints `PDF browser present: NONE` and _"=> render-pdf
and ats-lint PDF tests will SKIP on this leg, with a reason. Set PDF_BROWSER, or
install a browser, to close that hole."_ It always exits 0. It has no flags.

### How it works

One array of candidate paths — `process.env.PDF_BROWSER` first, then four Windows
locations, then three Linux ones — filtered by `fs.existsSync`. `.filter(Boolean)`
drops the environment variable when it is unset.

### Traps

> **Known duplication (2026-08-05).** The candidate list is byte-identical to the
> one inside `findBrowser()` in `src/documents/render-pdf.mjs`, and nothing
> enforces that they stay in sync. The file says so — _"Keep the candidate list
> in sync with findBrowser() in src/documents/render-pdf.mjs"_ — but a
> comment is not a check.

---

## 3.3 `tools/ci/scaffolding-reaper.mjs`

### What it is and why it exists

Development sometimes needs temporary code: a fake server, a throwaway harness, a
stub. The promise is always "we'll delete it later". The reaper turns that
promise into something the build can check.

> ```
> // docs/team-roster.md ("Skills and scaffolding") says ci-engineer **fails
> // the build** when a scaffolding artifact outlives its phase (so did the
> // autonomy plan doc, deleted 2026-08-06). Until 2026-07-31 that was a
> // comment in ci.yml and nothing else — a documented capability that did
> // not exist… This is the capability.
> ```

### The declaration contract

A file declares itself temporary by putting three keys in its **leading block**:

```yaml
---
name: fake-board-runner
scaffolding: true
remove_after: phase-2
owner: qa-adversary
---
```

| key            | required | meaning                                                   |
| -------------- | -------- | --------------------------------------------------------- |
| `scaffolding`  | yes      | must be exactly `true`; without it the file is ignored    |
| `remove_after` | yes      | the last phase in which this file may still exist         |
| `owner`        | no       | who owes the deletion; reported as `UNASSIGNED` if absent |

**Where the block may be** is narrow on purpose:

- `.md` / `.markdown` / `.yaml` / `.yml` → the `---` YAML frontmatter at the very
  top of the file (frontmatter is a small block of settings fenced by `---` lines
  before the document's real content);
- `.mjs` / `.js` / `.cjs` → the contiguous `//` comment block at the very top,
  before any code.

> ```
> // Anything further down is prose ABOUT the convention, not a declaration.
> // That distinction is load-bearing here: docs/team-roster.md and
> // .claude/agents/*.md contain the literal text scaffolding: true inside
> // fenced examples (so did the deleted autonomy plan doc). A reaper that
> // grepped the whole file would fail the build on its own documentation, get
> // muted within a day, and protect nothing.
> ```

And the keys must sit at **column 0**, with no leading spaces. That rule has its
own small masterclass of a comment:

> ```
> // COLUMN 0, and this is not cosmetic. The first version accepted leading
> // whitespace and immediately flagged THIS FILE — the worked example in the
> // comment block above parsed as a live declaration owned by qa-adversary.
> // … The fix is a real YAML rule rather than a patch: a top-level key sits at
> // column 0. An indented scaffolding: is a NESTED key and means something else,
> // so refusing it is correct parsing, not a workaround. It also gives every
> // file a free way to show an example — indent it.
> ```

### How you run it

```bash
npm run reap                                           # the real check
node tools/ci/scaffolding-reaper.mjs --json   # machine-readable
node tools/ci/scaffolding-reaper.mjs --self-test
node tools/ci/scaffolding-reaper.mjs --root ./some/tree --phase phase-2
```

| flag           | meaning                                                                          |
| -------------- | -------------------------------------------------------------------------------- |
| `--root <dir>` | walk this tree instead of the repository root (used by tests over fixtures)      |
| `--phase <p>`  | pretend the project is at phase `p` instead of `package.json`'s `phases.current` |
| `--json`       | emit `{root, phase, artifacts, live, expired, problems}` instead of prose        |
| `--self-test`  | run the built-in assertions proving the checker can go red; exit 0 or 1          |

**Exit codes:** `0` pass, `1` fail (or a failed self-test), `2` unknown option.

Real output from the current repository:

```
scaffolding-reaper — PASS
  phase       phase-5   (phase-1 → phase-2 → phase-3 → phase-4)
  scanned     .
  declared    0 scaffolding artifact(s)
  Nothing is currently marked "scaffolding: true" in a leading frontmatter/comment
  block. That is a real pass, not an inert check: run --self-test to see it go red
  on purpose.
```

Live artifacts print as `[owed] <file> — remove after <phase> (owner: …)` and
expired ones as `[MUST GO] …`, followed by `ERROR:` lines. As with the test gate,
a markdown table is appended to `$GITHUB_STEP_SUMMARY` when that variable exists.

### Everything it exports

Unlike the test gate, this file **is** also a library — importing it runs
nothing, thanks to the `isMain` guard at the bottom.

```js
export function frontmatterBlock(text)             // → string | null
export function leadingCommentBlock(text)          // → string | null
export function declarationBlock(file, text)       // → string | null (dispatches on extension)
export function readDeclaration(block)             // → {remove_after, owner} | null
export function findArtifacts(root)                // → {artifact, remove_after, owner}[]
export function judge(artifacts, {current, order}) // → {problems, live, expired}
export function loadPhases(root, override)         // → {order, current}
```

### How it works, step by step

1. `loadPhases` reads `phases.order` and `phases.current` from `package.json`,
   falling back to `["phase-1" … "phase-4"]` if the file cannot be read.
2. `findArtifacts(root)` walks the tree, sorted for determinism, skipping
   `node_modules`, `.git`, `worktrees`, `jobs`, `profile`, `.playwright-mcp`,
   `dist` and `coverage`, and only reading files with a text extension. There is a
   cheap reject first: `if (!text.includes("scaffolding")) continue`.

   `worktrees` is called out specifically: _"it holds checkouts of other
   branches, and a stale scaffolding declaration in one of those is not this
   build's problem."_

3. For each candidate, `declarationBlock` picks frontmatter or leading comment by
   file extension, and `readDeclaration` pulls the three keys out with these
   column-0 patterns:

   ```js
   scaffolding: /^scaffolding[ \t]*:[ \t]*true[ \t]*(?:#.*)?$/m
   remove_after: /^remove_after[ \t]*:[ \t]*["']?([A-Za-z0-9._-]+)["']?/m
   owner: /^owner[ \t]*:[ \t]*["']?([^"'\r\n#]+)["']?/m
   ```

4. `judge()` applies three rules in order:

   | rule | condition                                   | why it is a failure                                                                 |
   | ---- | ------------------------------------------- | ----------------------------------------------------------------------------------- |
   | 2    | `scaffolding: true` with no `remove_after`  | _"An unbounded promise is exactly what this check exists to prevent"_               |
   | 3    | `remove_after` names a phase not in `order` | _"a phase that does not exist can never pass, so this artifact would live forever"_ |
   | 1    | `nowIdx > idx` — the declared phase is past | the point of the whole check                                                        |

Worked example, with a file that does not exist. Suppose a `fake-board.md`
under `tests/fixtures/` declared
`scaffolding: true`, `remove_after: phase-2`, `owner: qa-adversary`, and the
project is at `phase-3` with `order` containing all four phases. Then
`order.indexOf("phase-3")` is 2, `order.indexOf("phase-2")` is 1, `2 > 1`, and
the build fails with:

```
[MUST GO] tests/fixtures/<name>.md — remove_after phase-2 (owner: qa-adversary)
ERROR: tests/fixtures/<name>.md was to be REMOVED AFTER phase-2; the project is
now at phase-3. Delete it, or move remove_after forward on purpose and in writing.
Owner: qa-adversary.
```

### `--self-test` and why it has three sections

Section 1 drives `judge()` over five synthetic artifacts. Sections 2 and 3 exist
because of a gap someone filed, and the reasoning generalises to any checker you
will ever write:

> ```
> // The original self-test drove judge() and nothing else. But every declaration
> // that ever reaches judge() has to survive frontmatterBlock /
> // leadingCommentBlock / readDeclaration / findArtifacts first, and a break in
> // ANY of those makes the walk return an empty array. judge([]) reports no
> // problems, so the real run prints "declared 0 … that is a real pass" and
> // --self-test prints 5/5. Two green outputs over a checker that inspected
> // nothing — the exact shape this whole pipeline exists to prevent, one level
> // down inside the thing that prevents it.
> ```

Section 2 tests the parser in both directions over in-memory text. Two of its
cases are worth knowing:

- One case exists purely to pin a **slice boundary**: _"changing `norm.slice(4,
end)` to `slice(5, end)` passed all the other cases, because every one of them
  opens with `name:` and only loses a character off a key nobody reads. A file
  whose FIRST key is the declaration is the shape that break eats."_
- Two cases use CRLF line endings: _"Windows is the primary platform here, so a
  hand-written .md arrives with CRLF. A parser that only handles LF would read
  zero declarations on the user's own machine and report it as a pass."_

Section 3 creates a real temporary directory containing `expired.md`, `prose.md`
and `node_modules/vendored.md`, asserts the walk finds exactly one artifact,
asserts `judge` goes red on it, deletes it, and asserts the same tree then goes
green.

### Traps and things not to "fix"

- **The self-test uses its own hardcoded phases**, `{order: [phase-1, phase-2,
phase-3], current: "phase-2"}`, which is why a green self-test does not prove
  the real phase configuration is sane.
- **`--root` moves the walk but not the phases.** `loadPhases(DEFAULT_ROOT,
opts.phase)` always reads the repository's own `package.json`, even when
  `--root` points somewhere else. Use `--phase` to change the phase.
- **Zero artifacts is a real pass and says so out loud.** Do not "improve" that
  message into a silent tick.

> **Known defect (2026-08-05 audit): rule 1 cannot currently fire.**
> `package.json` sets `phases.current: "phase-5"` while `phases.order` stops at
> `phase-4`, so `nowIdx` is `-1` and `nowIdx > idx` is false for every artifact
> with a valid phase. An artifact declaring `remove_after: phase-4` today would
> be reported as `[owed]`, not as expired. Rules 2 and 3 still work, and an
> artifact declaring `remove_after: phase-5` would still be caught by rule 3
> (unknown phase). `tests/hooks/scaffolding-reaper.test.mjs` asserts the
> repository currently declares zero scaffolding artifacts, which is why this is
> latent rather than producing a wrong verdict today. Fix by adding `phase-5` to
> `order`.

### What it depends on, and what depends on it

Imports `node:fs`, `node:os`, `node:path`, `node:url`. Reads `package.json`.
Depended on by `npm run reap`, the CI `scaffolding` job, and
`tests/hooks/scaffolding-reaper.test.mjs`.

---

## 3.4 `tools/ci/perf-gate.mjs`

### What it is and why it exists

The owner benchmarks this pipeline against a commercial product and treats
slowness as a defect. Without a committed baseline and a mechanical comparison,
"it got slower" is an opinion. This gate runs a fixed benchmark workload against
the local fake job board, compares five numbers against
`docs/perf-baseline.json`, and fails the build on a regression.

It also carries a **security** rule that is not really about performance at all:
if the `model_turns_per_app` column is anything other than zero, a language model
ended up on the unattended application path — which is precisely the change hard
rule 6 exists to prevent.

### How you run it

```bash
node tools/ci/perf-gate.mjs                 # check against the baseline
node tools/ci/perf-gate.mjs --update        # write a new baseline
node tools/ci/perf-gate.mjs --json
node tools/ci/perf-gate.mjs --allow-dirty   # passed through to the harness
```

Argument handling is `argv.includes(...)`, not a parser. **Exit:**
`process.exitCode = 1` when any finding has severity `fail`; otherwise 0. If the
benchmark harness itself fails, the gate exits with the harness's status and
prints the harness's own message.

### The fixed workload

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

> `// The gate's own command. Fixed here rather than passed in, because a gate`
> `// whose workload is a parameter is a gate whose baseline means nothing.`

The board **mix** is deliberate too:

> `// --board greenhouse alone gives defer_rate = 1.0 by construction (that`
> `// fixture carries a consent tickbox), so submitted throughput is structurally`
> `// zero and the defer-rate rule can never move. A gate whose columns cannot`
> `// move is not a gate.`

### The five rules

| column                | statistic                               | severity | overridable by | limit                 |
| --------------------- | --------------------------------------- | -------- | -------------- | --------------------- |
| `model_turns_per_app` | mean over the run                       | **fail** | **never**      | `0`                   |
| `sleep_ms_per_app`    | mean                                    | fail     | `sleep_ms`     | `base * 1.1 + budget` |
| `round_trips_per_app` | mean                                    | fail     | `round_trips`  | `base + budget`       |
| `defer_rate`          | mean                                    | fail     | **never**      | `base + 0.02`         |
| `wall_ms_p95`         | p95, compared on the median of the runs | **warn** | never          | `base * 1.25`         |

Every rule carries its own `why` string, and the header explains why the
strengths differ. On `model_turns`:

> ```
> // HARD, NO OVERRIDE — model_turns. Green tier is DEFINED as removing the
> // model from the path… an override here would let the single change this whole
> // plan exists to prevent — a model reading an attacker-controlled page in the
> // same context as the fact base — land behind a one-line PR annotation.
> ```

Its rule also treats a missing measurement as a failure: `bad: (v, limit) => v
=== null || v > limit`, because _"an unmeasured column cannot clear a hard
gate."_

On `defer_rate`: _"a rising defer rate is the machine understanding LESS. It is
not overridable because the sanctioned ways to move it are all in the other
direction: an adapter, a probed option list, or a banked answer."_

On `wall_ms_p95`: _"the noisiest column; hard-failing on it teaches people to
ignore red."_

(A **p95** is the 95th percentile — the value 95% of measurements come in under.
It describes the slow tail, which an average hides.)

### Everything it exports

| export                                    | role                                                                                     |
| ----------------------------------------- | ---------------------------------------------------------------------------------------- |
| `BASELINE_PATH`                           | `docs/perf-baseline.json`                                                                |
| `GATE_ARGS`                               | the fixed workload above                                                                 |
| `RULES`                                   | the five rules as data: `{key, statistic, severity, overridable, pick, limit, bad, why}` |
| `parseBudget(body)`                       | scans a pull-request body for `perf-budget: <column> +N` lines                           |
| `acrossRuns(runs, rule)`                  | the **median** across the three runs                                                     |
| `evaluate(result, baseline, budget = {})` | returns the findings array                                                               |
| `toBaseline(result, provenance)`          | the shape written by `--update`                                                          |

The rules are data rather than code _"so the rule set is readable in one screen
and so a test can drive each rule with a synthetic pair rather than by regressing
the real tree."_

### How `evaluate()` works, in order

1. **Concurrency check first.** If the observed maximum in-flight count never
   reached the requested concurrency, a `fail` finding is emitted before any
   column is compared: _"every throughput number in this run is reported under a
   label the run did not run at, so none of them may be compared or banked."_
2. **The ledger invariant, per run:** `durable_rows === reached_authorized` and
   `rows_in_state_attempted === 0`. A job left in `attempted` means _"a click was
   issued and nothing ever said what happened next."_

   The correction story attached to this rule is worth reading twice:

   > ```
   > // Revision 1 of the plan wrote this as durable_attempted_rows != apps_started,
   > // which contradicts its own state machine: deferrals exit BEFORE the
   > // attempted row is written, and there are 14 pre-attempt defer kinds, so that
   > // gate would have been red on every run by construction. Within a week it
   > // would have been passing with an override line — the exact failure the plan
   > // reasons about correctly elsewhere and then walked into.
   > ```

3. **For each rule:** take the median across runs; look up the baseline column.
   No baseline produces a `warn` ("nothing to compare against (run --update)"),
   never a silent pass. Otherwise apply the PR-body budget if the rule is
   overridable, compute the limit, and test.

### What it reads and writes

Shells out to `src/dev/bench-runner.mjs` (documented in
[`15-benchmarks.md`](15-benchmarks.md)). Reads and, under `--update`, writes
`docs/perf-baseline.json`. Reads `PR_BODY`, falling back to reading the pull
request body out of the file named by `GITHUB_EVENT_PATH`.

The current baseline:

```json
{
  "taken_at": "2026-08-03T04:28:54.530Z",
  "runs": 3,
  "columns": {
    "model_turns_per_app": 0,
    "sleep_ms_per_app": 450,
    "round_trips_per_app": 60,
    "defer_rate": 0.5,
    "wall_ms_p95": 1565.31
  },
  "provenance": { "sha": "9905681", "dirty_measured_files": [], "file_sha1": { … } }
}
```

`toBaseline` records the statistic name beside every number, because _"'sleep
went up' is not a claim until you know whether that is a mean, a min or a p50."_

### Traps and things not to "fix"

- **`maxBuffer: 64 * 1024 * 1024`.** The JSON from 3 × 50 applications is large,
  and Node's default 1MB buffer would truncate it into a parse error.
- **The error handling prints the harness's message, not a stack trace**, and the
  comment explains why that is a design decision rather than tidiness:

  > `// The commonest non-zero exit is the dirty-tree refusal, which is not a bug —`
  > `// it is the harness declining to produce a number that cannot be compared. In`
  > `// CI it never fires (a checkout is committed); locally it fires constantly,`
  > `// and a wall of execFileSync internals in place of one sentence is how a`
  > `// correct refusal gets mistaken for a broken gate and worked around.`

- **`--allow-dirty` has exactly one legitimate use:** proving the gate can go red
  by deliberately breaking something. _"Anything it prints under that flag is
  evidence about the GATE, never a number to bank."_
- **The gate's falsifiability was proved by mutation, not argued.** From
  `ci.yml`: adding a `waitForTimeout(200)` to the fill engine's verify step turns
  `sleep_ms` red and a matching budget line clears it; adding an outbound HTTPS
  request to a model provider in the fill planner turns `model_turns` red **and
  is not cleared** by `perf-budget: model_turns +99`.

### What it depends on, and what depends on it

Imports `node:fs`, `node:path`, `node:child_process`, `node:url`. Depended on by
the `perf-gate` CI job and by `tests/hooks/perf-gate.test.mjs`, which imports
`RULES`, `evaluate`, `parseBudget`, `acrossRuns`, `toBaseline` and
`BASELINE_PATH` and drives each rule with synthetic pairs.

---

# Part 4 — The dotfiles

These are the small configuration files whose names begin with a dot. Each is
short. Several contain a single line that is load-bearing, and the comments
around them exist because someone lost time to the alternative.

## 4.1 `.gitignore`

### What it is and why it exists

A list of paths git must not track. In this project it does two jobs, and the
second is the one people forget: it keeps personal data and credentials **out**,
and it keeps test inputs **in**.

### Every rule, and its reasoning

```gitignore
profile/*
!profile/profile.example.yaml
```

> `# NOTE: must be profile/* (not profile/) — git never descends into a fully`
> `# ignored directory, which would make the example-file negation dead.`

This is a genuine git rule most people do not know. Once a **directory** is
ignored, git does not look inside it at all, so a `!` un-ignore for a file within
it can never take effect. `profile/*` ignores the directory's _contents_, which
leaves the negation working.

```gitignore
/jobs/
```

> `# ANCHORED with a leading slash, and it must stay that way. An unanchored`
> `# jobs/ matches a directory of that name at ANY depth, which silently swallowed`
> `# all 8 of Phase 3's input fixtures in tests/documents/assemble/jobs/ — their`
> `# golden files committed, their inputs did not, so the byte-identical check`
> `# would have been untestable on a fresh clone while passing locally.`

```gitignore
*.tmp
```

Scratch copies of the fact base. A documented repair recipe stages the real
`answers.yaml` at the **repository root**, and `profile/*` does not cover the
root — so a half-run recipe would leave the user's answers sitting outside every
ignore rule. Found untracked and uncovered on 2026-07-31.

```gitignore
.env
node_modules/
*.log
```

```gitignore
.playwright-mcp/
.playwright-auto/
```

> `# BOTH of these hold the user's REAL ATS session cookies. That is the whole`
> `# reason they are here, and it is why neither may ever be committed.`

`.playwright-mcp/` is the browser profile the agent's browser uses;
`.playwright-auto/` belongs to the unattended runner. The second was missing
until 2026-07-31, and the script that refreshes it refuses to run when it is not
ignored (`code: "not_ignored"`) — a deliberate refusal rather than a silent sync
into a tracked directory.

```gitignore
*.pdf
*.html
!templates/*.html
!tests/fixtures/**/*.html
!tests/fixtures/**/*.pdf
```

> `# Test fixtures are SOURCE, not artifacts. Without these negations the *.html`
> `# rule above silently swallowed 10 files the moment they were written…`
> `# They passed locally and would have been absent from the clone CI checks out —`
> `# a suite that is green on one machine and missing its inputs on every other.`

```gitignore
logs/
```

Machine-local run records from the unattended cycle script.

### The standing check

`tests/hooks/repo-hygiene.test.mjs` runs `git check-ignore --stdin` over every
file under `tests/` and fails if any of them is ignored. Its header states the
principle:

> `// Written because of a real near-miss on 2026-07-31: the *.html rule in`
> `// .gitignore silently swallowed all ten HTML fixtures… Nothing in the suite`
> `// would have noticed, because a test's inputs are invisible to the test.`

That last clause is the durable idea. A test cannot notice that its own input
file is missing from the repository, because on the machine where it was written
the file is right there.

### Traps

- Never change `profile/*` to `profile/`.
- Never remove the leading slash from `/jobs/`.
- If you add a broad extension rule (`*.something`), check whether it swallows a
  test fixture, and add the matching `!tests/fixtures/**/…` negation.

---

## 4.2 `.gitattributes`

### What it is and why it exists

Five lines, one rule:

```gitattributes
# Force LF in working trees on every platform. Tests compare multiline JS
# template literals (always LF — the spec normalizes CRLF in literals) against
# file contents read raw from disk; CRLF checkouts silently break those
# comparisons on Windows.
* text=auto eol=lf
```

Text files end their lines differently on different systems: Unix uses a single
LF character, Windows historically uses CR followed by LF. Git's default on
Windows converts LF to CRLF when it writes files into your working tree.

Meanwhile the JavaScript language specification normalises CRLF to LF **inside
template literals** (the multi-line strings written between backticks). So a
test written like this:

```js
assert.equal(
  fs.readFileSync(f, "utf8"),
  `line one
line two
`,
)
```

compares CRLF-from-disk against LF-in-source and fails for a reason that has
nothing whatever to do with the code being tested. `* text=auto eol=lf` forces LF
in the working tree on every platform, which removes the entire class of failure.

**Do not "helpfully" remove this to match Windows convention.** It is one line
that prevents a category of confusing, platform-specific test failures.

Related, and not contradictory: `scaffolding-reaper.mjs`'s parser has explicit
CRLF test cases anyway, because a file the **user types by hand** is not subject
to git's normalisation until it is committed.

---

## 4.3 `.prettierrc`

```json
{
  "semi": false
}
```

The whole project's formatting convention: **no statement-terminating
semicolons**. Everything else is prettier 3's defaults — two-space indentation,
double quotes, an 80-column target width, trailing commas in multi-line
structures.

This one setting is why every JavaScript file in the repository reads the way it
does, and it is also why `.prettierignore` needs two of its three contract
entries — see below.

---

## 4.4 `.prettierignore`

### What it is and why it exists

Files prettier must not touch. Five are ordinary housekeeping:

```
node_modules/
package-lock.json
profile/
jobs/*/*.pdf
.playwright-mcp/
```

The rest are **contracts** — each entry carries its reason as a comment, and
`tests/quality/format.test.mjs` asserts the entries are present, so deleting
one fails the build. The original three (below) got company on 2026-08-27; the
newer entries share one shape: **bytes something else depends on staying
exactly as written**.

```
tests/fixtures/post-submit/captures/   # the classifier's evidence corpus
jobs/.auto/                            # staged captures awaiting review
tests/fixtures/hostile/                # byte-precise attack fixtures
.claude/worktrees/                     # other sessions' checkouts
tests/fixtures/post-submit/corpus.json # machine-written capture manifest
docs/candidates/                       # machine-written board exports
eslint-suppressions.json               # eslint rewrites it in ITS formatting
```

The captures and hostile fixtures are evidence: a classifier rule is justified
by the bytes of a captured page, and a hostile-form test by the exact shape of
its attack — formatting either rewrites what the rule was justified by. The
machine-written files (the manifest, the candidate exports, the suppressions
ledger) would be reformatted by prettier and then rewritten by their owning
script on the next run, putting the format gate in a churn war with the
tooling. The three originals:

### The two skill files

```
# Loaded and eval'd as bare function expressions, not modules — prettier's
# leading-semicolon guard would make them unparseable.
.claude/skills/apply-job/scan.driver.mjs
.claude/skills/apply-job/scan-page.js
```

These two files are injected into a live web page and evaluated as a **single
expression**, not imported as modules. Because `.prettierrc` sets `"semi":
false`, prettier protects against JavaScript's automatic-semicolon-insertion
hazards by adding a **leading** semicolon to any line that would otherwise be
ambiguous. That turns `function (…) {…}` into `;function (…) {…}`, which is no
longer one expression and fails to evaluate. The scanner would stop working, in
the browser, at apply time.

### `docs/job-sources.yaml`

```
# manage-sources.mjs edits this file LINE BY LINE, to preserve the explanatory
# comments a full yaml round-trip would delete. That only works while every
# board is one flow-style entry on one line, which the file's own FORMAT RULE
# states. Prettier reflows the longer workday and oracle_cloud entries into
# multi-line block style, which silently breaks that contract.
docs/job-sources.yaml
```

A YAML "round trip" — parse to data, then write back out — discards comments,
because comments are not data. The board list is full of explanatory comments
worth keeping, so the script that adds and removes boards edits the file **as
text, line by line**. That only works while each board is one line in YAML's
compact flow style (`{a: 1, b: 2}`). Prettier reflows the longer entries into
multi-line block style and the line-based editor stops finding them — silently.

---

## 4.5 `.mcp.json`

### What it is and why it exists

MCP (Model Context Protocol) is the standard by which the agent gains extra
tools. This file declares one server: Playwright, which gives the agent a real
browser to read job postings and fill application forms with.

```json
{
  "$comment": "…",
  "mcpServers": {
    "playwright": {
      "type": "stdio",
      "command": "npx",
      "args": [
        "-y",
        "@playwright/mcp@latest",
        "--user-data-dir",
        ".playwright-mcp/profile",
        "--codegen",
        "none"
      ]
    }
  }
}
```

JSON has no comment syntax, so the reasoning lives in a `$comment` key:

> _"Milestone 2: Playwright MCP lets the agent read the job posting on screen and
> fill application forms. … `--user-data-dir` keeps a persistent browser profile
> so ATS logins (Workday, Greenhouse, Lever) survive between sessions instead of
> stalling the flow on a login wall. It lives under `.playwright-mcp/`, which is
> gitignored — it holds real session cookies, so never commit it. `--codegen
none` suppresses the 'Ran Playwright code' echo in every browser tool result;
> the executed source is echoed into agent context whether passed inline or by
> filename, and it is pure cost. Changing this file needs a session restart."_

| setting                                   | why                                                                                        |
| ----------------------------------------- | ------------------------------------------------------------------------------------------ |
| `"type": "stdio"`                         | the server is a child process; requests and responses travel over its input/output pipes   |
| `--user-data-dir .playwright-mcp/profile` | a persistent browser profile, so logins survive between sessions                           |
| `--codegen none`                          | suppresses an echo of the executed browser code into the agent's context — pure token cost |

### Traps

- **Changing this file needs a session restart** to take effect. This is in
  `CLAUDE.md`'s gotcha list for a reason: editing it and seeing no change is
  confusing.
- **The profile directory holds real ATS session cookies.** Treat it as a
  credential store. It is gitignored; never commit it, never copy it anywhere.

> **Known risk (AUDIT M13, still live 2026-08-05).** `-y @playwright/mcp@latest`
> resolves to whatever is newest at session start, with no review, and that code
> then drives a browser profile holding real session cookies. This project also
> depends on precise Playwright behaviours documented at length in the fill
> engine, so an upstream change is a functional risk as well as a supply-chain
> one. Pinning a version and bumping deliberately would close both.

> **Stale text (2026-08-05).** The `$comment` says _"The human always performs
> the final submit."_ That was the rule before 2026-08-03; `CLAUDE.md` hard rule
> 6 now says the agent clicks submit when the user hands it a posting URL, while
> the unattended path remains gated. The comment describes an older policy.

---

## 4.6 `.env.example`

### What it is and why it exists

`.env` is a plain-text file of environment variables — settings and secrets read
by the program at run time. It is gitignored and never leaves the machine.
`.env.example` is the committed template that tells you which variables exist,
without containing any real values.

```
# Copy this file to .env and fill in real values. .env is gitignored — never
# commit it.

# Adzuna job-search API (aggregator with salary data; covers thousands of
# employers incl. Fortune 500 Workday/Taleo boards that have no public feed).
# Register free at https://developer.adzuna.com/ -> create an app -> copy the
# Application ID and Application Key here.
ADZUNA_APP_ID=your_app_id_here
ADZUNA_APP_KEY=your_app_key_here

# Optional: Adzuna country code for searches (default: us)
# ADZUNA_COUNTRY=us
```

| variable         | required            | purpose                                     |
| ---------------- | ------------------- | ------------------------------------------- |
| `ADZUNA_APP_ID`  | for Adzuna searches | the application identifier                  |
| `ADZUNA_APP_KEY` | for Adzuna searches | the application key                         |
| `ADZUNA_COUNTRY` | no                  | country code for searches; defaults to `us` |

### Traps

- **`.env` contents never go into chat, documents or commits.** `CLAUDE.md` says
  so as a hard rule, alongside `profile/`.
- **Not every environment variable this project reads is listed here.**
  `PDF_BROWSER` (which overrides browser discovery for PDF rendering) is real and
  documented elsewhere but absent from this template; `PR_BODY`,
  `GITHUB_STEP_SUMMARY` and `GITHUB_EVENT_PATH` are CI-provided and would not
  belong here.

---

# If you were rebuilding this

Three decisions in this area carry almost all the value. Everything else is
detail you could re-derive.

**1. Assert the count, not the exit code.** The single highest-value idea in this
document is that `node --test` exits 0 over an empty run, so "the build was
green" is not evidence that anything ran. Any test runner you pick will have the
same property. If you rebuild nothing else here, rebuild the floor: a number in
configuration, checked against the count the runner reports, with a written
record of who measured it and on what tree. The naive version — a CI job that
runs the tests and trusts the exit code — reports success for a suite you
deleted, and reports it faster, which is exactly the incentive that makes the
failure stick.

The corollaries follow from the same idea and are all cheap: a required
directory that is missing or empty is a failure, not a pass; a `todo` cap of zero,
because converting a failing test to `todo` is the cheapest way to fake green;
and every skip must carry a reason, because an unattributed skip and a test that
silently stopped running look identical.

**2. Put the lock on every door, and put the wiring behind the same lock.** The
Edit/Write path and the shell path are two different ways to reach the same file,
and a project with only the first guarded is a project that _feels_ guarded. The
gap here was found by probing (`"probe" | Out-File .claude/hooks/__probe.txt`
succeeded) rather than by reading, which is the general lesson: test your guard
by attacking it, from every tool that exists.

Then include the configuration file that wires the guards in the protected set.
This is the step a naive design misses, and it is the cheapest possible bypass:
you never have to edit a guard to disable it if you can delete the line that
loads it. The accepted cost — nobody but the owner can wire a new hook — is the
right trade, because that file is precisely where a guardrail gets switched off.

**3. Build guards that do not over-deny, because an over-denying guard gets
deleted.** Two files in this area learned the identical lesson within a minute of
being written: `guard-bash.mjs` denied `git branch --show-current`, a read-only
query, and `guard-profile-shell.mjs` denied a `grep` of a script's source. Both
comments draw the same conclusion — _"an over-matching guard gets switched off"_
— and both were rewritten to match operations rather than mentions. That is why
one of them contains a hand-written shell tokenizer instead of a pattern.

The naive version is a list of regular expressions over the raw command string.
It will simultaneously block work that is fine and let through the three spellings
you did not think of (`git.exe`, `git -C .`, `git checkout -B`). If you cannot
afford a tokenizer, at least write down which direction each rule errs in, and
prefer over-denial only where the missed case is unrecoverable — a wrong branch
push, not a formatting hiccup.

A fourth, smaller point worth carrying: **make every checker able to prove it can
fail.** The reaper's `--self-test` exists because "0 findings" and "the checker is
broken" produce identical output, and its second and third sections exist because
the first version of the self-test proved only the verdict function while a break
anywhere upstream would have produced two green outputs over a checker that
inspected nothing.
