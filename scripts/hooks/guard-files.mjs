#!/usr/bin/env node
// PreToolUse hook (Edit|Write|NotebookEdit): filesystem boundary for this
// project. This pipeline tailors and applies to jobs — it does not generate
// content elsewhere, so:
//   1. No edits/writes outside the project directory (temp dir and Claude's
//      own session memory dir are the only exceptions).
//   2. No NEW files anywhere except jobs/ workspaces (tailored resume.md,
//      cover-letter.md, PDFs). Everything else in the repo is edit-only.
//   3. scripts/hooks/ is self-protected, same as .claude/hooks/.
//
// NOTE: no process.exit() after writing — on Windows, exiting immediately after
// console.log drops buffered pipe output (same caveat as protect-profile.js).
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function deny(reason) {
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }));
}

let raw = '';
process.stdin.on('data', (d) => (raw += d));
process.stdin.on('end', () => {
  let input = {};
  try { input = JSON.parse(raw.replace(/^﻿/, '')); } catch { return; }
  const file = String(
    input.tool_input?.file_path ?? input.tool_input?.notebook_path ?? ''
  );
  if (!file) return;

  const root = path.resolve(input.cwd || process.cwd());
  const abs = path.resolve(root, file);
  const rel = path.relative(root, abs);
  const outside = rel.startsWith('..') || path.isAbsolute(rel);

  if (outside) {
    const tmp = path.relative(os.tmpdir(), abs);
    const inTmp = !tmp.startsWith('..') && !path.isAbsolute(tmp);
    const inMemory = /[\\/]\.claude[\\/]projects[\\/][^\\/]+[\\/]memory[\\/]/.test(abs);
    if (!inTmp && !inMemory) {
      deny(`"${file}" is outside the project directory. This project only edits its own files.`);
    }
    return;
  }

  if (/^scripts[\\/]hooks([\\/]|$)/i.test(rel)) {
    deny(`"${file}" is guardrail machinery. Ask the user to edit it by hand.`);
    return;
  }

  if (!existsSync(abs) && !/^jobs([\\/]|$)/i.test(rel)) {
    deny(
      `"${file}" does not exist and new files are only allowed under jobs/ ` +
      '(this project applies to jobs; it does not generate other content). ' +
      'Ask the user to create the file if it is genuinely needed.'
    );
  }
});
