// An answer saved for THIS exact question has to outrank the label rules.
//
// The rules run first by design, but a rule that resolves a value the form does
// not offer returns NEEDS-CHOICE — and it returns NEEDS-CHOICE on that same
// field for every future application, because a rule hit short-circuits the
// bank entirely. That is the defer count that never converges. These tests pin
// the fix, and pin the blast radius of it: exact normalized text only.
import test from "node:test"
import assert from "node:assert/strict"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
)
const FIXTURES = path.join(ROOT, "tests", "fixtures")

// answers-bank.yaml has no entry for "Degree" or "Gender"; answers-exact-pick
// has both. Same fields through both banks is the before/after.
function resolveAll(fields, answersFixture) {
  const res = spawnSync(
    process.execPath,
    [
      path.join(ROOT, "scripts", "apply", "answer-bank.mjs"),
      "--fields",
      JSON.stringify(fields),
      "--profile",
      path.join(FIXTURES, "profile.yaml"),
      "--answers",
      path.join(FIXTURES, answersFixture),
      "--json",
    ],
    { cwd: ROOT, encoding: "utf8" },
  )
  assert.equal(res.status, 0, res.stderr)
  const byKey = new Map()
  for (const r of JSON.parse(res.stdout).results) byKey.set(r.k, r)
  return byKey
}

// A real Greenhouse-style degree dropdown: the profile says "Bachelor's
// Degree", the form offers none of those words.
const DEGREE_FIELD = {
  k: "f1",
  t: "select",
  l: "Degree",
  req: true,
  opts: [
    "Select...",
    "High School",
    "Undergraduate (BS/BA)",
    "Graduate (MS/MA)",
    "Doctorate",
  ],
}

test("without a saved pick, a rule that misses the options defers forever", () => {
  const r = resolveAll([DEGREE_FIELD], "answers-bank.yaml")
  assert.equal(r.get("f1").status, "NEEDS-CHOICE")
  assert.equal(r.get("f1").source, "education")
})

test("an exact saved answer outranks the rule and resolves OK", () => {
  const r = resolveAll([DEGREE_FIELD], "answers-exact-pick.yaml")
  const f = r.get("f1")
  assert.equal(f.status, "OK")
  assert.equal(f.value, "Undergraduate (BS/BA)")
  // Provenance survives into the source string so a wrong pick is findable.
  assert.equal(f.source, "a-001@exact:model")
})

test("exact matching tolerates required markers and whitespace, nothing more", () => {
  const r = resolveAll(
    [
      { ...DEGREE_FIELD, k: "f1", l: "  Degree *" },
      { ...DEGREE_FIELD, k: "f2", l: "DEGREE:" },
      { ...DEGREE_FIELD, k: "f3", l: "Degree\n  awarded" },
    ],
    "answers-exact-pick.yaml",
  )
  assert.equal(r.get("f1").status, "OK", "trailing asterisk must still match")
  assert.equal(r.get("f2").status, "OK", "case and trailing colon must match")
  // "Degree awarded" is a different question. It must fall through to the rule,
  // not inherit an answer given for "Degree".
  assert.equal(r.get("f3").status, "NEEDS-CHOICE")
  assert.equal(r.get("f3").source, "education")
})

test("a near-miss question is never answered from the exact bank", () => {
  // Shares every token with "Degree" but asks something else entirely.
  const r = resolveAll(
    [
      {
        k: "f1",
        t: "select",
        l: "Is your degree from an accredited institution?",
        req: true,
        opts: ["Yes", "No"],
      },
    ],
    "answers-exact-pick.yaml",
  )
  assert.ok(
    !String(r.get("f1").source ?? "").includes("exact"),
    `must not resolve from the exact bank, got source=${r.get("f1").source}`,
  )
})

test("an answer the user actually gave beats the EEO auto-decline", () => {
  const field = {
    k: "f1",
    t: "select",
    l: "Gender",
    opts: ["Male", "Female", "Decline to self identify"],
  }

  // Default behaviour with no saved answer: decline on the user's behalf.
  const before = resolveAll([field], "answers-bank.yaml")
  assert.equal(before.get("f1").value, "Decline to self identify")
  assert.equal(before.get("f1").source, "eeo:decline")

  // But if they answered it, discarding that answer would be the bug.
  const after = resolveAll([field], "answers-exact-pick.yaml")
  assert.equal(after.get("f1").status, "OK")
  assert.equal(after.get("f1").value, "Female")
  assert.equal(
    after.get("f1").source,
    "a-002@exact",
    "user-sourced entries carry no :model marker",
  )
})

test("an exact hit whose answer is still absent from the options defers", () => {
  // Persisting a pick must not become a way to fill a value the form rejects.
  const r = resolveAll(
    [{ ...DEGREE_FIELD, opts: ["Select...", "High School", "Doctorate"] }],
    "answers-exact-pick.yaml",
  )
  assert.equal(r.get("f1").status, "NEEDS-CHOICE")
  assert.equal(r.get("f1").source, "a-001@exact:model")
})
