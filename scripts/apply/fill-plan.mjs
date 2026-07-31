#!/usr/bin/env node
// Turns a page scan into a deterministic fill plan. This is where the decisions
// happen; the browser-side engine only executes. Nothing here calls a model.
//
// Reads the scan produced by .claude/skills/apply-job/scan-page.js, resolves
// every field through scripts/apply/answer-bank.mjs (profile + answer bank only), and
// writes:
//   jobs/<slug>/fill-plan.js    -- a self-contained bootstrap: this job's plan
//                                  AND the fill-page.js engine source (read off
//                                  disk here, in an ordinary Node process, NOT
//                                  inside the browser_run_code_unsafe sandbox)
//                                  embedded as strings. Loaded whole via
//                                  `filename` and injected into the page with
//                                  page.evaluate + eval — never addScriptTag,
//                                  which a nonce-based CSP (Ashby) blocks
//                                  outright. See buildDriverSource() below and
//                                  the header comment in fill-page.js.
//   jobs/<slug>/fill-plan.json  -- the plan data alone, for tests and for the
//                                  user to read
//
// Anything the fact base cannot answer is DEFERRED, never guessed. Consent,
// terms, arbitration and e-signature fields are always deferred regardless of
// what the bank says — the agent does not agree to things on the user's behalf
// — UNLESS the exact label is on the user's own --consent-allowlist, and even
// then arbitration/background-check/e-signature wording is excluded no matter
// what the allowlist says (see isHardConsent).
//
// Usage: node scripts/apply/fill-plan.mjs <slug> [--scan <path> | --page <N>]
//        [--url <url>] [--resume <pdf>] [--cover <pdf>] [--json]
//        [--profile <path>] [--answers <path>] [--jobs-dir <path>]
//        [--consent-allowlist <path>] [--no-cache] [--invalidate]
//        [--record-via <path-to-fill-report.json>]
//
// --page <N> is sugar for --scan <jobDir>/scan-p<N>.json — the apply-job skill
// writes scan-p<N>.json per page of a multi-step form. Neither flag is needed
// when the job directory holds exactly one scan-p*.json (the common case); with
// more than one, the scan path MUST be given explicitly — see resolveScanPath.
//
// --invalidate drops the remembered shape of this form; use it when the engine
// reports verify.mismatch on a field whose options came from the cache.
//
// --record-via reads the engine's fill report (fill-engine.mjs's return value,
// written to disk by the caller) and persists comboVia/comboStrategy into the
// field cache against the LAST plan built for this slug, so the next
// application to the same form does not re-discover which combo strategy
// works. Runs standalone: no scan/profile/answers needed for this mode.
//
// Exit codes: 0 ok, 2 usage / missing scan, 3 ATS needs a human (Workday).
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { isTerse } from "../lib/lib.mjs"
import { detectAts } from "./ats/index.mjs"
import { resolveFieldsFromFiles, normalizeQuestion } from "./answer-bank.mjs"
import {
  fingerprint,
  loadCache,
  saveCache,
  applyCache,
  recordCache,
  invalidate,
  recordVia,
} from "./field-cache.mjs"
import {
  embedLiteral,
  engineSandboxSource,
  readScannerSource,
} from "./browser.mjs"

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
)

// Agreements. These are always the user's to accept, so they never become plan
// items no matter how confidently the bank resolves them — UNLESS the exact
// label is on the caller's consent allowlist (see isHardConsent/buildPlan).
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

// The subset of consent that carries legal weight beyond "my resume is
// accurate" — arbitration signs away a legal right, a background check
// authorizes a third party to pull the user's history, and an e-signature is
// a binding signature on the whole application. These are excluded from
// --consent-allowlist REGARDLESS of what the allowlist file contains: no
// exact label, however many times the user has approved it before, moves one
// of these into an auto-checked plan item.
const HARD_CONSENT_PATTERNS = [
  /\barbitration\b/i,
  /\bbackground (check|screening)\b/i,
  /\be-?sign(ature|ed)?\b|\b(electronic|digital)ly? sign(ature)?\b|\bsignature\b/i,
]

export function isHardConsent(label) {
  return HARD_CONSENT_PATTERNS.some((re) => re.test(String(label ?? "")))
}

// --consent-allowlist <path>: a JSON array of the user's OWN exact consent-box
// wording, approved over time. Matched by EXACT normalized text only — the
// same normalization answer-bank.mjs uses for a saved answer, never a
// pattern, so a superficially similar box on a different board is never
// silently ticked just because it shares some words with one the user
// approved. An unreadable or missing file yields an empty allowlist, which is
// the same as not passing the flag at all — nothing gets auto-checked.
export function loadConsentAllowlist(file) {
  const out = new Set()
  if (!file || !fs.existsSync(file)) return out
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"))
    const list = Array.isArray(raw) ? raw : raw?.labels
    if (!Array.isArray(list)) return out
    for (const s of list) {
      const n = normalizeQuestion(s)
      if (n) out.add(n)
    }
  } catch {
    /* an unparsable file is treated as "nothing allowlisted", not an error —
       the safe default (defer) still applies to every consent box. */
  }
  return out
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

// Imports answer-bank.mjs directly rather than spawning a subprocess per
// call — twice, today (here and, transitively, in pending-questions.mjs). A
// spawned command line also has a hard ~32,767-character ceiling on Windows,
// which a probed 200-option country list serialized into --fields can blow;
// an in-process call has no such ceiling.
export function resolveFields(fields, { profile, answers } = {}) {
  const { results } = resolveFieldsFromFiles(fields, {
    profileFile: profile,
    answersFile: answers,
  })
  return results
}

// Fields still missing options where a probe would actually change the
// outcome: the fact base has *something* to try against them (a rule/bank
// hit, or an EEO field probing could resolve to "decline"), or the form
// insists on an answer, so the real option list is worth showing the human
// even when nothing auto-resolves. A combo the fact base has nothing for, on
// a field the form does not require, is skipped in the plan either way —
// probing it is pure latency (measured 1.5-2.5s each) for zero effect on the
// outcome.
//
// NOTE for whoever wires this into scan-engine.mjs's `skipProbe`: that
// parameter's OWN doc comment currently treats "the fact base already
// resolved a value" as sufficient reason to skip probing. Since the fix
// below (requireOptions in answer-bank.mjs's matchOption) now requires a
// combo's options to be genuinely known before trusting a resolved value,
// skipping the probe on exactly those fields makes them defer as
// NEEDS-CHOICE instead of filling OK — safe, but it undoes the intended
// speedup. `skipProbe` should be the COMPLEMENT of this function's output,
// not fields this function returns.
export function combosNeedingProbe(fields, resolved) {
  const byKey = new Map((resolved ?? []).map((r) => [r.k, r]))
  const worthProbing = (f) => {
    if (f.req) return true
    const r = byKey.get(f.k)
    if (!r) return false
    if (r.source === "eeo") return true
    return !!r.status && r.status !== "UNKNOWN"
  }
  return (fields ?? [])
    .filter((f) => f.t === "combo" && !(Array.isArray(f.opts) && f.opts.length))
    .filter(worthProbing)
    .map((f) => f.k)
}

// Pure core (exported for tests).
export function buildPlan({
  scan,
  resolved,
  adapter,
  files = {},
  url,
  consentAllowlist = new Set(),
}) {
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

    // Agreements first — this outranks whatever the bank resolved. A consent
    // box only ever becomes an auto-checked item when ALL of: it is not
    // hard-excluded, its exact normalized label is on the caller's
    // allowlist, it is a genuine checkbox (not a combo/select-shaped
    // "confirm receipt" widget — there is no clean single verb for those),
    // and it has exactly one stamped option (never guess WHICH box to click
    // among several sharing a label).
    if (isConsent(label)) {
      const allowed =
        !isHardConsent(label) &&
        consentAllowlist.has(normalizeQuestion(label)) &&
        f.t === "checkbox" &&
        Array.isArray(f.o) &&
        f.o.length === 1
      if (allowed) {
        items.push({
          k: f.o[0].k,
          sel: f.o[0].sel,
          how: "check",
          value: "true",
          label,
          why: "consent:allowlisted",
        })
      } else {
        defer.push({ k: f.k, label, why: "consent" })
      }
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
        optsTruncated: f.optsTruncated || undefined,
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
      // A combo strategy remembered from a previous application to this same
      // form (threaded from the field cache via applyCache). The engine is
      // free to ignore this and walk its normal strategy order; it is a
      // hint, not a guarantee the field still works the same way.
      ...(verb === "combo" && f.via ? { via: f.via } : {}),
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
    // Where an ATS renders a value differently from the option text it was
    // chosen by (Greenhouse's country picker shows "United States +1" but
    // reduces to "+1" once chosen) — defined on every adapter, previously
    // never copied onto the plan the engine actually reads. AUDIT H8.
    valueAliases: adapter.valueAliases ?? [],
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
//
// Consent does not get special-cased here: buildPlan already resolved every
// allowlisted, non-hard consent box into a `check` item above, so anything
// still sitting in `defer` under `why: "consent"` is a box nobody has
// pre-approved (or one that legally cannot be) — and that correctly blocks
// the fast path, the same as any other undecided field.
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

// Builds the file written to jobs/<slug>/fill-plan.js: a single self-contained
// bootstrap that embeds BOTH the engine source and this job's plan as string
// constants, so `browser_run_code_unsafe { filename }` loads the whole thing
// with one real, unrestricted filesystem read on the MCP server.
//
// This is not cosmetic. The previous version loaded the two pieces into the
// page with page.addScriptTag({ path }), which inserts a real inline <script>
// element — any board with a nonce-based CSP (Ashby:
// `script-src 'nonce-...' https://cdn.ashbyprd.com ...`) refuses to run it:
// "Executing inline script violates the following Content Security Policy
// directive". page.evaluate instead drives the page over CDP
// (Runtime.evaluate), which is not a script the page itself loaded, so its
// CSP does not gate it — confirmed live on both Greenhouse (addScriptTag
// happened to work there too) and Ashby (only this way works).
//
// Why the engine source is embedded HERE rather than read inside the
// generated driver: the browser_run_code_unsafe vm context has no fs, no
// require, and no working dynamic import (see fill-page.js's sandbox notes)
// — so the only place that CAN do this read is an ordinary Node process, i.e.
// this file, before any of it is handed to the browser.
//
// THE ENGINE NEVER GOES INTO THE PAGE, AND NOTHING IS EVER READ BACK OUT OF IT.
//
// The previous version did both: it eval'd the engine into the page, read
// window.__ajFillSrc back out, and eval'd THAT Playwright-side, where `page`
// lives. A board only had to define its own getter to choose what ran with a
// live browser handle. That was not theoretical — it was built and executed
// against this generator: attacker code ran host-side, page.click on the submit
// button FIRED, it reached the Node process object, and it returned a fabricated
// clean report so the run looked successful. It defeated hard rule 6 (the user
// is always on the submit button) and could upload .env through setInputFiles.
//
// So the engine text is embedded as a LITERAL, read off our own disk by this
// generator, and the plan travels as an ARGUMENT. A page that defines
// window.__ajFillSrc now gets to do exactly nothing, because nobody asks.
//
// Two things below look like style and are not:
//
//   * `(0, eval)` must stay INDIRECT, and the local must NOT be named fillPage.
//     A direct sloppy-mode eval hoists the engine's own `function fillPage`
//     declaration into this scope, where it collides with the const — a
//     run-time SyntaxError, in the browser, in production only.
//   * embedLiteral, never JSON.stringify. U+2028/U+2029 are legal inside a JSON
//     string and are LINE TERMINATORS in JS source, and the plan carries labels
//     copied verbatim off a third-party page.
//
// The one remaining eval is of a string this generator read off OUR OWN DISK,
// and it exists only because the browser_run_code_unsafe vm has no module
// loader: playwright-core's runCode.ts supplies no importModuleDynamically
// callback, so even `await import("node:fs")` throws. The local runner needs
// none of it — scripts/apply/browser.mjs simply imports the same module.
//
// Page-side injection, for the SCANNER — the one thing that genuinely runs in
// the page — stays page.evaluate + (0, eval) and never page.addScriptTag({ path
// }): an injected inline <script> is refused outright by a nonce-based CSP board
// (Ashby: "Executing inline script violates the following Content Security
// Policy directive `script-src 'nonce-...' https://cdn.ashbyprd.com ...`"),
// which broke a live application. page.evaluate drives the page over CDP
// (Runtime.evaluate), which is not a script the page loaded, so the page's CSP
// does not gate it — the same reason DevTools can run code on a CSP-locked page.
// Confirmed live on Greenhouse and Ashby. Do not "fix" this back to addScriptTag.
export function buildDriverSource(plan, engineSrc, scannerSrc = null) {
  const installScanner = scannerSrc
    ? `
  // The scanner is the ONLY thing that goes INTO the page, and it goes in over
  // CDP — never as an inline <script>, which a nonce-CSP board refuses. Its text
  // was read off our own disk by the generator; nothing is read back out.
  const SCANNER = ${embedLiteral(scannerSrc)}
  if (!(await page.evaluate(() => typeof window.__ajScan === "function"))) {
    await page.evaluate((s) => { (0, eval)(s); }, SCANNER)
  }
`
    : ""
  return `// Generated by scripts/apply/fill-plan.mjs — do not edit by hand.
async (page) => {
  // Both constants below were read/built in an ordinary Node process (this
  // file's generator, scripts/apply/fill-plan.mjs), never in here — the
  // browser_run_code_unsafe vm context has no fs, no require, and no working
  // dynamic import. See fill-engine.mjs's sandbox notes for the full story.
  const ENGINE = ${embedLiteral(engineSrc)}
  const PLAN = ${embedLiteral(plan)}
${installScanner}  // One eval, of a string that came off OUR OWN DISK. The engine is never put
  // into the page and never read back out of it, so a board that defines
  // window.__ajFillSrc gets to do exactly nothing.
  const runFill = (0, eval)(ENGINE)
  return await runFill(page, PLAN)
}
`
}

// The printed instruction for step D: a `filename` load, not an inline `code`
// string — the whole point is that the (potentially large) engine + plan text
// lives on disk, never in the agent's context.
export function buildBootstrap(relJs) {
  return (
    "mcp__playwright__browser_run_code_unsafe\n" + `  { filename: "${relJs}" }`
  )
}

// Which scan file to read when the caller did not pass --scan explicitly.
//
// The bug this guards: fill-plan.mjs used to hardcode scan-p1.json
// regardless of how many pages had been scanned, and the engine's urlGuard
// cannot catch a wrong page on a single-URL multi-step form (the URL never
// changes between steps) — so page 2's answers were silently planned against
// page 1's fields. A single scan-p*.json in the job directory is unambiguous
// and used automatically (the common case: most forms are one page, and a
// multi-step form is still on page 1 the first time through). More than one
// is ambiguous and this refuses to guess — the caller must say --scan or
// --page. A guess that is loud and wrong (a usage error) is recoverable; a
// guess that is silent and wrong (page 1's answers in page 2's fields) is not.
export function resolveScanPath(jobDir, { scanFlag, pageFlag } = {}) {
  if (scanFlag) return { path: scanFlag }
  if (pageFlag) return { path: path.join(jobDir, `scan-p${pageFlag}.json`) }

  const candidates = fs.existsSync(jobDir)
    ? fs
        .readdirSync(jobDir)
        .filter((f) => /^scan-p\d+\.json$/.test(f))
        .sort()
    : []
  if (candidates.length === 1) {
    return { path: path.join(jobDir, candidates[0]) }
  }
  if (candidates.length === 0) {
    // Preserve the pre-existing "no scan found" message for the common case
    // of a job that has never been scanned at all.
    return { path: path.join(jobDir, "scan-p1.json") }
  }
  return {
    error:
      `${candidates.length} scans found in ${jobDir} (${candidates.join(", ")}) ` +
      "— pass --scan <path> or --page <N> to say which page this plan is for",
  }
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
  const pageFlag = flag("--page")
  const urlFlag = flag("--url")
  const resumeFlag = flag("--resume")
  const coverFlag = flag("--cover")
  const profileFlag = flag("--profile")
  const answersFlag = flag("--answers")
  const consentAllowlistFlag = flag("--consent-allowlist")
  const recordViaFlag = flag("--record-via")

  const slug = args.find((a) => !a.startsWith("--"))
  if (!slug) {
    console.error(
      "usage: node scripts/apply/fill-plan.mjs <slug> [--scan <path> | --page <N>]",
    )
    process.exit(2)
  }
  const jobDir = path.join(jobsDir, slug)

  // --record-via is a standalone mode: persist a fill report's learned combo
  // strategies against the LAST plan built for this slug. No scan needed.
  if (recordViaFlag) {
    const planPath = path.join(jobDir, "fill-plan.json")
    if (!fs.existsSync(planPath)) {
      console.error(`no plan at ${planPath} — run fill-plan.mjs first`)
      process.exit(2)
    }
    const plan = JSON.parse(fs.readFileSync(planPath, "utf8"))
    if (!plan.fp) {
      console.error(
        "plan has no cached fingerprint — re-run fill-plan.mjs to regenerate it",
      )
      process.exit(2)
    }
    let report
    try {
      report = JSON.parse(fs.readFileSync(recordViaFlag, "utf8"))
    } catch (e) {
      console.error(
        `could not read fill report at ${recordViaFlag}: ${e.message}`,
      )
      process.exit(2)
    }
    const cachePath = path.join(jobsDir, ".field-cache.json")
    const cache = loadCache(cachePath)
    const updated = recordVia(cache, plan.fp, plan, report)
    saveCache(cachePath, cache)
    console.log(
      isTerse()
        ? `recorded-via=${updated} fp=${plan.fp}`
        : `Recorded which combo strategy worked for ${updated} field(s).`,
    )
    return
  }

  const scanResolution = resolveScanPath(jobDir, { scanFlag, pageFlag })
  if (scanResolution.error) {
    console.error(scanResolution.error)
    process.exit(2)
  }
  const scanPath = scanResolution.path

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
  const cachedEntry = cache.forms[fp]
  const cacheStats = noCache
    ? { hits: 0, probed: 0, miss: 0 }
    : applyCache(scan, cachedEntry)

  const resolved = resolveFields(scan.fields ?? [], {
    profile: profileFlag,
    answers: answersFlag,
  })
  const consentAllowlist = loadConsentAllowlist(consentAllowlistFlag)
  const plan = buildPlan({
    scan,
    resolved,
    adapter,
    files,
    url,
    consentAllowlist,
  })
  // A board-level hint: even a combo the fact base could not resolve (so it
  // never became a plan item and has no per-field `via`) is worth trying
  // with whatever strategy usually wins on this form first.
  if (
    cachedEntry?.comboStrategy &&
    plan.comboStrategies?.includes(cachedEntry.comboStrategy)
  ) {
    plan.comboStrategies = [
      cachedEntry.comboStrategy,
      ...plan.comboStrategies.filter((s) => s !== cachedEntry.comboStrategy),
    ]
  }
  const probeNeeded = combosNeedingProbe(scan.fields ?? [], resolved)

  if (!noCache) {
    recordCache(cache, { fp, scan, atsId: adapter.id, url })
    saveCache(cachePath, cache)
  }

  // Carried on the written plan (not the pure buildPlan() return value) so a
  // later `--record-via` run can find its way back into the cache without
  // re-reading the scan.
  plan.fp = fp

  fs.mkdirSync(jobDir, { recursive: true })
  const jsPath = path.join(jobDir, "fill-plan.js")
  const jsonPath = path.join(jobDir, "fill-plan.json")
  fs.writeFileSync(jsonPath, JSON.stringify(plan, null, 2) + "\n")

  // Read here — an ordinary Node process — never inside the generated driver,
  // which runs in a vm sandbox with no fs. See buildDriverSource().
  //
  // engineSandboxSource() reads scripts/apply/fill-engine.mjs and translates it
  // for the sandbox by dropping `export default`. It THROWS if the engine ever
  // grows an import or a second export — deliberate, because such a file
  // compiles as a module and throws as a script, i.e. it would break only in
  // the browser and only in production.
  const engineSrc = engineSandboxSource()
  const scannerSrc = readScannerSource()
  fs.writeFileSync(jsPath, buildDriverSource(plan, engineSrc, scannerSrc))

  const relJs = path.relative(ROOT, jsPath).replace(/\\/g, "/")
  const bootstrap = buildBootstrap(relJs)

  const state = readiness(plan)

  if (wantJson) {
    console.log(
      JSON.stringify({ plan, bootstrap, probeNeeded, ...state }, null, 2),
    )
    return
  }
  if (isTerse()) {
    const skipped = plan.items.filter((i) => i.how === "skip")
    const checked = plan.items.filter((i) => i.why === "consent:allowlisted")
    console.log(
      `ats=${plan.ats} ready=${state.ready}` +
        (state.ready ? "" : ` reason=${JSON.stringify(state.reason)}`) +
        ` items=${plan.items.length - skipped.length}` +
        ` defer=${plan.defer.length} skip=${skipped.length} checked=${checked.length}` +
        // hits/probed/miss, not just hits/(hits+probed): a combo the cache
        // has never seen AND this scan did not probe used to vanish from
        // this ratio entirely, so a brand-new form and an all-text form both
        // printed cache=0/0 — indistinguishable. miss=N makes them different.
        ` cache=${cacheStats.hits}/${cacheStats.hits + cacheStats.probed + cacheStats.miss}` +
        ` miss=${cacheStats.miss} fp=${fp}`,
    )
    for (const d of plan.defer) {
      console.log(`defer\t${d.k}\t${d.why}\t${d.label}`)
    }
    for (const s of skipped) {
      console.log(`skip\t${s.k}\t${s.why}\t${s.label}`)
    }
    if (probeNeeded.length) {
      console.log(`probe\t${probeNeeded.join(",")}`)
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
