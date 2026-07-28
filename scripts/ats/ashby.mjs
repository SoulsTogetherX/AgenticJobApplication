// Ashby (jobs.ashbyhq.com). Custom React dropdowns similar in shape to
// Greenhouse's, and a drag-or-click file field.
export default {
  id: "ashby",
  match: /(^|\.)ashbyhq\.com/i,

  comboStrategies: ["type-enter", "click-option", "type-click"],

  // Used when the form labels its attachment inputs uninformatively (just
  // "Attach"); every one of these boards renders the resume slot first.
  fileOrder: ["resume", "cover"],

  fileFields: [
    { match: /resume|\bcv\b/i, doc: "resume" },
    { match: /cover letter/i, doc: "cover" },
  ],

  valueAliases: [],
}
