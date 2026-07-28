#!/usr/bin/env node
// Deterministic job-lead finder (no LLM calls). Sweeps the public,
// integration-friendly job APIs listed in docs/job-sources.yaml (Greenhouse,
// Lever, Ashby, SmartRecruiters, Workable, Recruitee, Workday CXS) plus
// Hacker News, filters every hit through docs/application-limits.yaml,
// dedupes against stored leads and application history, and maintains the
// lead store at jobs/leads.json.
//
// Usage:
//   node scripts/find-jobs.mjs search [--source all|hn|boards|adzuna] [--query "full stack"] [--max-age N]
//   node scripts/find-jobs.mjs import <file.json>   # leads captured in-session (Playwright/WebFetch)
//   node scripts/find-jobs.mjs list [--status new|recommended|dismissed|applied|all]
//   node scripts/find-jobs.mjs mark <id-or-url> --status <status> [--notes "..."]
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import yaml from "js-yaml"
import { isTerse } from "./lib.mjs"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const LIMITS_PATH = path.join(ROOT, "docs", "application-limits.yaml")
const SOURCES_PATH = path.join(ROOT, "docs", "job-sources.yaml")
const LEADS_PATH = path.join(ROOT, "jobs", "leads.json")
const APPLICATIONS_PATH = path.join(ROOT, "profile", "applications.yaml")

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

export function passesLimits(job, limits, now = new Date()) {
  const reasons = []
  const flags = []
  let local = false

  const title = String(job.title ?? "").toLowerCase()
  const kws = limits.roles?.title_keywords ?? []
  const titleHit =
    !kws.length || kws.some((k) => title.includes(String(k).toLowerCase()))

  const loc = String(job.location ?? "")
    .trim()
    .toLowerCase()
  // Workday collapses a multi-site posting to the literal string "2 Locations",
  // which carries no geography at all. Treating that as a location rejected it
  // as a relocation — and multi-site postings skew towards exactly the roles
  // worth seeing. Flag for screening to resolve instead of discarding.
  const OPAQUE_LOC = /^\d+\s*locations?$/i
  if (!loc || OPAQUE_LOC.test(loc)) {
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
    const remoteText = /\bremote\b/.test(loc) && !nonUsOnly
    // Board-level remote flag with a contradictory on-site location string is
    // kept but flagged: screening must confirm it is truly remote-from-NV.
    const remoteFlagged = job.remote === true && !nonUsOnly
    const remoteOk =
      (limits.location?.remote_ok ?? true) && (remoteText || remoteFlagged)
    if (!remoteOk && !onsiteOk) {
      reasons.push(
        `location: "${job.location}" would require relocating away from ${limits.location?.base ?? "base"}`,
      )
    } else if (remoteOk && !remoteText && !onsiteOk) {
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

// Boards return postings as HTML (Greenhouse double-encodes it). The screen
// only needs enough text to spot blockers — a clearance demand or a seniority
// bar — so store a stripped, capped snippet rather than the whole ad; the lead
// store holds dozens of these.
export const SNIPPET_MAX = 4000

const decodeEntities = (s) =>
  String(s)
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#0?39;|&rsquo;|&apos;/gi, "'")
    .replace(/&quot;|&ldquo;|&rdquo;/gi, '"')
    .replace(/&amp;/gi, "&")

export function textSnippet(...parts) {
  const raw = parts.filter(Boolean).join("\n")
  if (!raw) return null
  const txt = decodeEntities(
    decodeEntities(raw)
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim()
  return txt ? txt.slice(0, SNIPPET_MAX) : null
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

export function dedupeLeads(candidates, existingLeads = [], applied = []) {
  const seen = new Set()
  for (const l of existingLeads) {
    if (l.id) seen.add(l.id)
    if (l.url) seen.add(normUrl(l.url))
    seen.add(companyTitleKey(l))
  }
  const appliedKeys = new Set(applied.map(companyTitleKey))
  const fresh = []
  for (const c of candidates) {
    const keys = [
      c.id,
      c.url ? normUrl(c.url) : null,
      companyTitleKey(c),
    ].filter(Boolean)
    if (keys.some((k) => seen.has(k))) continue
    if (appliedKeys.has(companyTitleKey(c))) continue
    keys.forEach((k) => seen.add(k))
    fresh.push(c)
  }
  return fresh
}

// ---------------------------------------------------------------------------
// Store I/O
// ---------------------------------------------------------------------------

export function loadLimits(file = LIMITS_PATH) {
  return yaml.load(fs.readFileSync(file, "utf8")) ?? {}
}

function loadLeads() {
  if (!fs.existsSync(LEADS_PATH)) return { leads: [] }
  return JSON.parse(fs.readFileSync(LEADS_PATH, "utf8"))
}

function saveLeads(store) {
  fs.mkdirSync(path.dirname(LEADS_PATH), { recursive: true })
  fs.writeFileSync(LEADS_PATH, JSON.stringify(store, null, 2) + "\n")
}

function loadApplied() {
  if (!fs.existsSync(APPLICATIONS_PATH)) return []
  const doc = yaml.load(fs.readFileSync(APPLICATIONS_PATH, "utf8"))
  return doc?.applications ?? []
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

async function fetchJson(url, body = null) {
  const res = await fetch(url, {
    method: body ? "POST" : "GET",
    headers: {
      "user-agent": "agentic-job-application/0.1 (personal job search tool)",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
  return res.json()
}

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
    description: textSnippet(j.content),
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
    description: textSnippet(
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
      description: textSnippet(j.descriptionPlain ?? j.descriptionHtml),
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
    description: textSnippet(j.description, j.requirements),
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
        description: textSnippet(
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

async function fetchText(url) {
  const res = await fetch(url, {
    headers: {
      "user-agent": "agentic-job-application/0.1 (personal job search tool)",
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
  return res.text()
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
      description: textSnippet(tag("briefdescription"), tag("description")),
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
    description: textSnippet(j.description),
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

async function fetchHackerNews(query) {
  const q = encodeURIComponent(query || "full stack")
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
}

export const BOARD_TYPES = Object.keys(BOARD_FETCHERS)

// One entry point per board — used by cmdSearch and by manage-sources.mjs to
// prescreen a board before it is added to docs/job-sources.yaml.
export async function fetchBoard(board, query = "software engineer") {
  const fetcher = BOARD_FETCHERS[board.type]
  if (!fetcher) throw new Error(`unknown board type "${board.type}"`)
  return fetcher(board, query)
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

function summarize(kept, rejected, opts = {}) {
  if (opts.explain) explainTitles(rejected, opts.explainTop ?? 30)
  if (isTerse()) {
    for (const l of kept) {
      const f = l.flags?.length ? `|${l.flags.join(",")}` : ""
      console.log(`+${l.id}|${l.company}|${l.title}|${l.location || "?"}${f}`)
    }
    console.log(`stored=${kept.length} rejected=${rejected.length}`)
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
    `\nStored ${kept.length} new lead(s); rejected ${rejected.length} ` +
      `(${
        Object.entries(byReason)
          .map(([k, v]) => `${k}: ${v}`)
          .join(", ") || "none"
      }).`,
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

function ingest(candidates, limits) {
  const store = loadLeads()
  const applied = loadApplied()
  const now = new Date()
  const kept = []
  const rejected = []
  const backfilled = backfillDescriptions(candidates, store.leads)
  for (const c of dedupeLeads(candidates, store.leads, applied)) {
    const verdict = passesLimits(c, limits, now)
    if (!verdict.ok) {
      rejected.push({ ...c, reasons: verdict.reasons })
      continue
    }
    kept.push({
      ...c,
      flags: verdict.flags,
      status: "new",
      found_at: now.toISOString(),
      notes: "",
    })
  }
  store.leads.push(...kept)
  saveLeads(store)
  const ei = process.argv.indexOf("--explain")
  const eN = Number(process.argv[ei + 1])
  summarize(kept, rejected, {
    explain: ei !== -1,
    explainTop: Number.isFinite(eN) && eN > 0 ? eN : 30,
  })
  if (backfilled) {
    console.log(
      `Backfilled description snippets onto ${backfilled} existing lead(s).`,
    )
  }
}

async function cmdSearch(args) {
  const limits = loadLimits()
  const source = getFlag(args, "--source", "all")
  const query = getFlag(args, "--query", "full stack")
  const maxAge = getFlag(args, "--max-age")
  if (maxAge) (limits.freshness ??= {}).max_age_days = Number(maxAge)

  const candidates = []
  const failures = []
  if (source === "all" || source === "boards") {
    for (const board of loadSources()) {
      const label = `${board.type}:${board.slug ?? board.tenant}`
      try {
        candidates.push(...(await fetchBoard(board, query)))
      } catch (e) {
        failures.push(`${label} — ${e.message}`)
      }
    }
  }
  if (source === "all" || source === "hn") {
    try {
      candidates.push(...(await fetchHackerNews(query)))
    } catch (e) {
      failures.push(`hn — ${e.message}`)
    }
  }
  if (source === "all" || source === "adzuna") {
    try {
      candidates.push(...(await fetchAdzuna(query, limits)))
    } catch (e) {
      // On --source all, an unconfigured .env is a soft skip; asking for
      // adzuna explicitly makes it a hard failure worth surfacing.
      if (source === "adzuna") throw new Error(`adzuna — ${e.message}`)
      failures.push(`adzuna — ${e.message} (skipped)`)
    }
  }
  ingest(candidates, limits)
  for (const f of failures) console.error(`warn: source failed: ${f}`)
}

function cmdImport(args) {
  const file = args.find((a) => !a.startsWith("--"))
  if (!file) throw new Error("usage: find-jobs.mjs import <file.json>")
  const raw = JSON.parse(fs.readFileSync(file, "utf8"))
  const candidates = Array.isArray(raw) ? raw : (raw.leads ?? [])
  ingest(candidates, loadLimits())
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
  lead.status = status
  if (notes) lead.notes = notes
  saveLeads(store)
  console.log(`${lead.id} → ${status}`)
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2)
  if (cmd === "search") await cmdSearch(args)
  else if (cmd === "import") cmdImport(args)
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
