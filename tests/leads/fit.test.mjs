// L2 — profile fit. This stage REJECTS (user decision 2026-07-29), so most of
// what follows is about the cases where it must NOT: a job the user never sees
// is the worst failure this pipeline has.
import test from "node:test"
import assert from "node:assert/strict"
import {
  scoreFit,
  splitRequirements,
  seniorScopeSignals,
  isEvaluable,
  FIT_DEFAULTS,
} from "../../src/leads/fit.mjs"

const PROFILE = new Set([
  "React",
  "Node.js",
  "TypeScript",
  "JavaScript",
  "Python",
  "AWS",
  "PostgreSQL",
  "Docker",
  "Git",
])

// --- section splitting -------------------------------------------------------

test("splits required from preferred in flat, single-line text", () => {
  // The stored form: textSnippet output for older leads has no newlines at all,
  // and a line-anchored splitter found a heading in 0 of 92 real leads.
  const flat =
    "About the role. Minimum Qualifications: 3+ years with React and Node.js. Preferred Qualifications: Kubernetes and Go. Benefits: health, dental."
  const p = splitRequirements(flat)
  assert.match(p.required, /React and Node\.js/)
  assert.match(p.preferred, /Kubernetes/)
  assert.ok(
    !/Kubernetes/.test(p.required),
    "preferred tech leaked into required",
  )
})

test("splits required from preferred in structured text", () => {
  const p = splitRequirements(
    "About us.\nMinimum Qualifications\n3+ years React\nNode.js\nPreferred Qualifications\nKubernetes",
  )
  assert.match(p.required, /React/)
  assert.equal(p.preferred.trim(), "Kubernetes")
})

test("'gathering requirements' in prose does not start a requirements section", () => {
  // The motivating false positive: that phrase is a RESPONSIBILITY, and
  // treating it as a heading scores the job against the wrong half of its own
  // description. Weak single-word headings need punctuation to count.
  const p = splitRequirements(
    "You will be gathering requirements from stakeholders and shipping features.",
  )
  assert.equal(p.required, "", "prose must not open a required section")
})

test("a weak heading with a colon does count", () => {
  const p = splitRequirements("Requirements: React, Node.js, and SQL.")
  assert.match(p.required, /React/)
})

test("'Preferred Qualifications' is not also read as weak 'Qualifications'", () => {
  // Overlapping matches: the strong preferred heading must win, or the section
  // flips to required and the nice-to-haves get scored against the profile.
  const p = splitRequirements(
    "Qualifications: React. Preferred Qualifications: Kubernetes.",
  )
  assert.match(p.required, /React/)
  assert.match(p.preferred, /Kubernetes/)
  assert.ok(!/Kubernetes/.test(p.required))
})

test("text with no headings at all is all general", () => {
  const p = splitRequirements("We build web apps with React and Node.js.")
  assert.equal(p.required, "")
  assert.match(p.general, /React/)
})

test("an 'other' heading closes the required section", () => {
  const p = splitRequirements(
    "Requirements: React and Node.js. Benefits: unlimited PTO and Kubernetes-themed socks.",
  )
  assert.match(p.required, /React/)
  assert.ok(!/socks/.test(p.required), "benefits text leaked into required")
})

// --- senior scope ------------------------------------------------------------

test("senior scope phrases are detected", () => {
  assert.ok(seniorScopeSignals("You will own the technical roadmap.").length)
  assert.ok(seniorScopeSignals("Mentor junior engineers on the team.").length)
  assert.ok(seniorScopeSignals("Define the system architecture.").length)
})

test("ordinary collaboration language is not senior scope", () => {
  for (const s of [
    "Collaborate with the team on features.",
    "Work with designers and product managers.",
    "Participate in code review.",
    "Contribute to the roadmap discussion.",
  ]) {
    assert.deepEqual(seniorScopeSignals(s), [], `false senior signal in: ${s}`)
  }
})

// --- the reject guard --------------------------------------------------------

const job = (description) => ({ title: "Software Engineer", description })

test("a thin description can NEVER be rejected, however low the overlap", () => {
  // The single most important guard in the stage. Fewer named technologies
  // than min_required_terms means "unevaluated", not "bad match".
  const r = scoreFit(job("Requirements: Cobol."), PROFILE)
  assert.ok(r.ok, "a 1-technology posting must not be rejected")
  assert.ok(
    r.flags.includes("posting_thin"),
    "a SHORT unreadable body is posting_thin",
  )
  assert.ok(!r.flags.includes("lexicon_blind"))
  assert.ok(
    !r.flags.includes("fit_thin"),
    "fit_thin was split, not kept as an alias",
  )
  assert.ok(r.required_terms.length < FIT_DEFAULTS.min_required_terms)
})

test("an empty description passes and is flagged unknown", () => {
  const r = scoreFit(job(""), PROFILE)
  assert.ok(r.ok)
  assert.ok(r.flags.includes("fit_unknown"))
  assert.equal(r.fit_score, null)
})

// --- posting_thin vs lexicon_blind (retarget-readiness audit, 2026-08) ------

test("a LONG required section the lexicon cannot read is lexicon_blind, not posting_thin", () => {
  // A retarget's real signature: plenty of stated requirements, none of them
  // in this (software) lexicon. Nursing vocabulary, padded well past
  // long_body_chars (2000) with no boilerplate section headers that would
  // pull any of it out of "required".
  const nursingReq =
    "Requirements: Active RN license in good standing, BLS and ACLS certification, minimum three years acute care experience, demonstrated competency in medication administration and IV therapy, strong charting and patient assessment skills, experience with electronic health records, ability to work rotating twelve hour shifts including nights and weekends, current CPR certification, telemetry monitoring experience preferred. "
  const long = nursingReq.repeat(Math.ceil(2100 / nursingReq.length))
  assert.ok(long.length >= 2000, "fixture must clear long_body_chars")
  const r = scoreFit(job(long), PROFILE)
  assert.ok(r.ok, "still never rejected on thin evidence")
  assert.ok(r.required_terms.length < FIT_DEFAULTS.min_required_terms)
  assert.ok(r.flags.includes("lexicon_blind"))
  assert.ok(!r.flags.includes("posting_thin"))
})

test("a known-partial capture is posting_thin even when long, never lexicon_blind", () => {
  // job.partial_description means we already KNOW the text is a fragment
  // (screen.mjs sets it for every lead with no full captured posting — every
  // Adzuna lead, which only ever returns a teaser). Blaming the lexicon for a
  // body we know is incomplete would be a false claim, whatever its length.
  const nursingReq =
    "Requirements: Active RN license, BLS certification, acute care experience, medication administration, patient assessment, electronic health records, rotating shift availability. "
  const long = nursingReq.repeat(Math.ceil(2100 / nursingReq.length))
  const r = scoreFit(
    { title: "RN", description: long, partial_description: true },
    PROFILE,
  )
  assert.ok(r.ok)
  assert.ok(r.flags.includes("posting_thin"))
  assert.ok(!r.flags.includes("lexicon_blind"))
})

test("long_body_chars is configurable via limits.fit", () => {
  const shortish = "Requirements: knowledge of widgets and gadgets and gizmos."
  const r = scoreFit(job(shortish), PROFILE, {
    limits: { fit: { long_body_chars: 10 } },
  })
  assert.ok(
    r.flags.includes("lexicon_blind"),
    "a lowered threshold reclassifies it",
  )
})

// --- isEvaluable — the exported predicate w4-autonomy's fitSortKey ---------
// (automatability.mjs, 52d432b) had to recompute for itself before this
// existed. Structural, reads no flag name, so it cannot disagree with
// scoreFit's OWN evaluable computation.

test("isEvaluable is false for a thin (either flavour) result", () => {
  assert.equal(
    isEvaluable(scoreFit(job("Requirements: Cobol."), PROFILE)),
    false,
  )
  const nursingReq =
    "Requirements: Active RN license, BLS certification, acute care experience, medication administration, patient assessment, electronic health records, rotating shift availability. "
  const long = nursingReq.repeat(Math.ceil(2100 / nursingReq.length))
  assert.equal(isEvaluable(scoreFit(job(long), PROFILE)), false)
})

test("isEvaluable is false for an empty/unknown body", () => {
  assert.equal(isEvaluable(scoreFit(job(""), PROFILE)), false)
})

test("isEvaluable is true once required_terms clears the threshold", () => {
  const r = scoreFit(
    job("Requirements: React, Node.js, TypeScript, PostgreSQL."),
    PROFILE,
  )
  assert.equal(r.required_terms.length >= FIT_DEFAULTS.min_required_terms, true)
  assert.equal(isEvaluable(r), true)
})

test("isEvaluable honours a caller-supplied min_required_terms, never a literal", () => {
  const r = scoreFit(
    job("Requirements: React, Node.js, TypeScript, PostgreSQL."),
    PROFILE,
  )
  // 4 terms clears the default (4) but not a stricter caller threshold.
  assert.equal(
    isEvaluable(r, { limits: { fit: { min_required_terms: 5 } } }),
    false,
  )
})

test("isEvaluable handles null/undefined without throwing", () => {
  assert.equal(isEvaluable(null), false)
  assert.equal(isEvaluable(undefined), false)
})

test("a genuine stack mismatch with enough evidence is rejected", () => {
  const r = scoreFit(
    job(
      "Requirements: Scala, Kafka, Spark, Hadoop, Elasticsearch, and Kubernetes.",
    ),
    PROFILE,
  )
  assert.equal(r.ok, false)
  assert.match(r.reasons[0], /stack mismatch/)
  assert.ok(r.fit_score < FIT_DEFAULTS.reject_below)
})

test("a matching stack passes with a high score", () => {
  const r = scoreFit(
    job("Requirements: React, Node.js, TypeScript, PostgreSQL, and AWS."),
    PROFILE,
  )
  assert.ok(r.ok)
  assert.equal(r.fit_score, 1)
  assert.deepEqual(r.missing_terms, [])
})

test("technologies under 'nice to have' never count against the profile", () => {
  // Most postings list an aspirational preferred section. Scoring against it
  // rejects jobs the user could do.
  const r = scoreFit(
    job(
      "Minimum Qualifications: React, Node.js, TypeScript, PostgreSQL. " +
        "Preferred Qualifications: Kubernetes, Terraform, Scala, Kafka, Rust, Go.",
    ),
    PROFILE,
  )
  assert.ok(r.ok, "preferred-only tech must not reject")
  assert.equal(r.fit_score, 1)
  assert.ok(r.preferred_terms.includes("Kubernetes"))
  assert.ok(!r.required_terms.includes("Kubernetes"))
})

test("senior scope alone never rejects", () => {
  // Mid-level postings borrow this language freely.
  const r = scoreFit(
    job(
      "You will own the technical roadmap, mentor junior engineers, define the system architecture and set technical standards. " +
        "Requirements: React, Node.js, TypeScript, PostgreSQL, AWS.",
    ),
    PROFILE,
  )
  assert.ok(r.ok, "a strong stack match must survive senior language")
  assert.ok(r.flags.includes("senior_scope"), "but it should still be flagged")
})

test("senior scope PLUS a weak stack match rejects", () => {
  const r = scoreFit(
    job(
      "You will own the technical roadmap, mentor junior engineers, and define the system architecture. " +
        "Requirements: Scala, Kafka, Spark, Rust, React.",
    ),
    PROFILE,
  )
  assert.equal(r.ok, false)
  assert.match(r.reasons[0], /senior-scope/)
})

test("a middling overlap is flagged weak, not rejected", () => {
  const r = scoreFit(
    job("Requirements: React, Node.js, Kubernetes, Terraform, Scala, Kafka."),
    PROFILE,
  )
  assert.ok(r.ok)
  assert.ok(r.flags.includes("fit_weak"))
})

test("thresholds are overridable from the limits file", () => {
  const body = job(
    "Requirements: React, Node.js, Kubernetes, Terraform, Scala, Kafka.",
  )
  assert.ok(scoreFit(body, PROFILE).ok, "passes at the default threshold")
  const strict = scoreFit(body, PROFILE, {
    limits: { fit: { reject_below: 0.9 } },
  })
  assert.equal(
    strict.ok,
    false,
    "a stricter threshold rejects the same posting",
  )
})

test("raising min_required_terms makes a posting unevaluable again", () => {
  // Four DETECTABLE terms. "Spark" alone is not one: its only alias is
  // "apache spark", because "spark innovation" is ordinary posting prose.
  const body = job("Requirements: Scala, Kafka, Hadoop, Elasticsearch.")
  assert.equal(scoreFit(body, PROFILE).ok, false)
  const lenient = scoreFit(body, PROFILE, {
    limits: { fit: { min_required_terms: 99 } },
  })
  assert.ok(lenient.ok, "the guard must be able to switch rejection off")
})

test("indexed keywords add evidence but never enlarge the required set", () => {
  // Indexed keywords come from the WHOLE posting. Letting them into the
  // required set would sneak preferred-section technologies back in.
  const r = scoreFit(
    job("Minimum Qualifications: React, Node.js, TypeScript, PostgreSQL."),
    PROFILE,
    { indexed: new Set(["Docker", "Kubernetes"]) },
  )
  assert.ok(!r.required_terms.includes("Kubernetes"))
  assert.ok(
    r.bonus_terms.includes("Docker"),
    "profile-matching extras reported",
  )
})

test("requirements array is scored alongside the description", () => {
  const r = scoreFit(
    {
      title: "Software Engineer",
      description: "Join our team.",
      requirements: ["Requirements: Scala, Kafka, Spark, Hadoop, Rust."],
    },
    PROFILE,
  )
  assert.equal(r.ok, false, "an imported lead's requirements array must count")
})
