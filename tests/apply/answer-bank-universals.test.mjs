// The questions that appear on nearly every US application. Each of these was
// deferred to the user on a real Affirm form on 2026-07-28; fixing them once
// pays off on every future application, which is why they get their own file.
import test from "node:test"
import assert from "node:assert/strict"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")

function resolve(fields) {
  const res = spawnSync(
    process.execPath,
    [
      path.join(ROOT, "scripts", "apply", "answer-bank.mjs"),
      "--fields",
      JSON.stringify(fields),
      "--json",
      "--profile",
      path.join(ROOT, "tests", "fixtures", "profile.yaml"),
      "--answers",
      path.join(ROOT, "tests", "fixtures", "answers-bank.yaml"),
    ],
    { cwd: ROOT, encoding: "utf8" },
  )
  assert.equal(res.status, 0, res.stderr)
  return new Map(JSON.parse(res.stdout).results.map((r) => [r.k, r]))
}

const YESNO = ["Yes", "No"]

test("sponsorship and work authorization are never crossed", () => {
  // The dangerous case: these share almost every token, so token similarity
  // ranked "authorized to work = Yes" against "do you require sponsorship",
  // which would claim the user needs a visa and auto-reject them.
  const r = resolve([
    {
      k: "a",
      t: "combo",
      l: "Do you require immigration sponsorship to work for Acme in the United States?*",
      opts: YESNO,
    },
    {
      k: "b",
      t: "combo",
      l: "Will you require immigration sponsorship at any point in the future to maintain authorization to work in the United States?",
      opts: YESNO,
    },
    {
      k: "c",
      t: "combo",
      l: "Are you legally authorized to work in the country where this position is located?*",
      opts: YESNO,
    },
  ])
  assert.equal(r.get("a").value, "No", "requires sponsorship")
  assert.equal(
    r.get("b").value,
    "No",
    "sponsorship wins when both concepts appear",
  )
  assert.equal(r.get("c").value, "Yes", "authorized to work")
  for (const k of ["a", "b", "c"]) assert.equal(r.get(k).status, "OK", k)
})

test("a concept question is never answered from a different concept", () => {
  // With no sponsorship answer banked at all, the authorization answer must NOT
  // be borrowed — better to ask than to assert the opposite.
  const res = spawnSync(
    process.execPath,
    [
      path.join(ROOT, "scripts", "apply", "answer-bank.mjs"),
      "--fields",
      JSON.stringify([
        {
          k: "a",
          t: "combo",
          l: "Do you require visa sponsorship?",
          opts: YESNO,
        },
      ]),
      "--json",
      "--profile",
      path.join(ROOT, "tests", "fixtures", "profile.yaml"),
      "--answers",
      path.join(ROOT, "tests", "fixtures", "answers-only-auth.yaml"),
    ],
    { cwd: ROOT, encoding: "utf8" },
  )
  assert.equal(res.status, 0, res.stderr)
  const r = JSON.parse(res.stdout).results[0]
  assert.notEqual(r.value, "Yes", "must never claim sponsorship is required")
})

test("decline-to-answer is recognised however it is worded", () => {
  const r = resolve([
    {
      k: "a",
      t: "combo",
      l: "Disability Status",
      opts: [
        "Yes, I have a disability, or have had one in the past",
        "No, I do not have a disability and have not had one in the past",
        "I do not want to answer",
      ],
    },
    {
      k: "b",
      t: "combo",
      l: "Veteran Status",
      opts: ["I am not a protected veteran", "I don't wish to answer"],
    },
    {
      k: "c",
      t: "combo",
      l: "Gender",
      opts: ["Male", "Female", "Decline To Self Identify"],
    },
  ])
  assert.equal(r.get("a").value, "I do not want to answer")
  assert.equal(r.get("b").value, "I don't wish to answer")
  assert.equal(r.get("c").value, "Decline To Self Identify")
})

test("a state abbreviation matches a spelled-out option and vice versa", () => {
  const spelled = resolve([
    {
      k: "a",
      t: "combo",
      l: "Which U.S. State or Canadian Province do you reside in?*",
      opts: ["California", "Illinois", "Nevada"],
    },
  ])
  assert.equal(spelled.get("a").value, "Illinois")

  const abbrev = resolve([
    { k: "a", t: "combo", l: "State", opts: ["CA", "IL", "NV"] },
  ])
  assert.equal(abbrev.get("a").value, "IL")
})

test("prior employment answers No from a complete employment history", () => {
  const r = resolve([
    {
      k: "a",
      t: "combo",
      l: "Have you previously been employed at Affirm for any length of time?*",
      opts: [
        "I have not previously been employed at Affirm",
        "I have been employed at Affirm as a full-time employee",
      ],
    },
    {
      k: "b",
      t: "combo",
      l: "Have you previously been employed by Coinbase in any capacity?*",
      opts: YESNO,
    },
  ])
  assert.equal(
    r.get("a").value,
    "I have not previously been employed at Affirm",
  )
  assert.equal(r.get("b").value, "No")
})

test("prior employment defers when the company IS in the history", () => {
  // The profile proves absence, not the capacity someone was employed in.
  const r = resolve([
    {
      k: "a",
      t: "combo",
      l: "Have you previously been employed at Acme Corp?",
      opts: ["Yes, full-time", "Yes, as a contractor", "No"],
    },
  ])
  assert.notEqual(
    r.get("a").status,
    "OK",
    "must not answer No about a real employer",
  )
})

test("how-did-you-hear falls back Job Board -> Other -> LinkedIn", () => {
  const r = resolve([
    {
      k: "a",
      t: "combo",
      l: "How did you hear about this job?*",
      opts: ["Job Board", "LinkedIn", "Other"],
    },
    {
      k: "b",
      t: "combo",
      l: "How did you first learn about Acme as an employer? *",
      opts: ["Glassdoor", "Indeed", "LinkedIn", "Other"],
    },
    {
      k: "c",
      t: "combo",
      l: "How did you first learn about us?",
      opts: ["Glassdoor", "LinkedIn"],
    },
  ])
  assert.equal(r.get("a").value, "Job Board", "banked answer wins when offered")
  assert.equal(r.get("b").value, "Other", "no Job Board option -> Other")
  assert.equal(
    r.get("c").value,
    "LinkedIn",
    "no Other option either -> LinkedIn",
  )
})

test("Other Links carries only links the form has no field for", () => {
  // User decision 2026-07-28: github and website go here, unless the form
  // already asks for them separately.
  const covered = resolve([
    { k: "a", t: "textarea", l: "Other Links" },
    { k: "b", t: "text", l: "GitHub" },
    { k: "c", t: "text", l: "Portfolio" },
  ])
  assert.notEqual(covered.get("a").status, "OK", "nothing left to add")

  const partly = resolve([
    { k: "a", t: "textarea", l: "Other Links" },
    { k: "b", t: "text", l: "GitHub" },
  ])
  assert.equal(partly.get("a").status, "OK")
  assert.match(partly.get("a").value, /janetest\.example/)
  assert.ok(
    !/github/i.test(partly.get("a").value),
    "the form already has its own GitHub field",
  )

  const bare = resolve([{ k: "a", t: "textarea", l: "Other Links" }])
  assert.match(bare.get("a").value, /github/i)
  assert.match(bare.get("a").value, /janetest\.example/)
})

test("a long-form option is matched from a plain Yes/No answer", () => {
  const r = resolve([
    {
      k: "a",
      t: "combo",
      l: "Will you now or in the future require sponsorship for employment visa status?",
      opts: [
        "Yes, I will require sponsorship",
        "No, I will not require sponsorship",
      ],
    },
  ])
  assert.equal(r.get("a").value, "No, I will not require sponsorship")
})
