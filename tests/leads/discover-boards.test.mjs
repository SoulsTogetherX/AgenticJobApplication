import test from "node:test"
import assert from "node:assert/strict"
import {
  postsBelowSenior,
  evaluateCandidate,
  POOLS,
} from "../../src/leads/discover-boards.mjs"

const NOW = new Date("2026-07-29T12:00:00Z")

const LIMITS = {
  location: {
    base: "North Las Vegas, NV",
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

const CANDIDATE = { type: "greenhouse", slug: "acme", company: "Acme" }
const post = (over = {}) => ({
  title: "Software Engineer",
  location: "Remote (US)",
  posted_at: "2026-07-25T00:00:00Z",
  ...over,
})

test("postsBelowSenior detects level-I/II and junior titles", () => {
  assert.equal(
    postsBelowSenior([post({ title: "Software Engineer II" })]),
    true,
  )
  assert.equal(postsBelowSenior([post({ title: "Junior Developer" })]), true)
  assert.equal(postsBelowSenior([post({ title: "Associate Engineer" })]), true)
  assert.equal(postsBelowSenior([post({ title: "New Grad Engineer" })]), true)
  // A board that only ever posts Senior+ cannot yield for this profile.
  assert.equal(
    postsBelowSenior([
      post({ title: "Senior Software Engineer" }),
      post({ title: "Staff Software Engineer" }),
    ]),
    false,
  )
  assert.equal(postsBelowSenior([]), false)
})

test("a candidate with a reachable posting clears the bar", () => {
  const r = evaluateCandidate(
    CANDIDATE,
    [
      post({ title: "Software Engineer II" }),
      post({ title: "Senior Software Engineer" }),
    ],
    LIMITS,
    NOW,
  )
  assert.equal(r.live, 2)
  assert.equal(r.solid, 1)
  assert.equal(r.hard_filtered, 1)
  assert.equal(r.posts_below_senior, true)
  assert.equal(r.company, "Acme")
})

test("a senior-only board yields nothing and is not proposed", () => {
  // This is the shape of the 28 dead boards found on 2026-07-28: plenty of
  // live postings, every one above the bar.
  const r = evaluateCandidate(
    CANDIDATE,
    [
      post({ title: "Senior Software Engineer" }),
      post({ title: "Staff Software Engineer" }),
      post({ title: "Principal Software Engineer" }),
    ],
    LIMITS,
    NOW,
  )
  assert.equal(r.solid, 0)
  assert.equal(r.yield, 0)
  assert.equal(r.hard_filtered, 3)
  assert.equal(r.posts_below_senior, false)
})

test("an office-city posting flagged remote does not count as reachable", () => {
  // OpenAI and Ramp both looked productive this way until yield was measured
  // on confirmed locations only.
  const r = evaluateCandidate(
    CANDIDATE,
    [post({ location: "San Francisco", remote: true })],
    LIMITS,
    NOW,
  )
  assert.equal(r.qualifying, 1)
  assert.equal(r.solid, 0, "unconfirmed location must not count")
})

test("a Las Vegas on-site posting counts — the local pool's whole point", () => {
  const r = evaluateCandidate(
    { ...CANDIDATE, pool: "local" },
    [post({ location: "Las Vegas, NV", title: "Software Engineer II" })],
    LIMITS,
    NOW,
  )
  assert.equal(r.solid, 1)
  assert.equal(r.pool, "local")
})

test("an empty board is rejected rather than crashing on a zero divisor", () => {
  const r = evaluateCandidate(CANDIDATE, [], LIMITS, NOW)
  assert.equal(r.live, 0)
  assert.equal(r.solid, 0)
  assert.equal(r.yield, 0)
})

test("the documented candidate pools stay in priority order", () => {
  assert.deepEqual(POOLS, ["local", "levelled", "remote"])
})
