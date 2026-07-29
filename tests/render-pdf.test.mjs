import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const FIX = path.join(ROOT, "tests", "fixtures")

function run(argsArr) {
  return spawnSync(
    process.execPath,
    [path.join(ROOT, "scripts", "render-pdf.mjs"), ...argsArr],
    { cwd: ROOT, encoding: "utf8", timeout: 90_000 },
  )
}

test("render-pdf produces a real PDF and strips fact annotations", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "render-"))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const out = path.join(dir, "resume.pdf")

  const res = run([path.join(FIX, "good-resume.md"), out])
  if (res.status === 3) {
    t.skip(
      "No Edge/Chrome available on this machine — set PDF_BROWSER to enable this test",
    )
    return
  }
  assert.equal(res.status, 0, res.stderr)

  const buf = fs.readFileSync(out)
  assert.equal(buf.subarray(0, 5).toString("latin1").startsWith("%PDF"), true)
  assert.ok(buf.length > 1000, "PDF suspiciously small")

  // fact annotations must not leak into the rendered HTML
  const html = fs.readFileSync(path.join(dir, "resume.render.html"), "utf8")
  assert.ok(
    !html.includes("fact:"),
    "fact annotations leaked into rendered output",
  )
})

test("render-pdf usage errors exit 2", () => {
  assert.equal(run([]).status, 2)
  assert.equal(run([path.join(FIX, "nope.md"), "out.pdf"]).status, 2)
})

// An ATS reads the PDF text layer. Chrome does not emit CSS ::marker bullets
// into it, and link hrefs live only in annotations — so both must be injected
// as real text. Measured before the fix: 0 bullet chars, 0 URLs extractable.
test("render-pdf injects bullets as real text, not CSS markers", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "render-bullet-"))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const out = path.join(dir, "resume.pdf")

  const res = run([path.join(FIX, "good-resume.md"), out])
  if (res.status === 3) {
    t.skip("No Edge/Chrome available on this machine")
    return
  }
  assert.equal(res.status, 0, res.stderr)

  const html = fs.readFileSync(path.join(dir, "resume.render.html"), "utf8")
  assert.ok(
    html.includes('<li><span class="bullet">• </span>'),
    "list items must carry a literal bullet character",
  )
  // Every <li> gets one — no bare <li> left behind.
  assert.equal(
    (html.match(/<li>/g) ?? []).length,
    (html.match(/<li><span class="bullet">/g) ?? []).length,
    "every list item must be bulleted",
  )
})

test("render-pdf exposes link URLs as visible text, idempotently", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "render-link-"))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const out = path.join(dir, "links.pdf")

  const res = run([path.join(FIX, "ats-links.md"), out])
  if (res.status === 3) {
    t.skip("No Edge/Chrome available on this machine")
    return
  }
  assert.equal(res.status, 0, res.stderr)

  const html = fs.readFileSync(path.join(dir, "links.render.html"), "utf8")
  // Label-style links are replaced by the bare address, www. stripped.
  assert.ok(
    html.includes(">linkedin.com/in/jane-test<"),
    "LinkedIn label should render as its bare URL",
  )
  assert.ok(
    html.includes(">github.com/janetest<"),
    "GitHub label should render as its bare URL",
  )
  // The href itself must survive so the PDF stays clickable.
  assert.ok(html.includes('href="https://github.com/janetest"'))
  // A link whose text is already the address is left alone (no doubling).
  assert.ok(
    !html.includes("linkedin.com/in/linkedin.com"),
    "already-bare URLs must not be rewritten twice",
  )
})
