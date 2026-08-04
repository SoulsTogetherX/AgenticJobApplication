// The REAL stages — the browser leg the runner was missing.
//
// WHAT WAS ACTUALLY WRONG. `runJob`/`walkPages` take `openPage`, `scan`, `plan`
// and `fill` as injected functions, and `auto-apply.mjs` had a real
// `makeOpenPage` but never built the other three: its `main()` printed "the
// browser leg is Phase 5 W2, so this invocation wrote nothing" and returned
// REFUSED. The only caller supplying real stages was a bench harness driving
// the loopback fixture. So the whole runner — state machine, trust gate, caps,
// breaker, pool, classifier — was complete and unreachable. This file is the
// four functions that connect it to a browser.
//
// EVERY STAGE IS AN IMPORT, NEVER A SPAWN. §4.1, and it is a measured number
// rather than a preference: four `execFileSync` calls per application over 999
// applications is ~198s of pure process startup, serialised behind every tab,
// and `spawns_per_app` is a gate column asserted to be 0.
//
// THE STAGES ARE THE SAME CODE THE ATTENDED PATH USES. scan-engine.mjs,
// fill-plan.mjs and fill-engine.mjs, called in process. That is deliberate: an
// unattended path with its own scanner or its own planner would be a second
// implementation of the rules, and the second implementation is always the one
// that quietly disagrees. Everything that makes the attended path safe —
// verify-claims, the confirm-widget gate, the defer taxonomy, rule 1 — is
// therefore automatically true here, because it is literally the same call.
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import scanPage from "../apply/scan-engine.mjs"
import fillPage from "../apply/fill-engine.mjs"
import { resolveFields, buildPlan } from "../apply/fill-plan.mjs"
import { loadDisclosureLimits } from "../apply/disclosure.mjs"
import { detectAts } from "../apply/ats/index.mjs"
import { classify as classifyPage } from "./classify.mjs"
import { loadYamlFile } from "../lib/lib.mjs"

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
)

/**
 * How many answers the fact base holds — item 2.3's denominator.
 *
 * A read failure yields 0, which is the STRICTER end: `buildPlan` falls back to
 * the disclosure floor rather than to a budget scaled off a number it could not
 * establish. A fact base that cannot be read must not widen a limit.
 */
export function bankSizeOf(answersPath) {
  try {
    const doc = loadYamlFile(answersPath)
    return Array.isArray(doc?.answers) ? doc.answers.length : 0
  } catch {
    return 0
  }
}

/**
 * The rendered documents this job can attach.
 *
 * PDFs, never the markdown. `defaultDocuments` in auto-apply.mjs returns the
 * `.md` paths because it is answering a different question (which bytes did
 * verify-claims vouch for); the thing an ATS file input wants is the rendered
 * PDF. Handing it a `.md` would upload a file no recruiter can open, and the
 * fill engine would report `ok` for it — `ok` never says a file reached the
 * right field.
 *
 * A document that does not exist is OMITTED rather than passed as a missing
 * path, so `buildPlan` defers the attachment slot with `no rendered resume`
 * instead of the browser failing on it.
 */
export function renderedFiles(slug, { jobsDir }) {
  const out = {}
  for (const [key, name] of [
    ["resume", "resume.pdf"],
    ["cover", "cover-letter.pdf"],
  ]) {
    const p = path.join(jobsDir, slug, name)
    if (fs.existsSync(p)) out[key] = path.resolve(p)
  }
  return out
}

/**
 * Build the four stages `runCampaign` needs.
 *
 * @param jobsDir      where jobs/<slug>/ lives
 * @param profilePath  the fact base
 * @param answersPath  the answer bank
 * @param limitsFile   the user's docs/application-limits.yaml
 * @returns {{scan, plan, fill, classify}}
 */
export function makeStages({
  jobsDir,
  profilePath = path.join(ROOT, "profile", "profile.yaml"),
  answersPath = path.join(ROOT, "profile", "answers.yaml"),
  limitsFile = path.join(ROOT, "docs", "application-limits.yaml"),
  scannerSrc = undefined,
} = {}) {
  const limits = loadDisclosureLimits({ limitsFile })
  const bankSize = bankSizeOf(answersPath)

  // THE VOUCH TRAVELS OUT OF BAND, and this WeakMap is how.
  //
  // scanPage returns `{scan, vouchedLabels}`: it lifts every vouched label OUT
  // of the scan and hands it back as a separate array held in this process,
  // precisely so a scan object — which is built from page-controlled text — can
  // never assert its own trustworthiness. The stage contract in job.mjs passes
  // the SCAN from `scan()` to `plan()` and nothing else, so threading the array
  // through the scan object would put it straight back inside the thing it was
  // lifted out of. Keyed on object identity instead: the planner gets the vouch
  // only for a scan this process actually produced, and a scan from anywhere
  // else has no entry and therefore no vouch.
  const vouchOf = new WeakMap()

  async function scan(page, { url } = {}) {
    // WAIT FOR A CONTROL TO EXIST BEFORE SCANNING, because the runner navigates
    // with `domcontentloaded` and every board this repo adapts renders its form
    // client-side. MEASURED on a live Ashby application: the scan ran before
    // hydration, came back with buttons but no fields, and the job deferred
    // "nothing to fill" — a SHORT SCAN reported as an empty form, which is the
    // failure mode this pipeline treats as the worst kind because it looks
    // exactly like a page with nothing on it.
    //
    // A SELECTOR WAIT, NOT A SLEEP. It returns the moment a control appears, so
    // a fast board pays nothing; a flat delay would tax every application to
    // cover the slowest one. And it is deliberately NOT fatal on timeout: a page
    // that genuinely has no controls is a real answer (a login wall, a posting
    // that closed), and the scan that follows reports it honestly rather than
    // this throwing and losing the reason.
    try {
      await page.waitForSelector(
        "input,select,textarea,[contenteditable='true']",
        { timeout: 10_000, state: "attached" },
      )
    } catch {
      /* no control appeared; let the scan say so */
    }
    const result = await scanPage(page, {
      ...(scannerSrc === undefined ? {} : { scannerSrc }),
      url,
    })
    // scanPage returns {scan, vouchedLabels}; older callers got a bare scan.
    // Both shapes are handled rather than assumed, because a shape mismatch
    // here would surface as "the form has no fields" — a silent short scan,
    // which is the failure this pipeline treats as the worst kind.
    const bare = result?.scan ?? result
    if (!bare || !Array.isArray(bare.fields)) {
      throw new Error(
        "scan stage: scan-engine returned no field list — refusing to plan " +
          "against a scan that did not happen",
      )
    }
    vouchOf.set(bare, result?.vouchedLabels ?? [])
    return bare
  }

  async function plan({ scan: pageScan, url, job, documents }) {
    const adapter = detectAts(url)
    const slug = job?.slug ?? documents?.slug
    const files = slug ? renderedFiles(slug, { jobsDir }) : {}
    const resolved = resolveFields(pageScan.fields, {
      profile: profilePath,
      answers: answersPath,
    })
    return buildPlan({
      scan: pageScan,
      resolved,
      adapter,
      url,
      files,
      vouchedLabels: vouchOf.get(pageScan) ?? [],
      limits,
      bankSize,
    })
  }

  async function fill(page, pagePlan) {
    return fillPage(page, pagePlan)
  }

  // `(url, html) -> outcome`, pure. submit.mjs REQUIRES this in live mode and
  // refuses the click outright without it, so passing it is not optional
  // plumbing — it is what makes a live submit reachable at all.
  function classify(url, html) {
    return classifyPage(url, html)
  }

  return { scan, plan, fill, classify }
}
