# `src/hooks/` — the agent-editable guardrails

**Owner:** `ci-engineer`.

Three small programs Claude Code runs before or after a tool call. They are
enforcement an agent cannot argue with: a `deny` is a denial, not advice.

| File              | Fires on                    | What it does                                               |
| ----------------- | --------------------------- | ---------------------------------------------------------- |
| `guard-bash.mjs`  | PreToolUse, Bash/PowerShell | Refuses any git command that leaves or acts outside `dev`. |
| `guard-files.mjs` | PreToolUse, Edit/Write      | Refuses any write whose path lands outside the project.    |
| `prettify.mjs`    | PostToolUse                 | Runs prettier on every file the agent edits. Never blocks. |

## The two-owner rule

These three are **agent-editable**. `.claude/hooks/*` and
`.claude/settings*.json` are **the user's alone** and sealed on both the
Edit/Write and the shell paths — `settings.json` included, because it **wires**
every hook. An agent that could rewrite the wiring could switch off every other
rule, which is why that half is out of reach.

## The wiring still points at `scripts/`

`.claude/settings.json` invokes `node scripts/hooks/<name>.mjs`. Those three
paths are forwarding shims that rewrite `process.argv[1]` and import the file
here. They exist because repointing the sealed settings file is the user's act.
Do not delete a shim before that happens: [`../../scripts/README.md`](../../scripts/README.md).

## What does not belong here

- Any check that belongs in a test. A hook fires on a tool call, so it sees one
  edit at a time and cannot reason about the tree; `tests/quality/` can.
- Anything slow. A hook runs on every matching tool call, and its latency is
  paid by every session.
- Blocking behaviour in `prettify.mjs`. It formats and gets out of the way; a
  formatter that can deny a write is a formatter that can wedge a session.

## Patterns both guards share

- **Never `process.exit()` after printing a decision** — the decision goes out on
  stdout and the process must be allowed to flush it.
- **Read all of stdin, strip the BOM, fail open on garbage.** A guard that
  crashes on malformed input would deny everything, and a guard that denies
  everything gets switched off.
- **An over-matching guard gets switched off.** `guard-bash.mjs` once denied
  `git branch --show-current`; `guard-profile-shell.mjs` once denied a `grep` of
  a script's own source. Both match operations, never bare mentions.

Detail: [`../../docs/code/12-harness-and-ci.md`](../../docs/code/12-harness-and-ci.md).
