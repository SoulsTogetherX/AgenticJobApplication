// Phase 3, falsifiable check 2: the assembler's import graph carries no way to
// reach a model, and a run does not use one.
//
// THE SHAPE OF THIS CHECK MATTERS. Revision 1 of the plan asked for "the
// absence of any network egress", which was withdrawn because it was green by
// construction and could never go red — the script is local, package.json has
// no LLM SDK, and the check would stay green if a later change routed
// rephrasing through an execFileSync of a model CLI. So this asserts two things
// that CAN fail:
//
//   STATIC   the transitive import graph — static AND dynamic specifiers — of
//            assemble-resume.mjs contains no child_process, no network module,
//            and no third-party package outside the two declared dependencies.
//            Add one line to any module in that closure and this goes red.
//   RUNTIME  node:child_process is REPLACED, for the whole process, by a
//            counting shim (helpers/cp-spy.mjs), and `fetch` by a throwing
//            counter. A full assembly must complete with both counters at zero.
//            The positive control below spawns for real and asserts the counter
//            moves, so a broken spy cannot read as a clean run.
//
// cp-spy must be the FIRST import in this file, and the modules under test
// must be loaded with await import() AFTER it — see the note by that import.
import "./helpers/cp-spy.mjs"
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import yaml from "js-yaml"
import { pathToFileURL } from "node:url"
import { cpCalls, resetCpCalls } from "./helpers/cp-spy.mjs"

// The assembler is loaded DYNAMICALLY, and that is not a style choice. ESM
// resolves and instantiates a module's whole static graph BEFORE any of it
// evaluates, so a static `import` of the assembler here would resolve
// node:child_process before cp-spy.mjs's registerHooks ever ran — and the
// runtime check would sit green with an execFileSync sitting in the graph.
// Verified by mutation: with a static import it stayed green, with this it
// goes red.

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
)
const ENTRY = path.join(ROOT, "scripts", "documents", "assemble-resume.mjs")
const FIX = path.join(ROOT, "tests", "documents", "assemble")

// Everything a document assembler has no business reaching for. `node:sqlite`
// is deliberately absent from this list — verify-claims.mjs reaches it through
// a dynamic import to record a verification row, and that is local storage, not
// a way out of the machine.
const FORBIDDEN = new Set([
  "child_process",
  "node:child_process",
  "http",
  "node:http",
  "https",
  "node:https",
  "net",
  "node:net",
  "tls",
  "node:tls",
  "dgram",
  "node:dgram",
  "undici",
  "node-fetch",
  "axios",
  "openai",
  "@anthropic-ai/sdk",
  "@anthropic-ai/claude-agent-sdk",
  "worker_threads",
  "node:worker_threads",
  "node:vm",
  "vm",
])

// The only third-party packages package.json declares. A bare specifier that
// is not one of these is either a new dependency nobody approved or a typo
// that would fail at run time.
const ALLOWED_PACKAGES = new Set(["js-yaml", "marked"])

const STATIC_RE = /(?:^|\n)\s*import\s+(?:[^'"]*?\s+from\s+)?["']([^"']+)["']/g
const DYNAMIC_RE = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g
const EXPORT_FROM_RE = /(?:^|\n)\s*export\s+[^'"]*?\s+from\s+["']([^"']+)["']/g

function specifiersIn(src) {
  const out = []
  for (const re of [STATIC_RE, DYNAMIC_RE, EXPORT_FROM_RE]) {
    re.lastIndex = 0
    for (const m of src.matchAll(re))
      out.push({ spec: m[1], dynamic: re === DYNAMIC_RE })
  }
  return out
}

/** Walk the graph from `entry`, following relative specifiers only. */
function importGraph(entry) {
  const seen = new Set()
  const edges = []
  const stack = [entry]
  while (stack.length) {
    const file = stack.pop()
    if (seen.has(file)) continue
    seen.add(file)
    const src = fs.readFileSync(file, "utf8")
    for (const { spec, dynamic } of specifiersIn(src)) {
      edges.push({
        // Forward slashes on every platform: this list is asserted by name.
        from: path.relative(ROOT, file).split(path.sep).join("/"),
        spec,
        dynamic,
      })
      if (spec.startsWith(".")) {
        const target = path.resolve(path.dirname(file), spec)
        if (fs.existsSync(target)) stack.push(target)
      }
    }
  }
  return { files: [...seen], edges }
}

test("the assembler's import graph reaches nothing that can run or call out", () => {
  const { files, edges } = importGraph(ENTRY)
  assert.ok(files.length >= 6, `graph looks truncated: ${files.length} files`)

  const bad = edges.filter((e) => FORBIDDEN.has(e.spec))
  assert.deepEqual(
    bad,
    [],
    `forbidden imports: ${bad.map((e) => `${e.from} -> ${e.spec}`).join(", ")}`,
  )

  const bare = edges.filter(
    (e) => !e.spec.startsWith(".") && !e.spec.startsWith("node:"),
  )
  for (const e of bare) {
    assert.ok(
      ALLOWED_PACKAGES.has(e.spec),
      `${e.from} imports undeclared package "${e.spec}"`,
    )
  }
})

test("the forbidden list is enforced, not decorative", () => {
  // Mutation proof, kept as a test: the walker must actually see a
  // child_process import when one is there.
  const src =
    'import { execFileSync } from "node:child_process"\nexport const x = 1\n'
  const specs = specifiersIn(src).map((s) => s.spec)
  assert.deepEqual(specs, ["node:child_process"])
  assert.ok(specs.some((s) => FORBIDDEN.has(s)))
})

test("the graph's only dynamic import is the local verification store", () => {
  const { edges } = importGraph(ENTRY)
  const dynamic = edges.filter((e) => e.dynamic)
  // Pinned by name. A new dynamic import anywhere in this closure is a way to
  // load something the static assertion above never saw, so it has to be a
  // deliberate edit to this line rather than something that slips through.
  assert.deepEqual(dynamic.map((e) => `${e.from} -> ${e.spec}`).sort(), [
    "scripts/documents/verify-claims.mjs -> ../lib/db.mjs",
    "scripts/lib/db.mjs -> node:sqlite",
  ])
})

test("assemble-resume.mjs itself contains no spawn, exec or fetch", () => {
  const src = fs.readFileSync(ENTRY, "utf8")
  // Comments are stripped first: this file's own header discusses why it does
  // not do these things, and a check that a word is absent from prose is a
  // check on prose.
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|\n)\s*\/\/[^\n]*/g, "$1")
  for (const forbidden of [
    /\bspawn(Sync)?\s*\(/,
    /\bexec(Sync|File|FileSync)?\s*\(/,
    /\bfetch\s*\(/,
    /\brequire\s*\(/,
  ]) {
    assert.equal(
      forbidden.test(code),
      false,
      `assemble-resume.mjs contains ${forbidden}`,
    )
  }
})

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

const rawProfile = fs.readFileSync(path.join(FIX, "profile.yaml"), "utf8")
const profile = yaml.load(rawProfile)
const answers = yaml.load(
  fs.readFileSync(path.join(FIX, "answers.yaml"), "utf8"),
)
const job = JSON.parse(
  fs.readFileSync(path.join(FIX, "jobs", "cloud-platform.json"), "utf8"),
)

test("loading the assembler's whole graph resolves child_process zero times", async () => {
  resetCpCalls()
  await import(pathToFileURL(ENTRY).href)
  await import(
    pathToFileURL(path.join(ROOT, "scripts", "documents", "keyword-plan.mjs"))
      .href
  )
  assert.deepEqual(
    cpCalls(),
    [],
    "something in the assembler's graph imports child_process",
  )
})

test("a full assembly spawns nothing and fetches nothing", async () => {
  const { assembleResume } = await import(pathToFileURL(ENTRY).href)
  const { buildPlan } = await import(
    pathToFileURL(path.join(ROOT, "scripts", "documents", "keyword-plan.mjs"))
      .href
  )
  resetCpCalls()
  const realFetch = globalThis.fetch
  let fetches = 0
  globalThis.fetch = (...a) => {
    fetches++
    throw new Error(`assembly attempted a fetch: ${a[0]}`)
  }
  let markdown
  try {
    const plan = buildPlan({
      job,
      profileBlob: rawProfile,
      targets: ["Developer", "Engineer"],
    })
    markdown = assembleResume({
      job,
      profile,
      answers,
      plan,
      budget: 1400,
    }).markdown
  } finally {
    globalThis.fetch = realFetch
  }
  assert.ok(markdown.startsWith("# Jane Test"))
  assert.ok(markdown.includes("<!-- fact:"))
  assert.equal(fetches, 0)
  assert.deepEqual(cpCalls(), [], "the assembly reached child_process")
})

test("the spawn counter is wired — a real spawn is counted", async () => {
  resetCpCalls()
  const { spawnSync } = await import("node:child_process")
  spawnSync(process.execPath, ["-e", "0"])
  const events = cpCalls()
  assert.ok(
    events.some((e) => e.kind === "call" && e.fn === "spawnSync"),
    `the shim did not intercept: ${JSON.stringify(events)}`,
  )
  resetCpCalls()
})
