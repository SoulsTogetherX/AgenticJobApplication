// The defer/failure taxonomy as POLICY: where a kind can come from, what class
// it aggregates into, and which of several reasons is the one worth recording.
//
// The vocabulary itself lives in lib/db.mjs, beside the column that stores it
// (AUTO_DEFER_KINDS / AUTO_FAILURE_KINDS / AUTO_CHALLENGE_KINDS), because a
// closed value set is only closed if the writer enforces it. This file is
// everything built on top of that set, and it is deliberately the layer that
// can change without a migration.
//
// WHY A JOB CARRIES ONE KIND AND NOT A LIST. A single application often defers
// for several reasons at once — a consent tickbox AND an unprobed dropdown AND
// two unknown fields. The row records ONE, chosen by DEFER_PRIORITY below, and
// the rest go into the detail string. That is not a simplification; it is the
// arithmetic the backlog depends on.
//
//   The defer log's whole job is to answer "what would building X unlock?".
//   If a job blocked by a consent tickbox were counted under
//   `unprobed-dropdown` because a dropdown also went unprobed, then building
//   the dropdown probe would be credited with an application it cannot
//   deliver — the tickbox still stops it. So the recorded kind is the LEAST
//   REMOVABLE one: the constraint that would still be there after every
//   engineering fix on the list. Aggregate by it and the top of the list is a
//   set of applications that a deterministic understanding really does unlock.
//
// The order below is therefore not severity and not chronology. It is "how
// hard is this to make go away", hardest first.
import {
  AUTO_DEFER_KINDS,
  AUTO_FAILURE_KINDS,
  AUTO_CHALLENGE_KINDS,
  autoReasonClass,
  assertReasonKind,
} from "../lib/db.mjs"
import { safeText } from "./untrusted-text.mjs"

export {
  AUTO_DEFER_KINDS,
  AUTO_FAILURE_KINDS,
  AUTO_CHALLENGE_KINDS,
  autoReasonClass,
  assertReasonKind,
}

// Where in the per-job state machine a reason was produced. Closed, because
// "somewhere in the pipeline" is not a stage anybody can act on, and because
// the same kind means different things at different stages: `posting-gone` at
// `plan` is a lead that rotted, at `attempt` it is a race with the employer.
export const STAGES = Object.freeze([
  "queue", // never claimed — the run ended, or its board was paused
  "claim", // deciding whether to take the job at all
  "plan", // scan + fill-plan
  "authorize", // trust gate, caps, verification, token minting
  "attempt", // the click itself
  "post-submit", // classifying the page that came back
  "reconcile", // resolving an orphan after the fact
])
const STAGE_SET = new Set(STAGES)

/**
 * Reason CLASSES — the grouping 4.7's `defer_rate by reason class` reports on,
 * and the one that tells an engineer whether a number is theirs to move.
 *
 *   understanding — the machine did not understand the page. THE ONLY CLASS
 *                   THAT SHRINKS WITH ENGINEERING, and the only sanctioned
 *                   throughput lever: an adapter, a probed option list, or a
 *                   banked answer. Never a model reading the field.
 *   assent        — a human has to say yes. Does not shrink with engineering
 *                   and MUST NOT: shrinking it is the failure mode hard rule 6
 *                   is written to prevent.
 *   environment   — the board or the posting declined. Not ours, not a bug,
 *                   and rising incidence is a signal about them.
 *   policy        — our own rules said no: caps, trust, screening, an
 *                   unverified document. Working exactly as intended.
 *   malfunction   — every failure kind. The only class worth waking for.
 */
export const REASON_CLASSES = Object.freeze({
  understanding: Object.freeze([
    "unknown-field",
    "unprobed-dropdown",
    "fill-failed",
    "multipage-unresolvable",
    // The submit stamp died with a form remount and a re-scan did not bring
    // it back — an engine/adapter behaviour ours to fix, so it shrinks with
    // engineering, which is this tier's definition.
    "submit-control-lost",
  ]),
  assent: Object.freeze([
    "confirm-field",
    "confirm-widget",
    "consent-tickbox",
    "freetext-disclosure",
  ]),
  environment: Object.freeze([
    "captcha",
    "bot-challenge",
    "email-code-challenge",
    "identity-verification",
    "posting-gone",
    "board-paused",
    "reconciled-not-sent",
  ]),
  policy: Object.freeze([
    "doc-unverified",
    "doc-unrendered",
    "fact-base-changed",
    "board-untrusted",
    "board-unsighted",
    "l3-rejected",
    "cap-company",
    "already-applied",
    // A durable scoped STOP standing (§4.9). Policy, not environment: the
    // brake is our own rule holding — like board-untrusted — and clearing it
    // is the user's act (deleting the file), never a retry or a fix.
    "company-stopped",
    "board-stopped",
  ]),
  malfunction: AUTO_FAILURE_KINDS,
})

const CLASS_OF = new Map()
for (const [cls, kinds] of Object.entries(REASON_CLASSES))
  for (const k of kinds) CLASS_OF.set(k, cls)

/** Which class a kind aggregates into, or null if the kind is unknown. */
export const reasonClass = (kind) => CLASS_OF.get(kind) ?? null

// Every kind must have exactly one class. Checked at module load rather than in
// a test, because a kind added to db.mjs and forgotten here would otherwise
// aggregate into `null` and quietly vanish from the digest that the whole phase
// is built to produce.
{
  const missing = [...AUTO_DEFER_KINDS, ...AUTO_FAILURE_KINDS].filter(
    (k) => !CLASS_OF.has(k),
  )
  if (missing.length)
    throw new Error(
      `taxonomy.mjs: no reason class for ${missing.join(", ")} — ` +
        `every kind in db.mjs must appear in REASON_CLASSES`,
    )
}

/**
 * Least removable first. See the header for why this order and not severity.
 *
 * The three tiers, in words:
 *   1. assent      — a human must act; no amount of engineering removes it.
 *   2. environment — the board decided; we can retry, not fix.
 *   3. policy      — our rules; changing them is the user's call, not a fix.
 *   4. understanding — ours to remove, and the only tier a backlog item helps.
 */
export const DEFER_PRIORITY = Object.freeze([
  // 1. assent
  "consent-tickbox",
  "confirm-widget",
  "confirm-field",
  "freetext-disclosure",
  // 2. environment
  "identity-verification",
  "captcha",
  "bot-challenge",
  "email-code-challenge",
  "posting-gone",
  "board-paused",
  "reconciled-not-sent",
  // 3. policy
  "l3-rejected",
  // Ahead of board-untrusted: a standing scoped brake is the single most
  // actionable policy item — the fix is one file deletion, once the human has
  // adjudicated the orphan behind it. A company brake outranks a board brake
  // because it usually means an application may exist at that employer.
  "company-stopped",
  "board-stopped",
  "board-untrusted",
  // Beside board-untrusted, because it is the same shape of answer — "not
  // this board, not tonight" — with a different fix (capture a page, not
  // edit the allowlist). Ahead of already-applied so a stale queue never
  // hides a board the user has to go and capture.
  "board-unsighted",
  // Ahead of the rest of the tier: of every reason in this list it is the one
  // least worth reporting as work outstanding, because there is nothing to do.
  // The user already applied; the queue was stale. A backlog item here would
  // ask someone to fix a job that is finished.
  "already-applied",
  "cap-company",
  "doc-unverified",
  "doc-unrendered",
  "fact-base-changed",
  // 4. understanding — the backlog tier
  "multipage-unresolvable",
  // Beside fill-failed: the same "the engine lost the page" shape, at the
  // submit stage instead of the fill.
  "submit-control-lost",
  "fill-failed",
  "unprobed-dropdown",
  "unknown-field",
])

{
  const missing = AUTO_DEFER_KINDS.filter((k) => !DEFER_PRIORITY.includes(k))
  if (missing.length)
    throw new Error(
      `taxonomy.mjs: ${missing.join(", ")} has no position in DEFER_PRIORITY — ` +
        `an unranked kind cannot be chosen against another one`,
    )
}

export class TaxonomyError extends Error {
  constructor(message) {
    super(message)
    this.name = "TaxonomyError"
    this.code = "ETAXONOMY"
  }
}

/**
 * fill-plan's field-level `why` → a taxonomy kind.
 *
 * These two vocabularies are NOT merged, and the reason is worth stating.
 * `why` describes a FIELD ("consent", "long-free-text", "UNRESOLVED") and is
 * shown to a human looking at one form; a kind describes an APPLICATION and is
 * counted across a campaign. Collapsing them would either coarsen the form
 * report or force every new field reason to become a new countable bucket.
 *
 * The mapping is total by construction — see kindForWhy — because a `why` that
 * nothing recognises is exactly the case that must not silently become a
 * countable name nobody chose.
 */
const WHY_TO_KIND = new Map([
  ["consent", "consent-tickbox"],
  ["confirm", "confirm-field"],
  ["confirm-widget", "confirm-widget"],
  ["identity-verification", "identity-verification"],
  ["long-free-text", "freetext-disclosure"],
  ["disclosure-budget", "freetext-disclosure"],
  ["captcha", "captcha"],
  ["bot-challenge", "bot-challenge"],
  ["unresolved", "unknown-field"],
  ["unknown", "unknown-field"],
  // The other two statuses answer-bank emits that mean "a human still has to
  // decide" (NEEDS_HUMAN in fill-plan.mjs is exactly {UNKNOWN, NEEDS-CHOICE,
  // MAYBE}). Only the first was mapped, so a real Greenhouse form deferring two
  // fields the bank could not choose between reported as `plan-error` — a
  // FAILURE kind, read as "the planner is broken", when the truth was "two
  // dropdowns need an answer the user has not banked".
  ["needs-choice", "unknown-field"],
  ["maybe", "unknown-field"],
  ["unprobed-dropdown", "unprobed-dropdown"],
  ["fill-failed", "fill-failed"],
])

// `why` values that are built as sentences rather than picked from a list —
// fill-plan writes `unsupported field type ${f.t}` and
// `optional and not in the fact base (unresolved)`. Matched by PREFIX, never by
// substring search over the whole string: a substring rule is the string
// matching this taxonomy exists to replace, and it is also how a hostile label
// could steer its own classification.
const WHY_PREFIXES = [
  ["unsupported field type", "unknown-field"],
  ["optional and not in the fact base", "unknown-field"],
  // buildPlan writes "no rendered resume" / "no rendered cover" when the
  // attachment slot has no PDF behind it, and "unrecognised attachment slot"
  // when it cannot tell which document a file input wants.
  //
  // ADDED after a real run, where their absence had a consequence worth
  // stating: an unclassified `why` becomes a loud `plan-error`, which is a
  // FAILURE kind. So a workspace that simply had not been rendered to PDF yet
  // reported as a code fault — "3 deferred field(s) carry a reason the taxonomy
  // does not classify" — and the honest reading of that message is "something
  // is broken", which sends the next reader into the planner instead of into
  // the jobs/ directory where the missing file is.
  //
  // RE-TYPED 2026-08-18. Both used to map to `doc-unverified` as "the closest
  // existing kind", and the aggregation misled in practice: on the 2026-08-17
  // run five deferrals carried `doc-unverified` and not one of them was about
  // verification. A missing PDF is `doc-unrendered` — the document is fine,
  // render-pdf was never run, and that is the fix. A slot nothing recognised
  // is `unknown-field` — the planner did not understand which document a file
  // input wanted, which is exactly the understanding tier an adapter shrinks
  // (and the Ashby helper input, its commonest cause, is now recognised).
  ["no rendered", "doc-unrendered"],
  ["unrecognised attachment slot", "unknown-field"],
]

/**
 * The kind a field-level `why` belongs to, or null when nothing recognises it.
 *
 * NULL IS A REAL ANSWER AND CALLERS MUST HANDLE IT. Defaulting an unrecognised
 * reason to `unknown-field` would be the same mistake in a nicer coat: the
 * digest would show a growing `unknown-field` bucket that no dropdown probe or
 * adapter could ever shrink, because the entries in it are not fields the
 * machine failed to understand — they are reasons this file failed to classify.
 * classifyPlanDefers turns a null into a loud plan-error instead.
 */
export function kindForWhy(why) {
  if (typeof why !== "string" || !why) return null
  const w = why.trim().toLowerCase()
  if (WHY_TO_KIND.has(w)) return WHY_TO_KIND.get(w)
  for (const [prefix, kind] of WHY_PREFIXES)
    if (w.startsWith(prefix)) return kind
  return null
}

/**
 * Build the record a terminal auto_queue row is written from.
 *
 * `detail` is the only free-text field in the taxonomy and it is the one that
 * can carry page-derived text, so it is sanitised HERE — at the point it
 * becomes a string we keep — rather than being trusted to have been cleaned
 * upstream (Phase 0.3's rule, applied at a second door).
 *
 * @returns {{kind, stage, board_key, origin, detail, state, class: string}}
 */
export function reasonRecord({
  kind,
  stage,
  board_key = null,
  origin = null,
  detail = null,
  state = null,
} = {}) {
  const cls = autoReasonClass(kind)
  if (!cls)
    throw new TaxonomyError(
      `unknown reason kind ${JSON.stringify(kind)} — the taxonomy is closed ` +
        `(defer kinds: ${AUTO_DEFER_KINDS.join(", ")}; failure kinds: ${AUTO_FAILURE_KINDS.join(", ")})`,
    )
  if (!STAGE_SET.has(stage))
    throw new TaxonomyError(
      `unknown stage ${JSON.stringify(stage)} (expected one of ${STAGES.join(", ")})`,
    )
  // The class implies the state — EXCEPT for a challenge, where the class is
  // 'deferred' (the machine did not malfunction) and the state must be
  // 'challenged' (a click went out and we do not know whether it landed). Only
  // the caller knows which side of the click it is on, so it passes `state`.
  return Object.freeze({
    kind,
    stage,
    board_key: board_key ?? null,
    origin: origin ?? null,
    detail:
      detail === null || detail === undefined ? null : safeText(detail, 240),
    state: state ?? cls,
    class: reasonClass(kind),
  })
}

/** The opts object setAutoJobState takes, from a record. */
export const toStateOpts = (record) => ({
  reason_kind: record.kind,
  reason_stage: record.stage,
  reason_detail: record.detail,
})

/**
 * Reduce a fill-plan's deferred fields to the ONE kind the application row
 * records, plus a detail line naming what else was there.
 *
 * @param defers  the plan's `defer` array
 * @param ctx     {stage, board_key, origin}
 * @returns a reasonRecord, or null when there is nothing to defer for.
 */
export function classifyPlanDefers(defers, ctx = {}) {
  const list = Array.isArray(defers) ? defers : []
  if (!list.length) return null

  const kinds = []
  const unmapped = []
  for (const d of list) {
    const k = kindForWhy(d?.why)
    if (k) kinds.push(k)
    else unmapped.push(d?.why ?? "(no reason)")
  }

  // An unclassifiable reason is a MALFUNCTION of this file, and it says so.
  // The alternative — bucketing it under some plausible defer kind — produces
  // a number that looks like a product problem and is actually a mapping bug,
  // and nobody would ever find it because the digest would look healthy.
  if (unmapped.length)
    return reasonRecord({
      kind: "plan-error",
      stage: ctx.stage ?? "plan",
      board_key: ctx.board_key,
      origin: ctx.origin,
      detail:
        `${unmapped.length} deferred field(s) carry a reason the taxonomy does not ` +
        `classify: ${unmapped
          .slice(0, 3)
          .map((w) => safeText(w, 60))
          .join("; ")}`,
    })

  const ranked = [...new Set(kinds)].sort(
    (a, b) => DEFER_PRIORITY.indexOf(a) - DEFER_PRIORITY.indexOf(b),
  )
  const blocking = ranked[0]
  const others = ranked.slice(1)
  const first = list.find((d) => kindForWhy(d?.why) === blocking)
  const label = safeText(first?.label ?? first?.k ?? "", 80)
  // The defer's own `note` says WHY the field deferred ("required consent,
  // but the scanner could not vouch for its label"), and dropping it here is
  // what made every Reddit run from 2026-08-19 to 2026-08-21 read identically
  // while the actual blocker — an unreachable vouch — sat one key deeper.
  // Surfaced so the next dead-end grant is visible in the run log rather than
  // requiring a field-cache archaeology session.
  const note = safeText(first?.note ?? "", 120)

  return reasonRecord({
    kind: blocking,
    stage: ctx.stage ?? "plan",
    board_key: ctx.board_key,
    origin: ctx.origin,
    detail:
      `${list.length} field(s) need a human` +
      (label ? `; first: ${label}` : "") +
      (note ? ` — ${note}` : "") +
      (others.length ? ` (also ${others.join(", ")})` : ""),
  })
}

/**
 * The 4.4 predicate: which boards showed a challenge they had not shown before.
 *
 * @param rows  readChallengeIncidence output — [{board_key, current, prior}]
 * @returns the boards that are new, as an anomaly-breaker input.
 */
export function newlyChallengedBoards(rows = []) {
  return rows
    .filter((r) => Number(r.current) > 0 && Number(r.prior ?? 0) === 0)
    .map((r) => ({
      board_key: r.board_key,
      challenges: Number(r.current),
      // Said explicitly so a caller cannot read this as "the board is broken".
      // A challenge is the board working as designed against automation; what
      // is anomalous is that it started, not that it happened.
      why: "first challenge recorded on this board",
    }))
}
