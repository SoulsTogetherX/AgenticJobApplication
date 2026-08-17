import test from "node:test"
import assert from "node:assert/strict"
import {
  scoreBoard,
  mapPool,
  proposeRemovals,
} from "../../scripts/leads/board-yield.mjs"

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

// --- proposeRemovals: the history-driven prune proposal (P6) -----------------

const HNOW = new Date("2026-08-17T00:00:00Z")
const board = (over = {}) => ({
  board_id: "greenhouse:acme",
  company: "Acme",
  last_swept: "2026-08-17T00:00:00Z",
  leads_produced: 0,
  last_qualifying_at: null,
  sweeps: 1,
  zero_streak: 0,
  ...over,
})

test("proposeRemovals fires on a long dry streak", () => {
  const out = proposeRemovals([board({ zero_streak: 5, sweeps: 9 })], {
    now: HNOW,
  })
  assert.equal(out.length, 1)
  assert.match(out[0].reasons[0], /5 consecutive sweeps/)
})

test("proposeRemovals fires on a board that has never yielded", () => {
  // Streak deliberately 0 so ONLY the never-yielded rule can be what fired —
  // the rules overlap in real data and a test that lets both fire proves
  // neither.
  const out = proposeRemovals(
    [board({ sweeps: 5, zero_streak: 0, last_qualifying_at: null })],
    { now: HNOW },
  )
  assert.equal(out.length, 1)
  assert.deepEqual(out[0].reasons, [
    "never yielded a reachable posting in 5 sweeps",
  ])
})

test("proposeRemovals fires on a board whose last yield went stale", () => {
  const out = proposeRemovals(
    [
      board({
        leads_produced: 40,
        last_qualifying_at: "2026-06-01T00:00:00Z",
        sweeps: 2,
        zero_streak: 2,
      }),
    ],
    { now: HNOW },
  )
  assert.equal(out.length, 1)
  assert.match(out[0].reasons[0], /last reachable posting 77d ago/)
})

test("proposeRemovals spares a board that recently yielded", () => {
  const out = proposeRemovals(
    [
      board({
        leads_produced: 12,
        last_qualifying_at: "2026-08-16T00:00:00Z",
        sweeps: 30,
        zero_streak: 1,
      }),
    ],
    { now: HNOW },
  )
  assert.deepEqual(out, [], "one dry sweep after a yield is not a dead board")
})

test("proposeRemovals spares a board with no counted history yet", () => {
  // The healed shape: swept for weeks, counters NULL. Reading NULL as 0 sweeps
  // would be a claim about history nobody recorded, and the never-yielded rule
  // would then condemn every board in the file on the first run after the
  // migration.
  const out = proposeRemovals(
    [board({ sweeps: null, zero_streak: null, last_qualifying_at: null })],
    { now: HNOW },
  )
  assert.deepEqual(out, [])
})

test("proposeRemovals ignores an unparseable last_qualifying_at", () => {
  // NaN > deadDays is false, so a corrupt timestamp proposes nothing rather
  // than proposing everything.
  const out = proposeRemovals(
    [board({ last_qualifying_at: "not-a-date", sweeps: 2, zero_streak: 0 })],
    { now: HNOW },
  )
  assert.deepEqual(out, [])
})

test("proposeRemovals thresholds are caller-supplied", () => {
  const rows = [board({ sweeps: 3, zero_streak: 3 })]
  assert.equal(proposeRemovals(rows, { now: HNOW }).length, 0)
  assert.equal(
    proposeRemovals(rows, { now: HNOW, zeroStreak: 3 }).length,
    1,
    "a tighter threshold must be able to fire",
  )
})
