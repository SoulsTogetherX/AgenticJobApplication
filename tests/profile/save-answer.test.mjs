import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { loadYamlFile } from "../../scripts/lib/lib.mjs"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")

function run(argsArr) {
  return spawnSync(
    process.execPath,
    [path.join(ROOT, "scripts", "profile", "save-answer.mjs"), ...argsArr],
    { cwd: ROOT, encoding: "utf8" },
  )
}

test("save-answer creates file, appends, and rejects duplicates", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "answers-"))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, "answers.yaml")

  // 1. first answer creates the file
  let res = run([
    "Are you willing to relocate?",
    "No, remote or Las Vegas area only.",
    "--file",
    file,
  ])
  assert.equal(res.status, 0, res.stderr)
  let data = loadYamlFile(file)
  assert.equal(data.answers.length, 1)
  assert.equal(data.answers[0].id, "a-001")
  assert.match(data.answers[0].added, /^\d{4}-\d{2}-\d{2}$/)

  // 2. second answer appends with next id
  res = run([
    "Expected salary?",
    "$90k-$110k depending on benefits.",
    "--file",
    file,
  ])
  assert.equal(res.status, 0, res.stderr)
  data = loadYamlFile(file)
  assert.equal(data.answers.length, 2)
  assert.equal(data.answers[1].id, "a-002")

  // 3. same question again (case-insensitive) is rejected, file unchanged
  res = run(["expected salary?", "something else", "--file", file])
  assert.equal(res.status, 1)
  assert.equal(loadYamlFile(file).answers.length, 2)

  // 4. explicit duplicate id is rejected
  res = run(["New question?", "yes", "--id", "a-001", "--file", file])
  assert.equal(res.status, 1)
  assert.equal(loadYamlFile(file).answers.length, 2)
})

test("save-answer rejects empty question/answer (usage error)", () => {
  assert.equal(run(["", "answer"]).status, 2)
  assert.equal(run(["question only"]).status, 2)
  assert.equal(run(["q", "   "]).status, 2)
})

test("save-answer records provenance and validates --source", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "answers-src-"))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, "answers.yaml")

  // Default provenance is the user — the agent has to opt in to saying
  // otherwise, so an unmarked entry is never mistaken for a derived one.
  assert.equal(run(["Expected salary?", "$90k", "--file", file]).status, 0)
  assert.equal(loadYamlFile(file).answers[0].source, "user")

  const res = run(["Degree", "Undergraduate (BS/BA)", "--source", "model", "--file", file])
  assert.equal(res.status, 0, res.stderr)
  assert.equal(loadYamlFile(file).answers[1].source, "model")

  // An unrecognised source is a usage error, not a silently stored string.
  assert.equal(
    run(["New q?", "a", "--source", "guessed", "--file", file]).status,
    2,
  )
  assert.equal(loadYamlFile(file).answers.length, 2)
})

test("--replace overwrites a model pick but never a user-stated answer", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "answers-repl-"))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, "answers.yaml")

  run(["Degree", "Undergraduate (BS/BA)", "--source", "model", "--file", file])
  run(["Expected salary?", "$90k", "--file", file])

  // Without --replace nothing is overwritten, whatever the provenance.
  assert.equal(run(["Degree", "Graduate (MS/MA)", "--file", file]).status, 1)
  assert.equal(loadYamlFile(file).answers[0].answer, "Undergraduate (BS/BA)")

  // A derived pick is correctable: that is the point of recording provenance.
  const fixed = run([
    "degree",
    "Graduate (MS/MA)",
    "--replace",
    "--file",
    file,
  ])
  assert.equal(fixed.status, 0, fixed.stderr)
  let data = loadYamlFile(file)
  assert.equal(data.answers.length, 2, "--replace must not append a duplicate")
  assert.equal(data.answers[0].id, "a-001", "the id is kept")
  assert.equal(data.answers[0].answer, "Graduate (MS/MA)")
  assert.equal(data.answers[0].source, "user", "replacing promotes provenance")

  // What the user said themselves is not the agent's to overwrite.
  const blocked = run([
    "Expected salary?",
    "$200k",
    "--source",
    "model",
    "--replace",
    "--file",
    file,
  ])
  assert.equal(blocked.status, 1)
  assert.match(blocked.stderr, /user-stated/i)
  data = loadYamlFile(file)
  assert.equal(data.answers[1].answer, "$90k")
})

test("--replace refuses a legacy entry that predates provenance", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "answers-legacy-"))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, "answers.yaml")

  // Entries written before --source existed carry no provenance at all. They
  // came from the user, so they get the user's protection.
  fs.writeFileSync(
    file,
    "answers:\n  - id: a-001\n    question: Expected salary?\n    answer: $90k\n    added: 2026-07-01\n",
    "utf8",
  )
  const res = run([
    "Expected salary?",
    "$200k",
    "--source",
    "model",
    "--replace",
    "--file",
    file,
  ])
  assert.equal(res.status, 1)
  assert.equal(loadYamlFile(file).answers[0].answer, "$90k")
})
