// Adversarial tests for the --browser-fill leg, written while capturing
// baseline B1. They cover what the leg's own tests do not, and each one exists
// because a probe against the running artifact found the gap — not because the
// source looked wrong.
//
// The rule throughout: OBSERVE THE ARTIFACT, NEVER THE CLAIM. `report.ok` is
// the thing under test, `upload_integrity.ok` is the thing under test, and the
// evidence is what `document.querySelectorAll("input[type=file]")` says.
//
// What is deliberately NOT asserted here, so nobody mistakes silence for
// coverage:
//
//   - that the post-upload wait ever EXITS EARLY. It never does, on any
//     fixture board (see the third test). Its 1000ms ceiling is paid in full
//     every time, so B1's `post_upload_remount_ms` is a ceiling measurement,
//     not a settle measurement.
//   - that `upload_integrity.ok === true` means the right file reached the
//     right field. It does not — it is a count comparison, and a straight swap
//     of two files satisfies it. The first test is the check that formula
//     cannot make.
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  benchBrowserFill,
  collectIncomplete,
  fillCompleteness,
} from "../../scripts/dev/bench-apply.mjs"
import { start } from "../fixtures/boards/server.mjs"

const ROOT = path.resolve(import.meta.dirname, "..", "..")
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), "b1-" + p + "-"))

// ---------------------------------------------------------------------------
// 1. WHICH file landed on WHICH input, read out of the DOM.
//
// bench-apply's own integrity check is
//   ok = inputs_with_files === planned && files_attached === planned
// which counts. A cover letter attached as the resume — the defect this whole
// read-back mechanism was built for — passes it: two files, two inputs, both
// counts right, both documents on the wrong field. Demonstrated against the
// real harness with a fill engine that attaches crosswise; it reported
// `upload_integrity.ok: true`, `measurable: true`, exit 0.
//
// So this asserts the pairing, which is the property that actually protects
// the user, and it asserts it off the live DOM rather than off the plan.
// ---------------------------------------------------------------------------
test("B1: the resume input holds the resume and the cover input holds the cover", async (t) => {
  const board = await start()
  const dir = tmp("pair")
  try {
    const run = await benchBrowserFill({
      board,
      boardName: "greenhouse",
      jobsDir: dir,
    })
    if (!run.ran) return t.skip("no usable Chromium: " + run.error)
    assert.equal(run.error, undefined, "the leg must run end to end")

    // The bench writes exactly these two basenames; a swap is therefore
    // visible by name alone.
    const byId = new Map(run.upload_integrity.per_input.map((i) => [i.id, i]))
    const resume = byId.get("resume")
    const cover = byId.get("cover_letter")
    assert.ok(resume, "the greenhouse fixture must expose a #resume input")
    assert.ok(cover, "the greenhouse fixture must expose a #cover_letter input")

    assert.deepEqual(
      resume.names,
      ["resume.pdf"],
      "the resume field is holding " +
        JSON.stringify(resume.names) +
        " — a document is going out under the wrong heading",
    )
    assert.deepEqual(
      cover.names,
      ["cover-letter.pdf"],
      "the cover-letter field is holding " + JSON.stringify(cover.names),
    )

    // And the same assertion the counting formula makes, kept so a regression
    // that breaks BOTH is attributed to the right one.
    assert.equal(run.upload_integrity.files_attached, 2)
  } finally {
    await board.stop()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 2. M6 on the browser-fill path specifically.
//
// M6 is enforced by collectIncomplete, and its existing tests drive the
// `results` (accounted matrix) branch. The browser-fill leg reaches the same
// gate down a DIFFERENT branch — one guarded by `browserFill?.ran` — and B1 is
// taken through that branch, so it gets its own test.
//
// `ok:2 failed:1 deferred:3` is the shape named in the brief: a partial
// success. `failed > 0 && ok === 0` (the fix originally suggested in M6) would
// let it through; `failed === 0` is the predicate actually shipped, and it does
// not. Verified end to end as well: with fill-engine.mjs replaced in-process by
// a stub returning exactly this report, the real CLI printed MEASUREMENT
// REFUSED, named the field, emitted no ledger entry, and exited 3.
// ---------------------------------------------------------------------------
test("B1/M6: ok:2 failed:1 deferred:3 is refused on the browser-fill branch", () => {
  const partial = fillCompleteness(
    {
      ok: 2,
      failed: 1,
      deferred: 3,
      failures: [{ k: "f3", how: "fill", why: "element never became visible" }],
    },
    "browser fill (board=greenhouse)",
  )
  assert.equal(
    partial.complete,
    false,
    "a partial success is not a completed fill; two thirds of a baseline is " +
      "not a baseline",
  )
  assert.equal(partial.aborted, false, "k='-' is an abort; 'f3' is a failure")

  const caught = collectIncomplete({
    results: [],
    browserFill: { ran: true, completeness: partial },
  })
  assert.equal(caught.length, 1, "the browser-fill branch must reach the gate")
  assert.equal(caught[0].failed, 1)
  assert.ok(
    caught[0].failures.some((f) => f.k === "f3"),
    "the refusal must NAME the field; a count is not actionable",
  )

  // A leg that never ran is not an incomplete fill — it is no fill, and the
  // human/ledger output says DID NOT RUN. Asserted so a later tightening does
  // not turn "no Chromium on this machine" into a failed baseline.
  assert.deepEqual(
    collectIncomplete({
      results: [],
      browserFill: { ran: false, error: "no browser" },
    }),
    [],
  )

  // And a fill that deferred everything and failed nothing is measurable: a
  // deferral is a decision, not a breakage.
  assert.deepEqual(
    collectIncomplete({
      results: [],
      browserFill: {
        ran: true,
        completeness: fillCompleteness(
          { ok: 0, failed: 0, deferred: 4, failures: [] },
          "all-deferred",
        ),
      },
    }),
    [],
  )
})

// ---------------------------------------------------------------------------
// 3. THE COVERAGE THIS SUITE DOES NOT HAVE, asserted so it stays visible.
//
// fill-engine.mjs waits for its own `data-ajup` stamp to go `detached` after
// setInputFiles, on the reasoning that "a board that remounts in 150ms now
// costs 150ms" instead of a flat second. That early exit has NO fixture
// coverage: on all three boards the engine reports settled="timeout" and the
// wait bills its whole ceiling (greenhouse 2 x 1000ms, lever 1 x 1000ms, ashby
// 1 x 1000ms; observed by wrapping the engine and reading report.uploads).
//
// The mechanical reason is here, in the fixture: the ashby page is the only
// one that re-renders after an upload, and its re-render strips `data-aj="..."`
// while leaving `data-ajup="..."` untouched — the stamp the wait is watching
// survives, so `detached` never fires. This test pins that so the ceiling
// figure in B1 is never read as a settle time.
// ---------------------------------------------------------------------------
test("B1: no fixture board can make the post-upload detach wait exit early", () => {
  const page = fs.readFileSync(
    path.join(ROOT, "tests/fixtures/boards/pages/ashby.html"),
    "utf8",
  )
  const strip = page.match(/replace\((\/ data-aj[^,]*),/)
  assert.ok(strip, "the ashby fixture must still model a remount")
  // The regex the fixture uses to model React dropping the scanner's stamps.
  const re = new RegExp(
    strip[1].slice(1, strip[1].lastIndexOf("/")),
    strip[1].slice(strip[1].lastIndexOf("/") + 1),
  )
  assert.equal(
    ' data-ajup="u1"'.replace(re, ""),
    ' data-ajup="u1"',
    "if this ever strips data-ajup, the detach wait CAN fire and " +
      "post_upload_remount_ms stops being a pure ceiling measurement — " +
      "re-take B1 and say so in docs/measurements.md",
  )
  assert.equal(
    ' data-aj="a1"'.replace(re, ""),
    "",
    "the fixture must still drop the SCANNER's stamps; that part is real",
  )
})

// ---------------------------------------------------------------------------
// 4. Ashby: the engine reports ok, the DOM holds nothing.
//
// Observed 7/7 runs at 0b6db30: `fill: ok=4 failed=0 deferred=2` with
// `_systemfield_resume` holding zero files, because the fixture's re-render
// lands 700ms after setInputFiles — inside the engine's own 1000ms settle —
// and an innerHTML round trip cannot carry a FileList. The engine's
// report.uploads records `seen:"empty"`, and nothing in this repository reads
// that field.
//
// Written as an implication rather than as `files === 0`, so it keeps its
// meaning after the engine is fixed: whatever the DOM says, the harness must
// not price a remount it did not observe, and must not call the routing good.
// ---------------------------------------------------------------------------
test("B1: a run where no file attached must not report a remount cost", async (t) => {
  const board = await start()
  const dir = tmp("ashby")
  try {
    const run = await benchBrowserFill({
      board,
      boardName: "ashby",
      jobsDir: dir,
    })
    if (!run.ran) return t.skip("no usable Chromium: " + run.error)
    assert.equal(run.error, undefined, "the leg must run end to end")

    const f = run.legs.fill
    const ui = run.upload_integrity
    assert.ok(f.uploads_planned >= 1, "ashby's plan must carry an upload")

    if (ui.files_attached === 0) {
      assert.equal(
        f.post_upload_remount_ms,
        null,
        "a remount cost measured on an upload that did not happen is a " +
          "measurement of nothing",
      )
      assert.equal(f.post_upload_remount_method, "unmeasured")
      assert.ok(
        (f.post_upload_remount_why || "").length > 20,
        "an unmeasured column must carry its reason",
      )
      assert.equal(ui.ok, false, "zero files attached is not a good upload")
      assert.ok(
        f.ok > 0,
        "this is the point: the fill report still says ok. `ok` counts calls " +
          "that did not throw — it is not evidence a file reached a field.",
      )
    } else {
      // The engine got fixed. Then the number must be real and the routing
      // must be right, by name.
      assert.ok(f.post_upload_remount_ms > 0)
      assert.equal(ui.ok, true)
      assert.deepEqual(ui.per_input.find((i) => /resume/.test(i.id))?.names, [
        "resume.pdf",
      ])
    }
  } finally {
    await board.stop()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
