// ATS detection and adapter registry.
//
// An adapter contributes only knowledge, never behaviour: which combo strategy
// to try first, which file field takes which document, and where an ATS renders
// a value differently from the option text it was chosen by. The fill engine
// itself contains no ATS-specific code, so an unrecognised board still works —
// it just defers more fields to the user.
import greenhouse from "./greenhouse.mjs"
import lever from "./lever.mjs"
import ashby from "./ashby.mjs"
import generic from "./generic.mjs"

export const ADAPTERS = [greenhouse, lever, ashby]

// Workday is detected but deliberately NOT adapted: its application flow
// requires creating an account, which the agent is not permitted to do. Naming
// it explicitly produces an honest hand-off instead of a confusing stall at a
// login wall.
export const HANDOFF = [
  {
    id: "workday",
    match: /myworkdayjobs\.com|\.workday\.com/i,
    reason:
      "Workday requires creating an account to apply — the agent cannot do that. Open it yourself and the answers are in profile/answers.yaml.",
  },
]

// FINDING (qa-adversary, tests/security/fake-board.test.mjs): HANDOFF used to
// be matched against the WHOLE url string, so a tracking parameter on a REAL
// Greenhouse posting (?utm_source=myworkdayjobs.com) forced a Workday
// hand-off — fail-safe rather than fail-dangerous (the pipeline refuses to
// apply rather than filling something wrong), but still a third party
// silently denying an application the user could otherwise submit
// themselves; on the unattended auto-apply path that is a denial of service
// with nobody watching. HANDOFF is now matched against the URL's HOSTNAME
// only, parsed properly rather than string-sniffed, so a query parameter,
// fragment or path segment can never trigger it.
//
// Deliberately NARROW: adapter selection below is UNCHANGED. The broader
// "any board can impersonate any ATS via a URL substring" finding is real
// (same test file, the characterisation test above the one this fixes) but
// this repo's own fake-board fixture currently depends on that property to
// select a real adapter at all (see tests/fixtures/boards/server.mjs) — that
// is a coordinated fixture change, not something to fix as a side effect
// here. HANDOFF is the one half with a real consequence (a silent refusal to
// apply) cheap enough to close without touching the fixture.
function hostnameOf(url) {
  try {
    return new URL(String(url ?? "")).hostname
  } catch {
    return ""
  }
}

export function detectAts(url) {
  const u = String(url ?? "")
  const host = hostnameOf(u)
  for (const h of HANDOFF) {
    if (h.match.test(host)) return { id: h.id, handoff: true, reason: h.reason }
  }
  for (const a of ADAPTERS) {
    if (a.match.test(u)) return a
  }
  return generic
}
