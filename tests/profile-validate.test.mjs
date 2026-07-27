import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { loadYamlFile, buildFactIndex } from "../scripts/lib.mjs"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

test("fixture profile is well-formed with unique fact ids", () => {
  const profile = loadYamlFile(
    path.join(ROOT, "tests", "fixtures", "profile.yaml"),
  )
  const idx = buildFactIndex(profile, { answers: [] })
  assert.ok(idx.size >= 8)
  assert.equal(profile.meta.target_role, "Full-Stack Developer")
})

test("example profile template is well-formed", () => {
  const profile = loadYamlFile(
    path.join(ROOT, "profile", "profile.example.yaml"),
  )
  const idx = buildFactIndex(profile, { answers: [] })
  assert.ok(idx.size >= 5)
})

// The real profile is gitignored; validate it only where it exists.
test("real profile (if present) parses with unique ids and required meta", (t) => {
  const p = path.join(ROOT, "profile", "profile.yaml")
  if (!fs.existsSync(p)) {
    t.skip("no real profile on this machine")
    return
  }
  const profile = loadYamlFile(p)
  const answersPath = path.join(ROOT, "profile", "answers.yaml")
  const answers = fs.existsSync(answersPath)
    ? loadYamlFile(answersPath)
    : { answers: [] }
  const idx = buildFactIndex(profile, answers) // throws on duplicate ids
  assert.ok(idx.size >= 20, "real profile looks too small")
  assert.equal(profile.meta.target_role, "Full-Stack Developer")
  assert.ok(typeof profile.meta.approved_by_user === "boolean")
  assert.ok(profile.contact?.name)
  assert.ok(profile.contact?.email)
})
