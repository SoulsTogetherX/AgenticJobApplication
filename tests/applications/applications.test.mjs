import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { loadYamlFile } from "../../scripts/lib/lib.mjs"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")

function log(argsArr) {
  return spawnSync(
    process.execPath,
    [path.join(ROOT, "scripts", "applications", "log-application.mjs"), ...argsArr],
    { cwd: ROOT, encoding: "utf8" },
  )
}
function check(argsArr) {
  const res = spawnSync(
    process.execPath,
    [path.join(ROOT, "scripts", "applications", "check-applied.mjs"), ...argsArr],
    { cwd: ROOT, encoding: "utf8" },
  )
  let report = null
  try {
    report = JSON.parse(res.stdout)
  } catch {
    /* usage errors */
  }
  return { status: res.status, report, stderr: res.stderr }
}

test("log-application records, appends, and rejects duplicate slugs", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "apps-"))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, "applications.yaml")

  let res = log([
    "widgetco-fullstack",
    "--company",
    "WidgetCo",
    "--title",
    "Full-Stack Engineer",
    "--url",
    "https://example.com/jobs/123",
    "--date",
    "2026-07-20",
    "--file",
    file,
  ])
  assert.equal(res.status, 0, res.stderr)
  res = log([
    "acme-fullstack",
    "--company",
    "Acme Corp",
    "--title",
    "Full-Stack Developer",
    "--file",
    file,
  ])
  assert.equal(res.status, 0, res.stderr)

  const data = loadYamlFile(file)
  assert.equal(data.applications.length, 2)
  assert.equal(data.applications[0].applied_at, "2026-07-20")
  assert.match(data.applications[1].applied_at, /^\d{4}-\d{2}-\d{2}$/) // defaulted to today

  // duplicate slug rejected, log unchanged
  res = log([
    "widgetco-fullstack",
    "--company",
    "WidgetCo",
    "--title",
    "Same Again",
    "--file",
    file,
  ])
  assert.equal(res.status, 1)
  assert.equal(loadYamlFile(file).applications.length, 2)
})

test("log-application usage errors: missing fields, bad date", () => {
  assert.equal(log([]).status, 2)
  assert.equal(log(["slug-only"]).status, 2)
  assert.equal(log(["s", "--company", "C"]).status, 2)
  assert.equal(
    log(["s", "--company", "C", "--title", "T", "--date", "07/20/2026"]).status,
    2,
  )
  assert.equal(
    log(["s", "--company", "C", "--title", "T", "--date", "2026-13-99"]).status,
    2,
  )
})

test("check-applied finds jobs and companies with day counts", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "apps-"))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, "applications.yaml")
  log([
    "widgetco-fullstack",
    "--company",
    "WidgetCo",
    "--title",
    "Full-Stack Engineer",
    "--date",
    "2026-07-20",
    "--file",
    file,
  ])
  log([
    "widgetco-backend",
    "--company",
    "WidgetCo",
    "--title",
    "Backend Engineer",
    "--date",
    "2026-07-27",
    "--file",
    file,
  ])
  log([
    "acme-fullstack",
    "--company",
    "Acme Corp",
    "--title",
    "Full-Stack Developer",
    "--date",
    "2026-06-01",
    "--file",
    file,
  ])

  // exact slug match → job_already_applied, correct days_ago
  let { status, report } = check([
    "widgetco-fullstack",
    "--file",
    file,
    "--today",
    "2026-07-27",
  ])
  assert.equal(status, 0)
  assert.equal(report.job_already_applied, true)
  assert.equal(report.matches.length, 1)
  assert.equal(report.matches[0].days_ago, 7)

  // company match is case-insensitive substring; both WidgetCo roles reported, most recent first
  ;({ status, report } = check([
    "widgetco",
    "--file",
    file,
    "--today",
    "2026-07-27",
  ]))
  assert.equal(report.job_already_applied, false)
  assert.equal(report.matches.length, 2)
  assert.equal(report.matches[0].days_ago, 0) // same-day application (boundary)
  assert.equal(report.matches[1].days_ago, 7)

  // title match works too
  ;({ report } = check([
    "full-stack developer",
    "--file",
    file,
    "--today",
    "2026-07-27",
  ]))
  assert.equal(report.matches.length, 1)
  assert.equal(report.matches[0].company, "Acme Corp")

  // no match → clean empty result
  ;({ status, report } = check([
    "Globex",
    "--file",
    file,
    "--today",
    "2026-07-27",
  ]))
  assert.equal(status, 0)
  assert.equal(report.matches.length, 0)
  assert.equal(report.job_already_applied, false)
})

test("check-applied handles missing/empty log and usage errors", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "apps-"))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))

  // missing file → zero matches, not a crash
  const { status, report } = check([
    "WidgetCo",
    "--file",
    path.join(dir, "nope.yaml"),
  ])
  assert.equal(status, 0)
  assert.equal(report.checked, 0)
  assert.equal(report.matches.length, 0)

  // usage errors
  assert.equal(check([]).status, 2)
  assert.equal(check(["   "]).status, 2)
  assert.equal(check(["X", "--today", "yesterday"]).status, 2)
})

test("the real applications.yaml (if present) parses as a list", (t) => {
  const p = path.join(ROOT, "profile", "applications.yaml")
  if (!fs.existsSync(p)) {
    t.skip("no applications log on this machine")
    return
  }
  const data = loadYamlFile(p)
  assert.ok(Array.isArray(data.applications))
})
