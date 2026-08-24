#!/usr/bin/env node
// Mechanical first-pass screen for ghost-job / scam / vagueness signals —
// deterministic, offline, no LLM. It does NOT replace the judgment pass in
// the pipeline-jobs skill; it removes the parts that are just pattern
// matching, so the model only looks at what actually needs a human-like read.
//
// Verdicts: reject (a hard signal), caution (worth a closer look), pass.
//
// Verdicts are cached in the `screens` table, keyed by who produced them. This
// pass is cheap (~125 ms for the whole store) so its own cache saves nothing —
// it is recorded for history. What the cache is FOR is the model's judgment
// pass in the pipeline-jobs skill, which fetches the live posting and used to be
// re-paid on every re-screen. Record one with the `record` subcommand, and skip
// leads that already have one with --skip-screened.
//
// Usage: node scripts/leads/screen.mjs [--status new] [--json] [--skip-screened]
//        [--no-record] [--leads <path>] [--jobs-dir <path>] [--limits <path>]
//        [--profile <path>]
//        node scripts/leads/screen.mjs record <lead-id> --verdict pass|caution|reject
//          [--reason "..."] [--signals a,b] [--source model]
import fs from "node:fs"
import { assertKnownFlags } from "../lib/args.mjs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { isTerse, loadYamlFile, yearsOfExperience } from "../lib/lib.mjs"
import { loadLimits } from "./find-jobs.mjs"
import { evaluateStages, STAGE_IDS } from "./stages.mjs"
import { buildHistory } from "./risk.mjs"
import { extractTech } from "../lib/keywords.mjs"
import { profileText } from "../profile/profile-gaps.mjs"
import {
  readLeadStore,
  resolveLeadSource,
  openDb,
  loadKeywordIndex,
  recordScreens,
  screenIndex,
} from "../lib/db.mjs"

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
)

// Phrases that reliably indicate a scam or an ad that isn't a real job.
const SCAM_PATTERNS = [
  [
    /\b(pay|fee|payment|deposit)\s+(to\s+)?(apply|start|begin|register)/i,
    "pay_to_apply",
  ],
  [
    /\b(ssn|social security|bank account|routing number|credit card)\b/i,
    "asks_for_financial_id",
  ],
  [
    /\b(telegram|whatsapp|signal)\b.{0,30}\b(interview|contact|apply)/i,
    "offsite_chat_interview",
  ],
  [
    /\b(no experience (needed|required)).{0,40}\$\s*\d/i,
    "no_experience_high_pay",
  ],
  [
    /\b(immediate start|urgent hiring|hiring urgently|start today)\b/i,
    "urgency_pressure",
  ],
  [
    /\b(unlimited|guaranteed)\s+(earning|income|commission)\b/i,
    "guaranteed_income",
  ],
]

// Culture phrases that cluster in high-burnout postings. One is noise; the
// signal is the cluster, so this only ever produces "caution".
const CULTURE_PATTERNS = [
  [/\bwear (many|multiple) hats\b/i, "wear_many_hats"],
  [/\b(like a )?family\b/i, "family_culture"],
  [/\bwork hard,? play hard\b/i, "work_hard_play_hard"],
  [/\b(24\/7|around the clock|always on)\b/i, "always_on"],
  [/\brock ?star|ninja|guru\b/i, "rockstar_language"],
  [/\bfast[- ]paced\b/i, "fast_paced"],
]

// Requirements that applying cannot satisfy. A clearance is sponsored by an
// employer you already work for — you cannot obtain one to get the job — so
// these are hard rejects rather than judgment calls.
const BLOCKER_PATTERNS = [
  [/\b(TS\/SCI|top secret)\b/i, "clearance_required"],
  [
    /\bactive\s+(security\s+|government\s+|dod\s+)?clearance\b/i,
    "clearance_required",
  ],
  [/\bmust (have|possess|hold)\b.{0,30}\bclearance\b/i, "clearance_required"],
  [
    /\b(secret|public trust)\s+clearance\s+(is\s+)?required\b/i,
    "clearance_required",
  ],
  [/\b(ci|full scope|lifestyle)\s+polygraph\b/i, "polygraph_required"],
]

// How far above the candidate's own tenure a posting may reach before it stops
// being a stretch and starts being a waste. Overridable per-user in
// docs/application-limits.yaml (experience.stretch_years).
//
// Was 3, which put the ceiling at 5.5 years for a 2.5-year profile — so the
// single most common bar in practice, "5+ years", did not even raise a signal.
// Of 47 postings read on 2026-07-28 the sweep produced ZERO rejects for
// seniority while every one of them was in fact out of reach. 2 puts the
// ceiling at 4.5 and catches the 5+ band, which is where Senior actually sits.
const DEFAULT_STRETCH_YEARS = 2

// Highest years-of-experience demand in the posting. Deliberately narrow:
// requires an experience-ish word nearby, and skips "18 years of age", so a
// legal-minimum question is never read as a seniority bar.
export function extractYearsRequired(text) {
  let max = 0
  // The number may be fractional, and the lookbehind is load-bearing: with a
  // plain \b, "1.5+ years" matched the "5" (a decimal point is a word
  // boundary) and read an entry-level 1.5-year bar as a 5-year one — which
  // rejected precisely the junior postings this profile is looking for.
  const re =
    /(?<![\d.])(\d{1,2}(?:\.\d+)?)\s*\)?\s*\+?\s*years?\b([^.\n]{0,60})/gi
  for (const m of String(text).matchAll(re)) {
    const n = Number(m[1])
    const tail = m[2] ?? ""
    if (/\bof age\b|\bold\b/i.test(tail)) continue
    if (!/experien|background|track record/i.test(tail)) continue
    if (n > 0 && n <= 30 && n > max) max = n
  }
  return max
}

// Pure core (exported for tests). profileYears is the candidate's own tenure
// (see yearsOfExperience in lib.mjs); null disables the seniority gate.
export function screenJob(
  job,
  limits = {},
  now = new Date(),
  profileYears = null,
) {
  const signals = []
  let verdict = "pass"
  const text = [job.title, job.description, ...(job.requirements ?? [])]
    .filter(Boolean)
    .join("\n")

  for (const [re, name] of SCAM_PATTERNS) {
    if (re.test(text)) {
      signals.push(name)
      verdict = "reject"
    }
  }

  for (const [re, name] of BLOCKER_PATTERNS) {
    if (re.test(text)) {
      if (!signals.includes(name)) signals.push(name)
      verdict = "reject"
    }
  }

  // Seniority bar. This is the safety net for postings the title filter cannot
  // catch — Chainguard's "Software Engineer (Libraries Platform)" carried no
  // seniority word at all yet asked for 5+ years. A posting that states a bar
  // this far above the candidate's tenure is not a stretch, it is a waste, so
  // it rejects rather than cautions: cautions were being read and re-rejected
  // by hand, which is exactly the cost this is meant to remove.
  const demanded = extractYearsRequired(text)
  if (demanded && profileYears != null) {
    const ceiling =
      limits.experience?.max_years_required ??
      profileYears + (limits.experience?.stretch_years ?? DEFAULT_STRETCH_YEARS)
    if (demanded > ceiling) {
      signals.push(`over_bar_${demanded}y`)
      verdict = "reject"
    }
  }

  const ghostAge = limits.ghost_signals?.repost_age_days ?? 45
  if (job.posted_at) {
    const d = new Date(job.posted_at)
    if (!Number.isNaN(d.getTime())) {
      const days = Math.floor((now.getTime() - d.getTime()) / 86400000)
      if (days >= ghostAge) {
        signals.push(`stale_${days}d`)
        if (verdict === "pass") verdict = "caution"
      }
    }
  }

  const culture = CULTURE_PATTERNS.filter(([re]) => re.test(text)).map(
    ([, n]) => n,
  )
  if (culture.length >= 3) {
    signals.push(...culture)
    if (verdict === "pass") verdict = "caution"
  }

  for (const f of job.flags ?? []) {
    if (
      f === "no_salary" ||
      f === "unknown_location" ||
      f === "remote_unverified"
    ) {
      signals.push(f)
      if (verdict === "pass") verdict = "caution"
    }
  }

  // A description this thin can't be evaluated and is a mild ghost signal.
  // Skipped when the text is a known-truncated aggregator teaser, which is
  // short because of the source, not because the posting is empty.
  if (
    !job.partial_description &&
    job.description &&
    job.description.length < 200
  ) {
    signals.push("thin_description")
    if (verdict === "pass") verdict = "caution"
  }
  if (!job.company || /^unknown$/i.test(job.company)) {
    signals.push("unidentified_company")
    if (verdict === "pass") verdict = "caution"
  }

  return {
    id: job.id,
    company: job.company,
    title: job.title,
    verdict,
    signals,
    // Surfaced rather than kept internal: tailoring and the gap report both
    // want the bar a posting states, and re-parsing the description to get it
    // back is work this pass already did.
    years_required: demanded || null,
  }
}

function flag(args, name) {
  const i = args.indexOf(name)
  return i !== -1 ? (args[i + 1] ?? true) : null
}

// `screen.mjs record <lead-id> --verdict ...` — how the model's judgment pass
// gets written down. It is a separate verb because that verdict is not
// something this script can compute; it comes back from a read of the live
// posting, and the whole point of storing it is to not have to pay for it
// again.
function recordVerdict(args) {
  // Positional, not "the first bare word": scanning for one picked up the
  // VALUE of --verdict when the id was left off, and cheerfully recorded a
  // screen against a lead called "pass".
  const leadId = args[1]?.startsWith("--") ? null : args[1]
  const verdict = flag(args, "--verdict")
  const source = flag(args, "--source") || "model"
  const reason = flag(args, "--reason")
  const signals = flag(args, "--signals")
  const leadsPath = flag(args, "--leads") || resolveLeadSource().file

  if (!leadId || !["pass", "caution", "reject"].includes(verdict)) {
    console.error(
      'usage: screen.mjs record <lead-id> --verdict pass|caution|reject [--reason "..."] [--signals a,b]',
    )
    process.exit(2)
  }
  if (!String(leadsPath).endsWith(".db")) {
    console.error("recording a verdict needs the database, not a JSON store")
    process.exit(2)
  }
  const db = openDb(leadsPath)
  try {
    recordScreens(db, [
      {
        lead_id: leadId,
        source,
        verdict,
        reason: reason === true ? null : (reason ?? null),
        signals:
          typeof signals === "string"
            ? signals
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean)
            : [],
      },
    ])
    console.log(`recorded ${source} verdict for ${leadId}: ${verdict}`)
  } finally {
    db.close()
  }
}

const SCREEN_USAGE = `screen.mjs - mechanical screening over the stored leads

  --status all|new|...   which leads to screen
  --stage l0|l1|l3       run one stage only (diagnostic)
  --leads <path>         the lead store
  --limits <file>        application-limits.yaml
  --profile <file>       the fact base
  --jobs-dir <dir>       workspace root
  --skip-screened        skip leads that already have a verdict
  --json                 machine-readable output
  --no-record            do NOT write the screens table

RECORDING IS THE DEFAULT, and the rows written here are what the unattended
runner reads as screening evidence. --no-record is the read-only mode.
NOTE: --stage narrows the COMPUTATION but still records a full verdict; pair
it with --no-record.
`

function main() {
  const args = process.argv.slice(2)
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(SCREEN_USAGE)
    return 0
  }
  // STRICT. recording is the DEFAULT, and the rows it writes are what the unattended runner reads as screening evidence.
  try {
    assertKnownFlags(args, {
      known: [
        "--jobs-dir",
        "--json",
        "--leads",
        "--limits",
        "--no-record",
        "--profile",
        "--reason",
        "--signals",
        "--skip-screened",
        "--source",
        "--stage",
        "--status",
        "--verdict",
        "--help",
      ],
      valueFlags: [
        "--jobs-dir",
        "--leads",
        "--limits",
        "--profile",
        "--reason",
        "--signals",
        "--source",
        "--stage",
        "--status",
        "--verdict",
      ],
      script: "screen.mjs",
      note: "recording is the DEFAULT, and the rows it writes are what the unattended runner reads as screening evidence",
    })
  } catch (e) {
    console.error(e.message)
    process.exit(e.exitCode ?? 2)
  }
  if (args[0] === "record") return recordVerdict(args)
  // Defaults to jobs/leads.db when it exists, else the legacy JSON store.
  const leadsPath = flag(args, "--leads") || resolveLeadSource().file
  const jobsDir = flag(args, "--jobs-dir") || path.join(ROOT, "jobs")
  const limitsPath =
    flag(args, "--limits") || path.join(ROOT, "docs", "application-limits.yaml")
  const status = flag(args, "--status") || "new"
  const profilePath =
    flag(args, "--profile") || path.join(ROOT, "profile", "profile.yaml")

  if (!fs.existsSync(leadsPath)) {
    console.error(`no lead store at ${leadsPath} — run a search first`)
    process.exit(2)
  }
  const limits = fs.existsSync(limitsPath) ? loadLimits(limitsPath) : {}

  // The seniority gate needs the candidate's own tenure; without a profile it
  // stays off rather than guessing a bar.
  const profile = fs.existsSync(profilePath)
    ? (loadYamlFile(profilePath) ?? {})
    : {}
  const profileYears = profile.experience ? yearsOfExperience(profile) : null

  // Fold in captured posting text where a workspace exists.
  const byUrl = new Map()
  if (fs.existsSync(jobsDir)) {
    for (const slug of fs.readdirSync(jobsDir)) {
      const f = path.join(jobsDir, slug, "job.json")
      if (!fs.existsSync(f)) continue
      try {
        const j = JSON.parse(fs.readFileSync(f, "utf8"))
        if (j.source_url) byUrl.set(j.source_url, j)
      } catch {}
    }
  }

  const isDb = String(leadsPath).endsWith(".db")
  const skipScreened = args.includes("--skip-screened")
  const noRecord = args.includes("--no-record")

  // --stage l0|l1|l2|l3|all (comma-separated). Narrowing is for diagnosing one
  // layer in isolation — "what would L2 alone say about the store?" — without
  // the earlier layers short-circuiting everything first.
  const stageArg = flag(args, "--stage")
  const stages =
    !stageArg || stageArg === true || stageArg === "all"
      ? STAGE_IDS
      : String(stageArg)
          .split(",")
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean)
  const unknownStage = stages.find((s) => !STAGE_IDS.includes(s))
  if (unknownStage) {
    console.error(
      `unknown stage "${unknownStage}" — expected one of ${STAGE_IDS.join(", ")} or "all"`,
    )
    process.exit(2)
  }

  // The already-model-screened set. Consulted whether or not --skip-screened is
  // passed, so the count can be reported either way: knowing that 40 of 99
  // leads have already been judged is the whole saving on offer.
  let modelScreened = new Map()
  if (isDb && fs.existsSync(leadsPath)) {
    const db = openDb(leadsPath)
    try {
      modelScreened = screenIndex(db, "model")
    } finally {
      db.close()
    }
  }

  const all = (readLeadStore(leadsPath).leads ?? []).filter(
    (l) => status === "all" || l.status === status,
  )
  const alreadyJudged = all.filter((l) => modelScreened.has(l.id)).length
  const leads = skipScreened ? all.filter((l) => !modelScreened.has(l.id)) : all

  // Stage context, built once. History spans EVERY lead (dismissed included),
  // not just the ones being screened — a lead dismissed three weeks ago is the
  // evidence that today's identical posting is a repost.
  const now = new Date()
  const history = buildHistory(readLeadStore(leadsPath).leads ?? [], { now })
  const profileTech = extractTech(profileText(profile))
  // A KEYWORD INDEX THAT FAILED TO LOAD IS NOT AN EMPTY KEYWORD INDEX, and
  // this one is worse than gate-audit's twin: the rows written at the bottom of
  // this function are what the UNATTENDED RUNNER reads as its screening
  // evidence when no model verdict exists (selectEligible -> screeningFor ->
  // the trust gate's `screening` check). A bare `catch {}` here meant a locked
  // store could silently produce a confident `mechanical` verdict computed
  // without keywords, and the runner would then treat it as a real screen.
  //
  // Named and non-recording: the screen still runs and still prints, but a
  // verdict it knows is degraded must not become stored evidence.
  // A KEYWORD INDEX THAT FAILED TO LOAD IS NOT AN EMPTY KEYWORD INDEX, and
  // this one is worse than gate-audit's twin: the rows written at the bottom of
  // this function are what the UNATTENDED RUNNER reads as its screening
  // evidence when no model verdict exists (selectEligible -> screeningFor ->
  // the trust gate's `screening` check). A bare `catch {}` here meant a locked
  // store could silently produce a confident `mechanical` verdict computed
  // without keywords, and the runner would treat it as a real screen.
  //
  // Named and non-recording: the screen still runs and still prints, but a
  // verdict it knows is degraded must not become stored evidence.
  const { keywords: keywordIdx, error: keywordError } =
    loadKeywordIndex(leadsPath)
  if (keywordError)
    console.error(
      `screen: the keyword index could not be read (${keywordError}).
` +
        `  Every verdict below is computed WITHOUT keywords.
` +
        `  Nothing will be recorded — the unattended runner reads stored ` +
        `screens as evidence, and a degraded verdict is not evidence.`,
    )

  const results = leads.map((l) => {
    const captured = byUrl.get(l.url)
    // Prefer a full captured posting; fall back to the snippet the sweep
    // stored, so blockers are caught before a workspace ever exists.
    const job = {
      ...l,
      description: captured?.description ?? l.description,
      requirements: captured?.requirements,
      partial_description: !captured?.description,
    }
    const base = screenJob(job, limits, now, profileYears)
    // Which LAYER decided, recorded alongside the verdict. Without this a
    // stored "reject" says what happened but never why, and "why did I never
    // see this job?" stays unanswerable.
    const staged = evaluateStages(
      job,
      {
        limits,
        now,
        profileYears,
        profileTech,
        keywords: keywordIdx.get(l.id),
        history,
      },
      stages,
    )
    return {
      ...base,
      // A stage rejection outranks the pattern screen: the stages are the
      // ordered pipeline, screenJob is the scam/culture pass layered over it.
      verdict: staged.ok ? base.verdict : "reject",
      stage: staged.stage,
      signals: [...new Set([...base.signals, ...staged.flags])],
      reasons: staged.reasons,
      fit_score: staged.fit_score ?? null,
      repost_count: staged.repost_count ?? 0,
    }
  })

  // Recorded for history, not for speed — see the header. Never on a JSON
  // store, which is what the tests point at, so a test run cannot write here.
  // `keywordError` outranks --no-record's default: see the load site above.
  if (isDb && !noRecord && !keywordError && results.length) {
    const db = openDb(leadsPath)
    try {
      recordScreens(
        db,
        results.map((r) => ({
          lead_id: r.id,
          source: "mechanical",
          verdict: r.verdict,
          signals: r.signals,
          years_required: r.years_required,
          // Recorded inside `doc`, which is a verbatim-JSON column by design —
          // so this needs no schema change and cannot repeat the healScreens
          // problem (a table whose SHAPE changed after being created).
          stage: r.stage,
          reasons: r.reasons,
          fit_score: r.fit_score,
          repost_count: r.repost_count,
        })),
      )
    } finally {
      db.close()
    }
  }

  if (args.includes("--json")) {
    console.log(
      JSON.stringify(
        { results, model_screened: alreadyJudged, skipped: skipScreened },
        null,
        2,
      ),
    )
    return
  }
  const counts = results.reduce(
    (a, r) => ((a[r.verdict] = (a[r.verdict] ?? 0) + 1), a),
    {},
  )
  // What a caller needs to decide whether to spend the model on Stage A.
  const judged = alreadyJudged
    ? ` model-screened=${alreadyJudged}${skipScreened ? " (skipped)" : ""}`
    : ""
  // How many each layer caught — the headline number for "is my screening
  // actually filtering, and where?".
  const byStage = results.reduce((a, r) => {
    if (r.stage) a[r.stage] = (a[r.stage] ?? 0) + 1
    return a
  }, {})
  const stageSummary = Object.entries(byStage)
    .map(([s, n]) => `${s}=${n}`)
    .join(" ")

  if (isTerse()) {
    // Only non-passing rows need attention; passes are just a count.
    for (const r of results.filter((r) => r.verdict !== "pass")) {
      console.log(
        `${r.verdict}|${r.stage ?? "-"}|${r.id}|${r.company}|${r.signals.join(",")}`,
      )
    }
    console.log(
      `pass=${counts.pass ?? 0} caution=${counts.caution ?? 0} reject=${counts.reject ?? 0}${stageSummary ? ` ${stageSummary}` : ""}${judged}`,
    )
    return
  }
  for (const r of results) {
    const where = r.stage ? ` (caught at ${r.stage})` : ""
    console.log(
      `[${r.verdict}]${where} ${r.company} — ${r.title}` +
        (r.reasons?.length ? `\n  ${r.reasons.join("; ")}` : "") +
        (r.signals.length ? `\n  signals: ${r.signals.join(", ")}` : ""),
    )
  }
  console.log(
    `\n${counts.pass ?? 0} pass, ${counts.caution ?? 0} caution, ${counts.reject ?? 0} reject.`,
  )
  if (alreadyJudged) {
    console.log(
      `${alreadyJudged} already have a model verdict${skipScreened ? " and were skipped" : " — re-run with --skip-screened to leave them out"}.`,
    )
  }
}

const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (isMain) main()
