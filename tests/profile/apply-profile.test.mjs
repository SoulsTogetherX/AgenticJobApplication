import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { loadYamlFile } from "../../scripts/lib/lib.mjs"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
const FIXTURE_PROFILE = path.join(ROOT, "tests", "fixtures", "profile.yaml")

function run(argsArr) {
  const res = spawnSync(
    process.execPath,
    [path.join(ROOT, "scripts", "profile", "apply-profile.mjs"), ...argsArr],
    { cwd: ROOT, encoding: "utf8" },
  )
  let report = null
  try {
    report = JSON.parse(res.stdout)
  } catch {
    /* not applied */
  }
  return { status: res.status, report, stderr: res.stderr }
}

function setup(t, mutateProposal) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "profile-"))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const target = path.join(dir, "profile.yaml")
  const proposal = path.join(dir, "profile.proposed.yaml")
  fs.copyFileSync(FIXTURE_PROFILE, target)
  let text = fs.readFileSync(FIXTURE_PROFILE, "utf8")
  text = mutateProposal(text)
  fs.writeFileSync(proposal, text, "utf8")
  return { dir, target, proposal }
}

test("pure addition applies, backs up, and removes the proposal", (t) => {
  const { dir, target, proposal } = setup(t, (text) =>
    text.replace(
      "  - id: prj-demo",
      `  - id: prj-new
    name: New Project
    tech: Python
    year: "2026"
    bullets:
      - id: prj-new-b1
        text: Built a brand new thing with 3 modules.
  - id: prj-demo`,
    ),
  )

  const { status, report } = run(["--proposal", proposal, "--target", target])
  assert.equal(status, 0, report?.toString())
  assert.deepEqual(report.added.sort(), ["prj-new", "prj-new-b1"])
  assert.ok(
    fs.existsSync(path.join(dir, "profile.backup.yaml")),
    "backup missing",
  )
  assert.ok(!fs.existsSync(proposal), "proposal should be consumed")
  const applied = loadYamlFile(target)
  assert.ok(applied.projects.some((p) => p.id === "prj-new"))
  assert.ok(
    applied.projects.some((p) => p.id === "prj-demo"),
    "existing project preserved",
  )
})

test("deleting an existing fact is refused without --allow-removals", (t) => {
  const { target, proposal } = setup(t, (text) =>
    text.replace(
      `      - id: exp-acme-b2
        text: Reduced API latency by 42% by adding PostgreSQL query caching.
`,
      "",
    ),
  )

  const before = fs.readFileSync(target, "utf8")
  const { status, stderr } = run(["--proposal", proposal, "--target", target])
  assert.equal(status, 1)
  assert.ok(stderr.includes("DELETED") && stderr.includes("exp-acme-b2"))
  assert.equal(
    fs.readFileSync(target, "utf8"),
    before,
    "target must be untouched",
  )
  assert.ok(fs.existsSync(proposal), "proposal must survive a refused apply")
})

test("deletion goes through with --allow-removals", (t) => {
  const { target, proposal } = setup(t, (text) =>
    text.replace(
      `      - id: exp-acme-b2
        text: Reduced API latency by 42% by adding PostgreSQL query caching.
`,
      "",
    ),
  )
  const { status, report } = run([
    "--proposal",
    proposal,
    "--target",
    target,
    "--allow-removals",
  ])
  assert.equal(status, 0)
  assert.deepEqual(report.removed, ["exp-acme-b2"])
})

test("rewriting an existing fact is refused without --allow-edits", (t) => {
  const { target, proposal } = setup(t, (text) =>
    text.replace("Reduced API latency by 42%", "Reduced API latency by 90%"),
  )

  const { status, stderr } = run(["--proposal", proposal, "--target", target])
  assert.equal(status, 1)
  assert.ok(stderr.includes("REWRITTEN") && stderr.includes("exp-acme-b2"))

  const ok = run(["--proposal", proposal, "--target", target, "--allow-edits"])
  assert.equal(ok.status, 0)
  assert.deepEqual(ok.report.changed, ["exp-acme-b2"])
  assert.ok(fs.readFileSync(target, "utf8").includes("90%"))
})

test("proposal with duplicate ids is rejected", (t) => {
  const { target, proposal } = setup(t, (text) =>
    text.replace("- id: prj-demo-b1", "- id: exp-acme-b1"),
  )
  const { status, stderr } = run(["--proposal", proposal, "--target", target])
  assert.equal(status, 1)
  assert.ok(stderr.includes("Duplicate fact id"))
})

test("proposal missing contact or meta is rejected", (t) => {
  const noContact = setup(t, (text) =>
    text.replace("  email: jane@test.example", "  email:"),
  )
  assert.equal(
    run(["--proposal", noContact.proposal, "--target", noContact.target])
      .status,
    1,
  )
})

test("missing proposal file is a usage error", (t) => {
  const { target } = setup(t, (x) => x)
  const { status } = run([
    "--proposal",
    path.join(path.dirname(target), "nope.yaml"),
    "--target",
    target,
  ])
  assert.equal(status, 2)
})
