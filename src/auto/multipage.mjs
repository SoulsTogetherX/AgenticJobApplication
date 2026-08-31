// Walking a multi-page application form (§4.2c). Phase 5 W3.
//
// ===========================================================================
// THE PROBLEM, AND WHY THE OBVIOUS FIX WAS REJECTED
// ===========================================================================
//
// C7 required a form's fields to be resolved "before the first keystroke".
// Multi-page ATS forms only reveal page 2+ after page 1 is filled and Next is
// clicked, so that requirement was satisfiable **only** by deferring every
// multi-page form. That is a volume loss dressed up as a correctness win, and
// the only signal it had happened would have been a defer-rate number. §4.2c
// takes the other fix: resolve INCREMENTALLY, page by page, and abandon
// explicitly when a page cannot be resolved.
//
// ===========================================================================
// THE INVARIANT THAT REPLACES "RESOLVE EVERYTHING FIRST"
// ===========================================================================
//
//   Nothing is submitted until EVERY page has been resolved with zero defers.
//
// That is weaker than C7 asked for in one specific way — keystrokes reach page
// 1 before page 3 is known — and identical in the way that matters: an
// application still only leaves when nothing on any page needed a judgement.
// What page 1's keystrokes cost if page 3 turns out to be unresolvable is a
// DRAFT sitting in the employer's ATS, which is why abandoning it explicitly is
// part of the specification rather than a nicety.
//
// ===========================================================================
// A TOKEN PER PAGE, AND WHY NOT ONE FOR THE WHOLE FORM
// ===========================================================================
//
// `advanceOnce` demands an authorization bound to the plan of the page it is
// leaving, because that is the only plan that exists at that moment. One token
// for the whole form is impossible — the combined plan is not known until the
// last page is read — and a token bound to page 1 only would be a token that
// authorises clicking through a form nobody has seen.
//
// So each page transition mints its own, which means STOP, the caps and the
// trust gate are re-read at every page. A user who pulls the brake while a
// worker is on page 2 of 4 stops it there, and that is a property worth the
// extra reads rather than a cost to optimise away.
//
// THE SUBMIT'S OWN TOKEN IS MINTED SEPARATELY, over the COMBINED plan, by the
// caller. `mergePages` builds that plan. A token bound to only the last page
// would authorise a submit whose earlier pages nothing checked.
import { advanceOnce, findNextControl, AdvanceRefused } from "./advance.mjs"
import { safeText } from "./untrusted-text.mjs"

/** How many pages before this is not a form but a loop. A real ATS form is
 *  1-4 pages; the bound exists so a board that always renders a `next` control
 *  cannot spin a worker forever. Hitting it is `multipage-unresolvable`. */
export const MAX_PAGES = 8

/**
 * The plan and report for the WHOLE form, from its per-page parts.
 *
 * `submitReadiness` reads `plan.items`, `plan.defer`, `plan.actuated`,
 * `report.revealed` and — since 2026-08-05 — the FILL'S OWN VERDICT:
 * `report.failed`, `report.failures` and `report.verify` (`mismatch`,
 * `requiredEmpty`, and since 2026-08-06 `errors`). Every one of those has to
 * survive the merge; on 2026-08-05 three of them did not, and `plan.actuated`
 * was still being dropped until 2026-08-06 — see its own note in the loop.
 *
 * IT DOES NOT READ `report.uploads`. This sentence used to say it did, which
 * was false against the body of the function on the day it was written and is
 * worth correcting rather than deleting: an upload that did not attach reaches
 * the gate as a `failures` ENTRY — fill-engine.mjs demotes an upload whose
 * input the DOM still shows present and holding zero files to a fill failure —
 * so the gate reads the failure, not an absence in this list. `uploads` is
 * merged anyway because it is the list a HUMAN reads to see which file reached
 * which field, and that must never be reconstructed from the plan: the plan
 * says what was ATTEMPTED. Dropping it here because no gate reads it would
 * take the attachment record with it.
 *
 * THE BUG THAT PUT THEM HERE, and it is worth stating because the old version
 * looked complete. This function rebuilt the report as `{uploads, revealed}`
 * and dropped everything else on the floor. The engine had just learned to
 * demote an upload whose input the DOM showed STILL PRESENT AND EMPTY to a
 * fill failure — and that failure landed in `report.failures`, which stopped
 * existing right here, one call before any gate. The unattended path submits
 * the MERGED report or nothing, so a key missing from this object does not
 * exist as far as `authorizeSubmit` and `submitOnce` are concerned: an
 * application with no résumé attached passed both. A gate cannot refuse
 * evidence it was never handed.
 *
 * Defers concatenate too even though a page with defers ends the walk — the
 * merged plan has to be able to REPRESENT a defer, or the submit gate's own
 * zero-defer check becomes vacuous on multi-page forms.
 *
 * `verify` IS ABSENT, NOT EMPTY, when no page ran a verify pass, and that
 * asymmetry with `uploads`/`revealed`/`failures` is deliberate. "Nothing
 * measured this" and "this measured zero" are different facts; a fill that
 * never verified would, if this synthesised `{mismatch: [], requiredEmpty: []}`
 * for it, be handing the gate a clean bill of health nobody ever wrote.
 * submitReadiness reads the absence as "not measured" and refuses only on a
 * PRESENT non-zero count, so the forgery would have been silent.
 *
 * THE SAME FORGERY HAS A PER-PAGE HALF, and closing only the form-wide one left
 * it open. `verify` is emitted or not for the WHOLE merged report, so a walk
 * where page 1 verified and page 2 did not produced a PRESENT verify holding
 * page 1's counts alone — page 2's silence read as page 2's zero, and the gate,
 * which can only see the merged object, called the form measured clean. Mixed
 * coverage is therefore recorded as a fill failure, in the same vocabulary as
 * the malformed shapes below, naming the pages nobody measured.
 *
 * That cannot refuse anything the real engine produces: fillPage initialises
 * `out.verify` at the top and returns `out` on every path including its two
 * early guards, so a page it filled always carries one. Uniform absence —
 * no fill stage at all, or a stage that never verifies — leaves `verifyRan`
 * false and is untouched, which is the compatibility case item 4 protects.
 */
export function mergePages(pages) {
  const items = []
  const defer = []
  const actuated = []
  const uploads = []
  const revealed = []
  const failures = []
  const mismatch = []
  const requiredEmpty = []
  const errors = []
  let failed = 0
  let verifyRan = false
  // Pages that ran a fill and reported NO verify pass. Only meaningful once
  // some other page reported one — see the per-page forgery note above.
  const unverified = []

  // A report list that is PRESENT AND NOT A LIST is not an empty list.
  // Something produced it — `report.verify` is literally whatever the page
  // handed back from the verify pass's `page.evaluate` — and a shape nothing
  // can read is evidence the page was not understood, which is the same class
  // of thing as a failed fill. So it is recorded AS one, in the vocabulary
  // every gate downstream already reads, rather than as a new key each of them
  // would have to learn about (and one of them would forget).
  const drain = (v, into, pageNo, what) => {
    if (v == null) return
    if (!Array.isArray(v)) {
      failed += 1
      failures.push({
        k: "-",
        how: "merge",
        why: `page ${pageNo} reported ${what} as something other than a list, so it could not be checked`,
        page: pageNo,
      })
      return
    }
    for (const x of v) into.push(x)
  }

  for (const p of pages ?? []) {
    for (const i of p?.plan?.items ?? []) items.push({ ...i, page: p.page })
    for (const d of p?.plan?.defer ?? []) defer.push({ ...d, page: p.page })
    // `actuated` IS A GATE INPUT TOO, and it was being dropped exactly the way
    // `failures` and `verify` were (2026-08-06, found while correcting this
    // function's own docstring). buildPlan records every checkbox or radio it
    // ticked from an exact-text banked answer here, and submitReadiness refuses
    // on a non-empty list: rule 6 delegates assent when the USER hands over a
    // URL, and the unattended runner has no such instruction. Rebuilding the
    // plan without this key meant a widget ticked on page 2 of a four-page form
    // reached no gate at all, while the identical form on one page refused —
    // the gate cannot refuse evidence it was never handed.
    for (const a of p?.plan?.actuated ?? [])
      actuated.push({ ...a, page: p.page })
    drain(p?.report?.uploads, uploads, p?.page, "its uploads")
    drain(p?.report?.revealed, revealed, p?.page, "its revealed fields")

    // PAGE-TAGGED, exactly like the plan's items and defers above: "a field
    // failed to fill" is not actionable on a four-page form without knowing
    // which page to go back to.
    const pageFailures = []
    drain(p?.report?.failures, pageFailures, p?.page, "its fill failures")
    for (const f of pageFailures)
      failures.push(f && typeof f === "object" ? { ...f, page: p?.page } : f)

    // The count is carried BESIDE the list rather than derived from it. They
    // agree in everything the engine emits, and the gate checks both anyway —
    // a count that disagreed with its own list would itself mean something is
    // wrong with the report, and that is not a thing to resolve by picking the
    // smaller number.
    const n = p?.report?.failed
    if (n != null) {
      if (typeof n === "number" && Number.isFinite(n) && n >= 0) failed += n
      else {
        failed += 1
        failures.push({
          k: "-",
          how: "merge",
          // NAMES THE VALUE, not just the fact that it was rejected: the same
          // correction submitReadiness's own count branch needed, where "is a
          // ${typeof x}, not a number" rendered "is a number, not a number"
          // for the two likeliest shapes (`NaN`, `-1`). Truncated because the
          // value came off a page, and kept short because submitReadiness
          // slices a failure's `why` at 140 chars.
          why:
            `page ${p?.page} reported a failure count of ` +
            `${safeText(String(n), 40)}, which is not a count of zero or more`,
          page: p?.page,
        })
      }
    }

    const v = p?.report?.verify
    if (v !== undefined) {
      verifyRan = true
      if (v === null || typeof v !== "object" || Array.isArray(v)) {
        failed += 1
        failures.push({
          k: "-",
          how: "merge",
          why: `page ${p?.page}'s verify pass answered with something that is not a result object`,
          page: p?.page,
        })
      } else {
        drain(v.mismatch, mismatch, p?.page, "verify.mismatch")
        drain(v.requiredEmpty, requiredEmpty, p?.page, "verify.requiredEmpty")
        drain(v.errors, errors, p?.page, "verify.errors")
      }
    } else if (p?.report != null && typeof p.report === "object") {
      // A page that WAS filled and answered with no verify pass at all. Held
      // rather than judged here: on its own this is the legitimate "nobody
      // verified anything" walk, and it only becomes evidence once some other
      // page turns out to have verified.
      unverified.push(p?.page)
    }
  }

  // MEASURED IN PART IS NOT MEASURED. Recorded as a failure rather than as a
  // new key because every gate downstream already reads `failures`, and a key
  // one of them forgot to learn would be this bug again.
  //
  // UNDER 140 CHARACTERS, deliberately: submitReadiness slices a failure's
  // `why` at that length when it builds the reason the user reads, so a longer
  // sentence would lose its own tail. The page numbers come first for the same
  // reason the upload readback puts its tag first.
  if (verifyRan && unverified.length) {
    failed += 1
    failures.push({
      k: "-",
      how: "merge",
      why:
        `page ${unverified.map((n) => String(n ?? "?")).join(", ")} ran a fill ` +
        `but reported no verify pass while other pages did — a partly-measured ` +
        `form is not a measured one`,
      page: unverified[0],
    })
  }

  const report = { uploads, revealed, failed, failures }
  if (verifyRan) report.verify = { mismatch, errors, requiredEmpty }
  return {
    plan: { v: 1, items, defer, actuated, pages: (pages ?? []).length },
    report,
  }
}

/**
 * Abandoning a draft the run is walking away from.
 *
 * DELIBERATELY EMPTY FOR EVERY PRODUCTION BOARD, exactly like reconcile.mjs's
 * probe table, and for the same honest reason: Greenhouse, Lever and Ashby
 * hosted forms expose no candidate-facing "discard this application" action
 * without the logged-in session §6.4 excluded. §4.2c says "where the ATS
 * supports it", and on today's allowlist that is nowhere.
 *
 * So `abandonDraft` mostly RECORDS rather than acts, and the record is the
 * point: a partial application sitting in an employer's ATS is a thing the user
 * may want to know about, and the alternative — walking away silently — is the
 * behaviour rule 6 calls a silent skip.
 */
export const DRAFT_ABANDONERS = new Map()

/**
 * @returns {{abandoned: boolean, how: string}} — `abandoned: false` with a
 *   stated `how` is a legitimate outcome, not a failure. It means the draft is
 *   still there and nothing could remove it.
 */
export async function abandonDraft(page, { board = null, slug, why } = {}) {
  const fn = board ? DRAFT_ABANDONERS.get(board) : null
  if (!fn)
    return {
      abandoned: false,
      how:
        `no draft-discard path on ${safeText(board ?? "this board", 40)} — a ` +
        `partial application may be sitting in their ATS for "${safeText(slug, 60)}" ` +
        `(${safeText(why, 120)})`,
    }
  try {
    await fn(page, { slug })
    return { abandoned: true, how: `discarded via the ${board} adapter` }
  } catch (e) {
    return {
      abandoned: false,
      how: `the ${board} discard failed: ${safeText(e?.message ?? e, 140)}`,
    }
  }
}

/**
 * Walk the form, resolving each page before advancing to the next.
 *
 * Every stage is injected, for the same two reasons job.mjs injects its own:
 * §4.1 forbids spawning a process per stage, and the browser lane belongs to
 * the pool rather than to this file.
 *
 * @param scanStage   (page, ctx) -> scan
 * @param planStage   ({scan, url, ...}) -> plan
 * @param fillStage   (page, plan, ctx) -> report   (optional)
 * @param mintToken   (planSha) -> authorization | {deferred, reason, failed}
 * @returns {{ok, pages, plan, report, reason, kind, abandonment}}
 *   `ok: false` always carries a `kind` from the closed taxonomy AND, when the
 *   walk had already advanced past page 1, an `abandonment` describing what
 *   happened to the draft.
 */
export async function walkPages(
  page,
  {
    slug,
    mode,
    job = null,
    lead = null,
    documents = null,
    board = null,
    url,
    scanStage,
    planStage,
    fillStage = null,
    mintToken,
    planSha256: sha256Of,
    onPagePlanned = null,
    maxPages = MAX_PAGES,
  } = {},
) {
  const pages = []
  let liveUrl = url

  for (let pageNo = 1; ; pageNo++) {
    let scan = await scanStage(page, {
      url: liveUrl,
      job,
      lead,
      page: pageNo,
    })
    let plan = await planStage({
      scan,
      url: liveUrl,
      job,
      lead,
      documents,
      page: pageNo,
    })
    let pageSha = sha256Of(plan)

    // THE `planned` WAYPOINT, written BEFORE the fill and on every page.
    //
    // It moved here from job.mjs, and the move is the point rather than
    // tidiness. §4.4's ladder is queued -> claimed -> planned -> authorized,
    // and a state a SIGKILL can never land on is a rung that is not there:
    // writing `planned` only after the whole form was walked meant a kill
    // during page 1's fill left `claimed`, and the runner-resume suite caught
    // exactly that. Writing it per page also keeps the row's `plan_sha256`
    // describing the page the worker is actually on.
    if (onPagePlanned) await onPagePlanned({ page: pageNo, plan, sha: pageSha })

    // The fill runs Playwright-side and nothing is read back out of the page.
    let report = fillStage
      ? await fillStage(page, plan, { job, lead, page: pageNo })
      : null

    // ---- ONE bounded second pass, only when the fill CREATED fields --------
    //
    // A conditional reveal ("Have you worked here before? [Yes] -> If yes,
    // when?") does not exist at scan time, so it is in no plan, and the
    // verify pass reports it in `report.revealed` — un-stamped, because the
    // scanner never saw it. Nothing can be filled from a revealed entry
    // directly (no `k`, no fact-base resolution — fill-engine.mjs:2185 says
    // why); the only deterministic way to understand it is the same way the
    // first pass understood the page: scan again, plan again, fill again.
    // Same template as scan-engine.mjs's hydration re-scan: ONCE, announced
    // in signals, a full replacement rather than a merge. The gates are
    // untouched and unweakened — a field still revealed after this pass
    // refuses at submitReadiness exactly as before, anything UNKNOWN in the
    // re-plan defers at the plan-defer exit below, so the pass only ever
    // converts revealed -> planned-and-filled, revealed -> deferred, or
    // revealed -> still-revealed-and-refused.
    //
    // Skipped when pass 1 already deferred: the walk is ending at the
    // plan-defer exit regardless, and a second fill would only put more of
    // the user's data into a form that is not going to be submitted.
    if (fillStage && report?.revealed?.length && !plan?.defer?.length) {
      const scan2 = await scanStage(page, {
        url: liveUrl,
        job,
        lead,
        page: pageNo,
      })
      const plan2 = await planStage({
        scan: scan2,
        url: liveUrl,
        job,
        lead,
        documents,
        page: pageNo,
      })
      // Uploads are NOT idempotent (the cover-letter-on-top-of-the-resume
      // incident) — pass 2 replays every non-upload item and never re-attaches
      // a file. The FULL non-upload list, not a delta: the choice-group
      // coverage rule in the verify pass derives "covered" from the plan it is
      // handed, and a delta plan would re-report already-answered group
      // siblings as revealed.
      const items2 = (plan2.items ?? []).filter((i) => i?.how !== "upload")
      // Pass-1 grants survive the re-plan. A consent actuated in pass 1 whose
      // control the fill then collapsed is absent from scan2, and dropping its
      // record is the mergePages bug class (a gate cannot refuse — or admit —
      // evidence it was never handed). Deduped by label+grant, not by `k`:
      // scan2 re-stamps the page, so pass-1 keys may name different fields.
      const seenGrants = new Set(
        (plan2.actuated ?? []).map((a) => `${a.label}|${a.grant}`),
      )
      const carried = (plan.actuated ?? []).filter(
        (a) => !seenGrants.has(`${a.label}|${a.grant}`),
      )
      const pass2 = {
        ...plan2,
        items: items2,
        actuated: [...(plan2.actuated ?? []), ...carried],
      }
      const report2 = await fillStage(page, pass2, {
        job,
        lead,
        page: pageNo,
      })
      // Pass 2 is authoritative for everything it replayed; pass 1 stays
      // authoritative for uploads (its uploads record and any upload
      // failures) and for counts that must never reset (submitsBlocked).
      const upFails = (report?.failures ?? []).filter(
        (f) => f?.how === "upload",
      )
      report = {
        ...report2,
        ok:
          (report2.ok ?? 0) +
          (report?.uploads ?? []).filter((u) => u?.attached).length,
        failed: (report2.failed ?? 0) + upFails.length,
        failures: [...(report2.failures ?? []), ...upFails],
        uploads: report?.uploads ?? [],
        comboVia: { ...(report?.comboVia ?? {}), ...(report2.comboVia ?? {}) },
        submitsBlocked:
          (report?.submitsBlocked ?? 0) + (report2.submitsBlocked ?? 0),
        ms: (report?.ms ?? 0) + (report2.ms ?? 0),
        signals: [
          ...(report?.signals ?? []),
          ...(report2.signals ?? []),
          `${report.revealed.length} field(s) revealed by the fill; ` +
            "re-scanned and re-planned once",
        ],
      }
      scan = scan2
      plan = pass2
      // The advance token below and the merged submit sha both must bind the
      // plan that now exists — a token bound to the pass-1 sha would name a
      // plan this walk just replaced.
      pageSha = sha256Of(plan)
      if (onPagePlanned)
        await onPagePlanned({ page: pageNo, plan, sha: pageSha })
    }

    // The SCAN is kept per page, and the last page's is the one submitOnce
    // needs: the submit control lives on the final page, and locating it by the
    // stamp from an earlier page's scan would be locating it by a key that no
    // longer exists in the DOM.
    pages.push({ page: pageNo, plan, report, scan, sha: pageSha, url: liveUrl })

    // A DEFER ENDS THE WALK. Advancing past a page that needed a human would
    // put more of the user's data into a form that is never going to be
    // submitted.
    if (plan?.defer?.length)
      return fail(
        "plan-defer",
        `page ${pageNo} deferred ${plan.defer.length} field(s)`,
      )

    // A FAILED FILL DOES NOT END THE WALK, AND THAT IS KNOWN, NOT AN OVERSIGHT
    // (recorded 2026-08-06). `plan.defer` is the ONLY condition on this line.
    // A page whose fill reported failures — an upload that did not attach, a
    // combo that never took its value, a `report` shape mergePages could not
    // read — still mints a token, clicks Next, and the walk fills pages 2..N
    // before anything refuses.
    //
    // NOTHING IS SENT OFF A FAILED FILL: those failures survive mergePages and
    // submitReadiness refuses on them, which is exactly what tests/auto/
    // multipage.test.mjs's "THE WHOLE PATH: a failed fill on page 1 refuses the
    // merged submit" asserts — the walk returns ok:true and the SUBMIT gate
    // says no. The cost is narrower than the submit: more of the user's data
    // typed into a draft that will never be submitted, the same cost the defer
    // branch above exists to avoid, reached through a different door. On every
    // board on today's allowlist that draft cannot be discarded anyway (see
    // DRAFT_ABANDONERS), so stopping earlier would leave the draft too — it
    // would only stop adding to it.
    //
    // NOT CHANGED IN THE ROUND THAT WROTE THIS COMMENT, deliberately: a defer
    // is a DECISION the planner made about a field, while a failure count is a
    // MEASUREMENT handed back by an injected fill stage — and by the time it
    // reaches a gate the same `failures` vocabulary also carries mergePages's
    // own "we could not read your report" bookkeeping. Which of those is worth
    // abandoning a part-filled form for is its own change with its own tests,
    // not a second condition bolted onto the line above.

    const next = findNextControl(scan)
    // No `next` control means this is the last page — the ordinary and
    // overwhelmingly common exit, including for every single-page form.
    if (!next.ok) {
      if (next.terminal || pageNo === 1) break
      // A page that is neither advanceable nor terminal, mid-form: the form
      // went somewhere nothing understands.
      return fail(
        "multipage-unresolvable",
        `page ${pageNo} offers neither a 'next' control nor a 'submit' one: ${next.reason}`,
      )
    }

    // AN EMPTY FIRST PAGE THAT OFFERS 'NEXT' IS THE WRONG PAGE, not a page to
    // advance from. Measured 2026-08-17 on a real lead: the runner opened a
    // posting that had closed, the scan found no fields and one next-shaped
    // control, and the walk went on to mint a token for it — which the gate
    // refused ("nothing to fill") and this file then reported as an
    // authorisation FAILURE, i.e. a malfunction. Nothing malfunctioned: the
    // page was the ad, or the closed-posting notice, or a form that never
    // rendered, and none of those is a page to click through. Page 1 only —
    // a later page with nothing to fill and a Next control is a real shape
    // (an interstitial), and the last page with nothing to fill and a Submit
    // control is the review page, which the branch above already lets through.
    // `unknown-field` is the honest kind: nothing deterministic understood
    // this page, and it is the tier a probe or an adapter can shrink.
    const fillable = (plan?.items ?? []).filter((i) => i?.how !== "skip")
    if (pageNo === 1 && !fillable.length && !plan?.defer?.length)
      return fail(
        "unknown-field",
        "page 1 rendered no fillable field yet offers a 'next' control — the " +
          "runner is on the wrong page (posting closed, the ad rather than the " +
          "form, or a form that did not render)",
      )

    if (pageNo >= maxPages)
      return fail(
        "multipage-unresolvable",
        `still being offered a 'next' control after ${maxPages} pages — this is ` +
          `a loop rather than a form`,
      )

    // A FRESH AUTHORIZATION PER PAGE. Re-reads STOP, the caps and the trust
    // gate, so a brake pulled mid-form stops the worker on the page it is on.
    const token = await mintToken(pageSha, { page: pageNo, plan })
    if (!token || token.deferred)
      return fail(
        "authorize",
        `page ${pageNo} could not be authorised to advance: ` +
          safeText(token?.reason ?? "no token was minted", 160),
        // The FIRST failed check, carried so the caller can type the refusal
        // the same way it types the final gate's (job.mjs CHECK_TO_KIND). A
        // mid-walk refusal used to reach the row as a blanket `plan-error`,
        // so a policy defer on page 2 read as a malfunction on page 2.
        { check: token?.failed?.[0] ?? null },
      )

    try {
      const advanced = await advanceOnce(page, {
        token,
        slug,
        planSha: pageSha,
        mode,
        pageUrl: page.url ? page.url() : liveUrl,
        scan,
      })
      // In dry run nothing is clicked, so there is no page 2 to read. The walk
      // reports what it RESOLVED rather than pretending it advanced.
      if (!advanced.advanced)
        return {
          ok: true,
          dryRun: true,
          pages,
          ...mergePages(pages),
          reason: `dry run: resolved page ${pageNo} and did not advance`,
        }
      liveUrl = advanced.url
    } catch (e) {
      if (e instanceof AdvanceRefused)
        return fail("multipage-unresolvable", e.reason)
      // AdvanceAmbiguous and anything else: the click went out. This is NOT
      // ours to abandon — see advance.mjs. Re-thrown for job.mjs to type.
      throw e
    }
  }

  return { ok: true, pages, ...mergePages(pages) }

  // Local, so every failure path goes through the abandonment. `extra` carries
  // anything the caller needs to TYPE the failure (today: the failed check
  // name of an authorisation refusal); it never carries page text.
  async function fail(kind, reason, extra = {}) {
    // ONLY IF WE ADVANCED. A form abandoned on page 1 left nothing behind: no
    // Next was clicked, so no draft exists to discard, and reporting one would
    // be telling the user about something that is not there.
    const abandonment =
      pages.length > 1
        ? await abandonDraft(page, { board, slug, why: reason })
        : null
    return {
      ok: false,
      kind: kind === "plan-defer" ? "plan-defer" : kind,
      reason,
      pages,
      ...mergePages(pages),
      abandonment,
      ...extra,
    }
  }
}
