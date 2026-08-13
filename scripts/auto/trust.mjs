// The board trust gate (§4.8). Phase 5 W1.
//
// ===========================================================================
// WHAT THIS GATE IS, AND THE QUESTION IT CANNOT ANSWER
// ===========================================================================
//
// It is MECHANICAL. Five facts, each one either true or false without anything
// reading the page: the domain is on a list the USER wrote, that list names an
// ATS this repo has an adapter for, the lead cleared every screening stage,
// the URL is https, and the origin about to be submitted to is the origin
// recorded when the job was queued. No model, no impression of the page, no
// "this posting reads as legitimate".
//
// THE LIMIT, STATED HERE SO THE NEXT AUTHOR DOES NOT ADD A THIRD PATTERN LIST.
// Every Greenhouse tenant is same-origin with every other Greenhouse tenant
// and with the cookie holding the user's Greenhouse session, and ATS tenancy is
// self-service — anyone can have one. So the allowlist answers "is this the
// vendor's software" while the gate is being asked "is this party safe to
// submit to unattended". THE ALLOWLIST CAN NEVER BE LOAD-BEARING AGAINST A
// HOSTILE TENANT, and no amount of pattern-matching added below will change
// that. The two controls that do survive a hostile tenant are structural and
// live elsewhere:
//
//   * carry no session cookie for boards that do not need one (§4.2's
//     non-persistent lane), so there is nothing on the wire to steal; and
//   * never read anything back out of the page for a decision — which is true
//     today and must stay true.
//
// Adding a sixth heuristic here would look like progress and would buy none.
//
// ===========================================================================
// WHY THIS DOES NOT CALL detectAts()
// ===========================================================================
//
// `detectAts` (scripts/apply/ats/index.mjs) matches its adapter regexes against
// the WHOLE URL STRING, deliberately — the fake-board fixture depends on it and
// its own header records the finding. For picking a fill strategy that is
// fail-safe: the wrong adapter defers more fields. For a TRUST decision it is
// fail-dangerous, because a third party controls the query string:
//
//     https://evil.example/apply?utm_source=boards.greenhouse.io
//
// would "match greenhouse". So the ATS is not inferred from the URL at all
// here. It is DECLARED, by the user, next to the domain in their own file, and
// this gate only checks that the declared id is an adapter this repo ships.
import fs from "node:fs"

import { ADAPTERS } from "../apply/ats/index.mjs"
import { loadYamlFile } from "../lib/lib.mjs"
import { submitOrigin } from "./authorize.mjs"
import { isDisqualifying } from "../lib/untrusted.mjs"
import { safeText } from "./untrusted-text.mjs"

// The five checks, named. A closed list, for the same reason authorize.mjs
// keeps SUBMIT_CHECKS: a report can say which one refused without parsing
// prose, and a sixth has to be added HERE rather than smuggled in as an early
// return.
export const TRUST_CHECKS = Object.freeze([
  "allowlist",
  "adapter",
  "screening",
  "https",
  "origin_stable",
])

/** The adapter ids this repo actually ships, for check 2. */
export const ADAPTER_IDS = Object.freeze(ADAPTERS.map((a) => a.id))

// Loopback, for the fixture exemption below. Not a hostname test: a board that
// resolves 127.0.0.1 through DNS is still a third party, so this is the literal
// address only.
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]", "::1", "localhost"])

/** Is `host` this machine, literally? */
export function isLoopbackHost(host) {
  return LOOPBACK_HOSTS.has(String(host ?? "").toLowerCase())
}

/**
 * Does `host` fall under the allowlist entry `domain`?
 *
 * Exact match, or a dot-delimited subdomain of it. The dot is what stops
 * `evilgreenhouse.io` matching an entry of `greenhouse.io` — a bare
 * `endsWith` would accept it, and that is the whole bug this function exists
 * to not have.
 */
export function domainMatches(host, domain) {
  const h = String(host ?? "").toLowerCase()
  const d = String(domain ?? "")
    .toLowerCase()
    .replace(/^\.+/, "")
  if (!h || !d) return false
  return h === d || h.endsWith(`.${d}`)
}

/**
 * Normalise the user's allowlist into `[{domain, ats}]`.
 *
 * Two shapes are accepted because the user writes this by hand:
 *
 *   board_allowlist:
 *     boards.greenhouse.io: greenhouse      # a map, the recommended form
 *
 *   board_allowlist:
 *     - domain: boards.greenhouse.io        # a list of objects
 *       ats: greenhouse
 *
 * A BARE LIST OF DOMAIN STRINGS IS DELIBERATELY NOT ACCEPTED. It would leave
 * the ATS to be inferred from the URL, which is the thing the header above
 * refuses to do. An entry with no `ats` is dropped here and reported by
 * `allowlistProblems()` rather than silently treated as trusted.
 */
export function normalizeAllowlist(raw) {
  const out = []
  if (!raw) return out
  const push = (domain, ats) => {
    const d = String(domain ?? "").trim()
    const a = String(ats ?? "").trim()
    if (!d || !a) return
    out.push({ domain: d.toLowerCase().replace(/^\.+/, ""), ats: a })
  }
  if (Array.isArray(raw)) {
    for (const e of raw) {
      if (e && typeof e === "object") push(e.domain ?? e.host, e.ats ?? e.id)
    }
    return out
  }
  if (typeof raw === "object") {
    for (const [domain, ats] of Object.entries(raw)) {
      push(domain, typeof ats === "object" ? (ats?.ats ?? ats?.id) : ats)
    }
  }
  return out
}

/**
 * Everything wrong with the user's allowlist, as strings they can act on.
 *
 * Separate from the gate on purpose: the gate refuses ONE job and says why,
 * while this answers "why is nothing being submitted" in one line at startup.
 * A typo'd ats id would otherwise show up only as every job deferring
 * `board-untrusted`, which reads as "the boards are untrusted" rather than
 * "your file says `greenhosue`".
 */
export function allowlistProblems(raw) {
  const problems = []
  if (raw === undefined || raw === null) {
    problems.push(
      "auto_apply.board_allowlist is absent from docs/application-limits.yaml — " +
        "no board is trusted, so every job will defer board-untrusted. That file " +
        "is yours; the agent proposes values and never edits it.",
    )
    return problems
  }
  const entries = normalizeAllowlist(raw)
  if (!entries.length) {
    problems.push(
      "auto_apply.board_allowlist has no usable entries — each one needs a " +
        "domain AND the ats id serving it, e.g. `boards.greenhouse.io: greenhouse`",
    )
  }
  for (const e of entries) {
    if (!ADAPTER_IDS.includes(e.ats)) {
      problems.push(
        `board_allowlist entry "${safeText(e.domain, 80)}" names ats "${safeText(e.ats, 40)}", ` +
          `which is not an adapter this repo ships (${ADAPTER_IDS.join(", ")})`,
      )
    }
  }
  return problems
}

/** The entry covering `host`, or null. Longest domain wins, so a specific
 *  entry beats a broad one when the user has written both. */
export function allowlistEntry(host, entries) {
  let best = null
  for (const e of entries) {
    if (!domainMatches(host, e.domain)) continue
    if (!best || e.domain.length > best.domain.length) best = e
  }
  return best
}

// Screening: the lead must have cleared L0-L3 with no instruction-shaped
// finding. `isDisqualifying` draws that line and is NOT re-listed here — a
// second copy of that list is a second thing to forget to update (rule 0).
function screeningVerdict(screening) {
  // NEVER SCREENED IS NOT THE SAME EVENT AS REJECTED, and the kinds differ for
  // a reason the digest depends on. `l3-rejected` means a screening stage
  // looked at this lead and said no — a working control, and a number that
  // should stay non-zero. "No verdict on file" means the lead never went
  // through screening at all, which is a gap in the pipeline feeding the
  // runner, not a board being hostile. Collapsing them would put a plumbing
  // problem in the bucket the user reads as "boards rejecting me".
  if (!screening || typeof screening !== "object")
    return {
      ok: false,
      kind: "board-untrusted",
      detail:
        "no stored screening verdict for this lead — nothing may be submitted " +
        "unattended on a posting no screening stage has looked at",
    }

  const rejected =
    screening.verdict === "reject" ||
    screening.rejected === true ||
    screening.status === "dismissed"
  if (rejected)
    return {
      ok: false,
      kind: "l3-rejected",
      detail: `screening rejected this lead (${safeText(screening.reason ?? screening.verdict ?? "no reason recorded", 120)})`,
    }

  const findings = []
  const sources = [
    screening,
    screening.stages?.l3,
    screening.l3,
    screening.risk,
  ].filter((s) => s && typeof s === "object")
  for (const src of sources)
    for (const f of src.findings ?? []) findings.push(f)

  const bad = findings.filter((f) => isDisqualifying(f?.kind ?? f))
  if (bad.length)
    return {
      ok: false,
      kind: "l3-rejected",
      detail:
        `L3 recorded ${bad.length} instruction-shaped finding(s): ` +
        bad.map((f) => safeText(f?.kind ?? f, 40)).join(", "),
    }
  return {
    ok: true,
    kind: null,
    detail: "cleared L0-L3, no disqualifying finding",
  }
}

/**
 * The gate.
 *
 * @param lead            the stored lead. `apply_url` (Phase 0.13) is what is
 *                        checked — never `url`, which for an aggregator lead is
 *                        the aggregator, not the board.
 * @param limits          the parsed docs/application-limits.yaml (the whole
 *                        document, or just its auto_apply block).
 * @param screening       the stored screening verdict, or null.
 * @param recordedOrigin  the origin recorded for this job when it was queued
 *                        (`auto_queue.origin`). Check 5 compares against THIS
 *                        rather than against another field of the same lead
 *                        row, because comparing a row against itself is a
 *                        tautology: the point is to catch the lead store
 *                        changing under a queued job.
 * @param allowLoopbackHttp  the fixture exemption. OFF by default, set only by
 *                        the runner's --fixture flag, and it widens check 4
 *                        for 127.0.0.1 ONLY — an http URL on any other host is
 *                        still refused with the flag on, and a test asserts it.
 * @returns {{ok, reason, kind, checks, entry, origin}}
 *   `kind` is the taxonomy kind the FIRST failing check names. It is decided
 *   here rather than by the caller because only the check knows why it failed:
 *   "no screening verdict on file" and "L3 rejected this lead" are the same
 *   check and different kinds, and a caller mapping check names to kinds gets
 *   that wrong every time.
 */
export function trustBoard({
  lead,
  limits = null,
  screening = null,
  recordedOrigin = null,
  allowLoopbackHttp = false,
} = {}) {
  const checks = []
  const add = (name, ok, detail, kind = "board-untrusted") => {
    checks.push({ name, ok, detail, kind: ok ? null : kind })
    return ok
  }

  const auto = limits?.auto_apply ?? limits ?? null
  const entries = normalizeAllowlist(auto?.board_allowlist)

  const applyUrl = lead?.apply_url ?? null
  let parsed = null
  try {
    parsed = applyUrl ? new URL(String(applyUrl)) : null
  } catch {
    parsed = null
  }

  // 1. allowlist
  let entry = null
  if (!parsed) {
    add(
      "allowlist",
      false,
      applyUrl
        ? `apply_url is not a URL (${safeText(applyUrl, 80)})`
        : "the lead carries no apply_url — Phase 0.13 canonicalization did not " +
            "resolve this lead to the board behind it, so there is no domain to trust",
    )
  } else if (!entries.length) {
    add(
      "allowlist",
      false,
      "auto_apply.board_allowlist is absent or empty in the user's limits file — " +
        "no board is trusted until they add one",
    )
  } else {
    entry = allowlistEntry(parsed.hostname, entries)
    add(
      "allowlist",
      Boolean(entry),
      entry
        ? `${parsed.hostname} is covered by allowlist entry "${entry.domain}"`
        : `${safeText(parsed.hostname, 80)} is not on auto_apply.board_allowlist`,
    )
  }

  // 2. adapter — the id the USER declared, checked against what ships.
  add(
    "adapter",
    Boolean(entry) && ADAPTER_IDS.includes(entry.ats),
    entry
      ? ADAPTER_IDS.includes(entry.ats)
        ? `allowlist declares ats "${entry.ats}", which is a shipped adapter`
        : `allowlist declares ats "${safeText(entry.ats, 40)}", which is not a shipped ` +
          `adapter (${ADAPTER_IDS.join(", ")})`
      : "no allowlist entry, so no declared ats",
  )

  // 3. screening
  const s = screeningVerdict(screening)
  add("screening", s.ok, s.detail, s.kind ?? "board-untrusted")

  // 4. https — with the loopback exemption, and nothing else.
  if (!parsed) {
    add("https", false, "no parseable apply_url")
  } else if (parsed.protocol === "https:") {
    add("https", true, "apply_url is https")
  } else if (
    allowLoopbackHttp &&
    parsed.protocol === "http:" &&
    isLoopbackHost(parsed.hostname)
  ) {
    // The fixture serves plain http on an ephemeral loopback port. The
    // exemption is scoped to BOTH conditions — flag on AND literally this
    // machine — so turning the flag on cannot widen the gate to the internet.
    add("https", true, "http permitted: loopback fixture, --fixture is set")
  } else {
    add(
      "https",
      false,
      `apply_url is ${parsed.protocol}//, not https` +
        (parsed.protocol === "http:" && isLoopbackHost(parsed.hostname)
          ? " (loopback http needs the runner's --fixture flag)"
          : ""),
    )
  }

  // 5. origin_stable
  const liveOrigin = submitOrigin(applyUrl)
  if (!recordedOrigin) {
    add(
      "origin_stable",
      false,
      "no origin was recorded for this job when it was queued, so there is " +
        "nothing to compare the apply URL against",
    )
  } else if (!liveOrigin) {
    add("origin_stable", false, "apply_url has no spendable http(s) origin")
  } else {
    // A MISMATCH HERE IS A MALFUNCTION OF OURS, not a board declining, so it
    // carries a FAILURE kind. The row was queued with one origin and the lead
    // store now says another: either canonicalization re-resolved the lead
    // mid-run or something rewrote it. Filing that under `board-untrusted`
    // would report our own inconsistency as the board's fault.
    add(
      "origin_stable",
      liveOrigin === recordedOrigin,
      liveOrigin === recordedOrigin
        ? `origin ${liveOrigin} matches the one recorded at queue time`
        : `apply_url is now on ${safeText(liveOrigin, 80)} but was queued as ` +
            `${safeText(recordedOrigin, 80)} — the lead store changed under a queued job`,
      "origin-mismatch",
    )
  }

  const failed = checks.filter((c) => !c.ok)
  return Object.freeze({
    ok: failed.length === 0,
    // First failure is the headline; every check is carried, because the
    // report the user reads before enabling this needs to show the ones that
    // passed too.
    reason: failed.length ? `${failed[0].name}: ${failed[0].detail}` : null,
    kind: failed.length ? (failed[0].kind ?? "board-untrusted") : null,
    checks: Object.freeze(checks.map((c) => Object.freeze(c))),
    failed: Object.freeze(failed.map((c) => c.name)),
    entry: entry ? Object.freeze({ ...entry }) : null,
    origin: liveOrigin,
  })
}

/** Read a limits file, or null when it is absent. Never throws on absence:
 *  "the user has no limits file" is a policy state the gate reports, not a
 *  crash. A malformed one DOES throw — silently treating unparseable YAML as
 *  "no config" is how a typo turns into an open gate. */
export function readLimits(file) {
  if (!file || !fs.existsSync(file)) return null
  return loadYamlFile(file)
}
