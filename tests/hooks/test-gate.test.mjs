// Tests for the CI test gate (.github/workflows/test-gate.mjs).
//
// The gate's entire job is to make a green run mean something, so the property
// under test is "it can fail". Every case here drives it to a verdict from a
// real `node --test` run over a throwaway fixture — no mocking of the runner,
// because the failure being guarded against (an empty run reporting success)
// lives in the runner's exit code, not in a wrapper.
//
// This file lives in tests/hooks/ because ci-engineer owns tests/hooks/ and
// the pipeline; it is not a hook.
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
)
const GATE = path.join(ROOT, ".github", "workflows", "test-gate.mjs")

function fixture(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-fixture-"))
  for (const [name, body] of Object.entries(files)) {
    fs.mkdirSync(path.join(dir, path.dirname(name)), { recursive: true })
    fs.writeFileSync(path.join(dir, name), body)
  }
  return dir
}

function runGate(args, cwd) {
  // --cwd is what the gate resolves required dirs and test paths against; the
  // spawn cwd alone would leave it pointed at the real repo.
  const scoped = cwd ? ["--cwd", cwd] : []
  const res = spawnSync(
    process.execPath,
    [GATE, "--quiet", ...scoped, ...args],
    {
      cwd: cwd ?? ROOT,
      encoding: "utf8",
      timeout: 60_000,
    },
  )
  return { status: res.status, out: res.stdout + res.stderr }
}

const PASSING = `import test from "node:test"
test("one", () => {})
test("two", () => {})
test("three", () => {})
`

// The headline case. `node --test` exits 0 when it runs zero tests, so a
// pipeline that only checks the exit code reports success for a suite that
// was deleted, renamed out of discovery, or never written.
test("a run that executed ZERO tests fails the gate", (t) => {
  const dir = fixture({ "readme.md": "no tests live here\n" })
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))

  // NODE_TEST_CONTEXT is set on this process by the outer runner; a nested
  // `node --test` that inherits it switches to the internal reporter and
  // prints nothing. Same trap the gate itself has to avoid.
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  const bare = spawnSync(process.execPath, ["--test"], {
    cwd: dir,
    env,
    encoding: "utf8",
  })
  assert.equal(bare.status, 0, "premise: node --test exits 0 on an empty run")
  assert.match(bare.stdout, /tests 0/, "premise: it ran nothing and said so")

  const { status, out } = runGate(["--floor", "1"], dir)
  assert.equal(status, 1)
  assert.match(out, /only 0 tests ran, floor is 1/)
})

// A near miss worth pinning: a test FILE that declares no tests is reported as
// one PASSING test (the file). So "every test in the suite was deleted but the
// files remain" shows up as N passing tests, not as zero — only the floor
// catches it.
test("a test file with no tests in it counts as one passing test, so only the floor catches gutting", (t) => {
  const dir = fixture({
    "suite/a.test.mjs": "// every test in here was deleted\n",
    "suite/b.test.mjs": "// and here\n",
  })
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))

  const green = runGate(["--floor", "2", "--path", "suite/"], dir)
  assert.equal(green.status, 0, green.out)
  assert.match(green.out, /tests {7}2/)

  const { status, out } = runGate(["--floor", "50", "--path", "suite/"], dir)
  assert.equal(status, 1)
  assert.match(out, /only 2 tests ran, floor is 50/)
})

test("a run that meets the floor passes", (t) => {
  const dir = fixture({ "suite/a.test.mjs": PASSING })
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))

  const { status, out } = runGate(["--floor", "3", "--path", "suite/"], dir)
  assert.equal(status, 0, out)
  assert.match(out, /test-gate: test-gate — PASS/)
  assert.match(out, /tests {7}3 {3}\(floor 3\)/)
})

test("deleting tests fails the gate even though the runner is green", (t) => {
  const dir = fixture({ "suite/a.test.mjs": PASSING })
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))

  assert.equal(runGate(["--floor", "3", "--path", "suite/"], dir).status, 0)

  fs.writeFileSync(
    path.join(dir, "suite/a.test.mjs"),
    `import test from "node:test"\ntest("one", () => {})\n`,
  )
  const { status, out } = runGate(["--floor", "3", "--path", "suite/"], dir)
  assert.equal(status, 1)
  assert.match(out, /only 1 tests ran, floor is 3/)
})

test("a failing test fails the gate", (t) => {
  const dir = fixture({
    "suite/a.test.mjs": `import test from "node:test"
import assert from "node:assert/strict"
test("one", () => {})
test("two", () => assert.equal(1, 2))
test("three", () => {})
`,
  })
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))

  const { status, out } = runGate(["--floor", "3", "--path", "suite/"], dir)
  assert.equal(status, 1)
  assert.match(out, /1 test\(s\) FAILED/)
})

// The whole point of the known-red split: it is REPORTING, never tolerance.
// If this test ever passes with status 0, the gate has started hiding
// failures and is worthless.
test("a failure named FINDING (<owner>) still fails the build", (t) => {
  const dir = fixture({
    "suite/a.test.mjs": `import test from "node:test"
import assert from "node:assert/strict"
test("one", () => {})
test("two", () => {})
test("FINDING (w3-resolution): a reworded consent box is not recognised", () =>
  assert.equal(1, 2))
`,
  })
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))

  const { status, out } = runGate(["--floor", "3", "--path", "suite/"], dir)
  assert.equal(status, 1, "an owned, expected failure is still a failure")
  assert.match(
    out,
    /all 1 are named FINDING with an owner — still a failing build/,
  )
  assert.match(out, /known-red, named and owned \(1\)/)
  assert.match(out, /\[w3-resolution\] FINDING \(w3-resolution\)/)
})

test("an unowned failure is reported separately and first", (t) => {
  const dir = fixture({
    "suite/a.test.mjs": `import test from "node:test"
import assert from "node:assert/strict"
test("one", () => {})
test("FINDING (w3-resolution): known and owned", () => assert.equal(1, 2))
test("a regression nobody expected", () => assert.equal(1, 2))
`,
  })
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))

  const { status, out } = runGate(["--floor", "3", "--path", "suite/"], dir)
  assert.equal(status, 1)
  assert.match(out, /2 test\(s\) FAILED — 1 UNEXPECTED, 1 named FINDING/)
  assert.match(out, /UNEXPECTED failures \(1\)/)
  assert.match(out, /a regression nobody expected/)
  // Unexpected must be printed above the known-red block.
  assert.ok(
    out.indexOf("UNEXPECTED failures") < out.indexOf("known-red, named"),
    "a new failure must not be buried under the known-red list",
  )
})

// A skip is legitimate — ubuntu runners have no Edge/Chrome, so the PDF tests
// cannot run there — but it must say why, or it is indistinguishable from a
// test that silently stopped running.
test("a skip WITH a reason passes and is reported by name", (t) => {
  const dir = fixture({
    "suite/a.test.mjs": `import test from "node:test"
test("one", () => {})
test("two", () => {})
test("browser bound", (t) => t.skip("no Edge/Chrome on this machine"))
`,
  })
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))

  const { status, out } = runGate(["--floor", "3", "--path", "suite/"], dir)
  assert.equal(status, 0, out)
  assert.match(out, /skipped {5}1/)
  assert.match(out, /\[SKIP\] browser bound — no Edge\/Chrome on this machine/)
})

test("a skip WITHOUT a reason fails the gate", (t) => {
  const dir = fixture({
    "suite/a.test.mjs": `import test from "node:test"
test("one", () => {})
test("two", () => {})
test("silent", (t) => t.skip())
`,
  })
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))

  const { status, out } = runGate(["--floor", "3", "--path", "suite/"], dir)
  assert.equal(status, 1)
  assert.match(out, /SKIP without a reason: "silent"/)
})

// Converting a failing test to `todo` is the cheapest way to fake green.
test("a todo test fails the gate at the default cap of zero", (t) => {
  const dir = fixture({
    "suite/a.test.mjs": `import test from "node:test"
test("one", () => {})
test("two", () => {})
test("later", { todo: "will fix" }, () => {})
`,
  })
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))

  const { status, out } = runGate(["--floor", "3", "--path", "suite/"], dir)
  assert.equal(status, 1)
  assert.match(out, /1 test\(s\) marked todo, cap is 0/)
})

// This is what stops the Phase 1 security gate being "green" by being absent.
test("a required directory that does not exist fails before anything runs", (t) => {
  const dir = fixture({ "suite/a.test.mjs": PASSING })
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))

  const { status, out } = runGate(
    ["--floor", "3", "--path", "suite/", "--require-dir", "tests/security"],
    dir,
  )
  assert.equal(status, 1)
  assert.match(out, /required test directory "tests\/security" does not exist/)
  assert.match(out, /A missing suite is a FAILURE, not a pass/)
})

test("a required directory with no test files in it fails too", (t) => {
  const dir = fixture({
    "suite/a.test.mjs": PASSING,
    "tests/security/README.md": "# coming soon\n",
  })
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))

  const { status, out } = runGate(
    ["--floor", "3", "--path", "suite/", "--require-dir", "tests/security"],
    dir,
  )
  assert.equal(status, 1)
  assert.match(out, /contains no \*\.test\.mjs files/)
})

test("a required directory holding real tests satisfies the check", (t) => {
  const dir = fixture({
    "tests/security/a.test.mjs": PASSING,
  })
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))

  const { status, out } = runGate(
    [
      "--floor",
      "3",
      "--path",
      "tests/security/",
      "--require-dir",
      "tests/security",
    ],
    dir,
  )
  assert.equal(status, 0, out)
})

// Node 20/22 recurse into a directory passed to `node --test`; Node 24 tries
// to load it as a module, fails with "Cannot find module", and reports that as
// one failing test — so the plan's Phase 1 command runs NONE of tests/security
// on Node 24 while looking like an ordinary red. The gate expands directories
// itself so every Node version runs the same files.
test("a directory path is expanded to its test files, not handed to node raw", (t) => {
  const dir = fixture({
    "suite/a.test.mjs": PASSING,
    "suite/nested/b.test.mjs": PASSING,
    "suite/helper.mjs": "export const x = 1\n", // not a test file
  })
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))

  const { status, out } = runGate(["--floor", "6", "--path", "suite/"], dir)
  assert.equal(status, 0, out)
  assert.match(out, /files {7}2 test file\(s\) after expansion/)
  assert.match(out, /tests {7}6/)
  assert.ok(
    !out.includes("Cannot find module"),
    "the directory itself must never be loaded as a module",
  )
})

test("a configured test path that does not exist fails the gate", (t) => {
  const dir = fixture({ "suite/a.test.mjs": PASSING })
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))

  const { status, out } = runGate(
    ["--floor", "3", "--path", "suite/", "--path", "gone/"],
    dir,
  )
  assert.equal(status, 1)
  assert.match(out, /test path "gone\/" does not exist/)
})

test("a gate configured with no floor refuses to run", () => {
  const { status, out } = runGate(["--path", "tests/hooks/"])
  assert.equal(status, 1)
  assert.match(out, /no usable floor/)
})

// The gate config is the mechanical form of the plan's Phase 1 command
// (docs/autonomy-plan.md, "Verification"). If someone narrows it, this fails.
test("package.json pins the Phase 1 gate to the plan's exact paths", () => {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(ROOT, "package.json"), "utf8"),
  )
  const sec = pkg.testGate?.security
  assert.ok(sec, "package.json must define testGate.security")
  assert.deepEqual(sec.paths, [
    "tests/security/",
    "tests/lib/untrusted.test.mjs",
    "tests/documents/verify-claims.test.mjs",
  ])
  assert.deepEqual(sec.requireDirs, ["tests/security"])
  // Floors ratchet UP only. Re-measured 2026-07-31 after the merge window for
  // w1-security, ci-engineer, w2-engine and qa-adversary closed:
  // `npm run test:security` reported 147 over 8 files (3 samples) and
  // `npm test` reported 946 (2 samples).
  assert.ok(
    sec.floor >= 147,
    `security floor must not be lowered (${sec.floor})`,
  )
  assert.equal(sec.maxTodo, 0)

  const full = pkg.testGate?.full
  assert.ok(full, "package.json must define testGate.full")
  assert.ok(full.floor >= 946, `full floor must not be lowered (${full.floor})`)
  assert.equal(full.maxTodo, 0)

  assert.equal(pkg.scripts.test, "node .github/workflows/test-gate.mjs full")
  assert.equal(
    pkg.scripts["test:security"],
    "node .github/workflows/test-gate.mjs security",
  )
  // The 2026-07-29 reorg moved this; `npm run verify` pointed at the old path
  // for two days without anyone noticing, because nothing checked it.
  assert.equal(pkg.scripts.verify, "node scripts/documents/verify-claims.mjs")
  assert.ok(
    fs.existsSync(path.join(ROOT, "scripts", "documents", "verify-claims.mjs")),
    "npm run verify must point at a file that exists",
  )
})

// Every npm script must name a file that exists — the defect the reorg left
// behind, generalised so the next move is caught the same day.
test("every npm run-script points at a file that exists", () => {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(ROOT, "package.json"), "utf8"),
  )
  for (const [name, cmd] of Object.entries(pkg.scripts)) {
    for (const m of cmd.matchAll(
      /(?:^|\s)([\w./-]+\.(?:mjs|js|cjs))(?=\s|$)/g,
    )) {
      assert.ok(
        fs.existsSync(path.join(ROOT, m[1])),
        `npm run ${name} references ${m[1]}, which does not exist`,
      )
    }
  }
})

// The workflow must never buy green by ignoring a failure.
test("the CI workflow contains no failure-swallowing constructs", () => {
  const yml = fs.readFileSync(
    path.join(ROOT, ".github", "workflows", "ci.yml"),
    "utf8",
  )
  // Strip comments: the file explains these constructs by name.
  const code = yml
    .split("\n")
    .filter((l) => !l.trim().startsWith("#"))
    .join("\n")
  for (const bad of ["continue-on-error", "|| true", "exit 0 #", "|| exit 0"]) {
    assert.ok(!code.includes(bad), `ci.yml must not contain "${bad}"`)
  }
  assert.match(code, /workflow_dispatch/, "CI must be triggerable by hand")
  assert.match(code, /npm run test:security/, "the security gate must be wired")
  assert.match(code, /needs: \[security-gate, test\]/)
})
