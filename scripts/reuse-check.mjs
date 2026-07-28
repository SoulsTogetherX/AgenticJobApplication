#!/usr/bin/env node
// Is this posting close enough to one already tailored for that the existing
// resume can be reused instead of tailoring from scratch?
//
// Deterministic similarity only — it recommends, it never reuses anything by
// itself, and the user always approves a reuse.
//
// Usage: node scripts/reuse-check.mjs <slug> [--dir jobs] [--top 3]
//        [--threshold 0.75] [--json]
//
// Score = 0.5 * title similarity + 0.5 * tech-stack overlap, against every
// other job workspace that already has a resume.md.
// Exit codes: 0 = ran fine, 2 = usage error.
import fs from "node:fs"
import path from "node:path"
import { techTermsIn, isTerse } from "./lib.mjs"

const args = process.argv.slice(2)
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
const asJson = args.includes("--json")
const slug = args.find((a) => !a.startsWith("--"))

if (!slug) {
  console.error("Usage: reuse-check.mjs <slug> [--dir jobs] [--top 3] [--json]")
  process.exit(2)
}
const selfFile = path.join(dir, slug, "job.json")
if (!fs.existsSync(selfFile)) {
  console.error(`No job workspace at ${selfFile}`)
  process.exit(2)
}

const readJob = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"))
  } catch {
    return null
  }
}

const STOP = new Set(
  "a an the of and or for to in at with senior sr junior jr staff lead principal i ii iii remote contract fulltime full time parttime part".split(
    " ",
  ),
)
const titleTokens = (s) =>
  new Set(
    String(s ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9+#\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t && !STOP.has(t)),
  )

function jaccard(a, b) {
  if (!a.size || !b.size) return 0
  let inter = 0
  for (const t of a) if (b.has(t)) inter++
  return inter / (a.size + b.size - inter)
}

const stackOf = (job) =>
  new Set(
    techTermsIn(
      [job.description ?? "", ...(job.requirements ?? [])].join(" \n "),
    ),
  )

const self = readJob(selfFile)
if (!self) {
  console.error(`${selfFile} is not valid JSON`)
  process.exit(2)
}
const selfTitle = titleTokens(self.title)
const selfStack = stackOf(self)

const candidates = []
for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
  if (!entry.isDirectory() || entry.name === slug) continue
  const jobFile = path.join(dir, entry.name, "job.json")
  const resumeFile = path.join(dir, entry.name, "resume.md")
  if (!fs.existsSync(jobFile) || !fs.existsSync(resumeFile)) continue
  const job = readJob(jobFile)
  if (!job) continue
  const titleScore = jaccard(selfTitle, titleTokens(job.title))
  const stackScore = jaccard(selfStack, stackOf(job))
  candidates.push({
    slug: entry.name,
    company: job.company ?? "?",
    title: job.title ?? "?",
    score: Number((0.5 * titleScore + 0.5 * stackScore).toFixed(2)),
    title_score: Number(titleScore.toFixed(2)),
    stack_score: Number(stackScore.toFixed(2)),
    resume: resumeFile,
  })
}
candidates.sort((a, b) => b.score - a.score)

const ranked = candidates.slice(0, Math.max(1, top))
const best = ranked[0]
const verdict = best && best.score >= threshold ? "REUSE" : "TAILOR"

if (asJson) {
  console.log(JSON.stringify({ slug, verdict, threshold, ranked }, null, 2))
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
