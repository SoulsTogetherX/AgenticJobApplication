// Greenhouse (job-boards.greenhouse.io, incl. the /embed/job_app iframe used by
// company-hosted careers pages).
//
// Field map verified live against Coinbase's board on 2026-07-27: react-select
// widgets for every dropdown, intl-tel-input for phone, and file inputs that
// React discards unless the real chooser is used.
export default {
  id: "greenhouse",
  match: /(^|\.)greenhouse\.io/i,

  // type-enter first: it resolved 16 of 19 dropdowns in the live run. The
  // education selects (School/Degree/Discipline) needed the exact row clicked,
  // which is what type-click does, so it is the immediate fallback.
  comboStrategies: ["type-enter", "type-click", "click-option"],

  // Used when the form labels its attachment inputs uninformatively (just
  // "Attach"); every one of these boards renders the resume slot first.
  fileOrder: ["resume", "cover"],

  fileFields: [
    { match: /resume|\bcv\b/i, doc: "resume" },
    { match: /cover letter/i, doc: "cover" },
  ],

  // Greenhouse renders its country picker with the dial code appended
  // ("United States +1") and shows only "+1" once chosen, so an exact-match
  // verification would report a false mismatch.
  valueAliases: [
    {
      label: /^country/i,
      value: /united states/i,
      accept: /\+1|united states/i,
    },
  ],

  // WHERE THE FORM IS, and on Greenhouse this fixes TWO separate failures.
  //
  // 1. THE BOARD URL CAN REDIRECT OFF THE BOARD. Measured on a real lead
  //    (2026-08-03): job-boards.greenhouse.io/coinbase/jobs/8022068 answered
  //    with a 30x to www.coinbase.com/careers/positions/..., the company's own
  //    site. The runner scanned a job ad, found no fields and deferred with
  //    "nothing to fill". Worse, the page it had landed on was a DIFFERENT
  //    ORIGIN from the one the submit token was bound to, so even a filled form
  //    could not have been submitted.
  // 2. THE AD AND THE FORM ARE DIFFERENT PAGES. The embed endpoint serves the
  //    raw application form — 35 fields and a Submit control on the Coinbase
  //    posting above — and it does NOT redirect, so the runner stays on the
  //    allowlisted origin the token was minted against.
  //
  // Knowledge, not behaviour: a string in, a string out, nothing opened, and a
  // URL whose shape is not recognised is returned untouched rather than
  // rewritten on a guess.
  applicationUrl(url) {
    try {
      const u = new URL(String(url))
      if (!/greenhouse\.io$/i.test(u.hostname)) return String(url)
      if (/\/embed\/job_app/i.test(u.pathname)) return u.toString()
      const m = /^\/([^/]+)\/jobs\/(\d+)\/?$/.exec(u.pathname)
      if (!m) return String(url)
      // THE HOST IS PRESERVED, and that is load-bearing rather than tidy. An
      // earlier version hardcoded job-boards.greenhouse.io, which silently
      // moved a posting served from boards.greenhouse.io onto a DIFFERENT
      // ORIGIN — so the trust gate refused a board the user had allowlisted,
      // and a submit token minted against the posting could never have been
      // spent on the form. Caught by the existing suite, whose fixtures use
      // the other host. The embed endpoint exists on whichever Greenhouse host
      // served the posting, so keeping it is both correct and the only way
      // this function keeps the promise its comment makes.
      return `${u.origin}/embed/job_app?for=${encodeURIComponent(m[1])}&token=${encodeURIComponent(m[2])}`
    } catch {
      return String(url)
    }
  },
}
