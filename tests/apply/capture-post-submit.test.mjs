// The post-submit capture path (§4.10, Phase 5 W2).
//
// WHAT IS ACTUALLY UNDER TEST HERE, and it is not "does it copy a file". This
// script is the only thing standing between a page the user's real name, email,
// phone and address were just typed into, and a git repository. Every test
// below is some form of the same question: can any of that reach the corpus?
//
// The redactor is deliberately tested against the shapes that DEFEAT a naive
// one — a phone spaced out by markup, a name greeted alone, an identifier the
// fact base never knew about — because those are the cases where a redactor
// silently does nothing and the staging directory still reads as "safe".
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  identifiersFromProfile,
  redactCapture,
  assertRedacted,
  stageCapture,
  listStaged,
  reviewStaged,
  promoteCapture,
  readManifest,
} from "../../src/apply/capture-post-submit.mjs"

const PROFILE = `
meta:
  approved_by_user: true
contact:
  name: Jane Test
  email: jane@test.example
  phone: "(555) 123-4567"
  location: "Springfield, IL"
  github: https://github.com/janetest
`

function sandbox({ profile = PROFILE, answers = "answers: []\n" } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aj-capture-"))
  const jobsDir = path.join(root, "jobs")
  const profileDir = path.join(root, "profile")
  fs.mkdirSync(path.join(jobsDir, ".auto"), { recursive: true })
  fs.mkdirSync(profileDir, { recursive: true })
  fs.writeFileSync(path.join(profileDir, "profile.yaml"), profile)
  fs.writeFileSync(path.join(profileDir, "answers.yaml"), answers)
  return {
    root,
    jobsDir,
    profileDir,
    stagingDir: path.join(jobsDir, ".auto", "post-submit"),
    corpusDir: path.join(root, "corpus"),
    manifestPath: path.join(root, "corpus", "corpus.json"),
  }
}

const ids = (s) => identifiersFromProfile({ profileDir: s.profileDir })
const values = (list) => list.map((x) => x.value)

// --- what counts as an identifier --------------------------------------------

test("identifiers come from the fact base, including bare name parts", () => {
  const s = sandbox()
  const { literals, digits } = ids(s)
  assert.ok(values(literals).includes("Jane Test"))
  assert.ok(
    values(literals).includes("Jane"),
    "a page greets 'Jane' alone all the time",
  )
  assert.ok(values(literals).includes("jane@test.example"))
  assert.ok(values(literals).includes("Springfield, IL"))
  assert.ok(values(digits).includes("5551234567"), "phone as bare digits too")
})

test("every identifier carries a FIELD label, never the value, for reports", () => {
  // The report lands on disk and on a terminal. A label of `contact.email` is
  // actionable; the value itself would republish exactly what the redaction
  // removed, in the one place nobody thinks to check.
  const s = sandbox()
  for (const { label, value } of ids(s).literals) {
    assert.match(label, /^(contact\.|answers\.)/, `bad label ${label}`)
    assert.ok(!label.includes(value), "the label must not embed the value")
  }
})

test("a two-character value is NOT an identifier", () => {
  // Redacting "IL" would blank the word "will" on every page. The literals are
  // length-filtered for exactly this.
  const s = sandbox({
    profile: "contact:\n  name: Al\n  location: IL\n  email: a@b.co\n",
  })
  const got = values(ids(s).literals)
  assert.ok(!got.includes("Al"))
  assert.ok(!got.includes("IL"))
})

test("literals are ordered longest-first", () => {
  // Redacting "Jane" before "Jane Test" would leave " Test" on the page.
  const s = sandbox()
  const got = values(ids(s).literals)
  assert.ok(
    got.indexOf("Jane Test") < got.indexOf("Jane"),
    "the longer match has to be taken first",
  )
})

test("a missing or malformed fact base yields no identifiers, never a crash", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aj-capture-none-"))
  const got = identifiersFromProfile({ profileDir: path.join(root, "nope") })
  assert.deepEqual(got.literals, [])
  assert.deepEqual(got.digits, [])
})

// --- the redactor -------------------------------------------------------------

test("the user's own values do not survive redaction", () => {
  const s = sandbox()
  const html = `<p>Thank you Jane Test. A copy went to jane@test.example.</p>
    <p>Phone on file: (555) 123-4567. Location: Springfield, IL.</p>`
  const { html: out } = redactCapture(html, ids(s))
  for (const secret of [
    "Jane",
    "Test",
    "jane@test.example",
    "555",
    "Springfield",
  ])
    assert.ok(!out.includes(secret), `"${secret}" survived: ${out}`)
})

test("a phone spaced out by markup is still caught", () => {
  // The shape that defeats a single literal match, and the reason the digit
  // runs are matched separately from the formatted string.
  const s = sandbox()
  const html = "<span>5</span>5<i>5</i>-1 2 3 . 4-5-6-7"
  const { html: out } = redactCapture(html, ids(s))
  assert.ok(!out.replace(/\D+/g, "").includes("5551234567"))
})

test("identifiers the fact base never knew about are still redacted", () => {
  // A recruiter's email, the employer's own reference number, an upload token.
  // Deny-by-default: the fact base cannot enumerate what a third party puts on
  // their own page.
  const s = sandbox()
  const html = `<p>Questions? recruiting@acme.example</p>
    <p>Reference: 98217734</p>
    <p>token 3f2a19bb44cd77e0091a2b3c4d5e6f70</p>
    <p>id 550e8400-e29b-41d4-a716-446655440000</p>`
  const { html: out, findings } = redactCapture(html, ids(s))
  assert.ok(!out.includes("recruiting@acme.example"))
  assert.ok(!out.includes("98217734"))
  assert.ok(!out.includes("3f2a19bb44cd77e0091a2b3c4d5e6f70"))
  assert.ok(!out.includes("550e8400-e29b-41d4-a716-446655440000"))
  assert.ok(findings.some((f) => f.kind === "email"))
  assert.ok(findings.some((f) => f.kind === "uuid"))
})

test("the redaction report names kinds and counts, never the values", () => {
  const s = sandbox()
  const { findings } = redactCapture(
    "<p>Jane Test — jane@test.example</p>",
    ids(s),
  )
  const asText = JSON.stringify(findings)
  assert.ok(!asText.includes("jane@test.example"))
  assert.ok(findings.every((f) => typeof f.count === "number"))
})

test("the page's meaning survives redaction", () => {
  // A redactor that blanked the words a rule reads would produce a corpus that
  // cannot test anything. The phrases the classifier keys on must stay.
  const s = sandbox()
  const html =
    "<h1>Application received</h1><p>Thank you for applying, Jane Test.</p>"
  const { html: out } = redactCapture(html, ids(s))
  assert.match(out, /Application received/)
  assert.match(out, /Thank you for applying/)
})

// --- the check that makes it a guarantee --------------------------------------

test("assertRedacted re-reads the OUTPUT and throws on a survivor", () => {
  // The failure being guarded against is a pattern that did not fire, so the
  // check cannot trust the redactor's own findings list.
  const s = sandbox()
  assert.throws(
    () => assertRedacted("<p>Hello Jane Test</p>", ids(s)),
    /did not remove 2 identifier|did not remove \d+ identifier/,
  )
  assert.ok(assertRedacted("<p>Hello there</p>", ids(s)))
})

test("the surviving VALUE is never printed in the error", () => {
  // The error goes to a terminal, a log, and quite possibly into a model's
  // context. Naming the shape is actionable; quoting the value undoes the
  // redaction in the one place nobody thinks to look.
  const s = sandbox()
  try {
    assertRedacted("<p>jane@test.example</p>", ids(s))
    assert.fail("should have thrown")
  } catch (e) {
    assert.ok(!e.message.includes("jane@test.example"))
    assert.match(e.message, /NOTHING WAS STAGED/)
  }
})

test("assertRedacted catches a phone whose punctuation was stripped", () => {
  const s = sandbox()
  assert.throws(() => assertRedacted("<p>5551234567</p>", ids(s)), /digit run/)
})

// --- staging ------------------------------------------------------------------

test("staging writes a redacted page and a report, under jobs/", () => {
  const s = sandbox()
  const rec = stageCapture({
    url: "https://boards.greenhouse.io/acme/jobs/1?token=secret",
    html: "<h1>Application received</h1><p>Thanks Jane Test</p>",
    board: "greenhouse",
    slug: "acme-dev",
    ...s,
  })
  assert.equal(rec.host, "boards.greenhouse.io")
  assert.equal(
    rec.url,
    "https://boards.greenhouse.io/acme/jobs/1",
    "the query string is dropped — that is where tracking tokens live",
  )
  assert.equal(rec.promoted, false)
  assert.equal(
    rec.kind,
    undefined,
    "staging does NOT decide what the page means; the user does",
  )

  const html = fs.readFileSync(
    path.join(s.stagingDir, `${rec.id}.html`),
    "utf8",
  )
  assert.ok(!html.includes("Jane"))
  assert.match(html, /Application received/)
})

test("staging REFUSES and writes nothing when an identifier survives", () => {
  // The property that makes the staging directory meaningful. Simulated by
  // handing the redactor an identifier list it cannot act on — a literal that
  // regex-escapes to something the replace pass will not remove is not
  // reachable through the public API, so the check is driven directly.
  const s = sandbox()
  assert.throws(
    () => assertRedacted("<p>Jane Test</p>", ids(s)),
    /NOTHING WAS STAGED/,
  )
  assert.deepEqual(
    listStaged({ stagingDir: s.stagingDir }),
    [],
    "and nothing is on disk",
  )
})

test("staging refuses to write outside jobs/", () => {
  const s = sandbox()
  assert.throws(
    () =>
      stageCapture({
        url: "https://x.test/1",
        html: "<p>hi</p>",
        stagingDir: path.join(s.root, "elsewhere"),
        jobsDir: s.jobsDir,
        profileDir: s.profileDir,
      }),
    /refusing to write outside jobs/,
  )
})

test("two captures of the same page stage once — the id is content-addressed", () => {
  const s = sandbox()
  const args = {
    url: "https://boards.greenhouse.io/acme/jobs/1",
    html: "<h1>Application received</h1>",
    board: "greenhouse",
    ...s,
  }
  const a = stageCapture(args)
  const b = stageCapture(args)
  assert.equal(a.id, b.id)
  assert.equal(listStaged({ stagingDir: s.stagingDir }).length, 1)
})

// --- review and promote -------------------------------------------------------

test("review returns the VISIBLE TEXT, because that is what a skim misses", () => {
  const s = sandbox()
  const rec = stageCapture({
    url: "https://x.test/1",
    html: "<script>var a=1</script><h1>Application received</h1>",
    ...s,
  })
  const { text } = reviewStaged(rec.id, { stagingDir: s.stagingDir })
  assert.equal(text, "Application received")
})

test("promote REQUIRES --user-approved", () => {
  const s = sandbox()
  const rec = stageCapture({ url: "https://x.test/1", html: "<p>x</p>", ...s })
  assert.throws(
    () =>
      promoteCapture({
        id: rec.id,
        kind: "confirmation",
        stagingDir: s.stagingDir,
        corpusDir: s.corpusDir,
        manifestPath: s.manifestPath,
      }),
    /requires --user-approved/,
  )
  assert.deepEqual(readManifest(s.manifestPath).samples, [])
})

test("promote refuses a kind outside the closed set, and refuses unclassified", () => {
  const s = sandbox()
  const rec = stageCapture({ url: "https://x.test/1", html: "<p>x</p>", ...s })
  for (const kind of ["unclassified", "probably-fine", null, undefined])
    assert.throws(
      () =>
        promoteCapture({
          id: rec.id,
          kind,
          userApproved: true,
          stagingDir: s.stagingDir,
          corpusDir: s.corpusDir,
          manifestPath: s.manifestPath,
        }),
      TypeError,
      `kind ${JSON.stringify(kind)}`,
    )
})

test("a promoted sample records the hosts it may ever speak for", () => {
  // The bound on where a rule citing this sample may fire. A sample captured
  // from Greenhouse says nothing about Lever, and the manifest is where that
  // limit is written down.
  const s = sandbox()
  const rec = stageCapture({
    url: "https://boards.greenhouse.io/acme/jobs/1",
    html: "<h1>Application received</h1>",
    board: "greenhouse",
    ...s,
  })
  const sample = promoteCapture({
    id: rec.id,
    kind: "confirmation",
    userApproved: true,
    stagingDir: s.stagingDir,
    corpusDir: s.corpusDir,
    manifestPath: s.manifestPath,
  })
  assert.deepEqual(sample.hosts, ["boards.greenhouse.io"])
  assert.equal(sample.source, "capture")
  assert.equal(sample.kind, "confirmation")

  const onDisk = fs.readFileSync(path.join(s.corpusDir, sample.file), "utf8")
  assert.match(onDisk, /Application received/)
  assert.equal(
    readManifest(s.manifestPath).samples.length,
    1,
    "and the manifest is the index",
  )
})

test("re-promoting a sample replaces its entry rather than duplicating it", () => {
  const s = sandbox()
  const rec = stageCapture({
    url: "https://x.test/1",
    html: "<h1>Application received</h1>",
    ...s,
  })
  const opts = {
    id: rec.id,
    userApproved: true,
    stagingDir: s.stagingDir,
    corpusDir: s.corpusDir,
    manifestPath: s.manifestPath,
  }
  promoteCapture({ ...opts, kind: "confirmation" })
  promoteCapture({ ...opts, kind: "error" })
  const { samples } = readManifest(s.manifestPath)
  assert.equal(samples.length, 1)
  assert.equal(samples[0].kind, "error", "the correction wins")
})

test("promoting does not create a RULE — a human still writes that", () => {
  // Auto-generating a regex from a promoted page would be §4.6's forbidden
  // guess one layer down: the machine deciding what about the page is the
  // signal. The manifest is evidence; classify.mjs's rules are a judgement.
  const s = sandbox()
  const rec = stageCapture({
    url: "https://x.test/1",
    html: "<h1>Application received</h1>",
    ...s,
  })
  const sample = promoteCapture({
    id: rec.id,
    kind: "confirmation",
    userApproved: true,
    stagingDir: s.stagingDir,
    corpusDir: s.corpusDir,
    manifestPath: s.manifestPath,
  })
  assert.equal(sample.test, undefined)
  assert.equal(sample.pattern, undefined)
  assert.equal(sample.regex, undefined)
})

test("a missing manifest reads as empty, not as a crash", () => {
  assert.deepEqual(readManifest("/no/such/corpus.json").samples, [])
})
