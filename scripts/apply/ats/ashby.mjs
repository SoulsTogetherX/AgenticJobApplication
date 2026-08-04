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

  // WHERE THE FORM IS, given a POSTING url. Ashby serves the job ad at
  // /<org>/<id> and the application form at /<org>/<id>/application; the ad
  // carries no fields at all, so a runner handed the posting scans it, finds
  // nothing to fill and defers with "nothing to fill" — measured on a real
  // lead, 2026-08-03.
  //
  // KNOWLEDGE, NOT BEHAVIOUR, which is the rule for everything in this
  // directory: it returns a string, it opens nothing, and a URL it does not
  // recognise comes back unchanged rather than guessed at.
  applicationUrl(url) {
    try {
      const u = new URL(String(url))
      if (!/(^|\.)ashbyhq\.com$/i.test(u.hostname)) return String(url)
      if (/\/application\/?$/i.test(u.pathname)) return u.toString()
      // /<org>/<uuid> only. Anything deeper is already somewhere specific and
      // appending to it would invent a path.
      if (!/^\/[^/]+\/[^/]+\/?$/.test(u.pathname)) return String(url)
      u.pathname = u.pathname.replace(/\/?$/, "") + "/application"
      return u.toString()
    } catch {
      return String(url)
    }
  },
}
