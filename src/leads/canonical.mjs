// Phase 0.13 — resolve a lead's URL to the ATS-hosted posting behind it.
//
// WHY THIS EXISTS. The trust gate (§4.8 precondition 1) decides a board is
// trusted because its host is a known ATS on an allowlist the user controls.
// Measured on the real store 2026-08-03: 74 of 158 leads (47%) carry a host
// that is not an ATS at all — 51 adzuna, 10 coinbase, 9 jobicy, 4 samsara —
// so nearly half the supply would be refused at the gate even when the form
// behind it is a plain Greenhouse page the machine handles perfectly.
//
// THE SECURITY SHAPE OF THIS FILE, because it is the part that can go wrong.
// Canonicalization takes a URL chosen by a third party and produces a URL that
// a later stage will TRUST. That is an obvious lever: a hostile posting that
// can steer the output of this file can point the trust gate wherever it
// likes. Three rules make that unreachable, and none of them may be relaxed
// for convenience:
//
//   1. THE OUTPUT MUST ITSELF BE AN ATS URL, checked by atsIdentity() after
//      resolution, not before. A redirect chain or a page scan that ends
//      anywhere else is UNRESOLVED — never "resolved to whatever it gave us".
//   2. HOSTNAMES ARE MATCHED ANCHORED, ON THE PARSED HOST. Never a substring
//      of the whole URL. This file deliberately does NOT reuse detectAts()
//      from apply/ats/index.mjs: that function matches ADAPTERS against the
//      entire URL string (its own header records the finding and why the
//      fixture still depends on it), so `evil.com/?x=jobs.lever.co` selects
//      the Lever adapter. Harmless when it only picks a fill strategy; not
//      harmless when it picks who to trust.
//   3. AMBIGUITY IS A REFUSAL. A careers page linking three different ATS
//      postings does not tell us which one this lead is, and picking the first
//      is the same defect as gotcha C-leads ("slug probing can find the wrong
//      company") — an application sent to the wrong employer under the user's
//      name. Two distinct identities means unresolved.
//
// AND THE CHEAPEST TIER IS THE MOST TRUSTWORTHY ONE. A lead found through a
// Greenhouse board API already carries its tenant and job id in `source` and
// `id` — `greenhouse:coinbase:8051871` with `?gh_jid=8051871` on the URL — so
// its canonical form is a string operation on data the BOARD gave us, with no
// third-party page in the loop at all. That tier resolves coinbase and samsara
// with zero network and zero trust in anything a posting says. Only the true
// aggregators (adzuna, jobicy), which carry no ATS identity anywhere, need a
// fetch.
import path from "node:path"
import { pathToFileURL } from "node:url"
import { mapPool } from "#lib/lib.mjs"

// --- what counts as an ATS URL ------------------------------------------------
//
// Each matcher anchors on the HOSTNAME and then requires a path shape that
// yields a tenant and a job id. Requiring the id matters: `jobs.lever.co/acme`
// is a company's board, not a posting, and canonicalizing a lead to a board
// index is how you apply to the wrong job.
const ATS_MATCHERS = [
  {
    ats: "greenhouse",
    host: /^(?:job-boards|boards)\.greenhouse\.io$/i,
    path: /^\/([^/]+)\/jobs\/(\d+)\b/,
    // Greenhouse moved to job-boards.; both resolve, and the sweep produces
    // the new one 35 times to the old one's 2. One spelling per posting means
    // two leads for the same job compare equal.
    canonical: (tenant, id) =>
      `https://job-boards.greenhouse.io/${tenant}/jobs/${id}`,
  },
  {
    ats: "ashby",
    host: /^jobs\.ashbyhq\.com$/i,
    path: /^\/([^/]+)\/([0-9a-f-]{8,})\b/i,
    canonical: (tenant, id) => `https://jobs.ashbyhq.com/${tenant}/${id}`,
  },
  {
    ats: "lever",
    host: /^jobs\.lever\.co$/i,
    path: /^\/([^/]+)\/([0-9a-f-]{8,})\b/i,
    canonical: (tenant, id) => `https://jobs.lever.co/${tenant}/${id}`,
  },
  {
    ats: "smartrecruiters",
    host: /^jobs\.smartrecruiters\.com$/i,
    path: /^\/([^/]+)\/(\d+)\b/,
    canonical: (tenant, id) =>
      `https://jobs.smartrecruiters.com/${tenant}/${id}`,
  },
  {
    ats: "workday",
    // <tenant>.wd<N>.myworkdayjobs.com — the tenant is the first label, and it
    // is part of the identity: two tenants on wd1 are two different employers.
    host: /^([a-z0-9-]+)\.wd\d+\.myworkdayjobs\.com$/i,
    path: /^\/.+\/job\/.+/i,
    fromHost: true,
    canonical: (tenant, id, url) => url,
  },
  {
    ats: "oracle_cloud",
    host: /^[a-z0-9-]+\.fa\.[a-z0-9-]+\.oraclecloud\.com$/i,
    path: /\/job\/(\d+)/i,
    fromHost: true,
    canonical: (tenant, id, url) => url,
  },
]

const PRIVATE_HOST =
  /^(?:localhost|127\.|0\.|10\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.|192\.168\.|\[?::1\]?$|\[?fc00:|\[?fd)/i

/** Parse, or null. Never throws — a malformed URL is just not an ATS URL. */
function parse(url) {
  try {
    const u = new URL(String(url ?? ""))
    return u.protocol === "http:" || u.protocol === "https:" ? u : null
  } catch {
    return null
  }
}

/**
 * The ATS identity of a URL, or null.
 *
 * @returns {{ats, tenant, job_id, canonical}|null}
 */
export function atsIdentity(url) {
  const u = parse(url)
  if (!u) return null
  for (const m of ATS_MATCHERS) {
    const hostHit = m.host.exec(u.hostname)
    if (!hostHit) continue
    const pathHit = m.path.exec(u.pathname)
    if (!pathHit) continue
    const tenant = m.fromHost ? (hostHit[1] ?? u.hostname) : pathHit[1]
    const job_id = m.fromHost ? (pathHit[1] ?? null) : pathHit[2]
    return {
      ats: m.ats,
      tenant,
      job_id,
      // Query and fragment are DROPPED: `?gh_jid=` and `?utm_source=` are not
      // part of which posting this is, and keeping them means the same job
      // stored twice under two URLs.
      canonical: m.canonical(tenant, job_id, `${u.origin}${u.pathname}`),
    }
  }
  return null
}

/** Is this URL safe to fetch at all? Blocks the SSRF shapes outright. */
export function isFetchable(url, { allowLoopback = false } = {}) {
  const u = parse(url)
  if (!u) return false
  if (!allowLoopback && PRIVATE_HOST.test(u.hostname)) return false
  return true
}

// --- tier 1: the lead already knows -------------------------------------------

// `source` is stamped by the adapter that found the lead, so it is OUR string,
// not the posting's: `greenhouse:coinbase` means a Greenhouse board API for
// tenant `coinbase` returned this. That is a stronger provenance than anything
// a page could tell us, and it costs nothing to read.
const SOURCE_ATS = /^(greenhouse|lever|ashby|smartrecruiters):([^:]+)/i

// The job id an ATS puts in the URL of an embedded careers page. These are the
// board's own parameter names — the mechanism by which an employer's marketing
// site tells the ATS widget which posting to render.
const EMBED_PARAMS = [
  ["gh_jid", "greenhouse"],
  ["ashby_jid", "ashby"],
  ["lever_jid", "lever"],
]

/**
 * Canonicalize from what the lead already carries. NO NETWORK.
 *
 * Requires the ATS and tenant from `source` AND a job id from either the URL's
 * embed parameter or the lead id's own last segment — and, when both are
 * present, requires them to AGREE. A disagreement means the two sources are
 * describing different postings and this function has no business guessing
 * which; it returns null and the caller falls through to a slower tier.
 */
export function canonicalFromLead(lead) {
  const srcHit = SOURCE_ATS.exec(String(lead?.source ?? ""))
  if (!srcHit) return null
  const ats = srcHit[1].toLowerCase()
  const tenant = srcHit[2]

  const u = parse(lead?.url)
  let fromParam = null
  if (u)
    for (const [param, forAts] of EMBED_PARAMS)
      if (forAts === ats && u.searchParams.get(param))
        fromParam = u.searchParams.get(param)

  // `greenhouse:coinbase:8051871` -> `8051871`
  const idParts = String(lead?.id ?? "").split(":")
  const fromId = idParts.length >= 3 ? idParts[idParts.length - 1] : null

  if (fromParam && fromId && fromParam !== fromId) return null
  const job_id = fromParam ?? fromId
  if (!job_id) return null

  const m = ATS_MATCHERS.find((x) => x.ats === ats)
  if (!m || m.fromHost) return null
  const candidate = m.canonical(tenant, job_id)
  // The output goes through the same door as everything else. If a tenant with
  // a slash in it produced something that no longer parses as an ATS posting,
  // it is not one.
  const id = atsIdentity(candidate)
  return id ? { ...id, via: "lead-identity" } : null
}

// --- tier 2: the URL itself is already an ATS posting -------------------------

export function canonicalFromUrl(lead) {
  const id = atsIdentity(lead?.url)
  return id ? { ...id, via: "already-ats" } : null
}

// --- tier 3: ask the network ---------------------------------------------------

// Absolute http(s) URLs, from anywhere in a document. Deliberately crude: the
// filter that matters is atsIdentity() on each candidate, not this regex.
const URL_IN_TEXT = /https?:\/\/[^\s"'<>\\)]+/gi

/**
 * Every DISTINCT ATS posting a document mentions.
 *
 * Distinct means distinct canonical form: a page that links the same posting
 * from a button and a breadcrumb mentions one posting, not two.
 */
export function extractAtsUrls(html) {
  const out = new Map()
  for (const raw of String(html ?? "").match(URL_IN_TEXT) ?? []) {
    // Trailing punctuation from prose and from HTML attribute soup.
    const cleaned = raw.replace(/[.,;:]+$/, "").replace(/&amp;/g, "&")
    const id = atsIdentity(cleaned)
    if (id) out.set(id.canonical, id)
  }
  return [...out.values()]
}

/**
 * Follow an aggregator link to the posting behind it.
 *
 * Two mechanisms, in order of trust: the redirect chain (the aggregator's own
 * statement of where this job lives), then the delivered page (a scan for ATS
 * links). Both are bounded, and both end at the same door — atsIdentity().
 */
export async function resolveViaNetwork(
  url,
  {
    fetchImpl = globalThis.fetch,
    maxHops = 5,
    timeoutMs = 10000,
    allowLoopback = false,
  } = {},
) {
  if (!isFetchable(url, { allowLoopback }))
    return { status: "unresolved", reason: "url is not fetchable", hops: 0 }

  let current = url
  let hops = 0
  const chain = []
  while (hops < maxHops) {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), timeoutMs)
    let res
    try {
      res = await fetchImpl(current, {
        redirect: "manual",
        signal: ac.signal,
        // No cookies, no auth, ever: this is a third-party page and we are not
        // a logged-in user of it.
        credentials: "omit",
        headers: { accept: "text/html,application/xhtml+xml" },
      })
    } catch (e) {
      clearTimeout(timer)
      return {
        status: "unresolved",
        reason: `fetch failed: ${e.message}`,
        hops,
        chain,
      }
    }
    clearTimeout(timer)

    const location = res.headers?.get?.("location")
    if (res.status >= 300 && res.status < 400 && location) {
      let next
      try {
        next = new URL(location, current).toString()
      } catch {
        return {
          status: "unresolved",
          reason: "unparseable redirect",
          hops,
          chain,
        }
      }
      if (!isFetchable(next, { allowLoopback }))
        return {
          status: "unresolved",
          reason: "redirect left the public web",
          hops,
          chain,
        }
      chain.push(next)
      hops++
      const id = atsIdentity(next)
      if (id) return { status: "resolved", via: "redirect", hops, chain, ...id }
      current = next
      continue
    }

    // A DEAD POSTING IS NOT AN UNRESOLVABLE ONE, and collapsing the two hides
    // the single most common thing that happens to an aggregator link. Measured
    // 2026-08-03: adzuna details pages for stored leads return 404 while still
    // serving a full 49 KB page, so a scanner that only looks at the body reads
    // "no ATS posting found" and the lead looks like a parser gap. It is not —
    // the job is gone, which is `posting-gone` in the Phase 4.1 taxonomy and a
    // routine event at hundreds of leads.
    if (res.status === 404 || res.status === 410)
      return {
        status: "unresolved",
        reason: "posting-gone",
        kind: "posting-gone",
        http_status: res.status,
        hops,
        chain,
      }

    // A REFUSAL IS NOT A PARSE GAP, and conflating the two cost this project a
    // wrong conclusion. Measured 2026-08-03, the network tier scored 0/21 on
    // adzuna and jobicy and find-jobs.mjs was left offline on the strength of
    // it, with the reason recorded as "no ATS posting found on the page" — a
    // sentence that says the scanner looked and the page had nothing. It did
    // not. Re-measured 2026-08-09: `www.adzuna.com/land/ad/...` answers **403**
    // and serves a 13 KB block page, so what the scanner read was a bot wall.
    // Those are opposite findings with opposite fixes — a parse gap asks for a
    // better matcher, a 403 says this host does not serve robots and no matcher
    // will ever change that — and the old wording pointed at the fix that could
    // not work. Anything that refuses or rate-limits gets its own kind, before
    // the body is scanned, so the distinction cannot be lost again.
    //
    // Deliberately NOT a retry or a backoff, and never a forged User-Agent: the
    // host is declining automated access, and dressing the client up as a
    // browser to get past that is circumventing a control the operator put
    // there on purpose. `blocked` is a terminal answer here.
    if (res.status === 401 || res.status === 403 || res.status === 429)
      return {
        status: "unresolved",
        reason: `blocked by the host (HTTP ${res.status}) — it refuses automated requests, so no ATS posting can be read from it`,
        kind: "blocked",
        http_status: res.status,
        hops,
        chain,
      }

    // Not a redirect: this is the page. Scan it.
    let html = ""
    try {
      html = await res.text()
    } catch (e) {
      return {
        status: "unresolved",
        reason: `body read failed: ${e.message}`,
        hops,
        chain,
      }
    }
    const found = extractAtsUrls(html)
    if (found.length === 1)
      return { status: "resolved", via: "page-scan", hops, chain, ...found[0] }
    if (found.length > 1)
      return {
        status: "unresolved",
        // Named rather than resolved-to-the-first: see rule 3 in the header.
        reason: `page mentions ${found.length} distinct ATS postings; which one this lead is cannot be determined`,
        hops,
        chain,
        candidates: found.map((f) => f.canonical),
      }
    return {
      status: "unresolved",
      reason: "no ATS posting found on the page",
      hops,
      chain,
    }
  }
  return {
    status: "unresolved",
    reason: `more than ${maxHops} redirects`,
    hops,
    chain,
  }
}

// --- the whole ladder ----------------------------------------------------------

/**
 * @param lead    a stored lead
 * @param opts    {network: boolean, ...resolveViaNetwork opts}
 * @returns {{status, canonical?, ats?, tenant?, job_id?, via, reason?}}
 */
export async function canonicalizeLead(lead, { network = true, ...opts } = {}) {
  const cheap = canonicalFromUrl(lead) ?? canonicalFromLead(lead)
  if (cheap) return { status: "resolved", ...cheap }
  if (!network)
    return {
      status: "unresolved",
      reason: "needs a fetch and network is off",
      via: "none",
    }
  return resolveViaNetwork(lead?.url, opts)
}

/**
 * Canonicalize a batch, mutating each lead in place.
 *
 * The ORIGINAL URL IS NEVER DISCARDED. `url` keeps whatever the sweep found —
 * it is what the user clicks to read the posting as the aggregator presents it,
 * and it is the provenance of the canonical form. `apply_url` is the new field
 * and it is the one the trust gate reads: a lead has one only when something
 * deterministic resolved it.
 */
export async function canonicalizeLeads(
  leads,
  { concurrency = 4, network = true, ...opts } = {},
) {
  const targets = (leads ?? []).filter((l) => l?.url && !l.apply_url)
  const stats = {
    attempted: targets.length,
    resolved: 0,
    unresolved: 0,
    by_via: {},
  }
  await mapPool(targets, concurrency, async (lead) => {
    const r = await canonicalizeLead(lead, { network, ...opts })
    if (r.status === "resolved") {
      lead.apply_url = r.canonical
      lead.apply_ats = r.ats
      lead.apply_url_via = r.via
      stats.resolved++
      stats.by_via[r.via] = (stats.by_via[r.via] ?? 0) + 1
    } else {
      // Recorded, not silent: a lead the gate will refuse should say why it
      // could not be resolved, in the same spirit as a deferral.
      lead.apply_url_unresolved = r.reason ?? "unresolved"
      // The KIND is kept alongside the prose because the two answer different
      // questions: the reason is for a human reading one lead, the kind is what
      // a later measurement counts. `blocked` vs `no ATS posting found` is the
      // difference between "this host will never work" and "our matcher missed
      // one", and only the kind survives being tallied.
      if (r.kind) lead.apply_url_unresolved_kind = r.kind
      stats.unresolved++
      stats.by_kind ??= {}
      const k = r.kind ?? "unresolved"
      stats.by_kind[k] = (stats.by_kind[k] ?? 0) + 1
    }
  })
  return stats
}

// --- CLI -----------------------------------------------------------------------
// Backfill for leads already in the store, and the measurement 0.13 is scored
// on. DRY BY DEFAULT and OFFLINE BY DEFAULT, in that order of caution: the
// cheap tiers alone resolve every embedded careers page without asking anyone
// for anything, so the useful first run costs zero third-party requests.
// `--network` opts into the aggregator tier, and `--limit N` bounds how many
// pages a single run will fetch.

async function main() {
  const args = process.argv.slice(2)
  const flag = (n) => args.includes(n)
  const value = (n, d) => {
    const i = args.indexOf(n)
    return i !== -1 && args[i + 1] ? args[i + 1] : d
  }
  const apply = flag("--apply")
  const network = flag("--network")
  const limit = Number(value("--limit", "0")) || 0

  const { openDb, resolveLeadSource } = await import("#lib/db.mjs")
  const { isTerse } = await import("#lib/lib.mjs")

  const src = resolveLeadSource()
  if (src.kind !== "db") throw new Error("no lead database to canonicalize")
  const db = openDb(src.file)
  try {
    const rows = db.prepare("SELECT id, doc FROM leads").all()
    const leads = rows.map((r) => JSON.parse(r.doc))
    let targets = leads.filter((l) => l?.url && !l.apply_url)
    // The bound applies to the leads that would actually cost a request, so
    // --limit never silently starves the free tier.
    if (limit && network) {
      const cheap = targets.filter(
        (l) => canonicalFromUrl(l) ?? canonicalFromLead(l),
      )
      const dear = targets
        .filter((l) => !(canonicalFromUrl(l) ?? canonicalFromLead(l)))
        .slice(0, limit)
      targets = [...cheap, ...dear]
    }

    const stats = await canonicalizeLeads(targets, { network })

    if (apply) {
      const update = db.prepare("UPDATE leads SET doc = ? WHERE id = ?")
      db.exec("BEGIN")
      try {
        for (const l of targets) update.run(JSON.stringify(l), l.id)
        db.exec("COMMIT")
      } catch (e) {
        db.exec("ROLLBACK")
        throw e
      }
    }

    const byVia = Object.entries(stats.by_via)
      .map(([k, v]) => `${k}=${v}`)
      .join(" ")
    if (flag("--json")) {
      console.log(
        JSON.stringify(
          {
            ...stats,
            applied: apply,
            network,
            resolved_leads: targets
              .filter((l) => l.apply_url)
              .map((l) => ({
                id: l.id,
                apply_url: l.apply_url,
                via: l.apply_url_via,
              })),
          },
          null,
          2,
        ),
      )
    } else if (isTerse()) {
      console.log(
        `canonical attempted=${stats.attempted} resolved=${stats.resolved} unresolved=${stats.unresolved} ${byVia} apply=${apply}`,
      )
    } else {
      console.log(
        `Resolved ${stats.resolved} of ${stats.attempted} lead(s) to an ATS posting (${byVia || "none"}).`,
      )
      console.log(
        apply
          ? "Written to the store."
          : "Nothing written — re-run with --apply.",
      )
    }
  } finally {
    db.close()
  }
}

const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href

if (isMain) {
  main().catch((e) => {
    console.error(`error: ${e.message}`)
    process.exit(1)
  })
}
