#!/usr/bin/env node
// Retention for jobs/<slug>/ workspaces. Deterministic, no LLM.
//
// This used to also drop PDFs once an application was closed and old.
// scripts/maintenance/archive.mjs supersedes that: a closed application's whole
// workspace is folded into the `documents` table, and PDFs are deterministic
// output of render-pdf.mjs, so the markdown is archived and a PDF is rebuilt
// only if one is ever needed again. Two rules competing to delete the same
// files, on different triggers, is how a workspace loses a PDF that its
// archive row then records as regenerable-but-never-stored.
//
// So what is left here is the one thing that is pure waste at every moment of
// a workspace's life:
//
//   ALWAYS DROP    *.render.html — an intermediate render-pdf.mjs leaves
//                  behind. Regenerated on every render, useful to nobody.
//
//   EVERYTHING ELSE stays until the workspace is archived. resume.md,
//                  cover-letter.md, job.json and context.json are the record
//                  of what was actually claimed on an application; if an
//                  employer asks about a bullet in an interview, this is it.
//
// Dry run by default: it prints what it would remove and removes nothing
// unless --apply is passed.
//
// Usage: node scripts/maintenance/prune-jobs.mjs [--apply] [--jobs-dir <path>] [--json]
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { isTerse } from "../lib/lib.mjs"

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
)

function flag(args, name, fallback = null) {
  const i = args.indexOf(name)
  return i !== -1 && args[i + 1] !== undefined ? args[i + 1] : fallback
}

const ALWAYS_DROP = /\.render\.html$/i

// Pure core (exported for tests).
export function planPrune(workspaces) {
  const plan = []
  for (const ws of workspaces) {
    for (const file of ws.files) {
      if (ALWAYS_DROP.test(file)) {
        plan.push({ slug: ws.slug, file, reason: "regenerable intermediate" })
      }
    }
  }
  return plan
}

export function readWorkspaces(jobsDir) {
  if (!fs.existsSync(jobsDir)) return []
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
    out.push({
      slug,
      files: fs.readdirSync(dir).filter((f) => {
        try {
          return fs.statSync(path.join(dir, f)).isFile()
        } catch {
          return false
        }
      }),
    })
  }
  return out
}

function main() {
  const args = process.argv.slice(2)
  const jobsDir = flag(args, "--jobs-dir") || path.join(ROOT, "jobs")
  const apply = args.includes("--apply")

  const plan = planPrune(readWorkspaces(jobsDir))

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
        : "Nothing to prune — no regenerable intermediates found.",
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
        `Documents are never pruned; closed applications go to archive.mjs.\n`,
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
