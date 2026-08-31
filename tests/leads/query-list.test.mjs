// A query LIST for server-filtered boards.
//
// Why this file exists: Workday is the one fetcher of thirteen where the query
// is a server-side filter, so the sweep's single "full stack" returned 2 of
// Aristocrat's 178 postings and 0 of the Las Vegas Valley Water District's 10
// (measured 2026-08-13). The union path below is what makes the rest of those
// boards visible. The tests that matter most here are the NEGATIVE ones: a
// scalar must still take the original single-fetch path, and a non-Workday
// board must never be re-fetched per query, because that would multiply every
// sweep by the length of the list for no new postings.
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import {
  fetchBoard,
  parseQueries,
  DEFAULT_SEARCH_QUERY,
} from "../../src/leads/find-jobs.mjs"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")

// --- parseQueries ----------------------------------------------------------

test("parseQueries keeps a single query a scalar, not a one-element list", () => {
  // Load-bearing: a scalar is what routes to the untouched single-fetch path.
  assert.equal(parseQueries("full stack"), "full stack")
  assert.equal(parseQueries(["full stack"]), "full stack")
  assert.equal(parseQueries("  full stack  "), "full stack")
})

test("parseQueries splits a comma string and accepts a YAML list", () => {
  assert.deepEqual(parseQueries("full stack, developer,  game "), [
    "full stack",
    "developer",
    "game",
  ])
  assert.deepEqual(parseQueries(["developer", "game mathematician"]), [
    "developer",
    "game mathematician",
  ])
})

test("parseQueries returns null for absent or empty input so ?? falls through", () => {
  // getFlag yields null when the flag is missing and `true` when it is passed
  // with no value; neither may be mistaken for a real query.
  assert.equal(parseQueries(null), null)
  assert.equal(parseQueries(undefined), null)
  assert.equal(parseQueries(true), null)
  assert.equal(parseQueries(""), null)
  assert.equal(parseQueries("   "), null)
  assert.equal(parseQueries([]), null)
  assert.equal(parseQueries(["", "  "]), null)
})

// --- fetchBoard dispatch ---------------------------------------------------

// A fake board type is not available (BOARD_FETCHERS is module-private), so
// these drive the real dispatch through a stubbed global fetch and count calls.
function stubFetch(handler) {
  const original = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({
      url: String(url),
      body: init?.body ? JSON.parse(init.body) : null,
    })
    return handler(String(url), init, calls.length)
  }
  return {
    calls,
    restore: () => {
      globalThis.fetch = original
    },
  }
}

const jsonResponse = (payload) => ({
  ok: true,
  status: 200,
  json: async () => payload,
  text: async () => JSON.stringify(payload),
})

const workdayBoard = {
  type: "workday",
  company: "Test Water District",
  host: "example.wd1.myworkdayjobs.com",
  tenant: "example",
  site: "TestJobs",
}

const posting = (id, title) => ({
  title,
  externalPath: `/job/${id}`,
  bulletFields: [id],
  locationsText: "Las Vegas",
  postedOn: "Posted Today",
})

test("a query LIST unions a server-filtered board's results and dedupes", async () => {
  // The real defect, in miniature: "full stack" finds nothing, "developer"
  // finds the Applications Developer, and the shared row appears once.
  const byQuery = {
    "full stack": [],
    developer: [
      posting("R1", "Applications Developer"),
      posting("R2", "Shared"),
    ],
    "game mathematician": [
      posting("R2", "Shared"),
      posting("R3", "Mathematician"),
    ],
  }
  const stub = stubFetch((_url, init) => {
    const q = JSON.parse(init.body).searchText
    return jsonResponse({ total: byQuery[q].length, jobPostings: byQuery[q] })
  })
  try {
    const jobs = await fetchBoard(workdayBoard, [
      "full stack",
      "developer",
      "game mathematician",
    ])
    assert.equal(stub.calls.length, 3, "one fetch per query")
    assert.deepEqual(
      jobs.map((j) => j.title).sort(),
      ["Applications Developer", "Mathematician", "Shared"],
      "union of all queries, each posting once",
    )
    assert.deepEqual(
      stub.calls.map((c) => c.body.searchText),
      ["full stack", "developer", "game mathematician"],
      "each query is asked verbatim",
    )
  } finally {
    stub.restore()
  }
})

test("a NON-server-filtered board is fetched ONCE even when given a list", async () => {
  // Greenhouse returns the whole board and the gates filter locally, so
  // re-asking per query is pure waste. This is the cost guard.
  const stub = stubFetch(() => jsonResponse({ jobs: [] }))
  try {
    await fetchBoard({ type: "greenhouse", slug: "acme", company: "Acme" }, [
      "full stack",
      "developer",
      "game",
    ])
    assert.equal(
      stub.calls.length,
      1,
      "list must not multiply a local-filter board",
    )
  } finally {
    stub.restore()
  }
})

test("a scalar query takes the original single-fetch path unchanged", async () => {
  const stub = stubFetch((_url, init) =>
    jsonResponse({ total: 1, jobPostings: [posting("R1", "Only")] }),
  )
  try {
    const jobs = await fetchBoard(workdayBoard, "full stack")
    assert.equal(stub.calls.length, 1)
    assert.equal(stub.calls[0].body.searchText, "full stack")
    assert.equal(jobs.length, 1)
  } finally {
    stub.restore()
  }
})

test("an empty list still fetches once, with the canonical default", async () => {
  // Failing to an empty sweep would be silent: zero leads reads as "nothing
  // was posted today", which is the failure mode this whole area already had.
  const stub = stubFetch(() => jsonResponse({ total: 0, jobPostings: [] }))
  try {
    await fetchBoard(workdayBoard, [])
    assert.equal(stub.calls.length, 1)
    assert.equal(stub.calls[0].body.searchText, DEFAULT_SEARCH_QUERY)
  } finally {
    stub.restore()
  }
})

test("an unknown board type still throws before any query handling", async () => {
  await assert.rejects(
    () => fetchBoard({ type: "not-an-ats", slug: "x" }, ["a", "b"]),
    /unknown board type/,
  )
})

// --- wiring ----------------------------------------------------------------

test("HN and Adzuna receive the primary query, never the list", () => {
  // Adzuna is credentialed and rate-limited; a list must not silently multiply
  // billed calls as a side effect of unblocking Workday.
  const src = fs.readFileSync(
    path.join(ROOT, "src", "leads", "find-jobs.mjs"),
    "utf8",
  )
  assert.match(src, /fetchHackerNews\(primaryQuery\)/)
  assert.match(src, /fetchAdzuna\(primaryQuery, limits\)/)
  assert.match(src, /const primaryQuery = Array\.isArray\(query\)/)
})

test("workday is the only server-filtered type", () => {
  // If a second fetcher ever gains a server-side query, it must be added to
  // SERVER_FILTERED_TYPES or a list will silently under-read it.
  const src = fs.readFileSync(
    path.join(ROOT, "src", "leads", "find-jobs.mjs"),
    "utf8",
  )
  const m = src.match(/const SERVER_FILTERED_TYPES = new Set\(\[([^\]]*)\]\)/)
  assert.ok(m, "SERVER_FILTERED_TYPES must exist")
  assert.deepEqual(
    m[1]
      .split(",")
      .map((s) => s.trim().replace(/["']/g, ""))
      .filter(Boolean),
    ["workday"],
  )
})
