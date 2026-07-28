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

export function detectAts(url) {
  const u = String(url ?? "")
  for (const h of HANDOFF) {
    if (h.match.test(u)) return { id: h.id, handoff: true, reason: h.reason }
  }
  for (const a of ADAPTERS) {
    if (a.match.test(u)) return a
  }
  return generic
}
