// The gate that runs before any unattended run, and refuses to let one start.
//
// ---------------------------------------------------------------------------
// WHY THIS EXISTS AT ALL, given that save-answer.mjs already refuses
// ---------------------------------------------------------------------------
//
// save-answer.mjs refuses a government or financial identifier at the WRITE
// boundary — exit 4, no override, ahead of both the append and the --replace
// branch. So the invariant that actually shipped is:
//
//     "this script never puts one there"
//
// which is NOT:
//
//     "the fact base never holds one"
//
// Two gaps separate those sentences, and closing them is this file's entire
// job:
//
//   1. Entries stored BEFORE the guard existed. A write boundary cannot reach
//      backwards.
//   2. A HAND-EDIT of profile/answers.yaml. That bypasses the script, and it
//      is CORRECT to bypass it — hard rule 2 makes the fact base the user's,
//      and the file's own header invites editing. A control that treated a
//      hand-edit as an attack would be wrong about who owns the file.
//
// There is a third gap nobody had covered, found while writing this: the write
// boundary only guards `answers.yaml`. `profile/profile.yaml` is typed into
// third-party forms by exactly the same pipeline, and NO script writes it, so
// every value in it arrived by hand and none of them ever passed a check. That
// is what `scanProfileFacts` below is for.
//
// ---------------------------------------------------------------------------
// THE MATCHING RULE, AND THE ONE THAT WAS SPECIFIED WRONG
// ---------------------------------------------------------------------------
//
// The original blast-radius spec (autonomy-plan §3.4) said this preflight would
// refuse "if answers.yaml has keys matching SSN / DOB / bank / passport
// patterns". Keys only. That was corrected on 2026-07-31, and the correction is
// binding here: key-only matching REFUSES HONEST ANSWERS. Measured against the
// real fact base, a-002 — "Do you have a valid Nevada driver's license?" -> "No"
// — matches the licence KEY. A key-only guard throws out a truthful "No".
//
// A guard that refuses an honest answer gets bypassed, and a bypassed guard
// protects nothing.
//
// So this file calls w1-security's `findSensitiveValues` and re-implements
// nothing. That function is two-factor and neither leg refuses alone: value
// alone only for shapes carrying their own proof (SSN 3-2-4 grouping, IBAN
// mod-97, Luhn plus a real issuer prefix), question+value for everything
// shapeless. Its measured behaviour — 5940 pairs, 5 refusals, and 0 of the 49
// real entries — is the property to preserve. A preflight that refuses the
// user's real bank is a failed preflight, because it will be switched off.
//
// For `answers.yaml` the call is made through `rescanAnswerBank`, which is the
// audited caller: it runs the sanitiser FIRST, so an identifier padded with
// zero-width characters is reassembled before it is matched. Re-running
// `findSensitiveValues` on the raw text here would be a second, weaker copy of
// a check that already exists. For `profile.yaml`, which `rescanAnswerBank`
// does not know about, `findSensitiveValues` is called directly, on sanitised
// text, per flattened fact.
//
// ---------------------------------------------------------------------------
// WHAT THIS IS NOT
// ---------------------------------------------------------------------------
//
// This is a BOUNDARY, not a proof, and the residuals are stated up front rather
// than discovered later:
//
//   - An undashed nine-digit number under a neutral key is indistinguishable
//     from an employee ID and passes.
//   - Non-US identifiers are caught only via the key leg.
//   - A value that is sensitive because of WHERE IT IS POSTED cannot be seen
//     from here at all. innov-resilience's ruling stands: a field's meaning is
//     decided server-side, so an input labelled "Phone number" can POST into a
//     column called `ssn`. Every field-level guard against a lying label is
//     permanently mitigation. What this file bounds is the blast radius of that
//     lie — the contents of the fact base.
//
// It also writes NOTHING. There is no `assertInsideJobs` call below because
// there is no write to fence: the only side effect is stdout, and the exit
// code. That is a property of the control flow, not a promise in a comment —
// grep this file for `writeFileSync` and you will find none.

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { loadYamlFile } from "#lib/lib.mjs"
import {
  findSensitiveValues,
  describeSensitive,
  sanitizeUntrusted,
  rescanAnswerBank,
  rescanSummary,
  SENSITIVE_LIMITS,
} from "#lib/untrusted.mjs"
import { stopActive, readStop, STOP_PATH, ROOT } from "./guard.mjs"

export const PREFLIGHT_LIMITS =
  "a boundary, not a proof: shape matching only, no view of where a value is POSTED, and " +
  "no ability to tell a false answer from a true one. It bounds what an unattended run can " +
  "type into a form; it does not certify that what it types is right."

// Mirrors save-answer.mjs's vocabulary on purpose, so a wrapper can tell the
// two apart by number without parsing prose:
//   0  clear to run
//   1  refused for a reason that is not the fact base (STOP, caps, approval)
//   2  usage, or a file could not be read/parsed
//   3  refused: stored text is instruction-shaped (hard rule 0)
//   4  refused: the fact base holds something identifier-shaped (hard rule 2)
// 3 and 4 keep save-answer's meanings so that "what would the write boundary
// have done with this entry?" has one answer across both scripts.
export const EXIT = Object.freeze({
  OK: 0,
  REFUSED: 1,
  USAGE: 2,
  INSTRUCTION_SHAPED: 3,
  SENSITIVE: 4,
})

export const DEFAULT_ANSWERS = path.join(ROOT, "profile", "answers.yaml")
export const DEFAULT_PROFILE = path.join(ROOT, "profile", "profile.yaml")
export const DEFAULT_LIMITS = path.join(ROOT, "docs", "application-limits.yaml")

// A pathological or hostile YAML (a deeply self-referential anchor expansion)
// must not turn the preflight into the thing that hangs the scheduled task. The
// budget is generous next to a real profile — the fixture flattens to well
// under 100 nodes — and being truncated is reported, never silent, because a
// scan that stopped early and said nothing is worse than no scan.
export const MAX_FACT_NODES = 20_000

// ---------------------------------------------------------------------------
// profile.yaml -> (question, value) pairs
// ---------------------------------------------------------------------------
//
// `findSensitiveValues` wants a question and an answer. profile.yaml has
// neither: it has a nested tree. The key PATH stands in for the question, which
// is the honest mapping — "bank account number" as a YAML key is asking the same
// thing a form asks, and the two-factor rule then still needs the value to carry
// a datum before it refuses.
//
// Separators are normalised to spaces (`bank_account_number` -> "bank account
// number") because every key regex in untrusted.mjs is word-boundary based and
// would otherwise miss the snake_case form of the exact key it is looking for.
// Array indices are dropped: `experience[0].company` carries no more meaning
// than `experience company`, and the index would only break a \b boundary.
export function flattenFacts(doc, { maxNodes = MAX_FACT_NODES } = {}) {
  const out = []
  let truncated = false
  const seen = new WeakSet()

  const walk = (node, trail) => {
    if (out.length >= maxNodes) {
      truncated = true
      return
    }
    if (node == null) return
    // FOUND BY THE TEST, and it was a real hole rather than a style point. A
    // Date IS an object, so the object branch below claimed it first, found no
    // own enumerable keys, and produced nothing — meaning a date of birth
    // hand-written into profile.yaml UNQUOTED (js-yaml parses it into a Date)
    // was silently skipped by the scan that exists to find it. Date is checked
    // before objecthood for that reason.
    const scalarised =
      node instanceof Date
        ? Number.isNaN(node.getTime())
          ? ""
          : node.toISOString().slice(0, 10)
        : null
    if (scalarised === null && typeof node === "object") {
      // A YAML anchor can make the same object appear twice, and js-yaml will
      // happily hand back a cycle. Visiting once is enough for a scan.
      if (seen.has(node)) return
      seen.add(node)
      if (Array.isArray(node)) {
        for (const item of node) walk(item, trail)
      } else {
        for (const [k, v] of Object.entries(node)) walk(v, [...trail, k])
      }
      return
    }
    const value = scalarised ?? String(node)
    if (!value.trim()) return
    out.push({
      path: trail.join("."),
      question: trail
        .join(" ")
        .replace(/[_\-.]+/g, " ")
        .trim(),
      value,
    })
  }

  walk(doc, [])
  return { facts: out, truncated }
}

// Findings carry LABELS AND A LOCATION, never the value.
//
// Same reason `findSensitiveValues` itself carries no payload: this refusal is
// printed to a terminal, into a scheduled task's log, and possibly into an agent
// transcript that never forgets. Echoing the SSN back while refusing to hold it
// would be the whole attack, performed by the defence.
export function scanProfileFacts(doc, opts = {}) {
  const { facts, truncated } = flattenFacts(doc, opts)
  const findings = []
  for (const fact of facts) {
    // Sanitise first, for the same reason rescanAnswerBank does: zero-width
    // padding between the digits of an identifier is reassembled before the
    // shape rules run.
    const q = sanitizeUntrusted(fact.question).text
    const v = sanitizeUntrusted(fact.value).text
    const hits = findSensitiveValues(q, v)
    if (!hits.length) continue
    findings.push({
      entry: fact.path,
      severity: "error",
      kind: "sensitive_value",
      detail:
        `profile.yaml value at "${fact.path}" looks like a ${describeSensitive(hits)} ` +
        `(matched: ${[...new Set(hits.map((h) => h.matched))].join(", ")}). ` +
        `The value is NOT printed.`,
      remedy:
        `open profile/profile.yaml and remove "${fact.path}" yourself. No script writes that ` +
        `file, so nothing else will do it, and the unattended path types stored facts into ` +
        `third-party forms`,
    })
  }
  return { findings, truncated, scanned: facts.length }
}

// ---------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------

const check = (id, verdict, detail, extra = {}) => ({
  id,
  verdict,
  detail,
  ...extra,
})

// `error` severity refuses; `review` severity warns and never refuses.
//
// That split is deliberate and it is the same reasoning save-answer.mjs's
// --rescan uses: `review` findings are true of a HEALTHY bank (an id out of
// sequence, a high-reach answer worth re-reading), and a check that is red on a
// healthy store is a check that gets switched off. A preflight nobody trusts to
// go green is a preflight that gets commented out of the scheduled task.
const REFUSING_SEVERITY = "error"

/**
 * The whole gate. Pure — takes parsed documents, returns a verdict, touches
 * nothing. Every I/O decision belongs to the CLI at the bottom.
 *
 * @param mode 'dry_run' | 'live'. No default, for the same reason startRun has
 *   none: an unattended process that has to guess whether it may send real
 *   applications is already wrong, whichever way it guesses.
 */
export function preflight({
  mode,
  answersDoc = null,
  profileDoc = null,
  limitsDoc = null,
  stopPath = STOP_PATH,
  now = new Date(),
} = {}) {
  if (mode !== "dry_run" && mode !== "live")
    throw new TypeError(
      `preflight requires mode 'dry_run' or 'live', got ${JSON.stringify(mode)}`,
    )

  const checks = []

  // --- 1. the kill switch --------------------------------------------------
  // Checked here as well as at run start. Not redundant: the preflight is what
  // a human runs to ask "would a run start right now?", and answering that
  // without reading the brake would be answering a different question.
  if (stopActive({ stopPath })) {
    const reason = readStop({ stopPath })
    checks.push(
      check(
        "stop_switch",
        "refuse",
        `jobs/.auto/STOP exists${reason ? `: ${reason.split("\n")[0]}` : " (empty)"}`,
        {
          remedy:
            "delete jobs/.auto/STOP once you have read why it was set. There is deliberately no " +
            "script that clears it",
        },
      ),
    )
  } else {
    checks.push(check("stop_switch", "pass", "no jobs/.auto/STOP"))
  }

  // --- 2. the caps are configured -----------------------------------------
  // No defaults are supplied for any of these. docs/application-limits.yaml is
  // the USER'S file; a missing cap reads as "not configured", and an unattended
  // process inventing its own blast radius is exactly what the block exists to
  // prevent.
  const auto = limitsDoc?.auto_apply
  if (!auto || typeof auto !== "object") {
    checks.push(
      check(
        "auto_apply_caps",
        "refuse",
        "no auto_apply block in the limits file",
        {
          remedy:
            "the user adds the block; no agent edits docs/application-limits.yaml. Propose values, " +
            "never write them",
        },
      ),
    )
  } else {
    const missing = []
    for (const k of ["per_run_max", "per_day_max", "per_company_max_per_week"])
      if (!Number.isFinite(auto[k]) || auto[k] < 0) missing.push(k)
    for (const k of ["enabled", "dry_run"])
      if (typeof auto[k] !== "boolean") missing.push(k)
    if (missing.length)
      checks.push(
        check(
          "auto_apply_caps",
          "refuse",
          `auto_apply is missing or malformed: ${missing.join(", ")}`,
        ),
      )
    else
      checks.push(
        check(
          "auto_apply_caps",
          "pass",
          `per_run_max=${auto.per_run_max} per_day_max=${auto.per_day_max} ` +
            `per_company_max_per_week=${auto.per_company_max_per_week}`,
        ),
      )
  }

  // --- 3. is a LIVE run authorised at all? ---------------------------------
  // Only asked in live mode. A dry run is exactly what the user is supposed to
  // be able to do while `enabled: false`, so refusing it here would make the
  // shipped-disabled default unreadable — and reading a dry run they trust is
  // how the user decides to enable it.
  if (mode === "live") {
    if (auto?.enabled !== true)
      checks.push(
        check(
          "auto_submit_authorised",
          "refuse",
          "auto_apply.enabled is not true — auto-submit ships disabled and the user turns it on",
        ),
      )
    else if (auto?.dry_run !== false)
      checks.push(
        check(
          "auto_submit_authorised",
          "refuse",
          "auto_apply.dry_run is true — a live run needs dry_run: false, set by the user",
        ),
      )
    else
      checks.push(
        check(
          "auto_submit_authorised",
          "pass",
          "auto_apply.enabled=true dry_run=false",
        ),
      )
  } else {
    checks.push(
      check(
        "auto_submit_authorised",
        "pass",
        `mode=dry_run — nothing is submitted, so authorisation is not required ` +
          `(auto_apply.enabled=${auto?.enabled ?? "absent"})`,
      ),
    )
  }

  // --- 4. the profile is approved -----------------------------------------
  if (profileDoc == null) {
    checks.push(
      check(
        "profile_approved",
        "refuse",
        "profile.yaml is empty or unreadable",
      ),
    )
  } else if (profileDoc?.meta?.approved_by_user !== true) {
    checks.push(
      check(
        "profile_approved",
        "refuse",
        "profile.yaml meta.approved_by_user is not true",
        {
          remedy:
            "the user sets it after reading their own profile. An unattended run sends documents " +
            "derived from facts nobody signed off",
        },
      ),
    )
  } else {
    checks.push(
      check("profile_approved", "pass", "meta.approved_by_user is true"),
    )
  }

  // --- 5. the answer bank, re-audited --------------------------------------
  let bankFindings = []
  if (answersDoc == null) {
    checks.push(
      check(
        "answer_bank_scan",
        "refuse",
        "answers.yaml is empty or unreadable",
      ),
    )
  } else {
    bankFindings = rescanAnswerBank(answersDoc, { now })
    const counts = rescanSummary(bankFindings)
    const errs = bankFindings.filter((f) => f.severity === REFUSING_SEVERITY)
    checks.push(
      check(
        "answer_bank_scan",
        errs.length ? "refuse" : counts.review ? "warn" : "pass",
        `${Array.isArray(answersDoc.answers) ? answersDoc.answers.length : 0} entries, ` +
          `${counts.errors} error / ${counts.review} review`,
        // `value` is stripped here and never restored. rescanAnswerBank attaches
        // the stored value to a high-reach finding so a HUMAN can eyeball it;
        // the preflight's output goes to a scheduled task's log, which is not
        // that human. Found the expensive way once already: the first live
        // --rescan printed the user's home address into an agent transcript.
        { findings: bankFindings.map(({ value, ...f }) => f) },
      ),
    )
  }

  // --- 6. profile.yaml facts, scanned for the first time -------------------
  let profileFindings = []
  let profileTruncated = false
  if (profileDoc != null) {
    const res = scanProfileFacts(profileDoc)
    profileFindings = res.findings
    profileTruncated = res.truncated
    checks.push(
      check(
        "profile_fact_scan",
        profileFindings.length ? "refuse" : profileTruncated ? "warn" : "pass",
        `${res.scanned} scalar facts scanned` +
          (profileTruncated
            ? `; STOPPED at the ${MAX_FACT_NODES}-node budget, so this scan is INCOMPLETE`
            : "") +
          `, ${profileFindings.length} sensitive`,
        { findings: profileFindings },
      ),
    )
  }

  // --- verdict -------------------------------------------------------------
  const allFindings = [
    ...bankFindings.filter((f) => f.severity === REFUSING_SEVERITY),
    ...profileFindings,
  ]
  const refusals = checks.filter((c) => c.verdict === "refuse")
  const warnings = checks.filter((c) => c.verdict === "warn")

  // The most specific reason wins the exit code, so a caller that only reads
  // the number still learns the worst thing found.
  let exit = EXIT.OK
  if (refusals.length) exit = EXIT.REFUSED
  if (allFindings.some((f) => f.kind === "instruction_shaped"))
    exit = EXIT.INSTRUCTION_SHAPED
  if (allFindings.some((f) => f.kind === "sensitive_value"))
    exit = EXIT.SENSITIVE

  return {
    ok: refusals.length === 0,
    mode,
    exit,
    checked_at: now.toISOString(),
    checks,
    refusals: refusals.map((c) => c.id),
    warnings: warnings.map((c) => c.id),
    limits: PREFLIGHT_LIMITS,
    sensitive_limits: SENSITIVE_LIMITS,
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const isMain = (() => {
  try {
    return (
      process.argv[1] &&
      fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
    )
  } catch {
    return false
  }
})()

const USAGE =
  "usage: preflight.mjs [--mode dry_run|live] [--answers <file>] [--profile <file>]\n" +
  "                     [--limits <file>] [--json]\n" +
  "       Reports only. This script never writes anything."

function die(msg) {
  console.error(`${msg}\n\n${USAGE}`)
  process.exit(EXIT.USAGE)
}

function readDoc(file, label) {
  if (!fs.existsSync(file)) die(`No such ${label} file: ${file}`)
  try {
    return loadYamlFile(file) ?? null
  } catch (err) {
    die(`Could not parse ${file}: ${err.message}`)
  }
}

if (isMain) {
  const argv = process.argv.slice(2)
  let mode = "dry_run"
  let answersFile = null
  let profileFile = null
  let limitsFile = null
  let wantJson = false

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const take = () => {
      const v = argv[++i]
      if (v === undefined) die(`${a} needs a value`)
      return v
    }
    if (a === "--json") wantJson = true
    else if (a === "--mode") {
      mode = take()
      if (mode !== "dry_run" && mode !== "live")
        die(`--mode must be dry_run or live, got ${JSON.stringify(mode)}`)
    } else if (a === "--answers") answersFile = take()
    else if (a === "--profile") profileFile = take()
    else if (a === "--limits") limitsFile = take()
    else if (a === "--help" || a === "-h") {
      console.log(USAGE)
      process.exit(EXIT.OK)
    } else die(`Unknown argument: ${a}`)
  }

  // THE TEST GUARD, and it is not decoration.
  //
  // On 2026-07-31 two agents wrote fabricated answers into the real fact base.
  // This script cannot write, so it cannot repeat that — but it CAN read the
  // user's private profile and print findings about it into a transcript, and a
  // test that silently depends on the real bank passes or fails for reasons
  // that are not in this repository. Under a test context, name your own files.
  if (process.env.NODE_TEST_CONTEXT) {
    const defaulted = []
    if (!answersFile) defaulted.push("--answers")
    if (!profileFile) defaulted.push("--profile")
    if (defaulted.length)
      die(
        `Refusing to read the real profile/ from a test: pass ${defaulted.join(" and ")} ` +
          `pointing at a fixture.`,
      )
  }

  const report = preflight({
    mode,
    answersDoc: readDoc(answersFile ?? DEFAULT_ANSWERS, "answers"),
    profileDoc: readDoc(profileFile ?? DEFAULT_PROFILE, "profile"),
    limitsDoc: readDoc(limitsFile ?? DEFAULT_LIMITS, "limits"),
  })

  if (wantJson) {
    console.log(JSON.stringify(report, null, 2))
    process.exit(report.exit)
  }

  console.log(`Preflight (${report.mode}) — nothing written.`)
  for (const c of report.checks) {
    const mark =
      c.verdict === "pass" ? "ok  " : c.verdict === "warn" ? "warn" : "REFUSE"
    console.log(`  ${mark.padEnd(6)} ${c.id}: ${c.detail}`)
    if (c.remedy) console.log(`          -> ${c.remedy}`)
    for (const f of c.findings ?? []) {
      // Only the refusing severity is printed in prose. `review` findings are
      // true of a healthy bank; they are in --json for anyone who wants them.
      if (f.severity !== REFUSING_SEVERITY) continue
      console.log(`          ${f.entry ?? "bank"} ${f.kind}: ${f.detail}`)
      if (f.remedy) console.log(`            -> ${f.remedy}`)
    }
  }
  console.log(
    report.ok
      ? `\nCLEAR to run in ${report.mode} mode.`
      : `\nREFUSED: ${report.refusals.join(", ")} (exit ${report.exit}).`,
  )
  console.log(`\nLimits: ${report.limits}`)
  process.exit(report.exit)
}
