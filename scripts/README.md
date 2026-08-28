# `scripts/` — the six externally-pinned files

**Owner:** `ci-engineer`. **This directory is not where code lives.** The
pipeline moved to `src/` in the 2026-08-27 re-layout. Six files stayed behind,
and each one stayed for the same reason: **something outside this repository
names its path literally, and that something is the user's to change, not the
agent's.**

`tests/quality/structure.test.mjs` asserts two things about this directory: that
it holds exactly seven tracked entries — the six pinned files plus this README —
and, separately, that the **invocable** set (everything that is not a `.md`) is
exactly those six. Adding a seventh invocable file fails the build.

## The six

| File                        | Kind     | Pinned by                                                       |
| --------------------------- | -------- | --------------------------------------------------------------- |
| `hooks/guard-bash.mjs`      | shim     | `.claude/settings.json` → `node scripts/hooks/guard-bash.mjs`   |
| `hooks/guard-files.mjs`     | shim     | `.claude/settings.json` → `node scripts/hooks/guard-files.mjs`  |
| `hooks/prettify.mjs`        | shim     | `.claude/settings.json` → `node scripts/hooks/prettify.mjs`     |
| `auto/cycle.cmd`            | shim     | the Windows Scheduled Task `AgenticJobApplication`, 07:00 daily |
| `profile/save-answer.mjs`   | **real** | `.claude/hooks/guard-profile-shell.mjs` matches this exact path |
| `profile/apply-profile.mjs` | **real** | the same hook, the same regex                                   |

## Why the two `profile/` files are real files and not shims

`.claude/hooks/guard-profile-shell.mjs` is **sealed** — the user's file, on both
the Edit/Write and the shell paths. It contains this test:

```text
/\bnode(?:\.exe)?\b[^|;&]*\bscripts\/profile\/(?:save-answer|apply-profile)\.mjs/i
```

A command that matches it is required to carry `--file <temp>`,
`--user-approved` or `--rescan`, and is denied otherwise. That denial is the
guard that stopped two agents writing fabricated answers into the real fact base
on 2026-07-31 — one of them a phone number that would have been typed into a real
application as fact.

Now trace what a move would do. The invocation's path would begin
`src/profile/` instead of the `scripts/profile/` the regex names, so the
approval requirement never fires. It also does not
match the hook's second stage, which looks for `profile/answers.yaml` and friends
as an operand — the command names `save-answer.mjs`, not the YAML. Both stages
fall through and the hook **returns without denying**. The write proceeds with no
approval flag and nothing in the transcript saying so.

So these two are not shims and must not become shims: **the guard keys on the
path, and the path is the guard.** They are moved only in the same change that
the user makes to `.claude/hooks/guard-profile-shell.mjs`, which is theirs alone.

## How the four shims work, and why not a re-export

Each hook shim is five lines and does exactly one non-obvious thing:

```js
process.argv[1] = fileURLToPath(target) // BEFORE the import
await import(target.href)
```

**A bare re-export shim silently no-ops and exits 0.** Measured 2026-08-27:
`export * from "../../src/hooks/guard-bash.mjs"` runs nothing, because the
target's entry-point guard compares `process.argv[1]` against its own path,
concludes it was merely imported, and does not execute. Exit code 0 is what a
PreToolUse hook returns to mean "allowed", so a guard-bash shim in that shape
would disarm branch protection while every run looked normal. Rewriting
`process.argv[1]` first is what makes the forward indistinguishable from direct
invocation for any target that asks.

Two more properties, both deliberate:

- The deprecation notice goes to **stderr**, never stdout. Stdout is the hook
  protocol channel; a stray line there is parsed as a hook decision.
- stdin, stdout and the exit code pass through untouched.

`auto/cycle.cmd` is the same idea in batch: it `call`s `src\auto\cycle.cmd` and
exits with `%ERRORLEVEL%`. The real `cycle.cmd` pins the repository root itself,
so no `pushd` is needed.

`tests/quality/shims.test.mjs` asserts parity — each shim's exit code and stdout
match direct invocation, and the deprecation line is on stderr — for as long as
the shims exist.

## When each shim may be deleted

Never on the agent's initiative. Each waits on an act only the user can perform:

1. **The three hook shims** — after the user edits `.claude/settings.json` to
   invoke `node src/hooks/<name>.mjs`, and the hooks are live-fire verified
   (edit a scratch file and observe prettier run; attempt a `git checkout main`
   and observe the refusal).
2. **`auto/cycle.cmd`** — after the Scheduled Task's action points at
   `src\auto\cycle.cmd`. As of 2026-08-27 the registered action is
   `…\scripts\auto\cycle.cmd --skip-apply`; check it with
   `(Get-ScheduledTask AgenticJobApplication).Actions`.

Until then, deleting a shim breaks a guardrail or a scheduled run silently, which
is the failure mode this whole arrangement exists to avoid.

## What does not belong here

Anything else. New code goes in `src/<domain>/`; CI helpers go in `tools/ci/`.
If you find yourself wanting a seventh file here, the question to answer first is
which external, user-owned thing names its path — and if the answer is "nothing",
it belongs in `src/`.
