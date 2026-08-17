// The board trust gate (§4.8). Five mechanical checks, and the two ways a
// trust gate usually goes wrong: a suffix match that accepts a lookalike
// domain, and an exemption that widens further than the case it was added for.
import test from "node:test"
import assert from "node:assert/strict"
import {
  trustBoard,
  domainMatches,
  normalizeAllowlist,
  allowlistProblems,
  allowlistEntry,
  isLoopbackHost,
  TRUST_CHECKS,
  ADAPTER_IDS,
  resolveLeadForTrust,
} from "../../scripts/auto/trust.mjs"

const LIMITS = {
  auto_apply: {
    enabled: true,
    dry_run: true,
    board_allowlist: {
      "boards.greenhouse.io": "greenhouse",
      "jobs.lever.co": "lever",
    },
  },
}
const OK_LEAD = { apply_url: "https://boards.greenhouse.io/acme/jobs/1" }
const OK_SCREEN = { verdict: "pass", findings: [] }
const OK_ORIGIN = "https://boards.greenhouse.io"

const gate = (over = {}) =>
  trustBoard({
    lead: OK_LEAD,
    limits: LIMITS,
    screening: OK_SCREEN,
    recordedOrigin: OK_ORIGIN,
    ...over,
  })

const failedNames = (v) => v.checks.filter((c) => !c.ok).map((c) => c.name)

test("a fully allowlisted, screened, https, origin-stable lead passes", () => {
  const v = gate()
  assert.equal(v.ok, true, v.reason ?? "")
  assert.equal(v.kind, null)
  assert.deepEqual(
    v.checks.map((c) => c.name),
    [...TRUST_CHECKS],
    "every check is evaluated and reported, including the passing ones — the " +
      "report the user reads before enabling this needs all five",
  )
})

// --- check 1: the allowlist -------------------------------------------------

test("a domain not on the allowlist is refused", () => {
  const v = gate({
    lead: { apply_url: "https://jobs.ashbyhq.com/acme/1" },
    recordedOrigin: "https://jobs.ashbyhq.com",
  })
  assert.equal(v.ok, false)
  assert.deepEqual(failedNames(v), ["allowlist", "adapter"])
  assert.equal(v.kind, "board-untrusted")
})

test("A LOOKALIKE DOMAIN IS NOT A SUBDOMAIN", () => {
  // The bug this exists to not have: `host.endsWith(domain)` accepts
  // evilgreenhouse.io for an entry of greenhouse.io. The dot is the fix and
  // this is the test that would catch its removal.
  assert.equal(domainMatches("evilgreenhouse.io", "greenhouse.io"), false)
  assert.equal(domainMatches("boards.greenhouse.io", "greenhouse.io"), true)
  assert.equal(domainMatches("greenhouse.io", "greenhouse.io"), true)
  assert.equal(domainMatches("greenhouse.io.evil.test", "greenhouse.io"), false)
})

test("an absent allowlist refuses everything, and says so once at startup", () => {
  const v = gate({ limits: { auto_apply: { enabled: true } } })
  assert.equal(v.ok, false)
  assert.match(v.reason, /board_allowlist is absent or empty/)
  const problems = allowlistProblems(undefined)
  assert.equal(problems.length, 1)
  assert.match(problems[0], /board_allowlist is absent/)
  assert.match(problems[0], /never edits it/)
})

test("the longest matching entry wins", () => {
  const entries = normalizeAllowlist({
    "greenhouse.io": "generic-wrong",
    "boards.greenhouse.io": "greenhouse",
  })
  assert.equal(
    allowlistEntry("boards.greenhouse.io", entries).ats,
    "greenhouse",
  )
})

// --- check 2: the adapter ---------------------------------------------------

test("an ats id the repo does not ship is refused, not inferred", () => {
  const v = gate({
    limits: {
      auto_apply: { board_allowlist: { "boards.greenhouse.io": "greenhosue" } },
    },
  })
  assert.equal(v.ok, false)
  assert.deepEqual(failedNames(v), ["adapter"])
  assert.match(v.reason, /not a shipped adapter/)
  // And the typo is reported as a typo rather than as "your boards went bad".
  assert.match(
    allowlistProblems({ "boards.greenhouse.io": "greenhosue" })[0],
    /greenhosue/,
  )
})

test("a bare list of domain strings is NOT accepted as an allowlist", () => {
  // Accepting one would leave the ATS to be inferred from the URL, and
  // detectAts matches its regexes against the WHOLE url string — so a query
  // parameter naming a vendor would "declare" that vendor.
  assert.deepEqual(normalizeAllowlist(["boards.greenhouse.io"]), [])
  const v = gate({
    limits: { auto_apply: { board_allowlist: ["boards.greenhouse.io"] } },
  })
  assert.equal(v.ok, false)
})

test("a URL that merely mentions an ATS does not acquire its trust", () => {
  const v = gate({
    lead: {
      apply_url: "https://evil.test/apply?utm_source=boards.greenhouse.io",
    },
    recordedOrigin: "https://evil.test",
  })
  assert.equal(v.ok, false)
  assert.ok(failedNames(v).includes("allowlist"))
})

// --- check 3: screening -----------------------------------------------------

test("never screened and L3-rejected are different kinds", () => {
  const never = gate({ screening: null })
  assert.equal(never.ok, false)
  assert.equal(
    never.kind,
    "board-untrusted",
    "a lead nothing screened is a gap in the pipeline feeding the runner, " +
      "not a board rejecting the user",
  )

  // One of untrusted.mjs's eight disqualifying kinds, named here rather than
  // re-listed: the gate defers to isDisqualifying and this test must too, or
  // the two lists drift.
  const rejected = gate({
    screening: {
      verdict: "pass",
      findings: [{ kind: "override_instructions" }],
    },
  })
  assert.equal(rejected.ok, false)
  assert.equal(rejected.kind, "l3-rejected")
  assert.match(rejected.reason, /instruction-shaped/)
})

test("a non-disqualifying L3 finding flags but does not refuse", () => {
  // Hidden HTML and alt text alone only flag — a CMS emits those. The gate
  // must not turn every flagged lead into a refusal, or rule 0's deliberate
  // flag/reject split collapses.
  const v = gate({
    screening: { verdict: "pass", findings: [{ kind: "hidden_html" }] },
  })
  assert.equal(v.ok, true, v.reason ?? "")
})

// --- check 4: https, and the scope of the fixture exemption -----------------

test("http is refused", () => {
  const v = gate({
    lead: { apply_url: "http://boards.greenhouse.io/acme/jobs/1" },
    recordedOrigin: "http://boards.greenhouse.io",
  })
  assert.equal(v.ok, false)
  assert.deepEqual(failedNames(v), ["https"])
})

test("the loopback exemption needs BOTH the flag and loopback", () => {
  const loopback = {
    lead: { apply_url: "http://127.0.0.1:4571/boards.greenhouse.io/e/jobs/1" },
    limits: { auto_apply: { board_allowlist: { "127.0.0.1": "greenhouse" } } },
    recordedOrigin: "http://127.0.0.1:4571",
  }
  // Flag off: refused even on loopback.
  assert.equal(trustBoard({ ...loopback, screening: OK_SCREEN }).ok, false)
  // Flag on: permitted on loopback.
  assert.equal(
    trustBoard({ ...loopback, screening: OK_SCREEN, allowLoopbackHttp: true })
      .ok,
    true,
  )
  // THE ONE THAT MATTERS: flag on does NOT widen to the internet.
  const remote = trustBoard({
    lead: { apply_url: "http://boards.greenhouse.io/acme/jobs/1" },
    limits: LIMITS,
    screening: OK_SCREEN,
    recordedOrigin: "http://boards.greenhouse.io",
    allowLoopbackHttp: true,
  })
  assert.equal(remote.ok, false)
  assert.deepEqual(failedNames(remote), ["https"])
})

test("a host that merely resolves to loopback is not loopback", () => {
  assert.equal(isLoopbackHost("127.0.0.1"), true)
  assert.equal(isLoopbackHost("localhost"), true)
  assert.equal(isLoopbackHost("127.0.0.1.evil.test"), false)
  assert.equal(isLoopbackHost("local.test"), false)
})

// --- check 5: the origin recorded at queue time -----------------------------

test("the lead store changing under a queued job is caught, as a malfunction", () => {
  const v = gate({ recordedOrigin: "https://job-boards.greenhouse.io" })
  assert.equal(v.ok, false)
  assert.deepEqual(failedNames(v), ["origin_stable"])
  assert.equal(
    v.kind,
    "origin-mismatch",
    "our own store being internally inconsistent is our malfunction, not the " +
      "board declining",
  )
})

test("no recorded origin is a refusal, never a pass", () => {
  const v = gate({ recordedOrigin: null })
  assert.equal(v.ok, false)
  assert.deepEqual(failedNames(v), ["origin_stable"])
})

// --- shape ------------------------------------------------------------------

test("a lead with no apply_url is refused and says why", () => {
  const v = gate({ lead: { url: "https://adzuna.test/ad/123" } })
  assert.equal(v.ok, false)
  assert.match(v.reason, /carries no apply_url/)
})

test("the adapter ids are the ones the repo ships", () => {
  assert.deepEqual([...ADAPTER_IDS].sort(), ["ashby", "greenhouse", "lever"])
})

// --- resolveLeadForTrust: the one resolution both callers share --------------
//
// MEASURED 2026-08-17: the cycle's prep loop called trustBoard bare, with the
// posting URL and no recordedOrigin, and check 5 refused every board-hosted
// lead before a workspace existed. These pin the helper that both the runner
// and the cycle now go through.

test("resolveLeadForTrust: a posting URL is resolved to the form and its origin recorded", () => {
  const { applyUrl, origin, verdict } = resolveLeadForTrust(
    { apply_url: "https://boards.greenhouse.io/acme/jobs/1" },
    { limits: LIMITS, screening: OK_SCREEN },
  )
  assert.match(applyUrl, /^https:\/\/boards\.greenhouse\.io\//)
  assert.equal(origin, "https://boards.greenhouse.io")
  assert.equal(verdict.ok, true, verdict.reason ?? "")
  assert.ok(
    !verdict.failed.includes("origin_stable"),
    "a lead with an http(s) apply_url must never fail origin_stable at " +
      "selection time — there is nothing queued to compare against yet, and " +
      "the resolver is what records the origin",
  )
})

test("resolveLeadForTrust: Ashby's posting resolves to /application on the same origin", () => {
  const limits = {
    auto_apply: {
      enabled: true,
      dry_run: true,
      board_allowlist: { "jobs.ashbyhq.com": "ashby" },
    },
  }
  const { applyUrl, origin, verdict } = resolveLeadForTrust(
    {
      apply_url:
        "https://jobs.ashbyhq.com/render/06377f8a-a255-412a-8032-18ace1d005a5",
    },
    { limits, screening: OK_SCREEN },
  )
  assert.match(applyUrl, /\/application$/)
  assert.equal(origin, "https://jobs.ashbyhq.com")
  assert.equal(verdict.ok, true, verdict.reason ?? "")
})

test("resolveLeadForTrust: no apply_url still refuses on allowlist, not on origin", () => {
  const { origin, verdict } = resolveLeadForTrust(
    { url: null, apply_url: null },
    { limits: LIMITS, screening: OK_SCREEN },
  )
  assert.equal(origin, null)
  assert.equal(verdict.ok, false)
  assert.equal(verdict.failed[0], "allowlist")
})

test("resolveLeadForTrust: the loopback exemption still needs the flag", () => {
  const limits = {
    auto_apply: {
      enabled: true,
      dry_run: true,
      board_allowlist: { "127.0.0.1": "greenhouse" },
    },
  }
  const lead = { apply_url: "http://127.0.0.1:9/acme/jobs/1" }
  assert.equal(
    resolveLeadForTrust(lead, { limits, screening: OK_SCREEN }).verdict.ok,
    false,
  )
  assert.equal(
    resolveLeadForTrust(lead, {
      limits,
      screening: OK_SCREEN,
      allowLoopbackHttp: true,
    }).verdict.ok,
    true,
  )
})
