// scan-page.js — the page scanner itself: a bare function expression taking an
// optional PROBE flag. This file is the single source of truth; scan.driver.mjs
// reads it off disk and injects it as window.__ajScan.
//
// Direct fallback (if browser_run_code_unsafe is unavailable): paste this whole
// function as the browser_evaluate `function` argument. Called with no args it
// probes dropdowns, exactly like a first scan.
//
// It stamps every interactive element with data-aj="<key>", so `[data-aj="f7"]`
// is a unique selector usable as `target` in every Playwright tool.
//
// Output keys are short on purpose: k=key, t=type, l=label, req=required,
// v=current value, opts=choices, o=stamped sub-options, h=help text,
// sel=stable app-owned selector (id/name/aria-label) that outlives a React
// remount, which data-aj does not — fill plans fall back to it.
//
// Four more, each present only when it has something to say:
//   optsTruncated / optsTotal
//               the option list was CUT at MAX_OPTS and this is how long it
//               really was. Without it, 40 survivors of a 200-option country
//               list are indistinguishable from a genuine 40-option list: the
//               field cache stores the short list as complete, and an answer
//               the form does offer, past the cut, is deferred as unofferable.
//   section     the section heading the field sits under, when there is one
//               and it is neither the page heading nor a repeat of the label.
//               Greenhouse labels BOTH attachment inputs "Attach" and the word
//               that tells resume from cover letter is this heading, which
//               sits outside the element the label waterfall reads. REPORTED,
//               never merged into `l` — see the block that computes it.
//   widget      "aria" on a control none of the native loops collected: a div,
//               span or custom element with tabindex >= 0 or contenteditable,
//               a declared control role, or DECLARED STATE. The last of those
//               is the only one that can be a native tag — a <button> or an
//               <input type="submit"> carrying aria-checked / -pressed /
//               -selected is a value rather than an action, and the button
//               loop hands it over rather than filing it. No verb in this
//               pipeline can operate any of them; see the block that collects
//               them for why that is deliberate, and for why the DETECTOR is
//               reachability and state rather than a list of roles.
//               "buttons" on a QUESTION ANSWERED BY A ROW OF CUSTOM OPTION
//               CONTROLS — <button>s, or the focusable role-less leaves an ORC
//               form uses — see the block that collects those. The key keeps
//               the name it was given for the <button> case because its MEANING
//               is unchanged and consumers read it: no verb in this pipeline
//               operates any of them. Same meaning, and it is set
//               whether or not the answer set was recognised, because the
//               fill engine refuses to touch a <button> either way. What the
//               recognition changes is `t`, and through it whether the answer
//               travels with the defer; it never makes the control operable.
// `t` is correspondingly "aria-<role>" when the element declares a role this
// file recognises ("aria-checkbox", "aria-menuitemradio", "aria-option", ...)
// and the generic "widget" when it does not. BOTH are types fill-plan.mjs's
// VERB map has no entry for, so both DEFER rather than being acted on, which
// is the whole point of emitting them. The role only picks the string; it never
// decides whether the control is reported.
//
// WHAT THE ELEMENT SAYS IT IS, reported as fields of its own rather than left
// inside `sel` for a consumer to reverse-engineer out of a selector string:
//   n   the element's `name` attribute, verbatim
//   ac  the element's `autocomplete` attribute, verbatim, minus the two
//       reserved values ("on"/"off") that name no field
// plus `t`, which has always been here.
//
// READ THIS BEFORE USING ANY OF THEM. A PAGE CHOOSES ALL THREE; NONE IS
// EVIDENCE ABOUT WHAT THE VALUE WILL BE USED FOR. They are reported, not
// trusted. Two things they are legitimately for:
//
//   1. VERB SELECTION. Whether a control is typed into, ticked, or handed a
//      file is decided by `t`, and a consumer should not be parsing that back
//      out of a CSS selector. This is the real defect fixed here.
//   2. MAKING A SUBSTITUTION NON-SILENT. Showing the target's real `name`
//      beside the label in an approval message means a swapped field is
//      visible to the user even when no check detected it.
//
// WHAT THEY ARE NOT: a control against a lying label. A consumer may compare
// them with `l` and defer on a contradiction, and that is worth having,
// but it is a PATCH and it is defeated by a one-line rename. Measured
// (innov-resilience 2026-07-31, reproduced here by running this file through
// tests/fixtures/boards/dom.mjs over a variant of the mislabelled fixture in
// which id, name and autocomplete were all renamed to agree with the lying
// label): 3 of 4 hostile fields go undetected, and nothing a user could see
// changes. Specifically —
//   - `type` has no token for any sensitive category. There is no
//     type="ssn" and no type="salary"; a real SSN box is type="text". It
//     caught zero of the two text-typed attacks. `type` is load-bearing for
//     choosing a VERB and worthless for establishing identity.
//   - `autocomplete` appears on zero of the four honest board pages in
//     tests/fixtures/boards/pages/ and on exactly one page in this repo,
//     the hostile one. A signal only attackers supply must never be a guard
//     input.
//   - `name` is usually the wire key a form submits under, which is some cost
//     to lying — but a React board posts JSON off `.value` and never reads
//     `name`, so on a SPA it is as decorative as `id`. ADVISORY.
// And the one no scanner can reach at all: a field's MEANING is decided
// server-side. An input named `phone`, labelled "Phone number" and typed
// `tel` can POST into a column called `ssn`, and that fact is not in the
// document. The real control against a government ID being typed into a form
// is value-side — such a value never enters the answer bank — not here.
// If anyone describes these three keys as closing that finding, that is a
// documentation defect.
//
// Two long keys, on checkbox/radio groups only, because a tick is the one
// thing on a form that ASSERTS something and fill-plan.mjs will not tick a box
// the scanner cannot vouch for:
//   labelExact  true (or absent — never false) — `l` is the COMPLETE, VISIBLE
//               text of this control's label. Only set for a single-control
//               checkbox/radio group; `l` is then UNTRUNCATED and may exceed
//               the 120 chars every other label is cut to.
//   labelWhy    why the vouch was refused. Advisory, for humans reading a
//               defer; nothing decides on it.
//
// And one on ANY field: lSeen — the VISIBLE label, present only when `l` is
// NOT text the user can read and a visible label says something else. That
// covers an aria-label or a placeholder, and also an aria-labelledby pointed at
// a hidden element — the test is whether every element `l` came from is visible
// to the eye, not which source name it carries. `l` never changes for those
// fields; a caller showing the user a field should show both, because a page
// contradicting itself is information. Absent on an honest field, so it costs
// nothing on the wire.
//
// Self-installing: evaluating this file defines window.__ajScan. To paste it
// directly into browser_evaluate instead, paste from `async (PROBE` onward.
//
// NOT a module: no imports, no exports, no leading semicolon (see .prettierignore).
window.__ajScan = async (PROBE = true) => {
  const MAX_OPTS = 40
  const MAX_PROBE = 15

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  // full() is txt() without the slice. Every label is computed at full length
  // and only truncated on the way OUT, because truncation upstream of the
  // comparison is what let a 131-char certification and the same text with
  // " I also agree to binding arbitration." appended produce one identical
  // string. See the labelExact block below.
  const full = (s) =>
    String(s == null ? "" : s)
      .replace(/\s+/g, " ")
      .trim()
  const txt = (s, n = 120) => full(s).slice(0, n)
  const vis = (el) => {
    if (!el || !el.isConnected) return false
    const r = el.getBoundingClientRect()
    const st = getComputedStyle(el)
    return (
      (r.width > 0 || r.height > 0) &&
      st.visibility !== "hidden" &&
      st.display !== "none" &&
      st.opacity !== "0"
    )
  }
  const uniq = (a) => [...new Set(a.filter(Boolean))]

  let nf = 0
  let nb = 0
  const elOf = new Map()
  const stamp = (el, prefix) => {
    const k = prefix + (prefix === "b" ? ++nb : ++nf)
    el.setAttribute("data-aj", k)
    elOf.set(k, el)
    return k
  }

  // "IS THIS ELEMENT ALREADY COLLECTED **BY THIS RUN**?" — and the emphasis is
  // the whole point. Every collecting loop below used to ask
  // `el.closest("[data-aj]")`, which reads a DOM ATTRIBUTE THAT SURVIVES THE
  // SCAN THAT WROTE IT. A second scan of the same document therefore skipped
  // every control the first scan had stamped, and came back with a form made
  // only of native <input>s — which is not a theoretical path: scan-engine.mjs
  // and scan.driver.mjs both RE-SCAN when the first pass found no buttons (the
  // React-hydration tell), so on a page that hydrates slowly the second scan
  // silently lost every combo, every richtext box and every custom widget.
  // Found by Shape F's own tests, whose pages have no button and so always take
  // the re-scan path; the same defect was already live for combos and richtext.
  //
  // `elOf` is rebuilt on every run, so a stamp this run did not write fails the
  // identity check and the element is collected again — with a fresh key.
  const claimedNow = (el) => {
    let p = el
    while (p) {
      const k = p.getAttribute && p.getAttribute("data-aj")
      if (k && elOf.get(k) === p) return true
      p = p.parentElement
    }
    return false
  }

  // data-aj stamps are DOM attributes and do NOT survive a React remount —
  // uploading a file on Greenhouse re-renders the form and drops every stamp.
  // So each field also carries a selector built from attributes the app owns,
  // which a fill plan can fall back to. Null when nothing unique is available.
  // An id needs CSS identifier escaping; an attribute VALUE sits inside quotes
  // and only needs the quote and backslash escaped (CSS.escape would turn a
  // space into \20 and break the match).
  const escIdent = (s) =>
    window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/[^\w-]/g, "\\$&")
  const escAttr = (s) => String(s).replace(/(["\\])/g, "\\$1")
  const uniqueSel = (sel) => {
    try {
      return document.querySelectorAll(sel).length === 1 ? sel : null
    } catch {
      return null
    }
  }
  const stableSel = (el) => {
    if (!el || !el.getAttribute) return undefined
    if (el.id) {
      const s = uniqueSel("#" + escIdent(el.id))
      if (s) return s
    }
    const tag = el.tagName.toLowerCase()
    for (const attr of ["name", "data-testid", "data-qa", "aria-label"]) {
      const v = el.getAttribute(attr)
      if (!v) continue
      const s = uniqueSel(tag + "[" + attr + '="' + escAttr(v) + '"]')
      if (s) return s
    }
    return undefined
  }

  // The element's OWN identity statements, verbatim and unnormalised — the
  // scanner reports what the page wrote and nothing more. See the header for
  // what these are for (verb selection, and making a substitution visible)
  // and, more importantly, what they are NOT (evidence about the field).
  //
  // "on"/"off" are the two reserved autocomplete values; they answer "should
  // the browser autofill this" and name no field, so emitting them would put
  // a category-free string on the wire for every field on a form that turns
  // autofill off wholesale. Every other value is an autofill field name.
  //
  // A key it has nothing to say is OMITTED, not set to undefined: a consumer
  // asking `"n" in f` must get a straight answer, and a form that uses neither
  // attribute pays nothing.
  const AC_RESERVED = { on: 1, off: 1 }
  const identityOf = (el) => {
    const out = {}
    if (!el || !el.getAttribute) return out
    const n = full(el.getAttribute("name"))
    if (n) out.n = n
    const ac = full(el.getAttribute("autocomplete"))
    if (ac && !AC_RESERVED[ac.toLowerCase()]) out.ac = ac
    return out
  }

  const byId = (id) => {
    try {
      return id ? document.getElementById(id) : null
    } catch {
      return null
    }
  }

  // labelDetail resolves a control's label at FULL length and records HOW it
  // was found and WHICH elements' rendered text it came from. labelOf() below
  // is the old function exactly: the same waterfall, the same 120-char cut, so
  // every field that does not opt into exactness is byte-for-byte unchanged.
  //
  //   src  labelledby  aria-labelledby -> the referenced elements' innerText
  //        arialabel   the aria-label ATTRIBUTE (never visible on the page)
  //        for         <label for="id">
  //        wrap        an enclosing <label>
  //        legend      the enclosing fieldset's <legend> (a group heading)
  //        near        a nearby label-ish element found by walking ancestors
  //        attr        placeholder or name, as a last resort
  // `skipAttr` skips BOTH attribute-driven sources — aria-labelledby as well
  // as aria-label. Callers pass it to ask "what would this control's label be
  // if the page could not choose it through an attribute?", and aria-labelledby
  // is exactly as attribute-chosen as aria-label: it names an element by id
  // from outside that element, so a page can point it at text the user cannot
  // see while a plain <label for> says something else. seenOf() below needs the
  // <label>, and would otherwise get the same referenced text back.
  function labelDetail(el, skipAttr) {
    const attr = (a) => (el.getAttribute ? el.getAttribute(a) : null)
    const lb = skipAttr ? null : attr("aria-labelledby")
    if (lb) {
      const nodes = lb
        .split(/\s+/)
        .map((i) => byId(i))
        .filter(Boolean)
      const t = full(
        nodes
          .map((n) => n.innerText)
          .filter(Boolean)
          .join(" "),
      )
      if (t) return { text: t, src: "labelledby", nodes: nodes }
    }
    const al = attr("aria-label")
    if (!skipAttr && full(al))
      return { text: full(al), src: "arialabel", nodes: [] }
    if (el.id) {
      let l = null
      try {
        l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`)
      } catch {}
      if (l && full(l.innerText))
        return { text: full(l.innerText), src: "for", nodes: [l] }
    }
    const wrap = el.closest && el.closest("label")
    if (wrap && full(wrap.innerText))
      return { text: full(wrap.innerText), src: "wrap", nodes: [wrap] }
    const fs = el.closest && el.closest("fieldset")
    const lg = fs && fs.querySelector("legend")
    if (lg && full(lg.innerText))
      return { text: full(lg.innerText), src: "legend", nodes: [lg] }
    let p = el.parentElement
    for (let i = 0; i < 4 && p; i++, p = p.parentElement) {
      const cand = p.querySelector(
        "label,legend,[class*='label'],[class*='Label'],[class*='question'],[class*='Question']",
      )
      if (cand && !cand.contains(el) && full(cand.innerText)) {
        return { text: full(cand.innerText), src: "near", nodes: [cand] }
      }
    }
    return { text: full(el.placeholder || el.name || ""), src: "attr", nodes: [] }
  }

  function labelOf(el) {
    return txt(labelDetail(el).text)
  }

  // --- can the scanner VOUCH for a label? ----------------------------------
  // `labelExact: true` is a positive assertion with one meaning: THIS FIELD'S
  // `l` IS THE COMPLETE, VISIBLE TEXT OF THE CONTROL'S LABEL. It is what
  // fill-plan.mjs requires before a consent checkbox may ever be ticked
  // unattended, because the string matched against the user's allowlist, the
  // string the user approved, and the string shown in the approval message have
  // to be ONE string, and it has to be the whole thing.
  //
  // Two demonstrated attacks it exists to stop:
  //   DECOUPLING  <input aria-label="I certify the information is true"> beside
  //               <span>I agree to binding arbitration and waive a jury
  //               trial.</span> — the page picks what is MATCHED independently
  //               of what is DISPLAYED. So an attribute (aria-label, title,
  //               placeholder, name) can never establish exactness: it is not
  //               text the user can read. Only rendered DOM text can.
  //   TRUNCATION  a 131-char certification and the same text plus " I also
  //               agree to binding arbitration." used to slice to the identical
  //               120 chars. So a vouched label is never truncated.
  //
  // Everything below fails CLOSED. Every unclear case leaves labelExact unset,
  // and the cost of that is the user ticking a box in the browser, which is
  // hard rule 6 anyway. There is deliberately no attribute, flag or option a
  // page can set to make this true — the only way is to have a plain, visible,
  // unambiguous label, and then the vouched string IS the one on screen.
  const MAX_EXACT = 1000
  const WORDY = /[\p{L}\p{N}]/u
  const VOUCHABLE = { labelledby: 1, for: 1, wrap: 1 }

  // vis() passes anything with a box, which includes the screen-reader-only
  // idiom (1x1 clipped) and anything parked off the left edge. Those are real
  // to an accessibility tree and invisible to the person reading the form, so
  // they can label a field but can never VOUCH for one. Measured against the
  // document, not the viewport, so scroll position cannot change the answer.
  //
  // THE DECOUPLING ATTACK DOES NOT NEED JAVASCRIPT. Hiding text from the eye
  // while leaving it in innerText is pure CSS, and an earlier version of this
  // check caught almost none of it:
  //   - color: transparent, or any colour with alpha 0
  //   - font-size: 0
  //   - opacity: 0 on an ANCESTOR — opacity does not inherit, so the element's
  //     own computed opacity is still "1" and a check on the element alone
  //     passes. This is the one that made the rest of the list reachable.
  //   - another element painted over the top
  // visibility and display are not on that list: visibility INHERITS, so
  // getComputedStyle reports an ancestor's "hidden" on the child, and an
  // ancestor's display:none leaves the child with no box at all.
  const alpha0 = (c) => /^(transparent$|rgba\([^)]*,\s*0(\.0*)?\s*\))/i.test(c)
  const visibleToEye = (el) => {
    if (!vis(el)) return false
    // checkVisibility does the ancestor-opacity walk natively where it exists
    // (Chromium 105+, which is what this runs in); the loop below is the
    // fallback and the thing the tests exercise.
    if (typeof el.checkVisibility === "function") {
      try {
        if (
          !el.checkVisibility({
            checkOpacity: true,
            checkVisibilityCSS: true,
            contentVisibilityAuto: true,
          })
        ) {
          return false
        }
      } catch {}
    }
    for (let p = el, i = 0; p && i < 30; p = p.parentElement, i++) {
      let st
      try {
        st = getComputedStyle(p)
      } catch {
        return false
      }
      if (!st) return false
      if (Number(st.opacity) === 0) return false
    }
    let own
    try {
      own = getComputedStyle(el)
    } catch {
      return false
    }
    if (alpha0(String(own.color || ""))) return false
    if (parseFloat(own.fontSize || "16") < 6) return false

    const r = el.getBoundingClientRect()
    if (r.width < 8 || r.height < 8) return false
    const sx = window.scrollX || window.pageXOffset || 0
    const sy = window.scrollY || window.pageYOffset || 0
    if (!(r.right + sx > 0 && r.bottom + sy > 0)) return false

    // Occlusion. elementFromPoint is viewport-relative and returns null for a
    // point that is not on screen, so this can only be checked for a label
    // that happens to be in view — and the scanner will not scroll the user's
    // page to find out. STATED LIMIT: a label below the fold is vouched
    // without an occlusion check. Everything else above still applies to it.
    const cx = r.left + r.width / 2
    const cy = r.top + r.height / 2
    const inView =
      cx >= 0 &&
      cy >= 0 &&
      cx < (window.innerWidth || 0) &&
      cy < (window.innerHeight || 0)
    if (inView && document.elementFromPoint) {
      let top = null
      try {
        top = document.elementFromPoint(cx, cy)
      } catch {}
      if (!top) return false
      if (top !== el && !el.contains(top) && !top.contains(el)) return false
    }
    return true
  }

  // CSS ::before/::after content renders on screen and is absent from
  // innerText — the one way left to show the user words the scanner cannot
  // read. A decorative marker ("*", a bullet, an icon url()) is fine; anything
  // carrying letters or digits is not.
  const pseudoText = (root) => {
    let nodes
    try {
      nodes = [root].concat([...root.querySelectorAll("*")])
    } catch {
      return "unreadable subtree"
    }
    if (nodes.length > 60) return "label subtree too complex to vouch for"
    for (const n of nodes) {
      for (const p of ["::before", "::after"]) {
        let c = ""
        try {
          c = String(getComputedStyle(n, p).content || "")
        } catch {
          return "unreadable style"
        }
        const s = c
          .replace(/url\([^)]*\)/g, "")
          .replace(/["']/g, "")
          .trim()
        if (!s || s === "none" || s === "normal") continue
        if (WORDY.test(s)) return "CSS content renders extra text"
      }
    }
    return ""
  }

  // The label has to be the text NEXT TO the control, not merely associated
  // with it: label[for] reaches across a whole document, and a heading at the
  // top of the page is not what a user reads when they tick a box near the
  // bottom of it.
  //
  // The walk stops at BODY deliberately. Including it makes this check a no-op
  // on any shallow form — body contains everything, so every label on the page
  // would count as adjacent.
  const nearnessTo = (el) => {
    const chain = []
    for (let p = el, i = 0; p && i < 5; p = p.parentElement, i++) {
      if (p.tagName === "BODY" || p.tagName === "HTML") break
      chain.push(p)
    }
    return (n) => chain.some((a) => a === n || (a.contains && a.contains(n)))
  }

  // Returns "" when the label can be vouched for, else the reason it cannot.
  function vouchFail(el, d) {
    if (!VOUCHABLE[d.src]) return "label source is " + d.src
    if (!d.text || !WORDY.test(d.text)) return "label has no words"
    if (d.text.length > MAX_EXACT) return "label longer than " + MAX_EXACT
    if (!d.nodes.length) return "label came from no element"

    const near = nearnessTo(el)
    for (const n of d.nodes) {
      if (!visibleToEye(n)) return "label text is not visibly rendered"
      if (!near(n)) return "label is not adjacent to the control"
      const ghost = pseudoText(n)
      if (ghost) return ghost
      // A <label> holding two controls does not say which one it means.
      let inner = []
      try {
        inner = [...n.querySelectorAll("input,select,textarea")]
      } catch {}
      if (inner.length > 1 || (inner.length === 1 && inner[0] !== el)) {
        return "label covers more than this control"
      }
    }

    // Nothing else may claim this control and say something different. An
    // aria-label that AGREES is harmless; one that differs is the decoupling
    // attack, and there is no way to tell a benign disagreement from a hostile
    // one, so both defer.
    const rivals = []
    const push = (s) => {
      if (full(s)) rivals.push(full(s))
    }
    push(el.getAttribute && el.getAttribute("aria-label"))
    push(el.getAttribute && el.getAttribute("title"))
    if (el.id) {
      let same = []
      try {
        same = [...document.querySelectorAll(`label[for="${CSS.escape(el.id)}"]`)]
      } catch {}
      if (same.length > 1) return "two <label for> elements claim this control"
      for (const l of same) push(l.innerText)
      let dupes = []
      try {
        dupes = [...document.querySelectorAll("#" + escIdent(el.id))]
      } catch {}
      if (dupes.length > 1) return "id is not unique, so label[for] is ambiguous"
    }
    const w = el.closest && el.closest("label")
    if (w) push(w.innerText)

    const want = d.text.toLowerCase()
    for (const r of rivals) {
      if (r.toLowerCase() !== want) return "a second label says something else"
    }
    return ""
  }

  // WHAT THE PAGE SHOWS, when that is not what `l` says.
  //
  // labelOf prefers aria-label over a visible <label>, so an input carrying
  // BOTH <label for>Email</label> and aria-label="Emergency contact phone"
  // reports the attribute — and the approval message built from it describes a
  // form the user is not looking at. `l` is deliberately NOT changed here: it
  // is what answer-bank matches on, what the field cache keys on and what the
  // form fingerprint hashes, and silently repointing all of that at a
  // different string is a bigger change than the one being fixed.
  //
  // So the divergence is REPORTED instead of resolved. `lSeen` is the visible
  // text when it disagrees with `l`, and a caller showing the user a field can
  // show both — a page contradicting itself is information, not noise.
  //
  // The question this asks is NOT "which source did `l` come from" — that was
  // a list (`arialabel`, `attr`) standing in for the real property, and it let
  // one source through that has the same defect. It is: IS `l` TEXT THE USER
  // CAN READ? An attribute contributes no element, so aria-label/placeholder/
  // name are unreadable by construction; but aria-labelledby names an element
  // by id from OUTSIDE it, and that element can be clipped, transparent or
  // zero-size just as easily. `l` is then every bit as invisible as an
  // aria-label, and the old check reported no divergence at all. So the test is
  // "every element `l` came from is visible to the eye", which is the same
  // property vouchFail() already requires of a vouchable label.
  const seenOf = (el, d) => {
    const from = d.nodes ?? []
    if (from.length && from.every(visibleToEye)) return undefined
    const v = labelDetail(el, true)
    if (!VOUCHABLE[v.src]) return undefined
    for (const n of v.nodes) if (!visibleToEye(n)) return undefined
    const t = txt(v.text)
    if (!t || t.toLowerCase() === txt(d.text).toLowerCase()) return undefined
    return t
  }

  // The only entry point. Returns the label at full length plus the reason it
  // could not be vouched for ("" means it can).
  function vouchedLabel(el) {
    let d = labelDetail(el)
    // An aria-label is an ATTRIBUTE, so on its own it can never vouch — it is
    // not text anyone reading the form can see. But when it is BYTE-IDENTICAL
    // to the visible label (the normal, correct authoring pattern) there is
    // nothing left to decouple: every source says the same words, so the
    // VISIBLE one is what gets vouched, and the string is the same either way.
    if (d.src === "arialabel") {
      const v = labelDetail(el, true)
      if (v.text && v.text === d.text) d = v
    }
    // `nodes` rides along because the checkbox branch feeds this same object to
    // seenOf(), which asks whether the label's own elements are visible. An
    // object missing them would answer "not readable" for every vouched box.
    return { text: d.text, src: d.src, nodes: d.nodes, why: vouchFail(el, d) }
  }

  function helpOf(el) {
    const d = el.getAttribute && el.getAttribute("aria-describedby")
    if (!d) return ""
    return txt(
      d
        .split(/\s+/)
        .map((i) => byId(i) && byId(i).innerText)
        .filter(Boolean)
        .join(" "),
      160,
    )
  }

  const isReq = (el, label) =>
    !!(
      el.required ||
      el.getAttribute("aria-required") === "true" ||
      /\*\s*$|\(required\)/i.test(label)
    )

  // REQUIRED-NESS CAN LIVE ON A WRAPPER THE CONTROL DOES NOT OWN.
  //
  // MEASURED on Oracle Recruiting Cloud, 2026-08-04: the consent gate is
  //   <oj-checkboxset id="legal-disclaimer-checkbox" aria-required="true">
  //     <input type="checkbox">           <- bare: no required, no id
  // so a scanner reading only the control's own attributes reports an optional
  // field that the form refuses to submit without. That is the wrong direction
  // for a `req` to be wrong in: an unrequired-looking blocker is skipped
  // silently, and the submit fails with nothing in the run saying why.
  //
  // TWO BOUNDS, because "an ancestor said required" is otherwise a licence to
  // mark every field on a form required:
  //   1. FOUR ANCESTORS, stopping at the <form> — a marker further out is a
  //      statement about the page, not about this control.
  //   2. THE ANCESTOR MUST SPEAK FOR THIS CONTROL ALONE. A required marker on
  //      a container holding several controls says which SECTION is required
  //      and cannot say which box, so it is ignored. A radio group of five
  //      therefore does NOT inherit its fieldset's marker, which under-reports
  //      rather than over-reports and is the direction this file always takes.
  const GROUP_CTRL =
    "input,select,textarea,[contenteditable],[role='checkbox'],[role='radio']"
  const groupRequired = (el) => {
    if (!el || !el.parentElement) return false
    for (let p = el.parentElement, i = 0; p && i < 4; p = p.parentElement, i++) {
      if (p.tagName === "BODY" || p.tagName === "HTML" || p.tagName === "FORM")
        break
      if (!p.getAttribute) continue
      const marked =
        p.getAttribute("aria-required") === "true" ||
        (p.hasAttribute && p.hasAttribute("required"))
      if (!marked) continue
      let n = 0
      try {
        n = p.querySelectorAll(GROUP_CTRL).length
      } catch {
        return false
      }
      return n === 1
    }
    return false
  }

  // A CONTROL THE USER CAN SEE AND REACH WHOSE OWN BOX IS NOT PAINTED.
  //
  // The field loop drops anything that fails vis(), and that rule is right and
  // is NOT being relaxed: an invisible <input> is usually a board's own backing
  // store, and reporting one as a field would put a control the user is not
  // looking at into the approval message. Ashby's is the canonical example —
  // <input type="checkbox" tabindex="-1" name="question_7097054005"> at
  // display:none, which pages/ashby-buttons.html reproduces verbatim and which
  // must keep being dropped.
  //
  // But the SAME test also dropped Oracle's consent checkbox, which is painted
  // by CSS on its <label> with the input parked at opacity: 0 — the ordinary
  // accessible custom-checkbox idiom, used by every component library. That
  // control is on screen, is a tab stop, and is REQUIRED. It was reported
  // nowhere at all: not a field, not a widget, not a button, so fill-plan.mjs
  // named two decorative page-progress widgets as the reason the form was not
  // ready and never mentioned the one control that actually blocked it.
  //
  // WHAT SEPARATES THE TWO IS PRESENTATION, NOT PAINT, and every clause is
  // load-bearing:
  //   * CHECKBOX/RADIO ONLY. These are the controls a library restyles by
  //     hiding the native box. A hidden text input is a backing store; there is
  //     no idiom in which the user types into something they cannot see.
  //   * A VISIBLE LABEL FROM A DECLARED SOURCE. The words have to be on screen
  //     and the control has to own them (aria-labelledby / <label for> / an
  //     enclosing <label>) — the same VOUCHABLE sources and the same
  //     visibleToEye test the consent vouch already requires. Ashby's backing
  //     checkbox has no label by any route, so it fails here.
  //   * NOT REMOVED FROM THE TAB ORDER. tabindex="-1" is the page saying this
  //     control is for its own code, not for the user. Ashby's says exactly
  //     that, and it is the second independent reason that one stays dropped.
  //   * NOT aria-hidden.
  //
  // STATED LIMIT: reporting it does not make it clickable. Playwright's
  // actionability checks refuse a zero-opacity target, so a plan that tried to
  // tick this would FAIL VISIBLY rather than silently — which is the designed
  // direction, and in practice every check-verb field defers to the user
  // anyway (fill-plan.mjs's confirm-widget gate).
  const CHOICE_TYPE = { checkbox: 1, radio: 1 }
  const presentedUnpainted = (el, type) => {
    if (!CHOICE_TYPE[type]) return false
    if (el.getAttribute("aria-hidden") === "true") return false
    const ti = el.getAttribute("tabindex")
    if (ti !== null && !/^\s*\d+\s*$/.test(ti)) return false
    const d = labelDetail(el)
    if (!VOUCHABLE[d.src] || !d.nodes.length) return false
    if (!WORDY.test(d.text)) return false
    return d.nodes.every(visibleToEye)
  }

  // --- custom dropdown containers claim their descendants -----------------
  const COMBO_SEL = [
    "[role='combobox']",
    "[aria-haspopup='listbox']",
    "[class*='select__control']",
    "[class*='Select__control']",
    "[data-ui='select']",
  ].join(",")
  const claimed = new Set()
  const combos = []
  for (const el of document.querySelectorAll(COMBO_SEL)) {
    if (el.tagName === "SELECT" || !vis(el) || claimedNow(el))
      continue
    const dc = labelDetail(el)
    const label = txt(dc.text)
    combos.push({
      k: stamp(el, "f"),
      sel: stableSel(el),
      ...identityOf(el),
      t: "combo",
      l: label,
      lSeen: seenOf(el, dc),
      req: isReq(el, label) || groupRequired(el) || undefined,
      v: txt(el.value || el.innerText, 60) || undefined,
      h: helpOf(el) || undefined,
    })
    // THE CONTROL CLAIMS ITSELF, NOT ONLY ITS DESCENDANTS.
    //
    // MEASURED on Oracle Recruiting Cloud, 2026-08-04: ORC puts
    // role="combobox" ON THE <input>, not on a wrapper div. react-select puts
    // it on a div and the input is a DESCENDANT, so claiming descendants alone
    // was enough there — and on ORC it claimed nothing at all, because there
    // is no descendant input. The same element then came back TWICE:
    //   {"k":"f5","t":"text","l":"How did you hear about us?"}   <- fill
    //   {"k":"f1","t":"combo","l":"How did you hear about us?"}  <- combo
    // and that is not merely a duplicate row in a report. fill-plan.mjs's
    // duplicateCombo() exists for the intl-tel-input shape — a country PICKER
    // beside a separate phone TEXT INPUT under one label — and resolves it by
    // keeping the typable half and skipping the picker. Handed two reports of
    // ONE element it did exactly that, so the plan issued `fill` against a
    // combobox: the text landed in the visible input, the widget never
    // committed it to its form model, and the value reverted on blur. The
    // application went out with the field empty and the run reported it filled.
    //
    // One element, one field. intl-tel-input is untouched, because there the
    // picker and the text input are genuinely two different elements and only
    // one of them matches COMBO_SEL.
    claimed.add(el)
    for (const d of el.querySelectorAll("input,select,textarea,button"))
      claimed.add(d)
  }

  // --- everything else ----------------------------------------------------
  const fields = []
  const groups = new Map()
  const signals = []

  for (const el of document.querySelectorAll("select,textarea,input")) {
    if (claimed.has(el) || el.disabled) continue
    const tag = el.tagName.toLowerCase()
    const type = tag === "input" ? (el.type || "text").toLowerCase() : tag
    if (["submit", "button", "reset", "image", "hidden"].includes(type))
      continue
    if (type === "password") {
      signals.push("password field — login wall, hand off to the user")
      continue
    }
    // `type !== "file"` because a file input is routinely covered by a styled
    // button and is collected whatever its visibility; presentedUnpainted() is
    // the same allowance for the restyled tick, granted on evidence rather than
    // on the type alone. See its own comment for what the evidence is.
    if (!vis(el) && type !== "file" && !presentedUnpainted(el, type)) continue
    const dg = labelDetail(el)
    const label = txt(dg.text)

    if (type === "radio" || type === "checkbox") {
      // Ticking a box is the one thing on a form that ASSERTS something, so
      // this is the only branch that computes exactness — and the only branch
      // whose `l` can exceed 120 chars. Every other field type keeps the exact
      // string it had before, so answer-bank matching and the field-cache
      // fingerprint are untouched for them.
      const d = vouchedLabel(el)
      const why = d.why
      const own = why ? txt(d.text) : d.text
      const gid = type + ":" + (el.name || own || "?")
      let g = groups.get(gid)
      if (!g) {
        // A <legend> is a heading for a GROUP, not this control's own label,
        // so a group that takes its text from one can never be vouched for.
        const heading = labelOf(el.closest("fieldset") || el)
        const fromFieldset = !!el.closest("fieldset") && !!heading
        g = {
          k: "g" + (groups.size + 1),
          t: type,
          l: fromFieldset ? heading : own || heading,
          lSeen: fromFieldset ? undefined : seenOf(el, d),
          req: isReq(el, own) || groupRequired(el) || undefined,
          o: [],
        }
        if (fromFieldset) g.labelWhy = "label source is fieldset legend"
        else if (why) g.labelWhy = why
        else g.labelExact = true
        groups.set(gid, g)
        fields.push(g)
      } else if (g.labelExact) {
        // A second control under one label means the label no longer says
        // WHICH box, so the vouch is withdrawn rather than reinterpreted.
        delete g.labelExact
        g.labelWhy = "more than one control shares this label"
      }
      // The identity rides on the OPTION, not the group: a checkbox/radio
      // group is a synthetic object with no element of its own, exactly as
      // `sel` already works here.
      g.o.push({
        k: stamp(el, "f"),
        sel: stableSel(el),
        ...identityOf(el),
        l: g.labelExact ? own : txt(own, 80),
        on: el.checked || undefined,
      })
      continue
    }

    const f = {
      k: stamp(el, "f"),
      sel: stableSel(el),
      ...identityOf(el),
      t: tag === "select" ? "select" : tag === "textarea" ? "textarea" : type,
      l: label,
      lSeen: seenOf(el, dg),
      req: isReq(el, label) || groupRequired(el) || undefined,
      v: txt(el.value, 60) || undefined,
      h: helpOf(el) || undefined,
    }
    if (tag === "select") {
      // THE CUT IS NOW STATED. It used to be silent, and 40 survivors of a
      // 200-option country list are indistinguishable from a genuine
      // 40-option list: the field cache stored the short list as complete,
      // and an answer the form really does offer, past the cut, resolved as
      // "not on offer" and was deferred to the user for no reason.
      const all = [...el.options].map((o) => txt(o.text, 60))
      f.opts = all.slice(0, MAX_OPTS)
      if (all.length > MAX_OPTS) {
        f.optsTruncated = true
        f.optsTotal = all.length
      }
      if (el.multiple) f.multi = true
    }
    fields.push(f)
  }

  // ONE STRING, everywhere. A vouched group has exactly one option and that
  // option carries the same full text the group does; a group that never got
  // the vouch, or lost it to a second control, goes back to the 80-char option
  // label it has always had.
  for (const g of groups.values()) {
    if (g.labelExact && g.o.length !== 1) {
      delete g.labelExact
      g.labelWhy = "more than one control shares this label"
    }
    if (!g.labelExact) for (const o of g.o) o.l = txt(o.l, 80)
  }

  for (const el of document.querySelectorAll("[contenteditable='true']")) {
    if (!vis(el) || claimedNow(el)) continue
    fields.push({
      k: stamp(el, "f"),
      sel: stableSel(el),
      ...identityOf(el),
      t: "richtext",
      l: labelOf(el),
      lSeen: seenOf(el, labelDetail(el)),
      v: txt(el.innerText, 60) || undefined,
    })
  }

  // --- buttons ------------------------------------------------------------
  // THIS LOOP RUNS BEFORE THE WIDGET SWEEP BELOW, AND THE ORDER IS
  // LOAD-BEARING. It stamps every button-shaped control with data-aj, and the
  // sweep skips anything already stamped — which is how "a button is not a
  // field" gets expressed STRUCTURALLY (already collected) instead of as one
  // more selector list to be walked around. Moving it back down re-opens that.
  // Nothing else depends on where it runs: `b` keys have their own counter, so
  // no `f` key moves, and `kind` reads `btns` at the very end.
  const roleOf = (t) =>
    /^(submit|send)\b|submit application|send application|finish|complete application/i.test(
      t,
    )
      ? "submit"
      : /save (and|&) continue|^continue|^next|^review|proceed/i.test(t)
        ? "next"
        : /^back|^previous/i.test(t)
          ? "back"
          : /apply|get started|^start|^begin/i.test(t)
            ? "start"
            : /upload|attach|choose file|browse|add file/i.test(t)
              ? "upload"
              : /sign ?in|log ?in|create account|register|continue with (google|linkedin)/i.test(
                    t,
                  )
                ? "auth"
                : "other"

  // --- a question answered by a PAIR OF BUTTONS ----------------------------
  // THIS RUNS BEFORE THE BUTTON LOOP, FOR THE SAME REASON THAT LOOP RUNS
  // BEFORE THE WIDGET SWEEP: it stamps what it collects, and every later pass
  // skips anything already stamped this run. Whether a control is a field or
  // an action is decided in ONE place — the first pass that recognises it —
  // rather than by a selector list each later pass has to walk around.
  //
  // THE SILENT MISS THIS ENDS (Ashby, 2026-08-03). "Will you now or in the
  // future require sponsorship for employment visa status?" is rendered there
  // as two <button>s. roleOf() names neither, so both were filed in `btns`
  // with r:"other" — a list fill-plan.mjs never reads. The plan reported four
  // deferred fields and DID NOT MENTION THE QUESTION AT ALL; it was found by
  // hand-reading the DOM. A required work-authorisation answer went missing
  // and nothing anywhere said so. This file's own header: A SILENCE IS NOT A
  // REFUSAL, and a silence is the worse of the two failure modes.
  //
  // WHY THE BUTTON LOOP'S OWN ESCAPE HATCH DID NOT CATCH IT. That loop hands a
  // control down to the widget sweep only when it carries aria-checked /
  // aria-pressed / aria-selected. Ashby's buttons carry none: the selected one
  // is marked with a build-hashed CSS class (_active_1svni_57), which is not a
  // signal — it is a different string after the board's next deploy. This is
  // precisely the residual hole the sweep states about itself ("AND ONE NAME
  // LIST, THREE ENTRIES, WHICH IS THE RESIDUAL HOLE"), hit in production.
  //
  // THE DETECTOR CARRIES NO NAME LIST. It is structural: two or more <button>s
  // that roleOf() could not name, all short-labelled, under the nearest
  // container that ASKS A QUESTION and holds nothing else. A name list here
  // would be the same defect one rewording later, which is the lesson Shape E
  // paid for twice.
  //
  // TWO TIERS, AND ONLY THE SECOND IS ABOUT SPEED:
  //
  //   TIER 1 — everything this detector sees becomes t:"widget", a type
  //   fill-plan.mjs's VERB map has no entry for, so it lands in that file's
  //   `unsupported field type` defer: reported to the user, blocking, never
  //   acted on. REPORTING IS NOT A VERB. Tier 1 grants no capability at all;
  //   it converts a silence into a refusal, and that is the safety half.
  //
  //   TIER 2 — a RECOGNISED CLOSED ANSWER SET (Yes/No, today) is emitted as
  //   the same group shape the radio/checkbox branch above builds, because
  //   that is what the pair IS. It then travels the existing route: verb
  //   "check" -> fill-plan.mjs's confirm-widget gate -> the exact-text bank
  //   exemption, which fills it only from an answer the user recorded against
  //   this exact question, with no model turn. NOTHING HERE WEAKENS THAT GATE,
  //   and that is what makes tier 2 safe: this file grants no reach the gate
  //   does not already govern, and submitReadiness() still refuses the
  //   unattended path on `actuated`.
  //
  // THE ANSWER-SET LIST IN TIER 2 IS A RESTRICTION ON TOP OF THE STRUCTURAL
  // DETECTOR, NEVER THE DETECTOR ITSELF. An unrecognised pair — "Delete my
  // account" / "Keep" — falls back to tier 1 and defers loudly. The two
  // failure modes point the same way: a pair this file cannot read is still
  // SEEN.
  //
  // ONE STATED LIMIT, so nobody mistakes it for coverage. The walk up stops at
  // a container holding ANOTHER control, because the alternative is stamping
  // that control's label onto this pair — the E8 trap, and a wrong label is
  // worse than an empty one because the user acts on it. So a pair that shares
  // a row with a text input, and whose own container asks nothing, is STILL
  // missed: it falls through to `btns` exactly as it did before this block
  // existed. That is the same conservative direction the rest of the file
  // takes, and it is a smaller hole than the one being closed, not none.
  //
  // WHICH BUTTON IS SELECTED IS REPORTED ONLY WHEN THE PAGE SAYS SO. On the
  // board this was found on, the selection is a hashed class name and there is
  // no honest way to read it, so `on` is absent rather than guessed — a
  // consumer asking "is one already chosen" gets no answer instead of a wrong
  // one. A pair that DOES declare aria-checked / -pressed / -selected gets a
  // real `on`, because then the page has stated it.
  const PAIR_OPT_MAX = 40
  const PAIR_OPT_COUNT_MAX = 4
  // A ROW OF SIBLINGS IS ONE ANSWER SET, so it may be longer than four.
  //
  // The count cap above is a backstop against adopting one question's text for
  // another's options — a container holding several questions has many
  // unnamed controls in it, and questionIn() would stamp the LAST question on
  // all of them (the E8 trap: a wrong label is worse than an empty one). Four
  // is the right bound when the only thing known about the candidates is that
  // they share an ancestor.
  //
  // When they share a PARENT, more is known: two questions cannot both own one
  // parent element's direct children, so the shape itself rules out the merge
  // the cap defends against. That buys the real-world answer sets a Yes/No cap
  // excludes — age brackets, ethnicity, titles, seven to a dozen rows — which
  // on the ORC form measured here were 7 rows reported as 7 unfillable fields
  // with the question attached to none of them.
  //
  // This WIDENS and never narrows: nothing that grouped before stops grouping,
  // because the sibling test only ever raises the cap.
  const PAIR_LIST_COUNT_MAX = 12
  const PAIR_QUESTION_MAX = 300
  const MAX_PAIRS = 8
  // Containers holding one of these are somebody else's question, so the walk
  // up stops rather than adopting their label.
  //
  // "ONE OF THESE" MEANS A CONTROL THIS SCANNER WOULD ITSELF COLLECT, which is
  // to say a VISIBLE one — and that is not a refinement, it is the difference
  // between this block working on Ashby and not. MEASURED on a live Ashby form
  // (2026-08-03): each Yes/No pair sits in a container that ALSO holds
  //   <input type="checkbox" tabindex="-1" name="question_7097054005">
  // at display:none — the board's own backing store for the pair, not a second
  // question. An earlier version of this guard exempted `type="hidden"` only,
  // rejected that container, and the live page still reported both questions in
  // `btns`: the fix passed every fixture and did nothing on the real board.
  // A file input is collected whatever its visibility (see the field loop's own
  // `type !== "file"`), so it counts here whatever its visibility too.
  const PAIR_FOREIGN =
    "input,select,textarea,[contenteditable],[role='combobox'],[role='checkbox'],[role='radio'],[role='listbox']"
  const isFileInput = (c) =>
    c.tagName === "INPUT" && full(c.getAttribute("type")).toLowerCase() === "file"
  const holdsForeignControl = (a) => {
    try {
      for (const c of a.querySelectorAll(PAIR_FOREIGN)) {
        if (isFileInput(c) || vis(c)) return true
      }
    } catch {
      return true
    }
    return false
  }
  // A candidate OPTION button: one the loop below would have filed as the role
  // it could not name.
  //
  // A STATEFUL <button> IS NOT EXCLUDED HERE, AND THAT IS DELIBERATE — but the
  // reason has changed, and the old one is worth keeping because it is what
  // the hole looked like from inside. It was: the loop below defers a control
  // carrying aria-checked / -pressed / -selected to the widget sweep, the
  // sweep skipped NATIVE tags and BUTTON is one, so for a <button> that
  // hand-off went NOWHERE, and excluding stateful buttons here would have been
  // deferring to a catcher that does not exist. That hole is now closed in the
  // sweep, which carries the measurement.
  //
  // The non-exclusion stands on its own footing instead: THIS BLOCK MUST WIN.
  // A stateful pair the sweep reached first would come back as two unrelated
  // widgets with no question attached to either; recognised here it is one
  // group, and its state is reported as `on`. Order does the work — this runs
  // first and stamps what it takes, and the sweep skips anything stamped.
  const PAIR_STATE = ["aria-checked", "aria-pressed", "aria-selected"]

  // AN ANSWER THAT IS NOT A <button>, AND THE HOLE THAT LEFT.
  //
  // MEASURED on Oracle Recruiting Cloud, 2026-08-04. ORC renders a single-
  // select question as focusable <li>s: no <input type="radio"> anywhere in the
  // document, no aria-checked / -pressed / -selected, no role. This detector
  // only ever looked at <button>, so the question was not grouped and was not
  // reported AT ALL — while each of its seven answers WAS reported, separately,
  // by the widget sweep below, as its own unfillable `t:"widget"` field with no
  // question attached. Across the form that was ~15 phantom entries in the
  // defer list and not one of the questions they belonged to.
  //
  // That is both failure modes at once: the thing that needed answering is a
  // silence, and the noise around it is loud enough to make the whole list get
  // skimmed. The sweep is not the place to fix it — the sweep sees one control
  // at a time and cannot know a neighbouring row is the same question.
  //
  // THE PREDICATE IS THE SWEEP'S OWN LEFTOVERS, deliberately. It matches
  // exactly what would otherwise arrive as a loose `t:"widget"` phantom: a
  // focusable LEAF that declares NO role. An element that declares any role at
  // all is left alone — `role="radio"`, `role="option"`, `role="button"` and
  // the rest already have settled handling below, and quietly re-routing them
  // through here would change behaviour this repo has fixtures for. So this
  // takes only what nothing else was doing anything useful with.
  const NATIVE_TAG = {
    INPUT: 1,
    SELECT: 1,
    TEXTAREA: 1,
    BUTTON: 1,
    OPTION: 1,
    A: 1,
    IFRAME: 1,
    SUMMARY: 1,
    DETAILS: 1,
  }
  const LOOSE_CHILD =
    "input,select,textarea,button,[tabindex],[contenteditable],[role]"
  const isLooseOption = (el) => {
    if (NATIVE_TAG[el.tagName]) return false
    if (full(el.getAttribute("role"))) return false
    const ti = el.getAttribute("tabindex")
    if (ti === null || !/^\s*\d+\s*$/.test(ti)) return false
    // Not a leaf: a focusable element CONTAINING a control is a wrapper, which
    // is the same exclusion the sweep makes for the same reason.
    try {
      if (el.querySelector(LOOSE_CHILD)) return false
    } catch {
      return false
    }
    return true
  }
  // Every candidate under `root`, in document order. null when the selector
  // throws, which callers treat as "give up on this container".
  const pairElements = (root) => {
    let all = []
    try {
      all = [...root.querySelectorAll("button,[tabindex]")]
    } catch {
      return null
    }
    return all.filter((e) => e.tagName === "BUTTON" || isLooseOption(e))
  }
  const pairOptionLabel = (el) => {
    if (!vis(el) || el.disabled || claimedNow(el)) return ""
    const l = txt(el.innerText || el.value || labelOf(el), 60)
    if (!l || l.length > PAIR_OPT_MAX) return ""
    return roleOf(l) === "other" ? l : ""
  }
  // "true" on any of the three state attributes, and nothing at all when the
  // page declares none. Same rule as everywhere else in this file: a hashed
  // class is not a signal, so a board that marks its selection with one gets
  // no `on` rather than a guessed one.
  const pairOptionOn = (el) => {
    for (const a of PAIR_STATE) {
      if (full(el.getAttribute(a)).toLowerCase() === "true") return true
    }
    return undefined
  }
  // The container's own words, with the options' words taken out — "Yes No"
  // is not a question. Removed from the END: an option's text can occur
  // inside the question ("Note" contains "No"), and the buttons render after
  // the label.
  const withoutOptions = (t, labels) => {
    let s = t
    for (let i = labels.length - 1; i >= 0; i--) {
      const j = s.lastIndexOf(labels[i])
      if (j >= 0) s = s.slice(0, j) + " " + s.slice(j + labels[i].length)
    }
    return full(s)
  }
  // WHEN A SENTENCE BREAK IS NOT A SENTENCE BREAK.
  //
  // MEASURED on Oracle Recruiting Cloud, 2026-08-04, and it is the worst thing
  // this file has ever done. The question was
  //
  //   "WILL YOU NOW OR IN THE FUTURE REQUIRE SPONSORSHIP for employment visa
  //    status (e.g. H-1B status, etc) to work legally for our Company in the
  //    United States?"
  //
  // "(e.g. " ends in ". ", so the walk back below started there and the group
  // was labelled
  //
  //   "H-1B status, etc) to work legally for our Company in the United States?"
  //
  // which is not a truncation — it is a DIFFERENT QUESTION. The real one asks
  // whether the user REQUIRES SPONSORSHIP (correct answer: No); the fragment
  // reads as an authorisation question (correct answer: Yes). A fuzzy match
  // returns the right concept with the wrong truth value, which is exactly the
  // inversion docs/reference/09-gotchas.md gotcha A warns about, and the answer
  // that inversion produces is a false statement on a submitted application.
  //
  // SO THE BIAS IS EXPLICIT: WHEN A BOUNDARY IS AMBIGUOUS, KEEP MORE TEXT. An
  // over-long label is a question that fails to match the bank and defers to
  // the user — one extra decision. A short label is a question that matches the
  // wrong answer silently. Those costs are not comparable, and every rule below
  // exists to move the failure into the first column.
  //
  // TWO STRUCTURAL REJECTIONS AND ONE ORTHOGRAPHIC, none of them a word list —
  // a list of abbreviations would be the same defect one wording later, which
  // is the lesson the pair detector above already paid for:
  //   1. INSIDE A PARENTHETICAL. A sentence cannot end between "(" and ")".
  //      This is the one that fires here, and the unmatched ")" left in the
  //      fragment is the tell.
  //   2. AFTER A DOTTED INITIALISM. "e.g", "i.e", "U.S" — single-letter
  //      segments separated by dots are an abbreviation, not a sentence.
  //   3. BEFORE A LOWERCASE CONTINUATION. A new sentence does not start with a
  //      lowercase letter. Rejecting keeps more text, so this one is free.
  // Anything that survives all three is taken as a boundary, so a container
  // holding real prose before its question still trims that prose away.
  const openParenAt = (s) => {
    let n = 0
    for (let i = 0; i < s.length; i++) {
      if (s[i] === "(") n++
      else if (s[i] === ")" && n > 0) n--
    }
    return n > 0
  }
  const INITIALISM = /(?:^|[\s("'[])(?:\p{L}\.)+\p{L}$/u
  const isBoundary = (head, j, mark) => {
    const before = head.slice(0, j)
    if (openParenAt(before)) return false
    if (mark === ". " && INITIALISM.test(before)) return false
    const next = head.slice(j + mark.length, j + mark.length + 1)
    if (next && next.toLowerCase() === next && next.toUpperCase() !== next) {
      return false
    }
    return true
  }
  // The LAST sentence ending in a question mark. "" when the text asks
  // nothing, which is what keeps a toolbar of short unnamed buttons — Bold,
  // Italic, Underline — out of `fields` entirely.
  //
  // Cut at PAIR_QUESTION_MAX rather than the 120 every other label takes. The
  // container's text was already bounded by that constant before this is
  // called, so nothing longer can arrive; what the wider cut buys is that a
  // 154-character sponsorship question survives WHOLE. A truncated question is
  // the other half of the same defect — this file's own labelExact block
  // records two consent strings that sliced to identical 120 chars — and the
  // answer bank matches on exact text, so a cut tail is a question the user
  // answered that no longer matches what they answered.
  const questionIn = (t) => {
    const i = t.lastIndexOf("?")
    if (i < 0) return ""
    const head = t.slice(0, i + 1)
    let start = 0
    for (const mark of [". ", "? ", "! "]) {
      // Walk back from the LAST occurrence, skipping the ones that are not
      // sentence ends, so a rejected "(e.g. " does not hide a real boundary
      // earlier in the text.
      let j = head.lastIndexOf(mark, head.length - 2)
      while (j >= 0) {
        if (isBoundary(head, j, mark)) {
          if (j + mark.length > start) start = j + mark.length
          break
        }
        j = head.lastIndexOf(mark, j - 1)
      }
    }
    return txt(head.slice(start), PAIR_QUESTION_MAX)
  }
  // Sorted, because the comparison sorts. One entry today.
  const CLOSED_SETS = [["no", "yes"]]
  const closedKey = (l) =>
    full(l)
      .toLowerCase()
      .replace(/[.!?,]+$/, "")
  const isClosedSet = (opts) => {
    const keys = opts.map((o) => closedKey(o.l)).sort()
    return CLOSED_SETS.some(
      (set) => set.length === keys.length && set.every((v, i) => v === keys[i]),
    )
  }
  // A BACKSTOP, AND SAID TO BE ONE. What actually stops tier 2 acting on a
  // hostile pair is that it only ever fills from an EXACT bank hit — the
  // user's own recorded wording of this exact question — so a question they
  // never answered resolves UNKNOWN and defers. This list closes the one case
  // where being wrong cannot be undone, and closes nothing else: the 26th
  // rewording is free here exactly as it is everywhere else in this repo.
  const PAIR_DESTRUCTIVE =
    /\b(withdraw|delete|deactivate|revoke|erase)\b|\bclose (my )?(account|profile)\b|\bsubmit\b/i

  const pairCands = new Map()
  for (const el of pairElements(document) ?? []) {
    const l = pairOptionLabel(el)
    if (l) pairCands.set(el, l)
  }
  let ngroup = groups.size
  let pairCut = 0
  const pairTaken = new Set()
  if (pairCands.size >= 2) {
    for (const el of pairCands.keys()) {
      if (pairTaken.has(el)) continue
      // Nearest ancestor that asks a question and holds this pair and nothing
      // else. ANCESTORS, not siblings: whether the two buttons share a parent
      // or each sits in its own wrapper is a fact about one board's CSS, not
      // about forms, and a detector that turned on it would miss the next
      // board for a reason that has nothing to do with the question.
      for (let a = el.parentElement, i = 0; a && i < 5; a = a.parentElement, i++) {
        if (a.tagName === "BODY" || a.tagName === "HTML") break
        const all = pairElements(a)
        if (!all) break
        // A button ANOTHER pair already owns means this container spans two
        // questions; stop rather than merge them under one label.
        if (all.some((b) => pairTaken.has(b))) break
        const mine = all.filter((b) => pairCands.has(b))
        if (mine.length < 2) continue
        // A closed answer set rendered as buttons is two to four options. More
        // than that is a container of several questions, not one question, and
        // adopting its text would stamp the wrong question on the group — the
        // E8 trap the widget sweep records ("a wrong label is worse than an
        // empty one"). Stop; those buttons reach `btns` exactly as today.
        //
        // UNLESS THEY ARE ALL SIBLINGS, in which case the shape itself says
        // they are one answer list and the longer cap applies — see
        // PAIR_LIST_COUNT_MAX for why that is a widening and not a hole.
        const listShaped = mine.every(
          (b) => b.parentElement === mine[0].parentElement,
        )
        if (mine.length > (listShaped ? PAIR_LIST_COUNT_MAX : PAIR_OPT_COUNT_MAX))
          break
        // An action sharing the container — a compact row of Yes / No /
        // Submit — is NOT a reason to give up on the question: giving up is
        // the silent miss this block exists to end. Its words come out of the
        // text with the options', and the button itself is left for the loop
        // below, so nothing that was in `btns` stops being in `btns`.
        if (holdsForeignControl(a)) break
        const raw = withoutOptions(
          full(a.innerText),
          all.map((b) => pairCands.get(b) ?? txt(b.innerText || b.value, 60)),
        )
        if (raw.length > PAIR_QUESTION_MAX) break
        const question = questionIn(raw)
        if (!question) continue
        pairCut++
        // The cut is STATED, never silent — same reasoning as optsTruncated
        // and the widget sweep's own cap. What is skipped falls through to
        // `btns` exactly as before, which is the miss, so it is said out loud.
        if (pairCut > MAX_PAIRS) break
        const opts = mine.map((b) => ({ el: b, l: pairCands.get(b) }))
        const recognised =
          isClosedSet(opts) && !PAIR_DESTRUCTIVE.test(question)
        const g = {
          k: "g" + ++ngroup,
          t: recognised ? "radio" : "widget",
          l: question,
          req: isReq(a, raw) || undefined,
          o: opts.map((o) => ({
            k: stamp(o.el, "f"),
            sel: stableSel(o.el),
            ...identityOf(o.el),
            l: o.l,
            on: pairOptionOn(o.el),
          })),
          // ON BOTH TIERS, INCLUDING THE RECOGNISED ONE, AND THAT IS THE POINT.
          // Same meaning as the widget sweep's "aria": NO VERB IN THIS PIPELINE
          // OPERATES THIS CONTROL. It is literally true here — fill-engine.mjs's
          // kindOf() answers "forbidden:button" for a <button> and actOn()
          // refuses it — so a tier-2 group that reached `items` as how:"check"
          // would be an instruction the engine cannot carry out, reported as
          // ticked by a plan that could never tick it. Emitting the key on both
          // tiers is what lets fill-plan.mjs route this to the confirm-widget
          // defer WITH the resolved value and pick, which is the actuation rule
          // 6 describes: the agent acts and names it. Removing this key from the
          // recognised tier does not make the click work; it makes the plan lie.
          widget: "buttons",
        }
        if (!recognised) {
          g.labelWhy =
            "answered by buttons whose answer set this scanner does not recognise"
        }
        fields.push(g)
        for (const b of mine) pairTaken.add(b)
        break
      }
    }
  }
  if (pairCut > MAX_PAIRS) {
    signals.push(
      pairCut -
        MAX_PAIRS +
        " further button-pair question(s) were not reported — fill this form by hand",
    )
  }

  const btns = []
  // WHAT THIS LOOP HANDS DOWN TO THE WIDGET SWEEP, RECORDED RATHER THAN
  // RE-DERIVED. The hand-off below used to be implicit: this loop dropped a
  // stateful control on the floor and TRUSTED the sweep's selector list to pick
  // it up again. For every NATIVE tag in this loop's own selector it did not,
  // and the control was then reported NOWHERE — the sweep block carries the
  // measurement. A Set is the fix because it cannot drift: whatever this loop
  // declines to file as an action is, by construction, exactly what the sweep
  // is obliged to look at, however either selector list is edited later.
  const handedToSweep = new Set()
  for (const el of document.querySelectorAll(
    "button,[role='button'],input[type='submit'],input[type='button'],a[href]",
  )) {
    if (!vis(el) || el.disabled || claimedNow(el)) continue
    // A CONTROL THAT CARRIES STATE IS A VALUE, NOT AN ACTION, so it is left for
    // the widget sweep below rather than filed away as a button. Without this
    // the sweep's own aria-checked/-pressed/-selected escape hatch is DEAD
    // CODE — measured: <div role="button" tabindex="0" aria-pressed="false">I
    // certify the above is true</div> was consumed here and produced zero
    // fields, so a board could render a consent tick as a toggle button and it
    // would never defer. The cost is that a genuine toolbar toggle ("Bold" in
    // a rich-text editor) reports as an unfillable field instead of a button,
    // which is a visible defer rather than a silent miss.
    //
    // THE HAND-OFF IS RECORDED, NOT ASSUMED. Leaving it implicit is what made
    // the paragraph above FALSE for four of the five shapes this loop's own
    // selector matches: the sweep never saw them, so "left for the widget
    // sweep" meant dropped. The measurement is in the sweep block.
    if (
      el.hasAttribute("aria-checked") ||
      el.hasAttribute("aria-pressed") ||
      el.hasAttribute("aria-selected")
    ) {
      handedToSweep.add(el)
      continue
    }
    const label = txt(el.innerText || el.value || labelOf(el), 60)
    if (!label) continue
    const r = roleOf(label)
    if (el.tagName === "A" && r === "other") continue
    btns.push({ k: stamp(el, "b"), l: label, r })
    if (btns.length >= 40) break
  }

  // --- controls that are not elements the loops above collect ---------------
  // SHAPE E WAS BLINDNESS RATHER THAN DEFENCE; SHAPE F INVERTS THE DEFAULT.
  //
  // The original defect: a component library renders a checkbox as
  // <div role="checkbox" aria-checked="false"> with a keyboard handler and no
  // <input> anywhere. The loops above collect from select/textarea/input,
  // [contenteditable] and the combobox selector list, so such a control matched
  // NONE of them and this scanner emitted zero fields for it. On
  // tests/fixtures/hostile/forms/escalated-aria-checkbox.html that control is a
  // REQUIRED work-authorisation consent: it was not ticked, which is safe, but
  // it was also not DEFERRED, so it never reached the approval message,
  // pending-questions.mjs, or the plan's defer list. The submit then fails, or
  // the board defaults the answer, and nothing in the run log says why.
  // A silence is not a refusal.
  //
  // SHAPE E FIXED THAT WITH A SELECTOR LIST — [role='checkbox'],[role='radio'],
  // [role='switch'] — WHICH IS THE SAME DEFECT ONE REWORDING LATER.
  // role="menuitemcheckbox", role="option" inside a listbox, and a bare
  // <span tabindex="0"> with a click handler all returned to the original
  // blindness, and blindness is the WORSE failure mode because it is a silence
  // rather than a refusal. This is the 26th-rewording problem that made
  // looksLikeAgreementProse a second door behind isConsent.
  //
  // SO THE DETECTOR IS NO LONGER THE ROLE LIST. It is focusability:
  // tabindex >= 0 or contenteditable, minus native tags, minus anything already
  // collected. The role list survives only as a LABELLING NICETY — it decides
  // what `t` reads as, and a role outside it reports as the generic `widget`,
  // which is equally verb-less. NOTHING IS SKIPPED FOR BEING ABSENT FROM IT.
  // Today a control is invisible unless a selector names it; after this it is
  // visible unless it is a known-safe native control.
  //
  // WHY THE TYPE IS `aria-checkbox`/`widget` AND NEVER `checkbox`. Operating
  // one of these takes a CLICK, and the fill engine deliberately has no verb
  // that clicks — that absence is what stops an injected plan from submitting
  // an application, and it is not being traded away for a consent tick. So
  // these carry a type fill-plan.mjs's VERB map has no entry for, which lands
  // them in its `unsupported field type` defer: reported to the user, blocking
  // the unattended path, never acted on. REPORTING IS NOT A VERB. That is why
  // this is a scanner change and not an engine one, and it is why widening the
  // net costs no new capability.
  //
  // THE THREE EXCLUSIONS, each structural rather than a name:
  //   1. NATIVE tags. An <input type=checkbox role="checkbox"> is collected
  //      above; excluding it here stops a double report.
  //   2. Already stamped, or inside something stamped — combos, fields,
  //      richtext and (because of the ordering above) buttons.
  //   3. Not a leaf. A focusable element that CONTAINS controls is a scroll
  //      region or a focus wrapper, not a control: real pages put tabindex="0"
  //      on a scrollable <div> holding the form. A custom checkbox contains an
  //      icon and a text span and no control, so it still passes.
  //
  // AND ONE NAME LIST, THREE ENTRIES, WHICH IS THE RESIDUAL HOLE AND IS STATED
  // AS ONE. button/link/menuitem are ACTIONS, not values, and role="button" in
  // particular is already reported in full by the loop directly above — sweeping
  // icon-only buttons in as unlabelled defers is how a checker starts crying
  // wolf and gets ignored. The escape hatch is STATE: a control carrying
  // aria-checked / aria-pressed / aria-selected holds a value the form submits,
  // so a board rendering a consent tick as role="button" lands HERE rather than
  // vanishing into `btns`. What is left uncovered is a STATELESS custom control
  // wearing one of those three roles — which by its own markup declares itself
  // an action with no value.
  const NATIVE = { INPUT: 1, SELECT: 1, TEXTAREA: 1, BUTTON: 1, OPTION: 1 }
  const CONTROL_ROLE = {
    checkbox: 1,
    radio: 1,
    switch: 1,
    combobox: 1,
    listbox: 1,
    option: 1,
    textbox: 1,
    searchbox: 1,
    spinbutton: 1,
    slider: 1,
    menuitemcheckbox: 1,
    menuitemradio: 1,
    treeitem: 1,
  }
  // `tab` USED TO BE IN THE LIST ABOVE, AND TAKING IT OUT IS THE POINT.
  //
  // MEASURED ON A LIVE ASHBY APPLICATION (2026-08-03): every posting renders an
  // "Overview" / "Application" tab strip, both `role="tab"`, so every scan
  // emitted two `aria-tab` fields. fill-plan.mjs's VERB map has no entry for
  // that type, so both landed in `unsupported field type` — and submitReadiness
  // blocks on ANY defer. The result was an application that could never be
  // submitted unattended, on every Ashby posting, forever, because of the
  // page's own navigation.
  //
  // WHY THIS IS NOT "WEAKENING THE SWEEP TO GET A GREEN RUN", which is exactly
  // the pressure this file warns about: a tab is an ACTION, and the distinction
  // is real rather than convenient. `aria-selected` on a tab says WHICH PANEL
  // IS SHOWING — it changes what the user SEES, not what the form SENDS. No
  // value in a tab strip is submitted with the application. That is the same
  // property that puts button, link and menuitem in ACTION_ROLE below.
  //
  // AND IT IS NOT COVERED BY THE STATEFUL ESCAPE HATCH, deliberately. That
  // hatch exists so a board rendering a CONSENT TICK as role="button" is still
  // seen, because there the state IS the value. A tab carries aria-selected by
  // specification, so leaving it to the hatch would put every tab strip
  // straight back into `fields`. So `tab` is excluded whether or not it
  // declares state — the one role in this file for which that is true, and it
  // is true because its state is not a value.
  //
  // WHAT THIS COSTS, stated rather than glossed: a board that renders a real
  // yes/no answer as a tab strip is now invisible to the sweep. Nothing in this
  // repo has ever seen one, and the button-pair detector above already covers
  // the shape it would most likely take.
  const NAVIGATION_ROLE = { tab: 1, tablist: 1, tabpanel: 1 }
  // NATIVE ELEMENTS THAT ARE FOCUSABLE BUT ARE NOT FORM CONTROLS. `a[href]`,
  // <summary>, <iframe> and the media elements are all tab stops with an
  // implicit role no page had to declare, and every board has policy links. A
  // measured false positive, not a hypothetical: before this list, a probe of
  // <a href="/privacy" tabindex="0">Privacy policy</a> reported a `widget`
  // field with an EMPTY label, and an <iframe> already reported in `iframes`
  // was reported a second time as a control. They are skipped UNLESS the page
  // overrode the implicit role with a control role or gave the element state,
  // so <a role="checkbox" aria-checked> is still seen.
  const NATIVE_NONFORM = {
    A: 1,
    IFRAME: 1,
    SUMMARY: 1,
    DETAILS: 1,
    AUDIO: 1,
    VIDEO: 1,
    EMBED: 1,
    OBJECT: 1,
  }
  const ACTION_ROLE = { button: 1, link: 1, menuitem: 1 }
  const STATE_ATTR = ["aria-checked", "aria-pressed", "aria-selected"]
  const CONTAINS_CONTROL =
    "input,select,textarea,button,[data-aj],[tabindex],[contenteditable],[role='button']"
  // The cut is STATED, never silent — same reasoning as optsTruncated. A form
  // with more than this many unrecognised focusable controls is not a form this
  // pipeline should be filling unattended, and saying so beats reporting 200.
  const MAX_WIDGET = 25
  let widgetCut = 0
  // THE ROLE LIST IS STILL IN THE SELECTOR, AND THAT IS NOT A RELAPSE — IT IS A
  // UNION, NEVER A FILTER. Shape E collected [role='checkbox'] with no
  // focusability test at all, so a <div role="checkbox"> carrying NO tabindex
  // (it is reachable by click, and screen readers announce it) was reported.
  // Detecting on focusability ALONE would have silently dropped it: a probe of
  // exactly that markup came back with zero fields. Narrowing coverage while
  // claiming to widen it is the worst possible outcome here, so the two
  // detectors are OR'd — declared control role, OR focusable — and nothing
  // Shape E saw can stop being seen.
  //
  // A THIRD DETECTOR JOINS THAT UNION: DECLARED STATE. The two above ask "can
  // the user reach this control" and "does it say it is one". Neither asks
  // whether it HOLDS A VALUE, and a native <button aria-pressed> answers only
  // the third — it matched nothing here, so the button loop's hand-off landed
  // on an empty selector and the control was reported NOWHERE. Not in
  // `fields`, not in `btns`, not anywhere.
  //
  // MEASURED 2026-08-03 through tests/fixtures/boards/dom.mjs, one lone
  // stateful control per page beside a plain text input:
  //   <button aria-pressed>                      no field, no button  MISSED
  //   <button tabindex="0" aria-pressed>         no field, no button  MISSED
  //   <input type=submit aria-pressed>           no field, no button  MISSED
  //   <a href aria-pressed>                      no field, no button  MISSED
  //   <div role=button tabindex=0 aria-pressed>  widget field         seen
  // The ONE shape that worked is the one the button loop's comment was written
  // against, and that is how a hole this size stayed invisible: that case is
  // not NATIVE, so it reached this sweep, while every native shape in that
  // loop's own selector fell through both passes. A consent tick rendered as a
  // stateful <button> was therefore neither ticked (safe) nor DEFERRED (not
  // safe) — it reached no approval message, no pending question, no defer
  // list. A silence is not a refusal, and per this file's header a silence is
  // the worse of the two failure modes.
  //
  // The state attributes go in the SELECTOR, never in the filters: an element
  // that merely carries one and is neither focusable nor a declared control —
  // a <td aria-selected> in a grid, a <span aria-checked> — is still dropped
  // below exactly as before. What is enumerated widened; what is REPORTED
  // widened by precisely the set the button loop hands over.
  const SWEEP_SEL =
    "[tabindex],[contenteditable]," +
    STATE_ATTR.map((a) => "[" + a + "]").join(",") +
    "," +
    Object.keys(CONTROL_ROLE)
      .map((r) => "[role='" + r + "']")
      .join(",")
  for (const el of document.querySelectorAll(SWEEP_SEL)) {
    // THE HAND-OFF, HONOURED. The button loop already decided this control is a
    // VALUE rather than an ACTION, so it must be looked at whatever its tag and
    // whether or not it is a tab stop. This overrides those two structural
    // skips and NOTHING else: `handed` already implies visible, enabled and
    // unclaimed, because that loop tested all three before handing it over, and
    // every check below still applies unchanged.
    const handed = handedToSweep.has(el)
    // Exclusion 1 (NATIVE) exists to stop a double report of something the
    // loops above collected. A handed control is by definition one NONE of them
    // collected — BUTTON, which no loop above collects at all, and the inputs
    // whose `type` the field loop refuses — so the reason for the skip is
    // absent and the skip is too.
    if (NATIVE[el.tagName] && !handed) continue
    if (claimedNow(el)) continue
    const role = full(el.getAttribute("role")).toLowerCase()
    const stateful = STATE_ATTR.some((a) => el.hasAttribute(a))
    if (NATIVE_NONFORM[el.tagName] && !CONTROL_ROLE[role] && !stateful) continue
    // tabindex >= 0 only: a negative one is programmatic focus (modals, focus
    // traps), not a tab stop, and is not a control the user can reach.
    const ti = el.getAttribute("tabindex")
    const ce = el.getAttribute("contenteditable")
    const tabbable = ti !== null && /^\s*\d+\s*$/.test(ti)
    const editable = ce !== null && !/^(false|inherit)$/i.test(full(ce))
    // A handed control needs no tabindex to earn its place: <button> and
    // <input> are tab stops by their tag, which is the same reason
    // NATIVE_NONFORM has to exist a few lines up. Requiring the attribute here
    // would re-close the hole for the commonest spelling of it.
    if (!tabbable && !editable && !CONTROL_ROLE[role] && !handed) continue
    if (!vis(el)) continue
    if (el.getAttribute("aria-disabled") === "true") continue
    if (el.getAttribute("aria-hidden") === "true") continue
    let hasControl = false
    try {
      hasControl = !!el.querySelector(CONTAINS_CONTROL)
    } catch {}
    if (hasControl) continue
    if (ACTION_ROLE[role] && !stateful) continue
    // Navigation, whatever state it declares — see NAVIGATION_ROLE above for
    // why this one ignores the stateful hatch that every other skip honours.
    if (NAVIGATION_ROLE[role]) continue
    widgetCut++
    if (widgetCut > MAX_WIDGET) continue
    const da = labelDetail(el)
    // A CONTROL WITH NO LABEL IS IDENTIFIED BY ITS OWN TEXT, or it is not
    // identified at all. <span tabindex="0">I agree to the terms</span> has no
    // label by any DECLARED route, and reporting it with l:"" puts an anonymous
    // row in the approval message — a defer the user cannot act on, i.e. barely
    // better than the silence this block exists to end.
    //
    // AND THE PRECEDENCE IS NOT "LABEL FIRST". This is the E8 trap in its exact
    // shape, measured here rather than reasoned about: the waterfall's `near`
    // route walks ANCESTORS for a label-ish element, so on
    //   <label for="n">Full name</label><input id="n">
    //   <span tabindex="0">I agree to binding arbitration</span>
    // it stamped "Full name" onto the consent span. A wrong label is worse than
    // an empty one, because the user acts on it.
    //
    // So a label the CONTROL ITSELF declares (aria-labelledby, aria-label,
    // <label for>, an enclosing <label>) wins; otherwise the element's own
    // rendered text wins, because that is how these controls are authored —
    // <div role="checkbox">I agree</div> carries its label as content; and only
    // when there is neither does an INFERRED label get used, marked as inferred
    // so nothing downstream mistakes it for the control's own words.
    const INFERRED = { near: 1, legend: 1, attr: 1 }
    const declared = INFERRED[da.src] ? "" : txt(da.text)
    // `value` because a handed <input type="submit"> renders its label there
    // and has no innerText at all — without it the waterfall falls through to
    // the INFERRED branch and stamps a neighbouring field's label on it, which
    // is the E8 trap above in its exact shape. No effect on anything that
    // reached this sweep before: `.value` is undefined on a plain element, and
    // innerText wins whenever there is any.
    const ownText = txt(el.innerText || el.value)
    const label = declared || ownText || txt(da.text)
    const inferred = !declared && !ownText && !!label
    const checked = el.getAttribute("aria-checked")
    fields.push({
      k: stamp(el, "f"),
      sel: stableSel(el),
      ...identityOf(el),
      t: CONTROL_ROLE[role] ? "aria-" + role : "widget",
      l: label,
      lSeen: declared ? seenOf(el, da) : undefined,
      labelWhy: inferred
        ? "label inferred from a nearby element, not declared by the control"
        : undefined,
      req: isReq(el, label) || undefined,
      v:
        (checked === "true" ? "true" : undefined) ??
        (editable ? txt(el.innerText, 60) || undefined : undefined),
      h: helpOf(el) || undefined,
      // Stated so a consumer does not have to parse the type string: this is
      // a control no verb in this pipeline can operate.
      widget: "aria",
    })
  }
  if (widgetCut > MAX_WIDGET) {
    signals.push(
      widgetCut -
        MAX_WIDGET +
        " further focusable control(s) this scanner has no verb for were not reported — fill this form by hand",
    )
  }

  fields.push(...combos)
  const elFor = (f) => elOf.get(f.k) || (f.o && f.o[0] && elOf.get(f.o[0].k))

  // --- the heading a field sits under --------------------------------------
  // Greenhouse labels BOTH attachment inputs "Attach"; the word that tells
  // resume from cover letter is the SECTION HEADING above each one, which sits
  // outside the element labelOf() reads. Until now nothing carried it, so the
  // two fields were the same string in the scan and the only thing separating
  // them was document order — which is a convention of these boards, not a
  // fact about the page. `section` is that heading, reported so a consumer can
  // tell them apart, and so a field whose label contradicts the heading it
  // sits under is at least VISIBLE as a contradiction.
  //
  // It is REPORTED, NOT MERGED INTO `l`. `l` is what answer-bank matches on,
  // what the field cache keys on and what the form fingerprint hashes;
  // repointing all of that at a concatenated string is a bigger change than
  // the one being made. Same reasoning as lSeen above.
  //
  // Omitted when it equals the page heading already at the top of this scan.
  // On a form with no sections that is EVERY field, and a key with the same
  // value on every field distinguishes nothing — which is precisely the
  // property this exists to supply. Omitted when it merely repeats the label
  // too.
  const HEADING_SEL =
    "h1,h2,h3,h4,h5,h6,legend,[role='heading'],[class*='section-header'],[class*='sectionHeader']"
  const pageHeading = txt(
    (document.querySelector("h1") || {}).innerText || document.title,
    100,
  )
  let headings = []
  try {
    headings = [...document.querySelectorAll(HEADING_SEL)].filter(vis).slice(0, 40)
  } catch {}
  // A HEADING ONLY SPEAKS FOR ITS OWN CONTAINER, and this is not a detail —
  // "the last heading before this control" alone got it wrong on the very
  // first page it was run against. greenhouse-step2.html closes a
  // <fieldset><legend>Voluntary Self-Identification of Disability</legend>
  // and THEN renders the "I certify..." checkbox; by document order that
  // legend precedes the checkbox, and the checkbox is not in that section at
  // all. So the heading's own parent must also contain the field.
  //
  // The same rule disposes of the page <h1>: its parent is <body>, which
  // contains every field on the page, so a page-level heading would otherwise
  // be stamped on all of them — and a key with the same value everywhere
  // distinguishes nothing, which is the property this exists to supply. A
  // heading whose parent is BODY/HTML is therefore never a section.
  const owns = (h, el) => {
    const p = h.parentElement
    if (!p || p.tagName === "BODY" || p.tagName === "HTML") return false
    return !!(p.contains && p.contains(el))
  }
  const sectionOf = (el) => {
    if (!el || !headings.length) return undefined
    let best = null
    for (const h of headings) {
      if (h === el || (h.contains && h.contains(el))) continue
      // Document order: the last heading that comes BEFORE this control.
      if (!(h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)) {
        break
      }
      if (owns(h, el)) best = h
    }
    const t = best ? txt(best.innerText, 80) : ""
    if (!t || t === pageHeading) return undefined
    return t
  }
  for (const f of fields) {
    const s = sectionOf(elFor(f))
    if (s && full(s).toLowerCase() !== full(f.l).toLowerCase()) f.section = s
  }

  fields.sort((a, b) => {
    const ea = elFor(a)
    const eb = elFor(b)
    if (!ea || !eb) return 0
    return ea.compareDocumentPosition(eb) & Node.DOCUMENT_POSITION_FOLLOWING
      ? -1
      : 1
  })

  // --- reading a custom dropdown's options ---------------------------------
  // A MENU IS AN ELEMENT THE CONTROL NAMES, AND ITS ROWS ARE ITS LEAVES.
  //
  // MEASURED on Oracle Recruiting Cloud, 2026-08-04. Three required pickers —
  // "How did you hear about us?", "Gender", "Veteran Status" — came back with
  // ONE option each, and that option was every option run together and cut at
  // 60 characters:
  //
  //   "Billboard Built In Facebook Indeed LinkedIn Radio Ad Referra"
  //
  // Two independent causes, both of them the old selector list:
  //   * THE ROWS ARE NOT role="option". ORC's rows are plain divs, so
  //     [role='option'] matched nothing.
  //   * "[role='listbox'] li" MATCHED A CONTAINER. The only <li> inside the
  //     listbox is the scroller that holds every row, so its innerText IS the
  //     whole menu. A container's text is not an option and never was; the
  //     selector list simply had no way to say so.
  //
  // A blob is worse than nothing. `opts` is what answer-bank.mjs matches the
  // user's answer against and what the field cache stores as this form's
  // option list, so one 60-character non-answer means every real answer
  // resolves "not on offer" — and the cache then says so again on every future
  // application to this board.
  //
  // WHAT REPLACES IT, in order:
  //   1. THE MENU THE CONTROL NAMES. aria-controls / aria-owns points at the
  //      listbox from the combobox. That is the page telling us which element
  //      is this control's menu, which is strictly better evidence than any
  //      class-name guess, and it also scopes the read: a page-wide selector
  //      hands every dropdown the same list (the phone country-code widget is
  //      always in the DOM, which scan-engine.mjs's probe already records).
  //   2. INSIDE IT, role="option" rows when the page declares them.
  //   3. OTHERWISE ITS TEXT LEAVES — elements holding text with no descendant
  //      that holds text — each climbed back out to the outermost ancestor
  //      whose text is still the SAME string, so <li><span>X</span></li>
  //      yields the <li> once rather than the span and the li twice.
  // Only when the control names no menu does it fall back to the old
  // page-wide selector list, and even then containers are dropped: a candidate
  // that contains another candidate is not a row.
  //
  // STATED LIMIT: a row built from two text nodes that are NOT one string —
  // <li><span>Billboard</span><span>(offline)</span></li> — yields two rows.
  // The dominant shape is one label per row; a page like that reads as two
  // options rather than one, which is a visible wrong list, not a silent one.
  const OPTION_SEL =
    "[role='option'],[role='listbox'] li,[class*='__option'],[class*='menu'] li"
  // Guards the leaf walk, which costs an innerText per node. A menu with more
  // nodes than this is not a menu; fall back rather than pay for it.
  const MENU_NODES_MAX = 400
  const menuOf = (el) => {
    const ids = full(
      (el.getAttribute && (el.getAttribute("aria-controls") || el.getAttribute("aria-owns"))) || "",
    ).split(/\s+/)
    for (const id of ids) {
      const m = byId(id)
      if (m && vis(m)) return m
    }
    return null
  }
  // Drop any candidate that contains another candidate: a container is not a
  // row, and this is what turns the blob back into a list even on the
  // page-wide fallback path.
  const leavesOnly = (list) =>
    list.filter((n) => !list.some((o) => o !== n && n.contains && n.contains(o)))
  const rowsIn = (menu) => {
    let declared = []
    try {
      declared = [...menu.querySelectorAll("[role='option']")]
    } catch {}
    if (declared.length) return declared
    let nodes = []
    try {
      nodes = [...menu.querySelectorAll("*")]
    } catch {
      return []
    }
    if (nodes.length > MENU_NODES_MAX) return leavesOnly(nodes.filter(vis))
    const out = []
    const seen = new Set()
    for (const n of nodes) {
      const t = full(n.innerText)
      if (!t) continue
      let leaf = true
      try {
        for (const c of n.querySelectorAll("*")) {
          if (full(c.innerText)) {
            leaf = false
            break
          }
        }
      } catch {
        continue
      }
      if (!leaf) continue
      // Climb back out while the text is unchanged, so the row rather than the
      // span inside it is what gets reported.
      let best = n
      for (let p = n.parentElement; p && p !== menu; p = p.parentElement) {
        if (full(p.innerText) !== t) break
        best = p
      }
      if (seen.has(best)) continue
      seen.add(best)
      out.push(best)
    }
    return out
  }
  const optionTexts = (el) => {
    const menu = menuOf(el)
    let rows
    if (menu) {
      rows = rowsIn(menu)
    } else {
      let wide = []
      try {
        wide = [...document.querySelectorAll(OPTION_SEL)]
      } catch {}
      rows = leavesOnly(wide)
    }
    return rows.filter(vis).map((o) => txt(o.innerText, 60))
  }

  // --- probe custom dropdowns (batched) -----------------------------------
  if (PROBE) {
    // WHAT THE PROBE IS ALLOWED TO CLICK. Mirrored from
    // scripts/apply/scan-engine.mjs's probeRefusal(), the canonical copy, which
    // carries the full reasoning; this file runs in page context and cannot
    // import it. tests/apply/fill-page.test.mjs pins the copies identical.
    // Shape alone cannot tell a country picker from a button a board decorated
    // with role="combobox" and labelled "Withdraw my application", so: (1) a
    // picker's name comes from OUTSIDE it, a button's name is its own text;
    // (2) a word list as a named backstop, which is not the load-bearing half.
    const KEY = (s) =>
      String(s || "")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase()
    const DESTRUCTIVE_LABEL =
      /\b(withdraw|delete|deactivate|remove|revoke)\b|\bsubmit\b|\bsend (my |the )?applicat|\bconfirm and\b|\bclose (my )?(account|profile)\b/i
    const probeRefusal = (f) => {
      const name = KEY(f && f.l)
      const own = KEY(f && f.v)
      if (!name) return "no label to identify it as a picker"
      if (
        own &&
        (name === own ||
          (own.length >= 12 && (name.startsWith(own) || own.startsWith(name))))
      ) {
        return "its name is its own text, so it is a button, not a picker"
      }
      if (DESTRUCTIVE_LABEL.test(String((f && f.l) || ""))) {
        return "label reads as an action on the application, not a choice"
      }
      return ""
    }
    for (const f of combos.slice(0, MAX_PROBE)) {
      const el = elOf.get(f.k)
      if (!el || !el.isConnected) continue
      const refusal = probeRefusal(f)
      if (refusal) {
        f.probe_refused = refusal
        continue
      }
      try {
        el.click()
        await sleep(200)
        const all = uniq(optionTexts(el))
        f.opts = all.slice(0, MAX_OPTS)
        // Same silent cut as the <select> branch above, same consequence.
        if (all.length > MAX_OPTS) {
          f.optsTruncated = true
          f.optsTotal = all.length
        }
        if (!f.opts.length) f.opts = undefined
        el.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Escape",
            keyCode: 27,
            bubbles: true,
          }),
        )
        document.body.click()
        await sleep(80)
      } catch (e) {
        f.probe_error = txt(e && e.message, 60)
      }
    }
  }

  // --- page-level context -------------------------------------------------
  const iframeEls = [...document.querySelectorAll("iframe")].filter(vis).slice(0, 6)
  const iframes = iframeEls.map((f) => ({
    src: txt(f.src, 160),
    title: txt(f.title, 60),
  }))
  // A CAPTCHA VENDOR IS NOT A CAPTCHA CHALLENGE. Matching the vendor name
  // alone shut the entire pipeline, and the failure was invisible because it
  // looked like the guardrail working. Greenhouse, Lever and Ashby all embed
  // reCAPTCHA in its `size=invisible` score-based form: it renders a corner
  // badge, asks the user nothing, and a human fills those forms without ever
  // interacting with it. So every board with an adapter — every board on the
  // trust allowlist — deferred its whole page at `items: 0`. That took the
  // ATTENDED path down too, and the attended path is the only lawful source
  // of the post-submit corpus (§4.10), so both paths were gated shut at once
  // and neither could bootstrap the other. Measured 2026-08-03 on GitLab,
  // Affirm and Reddit: `size=invisible`, `.grecaptcha-badge` present, no
  // challenge rendered.
  //
  // FAIL CLOSED, AND THAT IS THE LOAD-BEARING HALF. A frame is passive ONLY
  // when it positively identifies itself as invisible AND does not look like
  // a challenge frame. Everything else still hands off: an hCaptcha
  // `frame=checkbox` (Map SSG, same day), a reCAPTCHA v2 anchor with
  // `size=normal`, a Turnstile widget, and a `bframe` that an invisible flow
  // ESCALATED into a real challenge. `vis` above is the other half of that
  // guarantee — an unshown challenge frame is `display:none` and never
  // reaches this list, so a challenge that appears later appears here.
  //
  // This narrows what counts as a challenge; it does not defeat, solve or
  // forge one. The score check still runs and still judges the session, and
  // a score low enough to fail still fails the submit visibly.
  // CLASSIFY FROM `iframeEls`, THE RAW ELEMENTS — NOT from `iframes` above.
  // That copy is truncated to 160 chars for reporting, and on a real
  // Greenhouse anchor the `size=invisible` parameter sits PAST the cut: the
  // first attempt at this fix read the truncated string, never matched, and
  // every board stayed blocked while the tests passed. The tests could not
  // catch it because they feed signal strings to the planner and never build
  // one from a live DOM. Read the full src here; truncate only for output.
  const CAPTCHA_VENDOR = /recaptcha|hcaptcha|turnstile/i
  const CAPTCHA_CHALLENGE = /bframe|frame=challenge|frame=checkbox|checkbox/i
  const captchaFrames = iframeEls.filter((f) => CAPTCHA_VENDOR.test(f.src))
  const captchaPassive = (f) =>
    /[?&#]size=invisible\b/i.test(String(f.src || "")) &&
    !CAPTCHA_CHALLENGE.test(String(f.src || "")) &&
    !CAPTCHA_CHALLENGE.test(String(f.title || ""))
  if (captchaFrames.some((f) => !captchaPassive(f)))
    signals.push("CAPTCHA present — hand off to the user")
  else if (captchaFrames.length)
    // Prefix pinned: fill-plan.mjs treats any OTHER captcha signal as blocking,
    // so a new or unrecognised one fails closed rather than opening the gate.
    signals.push(
      "captcha passive: invisible score-based widget, no challenge shown",
    )
  const embedded = iframes.find((f) =>
    /greenhouse|lever|ashby|workday|smartrecruiters|jobvite|icims/i.test(
      f.src,
    ),
  )
  if (embedded)
    signals.push(
      `application embedded in iframe — navigate to ${embedded.src}`,
    )

  // --- WHAT THIS SCANNER CANNOT SEE, SAID OUT LOUD -------------------------
  // A DELIBERATE REFUSAL, NOT SUPPORT. Everything above is built on
  // document.querySelectorAll, which stops at a shadow boundary and at a
  // document boundary. A form inside a web component's open shadow root, or
  // inside a same-origin iframe, is therefore INVISIBLE here: the scan comes
  // back short, the plan is built for the fields that were visible, and the
  // run reports a clean fill of a form nobody filled.
  //
  // Crossing those boundaries properly is a different piece of work — it needs
  // every selector in the fill engine to become frame-and-root aware, and a
  // closed shadow root cannot be crossed at all. Silence would be the worse
  // outcome, so this DETECTS the boundary and says so, and the honest failure
  // is a hand-off to the user rather than a scan that looks complete.
  //
  // Only reported when the hidden subtree actually contains form controls: a
  // shadow root holding a styled button is not a blind spot worth a signal.
  const HIDDEN_CONTROL =
    "input,select,textarea,[contenteditable='true']," +
    "[role='combobox'],[role='checkbox'],[role='radio'],[role='switch']"
  let shadowForms = 0
  try {
    // Capped: this is one pass over the document on every scan, and a huge
    // page should not pay for an unbounded one.
    const all = document.querySelectorAll("*")
    const cap = Math.min(all.length, 4000)
    for (let i = 0; i < cap; i++) {
      const r = all[i].shadowRoot
      if (r && r.querySelector && r.querySelector(HIDDEN_CONTROL)) shadowForms++
    }
  } catch {}
  if (shadowForms) {
    signals.push(
      shadowForms +
        " shadow root(s) hold form controls this scanner cannot see or fill — fill them by hand",
    )
  }
  let frameForms = 0
  for (const fr of [...document.querySelectorAll("iframe")].slice(0, 6)) {
    let doc = null
    try {
      // Cross-origin throws; that case is already covered by the embed signal
      // above and is not a silent blind spot.
      doc = fr.contentDocument
    } catch {}
    try {
      if (doc && doc.querySelector && doc.querySelector(HIDDEN_CONTROL))
        frameForms++
    } catch {}
  }
  if (frameForms) {
    signals.push(
      frameForms +
        " same-origin iframe(s) hold form controls this scanner cannot see or fill — open the frame directly",
    )
  }

  const body = txt(document.body.innerText, 3000)
  // A PAGE WHOSE ONLY "FIELDS" ARE CONTROLS NO VERB CAN OPERATE IS NOT YET A
  // FORM, and this test had to grow a second half the moment the sweep started
  // reporting stateful NATIVE buttons.
  //
  // MEASURED 2026-08-03: a job ad — <h1>, prose, an "Apply now" link and a
  // <button aria-pressed="false">Save job</button> — used to classify `ad`,
  // because the toggle was the silent miss and `fields` came back empty. Once
  // it is reported, `fields.length` alone flips the page to `form`, and per
  // SKILL.md's routing table that sends the skill to step B to build a plan
  // instead of clicking Apply. The plan then holds one unfillable defer and
  // the apply stalls on a page that was never the application. Bookmark and
  // follow toggles are ordinary furniture on a job ad, so this is the common
  // case, not a corner of one.
  //
  // `widget` is already the key meaning "no verb in this pipeline operates
  // this control" (see the header), so the discriminator is the one the file
  // already has, not a new one. AN OPERABLE FIELD STILL WINS: a real form
  // whose consent is a <div role="checkbox"> is unaffected, and so is a
  // widget-only form, because neither carries a `start` button — only the
  // three-way tie of "no operable field", "a start button" and "something
  // swept in" resolves differently than before.
  const operable = fields.some((f) => !f.widget)
  const kind = signals.some((s) => s.startsWith("password"))
    ? "login"
    : /thank you for applying|application (was )?(received|submitted)|we('| ha)ve received your application/i.test(
          body,
        )
      ? "confirm"
      : operable
        ? "form"
        : btns.some((b) => b.r === "start")
          ? "ad"
          : fields.length
            ? "form"
            : "unknown"

  return {
    url: location.href,
    heading: txt(
      (document.querySelector("h1") || {}).innerText || document.title,
      100,
    ),
    kind,
    fields,
    btns,
    iframes: iframes.length ? iframes : undefined,
    signals: signals.length ? uniq(signals) : undefined,
  }
}
// --- scanner ends here; nothing below is part of the function ---------------
// scan-engine.mjs's scannerExpression() slices between the assignment above and
// this line, so that it can eval the function into a LOCAL binding instead of
// calling it through window. Do not remove this marker, and do not put anything
// between it and the closing brace.
//
// Lock the global. Not load-bearing — scan-engine.mjs never reads
// window.__ajScan, and the MCP driver already strips every vouch precisely
// because it has to. This removes a free move: after install, a script on the
// page cannot quietly swap the scanner out, and an attempt to do so throws in
// strict mode instead of succeeding in silence. If the page got there FIRST the
// property is already non-configurable, this throws, and the catch leaves the
// situation exactly as it was — no worse, and the driver's preOwned check is
// what notices.
try {
  Object.defineProperty(window, "__ajScan", {
    value: window.__ajScan,
    writable: false,
    configurable: false,
  })
} catch (e) {}
