// loadKeywordIndex — a failed read is not an empty index.
//
// MEASURED 2026-08-24, in TWO places at once. `gate-audit.mjs` and
// `screen.mjs` each opened the store inside a bare `catch {}`, so a locked or
// corrupt database left an empty Map, every lead was scored WITHOUT keywords,
// and the degraded result was then PERSISTED — to `jobs/.gate-baseline.json`,
// the file every future gate change is diffed against, and to the `screens`
// table, which is what the unattended runner reads as screening evidence when
// no model verdict exists.
//
// The distinction this helper exists to preserve is "no keywords" vs "could not
// find out". Only the second one must stop a write.
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { openDb, loadKeywordIndex } from "../../src/lib/db.mjs"

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
)

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kwidx-"))
  t.after(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // A leaked handle must not fail a passing assertion — the repo idiom
      // (see tests/auto/job.test.mjs). On Windows a connection that threw
      // during open can hold the file briefly after close(), and the corrupt
      // -store case below hits exactly that.
    }
  })
  return dir
}

test("a healthy store yields its keywords and NO error", (t) => {
  const dir = tmp(t)
  const file = path.join(dir, "leads.db")
  const db = openDb(file)
  db.prepare(
    "INSERT INTO lead_keywords (lead_id, keyword) VALUES ('lead-1', 'python')",
  ).run()
  db.prepare(
    "INSERT INTO lead_keywords (lead_id, keyword) VALUES ('lead-1', 'aws')",
  ).run()
  db.close()

  const { keywords, error } = loadKeywordIndex(file)
  assert.equal(error, null)
  assert.deepEqual([...(keywords.get("lead-1") ?? [])].sort(), [
    "aws",
    "python",
  ])
})

test("an EMPTY index is not an error — that is the ordinary new-store case", (t) => {
  const dir = tmp(t)
  const file = path.join(dir, "leads.db")
  openDb(file).close()
  const { keywords, error } = loadKeywordIndex(file)
  assert.equal(error, null, "an empty table must not suppress a write")
  assert.equal(keywords.size, 0)
})

test("A CORRUPT STORE REPORTS AN ERROR, not an empty index", (t) => {
  // The whole point. Before this, both callers saw exactly what they would have
  // seen for a store with no keywords in it, and wrote their results anyway.
  const dir = tmp(t)
  const file = path.join(dir, "leads.db")
  fs.writeFileSync(file, "this is definitely not a sqlite database\n")
  const { keywords, error } = loadKeywordIndex(file)
  assert.ok(error, "a file that is not a database must report an error")
  assert.match(error, /not a database/)
  assert.equal(keywords.size, 0)
})

test("a non-.db path is not a failure — a JSON store simply has no index", (t) => {
  const dir = tmp(t)
  const file = path.join(dir, "leads.json")
  fs.writeFileSync(file, "{}")
  const { keywords, error } = loadKeywordIndex(file)
  assert.equal(error, null)
  assert.equal(keywords.size, 0)
})

test("a path that does not exist yet is CREATED, and that is not an error", (t) => {
  // Asserted because it is the surprising half: openDb mkdirs and SQLite
  // creates the file, so a first run against a fresh store reports no error and
  // an empty index — which is right. Only a store that exists and cannot be
  // READ may suppress a write; "there is nothing here yet" must not.
  const dir = tmp(t)
  const file = path.join(dir, "nope", "leads.db")
  const { keywords, error } = loadKeywordIndex(file)
  assert.equal(error, null)
  assert.equal(keywords.size, 0)
  assert.ok(fs.existsSync(file), "the store is created, not merely missing")
})

// --- the callers actually honour it ------------------------------------------
//
// Read off the source rather than asserted in prose. Both writes are the ones
// that made the bare `catch {}` dangerous, and a future edit that drops the
// guard must fail here rather than in production.

test("gate-audit does not write its baseline when the index failed", () => {
  const src = fs.readFileSync(
    path.join(ROOT, "src", "leads", "gate-audit.mjs"),
    "utf8",
  )
  assert.match(
    src,
    /if \(save && !keywordError\)/,
    "the baseline write must be gated on keywordError",
  )
  // Deliberately NOT a `doesNotMatch(/catch {}/)` over the whole file: the
  // comment explaining this fix quotes the bare catch it replaced, so that
  // assertion matched its own documentation. Assert the structure instead.
  assert.doesNotMatch(
    src,
    /keywordMap\(/,
    "reading the index directly is what allowed the silent degrade",
  )
})

test("screen does not record a verdict when the index failed", () => {
  const src = fs.readFileSync(
    path.join(ROOT, "src", "leads", "screen.mjs"),
    "utf8",
  )
  assert.match(
    src,
    /if \(isDb && !noRecord && !keywordError && results\.length\)/,
    "the screens write must be gated on keywordError",
  )
})

test("neither caller opens the store for keywords itself any more", () => {
  // One helper, so the two cannot drift apart again — which is how the same
  // defect came to exist twice.
  for (const f of ["gate-audit.mjs", "screen.mjs"]) {
    const src = fs.readFileSync(path.join(ROOT, "src", "leads", f), "utf8")
    assert.match(src, /loadKeywordIndex\(/, `${f} must use the shared helper`)
    assert.doesNotMatch(
      src,
      /keywordMap\(/,
      `${f} must not call keywordMap directly`,
    )
  }
})
