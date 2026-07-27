#!/usr/bin/env node
// PreToolUse hook (Bash|PowerShell): git branch policy for this project.
// Only the `dev` branch may be used: switching/creating any other branch is
// denied, state-changing git commands are denied unless HEAD is already on
// `dev`, and pushing to main/master is always denied. The user controls how
// dev merges into main.
//
// File create/delete shell commands are no longer blocked here (user decision,
// 2026-07-27): interactive development may manage files freely. The
// job-application flows are restricted to jobs/<slug>/ by their skill
// instructions instead.
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

  if (!/(^|[\s;&|(])git($|\s)/.test(cmd)) return

  const SWITCH_TO_DEV =
    /git\s+(checkout|switch)\s+(-b\s+|-c\s+|--create\s+)?dev(\s|;|&|\||$)/
  // Matches branch switches/creations ("checkout X", "checkout -b X") but not
  // path restores ("checkout -- file"), which are plain file operations.
  const SWITCH = /git\s+(checkout|switch)\s+(-b\s+|-c\s+|--create\s+)?[^-\s]/
  const BRANCH_MUTATION = /git\s+branch\s+(-|[^\s])/
  const STATE_CHANGING =
    /git\s+(commit|merge|rebase|cherry-pick|revert|reset|am\s|apply|tag\s|push)/

  if (SWITCH.test(cmd) && !SWITCH_TO_DEV.test(cmd)) {
    deny(
      "Only the `dev` branch may be used. Switch with `git checkout dev` (or `git checkout -b dev`).",
    )
    return
  }
  if (
    BRANCH_MUTATION.test(cmd) &&
    !/git\s+branch\s+dev(\s|;|&|\||$)/.test(cmd)
  ) {
    deny(
      "Branch create/delete/rename is blocked; only the `dev` branch may exist for agent work.",
    )
    return
  }
  // Scope the ref check to the push clause itself ([^;&|]* stops at command
  // separators) so "main" in a commit message doesn't false-positive.
  if (/git\s+push[^;&|]*\b(main|master)\b/.test(cmd)) {
    deny(
      "Pushing to main/master is blocked. Only `git push origin dev` is allowed.",
    )
    return
  }
  if (STATE_CHANGING.test(cmd) && !SWITCH_TO_DEV.test(cmd)) {
    const branch = currentBranch(input.cwd || process.cwd())
    if (branch && branch !== "dev") {
      deny(
        `HEAD is on "${branch}" but only the \`dev\` branch may be modified. Run \`git checkout dev\` first.`,
      )
    }
  }
})
