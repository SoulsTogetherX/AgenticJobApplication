#!/usr/bin/env node
// The test gate: runs `node --test` and asserts what a green run must PROVE.
//
// Why this exists: `node --test` exits 0 when it runs ZERO tests, so the exit
// code alone is worthless as evidence. A pipeline whose only assertion is
// "the runner did not error" reports success for a suite that was deleted,
// a directory that was renamed, or a glob that stopped matching. This gate
// asserts the COUNT, the failure count, and that every skip is attributed.
//
// It fails the build when:
//   - a required test directory is missing or contains no test files
//     (this is what makes an absent tests/security/ a FAILURE, not a pass);
//   - the runner produced no TAP summary (crashed / was killed);
//   - any test failed or was cancelled;
//   - fewer tests ran than the configured floor;
//   - more tests are `todo` than the configured cap — converting a failing
//     test to `todo` is the cheapest way to fake green, so the cap is 0;
//   - any test skipped WITHOUT a reason. A skip is legitimate (ubuntu has no
//     Edge/Chrome, so the PDF tests cannot run there) but it must be explicit,
//     reported and attributed. An unattributed skip is indistinguishable from
//     a test that quietly stopped running.
//
// It never hides a failure: there is no `|| true` path, and every exit is
// either 0 with the counts printed or 1 with the reason printed.
//
// Location note: this lives beside the workflow that calls it because
// `ci-engineer` owns `.github/workflows/*` and `package.json` but not the rest
// of `scripts/`. GitHub Actions only loads `*.yml`/`*.yaml` from this
// directory and ignores everything else, so a `.mjs` here is inert to Actions.
// Moving it to `scripts/ci/` later is a two-line change (package.json + ci.yml).
//
// Usage:
//   node .github/workflows/test-gate.mjs <gate-name>      # config from package.json "testGate"
//   node .github/workflows/test-gate.mjs --floor 10 --path tests/x [--require-dir d] [--quiet]
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, "..", "..")

function die(msg) {
  process.stderr.write(`test-gate: ${msg}\n`)
  process.exit(1)
}

function parseArgs(argv) {
  const o = {
    gate: null,
    floor: null,
    maxTodo: null,
    paths: [],
    requireDirs: [],
    quiet: false,
    cwd: null,
    label: null,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--floor") o.floor = Number(argv[++i])
    else if (a === "--max-todo") o.maxTodo = Number(argv[++i])
    else if (a === "--path") o.paths.push(argv[++i])
    else if (a === "--require-dir") o.requireDirs.push(argv[++i])
    else if (a === "--cwd") o.cwd = argv[++i]
    else if (a === "--label") o.label = argv[++i]
    else if (a === "--quiet") o.quiet = true
    else if (a.startsWith("-")) die(`unknown option ${a}`)
    else o.gate = a
  }
  return o
}

function loadGateConfig(name) {
  const pkgPath = path.join(ROOT, "package.json")
  let pkg
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"))
  } catch (err) {
    die(`cannot read ${pkgPath}: ${err.message}`)
  }
  const gates = pkg.testGate || {}
  const cfg = gates[name]
  if (!cfg) {
    die(
      `no gate named "${name}" in package.json "testGate" (have: ${Object.keys(gates).join(", ") || "none"})`,
    )
  }
  return cfg
}

// Files node's test runner would pick up under a directory. Used twice: to
// prove a required directory is not EMPTY, and to expand directory arguments
// into explicit file lists (see expandPaths).
function findTestFiles(dir) {
  const out = []
  for (const ent of fs
    .readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))) {
    const p = path.join(dir, ent.name)
    if (ent.isDirectory()) out.push(...findTestFiles(p))
    else if (/\.test\.(c|m)?js$/.test(ent.name)) out.push(p)
  }
  return out
}

// `node --test <directory>` is NOT portable across the Node versions this repo
// runs on. Node 20/22 recurse into a directory argument; Node 24 treats it as
// a module path, fails with "Cannot find module .../tests/security", and
// reports that as ONE FAILING TEST — so the plan's Phase 1 command
// (`node --test tests/security/ ...`) runs none of tests/security on Node 24
// while looking like an ordinary red. Deleting the directory argument to
// "fix" that red would produce a green run over zero security tests.
//
// So the gate expands directories itself and hands node explicit files. Same
// behaviour on every version, and the file list is reportable evidence.
function expandPaths(paths, cwd, problems) {
  const files = []
  for (const p of paths) {
    const abs = path.resolve(cwd, p)
    if (!fs.existsSync(abs)) {
      problems.push(
        `test path "${p}" does not exist. A gate cannot pass over paths that are not there.`,
      )
      continue
    }
    if (fs.statSync(abs).isDirectory()) {
      const found = findTestFiles(abs)
      if (found.length === 0) {
        problems.push(
          `test path "${p}" is a directory with no *.test.mjs files in it.`,
        )
      }
      files.push(...found)
    } else {
      files.push(abs)
    }
  }
  return files
}

function tapCount(tap, key) {
  const m = tap.match(new RegExp(`^# ${key} (\\d+(?:\\.\\d+)?)\\s*$`, "m"))
  return m ? Number(m[1]) : null
}

// `ok 3 - name # SKIP reason` / `ok 4 - name # TODO` (nested subtests are
// indented). TAP escapes a literal `#` inside a test name, so an unescaped
// ` # ` is always the directive separator.
const DIRECTIVE_RE =
  /^[ \t]*(?:not )?ok \d+ - (.*?) # (SKIP|TODO)\b[ \t]*(.*)$/gm

function collectDirectives(tap) {
  const out = []
  for (const m of tap.matchAll(DIRECTIVE_RE)) {
    out.push({ name: m[1].trim(), kind: m[2], reason: (m[3] || "").trim() })
  }
  return out
}

const opts = parseArgs(process.argv.slice(2))
const cfg = opts.gate ? loadGateConfig(opts.gate) : {}
const floor = opts.floor ?? cfg.floor
const maxTodo = opts.maxTodo ?? cfg.maxTodo ?? 0
const paths = opts.paths.length ? opts.paths : (cfg.paths ?? [])
const requireDirs = opts.requireDirs.length
  ? opts.requireDirs
  : (cfg.requireDirs ?? [])
const label = opts.label ?? opts.gate ?? "test-gate"
const cwd = opts.cwd ? path.resolve(opts.cwd) : ROOT

if (!Number.isFinite(floor) || floor < 1) {
  die(
    `gate "${label}" has no usable floor (got ${floor}). A gate with no floor cannot prove tests ran.`,
  )
}

const problems = []

// ---- 1. required directories must exist and contain tests -----------------
for (const d of requireDirs) {
  const abs = path.resolve(cwd, d)
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
    problems.push(
      `required test directory "${d}" does not exist. A missing suite is a FAILURE, not a pass — this gate exists so the Phase 1 security tests cannot be "green" by being absent.`,
    )
  } else if (findTestFiles(abs).length === 0) {
    problems.push(
      `required test directory "${d}" exists but contains no *.test.mjs files. An empty suite proves nothing.`,
    )
  }
}

// ---- 1b. resolve the paths to explicit files ------------------------------
// An empty list means "default discovery", which node does recurse correctly.
const files = problems.length === 0 ? expandPaths(paths, cwd, problems) : []

let tap = ""
let child = { status: null }
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "test-gate-"))
const tapFile = path.join(tmpDir, "run.tap")

if (problems.length === 0) {
  // ---- 2. run the suite ---------------------------------------------------
  // Two reporters: `spec` to the console for humans, `tap` to a file for this
  // gate to parse. Node pairs each --test-reporter with the following
  // --test-reporter-destination, in order.
  const args = [
    "--test",
    "--test-reporter=tap",
    `--test-reporter-destination=${tapFile}`,
  ]
  if (!opts.quiet) {
    args.push("--test-reporter=spec", "--test-reporter-destination=stdout")
  }
  args.push(...files)

  // NODE_TEST_CONTEXT must not be inherited. Node sets it on every test-file
  // subprocess, and a `node --test` that sees it switches to the internal
  // v8-serializer reporter and IGNORES --test-reporter — so the TAP file comes
  // out empty and the gate reports "no TAP summary". Observed while writing
  // tests/hooks/test-gate.test.mjs, which runs this gate from inside a test.
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT

  child = spawnSync(process.execPath, args, {
    cwd,
    env,
    stdio: opts.quiet ? ["ignore", "ignore", "pipe"] : "inherit",
  })
  if (child.error)
    problems.push(`could not start the test runner: ${child.error.message}`)
  try {
    tap = fs.readFileSync(tapFile, "utf8")
  } catch {
    tap = ""
  }
}

// ---- 3. the counts --------------------------------------------------------
const counts = {
  tests: tapCount(tap, "tests"),
  pass: tapCount(tap, "pass"),
  fail: tapCount(tap, "fail"),
  cancelled: tapCount(tap, "cancelled"),
  skipped: tapCount(tap, "skipped"),
  todo: tapCount(tap, "todo"),
  duration_ms: tapCount(tap, "duration_ms"),
}
const directives = collectDirectives(tap)

if (problems.length === 0) {
  if (counts.tests === null) {
    problems.push(
      `the runner produced no TAP summary (exit code ${child.status}). A run that did not report its counts is not evidence that anything ran.`,
    )
  } else {
    if (counts.fail > 0) problems.push(`${counts.fail} test(s) FAILED`)
    if (counts.cancelled > 0)
      problems.push(
        `${counts.cancelled} test(s) were CANCELLED (timeout or crash)`,
      )
    if (counts.tests < floor) {
      problems.push(
        `only ${counts.tests} tests ran, floor is ${floor}. Either tests were deleted/renamed out of discovery, or the floor in package.json "testGate" is stale. node --test exits 0 on an empty run, which is why this is checked.`,
      )
    }
    if (counts.todo > maxTodo) {
      problems.push(
        `${counts.todo} test(s) marked todo, cap is ${maxTodo}. Converting a failing test to todo is not a fix.`,
      )
    }
    const unattributed = directives.filter((d) => !d.reason)
    for (const d of unattributed) {
      problems.push(
        `${d.kind} without a reason: "${d.name}". A skip must say WHY (e.g. t.skip("no Edge/Chrome on this machine")) or it is indistinguishable from a test that silently stopped running.`,
      )
    }
    if (child.status !== 0 && counts.fail === 0) {
      problems.push(
        `the test runner exited ${child.status} while reporting 0 failures — treat as a failure, not noise.`,
      )
    }
  }
}

// ---- 4. report ------------------------------------------------------------
const lines = []
lines.push("")
lines.push(`test-gate: ${label} — ${problems.length ? "FAIL" : "PASS"}`)
lines.push(`  platform    ${process.platform} / node ${process.version}`)
lines.push(
  `  paths       ${paths.length ? paths.join(" ") : "(default discovery)"}`,
)
if (paths.length) {
  lines.push(`  files       ${files.length} test file(s) after expansion`)
}
lines.push(`  tests       ${counts.tests ?? "?"}   (floor ${floor})`)
lines.push(`  pass        ${counts.pass ?? "?"}`)
lines.push(`  fail        ${counts.fail ?? "?"}`)
lines.push(`  skipped     ${counts.skipped ?? "?"}`)
lines.push(`  todo        ${counts.todo ?? "?"}   (cap ${maxTodo})`)
if (counts.duration_ms != null) {
  lines.push(`  duration    ${(counts.duration_ms / 1000).toFixed(1)}s`)
}
if (directives.length) {
  lines.push(`  not executed on this leg (${directives.length}):`)
  for (const d of directives) {
    lines.push(`    [${d.kind}] ${d.name} — ${d.reason || "NO REASON GIVEN"}`)
  }
}
if (counts.tests != null && counts.tests >= floor + 25) {
  lines.push(
    `  NOTE: ${counts.tests - floor} tests above the floor. Raise "testGate.${opts.gate ?? "<gate>"}.floor" in package.json to ${counts.tests} so deletions below today's count are caught.`,
  )
}
for (const p of problems) lines.push(`  ERROR: ${p}`)
lines.push("")

const report = lines.join("\n")
process.stdout.write(report + "\n")

if (process.env.GITHUB_STEP_SUMMARY) {
  const md = [
    `### test-gate: ${label} — ${problems.length ? "FAIL" : "PASS"}`,
    "",
    `\`${process.platform}\` / node \`${process.version}\``,
    "",
    `| tests | floor | pass | fail | skipped | todo |`,
    `| --- | --- | --- | --- | --- | --- |`,
    `| ${counts.tests ?? "?"} | ${floor} | ${counts.pass ?? "?"} | ${counts.fail ?? "?"} | ${counts.skipped ?? "?"} | ${counts.todo ?? "?"} |`,
    "",
    ...(directives.length
      ? [
          `**Not executed on this leg:**`,
          "",
          ...directives.map(
            (d) =>
              `- \`${d.kind}\` ${d.name} — ${d.reason || "**NO REASON GIVEN**"}`,
          ),
          "",
        ]
      : ["No tests were skipped on this leg.", ""]),
    ...problems.map((p) => `- **ERROR:** ${p}`),
    "",
  ].join("\n")
  try {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md)
  } catch {
    /* a summary write failure must never change the verdict */
  }
}

try {
  fs.rmSync(tmpDir, { recursive: true, force: true })
} catch {
  /* best effort */
}

process.exit(problems.length ? 1 : 0)
