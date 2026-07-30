// The per-job keyword plan, and the evidence rule it shares with verify-claims.
//
// The invariant that matters: `must_use` is the INTERSECTION of the posting and
// the fact base. Every term in it is already true of the user, so placing it in
// a resume invents nothing. If must_use could ever contain a term R6 would
// reject, this script would be quietly steering the tailoring step into lying.
import test from "node:test"
import assert from "node:assert/strict"
import {
  buildPlan,
  titleMirror,
  cleanTitle,
  placementFor,
  SUMMARY_SLOTS,
  DENSITY_CAP,
} from "../../scripts/documents/keyword-plan.mjs"
import { evidenceText, techTermsIn } from "../../scripts/lib/lib.mjs"

const PROFILE_BLOB =
  "Skills: React, Node.js, TypeScript, PostgreSQL, AWS, Docker, Git. " +
  "Built web applications and automated testing pipelines."

// Mirrors the real docs/application-limits.yaml roles.title_keywords, so a
// mirroring test cannot pass or fail for the wrong reason.
const TARGETS = ["full stack", "back-end", "software engineer", "web developer"]

const job = (over = {}) => ({
  slug: "acme-fs",
  company: "Acme",
  title: "Full Stack Developer",
  description:
    "Requirements: React, Node.js, TypeScript, PostgreSQL, Kubernetes, Scala.",
  ...over,
})

// --- the core invariant ------------------------------------------------------

test("must_use only ever contains terms the fact base backs", () => {
  const plan = buildPlan({
    job: job(),
    profileBlob: PROFILE_BLOB,
    targets: TARGETS,
  })
  for (const m of plan.must_use) {
    assert.ok(
      new RegExp(m.skill.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(
        PROFILE_BLOB,
      ) || techTermsIn(PROFILE_BLOB).includes(m.skill),
      `${m.skill} is in must_use but not evidenced`,
    )
  }
})

test("posting-only technologies land in blocked, never in must_use", () => {
  const plan = buildPlan({
    job: job(),
    profileBlob: PROFILE_BLOB,
    targets: TARGETS,
  })
  const use = plan.must_use.map((m) => m.skill)
  const blocked = plan.blocked.map((b) => b.skill)
  assert.ok(use.includes("React"))
  assert.ok(blocked.includes("Kubernetes"))
  assert.ok(blocked.includes("Scala"))
  assert.ok(!use.includes("Kubernetes"))
})

test("a blocked term carries the command that would unlock it", () => {
  const plan = buildPlan({
    job: job(),
    profileBlob: PROFILE_BLOB,
    targets: TARGETS,
  })
  const k = plan.blocked.find((b) => b.skill === "Kubernetes")
  assert.match(k.fix, /save-answer\.mjs/)
  assert.match(k.why, /R6/)
})

test("a posting the profile fully covers blocks nothing", () => {
  const plan = buildPlan({
    job: job({ description: "Requirements: React, Node.js, TypeScript." }),
    profileBlob: PROFILE_BLOB,
    targets: TARGETS,
  })
  assert.deepEqual(plan.blocked, [])
})

// --- placement ---------------------------------------------------------------

test("required matches get the scarce SUMMARY slots, others go to SKILLS", () => {
  const plan = buildPlan({
    job: job(),
    profileBlob: PROFILE_BLOB,
    targets: TARGETS,
  })
  const summary = plan.must_use.filter((m) => m.placement.includes("SUMMARY"))
  assert.ok(summary.length <= SUMMARY_SLOTS, "summary must not be stuffed")
  assert.ok(
    summary.every((m) => m.required),
    "only required terms earn a slot",
  )
})

test("placementFor keeps non-required terms out of the summary", () => {
  assert.equal(placementFor("React", { required: false, index: 0 }), "SKILLS")
  assert.match(placementFor("React", { required: true, index: 0 }), /SUMMARY/)
  assert.equal(
    placementFor("React", { required: true, index: SUMMARY_SLOTS }),
    "SKILLS",
  )
})

test("a density cap is published so nothing gets repeated into stuffing", () => {
  const plan = buildPlan({
    job: job(),
    profileBlob: PROFILE_BLOB,
    targets: TARGETS,
  })
  assert.equal(plan.density_cap, DENSITY_CAP)
  assert.ok(DENSITY_CAP <= 3)
})

test("both acronym and expanded ATS forms are supplied", () => {
  const plan = buildPlan({
    job: job({ description: "Requirements: continuous integration, React." }),
    profileBlob: PROFILE_BLOB + " CI/CD GitHub Actions",
    targets: TARGETS,
  })
  const cicd = plan.must_use.find((m) => m.skill === "CI/CD")
  assert.ok(cicd, "CI/CD should be matched")
  assert.ok(cicd.ats_forms.length > 1, "needs acronym AND expansion")
})

// --- title mirroring ---------------------------------------------------------

test("a title inside the target roles may be mirrored", () => {
  const t = titleMirror("Full Stack Developer", TARGETS)
  assert.equal(t.mirror, "Full Stack Developer")
  assert.equal(t.supported_by, "full stack")
})

test("a title outside the target roles must NOT be mirrored", () => {
  // Mirroring "Machine Learning Engineer" would be claiming to be one.
  const t = titleMirror("Machine Learning Engineer", TARGETS)
  assert.equal(t.mirror, null)
  assert.match(t.note, /do NOT mirror/)
})

test("stripping a level never leaves punctuation debris behind", () => {
  // Each of these produced a broken mirror: "Sr." left a leading period,
  // "- Level 2" left a dangling "- Level", and a single roman numeral was not
  // recognised as a level at all.
  const cases = [
    ["Sr. Software Engineer", "Software Engineer"],
    ["Jr. Web Developer", "Web Developer"],
    ["Full Stack Developer - Level 2", "Full Stack Developer"],
    ["Software Engineer I", "Software Engineer"],
    ["Software Engineer 3", "Software Engineer"],
    ["Staff Software Engineer, Platform", "Software Engineer, Platform"],
  ]
  for (const [raw, want] of cases) {
    assert.equal(titleMirror(raw, TARGETS).mirror, want, `from "${raw}"`)
  }
})

test("a title that is nothing but level words yields no mirror", () => {
  // "Engineer II" cleans to "Engineer", too thin to put in a summary as a
  // claim about the kind of work done.
  assert.equal(titleMirror("Engineer II", TARGETS).mirror, null)
})

test("cleanTitle does not eat digits that are part of a word", () => {
  // "Web3" has no word boundary between "b" and "3".
  assert.equal(cleanTitle("Web3 Developer"), "Web3 Developer")
  assert.equal(cleanTitle("S3 Storage Engineer"), "S3 Storage Engineer")
})

test("cleanTitle leaves lowercase i and v alone", () => {
  // Roman-numeral stripping is case-SENSITIVE on purpose: a case-insensitive
  // version eats the "i" out of ordinary words.
  assert.equal(cleanTitle("Vision Developer"), "Vision Developer")
  assert.equal(cleanTitle("iOS Developer"), "iOS Developer")
})

test("seniority words are stripped from a mirrored title", () => {
  // Mirroring must not smuggle in a level the user has not reached.
  assert.equal(
    titleMirror("Senior Full Stack Developer", TARGETS).mirror,
    "Full Stack Developer",
  )
  assert.equal(
    titleMirror("Full Stack Developer II", TARGETS).mirror,
    "Full Stack Developer",
  )
})

test("an empty title does not throw", () => {
  assert.doesNotThrow(() => titleMirror(undefined, TARGETS))
  assert.equal(titleMirror("", TARGETS).mirror, null)
})

// --- coverage numbers --------------------------------------------------------

test("coverage reports required matched out of required total", () => {
  const plan = buildPlan({
    job: job(),
    profileBlob: PROFILE_BLOB,
    targets: TARGETS,
  })
  assert.equal(plan.coverage.required_matched, 4)
  assert.equal(plan.coverage.required_terms, 6)
})

test("a job with no description produces an empty but valid plan", () => {
  const plan = buildPlan({
    job: { title: "Full Stack Developer" },
    profileBlob: PROFILE_BLOB,
    targets: TARGETS,
  })
  assert.deepEqual(plan.must_use, [])
  assert.deepEqual(plan.blocked, [])
  assert.equal(plan.coverage.posting_terms, 0)
})

// --- the shared evidence rule ------------------------------------------------

test("a form question enumerating technologies is NOT evidence", () => {
  // The live bug this closed: answers.yaml a-030 is a multi-select question
  // listing "4 = Spring / Spring Boot; 5 = Cloud Technologies (AWS, Azure, or
  // GCP)", answered "1, 2, 3, 5". The raw file as corpus made BOTH Azure and
  // Spring pass verify-claims R6 — including Spring, which was explicitly not
  // selected. A resume could have claimed either.
  const answers = {
    answers: [
      {
        question:
          "Which technical areas do you have experience with? [4 = Spring / Spring Boot; 5 = Cloud (AWS, Azure, or GCP)]",
        answer: "1, 2, 3, 5",
      },
    ],
  }
  const terms = techTermsIn(evidenceText("Skills: React, Node.js", answers))
  assert.ok(!terms.includes("Azure"), "Azure must not become claimable")
  assert.ok(!terms.includes("Spring"), "Spring must not become claimable")
  assert.ok(terms.includes("React"), "the profile itself still counts")
})

test("a question answered YES does evidence what it asked about", () => {
  const answers = {
    answers: [
      {
        question: "Do you have hands-on experience with Kubernetes?",
        answer: "Yes",
      },
    ],
  }
  assert.ok(techTermsIn(evidenceText("", answers)).includes("Kubernetes"))
})

test("a question answered NO does not evidence what it asked about", () => {
  const answers = {
    answers: [
      {
        question: "Do you have hands-on experience with Kubernetes?",
        answer: "No",
      },
    ],
  }
  assert.ok(!techTermsIn(evidenceText("", answers)).includes("Kubernetes"))
})

test("free-text answers are always evidence", () => {
  const answers = {
    answers: [
      {
        question: "Describe your stack.",
        answer: "Mostly TypeScript and Docker.",
      },
    ],
  }
  const terms = techTermsIn(evidenceText("", answers))
  assert.ok(terms.includes("TypeScript"))
  assert.ok(terms.includes("Docker"))
})

test("evidenceText tolerates missing and malformed answer records", () => {
  assert.doesNotThrow(() => evidenceText("x", null))
  assert.doesNotThrow(() =>
    evidenceText("x", { answers: [null, {}, { answer: 5 }] }),
  )
})
