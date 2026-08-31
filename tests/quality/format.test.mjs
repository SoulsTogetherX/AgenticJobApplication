// Gate #1 (formatting) and #12 (.prettierignore contracts).
//
// The formatting half is one assertion: `prettier --check .` exits 0. The
// research behind the 2026-08-27 conventions plan found that "reformat every
// file" was mostly a mirage here — prettier's output already hashes identical
// to the committed blobs, and the files that looked dirty were stale-CRLF
// checkout drift. So the durable value is not a sweep, it is this standing
// check: drift is caught the day it lands instead of a month later.
//
// The .prettierignore half exists because every entry in that file is a
// CONTRACT with something that would break if prettier touched the file, and
// each one was written after the breakage. An entry silently deleted looks
// like tidying and costs a real defect:
//
//   scan.driver.mjs / scan-page.js  loaded and eval'd as bare function
//                                   expressions; prettier's leading-semicolon
//                                   guard makes them unparseable.
//   docs/job-sources.yaml           manage-sources.mjs edits it LINE BY LINE
//                                   to preserve comments a yaml round-trip
//                                   would delete; that only works while each
//                                   board is one flow-style entry on one line.
//   captures/ + corpus.json         the classifier's evidence corpus. Their
//                                   BYTES are the evidence; reformatting
//                                   rewrites what a rule was justified by.
//   tests/fixtures/hostile/         deliberate attack shapes, byte-precise on
//                                   purpose (hidden text, invisible
//                                   characters, misnested markup).
//   jobs/.auto/                     staged capture candidates awaiting review.
//   .claude/worktrees/              other sessions' checkouts, not this tree.
//   docs/candidates/                machine-written board-candidate exports.
//
// Owned by ci-engineer, like .prettierignore itself.
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { BIN, ROOT, runBin } from "./helpers/bins.mjs"

const IGNORE_FILE = path.join(ROOT, ".prettierignore")

test("prettier --check . passes over the whole repo", () => {
  const res = runBin(BIN.prettier, ["--check", "."])
  assert.equal(
    res.status,
    0,
    `prettier reports formatting drift. Run \`npm run lint:fix\`'s sibling:\n` +
      `  node node_modules/prettier/bin/prettier.cjs --write .\n` +
      `Do NOT add the offending file to .prettierignore to make this green —\n` +
      `every entry there is a contract with something that breaks, and a new\n` +
      `one needs the reason written next to it.\n\n` +
      `${res.stdout}\n${res.stderr}`,
  )
})

// One test per contract entry, so a failure names the ONE line that went
// missing rather than diffing a whole file.
const CONTRACTS = [
  [
    ".claude/skills/apply-job/scan.driver.mjs",
    "eval'd as a bare function expression; prettier's leading-semicolon guard makes it unparseable",
  ],
  [
    "scan-page.js",
    "eval'd as a bare function expression; same leading-semicolon trap as scan.driver.mjs",
  ],
  [
    "docs/job-sources.yaml",
    "manage-sources.mjs edits it line by line to keep the comments a yaml round-trip deletes",
  ],
  [
    "tests/fixtures/post-submit/captures/",
    "the classifier's evidence corpus — the BYTES are the evidence",
  ],
  [
    "tests/fixtures/hostile/",
    "deliberate attack shapes, byte-precise on purpose; formatting defuses them",
  ],
  ["jobs/.auto/", "staged capture candidates awaiting review"],
  [".claude/worktrees/", "other sessions' checkouts, not this tree's files"],
  [
    "tests/fixtures/post-submit/corpus.json",
    "machine-written capture manifest; formatting starts a churn war with capture-post-submit.mjs",
  ],
  [
    "docs/candidates/",
    "machine-written board-candidate exports (cc-boards.mjs) and hand-fed input lists",
  ],
  [
    "eslint-suppressions.json",
    "eslint rewrites it on every --suppress-all/--prune-suppressions in its own formatting; prettier would revert on the next regeneration and red the format gate on a file nobody edited",
  ],
]

for (const [entry, why] of CONTRACTS) {
  test(`.prettierignore still carries the contract entry "${entry}"`, () => {
    const text = fs.readFileSync(IGNORE_FILE, "utf8")
    const lines = text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"))
    assert.ok(
      lines.some((l) => l === entry || l.endsWith(entry)),
      `.prettierignore no longer ignores "${entry}".\n` +
        `Why it is there: ${why}.\n` +
        `Removing it does not "clean up" anything — it lets prettier rewrite\n` +
        `a file whose exact bytes something depends on. Current non-comment\n` +
        `entries:\n  ${lines.join("\n  ")}`,
    )
  })
}
