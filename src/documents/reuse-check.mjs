#!/usr/bin/env node
// Is this posting close enough to one already tailored for that the existing
// resume can be reused instead of tailoring from scratch?
//
// Deterministic similarity only — it recommends, it never reuses anything by
// itself, and the user always approves a reuse.
//
// Usage: node src/documents/reuse-check.mjs <slug> [--dir jobs] [--top 3]
//        [--threshold 0.75] [--json] [--cache auto|on|off] [--db <path>]
//
// Score = 0.5 * title similarity + 0.5 * tech-stack overlap, against every
// other job workspace that already has a resume.md.
// Exit codes: 0 = ran fine, 2 = usage error.
//
// SHAPE AND CACHE (Phase 3 item 3.4). This was a top-level script; the scoring
// is now exported pure functions with a thin CLI, and each workspace's derived
// stack is cached in `workspace_stacks`, keyed by the sha256 of its job.json.
//
// THE CACHE IS OFF BY DEFAULT AT SMALL TREE SIZES, AND THAT IS A MEASUREMENT,
// NOT A HEDGE. Measured on win32/node24, 4000-char descriptions, cached and
// uncached back to back in one process:
//
//   ranking loop only     N=60  108.5 -> 56.2 ms   (-48%)
//                         N=200 328.1 -> 145.6 ms  (-56%)
//                         N=400 778.2 -> 266.4 ms  (-66%)
//
// but the cache is not free at the process level: loading db.mjs costs ~18 ms
// (node:sqlite), opening the store ~4 ms, node:crypto ~6 ms. End to end that
// wipes out the whole saving on a small tree — at N=60 the cached and uncached
// CLI runs were indistinguishable (274.0 vs 273.7 ms median, 9 interleaved
// samples), and at N=200 the cached run was 26-31% faster.
//
// So `auto` engages only past CACHE_MIN_WORKSPACES. `jobs/` held 8 workspaces
// when this was written, so today it engages nothing and reuse-check is exactly
// as fast as it was. It starts paying when the unattended pipeline makes the
// tree big enough, which is the point of Phase 3.
//
// `--cache on` forces it (the tests need the cached path to be reachable at any
// size), `--cache off` forbids it.
import fs from "node:fs"
import { positionals } from "../lib/args.mjs"

// Flags that take a VALUE, so one is never read as the slug.
const REUSE_VALUE_FLAGS = ["--cache", "--db", "--dir", "--threshold", "--top"]
import path from "node:path"
import { pathToFileURL } from "node:url"
import { techTermsIn, isTerse, titleTokens, jaccard } from "../lib/lib.mjs"

// Where the win is unambiguous, not where the two costs cross. They cross
// somewhere around 60; at 60 the end-to-end runs were a dead heat, and a knob
// set at a dead heat is a coin flip dressed as a threshold.
export const CACHE_MIN_WORKSPACES = 120

export const stackOf = (job) =>
  new Set(
    techTermsIn(
      [job.description ?? "", ...(job.requirements ?? [])].join(" \n "),
    ),
  )

const readJobText = (file) => {
  try {
    return fs.readFileSync(file, "utf8")
  } catch {
    return null
  }
}

const parseJob = (text) => {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

// node:crypto is imported ONLY on the cache path, and that is measured, not
// stylistic: importing it costs ~6 ms, which is 4% of a whole reuse-check run
// and pure waste when there is no cache to key. `hash` is therefore injected —
// no cache, no hashing, no crypto module.
export function makeSha256(createHash) {
  return (s) => createHash("sha256").update(String(s)).digest("hex")
}

/**
 * The derived facts one candidate workspace contributes to a ranking.
 * Pure given the job.json text: the same bytes always give the same shape,
 * which is exactly what makes them cacheable under their own sha256.
 */
export function deriveWorkspace(slug, jobText, hash = null) {
  const job = parseJob(jobText)
  if (!job) return null
  return {
    slug,
    job_sha256: hash ? hash(jobText) : null,
    title: job.title ?? "?",
    company: job.company ?? "?",
    stack: stackOf(job),
    title_toks: titleTokens(job.title),
  }
}

/**
 * The eligible siblings: a directory with BOTH a job.json and a resume.md.
 * One readdir, returned to the caller, because the CLI needs the count to
 * decide whether the cache is worth loading and doing that with a second
 * readdir gave back part of what the cache saves.
 */
export function listWorkspaces(dir, slug) {
  const out = []
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === slug) continue
    const jobFile = path.join(dir, entry.name, "job.json")
    const resumeFile = path.join(dir, entry.name, "resume.md")
    if (!fs.existsSync(jobFile) || !fs.existsSync(resumeFile)) continue
    out.push({ slug: entry.name, jobFile, resumeFile })
  }
  return out
}

/** 0.5 title + 0.5 stack. Same split cluster.mjs uses, for the same reason. */
export function scorePair(self, other) {
  const titleScore = jaccard(self.title_toks, other.title_toks)
  const stackScore = jaccard(self.stack, other.stack)
  return {
    score: Number((0.5 * titleScore + 0.5 * stackScore).toFixed(2)),
    title_score: Number(titleScore.toFixed(2)),
    stack_score: Number(stackScore.toFixed(2)),
  }
}

/**
 * Rank every already-tailored sibling against `self`.
 *
 * `cache` is an optional `Map<slug, {job_sha256, ...}>` from
 * db.mjs's readWorkspaceStacks. A hit is used ONLY when its job_sha256 matches
 * the bytes on disk; every miss is recomputed and reported through
 * `onComputed`, so the caller can write the new rows back in one transaction.
 * No cache is a correctness difference of zero — it is only ever slower.
 */
export function rankCandidates({
  workspaces,
  self,
  cache = null,
  hash = null,
  onComputed,
}) {
  const ranked = []
  let hits = 0
  let misses = 0
  for (const ws of workspaces) {
    const text = readJobText(ws.jobFile)
    if (text === null) continue
    let w = cache?.get(ws.slug)
    // The sha is computed only when there is a row that might match it.
    if (w && hash && w.job_sha256 === hash(text)) {
      hits++
      w = { ...w, slug: ws.slug }
    } else {
      misses++
      w = deriveWorkspace(ws.slug, text, hash)
      if (!w) continue
      onComputed?.(w)
    }
    ranked.push({
      slug: ws.slug,
      company: w.company ?? "?",
      title: w.title ?? "?",
      ...scorePair(self, w),
      resume: ws.resumeFile,
    })
  }
  ranked.sort((a, b) => b.score - a.score)
  return { ranked, hits, misses }
}

/**
 * The whole decision: which sibling (if any) is close enough to reuse.
 * Pure apart from reading the workspace tree.
 */
export function reuseCheck({
  dir,
  slug,
  top = 3,
  threshold = 0.75,
  cache = null,
  hash = null,
  workspaces = null,
  onComputed,
}) {
  const selfFile = path.join(dir, slug, "job.json")
  const text = readJobText(selfFile)
  if (text === null) return { error: `No job workspace at ${selfFile}` }
  const self = deriveWorkspace(slug, text, hash)
  if (!self) return { error: `${selfFile} is not valid JSON` }

  const {
    ranked: all,
    hits,
    misses,
  } = rankCandidates({
    workspaces: workspaces ?? listWorkspaces(dir, slug),
    self,
    cache,
    hash,
    onComputed,
  })
  const ranked = all.slice(0, Math.max(1, top))
  const best = ranked[0]
  return {
    slug,
    verdict: best && best.score >= threshold ? "REUSE" : "TAILOR",
    threshold,
    ranked,
    self,
    cache_hits: hits,
    cache_misses: misses,
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main(argv = process.argv.slice(2)) {
  const args = [...argv]
  function flag(name, dflt) {
    const i = args.indexOf(name)
    if (i !== -1) {
      const v = args[i + 1]
      args.splice(i, 2)
      return v
    }
    return dflt
  }
  const dir = flag("--dir", "jobs")
  const top = Number(flag("--top", "3"))
  const threshold = Number(flag("--threshold", "0.75"))
  const cacheMode = flag("--cache", "auto")
  const dbFlag = flag("--db", null)
  const asJson = args.includes("--json")
  const slug = positionals(args, REUSE_VALUE_FLAGS)[0]

  if (!slug) {
    console.error(
      "Usage: reuse-check.mjs <slug> [--dir jobs] [--top 3] [--json] [--cache auto|on|off]",
    )
    process.exit(2)
  }
  if (!fs.existsSync(path.join(dir, slug, "job.json"))) {
    console.error(`No job workspace at ${path.join(dir, slug, "job.json")}`)
    process.exit(2)
  }
  if (!["auto", "on", "off"].includes(cacheMode)) {
    console.error(`--cache must be auto, on or off (got ${cacheMode})`)
    process.exit(2)
  }

  // ONE readdir, reused: it is what the ranking walks AND what the cache
  // decision is made from. Counting the siblings with a second readdir gave
  // back a measurable slice of what the cache saves.
  const workspaces = listWorkspaces(dir, slug)
  const useCache =
    cacheMode === "on" ||
    (cacheMode === "auto" && workspaces.length >= CACHE_MIN_WORKSPACES)

  return useCache
    ? withCache({ dir, slug, top, threshold, dbFlag, asJson, workspaces })
    : report(reuseCheck({ dir, slug, top, threshold, workspaces }), {
        asJson,
        cache: "off",
      })
}

async function withCache({
  dir,
  slug,
  top,
  threshold,
  dbFlag,
  asJson,
  workspaces,
}) {
  let db = null
  let cache = null
  let hash = null
  const computed = []
  try {
    const [{ openDb, readWorkspaceStacks }, { createHash }] = await Promise.all(
      [import("../lib/db.mjs"), import("node:crypto")],
    )
    hash = makeSha256(createHash)
    db = openDb(dbFlag ?? undefined)
    cache = readWorkspaceStacks(db)
  } catch (e) {
    // A cache is an optimisation. An unreachable store must never stop a
    // ranking from being produced — it only makes it as slow as it used to be.
    console.error(`stack cache unavailable (${e?.message ?? e}) — recomputing`)
  }
  const result = reuseCheck({
    dir,
    slug,
    top,
    threshold,
    cache,
    hash,
    workspaces,
    onComputed: (w) => computed.push(w),
  })
  if (db) {
    try {
      const { upsertWorkspaceStack } = await import("../lib/db.mjs")
      for (const w of computed) upsertWorkspaceStack(db, w)
      if (result.self) upsertWorkspaceStack(db, result.self)
    } catch (e) {
      console.error(`stack cache not written (${e?.message ?? e})`)
    } finally {
      db.close()
    }
  }
  return report(result, { asJson, cache: db ? "on" : "unavailable" })
}

function report(result, { asJson, cache }) {
  if (result.error) {
    console.error(result.error)
    process.exit(2)
  }
  const { slug, verdict, threshold, ranked } = result
  const best = ranked[0]

  if (asJson) {
    console.log(
      JSON.stringify(
        {
          slug,
          verdict,
          threshold,
          ranked,
          cache,
          cache_hits: result.cache_hits,
          cache_misses: result.cache_misses,
        },
        null,
        2,
      ),
    )
  } else if (isTerse()) {
    for (const c of ranked) {
      console.log(
        [
          c.slug,
          c.score,
          `t=${c.title_score}`,
          `s=${c.stack_score}`,
          c.company,
          c.title,
        ].join("\t"),
      )
    }
    console.log(
      `# verdict=${verdict}` +
        (best
          ? ` best=${best.slug} score=${best.score}`
          : " (no tailored jobs yet)"),
    )
  } else if (!best) {
    console.log("No previously tailored job workspaces to compare against.")
  } else {
    for (const c of ranked) {
      console.log(
        `${c.score}  ${c.slug} — ${c.company}, ${c.title} (title ${c.title_score}, stack ${c.stack_score})`,
      )
    }
    console.log(
      verdict === "REUSE"
        ? `\nClose enough to reuse ${best.slug}'s resume — ask the user before doing so.`
        : `\nNothing close enough (threshold ${threshold}) — tailor from scratch.`,
    )
  }
  return 0
}

const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (isMain) await main()
