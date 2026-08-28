// QA-0.12-1 — the fact base must not silently be empty.
//
// THE DEFECT (live from 147eb68, 2026-07-30, until this test existed).
// `resolveFieldsFromFiles` declared its paths as DESTRUCTURING DEFAULTS:
//
//     { profileFile = "profile/profile.yaml", answersFile = "profile/answers.yaml" } = {}
//
// A destructuring default fires only on `undefined`. All three callers build
// their options from a CLI flag helper that returns `null` when the flag is
// absent, so the documented invocation `node src/apply/fill-plan.mjs
// <slug>` passed `profileFile: null`. `fs.existsSync(null)` does not throw on
// Node 24 — it returns false and emits DEP0187 — so both files "did not
// exist", both loaded as `{}`, and the resolver ran against an EMPTY FACT
// BASE. Measured against jobs/coinbase-software-engineer/scan-p1.json: 15 OK /
// 3 CONFIRM / 8 UNKNOWN with the paths omitted, 2 OK / 31 UNKNOWN with them
// passed as `null`.
//
// WHY NO EXISTING TEST CAUGHT IT, which is the more interesting fact. Every
// test in this suite passes an EXPLICIT fixture path, because tests must never
// read the real gitignored `profile/`. An explicit string is exactly the one
// input shape that worked. The defect lived entirely in the shape nothing
// tested: "the caller did not say."
//
// So this file tests THE ABSENCE OF AN ARGUMENT, portably, by building a
// throwaway fact base in a temp directory and running from inside it — the
// defaults are relative to cwd, so that is the only way to exercise them
// without touching the real one. cwd is restored in a `finally` and node:test
// runs the tests in one file sequentially, so nothing else is affected.
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { resolveFieldsFromFiles } from "../../src/apply/answer-bank.mjs"
import { resolveFields } from "../../src/apply/fill-plan.mjs"

const FIELDS = [
  { k: "f1", t: "text", sel: "#f1", l: "Email" },
  { k: "f2", t: "text", sel: "#f2", l: "First name" },
  { k: "f3", t: "text", sel: "#f3", l: "What is your notice period?" },
]

function withFactBase(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aj-factbase-"))
  fs.mkdirSync(path.join(dir, "profile"))
  fs.writeFileSync(
    path.join(dir, "profile", "profile.yaml"),
    "contact:\n  name: Jane Test\n  email: jane@example.com\n",
  )
  fs.writeFileSync(
    path.join(dir, "profile", "answers.yaml"),
    "answers:\n  - id: a-001\n    question: What is your notice period?\n    answer: Two weeks\n",
  )
  const cwd = process.cwd()
  try {
    process.chdir(dir)
    return fn()
  } finally {
    process.chdir(cwd)
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

const statuses = (results) =>
  Object.fromEntries(results.map((r) => [r.k, `${r.status}:${r.value}`]))

test("QA-0.12-1: an explicitly NULL path resolves the same as an omitted one", () => {
  withFactBase(() => {
    const omitted = resolveFieldsFromFiles(FIELDS, {}).results
    const nulled = resolveFieldsFromFiles(FIELDS, {
      profileFile: null,
      answersFile: null,
    }).results

    // The fact base was actually read — if this fails the fixture is wrong,
    // not the code, and the comparison below would be vacuously true.
    assert.equal(
      statuses(omitted).f1,
      "OK:jane@example.com",
      "the temp fact base must resolve, or this test proves nothing",
    )
    assert.equal(statuses(omitted).f3, "OK:Two weeks")

    // THE REGRESSION. On the defective code `nulled` was UNKNOWN across the
    // board while `omitted` resolved.
    assert.deepEqual(
      statuses(nulled),
      statuses(omitted),
      "a null path means 'not specified', never 'there is no fact base'",
    )
  })
})

test("QA-0.12-1: undefined and empty-string paths behave the same way too", () => {
  withFactBase(() => {
    const want = statuses(resolveFieldsFromFiles(FIELDS, {}).results)
    for (const opts of [
      undefined,
      { profileFile: undefined, answersFile: undefined },
      { profileFile: "", answersFile: "" },
      { profileFile: "   ", answersFile: "   " },
    ]) {
      assert.deepEqual(
        statuses(resolveFieldsFromFiles(FIELDS, opts).results),
        want,
        JSON.stringify(opts),
      )
    }
  })
})

test("QA-0.12-1: the real call path — fill-plan's resolveFields with no flags", () => {
  // This is the shape that was actually live: fill-plan.mjs's `flag()` returns
  // null for an absent flag, and automatability.mjs writes the null out
  // explicitly (`typeof profileFlag === "string" ? profileFlag : null`). The
  // tier classifier has therefore been reading an empty fact base, which is a
  // very plausible part of why green was never reachable.
  withFactBase(() => {
    const withNulls = resolveFields(FIELDS, { profile: null, answers: null })
    const withNothing = resolveFields(FIELDS)
    assert.deepEqual(statuses(withNulls), statuses(withNothing))
    assert.equal(statuses(withNulls).f1, "OK:jane@example.com")
    assert.equal(
      withNulls.filter((r) => r.status === "UNKNOWN").length,
      0,
      "nothing should be UNKNOWN against a fact base that answers all three",
    )
  })
})

test("BOUNDARY: a path that IS given and does not exist still yields an empty fact base", () => {
  // The other direction, and it must keep working: "this fixture has no bank"
  // is a real answer to a real question, and most of the suite depends on it.
  // The fix distinguishes "no path given" from "a path that points nowhere";
  // it does not make a missing file an error.
  const results = resolveFieldsFromFiles(FIELDS, {
    profileFile: path.join(os.tmpdir(), "aj-nope-4c1a", "profile.yaml"),
    answersFile: path.join(os.tmpdir(), "aj-nope-4c1a", "answers.yaml"),
  }).results
  for (const r of results) assert.equal(r.status, "UNKNOWN", r.k)
})

test("BOUNDARY: a non-string path is treated as 'not specified', not coerced to a filename", () => {
  // 0, false and {} are all falsy-or-odd shapes a caller could produce from a
  // bad flag parse. None of them may become a path, and none may become "no
  // fact base" either.
  withFactBase(() => {
    const want = statuses(resolveFieldsFromFiles(FIELDS, {}).results)
    for (const bad of [0, false, {}, []]) {
      assert.deepEqual(
        statuses(
          resolveFieldsFromFiles(FIELDS, {
            profileFile: bad,
            answersFile: bad,
          }).results,
        ),
        want,
        String(bad),
      )
    }
  })
})
