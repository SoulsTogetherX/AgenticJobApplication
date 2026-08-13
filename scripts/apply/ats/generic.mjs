// Fallback for any form we do not recognise. This is the ONLY path where the
// model does real work: whatever the fact base cannot resolve is deferred to
// the single approval message, exactly as before.
//
// Every strategy is tried in turn and the engine reports which one worked —
// feed that back into a real adapter when a board shows up often enough.
export default {
  id: "generic",
  match: /.^/, // never auto-matches; selected only as the fallback
  // EXACT ROW FIRST ON THE UNKNOWN-BOARD PATH. `type-enter` commits whatever
  // row the widget has highlighted, which on a list that does not filter — or
  // has not finished filtering — is not the row anybody asked for; `type-click`
  // clicks the row whose whole text IS the value, or clicks nothing. Both
  // orders end up correct now that setCombo() verifies the COMMITTED value
  // rather than the visible text, but they differ in what the field holds when
  // every strategy fails: a wrong value that a later strategy could not undo,
  // versus empty. Measured on Oracle Recruiting Cloud 2026-08-04, where
  // type-enter put "Protected Veteran" into a Veteran Status field.
  //
  // The named adapters keep their own orders, which were measured against those
  // boards; this is the fallback, where nothing is known about the widget.
  comboStrategies: ["type-click", "type-enter", "click-option"],
  // Used when the form labels its attachment inputs uninformatively (just
  // "Attach"); every one of these boards renders the resume slot first.
  fileOrder: ["resume", "cover"],

  fileFields: [
    { match: /resume|\bcv\b/i, doc: "resume" },
    { match: /cover letter/i, doc: "cover" },
  ],
  valueAliases: [],
}
