// audit-submissions — the crude test that sorts "still the form" from
// "a human should look at this", and the reasons it must STAY crude.
//
// The audit exists because every live click this repo has made classified
// `unclassified` with no confirmation_url, and one staged capture proved that
// at least one recorded submission sent nothing: the post-click page for the
// 2026-08-24 Eliza click is the application form, submit button and all.
//
// THE ASYMMETRY IS THE DESIGN. `STILL-A-FORM` is a confident NEGATIVE — the
// page is asking to be submitted, so it was not. Nothing in this file is
// allowed to produce a confident POSITIVE, because a page misread as a
// confirmation records an application that was never sent and nothing later
// corrects it. That is why an ambiguous page reports UNCLEAR rather than
// guessing, and why the audit never writes to the ledger.
import test from "node:test"
import assert from "node:assert/strict"

import { verdictFor } from "../../scripts/dev/audit-submissions.mjs"

const page = (body) => `<html><body>${body}</body></html>`

test("a page still offering its submit is STILL-A-FORM", () => {
  // The real shape, from jobs/.auto/post-submit/board-22ccfdc08c99.html.
  assert.equal(
    verdictFor(
      page(`<form><label>Name</label><input>
            <button type="submit">Submit Application</button></form>`),
    ),
    "STILL-A-FORM",
  )
})

test("a real confirmation page reads looks-confirmed", () => {
  // The wording the promoted Ashby captures actually carry.
  assert.equal(
    verdictFor(page(`<h1>Application Success</h1><p>We'll be in touch.</p>`)),
    "looks-confirmed",
  )
})

test("BOTH markers is UNCLEAR, never a confirmation", () => {
  // A confirmation banner rendered ABOVE a still-live form is exactly the
  // ambiguous case, and the safe reading is "a human looks at it". Calling
  // this confirmed is the unrecoverable direction.
  const v = verdictFor(
    page(`<div>Thank you for your application</div>
          <form><button>Submit Application</button></form>`),
  )
  assert.equal(v, "UNCLEAR (both markers)")
  assert.notEqual(v, "looks-confirmed")
})

test("NEITHER marker is UNCLEAR, not a pass", () => {
  // An error page, a redirect stub, a challenge — none of these is evidence
  // that anything was sent.
  assert.equal(
    verdictFor(page(`<h1>Something went wrong</h1>`)),
    "UNCLEAR (neither marker)",
  )
})

test("the negative verdict does not fire on prose that merely mentions applying", () => {
  // A confirmation page often says the word "application". It must not be
  // dragged back to STILL-A-FORM by that alone — only a live submit control
  // does that.
  assert.equal(
    verdictFor(
      page(`<h1>Application Success</h1>
            <p>Your application has been received.</p>`),
    ),
    "looks-confirmed",
  )
})

test("an empty or junk page is UNCLEAR rather than throwing", () => {
  for (const html of ["", "<html></html>", "not html at all"])
    assert.match(verdictFor(html), /^UNCLEAR/, JSON.stringify(html))
})
