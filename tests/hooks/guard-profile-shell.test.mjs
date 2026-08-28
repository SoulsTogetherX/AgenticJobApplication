// Coverage for the PreToolUse shell guard over the user-owned fact base.
//
// WHY THIS FILE EXISTS. The guard was written on 2026-07-31 after two real
// incidents wrote fabricated answers into the REAL profile/answers.yaml, and it
// shipped with NO test at all. It was then MOVED from src/hooks/ to
// .claude/hooks/ so that no agent can edit it (protect-profile.js denies writes
// under .claude/hooks/). The move was correct — but a guard nothing asserts is
// indistinguishable from a guard that silently stopped working, and this one is
// now in the one directory where a broken version could not be repaired by the
// agent that noticed. That makes coverage MORE important here, not less.
//
// ci-engineer owns tests/hooks/ but CANNOT edit the hook under test. That
// asymmetry is deliberate: this file can only ever report, never paper over.
//
// Every case asserts the permissionDecision in BOTH directions — an allow case
// and a deny case — because an over-matching guard gets switched off by the
// people it protects (guard-bash.mjs denied `git branch --show-current`, and
// this very hook denied `grep` on save-answer.mjs within a minute of being
// written).
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
)
const GUARD = path.join(ROOT, ".claude", "hooks", "guard-profile-shell.mjs")

// A hard failure, never a skip. If the hook is gone, the fact base has an
// unguarded shell route and the build must go red rather than report "0 tests".
test("the shell guard exists at the agent-unwritable path", () => {
  assert.ok(
    fs.existsSync(GUARD),
    `${GUARD} is missing. profile/ then has no shell-side writer guard: ` +
      "protect-profile.js only sees Edit/Write (a Bash call carries no file_path) " +
      "and guard-bash.mjs only enforces git branch policy.",
  )
})

// The hook must live where agents cannot rewrite it. protect-profile.js matches
// /\/\.claude\/hooks\//i, so this asserts the location IS the protection.
test("the shell guard is inside the directory protect-profile.js defends", () => {
  const rel = path.relative(ROOT, GUARD).split(path.sep).join("/")
  assert.match(
    rel,
    /^\.claude\/hooks\//,
    "moving this guard back under src/hooks/ would make it editable by the " +
      "very agents it constrains",
  )
  const protector = fs.readFileSync(
    path.join(ROOT, ".claude", "hooks", "protect-profile.js"),
    "utf8",
  )
  assert.match(
    protector,
    /\\\.claude\\\/hooks\\\//,
    "protect-profile.js no longer denies writes under .claude/hooks/, so the " +
      "shell guard's location stops protecting it",
  )
})

function runGuard(payload) {
  const res = spawnSync(process.execPath, [GUARD], {
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
  return { status: res.status, decision, stdout: res.stdout }
}

const shell = (command, tool = "Bash") =>
  JSON.stringify({ tool_name: tool, cwd: ROOT, tool_input: { command } })

// ---------- DENY: the two incidents that caused this hook ----------

test("denies the sanctioned writers when aimed at the real fact base", () => {
  // This is the EXACT shape of both 2026-07-31 incidents: a legitimate script,
  // no --file, no --user-approved, so it lands in the real profile/answers.yaml.
  const commands = [
    'node scripts/profile/save-answer.mjs "Phone number" "555-0100"',
    'node scripts/profile/save-answer.mjs "Q" "A" --source model',
    "node scripts/profile/apply-profile.mjs --allow-edits",
    // The dropped-flag typo itself: --answers was silently ignored, so the
    // write fell through to the default path.
    'node scripts/profile/save-answer.mjs "Q" "A" --answers /tmp/x.yaml',
    "node.exe scripts/profile/save-answer.mjs Q A",
  ]
  for (const c of commands) {
    assert.equal(runGuard(shell(c)).decision, "deny", `should deny: ${c}`)
  }
})

test("denies raw shell writes that name a profile path", () => {
  const commands = [
    "echo pwned >> profile/answers.yaml",
    "echo x > profile/profile.yaml",
    'cat foo 1> "profile/answers.yaml"',
    "rm profile/answers.yaml",
    "mv /tmp/fake.yaml profile/answers.yaml",
    "cp /tmp/fake.yaml profile/profile.yaml",
    "sed -i s/a/b/ profile/answers.yaml",
    "truncate -s 0 profile/applications.yaml",
    "rm -rf profile/source/",
    "Set-Content profile/answers.yaml 'x'",
    "Remove-Item profile/profile.yaml",
    "Add-Content -Path profile/answers.yaml -Value 'x'",
    `node -e "fs.writeFileSync('profile/answers.yaml','x')"`,
    `python3 -c "open('profile/answers.yaml','w')" ; writeFileSync`,
  ]
  for (const c of commands) {
    assert.equal(runGuard(shell(c)).decision, "deny", `should deny: ${c}`)
  }
})

test("denies on the PowerShell tool as well as Bash", () => {
  // .claude/settings.json wires this hook on the `Bash|PowerShell` matcher and
  // this project has both. A guard that only handled Bash would leave the other
  // half of the matcher live but inert.
  const { decision } = runGuard(
    shell("Set-Content profile/answers.yaml 'x'", "PowerShell"),
  )
  assert.equal(decision, "deny")
})

test("a Windows backslash path is denied the same as a POSIX one", () => {
  const { decision } = runGuard(shell("echo x >> profile\\answers.yaml"))
  assert.equal(decision, "deny", "separator normalisation is load-bearing")
})

// ---------- ALLOW: the over-matching failure mode ----------

test("allows READS of the fact base, which agents do constantly", () => {
  // keyword-coverage, answer-bank and verify-claims all read profile/. If this
  // regresses to a bare-mention match, the guard gets disabled by whoever hits
  // it, and then nothing guards the writes either.
  const commands = [
    "cat profile/answers.yaml",
    "grep -n 'Phone' profile/answers.yaml",
    "head -n 20 profile/profile.yaml",
    "node src/profile/keyword-coverage.mjs --json",
    "node src/apply/answer-bank.mjs < jobs/x/scan-p1.json",
    // Reading the WRITER script is not writing the fact base. This exact
    // command was denied within a minute of the hook being written.
    "grep -n 'user-approved' scripts/profile/save-answer.mjs",
    "wc -l scripts/profile/apply-profile.mjs",
  ]
  for (const c of commands) {
    assert.equal(runGuard(shell(c)).decision, null, `should allow: ${c}`)
  }
})

test("allows the two sanctioned, declared paths", () => {
  const commands = [
    // A test writing to its own file cannot touch profile/.
    'node scripts/profile/save-answer.mjs "Q" "A" --file /tmp/t.yaml',
    'node scripts/profile/save-answer.mjs "Q" "A" --file=/tmp/t.yaml',
    // The user approved this answer in chat.
    'node scripts/profile/save-answer.mjs "Q" "A" --user-approved',
    'node scripts/profile/save-answer.mjs "Q" "A" --source model --user-approved',
  ]
  for (const c of commands) {
    assert.equal(runGuard(shell(c)).decision, null, `should allow: ${c}`)
  }
})

test("allows writes to paths that merely look like profile paths", () => {
  const commands = [
    "echo x > tests/fixtures/profile/answers.yaml".replace("profile/", "prof/"),
    "rm docs/profile-gaps.md",
    "echo x > my-profile.yaml",
    "node src/profile/profile-gaps.mjs --json",
  ]
  for (const c of commands) {
    assert.equal(runGuard(shell(c)).decision, null, `should allow: ${c}`)
  }
})

// ---------- fail-open contract ----------

test("fails OPEN on unparseable or empty input, like its sibling hooks", () => {
  // A guard that denied every shell command on a malformed payload would be
  // worse than the hole it closes. protect-profile.js and guard-bash.mjs share
  // this contract; tests/hooks/hook.test.mjs asserts it for the sibling.
  for (const raw of ["not json at all", "", "{}", '{"tool_input":{}}']) {
    const { status, decision } = runGuard(raw)
    assert.equal(status, 0, `should exit 0 on: ${JSON.stringify(raw)}`)
    assert.equal(decision, null)
  }
})

test("a UTF-8 BOM from a PowerShell pipe does not disable the deny", () => {
  // PowerShell prepends a BOM; without the strip, JSON.parse throws, the hook
  // fails open, and the guard is silently off on exactly one of its two tools.
  const { decision } = runGuard(
    "﻿" + shell("echo x >> profile/answers.yaml", "PowerShell"),
  )
  assert.equal(
    decision,
    "deny",
    "BOM stripping is what keeps PowerShell guarded",
  )
})

test("the deny reason names the fact base and both escape hatches", () => {
  // A denial an agent cannot act on gets worked around instead of obeyed.
  const { stdout } = runGuard(
    shell('node scripts/profile/save-answer.mjs "Q" "A"'),
  )
  const reason = JSON.parse(stdout).hookSpecificOutput.permissionDecisionReason
  assert.match(reason, /--file/)
  assert.match(reason, /--user-approved/)
  assert.match(reason, /CLAUDE\.md hard rule 2/)
})
