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
  prepareDocuments,
  runCycle,
  CYCLE_FLAGS,
  CYCLE_VALUE_FLAGS,
  STDERR_TAIL_LINES,
} from "../../scripts/auto/cycle.mjs"
import { assertKnownFlags } from "../../scripts/lib/args.mjs"
import { EXIT_NO_FIT } from "../../scripts/documents/assemble-resume.mjs"

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

// --- prepareDocuments: a refusal is a skip, a failure is a failure -----------
//
// The assembler exits EXIT_NO_FIT when the profile has several summary
// variants and none covers a term the posting asks for. That is the assembler
// working, not breaking, and the cycle must say so — a digest that lumps
// "your profile has no track for this job" in with "verify-claims crashed"
// hides a screening signal inside a bug count. `run` is injected so these
// drive the sequence without spawning anything.

function workspaceWithJob(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aj-cycle-prep-"))
  fs.mkdirSync(path.join(dir, "acme-dev"))
  fs.writeFileSync(
    path.join(dir, "acme-dev", "job.json"),
    JSON.stringify({ slug: "acme-dev", company: "Acme", title: "Dev" }),
  )
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

const ok = () => ({ ok: true, code: 0, detail: "", stderr: "" })

test("prepareDocuments records a no-summary-fit refusal as SKIPPED and stops", (t) => {
  const jobsDir = workspaceWithJob(t)
  const calls = []
  const run = (script) => {
    calls.push(script)
    if (script.includes("assemble-resume"))
      return {
        ok: false,
        code: EXIT_NO_FIT,
        detail:
          "refused: no-summary-fit — no summary variant covers a term the posting asked for",
        stderr: "",
      }
    return ok()
  }
  const out = prepareDocuments("acme-dev", {}, { jobsDir, run })

  assert.equal(out.ok, false)
  assert.equal(out.skipped, "no-summary-fit")
  assert.deepEqual(
    out.stages.map((s) => s.stage),
    ["keyword-plan", "assemble-resume"],
    "it stops at the refusal",
  )
  assert.equal(out.stages.at(-1).skipped, "no-summary-fit")
  assert.ok(
    !calls.some((s) => s.includes("verify-claims")),
    "no pass row may be written for a document that was never assembled",
  )
  assert.ok(!calls.some((s) => s.includes("render-pdf")))
})

test("prepareDocuments treats any OTHER assembler exit as a plain failure", (t) => {
  const jobsDir = workspaceWithJob(t)
  const run = (script) =>
    script.includes("assemble-resume")
      ? { ok: false, code: 2, detail: "usage: something wrong", stderr: "" }
      : ok()
  const out = prepareDocuments("acme-dev", {}, { jobsDir, run })
  assert.equal(out.ok, false)
  assert.equal(out.skipped, undefined, "exit 2 is not a fit refusal")
  assert.equal(out.stages.at(-1).stage, "assemble-resume")
  assert.equal(out.stages.at(-1).skipped, undefined)
})

test("prepareDocuments runs the stages in order and passes each the right arguments", (t) => {
  const jobsDir = workspaceWithJob(t)
  const calls = []
  const run = (script, args) => {
    calls.push({ script, args })
    return ok()
  }
  const out = prepareDocuments("acme-dev", {}, { jobsDir, run })
  assert.equal(out.ok, true)
  assert.deepEqual(
    calls.map((c) => c.script),
    [
      "scripts/documents/keyword-plan.mjs",
      "scripts/documents/assemble-resume.mjs",
      "scripts/documents/verify-claims.mjs",
      "scripts/documents/render-pdf.mjs",
    ],
    "job.json exists so new-job is skipped; no cover-letter.md so no cover render",
  )
  assert.deepEqual(calls[1].args, ["acme-dev"])
  assert.equal(calls[2].args[0], "resume")
  // path.join, so the separator is the platform's; compare the tail as parts.
  const tail = (p) => p.split(/[\\/]/).slice(-2).join("/")
  assert.equal(tail(calls[2].args[1]), "acme-dev/resume.md")
  assert.equal(tail(calls[3].args[1]), "acme-dev/resume.pdf")
})

// --- the applier gate is spelled, not guessed -------------------------------
//
// MEASURED 2026-08-24. `cycle.mjs` gated the runner on
// `!argv.includes("--skip-apply")`, so the gate FAILED OPEN: any misspelling of
// the flag meant the cycle submitted applications instead of preparing them.
// The user's registered 7:00 Windows task passes `--skip-apply` to prepare
// only, and one mistyped character in that registration would have sent real
// applications with nothing in the log saying so. These pin the refusal and
// the log line that makes the mode readable after the fact.

test("a misspelled --skip-apply is REFUSED — the applier gate fails open otherwise", async () => {
  await assert.rejects(
    () => runCycle(["--skip-aply"]),
    (e) => {
      assert.equal(e.isUsage, true, "must be a usage error, not a crash")
      assert.equal(e.exitCode, 2)
      assert.match(e.message, /Did you mean --skip-apply\?/)
      // The consequence has to be in the message: "unknown flag" on its own
      // reads as pedantry and gets worked around rather than fixed.
      assert.match(e.message, /submits applications/)
      return true
    },
  )
})

test("every flag the cycle actually reads is in CYCLE_FLAGS", () => {
  // The list and the reads must not drift apart: a flag added to runCycle but
  // not to the list would be refused, and one removed from runCycle but left in
  // the list would be silently ignored again.
  const src = fs.readFileSync(
    path.join(ROOT, "scripts", "auto", "cycle.mjs"),
    "utf8",
  )
  const read = new Set()
  for (const m of src.matchAll(/(?:argv|args)\.includes\("(--[a-z-]+)"\)/g))
    read.add(m[1])
  for (const m of src.matchAll(/flag\(argv,\s*"(--[a-z-]+)"/g)) read.add(m[1])
  for (const f of read)
    assert.ok(
      CYCLE_FLAGS.includes(f),
      `${f} is read by cycle.mjs but missing from CYCLE_FLAGS`,
    )
})

test("a correctly spelled prepare-only invocation is not refused", () => {
  // The guard must not be so eager that the real command stops working. This
  // asserts the parse only — running the cycle would spawn every stage.
  assert.doesNotThrow(() =>
    assertKnownFlags(["--skip-apply", "--top", "10", "--json"], {
      known: CYCLE_FLAGS,
      valueFlags: CYCLE_VALUE_FLAGS,
      script: "cycle.mjs",
    }),
  )
})
