#!/usr/bin/env node
// PreToolUse hook: hard-block agent Edit/Write to the user-owned fact base and
// to the guardrail machinery itself. The user edits these by hand; the agent's
// only sanctioned write path into the fact base is scripts/save-answer.mjs.
//
// NOTE: no process.exit() after writing — on Windows, exiting immediately after
// console.log drops buffered pipe output, which silently disables the deny.
let raw = '';
process.stdin.on('data', (d) => (raw += d));
process.stdin.on('end', () => {
  let input = {};
  // Strip a UTF-8 BOM (PowerShell pipes add one) so parse never fails silently.
  try { input = JSON.parse(raw.replace(/^﻿/, '')); } catch { return; }
  const file = String(input.tool_input?.file_path ?? '').replace(/\\/g, '/');
  if (!file) return;

  const PROTECTED = [
    /\/profile\/profile\.yaml$/i,
    /\/profile\/answers\.yaml$/i,
    /\/profile\/applications\.yaml$/i,
    /\/profile\/source\//i,
    /\/\.claude\/hooks\//i,
  ];
  if (PROTECTED.some((re) => re.test(file))) {
    console.log(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          `"${file}" is part of the user-owned fact base / guardrails. ` +
          'Ask the user to edit it, or use `node scripts/save-answer.mjs` for new answers.',
      },
    }));
  }
});
