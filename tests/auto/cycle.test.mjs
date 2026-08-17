// cycle.mjs — the join between the stages, and the log a human reads about it.
//
// Two defects measured 2026-08-17 in logs/cycle.log, both about the SAME
// function: `step()` kept the last three lines of a child's stderr and read
// nothing else, so the runner's launch error surfaced as the bottom edge of
// Playwright's boxed hint and a spawn timeout surfaced as `FAILED` followed by
// nothing. These pin the reason-extraction and the log shape.
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import {
  step,
  stepDetail,
  stageRecord,
  STDERR_TAIL_LINES,
} from "../../scripts/auto/cycle.mjs"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, "..", "..")

// A stub child under ROOT, because `step()` resolves its script argument
// against ROOT — that is the property that keeps the cycle running the
// repository's own scripts and not whatever the working directory holds.
function stub(t, name, body) {
  const dir = fs.mkdtempSync(
    path.join(ROOT, "tests", "fixtures", "cycle-stub-"),
  )
  const file = path.join(dir, name)
  fs.writeFileSync(file, body)
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return path.relative(ROOT, file)
}

// --- stepDetail: what the summary line says --------------------------------

test("stepDetail: the FIRST stderr line is kept, not just the tail", () => {
  const stderr = [
    "auto-apply: could not start a browser — browserType.launch: Executable doesn't exist",
    "╔══════════════════════════════════════════╗",
    "║ Looks like Playwright was just installed  ║",
    "║ <3 Playwright Team                        ║",
    "╚══════════════════════════════════════════╝",
  ].join("\n")
  const d = stepDetail({ status: 1, stderr })
  assert.match(
    d,
    /^auto-apply: could not start a browser/,
    "the runner's own reason is on line one; the tail alone rendered as the " +
      "bottom of a box, which is what the log carried for four days",
  )
  assert.match(d, /<3 Playwright Team/, "the tail is still there too")
})

test("stepDetail: a timed-out child is named as such, with its signal", () => {
  const d = stepDetail(
    { status: null, signal: "SIGTERM", stderr: "" },
    { timeout: 600_000 },
  )
  assert.match(d, /timed out after 600000ms \(SIGTERM\)/)
})

test("stepDetail: a spawn error outranks stderr", () => {
  const d = stepDetail({
    status: null,
    error: new Error("spawn ENOENT"),
    stderr: "irrelevant",
  })
  assert.equal(d, "spawn ENOENT")
})

test("stepDetail: empty stderr on a clean exit is an empty detail", () => {
  assert.equal(stepDetail({ status: 0, stderr: "" }), "")
  assert.equal(stepDetail({ status: 1, stderr: "   \n\n" }), "")
})

test("stepDetail: three or fewer lines are kept whole; the cap holds", () => {
  assert.equal(stepDetail({ status: 1, stderr: "a\nb\nc" }), "a b c")
  const long = "x".repeat(1000)
  assert.equal(stepDetail({ status: 1, stderr: long }).length, 300)
})

// --- step(): the real spawn ---------------------------------------------------

test("step: a failing child's first stderr line reaches `detail`, and the tail reaches `stderr`", (t) => {
  const script = stub(
    t,
    "fail.mjs",
    `process.stderr.write("real reason: the thing that broke\\n");
     for (let i = 0; i < 60; i++) process.stderr.write("noise " + i + "\\n");
     process.exit(1);`,
  )
  const r = step(script, [])
  assert.equal(r.ok, false)
  assert.equal(r.code, 1)
  assert.match(r.detail, /^real reason: the thing that broke/)
  const lines = r.stderr.split(/\r?\n/)
  assert.equal(
    lines.length,
    STDERR_TAIL_LINES,
    "the tail is capped so a runaway child cannot flood the log",
  )
  assert.equal(lines.at(-1), "noise 59")
})

test("step: a child that exceeds the timeout is reported as timed out, not as a blank failure", (t) => {
  const script = stub(t, "hang.mjs", `setTimeout(() => {}, 30_000);`)
  const r = step(script, [], { timeout: 500 })
  assert.equal(r.ok, false)
  assert.equal(r.code, null)
  assert.match(r.detail, /timed out after 500ms/)
})

test("step: a clean child carries no stderr tail, and its warnings still make the summary", (t) => {
  const script = stub(
    t,
    "warn.mjs",
    `process.stderr.write("warn: source failed: x — HTTP 429\\n"); process.stdout.write("ok\\n");`,
  )
  const r = step(script, [])
  assert.equal(r.ok, true)
  assert.match(r.detail, /warn: source failed/)
  assert.equal(r.stderr, "", "success keeps the log short")
  assert.equal(r.stdout, "ok\n")
})

// --- stageRecord: what the cycle keeps ---------------------------------------

test("stageRecord carries ok, detail and the stderr tail", () => {
  assert.deepEqual(stageRecord({ ok: false, detail: "d", stderr: "s" }), {
    ok: false,
    detail: "d",
    stderr: "s",
  })
  assert.deepEqual(stageRecord({ ok: true, detail: "" }), {
    ok: true,
    detail: "",
    stderr: "",
  })
})
