import test from "node:test"
import assert from "node:assert/strict"
import http from "node:http"
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
  fetchJson,
  fetchText,
  FETCH_TIMEOUT_MS,
} from "../../src/lib/lib.mjs"

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

// --- casing: R6's case-shaped hole, and the trap in closing it ---------------
//
// techTermsIn had no "i" flag, so the truthfulness gate could only see a
// technology written with the exact casing in the lexicon. A lowercase
// invention produced zero R6 violations and exit 0.

test("techTermsIn sees a lowercase technology claim", () => {
  const found = techTermsIn("Built with kubernetes and terraform")
  assert.ok(found.includes("Kubernetes"), JSON.stringify(found))
  assert.ok(found.includes("Terraform"), JSON.stringify(found))
  // Mis-cased spellings the writer is told to fix are still claims, not typos
  // R6 gets to ignore.
  for (const [text, term] of [
    ["we run postgres in prod", "Postgres"],
    ["shipped with DOCKER and mysql", "Docker"],
    ["javascript everywhere", "JavaScript"],
  ]) {
    assert.ok(techTermsIn(text).includes(term), `${text} -> ${term}`)
  }
})

test("techTermsIn does not read ordinary English as a technology claim", () => {
  // The reason the "i" flag cannot be applied to every term. Each word below is
  // a surface form in the lexicon AND an everyday word; a blanket flag turns
  // honest prose into an R6 failure, and a gate that fails truthful documents
  // gets muted. TECH_LEXICON's header recorded six such false positives out of
  // nine probes when `surface` was folded into the posting-side matcher.
  const honest = [
    "Decisions had to go through legal, so the rest of the team could react to feedback in the spring without express approval.",
    "Team unity helped spark a swift, agile response; nothing went off the rails and the report came back prettier.",
    "I kept a restful weekend, ran the bootstrap script by hand, and shipped an angular redesign of the shell company's brochure.",
  ]
  for (const sentence of honest) {
    assert.deepEqual(techTermsIn(sentence), [], sentence)
  }
})

test("the longest-first suppression survives case-insensitive matching", () => {
  // "React Native" must not also report "React", whichever way it is written.
  // The blanking step used a literal replaceAll, which does not remove a term
  // that matched case-insensitively.
  assert.deepEqual(techTermsIn("shipped a React Native app"), ["React Native"])
  assert.deepEqual(techTermsIn("shipped a react native app"), ["React Native"])
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

// Regression. The organizations line read `org.name`, but the schema defines
// `org.text`, so every organization fact indexed as the literal string
// "undefined". Nothing caught it: the fixture profiles all had
// `organizations: []`, and String(undefined) is a perfectly good string. The
// damage was downstream — a true bullet citing an organization failed R3,
// because the number it quoted was "not present in" a fact that had no text.
test("buildFactIndex indexes an organization by its text, not a missing name", () => {
  const profile = {
    organizations: [{ id: "org-honor", text: "Honor Society, member 2021." }],
  }
  const idx = buildFactIndex(profile, { answers: [] })
  assert.equal(idx.get("org-honor").text, "Honor Society, member 2021.")
  assert.ok(
    [...extractNumbers(idx.get("org-honor").text)].includes("2021"),
    "the year in an organization fact must survive into the index",
  )
})

test("fixture profile's organization fact carries its real text", () => {
  const profile = loadYamlFile(path.join(FIX, "profile.yaml"))
  const idx = buildFactIndex(profile, { answers: [] })
  for (const id of ["org-honor", "extra-clearance"]) {
    assert.ok(idx.has(id), `missing ${id}`)
    assert.notEqual(idx.get(id).text, "undefined")
  }
})

// The guard that makes the whole class of bug loud instead of silent.
test("buildFactIndex throws when a section field name does not exist", () => {
  assert.throws(
    () => buildFactIndex({ organizations: [{ id: "org-x" }] }, { answers: [] }),
    /Fact org-x has no text/,
  )
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

// --- fetch timeouts ---------------------------------------------------------
//
// Neither fetcher carried a signal, so a board that accepted the connection and
// never answered held one of mapPool's eight workers until the OS gave up on the
// socket. Measured before the fix: a loopback server that accepts and never
// replies was still hanging after 8s.
//
// Loopback only, ephemeral port, same rule as tests/fixtures/boards/server.mjs
// — a test fixture must not be able to reach anyone.

/** A 127.0.0.1 server whose handler decides what (if anything) to answer. */
async function loopback(t, handler) {
  const server = http.createServer(handler)
  await new Promise((r) => server.listen(0, "127.0.0.1", r))
  t.after(
    () =>
      new Promise((done) => {
        // A hung request holds its socket open, so close() alone would never
        // finish and the suite would hang on the very thing being tested.
        server.closeAllConnections?.()
        server.close(() => done())
      }),
  )
  return `http://127.0.0.1:${server.address().port}`
}

test("a board that never answers aborts within the timeout", async (t) => {
  const base = await loopback(t, () => {
    /* accept the request and never respond */
  })
  for (const [label, call] of [
    ["fetchJson", () => fetchJson(`${base}/jobs`, null, { timeoutMs: 300 })],
    ["fetchText", () => fetchText(`${base}/jobs`, { timeoutMs: 300 })],
  ]) {
    const started = Date.now()
    const err = await call().then(
      () => null,
      (e) => e,
    )
    const took = Date.now() - started
    assert.ok(err, `${label} resolved against a server that never answered`)
    assert.ok(took < 3000, `${label} took ${took}ms for a 300ms budget`)
    // The SHAPE callers already handle: find-jobs.mjs stores `e.message` as the
    // board's failure and enrich.mjs flags the lead — a slow board must cost one
    // board, not the sweep, and must not surface as a raw DOMException.
    assert.ok(
      err instanceof Error,
      `${label} threw a ${err?.constructor?.name}`,
    )
    assert.match(err.message, /timeout after 300ms/)
    assert.match(err.message, /127\.0\.0\.1/)
  }
})

test("the timeout covers the body, not just the headers", async (t) => {
  // A board that says 200 OK and then stalls mid-JSON is the same hang.
  const base = await loopback(t, (_req, res) => {
    res.writeHead(200, { "content-type": "application/json" })
    res.write("{")
  })
  const started = Date.now()
  await assert.rejects(
    fetchJson(`${base}/jobs`, null, { timeoutMs: 300 }),
    /timeout after 300ms/,
  )
  assert.ok(Date.now() - started < 3000)
})

test("a healthy board is untouched and an HTTP error keeps its own message", async (t) => {
  // The boundary the timeout must not cross: normal responses still resolve,
  // and a 404 is still reported as a 404 rather than as a timeout.
  const base = await loopback(t, (req, res) => {
    if (req.url === "/gone") {
      res.writeHead(404)
      return res.end("no")
    }
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ jobs: [{ id: 1 }] }))
  })
  assert.deepEqual(await fetchJson(`${base}/jobs`), { jobs: [{ id: 1 }] })
  assert.equal(await fetchText(`${base}/jobs`), '{"jobs":[{"id":1}]}')
  await assert.rejects(fetchJson(`${base}/gone`), /HTTP 404/)
  // The default exists and is well short of the OS socket timeout.
  assert.equal(FETCH_TIMEOUT_MS, 15000)
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
