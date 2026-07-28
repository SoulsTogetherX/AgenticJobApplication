// Lever (jobs.lever.co). Plainer than Greenhouse: mostly native inputs and
// selects, with a conventional file input for the resume.
export default {
  id: "lever",
  match: /(^|\.)lever\.co/i,

  // Native <select> elements are handled by the `select` verb, so the combo
  // strategies here only matter for Lever's few custom pickers.
  comboStrategies: ["click-option", "type-enter", "type-click"],

  // Used when the form labels its attachment inputs uninformatively (just
  // "Attach"); every one of these boards renders the resume slot first.
  fileOrder: ["resume", "cover"],

  fileFields: [
    { match: /resume|\bcv\b/i, doc: "resume" },
    { match: /cover letter|additional information/i, doc: "cover" },
  ],

  valueAliases: [],
}
