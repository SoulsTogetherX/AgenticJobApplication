// Fallback for any form we do not recognise. This is the ONLY path where the
// model does real work: whatever the fact base cannot resolve is deferred to
// the single approval message, exactly as before.
//
// Every strategy is tried in turn and the engine reports which one worked —
// feed that back into a real adapter when a board shows up often enough.
export default {
  id: "generic",
  match: /.^/, // never auto-matches; selected only as the fallback
  comboStrategies: ["type-enter", "type-click", "click-option"],
  // Used when the form labels its attachment inputs uninformatively (just
  // "Attach"); every one of these boards renders the resume slot first.
  fileOrder: ["resume", "cover"],

  fileFields: [
    { match: /resume|\bcv\b/i, doc: "resume" },
    { match: /cover letter/i, doc: "cover" },
  ],
  valueAliases: [],
}
