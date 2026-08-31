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
// Usage: node src/apply/pending-questions.mjs [<slug> ...] [--jobs-dir jobs]
//        [--no-predict] [--profile <path>] [--answers <path>]
//        [--inputs-dir <dir>] [--json]
//
// Exit codes: 0 ok, 2 usage / missing jobs dir.
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { isTerse } from "#lib/lib.mjs"
import { detectAts } from "./ats/index.mjs"
import { loadCache } from "./field-cache.mjs"
import {
  isConsent,
  looksLikeAgreementProse,
  isUnprobedButAnswered,
  resolveFields,
  labelHazard,
} from "./fill-plan.mjs"

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
      // Hazard over the FULLEST text available: instruction-shaped content
      // past the 120-char cut must still flag.
      const flag = labelHazard(q.labelFull ?? q.label)
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
    // The display companion: the merge key stays norm(q.label) — the 120-cut
    // string IS the bank key, and a full-text key would split one question
    // into two — but any source that knows the full text donates it.
    if (q.labelFull && !entry.labelFull) entry.labelFull = q.labelFull
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
        lFull: f.lFull || undefined,
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
  // Counted, not silently dropped — the same rule the stale-plan skip above
  // follows. A suppressed question that nobody can account for is the original
  // bug pointing the other way.
  const suppressed = { answered: 0, consent: 0 }
  for (const f of fields) {
    // BOTH consent predicates, matching buildPlan. `isConsent` alone was a
    // NARROWER filter than the planner's, so boxes the planner routes into its
    // protected branch still reached the user as questions: nine of them on
    // 2026-08-24, including "Please read the arbitration agreement below" and
    // four demographic-data consent boxes. That contradicted this file's own
    // header promise that consent and e-signature fields are never listed.
    // `looksLikeAgreementProse` is the shape half — long single-sentence prose
    // on a tickbox — and it is what catches a reworded box.
    if (isConsent(f.l) || looksLikeAgreementProse(f, f.l)) {
      suppressed.consent += 1
      continue
    }
    const r = byKey.get(f.k) ?? {}
    if (r.status && !NEEDS_HUMAN.has(r.status)) continue
    // The fact base already answers it and only a probe is missing. Asking a
    // human cannot supply a probe, so this is not a question — see
    // isUnprobedButAnswered in fill-plan.mjs for why this is not a licence to
    // fill it either.
    if (isUnprobedButAnswered(f, r)) {
      suppressed.answered += 1
      continue
    }
    found.push({
      source: "predicted",
      slug: null,
      ats: f.ats,
      label: f.l,
      labelFull: f.lFull || undefined,
      why: (r.status ?? "UNRESOLVED").toLowerCase(),
      options: f.opts ?? [],
      optsTruncated: f.optsTruncated || undefined,
    })
  }
  found.suppressed = suppressed
  return found
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"))
  } catch {
    return null
  }
}

// A PLAN IS ONLY AS CURRENT AS THE THINGS THAT BUILT IT, and nothing here was
// checking that. jobs/<slug>/fill-plan.json is a cached derivation of three
// inputs — the scan, the planner, and the fact base — but only the scan is
// tied to it (`fp`). Move either of the other two and every plan on disk keeps
// reporting defers that current code would not produce.
//
// MEASURED 2026-08-20: "Location (City)*" was listed as an open question across
// seven jobs off plans built 2026-08-08. ats/greenhouse.mjs had resolved that
// field on 2026-08-18 (typeaheadFields), and the answer had been banked since
// 2026-08-07 (a-066). The user was asked, three mornings running, a question
// they had already answered — with no signal anywhere that the PLAN was the
// stale part rather than the fact base being ignored. That is the failure this
// prevents, and it is a trust failure before it is a latency one.
//
// So a plan older than the newest input that could flip one of its defers is
// not a source of questions at all. Skipped and COUNTED, never silently
// dropped: a hidden question is the same bug pointing the other way. The
// rebuild is deterministic from the saved scan and costs no browser.
//
// mtime, not a version constant, on purpose. A constant has to be remembered on
// every planner change, and being forgotten is precisely the shape of this bug.
// mtime errs toward calling a plan stale — that direction costs a rebuild, the
// other costs the user's confidence that answering anything matters.
//
// DIRECTORIES, NOT A FILE LIST — and that correction is the whole point of the
// paragraph above. The list used to name four paths by hand, and the comment
// warning that "a constant has to be remembered on every planner change, and
// being forgotten is precisely the shape of this bug" described exactly what
// then happened to it: the constant did not disappear, it just moved up one
// level, from a version number to a path list, and was forgotten in the same
// way. Measured 2026-08-24, the hand-written list omitted `intents.mjs` (the
// 948-line polarity and typed-proposition engine, and the most defect-prone
// input `buildPlan` has), `disclosure.mjs`, `field-cache.mjs`,
// `scan-engine.mjs`, and everything in `lib/` — so a fix landing in any of them
// marked ZERO plans stale and every plan on disk kept answering with the old
// code's verdict.
//
// The two directories below are the real transitive closure of `buildPlan` and
// `resolveFields`, taken from the import graph rather than from memory. Naming
// a directory costs a `readdirSync` per run and cannot be forgotten when a new
// planner file lands beside the others, which is the failure being closed.
// Exported so the staleness tests can pin this list's coverage structurally,
// without comparing live mtimes of real sources (a read that races with any
// concurrent toucher of the same checkout).
export const PLAN_INPUT_PATHS = ["src/apply", "src/lib"]

// The fact base is an input too, and BOTH halves of it are. `profile.yaml` was
// missing until 2026-08-24: `resolveFields` reads it for address, name and
// education, so an edit there changed what a plan would decide while every plan
// on disk still read as current.
export const FACT_BASE_INPUTS = ["profile/answers.yaml", "profile/profile.yaml"]

/**
 * The fact-base paths to pass as `extra`, honouring an explicit --answers or
 * --profile override so a test pointed at fixture files does not stat the
 * real ones.
 */
export function factBaseInputs({
  answersFlag = null,
  profileFlag = null,
  root = ROOT,
} = {}) {
  return [
    typeof answersFlag === "string"
      ? path.resolve(answersFlag)
      : path.join(root, "profile", "answers.yaml"),
    typeof profileFlag === "string"
      ? path.resolve(profileFlag)
      : path.join(root, "profile", "profile.yaml"),
  ]
}

// `plannerRoots` (absolute paths) replaces the default source walk, and its
// only intended caller is a test. The staleness tests used to take thresholds
// off the REAL tree above — and prove sensitivity by bumping a real planner
// file's mtime a day into the future — so any two runs sharing this checkout
// could poison each other's arithmetic between one process's snapshot and its
// spawned child's re-walk: the 2026-08-27 flaky pair, reproduced on demand
// 2026-08-28. Tests now pin every input to files only they can touch;
// production callers pass nothing and get the real closure.
export function newestInputMtime(extra = [], plannerRoots = null) {
  let newest = 0
  const visit = (abs) => {
    let st
    try {
      st = fs.statSync(abs)
    } catch {
      return
    }
    if (st.isDirectory()) {
      for (const e of fs.readdirSync(abs)) visit(path.join(abs, e))
      return
    }
    if (st.mtimeMs > newest) newest = st.mtimeMs
  }
  const roots =
    plannerRoots ?? PLAN_INPUT_PATHS.map((rel) => path.join(ROOT, rel))
  for (const abs of roots) visit(abs)
  for (const p of extra) visit(p)
  return newest
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
  const inputsDir = flag("--inputs-dir")
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

  // The fact base counts as an input too: banking an answer is the single most
  // common reason a recorded defer stops being true.
  const newestInput = newestInputMtime(
    factBaseInputs({ answersFlag, profileFlag }),
    typeof inputsDir === "string" ? [path.resolve(inputsDir)] : null,
  )

  const plans = []
  const stalePlans = []
  const atsIds = new Set()
  for (const slug of slugs) {
    const planPath = path.join(jobsDir, slug, "fill-plan.json")
    const plan = readJson(planPath)
    if (plan) {
      let planMtime = 0
      try {
        planMtime = fs.statSync(planPath).mtimeMs
      } catch {
        // Unreadable stat on a readable file: treat as stale rather than
        // current, for the same reason as above.
      }
      // The ATS is still trustworthy on a stale plan — it comes from the URL,
      // not from the planner — so prediction still runs for this job and its
      // questions get re-derived from current code.
      if (plan.ats) atsIds.add(plan.ats)
      if (planMtime < newestInput) {
        stalePlans.push(slug)
        continue
      }
      plans.push({ slug, plan })
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
        {
          jobs: slugs.length,
          planned: plans.length,
          stale: stalePlans,
          questions,
        },
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
          // Display prefers the untruncated companion; matching and the
          // merge key stay on the 120-cut `label`.
          q.labelFull ?? q.label,
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
    if (stalePlans.length) {
      console.log(`stale	${stalePlans.join(",")}`)
    }
    console.log(
      `questions=${questions.length} jobs=${slugs.length} planned=${plans.length} predicted=${predicted.length} stale=${stalePlans.length}`,
    )
    return
  }
  if (stalePlans.length) {
    console.log(
      `${stalePlans.length} plan(s) predate the planner or the fact base and were NOT read — ` +
        `their defers may already be resolved. Rebuild before trusting this list:
` +
        `  node src/apply/rebuild-plans.mjs
`,
    )
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
      `- ${q.labelFull ?? q.label}${q.labelFlag ? ` [label flag: ${q.labelFlag}]` : ""}\n    ${q.why} — ${where}`,
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
