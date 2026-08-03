#!/usr/bin/env node
// The local fake ATS. Node's built-in `http` and nothing else.
//
// WHY THIS EXISTS
//
// Every browser-path test in this repo used to need a real employer's job
// board, which means it was never written. This server is the replacement:
// static replicas of Greenhouse, Lever and Ashby application forms, plus
// hostile variants, served from 127.0.0.1 on an ephemeral port. The whole
// scan -> plan -> fill path becomes testable in CI, and QA never sends a
// request, a form submission or an application to a real company.
//
// THE SAFETY RULE THIS FILE ENFORCES
//
// It binds loopback only and it refuses to start anywhere else (see
// assertLoopback). It serves bytes from two fixture directories and nothing
// else — no proxying, no upstream fetch, no redirect off-host. A test that
// points a browser here cannot reach a real board even by accident, because
// there is no code path out.
//
// DETERMINISM
//
// Same URL, same bytes. The CSP nonce on the Ashby replica is a fixed constant
// rather than a per-request random value for exactly this reason; real Ashby
// randomises it, and the fidelity that matters here is that the policy is
// nonce-based at all (which is why the fill bootstrap cannot use
// addScriptTag). The one intentional exception is Greenhouse's multi-step
// form, where the SAME URL returns step 1 to a GET and step 2 to a POST —
// that is the trait being reproduced, and it is deterministic per method.
//
// THE LATENCY CONTRACT — read this before you put a number in a column
//
// By default this server adds NO delay: it is loopback, and a fetch of a
// fixture page costs what a loopback socket costs. `--latency` turns on a
// DECLARED model instead (~300ms per document navigation, ~150ms per data
// request) so the runner can be measured against something shaped like a real
// board's RTT.
//
//   A LATENCY-MODELLED NUMBER AND A LOOPBACK NUMBER ARE DIFFERENT
//   POPULATIONS. They must never be averaged, summed, or merged into one
//   column, and a baseline recorded under one mode may not be compared against
//   a run under the other.
//
// That is not a convention this file hopes callers remember. Every response
// carries `x-aj-latency-mode: loopback|modelled` and `x-aj-latency-ms`, and
// GET /latency.json returns the whole model, so a harness that merges the two
// populations is doing it against bytes that say not to.
//
// The model is DECLARED, not measured: it is a fixed sleep, so it reproduces
// the SHAPE of a remote board (a nav costs more than an XHR) and none of its
// variance. A p95 taken under it is a p95 of this constant, not of a board.
//
// ORIGINS — why `start({ origins: 8 })` binds eight listeners
//
// §4.2 (C9) of the autonomy plan makes the in-flight exclusion key the
// registrable ORIGIN of apply_url, not board_key: cookies and localStorage are
// origin-scoped and board_key is tenant-scoped. Eight `fixture-emp-<n>`
// segments on one port are eight TENANTS and ONE origin — so a 50-app run at
// concurrency 8 would serialise on the exclusion key and report N=1 throughput
// under the label N=8. Distinct ports are distinct origins; that is why the
// count is a listener count. `*.localhost` was rejected — see ORIGINS in the
// README and the note above `start`.
//
// RUN IT BY HAND
//
//   node tests/fixtures/boards/server.mjs            # prints a URL, stays up
//   node tests/fixtures/boards/server.mjs --port 8899
//   node tests/fixtures/boards/server.mjs --origins 8 --latency
//   node tests/fixtures/boards/server.mjs --latency nav=300,xhr=150
//
// USE IT FROM A TEST
//
//   import { start } from "../fixtures/boards/server.mjs"
//   const board = await start()          // ephemeral port, never hardcoded
//   ...                                  // board.url, board.pageUrl("ashby")
//   await board.stop()
//
//   const many = await start({ origins: 8 })
//   many.origins                         // 8 distinct http://127.0.0.1:<port>
//   many.applyUrls(50)                   // 50 job URLs across 8 origins/tenants
import http from "node:http"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PAGES = path.join(HERE, "pages")
const POST_SUBMIT = path.join(PAGES, "post-submit")

// The seven pages the post-click classifier is tested against (§4.10), in the
// order they are worth reading. `not-a-confirmation` is the CONTROL and the
// most important of them: a classifier tested only on pages it is meant to
// recognise recognises everything, so one page here is deliberately warm,
// thank-you-shaped and NOT an application receipt, and the corpus test asserts
// it comes back `unclassified`.
//
// THESE ARE THE FIXTURE'S PAGES AND EVIDENCE ABOUT NOTHING ELSE. A classifier
// rule citing one may fire on loopback only — see classify.mjs's `ruleApplies`
// and this directory's README.
export const POST_SUBMIT_KINDS = Object.freeze([
  "confirmation",
  "bot-challenge",
  "email-code-challenge",
  "identity-verification",
  "posting-gone",
  "error",
  "not-a-confirmation",
])
const SCANS = path.join(HERE, "scans")
const HOSTILE = path.resolve(HERE, "..", "hostile")

// Fixed so the same URL returns the same bytes. See DETERMINISM above.
export const ASHBY_NONCE = "ajfixturenonce"

// The Ashby resume-parse remount, in ms. It is PAGE-SIDE (pages/ashby.html's
// own setTimeout), so only a real browser pays it — this constant exists so a
// harness can account it as a declared number instead of pretending it is
// zero, and so the served page and the model can never disagree: a test asserts
// the number in the HTML equals this one.
export const ASHBY_REMOUNT_MS = 700

// The declared latency model. OFF unless asked for — see THE LATENCY CONTRACT.
//
//   nav_ms  a document navigation: any route that returns HTML.
//   xhr_ms  a data request: /routes.json, /latency.json, /scans/*, /postings/*.
//
// The classification is by RESPONSE KIND, not by a request header, because a
// fixture must return the same bytes and the same delay to `fetch`, to a
// browser navigation and to curl. Every response says which class it was
// charged as in `x-aj-latency-class`.
export const DEFAULT_LATENCY = Object.freeze({ nav_ms: 300, xhr_ms: 150 })

/**
 * Parse the `--latency` value.
 *
 * Accepted: absent/false/"off" -> loopback (no delay); true/"" -> the defaults
 * above; "300/150"; "nav=300,xhr=150"; {nav_ms, xhr_ms}.
 *
 * @returns {{mode: "loopback"|"modelled", nav_ms: number, xhr_ms: number}}
 */
export function parseLatency(arg) {
  const off = { mode: "loopback", nav_ms: 0, xhr_ms: 0 }
  if (arg == null || arg === false || arg === "off" || arg === "0") return off
  const on = (nav, xhr) => ({
    mode: "modelled",
    nav_ms: Number(nav),
    xhr_ms: Number(xhr),
  })
  if (arg === true || arg === "" || arg === "on") {
    return on(DEFAULT_LATENCY.nav_ms, DEFAULT_LATENCY.xhr_ms)
  }
  if (typeof arg === "object") {
    return on(
      arg.nav_ms ?? DEFAULT_LATENCY.nav_ms,
      arg.xhr_ms ?? DEFAULT_LATENCY.xhr_ms,
    )
  }
  const s = String(arg)
  const slash = s.match(/^(\d+)\s*\/\s*(\d+)$/)
  if (slash) return on(slash[1], slash[2])
  const kv = { nav: DEFAULT_LATENCY.nav_ms, xhr: DEFAULT_LATENCY.xhr_ms }
  let sawOne = false
  for (const part of s.split(",")) {
    const m = part.trim().match(/^(nav|xhr)\s*=\s*(\d+)$/)
    if (!m) {
      throw new Error(
        `--latency: cannot parse ${JSON.stringify(s)}. Use "off", "on", ` +
          `"300/150", or "nav=300,xhr=150"`,
      )
    }
    kv[m[1]] = Number(m[2])
    sawOne = true
  }
  if (!sawOne) throw new Error(`--latency: empty value`)
  return on(kv.nav, kv.xhr)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Loopback only. Not a preference — a rule. The hostile fixtures in this tree
// are real attack strings, and the only thing that makes them safe to keep in
// a repository is that they can never be aimed at anyone.
const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"])

export function assertLoopback(host) {
  if (!LOOPBACK.has(String(host))) {
    throw new Error(
      `refusing to bind ${host}: the fake ATS is loopback-only, so a fixture ` +
        `can never be served to anything but this machine`,
    )
  }
  return host
}

// --- the route table -------------------------------------------------------
//
// Paths are shaped like the real boards' so an adapter that sniffs the URL
// (scripts/apply/ats/index.mjs detectAts) picks the right one. `ats` records
// which adapter a URL is MEANT to select, and a test asserts it does.

// WHY THE REAL BOARD HOSTNAME IS IN THE PATH.
//
// detectAts() in scripts/apply/ats/index.mjs tests its regex against the WHOLE
// URL STRING, not against the hostname:
//
//   match: /(^|\.)greenhouse\.io/i   ->  a.match.test(url)
//
// So a loopback fixture can only select the Greenhouse adapter by carrying
// "boards.greenhouse.io" somewhere in its URL, and putting it in the path is
// the only way to do that without touching a real DNS name. Without it the
// whole fake board exercises the `generic` adapter, and fileFields,
// comboStrategies and valueAliases go untested — which would make this server
// look like coverage while providing none.
//
// That is also a finding in its own right, and tests/security/fake-board.test.mjs
// pins it: because the test is a substring of the whole URL, ANY board can
// impersonate any ATS by putting the name in its own path or query string.

/**
 * @typedef {object} Route
 * @property {string} path     the URL path served
 * @property {string} file     absolute path to the HTML
 * @property {string} ats      the adapter detectAts should choose
 * @property {string} proves   one line: what this fixture is for
 * @property {boolean} [csp]   send a nonce-based Content-Security-Policy
 * @property {string} [post]   file served for a POST to the same path
 */

/** @type {Route[]} */
export const ROUTES = [
  {
    name: "greenhouse",
    path: "/boards.greenhouse.io/fixture-widgets/jobs/1000001",
    file: path.join(PAGES, "greenhouse-step1.html"),
    post: path.join(PAGES, "greenhouse-step2.html"),
    ats: "greenhouse",
    proves:
      "single-URL multi-step form: GET is page 1, POST is page 2, urlGuard cannot tell them apart",
  },
  {
    name: "lever",
    path: "/jobs.lever.co/fixture-robotics/00000000-0000-4000-8000-000000000001/apply",
    file: path.join(PAGES, "lever.html"),
    ats: "lever",
    proves:
      "Lever label shapes: .application-label siblings, native <select>, one file slot",
  },
  {
    name: "ashby",
    path: "/jobs.ashbyhq.com/fixture-analytics/11111111-2222-3333-4444-555555555555",
    file: path.join(PAGES, "ashby.html"),
    // The page AFTER the resume-parse remount. Same URL, same trick as
    // Greenhouse's two steps: a GET is the form as first served, a POST is the
    // subtree the board swapped in ~700ms after the upload. It is a separate
    // file rather than a second route because that is what the browser sees —
    // one URL, two DOMs — and because it is the only way a scan fixture can
    // exist for the post-remount state without a browser in the loop.
    post: path.join(PAGES, "ashby-remounted.html"),
    ats: "ashby",
    csp: true,
    proves:
      "nonce-based CSP (why addScriptTag is banned) and an async remount 700ms after upload",
  },
  {
    // Ashby's OTHER rendering of a yes/no question: two <button>s, no aria
    // state, the selected one marked by a build-hashed class. Honest page,
    // and the one the 2026-08-03 silent miss was found on.
    name: "ashby-buttons",
    path: "/jobs.ashbyhq.com/fixture-compute/66666666-7777-8888-9999-aaaaaaaaaaaa",
    file: path.join(PAGES, "ashby-buttons.html"),
    ats: "ashby",
    proves:
      "a yes/no question rendered as two <button>s — filed in btns and never reported until the pair detector landed",
  },
  {
    // THE ONE HONEST PAGE. Everything below this line is an attack fixture;
    // this is the control. See the page's own header for why a defence suite
    // that only ever sees attacks cannot tell "safe" from "broken".
    name: "honest-greenhouse",
    path: "/boards.greenhouse.io/fixture-analytics/jobs/2000001",
    file: path.join(PAGES, "honest-greenhouse.html"),
    ats: "greenhouse",
    proves:
      "an ordinary application form with no custom questions reaches ready:true — the fast path, demonstrated firing",
  },
  {
    name: "hostile-fillsrc",
    path: "/hostile/fillsrc-getter",
    file: path.join(HOSTILE, "forms", "fillsrc-getter.html"),
    ats: "generic",
    proves:
      "the code round-trip: window.__ajFillSrc / __ajPlan getters that click Submit and upload .env",
  },
  {
    name: "hostile-labels",
    path: "/hostile/label-injection",
    file: path.join(HOSTILE, "forms", "label-injection.html"),
    ats: "generic",
    proves:
      "field labels carrying injections and corpus poisoning, on their way to answers.yaml",
  },
  {
    name: "hostile-consent",
    path: "/hostile/consent-decoupled",
    file: path.join(HOSTILE, "forms", "consent-decoupled.html"),
    ats: "generic",
    proves:
      "aria-label decoupling and 120-char truncation — why consent auto-tick is disabled",
  },
  {
    name: "hostile-combobox",
    path: "/hostile/destructive-combobox",
    file: path.join(HOSTILE, "forms", "destructive-combobox.html"),
    ats: "generic",
    proves:
      "destructive controls wearing role=combobox, which the scan probe clicks with force:true",
  },
  {
    name: "hostile-remount",
    path: "/hostile/remount-mid-fill",
    file: path.join(HOSTILE, "forms", "remount-mid-fill.html"),
    ats: "generic",
    proves:
      "a form that remounts every 400ms while preserving values — a filled field reported as failed",
  },
  {
    name: "hostile-mislabelled",
    path: "/hostile/mislabelled-inputs",
    file: path.join(HOSTILE, "forms", "mislabelled-inputs.html"),
    ats: "generic",
    proves:
      "labels that describe a different field from the input they wrap (phone -> ssn)",
  },
  {
    name: "hostile-escalated",
    path: "/hostile/mislabelled-escalated",
    file: path.join(HOSTILE, "forms", "mislabelled-escalated.html"),
    ats: "generic",
    proves:
      "the same substitution with id/name/autocomplete renamed to agree with the lying label — no token left to compare",
  },
  // The three RENDERINGS of the escalated page's yes/no question. Same
  // question text, same input name, same server destination; only the markup
  // differs. They exist because the claim that a consent-shaped box is
  // structurally protected was falsified — see each file's own header.
  {
    name: "hostile-escalated-tickbox",
    path: "/hostile/escalated-tickbox-yes",
    file: path.join(HOSTILE, "forms", "escalated-tickbox-yes.html"),
    ats: "generic",
    proves:
      "shape B: a lone tickbox whose OWN label is 'Yes' — the stored answer now has an option to match, and it is ticked",
  },
  {
    name: "hostile-escalated-radio",
    path: "/hostile/escalated-radio-yesno",
    file: path.join(HOSTILE, "forms", "escalated-radio-yesno.html"),
    ats: "generic",
    proves:
      "shape C: a Yes/No radio pair, the commonest real ATS rendering — same tick, from the cheapest markup",
  },
  {
    name: "hostile-escalated-ariabox",
    path: "/hostile/escalated-aria-checkbox",
    file: path.join(HOSTILE, "forms", "escalated-aria-checkbox.html"),
    ats: "generic",
    proves:
      "shape E: <div role=checkbox> — the scanner emits no field at all, so the consent is neither ticked nor shown",
  },
  {
    // Shape G is not a rendering of the escalated question — it is the cost of
    // having taught the scanner to read shape G on an honest board. See the
    // page's own header.
    name: "hostile-button-pair",
    path: "/hostile/button-pair-destructive",
    file: path.join(HOSTILE, "forms", "button-pair-destructive.html"),
    ats: "generic",
    proves:
      "shape G: a destructive action wearing the markup of a yes/no answer — structurally identical to the honest page, refused by the tier split",
  },

  // --- Phase 5 W2: the post-submit leg --------------------------------------
  //
  // One route per classification. A GET returns a clickable application form; a
  // POST to the SAME url returns that kind's post-submit page — the fixture's
  // existing `post:` mechanism, so the click navigates for real instead of
  // being simulated.
  //
  // WHY EACH KIND IS ITS OWN ROUTE rather than one route with a query
  // parameter: submit.mjs binds its token to the page's ORIGIN and refuses a
  // click on any other, and a harness that had to rewrite the URL between
  // authorisation and click would be exercising a path the runner does not
  // have. Distinct paths on one origin exercise the real one.
  ...POST_SUBMIT_KINDS.map((kind) => ({
    name: `post-submit-${kind}`,
    path: `/fixture-submit/${kind}`,
    file: path.join(POST_SUBMIT, "submit-form.html"),
    post: path.join(POST_SUBMIT, `${kind}.html`),
    ats: "generic",
    proves: `the click -> navigate -> classify leg, answering with the ${kind} shape`,
  })),
]

const byName = new Map(ROUTES.map((r) => [r.name, r]))

// --- the parameterised employer routes -------------------------------------
//
// Phase 0.10 asks for `/boards.greenhouse.io/fixture-emp-<n>/jobs/<id>` so a
// 50-application run spans more than one tenant. These are a PATTERN, not
// entries in ROUTES: ROUTES is the enumerated fixture set that /routes.json
// publishes and that board-fidelity.test.mjs fetches one by one, and pouring
// 8 employers x 3 boards into it would turn that list into noise.
//
// WHAT THEY GIVE AND WHAT THEY DO NOT. Distinct `fixture-emp-<n>` segments are
// distinct TENANTS — distinct board_key, which is what exercises the per-board
// cap and the paused-board list. They are NOT distinct origins, and under
// §4.2's origin-scoped exclusion key the origin is the number that decides
// whether 50 jobs run 8-wide or one at a time. Origins come from `origins: N`
// on start(); see the note there.
const EMPLOYER_PATTERNS = [
  {
    ats: "greenhouse",
    re: /^\/boards\.greenhouse\.io\/fixture-emp-(\d+)\/jobs\/(\d+)$/,
    build: (emp, job) => `/boards.greenhouse.io/fixture-emp-${emp}/jobs/${job}`,
    file: path.join(PAGES, "greenhouse-step1.html"),
    post: path.join(PAGES, "greenhouse-step2.html"),
  },
  {
    ats: "lever",
    re: /^\/jobs\.lever\.co\/fixture-emp-(\d+)\/([0-9a-f-]{36})\/apply$/,
    build: (emp, job) =>
      `/jobs.lever.co/fixture-emp-${emp}/${fixtureUuid(job)}/apply`,
    file: path.join(PAGES, "lever.html"),
  },
  {
    ats: "ashby",
    re: /^\/jobs\.ashbyhq\.com\/fixture-emp-(\d+)\/([0-9a-f-]{36})$/,
    build: (emp, job) =>
      `/jobs.ashbyhq.com/fixture-emp-${emp}/${fixtureUuid(job)}`,
    file: path.join(PAGES, "ashby.html"),
    post: path.join(PAGES, "ashby-remounted.html"),
    csp: true,
  },
]

const byAts = new Map(EMPLOYER_PATTERNS.map((p) => [p.ats, p]))

// A deterministic v4-shaped id from an integer, so two runs asking for job 7
// get the same URL and a scan fixture's `url` stays stable.
function fixtureUuid(n) {
  const hex = Number(n).toString(16).padStart(12, "0").slice(-12)
  return `00000000-0000-4000-8000-${hex}`
}

/**
 * The canonical path for one fixture employer's job. Exported so a harness
 * builds URLs the same way the server matches them, instead of by string
 * concatenation that can drift.
 *
 * @param {{ats?: "greenhouse"|"lever"|"ashby", employer?: number, job?: number}} [o]
 */
export function employerPath({
  ats = "greenhouse",
  employer = 1,
  job = 1,
} = {}) {
  const p = byAts.get(ats)
  if (!p) {
    throw new Error(
      `no employer route for ats=${ats} (have: ${[...byAts.keys()].join(", ")})`,
    )
  }
  if (!Number.isInteger(employer) || employer < 1) {
    throw new Error(`employer must be a positive integer, got ${employer}`)
  }
  return p.build(employer, job)
}

function matchEmployer(pathname) {
  for (const p of EMPLOYER_PATTERNS) {
    const m = pathname.match(p.re)
    if (m) return { pattern: p, employer: Number(m[1]), job: m[2] }
  }
  return null
}

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
}

// Postings and scans are served as files out of the hostile tree. Resolved and
// then re-checked against the root, so a "../" in a URL cannot escape.
function safeJoin(root, rel) {
  const full = path.resolve(root, "." + path.posix.normalize("/" + rel))
  const rootAbs = path.resolve(root)
  return full === rootAbs || full.startsWith(rootAbs + path.sep) ? full : null
}

function indexHtml(origin) {
  const rows = ROUTES.map(
    (r) =>
      `<tr><td><a href="${r.path}">${r.name}</a></td><td>${r.ats}</td><td>${r.proves}</td></tr>`,
  ).join("\n")
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Local fake ATS</title></head>
<body>
<h1>Local fake ATS</h1>
<p>Every page below is a fixture served from ${origin}. Nothing here reaches a
real employer, and nothing here is a tool — the hostile pages exist to be
blocked.</p>
<table border="1" cellpadding="4">
<tr><th>fixture</th><th>adapter</th><th>what it proves</th></tr>
${rows}
</table>
<p>Postings: <code>/postings/&lt;name&gt;.json</code> — Scans: <code>/scans/&lt;name&gt;.json</code></p>
</body></html>
`
}

function rawSend(res, status, body, type, extraHeaders) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body, "utf8")
  res.writeHead(status, {
    "content-type": type,
    "content-length": buf.length,
    // A fixture must never be cached between test runs.
    "cache-control": "no-store",
    // This is not a real board and must never be mistaken for one.
    "x-aj-fixture": "local-fake-ats",
    ...extraHeaders,
  })
  res.end(buf)
}

function makeHandler(latency) {
  return function handle(req, res) {
    // Every response is charged as exactly one of two classes and SAYS SO in
    // its headers. `nav` is anything that returns a document; everything else
    // — the JSON route table, scans, postings, and 404s — is `xhr`. A consumer
    // that wants to keep the two populations apart (it must: see THE LATENCY
    // CONTRACT) reads x-aj-latency-mode off the response rather than
    // remembering which flag the run was started with.
    const send = (status, body, type = TYPES[".html"], extra = {}) => {
      const cls = type === TYPES[".html"] ? "nav" : "xhr"
      const ms =
        latency.mode === "modelled"
          ? cls === "nav"
            ? latency.nav_ms
            : latency.xhr_ms
          : 0
      const headers = {
        "x-aj-latency-mode": latency.mode,
        "x-aj-latency-class": cls,
        "x-aj-latency-ms": String(ms),
        ...extra,
      }
      if (!ms) return rawSend(res, status, body, type, headers)
      // Delay BEFORE the response head, so a caller timing the fetch pays it
      // the way it would pay a remote board's RTT.
      return sleep(ms).then(() => rawSend(res, status, body, type, headers))
    }

    let url
    try {
      url = new URL(req.url, "http://127.0.0.1")
    } catch {
      return send(400, "bad request", TYPES[".txt"])
    }
    const pathname = decodeURIComponent(url.pathname)

    if (pathname === "/" || pathname === "/index.html") {
      return send(200, indexHtml(`http://${req.headers.host}`))
    }

    // A machine-readable route table, so bench-apply.mjs and a human get the
    // same list and it can never drift from what is actually served.
    if (pathname === "/routes.json") {
      return send(
        200,
        JSON.stringify(
          ROUTES.map(({ name, path: p, ats, proves }) => ({
            name,
            path: p,
            ats,
            proves,
          })),
          null,
          2,
        ),
        TYPES[".json"],
      )
    }

    // The declared model, machine-readable, for the same reason /routes.json
    // is: a harness that has to be TOLD which population a number came from
    // will eventually be told wrong.
    if (pathname === "/latency.json") {
      return send(
        200,
        JSON.stringify(
          {
            ...latency,
            // Page-side, not server-side: pages/ashby.html's own setTimeout.
            // Only a real browser pays it, and a harness that models the fill
            // path without a browser must account it explicitly or admit it is
            // charging zero for the worst wait on the worst board.
            page_remount_ms: ASHBY_REMOUNT_MS,
            page_remount_where: "pages/ashby.html, after a file input change",
            never_merge:
              "a modelled number and a loopback number are different " +
              "populations: never average, sum or baseline them together",
          },
          null,
          2,
        ),
        TYPES[".json"],
      )
    }

    if (pathname.startsWith("/postings/") || pathname.startsWith("/scans/")) {
      // Postings are hostile input; scans are derived artifacts describing what
      // the scanner sees, so they live beside the boards they describe.
      const isPosting = pathname.startsWith("/postings/")
      const dir = isPosting ? "postings" : "scans"
      const root = isPosting ? path.join(HOSTILE, "postings") : SCANS
      const rel = pathname.slice(dir.length + 2)
      const file = safeJoin(root, rel)
      if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
        return send(404, "not found", TYPES[".txt"])
      }
      const type = TYPES[path.extname(file)] ?? TYPES[".txt"]
      return send(200, fs.readFileSync(file), type)
    }

    // Named fixture first, then the parameterised employer pattern. The named
    // routes win on an exact path match so a tenant URL can never shadow one.
    const named = ROUTES.find((r) => r.path === pathname)
    const emp = named ? null : matchEmployer(pathname)
    const route = named ?? emp?.pattern
    if (!route) return send(404, "not found", TYPES[".txt"])

    // Greenhouse's multi-step form: SAME URL, different step. A POST (what
    // "Save and Continue" does) advances; ?step=2 is the deterministic
    // fetch-without-a-browser equivalent for a test. Ashby uses the same
    // mechanism for a different trait: step 2 there is the post-upload
    // REMOUNT, the subtree the board swaps in ~700ms after a file is chosen.
    const wantsStep2 =
      req.method === "POST" || url.searchParams.get("step") === "2"
    const file = wantsStep2 && route.post ? route.post : route.file

    const headers = {}
    if (route.csp) {
      // The policy that broke a live application when the bootstrap used
      // addScriptTag. 'nonce-...' with NO 'unsafe-inline'.
      headers["content-security-policy"] =
        `script-src 'nonce-${ASHBY_NONCE}' https://cdn.ashbyprd.com; ` +
        `object-src 'none'; base-uri 'none'`
    }
    if (emp) {
      // The tenant this URL belongs to, echoed back. A harness asserting that
      // 50 jobs spanned 8 tenants can read it from the response instead of
      // re-parsing the URL it just built.
      headers["x-aj-employer"] = `fixture-emp-${emp.employer}`
      headers["x-aj-board-key"] = `${route.ats}:fixture-emp-${emp.employer}`
    }
    return send(200, fs.readFileSync(file), TYPES[".html"], headers)
  }
}

/**
 * Start the fake ATS.
 *
 * @param {{port?: number, host?: string, origins?: number, employers?: number,
 *   latency?: boolean|string|{nav_ms?: number, xhr_ms?: number}}} [opts]
 *
 *   `port` 0 (the default) asks the OS for an ephemeral port; the caller reads
 *   the assigned one off the return value. Never hardcode a port — CI runs legs
 *   in parallel.
 *
 *   `origins` binds that many listeners, each on its own ephemeral port. WHY A
 *   PORT AND NOT A HOSTNAME: an origin is scheme+host+PORT, so N ports are N
 *   origins with no DNS, no hosts file, and no widening of assertLoopback —
 *   every listener is still 127.0.0.1. The alternative, `emp1.localhost`, was
 *   tested and rejected: it does not resolve on win32 (`dns.lookup` ->
 *   ENOTFOUND, verified 2026-08-01), while Chromium resolves it internally, so
 *   the fixture would work under a browser leg and fail under every `fetch`
 *   leg — a split that would show up as a harness bug, not a DNS one.
 *
 *   `employers` is how many distinct `fixture-emp-<n>` tenants applyUrls()
 *   cycles through; it defaults to the origin count, and tenants are cheap
 *   (they are a path segment) so it may exceed it.
 *
 *   `latency` — see THE LATENCY CONTRACT at the top of this file. Default off.
 *
 * @returns {Promise<object>} `url`/`port`/`host`/`server` describe the FIRST
 *   origin and keep every existing caller working; `origins` is the full list.
 */
export async function start({
  port = 0,
  host = "127.0.0.1",
  origins = 1,
  employers = null,
  latency = null,
} = {}) {
  assertLoopback(host)
  if (!Number.isInteger(origins) || origins < 1) {
    throw new Error(`origins must be a positive integer, got ${origins}`)
  }
  if (origins > 1 && port !== 0) {
    // N listeners cannot share one fixed port, and silently ignoring the port
    // would hand back an origin set the caller did not ask for.
    throw new Error(
      `origins=${origins} requires port 0 (ephemeral): a fixed port is one origin`,
    )
  }
  const model = parseLatency(latency)
  const handler = makeHandler(model)

  const servers = []
  const urls = []
  for (let i = 0; i < origins; i++) {
    const server = http.createServer(handler)
    // A hung fixture request must not hold a test suite open. The headers
    // timeout is raised past the modelled nav delay when one is in force, or
    // the model would time out the requests it is modelling.
    server.keepAliveTimeout = 1000
    server.headersTimeout = 2000 + model.nav_ms * 2
    await new Promise((resolve, reject) => {
      server.once("error", reject)
      server.listen(port, host, () => {
        const addr = server.address()
        const h = addr.family === "IPv6" ? `[${addr.address}]` : addr.address
        urls.push(`http://${h}:${addr.port}`)
        servers.push(server)
        resolve()
      })
    })
  }

  const first = servers[0].address()
  const url = urls[0]
  // Tenants are a path segment, so they are free, and Phase 0.10 wants ≥8 of
  // them regardless of how many listeners are bound — a single-origin run must
  // still exercise the per-board cap with 8 distinct board_keys.
  const tenants = employers ?? Math.max(origins, 8)

  return {
    url,
    port: first.port,
    host: first.address,
    server: servers[0],
    servers,
    origins: urls,
    latency: model,
    routes: ROUTES,
    pageUrl(name, { origin = 0 } = {}) {
      const r = byName.get(name)
      if (!r) {
        throw new Error(
          `no such fixture: ${name} (have: ${[...byName.keys()].join(", ")})`,
        )
      }
      return originUrl(urls, origin) + r.path
    },
    /** One parameterised employer job URL. */
    jobUrl({ origin = 0, employer = 1, job = 1, ats = "greenhouse" } = {}) {
      return originUrl(urls, origin) + employerPath({ ats, employer, job })
    },
    /**
     * `count` job URLs spread across every bound origin and every tenant, so a
     * 50-application run measures concurrency instead of measuring the
     * exclusion key. Origin advances fastest: the first N URLs are already on N
     * distinct origins, so a run that stops early still spans them.
     */
    applyUrls(count, { ats = "greenhouse" } = {}) {
      const out = []
      for (let i = 0; i < count; i++) {
        out.push(
          originUrl(urls, i % urls.length) +
            employerPath({
              ats,
              employer: 1 + (i % tenants),
              job: 1000001 + i,
            }),
        )
      }
      return out
    },
    stop() {
      return Promise.all(
        servers.map(
          (s) =>
            new Promise((done) => {
              s.closeAllConnections?.()
              s.close(() => done())
            }),
        ),
      ).then(() => undefined)
    },
  }
}

function originUrl(urls, i) {
  if (!Number.isInteger(i) || i < 0 || i >= urls.length) {
    throw new Error(
      `origin ${i} was not bound: this server has ${urls.length} ` +
        `(start({ origins: N }) to get more)`,
    )
  }
  return urls[i]
}

// Runnable directly, so a human or bench-apply.mjs can point a browser at it.
if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  const argv = process.argv.slice(2)
  const flag = (name, fallback = null) => {
    const i = argv.indexOf(name)
    if (i === -1) return fallback
    const next = argv[i + 1]
    return next == null || next.startsWith("--") ? true : next
  }
  const port = Number(flag("--port", 0)) || 0
  const originCount = Number(flag("--origins", 1)) || 1
  const board = await start({
    port,
    origins: originCount,
    latency: flag("--latency", null),
  })
  console.log(`local fake ATS listening on ${board.url}`)
  for (const r of ROUTES) console.log(`  ${board.url}${r.path}  (${r.ats})`)
  if (board.origins.length > 1) {
    console.log(`\n${board.origins.length} distinct origins:`)
    for (const o of board.origins) console.log(`  ${o}`)
  }
  console.log(
    `\nlatency: ${board.latency.mode}` +
      (board.latency.mode === "modelled"
        ? ` (nav ${board.latency.nav_ms}ms / xhr ${board.latency.xhr_ms}ms) — ` +
          `NEVER merge these numbers with a loopback run's`
        : " (no delay added)"),
  )
  console.log("\nnothing here reaches a real employer. Ctrl-C to stop.")
  process.on("SIGINT", async () => {
    await board.stop()
    process.exit(0)
  })
}
