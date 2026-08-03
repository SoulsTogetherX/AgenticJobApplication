// §4.11 invariant 1: `.click(` appears in scripts/auto/ ONLY in submit.mjs and
// advance.mjs — ASSERTED BY A TEST, NOT BY A HABIT.
//
// This is the whole reason the click surface stays reviewable. "Never click
// submit" as a convention is a thing every future author has to be told; as a
// test it is a thing the suite tells them. The plan says it in exactly those
// words and this file is the discharge.
//
// WHY A SOURCE GREP HERE, when this project's own lesson is to prefer
// behavioural assertions (three source-grep tests broke on wording while the
// behaviour was fine): because the property under test IS a property of the
// source. "No other file contains a click" cannot be observed by running
// anything — a file that never gets called still contains the click, and the
// day somebody calls it is the day it matters. The behavioural half is the
// second test below, which asserts advance.mjs REFUSES rather than merely
// lacks.
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const AUTO_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "scripts",
  "auto",
)

/** Files permitted to contain a click, and what each may click. */
const PERMITTED = new Map([
  ["submit.mjs", "the one submit"],
  ["advance.mjs", "a control whose scanned role is `next`, never `submit`"],
])

// A comment mentioning a click is not a click. Matching `.click(` rather than
// the word is what keeps this test from failing on prose — every file in
// scripts/auto/ discusses clicking at length, on purpose.
const CLICK = /\.click\s*\(/

function autoFiles() {
  return fs
    .readdirSync(AUTO_DIR)
    .filter((f) => f.endsWith(".mjs"))
    .sort()
}

test("only submit.mjs and advance.mjs contain a click", () => {
  const offenders = []
  for (const file of autoFiles()) {
    const src = fs.readFileSync(path.join(AUTO_DIR, file), "utf8")
    // Strip line comments before matching, so a future author quoting
    // `locator.click()` in an explanation does not fail the suite and then get
    // the suite loosened to accommodate them.
    const code = src
      .split("\n")
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join("\n")
    if (CLICK.test(code) && !PERMITTED.has(file)) offenders.push(file)
  }
  assert.deepEqual(
    offenders,
    [],
    `these files under scripts/auto/ contain a click and are not permitted to: ` +
      `${offenders.join(", ")}. The click surface is exactly ` +
      `${[...PERMITTED.keys()].join(" and ")} (§4.10, §4.11).`,
  )
})

test("submit.mjs contains exactly one click, and it is the submit", () => {
  const src = fs.readFileSync(path.join(AUTO_DIR, "submit.mjs"), "utf8")
  const code = src
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join("\n")
  const hits = code.match(/\.click\s*\(/g) ?? []
  assert.equal(
    hits.length,
    1,
    `submit.mjs holds ${hits.length} clicks. One function, one click — a second ` +
      `one is a second place an irreversible act can be issued from.`,
  )
})

// advance.mjs is Phase 5 W3 and does not exist yet. The test is written now
// rather than later, and it SKIPS rather than passing silently: a test that
// quietly passes on a missing file is how "advance.mjs refuses submit controls"
// becomes a sentence nobody ever checked.
test("advance.mjs, when it exists, refuses a submit-role control", async (t) => {
  const file = path.join(AUTO_DIR, "advance.mjs")
  if (!fs.existsSync(file)) {
    t.skip(
      "advance.mjs is Phase 5 W3 (§4.2c) and is not built — this assertion is " +
        "outstanding, not satisfied",
    )
    return
  }
  const mod = await import(`file://${file.replace(/\\/g, "/")}`)
  assert.equal(
    typeof mod.advanceOnce,
    "function",
    "advance.mjs must export advanceOnce()",
  )
  const scan = { buttons: [{ k: "b1", l: "Submit application", r: "submit" }] }
  await assert.rejects(
    () =>
      mod.advanceOnce(
        { locator: () => ({ click: async () => assert.fail("it clicked") }) },
        { scan },
      ),
    /submit|next/i,
    "advanceOnce must refuse a control whose scanned role is 'submit'",
  )
})
