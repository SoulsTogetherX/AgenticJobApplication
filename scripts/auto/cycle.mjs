#!/usr/bin/env node
// ONE CYCLE: find jobs, screen them, tailor documents, apply. The thing a
// scheduler runs twice a day.
//
// WHAT WAS MISSING. Every stage of this pipeline existed as its own command and
// nothing joined them up, so "apply to jobs on its own every 12 hours" was
// three scripts and a human. This is the join.
//
//   1. search    find-jobs.mjs        new leads from the user's boards
//   2. screen    screen.mjs           l0/l1/l3 verdicts (hard rule 0 lives here)
//   3. prep      prep-queue.mjs       which leads are worth documents
//   4. tailor    new-job -> keyword-plan -> assemble-resume -> verify-claims
//                -> render-pdf, per lead
//   5. apply     auto-apply.mjs       the runner
//
// WHY THE WHOLE THING CAN BE UNATTENDED AT ALL: step 4 has no model in it.
// `assemble-resume.mjs` emits each selected fact VERBATIM with its
// `<!-- fact:ID -->` annotation, so rule 1 holds by construction rather than by
// inspection, and `verify-claims` still runs afterwards as the check. A
// pipeline whose tailoring step needed a model could not be scheduled; this one
// can, and that is the property that makes autonomy possible rather than the
// runner.
//
// WHY THIS SPAWNS AND THE RUNNER MUST NOT. job.mjs imports its stages because
// four spawns per application over 999 applications is ~198s of pure process
// startup on the critical path, and `spawns_per_app` is a gate column asserted
// to be 0. THIS file runs twice a day over a handful of leads, so a spawn per
// stage costs nothing measurable — and buys the thing that matters more here:
// one lead whose keyword plan throws cannot take the other nine down with it,
// because a non-zero exit is a value rather than an exception.
//
// THIS FILE NEVER DECIDES TO SEND ANYTHING. It prepares, then hands over to
// auto-apply.mjs, which reads `auto_apply.enabled` and `auto_apply.dry_run` out
// of the user's own docs/application-limits.yaml. Nothing here can turn a dry
// run into a live one, and nothing here edits that file.
//
// IDEMPOTENT ON PURPOSE. Run it twice and the second run does almost nothing:
// prep-queue excludes leads that already have a verified resume, and the
// runner's durable (slug, mode) row refuses a second attempt on a slug.
//
// Usage:
//   node scripts/auto/cycle.mjs [--top N] [--limit N] [--json]
//        [--skip-search] [--skip-apply] [--jobs-dir jobs]
//
//   --top N        leads to tailor this cycle (default 10)
//   --limit N      applications the runner may attempt (default: --top)
//   --skip-search  reuse the leads already in the store
//   --skip-apply   prepare documents and stop before the runner
//
// Exit codes: 0 ok, 2 usage. A stage that fails for one lead is reported and
// does not change the exit code — the cycle's job is to get as far as it can
// and say exactly where each lead stopped.
import fs from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath, pathToFileURL } from "node:url"
import { openDb, rowToLead, screenIndex } from "../lib/db.mjs"
import { trustBoard, readLimits } from "./trust.mjs"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, "..", "..")
const NODE = process.execPath

const flag = (args, name, dflt = null) => {
  const i = args.indexOf(name)
  return i !== -1 && args[i + 1] && !args[i + 1].startsWith("--")
    ? args[i + 1]
    : dflt
}

/**
 * Run one pipeline step.
 *
 * NEVER THROWS. A stage is a step in a cycle, not an assertion: `keyword-plan`
 * exiting 2 on one posting is a fact about that posting, and turning it into an
 * exception would abandon every lead behind it. The exit code and the last of
 * stderr come back as data.
 */
export function step(script, args, { cwd = ROOT, timeout = 180_000 } = {}) {
  const r = spawnSync(NODE, [path.join(ROOT, script), ...args], {
    cwd,
    timeout,
    encoding: "utf8",
    // The child's own stdout is captured rather than inherited so a cycle's
    // output stays one readable log instead of five interleaved ones.
    stdio: ["ignore", "pipe", "pipe"],
  })
  const err = String(r.stderr ?? "").trim()
  return {
    ok: r.status === 0,
    code: r.status,
    stdout: String(r.stdout ?? ""),
    // Capped: a stack trace in a summary line buries the summary.
    detail: err ? err.split(/\r?\n/).slice(-3).join(" ").slice(0, 300) : "",
  }
}

/**
 * `company-title` in kebab, which is what the existing workspaces under jobs/
 * are named and what new-job.mjs's own `^[a-z0-9][a-z0-9-]*$` accepts.
 *
 * Truncated to 60 so a long title cannot produce a path Windows refuses, and
 * suffixed on collision so two postings from one company at the same title do
 * not share a workspace — sharing one would let the second posting's keyword
 * plan overwrite the first's tailored resume after it had been verified.
 */
export function slugFor(lead, { jobsDir, taken = new Set() } = {}) {
  const kebab = (s) =>
    String(s ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
  const base =
    [kebab(lead.company), kebab(lead.title)].filter(Boolean).join("-") ||
    `lead-${lead.id ?? "unknown"}`
  let slug = base.slice(0, 60).replace(/-+$/, "")
  if (!/^[a-z0-9]/.test(slug)) slug = `job-${slug}`
  let n = 2
  while (taken.has(slug) || fs.existsSync(path.join(jobsDir, slug))) {
    const suffixed = `${base.slice(0, 56)}-${n++}`.replace(/-+$/, "")
    if (!taken.has(suffixed) && !fs.existsSync(path.join(jobsDir, suffixed))) {
      slug = suffixed
      break
    }
    if (n > 50) break
  }
  return slug
}

/**
 * Documents for one lead, end to end, with no model anywhere in it.
 *
 * STOPS AT THE FIRST FAILURE, and reports which stage. Rendering a PDF from a
 * resume that failed verification would put an unverified document where the
 * runner's own verification check reads one, and the runner would then be
 * authorised by a row that vouches for bytes nobody checked.
 */
export function prepareDocuments(slug, lead, { jobsDir }) {
  const dir = path.join(jobsDir, slug)
  const stages = []
  const record = (name, r) => {
    stages.push({ stage: name, ok: r.ok, detail: r.detail })
    return r.ok
  }

  if (!fs.existsSync(path.join(dir, "job.json"))) {
    const r = step("scripts/documents/new-job.mjs", [
      slug,
      "--from-lead",
      lead.url,
    ])
    if (!record("new-job", r)) return { slug, ok: false, stages }
  }

  // keyword-plan is the ONLY step that reads the posting, and it sanitises
  // first — hard rule 0. What it produces can move which of the user's own
  // facts are selected and can never contribute a word of text.
  if (
    !record("keyword-plan", step("scripts/documents/keyword-plan.mjs", [slug]))
  )
    return { slug, ok: false, stages }

  if (
    !record(
      "assemble-resume",
      step("scripts/documents/assemble-resume.mjs", [slug]),
    )
  )
    return { slug, ok: false, stages }

  // The durable pass row this writes is what `selectEligible` later reads to
  // decide the job may be applied to at all. Without it the runner will not
  // see this lead, which is the correct failure direction.
  if (
    !record(
      "verify-claims",
      step("scripts/documents/verify-claims.mjs", [
        "resume",
        path.join(dir, "resume.md"),
        "--job",
        path.join(dir, "job.json"),
      ]),
    )
  )
    return { slug, ok: false, stages }

  if (
    !record(
      "render-pdf",
      step("scripts/documents/render-pdf.mjs", [
        path.join(dir, "resume.md"),
        path.join(dir, "resume.pdf"),
      ]),
    )
  )
    return { slug, ok: false, stages }

  // THE COVER LETTER TOO, WHEN THERE IS ONE. Measured on a real run: a
  // workspace holding resume.md and cover-letter.md but only resume.pdf made
  // buildPlan defer BOTH attachment slots with "no rendered cover", and the
  // whole application failed on a document that was sitting right there in
  // markdown. Rendering only the resume is the kind of gap that looks like it
  // works, because the stage it skips is the one nothing asserts on.
  //
  // NOT FATAL when it fails. A missing cover letter defers one attachment
  // slot; a missing resume defers the application. Treating them the same
  // would throw away every application to a board that asks for an optional
  // cover letter this pipeline could not render.
  const coverMd = path.join(dir, "cover-letter.md")
  if (fs.existsSync(coverMd)) {
    record(
      "render-cover-pdf",
      step("scripts/documents/render-pdf.mjs", [
        coverMd,
        path.join(dir, "cover-letter.pdf"),
      ]),
    )
  }

  return { slug, ok: true, stages }
}

export async function runCycle(argv = []) {
  const top = Number(flag(argv, "--top", "10"))
  const limit = Number(flag(argv, "--limit", String(top)))
  const jobsDir = path.resolve(
    flag(argv, "--jobs-dir", path.join(ROOT, "jobs")),
  )
  const out = { started: new Date().toISOString(), stages: {}, leads: [] }

  if (!argv.includes("--skip-search")) {
    const r = step(
      "scripts/leads/find-jobs.mjs",
      ["search", "--source", "all"],
      {
        timeout: 600_000,
      },
    )
    out.stages.search = { ok: r.ok, detail: r.detail }
  }

  // Screening is where hard rule 0 is enforced, and the runner refuses an
  // unscreened lead outright, so this is not optional housekeeping.
  {
    const r = step("scripts/leads/screen.mjs", ["--skip-screened"], {
      timeout: 600_000,
    })
    out.stages.screen = { ok: r.ok, detail: r.detail }
  }

  const prep = step("scripts/leads/prep-queue.mjs", [
    "--top",
    String(top),
    "--cluster",
    "--json",
  ])
  out.stages.prep = { ok: prep.ok, detail: prep.detail }
  let queue = []
  try {
    queue = JSON.parse(prep.stdout || "[]")
  } catch {
    out.stages.prep.detail = "prep-queue did not return JSON"
  }

  // ==========================================================================
  // APPLICABILITY IS CHECKED BEFORE THE DOCUMENT WORK, NOT AFTER
  // ==========================================================================
  //
  // MEASURED, first real cycle (2026-08-03): prep-queue ranks on FIT and knows
  // nothing about where a posting lives, so it picked ten leads of which every
  // single one was refused by the runner a step later — eight on `www.adzuna.com`
  // (an aggregator, not an ATS, so it is not on the user's board_allowlist and
  // never will be) and two on a Workday tenant. The cycle had assembled,
  // verified and rendered a PDF for each. A pipeline that spends its whole
  // budget tailoring documents nothing can submit LOOKS like it is working:
  // every stage reports ok, `prepared=10`, and zero applications go out.
  //
  // So the same gate the runner uses is asked FIRST. `trustBoard` is imported
  // rather than reimplemented on purpose — a second copy of "is this board
  // applicable" is a copy that drifts, and the direction it drifts is toward
  // preparing documents for boards the runner then refuses.
  //
  // A REFUSED LEAD IS NOT DROPPED SILENTLY. It is reported with the gate's own
  // reason, because "we found you a job and cannot apply to it" is information:
  // it is how the user learns that most of their sources are aggregators, and
  // it is the same lead they can still apply to by hand.
  //
  // --any-board prepares documents regardless, which is the right thing when
  // the user is going to apply attended.
  const anyBoard = argv.includes("--any-board")
  const limitsDoc = readLimits(
    path.join(ROOT, "docs", "application-limits.yaml"),
  )
  const byUrl = new Map()
  const screeningOf = new Map()
  {
    const db = openDb()
    try {
      // The verdict lives in the `screens` table, keyed by (lead_id, source) —
      // never on the lead's own doc. Reading `lead.screening` off the doc is
      // the bug that made selectEligible report every lead unscreened; the
      // same lookup has to happen here or this gate refuses everything for the
      // same wrong reason.
      const model = screenIndex(db, "model")
      const mech = screenIndex(db, "mechanical")
      for (const row of db.prepare("SELECT * FROM leads").all()) {
        let lead
        try {
          lead = rowToLead(row)
        } catch {
          continue
        }
        const verdict = model.get(lead?.id) ?? mech.get(lead?.id) ?? null
        for (const key of [lead?.apply_url, lead?.url]) {
          if (!key) continue
          if (!byUrl.has(key)) byUrl.set(key, lead)
          if (verdict && !screeningOf.has(key)) screeningOf.set(key, verdict)
        }
      }
    } finally {
      db.close()
    }
  }

  const taken = new Set()
  out.skipped = []
  for (const entry of queue) {
    const lead = byUrl.get(entry.url) ?? entry
    if (!anyBoard) {
      const verdict = trustBoard({
        lead,
        limits: limitsDoc,
        screening:
          screeningOf.get(entry.url) ??
          screeningOf.get(lead.apply_url) ??
          lead.screening ??
          lead.screen ??
          null,
      })
      if (!verdict.ok) {
        out.skipped.push({
          company: entry.company,
          title: entry.title,
          url: entry.url,
          reason: verdict.reason,
        })
        continue
      }
    }
    const slug = entry.slug ?? slugFor(entry, { jobsDir, taken })
    taken.add(slug)
    out.leads.push({
      ...prepareDocuments(slug, entry, { jobsDir }),
      company: entry.company,
      title: entry.title,
    })
  }
  out.prepared = out.leads.filter((l) => l.ok).length

  if (!argv.includes("--skip-apply")) {
    // The runner reads the user's own enabled/dry_run. Nothing above this line
    // can change what it decides to do.
    const r = step(
      "scripts/auto/auto-apply.mjs",
      ["--limit", String(limit), "--json"],
      {
        timeout: 1_800_000,
      },
    )
    out.stages.apply = { ok: r.ok, detail: r.detail }
    try {
      out.run = JSON.parse(r.stdout.trim().split(/\r?\n/).pop() || "{}")
    } catch {
      out.run = null
    }
  }

  out.finished = new Date().toISOString()
  return out
}

async function main(argv = process.argv.slice(2)) {
  const out = await runCycle(argv)
  if (argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(out)}\n`)
    return 0
  }
  for (const [name, s] of Object.entries(out.stages))
    process.stdout.write(
      `${name}: ${s.ok ? "ok" : "FAILED"}${s.detail ? ` — ${s.detail}` : ""}\n`,
    )
  for (const l of out.leads) {
    const failed = l.stages.find((s) => !s.ok)
    process.stdout.write(
      `  ${l.slug}: ${l.ok ? "documents ready" : `stopped at ${failed?.stage} — ${failed?.detail}`}\n`,
    )
  }
  // Named, never a silent count. A lead the runner cannot take is still a lead
  // the user can apply to by hand, and the reason is how they learn that most
  // of their sources are aggregators rather than boards.
  for (const s of out.skipped ?? [])
    process.stdout.write(
      `  skipped ${s.company ?? "?"} — ${s.title ?? "?"}: ${s.reason}\n`,
    )
  process.stdout.write(
    `prepared=${out.prepared ?? 0}` +
      (out.run
        ? ` run=${out.run.run_id} mode=${out.run.mode} submitted=${out.run.submitted ?? 0}`
        : "") +
      "\n",
  )
  return 0
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  main().then((c) => process.exit(c))
}
