// Per-posting description fetchers.
//
// Why this exists: four of the swept ATS types return a *list* endpoint with no
// description at all (oracle_cloud, smartrecruiters, successfactors, workday).
// On 2026-07-29 that was 19 of 102 stored leads — and not a random 19: those
// boards are Caesars, Station Casinos, Boyd Gaming, IGT and CVS, i.e. the local
// Las Vegas employers, which are the highest-value leads for a North Las Vegas
// applicant precisely because on-site is in scope for them. A lead with no
// description cannot be keyword-indexed and cannot be blocker-screened, so
// those leads were the least examinable and the most important at once.
//
// What it cost to not have this: Station Casinos' "Junior Engineer - Palace"
// passed the title gate on local latitude and sat in the store as a software
// lead. Its description is "Pick up supplies and parts from vendors. Perform
// all repairs, maintenance and part replacements... preventive maintenance
// schedule" — a building-maintenance job. Nothing in the pipeline could see
// that, because nothing had the text.
//
// Latency discipline: these are N extra round trips, one per posting, so they
// run ONLY for postings that already survived the cheap title/location/
// freshness gates. That is single digits per sweep, not the hundreds the list
// endpoints return. Failures are per-posting and swallowed: a detail endpoint
// that 404s must never lose a lead the sweep already found.

import path from "node:path"
import { pathToFileURL } from "node:url"
import { fetchJson, fetchText, mapPool, decodeEntities } from "../lib/lib.mjs"
import { sanitizeHtmlSnippet } from "../lib/untrusted.mjs"

// A detail payload with no derivable URL or no matching markup is "nothing to
// enrich", not "clean text found" — both are `{ text: null, ... }`, but this
// constant is what every early-return path shares, so the fill loop below can
// treat every fetcher's result as the same three-field shape without a
// null-check of its own.
const NOTHING = { text: null, findings: [], clean: true }

// --- URL derivation ----------------------------------------------------------
// Deliberately derived from the stored lead's own url/id rather than from
// docs/job-sources.yaml: enrichment then also works for an imported lead, and a
// board removed from the sweep list does not orphan the leads it produced.

// https://ejfh.fa.us6.oraclecloud.com/hcmUI/CandidateExperience/en/sites/StationCasinos/job/22314
export function oracleDetailUrl(url) {
  const m =
    /^https?:\/\/([^/]+)\/hcmUI\/CandidateExperience\/[^/]+\/sites\/([^/]+)\/job\/(\d+)/i.exec(
      String(url ?? ""),
    )
  if (!m) return null
  const [, host, site, id] = m
  return (
    `https://${host}/hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails` +
    `?onlyData=true&expand=all&finder=ById;Id=%22${id}%22,siteNumber=%22${site}%22`
  )
}

// https://jobs.smartrecruiters.com/BoydGaming/3743990013989186
export function smartRecruitersDetailUrl(url) {
  const m = /^https?:\/\/jobs\.smartrecruiters\.com\/([^/]+)\/(\d+)/i.exec(
    String(url ?? ""),
  )
  if (!m) return null
  return `https://api.smartrecruiters.com/v1/companies/${m[1]}/postings/${m[2]}`
}

// Workday's careers page and the JSON its own front end calls differ only in
// the path prefix: /en-US/{site}{externalPath} -> /wday/cxs/{tenant}/{site}{externalPath}.
// The tenant is not in the page URL, so it comes from the lead id
// ("workday:cvshealth:R0977981"), falling back to the host's first label.
export function workdayDetailUrl(url, id = "") {
  const m = /^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)(\/job\/.+)$/i.exec(
    String(url ?? ""),
  )
  if (!m) return null
  const [, host, , site, externalPath] = m
  const tenant = String(id).split(":")[1] || host.split(".")[0]
  return `https://${host}/wday/cxs/${tenant}/${site}${externalPath}`
}

// --- payload -> description --------------------------------------------------

// Oracle splits a posting across four fields and only some are populated per
// tenant, so all of them are concatenated. Qualifications matter most: that is
// where the years-of-experience bar and the degree demand live.
//
// These four functions used to return textSnippet(...)'s plain string. They
// now return sanitizeHtmlSnippet(...)'s { text, findings, clean } — this is a
// detail-page fetch, i.e. RAW HTML from a third party, reaching the pipeline
// for the first time here, and it needs the same markup-aware scrub the list
// endpoints get in find-jobs.mjs (untrustedSnippet). Returning textSnippet's
// flattened string first would destroy the display:none the scrubber needs to
// see, exactly the ordering bug 1.3 exists to close.
export function oracleDescription(payload) {
  const it = payload?.items?.[0] ?? {}
  return sanitizeHtmlSnippet(
    it.ShortDescriptionStr,
    it.ExternalDescriptionStr,
    it.ExternalResponsibilitiesStr,
    it.ExternalQualificationsStr,
  )
}

// SmartRecruiters returns the ad as named sections. companyDescription is
// dropped: it is identical on every posting from the board and would crowd the
// snippet cap with boilerplate that says nothing about the role.
export function smartRecruitersDescription(payload) {
  const s = payload?.jobAd?.sections ?? {}
  return sanitizeHtmlSnippet(
    s.jobDescription?.text,
    s.qualifications?.text,
    s.additionalInformation?.text,
  )
}

// SuccessFactors has no public API; the description is a known span on the job
// page. Exported so a career-site redesign fails a test rather than silently
// yielding leads with no text.
export function successFactorsDescription(html) {
  const m = /<span[^>]*class="[^"]*jobdescription[^"]*"[^>]*>([\s\S]*?)$/i.exec(
    String(html ?? ""),
  )
  if (!m) return NOTHING
  // The span is not reliably closed before the footer, so cut at the first
  // structural marker that follows every posting body.
  const body = m[1].split(/<\/div>\s*<div[^>]*class="[^"]*jobFooter/i)[0]
  return sanitizeHtmlSnippet(body)
}

export function workdayDescription(payload) {
  const info = payload?.jobPostingInfo ?? {}
  return sanitizeHtmlSnippet(
    info.jobDescription,
    info.jobRequisitionLocation?.descriptor,
  )
}

// --- dispatch ----------------------------------------------------------------

// Which stored leads this module can do anything about. Keyed on the source
// prefix the adapters stamp, so an unknown board is skipped, not guessed at.
const FETCHERS = {
  oracle_cloud: async (lead) => {
    const u = oracleDetailUrl(lead.url)
    return u ? oracleDescription(await fetchJson(u)) : NOTHING
  },
  smartrecruiters: async (lead) => {
    const u = smartRecruitersDetailUrl(lead.url)
    return u ? smartRecruitersDescription(await fetchJson(u)) : NOTHING
  },
  successfactors: async (lead) => {
    if (!lead.url) return NOTHING
    return successFactorsDescription(await fetchText(lead.url))
  },
  workday: async (lead) => {
    const u = workdayDetailUrl(lead.url, lead.id)
    return u ? workdayDescription(await fetchJson(u)) : NOTHING
  },
}

export const canEnrich = (lead) =>
  !lead?.description &&
  Boolean(FETCHERS[String(lead?.source ?? lead?.id ?? "").split(":")[0]])

// Fills in `description` on every lead that lacks one and whose board has a
// detail endpoint. Mutates the leads in place and returns a count plus the
// per-board failures, so the sweep can report a broken detail endpoint the same
// way it reports a broken list endpoint.
//
// `fetchers` is injectable for tests — the real ones hit the network.
export async function enrichDescriptions(
  leads,
  { concurrency = 6, fetchers = FETCHERS } = {},
) {
  const targets = leads.filter(
    (l) =>
      !l.description && fetchers[String(l.source ?? l.id ?? "").split(":")[0]],
  )
  const failures = []
  let filled = 0
  await mapPool(targets, concurrency, async (lead) => {
    const kind = String(lead.source ?? lead.id ?? "").split(":")[0]
    try {
      const res = await fetchers[kind](lead) // { text, findings, clean }
      if (res.text) {
        lead.description = res.text
        // Omitted when clean, same convention as untrustedSnippet in
        // find-jobs.mjs — an honest lead's stored doc does not grow an empty
        // array just because it went through a detail fetch.
        if (!res.clean) lead.untrusted_findings = res.findings
        filled++
      } else {
        // Reached the endpoint but found no body: the parse is stale or the
        // posting genuinely has none. Flagged so screening knows the blocker
        // check ran against nothing rather than against a clean posting.
        lead.flags = [...new Set([...(lead.flags ?? []), "no_description"])]
      }
    } catch (e) {
      lead.flags = [...new Set([...(lead.flags ?? []), "no_description"])]
      failures.push(`${lead.source ?? kind} — ${e.message}`)
    }
  })
  return { filled, attempted: targets.length, failures }
}

export { decodeEntities }

// --- CLI ---------------------------------------------------------------------
// Backfill for leads already in the store. A sweep only enriches the postings it
// found this run, so without this the leads collected before the detail fetchers
// existed would stay permanently text-less — unscreenable and unindexed. Flat
// and idempotent: a lead that already has a description is skipped, so re-running
// costs nothing.

async function main() {
  const args = process.argv.slice(2)
  const dry = !args.includes("--apply")
  const { openDb, resolveLeadSource, setLeadKeywords } =
    await import("../lib/db.mjs")
  const { extractTech } = await import("../profile/profile-gaps.mjs")
  const { isTerse } = await import("../lib/lib.mjs")

  const src = resolveLeadSource()
  if (src.kind !== "db") throw new Error("no lead database to enrich")
  const db = openDb(src.file)
  try {
    const rows = db.prepare("SELECT id, doc FROM leads").all()
    const leads = rows.map((r) => JSON.parse(r.doc))
    const targets = leads.filter(canEnrich)
    if (!targets.length) {
      console.log(isTerse() ? "enriched=0/0" : "Every lead already has text.")
      return
    }
    if (dry) {
      for (const l of targets) console.log(`would-fetch ${l.id}`)
      console.log(
        isTerse()
          ? `candidates=${targets.length} apply=false`
          : `\n${targets.length} lead(s) could be enriched. Re-run with --apply.`,
      )
      return
    }
    const res = await enrichDescriptions(targets)
    const update = db.prepare("UPDATE leads SET doc = ? WHERE id = ?")
    // node:sqlite, so BEGIN/COMMIT explicitly — there is no db.transaction()
    // wrapper here the way better-sqlite3 provides one.
    db.exec("BEGIN")
    try {
      for (const l of targets) {
        update.run(JSON.stringify(l), l.id)
        // Keywords are derived from the description, so a lead that just gained
        // one has to be re-indexed or the whole point of the fetch is lost.
        setLeadKeywords(db, l.id, [
          ...extractTech(
            [l.title, l.description, ...(l.requirements ?? [])]
              .filter(Boolean)
              .join("\n"),
          ),
        ])
      }
      db.exec("COMMIT")
    } catch (e) {
      db.exec("ROLLBACK")
      throw e
    }
    console.log(
      isTerse()
        ? `enriched=${res.filled}/${res.attempted}`
        : `Fetched descriptions for ${res.filled} of ${res.attempted} lead(s) and re-indexed their keywords.`,
    )
    for (const f of res.failures) console.error(`warn: ${f}`)
  } finally {
    db.close()
  }
}

// Same shape as every other script here. Not a top-level await: this module is
// imported by find-jobs.mjs on the sweep path, and top-level await in a
// dependency delays the whole import graph.
const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href

if (isMain) {
  main().catch((e) => {
    console.error(`error: ${e.message}`)
    process.exit(1)
  })
}
