#!/usr/bin/env node
// PreToolUse hook (Bash|PowerShell): git branch policy for this project.
// Only the `dev` branch may be used: switching/creating any other branch is
// denied, state-changing git commands are denied unless HEAD is already on
// `dev`, and pushing to main/master is always denied. The user controls how
// dev merges into main. (CLAUDE.md hard rule 7.)
//
// File create/delete shell commands are no longer blocked here (user decision,
// 2026-07-27): interactive development may manage files freely. The
// job-application flows are restricted to jobs/<slug>/ by their skill
// instructions instead.
//
// 2026-07-31: the policy above is unchanged; HOW it is matched was rewritten.
// The regex form over-matched and under-matched at the same time:
//
//   OVER — `git branch --show-current` (a read-only query) was denied with
//   "Branch create/delete/rename is blocked", because the branch rule matched
//   any `git branch` followed by a dash. Observed in a real session.
//
//   UNDER — three ways to leave `dev` slipped through, because the rules
//   anchored the subcommand directly after the word `git`:
//     `git checkout -B main`   (-B/-C force-create were not in the create list)
//     `git -C . checkout main` (a global option before the subcommand)
//     `git.exe checkout main`  (the program-name match required a bare `git`)
//
// So the command is now TOKENIZED (quote-aware) and dispatched on the parsed
// subcommand instead of pattern-matched over the raw string. That also retires
// a whole bug class the old comment had to warn about: "main" inside a commit
// message is now an argument of `commit`, not a candidate push ref, by
// construction rather than by a `[^;&|]*` scoping trick.
//
// What `git branch` may do is decided by an ALLOWLIST of read-only flags, from
// probing real git rather than from reading the manual:
//   - `git branch -v probe` CREATES branch `probe` — `-v` does not imply list
//     mode, so a positional after it is a branch name, not a pattern.
//   - `git branch --contains HEAD` / `--merged=HEAD x` / `--format x` consume
//     their value and never create, so those queries stay allowed.
// Anything not on the allowlist is denied: a guardrail fails closed.
//
// NOTE: no process.exit() after writing — on Windows, exiting immediately after
// console.log drops buffered pipe output (same caveat as protect-profile.js).
import { spawnSync } from "node:child_process"

function deny(reason) {
  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    }),
  )
}

function currentBranch(cwd) {
  // --show-current works even on a freshly-initialized (unborn) branch and
  // prints empty on detached HEAD; both rev-parse variants error there.
  const res = spawnSync("git", ["branch", "--show-current"], {
    cwd,
    encoding: "utf8",
  })
  const name = res.status === 0 ? res.stdout.trim() : ""
  return name || null // null = branch unknown (detached/not a repo) → allow
}

// ------------------------------------------------------------ heredoc bodies
// A heredoc body is DATA, not commands — the same distinction the over-match
// fix was about, one layer down.
//
// 2026-07-31, found by the build-manager when this hook denied their own
// commit: newline is a clause separator, so every line of
//
//     cat > /tmp/msg.txt <<'EOF'
//     ...prose quoting `git checkout -B main` as an example...
//     EOF
//     git commit -F /tmp/msg.txt -- <paths>
//
// was analysed as if it were a command, and the quoted PROSE tripped the
// branch rule. This repo's commit messages quote commands as a matter of
// style, so it would have recurred on nearly every commit.
//
// Bodies are therefore blanked before tokenizing. Two rules keep that from
// becoming a bypass, both erring towards over-denial:
//   1. If the terminator never appears, nothing is skipped — an unterminated
//      heredoc is not a runnable command anyway, so analysing its lines as
//      commands costs nothing and skipping them would hide everything after.
//   2. If the line opening the heredoc runs an INTERPRETER (`bash <<'EOF'`,
//      `ssh host <<EOF`), the body IS commands and is left alone.
// The terminator is matched on the TRIMMED line, which ends a body at the
// earliest plausible point; ending late would swallow real commands.
const INTERPRETERS =
  /(^|[\s;&|(])(bash|sh|zsh|ksh|dash|ash|pwsh|powershell|ssh|su|sudo|env|xargs|eval|source|iex|Invoke-Expression)([\s;&|(]|$)/i

function consumeBodies(cmd, start, pending) {
  let pos = start
  for (const { delim, stripTabs } of pending) {
    let closed = false
    while (pos <= cmd.length) {
      const nl = cmd.indexOf("\n", pos)
      const lineEnd = nl === -1 ? cmd.length : nl
      const line = cmd.slice(pos, lineEnd)
      const cmp = stripTabs ? line.replace(/^\t+/, "") : line
      pos = nl === -1 ? cmd.length : nl + 1
      if (cmp.trim() === delim) {
        closed = true
        break
      }
      if (nl === -1) break
    }
    if (!closed) return null // unterminated → fail closed, skip nothing
  }
  return pos
}

// Replace heredoc / PowerShell here-string bodies with blanks, preserving
// newlines so line structure (and therefore clause splitting) is unchanged.
function maskHeredocs(cmd) {
  let out = ""
  let quote = null
  let pending = []
  let lineStart = 0
  const n = cmd.length
  let i = 0
  while (i < n) {
    const ch = cmd[i]
    if (quote) {
      out += ch
      if (ch === quote) quote = null
      i++
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      out += ch
      i++
      continue
    }
    // PowerShell here-string: @' or @" must sit at the end of its line.
    if (ch === "@" && (cmd[i + 1] === "'" || cmd[i + 1] === '"')) {
      const rest = cmd.slice(
        i + 2,
        cmd.indexOf("\n", i) === -1 ? n : cmd.indexOf("\n", i),
      )
      if (rest.trim() === "") {
        pending.push({ delim: cmd[i + 1] + "@", stripTabs: false })
        out += cmd.slice(i, i + 2)
        i += 2
        continue
      }
    }
    if (ch === "<" && cmd[i + 1] === "<" && cmd[i + 2] !== "<") {
      let j = i + 2
      let stripTabs = false
      if (cmd[j] === "-") {
        stripTabs = true
        j++
      }
      while (j < n && (cmd[j] === " " || cmd[j] === "\t")) j++
      let delim = ""
      if (cmd[j] === "'" || cmd[j] === '"') {
        const q = cmd[j++]
        while (j < n && cmd[j] !== q) delim += cmd[j++]
        j++
      } else {
        while (j < n && /[^\s;&|<>()]/.test(cmd[j])) {
          if (cmd[j] === "\\") j++
          if (j < n) delim += cmd[j++]
        }
      }
      if (delim) pending.push({ delim, stripTabs })
      out += cmd.slice(i, j)
      i = j
      continue
    }
    if (ch === "\n") {
      out += "\n"
      i++
      if (pending.length) {
        const opener = cmd.slice(lineStart, i)
        const end = INTERPRETERS.test(opener)
          ? null
          : consumeBodies(cmd, i, pending)
        if (end !== null) {
          out += cmd.slice(i, end).replace(/[^\n]/g, " ")
          i = end
        }
        pending = []
      }
      lineStart = i
      continue
    }
    out += ch
    i++
  }
  return out
}

// ---------------------------------------------------------------- tokenizer
// Split a command line into clauses at UNQUOTED separators, and each clause
// into tokens with quotes stripped. Newline is a separator: a multi-line Bash
// block is several commands, and missing that would hide every command after
// the first. `(` `)` and backtick are separators too, which is what lets
// `$(git branch --show-current)` be read as the harmless query it is.
const SEPARATORS = new Set([";", "|", "&", "\n", "\r", "(", ")", "`"])

function splitClauses(cmd) {
  const clauses = []
  let tokens = []
  let cur = ""
  let started = false // distinguishes an empty quoted token from no token
  let quote = null
  const endToken = () => {
    if (cur !== "" || started) tokens.push(cur)
    cur = ""
    started = false
  }
  const endClause = () => {
    endToken()
    if (tokens.length) clauses.push(tokens)
    tokens = []
  }
  for (const ch of cmd) {
    if (quote) {
      if (ch === quote) quote = null
      else cur += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      started = true
      continue
    }
    if (SEPARATORS.has(ch)) {
      endClause()
      continue
    }
    if (ch === " " || ch === "\t") {
      endToken()
      continue
    }
    cur += ch
  }
  endClause()
  return clauses
}

// ------------------------------------------------------------- git dispatch
const GIT_PROG = /^(?:.*[\\/])?git(?:\.exe)?$/i
// Global options that swallow the following token, so the subcommand is found
// after them: `git -C /repo checkout main` is still a checkout.
const GIT_GLOBAL_VALUE = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--exec-path",
  "--config-env",
  "--super-prefix",
])

function gitInvocation(tokens) {
  const gitIdx = tokens.findIndex((t) => GIT_PROG.test(t))
  if (gitIdx === -1) return null
  let i = gitIdx + 1
  while (i < tokens.length && tokens[i].startsWith("-")) {
    i += GIT_GLOBAL_VALUE.has(tokens[i]) ? 2 : 1
  }
  if (i >= tokens.length) return null
  return { sub: tokens[i], args: tokens.slice(i + 1) }
}

// ------------------------------------------------------- checkout / switch
const CREATE_FLAGS = new Set([
  "-b",
  "-B",
  "-c",
  "-C",
  "--create",
  "--force-create",
  "--orphan",
])
const CHECKOUT_VALUE_FLAGS = new Set([
  "--pathspec-from-file",
  "--start-point",
  "--conflict",
])

// The branch this checkout/switch lands on, or null when it changes no branch
// (`git checkout -- file`, `git checkout -p`).
function checkoutTarget(args) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === "--") return null // pathspec restore only
    // `git checkout -` / `git switch -` returns to the PREVIOUS branch, which
    // is exactly the branch the agent was told to leave. Not a flag.
    if (a === "-") return "-"
    if (CREATE_FLAGS.has(a)) return args[i + 1] ?? ""
    if (a.startsWith("-")) {
      if (CHECKOUT_VALUE_FLAGS.has(a)) i++
      continue
    }
    return a // first positional is the branch/ref
  }
  return null
}

// ----------------------------------------------------------------- branch
// Read-only single-letter flags; anything else (-d -D -m -M -c -C -u -f -t)
// mutates and is denied.
const BRANCH_RO_SHORT = new Set(["a", "r", "v", "q", "l", "i"])
const BRANCH_RO_LONG = new Set([
  "--all",
  "--remotes",
  "--verbose",
  "--quiet",
  "--list",
  "--show-current",
  "--ignore-case",
  "--omit-empty",
  "--color",
  "--no-color",
  "--column",
  "--no-column",
  "--abbrev",
  "--no-abbrev",
  "--sort",
  "--format",
  "--points-at",
  "--contains",
  "--no-contains",
  "--merged",
  "--no-merged",
])
// Probed: these consume the following token as their value and never create a
// branch, so `git branch --contains HEAD` is a query, not a mutation.
const BRANCH_VALUE_LONG = new Set([
  "--sort",
  "--format",
  "--points-at",
  "--contains",
  "--no-contains",
  "--merged",
  "--no-merged",
  "--abbrev",
])
// Flags that put git in list mode, so a trailing word is a PATTERN, not a new
// branch name. Probed: `--list x`, `-a x`, `--show-current x`, `--merged=HEAD x`
// all leave refs/heads untouched.
const BRANCH_LIST_MODE = new Set([
  "-l",
  "--list",
  "--show-current",
  "-a",
  "--all",
  "-r",
  "--remotes",
  "--contains",
  "--no-contains",
  "--merged",
  "--no-merged",
  "--points-at",
])

function branchIsReadOnly(args) {
  let listMode = false
  const positionals = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === "--") continue
    if (a.startsWith("--")) {
      const name = a.includes("=") ? a.slice(0, a.indexOf("=")) : a
      if (!BRANCH_RO_LONG.has(name)) return false // write flag or unknown
      if (BRANCH_LIST_MODE.has(name)) listMode = true
      if (!a.includes("=") && BRANCH_VALUE_LONG.has(name)) i++ // eat its value
      continue
    }
    if (a.startsWith("-") && a.length > 1) {
      for (const letter of a.slice(1)) {
        if (!BRANCH_RO_SHORT.has(letter)) return false
        if (letter === "a" || letter === "r" || letter === "l") listMode = true
      }
      continue
    }
    positionals.push(a)
  }
  if (positionals.length === 0) return true
  if (listMode) return true // patterns for a listing
  return positionals[0] === "dev" // creating/updating dev is allowed
}

// -------------------------------------------------------------------- push
function pushTouchesProtected(args) {
  if (args.includes("--mirror") || args.includes("--all")) return true
  return args.some((a) => /\b(main|master)\b/.test(a))
}

// --------------------------------------------------------------- the rest
const STATE_CHANGING = new Set([
  "commit",
  "merge",
  "rebase",
  "cherry-pick",
  "revert",
  "reset",
  "am",
  "apply",
  "tag",
  "push",
  "pull",
])
const WORKTREE_MUTATIONS = new Set(["add", "move", "remove", "repair"])

// Last-resort net: if the tokenizer ever throws on an input shape nobody
// anticipated, fall back to the blunt pre-2026-07-31 patterns rather than
// allowing the command through. Over-denial is recoverable; a missed
// `git push origin main` is not.
function fallbackDecision(cmd) {
  const SWITCH_TO_DEV =
    /git\s+(checkout|switch)\s+(-b\s+|-c\s+|--create\s+)?dev(\s|;|&|\||$)/
  const SWITCH = /git\s+(checkout|switch)\s+(-b\s+|-c\s+|--create\s+)?[^-\s]/
  const BRANCH_WRITE = /git\s+branch\s+(-[dDmMcCuft]|[^-\s])/
  if (SWITCH.test(cmd) && !SWITCH_TO_DEV.test(cmd)) return "switch"
  if (BRANCH_WRITE.test(cmd) && !/git\s+branch\s+dev(\s|;|&|\||$)/.test(cmd))
    return "branch"
  if (/git\s+push[^;&|]*\b(main|master)\b/.test(cmd)) return "push"
  return null
}

function decide(cmd, cwd) {
  const clauses = splitClauses(maskHeredocs(cmd))
  let switchedToDev = false
  let headBranch // resolved lazily, at most once
  for (const tokens of clauses) {
    const inv = gitInvocation(tokens)
    if (!inv) continue
    const { sub, args } = inv

    if (sub === "checkout" || sub === "switch") {
      const target = checkoutTarget(args)
      if (target === null) continue // path restore / interactive patch
      if (target === "dev") {
        if (!args.includes("--")) switchedToDev = true
        continue
      }
      return `Only the \`dev\` branch may be used, but this would move to "${target}". Switch with \`git checkout dev\` (or \`git checkout -b dev\`).`
    }

    if (sub === "branch") {
      if (!branchIsReadOnly(args)) {
        return "Branch create/delete/rename is blocked; only the `dev` branch may exist for agent work. Read-only queries (`git branch`, `--show-current`, `--list`, `-a`, `-v`) are allowed."
      }
      continue
    }

    if (sub === "worktree") {
      const first = args.find((a) => !a.startsWith("-"))
      if (first && WORKTREE_MUTATIONS.has(first)) {
        return "`git worktree` is blocked: a worktree is another way to check out a branch that is not `dev`."
      }
      continue
    }

    if (sub === "push" && pushTouchesProtected(args)) {
      return "Pushing to main/master is blocked. Only `git push origin dev` is allowed."
    }

    if (STATE_CHANGING.has(sub) && !switchedToDev) {
      if (sub === "tag" && !args.some((a) => !a.startsWith("-"))) continue
      if (headBranch === undefined) headBranch = currentBranch(cwd)
      if (headBranch && headBranch !== "dev") {
        return `HEAD is on "${headBranch}" but only the \`dev\` branch may be modified. Run \`git checkout dev\` first.`
      }
    }
  }
  return null
}

let raw = ""
process.stdin.on("data", (d) => (raw += d))
process.stdin.on("end", () => {
  let input = {}
  try {
    input = JSON.parse(raw.replace(/^﻿/, ""))
  } catch {
    return
  }
  const cmd = String(input.tool_input?.command ?? "")
  if (!cmd) return
  if (!/git/i.test(cmd)) return // cheap exit for the 99% that never touch git

  const cwd = input.cwd || process.cwd()
  let reason
  try {
    reason = decide(cmd, cwd)
  } catch {
    const kind = fallbackDecision(cmd)
    if (kind) {
      reason = `Blocked by the dev-branch policy (${kind}); the command could not be parsed, so it is denied rather than assumed safe.`
    }
  }
  if (reason) deny(reason)
})
