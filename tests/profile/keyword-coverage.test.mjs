// The "you forgot to write it down" recommender.
//
// The safety property that matters: this must never assert a skill is the
// user's. It produces a QUESTION and the command to record the answer; the
// user confirms. CLAUDE.md rule 2 — the agent never edits the fact base.
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  coverage,
  saveCommand,
  gatherDemand,
} from "../../scripts/profile/keyword-coverage.mjs"

const demandOf = (o) => new Map(Object.entries(o))

test("a demanded skill already in the profile is covered, not asked about", () => {
  const out = coverage(demandOf({ React: 5 }), new Set(["React"]))
  assert.deepEqual(
    out.covered.map((r) => r.skill),
    ["React"],
  )
  assert.deepEqual(out.ask, [])
  assert.deepEqual(out.gap, [])
})

test("a demanded skill adjacent to an evidenced one is ASKED about", () => {
  // Someone who has shipped Node.js has almost certainly written an Express
  // route; it just never made it into profile.yaml.
  const out = coverage(demandOf({ Express: 4 }), new Set(["Node.js"]))
  assert.equal(out.ask.length, 1)
  assert.equal(out.ask[0].skill, "Express")
  assert.deepEqual(out.ask[0].implied_by, ["Node.js"])
  assert.deepEqual(out.gap, [])
})

test("a demanded skill adjacent to nothing evidenced is a genuine gap", () => {
  const out = coverage(demandOf({ Kubernetes: 9 }), new Set(["React"]))
  assert.deepEqual(
    out.gap.map((r) => r.skill),
    ["Kubernetes"],
  )
  assert.deepEqual(out.ask, [])
})

test("adjacency is computed from what is EVIDENCED, not from what is demanded", () => {
  // The claim must be "you have React, so you probably have Redux" — never
  // "the market wants Redux, so you probably have it". With nothing evidenced
  // there can be no suggestions at all.
  const out = coverage(demandOf({ Redux: 9, Express: 9 }), new Set())
  assert.deepEqual(out.ask, [])
  assert.equal(out.gap.length, 2)
})

test("a skill below min_demand is dropped from every bucket", () => {
  const out = coverage(demandOf({ Express: 1 }), new Set(["Node.js"]), {
    minDemand: 2,
  })
  assert.deepEqual(out.ask, [])
  assert.deepEqual(out.gap, [])
  assert.deepEqual(out.covered, [])
})

test("min_demand of 1 keeps everything", () => {
  const out = coverage(demandOf({ Express: 1 }), new Set(["Node.js"]), {
    minDemand: 1,
  })
  assert.equal(out.ask.length, 1)
})

test("buckets are sorted by demand, highest first", () => {
  const out = coverage(
    demandOf({ Kubernetes: 3, Terraform: 9, Scala: 5 }),
    new Set(["React"]),
    { minDemand: 1 },
  )
  assert.deepEqual(
    out.gap.map((r) => r.skill),
    ["Terraform", "Scala", "Kubernetes"],
  )
})

test("an already-evidenced skill is never suggested back to the user", () => {
  const out = coverage(
    demandOf({ Express: 5, "Node.js": 5 }),
    new Set(["Node.js", "Express"]),
    { minDemand: 1 },
  )
  assert.deepEqual(out.ask, [])
  assert.equal(out.covered.length, 2)
})

test("one suggestion can be implied by several evidenced skills", () => {
  const out = coverage(demandOf({ Linux: 4 }), new Set(["Docker", "nginx"]), {
    minDemand: 1,
  })
  assert.equal(out.ask.length, 1)
  assert.ok(out.ask[0].implied_by.length >= 2, "records every skill implying it")
})

test("the printed command is a question, not an assertion of fact", () => {
  const cmd = saveCommand("Express")
  assert.match(cmd, /save-answer\.mjs/)
  assert.match(cmd, /Do you have hands-on experience with Express\?/)
  assert.match(cmd, /<your answer>/, "the answer is left for the user to fill in")
  assert.ok(!/--source model/.test(cmd), "must not pre-authorise a model guess")
})

test("empty demand produces empty buckets rather than throwing", () => {
  const out = coverage(new Map(), new Set(["React"]))
  assert.deepEqual([out.covered, out.ask, out.gap], [[], [], []])
})

test("an unknown skill name is treated as a gap, not a crash", () => {
  const out = coverage(demandOf({ Fortran: 3 }), new Set(["React"]), {
    minDemand: 1,
  })
  assert.deepEqual(
    out.gap.map((r) => r.skill),
    ["Fortran"],
  )
})

// --- required vs nice-to-have demand ----------------------------------------

// The distinction this report was missing: a skill under "Minimum
// Qualifications" and one under "Nice to have" are not the same fact.
const split = (o) => new Map(Object.entries(o))

test("required demand outranks total demand", () => {
  const out = coverage(
    split({
      Kubernetes: { required: 0, total: 20 },
      Terraform: { required: 6, total: 6 },
    }),
    new Set(["React"]),
    { minDemand: 1 },
  )
  assert.deepEqual(
    out.gap.map((r) => r.skill),
    ["Terraform", "Kubernetes"],
    "a hard requirement ranks above a more-mentioned nice-to-have",
  )
})

test("both counts are reported, not collapsed into one", () => {
  const out = coverage(split({ Kubernetes: { required: 2, total: 9 } }), new Set(), {
    minDemand: 1,
  })
  assert.equal(out.gap[0].required_demand, 2)
  assert.equal(out.gap[0].demand, 9)
})

test("a skill is kept on required demand even when the index has never seen it", () => {
  // lead_keywords is indexed once at ingest, so any skill added to the lexicon
  // afterwards has total = 0 while its required count is read live from the
  // descriptions. Gating on total alone dropped System design at required = 8 —
  // the most-required skill in the live store.
  const out = coverage(
    split({ "System design": { required: 8, total: 0 } }),
    new Set(["React"]),
    { minDemand: 2 },
  )
  assert.equal(
    out.gap.length + out.ask.length,
    1,
    "must not be filtered out for having no index rows",
  )
})

test("a skill below the threshold on BOTH counts is still dropped", () => {
  const out = coverage(
    split({ Cobol: { required: 1, total: 1 } }),
    new Set(["React"]),
    { minDemand: 2 },
  )
  assert.deepEqual([out.ask, out.gap], [[], []])
})

test("a plain number is still accepted as total-only demand", () => {
  // Backward compatibility for callers predating the split.
  const out = coverage(demandOf({ Kubernetes: 5 }), new Set(), { minDemand: 1 })
  assert.equal(out.gap[0].demand, 5)
  assert.equal(out.gap[0].required_demand, 0)
})

// --- the two ask routes ------------------------------------------------------

test("a same-area suggestion is offered but labelled as the weaker claim", () => {
  // Four evidenced Languages skills, and the market wants a fifth.
  const evidenced = new Set(["Python", "TypeScript", "JavaScript", "SQL", "C++"])
  const out = coverage(split({ Kotlin: { required: 3, total: 3 } }), evidenced, {
    minDemand: 1,
  })
  assert.equal(out.ask.length, 1)
  assert.equal(out.ask[0].confidence, "same-area")
  assert.match(out.ask[0].implied_by[0], /Languages/)
})

test("an adjacency edge always ranks above a same-area hunch", () => {
  const evidenced = new Set([
    "React",
    "Python",
    "TypeScript",
    "JavaScript",
    "SQL",
    "C++",
  ])
  const out = coverage(
    split({
      Kotlin: { required: 9, total: 9 }, // same-area, heavily required
      Redux: { required: 1, total: 1 }, // adjacent to React, barely required
    }),
    evidenced,
    { minDemand: 1 },
  )
  assert.equal(out.ask[0].skill, "Redux", "a checked edge beats a hunch")
  assert.equal(out.ask[0].confidence, "adjacent")
  assert.equal(out.ask[1].confidence, "same-area")
})

test("too few evidenced skills in a group means no same-area suggestion", () => {
  const out = coverage(split({ Kotlin: { required: 9, total: 9 } }), new Set(["Python"]), {
    minDemand: 1,
  })
  assert.deepEqual(out.ask, [], "one Languages skill is not an area")
  assert.equal(out.gap.length, 1)
})

// --- gatherDemand: where the required half actually comes from ---------------

// A JSON lead store, so these run without the database or the live data.
function storeWith(leads) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kwdemand-"))
  const file = path.join(dir, "leads.json")
  fs.writeFileSync(file, JSON.stringify({ leads }))
  return file
}

test("only the REQUIRED section counts toward required demand", () => {
  const file = storeWith([
    {
      id: "a",
      status: "new",
      title: "Full Stack Developer",
      description:
        "Minimum Qualifications: React and Node.js. Preferred Qualifications: Kubernetes.",
    },
  ])
  const d = gatherDemand({ leadsPath: file })
  assert.equal(d.get("React").required, 1)
  assert.equal(d.get("Node.js").required, 1)
  assert.equal(
    d.get("Kubernetes")?.required ?? 0,
    0,
    "a nice-to-have must not count as a requirement",
  )
})

test("a posting with no recognisable requirements section contributes no required demand", () => {
  // Falling back to the general text would mark every term in an unstructured
  // posting as required, which is exactly the flattening this pass undoes.
  const file = storeWith([
    {
      id: "a",
      status: "new",
      title: "Full Stack Developer",
      description: "We build things with React and Kubernetes every day.",
    },
  ])
  const d = gatherDemand({ leadsPath: file })
  assert.equal(d.get("React")?.required ?? 0, 0)
})

test("dismissed leads are excluded by default and included on request", () => {
  const leads = [
    {
      id: "a",
      status: "dismissed",
      title: "Engineer",
      description: "Requirements: Kubernetes and Terraform.",
    },
  ]
  const file = storeWith(leads)
  assert.equal(gatherDemand({ leadsPath: file }).size, 0, "dismissed gets no vote")
  const wide = gatherDemand({ leadsPath: file, includeDismissed: true })
  assert.ok(wide.get("Kubernetes").required >= 1)
})

test("a lead with no description still contributes its title to total demand", () => {
  const file = storeWith([
    { id: "a", status: "new", title: "React Developer", description: "" },
  ])
  const d = gatherDemand({ leadsPath: file })
  assert.ok(d.get("React").total >= 1)
  assert.equal(d.get("React").required, 0)
})

test("a specific --job counts heavily and its requirements count as required", () => {
  const file = storeWith([])
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kwjob-"))
  const jobFile = path.join(dir, "job.json")
  fs.writeFileSync(
    jobFile,
    JSON.stringify({
      title: "Full Stack Developer",
      description: "Requirements: React, Node.js, and PostgreSQL.",
    }),
  )
  const d = gatherDemand({ leadsPath: file, jobFile, jobWeight: 3 })
  assert.equal(d.get("React").total, 3)
  assert.equal(d.get("React").required, 3)
})

test("a missing lead store yields empty demand rather than throwing", () => {
  assert.doesNotThrow(() => gatherDemand({ leadsPath: "/no/such/store.json" }))
  assert.equal(gatherDemand({ leadsPath: "/no/such/store.json" }).size, 0)
})
