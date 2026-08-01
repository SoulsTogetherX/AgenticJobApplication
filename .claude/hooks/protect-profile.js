#!/usr/bin/env node
// PreToolUse hook: hard-block agent Edit/Write to the user-owned fact base and
// to the guardrail machinery itself. The user edits these by hand; the agent's
// only sanctioned write path into the fact base is scripts/profile/save-answer.mjs.
//
// .claude/settings.json is protected for a reason worth stating, because it is
// not obvious: it WIRES every hook. Disabling a guard never required editing a
// guard — deleting one line here does it without touching a protected file at
// all. Sealing .claude/hooks/ while leaving this writable relocates the lock
// and leaves the door (user decision 2026-07-31, after ci-engineer and
// guard-profile-shell.mjs's own residuals note flagged it independently).
//
// COST, ACCEPTED KNOWINGLY: ci-engineer owns .claude/settings*.json and can no
// longer edit it. Wiring a new hook, adding a permission, or changing a matcher
// now needs the user. That is the intended trade — settings.json is precisely
// where a guardrail gets switched off, so it belongs on the same footing as the
// guards themselves.
//
// NOTE: no process.exit() after writing — on Windows, exiting immediately after
// console.log drops buffered pipe output, which silently disables the deny.
let raw = ""
process.stdin.on("data", (d) => (raw += d))
process.stdin.on("end", () => {
  let input = {}
  // Strip a UTF-8 BOM (PowerShell pipes add one) so parse never fails silently.
  try {
    input = JSON.parse(raw.replace(/^\uFEFF/, ""))
  } catch {
    return
  }
  const file = String(input.tool_input?.file_path ?? "").replace(/\\/g, "/")
  if (!file) return

  const PROTECTED = [
    /\/profile\/profile\.yaml$/i,
    /\/profile\/answers\.yaml$/i,
    /\/profile\/applications\.yaml$/i,
    /\/profile\/source\//i,
    /\/\.claude\/hooks\//i,
    /\/\.claude\/settings(?:\.local)?\.json$/i,
  ]
  if (PROTECTED.some((re) => re.test(file))) {
    console.log(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason:
            `"${file}" is part of the user-owned fact base / guardrails. ` +
            "Ask the user to edit it, or use `node scripts/profile/save-answer.mjs` for new answers.",
        },
      }),
    )
  }
})
