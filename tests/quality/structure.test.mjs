// Gate #11: the folder structure is a decision, so it is asserted.
//
// The 2026-08-27 re-layout moved scripts/ to src/ and the CI helpers to
// tools/ci/. That layout only stays true if drift is loud: a new file at the
// repo root, a twelfth directory under src/, a helper quietly added beside a
// sealed shim. None of those break a test today, which is exactly why they
// happen.
//
// Every list here is COMPUTED FROM THE TRACKED TREE and then written down.
// The point is not that the list is beautiful; it is that changing it takes a
// deliberate edit in the same commit, with a reviewer looking at it.
//
// Owned by ci-engineer.
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { ROOT, gitAvailable, trackedFiles } from "./helpers/bins.mjs"

// ---------------------------------------------------------------------------
// (a) The repo root.
// ---------------------------------------------------------------------------
// Measured from `git ls-files` on 2026-08-27, plus eslint.config.mjs and
// eslint-suppressions.json added by this phase. A NEW root entry fails: the
// root is the first thing a human or an agent reads, and it is where
// scratch files and one-off scripts accumulate.
const ROOT_ALLOWLIST = [
  ".claude",
  ".env.example",
  ".gitattributes",
  ".github",
  ".gitignore",
  ".mcp.json",
  ".markdownlint-cli2.jsonc",
  ".prettierignore",
  ".prettierrc",
  "CLAUDE.md",
  "LICENSE",
  "README.md",
  "docs",
  "eslint-suppressions.json",
  "eslint.config.mjs",
  "package-lock.json",
  "package.json",
  "profile",
  "schemas",
  "scripts",
  "src",
  "templates",
  "tests",
  "tools",
]

// ---------------------------------------------------------------------------
// (b) src/ — ten domain directories and one file.
// ---------------------------------------------------------------------------
const SRC_ALLOWLIST = [
  "applications",
  "apply",
  "auto",
  "dev",
  "documents",
  "hooks",
  "leads",
  "lib",
  "maintenance",
  "profile",
  "status.mjs",
]

// ---------------------------------------------------------------------------
// (c) scripts/ — SIX files, and every one of them is pinned by something
// outside this repository's control.
// ---------------------------------------------------------------------------
const SCRIPTS_EXACT = [
  "scripts/auto/cycle.cmd",
  "scripts/hooks/guard-bash.mjs",
  "scripts/hooks/guard-files.mjs",
  "scripts/hooks/prettify.mjs",
  "scripts/profile/apply-profile.mjs",
  "scripts/profile/save-answer.mjs",
]

// The ONE non-executable file permitted here, and it is named rather than
// pattern-matched. It arrived on 2026-08-27, three minutes after this gate
// first ran, which is the gate working: the addition was caught, looked at,
// and admitted deliberately instead of drifting in. A `.md` cannot be invoked
// by .claude/settings.json or by Task Scheduler, so it cannot acquire the
// sealed-looking-path problem the rule below exists to prevent — and a
// document explaining why six files stayed behind is worth more here than
// anywhere else in the tree. Anything that is not this exact path still fails.
const SCRIPTS_DOC = "scripts/README.md"
const SCRIPTS_EXPECTED = [...SCRIPTS_EXACT, SCRIPTS_DOC].sort()

const SCRIPTS_WHY =
  "scripts/ is not a source directory any more — it is the set of paths that\n" +
  "something SEALED names literally, and nothing else may live there.\n" +
  "  hooks/{guard-bash,guard-files,prettify}.mjs  argv-rewriting forwarding\n" +
  "      shims. .claude/settings.json wires these exact paths and is the\n" +
  "      user's file alone; the agent cannot repoint it. A bare re-export\n" +
  "      shim silently runs nothing and exits 0 (measured 2026-08-27), which\n" +
  "      is why they rewrite process.argv[1] first.\n" +
  "  auto/cycle.cmd  the Windows Scheduled Task invokes this ABSOLUTE path at\n" +
  "      07:00 daily. Re-registering the task is the user's act.\n" +
  "  profile/{save-answer,apply-profile}.mjs  REAL files, not shims. The\n" +
  "      sealed .claude/hooks/guard-profile-shell.mjs regex pins that literal\n" +
  "      path, so moving them would disarm the guard that stops an accidental\n" +
  "      write to the real profile/.\n" +
  "  README.md  the one permitted document, admitted deliberately.\n" +
  "Adding an executable file here gives it a sealed-looking path nothing\n" +
  "actually pins. Removing one breaks a hook, a Scheduled Task, or a profile\n" +
  "guard SILENTLY."

// ---------------------------------------------------------------------------
// (d) naming.
// ---------------------------------------------------------------------------
// kebab-case: lowercase letters, digits, hyphens and dots only. README.md is
// allowed anywhere by universal convention (P4 adds one per src/ domain).
const KEBAB = /^[a-z0-9][a-z0-9.-]*$/
const NAME_EXEMPT = new Set(["README.md"])
// Extensions permitted under src/. The two named exceptions are deliberate:
//   src/dev/spawn-counter.cjs  spawned as a plain script; must NOT be parsed
//                              as an ES module.
//   src/auto/cycle.cmd         a batch wrapper, because Task Scheduler runs an
//                              action with no shell and no reliable PATH.
const SRC_EXTENSIONS = new Set([".mjs", ".md"])
const SRC_EXTENSION_EXEMPT = new Set([
  "src/dev/spawn-counter.cjs",
  "src/auto/cycle.cmd",
])

// ---------------------------------------------------------------------------
// (e) tests mirror src, one file for one file.
// ---------------------------------------------------------------------------
// Frozen 2026-08-27 by measurement: these 28 source modules have no
// name-matched test file. SHRINK-ONLY. Several are covered under a different
// filename (the three hooks by tests/hooks/guard-hooks.test.mjs, for
// instance) — the exemption records "no NAME-MATCHED test", not "untested".
//
// Both directions fail:
//   * a non-exempt module with no test  -> add the test, or argue for the
//     exemption in review;
//   * an exempt module that NOW has a test -> delete its line here. That is
//     what makes the list shrink instead of quietly becoming permanent.
const MIRROR_EXEMPT = [
  "src/applications/check-applied.mjs",
  "src/applications/log-application.mjs",
  "src/applications/update-application.mjs",
  "src/apply/ats/ashby.mjs",
  "src/apply/ats/generic.mjs",
  "src/apply/ats/greenhouse.mjs",
  "src/apply/ats/index.mjs",
  "src/apply/ats/lever.mjs",
  "src/apply/auth-sync.mjs",
  "src/apply/automatability.mjs",
  "src/apply/browser.mjs",
  "src/apply/fill-engine.mjs",
  "src/apply/longform.mjs",
  "src/apply/rebuild-plans.mjs",
  "src/apply/scan-engine.mjs",
  "src/auto/caps.mjs",
  "src/auto/notify.mjs",
  "src/auto/stages.mjs",
  "src/dev/bench-apply.mjs",
  "src/dev/bench-green-prevalence.mjs",
  "src/hooks/guard-bash.mjs",
  "src/hooks/guard-files.mjs",
  "src/hooks/prettify.mjs",
  "src/leads/applicability.mjs",
  "src/leads/recommend.mjs",
  "src/leads/screen.mjs",
  "src/leads/stages.mjs",
  "src/status.mjs",
]

// QA-3 (2026-08-27): the stale-entry test below catches an exemption that
// STOPPED being true, but nothing objected to quietly ADDING one — red to
// green with no reviewer. The length pin closes the growth direction. When
// you delete an entry, lower this number in the same edit; it never rises.
const MIRROR_EXEMPT_CEILING = 28

test("the mirror-exemption list only shrinks", () => {
  assert.ok(
    MIRROR_EXEMPT.length <= MIRROR_EXEMPT_CEILING,
    `MIRROR_EXEMPT has ${MIRROR_EXEMPT.length} entries; the ceiling is ` +
      `${MIRROR_EXEMPT_CEILING}. Write the missing test instead of adding an ` +
      `exemption — this list is a debt record, not a valve.`,
  )
})

function needGit(t) {
  if (gitAvailable()) return false
  t.skip("git is not on PATH, so the tracked file set cannot be read")
  return true
}

/** The test file a source module is expected to have. */
function mirrorFor(file) {
  const rel = file.startsWith("src/")
    ? file.slice("src/".length)
    : file.slice("scripts/".length)
  return "tests/" + rel.replace(/\.mjs$/, ".test.mjs")
}

test("the repo root holds only the allowlisted entries", (t) => {
  if (needGit(t)) return
  const tracked = trackedFiles()
  const roots = [
    ...new Set(tracked.map((f) => (f.includes("/") ? f.split("/")[0] : f))),
  ].sort()
  const extra = roots.filter((r) => !ROOT_ALLOWLIST.includes(r))
  assert.deepEqual(
    extra,
    [],
    `new entries at the repo root: ${extra.join(", ")}.\n` +
      `The root is the first thing anyone reads and the place scratch files\n` +
      `accumulate. If the entry belongs, add it to ROOT_ALLOWLIST here in the\n` +
      `same commit; if it was a one-off, delete it or move it under src/,\n` +
      `tools/ or docs/.`,
  )
})

test("src/ holds only the ten domain directories and status.mjs", (t) => {
  if (needGit(t)) return
  const entries = [
    ...new Set(trackedFiles("src").map((f) => f.split("/")[1])),
  ].sort()
  const extra = entries.filter((e) => !SRC_ALLOWLIST.includes(e))
  const gone = SRC_ALLOWLIST.filter((e) => !entries.includes(e))
  assert.deepEqual(
    extra,
    [],
    `unexpected top-level entries under src/: ${extra.join(", ")}. tests/ ` +
      `mirrors src/ one directory for one directory, so a new domain is a ` +
      `two-place change.`,
  )
  assert.deepEqual(gone, [], `src/ lost: ${gone.join(", ")}`)
})

test("scripts/ holds exactly the six sealed-path files", (t) => {
  if (needGit(t)) return
  const found = trackedFiles("scripts").sort()
  assert.deepEqual(
    found,
    SCRIPTS_EXPECTED,
    `${SCRIPTS_WHY}\n\nfound:\n  ${found.join("\n  ")}`,
  )
})

test("scripts/ gained no seventh EXECUTABLE file", (t) => {
  if (needGit(t)) return
  // The assertion above would already catch it, but this one states the
  // property that actually matters and fails with the right sentence: a new
  // .mjs/.cmd/.js under scripts/ looks pinned and is not. Only .md is
  // permitted alongside the six, and only at scripts/README.md.
  const executable = trackedFiles("scripts")
    .filter((f) => !f.endsWith(".md"))
    .sort()
  assert.deepEqual(
    executable,
    SCRIPTS_EXACT,
    `scripts/ holds a runnable file that is not one of the six pinned paths.\n` +
      `${SCRIPTS_WHY}\n\nfound (non-.md):\n  ${executable.join("\n  ")}`,
  )
})

test("every tracked .mjs/.cjs/.md under src, tests and tools is kebab-case", (t) => {
  if (needGit(t)) return
  const bad = trackedFiles("src", "tests", "tools")
    .filter((f) => /\.(mjs|cjs|md)$/.test(f))
    .filter((f) => {
      const base = path.posix.basename(f)
      return !NAME_EXEMPT.has(base) && !KEBAB.test(base)
    })
  assert.deepEqual(
    bad,
    [],
    `these filenames are not kebab-case: ${bad.join(", ")}.\n` +
      `Lowercase letters, digits, hyphens and dots. One casing convention is ` +
      `worth more than any individual name — a case-insensitive filesystem ` +
      `(this repo's primary platform) hides a rename that a case-sensitive CI ` +
      `runner then fails on.`,
  )
})

test("src/ carries only .mjs and .md, plus the two named exceptions", (t) => {
  if (needGit(t)) return
  const bad = trackedFiles("src").filter(
    (f) =>
      !SRC_EXTENSIONS.has(path.posix.extname(f)) &&
      !SRC_EXTENSION_EXEMPT.has(f),
  )
  assert.deepEqual(
    bad,
    [],
    `unexpected file types under src/: ${bad.join(", ")}.\n` +
      `The only two exceptions are named and reasoned:\n` +
      `  src/dev/spawn-counter.cjs  spawned as a plain script, must not be\n` +
      `      parsed as an ES module;\n` +
      `  src/auto/cycle.cmd  Task Scheduler runs an action with no shell and\n` +
      `      no reliable PATH or working directory.`,
  )
})

test("every source module has a name-matched test, or is on the frozen exemption list", (t) => {
  if (needGit(t)) return
  const tracked = new Set(trackedFiles())
  const sources = [...tracked]
    .filter(
      (f) =>
        (f.startsWith("src/") && f.endsWith(".mjs")) ||
        /^scripts\/profile\/[^/]+\.mjs$/.test(f),
    )
    .sort()
  const missing = sources.filter(
    (f) => !tracked.has(mirrorFor(f)) && !MIRROR_EXEMPT.includes(f),
  )
  assert.deepEqual(
    missing,
    [],
    `these modules have neither a name-matched test nor an exemption:\n  ` +
      missing.map((f) => `${f}  -> want ${mirrorFor(f)}`).join("\n  ") +
      `\nWrite the test. Adding a line to MIRROR_EXEMPT instead needs a ` +
      `reviewer to agree in the same commit — the list is shrink-only.`,
  )
})

test("the mirror exemption list is shrink-only — nothing on it has a test now", (t) => {
  if (needGit(t)) return
  const tracked = new Set(trackedFiles())
  const stale = MIRROR_EXEMPT.filter((f) => tracked.has(mirrorFor(f)))
  assert.deepEqual(
    stale,
    [],
    `these are exempted from the tests-mirror rule but DO have a ` +
      `name-matched test now:\n  ` +
      stale.map((f) => `${f}  (${mirrorFor(f)} exists)`).join("\n  ") +
      `\nDelete those lines from MIRROR_EXEMPT. This direction is asserted on ` +
      `purpose: an exemption list that only ever grows is a list of promises ` +
      `nobody keeps, and this is what turns paying the debt into a required ` +
      `edit rather than an optional one.`,
  )
  // Non-vacuous: the list must still describe real files.
  const vanished = MIRROR_EXEMPT.filter((f) => !tracked.has(f))
  assert.deepEqual(
    vanished,
    [],
    `MIRROR_EXEMPT names files that no longer exist: ${vanished.join(", ")}. ` +
      `Delete the lines — a stale exemption silently exempts nothing.`,
  )
})

test("the structure gate is reading a real tree, not an empty one", (t) => {
  if (needGit(t)) return
  const all = trackedFiles()
  assert.ok(
    all.length > 300,
    `git ls-files returned ${all.length} files. Every assertion in this file ` +
      `passes vacuously over an empty list, so the size is checked.`,
  )
  assert.ok(fs.existsSync(path.join(ROOT, "src", "status.mjs")))
})
