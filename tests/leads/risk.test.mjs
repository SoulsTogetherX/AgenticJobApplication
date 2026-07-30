// L3 — ghost / scam / evergreen risk.
import test from "node:test"
import assert from "node:assert/strict"
import {
  scoreRisk,
  buildHistory,
  bodyFingerprint,
  repostKey,
  RISK_DEFAULTS,
} from "../../scripts/leads/risk.mjs"
import { dedupeLeads } from "../../scripts/leads/find-jobs.mjs"

const lead = (over = {}) => ({
  id: "greenhouse:acme:1",
  company: "Acme",
  title: "Full Stack Developer",
  description: "You will build and ship features with React.",
  ...over,
})

// --- repost detection --------------------------------------------------------

test("dedupeLeads reports a repost instead of silently dropping it", () => {
  // The bug this exists to fix: a re-posted job arrives with a NEW board id and
  // was discarded as a company+title duplicate, so the store could never hold
  // the evidence that reposting had happened.
  const existing = [lead({ id: "greenhouse:acme:1" })]
  const fresh = dedupeLeads([lead({ id: "greenhouse:acme:999" })], existing)
  assert.equal(fresh.length, 0, "still not stored twice")
  assert.equal(fresh.reposts.length, 1, "but the sighting is reported")
  assert.equal(fresh.reposts[0].lead.id, "greenhouse:acme:1")
  assert.equal(fresh.reposts[0].candidate.id, "greenhouse:acme:999")
})

test("the SAME posting id seen again is not a repost", () => {
  // A posting that is simply still live says nothing about ghosting.
  const existing = [lead({ id: "greenhouse:acme:1" })]
  const fresh = dedupeLeads([lead({ id: "greenhouse:acme:1" })], existing)
  assert.equal(fresh.length, 0)
  assert.deepEqual(fresh.reposts, [])
})

test("a genuinely new posting is neither dropped nor counted as a repost", () => {
  const fresh = dedupeLeads(
    [lead({ id: "greenhouse:acme:2", title: "Backend Engineer" })],
    [lead()],
  )
  assert.equal(fresh.length, 1)
  assert.deepEqual(fresh.reposts, [])
})

test("an ingest-recorded repost_count rejects past the threshold", () => {
  const r = scoreRisk(lead({ repost_count: RISK_DEFAULTS.repost_reject }))
  assert.equal(r.ok, false)
  assert.match(r.reasons[0], /reposting/)
})

test("repost_count is judged even with no history map", () => {
  // screen.mjs against a JSON fixture supplies no history; the count stored on
  // the lead must still be read.
  const r = scoreRisk(lead({ repost_count: 5 }), null)
  assert.equal(r.ok, false)
})

test("a single repost cautions rather than rejects", () => {
  const r = scoreRisk(lead({ repost_count: 2 }))
  assert.ok(r.ok, "two sightings can be an honest re-open")
  assert.ok(r.flags.includes("repost"))
})

test("no reposts means no repost signal at all", () => {
  const r = scoreRisk(lead(), buildHistory([lead()]))
  assert.ok(r.ok)
  assert.equal(r.repost_count, 0)
  assert.deepEqual(r.flags, [])
})

test("a lead is never counted as a repost of itself", () => {
  const l = lead()
  const r = scoreRisk(l, buildHistory([l]))
  assert.equal(r.repost_count, 0)
})

test("repostKey ignores case and punctuation", () => {
  assert.equal(
    repostKey({ company: "Acme, Inc.", title: "Full-Stack Developer" }),
    repostKey({ company: "ACME Inc", title: "Full Stack Developer" }),
  )
})

// --- duplicate body ----------------------------------------------------------

test("a shared company intro is NOT treated as a duplicate body", () => {
  // The false positive this guards: Coinbase, Grafana Labs, Twilio and IGT all
  // open every posting with the same company paragraph. Fingerprinting a
  // PREFIX matched 49 of 102 real leads on nothing but marketing copy.
  const intro =
    "Ready to do the most impactful work of your career? We are a company that believes in building the future of the open internet for everyone everywhere. ".repeat(
      2,
    )
  const a = lead({ id: "a", description: intro + "You will build React apps." })
  const b = lead({
    id: "b",
    title: "Backend Engineer",
    description: intro + "You will build Python services and data pipelines.",
  })
  const r = scoreRisk(a, buildHistory([a, b]))
  assert.ok(
    !r.flags.includes("duplicate_body"),
    "a shared intro is marketing, not a ghost signal",
  )
})

test("an identical full body across several postings is flagged", () => {
  const body =
    "We are looking for an engineer to join the team and help build our products. ".repeat(
      5,
    )
  const leads = ["a", "b", "c"].map((id) =>
    lead({ id, title: `Engineer ${id}`, description: body }),
  )
  const r = scoreRisk(leads[0], buildHistory(leads))
  assert.ok(r.flags.includes("duplicate_body"))
})

test("a description too short to be distinctive gets no fingerprint", () => {
  assert.equal(bodyFingerprint("Short one."), null)
  assert.equal(bodyFingerprint(""), null)
  assert.ok(bodyFingerprint("x".repeat(250)))
})

// --- evergreen ---------------------------------------------------------------

test("explicit no-opening language rejects", () => {
  for (const phrase of [
    "This is a pipeline requisition for future hiring.",
    "There is no specific opening at this time.",
  ]) {
    const r = scoreRisk(lead({ description: phrase }))
    assert.equal(r.ok, false, `should reject: ${phrase}`)
  }
})

test("softer evergreen phrasing cautions rather than rejects", () => {
  const r = scoreRisk(
    lead({ description: "We are always hiring great people." }),
  )
  assert.ok(r.ok)
  assert.ok(r.flags.includes("evergreen"))
})

test("ordinary growth language is not evergreen", () => {
  for (const phrase of [
    "We are growing fast and hiring across the company.",
    "Ongoing recruitment for our engineering org.",
    "We review applications as they arrive.",
  ]) {
    const r = scoreRisk(lead({ description: phrase }))
    assert.ok(r.ok, `should not reject: ${phrase}`)
    assert.ok(!r.flags.includes("evergreen"), `should not flag: ${phrase}`)
  }
})

// --- boilerplate -------------------------------------------------------------

test("a long description that is all boilerplate and no work is flagged", () => {
  // Parenthesised: `.repeat` would otherwise bind to the last literal only and
  // leave the description under min_length_for_ratio, silently skipping the check.
  const desc = (
    "Our mission is to serve customers. We believe that diversity and inclusion matter. " +
    "We are an equal opportunity employer and consider applicants without regard to race. " +
    "Reasonable accommodation is available. Founded in 1999. "
  ).repeat(6)
  const r = scoreRisk(lead({ description: desc }))
  assert.ok(
    desc.length >= 600,
    "guard: the ratio check needs a long description",
  )
  assert.ok(r.flags.includes("vague_scope"))
})

test("a real posting with boilerplate at the bottom is not flagged", () => {
  const desc =
    "You will build and ship features, design APIs, deploy services, review code and collaborate with product. ".repeat(
      4,
    ) +
    "We are an equal opportunity employer and consider applicants without regard to race. Reasonable accommodation is available."
  const r = scoreRisk(lead({ description: desc }))
  assert.ok(!r.flags.includes("vague_scope"), "real work described")
})

test("a short description is never judged on boilerplate ratio", () => {
  const r = scoreRisk(
    lead({ description: "We are an equal opportunity employer." }),
  )
  assert.ok(!r.flags.includes("vague_scope"))
})

test("thresholds come from ghost_signals in the limits file", () => {
  const l = lead({ repost_count: 2 })
  assert.ok(scoreRisk(l).ok)
  const strict = scoreRisk(l, null, {
    limits: { ghost_signals: { repost_reject: 2 } },
  })
  assert.equal(strict.ok, false)
})

test("an empty lead does not throw", () => {
  assert.doesNotThrow(() => scoreRisk({}, buildHistory([])))
  assert.ok(scoreRisk({}, buildHistory([])).ok)
})
