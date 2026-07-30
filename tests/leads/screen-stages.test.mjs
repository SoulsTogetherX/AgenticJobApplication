// Stage recording: a stored verdict must say WHICH layer decided, so that
// "why did I never see this job?" is answerable after the fact.
import test from "node:test"
import assert from "node:assert/strict"
import {
  evaluateStages,
  STAGE_IDS,
  STAGE_LABELS,
} from "../../scripts/leads/stages.mjs"
import { buildHistory } from "../../scripts/leads/risk.mjs"

const LIMITS = {
  location: {
    base: "North Las Vegas, NV",
    remote_ok: true,
    onsite_allowed: ["las vegas"],
  },
  freshness: { max_age_days: 30 },
  roles: {
    title_keywords: ["full stack", "software engineer"],
    hard_filter: ["senior"],
  },
  fit: { min_required_terms: 4, reject_below: 0.2 },
}
const NOW = new Date("2026-07-29T00:00:00Z")
const FRESH = "2026-07-26T00:00:00Z"
const PROFILE = new Set(["React", "Node.js", "TypeScript", "PostgreSQL", "AWS"])

const ctx = (over = {}) => ({
  limits: LIMITS,
  now: NOW,
  profileTech: PROFILE,
  history: buildHistory([]),
  ...over,
})

test("every stage id has a human label", () => {
  for (const id of STAGE_IDS) {
    assert.ok(STAGE_LABELS[id], `no label for ${id}`)
  }
})

test("l0 catches a hard-filtered title and names itself", () => {
  const v = evaluateStages(
    { title: "Senior Software Engineer", location: "Remote", posted_at: FRESH },
    ctx(),
  )
  assert.equal(v.stage, "l0")
})

test("l1 catches a body disqualifier the title could not show", () => {
  const v = evaluateStages(
    {
      title: "Full Stack Developer",
      location: "Remote",
      posted_at: FRESH,
      description:
        "Great web development role. You must be willing to relocate to Austin.",
    },
    ctx(),
  )
  assert.equal(v.stage, "l1")
})

test("l2 catches a stack mismatch that l0 and l1 both pass", () => {
  const v = evaluateStages(
    {
      title: "Software Engineer",
      location: "Remote",
      posted_at: FRESH,
      description:
        "Build web applications and APIs. Requirements: Scala, Kafka, Hadoop, Elasticsearch, Rust.",
    },
    ctx(),
  )
  assert.equal(v.stage, "l2", `expected l2, got ${v.stage}: ${v.reasons}`)
  assert.match(v.reasons[0], /stack mismatch/)
})

test("l3 catches an evergreen posting that every earlier stage passes", () => {
  const v = evaluateStages(
    {
      title: "Full Stack Developer",
      location: "Remote",
      posted_at: FRESH,
      description:
        "Build web applications with React, Node.js, TypeScript and PostgreSQL on AWS. " +
        "This is a pipeline requisition for future hiring.",
    },
    ctx(),
  )
  assert.equal(v.stage, "l3", `expected l3, got ${v.stage}: ${v.reasons}`)
})

test("a clean posting reaches the end with stage null", () => {
  const v = evaluateStages(
    {
      title: "Full Stack Developer",
      location: "Remote",
      posted_at: FRESH,
      description:
        "Requirements: React, Node.js, TypeScript, PostgreSQL, AWS. You will build and ship features.",
    },
    ctx(),
  )
  assert.equal(v.ok, true)
  assert.equal(v.stage, null)
  assert.deepEqual(Object.keys(v.stages).sort(), [...STAGE_IDS].sort())
})

test("stages short-circuit — a later stage never runs after a rejection", () => {
  // This is what keeps the expensive checks cheap: they only ever see what the
  // earlier ones let through.
  const v = evaluateStages(
    { title: "Senior Engineer", location: "Remote", posted_at: FRESH },
    ctx(),
  )
  assert.deepEqual(Object.keys(v.stages), ["l0"])
})

test("a rejection reason is prefixed with the stage that produced it", () => {
  const v = evaluateStages(
    {
      title: "Software Engineer",
      location: "Remote",
      posted_at: FRESH,
      description: "Requirements: Scala, Kafka, Hadoop, Elasticsearch, Rust.",
    },
    ctx(),
  )
  assert.ok(
    v.reasons.every((r) => /^l\d:/.test(r)),
    `reasons must name their stage: ${v.reasons.join(" | ")}`,
  )
})

test("fit_score and repost_count surface on the top-level result", () => {
  // screen.mjs records these into screens.doc, so they must not be buried.
  const v = evaluateStages(
    {
      title: "Full Stack Developer",
      location: "Remote",
      posted_at: FRESH,
      description:
        "Requirements: React, Node.js, TypeScript, PostgreSQL. You will build features.",
      repost_count: 1,
    },
    ctx(),
  )
  assert.equal(typeof v.fit_score, "number")
  assert.equal(v.repost_count, 1)
})

test("narrowing to one stage skips the earlier ones entirely", () => {
  // "What would L2 alone say?" — without l0 short-circuiting everything first.
  const v = evaluateStages(
    {
      title: "Senior Engineer",
      location: "London, UK",
      posted_at: FRESH,
      description: "Requirements: React, Node.js, TypeScript, PostgreSQL, AWS.",
    },
    ctx(),
    ["l2"],
  )
  assert.ok(v.ok, "l0 would have rejected this, but it was not run")
  assert.deepEqual(Object.keys(v.stages), ["l2"])
})
