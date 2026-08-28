// Tests for the 0.12 prevalence harness (src/dev/bench-green-prevalence.mjs).
//
// WHAT THESE ARE FOR. The harness reports a number that gates the autonomy
// supply math, and its one real risk is silent drift: it BUCKETS strings that
// automatability.mjs's shapeBlockers() produced, so a rule reworded upstream
// could quietly stop being counted. These tests pin that it cannot — the
// bucketer throws on anything it does not recognise, and the self-check drives
// the REAL shapeBlockers() over synthetic shapes and asserts each known rule
// still lands in its bucket.
//
// The fixtures used here are SYNTHETIC and are never part of the reported
// prevalence figure. See the harness header.
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  bucket,
  selfCheck,
  allFieldsAsScanner,
  analyseCache,
} from "../../src/dev/bench-green-prevalence.mjs"
import { loadCache, CACHE_VERSION } from "../../src/apply/field-cache.mjs"
import { resolveFieldsFromFiles } from "../../src/apply/answer-bank.mjs"

test("every rule shapeBlockers() actually emits lands in a known bucket", () => {
  const results = selfCheck()
  assert.ok(results.length >= 5, "self-check should cover every blocker kind")
  for (const r of results) {
    assert.equal(
      r.pass,
      true,
      `${r.name}: expected bucket ${r.expect}, got [${r.got}]`,
    )
  }
})

test("bucket() throws rather than under-counting an unrecognised blocker", () => {
  // The failure mode this guards: a rule is reworded upstream, its blocker
  // stops matching any pattern, and the tally silently shrinks — a smaller
  // number that looks like progress.
  assert.throws(
    () => bucket("some blocker nobody has ever seen before"),
    /unrecognised blocker/,
  )
})

test("allFieldsAsScanner adapts the cache's MAP-shaped fields, not its rules", () => {
  const cache = {
    forms: {
      fp1: {
        ats: "greenhouse",
        url: "https://boards.greenhouse.io/x/jobs/1",
        fields: {
          "first name|text": { t: "text", l: "First Name", req: true },
          "gender|combo": { t: "combo", l: "Gender", opts: ["A", "B"] },
        },
      },
    },
  }
  const out = allFieldsAsScanner(cache)
  assert.equal(out.length, 2)
  // Key convention must match predictedFields() so both resolutions share one
  // namespace; a drift here would make every lookup miss and read as UNKNOWN.
  assert.deepEqual(out.map((f) => f.k).sort(), [
    "fp1:first name|text",
    "fp1:gender|combo",
  ])
  const gender = out.find((f) => f.k === "fp1:gender|combo")
  assert.deepEqual(gender.opts, ["A", "B"])
  assert.equal(gender.req, false)
  assert.equal(out.find((f) => f.k === "fp1:first name|text").req, true)
})

test("the harness must read the cache raw: loadCache() discards an old version", () => {
  // Why the harness JSON.parse()s jobs/.field-cache.json instead of using
  // loadCache(). The real corpus is v2 against CACHE_VERSION 4 — a REUSE
  // invalidation (0.5 added the registrable host to the fingerprint), not a
  // statement that the recorded field shapes are wrong. Written to a temp file
  // so this does not depend on the gitignored jobs/ tree.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gp-cache-"))
  const file = path.join(dir, ".field-cache.json")
  const raw = {
    v: CACHE_VERSION - 2,
    forms: {
      fp1: {
        ats: "greenhouse",
        url: "https://boards.greenhouse.io/x/jobs/1",
        updated: "2026-07-30",
        fields: {
          "first name|text": { t: "text", l: "First Name", req: true },
        },
      },
    },
  }
  fs.writeFileSync(file, JSON.stringify(raw))
  try {
    assert.equal(Object.keys(loadCache(file).forms ?? {}).length, 0)
    assert.equal(
      Object.keys(JSON.parse(fs.readFileSync(file, "utf8")).forms).length,
      1,
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("analyseCache reaches green only when no rule blocks, and names why when one does", () => {
  const now = new Date("2026-08-02T00:00:00Z")
  const cache = {
    forms: {
      clean: {
        ats: "ashby",
        url: "https://jobs.ashbyhq.com/x/y/application",
        updated: "2026-08-01",
        fields: {
          "legal name|text": { t: "text", l: "Legal Name", req: true },
          "email|email": { t: "email", l: "Email", req: true },
        },
      },
      widget: {
        ats: "ashby",
        url: "https://jobs.ashbyhq.com/x/z/application",
        updated: "2026-08-01",
        fields: {
          "legal name|text": { t: "text", l: "Legal Name", req: true },
          "current role|checkbox": { t: "checkbox", l: "Current role" },
        },
      },
    },
  }
  const { forms } = analyseCache(cache, {
    now,
    resolveOpts: {
      profile: "tests/fixtures/profile.yaml",
      answers: "tests/fixtures/answers.yaml",
    },
  })
  const byFp = Object.fromEntries(forms.map((f) => [f.fp, f]))
  assert.equal(byFp.clean.shape_green, true)
  assert.equal(byFp.clean.widget_shape_blocked, false)
  assert.equal(byFp.widget.shape_green, false)
  assert.equal(byFp.widget.widget_shape_blocked, true)
  assert.equal(
    byFp.widget.buckets.some((b) => b.kind === "confirm-widget"),
    true,
  )
})

test("a checkbox blocks green even when the fact base holds its answer", () => {
  // The rule this project keeps having to re-defend: a tick carries ASSENT, so
  // the widget defers on SHAPE, never on whether an answer was available. If
  // this ever inverts, the prevalence number above stops meaning anything.
  const now = new Date("2026-08-02T00:00:00Z")
  const cache = {
    forms: {
      fp1: {
        ats: "ashby",
        url: "https://jobs.ashbyhq.com/x/y/application",
        updated: "2026-08-01",
        fields: {
          "legal name|text": { t: "text", l: "Legal Name", req: true },
          // A label the fixture fact base can answer, on a checkbox.
          "gender|checkbox": { t: "checkbox", l: "Gender", req: true },
        },
      },
    },
  }
  const { forms } = analyseCache(cache, {
    now,
    resolveOpts: {
      profile: "tests/fixtures/profile.yaml",
      answers: "tests/fixtures/answers.yaml",
    },
  })
  assert.equal(forms[0].shape_green, false)
  assert.equal(
    forms[0].buckets.some((b) => b.kind === "confirm-widget"),
    true,
  )
})

test("resolution against an explicit fact-base path settles a known field", () => {
  // The contract the prevalence figure depends on: with a fact base actually
  // loaded, an ordinary contact field resolves OK rather than UNKNOWN.
  //
  // RELATED DEFECT, NOT ASSERTED HERE: passing `null` for these paths — which
  // is exactly what fill-plan.mjs's and automatability.mjs's CLIs do when no
  // --profile flag is given — is NOT the same as omitting them, because a
  // destructuring default fires only on `undefined`. See FINDING QA-0.12-1 in
  // docs/measurements.md. The failing test for that belongs with its fix.
  const { results } = resolveFieldsFromFiles(
    [{ k: "x", t: "text", l: "First Name", req: true }],
    {
      profileFile: "tests/fixtures/profile.yaml",
      answersFile: "tests/fixtures/answers.yaml",
    },
  )
  assert.equal(results[0].status, "OK")
  assert.equal(results[0].value, "Jane")
})
