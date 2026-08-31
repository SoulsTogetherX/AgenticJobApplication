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
// 2026-08-03: the branch check asked the WRONG REPOSITORY. `gitInvocation()`
// already parsed the global options that pick a repository (-C, --git-dir,
// --work-tree) but used them only to skip past them and find the subcommand;
// the branch was always read from the session cwd. Both directions were wrong,
// and the under-match is the same class of defect the 2026-07-31 note above
// describes — a rule anchored on the wrong thing:
//
//   OVER — a session whose cwd was a worktree on `claude/...` ran
//   `git -C <main-checkout> commit`. The main checkout was on `dev`, i.e.
//   exactly what this policy wants, and it was denied anyway. The workaround
//   was to prefix `git -C <main> checkout dev` — a no-op that only set
//   switchedToDev — so the guardrail was satisfied by a trick rather than by
//   the invariant it asserts.
//
//   UNDER — the mirror, and the one that matters: from a session cwd on `dev`,
//   `git -C /other/repo commit` (or reset/rebase/cherry-pick/am/apply) was
//   allowed no matter which branch /other/repo was on.
//
// So the repository is now RESOLVED from the parsed invocation (see repoDir)
// and that directory is what the branch is read from. switchedToDev and the
// resolved branch are keyed per repository too, because `git -C /a checkout
// dev` must not unlock a commit in /b.
//
// NOTE: no process.exit() after writing — on Windows, exiting immediately after
// console.log drops buffered pipe output (same caveat as protect-profile.js).
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

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

// The subset of the above that decides WHICH repository the command acts on.
// Collected with their values, in order, so repoDir() can replay them.
const GIT_DIR_OPTS = new Set(["-C", "--git-dir", "--work-tree"])

function gitInvocation(tokens) {
  const gitIdx = tokens.findIndex((t) => GIT_PROG.test(t))
  if (gitIdx === -1) return null
  let i = gitIdx + 1
  const dirOpts = []
  while (i < tokens.length && tokens[i].startsWith("-")) {
    const tok = tokens[i]
    const eq = tok.indexOf("=")
    const name = eq === -1 ? tok : tok.slice(0, eq)
    // Only the exact `--git-dir` spelling swallows the next token; the
    // `--git-dir=x` form carries its value, exactly as before this comment.
    const takesValue = eq === -1 && GIT_GLOBAL_VALUE.has(tok)
    if (GIT_DIR_OPTS.has(name)) {
      const value = eq === -1 ? tokens[i + 1] : tok.slice(eq + 1)
      if (value !== undefined) dirOpts.push([name, value])
    }
    i += takesValue ? 2 : 1
  }
  if (i >= tokens.length) return null
  return { sub: tokens[i], args: tokens.slice(i + 1), dirOpts }
}

// ------------------------------------------------------- which repo is this?
// Probed against git 2.54 rather than read off the manual, because the
// precedence here is not guessable, and one of the four rules is a trap:
//
//   git -C ../b branch --show-current        -> b's branch   (-C moves cwd)
//   git -C .. -C b branch --show-current     -> b's branch   (-C repeats, each
//                                                             resolved against
//                                                             the previous one)
//   git --git-dir=../b/.git ...              -> b's branch
//   git --git-dir=.git -C ../b ...           -> b's branch   (EVERY -C applies
//                                                             first, whatever
//                                                             the order on the
//                                                             command line)
//   git --work-tree=../b ...                 -> the CWD repo's branch  <-- trap
//   git -C '' ...                            -> no-op
//
// --work-tree relocates the files a command reads and writes, NOT the HEAD it
// moves: `git --work-tree=/other commit` still commits on the cwd repo's
// branch. So it is parsed and its value consumed, but it must not redirect
// this check — doing so would re-create the very over-match this resolution
// step exists to fix. `git --git-dir=X --work-tree=Y` is governed by X.
//
// Passing a .git directory as the spawn cwd reports that repository's branch
// (probed), which is what lets a single resolved path stand in for both -C and
// --git-dir instead of threading two values through currentBranch().
//
// Returns null when the directory cannot be resolved: a guardrail that cannot
// tell which branch it is protecting must fail closed.
function repoDir(dirOpts, cwd) {
  if (!dirOpts.length) return cwd // overwhelmingly the common case: no syscall
  let dir = cwd
  for (const [name, value] of dirOpts) {
    if (name === "-C" && value !== "") dir = path.resolve(dir, value)
  }
  const gitDir = dirOpts.filter(([name]) => name === "--git-dir").pop()
  if (gitDir) dir = path.resolve(dir, gitDir[1])
  try {
    return fs.statSync(dir).isDirectory() ? dir : null
  } catch {
    return null // missing, or a path we are not allowed to stat
  }
}

const describeDirOpts = (dirOpts) =>
  dirOpts.map(([name, value]) => `${name} ${value}`).join(" ")

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
  // Both keyed by resolved repository: `git -C /a checkout dev` must not
  // unlock `git -C /b commit`. Without any -C/--git-dir there is exactly one
  // key (cwd), so the common case behaves as it always has.
  const switchedToDev = new Set()
  const headBranch = new Map() // resolved lazily, at most once per repo
  const unresolved = (dirOpts) =>
    `Cannot resolve which repository \`${describeDirOpts(dirOpts)}\` refers to, so the dev-branch check cannot run. Denied rather than assumed safe.`
  for (const tokens of clauses) {
    const inv = gitInvocation(tokens)
    if (!inv) continue
    const { sub, args, dirOpts } = inv

    if (sub === "checkout" || sub === "switch") {
      const target = checkoutTarget(args)
      if (target === null) continue // path restore / interactive patch
      if (target === "dev") {
        if (!args.includes("--")) {
          const dir = repoDir(dirOpts, cwd)
          if (dir === null) return unresolved(dirOpts)
          switchedToDev.add(dir)
        }
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

    if (STATE_CHANGING.has(sub)) {
      if (sub === "tag" && !args.some((a) => !a.startsWith("-"))) continue
      const dir = repoDir(dirOpts, cwd)
      if (dir === null) return unresolved(dirOpts)
      if (switchedToDev.has(dir)) continue
      if (!headBranch.has(dir)) headBranch.set(dir, currentBranch(dir))
      const branch = headBranch.get(dir)
      if (branch && branch !== "dev") {
        // The no--C wording is unchanged; naming the repo only when it is not
        // the session cwd is what makes the OVER case above diagnosable.
        const head = dir === cwd ? "HEAD" : `HEAD of ${dir}`
        const fix =
          dir === cwd ? "git checkout dev" : `git -C ${dir} checkout dev`
        return `${head} is on "${branch}" but only the \`dev\` branch may be modified. Run \`${fix}\` first.`
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
    input = JSON.parse(raw.replace(/^\uFEFF/, ""))
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
