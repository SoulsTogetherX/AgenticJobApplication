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
  textSnippet,
  evidenceText,
  questionEvidence,
  validateContext,
  validateJob,
} from "../../scripts/lib/lib.mjs"

// fixtures/ stays at the tests/ root, shared by every group.
const FIX = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
)

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

// --- what may be treated as EVIDENCE ----------------------------------------
//
// This is the corpus verify-claims R6 checks a document's tech terms against,
// so anything that gets in here is a claim the user's resume is allowed to
// make. answers.yaml stores the employer's QUESTION beside the user's answer,
// and the employer writes the question.

test("an answer's own text is always evidence", () => {
  const ev = evidenceText("profile text", {
    answers: [{ question: "What do you use?", answer: "React and PostgreSQL" }],
  })
  assert.ok(techTermsIn(ev).includes("React"))
  assert.ok(techTermsIn(ev).includes("PostgreSQL"))
})

test("a question only becomes evidence when the answer is an unambiguous yes", () => {
  const enumerated = evidenceText("", {
    answers: [
      {
        question:
          "Which of these do you have experience with? [1 = REST APIs; 4 = Spring / Spring Boot; 5 = Cloud (AWS, Azure, or GCP)]",
        answer: "1, 2, 3, 5",
      },
    ],
  })
  // The bug this rule exists for: "1, 2, 3, 5" evidences nothing but itself,
  // and Spring was a box the user explicitly did NOT tick.
  for (const t of ["Spring", "Azure", "GCP", "AWS"]) {
    assert.ok(!techTermsIn(enumerated).includes(t), `${t} leaked into evidence`)
  }

  const plain = evidenceText("", {
    answers: [
      { question: "Do you have experience with React?", answer: "Yes" },
    ],
  })
  assert.ok(techTermsIn(plain).includes("React"))
})

test("a yes never evidences more than one technology at a time", () => {
  // "all three? any one?" — an ambiguous yes must not become evidence. The
  // user can always record each skill outright with save-answer.mjs.
  const ev = evidenceText("", {
    answers: [
      { question: "Experience with React, Vue and Angular?", answer: "Yes" },
    ],
  })
  for (const t of ["React", "Vue", "Angular"])
    assert.ok(!techTermsIn(ev).includes(t))
})

test("a yes evidences the question that was ASKED, not what follows it", () => {
  // The hole the parenthetical rule left open. Drop the brackets, name exactly
  // one technology, and both earlier guards are satisfied — so a single "Yes"
  // about work authorisation whitelists Kubernetes permanently, for every
  // future application, on a document signed with the user's name.
  const hostile = [
    "Authorized to work in the US? This role uses Kubernetes.",
    "Are you legally authorized to work in the United States? (Our stack is Kubernetes, Terraform and Rust.)",
    "Can you start within 30 days. The team runs Kubernetes.",
  ]
  for (const question of hostile) {
    const ev = evidenceText("", { answers: [{ question, answer: "Yes" }] })
    assert.ok(
      !techTermsIn(ev).includes("Kubernetes"),
      `"${question}" whitelisted Kubernetes`,
    )
  }
})

test("questionEvidence keeps an honest single-subject question intact", () => {
  // The narrowing must not cost the legitimate case, which is the exact shape
  // keyword-coverage.mjs tells the user to run.
  assert.match(
    questionEvidence("Do you have hands-on experience with Docker?"),
    /Docker/,
  )
  // A dot inside a tech term is not a sentence break.
  assert.match(
    questionEvidence("Do you have hands-on experience with Node.js"),
    /Node\.js/,
  )
  // A number in the asked clause is still evidence — "Engineer II" and "5
  // years" are legitimately carried by a question.
  assert.match(questionEvidence("Do you have 5 years of experience?"), /5/)
})

test("textSnippet still preserves block boundaries", () => {
  // Pinned here as well as in tests/leads/, because untrusted.mjs now calls
  // textSnippet at ingest and a regression would be blamed on the sanitiser.
  // The L2 fit stage found a requirements heading in 0 of 92 stored leads when
  // this was wrong.
  assert.equal(
    textSnippet("<p>About us.</p><h3>Requirements</h3><ul><li>React</li></ul>"),
    "About us.\nRequirements\nReact",
  )
  assert.equal(textSnippet("the <b>fast</b> path"), "the fast path")
  assert.equal(textSnippet("one<br>two"), "one\ntwo")
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
