import test from "node:test"
import assert from "node:assert/strict"
import { scoreBoard, mapPool } from "../../scripts/leads/board-yield.mjs"

const NOW = new Date("2026-07-28T12:00:00Z")

const LIMITS = {
  location: {
    base: "North Las Vegas, NV",
    relocation: false,
    remote_ok: true,
    onsite_allowed: ["north las vegas", "las vegas", "henderson"],
  },
  freshness: { max_age_days: 30 },
  roles: {
    title_keywords: ["full stack", "software engineer", "backend"],
    hard_filter: ["senior", "staff", "principal"],
    soft_filter: ["ii"],
  },
}

const BOARD = { type: "greenhouse", slug: "acme", company: "Acme" }
const posting = (over = {}) => ({
  title: "Software Engineer",
  location: "Remote (US)",
  posted_at: "2026-07-20T00:00:00Z",
  ...over,
})

test("scoreBoard counts reachable postings and explains the rest", () => {
  const r = scoreBoard(
    BOARD,
    [
      posting(),
      posting({ title: "Senior Software Engineer" }),
      posting({ title: "Staff Software Engineer" }),
      posting({ title: "Software Engineer", location: "Dublin, Ireland" }),
      posting({ title: "Warehouse Associate" }),
    ],
    LIMITS,
    NOW,
  )
  assert.equal(r.live, 5)
  assert.equal(r.solid, 1)
  assert.equal(r.hard_filtered, 2, "Senior + Staff")
  assert.equal(r.location, 1, "Dublin")
  assert.equal(r.title, 1, "Warehouse Associate")
  assert.equal(r.yield, 20)
  assert.equal(r.company, "Acme")
})

test("an unverified-remote posting counts as qualifying but NOT as reachable", () => {
  // The reason this split exists: on 2026-07-28 every "remote" posting that
  // carried an office city (OpenAI, Ramp) turned out to be Hybrid SF/NYC — a
  // relocation. Counting those as yield made office-bound boards look
  // productive and put OpenAI top of the ranking on nothing real.
  const r = scoreBoard(
    BOARD,
    [posting({ location: "San Francisco", remote: true })],
    LIMITS,
    NOW,
  )
  assert.equal(r.qualifying, 1, "passesLimits lets it through as a flag")
  assert.equal(r.solid, 0, "but it is not confirmed reachable")
  assert.equal(r.yield, 0, "yield must be measured on confirmed postings")
})

test("a board with no postings scores zero rather than dividing by zero", () => {
  const r = scoreBoard(BOARD, [], LIMITS, NOW)
  assert.equal(r.live, 0)
  assert.equal(r.solid, 0)
  assert.equal(r.yield, 0)
})

test("a Las Vegas on-site posting is reachable", () => {
  const r = scoreBoard(
    BOARD,
    [posting({ location: "Las Vegas, NV" })],
    LIMITS,
    NOW,
  )
  assert.equal(r.solid, 1)
})

test("mapPool preserves input order and respects the concurrency cap", async () => {
  let inFlight = 0
  let peak = 0
  const items = Array.from({ length: 20 }, (_, i) => i)
  const out = await mapPool(items, 4, async (n) => {
    inFlight++
    peak = Math.max(peak, inFlight)
    await new Promise((r) => setTimeout(r, 1))
    inFlight--
    return n * 2
  })
  assert.deepEqual(
    out,
    items.map((n) => n * 2),
  )
  assert.ok(peak <= 4, `concurrency exceeded: ${peak}`)
})

test("mapPool handles an empty list without hanging", async () => {
  assert.deepEqual(await mapPool([], 4, async () => 1), [])
})
