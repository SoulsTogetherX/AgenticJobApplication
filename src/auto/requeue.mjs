#!/usr/bin/env node
// Put one stranded queue row back to work.
//
// ===========================================================================
// WHY A COMMAND EXISTS FOR THIS
// ===========================================================================
//
// `auto_queue` had terminal states with no way back. The only door out was
// `enqueueAutoJobs`' conflict clause (db.mjs), which fires ONLY for a row that
// is `deferred` with a requeueable kind AND whose slug independently re-wins
// selection in the same invocation. The only other lever was
// `migrate.mjs --reset-queue`, which deletes the entire queue — including
// every legitimate `submitted` row, which is the `posted_at` half of the
// latency statistic and the whole `wall_ms` sample.
//
// Four populations were stranded behind that (measured 2026-08-24):
//
//   * a dry run's terminal row (fixed at source in job.mjs — a rehearsal is
//     now `deferred/rehearsed` — but rows written before that fix are still
//     sitting in the store, and this is what clears them);
//   * `deferred` rows whose kind is deliberately not requeueable, when the
//     design's assumption turns out to be wrong for a specific job;
//   * `deferred` rows with a requeueable kind whose LEAD was since dismissed —
//     reported by the digest as `requeueable` while being permanently
//     unreachable, because selection turns them away before the clause runs;
//   * `attempted` rows, which this command REFUSES. See below.
//
// ===========================================================================
// WHAT THIS REFUSES, AND WHY THAT IS THE POINT
// ===========================================================================
//
// `attempted` means a click went out and nothing recorded what came back. The
// row says an application MAY exist at an employer. Re-queuing it invites a
// SECOND application to a real company, which is the one failure this whole
// subsystem is built to avoid, and no flag here overrides it — that is
// reconcile.mjs's problem and, on today's boards, a human's.
//
// `submitted` is refused for the mirror reason: the application went out and
// the row is the record of it.
//
// Usage:
//   node src/auto/requeue.mjs --list
//   node src/auto/requeue.mjs <slug> [--reason "why"] [--db <file>]
//
// Exit codes: 0 ok, 1 nothing matched, 2 usage.
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { openDb, AUTO_REQUEUEABLE_KINDS } from "#lib/db.mjs"
import { assertKnownFlags, positionals } from "#lib/args.mjs"

export const REQUEUE_FLAGS = ["--list", "--reason", "--db", "--json", "--help"]
export const REQUEUE_VALUE_FLAGS = ["--reason", "--db"]

// A click may already have landed for these. Nothing here may move them.
export const REQUEUE_REFUSED = Object.freeze({
  attempted:
    "a click went out and no acknowledgement was recorded, so an application " +
    "may already exist at this employer. Re-queuing risks sending a second " +
    "one. Resolve it as an orphan instead — this command will not move it.",
  submitted:
    "this application was sent and the row is the record of it. Re-queuing " +
    "would send a second one.",
  challenged:
    "a click went out and the page came back a challenge, so it is unknown " +
    "whether the application landed. Same risk as 'attempted'.",
})

/**
 * Did a LIVE submit actually happen for this slug?
 *
 * THE QUEUE ROW'S STATE IS NOT EVIDENCE ON ITS OWN, and that is the whole
 * reason this function exists. `auto_queue` has a single slug key and no mode
 * column, so before 2026-08-24 a dry run wrote a terminal `submitted` row that
 * is indistinguishable — by state alone — from a real application. Refusing on
 * the state would strand exactly the rows this command was written to rescue.
 *
 * `auto_submissions` is the ledger that got the keying right: PRIMARY KEY
 * (slug, mode), with db.mjs:243-250 explaining why. So the honest question is
 * not "what does the queue say" but "is there a live row in the mode-keyed
 * ledger", and that is answerable mechanically.
 *
 * FAILS CLOSED. Any doubt — an unreadable table, an attempt with no
 * acknowledgement, a row whose mode is null (stored as live by design, see
 * submissions.test.mjs "a mode-less row is stored as live") — reports true, so
 * the caller refuses. A false "nothing was sent" is the one error here that
 * sends a second application to a real employer.
 */
export function hasLiveSubmission(db, slug) {
  try {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS n FROM auto_submissions
          WHERE slug = $slug AND (mode IS NULL OR mode <> 'dry_run')`,
      )
      .get({ slug })
    return (row?.n ?? 1) > 0
  } catch {
    return true
  }
}

/**
 * Rows a human might plausibly want back, with why each is or is not movable.
 * Read-only.
 */
export function listRequeueable(db) {
  const rows = db
    .prepare(
      `SELECT slug, state, reason_kind, reason_detail, attempt_no, updated_at
         FROM auto_queue
        WHERE state IN ('deferred','submitted','attempted','challenged','failed')
        ORDER BY updated_at DESC`,
    )
    .all()
  return rows.map((r) => {
    let refused = REQUEUE_REFUSED[r.state] ?? null
    // A `submitted` row with no live ledger entry is a REHEARSAL ARTEFACT, not
    // an application. Corroborated, never assumed — see hasLiveSubmission.
    if (r.state === "submitted" && !hasLiveSubmission(db, r.slug))
      refused = null
    return {
      ...r,
      movable: !refused,
      // A row can be movable by this command and still never be picked up by
      // `--enqueue`, because selection runs first and may turn its lead away.
      // Saying "requeueable" without saying that is how the digest ended up
      // reporting six permanently-unreachable rows as ready to go.
      autoRequeues:
        r.state === "deferred" &&
        AUTO_REQUEUEABLE_KINDS.includes(r.reason_kind),
      refused,
    }
  })
}

/**
 * Move one row back to 'queued'.
 *
 * @returns {{ok:boolean, slug:string, from?:string, reason?:string}}
 */
export function requeueSlug(db, slug, { reason = null } = {}) {
  const row = db
    .prepare("SELECT slug, state FROM auto_queue WHERE slug = ?")
    .get(slug)
  if (!row) return { ok: false, slug, reason: "no queue row for that slug" }
  let refused = REQUEUE_REFUSED[row.state]
  // Same corroboration as --list: a terminal `submitted` written by a dry run
  // records no application, and the mode-keyed ledger is what proves it.
  if (row.state === "submitted" && !hasLiveSubmission(db, slug)) refused = null
  if (refused) return { ok: false, slug, from: row.state, reason: refused }
  // A STATED REASON, always. The queue already refuses a deferral with no
  // reason (tests/auto/queue.test.mjs: "a silent skip is not a deferral"); a
  // requeue with no reason is the same hole pointing the other way, and this
  // row is about to be re-attempted against a real employer.
  const detail = `requeued by hand: ${reason || "no reason given"}`
  db.prepare(
    `UPDATE auto_queue
        SET state = 'queued', reason_kind = NULL, reason_stage = NULL,
            reason_detail = $detail, updated_at = $at
      WHERE slug = $slug`,
  ).run({ slug, detail, at: new Date().toISOString() })
  return { ok: true, slug, from: row.state }
}

function main(argv = process.argv.slice(2)) {
  if (argv.includes("--help") || !argv.length) {
    process.stdout.write(
      "requeue.mjs — put one stranded auto_queue row back to 'queued'\n\n" +
        "  --list            show every non-working row and whether it can move\n" +
        "  <slug>            the row to re-queue\n" +
        "  --reason <text>   why (recorded on the row)\n" +
        "  --db <file>       the store. Defaults to jobs/leads.db\n\n" +
        "Refuses 'attempted', 'submitted' and 'challenged': a click may " +
        "already have landed.\n",
    )
    return argv.length ? 0 : 2
  }
  try {
    assertKnownFlags(argv, {
      known: REQUEUE_FLAGS,
      valueFlags: REQUEUE_VALUE_FLAGS,
      script: "requeue.mjs",
      note: "this command re-arms a job for a real submit",
    })
  } catch (e) {
    process.stderr.write(`${e.message}\n`)
    return e.exitCode ?? 2
  }

  const dbAt = argv.indexOf("--db")
  const db = openDb(dbAt === -1 ? undefined : argv[dbAt + 1])
  try {
    if (argv.includes("--list")) {
      const rows = listRequeueable(db)
      if (argv.includes("--json")) {
        process.stdout.write(`${JSON.stringify(rows)}\n`)
        return 0
      }
      for (const r of rows)
        process.stdout.write(
          `${r.movable ? "movable" : "REFUSED"}\t${r.state}\t${r.slug}\t` +
            `${r.reason_kind ?? "-"}` +
            (r.autoRequeues ? "\t(the next --enqueue would retry this)" : "") +
            "\n",
        )
      process.stdout.write(
        `rows=${rows.length} movable=${rows.filter((r) => r.movable).length}\n`,
      )
      return 0
    }

    const reasonAt = argv.indexOf("--reason")
    const slug = positionals(argv, REQUEUE_VALUE_FLAGS)[0]
    if (!slug) {
      process.stderr.write("no slug given. Try --list.\n")
      return 2
    }
    const out = requeueSlug(db, slug, {
      reason: reasonAt === -1 ? null : argv[reasonAt + 1],
    })
    process.stdout.write(
      out.ok
        ? `requeued\t${out.slug}\t(was ${out.from})\n`
        : `REFUSED\t${out.slug}\t${out.reason}\n`,
    )
    return out.ok ? 0 : 1
  } finally {
    db.close()
  }
}

const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (isMain) process.exit(main())

export { main }
