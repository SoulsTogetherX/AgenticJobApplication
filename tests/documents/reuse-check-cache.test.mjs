// Phase 3 item 3.4: reuse-check.mjs's exported core, and the workspace stack
// cache that replaces a lexicon scan of every sibling on every call.
//
// tests/documents/reuse-check.test.mjs is left untouched on purpose — its four
// tests exercise the CLI's observable behaviour and their still passing is the
// evidence that the signature change did not move it. This file covers the new
// surface: the cache, its invalidation, and its failure modes.
//
// THE THING A CACHE MUST NEVER DO is answer from a stale entry. Every test
// below that could pass by accident is paired with one that changes the input
// and asserts the answer changes with it.
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import {
  stackOf,
  deriveWorkspace,
  listWorkspaces,
  rankCandidates,
  reuseCheck,
  scorePair,
  makeSha256,
  CACHE_MIN_WORKSPACES,
} from "../../scripts/documents/reuse-check.mjs"
import {
  openDb,
  readWorkspaceStacks,
  upsertWorkspaceStack,
} from "../../scripts/lib/db.mjs"

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
)
const hash = makeSha256(createHash)

const FULLSTACK = {
  company: "WidgetCo",
  title: "Full-Stack Engineer",
  description: "React and Node.js with PostgreSQL and Docker on AWS.",
  requirements: ["React", "Node.js", "PostgreSQL"],
}

function tree(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reuse-cache-"))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const add = (slug, job, tailored = true) => {
    fs.mkdirSync(path.join(dir, slug), { recursive: true })
    fs.writeFileSync(
      path.join(dir, slug, "job.json"),
      JSON.stringify({ slug, ...job }),
    )
    if (tailored)
      fs.writeFileSync(path.join(dir, slug, "resume.md"), "# tailored\n")
  }
  return { dir, add }
}

test("stackOf and scorePair are the scoring, exported and pure", () => {
  const a = deriveWorkspace("a", JSON.stringify(FULLSTACK), hash)
  const b = deriveWorkspace(
    "b",
    JSON.stringify({ ...FULLSTACK, title: "Senior Full-Stack Engineer" }),
    hash,
  )
  assert.deepEqual([...stackOf(FULLSTACK)].sort(), [
    "AWS",
    "Docker",
    "Node.js",
    "PostgreSQL",
    "React",
  ])
  assert.equal(scorePair(a, b).score, 1)
  const far = deriveWorkspace(
    "c",
    JSON.stringify({
      title: "Machine Learning Researcher",
      description: "Python research work.",
      requirements: ["Python"],
    }),
    hash,
  )
  assert.ok(scorePair(a, far).score < 0.4)
})

test("no hash function means no hashing at all", () => {
  const w = deriveWorkspace("a", JSON.stringify(FULLSTACK))
  assert.equal(w.job_sha256, null)
  assert.ok(w.stack.size > 0)
})

test("listWorkspaces returns only siblings that have BOTH files", (t) => {
  const { dir, add } = tree(t)
  add("self", FULLSTACK)
  add("tailored", FULLSTACK)
  add("scanned-only", FULLSTACK, false)
  fs.mkdirSync(path.join(dir, "empty-dir"))
  assert.deepEqual(
    listWorkspaces(dir, "self").map((w) => w.slug),
    ["tailored"],
  )
  assert.deepEqual(listWorkspaces(path.join(dir, "nope"), "self"), [])
})

test("a cache hit produces the same ranking as a cold scan", (t) => {
  const { dir, add } = tree(t)
  add("self", { ...FULLSTACK, company: "SelfCo" })
  add("near", FULLSTACK)
  add("far", {
    company: "DataCo",
    title: "Machine Learning Researcher",
    description: "Python research work.",
    requirements: ["Python"],
  })

  const cold = reuseCheck({ dir, slug: "self", hash })
  const cache = new Map()
  reuseCheck({
    dir,
    slug: "self",
    hash,
    onComputed: (w) => cache.set(w.slug, w),
  })
  const warm = reuseCheck({ dir, slug: "self", hash, cache })

  assert.equal(warm.cache_hits, 2)
  assert.equal(warm.cache_misses, 0)
  assert.equal(cold.cache_hits, 0)
  assert.deepEqual(warm.ranked, cold.ranked)
  assert.equal(warm.verdict, cold.verdict)
})

test("editing a posting invalidates its cached row", (t) => {
  const { dir, add } = tree(t)
  add("self", { ...FULLSTACK, company: "SelfCo" })
  add("other", FULLSTACK)

  const cache = new Map()
  reuseCheck({
    dir,
    slug: "self",
    hash,
    onComputed: (w) => cache.set(w.slug, w),
  })
  const before = reuseCheck({ dir, slug: "self", hash, cache })
  assert.equal(before.ranked[0].score, 1)
  assert.equal(before.cache_hits, 1)

  // Rewrite the sibling into an entirely different job. A cache that answered
  // from the old row would still report a perfect match.
  fs.writeFileSync(
    path.join(dir, "other", "job.json"),
    JSON.stringify({
      slug: "other",
      company: "DataCo",
      title: "Machine Learning Researcher",
      description: "Python research work.",
      requirements: ["Python"],
    }),
  )
  const after = reuseCheck({ dir, slug: "self", hash, cache })
  assert.equal(after.cache_hits, 0, "a stale row was believed")
  assert.equal(after.cache_misses, 1)
  assert.ok(after.ranked[0].score < 0.4, `stale score ${after.ranked[0].score}`)
  assert.equal(after.verdict, "TAILOR")
})

test("a cache without hashes is never trusted", (t) => {
  const { dir, add } = tree(t)
  add("self", { ...FULLSTACK, company: "SelfCo" })
  add("other", FULLSTACK)
  const cache = new Map([
    [
      "other",
      { job_sha256: "deadbeef", stack: new Set(), title_toks: new Set() },
    ],
  ])
  // No hash function -> the row cannot be matched -> recompute, not believe.
  const r = reuseCheck({ dir, slug: "self", cache })
  assert.equal(r.cache_hits, 0)
  assert.equal(r.ranked[0].score, 1)
})

test("the DB round-trips a stack and keys it on the posting's bytes", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reuse-db-"))
  const db = openDb(path.join(dir, "t.db"))
  // Close BEFORE the rm: t.after hooks run in registration order, and on
  // win32 an open sqlite handle keeps a lock that turns the rm into EPERM.
  t.after(() => db.close())
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))

  const w = deriveWorkspace("acme", JSON.stringify(FULLSTACK), hash)
  upsertWorkspaceStack(db, w)
  const back = readWorkspaceStacks(db)
  assert.equal(back.size, 1)
  assert.equal(back.get("acme").job_sha256, w.job_sha256)
  assert.deepEqual([...back.get("acme").stack].sort(), [...w.stack].sort())
  assert.deepEqual(
    [...back.get("acme").title_toks].sort(),
    [...w.title_toks].sort(),
  )

  // Upsert, not insert: one row per slug, and the newer bytes win.
  const w2 = deriveWorkspace(
    "acme",
    JSON.stringify({ ...FULLSTACK, description: "Go and Kafka." }),
    hash,
  )
  upsertWorkspaceStack(db, w2)
  const back2 = readWorkspaceStacks(db)
  assert.equal(back2.size, 1)
  assert.notEqual(back2.get("acme").job_sha256, w.job_sha256)
  assert.ok(back2.get("acme").stack.has("Kafka"))

  assert.throws(() => upsertWorkspaceStack(db, { slug: "x" }), /job_sha256/)
  assert.throws(() => upsertWorkspaceStack(db, {}), /slug/)
})

test("an unreadable cache row degrades to a recompute, never a crash", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reuse-db2-"))
  const db = openDb(path.join(dir, "t.db"))
  // Close BEFORE the rm: t.after hooks run in registration order, and on
  // win32 an open sqlite handle keeps a lock that turns the rm into EPERM.
  t.after(() => db.close())
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  db.prepare(
    `INSERT INTO workspace_stacks (slug, job_sha256, title, company, stack, title_toks, updated_at)
     VALUES ('broken','abc','t','c','{not json','[]','now')`,
  ).run()
  const back = readWorkspaceStacks(db)
  assert.equal(back.has("broken"), false)
})

// --- CLI --------------------------------------------------------------------

function cli(args) {
  return spawnSync(
    process.execPath,
    [path.join(ROOT, "scripts", "documents", "reuse-check.mjs"), ...args],
    { cwd: ROOT, encoding: "utf8" },
  )
}

test("--cache on fills the store, and the next run reads it", (t) => {
  const { dir, add } = tree(t)
  add("self", { ...FULLSTACK, company: "SelfCo" })
  add("other", FULLSTACK)
  const dbFile = path.join(dir, "c.db")

  const first = cli([
    "self",
    "--dir",
    dir,
    "--json",
    "--cache",
    "on",
    "--db",
    dbFile,
  ])
  assert.equal(first.status, 0, first.stderr)
  const a = JSON.parse(first.stdout)
  assert.equal(a.cache, "on")
  assert.equal(a.cache_misses, 1)
  assert.equal(a.cache_hits, 0)

  const second = cli([
    "self",
    "--dir",
    dir,
    "--json",
    "--cache",
    "on",
    "--db",
    dbFile,
  ])
  const b = JSON.parse(second.stdout)
  assert.equal(b.cache_hits, 1)
  assert.equal(b.cache_misses, 0)
  assert.deepEqual(b.ranked, a.ranked)
})

test("--cache off never touches the store, and gives the same answer", (t) => {
  const { dir, add } = tree(t)
  add("self", { ...FULLSTACK, company: "SelfCo" })
  add("other", FULLSTACK)
  const dbFile = path.join(dir, "c.db")
  const res = cli([
    "self",
    "--dir",
    dir,
    "--json",
    "--cache",
    "off",
    "--db",
    dbFile,
  ])
  assert.equal(res.status, 0, res.stderr)
  const out = JSON.parse(res.stdout)
  assert.equal(out.cache, "off")
  assert.equal(fs.existsSync(dbFile), false, "the store was opened anyway")
  assert.equal(out.ranked[0].score, 1)
})

test("auto leaves the cache alone below the measured break-even", (t) => {
  const { dir, add } = tree(t)
  add("self", { ...FULLSTACK, company: "SelfCo" })
  add("other", FULLSTACK)
  const dbFile = path.join(dir, "c.db")
  assert.ok(CACHE_MIN_WORKSPACES > 2)
  const out = JSON.parse(
    cli(["self", "--dir", dir, "--json", "--db", dbFile]).stdout,
  )
  assert.equal(out.cache, "off")
  assert.equal(fs.existsSync(dbFile), false)
})

test("an unreachable store still produces a ranking", (t) => {
  const { dir, add } = tree(t)
  add("self", { ...FULLSTACK, company: "SelfCo" })
  add("other", FULLSTACK)
  // A directory where the database file must go: openDb cannot create it.
  const dbFile = path.join(dir, "blocked")
  fs.mkdirSync(dbFile)
  const res = cli([
    "self",
    "--dir",
    dir,
    "--json",
    "--cache",
    "on",
    "--db",
    dbFile,
  ])
  assert.equal(res.status, 0, res.stderr)
  const out = JSON.parse(res.stdout)
  assert.equal(out.cache, "unavailable")
  assert.match(res.stderr, /cache unavailable/)
  assert.equal(out.ranked[0].score, 1)
})

test("a bad --cache value is a usage error", (t) => {
  const { dir, add } = tree(t)
  add("self", FULLSTACK)
  const res = cli(["self", "--dir", dir, "--cache", "maybe"])
  assert.equal(res.status, 2)
  assert.match(res.stderr, /--cache must be/)
})

test("rankCandidates reports hits and misses so the cache can be audited", (t) => {
  const { dir, add } = tree(t)
  add("self", { ...FULLSTACK, company: "SelfCo" })
  add("a", FULLSTACK)
  add("b", FULLSTACK)
  const self = deriveWorkspace(
    "self",
    fs.readFileSync(path.join(dir, "self", "job.json"), "utf8"),
    hash,
  )
  const ws = listWorkspaces(dir, "self")
  const cache = new Map()
  rankCandidates({
    workspaces: ws,
    self,
    hash,
    onComputed: (w) => cache.set(w.slug, w),
  })
  cache.delete("b")
  const r = rankCandidates({ workspaces: ws, self, hash, cache })
  assert.equal(r.hits, 1)
  assert.equal(r.misses, 1)
  assert.equal(r.ranked.length, 2)
})
