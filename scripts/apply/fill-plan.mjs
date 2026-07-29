#!/usr/bin/env node
// Turns a page scan into a deterministic fill plan. This is where the decisions
// happen; the browser-side engine only executes. Nothing here calls a model.
//
// Reads the scan produced by .claude/skills/apply-job/scan-page.js, resolves
// every field through scripts/apply/answer-bank.mjs (profile + answer bank only), and
// writes:
//   jobs/<slug>/fill-plan.js    -- window.__ajPlan = {...}, loaded into the page
//   jobs/<slug>/fill-plan.json  -- same data, for tests and for the user to read
//
// Anything the fact base cannot answer is DEFERRED, never guessed. Consent,
// terms, arbitration and e-signature fields are always deferred regardless of
// what the bank says — the agent does not agree to things on the user's behalf.
//
// Usage: node scripts/apply/fill-plan.mjs <slug> [--scan <path>] [--url <url>]
//        [--resume <pdf>] [--cover <pdf>] [--json]
//        [--profile <path>] [--answers <path>] [--jobs-dir <path>]
//        [--no-cache] [--invalidate]
//
// --invalidate drops the remembered shape of this form; use it when the engine
// reports verify.mismatch on a field whose options came from the cache.
//
// Exit codes: 0 ok, 2 usage / missing scan, 3 ATS needs a human (Workday).
import fs from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath, pathToFileURL } from "node:url"
import { isTerse } from "../lib/lib.mjs"
import { detectAts } from "./ats/index.mjs"
import {
  fingerprint,
  loadCache,
  saveCache,
  applyCache,
  recordCache,
  invalidate,
} from "./field-cache.mjs"

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
)

// Agreements. These are always the user's to accept, so they never become plan
// items no matter how confidently the bank resolves them.
//
// Deliberately does NOT match "Are you legally authorized to work..." — that is
// a fact about the user, not a promise being extracted from them.
const CONSENT_PATTERNS = [
  /\barbitration\b/i,
  /\bterms (and|&) conditions\b/i,
  /\bprivacy (notice|policy|statement)\b/i,
  /\bconfirm receipt\b/i,
  /\bi (agree|consent|acknowledge|understand|certify)\b/i,
  /\be-?sign(ature|ed)?\b|\b(electronic|digital)ly? sign(ature)?\b|\bsignature\b/i,
  /\bbackground (check|screening)\b/i,
  /\bconsent to\b/i,
  /\bcode of conduct\b/i,
]

export function isConsent(label) {
  return CONSENT_PATTERNS.some((re) => re.test(String(label ?? "")))
}

// scan field type -> engine verb.
const VERB = {
  text: "fill",
  email: "fill",
  tel: "fill",
  url: "fill",
  number: "fill",
  date: "fill",
  search: "fill",
  textarea: "fill",
  select: "select",
  combo: "combo",
  checkbox: "check",
  radio: "check",
  richtext: "type",
  file: "upload",
}

// Statuses answer-bank emits that mean "a human still has to decide".
const NEEDS_HUMAN = new Set(["UNKNOWN", "NEEDS-CHOICE", "MAYBE"])

export function resolveFields(fields, { profile, answers, script } = {}) {
  const args = [
    script ?? path.join(ROOT, "scripts", "apply", "answer-bank.mjs"),
    "--fields",
    JSON.stringify(fields),
    "--json",
  ]
  if (profile) args.push("--profile", profile)
  if (answers) args.push("--answers", answers)
  const res = spawnSync(process.execPath, args, {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  })
  if (res.status !== 0) {
    throw new Error(`answer-bank failed (${res.status}): ${res.stderr?.trim()}`)
  }
  return JSON.parse(res.stdout).results ?? []
}

// Pure core (exported for tests).
export function buildPlan({ scan, resolved, adapter, files = {}, url }) {
  const items = []
  const defer = []
  const byKey = new Map(resolved.map((r) => [r.k, r]))
  let fileIndex = 0

  // Composite widgets (intl-tel-input is the common one) expose a picker AND a
  // text input under the SAME label. Filling both puts the phone number into
  // the country selector, which then fails every strategy and reports a bogus
  // failure. Keep the typable one; mark the picker skipped so it stays visible
  // in the plan rather than silently vanishing.
  const labelCount = new Map()
  for (const f of scan.fields ?? []) {
    const key = String(f.l ?? "")
      .trim()
      .toLowerCase()
    if (!key) continue
    labelCount.set(key, (labelCount.get(key) ?? 0) + 1)
  }
  const duplicateCombo = (f) =>
    f.t === "combo" &&
    labelCount.get(
      String(f.l ?? "")
        .trim()
        .toLowerCase(),
    ) > 1 &&
    (scan.fields ?? []).some(
      (o) =>
        o !== f &&
        String(o.l ?? "")
          .trim()
          .toLowerCase() ===
          String(f.l ?? "")
            .trim()
            .toLowerCase() &&
        VERB[o.t] === "fill",
    )

  for (const f of scan.fields ?? []) {
    const r = byKey.get(f.k) ?? {}
    const label = String(r.label ?? f.l ?? "")
    const verb = VERB[f.t]

    // Agreements first — this outranks whatever the bank resolved.
    if (isConsent(label)) {
      defer.push({ k: f.k, label, why: "consent" })
      continue
    }

    if (duplicateCombo(f)) {
      items.push({
        k: f.k,
        how: "skip",
        label,
        why: "picker half of a composite widget; the text input carries the value",
      })
      continue
    }

    if (f.t === "file") {
      // Greenhouse labels both attachment inputs just "Attach" — the real
      // heading sits outside the element the scanner reads. So match on the
      // label when it is informative, and otherwise fall back to document
      // order, which every one of these boards renders resume-first.
      let spec = (adapter.fileFields ?? []).find((s) => s.match.test(label))
      if (!spec) {
        const want = (adapter.fileOrder ?? ["resume", "cover"])[fileIndex]
        spec = (adapter.fileFields ?? []).find((s) => s.doc === want)
      }
      fileIndex++
      const doc = spec && files[spec.doc]
      if (!doc) {
        defer.push({
          k: f.k,
          label,
          why: spec
            ? `no rendered ${spec.doc}`
            : "unrecognised attachment slot",
        })
        continue
      }
      items.push({
        k: f.k,
        how: "upload",
        // The engine finds the input by the text around it, because the first
        // upload remounts the form and invalidates every stamp.
        labelMatch: spec.match.source,
        paths: [doc],
        label: label && label !== "Attach" ? label : spec.doc,
      })
      continue
    }

    if (!verb) {
      defer.push({ k: f.k, label, why: `unsupported field type ${f.t}` })
      continue
    }

    if (NEEDS_HUMAN.has(r.status) || !r.status) {
      // An OPTIONAL field the fact base cannot answer is left blank, not turned
      // into a question. Asking the user for a Twitter handle they do not have
      // is noise, and noise is what makes an approval message get skimmed.
      // Still counted and listed, so nothing disappears silently.
      if (!f.req) {
        items.push({
          k: f.k,
          how: "skip",
          label,
          why: `optional and not in the fact base (${(r.status ?? "unresolved").toLowerCase()})`,
        })
        continue
      }
      defer.push({
        k: f.k,
        label,
        why: (r.status ?? "UNRESOLVED").toLowerCase(),
        options: f.opts ?? (f.o ?? []).map((o) => o.l),
        note: r.note,
      })
      continue
    }
    if (r.status === "SKIP") {
      defer.push({ k: f.k, label, why: "needs a document or long-form text" })
      continue
    }
    if (r.status !== "OK" || r.value === "" || r.value == null) {
      defer.push({ k: f.k, label, why: "no value resolved" })
      continue
    }

    // Radio/checkbox groups have no element of their own; target the option.
    if (verb === "check") {
      if (!r.pick) {
        defer.push({
          k: f.k,
          label,
          why: "no option matched the resolved value",
        })
        continue
      }
      items.push({
        k: r.pick,
        sel: r.pickSel,
        how: "check",
        value: "true",
        label: `${label} → ${r.value}`,
      })
      continue
    }

    items.push({
      k: f.k,
      sel: r.sel ?? f.sel,
      how: verb,
      value: r.value,
      label,
    })
  }

  // A ticked "current role" box disables the end-date pair on every one of
  // these boards, so asking the user to fill them is noise.
  if (
    items.some((i) => i.how === "check" && /current role/i.test(i.label ?? ""))
  ) {
    for (let i = defer.length - 1; i >= 0; i--) {
      if (/\bend date\b/i.test(defer[i].label ?? "")) {
        items.push({
          k: defer[i].k,
          how: "skip",
          label: defer[i].label,
          why: "not applicable — this is the current role",
        })
        defer.splice(i, 1)
      }
    }
  }

  return {
    v: 1,
    slug: scan.slug ?? null,
    ats: adapter.id,
    urlGuard: url ?? scan.url ?? null,
    comboStrategies: adapter.comboStrategies,
    items,
    defer,
  }
}

// "Is any model judgment still required before this form can be filled?"
//
// The planner already knows the answer — it counted the defers and it knows
// whether anything is left to fill. Emitting it as a boolean means the caller
// branches on a flag instead of reading the plan and forming an opinion, which
// is the whole point: on ready=true the path is scan -> fill -> hand over.
export function readiness(plan) {
  const fillable = (plan.items ?? []).filter((i) => i.how !== "skip")
  if (plan.defer?.length) {
    return {
      ready: false,
      reason: `${plan.defer.length} deferred field(s) need a human`,
    }
  }
  if (!fillable.length) {
    return { ready: false, reason: "nothing to fill" }
  }
  return { ready: true, reason: null }
}

function main() {
  const args = process.argv.slice(2)
  const wantJson = args.includes("--json")
  const noCache = args.includes("--no-cache")
  const wantInvalidate = args.includes("--invalidate")
  // Consume value flags so the lone remaining bare word is the slug.
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
  const scanFlag = flag("--scan")
  const urlFlag = flag("--url")
  const resumeFlag = flag("--resume")
  const coverFlag = flag("--cover")
  const profileFlag = flag("--profile")
  const answersFlag = flag("--answers")

  const slug = args.find((a) => !a.startsWith("--"))
  if (!slug) {
    console.error(
      "usage: node scripts/apply/fill-plan.mjs <slug> [--scan <path>]",
    )
    process.exit(2)
  }
  const jobDir = path.join(jobsDir, slug)
  const scanPath = scanFlag || path.join(jobDir, "scan-p1.json")

  if (!fs.existsSync(scanPath)) {
    console.error(`no scan at ${scanPath} — run the page scanner first`)
    process.exit(2)
  }
  const scan = JSON.parse(fs.readFileSync(scanPath, "utf8"))
  scan.slug = slug

  const url = urlFlag || scan.url
  const adapter = detectAts(url)
  if (adapter.handoff) {
    console.error(`${adapter.id}: ${adapter.reason}`)
    process.exit(3)
  }

  // Only offer documents that actually exist — a plan referencing a missing
  // PDF would fail in the browser instead of here.
  const files = {}
  const resume = resumeFlag || path.join(jobDir, "resume.pdf")
  const cover = coverFlag || path.join(jobDir, "cover-letter.pdf")
  if (fs.existsSync(resume)) files.resume = path.resolve(resume)
  if (fs.existsSync(cover)) files.cover = path.resolve(cover)

  // Reuse the remembered shape of this form so a second application to the
  // same board does not have to re-probe every dropdown in the browser.
  const cachePath = path.join(jobsDir, ".field-cache.json")
  const cache = noCache ? { v: 1, forms: {} } : loadCache(cachePath)
  const fp = fingerprint(scan, adapter.id)
  if (wantInvalidate && invalidate(cache, fp)) {
    saveCache(cachePath, cache)
    console.error(`evicted cached shape ${fp} — the next scan will re-probe`)
  }
  const cacheStats = noCache
    ? { hits: 0, probed: 0 }
    : applyCache(scan, cache.forms[fp])

  const resolved = resolveFields(scan.fields ?? [], {
    profile: profileFlag,
    answers: answersFlag,
  })
  const plan = buildPlan({ scan, resolved, adapter, files, url })

  if (!noCache) {
    recordCache(cache, { fp, scan, atsId: adapter.id, url })
    saveCache(cachePath, cache)
  }

  fs.mkdirSync(jobDir, { recursive: true })
  const jsPath = path.join(jobDir, "fill-plan.js")
  const jsonPath = path.join(jobDir, "fill-plan.json")
  fs.writeFileSync(jsonPath, JSON.stringify(plan, null, 2) + "\n")
  fs.writeFileSync(
    jsPath,
    "// Generated by scripts/apply/fill-plan.mjs — do not edit by hand.\n" +
      "window.__ajPlan = " +
      JSON.stringify(plan) +
      "\n",
  )

  const relJs = path.relative(ROOT, jsPath).replace(/\\/g, "/")
  const bootstrap =
    `async (page) => {\n` +
    `  for (const p of [".claude/skills/apply-job/fill-page.js", "${relJs}"]) await page.addScriptTag({ path: p })\n` +
    `  const [src, plan] = await page.evaluate(() => [window.__ajFillSrc, window.__ajPlan])\n` +
    `  return await eval("(" + src + ")")(page, plan)\n` +
    `}`

  const state = readiness(plan)

  if (wantJson) {
    console.log(JSON.stringify({ plan, bootstrap, ...state }, null, 2))
    return
  }
  if (isTerse()) {
    const skipped = plan.items.filter((i) => i.how === "skip")
    console.log(
      `ats=${plan.ats} ready=${state.ready}` +
        (state.ready ? "" : ` reason=${JSON.stringify(state.reason)}`) +
        ` items=${plan.items.length - skipped.length}` +
        ` defer=${plan.defer.length} skip=${skipped.length}` +
        ` cache=${cacheStats.hits}/${cacheStats.hits + cacheStats.probed} fp=${fp}`,
    )
    for (const d of plan.defer) {
      console.log(`defer\t${d.k}\t${d.why}\t${d.label}`)
    }
    for (const s of skipped) {
      console.log(`skip\t${s.k}\t${s.why}\t${s.label}`)
    }
    console.log(`plan=${relJs}`)
    console.log(`bootstrap:\n${bootstrap}`)
    return
  }
  console.log(`ATS: ${plan.ats}`)
  console.log(
    state.ready
      ? "Ready to fill — nothing needs a decision."
      : `Not ready — ${state.reason}.`,
  )
  console.log(`${plan.items.length} field(s) will be filled automatically.`)
  if (plan.defer.length) {
    console.log(`\n${plan.defer.length} left for you:`)
    for (const d of plan.defer) console.log(`  - ${d.label} (${d.why})`)
  }
  console.log(`\nPlan written to ${relJs}`)
}

const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (isMain) main()
