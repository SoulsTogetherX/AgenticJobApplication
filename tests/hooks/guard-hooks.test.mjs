import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
)
const GUARD_FILES = path.join(ROOT, "scripts", "hooks", "guard-files.mjs")
const GUARD_BASH = path.join(ROOT, "scripts", "hooks", "guard-bash.mjs")
const PRETTIFY = path.join(ROOT, "scripts", "hooks", "prettify.mjs")

function runHook(script, payload) {
  const res = spawnSync(process.execPath, [script], {
    input: payload,
    encoding: "utf8",
  })
  let decision = null
  if (res.stdout.trim()) {
    try {
      decision =
        JSON.parse(res.stdout).hookSpecificOutput?.permissionDecision ?? null
    } catch {}
  }
  return { status: res.status, decision }
}

const edit = (file) =>
  JSON.stringify({
    tool_name: "Edit",
    cwd: ROOT,
    tool_input: { file_path: file },
  })
const write = (file) =>
  JSON.stringify({
    tool_name: "Write",
    cwd: ROOT,
    tool_input: { file_path: file },
  })
const bash = (command) =>
  JSON.stringify({ tool_name: "Bash", cwd: ROOT, tool_input: { command } })

// ---------- guard-files: outside-project boundary ----------

test("guard-files denies edits outside the project directory", () => {
  // Platform-portable outside paths: the filesystem root of THIS machine and
  // the home dir. (A sibling of ROOT is wrong here — when the repo is cloned
  // into the temp dir, its sibling falls under the tmp exception.)
  const outside = [
    path.join(path.parse(ROOT).root, "guard-files-test-outside", "hosts.txt"),
    path.join(os.homedir(), "Documents", "other-project", "index.js"),
  ]
  for (const p of outside) {
    const { status, decision } = runHook(GUARD_FILES, edit(p))
    assert.equal(status, 0)
    assert.equal(decision, "deny", `expected deny for ${p}`)
  }
})

test("guard-files allows the temp dir and Claude session memory exceptions", () => {
  const allowed = [
    path.join(os.tmpdir(), "claude", "scratch", "notes.md"),
    path.join(
      os.homedir(),
      ".claude",
      "projects",
      "X--proj",
      "memory",
      "fact.md",
    ),
  ]
  for (const p of allowed) {
    const { decision } = runHook(GUARD_FILES, edit(p))
    assert.equal(decision, null, `expected allow for ${p}`)
  }
})

test("guard-files allows any writes inside the project, including new files", () => {
  const allowed = [
    write(path.join(ROOT, "jobs", "acme-dev", "resume.md")),
    write(path.join(ROOT, "totally-new-file.md")), // development freedom
    edit(path.join(ROOT, "docs", "tailoring-rules.md")),
    edit(path.join(ROOT, "scripts", "hooks", "guard-files.mjs")),
  ]
  for (const payload of allowed) {
    const { decision } = runHook(GUARD_FILES, payload)
    assert.equal(decision, null, `expected allow for ${payload}`)
  }
})

test("guard-files tolerates malformed or empty input", () => {
  assert.equal(runHook(GUARD_FILES, "not json").status, 0)
  assert.equal(runHook(GUARD_FILES, "").status, 0)
  assert.equal(runHook(GUARD_FILES, "{}").status, 0)
})

// ---------- guard-bash: git dev-branch policy ----------

test("guard-bash no longer blocks file management commands", () => {
  const allowed = [
    "rm old-scratch.txt",
    "mkdir new-dir",
    "touch new-file.txt",
    "Remove-Item stale.log",
    "git checkout -- docs/tailoring-rules.md", // path restore, not a branch switch
    "npm test",
    "node scripts/new-job.mjs acme --company Acme --title Dev",
    "git status",
    "git log --oneline -5",
  ]
  for (const c of allowed) {
    const { decision } = runHook(GUARD_BASH, bash(c))
    assert.equal(decision, null, `expected allow for: ${c}`)
  }
})

test('guard-bash: "main" in a commit message is not a push ref (checked on a dev-branch repo)', () => {
  // CI checkouts are detached-HEAD, so build a throwaway repo pinned to dev
  // instead of relying on this repo's current branch.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "guard-git-"))
  try {
    const init = spawnSync("git", ["init", "-b", "dev", dir], {
      encoding: "utf8",
    })
    assert.equal(init.status, 0, init.stderr)
    const payload = JSON.stringify({
      tool_name: "Bash",
      cwd: dir,
      tool_input: {
        command:
          'git commit -m "PRs target main eventually" ; git push origin dev',
      },
    })
    const { decision } = runHook(GUARD_BASH, payload)
    assert.equal(
      decision,
      null,
      "commit-message text must not trip the push-ref check",
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("guard-bash denies state-changing git when HEAD is not on dev", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "guard-git-"))
  try {
    const init = spawnSync("git", ["init", "-b", "trunk", dir], {
      encoding: "utf8",
    })
    assert.equal(init.status, 0, init.stderr)
    const payload = JSON.stringify({
      tool_name: "Bash",
      cwd: dir,
      tool_input: { command: "git commit -m msg" },
    })
    const { decision } = runHook(GUARD_BASH, payload)
    assert.equal(decision, "deny")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("guard-bash denies switching to or pushing any branch but dev", () => {
  const blocked = [
    "git checkout main",
    "git switch master",
    "git checkout -b feature/x",
    "git branch -D dev",
    "git branch new-feature",
    "git push origin main",
    "git push -f origin master",
  ]
  for (const c of blocked) {
    const { decision } = runHook(GUARD_BASH, bash(c))
    assert.equal(decision, "deny", `expected deny for: ${c}`)
  }
})

test("guard-bash allows dev-branch git operations", () => {
  const allowed = ["git checkout dev", "git checkout -b dev", "git switch dev"]
  for (const c of allowed) {
    const { decision } = runHook(GUARD_BASH, bash(c))
    assert.equal(decision, null, `expected allow for: ${c}`)
  }
})

// The over-match this hook was rewritten for: `git branch --show-current` is a
// read-only query and was denied as "Branch create/delete/rename is blocked"
// in a real session. Every entry here mutates nothing.
test("guard-bash allows read-only git branch queries", () => {
  const allowed = [
    "git branch --show-current", // the reported false deny
    "git branch",
    "git branch --list",
    "git branch -a",
    "git branch -r",
    "git branch -v",
    "git branch -vv",
    "git branch -av",
    "git branch --list dev*",
    "git branch -a origin/dev",
    "git branch --contains HEAD",
    "git branch --merged=HEAD",
    "git branch --format=%(refname:short)",
    "git branch --sort=committerdate --list",
    "git branch --no-color --column",
    "BRANCH=$(git branch --show-current)", // command substitution
    "git status && git branch --show-current",
    "git worktree list",
    "git checkout -p",
    "git checkout -- scripts/hooks/guard-bash.mjs",
  ]
  for (const c of allowed) {
    const { decision } = runHook(GUARD_BASH, bash(c))
    assert.equal(decision, null, `expected allow for: ${c}`)
  }
})

// The other half, and the more important one. Several of these were ALLOWED by
// the regex version of this hook; each is a way onto a branch that is not dev.
test("guard-bash still denies every way of mutating or leaving dev", () => {
  const blocked = [
    // `-v` does not imply list mode: this CREATES branch `probe` (probed).
    "git branch -v probe",
    "git branch -m dev main",
    "git branch -c dev copy",
    "git branch --delete feature",
    "git branch -f main HEAD",
    "git branch --set-upstream-to=origin/main dev",
    "git branch --edit-description",
    "git branch --unset-upstream",
    // Force-create variants the old create-flag list missed entirely.
    "git checkout -B main",
    "git switch -C main",
    "git checkout --orphan gh-pages",
    // A global option before the subcommand hid the checkout from the old rule.
    "git -C . checkout main",
    "git --git-dir=.git checkout main",
    "git -c core.pager=cat checkout main",
    // Program-name variants.
    "git.exe checkout main",
    "sudo git checkout main",
    // Back to the previous branch is still off dev.
    "git checkout -",
    "git switch -",
    "git checkout @{-1}",
    // A second command after a separator, including a newline.
    "git status; git checkout main",
    "git status\ngit checkout main",
    "git fetch && git switch release/2.0",
    // Worktrees are another checkout.
    "git worktree add ../wt main",
    // Push refs and whole-repo pushes.
    "git push origin HEAD:main",
    "git push origin dev:main",
    "git push --mirror origin",
    "git push --all origin",
    'git push origin "main"',
  ]
  for (const c of blocked) {
    const { decision } = runHook(GUARD_BASH, bash(c))
    assert.equal(decision, "deny", `expected deny for: ${c}`)
  }
})

test("guard-bash: branch names inside quoted arguments are arguments, not refs", () => {
  // Tokenizing instead of pattern-matching is what makes this true by
  // construction rather than by a scoping trick on the push regex.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "guard-git-"))
  try {
    assert.equal(spawnSync("git", ["init", "-b", "dev", dir]).status, 0)
    const allowed = [
      'git commit -m "checkout main when the branch is ready"',
      'git commit -m "switch master; git push origin main"',
      "git log --grep=main --oneline",
    ]
    for (const command of allowed) {
      const payload = JSON.stringify({
        tool_name: "Bash",
        cwd: dir,
        tool_input: { command },
      })
      const { decision } = runHook(GUARD_BASH, payload)
      assert.equal(decision, null, `expected allow for: ${command}`)
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// A heredoc BODY is data, not commands. Found by the build-manager on
// 2026-07-31 when this hook denied their own commit: the message quoted the
// very bypasses this hook had just been fixed to block, and every line of the
// body was analysed as a command. This repo's commit messages quote commands
// as a matter of style, so it would have recurred constantly.
test("guard-bash reads a heredoc body as data, not as commands", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "guard-git-"))
  try {
    assert.equal(spawnSync("git", ["init", "-b", "dev", dir]).status, 0)
    const payload = (command) =>
      JSON.stringify({ tool_name: "Bash", cwd: dir, tool_input: { command } })

    const allowed = [
      // The manager's exact shape.
      [
        "cat > /tmp/ci.txt <<'EOF'",
        "Three bypasses existed: git checkout -B main was allowed, and so",
        "was git -C . checkout main. Both now deny.",
        "EOF",
        "git commit -F /tmp/ci.txt -- scripts/hooks/guard-bash.mjs",
      ].join("\n"),
      // Unquoted delimiter.
      "cat > f <<EOF\ngit checkout main\nEOF\ngit commit -F f",
      // <<- form, terminator indented with tabs.
      "cat > f <<-EOF\n\tgit switch master\n\tEOF\ngit status",
      // Two heredocs queued on one line, consumed in order.
      "cat <<A <<B > f\ngit checkout main\nA\ngit branch -D dev\nB\ngit commit -F f",
      // PowerShell here-string: this is a Windows-primary repo.
      "$m = @'\ngit checkout main\n'@\ngit commit -F msg.txt",
      // `<<<` is a herestring, not a heredoc, and its word is an argument.
      'cat <<< "git checkout main"',
    ]
    for (const command of allowed) {
      assert.equal(
        runHook(GUARD_BASH, payload(command)).decision,
        null,
        `expected allow for:\n${command}`,
      )
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// The half that matters more. Skipping a body must not become a way to hide a
// command, so: anything outside the body is still analysed, an unterminated
// heredoc skips nothing, and a body fed to an INTERPRETER really is commands.
test("guard-bash still denies forbidden commands around and inside heredocs", () => {
  const blocked = [
    // The case that makes this non-trivial: after the terminator.
    "cat > f <<'EOF'\nharmless prose\nEOF\ngit checkout main",
    // Before the heredoc.
    "git checkout main\ncat > f <<'EOF'\nprose\nEOF",
    // On the opener line itself, after a separator.
    "cat <<EOF > f ; git checkout main\nbody\nEOF",
    "git push origin main <<EOF\nbody\nEOF",
    // `bash <<EOF` EXECUTES its body — never blanked.
    "bash <<'EOF'\ngit checkout main\nEOF",
    "ssh host <<EOF\ngit push origin main\nEOF",
    "sudo sh <<EOF\ngit branch -D dev\nEOF",
    // No terminator: nothing is skipped, so the body is read as commands.
    "cat > f <<EOF\ngit checkout main",
  ]
  for (const c of blocked) {
    const { decision } = runHook(GUARD_BASH, bash(c))
    assert.equal(decision, "deny", `expected deny for:\n${c}`)
  }
})

test("guard-bash lets a command switch to dev first, then change state", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "guard-git-"))
  try {
    assert.equal(spawnSync("git", ["init", "-b", "trunk", dir]).status, 0)
    const payload = (command) =>
      JSON.stringify({ tool_name: "Bash", cwd: dir, tool_input: { command } })

    assert.equal(
      runHook(GUARD_BASH, payload("git checkout dev && git commit -m msg"))
        .decision,
      null,
      "switching to dev first must still be the way out of a wrong branch",
    )
    // ...but the reverse order commits on the wrong branch first.
    assert.equal(
      runHook(GUARD_BASH, payload("git commit -m msg && git checkout dev"))
        .decision,
      "deny",
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("guard-bash tolerates malformed or empty input", () => {
  assert.equal(runHook(GUARD_BASH, "not json").status, 0)
  assert.equal(runHook(GUARD_BASH, "").status, 0)
  assert.equal(runHook(GUARD_BASH, "{}").status, 0)
})

// ---------- prettify ----------

test("prettify formats a messy markdown file in place", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prettify-test-"))
  const file = path.join(dir, "messy.md")
  try {
    fs.writeFileSync(file, "#   Title\n\n\n\n*  item one\n*  item two\n")
    const payload = JSON.stringify({
      tool_name: "Edit",
      tool_input: { file_path: file },
    })
    const res = spawnSync(process.execPath, [PRETTIFY], {
      input: payload,
      encoding: "utf8",
      timeout: 30000,
    })
    assert.equal(res.status, 0)
    const out = fs.readFileSync(file, "utf8")
    assert.equal(out, "# Title\n\n- item one\n- item two\n")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("prettify skips unsupported and missing files without failing", () => {
  const payloads = [
    JSON.stringify({
      tool_name: "Edit",
      tool_input: { file_path: path.join(ROOT, "no-such-file.md") },
    }),
    JSON.stringify({
      tool_name: "Edit",
      tool_input: { file_path: path.join(ROOT, "LICENSE") },
    }),
    "not json",
    "{}",
  ]
  for (const p of payloads) {
    const res = spawnSync(process.execPath, [PRETTIFY], {
      input: p,
      encoding: "utf8",
      timeout: 30000,
    })
    assert.equal(res.status, 0)
  }
})
