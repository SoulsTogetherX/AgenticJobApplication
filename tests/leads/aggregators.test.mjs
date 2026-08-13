// Remote-only aggregator sources.
//
// The contract that matters is `remote_source: true`. These boards state a
// posting's location as who may be HIRED ("USA", "Anywhere"), not where an
// office is, and without that flag the location gate reads it as a relocation
// and discards the entire corpus — which is exactly what happened: 35/35
// Remotive, 50/50 Jobicy and 100/100 RemoteOK postings were rejected.
import test from "node:test"
import assert from "node:assert/strict"
import {
  BOARD_TYPES,
  passesLimits,
  bodyDisqualifiers,
} from "../../scripts/leads/find-jobs.mjs"

const LIMITS = {
  location: {
    base: "North Las Vegas, NV",
    remote_ok: true,
    onsite_allowed: ["las vegas"],
  },
  freshness: { max_age_days: 30 },
  roles: {
    title_keywords: ["full stack", "software engineer", "backend"],
    hard_filter: ["senior"],
  },
}
const NOW = new Date("2026-07-29T00:00:00Z")
const FRESH = "2026-07-26T00:00:00Z"

test("the aggregator types are registered as board types", () => {
  for (const t of ["jobicy", "remotive", "remoteok"]) {
    assert.ok(BOARD_TYPES.includes(t), `${t} should be a known board type`)
  }
})

// A posting shaped the way each fetcher emits one.
const aggregatorPosting = (over = {}) => ({
  id: "jobicy:1",
  source: "jobicy",
  company: "Canonical Ltd.",
  title: "Graduate Software Engineer",
  location: "USA",
  remote: true,
  remote_source: true,
  url: "https://example.com/1",
  posted_at: FRESH,
  description:
    "Build web applications and APIs in Python. Requirements: Python, Linux, Git, SQL.",
  ...over,
})

test("an aggregator posting located 'USA' survives both gates", () => {
  const p = aggregatorPosting()
  const v = passesLimits(p, LIMITS, NOW)
  assert.ok(v.ok, `rejected at gate 1: ${v.reasons.join("; ")}`)
  assert.ok(
    !v.flags.includes("remote_unverified"),
    "a remote-only board is trusted",
  )
  const d = bodyDisqualifiers({ ...p, flags: v.flags }, LIMITS)
  assert.ok(d.ok, `rejected at gate 2: ${d.reasons.join("; ")}`)
})

test("without remote_source the same posting is rejected — the bug this fixes", () => {
  const p = aggregatorPosting({ location: "Anywhere" })
  delete p.remote_source
  delete p.remote
  // "Anywhere" is in the built-in synonym list, so prove it with a location
  // only the source flag can rescue.
  const office = aggregatorPosting({ location: "Austin, TX" })
  delete office.remote_source
  delete office.remote
  assert.ok(!passesLimits(office, LIMITS, NOW).ok)
  assert.ok(
    passesLimits(aggregatorPosting({ location: "Austin, TX" }), LIMITS, NOW).ok,
  )
})

test("remote_source does not defeat the non-US limit", () => {
  // Otherwise declaring a source remote-only would silently switch off the
  // relocation rule for every posting it carries.
  const p = aggregatorPosting({ location: "Berlin, Germany" })
  assert.ok(!passesLimits(p, LIMITS, NOW).ok)
})

test("aggregator titles still face the hard title filter", () => {
  // These boards carry a lot of senior and non-software work; the existing
  // gates are what make the extra volume affordable.
  const senior = aggregatorPosting({ title: "Senior Software Engineer" })
  assert.ok(!passesLimits(senior, LIMITS, NOW).ok)
  const nonTech = aggregatorPosting({ title: "Patient Care Specialist" })
  assert.ok(!passesLimits(nonTech, LIMITS, NOW).ok)
})

test("a stale aggregator posting is still stale", () => {
  const old = aggregatorPosting({ posted_at: "2026-01-01T00:00:00Z" })
  assert.ok(!passesLimits(old, LIMITS, NOW).ok)
})

test("aggregator descriptions arrive in the list payload, so gate 2 can run", () => {
  // This is why these sources cost no enrich round trips: the body gate has
  // text to read immediately, with no per-posting detail fetch.
  //
  // The title here is deliberately NOT one that names the discipline outright.
  // bodyDisqualifiers trusts "Software Engineer" and "Full Stack Developer" and
  // skips the is-this-software check for them by design, so a body-gate test
  // using one of those titles proves nothing.
  const p = aggregatorPosting({
    title: "Building Engineer",
    description:
      "Perform preventive maintenance and repairs on guest rooms. Maintain cleanliness of the casino floor. Use hand tools daily.",
  })
  assert.ok(
    p.description,
    "the aggregator supplied body text with no extra fetch",
  )
  const d = bodyDisqualifiers({ ...p, flags: ["title_loose"] }, LIMITS)
  assert.ok(
    !d.ok,
    `body gate should catch a maintenance job: ${JSON.stringify(d)}`,
  )
  assert.match(d.reasons.join(" "), /not a software role/)
})

test("an employment-shape disqualifier in an aggregator body is caught", () => {
  const p = aggregatorPosting({
    description:
      "Great full stack role. Employment Type: Contract. You will build web applications.",
  })
  const d = bodyDisqualifiers(
    { ...p, flags: [] },
    {
      ...LIMITS,
      employment: { reject_types: ["contract"] },
    },
  )
  assert.ok(!d.ok)
  assert.match(d.reasons.join(" "), /not full-time permanent/)
})
