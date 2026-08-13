#!/usr/bin/env node
// Render a tailored markdown document to PDF via local Edge/Chrome headless.
// Deterministic, no LLM, no network. Fact annotations are stripped first.
//
// Usage: node scripts/documents/render-pdf.mjs <input.md> <output.pdf> [--letter] [--css templates/document.css]
// Env:   PDF_BROWSER=<path to msedge.exe/chrome.exe> overrides browser discovery.
import fs from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { marked } from "marked"

const args = process.argv.slice(2)
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

function tryRender(headlessFlag) {
  return spawnSync(
    browser,
    [
      headlessFlag,
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--no-pdf-header-footer",
      `--print-to-pdf=${outAbs}`,
      htmlUrl,
    ],
    { timeout: 60_000 },
  )
}

let res = tryRender("--headless=new")
if (!fs.existsSync(outAbs)) res = tryRender("--headless")

if (!fs.existsSync(outAbs)) {
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
