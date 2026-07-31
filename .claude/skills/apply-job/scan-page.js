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
// And one on ANY field: lSeen — the VISIBLE label, present only when it
// disagrees with `l` (i.e. `l` came from an aria-label or a placeholder that
// says something else). `l` never changes for those fields; a caller showing
// the user a field should show both, because a page contradicting itself is
// information. Absent on an honest field, so it costs nothing on the wire.
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
  function labelDetail(el, skipAriaLabel) {
    const attr = (a) => (el.getAttribute ? el.getAttribute(a) : null)
    const lb = attr("aria-labelledby")
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
    if (!skipAriaLabel && full(al))
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
  const visibleToEye = (el) => {
    if (!vis(el)) return false
    const r = el.getBoundingClientRect()
    if (r.width < 8 || r.height < 8) return false
    const sx = window.scrollX || window.pageXOffset || 0
    const sy = window.scrollY || window.pageYOffset || 0
    return r.right + sx > 0 && r.bottom + sy > 0
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
  const seenOf = (el, d) => {
    if (d.src !== "arialabel" && d.src !== "attr") return undefined
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
    return { text: d.text, src: d.src, why: vouchFail(el, d) }
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
    if (el.tagName === "SELECT" || !vis(el) || el.closest("[data-aj]"))
      continue
    const dc = labelDetail(el)
    const label = txt(dc.text)
    combos.push({
      k: stamp(el, "f"),
      sel: stableSel(el),
      t: "combo",
      l: label,
      lSeen: seenOf(el, dc),
      req: isReq(el, label) || undefined,
      v: txt(el.value || el.innerText, 60) || undefined,
      h: helpOf(el) || undefined,
    })
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
    if (!vis(el) && type !== "file") continue
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
          req: isReq(el, own) || undefined,
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
      g.o.push({
        k: stamp(el, "f"),
        sel: stableSel(el),
        l: g.labelExact ? own : txt(own, 80),
        on: el.checked || undefined,
      })
      continue
    }

    const f = {
      k: stamp(el, "f"),
      sel: stableSel(el),
      t: tag === "select" ? "select" : tag === "textarea" ? "textarea" : type,
      l: label,
      lSeen: seenOf(el, dg),
      req: isReq(el, label) || undefined,
      v: txt(el.value, 60) || undefined,
      h: helpOf(el) || undefined,
    }
    if (tag === "select") {
      f.opts = [...el.options].map((o) => txt(o.text, 60)).slice(0, MAX_OPTS)
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
    if (!vis(el) || el.closest("[data-aj]")) continue
    fields.push({
      k: stamp(el, "f"),
      sel: stableSel(el),
      t: "richtext",
      l: labelOf(el),
      lSeen: seenOf(el, labelDetail(el)),
      v: txt(el.innerText, 60) || undefined,
    })
  }

  fields.push(...combos)
  const elFor = (f) => elOf.get(f.k) || (f.o && f.o[0] && elOf.get(f.o[0].k))
  fields.sort((a, b) => {
    const ea = elFor(a)
    const eb = elFor(b)
    if (!ea || !eb) return 0
    return ea.compareDocumentPosition(eb) & Node.DOCUMENT_POSITION_FOLLOWING
      ? -1
      : 1
  })

  // --- buttons ------------------------------------------------------------
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

  const btns = []
  for (const el of document.querySelectorAll(
    "button,[role='button'],input[type='submit'],input[type='button'],a[href]",
  )) {
    if (!vis(el) || el.disabled || el.hasAttribute("data-aj")) continue
    const label = txt(el.innerText || el.value || labelOf(el), 60)
    if (!label) continue
    const r = roleOf(label)
    if (el.tagName === "A" && r === "other") continue
    btns.push({ k: stamp(el, "b"), l: label, r })
    if (btns.length >= 40) break
  }

  // --- probe custom dropdowns (batched) -----------------------------------
  if (PROBE) {
    for (const f of combos.slice(0, MAX_PROBE)) {
      const el = elOf.get(f.k)
      if (!el || !el.isConnected) continue
      try {
        el.click()
        await sleep(200)
        const opts = [
          ...document.querySelectorAll(
            "[role='option'],[role='listbox'] li,[class*='__option'],[class*='menu'] li",
          ),
        ]
          .filter(vis)
          .map((o) => txt(o.innerText, 60))
        f.opts = uniq(opts).slice(0, MAX_OPTS)
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
  const iframes = [...document.querySelectorAll("iframe")]
    .filter(vis)
    .slice(0, 6)
    .map((f) => ({ src: txt(f.src, 160), title: txt(f.title, 60) }))
  if (iframes.some((f) => /recaptcha|hcaptcha|turnstile/i.test(f.src)))
    signals.push("CAPTCHA present — hand off to the user")
  const embedded = iframes.find((f) =>
    /greenhouse|lever|ashby|workday|smartrecruiters|jobvite|icims/i.test(
      f.src,
    ),
  )
  if (embedded)
    signals.push(
      `application embedded in iframe — navigate to ${embedded.src}`,
    )

  const body = txt(document.body.innerText, 3000)
  const kind = signals.some((s) => s.startsWith("password"))
    ? "login"
    : /thank you for applying|application (was )?(received|submitted)|we('| ha)ve received your application/i.test(
          body,
        )
      ? "confirm"
      : fields.length
        ? "form"
        : btns.some((b) => b.r === "start")
          ? "ad"
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
