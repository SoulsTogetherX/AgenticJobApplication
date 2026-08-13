#!/usr/bin/env node
// Every question the fact base cannot answer, across ALL prepped jobs, in one
// list.
//
// profile/answers.yaml is global: "Do you require sponsorship?" answered once
// resolves it for every application ever. Today the flow still asks per job,
// while the user waits at a form, so the same question gets asked N times and
// N-1 of those are pure latency. Collected up front, the user answers once and
// the defer list for every one of those applications drops by the same amount.
//
// Two sources, both deterministic:
//   plan       a defer already computed for a scanned form
//              (jobs/<slug>/fill-plan.json) — certain, and tied to slugs
//   predicted  a required field remembered in jobs/.field-cache.json for an ATS
//              these jobs use, that the fact base still cannot resolve — likely,
//              and available before any browser is opened
//
// Consent, terms and e-signature fields are NEVER listed: they are the user's
// to tick in the browser, not questions with answers worth storing.
//
// Usage: node scripts/apply/pending-questions.mjs [<slug> ...] [--jobs-dir jobs]
//        [--no-predict] [--profile <path>] [--answers <path>] [--json]
//
// Exit codes: 0 ok, 2 usage / missing jobs dir.
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { isTerse } from "../lib/lib.mjs"
import { detectAts } from "./ats/index.mjs"
import { loadCache } from "./field-cache.mjs"
import { isConsent, resolveFields, labelHazard } from "./fill-plan.mjs"

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
)

// The defer reasons that are QUESTIONS — something a person can answer once and
// have it stay answered. Everything else buildPlan defers (a missing rendered
// PDF, an unsupported widget, a consent box) is a different kind of problem and
// batching it into an approval message would only bury the real questions.
const ASKABLE = new Set([
  "unknown",
  "needs-choice",
  "maybe",
  "unresolved",
  "no option matched the resolved value",
])

const norm = (s) =>
  String(s ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()

// Merge questions that are the same question. Keyed on the normalized label
// because that is exactly what answer-bank's exact-match bank is keyed on: one
// saved answer resolves every entry that merged here.
export function mergeQuestions(found) {
  const byLabel = new Map()
  for (const q of found) {
    const key = norm(q.label)
    if (!key) continue
    let entry = byLabel.get(key)
    if (!entry) {
      // Computed here, once, regardless of source (a live plan's defer OR a
      // remembered field-cache entry, which stores the label VERBATIM — see
      // field-cache.mjs's recordCache — and would otherwise re-serve a
      // poisoned label to every future application with no marking at all).
      // Same detection fill-plan.mjs's buildPlan uses; see labelHazard's own
      // comment on why this is display-only.
      const flag = labelHazard(q.label)
      entry = {
        label: q.label,
        why: q.why,
        sources: [],
        slugs: [],
        options: [],
        ats: [],
        ...(flag ? { labelFlag: flag } : {}),
      }
      byLabel.set(key, entry)
    }
    if (!entry.sources.includes(q.source)) entry.sources.push(q.source)
    if (q.slug && !entry.slugs.includes(q.slug)) entry.slugs.push(q.slug)
    if (q.ats && !entry.ats.includes(q.ats)) entry.ats.push(q.ats)
    for (const o of q.options ?? []) {
      if (!entry.options.includes(o)) entry.options.push(o)
    }
    // If ANY source says this list might be incomplete, the merged entry
    // must say so too — a form the list came from complete on and one it
    // came from truncated on do not cancel each other out.
    if (q.optsTruncated) entry.optsTruncated = true
    // A defer computed from a real scan outranks a guess from the cache.
    if (q.source === "plan") entry.why = q.why
  }
  const out = [...byLabel.values()]
  // Most-shared first: the question that unblocks four applications is the one
  // worth putting at the top of the message.
  out.sort(
    (a, b) =>
      b.slugs.length - a.slugs.length ||
      a.label.localeCompare(b.label, "en", { sensitivity: "base" }),
  )
  return out
}

// Questions already computed for scanned forms.
export function questionsFromPlans(plans) {
  const found = []
  for (const { slug, plan } of plans) {
    for (const d of plan?.defer ?? []) {
      if (!ASKABLE.has(String(d.why ?? "").toLowerCase())) continue
      if (isConsent(d.label)) continue
      found.push({
        source: "plan",
        slug,
        ats: plan.ats ?? null,
        label: d.label,
        why: d.why,
        options: d.options ?? [],
        optsTruncated: d.optsTruncated || undefined,
      })
    }
  }
  return found
}

// Turn remembered form shapes back into scanner-shaped fields, so the same
// answer-bank pass that resolves a live scan can resolve a remembered one.
//
// Required fields only, and only entries that recorded whether a field was
// required at all: a cache written before that was stored says nothing about
// which of its fields the form insists on, and asking the user for an optional
// Twitter handle is the noise that makes an approval message get skimmed.
export function predictedFields(cache, atsIds) {
  const fields = []
  for (const [fp, entry] of Object.entries(cache.forms ?? {})) {
    if (!atsIds.has(entry.ats)) continue
    for (const [key, f] of Object.entries(entry.fields ?? {})) {
      if (!f.req) continue
      const label = f.l ?? key.split("|")[0]
      if (!label) continue
      fields.push({
        k: `${fp}:${key}`,
        t: f.t ?? "text",
        l: label,
        req: true,
        opts: f.opts ?? [],
        // Carried through so a predicted NEEDS-CHOICE also gets the "this
        // list may be incomplete" caveat answer-bank.mjs attaches — see
        // field-cache.mjs's optsTruncated (AUDIT H3).
        optsTruncated: f.optsTruncated || undefined,
        ats: entry.ats,
      })
    }
  }
  return fields
}

const NEEDS_HUMAN = new Set(["UNKNOWN", "NEEDS-CHOICE", "MAYBE"])

export function questionsFromPredicted(fields, resolved) {
  const byKey = new Map(resolved.map((r) => [r.k, r]))
  const found = []
  for (const f of fields) {
    if (isConsent(f.l)) continue
    const r = byKey.get(f.k) ?? {}
    if (r.status && !NEEDS_HUMAN.has(r.status)) continue
    found.push({
      source: "predicted",
      slug: null,
      ats: f.ats,
      label: f.l,
      why: (r.status ?? "UNRESOLVED").toLowerCase(),
      options: f.opts ?? [],
      optsTruncated: f.optsTruncated || undefined,
    })
  }
  return found
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"))
  } catch {
    return null
  }
}

function main() {
  const args = process.argv.slice(2)
  const wantJson = args.includes("--json")
  const noPredict = args.includes("--no-predict")
  const flag = (name) => {
    const i = args.indexOf(name)
    if (i === -1) return null
    const v = args[i + 1]
    if (v === undefined || v.startsWith("--")) {
      args.splice(i, 1)
      return true
    }
    args.splice(i, 2)
    return v
  }
  const jobsDir = flag("--jobs-dir") || path.join(ROOT, "jobs")
  const profileFlag = flag("--profile")
  const answersFlag = flag("--answers")
  const only = args.filter((a) => !a.startsWith("--"))

  if (!fs.existsSync(jobsDir)) {
    console.error(`no jobs directory at ${jobsDir}`)
    process.exit(2)
  }

  const slugs = (
    only.length
      ? only
      : fs
          .readdirSync(jobsDir, { withFileTypes: true })
          .filter((e) => e.isDirectory())
          .map((e) => e.name)
  ).filter((s) => fs.existsSync(path.join(jobsDir, s, "job.json")))

  const plans = []
  const atsIds = new Set()
  for (const slug of slugs) {
    const plan = readJson(path.join(jobsDir, slug, "fill-plan.json"))
    if (plan) {
      plans.push({ slug, plan })
      if (plan.ats) atsIds.add(plan.ats)
      continue
    }
    // No scan yet — the ATS is still knowable from the posting URL, and that is
    // all the prediction needs.
    const job = readJson(path.join(jobsDir, slug, "job.json"))
    const url = job?.apply_url || job?.source_url
    if (!url) continue
    const adapter = detectAts(url)
    if (adapter && !adapter.handoff) atsIds.add(adapter.id)
  }

  let predicted = []
  if (!noPredict && atsIds.size) {
    const fields = predictedFields(
      loadCache(path.join(jobsDir, ".field-cache.json")),
      atsIds,
    )
    if (fields.length) {
      const resolved = resolveFields(fields, {
        profile: profileFlag,
        answers: answersFlag,
      })
      predicted = questionsFromPredicted(fields, resolved)
    }
  }

  const questions = mergeQuestions([...questionsFromPlans(plans), ...predicted])

  if (wantJson) {
    console.log(
      JSON.stringify(
        { jobs: slugs.length, planned: plans.length, questions },
        null,
        2,
      ),
    )
    return
  }
  if (isTerse()) {
    for (const q of questions) {
      // Trailing column, not inserted mid-record — see fill-plan.mjs's own
      // comment on the same choice for `defer`/`skip` lines.
      console.log(
        [
          "q",
          q.sources.join("+"),
          q.slugs.length ? q.slugs.join(",") : q.ats.join(",") || "-",
          q.why,
          q.label,
          q.labelFlag ?? "",
        ].join("\t"),
      )
      if (q.options.length) {
        console.log(
          `opts\t${q.options.slice(0, 20).join(" | ")}` +
            (q.optsTruncated ? "\t(truncated)" : ""),
        )
      }
    }
    console.log(
      `questions=${questions.length} jobs=${slugs.length} planned=${plans.length} predicted=${predicted.length}`,
    )
    return
  }
  if (!questions.length) {
    console.log(
      slugs.length
        ? `Nothing to ask — the fact base answers every known field across ${slugs.length} job(s).`
        : "No job workspaces to check.",
    )
    return
  }
  console.log(
    `${questions.length} question(s) across ${slugs.length} job(s). Answering one resolves it everywhere:\n`,
  )
  for (const q of questions) {
    const where = q.slugs.length
      ? q.slugs.join(", ")
      : `${q.ats.join(", ")} (predicted)`
    console.log(
      `- ${q.label}${q.labelFlag ? ` [label flag: ${q.labelFlag}]` : ""}\n    ${q.why} — ${where}`,
    )
    if (q.options.length) {
      console.log(
        `    options: ${q.options.slice(0, 12).join(" | ")}` +
          (q.optsTruncated ? " (list may be incomplete — verify by hand)" : ""),
      )
    }
  }
  console.log(
    "\nSave each answer the user gives with scripts/profile/save-answer.mjs.",
  )
}

const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (isMain) main()
