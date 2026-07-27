#!/usr/bin/env node
// PostToolUse hook: run prettier on every document the agent edits/writes so
// formatting stays consistent. Silently skips files prettier can't parse.
//
// NOTE: no process.exit() after writing — on Windows, exiting immediately after
// console.log drops buffered pipe output (same caveat as protect-profile.js).
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PRETTIER_BIN = fileURLToPath(
  new URL('../../node_modules/prettier/bin/prettier.cjs', import.meta.url)
);

const SUPPORTED = new Set([
  '.md', '.markdown', '.json', '.js', '.mjs', '.cjs', '.ts', '.mts',
  '.yaml', '.yml', '.css', '.html', '.htm',
]);

let raw = '';
process.stdin.on('data', (d) => (raw += d));
process.stdin.on('end', () => {
  let input = {};
  try { input = JSON.parse(raw.replace(/^﻿/, '')); } catch { return; }
  const file = String(
    input.tool_input?.file_path ?? input.tool_response?.filePath ?? ''
  );
  if (!file || !existsSync(file)) return;
  if (!SUPPORTED.has(path.extname(file).toLowerCase())) return;
  if (!existsSync(PRETTIER_BIN)) return; // prettier not installed: never block edits

  const res = spawnSync(
    process.execPath,
    // --ignore-path: don't inherit .gitignore (prettier 3 default) — jobs/ is
    // gitignored on purpose but its documents must still be formatted.
    [PRETTIER_BIN, '--write', '--log-level', 'silent', '--ignore-path', '.prettierignore', file],
    { encoding: 'utf8' }
  );
  if (res.status !== 0 && res.stderr) {
    // Non-blocking: report but never fail the edit over a formatting hiccup.
    console.log(JSON.stringify({
      systemMessage: `prettier could not format ${file}: ${res.stderr.trim().slice(0, 200)}`,
    }));
  }
});
