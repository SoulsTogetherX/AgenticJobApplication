#!/usr/bin/env node
// Retention for jobs/<slug>/ workspaces. Deterministic, no LLM.
//
// The question this answers: "am I meant to delete these when I no longer
// need them?" No — but not all of it is worth keeping either.
//
//   KEEP FOREVER   resume.md, cover-letter.md, job.json, context.json
//                  (~40 KB per job). This is the audit trail of what was
//                  actually claimed on each application. If an employer asks
//                  about a bullet in an interview, this is the record — and
//                  it is the only part that cannot be regenerated.
//
//   ALWAYS DROP    *.render.html — an intermediate render-pdf.mjs leaves
//                  behind. Pure waste, regenerated on every render.
//
//   DROP WHEN OLD  *.pdf (~124 KB per job). render-pdf.mjs is deterministic,
//                  so these rebuild from the markdown in ~2 s. Only dropped
//                  once the application has an outcome AND is older than the
//                  age cutoff, so nothing in flight is touched.
//
// Dry run by default: it prints what it would remove and removes nothing
// unless --apply is passed.
//
// Usage: node scripts/prune-jobs.mjs [--older-than 90] [--apply]
//        [--jobs-dir <path>] [--applications <path>] [--json]
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { isTerse } from "./lib.mjs"
import { readApplications } from "./db.mjs"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

// Outcomes that mean the application is finished. "applied" is deliberately
// NOT here: a submitted application with no reply yet may still need its PDF.
const CLOSED = new Set(["rejected", "closed", "withdrawn", "no_response"])

function flag(args, name, fallback = null) {
  const i = args.indexOf(name)
  return i !== -1 && args[i + 1] !== undefined ? args[i + 1] : fallback
}

const KEEP = /\.(md|json)$/i
const ALWAYS_DROP = /\.render\.html$/i
const AGED_DROP = /\.pdf$/i

// Pure core (exported for tests).
export function planPrune(
  workspaces,
  { olderThanDays = 90, now = new Date() } = {},
) {
  const plan = []
  for (const ws of workspaces) {
    const ageDays =
      ws.applied_at != null
        ? Math.floor(
            (now.getTime() - new Date(ws.applied_at).getTime()) / 86400000,
          )
        : null
    const closed = ws.status ? CLOSED.has(ws.status) : false
    const aged = ageDays != null && ageDays >= olderThanDays

    for (const file of ws.files) {
      if (ALWAYS_DROP.test(file)) {
        plan.push({ slug: ws.slug, file, reason: "regenerable intermediate" })
      } else if (AGED_DROP.test(file) && closed && aged) {
        plan.push({
          slug: ws.slug,
          file,
          reason: `outcome "${ws.status}", ${ageDays}d old — rebuild with render-pdf.mjs`,
        })
      }
      // KEEP files are never listed: the audit trail is not negotiable.
      void KEEP
    }
  }
  return plan
}

export function readWorkspaces(jobsDir, applications = []) {
  if (!fs.existsSync(jobsDir)) return []
  const bySlug = new Map(applications.map((a) => [a.slug, a]))
  const out = []
  for (const slug of fs.readdirSync(jobsDir)) {
    const dir = path.join(jobsDir, slug)
    let st
    try {
      st = fs.statSync(dir)
    } catch {
      continue
    }
    if (!st.isDirectory()) continue
    const app = bySlug.get(slug)
    out.push({
      slug,
      files: fs.readdirSync(dir).filter((f) => {
        try {
          return fs.statSync(path.join(dir, f)).isFile()
        } catch {
          return false
        }
      }),
      status: app?.status ?? null,
      applied_at: app?.applied_at ?? null,
    })
  }
  return out
}

function main() {
  const args = process.argv.slice(2)
  const jobsDir = flag(args, "--jobs-dir") || path.join(ROOT, "jobs")
  const appsPath =
    flag(args, "--applications") ||
    path.join(ROOT, "profile", "applications.yaml")
  const olderThanDays = Number(flag(args, "--older-than", 90))
  const apply = args.includes("--apply")

  const applications = readApplications(
    appsPath.endsWith("applications.yaml") ? null : appsPath,
  )

  const workspaces = readWorkspaces(jobsDir, applications)
  const plan = planPrune(workspaces, { olderThanDays })

  let bytes = 0
  for (const p of plan) {
    try {
      bytes += fs.statSync(path.join(jobsDir, p.slug, p.file)).size
    } catch {}
  }

  if (args.includes("--json")) {
    console.log(JSON.stringify({ apply, bytes, plan }, null, 2))
    if (apply) removeAll(jobsDir, plan)
    return
  }

  if (!plan.length) {
    console.log(
      isTerse()
        ? "prune=0 bytes=0"
        : "Nothing to prune — no regenerable files found.",
    )
    return
  }

  if (isTerse()) {
    for (const p of plan) console.log(`${p.slug}/${p.file}|${p.reason}`)
    console.log(
      `prune=${plan.length} bytes=${bytes} applied=${apply ? "yes" : "no"}`,
    )
  } else {
    console.log(
      `\n${apply ? "Removing" : "Would remove"} ${plan.length} file(s), ${(bytes / 1024).toFixed(0)} KB:\n`,
    )
    for (const p of plan) console.log(`  ${p.slug}/${p.file}\n    ${p.reason}`)
    if (!apply) {
      console.log(
        `\nDry run — nothing was deleted. Re-run with --apply to remove them.`,
      )
      console.log(
        `Resumes, cover letters, job.json and context.json are never pruned.\n`,
      )
    }
  }
  if (apply) removeAll(jobsDir, plan)
}

function removeAll(jobsDir, plan) {
  let removed = 0
  for (const p of plan) {
    try {
      fs.rmSync(path.join(jobsDir, p.slug, p.file), { force: true })
      removed++
    } catch (e) {
      console.error(`warn: could not remove ${p.slug}/${p.file}: ${e.message}`)
    }
  }
  console.log(`removed=${removed}`)
}

const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (isMain) main()
