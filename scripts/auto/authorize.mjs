// The one place that decides whether an application may be submitted, and the
// only thing that can produce permission to click.
//
// ---------------------------------------------------------------------------
// WHY THIS FILE EXISTS: "ask" is not a control, "capability" is
// ---------------------------------------------------------------------------
//
// Every guard this directory had before was a function the runner was TRUSTED
// TO CALL. preflight.mjs reads auto_apply.enabled — in exactly one place, and
// nothing bound it to a run, so a runner that called startRun({mode:"live"})
// and never called preflight would send real applications while the user's file
// said `enabled: false`. audit.mjs's ticket was a DETECTOR, not a preventer:
// recordSubmission on a ticket miss records anyway and raises STOP, which is
// right for the record and useless for prevention, because the click already
// happened.
//
// So the API is inverted. Nothing here is asked "may I?"; the caller cannot
// proceed at all without an object it has no way to manufacture:
//
//     const token = authorizeSubmit({...})        // <- reads EVERY precondition
//     if (token.deferred) { defer(token.reason); return }
//     ...
//     clickSubmit(page, token)                    // <- consumeSubmitToken() or throw
//
// The token is frozen, single-use, and bound to the lead slug, the plan hash
// AND the run mode. A dry-run token cannot authorise a live click; a token for
// one job cannot authorise another; a token cannot authorise two clicks; and a
// plan edited after authorisation no longer matches the hash the token carries.
//
// THERE IS STILL NO RUNNER, AND NOTHING HERE OPENS A BROWSER OR CLICKS
// ANYTHING. This module launches nothing, imports no browser, and its only
// side effects are reading the STOP file and reading the two ledgers to count
// caps. It is the gate that a runner will have to pass through; the runner is
// wave B, and hard rule 6 (the user is on the submit button) is the operative
// rule until it ships AND the user turns auto_apply on.
//
// ---------------------------------------------------------------------------
// THE RUNNER'S CONTRACT — binding on wave B, written down here because
// discovering it late is how this entire inversion becomes decorative
// ---------------------------------------------------------------------------
//
//   1. EXACTLY ONE function in the tree may contain a click.
//   2. Its FIRST statement is consumeSubmitToken(token, {...}).
//   3. The token is a POSITIONAL, REQUIRED parameter of that function. Not an
//      option, not a field on an options bag, not defaulted, not nullable.
//
// Every property this module provides is reachable only through those three
// sentences. Two clicking call sites, or one that takes the token optionally
// "for now" because some build step is awkward, and the gate is decoration:
// the second site is the one that will send an application the user's file
// says is disabled, and nothing here will have any way to know.
//
// The order at the one call site is fixed, and each step exists because the
// step before it cannot do its job:
//
//     const token = authorizeSubmit({...})     // every precondition, once
//     if (token.deferred) { run.deferJob(job, token.reason); return }
//     run.beginSubmit(job, planSha, url, token) // durable intent + run/config mode binding
//     clickSubmit(page, token)                  // consumeSubmitToken FIRST
//     run.recordSubmission({...})               // resolves the intent
//
// and on any failure provably before the click:
//
//     run.abandonAttempt(slug, reason, { beforeClick: true })
//
// A failure DURING a click is not provably before it. Leave it as an orphan
// and let the runner stop; an application cannot be unsent, and a false
// "abandoned" is a lie in the only ledger that survives.
//
// ---------------------------------------------------------------------------
// TWO FAILURE MODES, KEPT APART ON PURPOSE
// ---------------------------------------------------------------------------
//
//   POLICY   -> { deferred: true, reason }   a decision about this application.
//               Hard rule 6: a silent skip is not a deferral, so the reason is
//               phrased for the user, names the thing that blocked it, and is
//               carried into the audit record.
//
//   PROGRAMMER ERROR -> throws.              A missing or malformed input is
//               NOT a defer. A defer looks like a considered decision, and a
//               considered decision about an input nobody supplied is a lie
//               that reads as a clean run: a hundred jobs "deferred: trust
//               verdict absent" is indistinguishable in a report from a
//               hundred jobs correctly held back.
//
// The line between them: anything sourced from the USER'S FILES or from the
// lead is data, and bad data defers. Anything the CALLER is responsible for
// wiring up — the lead, the plan, its hash, the trust verdict, the screening
// verdict slot — is a programmer error and throws.
import crypto from "node:crypto"

import { CHECKPOINTS, STOP_PATH, assertNotStopped } from "./guard.mjs"
import { capCheck } from "./caps.mjs"
import { submitReadiness } from "../apply/fill-plan.mjs"
import { isDisqualifying } from "../lib/untrusted.mjs"
import { DB_PATH } from "../lib/db.mjs"

/** A caller wired this wrong. Never a defer. */
export class AuthorizationInputError extends TypeError {
  constructor(message) {
    super(message)
    this.name = "AuthorizationInputError"
    this.code = "EAUTHINPUT"
  }
}

/** A token was missing, spent, or does not match what is about to happen. */
export class TokenError extends Error {
  constructor(message) {
    super(message)
    this.name = "TokenError"
    this.code = "EBADTOKEN"
  }
}

// Every precondition, named. A closed list so a report can say which one
// stopped an application without parsing prose, and so a new precondition has
// to be added HERE rather than smuggled in as an early return.
export const SUBMIT_CHECKS = Object.freeze([
  "auto_apply_block",
  "enabled",
  "mode",
  "trust_gate",
  "screening",
  "plan_defer",
  "submit_readiness",
  "company_known",
  "caps",
])

const HEX64 = /^[0-9a-f]{64}$/

/**
 * The hash the token binds to. One implementation, exported, so the runner and
 * the audit record cannot disagree about what "the plan" was.
 */
export function planSha256(plan) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(plan ?? null))
    .digest("hex")
}

// --- input validation --------------------------------------------------------

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v)

function requireInput(input) {
  if (!isObj(input))
    throw new AuthorizationInputError(
      "authorizeSubmit(input): input must be an object",
    )
  const { lead, plan, planSha, trustVerdict, sentThisRun = 0 } = input

  if (!isObj(lead) || typeof lead.slug !== "string" || !lead.slug.trim())
    throw new AuthorizationInputError(
      "authorizeSubmit: lead must be an object with a non-empty slug",
    )
  if (!isObj(plan))
    throw new AuthorizationInputError("authorizeSubmit: plan must be an object")
  if (typeof planSha !== "string" || !HEX64.test(planSha))
    throw new AuthorizationInputError(
      "authorizeSubmit: planSha must be a 64-character sha256 hex digest " +
        "(use planSha256(plan)) — an unbound token authorises any plan",
    )

  // The key must be PRESENT even when there is no block: `config: null` says
  // "the user's limits file has no auto_apply block", which is a policy state
  // and defers. An absent key says the caller never read the file, which is
  // not a state the user can act on.
  if (!("config" in input))
    throw new AuthorizationInputError(
      "authorizeSubmit: config is required (the auto_apply block, or null if the limits file has none)",
    )
  if (input.config !== null && !isObj(input.config))
    throw new AuthorizationInputError(
      "authorizeSubmit: config must be the auto_apply object or null",
    )

  // The trust gate itself is wave B. The INPUT is required now so that
  // plugging the real gate in does not reshape this function — and a missing
  // one throws rather than defers, because "no trust verdict" silently
  // becoming "not trusted" is how a gate gets shipped unwired and nobody
  // notices for a month.
  if (!isObj(trustVerdict) || typeof trustVerdict.ok !== "boolean")
    throw new AuthorizationInputError(
      "authorizeSubmit: trustVerdict must be { ok: boolean, reason? } — " +
        "the board trust gate's verdict, not a guess",
    )

  if (!("screening" in input))
    throw new AuthorizationInputError(
      "authorizeSubmit: screening is required (the stored l0/l1/l3 verdict, or null if never screened)",
    )
  if (input.screening !== null && !isObj(input.screening))
    throw new AuthorizationInputError(
      "authorizeSubmit: screening must be the evaluateStages result or null",
    )

  if (!Number.isInteger(sentThisRun) || sentThisRun < 0)
    throw new AuthorizationInputError(
      "authorizeSubmit: sentThisRun must be a non-negative integer",
    )
}

// --- the screening verdict ---------------------------------------------------

// Pull every injection finding out of a stored verdict, whichever carrier it
// arrived in. risk.mjs records ALL kinds as `injection:<kind>` risk signals and
// only the disqualifying ones as an `injection_attempt:<kind>+<kind>` reason,
// and a verdict read back out of the lead store may carry either or both.
// isDisqualifying draws the line — never a list here, because a second copy of
// that list is a second thing to forget to update.
export function screeningFindingKinds(screening) {
  const kinds = new Set()
  const add = (v) => {
    const k = typeof v === "string" ? v : v?.kind
    if (k) kinds.add(String(k))
  }
  const sources = [
    screening,
    screening?.stages?.l3,
    screening?.l3,
    screening?.risk,
  ].filter(isObj)
  for (const src of sources) {
    for (const f of src.findings ?? []) add(f)
    for (const s of src.risk_signals ?? []) {
      const m = /^injection:(.+)$/.exec(String(s))
      if (m) add(m[1])
    }
    for (const r of src.reasons ?? []) {
      const m = /^injection_attempt:(.+)$/.exec(String(r))
      if (m) for (const k of m[1].split("+")) add(k)
    }
  }
  return [...kinds]
}

// --- the checks --------------------------------------------------------------

function evaluate(input) {
  const {
    lead,
    plan,
    report = null,
    config,
    trustVerdict,
    screening,
    sentThisRun = 0,
    dbFile = DB_PATH,
    now = new Date(),
  } = input

  const checks = []
  const push = (name, ok, detail) => {
    checks.push({ name, ok, detail })
    return ok
  }

  // 1. the user's block exists at all.
  const haveBlock = push(
    "auto_apply_block",
    config !== null,
    config !== null
      ? "auto_apply block present"
      : "no auto_apply block in docs/application-limits.yaml — the user adds it; " +
          "no agent edits that file",
  )

  // 2. enabled, STRICTLY true. Absent, null, "yes", 1 — all defer. Auto-submit
  //    ships disabled and the user turns it on after reading a dry-run report
  //    they trust; a truthy-ish read of that key is how "off" becomes "on".
  const enabled = config?.enabled
  push(
    "enabled",
    haveBlock && enabled === true,
    enabled === true
      ? "auto_apply.enabled is true"
      : `auto_apply.enabled is ${enabled === undefined ? "absent" : JSON.stringify(enabled)}` +
          " — auto-submit ships disabled and only the user turns it on",
  )

  // 3. the mode, derived ONCE, here, from the user's file — not from an
  //    argument the runner chose. It is carried on the token, and the click
  //    site must state which one it is performing.
  const dryRun = config?.dry_run
  const modeOk = haveBlock && typeof dryRun === "boolean"
  const mode = modeOk ? (dryRun ? "dry_run" : "live") : null
  push(
    "mode",
    modeOk,
    modeOk
      ? `auto_apply.dry_run=${dryRun} -> mode=${mode}`
      : `auto_apply.dry_run is ${dryRun === undefined ? "absent" : JSON.stringify(dryRun)}` +
          " — a non-boolean is not interpreted, because guessing it wrong sends real applications",
  )

  // 4. the board trust gate. Mechanical, never a model's impression of a page.
  push(
    "trust_gate",
    trustVerdict.ok === true,
    trustVerdict.ok === true
      ? `board trusted: ${trustVerdict.reason ?? "allowlisted ATS"}`
      : `board did not pass the trust gate: ${trustVerdict.reason ?? "no reason given"}`,
  )

  // 5. the stored screening verdict. A stage rejection defers; so does any
  //    instruction-shaped finding, because nobody is reading an approval
  //    message before this path fires.
  if (screening === null) {
    push(
      "screening",
      false,
      "no stored l0/l1/l3 screening verdict for this lead — an unscreened lead is not a safe lead",
    )
  } else if (screening.ok === false) {
    push(
      "screening",
      false,
      `screening rejected at ${screening.stage ?? "an unnamed stage"}: ` +
        `${(screening.reasons ?? []).join("; ") || "no reasons recorded"}`,
    )
  } else {
    const hostile = screeningFindingKinds(screening).filter(isDisqualifying)
    push(
      "screening",
      hostile.length === 0,
      hostile.length
        ? `the posting carries instruction-shaped text (${hostile.sort().join(", ")}) — hard rule 0`
        : "l0/l1/l3 passed with no instruction-shaped finding",
    )
  }

  // 6. OUR OWN defer assertion, deliberately duplicating submitReadiness's
  //    first branch. submitReadiness is fill-plan.mjs's, and it is allowed to
  //    change: a future relaxation of it (an exemption for some defer class
  //    that is fine to leave for the user on an ATTENDED fill) must not
  //    silently widen the unattended gate. Two independent keys.
  const defers = Array.isArray(plan.defer) ? plan.defer : []
  push(
    "plan_defer",
    defers.length === 0,
    defers.length
      ? `${defers.length} deferred field(s) need a human: ` +
          defers
            .slice(0, 5)
            .map((d) => `${d?.label ?? d?.k ?? "?"} (${d?.why ?? "?"})`)
            .join("; ")
      : "no deferred fields",
  )

  // 7. the live-scan gate: zero failures, zero verify mismatches, zero
  //    required-empty, and nothing the fill revealed that the plan never knew
  //    about.
  const readiness = submitReadiness(plan, report)
  push(
    "submit_readiness",
    readiness.ready === true,
    readiness.ready ? "submitReadiness passed" : readiness.reason,
  )

  // 8. per_company_max_per_week is counted BY COMPANY NAME. A lead with no
  //    company would be counted against the empty string, i.e. never capped —
  //    the one cap whose failure costs the user their reputation, silently
  //    disabled by a missing field.
  const company = typeof lead.company === "string" ? lead.company.trim() : ""
  const haveCompany = push(
    "company_known",
    company.length > 0,
    company
      ? `company: ${company}`
      : "the lead carries no company name, so per_company_max_per_week cannot be counted",
  )

  // 9. the caps, answered from the ledgers rather than from memory.
  if (haveCompany && haveBlock) {
    const caps = capCheck({
      company,
      caps: config,
      sentThisRun,
      dbFile,
      now,
    })
    push("caps", caps.ok === true, caps.ok ? "within every cap" : caps.reason)
  } else {
    push(
      "caps",
      false,
      "caps not evaluated: no company name or no auto_apply block",
    )
  }

  return { checks, mode, company }
}

// --- the token ---------------------------------------------------------------

// The spend ledger: the nonces of tokens this process has minted and not yet
// spent. Never a flag on the token, because the token is FROZEN and a caller
// that could mark it spent could also un-mark it.
//
// KEYED ON THE NONCE, NOT ON OBJECT IDENTITY. The first draft used a WeakSet of
// token objects, and writing its own test found the hole: `{...token}` is a
// shape-identical copy with a fresh identity, so a caller could spend an
// authorisation twice by spreading it. A nonce survives the copy.
//
// A SPEND-ONCE LEDGER, NOT A SECRET, and nothing may be built on the second
// reading. An earlier version of this comment claimed a hand-built object
// "cannot name a nonce that was ever issued". That overstates it: beginSubmit
// writes `authorized: {nonce, issued_at}` into the intent row, which reaches
// both the JSONL and the database, so the nonce is on disk in two places by
// design. What makes replay fail is DELETION ON SPEND — the nonce stops being
// live the moment it is used, whoever can read it. Do not add a check that
// relies on the nonce being unguessable, and do not remove the deletion
// thinking the randomness is doing the work.
//
// Deleting on spend also bounds this: it cannot grow past the tokens in flight.
const liveNonces = new Set()

/**
 * The single decision point.
 *
 * @returns a frozen single-use token, or { deferred: true, reason, checks }.
 * @throws {AuthorizationInputError} on a missing or malformed input.
 * @throws {StopError} when the kill switch is set. NOT a defer: STOP halts the
 *   whole run, and turning it into a per-application deferral would let a run
 *   keep going through a switch the user pulled.
 */
export function authorizeSubmit(input) {
  requireInput(input)
  const { lead, planSha, runId = null, stopPath = STOP_PATH } = input

  const { checks, mode } = evaluate(input)
  const failed = checks.filter((c) => !c.ok)
  if (failed.length) {
    return Object.freeze({
      deferred: true,
      // The FIRST failure is the headline, and every check is carried anyway:
      // a dry-run report whose only failing check is `enabled` is exactly the
      // report the user reads before deciding to turn this on, and it can only
      // say that if the other eight were evaluated too.
      reason: `${failed[0].name}: ${failed[0].detail}`,
      slug: lead.slug,
      mode,
      checks: Object.freeze(checks.map((c) => Object.freeze(c))),
      failed: Object.freeze(failed.map((c) => c.name)),
    })
  }

  // LAST, after everything else, and immediately before the token exists —
  // never third, where the original spec put it, because the caps query opens
  // the database and any check that runs AFTER the switch is read is time in
  // which the user can pull the brake and still have the click happen.
  //
  // THIS IS NOT THE PRE-CLICK READ. It used to claim it was, on the strength of
  // "nothing slow happens between this line and the caller's click" — which is
  // false as the API is now shaped, because beginSubmit() sits in that window
  // doing openDb -> INSERT -> close. The read that is genuinely immediate is in
  // consumeSubmitToken(), the click's first statement. This one is the GATE'S
  // read, and it earns its keep by refusing to mint a token at all while the
  // switch is set, so the common case (brake already on) never writes an intent
  // row that then has to be abandoned.
  //
  // This function never WRITES anything — no STOP is raised here, no ledger row
  // is added — so it needs no jobsDir boundary seam. Raising STOP on an anomaly
  // stays audit.mjs's, where the run state that explains it lives.
  assertNotStopped(CHECKPOINTS.PRE_SUBMIT, { stopPath })

  const nonce = crypto.randomBytes(16).toString("hex")
  liveNonces.add(nonce)
  return Object.freeze({
    kind: "aj.submit-authorization",
    deferred: false,
    nonce,
    slug: lead.slug,
    company: typeof lead.company === "string" ? lead.company.trim() : null,
    apply_url: lead.apply_url ?? lead.url ?? null,
    planSha,
    mode,
    runId,
    issued_at: new Date().toISOString(),
    checks: Object.freeze(checks.map((c) => Object.freeze(c))),
  })
}

/** Shape test, so a caller can reject a plain object shaped like a token. */
export function isSubmitToken(t) {
  return (
    isObj(t) && t.kind === "aj.submit-authorization" && t.deferred === false
  )
}

/**
 * Check a token WITHOUT spending it.
 *
 * Two callers, and the difference between them is the whole point:
 *
 *   * audit.mjs's beginSubmit passes THIS RUN'S mode — the one startRun was
 *     opened with. That comparison, run mode vs. the mode authorizeSubmit
 *     derived from the user's file, happens NOWHERE ELSE IN THE TREE. It is
 *     the only thing standing between "the runner decided it was live" and
 *     "the user's file says dry_run: true".
 *   * consumeSubmitToken passes the mode the CALLER states it is about to
 *     perform, which is the caller vouching for itself. Useful — it stops a
 *     rehearsal token reaching a live click — but it is not the same check.
 *
 * @throws {TokenError}
 */
export function assertTokenMatches(token, { slug, planSha, mode } = {}) {
  if (!isSubmitToken(token))
    throw new TokenError(
      "submit authorization token missing or malformed — nothing may be clicked " +
        "without one from authorizeSubmit()",
    )
  if (typeof token.nonce !== "string" || !liveNonces.has(token.nonce))
    throw new TokenError(
      `submit authorization for "${token.slug}" has already been spent, was ` +
        "copied, or was not issued by authorizeSubmit() in this process — " +
        "one authorisation is one click",
    )
  if (slug !== token.slug)
    throw new TokenError(
      `submit authorization is for "${token.slug}", not "${slug}"`,
    )
  if (planSha !== token.planSha)
    throw new TokenError(
      `submit authorization is bound to plan ${token.planSha.slice(0, 12)}…, ` +
        `but the plan about to be submitted hashes to ${String(planSha).slice(0, 12)}…`,
    )
  if (mode !== token.mode)
    throw new TokenError(
      `submit authorization is for a ${token.mode} run, but a ${mode} submit was attempted`,
    )
  return token
}

/**
 * Spend the token. THE FUNCTION THAT CLICKS CALLS THIS FIRST, and there is no
 * other way to satisfy it.
 *
 * It also reads the kill switch, and this is where "checked immediately before
 * the click" becomes literally true rather than approximately true: the gate's
 * own read happens before beginSubmit writes the intent row, which costs an
 * openDb/INSERT/close in between. Here there is nothing between this line and
 * the caller's click but the caller's own next statement. One fs.existsSync.
 *
 * A StopError thrown from here leaves an intent row open, and that is correct
 * and recoverable: a refusal AT this point is provably before the click, so the
 * runner's catch may call run.abandonAttempt(slug, reason, {beforeClick: true}).
 * That is the one case where abandoning is unambiguous.
 *
 * @throws {StopError} when the kill switch is set.
 * @throws {TokenError} on missing, wrong-shaped, spent, copied, or mismatched.
 */
export function consumeSubmitToken(
  token,
  { slug, planSha, mode, stopPath = STOP_PATH } = {},
) {
  assertTokenMatches(token, { slug, planSha, mode })
  // AFTER the token checks and BEFORE the spend: a token rejected for any other
  // reason should say so rather than reporting the switch, and a token spent
  // and then refused by the switch would be lost for the retry that never
  // happens.
  assertNotStopped(CHECKPOINTS.PRE_SUBMIT, { stopPath })
  liveNonces.delete(token.nonce)
  return token
}

/** Has this token been spent? For assertions and reports; never a gate. */
export function tokenSpent(token) {
  return isSubmitToken(token) && !liveNonces.has(token.nonce)
}
