import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadYamlFile } from '../scripts/lib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function run(argsArr) {
  return spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'save-answer.mjs'), ...argsArr], { cwd: ROOT, encoding: 'utf8' });
}

test('save-answer creates file, appends, and rejects duplicates', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'answers-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'answers.yaml');

  // 1. first answer creates the file
  let res = run(['Are you willing to relocate?', 'No, remote or Las Vegas area only.', '--file', file]);
  assert.equal(res.status, 0, res.stderr);
  let data = loadYamlFile(file);
  assert.equal(data.answers.length, 1);
  assert.equal(data.answers[0].id, 'a-001');
  assert.match(data.answers[0].added, /^\d{4}-\d{2}-\d{2}$/);

  // 2. second answer appends with next id
  res = run(['Expected salary?', '$90k-$110k depending on benefits.', '--file', file]);
  assert.equal(res.status, 0, res.stderr);
  data = loadYamlFile(file);
  assert.equal(data.answers.length, 2);
  assert.equal(data.answers[1].id, 'a-002');

  // 3. same question again (case-insensitive) is rejected, file unchanged
  res = run(['expected salary?', 'something else', '--file', file]);
  assert.equal(res.status, 1);
  assert.equal(loadYamlFile(file).answers.length, 2);

  // 4. explicit duplicate id is rejected
  res = run(['New question?', 'yes', '--id', 'a-001', '--file', file]);
  assert.equal(res.status, 1);
  assert.equal(loadYamlFile(file).answers.length, 2);
});

test('save-answer rejects empty question/answer (usage error)', () => {
  assert.equal(run(['', 'answer']).status, 2);
  assert.equal(run(['question only']).status, 2);
  assert.equal(run(['q', '   ']).status, 2);
});
