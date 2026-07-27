#!/usr/bin/env node
// PreToolUse hook (Bash|PowerShell): shell-command boundary for this project.
//   1. Git is restricted to the `dev` branch: switching/creating any other
//      branch is denied, and state-changing git commands are denied unless
//      HEAD is already on `dev`. Pushing to any other ref is denied.
//   2. File create/delete shell commands (rm, del, mkdir, touch, ...) are
//      denied — deterministic scripts like scripts/new-job.mjs are the only
//      sanctioned way this project creates files.
//
// NOTE: no process.exit() after writing — on Windows, exiting immediately after
// console.log drops buffered pipe output (same caveat as protect-profile.js).
import { spawnSync } from 'node:child_process';

function deny(reason) {
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }));
}

function currentBranch(cwd) {
  const res = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd, encoding: 'utf8',
  });
  return res.status === 0 ? res.stdout.trim() : null;
}

let raw = '';
process.stdin.on('data', (d) => (raw += d));
process.stdin.on('end', () => {
  let input = {};
  try { input = JSON.parse(raw.replace(/^﻿/, '')); } catch { return; }
  const cmd = String(input.tool_input?.command ?? '');
  if (!cmd) return;

  // --- file create/delete commands ---
  const DESTRUCTIVE =
    /(^|[\s;&|(])(rm|rmdir|del|erase|unlink|shred|rimraf|trash)($|[\s;&|)])|Remove-Item|Clear-Content/i;
  const CREATE =
    /(^|[\s;&|(])(mkdir|touch|md)($|[\s;&|)])|New-Item/i;
  if (DESTRUCTIVE.test(cmd)) {
    deny('File/directory deletion commands are blocked in this project. Nothing here gets removed by the agent.');
    return;
  }
  if (CREATE.test(cmd)) {
    deny('Ad-hoc file creation commands are blocked. Use the sanctioned scripts (e.g. node scripts/new-job.mjs) instead.');
    return;
  }

  // --- git: dev branch only ---
  if (!/(^|[\s;&|(])git($|\s)/.test(cmd)) return;

  const SWITCH_TO_DEV = /git\s+(checkout|switch)\s+(-b\s+|-c\s+|--create\s+)?dev(\s|;|&|\||$)/;
  const SWITCH = /git\s+(checkout|switch)(\s|$)/;
  const BRANCH_MUTATION = /git\s+branch\s+(-|[^\s])/; // any git branch with args (create/delete/rename)
  const STATE_CHANGING =
    /git\s+(add|commit|merge|rebase|cherry-pick|revert|reset|restore|am|apply|tag|stash|rm|mv|clean|push|pull|fetch\s+.*--prune)/;

  if (/git\s+rm(\s|$)/.test(cmd) || /git\s+clean(\s|$)/.test(cmd)) {
    deny('git rm / git clean delete files and are blocked in this project.');
    return;
  }
  if (SWITCH.test(cmd) && !SWITCH_TO_DEV.test(cmd)) {
    deny('Only the `dev` branch may be used. Switch with `git checkout dev` (or `git checkout -b dev`).');
    return;
  }
  if (BRANCH_MUTATION.test(cmd) && !/git\s+branch\s+dev(\s|;|&|\||$)/.test(cmd)) {
    deny('Branch create/delete/rename is blocked; only the `dev` branch may exist for agent work.');
    return;
  }
  if (/git\s+push/.test(cmd) && /\b(main|master)\b/.test(cmd)) {
    deny('Pushing to main/master is blocked. Only `git push origin dev` is allowed.');
    return;
  }
  if (STATE_CHANGING.test(cmd) && !SWITCH_TO_DEV.test(cmd)) {
    const branch = currentBranch(input.cwd || process.cwd());
    if (branch && branch !== 'dev') {
      deny(`HEAD is on "${branch}" but only the \`dev\` branch may be modified. Run \`git checkout dev\` (or \`git checkout -b dev\`) first.`);
    }
  }
});
