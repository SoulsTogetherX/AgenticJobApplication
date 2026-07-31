// Repo hygiene checks that belong to the pipeline rather than to any feature.
//
// Written because of a real near-miss on 2026-07-31: the `*.html` rule in
// .gitignore silently swallowed all ten HTML fixtures for the fake ATS board
// and the hostile-form corpus the moment they were created. Every test using
// them passed on the machine that wrote them and would have failed — or worse,
// found nothing — on a fresh clone. Nothing in the suite would have noticed,
// because a test's inputs are invisible to the test.
//
// Owned by ci-engineer (tests/hooks/), like .gitignore itself.
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
)

function gitAvailable() {
  const res = spawnSync("git", ["--version"], { cwd: ROOT, encoding: "utf8" })
  return res.status === 0
}

function walk(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name)
    if (ent.isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

test("nothing under tests/ is gitignored", (t) => {
  if (!gitAvailable()) {
    // Explicit and attributed: the gate rejects a skip with no reason.
    return t.skip("git is not on PATH, so ignore rules cannot be evaluated")
  }
  const files = walk(path.join(ROOT, "tests")).map((p) =>
    path.relative(ROOT, p).split(path.sep).join("/"),
  )
  assert.ok(files.length > 50, "sanity: the walk found the test tree")

  // check-ignore exits 0 and echoes the paths it WOULD ignore.
  const res = spawnSync("git", ["check-ignore", "--stdin"], {
    cwd: ROOT,
    input: files.join("\n"),
    encoding: "utf8",
  })
  const ignored = res.stdout.split("\n").filter(Boolean)
  assert.deepEqual(
    ignored,
    [],
    `these test files would never reach a clone:\n  ${ignored.join("\n  ")}\nFix .gitignore (ci-engineer owns it) rather than moving the fixture.`,
  )
})

test("the fake board and hostile fixtures are committable", (t) => {
  if (!gitAvailable()) {
    return t.skip("git is not on PATH, so ignore rules cannot be evaluated")
  }
  // Named explicitly so the check keeps meaning something if the walk above is
  // ever narrowed: these are the inputs the Phase 1 security gate depends on.
  const required = [
    "tests/fixtures/boards",
    "tests/fixtures/hostile",
    "tests/security",
  ]
  for (const rel of required) {
    const dir = path.join(ROOT, rel)
    if (!fs.existsSync(dir)) {
      // These land with qa-adversary's work; do not invent a pass for a
      // directory that is not here yet, but do not fail the whole suite on
      // ordering either — the security gate is what requires tests/security.
      t.diagnostic(`${rel} does not exist yet`)
      continue
    }
    const files = walk(dir).map((p) =>
      path.relative(ROOT, p).split(path.sep).join("/"),
    )
    const res = spawnSync("git", ["check-ignore", "--stdin"], {
      cwd: ROOT,
      input: files.join("\n"),
      encoding: "utf8",
    })
    assert.equal(
      res.stdout.trim(),
      "",
      `gitignored fixtures under ${rel}: ${res.stdout.trim()}`,
    )
  }
})
