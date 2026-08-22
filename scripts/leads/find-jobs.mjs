#!/usr/bin/env node
// Deterministic job-lead finder (no LLM calls). Sweeps the public,
// integration-friendly job APIs listed in docs/job-sources.yaml (Greenhouse,
// Lever, Ashby, SmartRecruiters, Workable, Recruitee, Workday CXS) plus
// Hacker News, filters every hit through docs/application-limits.yaml,
// dedupes against stored leads and application history, and maintains the
// lead store at jobs/leads.json.
//
// Usage:
//   node scripts/leads/find-jobs.mjs search [--source all|hn|boards|adzuna] [--query "full stack"] [--max-age N] [--leads <path>]
//   node scripts/leads/find-jobs.mjs import <file.json> [--leads <path>]   # leads captured in-session (Playwright/WebFetch)
//   --leads overrides the store (and its lock) from jobs/leads.db — for tests only; omit it in normal use.
//   node scripts/leads/find-jobs.mjs list [--status new|recommended|dismissed|applied|all]
//   node scripts/leads/find-jobs.mjs mark <id-or-url> --status <status> [--notes "..."]
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import yaml from "js-yaml"
import {
  isTerse,
  mapPool,
  fetchJson,
  fetchText,
  decodeEntities,
  textSnippet,
  SNIPPET_MAX,
} from "../lib/lib.mjs"
import { untrustedSnippet } from "../lib/untrusted.mjs"
import { enrichDescriptions } from "./enrich.mjs"
import { canonicalizeLeads } from "./canonical.mjs"
import { withLock, LEADS_LOCK, lockPathFor } from "../lib/lock.mjs"
import {
  readLeadStore,
  writeLeadStore,
  openDb,
  setLeadStatus,
  resolveLeadSource,
  setLeadKeywords,
  readApplications,
  recordBoardStats,
} from "../lib/db.mjs"
import { extractTech } from "../profile/profile-gaps.mjs"

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
)
const LIMITS_PATH = path.join(ROOT, "docs", "application-limits.yaml")
const SOURCES_PATH = path.join(ROOT, "docs", "job-sources.yaml")

const STATUSES = ["new", "recommended", "dismissed", "applied"]

// Fallback if docs/job-sources.yaml is missing — the YAML is the real,
// user-editable list.
export const DEFAULT_BOARDS = [
  { type: "greenhouse", slug: "anthropic", company: "Anthropic" },
  { type: "ashby", slug: "openai", company: "OpenAI" },
]

export function loadSources(file = SOURCES_PATH) {
  if (!fs.existsSync(file)) return DEFAULT_BOARDS
  const doc = yaml.load(fs.readFileSync(file, "utf8"))
  return doc?.boards?.length ? doc.boards : DEFAULT_BOARDS
}

// ---------------------------------------------------------------------------
// Pure logic (exported for tests)
// ---------------------------------------------------------------------------

// Widened title test, applied ONLY to locally-commutable postings (see below).
const LOOSE_TECH_TITLE =
  /\b(software|developer|programmer|engineer|architect|analyst|application|web|data|technical|systems?)\b/i
// ...minus the trades. A casino's "engineers" are overwhelmingly facilities
// staff: painters, electricians, plumbers, stationary engineers.
// Stems, not whole words: "\bplumb\b" does not match "Plumber". "General
// Engineer" is a casino facilities title, not a software one. The second group
// exists because "analyst" is broad enough to drag in procurement and finance.
const TRADES_TITLE =
  /\b(maintenance|facilit\w*|paint\w*|electric\w*|plumb\w*|stationary|hvac|refrigerat\w*|custodial|grounds|kitchen|landscap\w*|carpenter|locksmith|janitor\w*|general engineer|slot technician)\b|\b(procurement|financial|finance|accounting|payroll|human resources|media operations|revenue management|benefits|tax|audit|credit|collections|supply chain|logistics)\b/i

// Location strings that state WHO MAY BE HIRED rather than where to move. A
// remote posting open to the whole country says "USA", not "Remote"; treating
// that as a relocation is a false reject (see passesLimits for the counts).
//
// Deliberately anchored to the WHOLE string. A substring match would read
// "Tulsa, USA" as country-wide remote, which it plainly is not — the point is
// that the location field names no city at all. "Worldwide" and "Anywhere"
// qualify because they include the US; a non-US carve-out elsewhere in the
// string is still caught by the NON_US check that runs alongside this.
//
// Overridable per-user via docs/application-limits.yaml location.remote_synonyms.
export const US_WIDE_LOCATION = [
  "usa",
  "u.s.",
  "u.s.a.",
  "us",
  "united states",
  "united states of america",
  "anywhere",
  "anywhere in the us",
  "worldwide",
  "global",
  "north america",
  "northern america",
  "remote us",
  "us remote",
  "remote (us)",
  "remote - us",
  "remote, us",
  "remote - united states",
  "flexible / remote",
  "fully remote",
  "distributed",
]

// Whole-string, case- and punctuation-insensitive membership test. Trailing
// punctuation and doubled spaces are stripped so "Remote (US)" and "remote - us"
// both land on the same entry.
export function matchesAny(value, list) {
  const norm = (s) =>
    String(s ?? "")
      .toLowerCase()
      .replace(/[().,\-–—/]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  const v = norm(value)
  return (list ?? []).some((entry) => norm(entry) === v)
}

// Whole-word title matching. Substring matching would make "sr" hit "usr" and
// "lead" hit "leading", so every hard/soft filter term is anchored on \b.
// Returns the matched keyword (for the reason string) or undefined.
export function matchTitleKeyword(title, keywords) {
  return (keywords ?? []).find((k) => {
    const esc = String(k)
      .toLowerCase()
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    return new RegExp(`\\b${esc}\\b`, "i").test(title)
  })
}

export function passesLimits(job, limits, now = new Date()) {
  const reasons = []
  const flags = []
  let local = false

  const title = String(job.title ?? "").toLowerCase()
  const kws = limits.roles?.title_keywords ?? []
  const titleHit =
    !kws.length || kws.some((k) => title.includes(String(k).toLowerCase()))

  // Hard filter runs before everything else: a title above the experience bar
  // or in the wrong discipline is not worth geocoding, dating, or storing.
  const hardHit = matchTitleKeyword(title, limits.roles?.hard_filter)
  if (hardHit) {
    return {
      ok: false,
      reasons: [`title: "${hardHit}" is hard-filtered`],
      flags: [],
    }
  }
  // Soft filter never rejects — it marks the lead so screening reads the body
  // before any tailoring effort is spent.
  const softHit = matchTitleKeyword(title, limits.roles?.soft_filter)
  if (softHit) flags.push(`title_watch:${softHit}`)

  const loc = String(job.location ?? "")
    .trim()
    .toLowerCase()
  // Workday collapses a multi-site posting to the literal string "2 Locations",
  // which carries no geography at all. Treating that as a location rejected it
  // as a relocation — and multi-site postings skew towards exactly the roles
  // worth seeing. Flag for screening to resolve instead of discarding.
  const OPAQUE_LOC = /^\d+\s*locations?$/i
  // Greenhouse's own way of saying the same thing: some boards (Cloudflare,
  // measured 2026-08-02) fill the location field with the WORK ARRANGEMENT
  // ("Hybrid", "In-Office") instead of a place, which carries exactly as much
  // geography as "2 Locations" does — none. Matched on shape (the ENTIRE
  // trimmed value is nothing but an arrangement word) so a future board's own
  // spelling of this is caught without hard-coding Cloudflare's two literals —
  // "Hybrid - San Francisco, New York" still falls through to the real check
  // below because it names actual cities. "Remote" is deliberately excluded
  // from this list: unlike "Hybrid"/"In-Office" it IS informative (not tied to
  // any office) and is read by the remote-text check below, not this one.
  const WORK_ARRANGEMENT_ONLY = /^(in[-\s]?office|on[-\s]?site|office|hybrid)$/i
  if (!loc || OPAQUE_LOC.test(loc) || WORK_ARRANGEMENT_ONLY.test(loc)) {
    flags.push("unknown_location")
  } else {
    // "Remote" restricted to a non-US region is still a relocation for a
    // North Las Vegas applicant; an explicit US marker overrides.
    const NON_US =
      /(france|germany|italy|spain|poland|netherlands|ireland|dublin|london|united kingdom|\buk\b|europe|emea|apac|australia|sydney|canada|toronto|vancouver|india|singapore|japan|brazil|mexico)/
    const US_MARK = /(united states|\busa?\b|u\.s\.|america)/
    const nonUsOnly = NON_US.test(loc) && !US_MARK.test(loc)
    const onsiteOk = (limits.location?.onsite_allowed ?? []).some((a) =>
      loc.includes(String(a).toLowerCase()),
    )
    // A country-level location string on a remote posting IS the remote
    // statement — it is naming who may be hired, not where to move.
    //
    // Without this the gate read `location: "USA"` as "would require relocating
    // away from North Las Vegas" and threw the posting out. That is how every
    // remote-only aggregator expresses US-remote, and on 2026-07-29 it rejected
    // 35 of 35 Remotive, 50 of 50 Jobicy and 100 of 100 RemoteOK postings —
    // a false reject, which is the worst failure this pipeline has, aimed
    // squarely at the remote roles that are most of the reachable market.
    const usWide = matchesAny(
      loc,
      limits.location?.remote_synonyms ?? US_WIDE_LOCATION,
    )
    // A board whose ENTIRE corpus is remote roles has already answered the
    // question; its postings should not each be re-doubted. Set by the fetcher
    // for sources declared `remote_only` in docs/job-sources.yaml.
    const remoteBySource = job.remote_source === true
    const remoteText = (/\bremote\b/.test(loc) || usWide) && !nonUsOnly
    // Board-level remote flag with a contradictory on-site location string is
    // kept but flagged: screening must confirm it is truly remote-from-NV.
    const remoteFlagged = (job.remote === true || remoteBySource) && !nonUsOnly
    const remoteOk =
      (limits.location?.remote_ok ?? true) && (remoteText || remoteFlagged)
    if (!remoteOk && !onsiteOk) {
      reasons.push(
        `location: "${job.location}" would require relocating away from ${limits.location?.base ?? "base"}`,
      )
    } else if (remoteOk && !remoteText && !remoteBySource && !onsiteOk) {
      flags.push("remote_unverified")
    }
    local = onsiteOk
  }

  // A commutable posting is rare enough to be worth a look even when its title
  // misses the keyword list — Caesars' "Staff Engineer - Booking Engine" is a
  // real Las Vegas software job that matched none of them. Remote postings are
  // NOT given this latitude: there are thousands and the gate is what keeps
  // them manageable. Flagged so screening knows it arrived on a loose match.
  if (
    !titleHit &&
    local &&
    LOOSE_TECH_TITLE.test(title) &&
    !TRADES_TITLE.test(title)
  ) {
    flags.push("title_loose")
  } else if (!titleHit) {
    reasons.push("title: not a targeted role")
  }

  const maxAge = limits.freshness?.max_age_days ?? 30
  if (job.posted_at) {
    const posted = new Date(job.posted_at)
    if (Number.isNaN(posted.getTime())) {
      flags.push("unknown_age")
    } else {
      const ageDays = (now.getTime() - posted.getTime()) / 86400000
      if (ageDays > maxAge) {
        reasons.push(
          `stale: posted ${Math.round(ageDays)} days ago (max ${maxAge})`,
        )
      }
    }
  } else {
    flags.push("unknown_age")
  }

  // Salary gate — active only when the user sets compensation.min_salary.
  const minSalary = limits.compensation?.min_salary
  if (minSalary != null) {
    if (job.salary_max != null) {
      if (job.salary_max < minSalary) {
        reasons.push(`salary: tops out at ${job.salary_max} (min ${minSalary})`)
      }
    } else if (limits.compensation?.flag_missing !== false) {
      flags.push("no_salary")
    }
  }

  return { ok: reasons.length === 0, reasons, flags }
}

// ---------------------------------------------------------------------------
// Body gate. passesLimits above reads only the title, location and date the
// board hands over in its list payload — the cheap fields. Everything that
// actually disqualifies a posting tends to be a sentence in its body, and
// until 2026-07-29 nothing in the sweep read that body at all.
//
// The three cases that motivated this, all from the live store:
//   * Station Casinos "Junior Engineer - Palace" — passed on local latitude,
//     body is "Pick up supplies and parts from vendors. Perform all repairs,
//     maintenance and part replacements... preventive maintenance schedule".
//     A building-maintenance job sitting in the store as a software lead.
//   * Fusion HCR "Full Stack Developer" — clean title, body says
//     "Type: Contract (Through End of Year)".
//   * Twilio — board says remote, body says "This role will be based in our
//     San Francisco, California office" AND "This role will be remote, but is
//     not eligible to be hired in CA, CT, IL, ...".
//
// Precision over recall throughout. A false reject here is a job the user never
// sees, which is worse than a flag they can dismiss, so anything ambiguous
// FLAGS and leaves the judgment to screening. Only the unambiguous cases reject.
// ---------------------------------------------------------------------------

// Phrases that only appear in postings about building software. Every term here
// is deliberately unambiguous, because this pattern decides whether a posting is
// technical at all and job-posting prose is full of near-misses: the first
// version of this matched bare "code" and read Station Casinos' "Be familiar
// with OSHA safety codes" as evidence of a software job. "application" (job
// application), "rest" (the rest of the team), "framework" (regulatory
// framework) and "library" all fail the same way and are excluded on purpose.
const SOFTWARE_BODY =
  /\b(software (?:engineer|developer|development|engineering)|source code|codebase|coding|writes? code|programming|scripting|web (?:application|development|app|service)|api\b|apis\b|sdk\b|back-?end|front-?end|full-?stack|micro-?services?|version control|unit test\w*|code review|pull request|graphql|rest(?:ful)? api|data structures?|algorithms?|database|sql\b|git\b|ci\/cd|deployment pipeline|typescript|javascript|python|react\b|node\.?js|html|css|\.net|c#|java\b)/i

// Body vocabulary of the non-software jobs that reach the store on a loose or
// local title match. Three groups, all drawn from live postings: casino
// facilities work, hospitality/floor work, and back-office finance.
//
// The hospitality group exists because the local boards (Station Casinos,
// Boyd, Caesars) are overwhelmingly casino-floor postings and a handful reach
// the store on local title latitude — "Junior Engineer - Palace" was a
// maintenance job and a "Kitchen Worker" probe cleared the gate on nothing but
// hospitality boilerplate.
//
// Every term is picked to be unambiguous in a software posting: "maintain
// cleanliness" not "cleanliness" (code cleanliness), "beverage server" not
// "server", "guest services" not "guest".
const NON_SOFTWARE_BODY =
  /\b(preventive maintenance|repairs? and maintenance|part replacements?|hvac|refrigerat\w*|plumb\w*|electrical (system|panel|wiring)|guest rooms?|casino floor equipment|slot machines?|hand tools|painting|landscap\w*|custodial|janitor\w*|housekeep\w*)\b|\b(maintain cleanliness|kitchen|culinary|bartend\w*|banquet|buffet|(?:beverage|food|cocktail) server|valet|table games|front desk|guest services?|security officer|cashier|dealer school|food and beverage)\b|\b(invoices?|purchase orders?|vendor contracts?|accounts payable|accounts receivable|general ledger|reconcil\w+ accounts)\b/i

// docs/application-limits.yaml's roles.exclude_body (P1, retarget-readiness
// audit 2026-08), optional and REPLACING (never merging with) NON_SOFTWARE_BODY
// when present — same convention location.remote_synonyms already documents
// ("Leave this key out entirely to use the built-in list... setting it
// REPLACES the built-in list"). Absent key -> today's regex groups exactly.
//
// A TERM LIST, deliberately, never a boolean: `bodyDisqualifiers` hard-rejects
// on this pattern with NO caution step (see the call site below), because the
// gate exists for real casino-boilerplate noise ("Junior Engineer - Palace"
// was a maintenance job). A `roles.skip_body_gate: true` escape hatch would
// let a retarget switch that whole control off; a term list only ever lets
// the user say WHAT it rejects on, never THAT it rejects — the reject stays,
// only its vocabulary is the user's to curate.
//
// An EMPTY array is deliberately treated as absent, not as "reject on
// nothing": `exclude_body: []` would otherwise be exactly the off-switch this
// key exists to refuse, just spelled as a list instead of a boolean. Only a
// non-empty list replaces the built-in.
//
// Terms are matched the same way every other roles.* term list in this file
// is — literal phrase, case-insensitive, whole-word/phrase boundaries (see
// matchTitleKeyword) — never a regex fragment, so a user editing this list
// writes plain words, not patterns.
export function excludeBodyPattern(limits = {}) {
  const custom = (limits.roles?.exclude_body ?? []).filter(
    (t) => String(t ?? "").trim() !== "",
  )
  if (!custom.length) return NON_SOFTWARE_BODY
  const alts = custom
    .map((t) =>
      String(t)
        .toLowerCase()
        .trim()
        .replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    )
    .sort((a, b) => b.length - a.length) // longer phrases first — avoids a
  // short alternative ("guest") shadowing a longer one ("guest services")
  // that starts with it in the same alternation.
  return new RegExp(`\\b(?:${alts.join("|")})\\b`, "i")
}

// "must relocate", not "relocation assistance available" — the second is a perk
// and matching it would reject the roles that are easiest to take.
const RELOCATION_REQUIRED =
  /\b(must|required to|expected to|willing(?:ness)? to)\s+(?:be\s+)?relocat\w*|\brelocation\s+(?:is\s+)?(?:required|mandatory|expected)\b/i

// Remote postings that carve out states. Only decisive when the carve-out names
// this user's state; a list that excludes California says nothing about Nevada.
const STATE_EXCLUSION =
  /\bnot\s+(?:eligible|available|able)\s+(?:to\s+be\s+hired|for\s+hire|to\s+hire|for\s+employment)?\s*in\b([^.]{0,400})/gi

// In-office expectation stated in the body. Flagged, never rejected: the Twilio
// posting carries three mutually contradictory location sentences pasted one
// after another, so any single-sentence match is as likely to be stale
// boilerplate as it is to be the real requirement.
const ONSITE_BODY =
  /\b(?:\d+\s*(?:\+)?\s*days?\s*(?:per|a)\s*week\s*(?:in\s*(?:the\s*)?office|on-?site)|hybrid\s+(?:role|position|schedule)|(?:this\s+)?role\s+(?:will\s+)?(?:be\s+)?(?:is\s+)?based\s+(?:out\s+of|in|at)\s+our|required\s+to\s+(?:work\s+)?(?:on-?site|in\s+(?:the\s+)?office))/i

// Employment shapes that are not full-time permanent. Anchored on an explicit
// type declaration or a duration, so the word "contract" inside "contract law"
// or "contract negotiation" (common in the analyst postings) cannot trip it.
const EMPLOYMENT_SHAPE = [
  [
    /\b(?:employment|position|job|role|opportunity)\s*type\s*[:\-]?\s*(contract|temporary|temp|part[-\s]?time|seasonal|intern(?:ship)?)/i,
    (m) => m[1].toLowerCase().replace(/\s+/g, "-"),
  ],
  [/\b(contract|temp)[-\s]?to[-\s]?hire\b/i, () => "contract-to-hire"],
  [
    /\bthis is a\s+(?:\d+[-\s]?month\s+)?(contract|temporary|part[-\s]?time|seasonal|internship)\b/i,
    (m) => m[1].toLowerCase().replace(/\s+/g, "-"),
  ],
  [
    /\b\d+[-\s]?month\s+(?:contract|assignment|engagement)\b/i,
    () => "contract",
  ],
  [/\bfixed[-\s]?term\s+(?:contract|position|role)\b/i, () => "fixed-term"],
  [
    /\btype\s*:\s*contract\b|\bcontract\s*\((?:through|thru)[^)]*\)/i,
    () => "contract",
  ],
]

// A seniority bar stated in the body of a posting whose title hides it. The
// motivating case is Chainguard's "Software Engineer (Libraries Platform)",
// whose body said "join as a Senior Software Engineer" — a title filter cannot
// see that, and screen.mjs' years gate only fires if a number is stated.
const SENIOR_IN_BODY =
  /\b(?:join(?:ing)?(?:\s+us)?\s+as\s+an?|hiring\s+an?|seeking\s+an?|as\s+an?)\s+(senior|staff|principal|lead|distinguished)\s+(?:software|full-?stack|back-?end|front-?end|web|platform)?\s*(?:engineer|developer)\b/i

// Reads the parts of a posting the list endpoints do not give us. Returns the
// same {ok, reasons, flags} shape as passesLimits so ingest can treat the two
// gates identically. A lead with no description at all passes: this gate can
// only speak to text it actually has.
export function bodyDisqualifiers(job, limits = {}) {
  const reasons = []
  const flags = []
  const text = [job.description, ...(job.requirements ?? [])]
    .filter(Boolean)
    .join("\n")
  if (!text) return { ok: true, reasons, flags }

  const titleKws = limits.roles?.title_keywords ?? []
  const title = String(job.title ?? "").toLowerCase()
  // A title that names the discipline outright ("Full Stack Developer") is
  // trusted; the non-software check is aimed at the leads that arrived on
  // local latitude or on a generic "Engineer"/"Analyst" match.
  const explicitTech =
    /\b(full[-\s]?stack|back[-\s]?end|front[-\s]?end|software (developer|engineer)|web developer|game (developer|engineer|mathematician))\b/i.test(
      title,
    )
  const looseArrival =
    (job.flags ?? []).includes("title_loose") ||
    !titleKws.some((k) => title.includes(String(k).toLowerCase()))

  const nonSoftwareBody = excludeBodyPattern(limits)
  if (!explicitTech && (looseArrival || nonSoftwareBody.test(text))) {
    if (!SOFTWARE_BODY.test(text) && nonSoftwareBody.test(text)) {
      reasons.push("body: not a software role (no software work described)")
    } else if (!SOFTWARE_BODY.test(text)) {
      flags.push("body_not_technical")
    }
  }

  if (RELOCATION_REQUIRED.test(text)) {
    reasons.push("body: requires relocating away from base")
  }

  // Only worth saying when the TITLE was clean — a posting titled "Senior
  // Backend Engineer" is already rejected by the hard title filter, and
  // reporting "the title hid it" about those would be plainly wrong.
  const titleStatesLevel =
    /\b(senior|sr\.?|staff|principal|lead|distinguished)\b/i.test(title)
  if (!titleStatesLevel) {
    const m = SENIOR_IN_BODY.exec(text)
    if (m)
      reasons.push(`body: states a ${m[1].toLowerCase()} bar the title hid`)
  }

  // Only the carve-outs that name this user's state are decisive.
  const base = String(limits.location?.base ?? "")
  const st = /,\s*([A-Z]{2})\b/.exec(base)?.[1] ?? "NV"
  const stateName =
    { NV: "nevada", CA: "california", AZ: "arizona", UT: "utah" }[st] ?? null
  STATE_EXCLUSION.lastIndex = 0
  for (const m of text.matchAll(STATE_EXCLUSION)) {
    const tail = m[1] ?? ""
    const named =
      new RegExp(`\\b${st}\\b`).test(tail) ||
      (stateName && new RegExp(`\\b${stateName}\\b`, "i").test(tail))
    if (named) {
      reasons.push(`body: not eligible for hire in ${st}`)
      break
    }
  }

  for (const [re, label] of EMPLOYMENT_SHAPE) {
    const m = re.exec(text)
    if (!m) continue
    const kind = label(m)
    const rejectTypes = (limits.employment?.reject_types ?? []).map((t) =>
      String(t).toLowerCase(),
    )
    if (rejectTypes.includes(kind)) {
      reasons.push(`body: ${kind}, not full-time permanent`)
    } else {
      flags.push(`employment:${kind}`)
    }
    break
  }

  if (ONSITE_BODY.test(text)) {
    const onsiteOk = (limits.location?.onsite_allowed ?? []).some((a) =>
      new RegExp(
        `\\b${String(a).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
        "i",
      ).test(text),
    )
    if (!onsiteOk) flags.push("onsite_conflict")
  }

  return { ok: reasons.length === 0, reasons, flags }
}

// Best-effort max-salary parse from strings like "$150K – $220K • 0.15%".
// Returns annual USD or null; amounts under 1000 are treated as $K shorthand.
export function parseSalaryMax(text) {
  const matches = [
    ...String(text ?? "").matchAll(/\$\s*([\d,.]+)\s*(k)?/gi),
  ].map(([, num, k]) => {
    let n = Number(num.replace(/,/g, ""))
    if (k || n < 1000) n *= 1000
    return n
  })
  const valid = matches.filter((n) => Number.isFinite(n) && n >= 10000)
  return valid.length ? Math.max(...valid) : null
}

// Workday reports relative dates ("Posted 3 Days Ago", "Posted 30+ Days Ago").
// "30+" maps past the default freshness gate on purpose — a month-old posting
// is stale AND a repost/ghost signal.
export function parseWorkdayPostedOn(text, now = new Date()) {
  const t = String(text ?? "").toLowerCase()
  let days = null
  if (/today/.test(t)) days = 0
  else if (/yesterday/.test(t)) days = 1
  else {
    const m = /(\d+)\s*\+?\s*days?\s+ago/.exec(t)
    if (m) days = Number(m[1]) + (t.includes("+") ? 15 : 0)
  }
  if (days == null) return null
  return new Date(now.getTime() - days * 86400000).toISOString()
}

// "/job/US-CA-Santa-Clara/Senior-Engineer_JR123" → "US CA Santa Clara"
export function workdayLocationFromPath(externalPath) {
  const m = /\/job\/([^/]+)\//.exec(String(externalPath ?? ""))
  return m ? m[1].replace(/-/g, " ") : ""
}

export function normUrl(u) {
  try {
    const p = new URL(u)
    return (p.origin + p.pathname).replace(/\/+$/, "").toLowerCase()
  } catch {
    return String(u ?? "").toLowerCase()
  }
}

const companyTitleKey = (x) =>
  `${String(x.company ?? "").toLowerCase()}::${String(x.title ?? "").toLowerCase()}`

// Returns the candidates worth storing, and — via `reposts` — the ones dropped
// because the store already holds that company+title.
//
// That second return value is not bookkeeping. Reposting is the strongest
// ghost-job signal there is, and this function is where the evidence was being
// destroyed: a posting taken down and put back up arrives with a fresh board id
// and a fresh date, matches an existing lead on company+title, and was silently
// discarded. The lead store therefore contained ZERO repeated company+title
// pairs by construction, so L3's repost check had nothing to read. The sighting
// is the signal; ingest records it against the lead already stored.
export function dedupeLeads(candidates, existingLeads = [], applied = []) {
  const seen = new Set()
  const byCompanyTitle = new Map()
  for (const l of existingLeads) {
    if (l.id) seen.add(l.id)
    if (l.url) seen.add(normUrl(l.url))
    const ct = companyTitleKey(l)
    seen.add(ct)
    if (!byCompanyTitle.has(ct)) byCompanyTitle.set(ct, l)
  }
  const appliedKeys = new Set(applied.map(companyTitleKey))
  const fresh = []
  const reposts = []
  for (const c of candidates) {
    const ct = companyTitleKey(c)
    const keys = [c.id, c.url ? normUrl(c.url) : null, ct].filter(Boolean)
    if (keys.some((k) => seen.has(k))) {
      // A DIFFERENT posting id for a company+title already stored is a repost.
      // The same id arriving again is just the same posting still being live,
      // which says nothing.
      const existing = byCompanyTitle.get(ct)
      if (existing && c.id && existing.id !== c.id && !seen.has(c.id)) {
        reposts.push({ lead: existing, candidate: c })
      }
      continue
    }
    if (appliedKeys.has(ct)) continue
    keys.forEach((k) => seen.add(k))
    fresh.push(c)
  }
  // Array-with-extras: every existing caller destructures or iterates this as
  // the list of fresh candidates, and changing that shape would touch the
  // import path, board-yield, discover-boards and three tests for no gain.
  fresh.reposts = reposts
  return fresh
}

// ---------------------------------------------------------------------------
// Store I/O
// ---------------------------------------------------------------------------

export function loadLimits(file = LIMITS_PATH) {
  return yaml.load(fs.readFileSync(file, "utf8")) ?? {}
}

// Backed by jobs/leads.db when it exists, else the legacy jobs/leads.json.
// See scripts/lib/db.mjs for why SQLite and what it fixes. `explicit` mirrors
// resolveLeadSource's own parameter — sibling CLIs (screen.mjs) already accept
// a `--leads <path>` override so tests can point at a scratch store instead of
// the real one; ingest() threads the same override through so a concurrency
// test can drive the locked commit path without touching jobs/leads.db.
function loadLeads(explicit = null) {
  return readLeadStore(explicit)
}

function saveLeads(store, explicit = null) {
  writeLeadStore(store, explicit)
}

function loadApplied() {
  return readApplications()
}

// ---------------------------------------------------------------------------
// Fetchers → normalized lead shape:
// { id, source, company, title, location, url, posted_at }
// ---------------------------------------------------------------------------

// Paging guards. Every paged fetcher stops at the reported total; MAX_PAGES is
// only a runaway backstop for a board that never reports one.
// 50 pages is ~1000 postings per board — well clear of the largest board seen
// (MGM, 505) while still bounding a board that never reports a total.
const MAX_PAGES = 50
const WORKDAY_PAGE = 20
const ADZUNA_PAGE = 50
const ORACLE_PAGE = 200 // Oracle silently clamps anything above this

// Re-exported from lib.mjs, where they now live so enrich.mjs can share them
// without importing this module back.
export { textSnippet, SNIPPET_MAX }

async function fetchGreenhouse(board) {
  const data = await fetchJson(
    `https://boards-api.greenhouse.io/v1/boards/${board.slug}/jobs?content=true`,
  )
  return (data.jobs ?? []).map((j) => ({
    id: `greenhouse:${board.slug}:${j.id}`,
    source: `greenhouse:${board.slug}`,
    company: j.company_name || board.company,
    title: j.title ?? "",
    location: j.location?.name ?? "",
    url: j.absolute_url,
    posted_at: j.first_published || j.updated_at || null,
    ...untrustedSnippet(j.content),
  }))
}

async function fetchLever(board) {
  const data = await fetchJson(
    `https://api.lever.co/v0/postings/${board.slug}?mode=json`,
  )
  return (Array.isArray(data) ? data : []).map((j) => ({
    id: `lever:${board.slug}:${j.id}`,
    source: `lever:${board.slug}`,
    company: board.company,
    title: j.text ?? "",
    location: j.categories?.location ?? "",
    remote: j.workplaceType === "remote",
    url: j.hostedUrl,
    posted_at: j.createdAt ? new Date(j.createdAt).toISOString() : null,
    salary_max: j.salaryRange?.max ?? null,
    ...untrustedSnippet(
      j.descriptionPlain ?? j.description,
      (j.lists ?? []).map((l) => `${l.text}: ${l.content}`).join("\n"),
    ),
  }))
}

async function fetchAshby(board) {
  const data = await fetchJson(
    `https://api.ashbyhq.com/posting-api/job-board/${board.slug}?includeCompensation=true`,
  )
  return (data.jobs ?? [])
    .filter((j) => j.isListed !== false)
    .map((j) => ({
      id: `ashby:${board.slug}:${j.id}`,
      source: `ashby:${board.slug}`,
      company: board.company,
      title: j.title ?? "",
      location: [
        j.location,
        ...(j.secondaryLocations ?? []).map((s) => s.location),
      ]
        .filter(Boolean)
        .join(" / "),
      remote: j.isRemote === true,
      url: j.jobUrl || j.applyUrl,
      posted_at: j.publishedAt ?? null,
      salary_max: parseSalaryMax(j.compensation?.compensationTierSummary),
      ...untrustedSnippet(j.descriptionPlain ?? j.descriptionHtml),
    }))
}

async function fetchSmartRecruiters(board) {
  const out = []
  let offset = 0
  let total = Infinity
  for (let page = 0; page < MAX_PAGES && offset < total; page++) {
    const data = await fetchJson(
      `https://api.smartrecruiters.com/v1/companies/${board.slug}/postings?limit=100&offset=${offset}`,
    )
    if (typeof data.totalFound === "number") total = data.totalFound
    const content = data.content ?? []
    if (!content.length) break
    out.push(
      ...content.map((j) => ({
        id: `smartrecruiters:${board.slug}:${j.id}`,
        source: `smartrecruiters:${board.slug}`,
        company: j.company?.name || board.company,
        title: j.name ?? "",
        location: [j.location?.city, j.location?.region, j.location?.country]
          .filter(Boolean)
          .join(", "),
        remote: j.location?.remote === true,
        url: `https://jobs.smartrecruiters.com/${board.slug}/${j.id}`,
        posted_at: j.releasedDate ?? null,
      })),
    )
    offset += content.length
  }
  return out
}

async function fetchWorkable(board) {
  const data = await fetchJson(
    `https://apply.workable.com/api/v1/widget/accounts/${board.slug}?details=false`,
  )
  return (data.jobs ?? []).map((j) => ({
    id: `workable:${board.slug}:${j.shortcode ?? j.code ?? j.id}`,
    source: `workable:${board.slug}`,
    company: data.name || board.company,
    title: j.title ?? "",
    location: [j.city, j.state, j.country].filter(Boolean).join(", "),
    remote: j.telecommuting === true,
    url: j.url || `https://apply.workable.com/${board.slug}/j/${j.shortcode}`,
    posted_at: j.published_on ?? null,
  }))
}

async function fetchRecruitee(board) {
  const data = await fetchJson(
    `https://${board.slug}.recruitee.com/api/offers/`,
  )
  return (data.offers ?? []).map((j) => ({
    id: `recruitee:${board.slug}:${j.id}`,
    source: `recruitee:${board.slug}`,
    company: board.company,
    title: j.title ?? "",
    location: [j.city, j.country].filter(Boolean).join(", "),
    remote: j.remote === true,
    url: j.careers_url,
    posted_at: j.published_at ?? j.created_at ?? null,
    ...untrustedSnippet(j.description, j.requirements),
  }))
}

// Workday's semi-public CXS endpoint (same JSON the careers site itself uses).
// Passes the search query server-side; most Fortune 500 companies live here.
//
// Workday caps a response at 20 postings and reports the real count in `total`,
// so a single request silently returns the first page only. Left unpaged this
// saw 20 of Light & Wonder's 90 and 20 of Aristocrat's 170 — the boards looked
// alive while most of their jobs were invisible.
async function fetchWorkday(board, query) {
  const out = []
  let offset = 0
  let total = Infinity
  for (let page = 0; page < MAX_PAGES; page++) {
    const data = await fetchJson(
      `https://${board.host}/wday/cxs/${board.tenant}/${board.site}/jobs`,
      {
        appliedFacets: {},
        limit: WORKDAY_PAGE,
        offset,
        searchText: query ?? "",
      },
    )
    // Workday reports `total` on the FIRST page only; every later page reports
    // 0. Trusting it each time set total=0 on page two and ended the loop at 40
    // of 90 — a partial fix that looked like a working one.
    if (page === 0 && typeof data.total === "number" && data.total > 0) {
      total = data.total
    }
    const posts = data.jobPostings ?? []
    if (!posts.length) break
    out.push(
      ...posts.map((j) => ({
        id: `workday:${board.tenant}:${j.bulletFields?.[0] ?? j.externalPath}`,
        source: `workday:${board.tenant}`,
        company: board.company,
        title: j.title ?? "",
        location:
          workdayLocationFromPath(j.externalPath) || j.locationsText || "",
        url: `https://${board.host}/en-US/${board.site}${j.externalPath}`,
        posted_at: parseWorkdayPostedOn(j.postedOn),
      })),
    )
    offset += posts.length
    if (offset >= total || posts.length < WORKDAY_PAGE) break
  }
  return out
}

// Oracle Cloud Recruiting (Fusion) — the candidate-experience REST endpoint the
// careers site itself calls. Public, no key. Two large Las Vegas employers
// (Caesars, Station Casinos) live here and were invisible to the sweep.
//
// `expand=requisitionList` is MANDATORY: without it the response still carries
// an accurate TotalJobsCount but an empty list, so the board reads as "found,
// but empty" rather than as a broken query.
async function fetchOracleCloud(board) {
  const out = []
  let offset = 0
  let total = Infinity
  for (let page = 0; page < MAX_PAGES; page++) {
    const data = await fetchJson(
      `https://${board.host}/hcmRestApi/resources/latest/recruitingCEJobRequisitions` +
        `?onlyData=true&expand=requisitionList.secondaryLocations` +
        `&finder=findReqs;siteNumber=${encodeURIComponent(board.site)}` +
        `,limit=${ORACLE_PAGE},offset=${offset},sortBy=POSTING_DATES_DESC`,
    )
    const item = data.items?.[0]
    if (
      page === 0 &&
      typeof item?.TotalJobsCount === "number" &&
      item.TotalJobsCount > 0
    ) {
      total = item.TotalJobsCount
    }
    const reqs = item?.requisitionList ?? []
    if (!reqs.length) break
    out.push(
      ...reqs.map((j) => ({
        id: `oracle_cloud:${board.site}:${j.Id}`,
        source: `oracle_cloud:${board.site}`,
        company: board.company,
        title: j.Title ?? "",
        location: [
          j.PrimaryLocation,
          ...(j.secondaryLocations ?? []).map((s) => s.Name),
        ]
          .filter(Boolean)
          .join(" / "),
        remote: /remote/i.test(j.WorkplaceType ?? j.WorkplaceTypeCode ?? ""),
        url: `https://${board.host}/hcmUI/CandidateExperience/en/sites/${board.site}/job/${j.Id}`,
        posted_at: j.PostedDate ?? null,
        ...untrustedSnippet(
          j.ShortDescriptionStr,
          j.ExternalResponsibilitiesStr,
          j.ExternalQualificationsStr,
        ),
      })),
    )
    offset += reqs.length
    if (offset >= total || reqs.length < ORACLE_PAGE) break
  }
  return out
}

const cdata = (s) =>
  decodeEntities(
    String(s ?? "")
      .replace(/^\s*<!\[CDATA\[/, "")
      .replace(/\]\]>\s*$/, ""),
  ).trim()

// "11/26/2025" -> ISO. Returns null rather than guessing on anything else.
function parseUsDate(s) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(s ?? "").trim())
  if (!m) return null
  const d = new Date(Date.UTC(+m[3], +m[1] - 1, +m[2]))
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

// Jobvite exposes no JSON job list at all — the only public surface is an XML
// feed, but it is unauthenticated, unpaginated, and carries full descriptions
// and absolute apply URLs. The feed key is NOT the URL slug, so it is read
// once from the careers page. Cloudflare throttles the feed to roughly one
// request per 30s, which a daily sweep never notices.
async function fetchJobvite(board) {
  let eid = board.eid
  if (!eid) {
    const html = await fetchText(
      `https://jobs.jobvite.com/${board.slug}/search`,
    )
    eid = /companyEId:\s*['"]([A-Za-z0-9]+)['"]/.exec(html)?.[1]
    if (!eid) {
      throw new Error(
        `could not read companyEId for jobvite slug "${board.slug}"`,
      )
    }
  }
  const xml = await fetchText(
    `https://app.jobvite.com/CompanyJobs/Xml.aspx?c=${encodeURIComponent(eid)}`,
  )
  return parseJobviteFeed(xml, board)
}

// Exported so the brittle bit is unit-testable against a fixture: a feed
// format change should fail a test, not silently return an empty board.
export function parseJobviteFeed(xml, board) {
  const out = []
  for (const m of String(xml).matchAll(/<job>([\s\S]*?)<\/job>/g)) {
    const body = m[1]
    const tag = (name) =>
      cdata(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(body)?.[1] ?? "")
    const id = tag("id") || tag("requisitionid")
    if (!id) continue
    out.push({
      id: `jobvite:${board.slug}:${id}`,
      source: `jobvite:${board.slug}`,
      company: board.company,
      title: tag("title"),
      location: tag("location"),
      url: tag("detail-url") || tag("apply-url"),
      posted_at: parseUsDate(tag("date")),
      ...untrustedSnippet(tag("briefdescription"), tag("description")),
    })
  }
  return out
}

// SAP SuccessFactors career sites (RMK) render results server-side and expose
// no JSON — verified by network capture, not assumed. The search page is
// honest offset pagination though, and prints the total on every page.
const SF_PAGE = 25

async function fetchSuccessFactors(board) {
  const out = []
  let total = Infinity
  for (let page = 0; page < MAX_PAGES; page++) {
    const start = page * SF_PAGE
    if (start >= total) break
    const html = await fetchText(
      `https://${board.host}/search/?q=&sortColumn=referencedate&sortDirection=desc&startrow=${start}`,
    )
    if (page === 0) total = parseSuccessFactorsTotal(html)
    const rows = parseSuccessFactorsPage(html, board)
    if (!rows.length) break
    out.push(...rows)
  }
  return out
}

// The result count is printed on every page ("Results 1 - 25 of 142").
export function parseSuccessFactorsTotal(html) {
  const m = /of\s*<b>\s*([\d,]+)\s*<\/b>/i.exec(String(html))
  return m ? Number(m[1].replace(/,/g, "")) || Infinity : Infinity
}

// Exported so the brittle bit is unit-testable: a career-site redesign should
// fail a test rather than silently yield an empty board. Each result is a
// title anchor followed by its location and date spans, so slice from one
// anchor to the next and the fields cannot bleed across rows.
export function parseSuccessFactorsPage(html, board) {
  const out = []
  const rowRe =
    /<a[^>]+class="[^"]*jobTitle-link[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>([\s\S]*?)(?=<a[^>]+class="[^"]*jobTitle-link|$)/g
  const strip = (s) => decodeEntities(String(s).replace(/<[^>]+>/g, "")).trim()
  for (const m of String(html).matchAll(rowRe)) {
    const href = m[1]
    const title = strip(m[2])
    if (!title) continue
    const rest = m[3] ?? ""
    const loc =
      /<span[^>]*class="[^"]*jobLocation[^"]*"[^>]*>([\s\S]*?)<\/span>/i.exec(
        rest,
      )
    const date =
      /<span[^>]*class="[^"]*jobDate[^"]*"[^>]*>([\s\S]*?)<\/span>/i.exec(rest)
    const posted = date ? new Date(strip(date[1])) : null
    out.push({
      id: `successfactors:${board.slug ?? board.host}:${/\/(\d+)\/?$/.exec(href)?.[1] ?? href}`,
      source: `successfactors:${board.slug ?? board.host}`,
      company: board.company,
      title,
      // The location cell carries a multi-site suffix ("Las Vegas, NV, US,
      // 89113 +1 more…") that would otherwise land in the stored location.
      location: loc
        ? strip(loc[1])
            .replace(/\s+/g, " ")
            .replace(
              /\s*\+\s*\d+\s*more\s*(?:…|\.\.\.|&hellip;|&#8230;)?\s*$/i,
              "",
            )
            .trim()
        : "",
      url: href.startsWith("http") ? href : `https://${board.host}${href}`,
      posted_at:
        posted && !Number.isNaN(posted.getTime()) ? posted.toISOString() : null,
    })
  }
  return out
}

// Minimal .env parser (no dependency): KEY=value lines, #-comments, optional
// quotes. Real environment variables win over .env values.
export function loadEnv(file = path.join(ROOT, ".env")) {
  const out = {}
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      if (line.trim().startsWith("#")) continue
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line)
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "")
    }
  }
  for (const k of Object.keys(out)) {
    if (process.env[k] !== undefined) out[k] = process.env[k]
  }
  return { ...out }
}

export function normalizeAdzunaJob(j) {
  return {
    id: `adzuna:${j.id}`,
    source: "adzuna",
    company: j.company?.display_name ?? "unknown",
    title: j.title ?? "",
    location: j.location?.display_name ?? "",
    url: j.redirect_url,
    posted_at: j.created ?? null,
    salary_max: j.salary_max ?? null,
    // Adzuna only returns a teaser, so this is deliberately partial — see the
    // partial_description handling in screen.mjs.
    ...untrustedSnippet(j.description),
  }
}

// Adzuna aggregator (https://developer.adzuna.com/) — credentialed via .env,
// covers thousands of employers (incl. Workday/Taleo companies with no public
// feed) and usually includes salary data. Two passes: near the user's base,
// and remote.
async function fetchAdzuna(query, limits, env = loadEnv()) {
  // Adzuna's own docs call these "Application ID/Key", so accept that spelling
  // as an alias for the shorter names in .env.example.
  const appId = env.ADZUNA_APP_ID || env.ADZUNA_APPLICATION_ID
  const appKey = env.ADZUNA_APP_KEY || env.ADZUNA_APPLICATION_KEY
  if (!appId || !appKey || appId === "your_app_id_here") {
    throw new Error(
      "not configured — copy .env.example to .env and set ADZUNA_APP_ID / ADZUNA_APP_KEY",
    )
  }
  const country = env.ADZUNA_COUNTRY || "us"
  const maxDays = limits.freshness?.max_age_days ?? 30
  const base = limits.location?.base || "Las Vegas"
  // The page number is a path segment, so "search/1" is literally page one and
  // nothing else — the local Las Vegas results were being cut off at 50.
  const mk = (page, params) =>
    `https://api.adzuna.com/v1/api/jobs/${country}/search/${page}?` +
    new URLSearchParams({
      app_id: appId,
      app_key: appKey,
      results_per_page: String(ADZUNA_PAGE),
      max_days_old: String(maxDays),
      ...params,
    })
  const queries = [
    { what: query, where: base, distance: "50" },
    { what: `${query} remote` },
  ]
  const out = []
  for (const q of queries) {
    for (let page = 1; page <= MAX_PAGES; page++) {
      const data = await fetchJson(mk(page, q))
      const results = data.results ?? []
      out.push(...results.map(normalizeAdzunaJob))
      if (results.length < ADZUNA_PAGE) break
    }
  }
  return out // cross-query duplicates fall out in dedupeLeads
}

// Remote-only aggregators.
//
// These differ from every board above in one way that matters: their entire
// corpus is remote roles, so a posting's location field states WHO MAY BE HIRED
// ("USA", "Anywhere") rather than where an office is. `remote_source: true`
// tells passesLimits to read it that way — without it the location gate called
// every one of them a relocation and threw the lot out (see US_WIDE_LOCATION).
//
// They also return the FULL description in the list endpoint, so the body gate
// and keyword indexing work with no per-posting enrich round trip.
//
// Measured 2026-07-29 against the real gates, after the remote fix:
//   jobicy    5 kept of 50  (10%) — incl. a Graduate Software Engineer.
//             Better than every tracked board except Render (8.8%).
//   remotive  0 of 35 — category filter is unreliable ("Patient Care
//             Specialist" filed under software-dev) and the free tier caps a
//             category at ~35 rows.
//   remoteok  0 of 100 — ~500-char descriptions, titles skew senior.
// Only jobicy is swept by default; the other two are available for
// job-sources.yaml to switch on, and board-yield will judge them on evidence.
//
// NOT added: The Muse (0 kept of 200 sampled — its "entry level software
// engineering" is dominated by SpaceX production technicians and 93% were
// stale) and Arbeitnow (a German/EU corpus the location gate rejects wholesale).
const JOBICY_COUNT = 50

async function fetchJobicy(board) {
  const geo = board.geo ?? "usa"
  const industry = board.industry ?? "engineering"
  const data = await fetchJson(
    `https://jobicy.com/api/v2/remote-jobs?count=${JOBICY_COUNT}&geo=${encodeURIComponent(geo)}&industry=${encodeURIComponent(industry)}`,
  )
  return (data.jobs ?? []).map((j) => ({
    id: `jobicy:${j.id}`,
    source: "jobicy",
    company: j.companyName || "unknown",
    title: j.jobTitle ?? "",
    location: j.jobGeo ?? "",
    remote: true,
    remote_source: true,
    url: j.url,
    posted_at: j.pubDate ?? null,
    salary_max: j.salaryMax ? Number(j.salaryMax) : null,
    ...untrustedSnippet(j.jobDescription ?? j.jobExcerpt),
  }))
}

async function fetchRemotive(board) {
  const category = board.category ?? "software-dev"
  const data = await fetchJson(
    `https://remotive.com/api/remote-jobs?category=${encodeURIComponent(category)}`,
  )
  return (data.jobs ?? []).map((j) => ({
    id: `remotive:${j.id}`,
    source: "remotive",
    company: j.company_name || "unknown",
    title: j.title ?? "",
    location: j.candidate_required_location ?? "",
    remote: true,
    remote_source: true,
    url: j.url,
    posted_at: j.publication_date ?? null,
    salary_max: parseSalaryMax(j.salary),
    ...untrustedSnippet(j.description),
  }))
}

async function fetchRemoteOk() {
  const data = await fetchJson("https://remoteok.com/api")
  // Row 0 is a legal notice, not a posting.
  return (Array.isArray(data) ? data.slice(1) : []).map((j) => ({
    id: `remoteok:${j.id}`,
    source: "remoteok",
    company: j.company || "unknown",
    title: j.position ?? "",
    location: j.location ?? "",
    remote: true,
    remote_source: true,
    url: j.url || j.apply_url,
    posted_at: j.date ?? null,
    salary_max: j.salary_max ? Number(j.salary_max) : null,
    ...untrustedSnippet(j.description),
  }))
}

async function fetchHackerNews(query) {
  const q = encodeURIComponent(query || DEFAULT_SEARCH_QUERY)
  const data = await fetchJson(
    `https://hn.algolia.com/api/v1/search_by_date?tags=job&query=${q}&hitsPerPage=50`,
  )
  return (data.hits ?? []).map((h) => {
    const title = h.title ?? ""
    // "Acme (YC W25) Is Hiring Full Stack Engineers (SF)" → company + location hint
    const company = title
      .split(/\s+is hiring/i)[0]
      .replace(/\s*\(YC [^)]*\)\s*/i, " ")
      .trim()
    const locMatch = /\(([^)]{2,40})\)\s*$/.exec(title)
    return {
      id: `hn:${h.objectID}`,
      source: "hn",
      company: company || "unknown",
      title,
      location: /remote/i.test(title) ? "Remote" : locMatch ? locMatch[1] : "",
      url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
      posted_at: h.created_at ?? null,
    }
  })
}

const BOARD_FETCHERS = {
  greenhouse: fetchGreenhouse,
  lever: fetchLever,
  ashby: fetchAshby,
  smartrecruiters: fetchSmartRecruiters,
  workable: fetchWorkable,
  recruitee: fetchRecruitee,
  workday: fetchWorkday,
  oracle_cloud: fetchOracleCloud,
  jobvite: fetchJobvite,
  successfactors: fetchSuccessFactors,
  jobicy: fetchJobicy,
  remotive: fetchRemotive,
  remoteok: fetchRemoteOk,
}

export const BOARD_TYPES = Object.keys(BOARD_FETCHERS)

// THE single hardcoded default query anywhere in this file (P5,
// retarget-readiness audit 2026-08). Before this there were TWO, independently
// spelled — cmdSearch's own "full stack" and fetchBoard's own parameter
// default "software engineer" — and Workday is the one fetcher of thirteen
// where the query is a server-side filter (searchText), so any caller that
// omitted the query (this file's own tests, manage-sources.mjs, a diagnostic
// script) silently got a different result set than production ever runs with.
// "full stack" is canonical because that is what cmdSearch actually sweeps
// with every day. Overridable per-user via docs/application-limits.yaml's
// roles.search_query — resolved by each CLI entry point (cmdSearch,
// manage-sources.mjs), never read here, since this function has no access to
// the limits file.
export const DEFAULT_SEARCH_QUERY = "full stack"

// The board types where the query is a SERVER-SIDE filter, so one query
// returns one SLICE of the board rather than the whole thing. Workday is the
// only one of the thirteen (see DEFAULT_SEARCH_QUERY above) — every other
// fetcher returns the full list and the gates filter it locally, which is why
// re-asking those per query would be N identical fetches for one result.
//
// Measured 2026-08-13, and this is why a list is supported at all: sweeping
// with the single query "full stack" returned 2 of Aristocrat's 178 postings,
// 10 of Light & Wonder's 111, 122 of MGM's 542, and 0 of UNLV's 123 — 697
// postings across three tracked boards that no gate ever saw. The same
// blindness made discover-boards.mjs score UNLV at live=0 and reject it; with
// a list it scores live=123, solid=2, ACCEPT. So the defect suppressed board
// DISCOVERY as well as the sweep.
//
// What this does NOT fix, checked rather than assumed: seeing a posting is not
// passing it. LVVWD goes 0 -> 10 postings and still yields 0, because its
// Las Vegas roles are located by BUILDING ("Molasky Corporate Center"), which
// the location gate reads as a relocation, and titled "Applications Developer",
// which roles.title_keywords does not carry. Both are the user's config to
// change, not this module's.
const SERVER_FILTERED_TYPES = new Set(["workday"])

// One entry point per board — used by cmdSearch and by manage-sources.mjs to
// prescreen a board before it is added to docs/job-sources.yaml.
//
// `query` may be a string or a list. A list is a UNION, not a refinement: each
// query is asked separately and the results are merged, because that is the
// only way to see a server-filtered board whose postings use vocabulary the
// canonical query does not ("Applications Developer", "Assoc GIS Developer").
export async function fetchBoard(board, query = DEFAULT_SEARCH_QUERY) {
  const fetcher = BOARD_FETCHERS[board.type]
  if (!fetcher) throw new Error(`unknown board type "${board.type}"`)
  const queries = (Array.isArray(query) ? query : [query])
    .map((q) => String(q ?? "").trim())
    .filter(Boolean)
  // A caller that passes [], [""] or null still gets one real fetch. An empty
  // sweep is a worse failure than a narrow one, and it fails silently.
  if (!queries.length) queries.push(DEFAULT_SEARCH_QUERY)
  if (queries.length === 1 || !SERVER_FILTERED_TYPES.has(board.type)) {
    return fetcher(board, queries[0])
  }
  // Union, first occurrence wins. Every fetcher stamps a stable `id`; `url` is
  // the fallback so a posting is never dropped for lacking one.
  const seen = new Map()
  for (const q of queries) {
    for (const job of await fetcher(board, q)) {
      const key = job.id ?? job.url
      if (key && !seen.has(key)) seen.set(key, job)
    }
  }
  return [...seen.values()]
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function getFlag(args, name, fallback = null) {
  const i = args.indexOf(name)
  return i !== -1 && args[i + 1] !== undefined ? args[i + 1] : fallback
}

// Titles rejected purely for not matching roles.title_keywords, ranked by how
// often they appear and filtered to software-ish work. Tuning the keyword list
// by guesswork is what let "Game Mathematician" sit unseen on a board for
// weeks; this makes the question answerable from data.
const TECHY =
  /engineer|developer|programmer|mathematic|software|architect|analyst|scientist|sre|devops|qa|data|web|game|technical/i
const NOT_TECHY =
  /field service|sales|account (manager|executive)|recruit|marketing|counsel|finance|payroll|technician|installer|driver|attendant|dealer|housekeep|cook|server|host/i

function explainTitles(rejected, top = 30) {
  const counts = new Map()
  for (const r of rejected) {
    if (!/^title:/.test(r.reasons[0] ?? "")) continue
    const t = String(r.title ?? "").trim()
    if (!t || !TECHY.test(t) || NOT_TECHY.test(t)) continue
    counts.set(t, (counts.get(t) ?? 0) + 1)
  }
  const ranked = [...counts.entries()].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  )
  console.log(
    `\nTop ${Math.min(top, ranked.length)} software-ish titles rejected by roles.title_keywords ` +
      `(of ${ranked.length} distinct):`,
  )
  for (const [title, n] of ranked.slice(0, top)) {
    console.log(`  ${String(n).padStart(4)}  ${title}`)
  }
}

// `counts` (2026-08-18) says where the candidates WENT, because `stored=0`
// alone cannot be told apart from a broken sweep: a healthy sweep of boards
// this store already holds stores nothing and drops everything as a
// duplicate, and a sweep whose every fetch failed stores nothing too. Read
// together — fetched, duplicates, gate-rejected, stored — the four say which
// it was. Duplicates were never counted before; dedupeLeads() dropped them
// silently between the fetch and the gate.
export function summarize(kept, rejected, opts = {}) {
  if (opts.explain) explainTitles(rejected, opts.explainTop ?? 30)
  const c = opts.counts ?? {}
  const fetched = c.fetched ?? kept.length + rejected.length
  const duplicates = c.duplicates ?? 0
  if (isTerse()) {
    for (const l of kept) {
      const f = l.flags?.length ? `|${l.flags.join(",")}` : ""
      console.log(`+${l.id}|${l.company}|${l.title}|${l.location || "?"}${f}`)
    }
    console.log(
      `fetched=${fetched} duplicates=${duplicates} gate_rejected=${rejected.length} stored=${kept.length}` +
        // Kept for anything that greps the old line; same number as
        // gate_rejected.
        ` rejected=${rejected.length}`,
    )
    return
  }
  for (const l of kept) {
    const flagStr = l.flags?.length ? `  [${l.flags.join(", ")}]` : ""
    console.log(
      `+ ${l.company} — ${l.title} (${l.location || "location?"})${flagStr}`,
    )
  }
  const byReason = {}
  for (const r of rejected) {
    const cat = r.reasons[0]?.split(":")[0] ?? "other"
    byReason[cat] = (byReason[cat] ?? 0) + 1
  }
  console.log(
    `\nFetched ${fetched} posting(s): ${duplicates} already in the store, ` +
      `${rejected.length} rejected by the gates ` +
      `(${
        Object.entries(byReason)
          .map(([k, v]) => `${k}: ${v}`)
          .join(", ") || "none"
      }), ${kept.length} stored.`,
  )
}

// Adds description snippets to leads stored before the sweep captured them.
// Without this the blocker screen would only ever apply to newly found leads,
// leaving the existing store permanently unscreenable. Mutates store.leads.
export function backfillDescriptions(candidates, leads) {
  const byKey = new Map()
  for (const l of leads) {
    if (l.id) byKey.set(l.id, l)
    if (l.url) byKey.set(normUrl(l.url), l)
  }
  let n = 0
  for (const c of candidates) {
    if (!c.description) continue
    const hit = byKey.get(c.id) ?? (c.url ? byKey.get(normUrl(c.url)) : null)
    if (hit && !hit.description) {
      hit.description = c.description
      n++
    }
  }
  return n
}

// Extract each new lead's tech keywords once, at ingest, so later analysis is
// a GROUP BY instead of re-parsing every stored description. Best-effort: a
// keyword-index failure must never lose a lead that was already saved.
//
// `explicit` MUST match whatever store ingest() just committed to — this used
// to always resolve the default (real) store regardless of a `--leads`
// override, which meant a scratch-store run (any test using --leads) quietly
// wrote keyword rows into the real jobs/leads.db for ids that live only in
// the scratch db.
function indexKeywords(leads, explicit = null) {
  const src = resolveLeadSource(explicit)
  if (src.kind !== "db" || !leads.length) return
  try {
    const db = openDb(src.file)
    try {
      for (const l of leads) {
        // requirements is included because an imported lead (Playwright/WebFetch
        // capture) carries its qualifications as a separate array rather than
        // folded into the description, and those bullets are precisely where the
        // demanded stack is named.
        const text = [l.title, l.description, ...(l.requirements ?? [])]
          .filter(Boolean)
          .join("\n")
        setLeadKeywords(db, l.id, [...extractTech(text)])
      }
    } finally {
      db.close()
    }
  } catch (e) {
    console.error(`warn: keywords not indexed (${e.message})`)
  }
}

// Append this sweep's productivity to board_stats. A single audit is a
// snapshot; pruning a board should rest on history, so every sweep contributes
// one data point and last_qualifying_at only moves when something reachable
// was actually found.
function recordSweep(results, limits, now) {
  const src = resolveLeadSource()
  if (src.kind !== "db") return
  try {
    const db = openDb(src.file)
    try {
      for (const r of results) {
        if (r.error) continue
        let qualifying = 0
        let solid = 0
        for (const p of r.postings) {
          const v = passesLimits(p, limits, now)
          if (!v.ok) continue
          qualifying++
          if (
            !(v.flags ?? []).some(
              (f) => f === "remote_unverified" || f === "unknown_location",
            )
          )
            solid++
        }
        recordBoardStats(db, {
          board_id: r.label,
          type: r.board.type,
          slug: r.board.slug ?? r.board.tenant ?? r.board.host ?? null,
          company: r.board.company ?? r.label,
          last_swept: now.toISOString(),
          live_postings: r.postings.length,
          qualifying,
          solid,
          leads_produced: solid,
        })
      }
    } finally {
      db.close()
    }
  } catch (e) {
    console.error(`warn: board stats not recorded (${e.message})`)
  }
}

// Two gates, cheapest first. passesLimits reads the list payload's title,
// location and date and throws out the thousands; only what survives is worth a
// per-posting detail fetch, and only once a description exists can the body gate
// read it. Running them in the other order would mean one HTTP round trip per
// posting the sweep was going to discard anyway.
//
// THE COMMIT IS LOCKED, THE FETCHES ARE NOT. `store` below is read once,
// unlocked, purely to plan this call's work: which candidates are new (worth
// screening/enriching) and which are repost sightings against what THIS
// process currently believes is stored. That plan does not need to be
// millisecond-fresh — being a few ms stale just means an occasional repost
// goes undetected until the next sweep, which is the pre-existing precision
// of this signal.
//
// What must never run on stale data is the WRITE. `writeLeadStore` upserts
// every lead object it is given, doc column and all — so committing an
// in-memory copy read before another process's write clobbers whatever that
// process changed in the interim (a status set by `mark`, a repost counter
// from another sweep, a screening verdict). That is the defect
// `scripts/lib/lock.mjs`'s header names by this function. The fix is to
// re-read fresh, apply this call's changes to THAT copy, and write it back —
// all inside LEADS_LOCK, and with nothing added to the critical section that
// doesn't need to be there.
//
// Board fetches happen before `ingest` is even called; `enrichDescriptions`
// runs inside it but stays OUTSIDE the lock deliberately — those requests can
// run long enough to vastly exceed the lock's staleMs, and holding the lock
// across them would make a concurrent writer legitimately break this one as
// abandoned mid-sweep (see lock.mjs's header on why age is the only thing
// that may ever break a lock).
async function ingest(
  candidates,
  limits,
  { enrich = true, leadsFile = null } = {},
) {
  // Defaults to the real store (LEADS_LOCK/DB_PATH). `leadsFile` exists so a
  // test can redirect both the store AND its lock to a scratch path without
  // touching jobs/leads.db — resolveLeadSource(null) resolves to the exact
  // same file LEADS_LOCK already guards, so production behaviour is unchanged.
  const lockPath = leadsFile
    ? lockPathFor(resolveLeadSource(leadsFile).file)
    : LEADS_LOCK
  const store = loadLeads(leadsFile)
  const applied = loadApplied()
  const now = new Date()
  const survivors = []
  const rejected = []
  const deduped = dedupeLeads(candidates, store.leads, applied)
  const repostSightings = deduped.reposts ?? []

  for (const c of deduped) {
    const verdict = passesLimits(c, limits, now)
    if (!verdict.ok) {
      rejected.push({ ...c, reasons: verdict.reasons })
      continue
    }
    survivors.push({ ...c, flags: verdict.flags })
  }

  let enriched = { filled: 0, attempted: 0, failures: [] }
  if (enrich && survivors.length) {
    enriched = await enrichDescriptions(survivors)
  }

  // Phase 0.13 — stamp the ATS-hosted apply_url while the lead is being
  // enriched, so the trust gate has one without a later backfill pass.
  //
  // OFFLINE ONLY on the sweep path, deliberately. The free tiers resolve every
  // embedded careers page from what the board API already told us and cost
  // nothing; the network tier was measured at 0/21 on the two aggregators this
  // store actually uses (M10), so paying a per-lead HTTP request on every sweep
  // would buy a measured nothing. It stays available behind
  // `canonical.mjs --network` for a board set where it pays.
  //
  // WHY THAT ZERO IS PERMANENT FOR ADZUNA, re-measured 2026-08-09 — M10 recorded
  // the number but not the cause, which left it looking like a matcher gap
  // someone could close. It is not. Four independent routes to the employer's
  // posting were tried and every one is shut by design:
  //
  //   1. `redirect_url` (`/land/ad/...`) answers **403** with a block page;
  //   2. the `/details/<id>/apply?aztt=<jwt>` hop the details page offers 303s
  //      straight back to the details page with `after_login=<id>`;
  //   3. the search API returns 15 fields and `redirect_url` is the only URL —
  //      no employer link, no apply link, and `adref` decodes to {session, id};
  //      there is no per-job detail endpoint to ask instead;
  //   4. the `description` teaser contains no URLs at all — 0 of 95 stored
  //      aggregator leads carry one.
  //
  // The click-through IS Adzuna's product, so the destination is exactly what
  // they withhold. Getting it would mean driving a browser through the
  // interstitial and signing in — circumventing an access control, which this
  // pipeline does not do. Aggregator leads are therefore hand-apply-only, and
  // prep-queue.mjs ranks them below leads the machine can finish rather than
  // dropping them (see `applicability()` there).
  if (survivors.length) await canonicalizeLeads(survivors, { network: false })

  const kept = []
  for (const s of survivors) {
    const body = bodyDisqualifiers(s, limits)
    if (!body.ok) {
      rejected.push({ ...s, reasons: body.reasons })
      continue
    }
    kept.push({
      ...s,
      flags: [...new Set([...(s.flags ?? []), ...body.flags])],
      status: "new",
      found_at: now.toISOString(),
      notes: "",
    })
  }

  // --- locked commit: fresh read, this call's changes applied on top, write.
  // No network below this line. `withLock` releases on every exit path
  // (normal return or throw); the explicit stillHeld() check below is on
  // purpose IN ADDITION to withLock's own post-check — that one fires only
  // AFTER `fn` returns, which is too late to stop a write that already ran.
  // Checking immediately before `saveLeads` is what actually prevents a
  // dispossessed holder from publishing over the process that replaced it.
  const { committed, backfilled } = withLock(lockPath, (handle) => {
    const fresh = loadLeads(leadsFile)
    const backfilledNow = backfillDescriptions(candidates, fresh.leads)

    // Repost sightings were detected against the planning read above; apply
    // them to the FRESH copy of the same lead (matched by id) so the counter
    // increments from whatever is on disk right now, not from a value read
    // before another writer may have already bumped it.
    for (const { lead, candidate } of repostSightings) {
      const freshLead = fresh.leads.find((l) => l.id === lead.id)
      if (!freshLead) continue // lead vanished between the plan and the commit
      freshLead.repost_count = (freshLead.repost_count ?? 0) + 1
      freshLead.first_seen_at ??= freshLead.found_at ?? now.toISOString()
      freshLead.last_seen_at = now.toISOString()
      if (candidate.posted_at) freshLead.last_reposted_at = candidate.posted_at
    }

    // Safety net against a candidate that a concurrent sweep already inserted
    // between the planning dedupe and this commit: never insert the same
    // id/url twice. This is cheap (id/url only, not the full dedupe) and
    // changes nothing in the overwhelmingly common uncontended case.
    const existingKeys = new Set()
    for (const l of fresh.leads) {
      if (l.id) existingKeys.add(l.id)
      if (l.url) existingKeys.add(normUrl(l.url))
    }
    const freshKept = kept.filter(
      (k) => !existingKeys.has(k.id) && !existingKeys.has(normUrl(k.url)),
    )
    fresh.leads.push(...freshKept)

    if (!handle.stillHeld()) {
      throw new Error(
        "LEADS_LOCK was broken while ingest held it — another process took over the lead store " +
          "mid-commit. Nothing was written this call; re-run the sweep.",
      )
    }
    saveLeads(fresh, leadsFile)
    return { committed: freshKept, backfilled: backfilledNow }
  })

  indexKeywords(committed, leadsFile)
  const ei = process.argv.indexOf("--explain")
  const eN = Number(process.argv[ei + 1])
  summarize(committed, rejected, {
    explain: ei !== -1,
    explainTop: Number.isFinite(eN) && eN > 0 ? eN : 30,
    counts: {
      fetched: candidates.length,
      // Everything the planning dedupe dropped against the store and the
      // application history — plus the few a concurrent sweep beat this one
      // to, which the locked commit dropped for the same reason.
      duplicates:
        candidates.length - deduped.length + (kept.length - committed.length),
    },
  })
  if (enriched.attempted) {
    console.log(
      isTerse()
        ? `enriched=${enriched.filled}/${enriched.attempted}`
        : `Fetched descriptions for ${enriched.filled} of ${enriched.attempted} posting(s) whose board list endpoint carries none.`,
    )
  }
  for (const f of enriched.failures) {
    console.error(`warn: description fetch failed: ${f}`)
  }
  if (backfilled) {
    console.log(
      `Backfilled description snippets onto ${backfilled} existing lead(s).`,
    )
  }
}

// Normalize whatever a caller spelled into a scalar or a list. Both
// `--query "full stack, developer"` and a YAML list under roles.search_query
// mean "sweep the server-filtered boards with each of these".
//
// A single query stays a SCALAR rather than becoming a one-element list, so
// the existing path through fetchBoard is byte-for-byte what it always was and
// the multi-query code is never entered by a user who did not ask for it.
// Returns null for absent/empty so `??` falls through to the next source.
export function parseQueries(value) {
  if (value == null || value === true) return null
  const list = (Array.isArray(value) ? value : String(value).split(","))
    .map((q) => String(q ?? "").trim())
    .filter(Boolean)
  if (!list.length) return null
  return list.length === 1 ? list[0] : list
}

async function cmdSearch(args) {
  const limits = loadLimits()
  const source = getFlag(args, "--source", "all")
  // Resolution order: an explicit --query wins, then docs/application-
  // limits.yaml's roles.search_query (P5, retarget-readiness audit 2026-08,
  // optional — see DEFAULT_SEARCH_QUERY above for why "full stack" is the
  // fallback), then the canonical default itself.
  const query =
    parseQueries(getFlag(args, "--query")) ??
    parseQueries(limits.roles?.search_query) ??
    DEFAULT_SEARCH_QUERY
  // Hacker News and Adzuna keep the FIRST query rather than the union. Adzuna
  // is credentialed and rate-limited, so widening it multiplies billed calls —
  // a cost the user should choose deliberately, not inherit from a change made
  // to unblock Workday. Boards are free to re-ask; a paid API is not.
  const primaryQuery = Array.isArray(query) ? query[0] : query
  const maxAge = getFlag(args, "--max-age")
  if (maxAge) (limits.freshness ??= {}).max_age_days = Number(maxAge)

  const candidates = []
  const failures = []
  if (source === "all" || source === "boards") {
    // Board fetches are network-bound and independent, so they run pooled
    // rather than one after another. The cap is deliberate: it is what keeps a
    // longer board list affordable without hammering any single ATS.
    const boards = loadSources()
    const concurrency = Number(getFlag(args, "--concurrency", 8))
    const t0 = Date.now()
    const results = await mapPool(boards, concurrency, async (board) => {
      const label = `${board.type}:${board.slug ?? board.tenant ?? board.host}`
      try {
        return { board, label, postings: await fetchBoard(board, query) }
      } catch (e) {
        return { board, label, postings: [], error: e.message }
      }
    })
    for (const r of results) {
      if (r.error) failures.push(`${r.label} — ${r.error}`)
      else candidates.push(...r.postings)
    }
    recordSweep(results, limits, new Date())
    if (!isTerse()) {
      console.log(
        `Swept ${boards.length} board(s) at concurrency ${concurrency} in ${((Date.now() - t0) / 1000).toFixed(1)}s.`,
      )
    }
  }
  if (source === "all" || source === "hn") {
    try {
      candidates.push(...(await fetchHackerNews(primaryQuery)))
    } catch (e) {
      failures.push(`hn — ${e.message}`)
    }
  }
  if (source === "all" || source === "adzuna") {
    try {
      candidates.push(...(await fetchAdzuna(primaryQuery, limits)))
    } catch (e) {
      // On --source all, an unconfigured .env is a soft skip; asking for
      // adzuna explicitly makes it a hard failure worth surfacing.
      if (source === "adzuna") throw new Error(`adzuna — ${e.message}`)
      failures.push(`adzuna — ${e.message} (skipped)`)
    }
  }
  await ingest(candidates, limits, {
    enrich: !args.includes("--no-enrich"),
    leadsFile: getFlag(args, "--leads"),
  })
  for (const f of failures) console.error(`warn: source failed: ${f}`)
}

async function cmdImport(args) {
  const file = args.find((a) => !a.startsWith("--"))
  if (!file) throw new Error("usage: find-jobs.mjs import <file.json>")
  const raw = JSON.parse(fs.readFileSync(file, "utf8"))
  const candidates = Array.isArray(raw) ? raw : (raw.leads ?? [])
  await ingest(candidates, loadLimits(), {
    enrich: !args.includes("--no-enrich"),
    leadsFile: getFlag(args, "--leads"),
  })
}

function cmdList(args) {
  const status = getFlag(args, "--status", "new")
  const { leads } = loadLeads()
  const shown = leads.filter((l) => status === "all" || l.status === status)
  if (isTerse()) {
    for (const l of shown) {
      console.log(
        `${l.id}|${l.status}|${l.company}|${l.title}|${l.location || "?"}|${(l.posted_at ?? "?").slice(0, 10)}|${l.url}`,
      )
    }
    console.log(`count=${shown.length} total=${leads.length}`)
    return
  }
  for (const l of shown) {
    console.log(
      `[${l.status}] ${l.id}\n  ${l.company} — ${l.title}\n  ${l.location || "location?"} | posted ${l.posted_at ?? "?"} | ${l.url}`,
    )
  }
  console.log(
    `\n${shown.length} lead(s) with status "${status}" (${leads.length} total).`,
  )
}

function cmdMark(args) {
  const key = args.find((a) => !a.startsWith("--"))
  const status = getFlag(args, "--status")
  const notes = getFlag(args, "--notes")
  if (!key || !STATUSES.includes(status)) {
    throw new Error(
      `usage: find-jobs.mjs mark <id-or-url> --status <${STATUSES.join("|")}> [--notes "..."]`,
    )
  }
  const store = loadLeads()
  const lead = store.leads.find(
    (l) => l.id === key || normUrl(l.url) === normUrl(key),
  )
  if (!lead) throw new Error(`no lead matches "${key}"`)

  // Single-row UPDATE rather than rewriting the whole store. Marking 57 leads
  // dismissed on 2026-07-28 meant 57 full-file rewrites of a 321 KB JSON;
  // this is what makes a batch linear instead of quadratic.
  const src = resolveLeadSource()
  if (src.kind === "db") {
    const db = openDb(src.file)
    try {
      setLeadStatus(db, lead.id, status, notes || undefined)
    } finally {
      db.close()
    }
  } else {
    lead.status = status
    if (notes) lead.notes = notes
    saveLeads(store)
  }
  console.log(`${lead.id} → ${status}`)
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2)
  if (cmd === "search") await cmdSearch(args)
  else if (cmd === "import") await cmdImport(args)
  else if (cmd === "list") cmdList(args)
  else if (cmd === "mark") cmdMark(args)
  else {
    console.error("usage: find-jobs.mjs <search|import|list|mark> [options]")
    process.exit(2)
  }
}

const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (isMain) {
  main().catch((e) => {
    console.error(e.message)
    process.exit(1)
  })
}
