#!/usr/bin/env node
// Render a tailored markdown document to PDF via local Edge/Chrome headless.
// Deterministic, no LLM, no network. Fact annotations are stripped first.
//
// Usage: node src/documents/render-pdf.mjs <input.md> <output.pdf> [--letter] [--css templates/document.css]
// Env:   PDF_BROWSER=<path to msedge.exe/chrome.exe> overrides browser discovery.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { marked } from "marked"
import { assertKnownFlags } from "#lib/args.mjs"

const args = process.argv.slice(2)
// STRICT. this command renders a PDF and spawns a browser, so an unrecognised flag must not
// be ignored. See src/lib/args.mjs.
try {
  assertKnownFlags(args, {
    known: ["--css", "--letter", "--help"],
    valueFlags: ["--css"],
    script: "render-pdf.mjs",
    note: "this command renders a PDF and spawns a browser",
  })
} catch (e) {
  console.error(e.message)
  process.exit(e.exitCode ?? 2)
}
function flagBool(name) {
  const i = args.indexOf(name)
  if (i !== -1) {
    args.splice(i, 1)
    return true
  }
  return false
}
function flag(name, dflt) {
  const i = args.indexOf(name)
  if (i !== -1) {
    const v = args[i + 1]
    args.splice(i, 2)
    return v
  }
  return dflt
}
const isLetter = flagBool("--letter")
const cssPath = flag("--css", "templates/document.css")
const [input, output] = args

if (!input || !output) {
  console.error(
    "Usage: render-pdf.mjs <input.md> <output.pdf> [--letter] [--css file.css]",
  )
  process.exit(2)
}
if (!fs.existsSync(input)) {
  console.error(`No such file: ${input}`)
  process.exit(2)
}

export function findBrowser() {
  const candidates = [
    process.env.PDF_BROWSER,
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/microsoft-edge",
  ].filter(Boolean)
  return candidates.find((p) => fs.existsSync(p)) ?? null
}

const browser = findBrowser()
if (!browser) {
  console.error(
    "No Edge/Chrome found. Set PDF_BROWSER to a browser executable path.",
  )
  process.exit(3)
}

// An ATS reads the PDF text layer, not the rendered page. Two things never
// reach that layer on their own:
//   - CSS ::marker bullets. Chrome draws them without emitting any text, so a
//     role's title, dates and every bullet extract as ONE merged line.
//   - Link hrefs. They live only in PDF link annotations, so a resume showing
//     "LinkedIn | GitHub" hands the parser no URL at all.
// Both are fixed here by putting real text into the document.
export function atsPostProcess(html) {
  return html
    .replace(/<li>/g, '<li><span class="bullet">• </span>')
    .replace(
      /<a href="(https?:\/\/[^"]+)"([^>]*)>([^<]*)<\/a>/g,
      (whole, href, attrs, text) => {
        const bare = href
          .replace(/^https?:\/\//, "")
          .replace(/^www\./, "")
          .replace(/\/$/, "")
        // Idempotent: leave links whose text already shows the address.
        if (text.toLowerCase().includes(bare.slice(0, 12).toLowerCase()))
          return whole
        return `<a href="${href}"${attrs}>${bare}</a>`
      },
    )
}

const raw = fs.readFileSync(input, "utf8")
const stripped = raw.replace(/<!--\s*fact:[^>]*-->/g, "")
const body = atsPostProcess(marked.parse(stripped))
const css = fs.existsSync(cssPath) ? fs.readFileSync(cssPath, "utf8") : ""

const html = `<!doctype html>
<html><head><meta charset="utf-8"><style>${css}</style></head>
<body class="${isLetter ? "letter" : "resume"}">${body}</body></html>`

const htmlPath = path.join(
  path.dirname(output),
  path.basename(output, ".pdf") + ".render.html",
)
fs.writeFileSync(htmlPath, html, "utf8")

const outAbs = path.resolve(output)
const htmlUrl = "file:///" + path.resolve(htmlPath).replace(/\\/g, "/")

// Edge's Program Files launcher DETACHES: spawnSync returns exit 0 while the
// real render child is still writing the PDF. Measured 2026-08-13 on Edge 151
// with the user's browser open: every probe "failed" an immediate existsSync,
// and every probe's PDF then appeared 1-6s after the launcher exited. A bare
// existence check straight after the spawn therefore loses exactly when the
// user has Edge open — which is when supervised runs happen. Wait for the
// file to exist AND hold a stable non-zero size instead.
const sleepMs = (ms) =>
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
function settled(file, deadlineMs) {
  const deadline = Date.now() + deadlineMs
  let lastSize = -1
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) {
      const size = fs.statSync(file).size
      if (size > 0 && size === lastSize) return true
      lastSize = size
    }
    sleepMs(150)
  }
  return fs.existsSync(file) && fs.statSync(file).size > 0
}

// A leftover PDF from a previous render would satisfy the settle check before
// the browser wrote a byte, turning a failed re-render into a silent pass —
// the old immediate existsSync had the same hole. Clear it first; a locked
// file means the browser could not have replaced it either, so refuse.
try {
  fs.rmSync(outAbs, { force: true })
} catch (e) {
  console.error(
    `Output is locked (close it and retry): ${outAbs} — ${e.message}`,
  )
  process.exit(1)
}

// A dedicated throwaway profile keeps the render out of the user's live Edge
// session: without one, the launcher delegates the print job INTO the running
// browser (same user-data-dir), contending with their real browsing.
const pdfProfile = path.join(os.tmpdir(), "aj-pdf-profile")

function tryRender(headlessFlag) {
  return spawnSync(
    browser,
    [
      headlessFlag,
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--no-pdf-header-footer",
      `--user-data-dir=${pdfProfile}`,
      `--print-to-pdf=${outAbs}`,
      htmlUrl,
    ],
    { timeout: 60_000 },
  )
}

let res = tryRender("--headless=new")
if (!settled(outAbs, 20_000)) res = tryRender("--headless")

if (!settled(outAbs, 20_000)) {
  console.error(
    `PDF was not produced (browser exit ${res.status}). stderr:\n${res.stderr?.toString().slice(0, 500)}`,
  )
  process.exit(1)
}
const head = fs.readFileSync(outAbs).subarray(0, 5).toString("latin1")
if (!head.startsWith("%PDF")) {
  console.error("Output exists but is not a valid PDF.")
  process.exit(1)
}
console.log(
  `Rendered ${outAbs} (${fs.statSync(outAbs).size} bytes). Intermediate HTML kept at ${htmlPath}`,
)
