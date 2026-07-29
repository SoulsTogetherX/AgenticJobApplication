import test from "node:test"
import assert from "node:assert/strict"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
const FIXTURES = path.join(ROOT, "tests", "fixtures")

function run(fields, extra = []) {
  return spawnSync(
    process.execPath,
    [
      path.join(ROOT, "scripts", "apply", "answer-bank.mjs"),
      "--fields",
      JSON.stringify(fields),
      "--profile",
      path.join(FIXTURES, "profile.yaml"),
      "--answers",
      path.join(FIXTURES, "answers-bank.yaml"),
      ...extra,
    ],
    { cwd: ROOT, encoding: "utf8" },
  )
}

function resolveAll(fields) {
  const res = run(fields, ["--json"])
  assert.equal(res.status, 0, res.stderr)
  const byKey = new Map()
  for (const r of JSON.parse(res.stdout).results) byKey.set(r.k, r)
  return byKey
}

test("resolves contact fields from the profile", () => {
  const r = resolveAll([
    { k: "f1", t: "text", l: "First Name *" },
    { k: "f2", t: "text", l: "Last Name" },
    { k: "f3", t: "email", l: "Email" },
    { k: "f4", t: "tel", l: "Phone number" },
    { k: "f5", t: "text", l: "Current location (city)" },
  ])
  assert.equal(r.get("f1").value, "Jane")
  assert.equal(r.get("f1").status, "OK")
  assert.equal(r.get("f2").value, "Test")
  assert.equal(r.get("f3").value, "jane@test.example")
  assert.equal(r.get("f4").value, "(555) 123-4567")
  assert.equal(r.get("f5").value, "Springfield")
})

test("matches the answers bank and maps the answer onto real options", () => {
  const r = resolveAll([
    { k: "f1", t: "select", l: "Are you authorized to work in the US?" },
    {
      k: "g1",
      t: "radio",
      l: "Are you legally authorized to work in the United States?",
      o: [
        { k: "f8", l: "Yes" },
        { k: "f9", l: "No" },
      ],
    },
  ])
  // strong wording match -> uses the banked answer verbatim
  assert.equal(r.get("f1").status, "OK")
  assert.match(r.get("f1").value, /^Yes/)
  // radio group -> answer normalised to the option label + the key to click
  const g = r.get("g1")
  assert.equal(g.status, "OK")
  assert.equal(g.value, "Yes")
  assert.match(g.note, /pick=f8/)
})

test("unmatched questions come back UNKNOWN instead of invented", () => {
  const r = resolveAll([
    { k: "f1", t: "number", l: "How many years of Kubernetes experience?" },
    { k: "f2", t: "text", l: "Desired salary" },
  ])
  assert.equal(r.get("f1").status, "UNKNOWN")
  assert.equal(r.get("f1").value, "")
  assert.equal(r.get("f2").status, "UNKNOWN")
})

test("EEO questions default to the decline option, files are skipped", () => {
  const r = resolveAll([
    {
      k: "f1",
      t: "select",
      l: "Gender",
      opts: ["Select...", "Male", "Female", "Decline to self-identify"],
    },
    { k: "f2", t: "select", l: "Veteran status", opts: ["Yes", "No"] },
    { k: "f3", t: "file", l: "Resume/CV" },
  ])
  assert.equal(r.get("f1").status, "OK")
  assert.equal(r.get("f1").value, "Decline to self-identify")
  // no decline option offered -> never guess on the user's behalf
  assert.equal(r.get("f2").status, "UNKNOWN")
  assert.equal(r.get("f3").status, "SKIP")
})

test("flags a resolved value that matches none of the offered options", () => {
  const r = resolveAll([
    {
      k: "f1",
      t: "select",
      l: "Are you authorized to work in the US?",
      opts: ["Requires sponsorship", "Green card holder"],
    },
  ])
  assert.equal(r.get("f1").status, "NEEDS-CHOICE")
  assert.match(r.get("f1").note, /options: Requires sponsorship/)
})

test("weak wording matches surface as MAYBE with the banked question", () => {
  const r = resolveAll([
    { k: "f1", t: "text", l: "US work authorization status?" },
  ])
  const f = r.get("f1")
  assert.ok(
    ["MAYBE", "OK"].includes(f.status),
    `expected a match, got ${f.status}`,
  )
  if (f.status === "MAYBE") assert.match(f.note, /bank asks:/)
})

test("terse output is one tab-separated line per field plus a summary", () => {
  const res = run([
    { k: "f1", t: "text", l: "First Name" },
    { k: "f2", t: "text", l: "Desired salary" },
  ])
  assert.equal(res.status, 0, res.stderr)
  const lines = res.stdout.trim().split(/\r?\n/)
  assert.equal(lines.length, 3)
  assert.deepEqual(lines[0].split("\t").slice(0, 4), [
    "f1",
    "OK",
    "contact.name",
    "Jane",
  ])
  assert.match(lines[1], /^f2\tUNKNOWN/)
  assert.match(lines[2], /^# 2 fields:/)
})

test("usage errors: no input and malformed JSON", () => {
  const noInput = spawnSync(
    process.execPath,
    [path.join(ROOT, "scripts", "apply", "answer-bank.mjs"), "--fields", "   "],
    { cwd: ROOT, encoding: "utf8" },
  )
  assert.equal(noInput.status, 2)
  assert.equal(run([], ["--json"]).status, 0) // empty list is fine
  const bad = spawnSync(
    process.execPath,
    [path.join(ROOT, "scripts", "apply", "answer-bank.mjs"), "--fields", "{not json"],
    { cwd: ROOT, encoding: "utf8" },
  )
  assert.equal(bad.status, 2)
})
