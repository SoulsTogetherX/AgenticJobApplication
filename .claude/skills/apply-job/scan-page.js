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
// Self-installing: evaluating this file defines window.__ajScan. To paste it
// directly into browser_evaluate instead, paste from `async (PROBE` onward.
//
// NOT a module: no imports, no exports, no leading semicolon (see .prettierignore).
window.__ajScan = async (PROBE = true) => {
  const MAX_OPTS = 40
  const MAX_PROBE = 15

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const txt = (s, n = 120) =>
    String(s == null ? "" : s)
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, n)
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

  function labelOf(el) {
    const lb = el.getAttribute && el.getAttribute("aria-labelledby")
    if (lb) {
      const t = lb
        .split(/\s+/)
        .map((i) => byId(i) && byId(i).innerText)
        .filter(Boolean)
        .join(" ")
      if (txt(t)) return txt(t)
    }
    const al = el.getAttribute && el.getAttribute("aria-label")
    if (txt(al)) return txt(al)
    if (el.id) {
      let l = null
      try {
        l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`)
      } catch {}
      if (l && txt(l.innerText)) return txt(l.innerText)
    }
    const wrap = el.closest && el.closest("label")
    if (wrap && txt(wrap.innerText)) return txt(wrap.innerText)
    const fs = el.closest && el.closest("fieldset")
    const lg = fs && fs.querySelector("legend")
    if (lg && txt(lg.innerText)) return txt(lg.innerText)
    let p = el.parentElement
    for (let i = 0; i < 4 && p; i++, p = p.parentElement) {
      const cand = p.querySelector(
        "label,legend,[class*='label'],[class*='Label'],[class*='question'],[class*='Question']",
      )
      if (cand && !cand.contains(el) && txt(cand.innerText)) {
        return txt(cand.innerText)
      }
    }
    return txt(el.placeholder || el.name || "")
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
    const label = labelOf(el)
    combos.push({
      k: stamp(el, "f"),
      sel: stableSel(el),
      t: "combo",
      l: label,
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
    const label = labelOf(el)

    if (type === "radio" || type === "checkbox") {
      const gid = type + ":" + (el.name || label || "?")
      let g = groups.get(gid)
      if (!g) {
        g = {
          k: "g" + (groups.size + 1),
          t: type,
          l: labelOf(el.closest("fieldset") || el) || label,
          req: isReq(el, label) || undefined,
          o: [],
        }
        groups.set(gid, g)
        fields.push(g)
      }
      g.o.push({
        k: stamp(el, "f"),
        sel: stableSel(el),
        l: txt(label, 80),
        on: el.checked || undefined,
      })
      continue
    }

    const f = {
      k: stamp(el, "f"),
      sel: stableSel(el),
      t: tag === "select" ? "select" : tag === "textarea" ? "textarea" : type,
      l: label,
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

  for (const el of document.querySelectorAll("[contenteditable='true']")) {
    if (!vis(el) || el.closest("[data-aj]")) continue
    fields.push({
      k: stamp(el, "f"),
      sel: stableSel(el),
      t: "richtext",
      l: labelOf(el),
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
