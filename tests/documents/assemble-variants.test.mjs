// One summary variant per resume, competing skills groups, no-fit refusal.
//
// The shape this covers is the real one: a profile that banks several approved
// summary paragraphs, one per track. Until 2026-08-17 every variant was
// mandatory, so all five went out on every job (~2,100 of 3,800 chars) and the
// bullets got 9 — six unrelated postings assembled byte-identically, four of
// five jobs with no bullets under them. assemble-resume.test.mjs cannot see any
// of this because its fixture has ONE variant, and with one there is nothing to
// choose. This file has five, ordered so a tie is observable.
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import yaml from "js-yaml"

import {
  assembleResume,
  selectItems,
  formatSelectionDiff,
  DEFAULT_BUDGET,
  EXIT_NO_FIT,
  NoSummaryFit,
} from "../../scripts/documents/assemble-resume.mjs"
import { buildPlan } from "../../scripts/documents/keyword-plan.mjs"
import { buildFactIndex } from "../../scripts/lib/lib.mjs"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, "..", "..")
const FIX = path.join(HERE, "assemble")
const PROFILE = path.join(FIX, "profile-multi.yaml")
const ANSWERS = path.join(FIX, "answers.yaml")
const GOLDEN_BUDGET = 1400

const rawProfile = fs.readFileSync(PROFILE, "utf8")
const profile = yaml.load(rawProfile)
const answers = yaml.load(fs.readFileSync(ANSWERS, "utf8"))
const factIndex = buildFactIndex(profile, answers)

const readJob = (slug) =>
  JSON.parse(fs.readFileSync(path.join(FIX, "jobs", `${slug}.json`), "utf8"))

function assemble(slug, budget = GOLDEN_BUDGET, prof = profile) {
  const job = readJob(slug)
  const plan = buildPlan({
    job,
    profileBlob: rawProfile,
    targets: ["Developer", "Engineer"],
  })
  return assembleResume({ job, profile: prof, answers, plan, budget })
}

const included = (sel, id) => sel.included.find((i) => i.id === id)
const dropped = (sel, id) => sel.dropped.find((d) => d.id === id)
const VARIANTS = [
  "summary-web",
  "summary-mobile",
  "summary-cloud",
  "summary-data",
  "summary-tutor",
]

// --- (a) exactly one variant, the others dropped with a mechanical reason ----

test("exactly one summary variant is emitted, and the choice carries its score", () => {
  const { markdown, selection } = assemble("cloud-platform")
  const onPage = VARIANTS.filter((id) => markdown.includes(`fact:${id}`))
  assert.deepEqual(onPage, ["summary-cloud"], "one variant, the matching one")

  const win = included(selection, "summary-cloud")
  assert.equal(win.how, "mandatory", "a summary existing is structural")
  assert.match(win.reason, /summary variant chosen for this posting — scored 8/)
  assert.match(win.reason, /AWS|Kubernetes|Terraform|CI\/CD/)

  for (const id of VARIANTS.filter((v) => v !== "summary-cloud")) {
    const d = dropped(selection, id)
    assert.ok(d, `${id} must be recorded as dropped, not silently absent`)
    assert.match(
      d.reason,
      /^summary variant not chosen — scored \d+ against the posting; summary-cloud scored 8$/,
      `${id}: ${d.reason}`,
    )
  }
  assert.equal(selection.summary_choice.chosen, "summary-cloud")
  assert.equal(selection.summary_choice.ranked.length, 5)
})

// --- (b) different postings pick different variants --------------------------

test("different postings choose different variants", () => {
  assert.equal(
    assemble("cloud-platform").selection.summary_choice.chosen,
    "summary-cloud",
  )
  assert.equal(
    assemble("python-data").selection.summary_choice.chosen,
    "summary-data",
  )
  assert.equal(
    assemble("react-frontend").selection.summary_choice.chosen,
    "summary-web",
  )
  // And the documents differ — the point of the whole change.
  const a = assemble("cloud-platform").markdown
  const b = assemble("python-data").markdown
  assert.notEqual(a, b)
})

// --- (c) zero match with 2+ variants REFUSES ---------------------------------

test("a posting no variant addresses is refused, naming every score", () => {
  assert.throws(
    () => assemble("graphql-api"),
    (e) => {
      assert.ok(e instanceof NoSummaryFit)
      assert.equal(e.code, "no-summary-fit")
      for (const id of VARIANTS) assert.match(e.message, new RegExp(`${id} 0`))
      assert.match(
        e.message,
        /GraphQL\*/,
        "the must_use list is in the message",
      )
      assert.equal(e.variants.length, 5)
      assert.ok(e.variants.every((v) => v.score === 0))
      return true
    },
  )
})

test("the CLI exits 3 on no-summary-fit and writes nothing", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aj-variants-"))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  fs.mkdirSync(path.join(dir, "graphql-api"))
  fs.copyFileSync(
    path.join(FIX, "jobs", "graphql-api.json"),
    path.join(dir, "graphql-api", "job.json"),
  )
  const res = spawnSync(
    process.execPath,
    [
      path.join(ROOT, "scripts", "documents", "assemble-resume.mjs"),
      "graphql-api",
      "--jobs-dir",
      dir,
      "--profile",
      PROFILE,
      "--answers",
      ANSWERS,
    ],
    { cwd: ROOT, encoding: "utf8" },
  )
  assert.equal(res.status, EXIT_NO_FIT, res.stderr)
  assert.match(res.stderr, /^refused: no-summary-fit — /)
  assert.ok(
    !fs.existsSync(path.join(dir, "graphql-api", "resume.md")),
    "a refusal must not leave a resume behind",
  )
  assert.ok(
    !fs.existsSync(path.join(dir, "graphql-api", "resume-selection.json")),
    "nor a selection record",
  )
})

// --- (d) ties break to profile order, not to cost ----------------------------

test("a tie between variants goes to profile order, even when the later one is shorter", () => {
  // react-frontend: web 4, mobile 4. mobile is 69 chars to web's 106; if cost
  // broke the tie, mobile would win. It does not — the user's ordering does.
  const { selection } = assemble("react-frontend")
  assert.equal(selection.summary_choice.chosen, "summary-web")
  const m = dropped(selection, "summary-mobile")
  assert.match(m.reason, /scored 4 against the posting; summary-web scored 4/)
})

// --- (e) skills groups compete, with a floor, without seeding coverage --------

test("skills groups compete: the best is always kept, the rest only if they earn it", () => {
  // At the default budget everything fits, so all four groups are on the page.
  const roomy = assemble("cloud-platform", DEFAULT_BUDGET).selection
  assert.deepEqual(
    roomy.included
      .filter((i) => i.section === "skills")
      .map((i) => i.id)
      .sort(),
    ["skill-data", "skill-fw", "skill-infra", "skill-lang"],
  )
  const floor = roomy.included.find(
    (i) => i.section === "skills" && i.how === "mandatory",
  )
  assert.equal(floor.id, "skill-infra", "the best-scoring group is the floor")
  assert.match(floor.reason, /best match for this posting/)

  // Squeezed to just above the structural cost, only the floor survives.
  const structural = roomy.included
    .filter((i) => i.how === "mandatory")
    .reduce((s, i) => s + i.chars, 0)
  const tight = assemble("cloud-platform", structural + 5).selection
  assert.deepEqual(
    tight.included.filter((i) => i.section === "skills").map((i) => i.id),
    ["skill-infra"],
  )
  for (const id of ["skill-lang", "skill-fw", "skill-data"]) {
    const d = dropped(tight, id)
    assert.ok(d, `${id} must be recorded as dropped`)
    assert.match(d.reason, /^budget exhausted/)
  }
})

test("a skills group never seeds coverage — bullets still earn their place", () => {
  // Hand-built: the group lists both terms. If it seeded `covered`, the bullet
  // covering B would have zero marginal gain and fall to FILL. It must not.
  const items = [
    {
      id: "__contact",
      section: "header",
      mandatory: true,
      text: "x",
      covers: [],
      order: 0,
    },
    {
      id: "s1",
      section: "summary",
      pool: "summary",
      text: "summary A",
      covers: ["A"],
      contextual: true,
      order: 1,
    },
    {
      id: "b1",
      section: "experience",
      text: "bullet about B",
      covers: ["B"],
      contextual: true,
      order: 2,
    },
    {
      id: "g1",
      section: "skills",
      pool: "skills",
      text: "Group: A, B",
      covers: ["A", "B"],
      order: 3,
    },
  ]
  const mustUse = new Map([
    ["A", true],
    ["B", true],
  ])
  const { chosen } = selectItems(items, mustUse, 10_000)
  assert.equal(chosen.get("b1").how, "coverage")
  assert.match(chosen.get("b1").reason, /covers B/)
  assert.equal(chosen.get("g1").how, "mandatory", "the only group is the floor")
  assert.equal(chosen.get("s1").how, "mandatory")
})

test("in FILL a zero-score bullet earlier in profile order beats a zero-score group", () => {
  const items = [
    {
      id: "__contact",
      section: "header",
      mandatory: true,
      text: "x",
      covers: [],
      order: 0,
    },
    {
      id: "s1",
      section: "summary",
      pool: "summary",
      text: "s",
      covers: ["A"],
      contextual: true,
      order: 1,
    },
    {
      id: "b1",
      section: "experience",
      text: "0123456789",
      covers: [],
      contextual: true,
      order: 2,
    },
    {
      id: "g1",
      section: "skills",
      pool: "skills",
      text: "Group: Z",
      covers: [],
      order: 3,
    },
    {
      id: "g2",
      section: "skills",
      pool: "skills",
      text: "Group: Y",
      covers: [],
      order: 4,
    },
  ]
  const mustUse = new Map([["A", true]])
  // Budget: contact 1 + summary 1 + floor group 8 = 10; leave room for exactly
  // one more 10-char item — the bullet comes first in profile order.
  const { chosen, dropped: dr } = selectItems(items, mustUse, 20)
  assert.equal(chosen.get("b1")?.how, "fill")
  assert.ok(
    !chosen.has("g2"),
    "the second zero-score group waited its turn and lost",
  )
  assert.match(
    dr.find((d) => d.id === "g2").reason,
    /lists nothing the posting asked for/,
  )
})

// --- (f) determinism ---------------------------------------------------------

test("assembly is deterministic across variants — same inputs, same bytes", () => {
  for (const slug of ["react-frontend", "cloud-platform", "python-data"]) {
    const a = assemble(slug)
    const b = assemble(slug)
    assert.equal(a.markdown, b.markdown)
    assert.deepEqual(a.selection, b.selection)
  }
})

// --- (g) rule 0: an instruction payload cannot steer the choice ---------------

test("a hostile posting cannot steer which variant is chosen", () => {
  // fullstack-hostile carries a payload asking for Kubernetes and Terraform —
  // summary-cloud's exact terms. sanitizeUntrusted removes it before must_use
  // exists, so the choice is identical to the clean posting's and cloud loses.
  const hostile = assemble("fullstack-hostile")
  const clean = assemble("fullstack-hostile-clean")
  assert.equal(hostile.markdown, clean.markdown)
  assert.equal(hostile.selection.summary_choice.chosen, "summary-web")
  assert.equal(
    hostile.selection.summary_choice.ranked.find(
      (v) => v.id === "summary-cloud",
    ).score,
    0,
    "the payload's terms never reached the score",
  )
})

// --- (h) every fact accounted for exactly once --------------------------------

test("every profile fact appears exactly once across included, dropped, not_emitted", () => {
  const { selection } = assemble("python-data")
  const seen = [
    ...selection.included.map((i) => i.id),
    ...selection.dropped.map((d) => d.id),
    ...selection.not_emitted.map((n) => n.id),
  ]
  assert.equal(new Set(seen).size, seen.length, "a fact id appears twice")
  const unaccounted = [...factIndex.keys()].filter(
    (id) => !seen.includes(id) && id !== "__contact",
  )
  assert.deepEqual(unaccounted, [])
})

// --- (i) the refusal guards a CHOICE: zero or one variant never refuses -------

test("a single variant is always carried, whatever it scores", () => {
  const one = { ...profile, summary: [profile.summary[4]] } // tutor: scores 0
  const { markdown, selection } = assemble("cloud-platform", GOLDEN_BUDGET, one)
  assert.ok(markdown.includes("fact:summary-tutor"))
  assert.match(
    included(selection, "summary-tutor").reason,
    /the only summary variant — carried for every posting/,
  )
})

test("no variants at all is not a refusal — there is just no Summary section", () => {
  const none = { ...profile, summary: [] }
  const { markdown, selection } = assemble(
    "cloud-platform",
    GOLDEN_BUDGET,
    none,
  )
  assert.ok(!/## Summary/.test(markdown))
  assert.equal(selection.summary_choice.chosen, null)
})

// --- the diff shows the choice ------------------------------------------------

test("the selection diff states which variant was chosen and how the others scored", () => {
  const { selection } = assemble("cloud-platform")
  const text = formatSelectionDiff(selection)
  assert.match(text, /^SUMMARY {3}summary-cloud chosen \(scored 8: /m)
  assert.match(text, /summary-web 0/)
  assert.match(text, /summary-tutor 0/)
})
