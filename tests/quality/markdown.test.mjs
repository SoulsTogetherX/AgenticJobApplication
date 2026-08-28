// Gate #17: markdownlint over the documentation.
//
// The corpus and the rule set live in .markdownlint-cli2.jsonc — read its
// header for the tuning record and the measured counts. This file runs the
// tool and, separately, asserts that the config still has the shape the tuning
// argued for. Both halves are needed: a config that quietly turned off
// MD001 and MD056 would make the first test pass forever.
//
// The tool is invoked with NO arguments so the corpus has exactly one
// definition. `npm run lint`'s CI job does the same.
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { BIN, ROOT, runBin } from "./helpers/bins.mjs"

const CONFIG = path.join(ROOT, ".markdownlint-cli2.jsonc")

// Rules the tuning deliberately KEPT, chosen because each one has caught a
// real defect in this repo or guards the document structure agents navigate
// by. Turning one off to clear a failure is the move this test exists to
// prevent — the config's header records what each disabled rule cost.
const MUST_STAY_ON = [
  "MD001", // heading-increment: the heading tree is how docs are navigated
  "MD029", // ol-prefix
  "MD031", // blanks-around-fences: a fence that does not open is silent
  "MD038", // no-space-in-code
  "MD051", // link-fragments: caught a stale pre-re-layout anchor
  "MD056", // table-column-count: caught 6 rows losing text to a bare `|`
]

const EXPECTED_GLOBS = [
  "docs/**/*.md",
  "*.md",
  "src/**/*.md",
  "tools/**/*.md",
  "scripts/**/*.md",
  "!docs/plans/**",
  "!docs/measurements.md",
  "!docs/roster-log.md",
]

/** JSONC -> JSON. Only // line comments are used in this file. */
function readConfig() {
  const raw = fs.readFileSync(CONFIG, "utf8")
  const stripped = raw
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("//"))
    .join("\n")
    // Trailing commas: prettier adds them to .jsonc and JSON.parse rejects them.
    .replace(/,(\s*[}\]])/g, "$1")
  return JSON.parse(stripped)
}

test("markdownlint-cli2 passes over the documentation corpus", () => {
  const res = runBin(BIN.markdownlint, [])
  assert.equal(
    res.status,
    0,
    `markdownlint found issues:\n${res.stdout}\n${res.stderr}\n\n` +
      `Fix the markdown. Disabling the rule is a last resort and needs a line ` +
      `in .markdownlint-cli2.jsonc's tuning record saying what it cost — the ` +
      `two rules already disabled for conflict (MD030, MD049) lose to prettier ` +
      `by an argument written down there, not by convenience.`,
  )
  // Non-vacuous: markdownlint-cli2 exits 0 for a glob that matched nothing,
  // which is the same failure shape `node --test` has on an empty run.
  const m = res.stdout.match(/Linting:\s+(\d+)\s+files?/)
  assert.ok(m, `no "Linting: N files" line in the output:\n${res.stdout}`)
  assert.ok(
    Number(m[1]) >= 45,
    `only ${m[1]} files were linted (47 as of 2026-08-27: the docs tree, the ` +
      `root markdown, and the twelve per-domain README.md files under src/, ` +
      `tools/ci/ and scripts/). A glob that stopped matching exits 0 and reads ` +
      `as "the docs are clean".`,
  )
})

test("the markdownlint config still pins the corpus and the structural rules", () => {
  const cfg = readConfig()
  assert.deepEqual(
    cfg.globs,
    EXPECTED_GLOBS,
    `the linted corpus changed. docs/plans/**, docs/measurements.md and ` +
      `docs/roster-log.md are dated archives and stay excluded; anything else ` +
      `being excluded means a document stopped being checked.`,
  )
  const off = Object.entries(cfg.config ?? {})
    .filter(([, v]) => v === false)
    .map(([k]) => k)
  const wronglyOff = MUST_STAY_ON.filter((id) => off.includes(id))
  assert.deepEqual(
    wronglyOff,
    [],
    `these rules were disabled: ${wronglyOff.join(", ")}. They are the ones ` +
      `that found real defects (MD051 a stale anchor, MD056 six truncated ` +
      `table rows) or that guard the heading tree agents navigate by. ` +
      `"Tune, don't gut" was the instruction, and this is where gutting shows.`,
  )
})
