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

  // Lever serves the ad at /<org>/<id> and the form at /<org>/<id>/apply.
  // Knowledge only: returns a string, opens nothing, and leaves a URL it does
  // not recognise exactly as it found it.
  applicationUrl(url) {
    try {
      const u = new URL(String(url))
      if (!/(^|\.)lever\.co$/i.test(u.hostname)) return String(url)
      if (/\/apply\/?$/i.test(u.pathname)) return u.toString()
      if (!/^\/[^/]+\/[^/]+\/?$/.test(u.pathname)) return String(url)
      u.pathname = u.pathname.replace(/\/?$/, "") + "/apply"
      return u.toString()
    } catch {
      return String(url)
    }
  },
}
