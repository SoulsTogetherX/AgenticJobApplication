// One batched question list across every prepped job. The properties that
// matter: a consent box is never turned into a question, an answered question
// never reappears, and the same question asked by four forms is asked once.
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import {
  mergeQuestions,
  questionsFromPlans,
  questionsFromPredicted,
  predictedFields,
} from "../../scripts/apply/pending-questions.mjs"
import { recordCache } from "../../scripts/apply/field-cache.mjs"

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
)
const SCRIPT = path.join(ROOT, "scripts", "apply", "pending-questions.mjs")
const FIXTURES = path.join(ROOT, "tests", "fixtures")

const plan = (slug, defer) => ({ slug, plan: { ats: "greenhouse", defer } })

test("collects only the defers that are questions a person can answer", () => {
  const qs = questionsFromPlans([
    plan("a", [
      {
        k: "f1",
        label: "Highest degree",
        why: "needs-choice",
        options: ["BS"],
      },
      { k: "f2", label: "Preferred pronouns", why: "unknown" },
      {
        k: "f3",
        label: "Are you okay with our arbitration policy?",
        why: "unknown",
      },
      { k: "f4", label: "Resume", why: "no rendered resume" },
      { k: "f5", label: "Signature pad", why: "unsupported field type canvas" },
    ]),
  ])
  assert.deepEqual(
    qs.map((q) => q.label),
    ["Highest degree", "Preferred pronouns"],
    "consent, missing documents and dead widgets are not questions",
  )
  assert.deepEqual(qs[0].options, ["BS"])
})

test("the same question from four forms is one entry naming all four", () => {
  const merged = mergeQuestions(
    questionsFromPlans([
      plan("a", [
        { k: "f1", label: "Do you require sponsorship?", why: "unknown" },
      ]),
      plan("b", [
        { k: "f1", label: "do you require  sponsorship?", why: "unknown" },
      ]),
      plan("c", [{ k: "f9", label: "Start date", why: "unknown" }]),
    ]),
  )
  assert.equal(merged.length, 2)
  assert.equal(merged[0].label, "Do you require sponsorship?")
  assert.deepEqual(
    merged[0].slugs,
    ["a", "b"],
    "case and spacing must not split it",
  )
  assert.equal(merged[1].slugs.length, 1, "most-shared question comes first")
})

test("options from different forms are unioned, and a real scan wins on the reason", () => {
  const merged = mergeQuestions([
    {
      source: "predicted",
      ats: "greenhouse",
      label: "Degree",
      why: "unknown",
      options: ["BS"],
    },
    {
      source: "plan",
      slug: "a",
      ats: "greenhouse",
      label: "Degree",
      why: "needs-choice",
      options: ["BS", "MS"],
    },
  ])
  assert.equal(merged.length, 1)
  assert.deepEqual(merged[0].options, ["BS", "MS"])
  assert.equal(merged[0].why, "needs-choice")
  assert.deepEqual(merged[0].sources, ["predicted", "plan"])
})

test("prediction reads required fields off remembered forms, for the right ATS", () => {
  const cache = { v: 2, forms: {} }
  recordCache(cache, {
    fp: "gh1",
    atsId: "greenhouse",
    url: "https://job-boards.greenhouse.io/x/jobs/1",
    scan: {
      fields: [
        {
          k: "f1",
          t: "select",
          l: "Highest degree",
          req: true,
          opts: ["BS", "MS"],
        },
        { k: "f2", t: "text", l: "Twitter", req: false },
      ],
    },
  })
  recordCache(cache, {
    fp: "lv1",
    atsId: "lever",
    url: "https://jobs.lever.co/y/1",
    scan: { fields: [{ k: "f1", t: "text", l: "Portfolio", req: true }] },
  })

  const fields = predictedFields(cache, new Set(["greenhouse"]))
  assert.deepEqual(
    fields.map((f) => f.l),
    ["Highest degree"],
    "optional fields are noise; another ATS is not these jobs' problem",
  )
  assert.deepEqual(fields[0].opts, ["BS", "MS"])
})

test("a cache written before req was recorded predicts nothing rather than everything", () => {
  const cache = {
    v: 2,
    forms: {
      old: { ats: "greenhouse", fields: { "degree|select": { t: "select" } } },
    },
  }
  assert.deepEqual(predictedFields(cache, new Set(["greenhouse"])), [])
})

test("a predicted field the fact base can answer is not asked about", () => {
  const fields = [
    { k: "a", t: "text", l: "Email", req: true, ats: "greenhouse", opts: [] },
    {
      k: "b",
      t: "select",
      l: "Highest degree",
      req: true,
      ats: "greenhouse",
      opts: ["BS"],
    },
    {
      k: "c",
      t: "checkbox",
      l: "I agree to the terms and conditions",
      req: true,
      ats: "greenhouse",
      opts: [],
    },
  ]
  const qs = questionsFromPredicted(fields, [
    { k: "a", status: "OK", value: "x@y.z" },
    { k: "b", status: "NEEDS-CHOICE" },
    { k: "c", status: "UNKNOWN" },
  ])
  assert.deepEqual(
    qs.map((q) => q.label),
    ["Highest degree"],
  )
})

test("CLI batches across workspaces and reports nothing to ask when there is nothing", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pending-q-"))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))

  const mk = (slug, files) => {
    fs.mkdirSync(path.join(dir, slug), { recursive: true })
    for (const [name, body] of Object.entries(files)) {
      fs.writeFileSync(path.join(dir, slug, name), JSON.stringify(body))
    }
  }
  const job = {
    company: "Co",
    title: "T",
    source_url: "https://job-boards.greenhouse.io/co/jobs/1",
  }
  mk("one", {
    "job.json": job,
    "fill-plan.json": {
      ats: "greenhouse",
      defer: [
        { k: "f1", label: "Do you require sponsorship?", why: "unknown" },
        { k: "f2", label: "I consent to the privacy policy", why: "consent" },
      ],
    },
  })
  mk("two", {
    "job.json": job,
    "fill-plan.json": {
      ats: "greenhouse",
      defer: [
        { k: "f1", label: "Do you require sponsorship?", why: "unknown" },
      ],
    },
  })

  const run = (extra = []) =>
    spawnSync(
      process.execPath,
      [
        SCRIPT,
        "--jobs-dir",
        dir,
        "--profile",
        path.join(FIXTURES, "profile.yaml"),
        "--answers",
        path.join(FIXTURES, "answers.yaml"),
        "--json",
        ...extra,
      ],
      { cwd: ROOT, encoding: "utf8" },
    )

  const out = JSON.parse(run().stdout)
  assert.equal(out.jobs, 2)
  assert.equal(out.questions.length, 1, "one question, not one per job")
  assert.deepEqual(out.questions[0].slugs, ["one", "two"])

  const single = JSON.parse(run(["one"]).stdout)
  assert.equal(single.jobs, 1, "a named slug narrows the batch")

  fs.rmSync(path.join(dir, "one", "fill-plan.json"))
  fs.rmSync(path.join(dir, "two", "fill-plan.json"))
  const none = JSON.parse(run(["--no-predict"]).stdout)
  assert.deepEqual(none.questions, [])
})

test("a missing jobs directory exits 2", () => {
  const run = spawnSync(
    process.execPath,
    [SCRIPT, "--jobs-dir", path.join(ROOT, "no-such-jobs-dir")],
    { cwd: ROOT, encoding: "utf8" },
  )
  assert.equal(run.status, 2)
  assert.match(run.stderr, /no jobs directory/)
})
