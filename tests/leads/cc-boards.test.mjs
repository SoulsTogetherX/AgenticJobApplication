// cc-boards turns Common Crawl's CDX index into board CANDIDATES. The tests
// that matter most: resume must never refetch a done page (the index sheds
// load with 5xx, and refetching is how a polite client turns impolite), and
// the output must be exactly what discover-boards.mjs consumes, deduped
// against boards already swept. All index traffic in these tests runs through
// a stubbed fetch and a no-op politeness sleep — no network, no real seconds.
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  HOSTS,
  slugFromUrl,
  foldPage,
  companyFromSlug,
  buildCandidates,
  loadState,
  saveState,
  enumerateHost,
} from "../../src/leads/cc-boards.mjs"
import { setPolitenessClock, resetHostGates } from "#lib/lib.mjs"

// --- pure: slug extraction -------------------------------------------------

test("slugFromUrl takes the first path segment, decoded", () => {
  assert.equal(slugFromUrl("https://jobs.ashbyhq.com/openai"), "openai")
  assert.equal(
    slugFromUrl("https://jobs.ashbyhq.com/My%20Company/1554-abc?utm=x"),
    "My Company",
  )
  assert.equal(
    slugFromUrl("https://boards.greenhouse.io/acme/jobs/123"),
    "acme",
  )
})

test("slugFromUrl drops routes, assets and junk rather than proposing them", () => {
  assert.equal(
    slugFromUrl("https://boards.greenhouse.io/embed/job_board?for=acme"),
    null,
    "embed is a route; the org appears via its direct board URL",
  )
  assert.equal(slugFromUrl("https://jobs.ashbyhq.com/api/whatever"), null)
  assert.equal(slugFromUrl("https://jobs.ashbyhq.com/favicon.ico"), null)
  assert.equal(slugFromUrl("https://jobs.ashbyhq.com/"), null, "bare host")
  assert.equal(slugFromUrl("https://jobs.ashbyhq.com/x"), null, "too short")
  assert.equal(slugFromUrl("not a url"), null)
})

// --- pure: page folding ----------------------------------------------------

const line = (url, status = "200") => JSON.stringify({ url, status })

test("foldPage counts 2xx/3xx captures and skips 4xx and garbage", () => {
  const counts = {}
  const folded = foldPage(
    counts,
    [
      line("https://jobs.ashbyhq.com/acme"),
      line("https://jobs.ashbyhq.com/acme/posting-1", "301"),
      line("https://jobs.ashbyhq.com/dead", "404"),
      "not json at all",
      line("https://jobs.ashbyhq.com/api/x"),
      "",
    ].join("\n"),
  )
  assert.equal(folded, 2)
  assert.equal(counts.acme.seen, 2)
  assert.equal(counts.dead, undefined, "a 404-only slug is a dead board")
})

test("foldPage merges case variants under the first spelling seen", () => {
  const counts = {}
  foldPage(
    counts,
    [
      line("https://jobs.ashbyhq.com/OpenAI"),
      line("https://jobs.ashbyhq.com/openai"),
      line("https://jobs.ashbyhq.com/OPENAI"),
    ].join("\n"),
  )
  assert.equal(Object.keys(counts).length, 1)
  assert.equal(counts.openai.slug, "OpenAI")
  assert.equal(counts.openai.seen, 3)
})

// --- pure: candidates doc --------------------------------------------------

test("companyFromSlug prettifies without inventing case", () => {
  assert.equal(companyFromSlug("acme-widgets"), "Acme Widgets")
  assert.equal(companyFromSlug("OpenAI"), "OpenAI")
  assert.equal(companyFromSlug("my_company.io"), "My Company Io")
})

test("buildCandidates emits the discover-boards shape, deduped and ranked", () => {
  const counts = {
    acme: { slug: "acme", seen: 5 },
    zeta: { slug: "zeta", seen: 9 },
    beta: { slug: "beta", seen: 5 },
    tracked: { slug: "tracked", seen: 99 },
  }
  const doc = buildCandidates(
    "greenhouse",
    counts,
    new Set(["greenhouse:tracked"]),
  )
  assert.deepEqual(
    doc.candidates.map((c) => c.slug),
    ["zeta", "acme", "beta"],
    "seen desc, then slug for a deterministic file",
  )
  for (const c of doc.candidates) {
    assert.equal(c.type, "greenhouse")
    assert.equal(c.pool, "cc")
    assert.ok(c.company)
    assert.ok(Number.isInteger(c.seen))
  }
  assert.ok(
    !doc.candidates.some((c) => c.slug === "tracked"),
    "a board already swept must not be re-proposed",
  )
})

// --- enumerate + resume ----------------------------------------------------

const CRAWL = "CC-MAIN-2026-30"

function cdxStub(handler) {
  const original = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url) => {
    const u = String(url)
    calls.push(u)
    const res = handler(u)
    return {
      ok: res.status ? res.status >= 200 && res.status < 300 : true,
      status: res.status ?? 200,
      headers: { get: () => null },
      json: async () => res.body,
      text: async () =>
        typeof res.body === "string" ? res.body : JSON.stringify(res.body),
    }
  }
  return { calls, restore: () => (globalThis.fetch = original) }
}

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aj-cc-boards-"))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

function quietPoliteness(t) {
  // Politeness stays ON (the gate code runs); only its sleeps become no-ops
  // so index.commoncrawl.org's 1s spacing costs the suite nothing.
  const restore = setPolitenessClock({ sleep: async () => {} })
  resetHostGates()
  t.after(() => {
    restore()
    resetHostGates()
  })
}

const pageUrl = (n) => `&page=${n}`

test("enumerateHost fetches every page once and a re-run fetches nothing", async (t) => {
  quietPoliteness(t)
  const dir = tempDir(t)
  const stub = cdxStub((u) =>
    u.includes("showNumPages")
      ? { body: { pages: 2, pageSize: 5, blocks: 8 } }
      : { body: line(`https://jobs.ashbyhq.com/slug${u.at(-1)}`) },
  )
  t.after(stub.restore)

  const r1 = await enumerateHost({
    crawl: CRAWL,
    hostKey: "ashby",
    stateDir: dir,
  })
  assert.equal(r1.fetched, 2)
  assert.equal(r1.remaining, 0)
  assert.equal(Object.keys(r1.state.counts).length, 2)

  const callsBefore = stub.calls.length
  const r2 = await enumerateHost({
    crawl: CRAWL,
    hostKey: "ashby",
    stateDir: dir,
  })
  assert.equal(r2.fetched, 0, "resume must refetch nothing")
  assert.equal(
    stub.calls.length,
    callsBefore,
    "not even showNumPages — the count is in state",
  )
  assert.equal(Object.keys(r2.state.counts).length, 2, "counts survive resume")
})

test("--max-pages slices the run and the next run picks up the rest", async (t) => {
  quietPoliteness(t)
  const dir = tempDir(t)
  const stub = cdxStub((u) =>
    u.includes("showNumPages")
      ? { body: { pages: 3 } }
      : { body: line("https://jobs.ashbyhq.com/acme") },
  )
  t.after(stub.restore)

  const r1 = await enumerateHost({
    crawl: CRAWL,
    hostKey: "ashby",
    stateDir: dir,
    maxPages: 1,
  })
  assert.equal(r1.fetched, 1)
  assert.equal(r1.remaining, 2)

  const r2 = await enumerateHost({
    crawl: CRAWL,
    hostKey: "ashby",
    stateDir: dir,
  })
  assert.equal(r2.fetched, 2)
  assert.equal(r2.remaining, 0)
  assert.equal(r2.state.counts.acme.seen, 3)
})

test("greenhouse folds both hosts' patterns into one candidates pool", async (t) => {
  quietPoliteness(t)
  const dir = tempDir(t)
  const stub = cdxStub((u) => {
    if (u.includes("showNumPages")) return { body: { pages: 1 } }
    return u.includes(encodeURIComponent("job-boards.greenhouse.io"))
      ? { body: line("https://job-boards.greenhouse.io/acme/jobs/1") }
      : { body: line("https://boards.greenhouse.io/acme") }
  })
  t.after(stub.restore)

  const r = await enumerateHost({
    crawl: CRAWL,
    hostKey: "greenhouse",
    stateDir: dir,
  })
  assert.equal(r.fetched, 2)
  assert.equal(r.state.counts.acme.seen, 2, "one company, seen on both hosts")
  assert.equal(HOSTS.greenhouse.patterns.length, 2)
})

test("an index 429/503 surfaces AND leaves the run resumable", async (t) => {
  quietPoliteness(t)
  const dir = tempDir(t)
  let healthy = false
  const stub = cdxStub((u) => {
    if (u.includes("showNumPages")) return { body: { pages: 2 } }
    if (u.includes(pageUrl(1)) && !healthy) return { status: 503, body: "" }
    return { body: line("https://jobs.ashbyhq.com/acme") }
  })
  t.after(stub.restore)

  await assert.rejects(
    enumerateHost({ crawl: CRAWL, hostKey: "ashby", stateDir: dir }),
    /HTTP 503/,
    "the refusal must surface, not vanish",
  )
  const saved = loadState(dir, CRAWL, "ashby")
  assert.deepEqual(
    saved.patterns["jobs.ashbyhq.com/*"].done,
    [0],
    "the completed page is banked before the error propagates",
  )

  healthy = true
  const callsBefore = stub.calls.length
  const r = await enumerateHost({
    crawl: CRAWL,
    hostKey: "ashby",
    stateDir: dir,
  })
  assert.equal(r.fetched, 1, "resume fetches only the failed page")
  assert.equal(r.remaining, 0)
  assert.equal(
    stub.calls.slice(callsBefore).filter((u) => u.includes(pageUrl(0))).length,
    0,
    "page 0 is never refetched",
  )
})

test("state survives only for its own crawl+host identity", async (t) => {
  const dir = tempDir(t)
  saveState(dir, {
    crawl: CRAWL,
    hostKey: "ashby",
    patterns: { "jobs.ashbyhq.com/*": { pages: 1, done: [0] } },
    counts: { acme: { slug: "acme", seen: 1 } },
  })
  const same = loadState(dir, CRAWL, "ashby")
  assert.equal(same.counts.acme.seen, 1)
  const other = loadState(dir, "CC-MAIN-2026-25", "ashby")
  assert.deepEqual(other.counts, {}, "a different crawl starts clean")
})
