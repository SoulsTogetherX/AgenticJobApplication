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
}
