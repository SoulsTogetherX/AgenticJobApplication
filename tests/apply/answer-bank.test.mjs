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

// ---------------------------------------------------------------------------
// The job being APPLIED TO is not the user's current job (found 2026-08-05)
// ---------------------------------------------------------------------------
// Two PROFILE_RULES answer with the user's own employer and title. Neither
// "Position Applied For" nor "Company you are applying to" is question-shaped,
// so IS_QUESTION did not divert them and both resolved OK — the current job
// title and the current employer, typed into a real employer's form and
// submitted with no human review, because fill-plan.mjs turns an OK into an
// automatic fill. Observed before the fix:
//
//   {"k":"q3","label":"Position Applied For","status":"OK",
//    "source":"experience.current","value":"Engineer"}
//   {"k":"q4","label":"Company you are applying to","status":"OK",
//    "source":"experience.current","value":"Globex"}
//
// THE FIRST FIX WAS A DENYLIST AND FAILED OPEN. It dropped the two
// `current-job` rules only when the label matched APPLIED_TO — i.e. it assumed
// every other label meant the user's own job. Proved incomplete by execution
// the same day, end to end through buildPlan with the greenhouse adapter:
//
//   {"k":"f0","how":"fill","value":"Engineer","label":"Requisition Title"}
//   {"k":"f1","how":"fill","value":"Globex","label":"Hiring Company"}
//   "Vacancy Title"  -> "Engineer"
//   "Position Title" -> "Engineer"
//
// while "Position Applied For" in the same run correctly deferred. The test is
// now INVERTED: those two rules run only on positive evidence that the label
// asks for the applicant's CURRENT job — the label itself, or the section
// heading the field sits under — and are dropped otherwise.
//
// The BOUNDARY tests below are the ones that matter most: the case those rules
// EXIST for must keep resolving, by label ("Current Employer") and by section
// (a bare "Company" under a "Work Experience" heading). A gate that deferred
// those too would be a different defect.
const JOB_PROFILE = {
  contact: { name: "Jane Q Test", email: "jane@test.example" },
  experience: [
    { company: "Globex", title: "Engineer", dates: "Jan 2022 - Present" },
  ],
}

// A label is either a plain string or {l, section} — `section` is what
// scan-page.js stamps on a field from the heading above it, and it reaches
// resolveField unchanged (fill-plan.mjs passes scan.fields straight through).
const jobResolve = (labels, answersDoc = { answers: [] }) => {
  const fields = labels.map((x, i) =>
    typeof x === "string"
      ? { k: `f${i}`, t: "text", l: x }
      : { k: `f${i}`, t: "text", ...x },
  )
  const { results } = createResolver(JOB_PROFILE, answersDoc).resolveAll(fields)
  return new Map(results.map((r, i) => [fields[i].l, r]))
}

// A POPULATED BANK, because an empty one hid a defect for three rounds.
// Every own-job test below this point used `{ answers: [] }`, which is the one
// configuration nobody runs: the suite was green while the production path —
// a real profile/answers.yaml — answered the labels the guard had refused.
const JOB_BANK = {
  answers: [
    { id: "a1", question: "Current Job Title", answer: "Engineer" },
    { id: "a2", question: "Current Employer", answer: "Globex" },
  ],
}

test("a heading about somebody ELSE vetoes the bank, exact match included", () => {
  // "Current Employer" is a legitimate banked question and `a2` is a
  // legitimate answer to it. Under one of these headings the same words are
  // asking about a different human being, so the exact match is the wrong
  // reason to trust it — the words matching is precisely what makes it wrong.
  //
  // This filled with the owner's employer (source `a2@exact`) until 2026-08-06.
  // The profile rules had already refused it; the exact-bank lookup runs
  // BEFORE them and answered anyway, which is why gating the fuzzy tier alone
  // changed nothing.
  const hostile = [
    "Emergency Contact",
    "Reference",
    "Reference 1",
    "Next of Kin",
    "Beneficiary",
    "Spouse",
    "Parent or Guardian",
    "Supervisor",
  ]
  const r = jobResolve(
    hostile.map((section) => ({ l: "Current Employer", section })),
    JOB_BANK,
  )
  for (const [, f] of r) {
    assert.notEqual(f.status, "OK", JSON.stringify(f))
    assert.equal(f.value, "")
  }
})

test("BOUNDARY: the same bank still answers the owner's own current employer", () => {
  // The veto is narrow on purpose. With no hostile heading the banked answer
  // is exactly right and must still be used, or the fix has traded a wrong
  // answer for a lost one.
  const r = jobResolve(["Current Employer", "Current Job Title"], JOB_BANK)
  assert.equal(r.get("Current Employer").status, "OK")
  assert.equal(r.get("Current Employer").value, "Globex")
  assert.equal(r.get("Current Job Title").status, "OK")
  assert.equal(r.get("Current Job Title").value, "Engineer")
})

test("BOUNDARY: a requisition label cannot reach the bank fuzzily", () => {
  // "Requisition Title" overlaps "Current Job Title" enough to score above the
  // 0.7 fuzzy threshold, which is how three holes closed in round 3 re-opened
  // on the production path once a real bank was loaded.
  const r = jobResolve(
    ["Requisition Title", "Hiring Company", "Vacancy Title"],
    JOB_BANK,
  )
  for (const [l, f] of r) {
    assert.notEqual(f.status, "OK", `${l}: ${JSON.stringify(f)}`)
    assert.equal(f.value, "")
  }
})

test("a label naming the job APPLIED TO is never answered with the current one", () => {
  const labels = [
    "Position Applied For",
    "Company you are applying to",
    "Position you are applying for",
    "Organization applying to",
    "Desired Position",
    "Position of Interest",
    "Role sought",
    "Prospective employer",
    "Title of this position",
  ]
  const r = jobResolve(labels)
  for (const l of labels) {
    const f = r.get(l)
    assert.equal(f.status, "UNKNOWN", `${l}: ${JSON.stringify(f)}`)
    assert.equal(f.value, "", `${l} must not be filled from the current job`)
    assert.notEqual(f.value, "Engineer")
    assert.notEqual(f.value, "Globex")
  }
})

test("GAP CLOSED: a label naming the requisition WITHOUT the word 'applied' also defers", () => {
  // The exact labels the denylist let through. None of them says applied /
  // applying / desired / sought / of interest, and every one of them is a real
  // ATS field naming the job being applied FOR.
  const labels = [
    "Requisition Title",
    "Vacancy Title",
    "Position Title",
    "Posting Title",
    "Req Title",
    "Hiring Company",
    "Recruiting Company",
    "Hiring Organization",
  ]
  const r = jobResolve(labels)
  for (const l of labels) {
    const f = r.get(l)
    assert.equal(f.status, "UNKNOWN", `${l}: ${JSON.stringify(f)}`)
    assert.notEqual(f.value, "Engineer", `${l} got the user's own job title`)
    assert.notEqual(f.value, "Globex", `${l} got the user's own employer`)
  }
})

test("BOUNDARY: the current employer and title still resolve — on the LABEL's own evidence", () => {
  const labels = [
    "Current Job Title",
    "Current Employer",
    "Current Company",
    "Current Title",
    "Most Recent Employer",
    "Most Recent Job Title",
    "Present Employer",
    "Latest Job Title",
    "Existing employer",
    // "applicable" must not read as "apply" — the veto is word-bounded.
    "Current Employer (if applicable)",
  ]
  const r = jobResolve(labels)
  for (const l of labels) {
    const f = r.get(l)
    assert.equal(f.status, "OK", `${l}: ${JSON.stringify(f)}`)
    assert.equal(f.source, "experience.current")
    assert.ok(
      ["Engineer", "Globex"].includes(f.value),
      `${l} resolved to ${f.value}`,
    )
  }
})

test("BOUNDARY: a bare label under an employment-history SECTION still resolves", () => {
  // The second kind of positive evidence, and the one that keeps a real
  // work-history block (Workday, Oracle, Taleo) filling: the label carries no
  // "current", but the heading it sits under says whose job it is.
  const fields = [
    { l: "Company", section: "Work Experience" },
    { l: "Job Title", section: "Work Experience" },
    { l: "Employer", section: "Employment History" },
    { l: "Title", section: "Experience" },
    { l: "Company Name", section: "Career History" },
    { l: "Position Title", section: "Work Experience" },
  ]
  const r = jobResolve(fields)
  for (const { l } of fields) {
    const f = r.get(l)
    assert.equal(f.status, "OK", `${l}: ${JSON.stringify(f)}`)
    assert.equal(f.source, "experience.current")
    assert.ok(["Engineer", "Globex"].includes(f.value))
  }
})

test("THE COST: a bare label with NO evidence either way defers rather than guessing", () => {
  // The measured price of inverting the test, asserted so it cannot drift
  // silently in either direction. Each of these is genuinely ambiguous — on
  // one board it is the applicant's employer, on the next it is the
  // requisition — and nothing on the page says which. A deferral costs the
  // owner one question; the alternative cost them the application.
  const labels = [
    "Job Title",
    "Title",
    "Employer",
    "Employer Name",
    "Company Name",
    "Company",
    "Organisation name",
    "Organization",
  ]
  const r = jobResolve(labels)
  for (const l of labels) {
    const f = r.get(l)
    assert.equal(f.status, "UNKNOWN", `${l}: ${JSON.stringify(f)}`)
    assert.equal(f.value, "")
  }
})

test("the APPLIED_TO veto still overrides both kinds of evidence", () => {
  // APPLIED_TO survives, but only as a veto: it can add a deferral, never
  // grant an answer. A label carrying BOTH signals is ambiguous and defers,
  // and so does a requisition field that happens to sit under a work-history
  // heading.
  const fields = [
    { l: "Current openings you are applying for" },
    { l: "Position Applied For", section: "Work Experience" },
    { l: "Current position you are applying to" },
  ]
  const r = jobResolve(fields)
  for (const { l } of fields) {
    const f = r.get(l)
    assert.equal(f.status, "UNKNOWN", `${l}: ${JSON.stringify(f)}`)
    assert.notEqual(f.value, "Engineer")
    assert.notEqual(f.value, "Globex")
  }
})

test("GAP CLOSED (round 2): WHICH-job evidence alone no longer hands a requisition label the user's own job", () => {
  // The inversion above establishes WHICH job (the label says "current") and
  // WHOSE job (the section heading). Neither establishes that the label is
  // asking for an employer or a title AT ALL, so the evidence leaked onto any
  // label the two tagged rules' regexes happened to touch. Proved by execution
  // 2026-08-06 with (a)+(b) in place and no label-shape test:
  //
  //   "Current Hiring Company"                  -> OK "Globex"
  //   "Current Requisition Title"               -> OK "Engineer"
  //   "Currently Recruiting Company"            -> OK "Globex"
  //   "Requisition Title" [Work Experience]     -> OK "Engineer"
  //   "Hiring Company"    [Employment History]  -> OK "Globex"
  //
  // Same defect, arriving through the evidence instead of around it.
  const fields = [
    { l: "Current Hiring Company" },
    { l: "Current Requisition Title" },
    { l: "Current Posting Title" },
    { l: "Currently Recruiting Company" },
    { l: "Requisition Title", section: "Work Experience" },
    { l: "Hiring Company", section: "Employment History" },
    { l: "Vacancy Title", section: "Experience" },
    { l: "Req Title", section: "Work Experience" },
  ]
  const r = jobResolve(fields)
  for (const { l } of fields) {
    const f = r.get(l)
    assert.equal(f.status, "UNKNOWN", `${l}: ${JSON.stringify(f)}`)
    assert.equal(f.value, "")
  }
})

test("the APPLIED_TO veto reads the SECTION too, not only the label", () => {
  // The section is being used as evidence, so it is subject to the same veto.
  // Without this a prose heading grants a work-history reading it should not:
  // "Job Title" under "Tell us about your experience with this position"
  // resolved OK "Engineer" — the heading matched on the word "experience".
  const fields = [
    {
      l: "Job Title",
      section: "Tell us about your experience with this position",
    },
    { l: "Company", section: "The role you are applying for" },
  ]
  const r = jobResolve(fields)
  for (const { l } of fields) {
    const f = r.get(l)
    assert.equal(f.status, "UNKNOWN", `${l}: ${JSON.stringify(f)}`)
    assert.equal(f.value, "")
  }
})

test("BOUNDARY: the label-shape test accepts the wordings a real form uses", () => {
  // The cost of requiring the label to be a bare work-history field name is
  // paid entirely by labels that name some OTHER subject. Ordinary renderings
  // of the same field — a possessive, a slash pair, a required marker, a
  // bracketed aside, "name of" — must all still resolve, or this condition
  // would be a throughput regression dressed up as a guard.
  const fields = [
    { l: "Name of Current Employer" },
    { l: "Current Employer's Name" },
    { l: "Current Employer/Company" },
    { l: "Current Employer *" },
    { l: "Current Employer [required]" },
    { l: "Your Current Employer" },
    { l: "Employer Name", section: "Work History" },
    { l: "Job Title", section: "Positions Held" },
    { l: "Company", section: "Current Employment" },
  ]
  const r = jobResolve(fields)
  for (const { l } of fields) {
    const f = r.get(l)
    assert.equal(f.status, "OK", `${l}: ${JSON.stringify(f)}`)
    assert.equal(f.source, "experience.current")
    assert.ok(["Engineer", "Globex"].includes(f.value), `${l} -> ${f.value}`)
  }
})

test("GAP CLOSED (round 3): a bracketed aside can no longer hide a subject word from the allowlist", () => {
  // The label-shape test stripped "(...)"/"[...]" BEFORE running the token
  // allowlist, so anything inside the brackets was invisible to it and only
  // the APPLIED_TO denylist still guarded that text. The requisition walked
  // straight back in wearing brackets. Proved by execution 2026-08-06:
  //
  //   "Current Employer (Hiring Company)"  -> OK "Globex"
  //   "Current Title (Vacancy Title)"      -> OK "Engineer"
  //
  // The token test now has to pass on the stripped form AND on the full text.
  const labels = [
    "Current Employer (Hiring Company)",
    "Current Title (Vacancy Title)",
    "Current Employer [Requisition]",
    "Current Company (Requisition)",
    "Current Employer (Recruiting Organization)",
    "Current Title [Posting Title]",
  ]
  const r = jobResolve(labels)
  for (const l of labels) {
    const f = r.get(l)
    assert.equal(f.status, "UNKNOWN", `${l}: ${JSON.stringify(f)}`)
    assert.equal(f.value, "", `${l} was filled from the user's own job`)
  }
})

test("BOUNDARY: an ordinary bracketed aside still passes, and a bracket-only label still defers", () => {
  // The strip exists for these, and requiring BOTH forms to pass must not cost
  // them: every token inside the brackets is already in the vocabulary, so the
  // full-text test is satisfied too.
  const ok = [
    "Current Employer (if applicable)",
    "Current Employer [required]",
    "Current Employer (optional)",
    "Current Employer (required)",
    "Current Job Title (if any)",
  ]
  const r = jobResolve(ok)
  for (const l of ok) {
    const f = r.get(l)
    assert.equal(f.status, "OK", `${l}: ${JSON.stringify(f)}`)
    assert.ok(["Engineer", "Globex"].includes(f.value))
  }
  // The other half of why the stripped test is kept rather than folded into
  // the full-text one: a label made of NOTHING BUT an aside has no field name
  // in it at all, and no tokens is not evidence.
  const none = jobResolve([
    { l: "(if applicable)", section: "Work Experience" },
    { l: "[required]", section: "Work Experience" },
  ])
  for (const [l, f] of none) {
    assert.equal(f.status, "UNKNOWN", `${l}: ${JSON.stringify(f)}`)
  }
})

test("GAP CLOSED (round 3): a heading that merely CONTAINS 'experience' grants nothing", () => {
  // OWN_EMPLOYMENT_SECTION's first alternative was a bare \bexperience\b —
  // one loose token matching an unbounded set of headings, and flatly
  // contradicting the comment above it promising an allowlist. Proved by
  // execution 2026-08-06:
  //
  //   "Position Title" [Experience Required]  -> OK "Engineer"
  //   "Employer"       [Years of Experience]  -> OK "Globex"
  //
  // These headings are about the JOB's requirements, not the applicant's
  // history. The allowlist is anchored now: the heading must BE an employment
  // -history heading, not contain a word one uses.
  const fields = [
    { l: "Position Title", section: "Experience Required" },
    { l: "Company", section: "Experience Required" },
    { l: "Job Title", section: "Relevant Experience" },
    { l: "Employer", section: "Years of Experience" },
    { l: "Company", section: "Experience with our products" },
    { l: "Title", section: "Minimum Experience" },
    { l: "Employer", section: "Experience Level" },
    { l: "Company", section: "No experience necessary" },
  ]
  const r = jobResolve(fields)
  for (const { l, section } of fields) {
    const f = r.get(l)
    assert.equal(f.status, "UNKNOWN", `${l} [${section}]: ${JSON.stringify(f)}`)
    assert.equal(f.value, "", `${l} [${section}] was filled`)
  }
})

test("BOUNDARY: the real employment-history headings still grant, punctuation and all", () => {
  // The anchoring must not cost the headings the rule exists for. A bare
  // "Experience" IS a work-history header on a real board and keeps granting;
  // so does a bare "Employment", which the previous comment described as
  // deliberately absent and which is now listed rather than assumed.
  const fields = [
    { l: "Company", section: "Work Experience" },
    { l: "Job Title", section: "Employment History" },
    { l: "Employer", section: "Work History" },
    { l: "Title", section: "Experience" },
    { l: "Company Name", section: "Career History" },
    { l: "Employer", section: "Employment" },
    { l: "Job Title", section: "Positions Held" },
    { l: "Company", section: "Current Employment" },
    { l: "Employer", section: "Previous Employment" },
    { l: "Title", section: "Professional Experience" },
    { l: "Company", section: "Occupational History" },
    { l: "Employer", section: "Employment Record" },
    // rendering variance the normaliser folds: a required marker, a colon,
    // doubled spacing. None of these carries a subject word.
    { l: "Company", section: "Work Experience *" },
    { l: "Job Title", section: "Employment History:" },
    { l: "Employer", section: "  Work   History  " },
  ]
  const r = jobResolve(fields)
  for (const { l, section } of fields) {
    const f = r.get(l)
    assert.equal(f.status, "OK", `${l} [${section}]: ${JSON.stringify(f)}`)
    assert.equal(f.source, "experience.current")
    assert.ok(["Engineer", "Globex"].includes(f.value))
  }
})

test("OVER-DEFERRAL CLOSED: a numbered work-history row and an 'if any' aside resolve again", () => {
  // Measured as a cost of round 2's label-shape test: the token allowlist had
  // no digits and no "any", so the commonest rendering of a repeated
  // work-history block went OK -> UNKNOWN for no safety benefit. A row index
  // names no subject, and neither does "any".
  const fields = [
    { l: "Employer 1", section: "Work Experience" },
    { l: "Company 1", section: "Employment History" },
    { l: "Job Title 1", section: "Work Experience" },
    { l: "Employer No. 1", section: "Work Experience" },
    { l: "Current Employer, if any" },
    { l: "Current Employer (if any)" },
  ]
  const r = jobResolve(fields)
  for (const { l, section } of fields) {
    const f = r.get(l)
    assert.equal(f.status, "OK", `${l} [${section}]: ${JSON.stringify(f)}`)
    assert.equal(f.source, "experience.current")
    assert.ok(["Engineer", "Globex"].includes(f.value))
  }
})

test("THE COST OF ADMITTING DIGITS, paid deliberately: row 2 and beyond still defer", () => {
  // Admitting the digit into the label vocabulary would otherwise have created
  // a NEW wrong answer rather than closing an old deferral: the two
  // current-job rules read profile.experience[0] and have no notion of any
  // other job, so "Employer 2" under a work-history heading would be answered
  // with the CURRENT employer. That is the same WHICH-job defect the
  // out-of-scope "Previous Employer" test records, and this keeps it from
  // spreading to numbered rows.
  //
  // Recorded as a deviation, not a silent choice: the adversary's measurement
  // listed "Company #2" [Employment History] as an over-deferral to close, and
  // it is still deferred here, because closing it means asserting the wrong
  // employer for that row.
  const fields = [
    { l: "Employer 2", section: "Work Experience" },
    { l: "Company #2", section: "Employment History" },
    { l: "Employer 3", section: "Work Experience" },
    { l: "Job Title 2", section: "Work Experience" },
  ]
  const r = jobResolve(fields)
  for (const { l, section } of fields) {
    const f = r.get(l)
    assert.equal(f.status, "UNKNOWN", `${l} [${section}]: ${JSON.stringify(f)}`)
    assert.equal(f.value, "")
  }
  // The digit is bounded to a row index, so a year or a plan number is not one
  // and defers on the token allowlist as it always did.
  const other = jobResolve([
    { l: "Employer 2019", section: "Work Experience" },
    { l: "Company 401k", section: "Work Experience" },
  ])
  for (const [l, f] of other) {
    assert.equal(f.status, "UNKNOWN", `${l}: ${JSON.stringify(f)}`)
  }
})

// THE MEASUREMENT the inversion has to carry, run rather than estimated. The
// corpus below is the repo-side half: every row carries the status it must
// resolve to and WHY, and the tallies are asserted, so the cost cannot drift
// in either direction without a test failing.
//
// MEASURED 2026-08-06 by resolving a 125-label corpus — the 58 distinct labels
// in tests/fixtures/boards/scans/*.json plus the requisition, work-history and
// prior-employment shapes below — against three reconstructions of this guard:
// none at all (HEAD), the APPLIED_TO denylist, and WHICH-job evidence without
// the label-shape test.
//
//   denylist        -> now :  31 labels changed, 30 of them OK -> UNKNOWN
//                             (+1 NEEDS-CHOICE "Globex" -> UNKNOWN, a consent
//                             checkbox that merely contained the word
//                             "company"). Of the 30: TWENTY-TWO were wrong
//                             answers being withdrawn — 17 requisition-shaped
//                             labels, 4 fabricated "No"s about a company the
//                             question never named, and "Previous Employer"
//                             answered with the CURRENT employer — and EIGHT
//                             are the genuine throughput cost, the bare
//                             ambiguous labels tagged "ambiguous" below.
//   (a)+(b) only    -> now :   9 labels changed, all OK -> UNKNOWN, all nine
//                             wrong answers. The label-shape condition costs
//                             NOTHING on this corpus: no legitimate case moved.
//
// Every work-history row under a section heading kept resolving throughout, so
// a board that emits headings loses nothing at all. Eight ambiguous bare
// labels is the whole price, and it is one question to the owner each.
//
// WHY 17 AND NOT 24. The corpus below carries 24 requisition rows but only 17
// CHANGED against the denylist baseline: the other seven ("Position Applied
// For", "Company you are applying to", "Desired Position", "Position of
// Interest", "Role sought", "Prospective employer", "Title of this position")
// already deferred there, because APPLIED_TO happened to name their wording.
// They are kept in the corpus precisely because that is the point — the
// denylist caught the seven someone thought of and none of the rest.
//
// RE-MEASURED 2026-08-06 after round 3 (the bracket strip, the anchored
// section allowlist, the non-adjacent placeholder test and the digit/"any"
// tokens), on a 161-label corpus: the same 58 fixture labels plus 103 authored
// shapes, resolved against the round-2 code and against this one.
//
//   round 2 -> now :  19 labels changed.
//     15 OK -> UNKNOWN, and every one of the fifteen is a WRONG ANSWER being
//        withdrawn — 4 requisition labels hidden inside brackets, 5 own-job
//        labels sitting under a job-requirements heading, and 6 fabricated
//        "No"s about a company the question never named.
//      4 UNKNOWN -> OK, and every one of the four is a legitimate own-job
//        field the round-2 vocabulary could not spell: "Employer 1",
//        "Job Title 1" and "Employer No. 1" under a work-history heading, and
//        "Current Employer, if any".
//     ZERO legitimate answers were lost: not one row moved from OK to a defer
//     that was not already a wrong answer, and none of the 58 fixture labels
//     moved at all.
//
// NOT CLOSED, AND DELIBERATELY: "Company #2" / "Employer 2" stay UNKNOWN. The
// adversary counted those as over-deferrals, but the two current-job rules can
// only answer row ONE — see the "COST OF ADMITTING DIGITS" test above.
const REAL_ATS_LABELS = [
  // untouched by the inversion — the rest of the resolver, asserted so a
  // regression here shows up as a corpus failure rather than a mystery
  { l: "First Name *", want: "OK", why: "control" },
  { l: "Last Name *", want: "OK", why: "control" },
  { l: "Email *", want: "OK", why: "control" },
  // no location in JOB_PROFILE
  { l: "Current location (city)", want: "UNKNOWN", why: "control" },
  // the requisition — named outright
  { l: "Requisition Title", want: "UNKNOWN", why: "requisition" },
  { l: "Vacancy Title", want: "UNKNOWN", why: "requisition" },
  { l: "Position Title", want: "UNKNOWN", why: "requisition" },
  { l: "Posting Title", want: "UNKNOWN", why: "requisition" },
  { l: "Req Title", want: "UNKNOWN", why: "requisition" },
  { l: "Hiring Company", want: "UNKNOWN", why: "requisition" },
  { l: "Recruiting Company", want: "UNKNOWN", why: "requisition" },
  { l: "Hiring Organization", want: "UNKNOWN", why: "requisition" },
  { l: "Position Applied For", want: "UNKNOWN", why: "requisition" },
  { l: "Company you are applying to", want: "UNKNOWN", why: "requisition" },
  { l: "Desired Position", want: "UNKNOWN", why: "requisition" },
  { l: "Position of Interest", want: "UNKNOWN", why: "requisition" },
  { l: "Role sought", want: "UNKNOWN", why: "requisition" },
  { l: "Prospective employer", want: "UNKNOWN", why: "requisition" },
  { l: "Title of this position", want: "UNKNOWN", why: "requisition" },
  // the requisition, WITH which-job evidence attached — the round-2 gap
  { l: "Current Hiring Company", want: "UNKNOWN", why: "requisition" },
  { l: "Current Requisition Title", want: "UNKNOWN", why: "requisition" },
  { l: "Current Posting Title", want: "UNKNOWN", why: "requisition" },
  { l: "Currently Recruiting Company", want: "UNKNOWN", why: "requisition" },
  {
    l: "Requisition Title",
    section: "Work Experience",
    want: "UNKNOWN",
    why: "requisition",
  },
  {
    l: "Hiring Company",
    section: "Employment History",
    want: "UNKNOWN",
    why: "requisition",
  },
  {
    l: "Vacancy Title",
    section: "Experience",
    want: "UNKNOWN",
    why: "requisition",
  },
  {
    l: "Req Title",
    section: "Work Experience",
    want: "UNKNOWN",
    why: "requisition",
  },
  {
    l: "Job Title",
    section: "Tell us about your experience with this position",
    want: "UNKNOWN",
    why: "requisition",
  },
  // ambiguous, no evidence either way — the cost
  { l: "Job Title", want: "UNKNOWN", why: "ambiguous" },
  { l: "Title", want: "UNKNOWN", why: "ambiguous" },
  { l: "Employer", want: "UNKNOWN", why: "ambiguous" },
  { l: "Employer Name", want: "UNKNOWN", why: "ambiguous" },
  { l: "Company Name", want: "UNKNOWN", why: "ambiguous" },
  { l: "Company", want: "UNKNOWN", why: "ambiguous" },
  { l: "Organisation name", want: "UNKNOWN", why: "ambiguous" },
  { l: "Organization", want: "UNKNOWN", why: "ambiguous" },
  // the applicant's own job, said in the label
  { l: "Current Employer", want: "OK", why: "own-job-label" },
  { l: "Current Job Title", want: "OK", why: "own-job-label" },
  { l: "Current Company", want: "OK", why: "own-job-label" },
  { l: "Current Title", want: "OK", why: "own-job-label" },
  { l: "Current Employer (if applicable)", want: "OK", why: "own-job-label" },
  { l: "Most Recent Employer", want: "OK", why: "own-job-label" },
  { l: "Most Recent Job Title", want: "OK", why: "own-job-label" },
  { l: "Present Employer", want: "OK", why: "own-job-label" },
  { l: "Latest Job Title", want: "OK", why: "own-job-label" },
  { l: "Existing employer", want: "OK", why: "own-job-label" },
  // the applicant's own job, said by the section
  {
    l: "Company",
    section: "Work Experience",
    want: "OK",
    why: "own-job-section",
  },
  {
    l: "Job Title",
    section: "Work Experience",
    want: "OK",
    why: "own-job-section",
  },
  {
    l: "Employer",
    section: "Employment History",
    want: "OK",
    why: "own-job-section",
  },
  { l: "Title", section: "Experience", want: "OK", why: "own-job-section" },
  {
    l: "Company Name",
    section: "Career History",
    want: "OK",
    why: "own-job-section",
  },
  {
    l: "Position Title",
    section: "Work Experience",
    want: "OK",
    why: "own-job-section",
  },
  // round 3 — the requisition hidden inside a bracketed aside
  {
    l: "Current Employer (Hiring Company)",
    want: "UNKNOWN",
    why: "requisition",
  },
  { l: "Current Title (Vacancy Title)", want: "UNKNOWN", why: "requisition" },
  { l: "Current Employer [Requisition]", want: "UNKNOWN", why: "requisition" },
  { l: "Current Company (Requisition)", want: "UNKNOWN", why: "requisition" },
  // round 3 — a heading about the JOB's requirements, not the applicant's
  // history. A bare \bexperience\b matched all four.
  {
    l: "Position Title",
    section: "Experience Required",
    want: "UNKNOWN",
    why: "job-heading",
  },
  {
    l: "Company",
    section: "Experience Required",
    want: "UNKNOWN",
    why: "job-heading",
  },
  {
    l: "Job Title",
    section: "Relevant Experience",
    want: "UNKNOWN",
    why: "job-heading",
  },
  {
    l: "Employer",
    section: "Years of Experience",
    want: "UNKNOWN",
    why: "job-heading",
  },
  // round 3 — the numbered/optional own-job rows the digit and "any" tokens
  // bought back
  {
    l: "Employer 1",
    section: "Work Experience",
    want: "OK",
    why: "own-job-row",
  },
  {
    l: "Job Title 1",
    section: "Work Experience",
    want: "OK",
    why: "own-job-row",
  },
  {
    l: "Employer No. 1",
    section: "Work Experience",
    want: "OK",
    why: "own-job-row",
  },
  { l: "Current Employer, if any", want: "OK", why: "own-job-row" },
  // round 3 — the row these rules cannot answer, kept deferring on purpose
  {
    l: "Employer 2",
    section: "Work Experience",
    want: "UNKNOWN",
    why: "later-row",
  },
  {
    l: "Company #2",
    section: "Employment History",
    want: "UNKNOWN",
    why: "later-row",
  },
]

test("MEASURED: the real-ATS label corpus resolves exactly as recorded", () => {
  const r = jobResolve(
    REAL_ATS_LABELS.map(({ l, section }) => ({ l, section })),
  )
  // Map is keyed by label, and the corpus reuses labels across sections, so
  // resolve positionally instead.
  const fields = REAL_ATS_LABELS.map((x, i) => ({
    k: `f${i}`,
    t: "text",
    l: x.l,
    section: x.section,
  }))
  const { results } = createResolver(JOB_PROFILE, { answers: [] }).resolveAll(
    fields,
  )
  assert.equal(results.length, REAL_ATS_LABELS.length)
  assert.ok(REAL_ATS_LABELS.length >= 30, "the corpus must stay realistic")
  let ok = 0
  const byWhy = {}
  for (let i = 0; i < results.length; i++) {
    const want = REAL_ATS_LABELS[i].want
    const got = results[i]
    const where = REAL_ATS_LABELS[i].section
      ? `${REAL_ATS_LABELS[i].l} [${REAL_ATS_LABELS[i].section}]`
      : REAL_ATS_LABELS[i].l
    assert.equal(got.status, want, `${where}: ${JSON.stringify(got)}`)
    if (want === "OK") ok++
    byWhy[REAL_ATS_LABELS[i].why] = (byWhy[REAL_ATS_LABELS[i].why] ?? 0) + 1
    // Whatever the status, the user's own job must never reach a label that
    // names the requisition.
    if (want === "UNKNOWN") {
      assert.notEqual(got.value, "Engineer", where)
      assert.notEqual(got.value, "Globex", where)
    }
  }
  assert.equal(ok, 23, "the answerable half of the corpus")
  // The measured cost, asserted rather than narrated. `ambiguous` is the ONLY
  // category that is a genuine throughput loss; `requisition` and
  // `job-heading` are wrong answers withdrawn, `later-row` is a wrong answer
  // never created, and the three own-job categories are the case the rules
  // exist for and must never shrink.
  assert.deepEqual(byWhy, {
    control: 4,
    requisition: 28,
    "job-heading": 4,
    ambiguous: 8,
    "own-job-label": 10,
    "own-job-section": 6,
    "own-job-row": 4,
    "later-row": 2,
  })
  assert.ok(r.size > 0)
})

test("OUT OF SCOPE, asserted UNCHANGED: 'Previous Employer' under a section still answers with the CURRENT employer", () => {
  // Pre-existing and belonging to a different rule: the two current-job rules
  // have no notion of WHICH of the user's jobs is being asked for, so a
  // work-history section asking for a PREVIOUS employer still gets the
  // current one. This inversion does not fix that and must not be read as
  // having done so.
  const r = jobResolve([
    { l: "Previous Employer", section: "Employment History" },
  ])
  const f = r.get("Previous Employer")
  assert.equal(f.status, "OK")
  assert.equal(f.value, "Globex")
  assert.equal(f.source, "experience.current")
})

test("side effect of the inversion, recorded: a BARE 'Previous Employer' now defers", () => {
  // Not a fix for the above — a consequence of requiring positive evidence.
  // "previous" is not evidence that the question is about the CURRENT job, so
  // with no section heading there is nothing to justify answering, and the
  // wrong answer is withheld rather than typed. Recorded so the change is
  // visible rather than discovered later.
  const r = jobResolve(["Previous Employer"])
  const f = r.get("Previous Employer")
  assert.equal(f.status, "UNKNOWN")
  assert.equal(f.value, "")
})

test("dropping the rule leaves the label to the bank, which can still answer it", () => {
  // The guard REMOVES the two current-job rules for this label rather than
  // blanking their value, so an answer the user banked for exactly this
  // question is still reached. A blanked value would have returned UNKNOWN
  // before the bank was ever consulted.
  const r = jobResolve(["Position Applied For"], {
    answers: [
      {
        id: "a-501",
        question: "Position Applied For",
        answer: "Senior Full-Stack Developer",
      },
    ],
  })
  const f = r.get("Position Applied For")
  assert.equal(f.status, "OK")
  assert.equal(f.value, "Senior Full-Stack Developer")
  assert.match(f.source, /^a-501@exact/)
})

// ---------------------------------------------------------------------------
// prior employment: a company the question never named (found 2026-08-05)
// ---------------------------------------------------------------------------
// priorEmployment() answers only the negative, because the profile can prove
// someone is ABSENT from a complete employment history. It cannot prove
// absence from a company the label never identified — and intents.mjs's
// param() used to hand it the literal string "our company", which matched no
// entry in profile.experience and so read as proof of absence. Observed before
// the fix, with Globex in the employment history:
//
//   {"k":"q1","label":"Have you ever worked for our company before?",
//    "status":"OK","source":"experience","value":"No"}
//
// If the user HAS worked there, that is a false statement on a submitted
// application. The correctly-named question already deferred, which is what
// made the placeholder case a defect rather than a design.
test("prior employment defers when the company is only a pronoun", () => {
  const labels = [
    "Have you ever worked for our company before?",
    "Have you ever worked for this company before?",
    "Have you ever been employed by us?",
    "Have you previously worked for our organization?",
    "Have you ever been employed by any of our subsidiaries?",
  ]
  const r = jobResolve(labels)
  for (const l of labels) {
    const f = r.get(l)
    assert.notEqual(f.status, "OK", `${l}: ${JSON.stringify(f)}`)
    assert.notEqual(f.value, "No", `${l} must not assert a "No" about nobody`)
  }
})

test("GAP CLOSED: one token outside the generic vocabulary no longer makes a placeholder a name", () => {
  // The first fix classified a phrase as a placeholder only when EVERY token
  // was in a hand-written vocabulary, so a single unlisted qualifier turned it
  // back into a "company name" and re-enabled the fabricated "No". Observed
  // before this fix, with Globex in the employment history — "related" was the
  // only token missing from the list:
  //
  //   "Have you ever worked for this employer or its related entities?"
  //     -> {"status":"OK","value":"No","param":"this employer or its related
  //         entities"}
  const labels = [
    "Have you ever worked for this employer or its related entities?",
    "Have you ever worked for our organization, its subsidiaries or affiliates?",
    "Have you ever been employed by this company or any of its wholly-owned units?",
    "Are you a former employee of the organization or its predecessor entities?",
    "Have you previously been employed by us or any related employer?",
  ]
  const r = jobResolve(labels)
  for (const l of labels) {
    const f = r.get(l)
    assert.notEqual(f.status, "OK", `${l}: ${JSON.stringify(f)}`)
    assert.equal(f.value, "", `${l} must not assert anything about nobody`)
  }
})

test("the defer REASON says the question named no company, not that the profile is missing one", () => {
  // What the owner reads in pending-questions.mjs. The observed note was
  // {"status":"UNKNOWN","source":"experience","note":"not in
  // profile.experience"} — which sends them looking for a gap in their own
  // fact base that does not exist. Nothing is missing; the question named
  // nobody.
  const r = jobResolve(["Have you ever worked for our company before?"])
  const f = r.get("Have you ever worked for our company before?")
  assert.equal(f.status, "UNKNOWN")
  assert.match(f.note, /names no company/)
  assert.doesNotMatch(f.note, /not in profile\./)
})

test("a NAMED company the user never worked at ALSO defers", () => {
  // This test asserted the opposite until 2026-08-05, on the stated grounds
  // that "Initech is absent from a complete employment history, so No is a
  // fact the profile does make". The premise was false and it is worth being
  // precise about why, because the conclusion looks obviously right.
  //
  // `profile.yaml` is distilled from the owner's resumes. A resume is a
  // SELECTION, not a census — it leaves out short stints, unrelated work, and
  // anything that did not help the application it was written for. So the
  // profile can prove PRESENCE ("this employer is in the record") and can
  // never prove ABSENCE ("this employer is in no record anywhere"). Answering
  // "No, I have never worked for Initech" from a file that never claimed to
  // list every job is a statement the fact base cannot back — hard rule 1 —
  // and it goes onto a real application under the owner's name.
  //
  // The negative path was indeed "the whole point of the rule". The rule had
  // no sound version, so it no longer answers. The cost is one question per
  // form that asks this; pending-questions.mjs surfaces it.
  const r = jobResolve([
    "Have you ever worked for Initech before?",
    "Have you previously been employed at Initech?",
  ])
  for (const [l, f] of r) {
    assert.notEqual(f.status, "OK", `${l}: ${JSON.stringify(f)}`)
    assert.equal(f.value, "", `${l} must carry no value`)
  }
})

test("BOUNDARY: a named company the user DID work at still defers", () => {
  // Unchanged by this fix, and asserted here so a later widening of the
  // placeholder list cannot quietly turn presence into a "No" either.
  const r = jobResolve(["Have you ever worked for Globex before?"])
  const f = r.get("Have you ever worked for Globex before?")
  assert.notEqual(f.status, "OK")
  assert.equal(f.value, "")
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

// ---------------------------------------------------------------------------
// Voluntary self-ID: the auto-decline must never overwrite a banked answer
//
// MEASURED 2026-08-06 on three live Ashby applications. The EEO branch ran
// AHEAD of the fuzzy bank match and behind only an EXACT question match, so a
// bank holding "Race" -> "Hispanic or Latino" answered the label "Race" from
// the bank and answered every other wording of the same question with
// "Decline to self identify" at status OK — filled and submitted with no
// review, contradicting the answer the user had actually given. No two boards
// word these questions alike, so the exact map missed far more often than it
// hit.
// ---------------------------------------------------------------------------
const DECLINE = "Decline to self identify"
const selfIdField = (k, l, opts) => ({
  k,
  l,
  t: "select",
  o: opts.map((o, i) => ({ k: `${k}o${i}`, l: o })),
})
const RACE_OPTS = ["Hispanic or Latino", "Asian", DECLINE]
const GENDER_OPTS = ["Male", "Female", DECLINE]
const selfIdResolve = (fields, answersDoc) =>
  new Map(
    createResolver(JOB_PROFILE, answersDoc)
      .resolveAll(fields)
      .results.map((r) => [r.k, r]),
  )

const RACE_BANK = {
  answers: [
    {
      id: "c1",
      question: "Race",
      answer: "Hispanic or Latino",
      source: "user",
    },
  ],
}

test("a banked self-ID answer survives every rewording of the question", () => {
  const fields = [
    selfIdField("f1", "Race", RACE_OPTS),
    selfIdField("f2", "Race / Ethnicity", RACE_OPTS),
    selfIdField("f3", "What is your race/ethnicity?", RACE_OPTS),
    selfIdField("f4", "Please select your race", RACE_OPTS),
  ]
  const r = selfIdResolve(fields, RACE_BANK)
  for (const k of ["f1", "f2", "f3", "f4"]) {
    assert.equal(r.get(k).status, "OK", `${k} did not resolve`)
    assert.equal(
      r.get(k).value,
      "Hispanic or Latino",
      `${k} was answered with something other than the banked answer`,
    )
  }
})

test("BOUNDARY: with nothing banked, self-ID still auto-declines", () => {
  // The decline exists to spare the user a question they never answered. That
  // behaviour is the reason the branch is there and must not regress.
  const fields = [
    selfIdField("f1", "Race / Ethnicity", RACE_OPTS),
    selfIdField("f2", "Gender", GENDER_OPTS),
    selfIdField("f3", "Veteran Status", ["Yes", "No", DECLINE]),
  ]
  const r = selfIdResolve(fields, { answers: [] })
  for (const k of ["f1", "f2", "f3"]) {
    assert.equal(r.get(k).status, "OK")
    assert.equal(r.get(k).value, DECLINE)
    assert.equal(r.get(k).source, "eeo:decline")
  }
})

test("BOUNDARY: an unrelated banked answer is never voted onto a self-ID field", () => {
  // The fuzzy matcher is loose by design. It must not reach 0.7 against a
  // question about something else and put that answer on a self-ID field.
  const bank = {
    answers: [
      {
        id: "b1",
        question: "Are you authorized to work in the US?",
        answer: "Yes",
        source: "user",
      },
      {
        id: "b2",
        question: "How did you hear about us?",
        answer: "LinkedIn",
        source: "user",
      },
    ],
  }
  const fields = [
    selfIdField("f1", "Race / Ethnicity", RACE_OPTS),
    selfIdField("f2", "Gender", GENDER_OPTS),
  ]
  const r = selfIdResolve(fields, bank)
  for (const k of ["f1", "f2"]) {
    assert.equal(r.get(k).source, "eeo:decline", `${k} took a foreign answer`)
    assert.equal(r.get(k).value, DECLINE)
  }
})

test("BOUNDARY: banking one self-ID answer does not answer the others", () => {
  const fields = [
    selfIdField("f1", "Race / Ethnicity", RACE_OPTS),
    selfIdField("f2", "Gender", GENDER_OPTS),
  ]
  const r = selfIdResolve(fields, RACE_BANK)
  assert.equal(r.get("f1").value, "Hispanic or Latino")
  assert.equal(r.get("f2").value, DECLINE)
  assert.equal(r.get("f2").source, "eeo:decline")
})

test("a banked answer the board does not offer defers rather than coercing", () => {
  // The wording mismatch is the thing to surface. Silently declining over it
  // would be the original defect wearing a different hat, and picking the
  // nearest option would be a claim the user never made.
  const fields = [selfIdField("f1", "Race / Ethnicity", RACE_OPTS)]
  const r = selfIdResolve(fields, {
    answers: [{ id: "d1", question: "Race", answer: "Latinx", source: "user" }],
  })
  assert.equal(r.get("f1").status, "NEEDS-CHOICE")
  assert.notEqual(r.get("f1").value, DECLINE)
})
