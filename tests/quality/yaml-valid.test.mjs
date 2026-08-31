// Gate #14: YAML and JSON validity, READ-ONLY.
//
// docs/application-limits.yaml is the authoritative list of what this pipeline
// may apply to, and docs/job-sources.yaml is the board registry. Both are the
// USER'S FILES — the agent proposes values and never edits them. A syntax
// error in either does not fail loudly at the point of the mistake: it fails
// at 07:00 the next morning, inside an unattended cycle, as a load error on a
// file nobody was looking at.
//
// So this gate parses and asserts, and does NOTHING else. It never writes,
// never normalises, never "fixes" a quote. It also deliberately does not
// validate CONTENT — no schema, no key checks — because that would encode the
// agent's opinion about a file whose contents are the user's decision.
//
// job-sources.yaml carries an extra constraint this gate respects by doing
// nothing: manage-sources.mjs edits it LINE BY LINE to preserve comments a
// yaml round-trip would delete, which is why it is in .prettierignore.
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import yaml from "js-yaml"
import { ROOT } from "./helpers/bins.mjs"

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

const rel = (p) => path.relative(ROOT, p).replace(/\\/g, "/")

const YAML_FILES = walk(path.join(ROOT, "docs")).filter((f) =>
  /\.(yaml|yml)$/.test(f),
)
const JSON_FILES = [
  ...walk(path.join(ROOT, "schemas")).filter((f) => f.endsWith(".json")),
  path.join(ROOT, "docs", "perf-baseline.json"),
]

test("every docs/**/*.yaml parses", () => {
  const broken = []
  for (const f of YAML_FILES) {
    try {
      yaml.load(fs.readFileSync(f, "utf8"))
    } catch (err) {
      broken.push(`${rel(f)}: ${err.message.split("\n")[0]}`)
    }
  }
  assert.deepEqual(
    broken,
    [],
    `these YAML files do not parse:\n  ${broken.join("\n  ")}\n` +
      `application-limits.yaml and job-sources.yaml are the USER'S files — ` +
      `report the error and let them fix it, or propose the exact edit. Do ` +
      `not rewrite them.`,
  )
})

test("every schemas/*.json and docs/perf-baseline.json parses", () => {
  const broken = []
  for (const f of JSON_FILES) {
    try {
      JSON.parse(fs.readFileSync(f, "utf8"))
    } catch (err) {
      broken.push(`${rel(f)}: ${err.message.split("\n")[0]}`)
    }
  }
  assert.deepEqual(
    broken,
    [],
    `these JSON files do not parse:\n  ${broken.join("\n  ")}`,
  )
})

test("the two user-owned board/limit files are among the parsed set", () => {
  // Non-vacuity aimed at the two that matter most: if a rename moved them out
  // of docs/, every assertion above would still pass over a shorter list.
  const names = YAML_FILES.map(rel)
  for (const want of [
    "docs/application-limits.yaml",
    "docs/job-sources.yaml",
  ]) {
    assert.ok(
      names.includes(want),
      `${want} was not found by the scan. It is authoritative — ` +
        `roles.title_keywords in application-limits.yaml decides what is in ` +
        `scope, and it is wider than any prose summary of it. If it moved, ` +
        `this gate stopped checking it.`,
    )
  }
})

test("the yaml/json scan is not vacuous", () => {
  assert.ok(
    YAML_FILES.length >= 8,
    `only ${YAML_FILES.length} yaml files found under docs/ (expected >=8)`,
  )
  assert.ok(
    JSON_FILES.length >= 3,
    `only ${JSON_FILES.length} json files found (expected >=3)`,
  )
  for (const f of JSON_FILES) {
    assert.ok(fs.existsSync(f), `${rel(f)} is missing`)
  }
})
