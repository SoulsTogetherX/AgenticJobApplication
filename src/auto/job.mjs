// The per-job state machine (§4.4). Phase 5 W1.
//
//   queued
//     -> claimed      (INSERT ... ON CONFLICT DO NOTHING; 0 changes means
//                      another worker owns it, and this one returns)
//     -> planned      (scan + fill-plan; plan_sha256 written)
//     -> authorized   (trust gate + authorizeSubmit token minted)
//     -> attempted    (the durable (slug, mode) row, written BEFORE the click)
//     -> submitted | challenged | deferred | failed
//
// ===========================================================================
// THE TWO PROPERTIES THIS FILE EXISTS TO HOLD
// ===========================================================================
//
// 1. EVERY TRANSITION IS A DURABLE WRITE, and nothing lives in process memory
//    across a job boundary that cannot be re-derived from the database. The
//    run is not a recovery unit; the job is. A SIGKILL at any point leaves the
//    row saying exactly how far this job got, and `readResumableAutoJobs`
//    picks it up next invocation — except from `attempted`, which is excluded
//    on purpose, because that click may already be an application and belongs
//    to a human rather than to an automatic retry.
//
// 2. EVERY EXIT IS TYPED. There is no path out of this function that leaves a
//    job without a `reason_kind` from the closed taxonomy, and a kind nothing
//    recognises becomes a loud `plan-error` rather than a quiet bucket. Hard
//    rule 6: a silent skip is not a deferral. The one exit with no reason is
//    `submitted`, which has nothing to explain.
//
// ===========================================================================
// WHY EVERY DEPENDENCY IS INJECTED
// ===========================================================================
//
// `openPage`, `scan`, `plan` and `fill` arrive as functions. Two reasons, and
// neither is testability alone:
//
//   * §4.1 requires the runner to IMPORT its stages, never `execFileSync` them
//     — four spawns per application over 999 applications is ~198s of process
//     startup, serialised behind every tab, and `spawns_per_app` is a gate
//     column asserted to be 0. Injection is what lets auto-apply.mjs hand in
//     the real in-process implementations while a test hands in fakes, without
//     this file ever growing a "if (test)" branch.
//   * the browser lane differs per board (§4.2: non-persistent context per job
//     for cookie-free boards, one page on the shared profile for boards that
//     need a session). That choice belongs to the pool, which owns the browser.
//     This file must not know which lane it is on.
import { claimAutoJob, setAutoJobState, AUTO_QUEUE_TERMINAL } from "#lib/db.mjs"
import {
  authorizeSubmit,
  planSha256,
  AuthorizationInputError,
} from "./authorize.mjs"
import { trustBoard } from "./trust.mjs"
import {
  submitOnce,
  SubmitRefused,
  SubmitAmbiguous,
  SubmitStampLost,
  ClassifierRequired,
} from "./submit.mjs"
import { walkPages } from "./multipage.mjs"
import { AdvanceAmbiguous } from "./advance.mjs"
import { classifyPlanDefers, reasonRecord, toStateOpts } from "./taxonomy.mjs"
import { safeText } from "./untrusted-text.mjs"
import { StopError } from "./guard.mjs"
import { isHostSighted } from "./classify.mjs"
import { stageCapture } from "../apply/capture-post-submit.mjs"

/** The hostname of a url, for a message; never throws. */
function hostOf(url) {
  try {
    return new URL(String(url)).hostname
  } catch {
    return "an unparseable url"
  }
}

/**
 * authorizeSubmit's check names -> taxonomy kinds.
 *
 * Every one of these is a DELIBERATE aggregation decision, not a lookup table
 * somebody filled in:
 *
 *   auto_apply_block/enabled/mode -> `fact-base-changed`. These three read the
 *     user's own limits file, which auto-apply.mjs already read once at
 *     startup and refused to open a run over. So a per-job failure here means
 *     THE FILE CHANGED WHILE THE RUN WAS IN FLIGHT — the same event
 *     `fact-base-changed` was added for when it happens to profile/. Mapping
 *     them to `board-untrusted` (the nearest-looking kind) would tell the user
 *     their boards went bad when what actually happened is that they edited
 *     their own file at 21:40.
 *
 *   label_flag -> `l3-rejected`. The finding came from the FORM's label rather
 *     than from the posting body, but it is the same class of event — text
 *     under a third party's control tried to instruct the agent, and rule 0
 *     stopped it. It aggregates with its siblings instead of inventing a bucket
 *     of one. If that bucket ever grows enough to be worth acting on
 *     separately, the fix is a new kind in db.mjs, not a substring match here.
 *
 *   apply_origin -> `origin-mismatch`, which is a FAILURE kind, not a defer.
 *     The lead's apply URL not being an origin a token can bind to is a broken
 *     invariant in our own store, not the board declining.
 */
const CHECK_TO_KIND = new Map([
  ["auto_apply_block", "fact-base-changed"],
  ["enabled", "fact-base-changed"],
  ["mode", "fact-base-changed"],
  ["trust_gate", "board-untrusted"],
  ["apply_origin", "origin-mismatch"],
  ["screening", "l3-rejected"],
  ["plan_defer", "unknown-field"],
  ["label_flag", "l3-rejected"],
  ["submit_readiness", "unknown-field"],
  ["company_known", "unknown-field"],
  ["caps", "cap-company"],
  // Without this entry the fallback makes a duplicate refusal read as
  // `plan-error` — a malfunction kind. Nothing malfunctioned: the queue was
  // stale and the gate did its job.
  ["not_already_applied", "already-applied"],
])

/** submitOnce's precondition names -> taxonomy kinds, same reasoning. */
const PRECONDITION_TO_KIND = new Map([
  ["token_live", "token-refused"],
  ["token_slug", "token-refused"],
  ["token_plan_sha", "token-refused"],
  ["token_mode", "token-refused"],
  ["page_origin", "origin-mismatch"],
  ["queue_claimed", "token-refused"],
  ["durable_attempt", "db-write-failed"],
  ["plan_clean", "unknown-field"],
  ["stop_clear", "doc-unverified"],
  ["board_trusted", "board-untrusted"],
  ["document_verified", "doc-unverified"],
])

/** A job that ended without being claimed. Not an error — in a fan-out it is
 *  the ordinary result for every worker but one. */
export const NOT_CLAIMED = "not-claimed"

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v)

/**
 * Run one application, end to end.
 *
 * @returns {{slug, state, kind, stage, detail, submitted, wall_ms}}
 *   `state` is `not-claimed` or a terminal auto_queue state. It NEVER throws
 *   for a per-job condition — a thrown error would take the pool's worker down
 *   with it and strand every job behind it. It re-throws `StopError` ONLY at
 *   global/run scope, because that STOP is not a per-job condition: it means
 *   stop. A company- or board-scoped brake IS a per-job condition — it holds
 *   one employer or vendor and promises everything else keeps running — so it
 *   returns as a `company-stopped`/`board-stopped` deferral instead (§4.9).
 */
export async function runJob({
  db,
  run,
  job,
  lead,
  limits,
  screening = null,
  mode,
  // stages, injected (see the header)
  openPage,
  scan: scanStage,
  plan: planStage,
  fill: fillStage,
  // documents and the fact base, prepared by the caller
  documents = null,
  profileApproved = false,
  // policy
  sentThisRun = 0,
  allowLoopbackHttp = false,
  classify = null,
  // Can a confirmation on this host be read? Defaults to the shipped
  // classifier's own evidence (classify.mjs isHostSighted); injectable so a
  // harness that injects a `classify` can say what its classifier can see.
  hostSighted = isHostSighted,
  dbFile,
  stopPath = undefined,
  navRetries = 1,
  navBackoffMs = 1_000,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = () => new Date(),
} = {}) {
  const t0 = Date.now()
  const slug = job?.slug
  if (!slug) throw new TypeError("runJob requires a job with a slug")

  const ctx = {
    board_key: job.board_key ?? null,
    origin: job.origin ?? null,
  }
  /** How long this job has been running, at the moment of asking. Written to
   *  the queue row at every TERMINAL state and returned to the caller, so the
   *  number the digest reports and the number the pool sees are the same one.
   *  It was computed and returned here for as long as this function has
   *  existed, and persisted nowhere — so `auto latency` had no per-job sample
   *  to report and said n=0. */
  const wallMs = () => Date.now() - t0
  // MEASURED ONCE PER EXIT, and `ms` is how. The comment above promises the row
  // and the return value are "the same one"; they were not, because both this
  // helper and terminate() called wallMs() independently with a database write
  // and an audit write in between. The two numbers therefore always differed —
  // by 1-2ms when the box was quiet and by more than the 10ms the test allows
  // when it was not, which is why that test read as a contention flake for
  // months. A duration is a fact about a job that already happened, so it is
  // taken at one instant and handed to both writers.
  const done = (state, record, ms = wallMs()) => ({
    slug,
    state,
    kind: record?.kind ?? null,
    stage: record?.stage ?? null,
    detail: record?.detail ?? null,
    submitted: state === "submitted",
    wall_ms: ms,
  })

  /** Write a terminal row and return the result. One funnel, so no exit can
   *  skip the taxonomy: reasonRecord throws on an unknown kind. */
  const terminate = (kind, stage, detail, state = null) => {
    const record = reasonRecord({ kind, stage, ...ctx, detail, state })
    const ms = wallMs()
    setAutoJobState(db, slug, record.state, {
      run_id: run.id,
      ...toStateOpts(record),
      wall_ms: ms,
    })
    if (record.state === "failed") run.failJob(job, detail)
    else run.deferJob(job, `${record.kind}: ${record.detail ?? ""}`)
    return done(record.state, record, ms)
  }

  // --- claimed --------------------------------------------------------------
  if (
    claimAutoJob(db, slug, {
      run_id: run.id,
      board_key: ctx.board_key,
      origin: ctx.origin,
    }) !== 1
  ) {
    // 0 changes means another worker owns it, or it is already terminal. Either
    // way this worker touches nothing — writing a reason here would overwrite
    // the owner's.
    return done(NOT_CLAIMED, null)
  }

  let page = null
  let closePage = async () => {}

  try {
    run.beginJob(job)

    // --- the trust gate, BEFORE the browser -------------------------------
    //
    // Deliberately first. A board the user has not allowlisted costs one row
    // and no page load, which is what makes the gate cheap enough to be
    // strict. Running it after the scan would spend a navigation on every
    // untrusted board in the queue.
    const trust = trustBoard({
      lead,
      limits,
      screening,
      recordedOrigin: ctx.origin,
      allowLoopbackHttp,
    })
    if (!trust.ok) return terminate(trust.kind, "claim", trust.reason)

    // --- planned ----------------------------------------------------------
    const applyUrl = lead?.apply_url
    let nav = null
    for (let attempt = 0; ; attempt++) {
      try {
        nav = await openPage(applyUrl, { job, lead })
        break
      } catch (e) {
        // §4.6: transient kinds get a bounded job-level retry with backoff
        // BEFORE they are eligible to count toward a breaker signature. A
        // 20-second wifi drop at job 41 must not pause a board holding 900
        // leads.
        if (attempt >= navRetries)
          return terminate(
            "nav-timeout",
            "plan",
            `could not open ${safeText(applyUrl, 100)} after ${attempt + 1} attempt(s): ` +
              safeText(e?.message ?? e, 140),
          )
        await sleep(navBackoffMs * (attempt + 1))
      }
    }
    page = nav.page
    closePage = nav.close ?? (async () => {})

    // A posting taken down between screening and submit is routine at hundreds
    // of leads, and it is the board's event, not a malfunction of ours.
    if (nav.status === 404 || nav.status === 410 || nav.gone === true)
      return terminate(
        "posting-gone",
        "plan",
        `the posting returned ${nav.status ?? "a gone marker"} — it was taken ` +
          `down between screening and this run`,
      )

    const liveUrl = nav.url ?? applyUrl

    // --- the sightedness gate, BEFORE anything is typed into the form -----
    //
    // THE ALLOWLIST AND THE EVIDENCE LIST ARE DIFFERENT LISTS (CLAUDE.md rule
    // 6). The trust gate above said the user trusts this vendor; this asks
    // whether the repository can READ what the vendor's page says after a
    // submit — i.e. whether classify.mjs ships a capture-sourced confirmation
    // rule for the LIVE host, redirects followed. Until 2026-08-18 nothing
    // asked until after the click, so on an allowlisted-but-uncaptured host
    // (boards.greenhouse.io, jobs.lever.co on that day) the form was filled,
    // clicked, and the page after came back `unclassified` — a hard STOP, with
    // the application possibly SENT and unrecorded, which is the one failure
    // nothing later corrects. Deferring here costs one navigation and names the
    // fix: an attended apply on that host with capture-post-submit.mjs, then
    // promote. Live only — a dry run clicks nothing and reads nothing.
    if (mode === "live" && !hostSighted(liveUrl))
      return terminate(
        "board-unsighted",
        "plan",
        `no captured post-submit page for ${safeText(hostOf(liveUrl), 60)} — ` +
          `a live click could not be read afterwards; capture one attended ` +
          `(src/apply/capture-post-submit.mjs: stage → review → promote) ` +
          `and re-enqueue`,
      )

    // THE WALK (§4.2c). One page or several — the single-page case is the same
    // code path with the loop running once, so a multi-page form is not a
    // special case to be remembered. The scan, plan and fill stages are handed
    // through unchanged; what walkPages adds is the Next click between pages
    // and the explicit draft abandonment when a later page cannot be resolved.
    //
    // `mintToken` is this same authorizeSubmit call, per page, so STOP, the
    // caps and the trust gate are re-read at every page transition — a brake
    // pulled while a worker is on page 2 of 4 stops it there.
    const authorizeFor = (pageSha, pagePlan, pageReport) =>
      authorizeSubmit({
        lead,
        plan: pagePlan,
        planSha: pageSha,
        report: pageReport,
        config: limits?.auto_apply ?? null,
        trustVerdict: {
          ok: trust.ok,
          reason: trust.reason ?? "allowlisted ATS",
        },
        screening,
        sentThisRun,
        dbFile,
        ...(stopPath === undefined ? {} : { stopPath }),
        runId: run.id,
      })

    let walk
    try {
      walk = await walkPages(page, {
        slug,
        mode,
        job,
        lead,
        documents,
        board: trust?.entry?.ats ?? job?.board_key ?? null,
        url: liveUrl,
        scanStage: (p, c) => scanStage(p, c),
        planStage: (c) => planStage(c),
        fillStage: fillStage ? (p, pl, c) => fillStage(p, pl, c) : null,
        mintToken: async (pageSha, { plan: pagePlan }) =>
          authorizeFor(pageSha, pagePlan, null),
        planSha256,
        // Written per page, before that page's fill, so a SIGKILL anywhere in
        // the walk lands on `planned` with the sha of the page it died on.
        onPagePlanned: ({ sha: pageSha }) =>
          setAutoJobState(db, slug, "planned", {
            run_id: run.id,
            plan_sha256: pageSha,
          }),
      })
    } catch (e) {
      if (e instanceof StopError) throw e
      // AdvanceAmbiguous: a Next click went out and the page did not become
      // what was expected. If the scanner's role regex was wrong, that click
      // was a submit — so this is NOT abandoned and NOT retried, exactly like
      // an ambiguous submit.
      if (e instanceof AdvanceAmbiguous)
        return terminate(
          "post-submit-unclassified",
          "plan",
          safeText(e.detail ?? e.message, 200),
        )
      throw e
    }

    const plan = walk.plan
    const report = walk.report
    // THE LAST PAGE'S SCAN, never the first. The submit control lives on the
    // final page, and an earlier page's stamps do not exist in that DOM.
    // `let`, not `const`: if the fill's upload remounted the form and killed
    // the stamps, submitOnce throws SubmitStampLost and the retry below
    // replaces this with one fresh scan.
    let scan = walk.pages?.[walk.pages.length - 1]?.scan ?? null
    // The MERGED sha, replacing the per-page one the walk left on the row. This
    // is the sha the submit token binds to, and it has to cover every page — a
    // token bound to the last page alone would authorise a submit whose earlier
    // pages nothing checked.
    const sha = planSha256(plan)
    setAutoJobState(db, slug, "planned", { run_id: run.id, plan_sha256: sha })

    // A DRY RUN STOPS AT PAGE 1, because nothing was clicked and there is no
    // page 2 to read. Reporting the pages it DID resolve is honest; carrying on
    // as though the form were walked would make the rehearsal a rehearsal of
    // something else.
    if (
      walk.dryRun &&
      (walk.pages?.length ?? 0) === 1 &&
      walk.pages[0]?.hasNext
    )
      return terminate("multipage-unresolvable", "plan", walk.reason)

    if (!walk.ok) {
      // A walk that stopped for a reason of its own — a later page's defers, a
      // page nothing understood, a mid-form authorisation refused. Its
      // abandonment is folded into the detail rather than dropped: a partial
      // application left in an employer's ATS is a thing the user may need to
      // know about, and not saying so is the silent skip rule 6 forbids.
      const suffix = walk.abandonment
        ? ` — ${safeText(walk.abandonment.how, 200)}`
        : ""
      if (walk.kind !== "plan-defer")
        return terminate(
          // A mid-walk authorisation refusal is typed EXACTLY as the final
          // gate's is (CHECK_TO_KIND, below): the walk carries the first failed
          // check's name, and the same policy check gets the same kind whether
          // it fired on page 2 or at the end. It used to be a blanket
          // `plan-error`, so a "nothing to fill" on a closed posting — a
          // `submit_readiness` refusal, `unknown-field` at the final gate —
          // reached the row as a MALFUNCTION and fed the breaker. Only a
          // refusal whose check nothing maps (or a token that was never
          // minted) is still the runner's own fault.
          walk.kind === "authorize"
            ? (CHECK_TO_KIND.get(walk.check) ?? "plan-error")
            : walk.kind,
          "plan",
          `${safeText(walk.reason, 200)}${suffix}`,
        )
      // A defer on some page: type it from the merged plan's own defer entries,
      // so the kind comes from the shipped taxonomy rather than from here.
      const walkDefer = classifyPlanDefers(plan.defer, {
        stage: "plan",
        ...ctx,
      })
      if (walkDefer) {
        const ms = wallMs() // one measurement, both writers — see `done`
        setAutoJobState(db, slug, walkDefer.state, {
          run_id: run.id,
          ...toStateOpts(walkDefer),
          reason_detail: `${walkDefer.detail ?? ""}${suffix}`,
          wall_ms: ms,
        })
        if (walkDefer.state === "failed") run.failJob(job, walkDefer.detail)
        else run.deferJob(job, `${walkDefer.kind}: ${walkDefer.detail ?? ""}`)
        return done(walkDefer.state, walkDefer, ms)
      }
      return terminate("unknown-field", "plan", `${walk.reason}${suffix}`)
    }

    // Everything the machine did not understand, as ONE typed kind. Kept for
    // the single-page path and as a second net: a walk reporting ok with defers
    // in its merged plan would otherwise reach the submit gate.
    const planDefer = classifyPlanDefers(plan.defer, { stage: "plan", ...ctx })
    if (planDefer) {
      const ms = wallMs() // one measurement, both writers — see `done`
      setAutoJobState(db, slug, planDefer.state, {
        run_id: run.id,
        ...toStateOpts(planDefer),
        wall_ms: ms,
      })
      if (planDefer.state === "failed") run.failJob(job, planDefer.detail)
      else run.deferJob(job, `${planDefer.kind}: ${planDefer.detail ?? ""}`)
      return done(planDefer.state, planDefer, ms)
    }

    // --- authorized -------------------------------------------------------
    let auth
    try {
      auth = authorizeSubmit({
        lead,
        plan,
        planSha: sha,
        report,
        config: limits?.auto_apply ?? null,
        trustVerdict: {
          ok: trust.ok,
          reason: trust.reason ?? "allowlisted ATS",
        },
        screening,
        sentThisRun,
        dbFile,
        ...(stopPath === undefined ? {} : { stopPath }),
        runId: run.id,
      })
    } catch (e) {
      if (e instanceof StopError) throw e
      if (e instanceof AuthorizationInputError)
        // The runner wired the gate wrong. A malfunction of ours, and it must
        // read as one rather than as the board declining.
        return terminate(
          "plan-error",
          "authorize",
          safeText(e?.message ?? e, 200),
        )
      throw e
    }

    if (auth.deferred) {
      const first = auth.failed?.[0] ?? null
      const kind = CHECK_TO_KIND.get(first) ?? "plan-error"
      return terminate(kind, "authorize", auth.reason)
    }

    setAutoJobState(db, slug, "authorized", { run_id: run.id })

    // --- attempted -> submitted -------------------------------------------
    //
    // The queue row moves to 'attempted' BEFORE submitOnce, so a SIGKILL
    // between these two lines leaves a row that says a click may have been
    // issued — which is what keeps it out of AUTO_QUEUE_RESUMABLE and in front
    // of a human. It is written before submitOnce's own durable ledger row on
    // purpose: of the two possible orderings, this one can only ever
    // over-report, and over-reporting an attempt costs a human one look at a
    // URL while under-reporting one costs a duplicate application.
    setAutoJobState(db, slug, "attempted", { run_id: run.id })

    let result
    // Bounded at ONE re-scan. SubmitStampLost is thrown before the durable
    // attempt row and before the token spend (submit.mjs), so retrying is
    // safe: no orphan exists and the token is still whole. The re-scan is a
    // scan ONLY — no plan, no fill, no other click; the merged sha and the
    // token are untouched, and the fresh stamps are the one thing the retry
    // needs (Greenhouse's embed remount is why they died).
    let rescanned = false
    try {
      for (;;) {
        try {
          result = await submitOnce(page, {
            token: auth,
            slug,
            planSha: sha,
            mode,
            pageUrl: page.url ? page.url() : liveUrl,
            queueRow: { slug, state: "authorized", run_id: run.id },
            plan,
            report,
            run,
            trust,
            verification: documents?.verification ?? null,
            profileApproved,
            scan,
            classify,
            // Auto-stage the real post-submit page when it does not classify
            // as a confirmation (submit.mjs's stagePostSubmit doc has the
            // full reasoning). Redaction and the gitignored staging dir are
            // stageCapture's own guarantees; promotion into the corpus stays
            // the user's reviewed act.
            stagePostSubmit: ({ url, html, slug: s }) =>
              stageCapture({ url, html, slug: s }),
            dbFile,
            ...(stopPath === undefined ? {} : { stopPath }),
            job,
          })
          break
        } catch (e) {
          if (e instanceof SubmitStampLost && !rescanned) {
            rescanned = true
            scan = await scanStage(page, {
              url: liveUrl,
              job,
              lead,
              page: walk.pages?.length ?? 1,
            })
            continue
          }
          throw e
        }
      }
    } catch (e) {
      if (e instanceof StopError) throw e
      if (e instanceof SubmitStampLost) {
        // One re-scan did not bring the stamp back. No click was issued and
        // no attempt row exists, so this defers cleanly and a fresh run —
        // which re-navigates and re-stamps — usually lands it.
        return terminate(
          "submit-control-lost",
          "attempt",
          safeText(
            `the submit stamp left the DOM before any click (form remount ` +
              `after upload); one re-scan did not recover it: ${e.detail}`,
            200,
          ),
        )
      }
      if (e instanceof SubmitAmbiguous) {
        // The click went out and we do not know what happened. The ledger row
        // stays 'attempted' — an ORPHAN, deliberately — and the queue row says
        // so. Nothing retries this; a human adjudicates one slug.
        return terminate(
          "post-submit-unclassified",
          "attempt",
          safeText(e.detail ?? e.message, 200),
        )
      }
      if (e instanceof SubmitRefused) {
        const kind = PRECONDITION_TO_KIND.get(e.precondition) ?? "plan-error"
        return terminate(kind, "authorize", e.detail ?? e.message)
      }
      // A wiring error of ours, and it reads as one: the runner asked for a
      // live submit without the thing that types the page afterwards.
      if (e instanceof ClassifierRequired)
        return terminate("plan-error", "authorize", e.message)
      throw e
    }

    // A REHEARSAL IS NOT A SUBMISSION, AND THE QUEUE ROW MUST NOT SAY IT WAS.
    //
    // These two outcomes were collapsed into one terminal `submitted` row, and
    // the dry-run signal was sitting in the condition being tested:
    // submit.mjs returns `outcome: "dry-run"` from its `if (mode !== "live")`
    // branch. `auto_submissions` got this right — it is keyed (slug, mode) and
    // db.mjs:243-250 explains why at length — but `auto_queue` has a single
    // slug key and never learned the same lesson, so a rehearsal wrote a
    // terminal row that the live attempt could then never claim.
    //
    // MEASURED 2026-08-24: eliza-associate-forward-deployed-engineer was
    // rehearsed on 2026-08-18 and had read `submitted` ever since, with no
    // `applications` row and no live `auto_submissions` row. It re-selected on
    // every --enqueue and was dropped at the resumable SELECT — one stage
    // BEFORE the claim, so it never even reached the point where a refusal
    // gets logged. A dry run had permanently consumed the live slot.
    //
    // `deferred/rehearsed` is the honest record: nothing was sent, this run is
    // finished with the job, and a later LIVE run should look again. The kind
    // is on AUTO_REQUEUEABLE_KINDS so the next --enqueue re-queues it, which
    // is exactly the "rehearse, then arm" workflow dry_run exists to support.
    if (result.outcome === "dry-run") {
      // Through `terminate`, not a hand-rolled setAutoJobState: that is the
      // one funnel where reasonRecord validates the kind against the taxonomy
      // and decides the state. Writing the row directly here would skip both.
      return terminate(
        "rehearsed",
        // "attempt" — the stage the click belongs to. There is no "submit"
        // stage; the taxonomy names this one for the click itself, and a dry
        // run is precisely a run that reached it and stopped.
        "attempt",
        "dry run completed — the form was filled and the submit was NOT " +
          "clicked. Nothing was sent. A live run will attempt this job again.",
      )
    }
    if (result.outcome === "confirmation") {
      // One measurement, handed to both writers — see `done`.
      const ms = wallMs()
      setAutoJobState(db, slug, "submitted", {
        run_id: run.id,
        wall_ms: ms,
      })
      return done("submitted", null, ms)
    }

    // Everything else the classifier can return is a CHALLENGE or an error
    // page. `challenged` means "a click went out and we do not know whether it
    // landed" — it counts toward caps (never under-count) and is reported as
    // unconfirmed, never as sent.
    const CHALLENGE = new Map([
      ["bot-challenge", "bot-challenge"],
      ["email-code-challenge", "email-code-challenge"],
      ["identity-verification", "captcha"],
    ])
    if (CHALLENGE.has(result.outcome))
      return terminate(
        CHALLENGE.get(result.outcome),
        "post-submit",
        `the board answered the click with ${result.outcome}`,
        "challenged",
      )
    if (result.outcome === "posting-gone")
      return terminate(
        "posting-gone",
        "post-submit",
        "the posting was gone by the time the click landed",
      )
    return terminate(
      "post-submit-unclassified",
      "post-submit",
      `the post-submit page classified as ${safeText(result.outcome, 60)}`,
    )
  } catch (e) {
    if (e instanceof StopError) {
      // A SCOPED brake defers this job; only global/run scope stops the run.
      // The brake's own message promises "everything else keeps running", and
      // until 2026-08-22 this re-throw broke that promise: one company STOP
      // rejected the pool's Promise.all and stranded every queued job behind
      // it, twice in one day. Every checkpoint throw (beginJob, pre-submit)
      // funnels here, so this is the single conversion point.
      if (e.scope === "company" || e.scope === "board")
        return terminate(
          e.scope === "board" ? "board-stopped" : "company-stopped",
          "claim",
          safeText(
            `a ${e.scope}-scoped STOP for "${e.key}" is set (checkpoint ${e.checkpoint}) — ` +
              `delete ${e.at} to clear, then --enqueue`,
            200,
          ),
        )
      throw e // global | run: a STOP means stop
    }
    // The catch-all. A job must not be able to take its worker down: the pool
    // has N-1 other jobs behind it and an uncaught throw strands all of them.
    try {
      return terminate("plan-error", "plan", safeText(e?.message ?? e, 200))
    } catch {
      // Even the terminal write failed. Report it without throwing; audit's
      // finish() will see the queue row still non-terminal and say so.
      return done("failed", {
        kind: "db-write-failed",
        stage: "plan",
        detail: safeText(e?.message ?? e, 200),
      })
    }
  } finally {
    // The per-job disposal unit is the context (non-persistent lane) or the
    // page (persistent lane), created and UNCONDITIONALLY closed per job.
    try {
      await closePage()
    } catch {
      /* a leaked page must not turn a clean defer into a failure */
    }
  }
}

/** Is this a state nothing further happens to? Re-exported so the pool does
 *  not import db.mjs for one set. */
export const isTerminal = (state) => AUTO_QUEUE_TERMINAL.has(state)

export { CHECK_TO_KIND, PRECONDITION_TO_KIND }

/** The shape every exit of runJob returns. For assertions, never a gate. */
export function isJobResult(v) {
  return isObj(v) && typeof v.slug === "string" && typeof v.state === "string"
}
