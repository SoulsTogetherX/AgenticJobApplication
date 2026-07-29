import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { validateJob, validateContext } from "../../scripts/lib/lib.mjs"

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
)

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

// --- --from-lead ------------------------------------------------------------
//
// The sweep already captured company/title/location/description for every
// lead. Re-reading the live posting to extract the same fields is a model call
// spent on data that is sitting in the store.

const LEADS = {
  leads: [
    {
      id: "gh-acme-1",
      company: "Acme",
      title: "Full-Stack Developer",
      location: "Remote (US)",
      url: "https://job-boards.greenhouse.io/acme/jobs/1",
      description: "Build things with Node and Postgres.",
      status: "new",
    },
    {
      // The SuccessFactors shape: a real lead the fetcher got no body for.
      id: "sf-widgetco-9",
      company: "WidgetCo",
      title: "Back-End Engineer",
      location: "Las Vegas, NV",
      url: "https://widgetco.example/careers/9",
      description: "",
      status: "new",
    },
  ],
}

function withLeads(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "leads-"))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, "leads.json")
  fs.writeFileSync(file, JSON.stringify(LEADS), "utf8")
  return { dir, file }
}

test("new-job --from-lead fills the workspace from the lead store", (t) => {
  const { dir, file } = withLeads(t)
  const root = path.join(dir, "jobs")

  const res = run([
    "acme-fullstack",
    "--from-lead",
    "https://job-boards.greenhouse.io/acme/jobs/1",
    "--leads",
    file,
    "--root",
    root,
  ])
  assert.equal(res.status, 0, res.stderr)

  const job = JSON.parse(
    fs.readFileSync(path.join(root, "acme-fullstack", "job.json"), "utf8"),
  )
  assert.deepEqual(validateJob(job), [])
  assert.equal(job.company, "Acme")
  assert.equal(job.title, "Full-Stack Developer")
  assert.equal(job.location, "Remote (US)")
  assert.equal(job.source_url, "https://job-boards.greenhouse.io/acme/jobs/1")
  assert.equal(job.description, "Build things with Node and Postgres.")
  // Requirements stay an extraction job; the store does not hold them.
  assert.deepEqual(job.requirements, [])
  assert.match(res.stdout, /description=36\b/)
})

test("new-job --from-lead matches by id, and by url modulo tracking params", (t) => {
  const { dir, file } = withLeads(t)
  const root = path.join(dir, "jobs")

  assert.equal(
    run(["by-id", "--from-lead", "gh-acme-1", "--leads", file, "--root", root])
      .status,
    0,
  )
  // Share and tracking params get bolted onto ATS links constantly; the lead
  // was stored without them and must still match.
  const res = run([
    "by-url",
    "--from-lead",
    "https://job-boards.greenhouse.io/acme/jobs/1/?utm_source=x#apply",
    "--leads",
    file,
    "--root",
    root,
  ])
  assert.equal(res.status, 0, res.stderr)
  const job = JSON.parse(
    fs.readFileSync(path.join(root, "by-url", "job.json"), "utf8"),
  )
  assert.equal(job.company, "Acme")
})

test("new-job --from-lead reports a missing description rather than faking one", (t) => {
  const { dir, file } = withLeads(t)
  const root = path.join(dir, "jobs")

  const res = run([
    "widgetco-backend",
    "--from-lead",
    "sf-widgetco-9",
    "--leads",
    file,
    "--root",
    root,
  ])
  assert.equal(res.status, 0, res.stderr)
  // `missing` is the caller's signal to fall back to reading the page. A short
  // description is fine; an empty one is not.
  assert.match(res.stdout, /description=missing/)
  const job = JSON.parse(
    fs.readFileSync(path.join(root, "widgetco-backend", "job.json"), "utf8"),
  )
  assert.equal(job.description, null)
  assert.equal(job.location, "Las Vegas, NV")
})

test("new-job --from-lead exits 4 when no lead matches, creating nothing", (t) => {
  const { dir, file } = withLeads(t)
  const root = path.join(dir, "jobs")

  const res = run([
    "nowhere",
    "--from-lead",
    "https://other.example/jobs/404",
    "--leads",
    file,
    "--root",
    root,
  ])
  // 4 is distinct from 2 (usage) and 1 (workspace exists) so the caller can
  // fall back to the page read without parsing an error string.
  assert.equal(res.status, 4)
  assert.equal(fs.existsSync(path.join(root, "nowhere")), false)
})

test("explicit --company/--title still win over the stored lead", (t) => {
  const { dir, file } = withLeads(t)
  const root = path.join(dir, "jobs")

  const res = run([
    "acme-override",
    "--from-lead",
    "gh-acme-1",
    "--company",
    "Acme Corporation",
    "--title",
    "Senior Full-Stack Developer",
    "--leads",
    file,
    "--root",
    root,
  ])
  assert.equal(res.status, 0, res.stderr)
  const job = JSON.parse(
    fs.readFileSync(path.join(root, "acme-override", "job.json"), "utf8"),
  )
  assert.equal(job.company, "Acme Corporation")
  assert.equal(job.title, "Senior Full-Stack Developer")
  // Everything not overridden still comes from the lead.
  assert.equal(job.location, "Remote (US)")
})
