// Gate #2-#7: ESLint 10 over the repo, with the ratchet frozen in
// eslint-suppressions.json.
//
// THE SECOND TEST IN THIS FILE IS THE POINT. A lint gate nobody has watched
// fail is not a gate — `eslint .` exits 0 for a config that matched no files,
// for a plugin that failed to load its rules, and for a `files` glob that
// stopped matching after a directory rename. The canary lints a file that
// MUST be rejected and fails the build if it is not, which is the same
// argument test-gate.mjs makes about `node --test` exiting 0 on an empty run.
//
// It goes through --stdin with a virtual filename rather than writing a file
// into the tree. Two reasons: nothing can be left behind by a crash, and a
// real file would race the `prettier --check .` in format.test.mjs. The
// virtual name is under tests/, so it resolves the SAME project config the
// repo run uses — the canary proves the shipped rules can fail, not that some
// throwaway config can.
//
// WHY --pass-on-unpruned-suppressions: fixing a suppressed violation must
// never redden the build. Pruning is a deliberate maintenance act
// (`--prune-suppressions`), run by a human who then commits the smaller file.
// The inverse — a NEW violation of a suppressed rule in a file that already
// has suppressions — is still reported, because suppressions are counted per
// file per rule, not blanket-disabled.
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { BIN, ROOT, runBin } from "./helpers/bins.mjs"

const SUPPRESSIONS = path.join(ROOT, "eslint-suppressions.json")

// Rules whose presence in the baseline would mean something is genuinely
// BROKEN rather than merely oversized. A parse error means a file does not
// compile; an unresolved import means a module specifier points at nothing.
// Neither is debt to be frozen — both were fixed for real before the baseline
// was written, and this test is what keeps them out of it.
const NEVER_SUPPRESS = [
  "import-x/no-unresolved",
  "n/no-missing-import",
  "no-undef",
  "no-obj-calls",
  "no-const-assign",
  "no-dupe-keys",
  "no-dupe-args",
  "no-unsafe-negation",
]

test("eslint passes over the repo with the committed suppressions", () => {
  const res = runBin(BIN.eslint, [".", "--pass-on-unpruned-suppressions"])
  assert.equal(
    res.status,
    0,
    `eslint reported a violation that the committed baseline does not cover.\n` +
      `Fix the code. Do NOT re-run --suppress-all to bury it: that widens the\n` +
      `ratchet, and the ratchet is only ever allowed to shrink.\n\n` +
      `${res.stdout}\n${res.stderr}`,
  )
})

test("the lint gate can go red — the shipped config rejects a violating file", () => {
  // no-undef + no-unused-vars, both from eslint:recommended, both at error.
  // Written prettier-clean (no semicolon) so nothing about it is ambiguous.
  const violating =
    "var unusedCanaryValue = someGlobalThatIsNotDefinedAnywhere\n"
  const res = spawnSync(
    process.execPath,
    [
      BIN.eslint,
      "--stdin",
      "--stdin-filename",
      "tests/quality/lint-canary.mjs",
      "--no-ignore",
    ],
    {
      cwd: ROOT,
      input: violating,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    },
  )
  assert.equal(
    res.status,
    1,
    `eslint exited ${res.status} on a file with an undefined variable AND an\n` +
      `unused one. A lint gate that cannot go red is decoration: the likely\n` +
      `causes are a "files" glob in eslint.config.mjs that no longer matches\n` +
      `tests/, a plugin that failed to load, or eslint:recommended having been\n` +
      `dropped.\n\n${res.stdout}\n${res.stderr}`,
  )
  assert.match(res.stdout, /no-undef/, "expected no-undef to be reported")
  assert.match(
    res.stdout,
    /no-unused-vars/,
    "expected no-unused-vars to be reported",
  )
})

test("eslint-suppressions.json is committed and parses", () => {
  assert.ok(
    fs.existsSync(SUPPRESSIONS),
    `eslint-suppressions.json is missing. Without it the ratchet has no\n` +
      `baseline and the first test in this file would fail on the several\n` +
      `hundred pre-existing, frozen\n` +
      `violations. Regenerate with:\n` +
      `  node node_modules/eslint/bin/eslint.js . --suppress-all`,
  )
  const parsed = JSON.parse(fs.readFileSync(SUPPRESSIONS, "utf8"))
  assert.equal(typeof parsed, "object")
  assert.ok(
    Object.keys(parsed).length > 0,
    "an empty suppressions file means the baseline was lost, not that the debt was paid",
  )
})

test("no parse failure or unresolved import is hidden in the suppressions baseline", () => {
  const parsed = JSON.parse(fs.readFileSync(SUPPRESSIONS, "utf8"))
  const found = []
  for (const [file, rules] of Object.entries(parsed)) {
    for (const rule of Object.keys(rules)) {
      if (NEVER_SUPPRESS.includes(rule)) found.push(`${file}  ${rule}`)
    }
  }
  assert.deepEqual(
    found,
    [],
    `These rules must never be suppressed — each one means something is\n` +
      `BROKEN, not merely oversized: an import that points at nothing, or a\n` +
      `name that does not exist at runtime. Fix the code, or (for a genuine\n` +
      `page-side global) add the name to PAGE_SIDE_FILES/DOM_GLOBALS in\n` +
      `eslint.config.mjs.\n  ${found.join("\n  ")}`,
  )
})
