#!/usr/bin/env node
// Autonomy plan item 0.12 — green-tier prevalence BY WIDGET SHAPE.
//
// THE QUESTION: of the real application forms this machine has actually seen,
// how many could reach the `green` tier at all, given that a checkbox/radio
// group defers permanently (`confirm-widget`), a consent tickbox defers on its
// shape, and any field resolving `CONFIRM` blocks a submit however it renders?
//
// WHAT THIS IS NOT
//
// The plan text says 0.12 is "computed from the already-stored scans of the
// 141 leads". THERE ARE NO SUCH SCANS. Scanning happens per-application and a
// handful of applications have ever been prepped. The corpus is:
//
//   * jobs/.field-cache.json      — 7 remembered form shapes (the corpus)
//   * jobs/<slug>/scan-p*.json    — 4 workspace scans (richer, 3 distinct forms)
//
// The synthetic boards under tests/fixtures/boards/ are used ONLY by --self-check
// to prove this harness agrees with the product rules. They are never counted.
//
// TWO DELIBERATE READS OF THE RAW FILE
//
// 1. The cache says `v: 2`; CACHE_VERSION is 4, so loadCache() discards it and
//    warns. That bump (0.5, registrable host in the fingerprint) is about
//    REUSE — it invalidates the keys, not the recorded field shapes. The shapes
//    are still a valid historical record of what those seven forms looked like,
//    so this file JSON.parse()s the cache directly and says so in its output.
// 2. `fields` is a MAP keyed "<normalised label>|<type>", not an array. That is
//    the DATA being adapted into what the real functions expect. No rule is
//    reimplemented here: every verdict below comes from
//    automatability.mjs's shapeBlockers()/classify(), fill-plan.mjs's
//    resolveFields()/buildPlan()/submitReadiness(), and
//    pending-questions.mjs's predictedFields(). This file only BUCKETS the
//    strings those functions returned — see CATEGORIES, which asserts that
//    every blocker string it was handed matched a known bucket and throws
//    otherwise, so a rule change cannot silently drop out of the tally.
//
// Usage:
//   node src/dev/bench-green-prevalence.mjs            # human report
//   node src/dev/bench-green-prevalence.mjs --json
//   node src/dev/bench-green-prevalence.mjs --self-check
import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import { fileURLToPath, pathToFileURL } from "node:url"
import { execFileSync } from "node:child_process"

import { detectAts, ADAPTERS } from "../apply/ats/index.mjs"
import { predictedFields } from "../apply/pending-questions.mjs"
import { resolveFields } from "../apply/fill-plan.mjs"
import {
  shapeBlockers,
  classify,
  boardKey,
  DEFAULT_CACHE_MAX_AGE_DAYS,
} from "../apply/automatability.mjs"

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
)

const ADAPTER_IDS = new Set(ADAPTERS.map((a) => a.id))

export function sha1(file) {
  return crypto.createHash("sha1").update(fs.readFileSync(file)).digest("hex")
}

// --- bucketing -----------------------------------------------------------
//
// These patterns match the literal strings automatability.mjs's shapeBlockers()
// emits. They classify a verdict that has already been reached; they do not
// reach one. If shapeBlockers grows a blocker this list does not know, the
// harness throws rather than under-counting.
const CATEGORIES = [
  ["consent", /^consent tickbox present \("(.*)"\)/s],
  ["confirm-widget", /^(checkbox|radio) group present \("(.*)"\)/s],
  ["required-unsettled", /^required field "(.*)" is ([a-z-]+)$/s],
  [
    "truncated-options",
    /^required field "(.*)" was matched against a truncated/s,
  ],
  ["req-not-recorded", /does not record which fields the form requires/s],
  ["no-fields", /records no fields at all/s],
  [
    "stale-shape",
    /^remembered form shape (is \d+ days old|has no recorded date)/s,
  ],
]

export function bucket(blocker) {
  for (const [name, re] of CATEGORIES) {
    const m = re.exec(blocker)
    if (m) {
      if (name === "confirm-widget")
        return { kind: name, widget: m[1], label: m[2] }
      if (name === "required-unsettled")
        return { kind: name, label: m[1], status: m[2] }
      if (name === "consent" || name === "truncated-options")
        return { kind: name, label: m[1] }
      return { kind: name }
    }
  }
  throw new Error(
    `bench-green-prevalence: unrecognised blocker from shapeBlockers() — ` +
      `the rules moved and this tally would silently under-count: ${blocker}`,
  )
}

// --- data adaptation -----------------------------------------------------
//
// The cache's map-shaped `fields` turned into the array of scanner-shaped
// fields resolveFields() takes. Same key convention predictedFields() uses
// (`${fp}:${cacheKey}`) so both resolutions share one namespace. The ONLY
// difference from predictedFields() is that this does not filter to `req` —
// needed because a CONFIRM on an OPTIONAL field still defers in buildPlan
// (fill-plan.mjs:1093, before the `!f.req` skip) while shapeBlockers() never
// looks at it. That asymmetry is a finding, not a rule this file invents.
export function allFieldsAsScanner(cache) {
  const out = []
  for (const [fp, entry] of Object.entries(cache.forms ?? {})) {
    for (const [key, f] of Object.entries(entry.fields ?? {})) {
      const label = f.l ?? key.split("|")[0]
      if (!label) continue
      out.push({
        k: `${fp}:${key}`,
        t: f.t ?? "text",
        l: label,
        req: !!f.req,
        opts: f.opts ?? [],
        optsTruncated: f.optsTruncated || undefined,
        ats: entry.ats,
      })
    }
  }
  return out
}

// --- part A: the seven remembered shapes ---------------------------------

// `resolveOpts` selects WHICH fact base the resolution sees, and the two
// choices are not equivalent — see FINDING QA-0.12-1 in docs/measurements.md.
//
//   {}                            -> undefined -> answer-bank.mjs's defaults
//                                    -> the REAL profile/answers. What the
//                                    module contract intends.
//   { profile: null, answers: null } -> what automatability.mjs:611 and
//                                    fill-plan.mjs:1747 actually pass when no
//                                    --profile flag is given. A destructuring
//                                    default fires only on `undefined`, so
//                                    `null` reaches fs.existsSync(null), which
//                                    is false, and the fact base is EMPTY.
export function analyseCache(
  cache,
  { now, maxAgeDays = DEFAULT_CACHE_MAX_AGE_DAYS, resolveOpts = {} },
) {
  const atsIds = new Set(
    Object.values(cache.forms ?? {})
      .map((e) => e.ats)
      .filter(Boolean),
  )

  // The real resolution pass, exactly as automatability.mjs's classifyAll runs
  // it: predictedFields -> resolveFields -> Map keyed by row key.
  const predicted = predictedFields(cache, atsIds)
  const resolved = resolveFields(predicted, resolveOpts)
  const resolvedByKey = new Map(resolved.map((r) => [r.k, r]))

  // Second pass over EVERY field (not just required) purely to expose optional
  // CONFIRMs, which shapeBlockers() does not examine but buildPlan() defers.
  const allResolved = resolveFields(allFieldsAsScanner(cache), resolveOpts)
  const allByKey = new Map(allResolved.map((r) => [r.k, r]))

  const forms = []
  for (const [fp, entry] of Object.entries(cache.forms ?? {})) {
    const blockers = shapeBlockers(fp, entry, resolvedByKey, {
      now,
      maxAgeDays,
    })
    const buckets = blockers.map(bucket)
    const fieldCount = Object.keys(entry.fields ?? {}).length
    const reqCount = Object.values(entry.fields ?? {}).filter(
      (f) => f.req,
    ).length

    const widgetFields = Object.entries(entry.fields ?? {})
      .filter(([, f]) => f.t === "checkbox" || f.t === "radio")
      .map(([k, f]) => ({ key: k, t: f.t, req: !!f.req }))

    // Optional fields the fact base answers from an assertion-class bank entry.
    // Not a shapeBlockers concern; it IS a submitReadiness concern.
    const optionalConfirms = Object.entries(entry.fields ?? {})
      .filter(
        ([k, f]) => !f.req && allByKey.get(`${fp}:${k}`)?.status === "CONFIRM",
      )
      .map(([k]) => k)

    const adapter = detectAts(entry.url ?? "")
    forms.push({
      fp,
      ats: entry.ats,
      url: entry.url,
      board: boardKey(entry.url ?? ""),
      detected_ats: adapter?.id ?? null,
      known_adapter: ADAPTER_IDS.has(adapter?.id),
      updated: entry.updated ?? null,
      fields: fieldCount,
      required_fields: reqCount,
      widget_fields: widgetFields,
      optional_confirm_fields: optionalConfirms,
      blockers,
      buckets,
      shape_green: blockers.length === 0,
      // The WIDGET-SHAPE half on its own — the two rules that are TOTAL over
      // the shape (they run on every field, required or not) and that no
      // amount of fact-base knowledge can unblock. Separated out because the
      // corpus is dominated by `req-not-recorded`, a scanner-vintage gap that
      // says nothing about widgets, and folding the two together would make
      // the widget rule look responsible for forms it did not block.
      widget_shape_blocked: buckets.some(
        (b) => b.kind === "confirm-widget" || b.kind === "consent",
      ),
    })
  }
  return { forms, predicted, resolved }
}

// --- part B: the real classifier, best case ------------------------------
//
// classify() also gates on facts about US (profile approved, a passing
// verify-claims row, screening). Those are per-LEAD, not per-form, and 0.12
// asks about the FORM. So every one of them is handed its most permissive
// value: this is an UPPER BOUND on green, not a prediction of any real run.
export function bestCaseTier(url, cache, resolvedByKey, now, maxAgeDays) {
  return classify(
    { apply_url: url },
    {
      cache,
      resolvedByKey,
      profileApproved: true,
      hasVerifiedResume: true,
      alreadyApplied: false,
      stages: { ok: true },
      now,
      maxAgeDays,
    },
  )
}

// --- part C: the four workspace scans ------------------------------------
//
// Runs the SHIPPED CLI (`src/apply/fill-plan.mjs --json`) against a COPY of
// the jobs tree in a temp dir, because that CLI writes fill-plan.json,
// fill-plan.js, the cache and a shape-history sidecar. Nothing in the real
// jobs/ tree is touched. Reading the CLI's own JSON rather than calling
// buildPlan() directly keeps stripUnvouchedLabelExact(), applyCache() and the
// adapter wiring in the path — the artifact, not a reconstruction of it.
const SCANS = [
  ["affirm-swe-backend-pba-growth", "scan-p1.json"],
  ["affirm-swe-backend-pba-growth", "scan-p2.json"],
  ["affirm-swe-backend-pba-growth", "scan-p3.json"],
  ["coinbase-software-engineer", "scan-p1.json"],
]

export function analyseScans(tmpRoot, { pastCaptcha = false } = {}) {
  const jobsDir = path.join(tmpRoot, pastCaptcha ? "jobs-cf" : "jobs")
  fs.rmSync(jobsDir, { recursive: true, force: true })
  fs.mkdirSync(jobsDir, { recursive: true })
  fs.copyFileSync(
    path.join(ROOT, "jobs", ".field-cache.json"),
    path.join(jobsDir, ".field-cache.json"),
  )
  const out = []
  for (const [slug, scan] of SCANS) {
    const src = path.join(ROOT, "jobs", slug)
    let scanPath = path.join(src, scan)
    if (!fs.existsSync(scanPath)) {
      out.push({ slug, scan, error: "scan file missing" })
      continue
    }
    fs.cpSync(src, path.join(jobsDir, slug), { recursive: true })
    if (pastCaptcha) {
      // COUNTERFACTUAL, ON MODIFIED DATA, AND LABELLED AS SUCH.
      //
      // All four scans on record carry a CAPTCHA signal, so buildPlan
      // short-circuits at fill-plan.mjs:739 with one `__page__` defer and zero
      // items — correct behaviour, and it means the real scans contribute
      // nothing to a by-widget breakdown. This leg deletes ONLY `signals` from
      // a COPY, so the per-field planner runs and the widget verdicts become
      // visible. It is not a measurement of what the pipeline would do on
      // those pages; the un-modified leg above is.
      const j = JSON.parse(fs.readFileSync(scanPath, "utf8"))
      delete j.signals
      scanPath = path.join(jobsDir, slug, `cf-${scan}`)
      fs.writeFileSync(scanPath, JSON.stringify(j))
    }
    let json
    try {
      const stdout = execFileSync(
        process.execPath,
        [
          path.join(ROOT, "src", "apply", "fill-plan.mjs"),
          slug,
          "--jobs-dir",
          jobsDir,
          "--scan",
          scanPath,
          "--json",
        ],
        { encoding: "utf8", cwd: ROOT, maxBuffer: 64 * 1024 * 1024 },
      )
      json = JSON.parse(stdout)
    } catch (e) {
      out.push({ slug, scan, error: String(e.message).slice(0, 300) })
      continue
    }
    const defers = json.plan?.defer ?? []
    const byWhy = {}
    for (const d of defers) {
      const why = d.why ?? "?"
      byWhy[why] = (byWhy[why] ?? 0) + 1
    }
    out.push({
      slug,
      scan,
      counterfactual: pastCaptcha || undefined,
      ats: json.plan?.ats,
      fields: (json.plan?.items?.length ?? 0) + defers.length,
      items: (json.plan?.items ?? []).filter((i) => i.how !== "skip").length,
      defer_total: defers.length,
      defer_by_why: byWhy,
      defers: defers.map((d) => ({
        why: d.why,
        label: String(d.label ?? "").slice(0, 90),
      })),
      ready: json.ready,
      submitReady: json.submitReady,
      submitReason: json.submitReason,
    })
  }
  return out
}

// --- self-check ----------------------------------------------------------
//
// Proves the bucketing above still speaks the product's language, using the
// SYNTHETIC fixture shapes. These are NEVER counted in the prevalence figure.
export function selfCheck() {
  const now = new Date("2026-08-02T00:00:00Z")
  const cases = [
    {
      name: "checkbox defers on shape even when required and answerable",
      entry: {
        ats: "greenhouse",
        updated: "2026-08-01",
        url: "https://boards.greenhouse.io/fixture/jobs/1",
        fields: {
          "first name|text": { t: "text", l: "First Name", req: true },
          "i agree to the terms|checkbox": {
            t: "checkbox",
            l: "Widget",
            req: true,
          },
        },
      },
      expect: "confirm-widget",
    },
    {
      name: "consent tickbox defers on topic",
      entry: {
        ats: "greenhouse",
        updated: "2026-08-01",
        url: "https://boards.greenhouse.io/fixture/jobs/2",
        fields: {
          "first name|text": { t: "text", l: "First Name", req: true },
          "i consent to the privacy policy|text": {
            t: "text",
            l: "I consent to the Privacy Policy",
            req: true,
          },
        },
      },
      expect: "consent",
    },
    {
      name: "a shape recording no requiredness is not evidence",
      entry: {
        ats: "greenhouse",
        updated: "2026-08-01",
        url: "https://boards.greenhouse.io/fixture/jobs/3",
        fields: { "first name|text": { t: "text", l: "First Name" } },
      },
      expect: "req-not-recorded",
    },
    {
      name: "empty shape blocks",
      entry: {
        ats: "greenhouse",
        updated: "2026-08-01",
        url: "https://boards.greenhouse.io/fixture/jobs/4",
        fields: {},
      },
      expect: "no-fields",
    },
    {
      name: "stale shape blocks",
      entry: {
        ats: "greenhouse",
        updated: "2020-01-01",
        url: "https://boards.greenhouse.io/fixture/jobs/5",
        fields: {
          "first name|text": { t: "text", l: "First Name", req: true },
        },
      },
      expect: "stale-shape",
    },
  ]
  const results = []
  for (const c of cases) {
    const cache = { forms: { fixfp: c.entry } }
    const predicted = predictedFields(cache, new Set(["greenhouse"]))
    const resolved = resolveFields(predicted, {})
    const byKey = new Map(resolved.map((r) => [r.k, r]))
    const blockers = shapeBlockers("fixfp", c.entry, byKey, {
      now,
      maxAgeDays: DEFAULT_CACHE_MAX_AGE_DAYS,
    })
    const kinds = blockers.map((b) => bucket(b).kind)
    results.push({
      name: c.name,
      expect: c.expect,
      got: kinds,
      pass: kinds.includes(c.expect),
    })
  }
  return results
}

// --- CLI -----------------------------------------------------------------

function main() {
  const args = process.argv.slice(2)
  const wantJson = args.includes("--json")
  const noScans = args.includes("--no-scans")

  if (args.includes("--self-check")) {
    const rs = selfCheck()
    for (const r of rs)
      console.log(`${r.pass ? "ok  " : "FAIL"} ${r.name} -> [${r.got}]`)
    process.exit(rs.every((r) => r.pass) ? 0 : 1)
  }

  const cacheFile = path.join(ROOT, "jobs", ".field-cache.json")
  // Deliberately NOT loadCache(): see this file's header.
  const cache = JSON.parse(fs.readFileSync(cacheFile, "utf8"))
  const now = new Date()
  const maxAgeDays = DEFAULT_CACHE_MAX_AGE_DAYS

  const { forms, predicted, resolved } = analyseCache(cache, {
    now,
    maxAgeDays,
  })
  const resolvedByKey = new Map(resolved.map((r) => [r.k, r]))

  // The SAME analysis with the argument the shipped CLIs actually pass. If
  // these two disagree, the number a user would see today is not the number
  // the rules imply, and that gap is the finding — not a footnote.
  const asShipped = analyseCache(cache, {
    now,
    maxAgeDays,
    resolveOpts: { profile: null, answers: null },
  })

  const boards = new Map()
  for (const f of forms) {
    if (!boards.has(f.board)) {
      boards.set(f.board, {
        board: f.board,
        url: f.url,
        shapes: [],
        tier: bestCaseTier(f.url, cache, resolvedByKey, now, maxAgeDays),
      })
    }
    boards.get(f.board).shapes.push(f.fp)
  }

  const tmpRoot =
    process.env.BENCH_TMP ||
    fs.mkdtempSync(path.join(require$fallbackTmp(), "green-prev-"))
  const scans = noScans ? [] : analyseScans(tmpRoot)
  const scansPastCaptcha = noScans
    ? []
    : analyseScans(tmpRoot, { pastCaptcha: true })

  // ASSERT THE RUN COMPLETED. A leg that errored is not a datum, and a tally
  // computed over a partial corpus is worse than no tally.
  const failed = [...scans, ...scansPastCaptcha].filter((s) => s.error)
  if (failed.length && !noScans) {
    console.error(
      `bench-green-prevalence: ${failed.length} scan leg(s) failed — refusing ` +
        `to report a partial corpus:\n` +
        failed.map((f) => `  ${f.slug}/${f.scan}: ${f.error}`).join("\n"),
    )
    process.exit(1)
  }

  const shapeGreen = forms.filter((f) => f.shape_green)
  const widgetBlocked = forms.filter((f) => f.widget_shape_blocked)
  const tierGreen = [...boards.values()].filter((b) => b.tier.tier === "green")

  const tally = {}
  for (const f of forms)
    for (const b of f.buckets) tally[b.kind] = (tally[b.kind] ?? 0) + 1
  const formsWith = {}
  for (const f of forms) {
    for (const k of new Set(f.buckets.map((b) => b.kind)))
      formsWith[k] = (formsWith[k] ?? 0) + 1
  }

  const payload = {
    corpus: {
      cache_file: cacheFile,
      cache_v: cache.v,
      cache_read:
        "raw JSON.parse — loadCache() would discard v:2 against CACHE_VERSION 4",
      remembered_shapes: forms.length,
      distinct_boards: boards.size,
      workspace_scans: scans.length,
      fixtures_counted: false,
    },
    headline: {
      shapes_reaching_green: `${shapeGreen.length} of ${forms.length}`,
      boards_reaching_green_best_case: `${tierGreen.length} of ${boards.size}`,
      green_shapes: shapeGreen.map((f) => f.fp),
      widget_or_consent_blocked: `${widgetBlocked.length} of ${forms.length}`,
      shapes_reaching_green_AS_SHIPPED_CLI: `${
        asShipped.forms.filter((f) => f.shape_green).length
      } of ${asShipped.forms.length}`,
      widget_blocked_shapes: widgetBlocked.map((f) => f.fp),
      scans_handed_off_before_any_field: `${
        scans.filter(
          (s) => s.defer_by_why?.["CAPTCHA present — hand off to the user"],
        ).length
      } of ${scans.length}`,
    },
    blocker_tally_by_rule: tally,
    forms_affected_by_rule: formsWith,
    forms,
    boards: [...boards.values()].map((b) => ({
      board: b.board,
      shapes: b.shapes,
      tier: b.tier.tier,
      reason: b.tier.reason,
    })),
    scans,
    scans_past_captcha_COUNTERFACTUAL: scansPastCaptcha,
    predicted_required_rows: predicted.length,
    sha1: {
      "src/dev/bench-green-prevalence.mjs": sha1(
        fileURLToPath(import.meta.url),
      ),
      "src/apply/fill-plan.mjs": sha1(
        path.join(ROOT, "src/apply/fill-plan.mjs"),
      ),
      "src/apply/automatability.mjs": sha1(
        path.join(ROOT, "src/apply/automatability.mjs"),
      ),
      "src/apply/answer-bank.mjs": sha1(
        path.join(ROOT, "src/apply/answer-bank.mjs"),
      ),
      "jobs/.field-cache.json": sha1(cacheFile),
    },
  }

  if (wantJson) {
    console.log(JSON.stringify(payload, null, 2))
    return
  }

  console.log(
    `0.12 green-tier prevalence — corpus: ${forms.length} remembered shapes ` +
      `(${boards.size} distinct boards), ${scans.length} workspace scans. Fixtures NOT counted.`,
  )
  console.log(
    `HEADLINE  shapes reaching green: ${shapeGreen.length} of ${forms.length} | ` +
      `boards reaching green (best case): ${tierGreen.length} of ${boards.size}`,
  )
  console.log(
    `          blocked by widget shape alone (checkbox/radio or consent): ` +
      `${widgetBlocked.length} of ${forms.length}`,
  )
  console.log(
    `          same analysis with the argument the shipped CLIs pass ` +
      `(profile:null -> EMPTY fact base, FINDING QA-0.12-1): ` +
      `${asShipped.forms.filter((f) => f.shape_green).length} of ${forms.length}`,
  )
  console.log(`\nBlockers by rule (occurrences / forms affected):`)
  for (const k of Object.keys(tally).sort())
    console.log(
      `  ${k.padEnd(20)} ${String(tally[k]).padStart(3)} / ${formsWith[k]}`,
    )
  console.log(`\nPer form:`)
  for (const f of forms) {
    console.log(
      `  ${f.fp} ${String(f.ats).padEnd(10)} fields=${String(f.fields).padStart(3)} ` +
        `req=${String(f.required_fields).padStart(2)} widgets=${f.widget_fields.length} ` +
        `optCONFIRM=${f.optional_confirm_fields.length} green=${f.shape_green}`,
    )
    for (const b of f.buckets)
      console.log(
        `      - ${b.kind}${b.label ? `: ${String(b.label).slice(0, 70)}` : ""}` +
          (b.status ? ` [${b.status}]` : ""),
      )
  }
  console.log(`\nWorkspace scans (shipped fill-plan.mjs CLI, temp jobs dir):`)
  for (const s of scans) {
    if (s.error) {
      console.log(`  ${s.slug}/${s.scan} ERROR ${s.error}`)
      continue
    }
    console.log(
      `  ${s.slug}/${s.scan} ats=${s.ats} items=${s.items} defer=${s.defer_total} ` +
        `ready=${s.ready} submitReady=${s.submitReady}`,
    )
    for (const [why, n] of Object.entries(s.defer_by_why))
      console.log(`      - ${why}: ${n}`)
  }
  console.log(
    `\nCOUNTERFACTUAL — same scans with \`signals\` deleted, to see past the ` +
      `CAPTCHA hand-off.\nNot a measurement of pipeline behaviour on those pages:`,
  )
  for (const s of scansPastCaptcha) {
    console.log(
      `  ${s.slug}/${s.scan} ats=${s.ats} items=${s.items} defer=${s.defer_total} ` +
        `ready=${s.ready} submitReady=${s.submitReady}`,
    )
    for (const [why, n] of Object.entries(s.defer_by_why))
      console.log(`      - ${why}: ${n}`)
  }
  console.log(`\nfile_sha1:`)
  for (const [k, v] of Object.entries(payload.sha1)) console.log(`  ${v}  ${k}`)
}

function require$fallbackTmp() {
  return process.env.TMPDIR || process.env.TEMP || process.env.TMP || "."
}

const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (isMain) main()
