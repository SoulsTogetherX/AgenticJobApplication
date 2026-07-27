import test from "node:test"
import assert from "node:assert/strict"
import path from "node:path"
import { fileURLToPath } from "node:url"
import {
  loadYamlFile,
  buildFactIndex,
  extractNumbers,
  extractMonthYears,
  techTermsIn,
  validateContext,
  validateJob,
} from "../scripts/lib.mjs"

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures")

test("extractNumbers normalizes separators and suffixes", () => {
  const n = extractNumbers(
    "Served 1,200 users, 99.9% uptime, 45+ stars, C++17, ≤250 ms, GPA 3.75",
  )
  assert.deepEqual(
    [...n].sort(),
    ["1200", "17", "250", "3.75", "45", "99.9"].sort(),
  )
})

test("extractNumbers on empty text returns empty set", () => {
  assert.equal(extractNumbers("no digits here").size, 0)
})

test("extractMonthYears finds month-year tokens", () => {
  const d = extractMonthYears(
    "Jan 2024 – Present, graduated Jun 2023, and June 2022",
  )
  assert.deepEqual([...d].sort(), ["Jan 2024", "Jun 2022", "Jun 2023"].sort())
})

test("techTermsIn finds terms with tricky boundaries", () => {
  const found = techTermsIn(
    "Used C++ and Node.js with React Native; GitHub is not Git term-wise... but Git alone is.",
  )
  assert.ok(found.includes("C++"))
  assert.ok(found.includes("Node.js"))
  assert.ok(found.includes("React Native"))
  assert.ok(found.includes("Git"))
  // "React Native" must not also report bare "React"
  assert.ok(!found.includes("React"))
})

test("techTermsIn does not match terms inside larger words", () => {
  const found = techTermsIn("The GitHubber Reacted using JavaLike tools")
  assert.ok(!found.includes("Git"))
  assert.ok(!found.includes("React"))
  assert.ok(!found.includes("Java"))
})

test("buildFactIndex indexes every fixture fact id uniquely", () => {
  const profile = loadYamlFile(path.join(FIX, "profile.yaml"))
  const answers = loadYamlFile(path.join(FIX, "answers.yaml"))
  const idx = buildFactIndex(profile, answers)
  for (const id of [
    "summary-fs",
    "exp-acme",
    "exp-acme-b1",
    "exp-acme-b2",
    "prj-demo-b1",
    "skill-lang",
    "edu-state",
    "a-001",
  ]) {
    assert.ok(idx.has(id), `missing ${id}`)
  }
})

test("buildFactIndex throws on duplicate ids", () => {
  const profile = {
    summary: [{ id: "dup", text: "a" }],
    experience: [
      { id: "dup", title: "t", company: "c", dates: "d", bullets: [] },
    ],
  }
  assert.throws(
    () => buildFactIndex(profile, { answers: [] }),
    /Duplicate fact id/,
  )
})

test("validateJob catches missing fields", () => {
  assert.deepEqual(validateJob({ slug: "s", company: "c", title: "t" }), [])
  assert.ok(validateJob({ slug: "s", company: "", title: "t" }).length > 0)
  assert.ok(validateJob(null).length > 0)
})

test("validateContext accepts a well-formed context", () => {
  const ctx = {
    slug: "x",
    analysis: { key_requirements: [], matched_fact_ids: [] },
    resume: { status: "pending" },
    cover_letter: { status: "rendered" },
  }
  assert.deepEqual(validateContext(ctx), [])
})

test("validateContext rejects bad shapes", () => {
  assert.ok(validateContext(null).length > 0)
  assert.ok(validateContext({ slug: "x" }).length > 0)
  const badStatus = {
    slug: "x",
    analysis: { key_requirements: [], matched_fact_ids: [] },
    resume: { status: "done" },
    cover_letter: { status: "pending" },
  }
  assert.ok(validateContext(badStatus).some((e) => e.includes("resume.status")))
})
