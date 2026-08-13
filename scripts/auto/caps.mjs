// The blast-radius arithmetic, and NOTHING else.
//
// WHY IT IS ITS OWN FILE. It used to live in audit.mjs, which made audit.mjs a
// dependency of authorize.mjs (the gate needs the caps) — and that meant
// audit.mjs could not import the gate back to check a submit token without an
// import cycle. The concession that followed was beginSubmit taking its token
// OPTIONALLY, and an optional check is not a check.
//
// The shared leaf goes in a leaf module: caps.mjs imports only db.mjs, both
// audit.mjs and authorize.mjs import caps.mjs, and authorize.mjs is free to be
// imported by audit.mjs. Two alternatives were considered and rejected before
// this one:
//
//   * having the CALLER inject capCheck into authorizeSubmit — which puts the
//     runner back in charge of supplying its own control, the exact shape this
//     whole inversion exists to remove;
//   * a dynamic import() inside authorizeSubmit — which makes the gate async
//     and hides the dependency. An async gate at a click site is the one
//     function nobody should have to reason hard about.
//
// Nothing here writes. It reads two ledgers and returns a verdict.
import {
  openDb,
  countAutoSubmissions,
  companySubmissionBreakdown,
  DB_PATH,
} from "../lib/db.mjs"


/**
 * The cap arithmetic, answered from the ledgers rather than from a counter the
 * runner keeps in memory (which resets when the runner dies and forgets what it
 * sent this morning).
 *
 * `caps` comes from docs/application-limits.yaml's auto_apply block — the
 * USER'S file. Nothing here supplies defaults for it: a missing cap reads as
 * "not configured" and this returns a refusal, because an unattended process
 * inventing its own blast radius is precisely the failure the block exists to
 * prevent.
 */
export function capCheck({
  company,
  caps,
  sentThisRun = 0,
  dbFile = DB_PATH,
  now = new Date(),
} = {}) {
  const per_run = caps?.per_run_max
  const per_day = caps?.per_day_max
  const per_company_week = caps?.per_company_max_per_week
  const missing = []
  if (!Number.isFinite(per_run)) missing.push("per_run_max")
  if (!Number.isFinite(per_day)) missing.push("per_day_max")
  if (!Number.isFinite(per_company_week))
    missing.push("per_company_max_per_week")
  if (missing.length) {
    return {
      ok: false,
      reason: `auto_apply caps not configured: ${missing.join(", ")}`,
      counts: null,
    }
  }

  if (sentThisRun >= per_run) {
    return {
      ok: false,
      reason: `per_run_max reached (${sentThisRun}/${per_run})`,
      counts: { run: sentThisRun },
    }
  }

  const dayAgo = new Date(now.getTime() - 24 * 3600 * 1000).toISOString()
  const weekAgo = new Date(now.getTime() - 7 * 24 * 3600 * 1000).toISOString()
  const db = openDb(dbFile)
  try {
    const day = countAutoSubmissions(db, dayAgo)
    const byMode = companySubmissionBreakdown(db, company, weekAgo)
    const week = byMode.total
    const counts = { run: sentThisRun, day, company: week, byMode }
    if (day >= per_day) {
      return {
        ok: false,
        reason: `per_day_max reached (${day}/${per_day})`,
        counts,
      }
    }
    if (week >= per_company_week) {
      // ITEMISED, because the reason has to be one the user can act on and the
      // unitemised version misattributed. Dry-run rows count toward this cap on
      // purpose (the rehearsal must exercise the arithmetic the live run will),
      // so five dry runs against one employer followed by a live enable refuse
      // every application to that employer — and the old string blamed "manual
      // applications", sending the user to look through a ledger that says
      // nothing of the kind. Each source is named, and only when it is non-zero.
      const parts = []
      if (byMode.live) parts.push(`${byMode.live} auto-submitted`)
      if (byMode.dry_run)
        parts.push(
          `${byMode.dry_run} from dry runs (rehearsals, counted on purpose)`,
        )
      if (byMode.manual) parts.push(`${byMode.manual} applied manually`)
      return {
        ok: false,
        reason:
          `per_company_max_per_week reached for ${company} (${week}/${per_company_week}): ` +
          (parts.join(", ") || "no source recorded"),
        counts,
      }
    }
    return { ok: true, reason: null, counts }
  } finally {
    db.close()
  }
}
