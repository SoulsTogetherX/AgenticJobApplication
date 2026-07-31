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
// RUN IT BY HAND
//
//   node tests/fixtures/boards/server.mjs            # prints a URL, stays up
//   node tests/fixtures/boards/server.mjs --port 8899
//
// USE IT FROM A TEST
//
//   import { start } from "../fixtures/boards/server.mjs"
//   const board = await start()          // ephemeral port, never hardcoded
//   ...                                  // board.url, board.pageUrl("ashby")
//   await board.stop()
import http from "node:http"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PAGES = path.join(HERE, "pages")
const SCANS = path.join(HERE, "scans")
const HOSTILE = path.resolve(HERE, "..", "hostile")

// Fixed so the same URL returns the same bytes. See DETERMINISM above.
export const ASHBY_NONCE = "ajfixturenonce"

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
    ats: "ashby",
    csp: true,
    proves:
      "nonce-based CSP (why addScriptTag is banned) and an async remount 700ms after upload",
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
]

const byName = new Map(ROUTES.map((r) => [r.name, r]))

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

function send(res, status, body, type = TYPES[".html"], extraHeaders = {}) {
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

function handle(req, res) {
  let url
  try {
    url = new URL(req.url, "http://127.0.0.1")
  } catch {
    return send(res, 400, "bad request", TYPES[".txt"])
  }
  const pathname = decodeURIComponent(url.pathname)

  if (pathname === "/" || pathname === "/index.html") {
    return send(res, 200, indexHtml(`http://${req.headers.host}`))
  }

  // A machine-readable route table, so bench-apply.mjs and a human get the
  // same list and it can never drift from what is actually served.
  if (pathname === "/routes.json") {
    return send(
      res,
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

  if (pathname.startsWith("/postings/") || pathname.startsWith("/scans/")) {
    // Postings are hostile input; scans are derived artifacts describing what
    // the scanner sees, so they live beside the boards they describe.
    const isPosting = pathname.startsWith("/postings/")
    const dir = isPosting ? "postings" : "scans"
    const root = isPosting ? path.join(HOSTILE, "postings") : SCANS
    const rel = pathname.slice(dir.length + 2)
    const file = safeJoin(root, rel)
    if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      return send(res, 404, "not found", TYPES[".txt"])
    }
    const type = TYPES[path.extname(file)] ?? TYPES[".txt"]
    return send(res, 200, fs.readFileSync(file), type)
  }

  const route = ROUTES.find((r) => r.path === pathname)
  if (!route) return send(res, 404, "not found", TYPES[".txt"])

  // Greenhouse's multi-step form: SAME URL, different step. A POST (what
  // "Save and Continue" does) advances; ?step=2 is the deterministic
  // fetch-without-a-browser equivalent for a test.
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
  return send(res, 200, fs.readFileSync(file), TYPES[".html"], headers)
}

/**
 * Start the fake ATS.
 *
 * @param {{port?: number, host?: string}} [opts] port 0 (the default) asks the
 *   OS for an ephemeral port; the caller reads the assigned one off the return
 *   value. Never hardcode a port — CI runs legs in parallel.
 * @returns {Promise<{url: string, port: number, host: string, server: import("node:http").Server,
 *   routes: Route[], pageUrl: (name: string) => string, stop: () => Promise<void>}>}
 */
export function start({ port = 0, host = "127.0.0.1" } = {}) {
  assertLoopback(host)
  const server = http.createServer(handle)
  // A hung fixture request must not hold a test suite open.
  server.keepAliveTimeout = 1000
  server.headersTimeout = 2000
  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(port, host, () => {
      const addr = server.address()
      const h = addr.family === "IPv6" ? `[${addr.address}]` : addr.address
      const url = `http://${h}:${addr.port}`
      resolve({
        url,
        port: addr.port,
        host: addr.address,
        server,
        routes: ROUTES,
        pageUrl(name) {
          const r = byName.get(name)
          if (!r) {
            throw new Error(
              `no such fixture: ${name} (have: ${[...byName.keys()].join(", ")})`,
            )
          }
          return url + r.path
        },
        stop() {
          return new Promise((done) => {
            server.closeAllConnections?.()
            server.close(() => done())
          })
        },
      })
    })
  })
}

// Runnable directly, so a human or bench-apply.mjs can point a browser at it.
if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  const i = process.argv.indexOf("--port")
  const port = i !== -1 ? Number(process.argv[i + 1]) : 0
  const board = await start({ port })
  console.log(`local fake ATS listening on ${board.url}`)
  for (const r of ROUTES) console.log(`  ${board.url}${r.path}  (${r.ats})`)
  console.log("\nnothing here reaches a real employer. Ctrl-C to stop.")
  process.on("SIGINT", async () => {
    await board.stop()
    process.exit(0)
  })
}
