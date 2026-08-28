// Resolving an orphaned submit attempt (§4.9, Phase 5 W2).
//
// The orphan is the state a SIGKILL between the click returning and the
// acknowledgement being written leaves behind: a durable row saying an
// application MAY exist at an employer, with nothing able to say whether it
// does. W2's check is that this resolves "without a human".
//
// MOST OF THESE TESTS ARE THE RECONCILER REFUSING TO DECIDE, and that is the
// design rather than a shortfall. Resolving an orphan to `reconciled-not-sent`
// releases the (slug, mode) claim and lets the runner apply to that posting
// again — so an optimistic guess here is a guess in the direction of a
// duplicate application, which is the most reputation-destroying failure on
// record for this class of tool.
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  reconcileOne,
  reconcileAll,
  PROBES,
  VERDICTS,
} from "../../src/auto/reconcile.mjs"
import {
  openDb,
  recordAutoSubmission,
  readAutoSubmission,
  countAutoSubmissions,
  enqueueAutoJobs,
  readAutoQueue,
  readOrphanAttempts,
  RECONCILED_NOT_SENT,
} from "#lib/db.mjs"
import { readStop, scopedStopPath } from "../../src/auto/guard.mjs"

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aj-reconcile-"))
  const jobsDir = path.join(root, "jobs")
  fs.mkdirSync(path.join(jobsDir, ".auto"), { recursive: true })
  return {
    root,
    jobsDir,
    dbFile: path.join(jobsDir, "leads.db"),
    stopPath: path.join(jobsDir, ".auto", "STOP"),
  }
}

/** The state a kill between click-return and acknowledgement leaves: the
 *  durable attempt row exists, nothing resolved it. */
function orphan(s, { slug = "acme-dev", company = "Acme", board = null } = {}) {
  const db = openDb(s.dbFile)
  try {
    enqueueAutoJobs(db, [
      { slug, run_id: "run-1", board_key: board, origin: "https://b.test" },
    ])
    recordAutoSubmission(db, {
      run_id: "run-1",
      slug,
      company,
      mode: "live",
      outcome: "attempted",
      apply_url: `https://b.test/apply/${slug}`,
      submitted_at: new Date().toISOString(),
    })
    // READ THE ORPHAN BACK OUT OF THE STORE rather than hand-building one.
    //
    // This function used to return a literal carrying `board_key`, and
    // readOrphanAttempts could not produce that shape: it selected from
    // auto_submissions, which has no such column. reconcile.mjs dispatches its
    // probe on exactly that field, so in production `orphan.board_key` was
    // ALWAYS undefined and every orphan fell through to `probe = null` — the
    // module could resolve nothing, including its own loopback fixture. The
    // test passed throughout, because the fixture was more capable than
    // production.
    //
    // A fixture that can express a shape the code cannot is not a fixture, it
    // is a second implementation. readOrphanAttempts now joins auto_queue for
    // the board key, and this reads the real row.
    const rows = readOrphanAttempts(db)
    const row = rows.find((r) => r.slug === slug)
    assert.ok(row, "the orphan must be readable through readOrphanAttempts")
    return row
  } finally {
    db.close()
  }
}

/** An injected page, so nothing here needs Chromium. */
const pageServing =
  (html, url = "http://127.0.0.1:1/x") =>
  async () => ({
    page: {
      goto: async () => {},
      url: () => url,
      content: async () => html,
    },
    close: async () => {},
  })

// --- the honest limit, asserted rather than described --------------------------

test("no production board has a probe, and an orphan there is undecidable", () => {
  // §4.9's honest limit: Lever and Ashby expose no candidate-visible
  // application state at all, and Greenhouse exposes it only behind the
  // logged-in session §6.4 excluded as a security control. This test exists so
  // that reading `reconcile.mjs` in a file listing cannot be mistaken for
  // orphans being handled.
  for (const board of ["greenhouse", "lever", "ashby"])
    assert.equal(PROBES.has(board), false, `${board} must have no probe`)
})

test("an orphan on a board with no probe resolves to nothing, and says why", async () => {
  const s = sandbox()
  const o = orphan(s, { board: "greenhouse" })
  const got = await reconcileOne(o, { dbFile: s.dbFile })
  assert.equal(got.verdict, "undecidable")
  assert.equal(got.outcome, null)
  assert.match(got.why, /no reconciler probe for board greenhouse/)
  assert.match(got.why, /a human adjudicates this one slug/)

  const row = readAutoSubmission(openDb(s.dbFile), o.slug, "live")
  assert.equal(row.outcome, "attempted", "and the row is untouched")
})

// --- what a probe may conclude --------------------------------------------------

test("a confirmation on the board resolves the orphan to submitted", async () => {
  const s = sandbox()
  const o = orphan(s, { board: "fixture" })
  const html = fs.readFileSync(
    path.resolve(
      path.dirname(new URL(import.meta.url).pathname.slice(1)),
      "..",
      "fixtures",
      "boards",
      "pages",
      "post-submit",
      "confirmation.html",
    ),
    "utf8",
  )
  const got = await reconcileOne(o, {
    dbFile: s.dbFile,
    openPage: pageServing(html),
  })
  assert.equal(got.verdict, "submitted")
  assert.equal(got.outcome, "submitted")
  assert.ok(got.confirmationUrl)

  const db = openDb(s.dbFile)
  try {
    assert.equal(readAutoSubmission(db, o.slug, "live").outcome, "submitted")
    assert.equal(
      readAutoQueue(db).find((r) => r.slug === o.slug).state,
      "submitted",
    )
  } finally {
    db.close()
  }
})

test("a POSTING-GONE page is undecidable, not a resolution", async () => {
  // The trap. A req taken down AFTER a successful submit looks identical to one
  // taken down before it, so "the posting is gone" is evidence about the
  // posting and none at all about the application. Reading it as not-sent would
  // release the claim on a posting the user may well have applied to.
  const s = sandbox()
  const o = orphan(s, { board: "fixture" })
  const got = await reconcileOne(o, {
    dbFile: s.dbFile,
    openPage: pageServing(
      "<h1>This position is no longer available</h1>" +
        "<p>no longer accepting applications</p>",
    ),
  })
  assert.equal(got.verdict, "undecidable")
  assert.match(got.why, /says nothing about whether the application landed/)
  assert.equal(
    readAutoSubmission(openDb(s.dbFile), o.slug, "live").outcome,
    "attempted",
  )
})

test("every error path lands on undecidable, never on a resolution", async () => {
  const s = sandbox()
  for (const openPage of [
    async () => {
      throw new Error("browser would not launch")
    },
    async () => ({
      page: {
        goto: async () => {
          throw new Error("nav timeout")
        },
        url: () => "x",
        content: async () => "",
      },
      close: async () => {},
    }),
    async () => ({
      page: {
        goto: async () => {},
        url: () => "http://127.0.0.1/x",
        content: async () => {
          throw new Error("page went away")
        },
      },
      close: async () => {},
    }),
  ]) {
    const o = orphan(s, { slug: `s-${Math.random()}`, board: "fixture" })
    const got = await reconcileOne(o, { dbFile: s.dbFile, openPage })
    assert.equal(got.verdict, "undecidable", got.why)
    assert.equal(got.outcome, null)
  }
})

test("a probe returning nonsense cannot resolve anything", async () => {
  const s = sandbox()
  const o = orphan(s, { board: "made-up" })
  const probes = new Map([["made-up", async () => ({ verdict: "probably" })]])
  const got = await reconcileOne(o, {
    dbFile: s.dbFile,
    probes,
    openPage: pageServing("<p>x</p>"),
  })
  assert.equal(got.verdict, "undecidable")
  assert.ok(VERDICTS.includes(got.verdict))
})

// --- reconciled-not-sent, and the deadlock it exists to prevent -----------------

test("a not-sent resolution RELEASES the claim, so the slug is appliable again", async () => {
  // §4.9's C-material correction. Under a plain DO NOTHING the resolved row
  // still occupied (slug, mode) forever: the slug would report 0 changes on
  // every future run, fail as `db-write-failed` each time, and after two in a
  // row pause the board. A posting nobody applied to would become permanently
  // unappliable, loudly, for the rest of the machine's life.
  const s = sandbox()
  const o = orphan(s, { board: "says-no" })
  const probes = new Map([
    ["says-no", async () => ({ verdict: "not-sent", why: "board says none" })],
  ])
  const got = await reconcileOne(o, {
    dbFile: s.dbFile,
    probes,
    openPage: pageServing(""),
  })
  assert.equal(got.outcome, RECONCILED_NOT_SENT)

  const db = openDb(s.dbFile)
  try {
    assert.equal(
      readAutoSubmission(db, o.slug, "live").outcome,
      RECONCILED_NOT_SENT,
    )
    assert.equal(
      recordAutoSubmission(db, {
        run_id: "run-2",
        slug: o.slug,
        company: "Acme",
        mode: "live",
        outcome: "attempted",
        apply_url: o.apply_url,
      }),
      1,
      "a later run may claim this slug again",
    )
    assert.equal(
      readAutoSubmission(db, o.slug, "live").run_id,
      "run-2",
      "and the claim now belongs to that run",
    )
  } finally {
    db.close()
  }
})

test("EVERY OTHER outcome still holds the claim", () => {
  // The narrowness of the exception, which is the whole reason it is safe.
  const s = sandbox()
  const db = openDb(s.dbFile)
  try {
    for (const outcome of ["attempted", "submitted", "abandoned"]) {
      const slug = `slug-${outcome}`
      assert.equal(
        recordAutoSubmission(db, {
          run_id: "run-1",
          slug,
          mode: "live",
          outcome,
        }),
        1,
      )
      assert.equal(
        recordAutoSubmission(db, {
          run_id: "run-2",
          slug,
          mode: "live",
          outcome: "attempted",
        }),
        0,
        `${outcome} must still refuse a second claim`,
      )
    }
  } finally {
    db.close()
  }
})

test("a reconciled-not-sent row does not spend cap budget", () => {
  // It is an application that provably never happened. Counting it would spend
  // the user's daily budget on nothing.
  const s = sandbox()
  const db = openDb(s.dbFile)
  const since = "2000-01-01T00:00:00.000Z"
  try {
    recordAutoSubmission(db, {
      run_id: "r",
      slug: "counted",
      mode: "live",
      outcome: "attempted",
    })
    assert.equal(countAutoSubmissions(db, since), 1)
    recordAutoSubmission(db, {
      run_id: "r",
      slug: "not-sent",
      mode: "live",
      outcome: RECONCILED_NOT_SENT,
    })
    assert.equal(
      countAutoSubmissions(db, since),
      1,
      "the reconciled row must not count",
    )
  } finally {
    db.close()
  }
})

// --- the whole sweep -------------------------------------------------------------

test("reconcileAll brakes ONE COMPANY per undecidable orphan, and no more", async () => {
  const s = sandbox()
  orphan(s, { slug: "a", company: "Acme", board: "greenhouse" })
  orphan(s, { slug: "b", company: "Globex", board: "lever" })

  const got = await reconcileAll({
    dbFile: s.dbFile,
    stopPath: s.stopPath,
    jobsDir: s.jobsDir,
    notify: () => {},
  })
  assert.equal(got.undecidable, 2)
  assert.equal(got.resolved, 0)
  assert.deepEqual(got.blocked.sort(), ["Acme", "Globex"])

  const at = (key) =>
    readStop({
      stopPath: scopedStopPath("company", key, { stopPath: s.stopPath }),
    })
  assert.match(at("Acme"), /orphaned submit attempt for "a"/)
  assert.match(at("Globex"), /orphaned submit attempt for "b"/)
  assert.match(at("Acme"), /Nothing else is held back/)
  assert.equal(
    readStop({ stopPath: s.stopPath }),
    null,
    "and NOTHING global — that is the whole point of §4.9",
  )
})

test("an orphan with no company still stops everything", async () => {
  // The pessimistic fallback. A brake has to be filed against something, and
  // "an application may exist and we cannot say where" is not a case to be
  // optimistic about.
  const s = sandbox()
  orphan(s, { slug: "a", company: null, board: "greenhouse" })
  await reconcileAll({
    dbFile: s.dbFile,
    stopPath: s.stopPath,
    jobsDir: s.jobsDir,
    notify: () => {},
  })
  assert.match(readStop({ stopPath: s.stopPath }), /orphaned submit attempt/)
})

test("a clean database reconciles to nothing and brakes nothing", async () => {
  const s = sandbox()
  openDb(s.dbFile).close()
  const got = await reconcileAll({
    dbFile: s.dbFile,
    stopPath: s.stopPath,
    jobsDir: s.jobsDir,
    notify: () => {},
  })
  assert.deepEqual(got, {
    resolved: 0,
    undecidable: 0,
    results: [],
    blocked: [],
  })
  assert.equal(readStop({ stopPath: s.stopPath }), null)
})

test("reconcile.mjs contains no click", () => {
  // Asserted here as well as in click-surface.test.mjs, because THIS is the
  // module where a click would be most tempting and most catastrophic: a
  // reconciler that could click could re-submit the very application it was
  // sent to ask about.
  const src = fs.readFileSync(
    new URL("../../src/auto/reconcile.mjs", import.meta.url),
    "utf8",
  )
  assert.equal(/\.click\s*\(/.test(src), false)
})

test("readOrphanAttempts carries the board_key reconcile dispatches on", (t) => {
  // THE INVARIANT THE OLD FIXTURE HID. reconcile.mjs picks its probe with
  // `orphan.board_key ?? orphan.board ?? null`, and readOrphanAttempts
  // selected only from auto_submissions — a table with no board_key column. So
  // the field was ALWAYS undefined in production, `probe` was always null, and
  // the module could not resolve a single orphan, including the loopback
  // fixture that is the only probe it ships. Every test passed, because the
  // fixture hand-built an orphan literal carrying a field the query could not
  // return.
  const s = sandbox()
  t.after(() => fs.rmSync(s.root, { recursive: true, force: true }))
  const o = orphan(s, { slug: "board-key-job", board: "fixture" })
  assert.equal(
    o.board_key,
    "fixture",
    "without this, reconcileOne cannot select a probe for any orphan",
  )
})

test("an orphan whose queue row is gone is still reported, without a board", (t) => {
  // A LEFT JOIN, deliberately. Dropping the orphan when its queue row has been
  // pruned would lose the one fact that matters: a click is unaccounted for.
  // Losing the board key only degrades it to `undecidable`, which is where
  // every real board lands today anyway.
  const s = sandbox()
  t.after(() => fs.rmSync(s.root, { recursive: true, force: true }))
  orphan(s, { slug: "pruned-job", board: "fixture" })
  const db = openDb(s.dbFile)
  try {
    db.prepare("DELETE FROM auto_queue WHERE slug = 'pruned-job'").run()
    const rows = readOrphanAttempts(db)
    const row = rows.find((r) => r.slug === "pruned-job")
    assert.ok(row, "the unaccounted click must still be reported")
    assert.equal(row.board_key, null)
  } finally {
    db.close()
  }
})
