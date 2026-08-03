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
 * `submitReadiness` reads `plan.items`, `plan.defer` and `report.uploads`, so
 * all three concatenate. Defers concatenate too even though a page with defers
 * ends the walk — the merged plan has to be able to REPRESENT a defer, or the
 * submit gate's own zero-defer check becomes vacuous on multi-page forms.
 */
export function mergePages(pages) {
  const items = []
  const defer = []
  const uploads = []
  const revealed = []
  for (const p of pages ?? []) {
    for (const i of p?.plan?.items ?? []) items.push({ ...i, page: p.page })
    for (const d of p?.plan?.defer ?? []) defer.push({ ...d, page: p.page })
    for (const u of p?.report?.uploads ?? []) uploads.push(u)
    for (const r of p?.report?.revealed ?? []) revealed.push(r)
  }
  return {
    plan: { v: 1, items, defer, pages: (pages ?? []).length },
    report: { uploads, revealed },
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
    const scan = await scanStage(page, {
      url: liveUrl,
      job,
      lead,
      page: pageNo,
    })
    const plan = await planStage({
      scan,
      url: liveUrl,
      job,
      lead,
      documents,
      page: pageNo,
    })
    const pageSha = sha256Of(plan)

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
    const report = fillStage
      ? await fillStage(page, plan, { job, lead, page: pageNo })
      : null
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

  // Local, so every failure path goes through the abandonment.
  async function fail(kind, reason) {
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
    }
  }
}
