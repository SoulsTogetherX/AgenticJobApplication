// The location gate's remote handling.
//
// Regression origin: passesLimits read `location: "USA"` as "would require
// relocating away from North Las Vegas" and rejected it. That is how every
// remote-only aggregator states US-remote, and it discarded 35/35 Remotive,
// 50/50 Jobicy and 100/100 RemoteOK postings — a false reject aimed at the
// remote roles that make up most of the reachable market.
//
// The tests that matter most here are the ones asserting a location is STILL
// rejected: widening this gate is how a Las Vegas job search quietly becomes a
// nationwide relocation search.
import test from "node:test"
import assert from "node:assert/strict"
import {
  passesLimits,
  matchesAny,
  US_WIDE_LOCATION,
} from "../../scripts/leads/find-jobs.mjs"

const LIMITS = {
  location: {
    base: "North Las Vegas, NV",
    remote_ok: true,
    onsite_allowed: ["north las vegas", "las vegas", "henderson"],
  },
  freshness: { max_age_days: 30 },
  roles: { title_keywords: ["full stack", "software engineer"] },
}

const NOW = new Date("2026-07-29T00:00:00Z")
const FRESH = "2026-07-26T00:00:00Z"

const check = (location, extra = {}) =>
  passesLimits(
    { title: "Full Stack Developer", location, posted_at: FRESH, ...extra },
    LIMITS,
    NOW,
  )

test("country-wide location strings read as remote, not relocation", () => {
  for (const loc of [
    "USA",
    "United States",
    "Anywhere",
    "Worldwide",
    "North America",
    "Remote (US)",
    "remote - us",
    "Flexible / Remote",
  ]) {
    const v = check(loc)
    assert.ok(v.ok, `"${loc}" was rejected: ${v.reasons.join("; ")}`)
    assert.ok(
      !v.flags.includes("remote_unverified"),
      `"${loc}" should not need verification`,
    )
  }
})

test("a named city plus a country is still an on-site role", () => {
  // The whole-string anchor is what makes this work. A substring match on
  // "usa" would read this as country-wide remote and pull in every US city.
  for (const loc of [
    "Tulsa, USA",
    "Austin, TX, USA",
    "New York, United States",
  ]) {
    assert.ok(!check(loc).ok, `"${loc}" should still be filtered`)
  }
})

test("non-US locations are still rejected", () => {
  for (const loc of [
    "London, UK",
    "Berlin, Germany",
    "Toronto, Canada",
    "Bangalore, India",
    "Sydney, Australia",
  ]) {
    const v = check(loc)
    assert.ok(!v.ok, `"${loc}" should be rejected`)
    assert.match(v.reasons.join(" "), /relocat/)
  }
})

test("remote restricted to a non-US region is still a relocation", () => {
  const v = check("Remote - Europe")
  assert.ok(!v.ok, "EU-only remote is not reachable from North Las Vegas")
})

test("local on-site roles still pass", () => {
  for (const loc of ["Las Vegas, NV", "North Las Vegas, NV", "Henderson, NV"]) {
    assert.ok(check(loc).ok, `"${loc}" should pass`)
  }
})

test("a remote-only source is trusted and not flagged unverified", () => {
  // A board whose entire corpus is remote roles has already answered the
  // question; re-doubting each posting costs a 3-point score penalty for
  // nothing (FLAG_PENALTY.remote_unverified in recommend.mjs).
  const v = check("Austin, TX", { remote_source: true })
  assert.ok(v.ok)
  assert.ok(!v.flags.includes("remote_unverified"))
})

test("a remote-only source does NOT override a non-US location", () => {
  // Otherwise declaring a board remote-only would silently disable the
  // relocation limit for every posting on it.
  const v = check("Berlin, Germany", { remote_source: true })
  assert.ok(!v.ok, "remote_only must not defeat the non-US check")
})

test("a board-level remote flag on an on-site string is still flagged", () => {
  const v = check("Seattle, WA", { remote: true })
  assert.ok(v.ok)
  assert.ok(
    v.flags.includes("remote_unverified"),
    "a contradictory location still needs screening to confirm",
  )
})

test("missing location is unknown, not a rejection", () => {
  const v = check("")
  assert.ok(v.ok)
  assert.ok(v.flags.includes("unknown_location"))
})

test("remote_synonyms in limits replaces the built-in list", () => {
  const strict = {
    ...LIMITS,
    location: { ...LIMITS.location, remote_synonyms: ["usa"] },
  }
  const mk = (location) =>
    passesLimits(
      { title: "Full Stack Developer", location, posted_at: FRESH },
      strict,
      NOW,
    )
  assert.ok(mk("USA").ok, "the one configured synonym still works")
  assert.ok(!mk("Worldwide").ok, "a built-in synonym is gone once overridden")
})

test("remote_ok: false disables remote entirely", () => {
  const noRemote = {
    ...LIMITS,
    location: { ...LIMITS.location, remote_ok: false },
  }
  const v = passesLimits(
    { title: "Full Stack Developer", location: "USA", posted_at: FRESH },
    noRemote,
    NOW,
  )
  assert.ok(!v.ok, "USA must not pass when remote is switched off")
})

test("matchesAny normalizes punctuation and spacing", () => {
  assert.ok(matchesAny("Remote (US)", US_WIDE_LOCATION))
  assert.ok(matchesAny("  REMOTE - US  ", US_WIDE_LOCATION))
  assert.ok(matchesAny("U.S.A.", US_WIDE_LOCATION))
  assert.ok(!matchesAny("Remote US office in Tulsa", US_WIDE_LOCATION))
  assert.ok(!matchesAny("", US_WIDE_LOCATION))
})
