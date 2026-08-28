#!/usr/bin/env node
// Re-run every screening stage over the WHOLE stored lead set and diff the
// result against the last recorded run.
//
// Why this exists: CLAUDE.md already warns that adding a term to the body gate
// means re-running it over the live store and checking the reject list did not
// grow. That was a discipline nobody could verify afterwards. This makes it a
// command, and stores the answer so the next change has something to diff
// against.
//
// The asymmetry is deliberate. A newly ACCEPTED lead is a win and is reported
// as one line. A newly REJECTED lead is the dangerous direction — CLAUDE.md's
// stated worst failure is a job the user never sees — so those are listed in
// full, with the stage and reason that killed them, every time.
//
// Usage:
//   node scripts/leads/gate-audit.mjs [--json] [--status all|new|...]
//        [--baseline <file>] [--save] [--no-save] [--leads <path>]
//
// Exit codes: 0 clean or only-improvements, 1 when leads became newly rejected
// (so a CI-ish caller notices), 2 usage/missing store.
import fs from "node:fs"
import { assertKnownFlags } from "../lib/args.mjs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { isTerse, loadYamlFile, yearsOfExperience } from "../lib/lib.mjs"
import { loadLimits } from "./find-jobs.mjs"
import {
  readLeadStore,
  resolveLeadSource,
  loadKeywordIndex,
} from "../lib/db.mjs"
import { evaluateStages, STAGE_IDS, STAGE_LABELS } from "./stages.mjs"
import { buildHistory } from "./risk.mjs"
import { extractTech } from "../lib/keywords.mjs"
import { profileText } from "../profile/profile-gaps.mjs"

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
)
// Lives under jobs/ because that directory is already gitignored and this is
// derived state about the user's own lead store, not project source.
const DEFAULT_BASELINE = path.join(ROOT, "jobs", ".gate-baseline.json")

function flag(args, name, fallback = null) {
  const i = args.indexOf(name)
  return i !== -1 && args[i + 1] !== undefined ? args[i + 1] : fallback
}

// Pure core (exported for tests): current verdicts vs the previous ones.
export function diffAudit(previous, current) {
  const prev = new Map((previous?.leads ?? []).map((r) => [r.id, r]))
  const newlyRejected = []
  const newlyAccepted = []
  const stageMoved = []

  for (const row of current) {
    const before = prev.get(row.id)
    if (!before) continue // first sighting is neither a regression nor a win
    if (before.ok && !row.ok) newlyRejected.push({ ...row, was: "pass" })
    else if (!before.ok && row.ok)
      newlyAccepted.push({ ...row, was: before.stage })
    else if (!before.ok && !row.ok && before.stage !== row.stage) {
      stageMoved.push({ ...row, was: before.stage })
    }
  }

  const seen = new Set(current.map((r) => r.id))
  const gone = [...prev.keys()].filter((id) => !seen.has(id))

  return { newlyRejected, newlyAccepted, stageMoved, gone, compared: prev.size }
}

export function summarize(current) {
  const byStage = Object.fromEntries(STAGE_IDS.map((s) => [s, 0]))
  let passing = 0
  for (const r of current) {
    if (r.ok) passing++
    else byStage[r.stage] = (byStage[r.stage] ?? 0) + 1
  }
  return { total: current.length, passing, rejected_by: byStage }
}

const GATE_AUDIT_USAGE = `gate-audit.mjs - re-run every screening stage over the whole store and diff

  --status all|new|...   which leads to audit (default all)
  --baseline <file>      the baseline to diff against and write
  --leads <path>         the lead store
  --profile <file>       the fact base
  --json                 machine-readable output
  --save                 write the baseline (the default; states it explicitly)
  --no-save              do NOT write the baseline

SAVING IS THE DEFAULT. --no-save is the read-only mode.
`

function main() {
  const args = process.argv.slice(2)
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(GATE_AUDIT_USAGE)
    return 0
  }
  // STRICT. saving is the DEFAULT, so a typo overwrites jobs/.gate-baseline.json — the file every future gate change is diffed against.
  try {
    assertKnownFlags(args, {
      known: [
        "--baseline",
        "--json",
        "--leads",
        // Saving is the default, so --save is a no-op that states the intent
        // explicitly. It is documented in this file's own usage header and in
        // docs/operate/01-commands.md, and omitting it here made a documented
        // command exit 2 — the strictness is right, the list was incomplete.
        "--save",
        "--no-save",
        "--profile",
        "--status",
        "--help",
      ],
      valueFlags: ["--baseline", "--leads", "--profile", "--status"],
      script: "gate-audit.mjs",
      note: "saving is the DEFAULT, so a typo overwrites jobs/.gate-baseline.json — the file every future gate change is diffed against",
    })
  } catch (e) {
    console.error(e.message)
    process.exit(e.exitCode ?? 2)
  }
  const leadsPath = flag(args, "--leads") || resolveLeadSource().file
  const baselinePath = flag(args, "--baseline") || DEFAULT_BASELINE
  const status = flag(args, "--status", "all")
  const profilePath =
    flag(args, "--profile") || path.join(ROOT, "profile", "profile.yaml")
  const asJson = args.includes("--json")
  // Saving is the default: an audit whose result is not recorded gives the next
  // change nothing to diff against, which is the whole point.
  const save = !args.includes("--no-save")

  if (!fs.existsSync(leadsPath)) {
    console.error(`no lead store at ${leadsPath} — run a search first`)
    process.exit(2)
  }

  const limits = loadLimits()
  const now = new Date()
  const profile = fs.existsSync(profilePath)
    ? (loadYamlFile(profilePath) ?? {})
    : {}
  const profileYears = profile.experience ? yearsOfExperience(profile) : null
  const profileTech = extractTech(profileText(profile))

  // A KEYWORD INDEX THAT FAILED TO LOAD IS NOT AN EMPTY KEYWORD INDEX.
  //
  // This used to be a bare `catch {}`, so a locked or corrupt store left the
  // index empty, every lead was then scored WITHOUT keywords, and the degraded
  // scores were written to the baseline at the bottom of this function — the
  // very file every future gate change is diffed against. A transient DB lock
  // could therefore silently redefine "before".
  //
  // Named and non-recording. The audit still runs and still prints, because a
  // read-only answer is useful; what it must not do is persist a verdict it
  // knows is degraded. loadKeywordIndex is shared with screen.mjs, which had
  // the identical defect.
  const { keywords, error: keywordError } = loadKeywordIndex(leadsPath)
  if (keywordError)
    console.error(
      `gate-audit: the keyword index could not be read (${keywordError}).
` +
        `  Every lead below is scored WITHOUT keywords, so these numbers are ` +
        `not comparable to a normal run.
` +
        `  The baseline will NOT be written — a degraded audit must not become ` +
        `the thing future gate changes are diffed against.`,
    )

  const all = readLeadStore(leadsPath).leads ?? []
  const leads = all.filter((l) => status === "all" || l.status === status)

  // Repost history is built from EVERY lead, dismissed ones included and
  // whatever --status narrows the audit to: a lead dismissed three weeks ago is
  // precisely the evidence that today's identical posting is a repost.
  const history = buildHistory(all, { now })

  const t0 = Date.now()
  const current = leads.map((l) => {
    const v = evaluateStages(l, {
      limits,
      now,
      profileYears,
      profileTech,
      keywords: keywords.get(l.id),
      history,
    })
    return {
      id: l.id,
      company: l.company,
      title: l.title,
      ok: v.ok,
      stage: v.stage,
      reasons: v.reasons,
      flags: v.flags,
    }
  })
  const ms = Date.now() - t0

  const previous = fs.existsSync(baselinePath)
    ? JSON.parse(fs.readFileSync(baselinePath, "utf8"))
    : null
  const diff = diffAudit(previous, current)
  const stats = summarize(current)

  // `keywordError` outranks --save: see the load site above.
  if (save && !keywordError) {
    fs.mkdirSync(path.dirname(baselinePath), { recursive: true })
    fs.writeFileSync(
      baselinePath,
      JSON.stringify(
        { recorded_at: now.toISOString(), leads: current },
        null,
        2,
      ),
    )
  }

  if (asJson) {
    console.log(
      JSON.stringify({ ms, stats, diff, baseline: baselinePath }, null, 2),
    )
  } else if (isTerse()) {
    for (const r of diff.newlyRejected) {
      console.log(
        `REGRESSION|${r.stage}|${r.id}|${r.company}|${r.reasons.join(" ")}`,
      )
    }
    for (const r of diff.newlyAccepted) {
      console.log(`recovered|was=${r.was}|${r.id}|${r.company}`)
    }
    const by = Object.entries(stats.rejected_by)
      .filter(([, n]) => n)
      .map(([s, n]) => `${s}=${n}`)
      .join(" ")
    console.log(
      `audited=${stats.total} passing=${stats.passing} ${by} compared=${diff.compared} newly_rejected=${diff.newlyRejected.length} newly_accepted=${diff.newlyAccepted.length} ms=${ms}`,
    )
  } else {
    console.log(
      `\nAudited ${stats.total} lead(s) through ${STAGE_IDS.length} stages in ${ms} ms.\n`,
    )
    console.log(`  ${stats.passing} pass every stage`)
    for (const [s, n] of Object.entries(stats.rejected_by)) {
      if (n) console.log(`  ${n} rejected at ${s} (${STAGE_LABELS[s]})`)
    }
    if (!previous) {
      console.log("\nNo previous baseline — this run becomes the baseline.")
    } else {
      console.log(
        `\nCompared against ${diff.compared} lead(s) in the baseline.`,
      )
      if (diff.newlyRejected.length) {
        console.log(
          `\n!! ${diff.newlyRejected.length} lead(s) NEWLY REJECTED — check each one:\n`,
        )
        for (const r of diff.newlyRejected) {
          console.log(`  ${r.company} — ${r.title}`)
          console.log(`    ${r.stage}: ${r.reasons.join("; ")}`)
        }
      } else {
        console.log("No lead became newly rejected.")
      }
      if (diff.newlyAccepted.length) {
        console.log(`\n${diff.newlyAccepted.length} lead(s) recovered:`)
        for (const r of diff.newlyAccepted) {
          console.log(`  ${r.company} — ${r.title} (was rejected at ${r.was})`)
        }
      }
      if (diff.stageMoved.length) {
        console.log(
          `\n${diff.stageMoved.length} still-rejected lead(s) changed which stage caught them:`,
        )
        for (const r of diff.stageMoved) {
          console.log(`  ${r.company}: ${r.was} -> ${r.stage}`)
        }
      }
    }
    if (save) console.log(`\nBaseline written to ${baselinePath}`)
  }

  process.exit(diff.newlyRejected.length ? 1 : 0)
}

const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (isMain) main()
