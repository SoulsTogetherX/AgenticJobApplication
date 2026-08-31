#!/usr/bin/env node
// Diagnostic for the CI matrix: print which browser render-pdf.mjs would find
// on this leg. It exists so that a skipped PDF test is attributable — "skipped
// because this runner has no Chrome" is a fact somebody can check, "skipped"
// on its own is indistinguishable from a test that quietly stopped running.
//
// It is NOT a gate and never fails the build: the gate is `npm test`, which
// rejects any skip that carries no reason.
//
// Written as a file rather than an inline `node -e` in the workflow because
// the Windows paths below contain backslashes and spaces, and this same step
// runs under PowerShell on the windows-latest legs.
//
// Keep the candidate list in sync with findBrowser() in
// src/documents/render-pdf.mjs (owned by w6-documents).
import fs from "node:fs"

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

const found = candidates.filter((p) => fs.existsSync(p))

console.log(`platform: ${process.platform} / node ${process.version}`)
if (found.length) {
  console.log(`PDF browser present: ${found.join(", ")}`)
  console.log("=> render-pdf and ats-lint PDF tests should RUN on this leg.")
} else {
  console.log("PDF browser present: NONE")
  console.log(
    "=> render-pdf and ats-lint PDF tests will SKIP on this leg, with a reason. " +
      "Set PDF_BROWSER, or install a browser, to close that hole.",
  )
}
