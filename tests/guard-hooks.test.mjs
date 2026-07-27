import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GUARD_FILES = path.join(ROOT, 'scripts', 'hooks', 'guard-files.mjs');
const GUARD_BASH = path.join(ROOT, 'scripts', 'hooks', 'guard-bash.mjs');
const PRETTIFY = path.join(ROOT, 'scripts', 'hooks', 'prettify.mjs');

function runHook(script, payload) {
  const res = spawnSync(process.execPath, [script], { input: payload, encoding: 'utf8' });
  let decision = null;
  if (res.stdout.trim()) {
    try { decision = JSON.parse(res.stdout).hookSpecificOutput?.permissionDecision ?? null; } catch {}
  }
  return { status: res.status, decision };
}

const edit = (file) => JSON.stringify({ tool_name: 'Edit', cwd: ROOT, tool_input: { file_path: file } });
const write = (file) => JSON.stringify({ tool_name: 'Write', cwd: ROOT, tool_input: { file_path: file } });
const bash = (command) => JSON.stringify({ tool_name: 'Bash', cwd: ROOT, tool_input: { command } });

// ---------- guard-files ----------

test('guard-files denies edits outside the project directory', () => {
  const outside = [
    'C:/Windows/System32/drivers/etc/hosts',
    path.join(os.homedir(), 'Documents', 'other-project', 'index.js'),
    path.resolve(ROOT, '..', 'sibling-project', 'file.txt'),
  ];
  for (const p of outside) {
    const { status, decision } = runHook(GUARD_FILES, edit(p));
    assert.equal(status, 0);
    assert.equal(decision, 'deny', `expected deny for ${p}`);
  }
});

test('guard-files allows the temp dir and Claude session memory exceptions', () => {
  const allowed = [
    path.join(os.tmpdir(), 'claude', 'scratch', 'notes.md'),
    path.join(os.homedir(), '.claude', 'projects', 'X--proj', 'memory', 'fact.md'),
  ];
  for (const p of allowed) {
    const { decision } = runHook(GUARD_FILES, edit(p));
    assert.equal(decision, null, `expected allow for ${p}`);
  }
});

test('guard-files denies creating new files outside jobs/', () => {
  const newFiles = [
    path.join(ROOT, 'totally-new-file.md'),
    path.join(ROOT, 'docs', 'new-doc.md'),
    path.join(ROOT, 'scripts', 'new-script.mjs'),
  ];
  for (const p of newFiles) {
    assert.ok(!fs.existsSync(p), `test precondition: ${p} must not exist`);
    const { decision } = runHook(GUARD_FILES, write(p));
    assert.equal(decision, 'deny', `expected deny for new file ${p}`);
  }
});

test('guard-files allows new files under jobs/ and edits to existing files', () => {
  const allowed = [
    write(path.join(ROOT, 'jobs', 'acme-dev', 'resume.md')), // new, but in jobs/
    write(path.join(ROOT, 'README.md')),                     // exists: overwrite ok
    edit(path.join(ROOT, 'docs', 'tailoring-rules.md')),     // exists: edit ok
  ];
  for (const payload of allowed) {
    const { decision } = runHook(GUARD_FILES, payload);
    assert.equal(decision, null, `expected allow for ${payload}`);
  }
});

test('guard-files protects its own directory', () => {
  const { decision } = runHook(GUARD_FILES, edit(path.join(ROOT, 'scripts', 'hooks', 'guard-files.mjs')));
  assert.equal(decision, 'deny');
});

test('guard-files tolerates malformed or empty input', () => {
  assert.equal(runHook(GUARD_FILES, 'not json').status, 0);
  assert.equal(runHook(GUARD_FILES, '').status, 0);
  assert.equal(runHook(GUARD_FILES, '{}').status, 0);
});

// ---------- guard-bash ----------

test('guard-bash denies file deletion and creation commands', () => {
  const blocked = [
    'rm -rf jobs',
    'rmdir /s docs',
    'del important.txt',
    'Remove-Item -Recurse profile',
    'npx rimraf node_modules',
    'mkdir new-dir',
    'touch new-file.txt',
    'New-Item -ItemType File x.txt',
    'echo hi; rm x.txt',
  ];
  for (const c of blocked) {
    const { decision } = runHook(GUARD_BASH, bash(c));
    assert.equal(decision, 'deny', `expected deny for: ${c}`);
  }
});

test('guard-bash allows harmless commands and sanctioned scripts', () => {
  const allowed = [
    'npm test',
    'node scripts/new-job.mjs acme --company "Acme" --title "Dev"',
    'node scripts/verify-claims.mjs resume jobs/acme/resume.md',
    'git status',
    'git log --oneline -5',
    'git diff',
    'format the norm', // substrings containing rm/del must not trip the regex
  ];
  for (const c of allowed) {
    const { decision } = runHook(GUARD_BASH, bash(c));
    assert.equal(decision, null, `expected allow for: ${c}`);
  }
});

test('guard-bash denies switching to or pushing any branch but dev', () => {
  const blocked = [
    'git checkout main',
    'git switch master',
    'git checkout -b feature/x',
    'git branch -D dev',
    'git branch new-feature',
    'git push origin main',
    'git push -f origin master',
  ];
  for (const c of blocked) {
    const { decision } = runHook(GUARD_BASH, bash(c));
    assert.equal(decision, 'deny', `expected deny for: ${c}`);
  }
});

test('guard-bash allows dev-branch git operations', () => {
  const allowed = [
    'git checkout dev',
    'git checkout -b dev',
    'git switch dev',
  ];
  for (const c of allowed) {
    const { decision } = runHook(GUARD_BASH, bash(c));
    assert.equal(decision, null, `expected allow for: ${c}`);
  }
});

test('guard-bash denies git rm and git clean outright', () => {
  for (const c of ['git rm old-file.md', 'git clean -fd']) {
    const { decision } = runHook(GUARD_BASH, bash(c));
    assert.equal(decision, 'deny', `expected deny for: ${c}`);
  }
});

test('guard-bash tolerates malformed or empty input', () => {
  assert.equal(runHook(GUARD_BASH, 'not json').status, 0);
  assert.equal(runHook(GUARD_BASH, '').status, 0);
  assert.equal(runHook(GUARD_BASH, '{}').status, 0);
});

// ---------- prettify ----------

test('prettify formats a messy markdown file in place', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prettify-test-'));
  const file = path.join(dir, 'messy.md');
  try {
    fs.writeFileSync(file, '#   Title\n\n\n\n*  item one\n*  item two\n');
    const payload = JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: file } });
    const res = spawnSync(process.execPath, [PRETTIFY], { input: payload, encoding: 'utf8', timeout: 30000 });
    assert.equal(res.status, 0);
    const out = fs.readFileSync(file, 'utf8');
    assert.equal(out, '# Title\n\n- item one\n- item two\n');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('prettify skips unsupported and missing files without failing', () => {
  const payloads = [
    JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: path.join(ROOT, 'no-such-file.md') } }),
    JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: path.join(ROOT, 'LICENSE') } }),
    'not json',
    '{}',
  ];
  for (const p of payloads) {
    const res = spawnSync(process.execPath, [PRETTIFY], { input: p, encoding: 'utf8', timeout: 30000 });
    assert.equal(res.status, 0);
  }
});
