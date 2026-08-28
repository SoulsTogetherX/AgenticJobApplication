#!/usr/bin/env node
// Enumerate ATS board slugs from the Common Crawl URL index (fix plan Phase 3).
//
// The reach ceiling was never "which companies exist" — it was "which slugs do
// we know". Common Crawl's CDX index has already seen every public
// jobs.ashbyhq.com/<slug> and *.greenhouse.io/<slug> page on the open web, and
// both hosts' robots.txt permit that crawl, so the index is a lawful candidate
// source at zero load on the ATSs themselves. This script only produces
// CANDIDATES: discover-boards.mjs yield-gates them, and only the user adds a
// board via manage-sources (job-sources.yaml is user policy, rule 10).
//
// LEVER IS EXCLUDED BY RULE, not by omission. Lever's robots.txt disallows
// crawlers, so Common Crawl carries no lawful index of it; Lever candidates
// come from find-boards.mjs name probing over api.lever.co, which its
// robots.txt allows under the 1-second Crawl-delay that lib.mjs's politeness
// gate enforces (Phase 2).
//
// Politeness: every index request goes through fetchJson/fetchText, and
// index.commoncrawl.org sits in HOST_MIN_DELAY_MS — CDX pages are fetched 1s
// apart, start to start, without this file doing anything. The index also
// sheds load with transient 5xx (a 502 was measured on the first probe of
// CC-MAIN-2026-30); the answer is resume, never a retry loop.
//
// Crash-safe: state (done pages + slug counts) lives in
// jobs/.cc/<crawl>-<host>.state.json (inside the gitignored /jobs/ tree),
// written atomically after every page, so a killed or refused run resumes
// instead of refetching, and the candidates YAML is regenerated from state on
// every run — including a --max-pages slice.
//
// The CDX page endpoint answers NDJSON (one JSON object per line), which is
// why pages ride fetchText rather than fetchJson; showNumPages answers a
// single JSON object and stays on fetchJson. Both take the politeness gate.
//
// Usage:
//   node src/leads/cc-boards.mjs --crawl CC-MAIN-2026-30 --hosts ashby,greenhouse
//        [--out <file>] [--max-pages N] [--json]
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import yaml from "js-yaml"
import { fetchJson, fetchText, isTerse } from "../lib/lib.mjs"
import { loadSources } from "./find-jobs.mjs"

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
)

const INDEX_HOST = "https://index.commoncrawl.org"

// Host keys -> the CDX URL patterns that cover them. Greenhouse spans two
// hosts on purpose: legacy boards.greenhouse.io and the newer
// job-boards.greenhouse.io both carry live boards, and a slug seen on either
// is the same company, so both patterns fold into one candidates file.
export const HOSTS = {
  ashby: { type: "ashby", patterns: ["jobs.ashbyhq.com/*"] },
  greenhouse: {
    type: "greenhouse",
    patterns: ["boards.greenhouse.io/*", "job-boards.greenhouse.io/*"],
  },
}

// First path segments that are routes or assets, never org slugs.
const DROP_SEGMENTS = new Set([
  "",
  "embed",
  "js",
  "api",
  "assets",
  "static",
  "css",
  "img",
  "images",
  "fonts",
  "_next",
  "error",
  "404",
])
const FILE_EXT_RE =
  /\.(ico|txt|xml|js|css|png|jpe?g|svg|json|map|webmanifest)$/i

// First path segment of a captured URL, decoded, or null when the segment is
// a route/asset rather than a plausible org slug. Ashby paths are display
// names ("My%20Company"), so the decoded form is the board identifier.
export function slugFromUrl(url) {
  let u
  try {
    u = new URL(url)
  } catch {
    return null
  }
  const seg = u.pathname.split("/").filter(Boolean)[0] ?? ""
  let slug
  try {
    slug = decodeURIComponent(seg).trim()
  } catch {
    slug = seg.trim()
  }
  if (slug.length < 2) return null
  if (DROP_SEGMENTS.has(slug.toLowerCase()) || FILE_EXT_RE.test(slug))
    return null
  return slug
}

// Fold one CDX NDJSON page into counts (lowercased slug -> {slug, seen},
// first spelling kept). Only 2xx/3xx captures count: a slug seen exclusively
// via 404s is a dead board, and counting it would just hand discover-boards a
// broken fetch.
export function foldPage(counts, ndjson) {
  let folded = 0
  for (const line of String(ndjson).split("\n")) {
    if (!line.trim()) continue
    let rec
    try {
      rec = JSON.parse(line)
    } catch {
      continue
    }
    const status = Number(rec.status ?? 0)
    if (status < 200 || status >= 400) continue
    const slug = slugFromUrl(rec.url)
    if (!slug) continue
    const key = slug.toLowerCase()
    const cur = counts[key] ?? { slug, seen: 0 }
    cur.seen++
    counts[key] = cur
    folded++
  }
  return folded
}

// Display-name guess for a slug: "acme-widgets" -> "Acme Widgets". The live
// check shows real postings before anything is proposed, so this only has to
// be readable, not authoritative.
export function companyFromSlug(slug) {
  const words = String(slug)
    .replace(/[-_.]+/g, " ")
    .trim()
    .split(/\s+/)
  return words
    .map((w) => (w === w.toLowerCase() ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ")
}

// Candidates doc in exactly the shape discover-boards.mjs loads
// (doc.candidates), deduped against the boards already swept, sorted by how
// often Common Crawl saw the board (a live, linked-to board gets captured
// more) with the slug as a deterministic tiebreak.
export function buildCandidates(hostKey, counts, known) {
  const type = HOSTS[hostKey].type
  const candidates = Object.values(counts)
    .filter((c) => !known.has(`${type}:${c.slug.toLowerCase()}`))
    .sort((a, b) => b.seen - a.seen || a.slug.localeCompare(b.slug))
    .map((c) => ({
      type,
      slug: c.slug,
      company: companyFromSlug(c.slug),
      pool: "cc",
      seen: c.seen,
    }))
  return { candidates }
}

const stateFileFor = (dir, crawl, hostKey) =>
  path.join(dir, `${crawl}-${hostKey}.state.json`)

export function loadState(dir, crawl, hostKey) {
  try {
    const s = JSON.parse(
      fs.readFileSync(stateFileFor(dir, crawl, hostKey), "utf8"),
    )
    if (s?.crawl === crawl && s?.hostKey === hostKey) return s
  } catch {}
  return { crawl, hostKey, patterns: {}, counts: {} }
}

// Atomic tmp+rename after every page: a killed run loses at most the page in
// flight, never the file.
export function saveState(dir, state) {
  fs.mkdirSync(dir, { recursive: true })
  const file = stateFileFor(dir, state.crawl, state.hostKey)
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, JSON.stringify(state))
  fs.renameSync(tmp, file)
}

const cdxBase = (crawl, pattern) =>
  `${INDEX_HOST}/${crawl}-index?url=${encodeURIComponent(pattern)}&output=json`

// A CDX page is multi-megabyte bulk data from an index that sheds load when
// busy — measured 2026-08-13: page 0 served in seconds, page 1 blew the 15s
// default. Bulk pages get a bulk budget; lib.mjs's default stays tuned for
// ATS list probes.
const CDX_TIMEOUT_MS = 120_000

// Enumerate one host key: fetch pages not already in state, up to maxPages
// new pages this run, saving state after each. Returns {state, fetched,
// remaining}; remaining > 0 means run again to finish. An index error
// (429/5xx) propagates AFTER state is saved — resumable by design.
export async function enumerateHost({
  crawl,
  hostKey,
  stateDir,
  maxPages = Infinity,
}) {
  const state = loadState(stateDir, crawl, hostKey)
  let fetched = 0
  outer: for (const pattern of HOSTS[hostKey].patterns) {
    const pat = (state.patterns[pattern] ??= { pages: null, done: [] })
    if (pat.pages == null) {
      const info = await fetchJson(
        `${cdxBase(crawl, pattern)}&showNumPages=true`,
        null,
        { timeoutMs: CDX_TIMEOUT_MS },
      )
      pat.pages = Number(info?.pages ?? 0)
      saveState(stateDir, state)
    }
    for (let p = 0; p < pat.pages; p++) {
      if (pat.done.includes(p)) continue
      if (fetched >= maxPages) break outer
      const body = await fetchText(`${cdxBase(crawl, pattern)}&page=${p}`, {
        timeoutMs: CDX_TIMEOUT_MS,
      })
      foldPage(state.counts, body)
      pat.done.push(p)
      fetched++
      saveState(stateDir, state)
    }
  }
  // A pattern whose page count is still unknown reports as one remaining
  // page: nonzero is what "re-run to resume" keys off, not the exact figure.
  const remaining = HOSTS[hostKey].patterns.reduce((n, pattern) => {
    const pat = state.patterns[pattern]
    return n + (pat?.pages == null ? 1 : pat.pages - pat.done.length)
  }, 0)
  return { state, fetched, remaining }
}

function flag(args, name, fallback = null) {
  const i = args.indexOf(name)
  return i !== -1 && args[i + 1] !== undefined ? args[i + 1] : fallback
}

async function main() {
  const args = process.argv.slice(2)
  const crawl = flag(args, "--crawl")
  const hostsArg = flag(args, "--hosts")
  const asJson = args.includes("--json")
  const maxPages = Number(flag(args, "--max-pages", Infinity))
  const outFlag = flag(args, "--out")
  if (!crawl || !hostsArg) {
    console.error(
      "usage: cc-boards.mjs --crawl CC-MAIN-YYYY-WW --hosts ashby,greenhouse [--out <file>] [--max-pages N] [--json]",
    )
    process.exit(2)
  }
  const hostKeys = String(hostsArg)
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
  for (const k of hostKeys) {
    if (k === "lever") {
      console.error(
        "lever is excluded by rule: its robots.txt disallows crawling, so Common Crawl carries no lawful index of it. Use find-boards.mjs name probing over api.lever.co instead.",
      )
      process.exit(2)
    }
    if (!HOSTS[k]) {
      console.error(
        `unknown host key "${k}" — known: ${Object.keys(HOSTS).join(", ")}`,
      )
      process.exit(2)
    }
  }
  if (outFlag && hostKeys.length > 1) {
    console.error("--out names one file; use one --hosts key with it")
    process.exit(2)
  }

  const stateDir = path.join(ROOT, "jobs", ".cc")
  const known = new Set(
    loadSources().map(
      (b) => `${b.type}:${(b.slug ?? b.tenant ?? b.host ?? "").toLowerCase()}`,
    ),
  )

  const results = []
  for (const hostKey of hostKeys) {
    let r
    try {
      r = await enumerateHost({ crawl, hostKey, stateDir, maxPages })
    } catch (e) {
      // State was saved after every completed page, so a 429/5xx or a dead
      // network leaves the run resumable: report and stop rather than
      // hammering an index that just said no.
      console.error(
        `${hostKey}: stopped (${e.message}) — state saved, re-run to resume`,
      )
      process.exitCode = 1
      break
    }
    const doc = buildCandidates(hostKey, r.state.counts, known)
    const out =
      outFlag ??
      path.join(ROOT, "docs", "candidates", `cc-${crawl}-${hostKey}.yaml`)
    fs.mkdirSync(path.dirname(out), { recursive: true })
    fs.writeFileSync(
      out,
      "# Board candidates enumerated from the Common Crawl URL index by\n" +
        "# src/leads/cc-boards.mjs. NOT swept, NOT vetted — run\n" +
        "# discover-boards.mjs to yield-gate a batch, then add survivors with\n" +
        "# manage-sources. Nothing here touches job-sources.yaml.\n" +
        `# crawl: ${crawl}; seen = captures of the board in that crawl.\n` +
        yaml.dump(doc),
    )
    results.push({
      hostKey,
      out,
      fetched: r.fetched,
      remaining: r.remaining,
      candidates: doc.candidates.length,
      tracked_skipped:
        Object.keys(r.state.counts).length - doc.candidates.length,
    })
  }

  if (asJson) return console.log(JSON.stringify({ crawl, results }, null, 2))
  if (isTerse()) {
    for (const r of results)
      console.log(
        `cc|${r.hostKey}|candidates=${r.candidates}|already_tracked=${r.tracked_skipped}|pages_fetched=${r.fetched}|pages_remaining=${r.remaining}|out=${r.out}`,
      )
    return
  }
  for (const r of results) {
    console.log(
      `\n${r.hostKey}: ${r.candidates} candidate board(s) from ${crawl}` +
        (r.tracked_skipped ? ` (${r.tracked_skipped} already tracked)` : "") +
        (r.remaining
          ? `\n  INCOMPLETE: ${r.remaining} page(s) left — re-run to resume.`
          : "") +
        `\n  written to ${r.out}` +
        `\n  Next: node src/leads/discover-boards.mjs --candidates ${r.out}`,
    )
  }
  console.log("")
}

const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (isMain)
  main().catch((e) => {
    console.error(e.message)
    process.exit(1)
  })
