import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
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
