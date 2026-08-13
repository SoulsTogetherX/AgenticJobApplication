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

  // A CONTROL THAT LOOKS LIKE A DROPDOWN AND IS NOT ONE.
  //
  // MEASURED on Ashby, 2026-08-04 and again on three live Render applications
  // 2026-08-06. Location renders as
  //   <label class="_heading_ _required_">Location</label>
  //   <input role="combobox" placeholder="Start typing...">
  // and its list is built from a SERVER QUERY as you type. Opened with no
  // query it renders "No results" and declares no [role=option] at all, so the
  // scanner correctly records zero options — there is no list to enumerate,
  // now or ever. The field then resolved NEEDS-CHOICE "field was not probed"
  // and a human typed the value in by hand on every single application.
  //
  // KNOWLEDGE, NOT BEHAVIOUR, the rule for this whole directory: this says
  // what the control IS. It opens nothing, types nothing and chooses nothing.
  // What consumes it (buildPlan) still requires an approved value to type.
  //
  // Why this is not the defer list being quietly shortened: rule 6 permits
  // exactly three ways to defer less, and this is the first of them — an
  // adapter that knows a board's shape. An enumerated dropdown nobody probed
  // is an unknown and still blocks; this control has no enumeration to miss,
  // so "unprobed" was never the right reading of it. Nothing here lets a model
  // near the page, and a field with no approved value still defers.
  typeaheadFields: [{ match: /^\s*location\s*\**\s*$/i }],

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
