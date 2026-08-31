// Resolving an orphaned submit attempt (§4.9). Phase 5 W2.
//
// ===========================================================================
// THE ORPHAN, AND WHY IT IS WORTH A WHOLE MODULE
// ===========================================================================
//
// submit.mjs writes the durable `(slug, mode)` attempt row BEFORE the click
// (precondition 7), because "an attempt is a submission until proven
// otherwise". A process killed between the click returning and the
// acknowledgement being written therefore leaves a row saying an application
// MAY exist at an employer, with nothing able to say whether it does.
//
// Before scoping, one such row halted every future invocation until a human
// deleted a file. §4.9's instruction is precise about the fix and about what
// the fix is not: **do not weaken the protection — make it mechanically
// resolvable, and scope the halt.** The scoping half landed with `raiseStop`'s
// `company` scope. This file is the resolving half.
//
// ===========================================================================
// THE HONEST LIMIT, WHICH IS WORSE THAN IT SOUNDS AND IS STATED FIRST ON PURPOSE
// ===========================================================================
//
// Reconciliation by re-reading the board works only where the board exposes
// application state to a candidate. On the recommended launch allowlist that is
// CLOSE TO NONE OF IT:
//
//   * Lever hosted boards   — no candidate login, no already-applied state.
//   * Ashby hosted boards   — the same.
//   * Greenhouse            — exposes it only through a MyGreenhouse account,
//                             which needs exactly the logged-in session §6.4
//                             excluded as a structural security control.
//
// So this module ships DESCOPED to the boards that can answer, and on today's
// allowlist that set is empty. `reconcile()` returns `undecidable` for all of
// them, which brakes ONE COMPANY and lets the other 998 run — the real win,
// and the only one available. §6.7 puts the confirmation email, the one
// applicant-observable proof on these three boards, to the user as a consent
// decision; until that is answered a human adjudicates one slug.
//
// This paragraph is here rather than in a design document because the tempting
// mistake is to read `reconcile.mjs` in a file listing and conclude orphans are
// handled. They are handled the way §4.9 says: narrowly, and mostly by telling
// the user exactly which one slug needs a person.
//
// ===========================================================================
// WHAT IT MAY NOT DO
// ===========================================================================
//
// **It never clicks a control** (§4.9, and tests/auto/click-surface.test.mjs
// enforces the absence). It re-opens a URL and reads. A reconciler that could
// click could re-submit the very application it was sent to ask about, which is
// the one irreversible mistake in this whole subsystem.
//
// It also never RESOLVES OPTIMISTICALLY. `undecidable` is the default and every
// error path lands on it: a nav timeout, an unparseable page, a board with no
// probe, a probe that throws. Resolving an orphan to `reconciled-not-sent`
// releases the (slug, mode) claim and lets the runner apply to that posting
// again, so guessing "probably not sent" is guessing in the direction of a
// duplicate application.
import {
  openDb,
  DB_PATH,
  readOrphanAttempts,
  acknowledgeAutoSubmission,
  setAutoJobState,
  RECONCILED_NOT_SENT,
} from "#lib/db.mjs"
import { classify } from "./classify.mjs"
import { safeText } from "./untrusted-text.mjs"
import { raiseStop, JOBS_DIR, STOP_PATH } from "./guard.mjs"

/** What a probe may conclude. `undecidable` is the default, not a fallback. */
export const VERDICTS = Object.freeze([
  "submitted", // the board shows the application exists
  "not-sent", // the board shows it does not
  "undecidable", // anything else, including every error
])

/**
 * The per-board probes.
 *
 * DELIBERATELY EMPTY FOR EVERY PRODUCTION BOARD, and the emptiness is the
 * finding rather than a gap somebody forgot. See the honest limit above: none
 * of Greenhouse, Lever or Ashby exposes candidate-visible application state
 * without the logged-in session the design excludes.
 *
 * A probe is `async (page, {applyUrl, slug}) -> {verdict, why, confirmationUrl}`
 * and MUST NOT click. The fixture probe below exists so the resolution path,
 * the DB transition and the kill-between-click-and-ack recovery are all
 * exercised by a test rather than shipped unrun.
 */
export const PROBES = new Map([
  [
    "fixture",
    async (page, { applyUrl }) => {
      // Read-only: navigate and classify. `classify` is the same pure function
      // the post-click path uses, so the fixture's confirmation page means the
      // same thing here as it does there.
      await page.goto(applyUrl, { waitUntil: "domcontentloaded" })
      const url = page.url()
      const html = await page.content()
      const { kind, why } = classify(url, html)
      if (kind === "confirmation")
        return { verdict: "submitted", why, confirmationUrl: url }
      if (kind === "posting-gone")
        // THE POSTING IS GONE, WHICH IS NOT EVIDENCE EITHER WAY. A req taken
        // down after a successful submit looks identical to one taken down
        // before it. Reading this as `not-sent` would release the claim on a
        // posting the user may well have applied to.
        return {
          verdict: "undecidable",
          why: "the posting is gone, which says nothing about whether the application landed",
        }
      return { verdict: "undecidable", why }
    },
  ],
])

/**
 * Resolve one orphan.
 *
 * @param orphan   a row from readOrphanAttempts.
 * @param openPage async () -> {page, close}. Injected, exactly as job.mjs
 *   injects its stages: this module must not decide which browser lane it is
 *   on, and a test must be able to drive it without Chromium.
 * @returns {{slug, verdict, why, outcome, confirmationUrl}}
 */
export async function reconcileOne(
  orphan,
  { openPage = null, probes = PROBES, dbFile = DB_PATH, db = null } = {},
) {
  const slug = orphan?.slug
  const board = orphan?.board_key ?? orphan?.board ?? null
  const probe = board ? probes.get(board) : null

  let verdict = "undecidable"
  let why = probe
    ? "the probe returned nothing"
    : `no reconciler probe for board ${safeText(board ?? "(none recorded)", 40)} — ` +
      `this board exposes no candidate-visible application state, so a human ` +
      `adjudicates this one slug`
  let confirmationUrl = null

  if (probe && typeof openPage === "function") {
    let session = null
    try {
      session = await openPage()
      const got = await probe(session.page, {
        applyUrl: orphan.apply_url,
        slug,
      })
      if (VERDICTS.includes(got?.verdict)) {
        verdict = got.verdict
        why = safeText(got.why ?? "no reason given", 200)
        confirmationUrl = got.confirmationUrl ?? null
      }
    } catch (e) {
      // EVERY error path lands on undecidable. A reconciler that resolved on a
      // timeout would release the claim on the strength of the network being
      // slow.
      verdict = "undecidable"
      why = `the probe could not decide: ${safeText(e?.message ?? e, 160)}`
    } finally {
      try {
        await session?.close?.()
      } catch {
        /* a leaked page must not turn a decision into an error */
      }
    }
  }

  const outcome =
    verdict === "submitted"
      ? "submitted"
      : verdict === "not-sent"
        ? RECONCILED_NOT_SENT
        : null

  if (outcome) writeResolution({ orphan, outcome, confirmationUrl, dbFile, db })

  return { slug, verdict, why, outcome, confirmationUrl }
}

/**
 * The ledger row and the queue row, in ONE transaction.
 *
 * §4.9 requires it: resolving the submission while leaving the queue row
 * non-terminal (or the reverse) produces exactly the half-state the whole
 * ledger exists to make impossible, and a crash between two separate writes is
 * not a rare case at this volume — it is the case this module was written for.
 */
function writeResolution({ orphan, outcome, confirmationUrl, dbFile, db }) {
  const owned = !db
  const conn = db ?? openDb(dbFile)
  try {
    conn.exec("BEGIN IMMEDIATE")
    try {
      acknowledgeAutoSubmission(conn, {
        run_id: orphan.run_id,
        slug: orphan.slug,
        company: orphan.company ?? null,
        mode: orphan.mode ?? "live",
        apply_url: orphan.apply_url ?? null,
        confirmation_url: confirmationUrl,
        outcome,
        reconciled: true,
      })
      setAutoJobState(
        conn,
        orphan.slug,
        outcome === "submitted" ? "submitted" : "deferred",
        outcome === "submitted"
          ? {}
          : {
              reason_kind: "reconciled-not-sent",
              reason_stage: "post-submit",
              reason_detail:
                "the board was asked and shows no application; the (slug, mode) claim was released",
            },
      )
      conn.exec("COMMIT")
    } catch (e) {
      conn.exec("ROLLBACK")
      throw e
    }
  } finally {
    if (owned) conn.close()
  }
}

/**
 * Resolve every orphan, and brake the companies that could not be resolved.
 *
 * @returns {{resolved, undecidable, blocked}} — counts and the company keys now
 *   braked, so the run report says how much was held back as a NUMBER.
 */
export async function reconcileAll({
  dbFile = DB_PATH,
  openPage = null,
  probes = PROBES,
  stopPath = STOP_PATH,
  stopsDir = null,
  jobsDir = JOBS_DIR,
  notify = undefined,
} = {}) {
  const db = openDb(dbFile)
  let orphans
  try {
    orphans = readOrphanAttempts(db)
  } finally {
    db.close()
  }

  const results = []
  for (const o of orphans)
    results.push(await reconcileOne(o, { openPage, probes, dbFile }))

  const blocked = []
  for (const r of results) {
    if (r.verdict !== "undecidable") continue
    const orphan = orphans.find((o) => o.slug === r.slug)
    const company =
      typeof orphan?.company === "string" ? orphan.company.trim() : ""
    raiseStop(
      `an orphaned submit attempt for "${r.slug}" at ` +
        `${orphan?.apply_url ?? "url not recorded"} could not be resolved ` +
        `automatically: ${r.why}\n` +
        `Open that page, log or withdraw as appropriate, then delete this file. ` +
        `Nothing else is held back.`,
      {
        ...(company ? { scope: "company", key: company } : {}),
        stopPath,
        stopsDir,
        jobsDir,
        meta: { slug: r.slug, verdict: r.verdict },
        ...(notify === undefined ? {} : { notify }),
      },
    )
    if (company) blocked.push(company)
  }

  return {
    resolved: results.filter((r) => r.verdict !== "undecidable").length,
    undecidable: results.filter((r) => r.verdict === "undecidable").length,
    results,
    blocked,
  }
}
