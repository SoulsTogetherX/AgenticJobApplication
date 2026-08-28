// Regression tests for the polarity guard in answer-bank.mjs.
//
// The bug: "Are you authorized to work in the U.S. without company
// sponsorship?" fuzzy-matched into the sponsorship concept bucket (it names
// "sponsorship", so CONCEPTS classifies it as a sponsorship question before
// work_authorization ever gets a look-in) and copied the sponsorship-refusal
// answer ("No") straight onto the field. But the form's real subject is work
// authorization — "without sponsorship" is a negated qualifier, not the
// question's topic — so the truthful answer is Yes, and the fuzzy match
// silently flipped it. It reported OK, not deferred, so a form that treats
// this as an ordinary field would have submitted the opposite of the truth on
// the single highest-stakes field on the application.
//
// These fixtures deliberately have NO exact entry for the negated phrasing,
// so every case here exercises the fuzzy `bestAnswer` path the bug lives in —
// never the exact-question lookup, which already short-circuits it correctly
// (pinned by the last test below, using a fixture that DOES carry the exact
// entry).
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

function resolveAll(fields, answersFixture) {
  const res = spawnSync(
    process.execPath,
    [
      path.join(ROOT, "src", "apply", "answer-bank.mjs"),
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

const YESNO = ["Yes", "No"]

// answers-bank.yaml (shared fixture) holds, among others:
//   a-002 "Are you legally authorized to work in the United States?" -> Yes
//   a-003 "Will you now or in the future require sponsorship for employment
//          visa status?" -> No
// Same shape as the real profile's a-005/a-006 pair from the bug report.

test("success case: same-polarity fuzzy match still auto-resolves OK", () => {
  // No negation on either side of the match — the fix must not make the
  // guard defer everything that merely shares a concept.
  const r = resolveAll(
    [
      {
        k: "a",
        t: "radio",
        l: "Do you need sponsorship to work in the United States?",
        opts: YESNO,
        req: true,
      },
    ],
    "answers-bank.yaml",
  )
  assert.equal(r.get("a").status, "OK")
  assert.equal(r.get("a").value, "No")
})

test("failure case: a negated phrasing defers instead of copying the opposite-polarity answer", () => {
  // This is the exact repro from the bug report (minus the now-saved exact
  // entry, which would mask it — see the trailing exact-match test).
  const r = resolveAll(
    [
      {
        k: "b3",
        t: "radio",
        l: "Are you authorized to work in the U.S. without company sponsorship?",
        opts: YESNO,
        req: true,
      },
    ],
    "answers-bank.yaml",
  )
  const f = r.get("b3")
  assert.equal(
    f.status,
    "NEEDS-CHOICE",
    "must defer, not silently answer No to a work-authorization question",
  )
  assert.notEqual(f.value, "No", "must never assert the opposite of the truth")
  // The stored sponsorship fact is still surfaced so a human can resolve this
  // fast, just not trusted as the literal value.
  assert.match(f.note, /polarity/i)
  assert.match(f.note, /options: Yes \| No/)
})

test("failure case: other negation markers ('unable', 'not', 'never') also defer, not just 'without'", () => {
  const r = resolveAll(
    [
      {
        k: "a",
        t: "radio",
        l: "Are you unable to work in the United States without sponsorship from an employer?",
        opts: YESNO,
        req: true,
      },
      {
        k: "b",
        t: "radio",
        l: "Is it true that you are not authorized to work in the U.S. without company sponsorship?",
        opts: YESNO,
        req: true,
      },
    ],
    "answers-bank.yaml",
  )
  for (const k of ["a", "b"]) {
    assert.notEqual(r.get(k).status, "OK", k)
    assert.notEqual(r.get(k).value, "No", k)
  }
})

test("boundary case: a double negative defers rather than risk a clever re-invert", () => {
  // "Unable ... without" carries two negation markers. Auto-inverting was
  // rejected specifically because a double negative flips back, and getting
  // THAT subtly wrong is no safer than the original bug — so this must land
  // on the same safe default as a single negation, not attempt cleverness.
  const r = resolveAll(
    [
      {
        k: "a",
        t: "radio",
        l: "Are you unable to work in the U.S. without company sponsorship?",
        opts: YESNO,
        req: true,
      },
    ],
    "answers-bank.yaml",
  )
  assert.equal(r.get("a").status, "NEEDS-CHOICE")
})

test("the exact-label match path still wins over the polarity guard", () => {
  // Once the user has approved this EXACT phrasing once (answers-polarity-
  // exact.yaml mirrors the real a-045 fix-up from the bug report), it must
  // keep resolving OK on every later application — the guard must not
  // second-guess an exact match, only the fuzzy tier below it.
  const r = resolveAll(
    [
      {
        k: "b3",
        t: "radio",
        l: "Are you authorized to work in the U.S. without company sponsorship?",
        opts: YESNO,
        req: true,
      },
    ],
    "answers-polarity-exact.yaml",
  )
  const f = r.get("b3")
  assert.equal(f.status, "OK")
  assert.equal(f.value, "Yes")
  assert.match(f.source, /^a-101@exact/)
})
