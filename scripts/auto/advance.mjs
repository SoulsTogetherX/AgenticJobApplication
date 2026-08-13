// advanceOnce() — the navigate verb (§4.2c). Phase 5 W3.
//
// THE SECOND AND LAST FILE UNDER scripts/auto/ PERMITTED TO CONTAIN A CLICK,
// and it may click exactly one thing: a control whose SCANNED ROLE IS `next`.
// tests/auto/click-surface.test.mjs asserts both halves — that no third file
// grows a click, and that this one refuses a `submit` control.
//
// ===========================================================================
// WHY THIS FILE EXISTS AT ALL, WHICH IS A COST RATHER THAN A FEATURE
// ===========================================================================
//
// C7 required a multi-page form's fields to be resolved "before the first
// keystroke". Multi-page ATS forms only reveal page 2+ after page 1 is filled
// and Next is clicked, and no module could click Next — `fill-engine.mjs` says
// so deliberately: "there is deliberately no verb that clicks a button. 'Never
// click submit' is not a rule this engine follows — it is a thing it cannot
// express."
//
// So the requirement was satisfiable only by deferring EVERY multi-page form: a
// volume loss dressed up as a correctness win, invisible except as a defer-rate
// number. §4.2c takes the other fix and rejects that one.
//
// **`fill-engine.mjs` is not touched.** Its inexpressibility property is
// preserved verbatim. The navigate verb lives out here instead — one small file
// with one function, where the click surface stays reviewable.
//
// This is a REAL WIDENING of a surface this project kept at zero, which is why
// §4.2c writes the cost down rather than absorbing it. Everything below is
// about making the widening as narrow as it can be.
//
// ===========================================================================
// WHY IT DEMANDS A TOKEN, WHEN IT IS "ONLY" A NEXT BUTTON
// ===========================================================================
//
// Because the difference between Next and Submit is a REGEX OVER THIRD-PARTY
// TEXT. `roleOf` in scan-page.js reads the control's label — which the board
// writes — so a page that labels its final submit "Save and Continue" is
// scanned as `next`. That is not hypothetical; it is a normal thing for a
// board to do, and rule 0 says the label is data.
//
// So this function assumes it may be wrong about the role and takes the same
// origin binding and the same single-use token discipline as `submitOnce`. If
// the click it makes turns out to have been a submit, the durable
// `(slug, mode)` row exists, the caps counted it, and the ledger says an
// attempt was made — instead of an application leaving with no record at all.
//
// THE ONE THING IT DOES NOT SHARE with submitOnce is the post-click
// classification: a `next` click is expected to produce another form page, not
// a terminal outcome. What it does instead is DETECT that it landed on
// something terminal (see `landedOnSubmit`) and hand that back, because a
// "Next" that was really a Submit is exactly the case the record has to catch.
import {
  consumeSubmitToken,
  assertTokenMatches,
  isSubmitToken,
  submitOrigin,
  TokenError,
} from "./authorize.mjs"
import { safeText } from "./untrusted-text.mjs"

/** The roles this file will actuate. A set of one, written as a set so that
 *  adding to it is a visible act rather than an edit to a comparison. */
const CLICKABLE_ROLES = new Set(["next"])

/** The role it must never actuate, named separately from "not in the set
 *  above" so the refusal can say WHY rather than "no next control found". */
const FORBIDDEN_ROLE = "submit"

export class AdvanceRefused extends Error {
  constructor(reason, { role = null } = {}) {
    super(`advanceOnce refused: ${reason}`)
    this.name = "AdvanceRefused"
    this.code = "EADVANCEREFUSED"
    this.reason = reason
    this.role = role
  }
}

/** The click was issued and the page did not become what was expected. Same
 *  shape and same meaning as submit.mjs's SubmitAmbiguous: never retried,
 *  never abandoned, because the request may have reached the ATS. */
export class AdvanceAmbiguous extends Error {
  constructor(detail) {
    super(
      `the advance click was issued and its outcome is unknown: ${detail}. ` +
        `If that control was really a submit, this is an application.`,
    )
    this.name = "AdvanceAmbiguous"
    this.code = "EADVANCEAMBIGUOUS"
    this.detail = detail
  }
}

/**
 * The scanned `next` control, or a stated reason there is not exactly one.
 *
 * Located by the scanner's `data-aj` stamp and by NOTHING ELSE, for the same
 * reason submit.mjs gives: a text fallback is a fuzzy match to a control that
 * moves an application forward, and the label is the board's own text.
 *
 * REFUSES AMBIGUITY IN BOTH DIRECTIONS. No `next` control is a refusal. More
 * than one is also a refusal — "which of these advances the form" is a
 * judgement, and this path does not make judgements.
 */
export function findNextControl(scan) {
  const buttons = scan?.buttons ?? scan?.btns ?? []
  const next = buttons.filter((b) => CLICKABLE_ROLES.has(b?.r))
  if (!next.length) {
    // Say whether the page had a SUBMIT instead, because "no next control" and
    // "this is the last page" are different situations and the caller's correct
    // response differs: one is a defer, the other is a submit.
    const terminal = buttons.some((b) => b?.r === FORBIDDEN_ROLE)
    return {
      ok: false,
      terminal,
      reason: terminal
        ? "the scan found no 'next' control, only a 'submit' one — this is the " +
          "last page, and advancing is not what should happen here"
        : "the scan found no control with role 'next'",
    }
  }
  if (next.length > 1)
    return {
      ok: false,
      terminal: false,
      reason:
        `the scan found ${next.length} controls with role 'next' ` +
        `(${next.map((b) => safeText(b.l, 40)).join(" | ")}) — which one ` +
        `advances the form is a judgement, and this path does not make judgements`,
    }
  const b = next[0]
  if (!b.k)
    return {
      ok: false,
      terminal: false,
      reason: "the 'next' control carries no data-aj stamp to locate it by",
    }
  return { ok: true, key: b.k, label: b.l ?? null, role: b.r }
}

/**
 * Click the control that advances a multi-page form to its next page.
 *
 * @param page      the Playwright page, on the current form page.
 * @param token     the authorizeSubmit() token for this job. NOT spent here —
 *                  see the note below.
 * @param slug      the job slug.
 * @param planSha   sha256 of the plan this page was filled from.
 * @param mode      'dry_run' | 'live'.
 * @param pageUrl   page.url(), the LIVE url.
 * @param scan      the scan of the page as it is now.
 * @returns {{advanced, url, control}}
 */
export async function advanceOnce(
  page,
  {
    token,
    slug,
    planSha,
    mode,
    pageUrl,
    scan = null,
    clickTimeoutMs = 15_000,
    settleMs = 20_000,
  } = {},
) {
  // --- the token, checked but NOT SPENT ------------------------------------
  //
  // A multi-page form needs several advances and exactly one submit, and the
  // token is single-use because the SUBMIT must be. Spending it here would
  // leave nothing to authorise the submit at the end of the form; minting a
  // fresh one per page would make the nonce meaningless. So this verb checks
  // the same bindings `consumeSubmitToken` checks and leaves the nonce live —
  // the authorisation is what says "this worker owns this job on this origin",
  // and advancing is inside that, not beside it.
  if (!isSubmitToken(token))
    throw new AdvanceRefused(
      "no authorization token — nothing may be clicked without one from " +
        "authorizeSubmit(), including a Next button",
    )
  try {
    assertTokenMatches(token, { slug, planSha, mode })
  } catch (e) {
    if (e instanceof TokenError) throw new AdvanceRefused(e.message)
    throw e
  }

  // --- origin, the same binding submitOnce uses ----------------------------
  //
  // Phase 0.1, and it matters MORE here than at the submit: an attacker-
  // controlled redirect on page 2 of a form moves the browser somewhere else,
  // and the next thing this runner does is type the user's answers into
  // whatever is there.
  const bound = submitOrigin(token.apply_url)
  const live = submitOrigin(pageUrl)
  if (!bound || !live || live !== bound)
    throw new AdvanceRefused(
      `authorization is bound to ${bound ?? "no origin"} but the page is on ` +
        `${safeText(live ?? String(pageUrl), 80)} — the browser was moved to ` +
        `another origin`,
    )

  // --- the control ----------------------------------------------------------
  const control = findNextControl(scan)
  if (!control.ok)
    throw new AdvanceRefused(control.reason, {
      role: control.terminal ? FORBIDDEN_ROLE : null,
    })

  // BELT AND BRACES over findNextControl's own filter. The check is repeated
  // rather than trusted because it is the single property this file exists to
  // guarantee, and a future edit to findNextControl that widened the filter
  // would otherwise silently make this function able to submit.
  if (control.role === FORBIDDEN_ROLE || !CLICKABLE_ROLES.has(control.role))
    throw new AdvanceRefused(
      `refusing to actuate a control whose scanned role is ` +
        `'${safeText(control.role, 20)}' — this verb clicks 'next' and nothing else`,
      { role: control.role },
    )

  // --- dry run stops here, having exercised every check --------------------
  if (mode !== "live")
    return { advanced: false, url: pageUrl, control, dryRun: true }

  const locator = page.locator(`[data-aj="${control.key}"]`)
  try {
    await locator.click({ timeout: clickTimeoutMs })
  } catch (e) {
    // A NEXT CLICK THAT THREW IS NOT AUTOMATICALLY SAFE. Playwright's timeout
    // can fire after the event reached the page, and if the scanner's regex was
    // wrong about the role, that dispatched event was a submit. The caller must
    // treat this the way it treats an ambiguous submit.
    throw new AdvanceAmbiguous(safeText(e?.message ?? e, 200))
  }

  try {
    await page.waitForLoadState("domcontentloaded", { timeout: settleMs })
  } catch {
    /* a slow settle is not evidence of anything */
  }

  let url = pageUrl
  try {
    url = page.url()
  } catch (e) {
    throw new AdvanceAmbiguous(
      `the click returned but the page url could not be read: ` +
        safeText(e?.message ?? e, 160),
    )
  }

  // ORIGIN AGAIN, AFTER THE NAVIGATION. The click is the moment a board can
  // move the browser, so binding checked only before it is a check on the page
  // that is no longer there. A caller that fills page 2 without this would be
  // typing the user's answers into whatever the redirect landed on.
  const after = submitOrigin(url)
  if (after !== bound)
    throw new AdvanceAmbiguous(
      `advancing moved the browser from ${bound} to ${safeText(after ?? String(url), 80)}`,
    )

  return { advanced: true, url, control }
}
