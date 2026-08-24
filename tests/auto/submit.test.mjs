// submitOnce() — §4.11 invariant 2: ELEVEN PRECONDITIONS, ONE TEST EACH, AND
// EVERY ONE OF THEM ASSERTS THE CLICK DID NOT HAPPEN.
//
// The assertion that matters in all eleven is the same and it is not the error
// message: `page.clicks` must be empty. A test that only checks a rejection
// passes just as happily against a function that clicks first and throws
// afterwards, which is the one bug this file exists to catch.
//
// Plus the two C8 properties, which are the reason the ledger is keyed
// (slug, mode) rather than (run_id, slug) or (slug):
//
//   * a dry-run rehearsal does NOT consume the live claim, and
//   * a second live attempt on a slug IS refused.
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import crypto from "node:crypto"

import {
  submitOnce,
  SubmitRefused,
  SubmitAmbiguous,
  ClassifierRequired,
  findSubmitControl,
  isProvablyBeforeClick,
  SUBMIT_PRECONDITIONS,
} from "../../scripts/auto/submit.mjs"
import { authorizeSubmit, planSha256 } from "../../scripts/auto/authorize.mjs"
import { startRun } from "../../scripts/auto/audit.mjs"
import { openDb, recordVerification } from "../../scripts/lib/db.mjs"

// ---------------------------------------------------------------------------
// The rig
// ---------------------------------------------------------------------------

const APPLY_URL = "https://boards.greenhouse.io/acme/jobs/1"
const SLUG = "acme-fullstack"
const DOC_SHA = "a".repeat(64)
const PROFILE_SHA = "b".repeat(64)

const LIMITS = {
  enabled: true,
  dry_run: true,
  per_run_max: 10,
  per_day_max: 10,
  per_company_max_per_week: 5,
  board_allowlist: { "boards.greenhouse.io": "greenhouse" },
}

const PLAN = Object.freeze({
  items: [{ k: "f1", how: "fill", value: "Xavier" }],
  defer: [],
})
const SCAN = Object.freeze({
  buttons: [{ k: "b7", l: "Submit application", r: "submit" }],
})

/** A page that RECORDS clicks instead of performing them. `stampAttached:
 *  false` makes the pre-click liveness check see a dead stamp (the Greenhouse
 *  post-upload remount) without touching the click path. */
function fakePage({
  url = APPLY_URL,
  onClick = null,
  stampAttached = true,
} = {}) {
  const clicks = []
  return {
    clicks,
    url: () => url,
    locator(sel) {
      return {
        async click(opts) {
          clicks.push({ sel, opts })
          if (onClick) return onClick(sel)
        },
        async waitFor() {
          if (!stampAttached)
            throw new Error(`Timeout exceeded waiting for ${sel}`)
        },
      }
    },
    async content() {
      return "<html><body>Thanks for applying</body></html>"
    },
    async waitForLoadState() {},
  }
}

function rig(t, { mode = "dry_run", limits = LIMITS, verify = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aj-submit-"))
  const dbFile = path.join(dir, "leads.db")
  const jobsDir = path.join(dir, "jobs")
  const autoDir = path.join(jobsDir, ".auto")
  fs.mkdirSync(autoDir, { recursive: true })
  const stopPath = path.join(autoDir, "STOP")

  const db = openDb(dbFile)
  if (verify)
    recordVerification(db, {
      slug: SLUG,
      mode: "resume",
      verdict: "pass",
      doc_sha256: DOC_SHA,
      profile_sha256: PROFILE_SHA,
    })
  db.close()

  const run = startRun({ mode, dbFile, autoDir, stopPath })
  t.after(() => {
    try {
      run.finish({ outcome: "ok" })
    } catch {
      /* a run left open by a failing assertion must not mask it */
    }
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* a leaked handle must not fail an assertion that already passed */
    }
  })

  const planSha = planSha256(PLAN)
  const mint = (over = {}) =>
    authorizeSubmit({
      lead: { slug: SLUG, company: "Acme", apply_url: APPLY_URL },
      plan: PLAN,
      planSha,
      config: limits,
      trustVerdict: { ok: true, reason: "allowlisted" },
      screening: { verdict: "pass", findings: [] },
      dbFile,
      stopPath,
      runId: run.id,
      ...over,
    })

  const base = (over = {}) => ({
    token: mint(),
    slug: SLUG,
    planSha,
    mode,
    pageUrl: APPLY_URL,
    queueRow: { slug: SLUG, state: "authorized", run_id: run.id },
    plan: PLAN,
    report: null,
    run,
    trust: { ok: true, reason: "allowlisted" },
    verification: {
      doc_sha256: DOC_SHA,
      profile_sha256: PROFILE_SHA,
      mode: "resume",
    },
    profileApproved: true,
    scan: SCAN,
    dbFile,
    stopPath,
    job: { slug: SLUG, company: "Acme", title: "Full-Stack Engineer" },
    ...over,
  })

  return { dir, dbFile, stopPath, autoDir, run, planSha, mint, base }
}

/** Every refusal test is this shape: it must throw AND it must not click. */
async function refuses(t, page, opts, expect) {
  await assert.rejects(() => submitOnce(page, opts), expect)
  assert.deepEqual(
    page.clicks,
    [],
    "THE CLICK HAPPENED ANYWAY. A precondition that throws after clicking is " +
      "not a precondition.",
  )
}

// ---------------------------------------------------------------------------
// The happy path first, so every refusal below is a real difference
// ---------------------------------------------------------------------------

test("dry run passes every check, writes the ledger row, and does not click", async (t) => {
  const r = rig(t)
  const page = fakePage()
  const out = await submitOnce(page, r.base())
  assert.equal(out.outcome, "dry-run")
  assert.equal(out.clicked, false)
  assert.deepEqual(page.clicks, [])

  const db = openDb(r.dbFile)
  const row = db
    .prepare("SELECT * FROM auto_submissions WHERE slug = ? AND mode = ?")
    .get(SLUG, "dry_run")
  db.close()
  assert.ok(row, "the rehearsal writes a real (slug, 'dry_run') row")
  assert.equal(
    row.outcome,
    "submitted",
    "resolved, not left 'attempted' — an unresolved attempt is an orphan, and " +
      "an orphan halts EVERY future run until a human looks at a URL",
  )
  assert.equal(
    row.apply_url,
    APPLY_URL,
    "the row says where the click was aimed",
  )
})

// ---------------------------------------------------------------------------
// The eleven
// ---------------------------------------------------------------------------

test("1. token_live — a forged or spent token is refused", async (t) => {
  const r = rig(t)
  await refuses(t, fakePage(), r.base({ token: null }), /token/i)
  await refuses(
    t,
    fakePage(),
    r.base({
      token: {
        kind: "aj.submit-authorization",
        deferred: false,
        nonce: "deadbeef",
        slug: SLUG,
        planSha: r.planSha,
        mode: "dry_run",
        apply_url: APPLY_URL,
      },
    }),
    /already been spent|was copied|not issued/i,
  )
})

test("1b. token_live — one authorisation is one click", async (t) => {
  const r = rig(t)
  const opts = r.base()
  await submitOnce(fakePage(), opts)
  // The same token again. The nonce is gone from the live set, so the second
  // spend is refused — and it is refused BEFORE any second ledger row.
  const page = fakePage()
  await refuses(t, page, opts, /already been spent|ledger already holds/i)
})

test("2. token_slug — a token for another job is refused", async (t) => {
  const r = rig(t)
  await refuses(
    t,
    fakePage(),
    r.base({ slug: "some-other-job" }),
    /slug|queue row/i,
  )
})

test("3. token_plan_sha — a token is refused against a different plan", async (t) => {
  const r = rig(t)
  const otherPlan = {
    items: [{ k: "f1", how: "fill", value: "someone else" }],
    defer: [],
  }
  await refuses(
    t,
    fakePage(),
    r.base({ planSha: planSha256(otherPlan), plan: otherPlan }),
    /plan/i,
  )
})

test("4. token_mode — a dry-run token cannot reach a live click", async (t) => {
  const r = rig(t)
  await refuses(
    t,
    fakePage(),
    r.base({ mode: "live", classify: () => "confirmation" }),
    /mode/i,
  )
})

test("5. page_origin — a redirect elsewhere cannot spend the token", async (t) => {
  const r = rig(t)
  // Phase 0.1. Without this an attacker-controlled redirect moves the browser
  // to another origin and the authorisation is still spendable there.
  await refuses(
    t,
    fakePage({ url: "https://evil.test/apply" }),
    r.base({ pageUrl: "https://evil.test/apply" }),
    /bound to|origin/i,
  )
  // And an opaque origin is not an origin: two different file: pages compare
  // equal under `new URL(x).origin`.
  await refuses(
    t,
    fakePage({ url: "about:blank" }),
    r.base({ pageUrl: "about:blank" }),
    /origin/i,
  )
})

test("6. queue_claimed — a job this worker does not own is refused", async (t) => {
  const r = rig(t)
  await refuses(
    t,
    fakePage(),
    r.base({ queueRow: { slug: SLUG, state: "planned", run_id: r.run.id } }),
    /not 'authorized'/,
  )
  await refuses(
    t,
    fakePage(),
    r.base({
      queueRow: { slug: SLUG, state: "authorized", run_id: "someone-else" },
    }),
    /claimed by run/,
  )
})

test("7. durable_attempt — a second live attempt on one slug is refused", async (t) => {
  // C8. The row is the claim, and the claim is what a crash cannot walk past.
  const r = rig(t, { mode: "live", limits: { ...LIMITS, dry_run: false } })
  const page = fakePage()
  const first = await submitOnce(
    page,
    r.base({ mode: "live", classify: () => "confirmation" }),
  )
  assert.equal(first.clicked, true, "the live path did click, once")
  assert.equal(page.clicks.length, 1)

  // Second attempt, fresh token, same slug. beginSubmit's INSERT reports 0
  // changes and the runner stops rather than clicking again — carpet-bombing
  // one employer is the damage that actually costs the user something.
  const page2 = fakePage()
  await refuses(
    t,
    page2,
    r.base({ mode: "live", classify: () => "confirmation" }),
    /ledger already holds|STOP/i,
  )
})

test("8. plan_clean — a field the FILL revealed defeats submitReadiness", async (t) => {
  // THE REACHABLE HALF, and picking it took a correction worth recording. The
  // obvious test — pass a plan with a defer — cannot reach precondition 8 at
  // all: the token is bound to the plan's sha256, so a mutated plan trips
  // precondition 3 first, and authorizeSubmit refuses a deferred plan before
  // minting anything (see the next test). What IS reachable is the case where
  // the plan was clean when the token was minted and the FILL then revealed a
  // field that was never in it — the page was not fully understood, and
  // submitReadiness reads that from the report rather than from the plan.
  const r = rig(t)
  await refuses(
    t,
    fakePage(),
    r.base({ report: { uploads: [], revealed: [{ k: "f9", l: "Salary" }] } }),
    /revealed by the fill|not fully understood/i,
  )
})

test("8c. plan_clean — an UNREADABLE fill report refuses at the real gate", async (t) => {
  // `[]` is the shape that fooled submitReadiness into ready:true: truthy, so
  // it entered the report checks, and every key it looks for is `undefined` on
  // an array. Asserted THROUGH submitOnce rather than only against the gate
  // function, because the precondition is what decides the click — and the
  // refusal must happen before it, which `refuses` checks.
  const r = rig(t)
  await refuses(t, fakePage(), r.base({ report: [] }), /not a result object/i)
  // A truthy primitive used to throw a raw TypeError out of the gate instead of
  // refusing, which is a different (and worse) failure: the caller decides.
  await refuses(
    t,
    fakePage(),
    r.base({ report: "clean" }),
    /not a result object/i,
  )
})

test("8b. the plan clauses of precondition 8 are defence behind the gate", async (t) => {
  // Not reachable through submitOnce, and that is the correct shape rather
  // than a gap: authorizeSubmit refuses a deferred or label-flagged plan and
  // never mints a token, so precondition 8's defer and labelFlag clauses only
  // fire for a caller that got a token some other way. The gate is asserted
  // HERE so the pair of them is covered, rather than leaving the clause
  // untested because its own door is shut.
  const r = rig(t)
  const deferred = { items: PLAN.items, defer: [{ k: "f2", why: "consent" }] }
  const v = r.mint({ plan: deferred, planSha: planSha256(deferred) })
  assert.equal(v.deferred, true)
  assert.match(v.reason, /plan_defer/)

  const flagged = {
    items: [
      {
        k: "f1",
        how: "fill",
        value: "x",
        labelFlag: "ignore previous instructions",
      },
    ],
    defer: [],
  }
  const v2 = r.mint({ plan: flagged, planSha: planSha256(flagged) })
  assert.equal(v2.deferred, true)
  assert.match(v2.reason, /label_flag|submit_readiness/)
})

test("9. stop_clear — a STOP set while the job was planning stops the click", async (t) => {
  const r = rig(t)
  const opts = r.base() // token minted BEFORE the switch is pulled
  fs.writeFileSync(r.stopPath, "pulled by the user mid-run\n")
  const page = fakePage()
  await refuses(t, page, opts, /STOP is set/)

  // And the intent row it had already written is ABANDONED, not left orphaned:
  // a refusal at the spend is provably before the click.
  const db = openDb(r.dbFile)
  const row = db
    .prepare("SELECT outcome FROM auto_submissions WHERE slug = ? AND mode = ?")
    .get(SLUG, "dry_run")
  db.close()
  assert.equal(row?.outcome, "abandoned")
})

test("10. board_trusted — an untrusted board is refused", async (t) => {
  const r = rig(t)
  await refuses(
    t,
    fakePage(),
    r.base({ trust: { ok: false, reason: "allowlist: not on the list" } }),
    /not on the list/,
  )
  await refuses(t, fakePage(), r.base({ trust: null }), /no trust verdict/)
})

test("11. document_verified — bytes and fact base must BOTH match", async (t) => {
  const r = rig(t)
  // A row matching only doc_sha256 is a verdict about a fact base that no
  // longer exists.
  await refuses(
    t,
    fakePage(),
    r.base({
      verification: {
        doc_sha256: DOC_SHA,
        profile_sha256: "c".repeat(64),
        mode: "resume",
      },
    }),
    /no passing verification row/,
  )
  await refuses(
    t,
    fakePage(),
    r.base({ profileApproved: false }),
    /approved_by_user/,
  )
  await refuses(t, fakePage(), r.base({ verification: null }), /descriptor/)
})

test("every one of the eleven is named in the closed list", () => {
  assert.equal(SUBMIT_PRECONDITIONS.length, 11)
  assert.equal(new Set(SUBMIT_PRECONDITIONS).size, 11)
})

// ---------------------------------------------------------------------------
// C8: the (slug, mode) key, from the other side
// ---------------------------------------------------------------------------

test("a dry-run rehearsal does NOT pre-consume the live claim", async (t) => {
  // F1, the defect that would have shipped a runner that could never submit
  // anything: with a slug-only key, every rehearsed slug consumed its own claim
  // and precondition 7 refused it FOREVER after.
  const r = rig(t)
  await submitOnce(fakePage(), r.base())

  const live = startRun({
    mode: "live",
    dbFile: r.dbFile,
    autoDir: r.autoDir,
    stopPath: r.stopPath,
  })
  const token = r.mint({ config: { ...LIMITS, dry_run: false } })
  const page = fakePage()
  const out = await submitOnce(page, {
    ...r.base(),
    mode: "live",
    token,
    run: live,
    queueRow: { slug: SLUG, state: "authorized", run_id: live.id },
    classify: () => "confirmation",
  })
  assert.equal(out.outcome, "confirmation")
  assert.equal(page.clicks.length, 1, "the live submit went through")
  live.finish({ outcome: "ok" })

  const db = openDb(r.dbFile)
  const rows = db
    .prepare("SELECT mode, outcome FROM auto_submissions WHERE slug = ?")
    .all(SLUG)
  db.close()
  assert.equal(rows.length, 2, "two rows, one per mode — that IS the key")
  assert.deepEqual(rows.map((x) => x.mode).sort(), ["dry_run", "live"])
})

test("a CONFIRMED live click resolves its own ledger row, counts as submitted, names every actuation, and leaves the run clean", async (t) => {
  // THE DEFECT (2026-08-18): nothing on the live path ever called
  // run.recordSubmission(). The queue row went to `submitted`, the ledger row
  // stayed `attempted`, run.submitted stayed 0, and finish() reported one
  // unresolved attempt "which may already be an application" and raised a
  // company-scoped brake — for a SUCCESSFUL application. Found by driving the
  // path with a classifier that answers `confirmation`; the first real submit
  // would have found it too.
  const r = rig(t, { mode: "live", limits: { ...LIMITS, dry_run: false } })
  const page = fakePage()
  const plan = {
    ...PLAN,
    actuated: [
      {
        k: "g1",
        label: "Are you legally authorized to work in the United States?",
        value: "Yes",
        pick: "f2",
        grant: "required-assertion",
        req: true,
      },
    ],
  }
  const planSha = planSha256(plan)
  // The plan carries a granted actuation, so the gate needs the policy that
  // grants it — the same key the user's file would carry.
  const token = r.mint({
    plan,
    planSha,
    config: {
      ...LIMITS,
      dry_run: false,
      unattended_assent: { required_assertions: true },
    },
  })
  assert.ok(token?.nonce, `a token was minted: ${token?.reason ?? ""}`)
  const out = await submitOnce(page, {
    ...r.base({
      mode: "live",
      classify: () => ({ kind: "confirmation", rule: "capture-test" }),
    }),
    token,
    plan,
    planSha,
    report: { verify: { mismatch: [], errors: [], requiredEmpty: [] } },
    job: { slug: SLUG, company: "Acme", title: "Full-Stack Engineer" },
  })
  assert.equal(out.outcome, "confirmation")
  assert.equal(out.row.outcome, "submitted", "the resolved row comes back")

  const db = openDb(r.dbFile)
  const row = db
    .prepare(
      "SELECT outcome, confirmation_url, doc FROM auto_submissions WHERE slug = ? AND mode = 'live'",
    )
    .get(SLUG)
  db.close()
  assert.equal(
    row.outcome,
    "submitted",
    "the ledger row is RESOLVED, not left attempted",
  )
  assert.equal(row.confirmation_url, APPLY_URL)
  const doc = JSON.parse(row.doc)
  assert.deepEqual(
    doc.consent_labels,
    [
      {
        label: "Are you legally authorized to work in the United States?",
        value: "Yes",
        grant: "required-assertion",
      },
    ],
    "every actuation is named on the record, with its grant",
  )
  assert.equal(doc.actuated.length, 1)
  assert.equal(
    doc.audit_incomplete,
    undefined,
    "nothing a withdrawal needs is missing",
  )

  const fin = r.run.finish({ outcome: "ok" })
  assert.equal(fin.submitted, 1, "the run counted it")
  assert.equal(fin.outcome, "ok", `no false brake: ${fin.stop_reason ?? ""}`)
})

test("a challenge after the click leaves the attempt OPEN — only a confirmation resolves it", async (t) => {
  const r = rig(t, { mode: "live", limits: { ...LIMITS, dry_run: false } })
  const out = await submitOnce(
    fakePage(),
    r.base({ mode: "live", classify: () => "bot-challenge" }),
  )
  assert.equal(out.outcome, "bot-challenge")
  const db = openDb(r.dbFile)
  const row = db
    .prepare(
      "SELECT outcome FROM auto_submissions WHERE slug = ? AND mode = 'live'",
    )
    .get(SLUG)
  db.close()
  assert.equal(
    row.outcome,
    "attempted",
    "an orphan for a human to adjudicate, by design",
  )
})

// ---------------------------------------------------------------------------
// The click site itself
// ---------------------------------------------------------------------------

test("a live submit without the classifier is refused as a wiring error", async (t) => {
  const r = rig(t, { mode: "live", limits: { ...LIMITS, dry_run: false } })
  const page = fakePage()
  await assert.rejects(
    () => submitOnce(page, r.base({ mode: "live", classify: null })),
    ClassifierRequired,
  )
  assert.deepEqual(page.clicks, [])
})

test("the submit control is located by its data-aj stamp, never by its text", () => {
  assert.deepEqual(findSubmitControl(SCAN), {
    ok: true,
    key: "b7",
    label: "Submit application",
  })
  assert.equal(findSubmitControl({ buttons: [] }).ok, false)
  // Two submit-shaped controls is a judgement, and this path makes none.
  assert.match(
    findSubmitControl({
      buttons: [
        { k: "b1", l: "Submit", r: "submit" },
        { k: "b2", l: "Submit application", r: "submit" },
      ],
    }).reason,
    /judgement/,
  )
  // The stamp is gone (Greenhouse remounts its form after an upload). Refuse,
  // never fall back to matching the label — the label is third-party text.
  assert.match(
    findSubmitControl({ buttons: [{ l: "Submit application", r: "submit" }] })
      .reason,
    /data-aj/,
  )
})

test("a missing submit control abandons the attempt rather than orphaning it", async (t) => {
  const r = rig(t, { mode: "live", limits: { ...LIMITS, dry_run: false } })
  const page = fakePage()
  await refuses(
    t,
    page,
    r.base({
      mode: "live",
      classify: () => "confirmation",
      scan: { buttons: [] },
    }),
    /no control with role 'submit'/,
  )
  const db = openDb(r.dbFile)
  const row = db
    .prepare("SELECT outcome FROM auto_submissions WHERE slug = ? AND mode = ?")
    .get(SLUG, "live")
  db.close()
  assert.equal(
    row?.outcome,
    "abandoned",
    "there was provably no click, so this must not become an orphan that " +
      "halts every future run",
  )
})

test("A TIMEOUT DURING THE CLICK IS AMBIGUOUS AND STAYS AN ORPHAN", async (t) => {
  // The single most important line in this file. Playwright performs the
  // actionability wait and the dispatch inside ONE call, so a timeout cannot
  // prove which side of the dispatch it died on — and an unprovable case must
  // never be abandoned, because abandoning is the caller asserting the click
  // never went out.
  const r = rig(t, { mode: "live", limits: { ...LIMITS, dry_run: false } })
  const page = fakePage({
    onClick: () => {
      throw new Error("locator.click: Timeout 15000ms exceeded.")
    },
  })
  await assert.rejects(
    () =>
      submitOnce(
        page,
        r.base({ mode: "live", classify: () => "confirmation" }),
      ),
    SubmitAmbiguous,
  )
  const db = openDb(r.dbFile)
  const row = db
    .prepare("SELECT outcome FROM auto_submissions WHERE slug = ? AND mode = ?")
    .get(SLUG, "live")
  db.close()
  assert.equal(row?.outcome, "attempted", "it stays an orphan, on purpose")
})

test("a structural locator error IS provably before the click", () => {
  assert.equal(
    isProvablyBeforeClick(
      new Error("strict mode violation: resolved to 3 elements"),
    ),
    true,
  )
  assert.equal(
    isProvablyBeforeClick(new Error("element is not attached to the DOM")),
    true,
  )
  assert.equal(
    isProvablyBeforeClick(
      new Error("locator.click: Timeout 15000ms exceeded."),
    ),
    false,
  )
  assert.equal(
    isProvablyBeforeClick(
      new Error("Timeout 15000ms exceeded. Call log: waiting for locator"),
    ),
    false,
    "a timeout stays ambiguous however its call log reads",
  )
})

test("the refusal type carries WHICH precondition, for an actionable reason", async (t) => {
  const r = rig(t)
  try {
    await submitOnce(
      fakePage(),
      r.base({ trust: { ok: false, reason: "nope" } }),
    )
    assert.fail("expected a refusal")
  } catch (e) {
    assert.ok(e instanceof SubmitRefused)
    assert.equal(e.precondition, "board_trusted")
    assert.ok(SUBMIT_PRECONDITIONS.includes(e.precondition))
  }
})

// --- the pre-click stamp liveness check ------------------------------------
//
// Greenhouse's embed remounts its form after an upload and drops every
// [data-aj] stamp. Before this check, the click waited its full 15s on a
// selector matching zero elements WITH THE ATTEMPT ROW ALREADY WRITTEN — an
// orphan and a company STOP for a click that provably never dispatched
// (three times on Torc, 2026-08-19/22). The check runs before anything
// durable: no row, no token spend, so the caller can re-scan and retry.

test("a dead submit stamp refuses BEFORE the attempt row, and the token survives", async (t) => {
  const { SubmitStampLost } = await import("../../scripts/auto/submit.mjs")
  const r = rig(t, { mode: "live", limits: { ...LIMITS, dry_run: false } })

  const dead = fakePage({ stampAttached: false })
  const token = r.mint()
  await assert.rejects(
    () =>
      submitOnce(
        dead,
        r.base({ mode: "live", classify: () => "confirmation", token }),
      ),
    (e) => e instanceof SubmitStampLost && e.key === "b7",
  )
  assert.deepEqual(dead.clicks, [], "no click may be issued on a dead stamp")

  const db = openDb(r.dbFile)
  const row = db
    .prepare("SELECT * FROM auto_submissions WHERE slug = ?")
    .get(SLUG)
  db.close()
  assert.equal(row, undefined, "a dead stamp must write no attempt row")

  // The same token spends cleanly on a page whose stamp is alive — the
  // refusal consumed nothing.
  const alive = fakePage()
  const out = await submitOnce(
    alive,
    r.base({ mode: "live", classify: () => "confirmation", token }),
  )
  assert.equal(out.clicked, true)
  assert.equal(alive.clicks.length, 1)
})

test("a dry run never runs the liveness check — its page double has no DOM", async (t) => {
  const r = rig(t)
  // stampAttached:false would throw in live mode; in dry_run the check is
  // skipped entirely and the dry rehearsal completes.
  const page = fakePage({ stampAttached: false })
  const out = await submitOnce(page, r.base())
  assert.equal(out.outcome, "dry-run")
  assert.deepEqual(page.clicks, [], "a dry run must never click")
})

// ---------------------------------------------------------------------------
// stagePostSubmit: the corpus grows from real pages, or not at all
// ---------------------------------------------------------------------------

test("an unclassified live click hands its page to stagePostSubmit", async (t) => {
  // Until 2026-08-24 the runner read a real post-submit page on every live
  // click and threw it away, so a blind host stayed blind forever (nine
  // clicked-unconfirmed submissions in one week). The hook is the fix; this
  // pins its firing conditions. A confirmation page is NOT staged — the host
  // is already sighted for that page, and staging it would grow the review
  // pile with pages nobody needs to look at.
  const r = rig(t)
  const staged = []
  const live = startRun({
    mode: "live",
    dbFile: r.dbFile,
    autoDir: r.autoDir,
    stopPath: r.stopPath,
  })
  const page = fakePage()
  const out = await submitOnce(page, {
    ...r.base(),
    mode: "live",
    token: r.mint({ config: { ...LIMITS, dry_run: false } }),
    run: live,
    queueRow: { slug: SLUG, state: "authorized", run_id: live.id },
    classify: () => "unclassified",
    stagePostSubmit: (c) => staged.push(c),
  })
  assert.equal(out.outcome, "unclassified")
  assert.equal(staged.length, 1, "the unclassified page was staged")
  assert.equal(staged[0].slug, SLUG)
  assert.ok(typeof staged[0].url === "string" && staged[0].url.length)
  assert.ok(typeof staged[0].html === "string" && staged[0].html.length)
  live.finish({ outcome: "stopped", stopReason: "unclassified" })
})

test("a confirmation is never staged", async (t) => {
  // Fresh rig: the unclassified test above rightly leaves an unresolved
  // attempt and a company brake behind it, and this test is about staging,
  // not about the brake.
  const r = rig(t)
  const staged = []
  const live = startRun({
    mode: "live",
    dbFile: r.dbFile,
    autoDir: r.autoDir,
    stopPath: r.stopPath,
  })
  const out = await submitOnce(fakePage(), {
    ...r.base(),
    mode: "live",
    token: r.mint({ config: { ...LIMITS, dry_run: false } }),
    run: live,
    queueRow: { slug: SLUG, state: "authorized", run_id: live.id },
    classify: () => "confirmation",
    stagePostSubmit: (c) => staged.push(c),
  })
  assert.equal(out.outcome, "confirmation")
  assert.equal(staged.length, 0, "a confirmation is never staged")
  live.finish({ outcome: "ok" })
})

test("a stagePostSubmit that throws never changes what the submit reports", async (t) => {
  // Staging is an optimisation; redaction can refuse (assertRedacted throws
  // when an identifier survives), and that refusal must cost the capture,
  // never the outcome record.
  const r = rig(t)
  const live = startRun({
    mode: "live",
    dbFile: r.dbFile,
    autoDir: r.autoDir,
    stopPath: r.stopPath,
  })
  const out = await submitOnce(fakePage(), {
    ...r.base(),
    mode: "live",
    token: r.mint({ config: { ...LIMITS, dry_run: false } }),
    run: live,
    queueRow: { slug: SLUG, state: "authorized", run_id: live.id },
    classify: () => "unclassified",
    stagePostSubmit: () => {
      throw new Error("redaction refused")
    },
  })
  assert.equal(out.outcome, "unclassified")
  live.finish({ outcome: "stopped", stopReason: "unclassified" })
})
