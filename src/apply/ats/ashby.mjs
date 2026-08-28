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
  //
  // SCHOOL IS THE SAME CONTROL. MEASURED on Quora's Ashby form, 2026-08-18:
  //   <label class="_heading_ _required_">School</label>
  //   <input role="combobox" placeholder="Search schools..." aria-haspopup="listbox">
  // Opened with no query it lists nothing; typed into ("University of Nevada")
  // it lists server-side matches — "University of Nevada, Las Vegas / United
  // States / unlv.edu" among them. Same rule, same limits: the banked value is
  // typed, the engine reads the committed value back, and a spelling the
  // search does not offer under that name is a failed fill (blocks), never a
  // near-miss taken. The bank's School answer must therefore be spelled the
  // way the board's list spells it (comma, not hyphen, on Ashby).
  // "WHERE ARE YOU CURRENTLY LOCATED?" IS THE SAME CONTROL, ASKED IN A
  // SENTENCE. MEASURED on jobs.ashbyhq.com/openai, 2026-08-20: the same
  // server-queried place combobox, but labelled as a question rather than as
  // "Location", so the pattern above missed it. The whole application deferred
  // on that one field — answer-bank resolved it `NEEDS-CHOICE a-091@exact`
  // with the note "field was not probed", which is exactly the state this
  // adapter exists to explain — while the banked answer ("North Las Vegas,
  // Nevada, United States", source: user) sat unused.
  //
  // DELIBERATELY NARROW, and the narrowness is the point. A loose /located/
  // would also catch "Do you currently live or are you willing to relocate to
  // the job's location?" — a three-way CHOICE whose right answer depends on
  // where the job is, and typing a city into it would be a wrong answer rather
  // than a deferred one. So the wording is pinned, and a board that invents a
  // fourth phrasing defers until someone measures it and adds it here.
  typeaheadFields: [
    { match: /^\s*location\s*\**\s*$/i },
    { match: /^\s*school\s*\**\s*$/i },
    { match: /^\s*where\s+are\s+you\s+currently\s+located\s*\?*\s*\**\s*$/i },
  ],

  // A FILE INPUT THAT IS NOT AN ATTACHMENT SLOT: Ashby's "Autofill from resume"
  // control. MEASURED on every live Ashby form scanned 2026-08-06..17 (Render,
  // Watershed, Hims & Hers, Eliza, Flock Safety, Quora): the scan carries
  //   {k:"f1", t:"file", l:"Name", req:true}          <- this one
  //   {k:"f2", sel:"#_systemfield_name", t:"text", l:"Name", req:true}
  //   {k:"f4", sel:"#_systemfield_resume", t:"file", l:"Resume", req:true}
  // The first is the hidden helper input behind Ashby's autofill button; it has
  // no id or name of its own, so the scanner's label search finds the NEXT
  // control's label ("Name") and its required marker. buildPlan then reported
  // it as an "unrecognised attachment slot", which typed as `doc-unverified`
  // and deferred EVERY Ashby application unattended (five of five on the
  // 2026-08-17 run carried it as a secondary kind).
  //
  // KNOWLEDGE, NOT BEHAVIOUR (rule 6's first lawful route — an adapter that
  // knows a board's shape): this says what the control IS. buildPlan skips it
  // and uploads nothing to it. Every clause is load-bearing, and it is
  // deliberately narrower than "any file input with a borrowed label":
  //   * `t === "file"` with NO selector — a real Ashby slot has one
  //     (`#_systemfield_resume`, `#cover_letter`); the helper has none.
  //   * its label is the label of a NON-file field on the same scan, i.e. it
  //     borrowed one — a genuine attachment slot labelled like a text field is
  //     not a shape this board renders.
  //   * the scan also carries a real résumé slot, so skipping this one cannot
  //     leave the application with nowhere to put the résumé.
  // The last clause is the safe direction: if the board ever renders the
  // helper WITHOUT a real slot beside it, this returns false and the field
  // still defers.
  helperFileInput(f, scan) {
    if (!f || f.t !== "file" || f.sel) return false
    const fields = scan?.fields ?? []
    const label = String(f.l ?? "")
      .trim()
      .toLowerCase()
    if (!label) return false
    const borrowed = fields.some(
      (o) =>
        o !== f &&
        o.t !== "file" &&
        String(o.l ?? "")
          .trim()
          .toLowerCase() === label,
    )
    if (!borrowed) return false
    return fields.some(
      (o) =>
        o !== f &&
        o.t === "file" &&
        o.sel &&
        /resume|\bcv\b/i.test(String(o.l ?? "")),
    )
  },

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
