// lead_keywords is populated at ingest and was then read by nothing.
//
// recommend.mjs derived tech from `lead.title + lead.job_text`, and job_text
// exists only where a job workspace does — so leads with no workspace were
// ranked on their title alone. profile-gaps.mjs was worse: it handed every lead
// over as `text: lead.title`, so stored descriptions counted for nothing at all.
//
// Measured on the live store when this was fixed: leads contributing no tech
// signal fell from 81 of 102 to 28, and the top-ranked lead changed.
import test from "node:test"
import assert from "node:assert/strict"
import { scoreLead, rankLeads } from "../../src/leads/recommend.mjs"
import { computeGaps } from "../../src/profile/profile-gaps.mjs"

const PROFILE_TECH = new Set(["React", "Node.js", "TypeScript", "AWS"])

test("scoreLead uses indexed keywords when the lead has no captured text", () => {
  const lead = { id: "l1", company: "Acme", title: "Full Stack Developer" }
  const bare = scoreLead(lead, PROFILE_TECH)
  const indexed = scoreLead(
    lead,
    PROFILE_TECH,
    new Date(),
    new Set(["React", "Node.js", "Kubernetes"]),
  )
  assert.deepEqual(bare.matched_tech, [], "no signal without the index")
  assert.deepEqual(indexed.matched_tech, ["Node.js", "React"])
  assert.deepEqual(indexed.missing_tech, ["Kubernetes"])
  assert.ok(indexed.score > bare.score, "overlap must raise the score")
})

test("indexed keywords and captured posting text are unioned, not either/or", () => {
  // The index covers leads with no workspace; a captured posting is richer than
  // the description snippet the sweep stored. Preferring one loses the other.
  const lead = {
    id: "l2",
    company: "Acme",
    title: "Full Stack Developer",
    job_text: "You will work with TypeScript and GraphQL.",
  }
  const r = scoreLead(lead, PROFILE_TECH, new Date(), new Set(["AWS", "React"]))
  for (const t of ["TypeScript", "AWS", "React"]) {
    assert.ok(r.matched_tech.includes(t), `${t} missing from matches`)
  }
  assert.ok(r.missing_tech.includes("GraphQL"))
})

test("rankLeads passes each lead its own keyword set", () => {
  const leads = [
    { id: "a", company: "A", title: "Software Engineer" },
    { id: "b", company: "B", title: "Software Engineer" },
  ]
  const keywords = new Map([
    ["a", new Set(["React", "Node.js", "TypeScript"])],
    ["b", new Set(["Kubernetes"])],
  ])
  const ranked = rankLeads(leads, "React Node.js TypeScript AWS", {
    keywords,
    top: 10,
  })
  assert.equal(ranked[0].id, "a", "the lead matching the profile ranks first")
  assert.deepEqual(ranked[1].matched_tech, [])
})

test("rankLeads without a keyword map still works", () => {
  const leads = [{ id: "a", company: "A", title: "Full Stack Developer" }]
  assert.doesNotThrow(() => rankLeads(leads, "React", { top: 5 }))
  assert.equal(rankLeads(leads, "React", { top: 5 }).length, 1)
})

test("a lead with no indexed keywords is not penalised, just unscored", () => {
  const leads = [{ id: "a", company: "A", title: "Full Stack Developer" }]
  const withEmpty = rankLeads(leads, "React", { top: 5, keywords: new Map() })
  const without = rankLeads(leads, "React", { top: 5 })
  assert.equal(withEmpty[0].score, without[0].score)
})

test("computeGaps accepts pre-extracted terms instead of text", () => {
  const jobs = [
    { slug: "j1", terms: ["Kubernetes", "React"], weight: 1 },
    { slug: "j2", terms: ["Kubernetes"], weight: 1 },
  ]
  const out = computeGaps(jobs, "React and Node.js", { minDemand: 1 })
  const k = out.gaps.find((g) => g.tech === "Kubernetes")
  assert.ok(k, "Kubernetes should be a gap")
  assert.equal(k.demand, 2)
  assert.ok(
    out.covered.some((c) => c.tech === "React"),
    "React is evidenced in the profile blob",
  )
})

test("computeGaps still accepts text, and terms take precedence", () => {
  const out = computeGaps(
    [
      { slug: "j1", text: "We use Kubernetes heavily.", weight: 1 },
      // terms wins over text: the index is authoritative for a stored lead.
      { slug: "j2", terms: ["Redis"], text: "We use Kubernetes.", weight: 1 },
    ],
    "React",
    { minDemand: 1 },
  )
  const byTech = Object.fromEntries(out.gaps.map((g) => [g.tech, g.demand]))
  assert.equal(byTech.Kubernetes, 1, "only j1 contributed Kubernetes")
  assert.equal(byTech.Redis, 1)
})

test("an empty terms set contributes nothing rather than throwing", () => {
  const out = computeGaps([{ slug: "j1", terms: [], weight: 1 }], "React", {
    minDemand: 1,
  })
  assert.deepEqual(out.gaps, [])
})
