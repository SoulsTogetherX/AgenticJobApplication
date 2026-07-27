import test from "node:test"
import assert from "node:assert/strict"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const HOOK = path.join(ROOT, ".claude", "hooks", "protect-profile.js")

// spawnSync's `input` option feeds stdin byte-clean (no shell BOM/backslash mangling).
function runHook(payload) {
  const res = spawnSync(process.execPath, [HOOK], {
    input: payload,
    encoding: "utf8",
  })
  let decision = null
  if (res.stdout.trim())
    decision =
      JSON.parse(res.stdout).hookSpecificOutput?.permissionDecision ?? null
  return { status: res.status, decision }
}

const edit = (file) =>
  JSON.stringify({ tool_name: "Edit", tool_input: { file_path: file } })

test("hook denies edits to every protected path (forward and back slashes)", () => {
  const protectedPaths = [
    "C:/repo/AgenticJobApplication/profile/profile.yaml",
    "C:\\repo\\AgenticJobApplication\\profile\\profile.yaml",
    "C:/repo/AgenticJobApplication/profile/answers.yaml",
    "C:/repo/AgenticJobApplication/profile/applications.yaml",
    "C:/repo/AgenticJobApplication/profile/source/Resume General.pdf",
    "C:/repo/AgenticJobApplication/.claude/hooks/protect-profile.js",
    "C:\\repo\\AgenticJobApplication\\.claude\\hooks\\evil-new-hook.js",
  ]
  for (const p of protectedPaths) {
    const { status, decision } = runHook(edit(p))
    assert.equal(status, 0)
    assert.equal(decision, "deny", `expected deny for ${p}`)
  }
})

test("hook allows normal workspace files", () => {
  const allowed = [
    "C:/repo/AgenticJobApplication/jobs/acme/resume.md",
    "C:/repo/AgenticJobApplication/scripts/lib.mjs",
    "C:/repo/AgenticJobApplication/profile-notes.md", // similar name, not protected
    "C:/repo/AgenticJobApplication/docs/tailoring-rules.md",
  ]
  for (const p of allowed) {
    const { status, decision } = runHook(edit(p))
    assert.equal(status, 0)
    assert.equal(decision, null, `expected allow for ${p}`)
  }
})

test("hook still denies when input carries a UTF-8 BOM", () => {
  const { decision } = runHook("\uFEFF" + edit("C:/x/profile/profile.yaml"))
  assert.equal(decision, "deny")
})

test("hook tolerates malformed or empty input without crashing", () => {
  assert.equal(runHook("not json at all").status, 0)
  assert.equal(runHook("").status, 0)
  assert.equal(runHook("{}").status, 0)
})
