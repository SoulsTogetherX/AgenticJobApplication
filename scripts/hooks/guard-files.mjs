#!/usr/bin/env node
// PreToolUse hook (Edit|Write|NotebookEdit): filesystem boundary for this
// project — no edits/writes OUTSIDE the project directory. The OS temp dir and
// Claude's own session-memory dir are the only exceptions.
//
// File creation/removal inside the project is allowed for development work
// (user decision, 2026-07-27). The job-application flows are still restricted
// to jobs/<slug>/ — that rule lives in the skill instructions
// (pipeline-jobs / apply-job / find-jobs), not here.
//
// NOTE: no process.exit() after writing — on Windows, exiting immediately after
// console.log drops buffered pipe output (same caveat as protect-profile.js).
import os from "node:os"
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

let raw = ""
process.stdin.on("data", (d) => (raw += d))
process.stdin.on("end", () => {
  let input = {}
  try {
    input = JSON.parse(raw.replace(/^﻿/, ""))
  } catch {
    return
  }
  const file = String(
    input.tool_input?.file_path ?? input.tool_input?.notebook_path ?? "",
  )
  if (!file) return

  const root = path.resolve(input.cwd || process.cwd())
  const abs = path.resolve(root, file)
  const rel = path.relative(root, abs)
  const outside = rel.startsWith("..") || path.isAbsolute(rel)
  if (!outside) return

  const tmp = path.relative(os.tmpdir(), abs)
  const inTmp = !tmp.startsWith("..") && !path.isAbsolute(tmp)
  const inMemory =
    /[\\/]\.claude[\\/]projects[\\/][^\\/]+[\\/]memory[\\/]/.test(abs)
  if (!inTmp && !inMemory) {
    deny(
      `"${file}" is outside the project directory. This project only edits its own files.`,
    )
  }
})
