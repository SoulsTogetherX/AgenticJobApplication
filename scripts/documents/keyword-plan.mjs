#!/usr/bin/env node
// Build the keyword plan for one job, BEFORE the resume is tailored.
//
// Two gatekeepers read a resume now. The classic ATS parser does literal
// keyword matching, and an LLM layer on top of it summarises and ranks whatever
// survives. They reward different things, and this file is about giving the
// tailoring step a concrete, truthful target for both:
//
//   literal layer   the exact terms from the posting, in the sections that
//                   carry the most weight, in both acronym and expanded form
//                   (some systems index one and not the other)
//   LLM layer       those terms used in real sentences about real work, which
//                   is what the tailoring rules already produce
//
// The one thing this must never do is widen what the resume may claim.
// `must_use` is the INTERSECTION of the posting and the fact base — every term
// in it is already true of the user, so placing it invents nothing.
// `blocked` is the posting's other terms, listed precisely so they stay out;
// verify-claims R6 enforces that independently, and this explains it.
//
// Usage: node scripts/documents/keyword-plan.mjs <slug> [--json] [--jobs-dir <d>]
//        [--profile <p>] [--answers <a>]
// Writes jobs/<slug>/keywords.json. Prints must_use/blocked counts.
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { loadYamlFile, isTerse, evidenceText } from "../lib/lib.mjs"
import { extractTech, atsFormsFor, SKILL_BY_NAME } from "../lib/keywords.mjs"
import { splitRequirements } from "../leads/fit.mjs"
import { profileText } from "../profile/profile-gaps.mjs"

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
)

function flag(args, name, fallback = null) {
  const i = args.indexOf(name)
  return i !== -1 && args[i + 1] !== undefined ? args[i + 1] : fallback
}

// Where a term earns the most. Research is consistent that the summary is the
// highest-weighted region and that a dedicated skills block gives the parser
// one concentrated keyword area, while bullets supply the context the LLM layer
// actually reads.
//
// SUMMARY is reserved for the handful of terms the posting REQUIRES and the
// profile can back — stuffing every match into it is what tips a modern parser
// into "keyword stuffing" territory.
export const SUMMARY_SLOTS = 5

export function placementFor(skill, { required, index }) {
  if (required && index < SUMMARY_SLOTS) return "SUMMARY+SKILLS"
  return "SKILLS"
}

// Repeats per term across the whole document. Keyword stuffing is actively
// detected and penalised now, and a one-page resume has no room for it anyway.
export const DENSITY_CAP = 3

// The posting's own title, plus the closest phrasing the fact base can support.
//
// Title mirroring is the single highest-leverage thing on a resume — a resume
// carrying the posting's title measurably outperforms one that does not — but
// it is only allowed when the profile actually supports the claim. The user
// targets Full-Stack and Back-End roles (docs/application-limits.yaml), so a
// posting titled "Full Stack Engineer" may be mirrored; one titled "Machine
// Learning Engineer" may not, and this says so rather than inventing a match.
export function titleMirror(jobTitle, profileTargets) {
  const t = String(jobTitle ?? "").trim()
  const norm = t.toLowerCase()
  const supported = (profileTargets ?? []).find((target) =>
    norm.includes(String(target).toLowerCase()),
  )
  return {
    posting_title: t,
    // Strip seniority and level noise: the user is not claiming to be a Staff
    // engineer by mirroring a title, only to be doing that KIND of work.
    mirror: supported
      ? t
          .replace(/\b(senior|sr\.?|staff|principal|lead|ii+|iv|\d)\b/gi, "")
          .replace(/\s{2,}/g, " ")
          .replace(/[\s,(-]+$/, "")
          .trim()
      : null,
    supported_by: supported ?? null,
    note: supported
      ? "safe to mirror in the SUMMARY line"
      : `posting title is outside the profile's target roles — do NOT mirror it`,
  }
}

// Pure core (exported for tests).
export function buildPlan({ job, profileBlob, targets = [] }) {
  const body = [job.description, ...(job.requirements ?? [])]
    .filter(Boolean)
    .join("\n")
  const parts = splitRequirements(body)
  const requiredText = parts.required || parts.general
  const requiredTech = extractTech(requiredText)
  const postingTech = extractTech(`${job.title ?? ""}\n${body}`)
  const evidenced = extractTech(profileBlob)

  // Ordered: required-and-evidenced first (those are the ones worth a SUMMARY
  // slot), then everything else the posting mentions that the profile can back.
  const mustUse = []
  for (const skill of [...postingTech].sort()) {
    if (!evidenced.has(skill)) continue
    mustUse.push({ skill, required: requiredTech.has(skill) })
  }
  mustUse.sort(
    (a, b) =>
      Number(b.required) - Number(a.required) || a.skill.localeCompare(b.skill),
  )

  const must_use = mustUse.map((m, i) => ({
    skill: m.skill,
    required: m.required,
    group: SKILL_BY_NAME.get(m.skill)?.group ?? null,
    ats_forms: atsFormsFor(m.skill),
    placement: placementFor(m.skill, { required: m.required, index: i }),
  }))

  // Everything the posting wants that the fact base cannot back. Listed so the
  // tailoring step knows exactly what NOT to reach for, and so the user can see
  // what recording an answer would unlock.
  const blocked = [...postingTech]
    .filter((s) => !evidenced.has(s))
    .sort()
    .map((skill) => ({
      skill,
      required: requiredTech.has(skill),
      why: "not present in profile.yaml or answers.yaml — verify-claims R6 will reject it",
      fix: `node scripts/profile/save-answer.mjs "Do you have hands-on experience with ${skill}?" "<your answer>"`,
    }))

  return {
    slug: job.slug ?? null,
    company: job.company ?? null,
    title_mirror: titleMirror(job.title, targets),
    density_cap: DENSITY_CAP,
    summary_slots: SUMMARY_SLOTS,
    must_use,
    blocked,
    coverage: {
      posting_terms: postingTech.size,
      evidenced_matches: must_use.length,
      required_terms: requiredTech.size,
      required_matched: must_use.filter((m) => m.required).length,
    },
  }
}

function main() {
  const args = process.argv.slice(2)
  const slug = args.find((a) => !a.startsWith("--"))
  if (!slug) {
    console.error("usage: keyword-plan.mjs <slug> [--json]")
    process.exit(2)
  }
  const jobsDir = flag(args, "--jobs-dir") || path.join(ROOT, "jobs")
  const profilePath =
    flag(args, "--profile") || path.join(ROOT, "profile", "profile.yaml")
  const answersPath =
    flag(args, "--answers") || path.join(ROOT, "profile", "answers.yaml")
  const limitsPath =
    flag(args, "--limits") || path.join(ROOT, "docs", "application-limits.yaml")

  const jobFile = path.join(jobsDir, slug, "job.json")
  if (!fs.existsSync(jobFile)) {
    console.error(`no job workspace at ${jobFile} — run new-job.mjs first`)
    process.exit(2)
  }
  if (!fs.existsSync(profilePath)) {
    console.error(`profile not found at ${profilePath}`)
    process.exit(2)
  }

  const job = { slug, ...JSON.parse(fs.readFileSync(jobFile, "utf8")) }
  // evidenceText, not the raw answers file: a form question enumerating
  // "AWS, Azure, or GCP" is not evidence of Azure. This is the same rule
  // verify-claims R6 applies, so must_use can never contain a term the
  // verifier would go on to reject.
  const blob = evidenceText(
    profileText(loadYamlFile(profilePath)),
    fs.existsSync(answersPath) ? loadYamlFile(answersPath) : { answers: [] },
  )

  const limits = fs.existsSync(limitsPath)
    ? (loadYamlFile(limitsPath) ?? {})
    : {}
  const targets = limits.roles?.title_keywords ?? []

  const plan = buildPlan({ job, profileBlob: blob, targets })
  const out = path.join(jobsDir, slug, "keywords.json")
  fs.writeFileSync(out, JSON.stringify(plan, null, 2))

  if (args.includes("--json")) return console.log(JSON.stringify(plan, null, 2))

  if (isTerse()) {
    console.log(
      `must_use=${plan.must_use.length} required_matched=${plan.coverage.required_matched}/${plan.coverage.required_terms} blocked=${plan.blocked.length} mirror=${plan.title_mirror.mirror ? "yes" : "no"} file=${out}`,
    )
    for (const m of plan.must_use) {
      console.log(`use|${m.skill}|${m.placement}|${m.ats_forms.join(" / ")}`)
    }
    for (const b of plan.blocked.filter((b) => b.required)) {
      console.log(`blocked|${b.skill}|required-by-posting`)
    }
    return
  }

  console.log(
    `\nKeyword plan for ${plan.company ?? slug} — written to ${out}\n`,
  )
  console.log(
    `Title mirror: ${plan.title_mirror.mirror ?? "(none)"} — ${plan.title_mirror.note}\n`,
  )
  console.log(
    `MUST USE (${plan.must_use.length}) — in the posting AND backed by your facts:`,
  )
  for (const m of plan.must_use) {
    console.log(
      `  ${m.skill}${m.required ? " *required*" : ""}  ->  ${m.placement}` +
        (m.ats_forms.length > 1
          ? `\n    write as: ${m.ats_forms.join(" / ")}`
          : ""),
    )
  }
  if (plan.blocked.length) {
    console.log(
      `\nBLOCKED (${plan.blocked.length}) — the posting wants these, your facts do not back them.` +
        `\nThey must NOT appear in the resume; verify-claims R6 will reject them.\n`,
    )
    for (const b of plan.blocked) {
      console.log(
        `  ${b.skill}${b.required ? " *the posting requires this*" : ""}`,
      )
    }
    console.log(`\nIf any of those are actually true of you, record it first:`)
    console.log(`  ${plan.blocked[0].fix}`)
  }
  console.log(
    `\nNo term more than ${plan.density_cap} times — stuffing is detected and penalised.`,
  )
}

const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (isMain) main()
