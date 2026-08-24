// submitOnce() — THE ONLY FUNCTION IN THIS REPOSITORY PERMITTED TO CONTAIN A
// SUBMIT CLICK (§4.10). Phase 5 W1.
//
// tests/auto/click-surface.test.mjs asserts that `.click(` appears under
// scripts/auto/ only here and in advance.mjs, and that advance.mjs refuses any
// control whose scanned role is `submit`. That test is the enforcement; this
// comment is only the explanation.
//
// ===========================================================================
// THE ELEVEN PRECONDITIONS, AND WHY THEY ARE ORDERED THE WAY THEY ARE
// ===========================================================================
//
// §4.10 lists eleven. They are a SET — all must hold — but the order they are
// evaluated in is a safety property, not a style choice:
//
//   FIRST, everything that can refuse with NO SIDE EFFECT AT ALL (1-6, 8, 10,
//   11). A job refused here leaves no row, no ledger entry and nothing to
//   reconcile, which is what makes a defer cheap enough that the runner can
//   afford to be strict.
//
//   THEN 7, the durable `(slug, mode)` attempt row, written BEFORE the click.
//   It is deliberately the LAST thing before the token is spent, because every
//   check placed after it is time in which a crash leaves an orphan for a
//   human to adjudicate. Item 7 is the only control in the design that a crash
//   or a claim-race cannot walk past — db.mjs says it outright: "An attempt is
//   a submission until proven otherwise."
//
//   THEN the token spend (consumeSubmitToken), which re-runs 1-5 and re-reads
//   the kill switch with nothing between it and the click but one statement.
//   That is check 9 in its load-bearing position: a STOP the user set while
//   this job was planning still stops it.
//
// A REFUSAL BEFORE ITEM 7 THROWS `SubmitRefused` AND WRITES NOTHING.
// A FAILURE AFTER ITEM 7 BUT PROVABLY BEFORE THE CLICK CALLS
// `run.abandonAttempt(..., { beforeClick: true })` — that verb exists because
// without it every locator timeout would leave a "this may already be an
// application" brake on a run that never clicked anything.
// A FAILURE DURING THE CLICK IS AMBIGUOUS AND STAYS AN ORPHAN. It is not
// abandoned, not retried, and it stops the runner. The request may have reached
// the ATS, and an application cannot be unsent.
//
// ===========================================================================
// WHAT DRY RUN DOES, AND WHY IT IS NOT A NO-OP
// ===========================================================================
//
// `mode !== 'live'` returns after EVERY check above, including item 7. The
// rehearsal writes a real `(slug, 'dry_run')` row and it counts toward the caps
// on purpose (db.mjs: "The cap counts dry-run rows on purpose") — a rehearsal
// that did not exercise the cap arithmetic would not be a rehearsal of the run
// that matters. The `(slug, mode)` key is what stops that row from
// pre-consuming the live claim (C8/F1): the same slug can be rehearsed and then
// submitted, and a test asserts it.
//
// The row is resolved by `run.recordRehearsal()` rather than left `attempted`.
// An unresolved attempt is an orphan, and an orphan halts EVERY future run
// until a human looks at a URL — so a dry run that left one would turn the
// safe mode into the one that breaks the machine.
//
// AND THE HONEST LIMIT OF DRY RUN, WHICH IS THE REASON W2 EXISTS: everything
// below the token spend — the click, the post-click classification, the
// attempted -> submitted transition — runs for the FIRST TIME when the user
// enables live mode, unless something exercises it against a fixture first.
// Dry run proves the gate. It proves nothing about the click.
import {
  consumeSubmitToken,
  assertTokenMatches,
  isSubmitToken,
  submitOrigin,
  TokenError,
} from "./authorize.mjs"
import { submitReadiness } from "../apply/fill-plan.mjs"
import { safeText } from "./untrusted-text.mjs"
import { openDb, hasPassingVerification, DB_PATH } from "../lib/db.mjs"

/** The eleven, named, in §4.10's numbering. A report says which one refused
 *  without parsing prose, and a twelfth has to be added HERE. */
export const SUBMIT_PRECONDITIONS = Object.freeze([
  "token_live", //  1  minted by authorizeSubmit() in this process, nonce unspent
  "token_slug", //  2  token.slug === slug
  "token_plan_sha", //  3  token.planSha === planSha === sha256(plan being sent)
  "token_mode", //  4  token.mode === mode
  "page_origin", //  5  live page origin === token's apply_url origin
  "queue_claimed", //  6  queue row is 'authorized' and claimed by this worker
  "durable_attempt", //  7  the (slug, mode) attempt row reported 1 change
  "plan_clean", //  8  no defers, submitReadiness true, no labelFlag anywhere
  "stop_clear", //  9  STOP not set at global / board / company scope
  "board_trusted", // 10  trust.mjs passed and the lead carries no L3 rejection
  "document_verified", // 11  passing verification for these bytes AND this fact base
])

/** A precondition said no. Carries WHICH one, so the queue row's reason_detail
 *  is actionable rather than "submit refused". */
export class SubmitRefused extends Error {
  constructor(precondition, detail) {
    super(`submitOnce refused at precondition "${precondition}": ${detail}`)
    this.name = "SubmitRefused"
    this.code = "ESUBMITREFUSED"
    this.precondition = precondition
    this.detail = detail
  }
}

/**
 * A live submit was asked for without the post-click classifier.
 *
 * NOT a SubmitRefused, because it is not one of the eleven — those are
 * properties of the job, and this is a property of how the runner was wired.
 * Reusing a precondition name for it would put a wiring error in the bucket the
 * user reads as "the board declined", and would quietly make the closed list of
 * eleven mean twelve things.
 */
export class ClassifierRequired extends Error {
  constructor() {
    super(
      "a live submit needs the post-click classifier (§4.10, Phase 5 W2) and " +
        "none was supplied — without it the page after the click cannot be " +
        "typed, and an unclassified post-submit page is a hard STOP",
    )
    this.name = "ClassifierRequired"
    this.code = "ECLASSIFIER"
  }
}

/**
 * The submit control's data-aj stamp matched nothing on the live page.
 *
 * NOT a SubmitRefused, for the same reason ClassifierRequired is not: the
 * eleven preconditions are properties of the job, and this is a property of
 * the page's lifecycle — Greenhouse's embed remounts its form after an upload
 * and drops every stamp (fill-engine.mjs), so the scan that named the button
 * may be describing a document that no longer exists. Thrown BEFORE the
 * durable attempt row and before the token spend, so nothing needs abandoning
 * and the token stays reusable: the header above says the correct outcome for
 * a dead stamp is a re-scan by the caller, and this error is that mechanism.
 */
export class SubmitStampLost extends Error {
  constructor(key, label, detail) {
    super(detail)
    this.name = "SubmitStampLost"
    this.code = "ESTAMPLOST"
    this.key = key
    this.label = label ?? null
    this.detail = detail
  }
}

/** The click was issued and something went wrong AFTER it. Deliberately a
 *  different type from SubmitRefused: this one must never be retried and must
 *  never be abandoned, because the request may have reached the ATS. */
export class SubmitAmbiguous extends Error {
  constructor(detail) {
    super(
      `the submit click was issued and its outcome is unknown: ${detail}. ` +
        `This attempt stays an orphan on purpose — a human adjudicates one slug.`,
    )
    this.name = "SubmitAmbiguous"
    this.code = "ESUBMITAMBIGUOUS"
    this.detail = detail
  }
}

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v)

/**
 * The scanned submit control, or a stated reason there is not exactly one.
 *
 * Located by the scanner's own `data-aj` stamp and by NOTHING ELSE. A text
 * fallback ("find a button that says Submit") is the obvious next move and it
 * is refused deliberately: the label is third-party text, and a fuzzy match to
 * a submit button is a fuzzy match to an irreversible act. If the stamp is gone
 * — Greenhouse remounts its form after an upload and drops every stamp, which
 * is a measured behaviour of the real board, not a hypothetical — the correct
 * outcome is a re-scan by the caller or a defer, never a guess.
 */
export function findSubmitControl(scan) {
  const buttons = (scan?.buttons ?? scan?.btns ?? []).filter(
    (b) => b?.r === "submit",
  )
  if (!buttons.length)
    return { ok: false, reason: "the scan found no control with role 'submit'" }
  if (buttons.length > 1)
    return {
      ok: false,
      reason:
        `the scan found ${buttons.length} controls with role 'submit' ` +
        `(${buttons.map((b) => safeText(b.l, 40)).join(" | ")}) — which one is ` +
        `the application is a judgement, and this path does not make judgements`,
    }
  const b = buttons[0]
  if (!b.k)
    return {
      ok: false,
      reason: "the submit control carries no data-aj stamp to locate it by",
    }
  return { ok: true, key: b.k, label: b.l ?? null }
}

/**
 * THE SUBMIT.
 *
 * @param page      the Playwright page, already on the application form.
 * @param token     the authorizeSubmit() token for this exact submit.
 * @param slug      the job slug.
 * @param planSha   sha256 of the plan actually about to be submitted.
 * @param mode      'dry_run' | 'live' — what the CALLER states it is doing.
 * @param pageUrl   page.url(), the LIVE url. Never the planned one: comparing
 *                  the plan against itself passes through a redirect.
 * @param queueRow  the auto_queue row, for check 6.
 * @param plan      the fill plan, for check 8.
 * @param report    the fill report, if a fill already ran. submitReadiness
 *                  reads the FILL'S OWN VERDICT off it — `failed`, `failures`,
 *                  `verify` and `revealed`. IT READS NO `uploads` KEY, and the
 *                  older claim here that it did was false against that
 *                  function's body: an upload that did not attach arrives as a
 *                  `failures` entry, because fill-engine.mjs demotes an upload
 *                  whose input the DOM still shows present and holding zero
 *                  files to a fill failure. The "never from the plan" half of
 *                  that old sentence records a real incident and still holds —
 *                  the plan says what was ATTEMPTED, only the report says what
 *                  happened, and the attachment list a human reads is
 *                  `report.uploads` rather than anything on the plan.
 * @param run       the audit run — beginSubmit/recordRehearsal/abandonAttempt.
 * @param trust     the trustBoard() verdict, for check 10.
 * @param verification {doc_sha256, profile_sha256, mode}, for check 11.
 * @param profileApproved  profile.yaml meta.approved_by_user, for check 11.
 * @param classify  REQUIRED IN LIVE MODE. The pure `(url, html) -> outcome`
 *                  classifier (§4.10). It is injected rather than imported so
 *                  that this file cannot silently acquire a live path before
 *                  W2 builds and corpus-tests one — see the refusal below.
 * @param stagePostSubmit  Optional `({url, html, slug}) -> void`. Called on a
 *                  LIVE click whose page classified as anything OTHER than
 *                  `confirmation` — the one moment the real post-submit page
 *                  this host renders is in hand. §4.10's corpus can only grow
 *                  from real pages, and until 2026-08-24 the runner read one on
 *                  every live click and threw it away, so every blind host
 *                  stayed blind (9 clicked-unconfirmed submissions in one
 *                  week). The hook STAGES (redact → gitignored dir) — promote
 *                  stays the user's own reviewed act, exactly as
 *                  capture-post-submit.mjs's three-step design requires.
 *                  Injected like `classify` and for the same reason; failures
 *                  are swallowed — losing a capture must never change what the
 *                  submit reports.
 * @returns {{outcome, confirmationUrl, clicked, row}}
 */
export async function submitOnce(
  page,
  {
    token,
    slug,
    planSha,
    mode,
    pageUrl,
    queueRow,
    plan,
    report = null,
    run,
    trust,
    verification = null,
    profileApproved = false,
    scan = null,
    classify = null,
    stagePostSubmit = null,
    dbFile = DB_PATH,
    stopPath = undefined,
    clickTimeoutMs = 15_000,
    settleMs = 20_000,
    stampWaitMs = 250,
    job = null,
  } = {},
) {
  const refuse = (name, detail) => {
    throw new SubmitRefused(name, detail)
  }

  // --- 1-4: the token, checked WITHOUT spending it -------------------------
  //
  // EACH OF THE FOUR IS ITS OWN EXPLICIT CHECK, and the reason is worth stating
  // because the shorter version was written first and was wrong. Calling
  // assertTokenMatches and then deriving WHICH precondition failed by matching
  // its message with a regex is string matching where a type belongs: the
  // message says `is for "acme", not "other"` and a `/slug/` pattern does not
  // appear in it, so three of the four names came out as `token_live`. A
  // report that names the wrong precondition is worse than one that names
  // none, and the failure is invisible — every test still sees a rejection.
  if (!isSubmitToken(token))
    refuse(
      "token_live",
      "no submit authorization token — nothing may be clicked without one " +
        "from authorizeSubmit()",
    )
  if (token.slug !== slug)
    refuse(
      "token_slug",
      `the authorization is for "${safeText(token.slug, 60)}", not "${safeText(slug, 60)}"`,
    )
  if (token.planSha !== planSha)
    refuse(
      "token_plan_sha",
      `the authorization is bound to plan ${String(token.planSha).slice(0, 12)} ` +
        `but the plan about to be submitted hashes to ${String(planSha).slice(0, 12)} — ` +
        `an unbound token authorises any plan`,
    )
  if (token.mode !== mode)
    refuse(
      "token_mode",
      `the authorization is for a ${safeText(token.mode, 20)} run, but a ` +
        `${safeText(mode, 20)} submit was attempted`,
    )
  try {
    // The same implementation beginSubmit and consumeSubmitToken use, run last
    // as a belt-and-braces: it re-checks all four AND the nonce's liveness,
    // which is the one of the five this function cannot see for itself. Keeping
    // it means the three call sites cannot drift into three different opinions
    // of what "matches" means.
    assertTokenMatches(token, { slug, planSha, mode })
  } catch (e) {
    if (e instanceof TokenError) refuse("token_live", e.message)
    throw e
  }

  // --- 5: origin ------------------------------------------------------------
  const bound = submitOrigin(token.apply_url)
  const live = submitOrigin(pageUrl)
  if (!bound)
    refuse(
      "page_origin",
      `the authorization carries no http(s) apply URL, so there is no origin ` +
        `to bind the click to`,
    )
  if (!live)
    refuse(
      "page_origin",
      `the live page is not on an http(s) origin (${safeText(pageUrl, 100)})`,
    )
  if (live !== bound)
    refuse(
      "page_origin",
      `authorization is bound to ${bound} but the page is on ${safeText(live, 80)} — ` +
        `the browser was moved to another origin after the plan was authorised`,
    )

  // --- 6: the queue row -----------------------------------------------------
  if (!isObj(queueRow)) refuse("queue_claimed", "no auto_queue row was passed")
  if (queueRow.state !== "authorized")
    refuse(
      "queue_claimed",
      `the queue row is '${safeText(queueRow.state, 40)}', not 'authorized'`,
    )
  if (queueRow.slug !== slug)
    refuse(
      "queue_claimed",
      `the queue row is for "${safeText(queueRow.slug, 60)}", not "${safeText(slug, 60)}"`,
    )
  if (run?.id && queueRow.run_id && queueRow.run_id !== run.id)
    refuse(
      "queue_claimed",
      `the queue row is claimed by run ${safeText(queueRow.run_id, 40)}, not by ` +
        `this one (${run.id}) — a worker may only submit a job it owns`,
    )

  // --- 8: the plan ----------------------------------------------------------
  if (!isObj(plan)) refuse("plan_clean", "no plan was passed")
  const defers = plan.defer ?? []
  if (defers.length)
    refuse(
      "plan_clean",
      `the plan defers ${defers.length} field(s): ` +
        defers
          .slice(0, 4)
          .map((d) => safeText(d?.why ?? d?.label ?? "unnamed", 40))
          .join(", "),
    )
  // Under the assent policy the TOKEN carries (authorize.mjs stamps the
  // policy check 9 read from the user's block): the click site has no limits
  // file in hand, and re-checking against anything but what the gate saw would
  // make this precondition a second, independently-configured gate. A token
  // from before the policy carries none, which is every grant off.
  const ready = submitReadiness(plan, report, { assent: token?.assent ?? null })
  if (!ready?.ready)
    refuse(
      "plan_clean",
      `submitReadiness says no: ${safeText(ready?.reason ?? "no reason given", 200)}`,
    )
  // A labelFlag ANYWHERE — plan item or defer entry — is rule 0 firing on the
  // page's own text. It is not weighed against the rest of the plan.
  const flagged = [...(plan.items ?? []), ...defers].find((x) => x?.labelFlag)
  if (flagged)
    refuse(
      "plan_clean",
      `a plan entry carries a labelFlag (${safeText(flagged.labelFlag, 60)}) — ` +
        `the page's own text tripped rule 0 and nothing is submitted through that`,
    )

  // --- 10: trust ------------------------------------------------------------
  if (!isObj(trust))
    refuse("board_trusted", "no trust verdict was passed — see trust.mjs")
  if (!trust.ok)
    refuse("board_trusted", safeText(trust.reason ?? "board not trusted", 200))

  // --- 11: the document -----------------------------------------------------
  //
  // WHAT THIS CHECKS AND WHAT IT STILL DOES NOT. It checks that verify-claims
  // passed for EXACTLY these document bytes against EXACTLY this fact base, and
  // that the fact base itself is user-approved. It does NOT check that the user
  // approved THIS DOCUMENT, because no durable record of a per-document
  // approval exists anywhere in the tree today (hard rule 5's approval happens
  // in a chat message, which leaves no row). That gap is named here rather than
  // papered over with a field that would always read true.
  if (!isObj(verification))
    refuse(
      "document_verified",
      "no verification descriptor was passed ({doc_sha256, profile_sha256})",
    )
  if (profileApproved !== true)
    refuse(
      "document_verified",
      "profile.yaml meta.approved_by_user is not true — nothing may be " +
        "submitted from an unapproved fact base",
    )
  {
    const db = openDb(dbFile)
    let passing = false
    try {
      passing = hasPassingVerification(db, {
        slug,
        mode: verification.mode ?? "resume",
        doc_sha256: verification.doc_sha256,
        profile_sha256: verification.profile_sha256,
      })
    } finally {
      db.close()
    }
    if (!passing)
      refuse(
        "document_verified",
        `no passing verification row for ${slug} matching both doc_sha256 ` +
          `${String(verification.doc_sha256 ?? "absent").slice(0, 12)} and ` +
          `profile_sha256 ${String(verification.profile_sha256 ?? "absent").slice(0, 12)} — ` +
          `a verdict matching only the document is a verdict about a fact base ` +
          `that no longer exists`,
      )
  }

  // --- live mode needs a classifier, and W1 does not have one ---------------
  //
  // Refused HERE, before anything durable is written, so a runner wired live
  // without W2 fails as a clean defer instead of leaving an attempted row it
  // cannot resolve.
  if (mode === "live" && typeof classify !== "function")
    throw new ClassifierRequired()

  // --- the stamp is ALIVE, or nothing durable is written -------------------
  //
  // ATTACHED WITHIN stampWaitMs, OR GONE — the scan-engine's own idiom for a
  // stamp after a remount. Greenhouse's embed remounts its form after an
  // upload and drops every [data-aj] stamp; without this check the click below
  // waited its full 15s on a selector matching zero elements, with the attempt
  // row ALREADY WRITTEN — an orphan and a company STOP for a click that
  // provably never dispatched (measured three times on Torc, 2026-08-19/22).
  // Checked here, before the durable row and the token spend, so a dead stamp
  // costs nothing: no orphan to adjudicate, and the token is still spendable
  // when the caller re-scans and retries. Live-only: a dry run never clicks,
  // and its page double has no real DOM to wait on.
  if (mode === "live") {
    const pre = findSubmitControl(scan)
    if (pre.ok) {
      const alive = await page
        .locator(`[data-aj="${pre.key}"]`)
        .waitFor({ state: "attached", timeout: stampWaitMs })
        .then(
          () => true,
          () => false,
        )
      if (!alive)
        throw new SubmitStampLost(
          pre.key,
          pre.label,
          `the submit control's stamp [data-aj="${pre.key}"] matched nothing ` +
            `within ${stampWaitMs}ms — the form likely remounted (Greenhouse ` +
            `drops every stamp after an upload); re-scan and retry`,
        )
    }
  }

  // --- 7: THE DURABLE ATTEMPT, and 9: STOP ---------------------------------
  //
  // beginSubmit writes the row and throws StopError if the ledger already holds
  // one for this (slug, mode). It also re-checks the token against the RUN'S
  // mode, which is the only place in the tree where "the runner decided it was
  // live" is compared against "the user's file says dry_run: true".
  const attempt = run.beginSubmit(
    job ?? { slug, company: token.company ?? null, title: null },
    planSha,
    token.apply_url,
    token,
  )

  // The spend. Re-runs 1-5 and re-reads STOP with one statement between it and
  // the click. A StopError from here is provably before the click, which is the
  // one case where abandoning is unambiguous.
  try {
    consumeSubmitToken(token, {
      slug,
      planSha,
      mode,
      pageUrl,
      // Precondition 9 at full width (§4.10): global, this job's COMPANY and
      // RUN (both frozen into the token), and this job's BOARD — which only the
      // trust verdict knows, because `entry.ats` is the allowlist id the user
      // declared rather than anything read off the page.
      board: trust?.entry?.ats ?? null,
      ...(stopPath === undefined ? {} : { stopPath }),
    })
  } catch (e) {
    run.abandonAttempt(
      slug,
      `refused at the spend, before any click: ${safeText(e?.message ?? e, 200)}`,
      { beforeClick: true },
    )
    throw e
  }

  // --- dry run stops here, having exercised every check --------------------
  if (mode !== "live") {
    const row = run.recordRehearsal({
      slug,
      plan_sha256: planSha,
      apply_url: token.apply_url,
      checks: SUBMIT_PRECONDITIONS,
    })
    return { outcome: "dry-run", confirmationUrl: null, clicked: false, row }
  }

  // --- the click ------------------------------------------------------------
  const control = findSubmitControl(scan)
  if (!control.ok) {
    run.abandonAttempt(slug, `no submit control to click: ${control.reason}`, {
      beforeClick: true,
    })
    throw new SubmitRefused("plan_clean", control.reason)
  }

  const locator = page.locator(`[data-aj="${control.key}"]`)
  let clicked = false
  try {
    await locator.click({ timeout: clickTimeoutMs })
    clicked = true
  } catch (e) {
    // A click that THREW may still have dispatched. Playwright's timeout can
    // fire after the event reached the page, and the only honest reading of
    // "the locator errored" is "unknown". Abandoning here would be the caller
    // asserting something it does not know.
    if (isProvablyBeforeClick(e)) {
      run.abandonAttempt(
        slug,
        `the submit control could not be actuated: ${safeText(e?.message ?? e, 200)}`,
        { beforeClick: true },
      )
      throw new SubmitRefused("plan_clean", safeText(e?.message ?? e, 200))
    }
    throw new SubmitAmbiguous(safeText(e?.message ?? e, 200))
  }

  // --- after the click ------------------------------------------------------
  //
  // READING THE PAGE HERE IS SANCTIONED AND NARROW (§4.10): the classifier is a
  // pure function over (url, html) and its output is a TYPE, never an
  // instruction. Nothing else is read back out of the page for a decision.
  let url = null
  let html = ""
  try {
    await page.waitForLoadState("domcontentloaded", { timeout: settleMs })
  } catch {
    /* a slow settle is not evidence of anything; classify what is there */
  }
  try {
    url = page.url()
    html = await page.content()
  } catch (e) {
    throw new SubmitAmbiguous(
      `the click returned but the resulting page could not be read: ` +
        safeText(e?.message ?? e, 160),
    )
  }

  const outcome = classify(url, html)
  const kind = typeof outcome === "string" ? outcome : outcome?.kind
  const confirmationUrl = kind === "confirmation" ? url : null

  // The one moment a blind host's real post-submit page is in hand. Stage it
  // (redacted, gitignored) so the user can review and promote it into the
  // classifier's corpus — see the param doc above. Never on a confirmation
  // (the host is already sighted for this page) and never fatally: a submit
  // outcome must not change because a capture could not be written.
  if (kind !== "confirmation" && typeof stagePostSubmit === "function") {
    try {
      stagePostSubmit({ url, html, slug })
    } catch (e) {
      console.error(
        `warn: post-submit capture not staged for ${slug}: ` +
          safeText(e?.message ?? e, 120),
      )
    }
  }

  // A CONFIRMED CLICK RESOLVES THE INTENT, HERE, IN THE SAME FUNCTION THAT
  // WROTE IT (2026-08-18). Until this, nothing on the live path ever called
  // run.recordSubmission(): the queue row went to `submitted`, but the ledger
  // row stayed `attempted`, `run.submitted` stayed 0, and finish() — reading
  // the ledger, as it must — reported "1 unresolved submit attempt(s), each of
  // which may already be an application" and raised a company-scoped brake.
  // For a SUCCESSFUL application. Found by driving runJob with a classifier
  // that answers `confirmation`; the first real submit would have found it too.
  //
  // WHAT THE RECORD CARRIES, and why each field: the confirmation url (what
  // the user opens to see it landed); the fill's own verify block (what the
  // page said the fields held); every assent this plan actuated on the user's
  // behalf, with its grant — rule 6: "every one that is must be named in the
  // report", and this row is the report's source; and no screenshots, said
  // as an empty list rather than left null, because "none were taken" is a
  // fact and "unknown" is not. A challenge, a gone posting or an unclassified
  // page leaves the attempt OPEN on purpose — that is the orphan a human
  // adjudicates, and it must not be resolved by anything that did not see a
  // confirmation.
  if (kind === "confirmation") {
    const actuated = Array.isArray(plan?.actuated) ? plan.actuated : []
    const row = run.recordSubmission({
      slug,
      plan_sha256: planSha,
      apply_url: token.apply_url,
      company: job?.company ?? token.company ?? null,
      title: job?.title ?? null,
      confirmation_url: url,
      classified_by:
        typeof outcome === "object" && outcome ? (outcome.rule ?? null) : null,
      // The engine's report always carries `verify` (fill-engine.mjs
      // initialises it before the first action) and mergePages carries it
      // across pages; a walk with NO fill stage — a rehearsal harness, a
      // test — has no report at all. That is stated as a verify block that
      // says nothing was measured, rather than as null: the audit's
      // required-field check reads null as "the record is missing a piece it
      // needs for a withdrawal", and an honest "not measured" is not that.
      verify: report?.verify ?? { measured: false, note: "no fill report" },
      // The assents, as the record's `consent_labels` (the name predates the
      // policy and is what the audit's required-field list checks) AND in full
      // as `actuated`, grants included.
      consent_labels: actuated.map((a) => ({
        label: a?.label ?? null,
        value: a?.value ?? a?.pick ?? null,
        grant: a?.grant ?? null,
      })),
      actuated,
      screenshots: [],
    })
    return { outcome: kind, confirmationUrl, clicked, url, row }
  }

  return { outcome: kind, confirmationUrl, clicked, url, row: attempt }
}

// STRUCTURAL failures only: the selector matched nothing, or matched several,
// or the node left the DOM. Each of those is decided before Playwright reaches
// the actionability wait, so no event was dispatched.
//
// A TIMEOUT IS NEVER IN THIS LIST, and the temptation to add one is the reason
// the list is written out rather than expressed as "not a timeout". Playwright
// performs the actionability wait and the dispatch inside ONE call, and its
// timeout message is the same string whether it gave up before "attempting
// click action" or after — so a timeout cannot prove which side of the dispatch
// it died on. An unprovable case must read as ambiguous, and an ambiguous
// attempt stays an orphan for a human to adjudicate. Widening this list to
// recover a few clean defers would trade an orphan the user can resolve for a
// duplicate application they cannot.
const BEFORE_CLICK_PATTERNS = [
  /strict mode violation/i,
  /resolved to \d+ elements/i,
  /element is not attached to the dom/i,
  /no element matches selector/i,
]

/** Is this locator error provably from before the event was dispatched? */
export function isProvablyBeforeClick(e) {
  const m = String(e?.message ?? e ?? "")
  if (/timeout/i.test(m)) return false
  return BEFORE_CLICK_PATTERNS.some((re) => re.test(m))
}
