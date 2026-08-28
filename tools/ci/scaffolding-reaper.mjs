#!/usr/bin/env node
// The scaffolding reaper: fails the build when a development-only artifact
// outlives the phase it promised to die in.
//
// docs/team-roster.md ("Skills and scaffolding") says `ci-engineer` **fails
// the build** when a scaffolding artifact outlives its phase (so did the
// autonomy plan doc, deleted 2026-08-06). Until 2026-07-31 that was a comment
// in ci.yml and nothing else — a documented capability that did not exist,
// which is on the protocol's slacking-signatures list. This is the capability.
//
// The declaration, written by whoever owns the artifact:
//
//   ---
//   name: fake-board-runner
//   scaffolding: true
//   remove_after: phase-2
//   owner: qa-adversary
//   ---
//
// WHERE IT IS READ FROM, and why that is narrow on purpose. Only the LEADING
// block of a file counts:
//   - `.md` / `.yaml`: the `---` YAML frontmatter at the very top;
//   - `.mjs` / `.js` / `.cjs`: the contiguous `//` comment block at the very
//     top, before any code.
// Anything further down is prose ABOUT the convention, not a declaration.
// That distinction is load-bearing here: docs/team-roster.md and
// .claude/agents/*.md contain the literal text `scaffolding: true` inside
// fenced examples (so did the deleted autonomy plan doc). A reaper that
// grepped the whole file would fail the build on its own documentation, get
// muted within a day, and protect nothing.
//
// WHAT FAILS THE BUILD:
//   1. an artifact whose `remove_after` phase is already PAST (the point);
//   2. `scaffolding: true` with NO `remove_after` — an unbounded promise is
//      the thing this check exists to prevent, so it is not a warning;
//   3. `remove_after` naming a phase that is not in package.json "phases"
//      .order — a typo'd phase can never expire, so it would be scaffolding
//      that outlives the project silently.
//
// WHAT DOES NOT FAIL: an artifact still inside its phase. It is listed on
// every run with its owner, so "what do we still owe?" is answered by the
// pipeline rather than by memory.
//
// Exit 0 with zero artifacts found is a legitimate PASS and says so out loud
// ("0 declared"), because a checker with nothing to check must be
// distinguishable from a checker that is broken — see the `--self-test` flag,
// and tests/hooks/scaffolding-reaper.test.mjs which drives both directions
// over fixture trees.
//
// Usage:
//   node tools/ci/scaffolding-reaper.mjs [--root <dir>] [--phase <p>] [--json]
//   node tools/ci/scaffolding-reaper.mjs --self-test
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_ROOT = path.resolve(HERE, "..", "..")

// Directories that never hold a shipped artifact, and would make the walk slow
// or noisy. `worktrees` matters on this repo specifically: it holds checkouts
// of other branches, and a stale scaffolding declaration in one of those is
// not this build's problem.
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "worktrees",
  "jobs",
  "profile",
  ".playwright-mcp",
  "dist",
  "coverage",
])

const TEXT_EXT = new Set([
  ".md",
  ".markdown",
  ".yaml",
  ".yml",
  ".mjs",
  ".js",
  ".cjs",
])

function parseArgs(argv) {
  const o = { root: null, phase: null, json: false, selfTest: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--root") o.root = argv[++i]
    else if (a === "--phase") o.phase = argv[++i]
    else if (a === "--json") o.json = true
    else if (a === "--self-test") o.selfTest = true
    else {
      process.stderr.write(`scaffolding-reaper: unknown option ${a}\n`)
      process.exit(2)
    }
  }
  return o
}

// ---- the declaration block ------------------------------------------------

// The leading YAML frontmatter, or null. Must open on the FIRST line: a `---`
// further down is a horizontal rule or a document separator, not frontmatter.
export function frontmatterBlock(text) {
  const norm = text.replace(/^\uFEFF/, "")
  if (!/^---[ \t]*\r?\n/.test(norm)) return null
  const end = norm.indexOf("\n---", 3)
  if (end === -1) return null
  return norm.slice(4, end)
}

// The contiguous `//` comment block at the top of a script, or null. Stops at
// the first line that is not a comment and not blank, so a `scaffolding: true`
// in a comment halfway down the file is never a declaration.
export function leadingCommentBlock(text) {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/)
  const out = []
  for (const line of lines) {
    const t = line.trim()
    if (t.startsWith("#!")) continue
    if (t === "") {
      if (out.length) break
      continue
    }
    if (!t.startsWith("//")) break
    out.push(t.replace(/^\/\/ ?/, ""))
  }
  return out.length ? out.join("\n") : null
}

export function declarationBlock(file, text) {
  const ext = path.extname(file).toLowerCase()
  if (ext === ".mjs" || ext === ".js" || ext === ".cjs")
    return leadingCommentBlock(text)
  return frontmatterBlock(text)
}

// Reads the three fields out of a declaration block. Returns null when the
// block does not declare scaffolding at all, which is the overwhelmingly
// common case and must be cheap.
//
// COLUMN 0, and this is not cosmetic. The first version accepted leading
// whitespace and immediately flagged THIS FILE — the worked example in the
// comment block above parsed as a live declaration owned by `qa-adversary`.
// That is the same false positive the header warns about, one layer in, and it
// would have made the reaper's first act to fail the build over its own
// documentation.
//
// The fix is a real YAML rule rather than a patch: a top-level key sits at
// column 0. An indented `scaffolding:` is a NESTED key and means something
// else, so refusing it is correct parsing, not a workaround. It also gives
// every file a free way to show an example — indent it.
const DECL_RE = {
  scaffolding: /^scaffolding[ \t]*:[ \t]*true[ \t]*(?:#.*)?$/m,
  remove_after: /^remove_after[ \t]*:[ \t]*["']?([A-Za-z0-9._-]+)["']?/m,
  owner: /^owner[ \t]*:[ \t]*["']?([^"'\r\n#]+)["']?/m,
}

export function readDeclaration(block) {
  if (!block) return null
  if (!DECL_RE.scaffolding.test(block)) return null
  const after = DECL_RE.remove_after.exec(block)
  const owner = DECL_RE.owner.exec(block)
  return {
    remove_after: after ? after[1] : null,
    owner: owner ? owner[1].trim() : null,
  }
}

// ---- the walk -------------------------------------------------------------

export function findArtifacts(root) {
  const found = []
  const walk = (dir) => {
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const ent of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(ent.name)) continue
        walk(path.join(dir, ent.name))
        continue
      }
      if (!TEXT_EXT.has(path.extname(ent.name).toLowerCase())) continue
      const abs = path.join(dir, ent.name)
      let text
      try {
        text = fs.readFileSync(abs, "utf8")
      } catch {
        continue
      }
      // Cheap reject before any parsing: the string must appear at all.
      if (!text.includes("scaffolding")) continue
      const decl = readDeclaration(declarationBlock(abs, text))
      if (!decl) continue
      found.push({
        artifact: path.relative(root, abs).replace(/\\/g, "/"),
        remove_after: decl.remove_after,
        owner: decl.owner,
      })
    }
  }
  walk(root)
  return found
}

// ---- the verdict ----------------------------------------------------------

export function judge(artifacts, { current, order }) {
  const nowIdx = order.indexOf(current)
  const problems = []
  const live = []
  const expired = []
  for (const a of artifacts) {
    if (!a.remove_after) {
      problems.push(
        `${a.artifact} declares "scaffolding: true" with NO "remove_after". ` +
          `An unbounded promise is exactly what this check exists to prevent — ` +
          `name the phase it dies in. Owner: ${a.owner ?? "UNASSIGNED"}.`,
      )
      expired.push(a)
      continue
    }
    const idx = order.indexOf(a.remove_after)
    if (idx === -1) {
      problems.push(
        `${a.artifact} names remove_after "${a.remove_after}", which is not a ` +
          `known phase (${order.join(", ")}). A phase that does not exist can ` +
          `never pass, so this artifact would live forever. ` +
          `Owner: ${a.owner ?? "UNASSIGNED"}.`,
      )
      expired.push(a)
      continue
    }
    if (nowIdx > idx) {
      problems.push(
        `${a.artifact} was to be REMOVED AFTER ${a.remove_after}; the project ` +
          `is now at ${current}. Delete it, or move remove_after forward on ` +
          `purpose and in writing. Owner: ${a.owner ?? "UNASSIGNED"}.`,
      )
      expired.push(a)
      continue
    }
    live.push(a)
  }
  return { problems, live, expired }
}

export function loadPhases(root, override) {
  let pkg = {}
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"))
  } catch {
    /* falls through to the default below */
  }
  const order = pkg.phases?.order ?? [
    "phase-1",
    "phase-2",
    "phase-3",
    "phase-4",
  ]
  const current = override ?? pkg.phases?.current ?? order[0]
  return { order, current }
}

// ---- self-test ------------------------------------------------------------
// Proves the reaper can go RED, without needing the test suite. `qa-breaker`
// canaries this pipeline; this is the cheapest way for them to confirm the
// checker is not inert on a leg where zero artifacts are declared.
//
// THREE SECTIONS, and sections 2 and 3 exist because of a gap `doc-scribe`
// filed on 2026-07-31. The original self-test drove `judge()` and nothing else.
// But every declaration that ever reaches `judge()` has to survive
// `frontmatterBlock` / `leadingCommentBlock` / `readDeclaration` /
// `findArtifacts` first, and a break in ANY of those makes the walk return an
// empty array. `judge([])` reports no problems, so the real run prints
// "declared 0 ... that is a real pass" and `--self-test` prints 5/5. Two green
// outputs over a checker that inspected nothing — the exact shape this whole
// pipeline exists to prevent, one level down inside the thing that prevents it.
//
// So: section 1 is the verdict, section 2 is the parser over in-memory text in
// BOTH directions, and section 3 walks a real throwaway directory on disk so
// that "found the file, read the keys, failed the build" is proven end to end.
// tests/hooks/scaffolding-reaper.test.mjs covers the same ground more widely;
// this duplicates it on purpose, because the self-test's job is to be runnable
// on a leg where the suite is not.
const SELF_TEST_PHASES = {
  order: ["phase-1", "phase-2", "phase-3"],
  current: "phase-2",
}

// A declaration that is expired against SELF_TEST_PHASES above.
const SELF_TEST_EXPIRED_MD = `---
name: fake-board-runner
scaffolding: true
remove_after: phase-1
owner: qa-adversary
---

# Fake board runner
`

// ---- section 1: the verdict ----
function verdictCases() {
  const cases = [
    [
      { artifact: "a", remove_after: "phase-1", owner: "x" },
      true,
      "expired phase",
    ],
    [
      { artifact: "b", remove_after: "phase-2", owner: "x" },
      false,
      "current phase",
    ],
    [
      { artifact: "c", remove_after: "phase-3", owner: "x" },
      false,
      "future phase",
    ],
    [
      { artifact: "d", remove_after: null, owner: "x" },
      true,
      "no remove_after",
    ],
    [
      { artifact: "e", remove_after: "phase-9", owner: "x" },
      true,
      "unknown phase",
    ],
  ]
  return cases.map(([a, wantRed, why]) => {
    const red = judge([a], SELF_TEST_PHASES).problems.length > 0
    return [
      red === wantRed,
      `${why} → ${red ? "FAIL" : "pass"} (want ${wantRed ? "FAIL" : "pass"})`,
    ]
  })
}

// ---- section 2: the parser ----
// Both directions. The negative cases are the load-bearing ones: each is a
// shape that MUST NOT be read as a declaration, and each was a real false
// positive at some point — the reaper's own header comment, and the fenced
// examples in docs/team-roster.md and .claude/agents/*.md.
function parserCases() {
  const cases = [
    [
      "skill.md",
      "---\nname: x\nscaffolding: true\nremove_after: phase-2\nowner: qa-adversary\n---\n\n# doc\n",
      { remove_after: "phase-2", owner: "qa-adversary" },
      "md frontmatter declaration is read",
    ],
    // Pins the SLICE BOUNDARY of frontmatterBlock. Found by canarying this
    // very self-test on 2026-07-31: changing `norm.slice(4, end)` to
    // `slice(5, end)` passed all the other cases, because every one of them
    // opens with `name:` and only loses a character off a key nobody reads.
    // A file whose FIRST key is the declaration is the shape that break eats,
    // and it is a shape a real skill would have.
    [
      "skill.md",
      "---\nscaffolding: true\nremove_after: phase-1\nowner: w2-engine\n---\n",
      { remove_after: "phase-1", owner: "w2-engine" },
      "scaffolding as the FIRST frontmatter key (pins the slice boundary)",
    ],
    // Windows is the primary platform here, so a hand-written .md arrives with
    // CRLF. A parser that only handles LF would read zero declarations on the
    // user's own machine and report it as a pass.
    [
      "skill.md",
      "---\r\nname: x\r\nscaffolding: true\r\nremove_after: phase-2\r\nowner: w6-documents\r\n---\r\n",
      { remove_after: "phase-2", owner: "w6-documents" },
      "CRLF frontmatter is read (Windows is the primary platform)",
    ],
    [
      "helper.mjs",
      "#!/usr/bin/env node\n// a dev-only helper\n// scaffolding: true\n// remove_after: phase-3\n// owner: ci-engineer\nexport const x = 1\n",
      { remove_after: "phase-3", owner: "ci-engineer" },
      "leading // comment block in a script is read",
    ],
    [
      "helper.mjs",
      "// a dev-only helper\r\n// scaffolding: true\r\n// remove_after: phase-3\r\n// owner: ci-engineer\r\nexport const x = 1\r\n",
      { remove_after: "phase-3", owner: "ci-engineer" },
      "CRLF leading comment block is read",
    ],
    [
      "skill.md",
      "---\nname: x\nscaffolding: true\nremove_after: phase-2\n---\n",
      { remove_after: "phase-2", owner: null },
      "a missing owner reads as null (reported UNASSIGNED, never silence)",
    ],
    [
      "doc.md",
      "---\nname: x\nexample:\n  scaffolding: true\n  remove_after: phase-1\n---\n",
      null,
      "an INDENTED key is nested YAML, not a declaration",
    ],
    [
      "doc.md",
      "# prose\n\nMark it `scaffolding: true` with `remove_after: phase-1`.\n",
      null,
      "prose ABOUT the convention is not a declaration",
    ],
    [
      "helper.mjs",
      "export const x = 1\n// scaffolding: true\n// remove_after: phase-1\n",
      null,
      "a declaration below the leading block is not read",
    ],
  ]
  return cases.map(([file, text, want, why]) => {
    const got = readDeclaration(declarationBlock(file, text))
    const ok =
      want === null
        ? got === null
        : got !== null &&
          got.remove_after === want.remove_after &&
          got.owner === want.owner
    return [ok, `${why} → ${JSON.stringify(got)}`]
  })
}

// ---- section 3: the walk, on a real directory ----
// The one section that proves file discovery works. Without it a broken
// findArtifacts reports zero artifacts, which the main run prints as a pass.
function walkCases() {
  const out = []
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reaper-selftest-"))
  try {
    fs.mkdirSync(path.join(dir, "node_modules"), { recursive: true })
    fs.writeFileSync(
      path.join(dir, "node_modules", "vendored.md"),
      SELF_TEST_EXPIRED_MD,
    )
    fs.writeFileSync(path.join(dir, "expired.md"), SELF_TEST_EXPIRED_MD)
    fs.writeFileSync(
      path.join(dir, "prose.md"),
      "# about\n\nWe write `scaffolding: true` in frontmatter.\n",
    )

    const found = findArtifacts(dir)
    out.push([
      found.length === 1 && found[0].artifact === "expired.md",
      `the walk finds a declaration on disk, and skips prose + node_modules → ${found.length} found`,
    ])
    out.push([
      found[0]?.remove_after === "phase-1" &&
        found[0]?.owner === "qa-adversary",
      `the walk carries remove_after and owner through → ${found[0]?.remove_after}/${found[0]?.owner}`,
    ])
    const red = judge(found, SELF_TEST_PHASES)
    out.push([
      red.problems.length === 1 && red.expired.length === 1,
      `an expired artifact ON DISK fails the build → ${red.problems.length} problem(s)`,
    ])

    fs.rmSync(path.join(dir, "expired.md"))
    const after = findArtifacts(dir)
    const green = judge(after, SELF_TEST_PHASES)
    out.push([
      after.length === 0 && green.problems.length === 0,
      `removing it turns the same tree green → ${after.length} found, ${green.problems.length} problem(s)`,
    ])
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  }
  return out
}

function selfTest() {
  const sections = [
    ["verdict (judge)", verdictCases()],
    ["parser (frontmatter / leading comment / keys)", parserCases()],
    ["walk (a real directory on disk)", walkCases()],
  ]
  let bad = 0
  let total = 0
  for (const [title, results] of sections) {
    process.stdout.write(`  -- ${title}\n`)
    for (const [ok, why] of results) {
      total++
      if (!ok) bad++
      process.stdout.write(`  ${ok ? "ok" : "NOT OK"}  ${why}\n`)
    }
  }
  process.stdout.write(
    bad === 0
      ? `scaffolding-reaper --self-test: the checker can go red, and the parser and walk that feed it still work. ${total}/${total}.\n`
      : `scaffolding-reaper --self-test: ${bad} of ${total} case(s) wrong.\n`,
  )
  return bad === 0 ? 0 : 1
}

// ---- main -----------------------------------------------------------------

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))

if (isMain) {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.selfTest) process.exit(selfTest())

  const root = path.resolve(opts.root ?? DEFAULT_ROOT)
  const phases = loadPhases(DEFAULT_ROOT, opts.phase)
  const artifacts = findArtifacts(root)
  const { problems, live, expired } = judge(artifacts, phases)

  if (opts.json) {
    process.stdout.write(
      JSON.stringify(
        { root, phase: phases.current, artifacts, live, expired, problems },
        null,
        2,
      ) + "\n",
    )
    process.exit(problems.length ? 1 : 0)
  }

  const lines = []
  lines.push("")
  lines.push(`scaffolding-reaper — ${problems.length ? "FAIL" : "PASS"}`)
  lines.push(`  phase       ${phases.current}   (${phases.order.join(" → ")})`)
  lines.push(`  scanned     ${path.relative(DEFAULT_ROOT, root) || "."}`)
  lines.push(`  declared    ${artifacts.length} scaffolding artifact(s)`)
  if (artifacts.length === 0) {
    lines.push(
      `  Nothing is currently marked "scaffolding: true" in a leading ` +
        `frontmatter/comment block. That is a real pass, not an inert check: ` +
        `run --self-test to see it go red on purpose.`,
    )
  }
  for (const a of live) {
    lines.push(
      `  [owed]  ${a.artifact} — remove after ${a.remove_after} (owner: ${a.owner ?? "UNASSIGNED"})`,
    )
  }
  for (const a of expired) {
    lines.push(
      `  [MUST GO] ${a.artifact} — remove_after ${a.remove_after ?? "(none declared)"} (owner: ${a.owner ?? "UNASSIGNED"})`,
    )
  }
  for (const p of problems) lines.push(`  ERROR: ${p}`)
  lines.push("")
  process.stdout.write(lines.join("\n") + "\n")

  if (process.env.GITHUB_STEP_SUMMARY) {
    const md = [
      `### scaffolding-reaper — ${problems.length ? "FAIL" : "PASS"}`,
      "",
      `Phase **${phases.current}**, ${artifacts.length} declared artifact(s).`,
      "",
      ...(artifacts.length
        ? [
            `| artifact | remove_after | owner | status |`,
            `| --- | --- | --- | --- |`,
            ...live.map(
              (a) =>
                `| \`${a.artifact}\` | ${a.remove_after} | ${a.owner ?? "UNASSIGNED"} | owed |`,
            ),
            ...expired.map(
              (a) =>
                `| \`${a.artifact}\` | ${a.remove_after ?? "(none)"} | ${a.owner ?? "UNASSIGNED"} | **MUST GO** |`,
            ),
            "",
          ]
        : [
            "No scaffolding declared. `--self-test` proves the checker still fails.",
            "",
          ]),
      ...problems.map((p) => `- **ERROR:** ${p}`),
      "",
    ].join("\n")
    try {
      fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md)
    } catch {
      /* a summary write failure must never change the verdict */
    }
  }

  process.exit(problems.length ? 1 : 0)
}
