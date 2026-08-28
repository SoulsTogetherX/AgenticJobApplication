// Gate #15: deep-relative import specifiers, ratcheted.
//
// `../../` in a module specifier is the shape that makes a directory move
// expensive: it encodes not just where a file is, but how far up the tree the
// reader has to climb, so every one of them is a place a future re-layout
// breaks. The repo has a `#lib/*` subpath import for exactly this reason.
//
// This is a RATCHET, not a ban. The number may only go down.
//
// SCOPE: src/**/*.mjs plus the two carved-out scripts/profile/*.mjs. Tests are
// deliberately excluded — tests/<domain>/x.test.mjs reaching ../../src is the
// mirror working as designed, and counting it would ratchet the wrong thing.
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { ROOT, gitAvailable, trackedFiles } from "./helpers/bins.mjs"

// Measured 2026-08-27 over the post-re-layout tree. MAY ONLY GO DOWN.
// The two sites, both the same shape — a benchmark in src/dev reaching into
// the loopback fixture board that tests/ owns:
//   src/dev/bench-apply.mjs   ../../tests/fixtures/boards/server.mjs
//   src/dev/bench-runner.mjs  ../../tests/fixtures/boards/server.mjs
//
// NOT counted, and worth knowing so nobody thinks it was missed:
// src/hooks/prettify.mjs line 13 builds `new URL("../../node_modules/...")`.
// That is a runtime path, not a module specifier — it never goes through the
// resolver — so it is outside this rule's definition. It is still fragile, and
// still deliberate: the hook must not import prettier as a dependency.
const BASELINE = 2

// import x from "..", export {x} from "..", import("..").
// A `from` clause can sit many lines below its `import` keyword in this
// codebase (long destructuring lists), so the gap is matched loosely — but
// with [^"'], never [\s\S]. That bound is load-bearing: with [\s\S] the
// static branch swallows a `await import("../../y.mjs")` and runs on to the
// `from` of the NEXT statement, so a dynamic import reads as absent. Measured
// while writing this file; the non-vacuity test below is what caught it.
// The third branch is the side-effect form: `import "../../x.mjs"` has no
// `from` clause and is not `import(`, so the first two branches are blind to
// it — QA-2 (2026-08-27) walked one straight past this gate.
const SPECIFIER_RE =
  /(?:^|[\s;}])(?:import|export)\b[^"']{0,400}?\bfrom\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']|(?:^|[\s;}])import\s*["']([^"']+)["']/g

function specifiersIn(text) {
  const out = []
  for (const m of text.matchAll(SPECIFIER_RE)) out.push(m[1] ?? m[2] ?? m[3])
  return out
}

function sources() {
  return trackedFiles("src", "scripts/profile").filter((f) =>
    f.endsWith(".mjs"),
  )
}

function deepRelative() {
  const hits = []
  for (const rel of sources()) {
    const text = fs.readFileSync(path.join(ROOT, rel), "utf8")
    for (const spec of specifiersIn(text)) {
      if (spec.startsWith("../../")) hits.push(`${rel} :: ${spec}`)
    }
  }
  return hits.sort()
}

test("deep-relative import specifiers stay at or below the frozen baseline", (t) => {
  if (!gitAvailable()) return t.skip("git is not on PATH")
  const hits = deepRelative()
  assert.ok(
    hits.length <= BASELINE,
    `${hits.length} deep-relative specifiers, baseline is ${BASELINE}:\n  ` +
      `${hits.join("\n  ")}\n` +
      `Use the "#lib/*" subpath import, or move the module. Raising BASELINE ` +
      `is not an option — the whole value of this number is that it only ` +
      `travels one way.`,
  )
})

test("the deep-relative counter can actually see a specifier", (t) => {
  if (!gitAvailable()) return t.skip("git is not on PATH")
  // Non-vacuity, the same argument test-gate.mjs makes about an empty run:
  // a broken regex would report 0 and read as "we fixed them all".
  const parsed = specifiersIn(
    [
      'import { start } from "../../tests/fixtures/boards/server.mjs"',
      'export { a } from "../../x.mjs"',
      'const m = await import("../../y.mjs")',
      'import "../../side-effect.mjs"',
      'import fs from "node:fs"',
      'import { loadYamlFile } from "#lib/lib.mjs"',
    ].join("\n"),
  )
  assert.deepEqual(parsed, [
    "../../tests/fixtures/boards/server.mjs",
    "../../x.mjs",
    "../../y.mjs",
    "../../side-effect.mjs",
    "node:fs",
    "#lib/lib.mjs",
  ])
  assert.ok(
    sources().length > 50,
    `only ${sources().length} source modules were scanned; the file list is broken`,
  )
})
