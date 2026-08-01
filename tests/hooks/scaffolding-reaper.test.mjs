// Tests for the scaffolding reaper (.github/workflows/scaffolding-reaper.mjs).
//
// The reaper's whole value is that it can go RED. On this repo it currently
// finds zero declared artifacts, so a run against the real tree proves
// nothing about whether it works — a checker with nothing to check is
// indistinguishable from a broken one, which is the protocol's slacking
// signature "a capability documented that does not exist".
//
// So every case here builds a throwaway tree with a real declaration in it and
// drives the real CLI, asserting the EXIT CODE in both directions. Nothing is
// mocked: the thing being guarded against is the reaper silently matching
// nothing, and a mock of the file walk would hide exactly that.
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
const REAPER = path.join(ROOT, ".github", "workflows", "scaffolding-reaper.mjs")

function fixture(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reaper-fixture-"))
  for (const [name, body] of Object.entries(files)) {
    fs.mkdirSync(path.join(dir, path.dirname(name)), { recursive: true })
    fs.writeFileSync(path.join(dir, name), body)
  }
  return dir
}

function reap(dir, extra = []) {
  const res = spawnSync(
    process.execPath,
    [REAPER, "--root", dir, "--json", ...extra],
    { cwd: ROOT, encoding: "utf8", timeout: 30_000 },
  )
  let json = null
  try {
    json = JSON.parse(res.stdout)
  } catch {
    /* left null; the assertions below report the raw output */
  }
  return { status: res.status, out: res.stdout + res.stderr, json }
}

const EXPIRED_SKILL = `---
name: fake-board-runner
description: spins the local ATS fixture
scaffolding: true
remove_after: phase-1
owner: qa-adversary
---

# Fake board runner
`

const LIVE_SKILL = `---
name: still-needed
scaffolding: true
remove_after: phase-3
owner: ci-engineer
---
`

// ---------------------------------------------------------------- goes red

test("an artifact that outlived its phase FAILS the build, and is named", (t) => {
  const dir = fixture({ ".claude/skills/fake-board/SKILL.md": EXPIRED_SKILL })
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))

  const r = reap(dir, ["--phase", "phase-2"])
  assert.equal(r.status, 1, `expected exit 1, got ${r.status}\n${r.out}`)
  assert.equal(r.json.expired.length, 1)
  assert.equal(r.json.expired[0].artifact, ".claude/skills/fake-board/SKILL.md")
  // "Print what must go and who owns it" — the owner is the point. A finding
  // nobody is named on gets read and dropped.
  assert.equal(r.json.expired[0].owner, "qa-adversary")
  assert.match(r.json.problems[0], /REMOVED AFTER phase-1/)
  assert.match(r.json.problems[0], /qa-adversary/)
})

test("scaffolding with NO remove_after fails — an unbounded promise is the defect", (t) => {
  const dir = fixture({
    "scripts/dev/helper.mjs": `#!/usr/bin/env node
// A development helper.
// scaffolding: true
// owner: innov-perf
export const x = 1
`,
  })
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))

  const r = reap(dir, ["--phase", "phase-1"])
  assert.equal(r.status, 1, `expected exit 1, got ${r.status}\n${r.out}`)
  assert.match(r.json.problems[0], /NO "remove_after"/)
  assert.match(r.json.problems[0], /innov-perf/)
})

test("a remove_after naming an unknown phase fails, because it could never expire", (t) => {
  const dir = fixture({
    "docs/temp-note.md": `---
scaffolding: true
remove_after: phase-two
---
`,
  })
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))

  const r = reap(dir, ["--phase", "phase-1"])
  assert.equal(r.status, 1, `expected exit 1, got ${r.status}\n${r.out}`)
  assert.match(r.json.problems[0], /not a known phase/)
})

test("an unowned artifact is still reported, as UNASSIGNED rather than silently", (t) => {
  const dir = fixture({
    "docs/orphan.md": `---
scaffolding: true
remove_after: phase-1
---
`,
  })
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))

  const r = reap(dir, ["--phase", "phase-2"])
  assert.equal(r.status, 1)
  assert.equal(r.json.expired[0].owner, null)
  assert.match(r.json.problems[0], /UNASSIGNED/)
})

// -------------------------------------------------------------- stays green

test("an artifact still inside its phase passes, and is listed as owed", (t) => {
  const dir = fixture({ ".claude/skills/keep/SKILL.md": LIVE_SKILL })
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))

  const r = reap(dir, ["--phase", "phase-1"])
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}\n${r.out}`)
  assert.equal(r.json.live.length, 1)
  assert.equal(r.json.expired.length, 0)
  // Listed on every run: "what do we still owe?" is answered by the pipeline.
  assert.equal(r.json.live[0].remove_after, "phase-3")
})

test("removing the artifact turns the same tree green — the check tracks reality", (t) => {
  const dir = fixture({ ".claude/skills/fake-board/SKILL.md": EXPIRED_SKILL })
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))

  assert.equal(reap(dir, ["--phase", "phase-2"]).status, 1)
  fs.rmSync(path.join(dir, ".claude/skills/fake-board"), {
    recursive: true,
    force: true,
  })
  const after = reap(dir, ["--phase", "phase-2"])
  assert.equal(after.status, 0, after.out)
  assert.equal(after.json.artifacts.length, 0)
})

// ------------------------------------------------- the false-positive rules

// This is the case that nearly shipped broken. docs/team-roster.md,
// docs/autonomy-plan.md and .claude/agents/*.md all contain the literal string
// `scaffolding: true` inside fenced examples, and the reaper's OWN header
// carries a worked example. A whole-file grep fails the build on its own
// documentation, gets muted within a day, and protects nothing.
test("prose ABOUT the convention is not a declaration", (t) => {
  const dir = fixture({
    "docs/roster.md": `# Roster

Development-only skills declare it in frontmatter:

\`\`\`yaml
scaffolding: true
remove_after: phase-2
\`\`\`

ci-engineer fails the build when one outlives its phase.
`,
    "docs/agent.md": `---
name: doc-scribe
---

Write \`scaffolding: true\` and \`remove_after: phase-1\` in the frontmatter.
`,
  })
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))

  const r = reap(dir, ["--phase", "phase-4"])
  assert.equal(r.status, 0, `prose must not fail the build\n${r.out}`)
  assert.equal(r.json.artifacts.length, 0)
})

// The column-0 rule, which is what makes the case above work without a
// special case. A top-level YAML key sits at column 0; an indented one is a
// nested key and means something else.
test("an INDENTED scaffolding key is nested YAML, not a top-level declaration", (t) => {
  const dir = fixture({
    "docs/example.md": `---
name: reaper-docs
example:
  scaffolding: true
  remove_after: phase-1
---
`,
  })
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))

  const r = reap(dir, ["--phase", "phase-4"])
  assert.equal(r.status, 0, r.out)
  assert.equal(r.json.artifacts.length, 0)
})

test("a declaration below the leading block is not read — only the top counts", (t) => {
  const dir = fixture({
    "scripts/thing.mjs": `#!/usr/bin/env node
// A real module.
export const x = 1

// scaffolding: true
// remove_after: phase-1
`,
    "docs/late.md": `# Title

Some prose first.

---
scaffolding: true
remove_after: phase-1
---
`,
  })
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))

  const r = reap(dir, ["--phase", "phase-4"])
  assert.equal(r.status, 0, r.out)
  assert.equal(r.json.artifacts.length, 0)
})

test("a leading comment block in a script IS read, so helpers are covered too", (t) => {
  const dir = fixture({
    "scripts/dev/harness.mjs": `#!/usr/bin/env node
// Benchmark harness.
// scaffolding: true
// remove_after: phase-2
// owner: innov-perf
export const x = 1
`,
  })
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))

  const r = reap(dir, ["--phase", "phase-3"])
  assert.equal(r.status, 1, `expected exit 1, got ${r.status}\n${r.out}`)
  assert.equal(r.json.expired[0].owner, "innov-perf")
})

test("node_modules, .git, worktrees, jobs and profile are never walked", (t) => {
  const decl = `---
scaffolding: true
remove_after: phase-1
---
`
  const dir = fixture({
    "node_modules/pkg/readme.md": decl,
    ".git/notes.md": decl,
    "worktrees/other/SKILL.md": decl,
    "jobs/some-slug/notes.md": decl,
    "profile/notes.md": decl,
  })
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))

  const r = reap(dir, ["--phase", "phase-4"])
  assert.equal(r.status, 0, `skipped trees must not fail the build\n${r.out}`)
  assert.equal(r.json.artifacts.length, 0)
})

// ---------------------------------------------------------------- self-test

// qa-breaker canaries this pipeline. --self-test is the cheapest way for them
// to confirm the reaper is not inert on a leg where zero artifacts exist, so
// it has to keep working.
test("--self-test proves the checker can go red, and exits 0 when it can", () => {
  const res = spawnSync(process.execPath, [REAPER, "--self-test"], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 30_000,
  })
  assert.equal(res.status, 0, res.stdout + res.stderr)
  assert.match(res.stdout, /the checker can go red/)
  assert.doesNotMatch(res.stdout, /NOT OK/)
})

// The gap doc-scribe filed on 2026-07-31: --self-test drove judge() ALONE, so
// a break in readDeclaration/frontmatterBlock/findArtifacts printed 5/5 here
// AND "declared 0 — that is a real pass" on the real run. Two greens over a
// checker that inspected nothing.
//
// This asserts the three sections exist and pins a FLOOR on the case count,
// for the same reason package.json pins a floor on the test count: a self-test
// that silently lost half its cases still prints N/N and still exits 0.
test("--self-test covers the parser and the walk, not judge() alone", () => {
  const res = spawnSync(process.execPath, [REAPER, "--self-test"], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 30_000,
  })
  assert.match(res.stdout, /-- verdict \(judge\)/)
  assert.match(res.stdout, /-- parser \(/, "no parser section in --self-test")
  assert.match(res.stdout, /-- walk \(/, "no walk section in --self-test")

  const m = /can go red[^.]*\. (\d+)\/(\d+)\./.exec(res.stdout)
  assert.ok(m, `no N/N summary line in:\n${res.stdout}`)
  assert.equal(m[1], m[2], "some self-test case did not pass")
  assert.ok(
    Number(m[2]) >= 18,
    `--self-test is down to ${m[2]} cases, was 18. Cases were deleted, or the ` +
      `summary stopped counting them. Either way the self-test is weaker than ` +
      `the last time anyone looked; raise this floor deliberately, never down.`,
  )
})

// The parser section must itself be able to fail. Proven by mutating a COPY of
// the reaper — the same canary qa-breaker runs against the pipeline, applied
// one level down to the thing that certifies the pipeline. Two mutations, each
// invisible to the old judge()-only self-test:
//   - readDeclaration always returns null  → the walk finds nothing
//   - frontmatterBlock slices one char too many → only bites a file whose
//     FIRST frontmatter key is the declaration
test("--self-test goes RED when the parser is broken (canary, on a copy)", () => {
  const src = fs.readFileSync(REAPER, "utf8")
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reaper-canary-"))
  const mutations = [
    [
      "readDeclaration returns null",
      src.replace(
        "  if (!DECL_RE.scaffolding.test(block)) return null",
        "  if (!DECL_RE.scaffolding.test(block)) return null\n  return null",
      ),
    ],
    [
      "frontmatterBlock off-by-one",
      src.replace("return norm.slice(4, end)", "return norm.slice(5, end)"),
    ],
  ]
  try {
    for (const [why, mutated] of mutations) {
      assert.notEqual(mutated, src, `the ${why} mutation did not apply`)
      const file = path.join(dir, "canary.mjs")
      fs.writeFileSync(file, mutated)
      const res = spawnSync(process.execPath, [file, "--self-test"], {
        cwd: ROOT,
        encoding: "utf8",
        timeout: 30_000,
      })
      assert.equal(
        res.status,
        1,
        `--self-test still exited 0 with "${why}" broken. That is the exact ` +
          `defect this covers: a green self-test over a parser that reads ` +
          `nothing.\n${res.stdout}${res.stderr}`,
      )
      assert.match(res.stdout, /NOT OK/, `no NOT OK line for "${why}"`)
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// ------------------------------------------------- the real tree, honestly

test("the real repository currently declares ZERO scaffolding artifacts", () => {
  // Pinned deliberately. When the first artifact lands this test fails, and
  // the person adding it has to look at the reaper and confirm it saw them —
  // which is the moment the check stops being theoretical. The failure message
  // says exactly that, so it is not read as a mystery regression.
  const r = reap(ROOT)
  assert.equal(
    r.status,
    0,
    `the reaper failed against the real tree:\n${r.out}`,
  )
  assert.equal(
    r.json.artifacts.length,
    0,
    `A scaffolding artifact now exists: ${JSON.stringify(r.json.artifacts)}. ` +
      `That is not a bug — update this count, and confirm the reaper reports ` +
      `it with the right owner and remove_after.`,
  )
})
