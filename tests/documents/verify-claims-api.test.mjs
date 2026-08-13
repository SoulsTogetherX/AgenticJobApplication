// Phase 3 item 3.4: verify-claims.mjs is exported pure functions plus a thin
// CLI, and the fact index is built once per run.
//
// DELIBERATELY A SEPARATE FILE from tests/documents/verify-claims.test.mjs.
// That file is on the SECURITY gate's path list and it was not touched by the
// refactor — leaving it untouched is what makes its 28 passing tests evidence
// that the signature change preserved behaviour, rather than evidence that the
// tests were changed to match. This file covers only the new surface.
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import {
  loadFactContext,
  factContextFrom,
  verifyDocument,
  addressingFor,
  coverageFor,
} from "../../scripts/documents/verify-claims.mjs"

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
)
const FIX = path.join(ROOT, "tests", "fixtures")
const PROFILE = path.join(FIX, "profile.yaml")
const ANSWERS = path.join(FIX, "answers.yaml")

const ctx = () =>
  loadFactContext({ profilePath: PROFILE, answersPath: ANSWERS })
const GOOD = fs.readFileSync(path.join(FIX, "good-resume.md"), "utf8")

test("importing verify-claims.mjs runs nothing and exits nothing", () => {
  // The point of the refactor: before it, importing this module executed the
  // whole verifier against process.argv and called process.exit. That it can be
  // imported at all is what lets assemble-resume re-verify in-process instead
  // of spawning — which is what keeps child_process out of its import graph.
  const c = ctx()
  assert.ok(c.factIndex instanceof Map)
  assert.ok(c.factIndex.size > 5)
  assert.ok(c.corpusTech instanceof Set)
  assert.ok(c.corpusTech.has("React"))
})

test("the fact index is built once and reused across documents", () => {
  const c = ctx()
  const a = verifyDocument({ doc: GOOD, mode: "resume", ctx: c })
  const b = verifyDocument({ doc: GOOD, mode: "resume", ctx: c })
  assert.equal(a.ok, true, JSON.stringify(a.violations))
  assert.equal(b.ok, true)
  // Same object, both times — not a copy, not a rebuild.
  const before = c.factIndex
  verifyDocument({ doc: GOOD, mode: "resume", ctx: c })
  assert.equal(c.factIndex, before)
})

test("verifyDocument is pure — it writes nothing and never exits", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vc-api-"))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const before = fs.readdirSync(dir)
  verifyDocument({ doc: GOOD, mode: "resume", ctx: ctx() })
  assert.deepEqual(fs.readdirSync(dir), before)
})

test("verifyDocument catches the same violations the CLI does", () => {
  const c = ctx()
  const bad = fs.readFileSync(path.join(FIX, "bad-invented-number.md"), "utf8")
  const r = verifyDocument({ doc: bad, mode: "resume", ctx: c })
  assert.equal(r.ok, false)
  assert.ok(
    r.violations.some((v) => v.rule === "R3" && v.detail.includes("5000")),
  )

  const tech = fs.readFileSync(path.join(FIX, "bad-unknown-tech.md"), "utf8")
  const r2 = verifyDocument({ doc: tech, mode: "resume", ctx: c })
  assert.ok(r2.violations.some((v) => v.rule === "R6"))
})

test("addressing widens numbers and dates but never technology", () => {
  const c = ctx()
  const hostile = addressingFor({
    company: "Kubernetes Solutions LLC",
    title: "Engineer 7",
  })
  // A number from the title is accepted...
  const withNumber = verifyDocument({
    doc: "Some prose mentioning 7 things.\n\n- Built a customer portal in React and Node.js serving 1,200 users with 99.9% uptime. <!-- fact:exp-acme-b1 -->",
    mode: "resume",
    ctx: c,
    addressing: hostile,
  })
  assert.equal(
    withNumber.violations.filter((v) => v.rule === "R4").length,
    0,
    JSON.stringify(withNumber.violations),
  )
  // ...and a technology from the company name is NOT.
  const withTech = verifyDocument({
    doc: "- Ran Kubernetes in production. <!-- fact:exp-acme-b1 -->",
    mode: "resume",
    ctx: c,
    addressing: hostile,
  })
  assert.ok(
    withTech.violations.some(
      (v) => v.rule === "R6" && v.detail.includes("Kubernetes"),
    ),
    "a board-written company name authorised a claim",
  )
})

test("factContextFrom takes bytes, so a caller can verify against a fact base not on disk", () => {
  const c = factContextFrom({
    profileRaw: "summary:\n  - id: s1\n    text: Writes Go.\n",
    profile: { summary: [{ id: "s1", text: "Writes Go." }] },
    answers: { answers: [] },
  })
  assert.equal(c.factIndex.get("s1").text, "Writes Go.")
  assert.ok(c.corpusTech.has("Go"))
  const r = verifyDocument({
    doc: "- Writes Go. <!-- fact:s1 -->",
    mode: "resume",
    ctx: c,
  })
  assert.equal(r.ok, true, JSON.stringify(r.violations))
})

test("coverageFor reports placement without ever failing a document", () => {
  const plan = {
    must_use: [
      { skill: "React", required: true, ats_forms: ["React"] },
      { skill: "Kubernetes", required: true, ats_forms: ["Kubernetes", "K8s"] },
    ],
    blocked: [{ skill: "Terraform" }],
  }
  const cov = coverageFor(GOOD, plan)
  assert.equal(cov.must_use, 2)
  assert.equal(cov.placed, 1)
  assert.deepEqual(cov.missing, ["Kubernetes"])
  assert.deepEqual(cov.missing_required, ["Kubernetes"])
  assert.deepEqual(cov.used_blocked, [])
  // Coverage is reported on the verdict but is never part of it.
  const r = verifyDocument({ doc: GOOD, mode: "resume", ctx: ctx(), plan })
  assert.equal(r.ok, true)
  assert.equal(r.coverage.placed, 1)
})

// --- R6: what counts as the same claim --------------------------------------
//
// Two changes to the gate itself, and each has to be shown in BOTH directions,
// because R6 is the control hard rules 1 and 4 rest on.

/** A fact base whose only content is one sentence. */
const factBase = (text) =>
  factContextFrom({
    profileRaw: `summary:\n  - id: s1\n    text: ${text}\n`,
    profile: { summary: [{ id: "s1", text }] },
    answers: { answers: [] },
  })

const verdict = (profileText, docText) =>
  verifyDocument({
    doc: `- ${docText} <!-- fact:s1 -->`,
    mode: "resume",
    ctx: factBase(profileText),
  })

test("R6 accepts a sibling spelling of a skill the fact base evidences", () => {
  // AUDIT C3. docs/tailoring-rules.md §8 instructs "PostgreSQL not Postgres"
  // and checkWrittenForm() flags "Postgres" as a spelling to fix — so the rules
  // document, the linter and the plan all pushed the writer toward a spelling
  // the verifier then rejected with exit 1.
  for (const [profileForm, docForm] of [
    ["Postgres", "PostgreSQL"],
    ["Golang", "Go"],
    ["WebSocket", "WebSockets"],
    ["REST", "RESTful"],
    ["SCSS", "Sass"],
    ["Unix", "Linux"],
    ["Shell", "Bash"],
    ["Swagger", "OpenAPI"],
  ]) {
    const r = verdict(`Uses ${profileForm}.`, `Uses ${docForm}.`)
    assert.equal(
      r.ok,
      true,
      `profile "${profileForm}" + resume "${docForm}": ${JSON.stringify(r.violations)}`,
    )
  }
})

test("R6 still rejects a different technology under the same abstraction", () => {
  // The direction the obvious fix would have broken. Mapping every term through
  // its canonical SKILL would fold Testing's whole surface list — Jest, Vitest,
  // Mocha, Cypress, Playwright, Selenium, Puppeteer, pytest — into one claim, so
  // a profile mentioning Jest would evidence a resume claiming Selenium. That is
  // the invention rule 1 forbids, arriving through the truthfulness gate itself.
  for (const [profileForm, docForm] of [
    ["Jest", "Selenium"],
    ["Grafana", "Datadog"],
    ["Claude", "OpenAI"],
    ["OAuth", "RBAC"],
    ["Jenkins", "CircleCI"],
    ["Pinecone", "Weaviate"],
    ["TensorFlow", "PyTorch"],
  ]) {
    const r = verdict(`Uses ${profileForm}.`, `Uses ${docForm}.`)
    assert.equal(r.ok, false, `"${profileForm}" evidenced "${docForm}"`)
    assert.ok(
      r.violations.some((v) => v.rule === "R6" && v.detail.includes(docForm)),
      JSON.stringify(r.violations),
    )
  }
})

test("R6 catches an invented claim written in lowercase", () => {
  // The case-shaped hole: techTermsIn had no "i" flag, so a bullet claiming
  // lowercase "kubernetes" produced zero violations and the document passed.
  const r = verdict("Uses React.", "Deployed on kubernetes with terraform.")
  assert.equal(r.ok, false)
  for (const term of ["Kubernetes", "Terraform"]) {
    assert.ok(
      r.violations.some((v) => v.rule === "R6" && v.detail.includes(term)),
      `lowercase ${term} passed R6: ${JSON.stringify(r.violations)}`,
    )
  }
})

test("R6 does not fail an honest document over ordinary English", () => {
  // The cost of closing the hole carelessly. "go", "rest", "react", "spring",
  // "express" and "rails" are all surface forms in the lexicon and all everyday
  // words; a blanket case-insensitive match reads them as claims and fails a
  // truthful resume, which is how a guardrail gets muted.
  const r = verdict(
    "Coordinated releases.",
    "Had to go through legal, so the rest of the team could react to feedback in the spring without express approval, and nothing went off the rails.",
  )
  assert.equal(r.ok, true, JSON.stringify(r.violations))
})

test("a missing answers.yaml is a legitimate fact base, not an error", () => {
  const c = loadFactContext({
    profilePath: PROFILE,
    answersPath: path.join(FIX, "does-not-exist.yaml"),
  })
  assert.deepEqual(c.answers, { answers: [] })
  assert.ok(c.factIndex.size > 5)
})
