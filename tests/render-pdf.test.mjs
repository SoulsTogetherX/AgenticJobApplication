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
