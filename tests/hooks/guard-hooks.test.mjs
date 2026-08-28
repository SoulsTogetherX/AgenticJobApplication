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
const GUARD_FILES = path.join(ROOT, "src", "hooks", "guard-files.mjs")
const GUARD_BASH = path.join(ROOT, "src", "hooks", "guard-bash.mjs")
const PRETTIFY = path.join(ROOT, "src", "hooks", "prettify.mjs")

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
    edit(path.join(ROOT, "src", "hooks", "guard-files.mjs")),
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
    "node src/new-job.mjs acme --company Acme --title Dev",
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
    "git checkout -- src/hooks/guard-bash.mjs",
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
        "git commit -F /tmp/ci.txt -- src/hooks/guard-bash.mjs",
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

// ---------- guard-bash: the branch is read from the TARGETED repo ----------
// 2026-08-03. `git -C /other/repo commit` was judged against the SESSION repo's
// branch, because the parsed -C/--git-dir/--work-tree options were only used to
// locate the subcommand, never to pick the repo to ask. Two directions:
//   OVER  — a session in a worktree on claude/... was denied `git -C <main>
//           commit` even though <main> was on dev.
//   UNDER — from a session on dev, `git -C /elsewhere commit` was allowed
//           whatever branch /elsewhere was on. This is the half that matters.
//
// Every test below builds two throwaway repos: `a` on dev, `b` on trunk.
function withTwoRepos(fn) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "guard-git2-"))
  try {
    const a = path.join(base, "a")
    const b = path.join(base, "b")
    fs.mkdirSync(a)
    fs.mkdirSync(b)
    assert.equal(spawnSync("git", ["init", "-b", "dev", a]).status, 0)
    assert.equal(spawnSync("git", ["init", "-b", "trunk", b]).status, 0)
    // `cwd` is the session cwd the hook is told about — the thing that used to
    // be the only repo it ever asked.
    const at = (cwd) => (command) =>
      runHook(
        GUARD_BASH,
        JSON.stringify({ tool_name: "Bash", cwd, tool_input: { command } }),
      ).decision
    fn({ base, a, b, fromDev: at(a), fromTrunk: at(b) })
  } finally {
    fs.rmSync(base, { recursive: true, force: true })
  }
}

test("guard-bash: -C targeting a repo on dev is allowed from a non-dev session", () => {
  // The OVER case, verbatim: the session sits on a non-dev branch, but the repo
  // the command actually modifies is on dev, which is what the policy wants.
  withTwoRepos(({ a, fromTrunk }) => {
    for (const c of [
      `git -C ${a} commit -m msg`,
      `git -C ${a} reset --hard`,
      `git -C ${a} rebase origin/dev`,
      `git -C ${a} cherry-pick abc123`,
      `git -C ../a commit -m msg`, // relative, resolved against the session cwd
    ]) {
      assert.equal(fromTrunk(c), null, `expected allow for: ${c}`)
    }
  })
})

test("guard-bash: -C targeting a non-dev repo is denied from a dev session", () => {
  // The UNDER case. Every one of these was allowed before 2026-08-03.
  withTwoRepos(({ b, fromDev }) => {
    for (const c of [
      `git -C ${b} commit -m msg`,
      `git -C ${b} reset --hard`,
      `git -C ${b} rebase main`,
      `git -C ${b} cherry-pick abc123`,
      `git -C ${b} am patch.mbox`,
      `git -C ${b} apply patch.diff`,
      `git -C ../b commit -m msg`,
    ]) {
      assert.equal(fromDev(c), "deny", `expected deny for: ${c}`)
    }
  })
})

test("guard-bash: --git-dir picks the repo, --work-tree does not", () => {
  withTwoRepos(({ a, b, fromDev, fromTrunk }) => {
    // --git-dir relocates HEAD, in both spellings.
    assert.equal(fromDev(`git --git-dir=${b}/.git commit -m msg`), "deny")
    assert.equal(fromDev(`git --git-dir ${b}/.git commit -m msg`), "deny")
    assert.equal(fromTrunk(`git --git-dir=${a}/.git commit -m msg`), null)
    assert.equal(fromTrunk(`git --git-dir ${a}/.git commit -m msg`), null)
    // --git-dir wins over a --work-tree pointing the other way.
    assert.equal(
      fromTrunk(`git --git-dir=${a}/.git --work-tree=${a} commit -m msg`),
      null,
    )
    // Probed: --work-tree ALONE relocates the files a command touches, not the
    // HEAD it moves — `git --work-tree=<b> commit` still commits on the session
    // repo's branch. Honouring it here would be a fresh over-match, so a
    // dev-branch session stays allowed and a trunk session stays denied,
    // whichever work tree is named.
    assert.equal(fromDev(`git --work-tree=${b} commit -m msg`), null)
    assert.equal(fromTrunk(`git --work-tree=${a} commit -m msg`), "deny")
  })
})

test("guard-bash: repeated -C composes, each relative to the last", () => {
  withTwoRepos(({ fromDev, fromTrunk }) => {
    // From a (dev): .. then b lands on trunk.
    assert.equal(fromDev("git -C .. -C b commit -m msg"), "deny")
    // From b (trunk): .. then a lands on dev.
    assert.equal(fromTrunk("git -C .. -C a commit -m msg"), null)
    // An empty -C is a no-op (probed), so this still resolves to a/dev.
    assert.equal(fromDev('git -C "" commit -m msg'), null)
    // -C applies before --git-dir even when written after it.
    assert.equal(fromDev("git --git-dir=.git -C ../b commit -m msg"), "deny")
  })
})

test("guard-bash: an unresolvable -C is denied, not assumed safe", () => {
  withTwoRepos(({ base, fromDev }) => {
    const missing = path.join(base, "no-such-repo")
    for (const c of [
      `git -C ${missing} commit -m msg`,
      `git -C ${missing} reset --hard`,
      `git --git-dir=${missing} commit -m msg`,
      // Resolving to a FILE rather than a directory is equally unresolvable.
      `git -C ${path.join(base, "a", ".git", "HEAD")} commit -m msg`,
    ]) {
      assert.equal(fromDev(c), "deny", `expected deny for: ${c}`)
    }
  })
})

test("guard-bash: switching to dev in one repo does not unlock another", () => {
  withTwoRepos(({ a, b, fromDev, fromTrunk }) => {
    // The workaround the OVER case forced: a checkout that is a no-op must not
    // be what satisfies the guardrail for a DIFFERENT repo.
    assert.equal(
      fromTrunk(`git -C ${a} checkout dev && git -C ${b} commit -m msg`),
      "deny",
    )
    // ...while the honest remedy, in the repo actually being modified, works.
    assert.equal(
      fromTrunk(`git -C ${b} checkout dev && git -C ${b} commit -m msg`),
      null,
    )
    // And a bare `git checkout dev` still only covers the session repo.
    assert.equal(
      fromDev(`git checkout dev && git -C ${b} commit -m msg`),
      "deny",
    )
  })
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
