import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { validateJob, validateContext } from "../../scripts/lib/lib.mjs"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")

function run(argsArr) {
  return spawnSync(
    process.execPath,
    [path.join(ROOT, "scripts", "documents", "new-job.mjs"), ...argsArr],
    { cwd: ROOT, encoding: "utf8" },
  )
}

test("new-job scaffolds a schema-valid workspace", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jobs-"))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  const res = run([
    "acme-fullstack",
    "--company",
    "Acme",
    "--title",
    "Full-Stack Developer",
    "--url",
    "https://x.example/1",
    "--root",
    root,
  ])
  assert.equal(res.status, 0, res.stderr)

  const job = JSON.parse(
    fs.readFileSync(path.join(root, "acme-fullstack", "job.json"), "utf8"),
  )
  const ctx = JSON.parse(
    fs.readFileSync(path.join(root, "acme-fullstack", "context.json"), "utf8"),
  )
  assert.deepEqual(validateJob(job), [])
  assert.deepEqual(validateContext(ctx), [])
  assert.equal(job.company, "Acme")
  assert.equal(ctx.resume.status, "pending")
  assert.equal(ctx.cover_letter.status, "pending")

  // re-running for the same slug refuses (no clobbering an in-progress job)
  const again = run([
    "acme-fullstack",
    "--company",
    "Acme",
    "--title",
    "X",
    "--root",
    root,
  ])
  assert.equal(again.status, 1)
})

test("new-job rejects bad slugs and missing fields", () => {
  assert.equal(run(["Bad Slug!", "--company", "A", "--title", "B"]).status, 2)
  assert.equal(run(["UPPER", "--company", "A", "--title", "B"]).status, 2)
  assert.equal(run(["ok-slug", "--title", "B"]).status, 2)
  assert.equal(run(["ok-slug", "--company", "A"]).status, 2)
  assert.equal(run([]).status, 2)
})
