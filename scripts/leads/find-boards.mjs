#!/usr/bin/env node
// Given company NAMES, find their public job boards.
//
// This is the missing front half of board discovery. discover-boards.mjs already
// decides whether a candidate board is worth sweeping — it fetches the board and
// applies the same yield bar the audit applies to existing ones — but it needs
// a {type, slug} to start from, and getting those by hand is why the board list
// sat at 41 entries.
//
// Method: the six big ATSs all publish a no-auth JSON board endpoint keyed on a
// company slug, and the slug is almost always a predictable squashing of the
// company name. So: generate candidate slugs, ask each ATS, keep what answers.
//
// WHAT THIS DOES NOT DO, measured rather than assumed. Probing 16 companies
// found Vercel, Figma and Notion in 4.2 seconds and found NOTHING for Konami
// Gaming, Everi, Zappos, Switch, Scientific Games, PlayAGS, Sightline Payments,
// Southwest Gas or NV Energy. Those are Las Vegas employers on Workday, iCIMS,
// Taleo and Phenom, whose board URLs contain an opaque tenant host that cannot
// be guessed from a name. Slug probing reaches startups and tech companies; the
// local market needs per-company research or an aggregator. Saying so in the
// output matters, because "no board found" reads as "not hiring" otherwise.
//
// Output is a candidates file for discover-boards.mjs. It never edits
// docs/job-sources.yaml — adding a board stays the user's call via
// manage-sources (CLAUDE.md rule 10 territory: the sweep list is user policy).
//
// Usage:
//   node scripts/leads/find-boards.mjs --names "Acme,Globex" [--out docs/board-candidates.yaml]
//   node scripts/leads/find-boards.mjs --file docs/candidates/fortune500.yaml [--limit 100]
//   [--concurrency 6] [--json] [--append]
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import yaml from "js-yaml"
import { isTerse, mapPool, UA } from "../lib/lib.mjs"
import { loadSources } from "./find-jobs.mjs"

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
)

// One probe per ATS: a URL builder and a "did this board answer with jobs?"
// reader. Every one of these is public and unauthenticated.
export const PROBES = [
  {
    type: "greenhouse",
    url: (s) => `https://boards-api.greenhouse.io/v1/boards/${s}/jobs`,
    count: (j) => j?.jobs?.length ?? 0,
  },
  {
    type: "lever",
    url: (s) => `https://api.lever.co/v0/postings/${s}?mode=json`,
    count: (j) => (Array.isArray(j) ? j.length : 0),
  },
  {
    type: "ashby",
    url: (s) => `https://api.ashbyhq.com/posting-api/job-board/${s}`,
    count: (j) => j?.jobs?.length ?? 0,
  },
  {
    type: "smartrecruiters",
    url: (s) =>
      `https://api.smartrecruiters.com/v1/companies/${s}/postings?limit=1`,
    count: (j) => j?.totalFound ?? 0,
  },
  {
    type: "workable",
    url: (s) => `https://apply.workable.com/api/v1/widget/accounts/${s}`,
    count: (j) => j?.jobs?.length ?? 0,
  },
  {
    type: "recruitee",
    url: (s) => `https://${s}.recruitee.com/api/offers/`,
    count: (j) => j?.offers?.length ?? 0,
  },
]

// Candidate slugs for a company name, most likely first.
//
// Suffixes are stripped because no ATS slug contains them: "Fanatics Betting &
// Gaming, Inc." is "fanaticsfbg" or "fanatics", never "fanaticsbettinggaminginc".
export function slugsFor(name) {
  const cleaned = String(name ?? "")
    .toLowerCase()
    .replace(
      /\b(inc|llc|ltd|corp|corporation|company|co|holdings|group|the|plc|sa|nv|gmbh)\b/g,
      " ",
    )
    .replace(/[&+]/g, " ")
    .trim()
  const words = cleaned.split(/\s+/).filter(Boolean)
  if (!words.length) return []
  return [
    ...new Set([
      words.join(""), // acmewidgets
      words.join("-"), // acme-widgets
      words[0], // acme
      words.map((w) => w[0]).join(""), // aw  (initialisms like ibm, ags)
    ]),
  ].filter((s) => s.length >= 2)
}

async function probeOne(slug, probe, timeoutMs) {
  const ctl = AbortSignal.timeout(timeoutMs)
  try {
    const r = await fetch(probe.url(slug), {
      headers: { "user-agent": UA, accept: "application/json" },
      signal: ctl,
    })
    if (!r.ok) return null
    const n = probe.count(await r.json())
    return n > 0 ? { type: probe.type, slug, live: n } : null
  } catch {
    return null
  }
}

// Find the board for one company. Stops at the first hit: a company has one
// real board, and continuing costs round trips for nothing.
export async function findBoard(name, { timeoutMs = 8000 } = {}) {
  for (const slug of slugsFor(name)) {
    for (const probe of PROBES) {
      const hit = await probeOne(slug, probe, timeoutMs)
      if (hit) return { company: name, ...hit }
    }
  }
  return { company: name, type: null, slug: null, live: 0 }
}

function flag(args, name, fallback = null) {
  const i = args.indexOf(name)
  return i !== -1 && args[i + 1] !== undefined ? args[i + 1] : fallback
}

function loadNames(args) {
  const inline = flag(args, "--names")
  if (inline) {
    return String(inline)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  }
  const file = flag(args, "--file")
  if (!file) return null
  const raw = fs.readFileSync(file, "utf8")
  const doc = file.endsWith(".json") ? JSON.parse(raw) : yaml.load(raw)
  const list = Array.isArray(doc) ? doc : (doc?.companies ?? doc?.names ?? [])
  return list
    .map((x) => (typeof x === "string" ? x : (x?.company ?? x?.name)))
    .filter(Boolean)
}

async function main() {
  const args = process.argv.slice(2)
  const names = loadNames(args)
  if (!names?.length) {
    console.error(
      'usage: find-boards.mjs --names "Acme,Globex" | --file <companies.yaml> [--out <f>] [--append]',
    )
    process.exit(2)
  }
  const limit = Number(flag(args, "--limit", names.length))
  const concurrency = Number(flag(args, "--concurrency", 6))
  const outPath =
    flag(args, "--out") || path.join(ROOT, "docs", "board-candidates.yaml")
  const asJson = args.includes("--json")

  // Never re-probe a board already being swept.
  const known = new Set(
    loadSources().map(
      (b) => `${b.type}:${(b.slug ?? b.tenant ?? b.host ?? "").toLowerCase()}`,
    ),
  )

  const t0 = Date.now()
  const rows = await mapPool(names.slice(0, limit), concurrency, (n) =>
    findBoard(n),
  )
  const ms = Date.now() - t0

  const found = rows.filter((r) => r.type)
  const fresh = found.filter(
    (r) => !known.has(`${r.type}:${r.slug.toLowerCase()}`),
  )
  const dupes = found.length - fresh.length
  const missing = rows.filter((r) => !r.type)

  if (asJson) {
    return console.log(
      JSON.stringify(
        { ms, probed: rows.length, found: fresh, dupes, missing },
        null,
        2,
      ),
    )
  }

  // The candidates file discover-boards.mjs reads.
  if (fresh.length) {
    let existing = []
    if (args.includes("--append") && fs.existsSync(outPath)) {
      try {
        existing = yaml.load(fs.readFileSync(outPath, "utf8"))?.candidates ?? []
      } catch {}
    }
    const seen = new Set(existing.map((c) => `${c.type}:${c.slug}`))
    const merged = [
      ...existing,
      ...fresh
        .filter((r) => !seen.has(`${r.type}:${r.slug}`))
        .map((r) => ({
          type: r.type,
          slug: r.slug,
          company: r.company,
          pool: "levelled",
        })),
    ]
    fs.mkdirSync(path.dirname(outPath), { recursive: true })
    fs.writeFileSync(
      outPath,
      "# Board candidates discovered by scripts/leads/find-boards.mjs.\n" +
        "# NOT swept yet — run discover-boards.mjs to yield-gate these, then add\n" +
        "# the survivors with manage-sources. Nothing here touches job-sources.yaml.\n" +
        yaml.dump({ candidates: merged }),
    )
  }

  if (isTerse()) {
    for (const r of fresh)
      console.log(`found|${r.type}|${r.slug}|${r.company}|live=${r.live}`)
    console.log(
      `probed=${rows.length} found=${fresh.length} already_tracked=${dupes} no_public_board=${missing.length} ms=${ms} out=${outPath}`,
    )
    return
  }

  console.log(
    `\nProbed ${rows.length} compan(ies) in ${(ms / 1000).toFixed(1)}s.\n`,
  )
  if (fresh.length) {
    console.log(`FOUND — ${fresh.length} board(s), written to ${outPath}:`)
    for (const r of fresh) {
      console.log(
        `  ${r.company}: ${r.type}:${r.slug} (${r.live} live postings)`,
      )
    }
    console.log(`\nNext, yield-gate them before adding any:`)
    console.log(
      `  node scripts/leads/discover-boards.mjs --candidates ${outPath}\n`,
    )
  } else {
    console.log("No new boards found.\n")
  }
  if (dupes) console.log(`${dupes} were already in the sweep list.\n`)
  if (missing.length) {
    console.log(
      `No public board for ${missing.length} compan(ies). That does NOT mean they\n` +
        `are not hiring — Workday, iCIMS, Taleo and Phenom boards live behind an\n` +
        `opaque tenant host that cannot be guessed from a company name, and that is\n` +
        `what most large and most local employers use:`,
    )
    console.log(`  ${missing.map((r) => r.company).join(", ")}\n`)
  }
}

const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (isMain)
  main().catch((e) => {
    console.error(e.message)
    process.exit(1)
  })
