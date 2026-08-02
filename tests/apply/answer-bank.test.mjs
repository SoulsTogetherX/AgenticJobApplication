import test from "node:test"
import assert from "node:assert/strict"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import {
  matchOption,
  createResolver,
} from "../../scripts/apply/answer-bank.mjs"

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
)
const FIXTURES = path.join(ROOT, "tests", "fixtures")

function run(fields, extra = []) {
  return spawnSync(
    process.execPath,
    [
      path.join(ROOT, "scripts", "apply", "answer-bank.mjs"),
      "--fields",
      JSON.stringify(fields),
      "--profile",
      path.join(FIXTURES, "profile.yaml"),
      "--answers",
      path.join(FIXTURES, "answers-bank.yaml"),
      ...extra,
    ],
    { cwd: ROOT, encoding: "utf8" },
  )
}

function resolveAll(fields) {
  const res = run(fields, ["--json"])
  assert.equal(res.status, 0, res.stderr)
  const byKey = new Map()
  for (const r of JSON.parse(res.stdout).results) byKey.set(r.k, r)
  return byKey
}

test("resolves contact fields from the profile", () => {
  const r = resolveAll([
    { k: "f1", t: "text", l: "First Name *" },
    { k: "f2", t: "text", l: "Last Name" },
    { k: "f3", t: "email", l: "Email" },
    { k: "f4", t: "tel", l: "Phone number" },
    { k: "f5", t: "text", l: "Current location (city)" },
  ])
  assert.equal(r.get("f1").value, "Jane")
  assert.equal(r.get("f1").status, "OK")
  assert.equal(r.get("f2").value, "Test")
  assert.equal(r.get("f3").value, "jane@test.example")
  assert.equal(r.get("f4").value, "(555) 123-4567")
  assert.equal(r.get("f5").value, "Springfield")
})

test("matches the answers bank and maps the answer onto real options", () => {
  const r = resolveAll([
    // `opts` is deliberately populated: a `select` with no recorded options
    // is UNPROBED (see the "unprobed combo defers" test below), and a bank
    // hit there must defer, not silently accept the first candidate. This
    // test is about the bank producing a strong match and that match landing
    // on a real, offered option — both need the option actually offered.
    {
      k: "f1",
      t: "select",
      l: "Are you authorized to work in the US?",
      opts: ["Yes, US citizen, no sponsorship needed.", "No"],
    },
    {
      k: "g1",
      t: "radio",
      l: "Are you legally authorized to work in the United States?",
      o: [
        { k: "f8", l: "Yes" },
        { k: "f9", l: "No" },
      ],
    },
  ])
  // strong wording match -> uses the banked answer verbatim
  assert.equal(r.get("f1").status, "OK")
  assert.match(r.get("f1").value, /^Yes/)
  // radio group -> answer normalised to the option label + the key to click
  const g = r.get("g1")
  assert.equal(g.status, "OK")
  assert.equal(g.value, "Yes")
  assert.match(g.note, /pick=f8/)
})

test("an unprobed combo defers instead of silently accepting the first candidate", () => {
  // Same question as above, but with NO opts at all — exactly what a
  // combo/select looks like before the browser ever opened its menu. A
  // resolved bank value must not be trusted as "offered" when nobody has
  // actually seen the real option list.
  const r = resolveAll([
    {
      k: "f1",
      t: "select",
      l: "Are you authorized to work in the US?",
    },
    {
      k: "f2",
      t: "combo",
      l: "Are you legally authorized to work in the United States?",
    },
  ])
  for (const k of ["f1", "f2"]) {
    const f = r.get(k)
    assert.equal(f.status, "NEEDS-CHOICE", `${k}: ${JSON.stringify(f)}`)
    assert.match(f.note, /not (been )?probed|unprobed/i)
  }
})

// --- the prefix rule must never invent detail the label never offered ------
//
// AUDIT C1/C2. matchOption() lets a banked "Yes" expand to a longer OFFERED
// option that merely restates the label ("Will you require sponsorship?" ->
// "No, I will not require sponsorship" — nothing new asserted). The bug: the
// same mechanism used to accept ANY option merely starting with "Yes"/"No",
// so a banked "Yes" for "Do you have experience with React?" against an
// option list offering "Yes, 5+ years professionally" invented a duration
// nowhere in the label or the banked answer — a confidently wrong,
// auto-filled claim. remainderIsGrounded() is the fix: whatever text SURVIVES
// past the matched value must already be implied by the FIELD's own label.
test("matchOption: a banked Yes does not expand into invented detail the label never offered (AUDIT C1)", () => {
  const r = matchOption("Yes", ["Yes, 5+ years professionally", "No"], {
    requireOptions: true,
    label: "Do you have experience with React?",
  })
  assert.notEqual(
    r.value,
    "Yes, 5+ years professionally",
    "a bare Yes must not be upgraded into an invented years-of-experience claim",
  )
  assert.equal(
    r.needsChoice,
    true,
    "must defer to the user instead of guessing",
  )
})

test("matchOption: a banked No does not expand into an invented list-negation (AUDIT C2)", () => {
  // "None of the above" is only correct when the label actually asked about a
  // list — copying it onto an ordinary yes/no question invents a shape the
  // label never had. `none\b` was deliberately removed from NO_LONG for
  // exactly this reason.
  const r = matchOption(
    "No",
    ["None of the above", "Yes, I was previously employed here"],
    {
      requireOptions: true,
      label: "Have you previously been employed at Globex?",
    },
  )
  assert.notEqual(r.value, "None of the above")
  assert.equal(r.needsChoice, true)
})

test("matchOption: a grounded long-form option still expands correctly", () => {
  // The positive control: whatever survives past the matched value IS
  // already implied by the label, so the expansion is a restatement, not an
  // invention, and must still resolve OK — this is the case the AUDIT C1 fix
  // must not break in the name of fixing it.
  const r = matchOption("No", ["No, I will not require sponsorship", "Yes"], {
    requireOptions: true,
    label: "Will you now or in the future require sponsorship?",
  })
  assert.equal(r.value, "No, I will not require sponsorship")
  assert.equal(r.needsChoice, undefined)
})

test("a free-text field with no options is unaffected by the unprobed-combo guard", () => {
  // Text/email/etc. fields have no option list to begin with — that is not
  // the same fact as "a dropdown nobody opened", and must keep resolving.
  const r = resolveAll([{ k: "f1", t: "email", l: "Email" }])
  assert.equal(r.get("f1").status, "OK")
  assert.equal(r.get("f1").value, "jane@test.example")
})

test("a truncated option list is flagged in the NEEDS-CHOICE note, not presented as complete", () => {
  // field-cache.mjs sets optsTruncated when a cached/recorded list may not be
  // the whole thing (AUDIT H3). A "no match" note must say so, rather than
  // implying the value is definitely not offered anywhere on the real form.
  const r = resolveAll([
    {
      k: "f1",
      t: "select",
      l: "Are you authorized to work in the US?",
      opts: ["Green card holder", "Requires sponsorship"],
      optsTruncated: true,
    },
  ])
  const f = r.get("f1")
  assert.equal(f.status, "NEEDS-CHOICE")
  assert.match(f.note, /truncat/i)
})

test("an untruncated option list with no match gets the plain options note", () => {
  const r = resolveAll([
    {
      k: "f1",
      t: "select",
      l: "Are you authorized to work in the US?",
      opts: ["Green card holder", "Requires sponsorship"],
    },
  ])
  const f = r.get("f1")
  assert.equal(f.status, "NEEDS-CHOICE")
  assert.doesNotMatch(f.note, /truncat/i)
})

test("unmatched questions come back UNKNOWN instead of invented", () => {
  const r = resolveAll([
    { k: "f1", t: "number", l: "How many years of Kubernetes experience?" },
    { k: "f2", t: "text", l: "Desired salary" },
  ])
  assert.equal(r.get("f1").status, "UNKNOWN")
  assert.equal(r.get("f1").value, "")
  assert.equal(r.get("f2").status, "UNKNOWN")
})

test("EEO questions default to the decline option, files are skipped", () => {
  const r = resolveAll([
    {
      k: "f1",
      t: "select",
      l: "Gender",
      opts: ["Select...", "Male", "Female", "Decline to self-identify"],
    },
    { k: "f2", t: "select", l: "Veteran status", opts: ["Yes", "No"] },
    { k: "f3", t: "file", l: "Resume/CV" },
  ])
  assert.equal(r.get("f1").status, "OK")
  assert.equal(r.get("f1").value, "Decline to self-identify")
  // no decline option offered -> never guess on the user's behalf
  assert.equal(r.get("f2").status, "UNKNOWN")
  assert.equal(r.get("f3").status, "SKIP")
})

test("flags a resolved value that matches none of the offered options", () => {
  const r = resolveAll([
    {
      k: "f1",
      t: "select",
      l: "Are you authorized to work in the US?",
      opts: ["Requires sponsorship", "Green card holder"],
    },
  ])
  assert.equal(r.get("f1").status, "NEEDS-CHOICE")
  assert.match(r.get("f1").note, /options: Requires sponsorship/)
})

test("weak wording matches surface as MAYBE with the banked question", () => {
  const r = resolveAll([
    { k: "f1", t: "text", l: "US work authorization status?" },
  ])
  const f = r.get("f1")
  assert.ok(
    ["MAYBE", "OK"].includes(f.status),
    `expected a match, got ${f.status}`,
  )
  if (f.status === "MAYBE") assert.match(f.note, /bank asks:/)
})

test("terse output is one tab-separated line per field plus a summary", () => {
  const res = run([
    { k: "f1", t: "text", l: "First Name" },
    { k: "f2", t: "text", l: "Desired salary" },
  ])
  assert.equal(res.status, 0, res.stderr)
  const lines = res.stdout.trim().split(/\r?\n/)
  assert.equal(lines.length, 3)
  assert.deepEqual(lines[0].split("\t").slice(0, 4), [
    "f1",
    "OK",
    "contact.name",
    "Jane",
  ])
  assert.match(lines[1], /^f2\tUNKNOWN/)
  assert.match(lines[2], /^# 2 fields:/)
})

// ---------------------------------------------------------------------------
// Phase 0.7 — name, email and phone go out BYTE-IDENTICAL on every form,
// from profile.yaml and nowhere else.
// ---------------------------------------------------------------------------
// Two failure modes, both live before this landed, both invisible in an
// approval message a human skims:
//
//   * FORMAT DRIFT — the same phone number rendered "(702) 555-0134" on one
//     board and "702.555.0134" on the next, because the second board's label
//     happened to hit an answers.yaml entry instead of profile.contact.
//   * PLUS-ALIASING — "jane+greenhouse@example.com" on one form and
//     "jane@example.com" on another. Per-board aliases are a reasonable thing
//     for a person to want and a terrible thing for an agent to emit
//     silently: they are trivially linkable back to one inbox, and the user
//     never chose which board saw which alias.
//
// The mechanism under test is the ORDERING at answer-bank.mjs's identity
// pass: the exact answer-bank lookup used to run first, so any bank entry
// whose question normalized into the identity set outranked the profile.
// These use createResolver() with in-memory documents — nothing in
// tests/fixtures/ is touched, and no real profile is read.
const ID_PROFILE = {
  contact: {
    name: "Jane Q Test",
    email: "jane@test.example",
    phone: "(702) 555-0134",
    linkedin: "https://linkedin.com/in/janetest",
    location: "Springfield, NV",
  },
}

// A bank that disagrees with the profile on EVERY identity fact, in exactly
// the shapes that would have won before: exact-normalized questions.
const HOSTILE_TO_IDENTITY = {
  answers: [
    { id: "a-1", question: "Email", answer: "jane+greenhouse@test.example" },
    { id: "a-2", question: "E-mail address", answer: "JANE@TEST.EXAMPLE" },
    { id: "a-3", question: "Phone", answer: "702.555.0134" },
    { id: "a-4", question: "Mobile phone number", answer: "+1 702 555 0134" },
    { id: "a-5", question: "Full name", answer: "J. Test" },
    { id: "a-6", question: "First name", answer: "JANE" },
  ],
}

const idResolve = (fields, answersDoc = HOSTILE_TO_IDENTITY) => {
  const { results } = createResolver(ID_PROFILE, answersDoc).resolveAll(fields)
  return new Map(results.map((r) => [r.k, r]))
}

test("0.7: every label shape for the same identity fact emits the identical bytes", () => {
  // The label wordings are the ones the four real boards use. Every email
  // result must be the SAME STRING — asserted with ===, not a regex, because
  // a regex is exactly what would let a plus-alias or a case change through.
  const emailLabels = [
    "Email",
    "Email *",
    "Email Address",
    "E-mail",
    "Work email",
  ]
  const phoneLabels = [
    "Phone",
    "Phone *",
    "Phone number",
    "Mobile phone number",
    "Telephone",
  ]
  const r = idResolve([
    ...emailLabels.map((l, i) => ({ k: `e${i}`, t: "email", l })),
    ...phoneLabels.map((l, i) => ({ k: `p${i}`, t: "tel", l })),
    { k: "n1", t: "text", l: "Full name" },
    { k: "n2", t: "text", l: "Name" },
    { k: "n3", t: "text", l: "Legal name" },
    { k: "f1", t: "text", l: "First Name" },
    { k: "f2", t: "text", l: "Given name" },
    { k: "l1", t: "text", l: "Last Name" },
    { k: "l2", t: "text", l: "Surname" },
  ])
  for (const [i, l] of emailLabels.entries()) {
    assert.equal(r.get(`e${i}`).value, "jane@test.example", `email via "${l}"`)
    assert.equal(r.get(`e${i}`).source, "contact.email")
  }
  for (const [i, l] of phoneLabels.entries()) {
    assert.equal(r.get(`p${i}`).value, "(702) 555-0134", `phone via "${l}"`)
    assert.equal(r.get(`p${i}`).source, "contact.phone")
  }
  for (const k of ["n1", "n2", "n3"])
    assert.equal(r.get(k).value, "Jane Q Test")
  for (const k of ["f1", "f2"]) assert.equal(r.get(k).value, "Jane")
  for (const k of ["l1", "l2"]) assert.equal(r.get(k).value, "Test")
})

test("0.7: a plus-aliased address in the answer bank never reaches a form", () => {
  const r = idResolve([
    { k: "f1", t: "email", l: "Email" },
    { k: "f2", t: "email", l: "E-mail address" },
  ])
  for (const k of ["f1", "f2"]) {
    const v = r.get(k).value
    assert.equal(v, "jane@test.example")
    assert.ok(!v.includes("+"), "no plus-alias may be emitted")
    assert.equal(v, v.toLowerCase(), "and no case drift either")
    assert.doesNotMatch(
      r.get(k).source,
      /^a-\d/,
      "the value must not have come from the bank at all",
    )
  }
})

test("0.7: a differently punctuated phone in the bank does not override the profile", () => {
  const r = idResolve([
    { k: "f1", t: "tel", l: "Phone" },
    { k: "f2", t: "tel", l: "Mobile phone number" },
  ])
  assert.equal(r.get("f1").value, "(702) 555-0134")
  assert.equal(r.get("f2").value, "(702) 555-0134")
})

test("0.7 BOUNDARY: an identity fact the profile lacks is UNKNOWN, never the bank's to answer", () => {
  // "Profile, or nobody." Falling back to the bank here would reintroduce the
  // drift by the back door: two bank entries, two renderings, no single
  // source to check byte-identity against.
  const noPhone = {
    contact: { name: "Jane Q Test", email: "jane@test.example" },
  }
  const { results } = createResolver(noPhone, HOSTILE_TO_IDENTITY).resolveAll([
    { k: "f1", t: "tel", l: "Phone" },
  ])
  assert.equal(results[0].status, "UNKNOWN")
  assert.equal(results[0].value, "")
  assert.match(results[0].note ?? "", /not in profile\.contact\.phone/)
})

test("0.7 IS NARROW: a non-identity contact field still takes the bank's exact answer", () => {
  // If the identity pass had been written as "CONTACT_RULES beat the bank",
  // this goes red — and a user who deliberately saved a per-application
  // LinkedIn URL or street address would silently stop getting it.
  const r = idResolve(
    [
      { k: "f1", t: "text", l: "LinkedIn Profile" },
      { k: "f2", t: "text", l: "Website" },
    ],
    {
      answers: [
        {
          id: "a-9",
          question: "LinkedIn Profile",
          answer: "https://linkedin.com/in/jane-hiring",
        },
        { id: "a-10", question: "Website", answer: "https://jane.example" },
      ],
    },
  )
  assert.equal(r.get("f1").value, "https://linkedin.com/in/jane-hiring")
  assert.match(r.get("f1").source, /^a-9@exact/)
  assert.equal(r.get("f2").value, "https://jane.example")
})

test("0.7 ORDER PRESERVED: 'Middle Name' and 'Name Pronunciation' are still not the legal name", () => {
  // The identity pass takes the FIRST matching CONTACT_RULE, not the first
  // matching IDENTITY rule. Both of these labels are matched by earlier,
  // unflagged rules — "Name Pronunciation" asks how to say it, and answering
  // it with the name itself happened on a real Affirm form.
  const r = idResolve([
    { k: "f1", t: "text", l: "Middle Name" },
    { k: "f2", t: "text", l: "Name Pronunciation" },
  ])
  assert.notEqual(r.get("f1").value, "Jane Q Test")
  assert.equal(r.get("f1").value, "")
  assert.notEqual(r.get("f2").value, "Jane Q Test")
  assert.equal(r.get("f2").value, "")
})

test("usage errors: no input and malformed JSON", () => {
  const noInput = spawnSync(
    process.execPath,
    [path.join(ROOT, "scripts", "apply", "answer-bank.mjs"), "--fields", "   "],
    { cwd: ROOT, encoding: "utf8" },
  )
  assert.equal(noInput.status, 2)
  assert.equal(run([], ["--json"]).status, 0) // empty list is fine
  const bad = spawnSync(
    process.execPath,
    [
      path.join(ROOT, "scripts", "apply", "answer-bank.mjs"),
      "--fields",
      "{not json",
    ],
    { cwd: ROOT, encoding: "utf8" },
  )
  assert.equal(bad.status, 2)
})
