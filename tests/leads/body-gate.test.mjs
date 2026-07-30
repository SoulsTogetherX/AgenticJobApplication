// The body gate: disqualifiers that only ever appear in a posting's text, not
// in the title/location/date the board list endpoints hand over.
//
// Every case here is a posting that was actually sitting in the live lead store
// on 2026-07-29, mis-filed as a real software lead because nothing read its
// body. The precision cases matter as much as the detection ones: a false
// reject is a job the user never sees.
import test from "node:test"
import assert from "node:assert/strict"
import { bodyDisqualifiers } from "../../scripts/leads/find-jobs.mjs"

const LIMITS = {
  location: {
    base: "North Las Vegas, NV",
    onsite_allowed: ["north las vegas", "las vegas", "henderson"],
  },
  roles: {
    title_keywords: [
      "full stack",
      "back-end",
      "software engineer",
      "software developer",
      "web developer",
    ],
  },
}

const job = (o) => ({ title: "Software Engineer", description: "", ...o })

// A body with enough unambiguous software vocabulary to read as technical.
const SOFTWARE_BODY =
  "You will build and maintain web applications, review pull requests, write " +
  "unit tests, and work across our TypeScript and Python services backed by a " +
  "PostgreSQL database."

test("a lead with no description passes — the gate cannot judge text it lacks", () => {
  const v = bodyDisqualifiers(job({ description: null }), LIMITS)
  assert.equal(v.ok, true)
  assert.deepEqual(v.reasons, [])
  assert.deepEqual(v.flags, [])
})

test("clean software posting passes with no flags", () => {
  const v = bodyDisqualifiers(
    job({ title: "Full Stack Developer", description: SOFTWARE_BODY }),
    LIMITS,
  )
  assert.equal(v.ok, true)
  assert.deepEqual(v.flags, [])
})

// --- non-software body -------------------------------------------------------

test("rejects a facilities job that reached the store on a local title match", () => {
  // Station Casinos "Junior Engineer - Palace", verbatim shape.
  const v = bodyDisqualifiers(
    job({
      title: "Junior Engineer - Palace",
      flags: ["title_loose"],
      description:
        "Pick up supplies and parts from vendors. Perform all repairs, " +
        "maintenance and part replacements. Continually assess the preventive " +
        "maintenance schedule to ensure equipment longevity. Be familiar with " +
        "OSHA safety codes regarding chemicals and electrical equipment. " +
        "Experience on any of the following fields a plus: plumbing, electrical, HVAC.",
    }),
    LIMITS,
  )
  assert.equal(v.ok, false)
  assert.match(v.reasons.join(" "), /not a software role/)
})

test('"OSHA safety codes" is not evidence of a software job', () => {
  // Regression: the first SOFTWARE_BODY pattern matched bare "code", so a
  // maintenance posting proved itself technical by mentioning safety codes.
  const v = bodyDisqualifiers(
    job({
      title: "General Engineer",
      flags: ["title_loose"],
      description:
        "Be familiar with OSHA safety codes. Perform preventive maintenance " +
        "on guest rooms and HVAC equipment. Complete the rest of the assigned " +
        "work orders. Submit your application through our portal.",
    }),
    LIMITS,
  )
  assert.equal(
    v.ok,
    false,
    "safety codes / job application must not read as software",
  )
})

test("rejects a casino-floor job whose body is pure hospitality boilerplate", () => {
  // Station Casinos "Kitchen Worker", verbatim shape. The local boards are
  // overwhelmingly floor postings and a few reach the store on title latitude,
  // so the hospitality vocabulary has to be decisive on its own — this body
  // names no trade and no technology at all.
  const v = bodyDisqualifiers(
    job({
      title: "Junior Engineer - Palace",
      flags: ["title_loose"],
      description:
        "Responsible for practicing, supporting, and promoting Company-wide " +
        "culture. Maintain cleanliness of assigned area as instructed. " +
        "Qualifications: Previous cleaning experience preferred. Ability to " +
        "communicate effectively with Guests, Team Members and Management.",
    }),
    LIMITS,
  )
  assert.equal(v.ok, false)
  assert.match(v.reasons.join(" "), /not a software role/)
})

test("hospitality terms do not fire on software prose that reuses the words", () => {
  // "code cleanliness" and "web server" are why the pattern says "maintain
  // cleanliness" and "beverage server" rather than the bare nouns.
  const v = bodyDisqualifiers(
    job({
      title: "Software Engineer",
      flags: ["title_loose"],
      description:
        `${SOFTWARE_BODY} You will care about code cleanliness, tune our web ` +
        "server fleet, and serve guest users through a public API.",
    }),
    LIMITS,
  )
  assert.equal(v.ok, true)
  assert.deepEqual(v.flags, [])
})

test("a technical-but-not-software body flags rather than rejects", () => {
  // Network/cloud/analyst work is real engineering and the user may still want
  // to see it; it just is not what the profile targets.
  const v = bodyDisqualifiers(
    job({
      title: "Network Engineer II",
      flags: ["title_loose"],
      description:
        "Deploy, configure, manage, and optimize networking equipment and " +
        "protocols such as switches, routers, firewalls and VLANs across the " +
        "property. Maintain vendor relationships and document topology.",
    }),
    LIMITS,
  )
  assert.equal(v.ok, true)
  assert.ok(v.flags.includes("body_not_technical"))
})

test("an explicitly-titled software role is trusted even with a thin body", () => {
  const v = bodyDisqualifiers(
    job({
      title: "Full Stack Developer",
      description: "Join our growing team in a fast-paced environment.",
    }),
    LIMITS,
  )
  assert.equal(v.ok, true)
  assert.deepEqual(v.flags, [])
})

// --- relocation --------------------------------------------------------------

test("rejects a stated relocation requirement", () => {
  for (const phrase of [
    "Candidates must relocate to our Austin headquarters.",
    "You are required to relocate within 90 days of hire.",
    "Relocation is required for this position.",
    "Willingness to relocate is expected.",
  ]) {
    const v = bodyDisqualifiers(
      job({ description: `${SOFTWARE_BODY} ${phrase}` }),
      LIMITS,
    )
    assert.equal(v.ok, false, phrase)
    assert.match(v.reasons.join(" "), /relocat/)
  }
})

test("relocation ASSISTANCE is a perk, not a disqualifier", () => {
  const v = bodyDisqualifiers(
    job({
      description: `${SOFTWARE_BODY} We offer relocation assistance and a signing bonus. Relocation package available.`,
    }),
    LIMITS,
  )
  assert.equal(v.ok, true, "offering to pay for a move must not reject the job")
})

// --- state carve-outs --------------------------------------------------------

test("rejects a remote role that excludes the user's own state", () => {
  const v = bodyDisqualifiers(
    job({
      description: `${SOFTWARE_BODY} This role will be remote, but is not eligible to be hired in CA, NV, NY, or WA.`,
    }),
    LIMITS,
  )
  assert.equal(v.ok, false)
  assert.match(v.reasons.join(" "), /not eligible for hire in NV/)
})

test("a carve-out that excludes OTHER states says nothing about Nevada", () => {
  // Twilio, verbatim: excludes 14 states and DC — none of them NV.
  const v = bodyDisqualifiers(
    job({
      description: `${SOFTWARE_BODY} This role will be remote, but is not eligible to be hired in CA, CT, IL, MA, MD, NJ, NY, OR, PA, RI, TX, VA, WA, or Washington DC.`,
    }),
    LIMITS,
  )
  assert.equal(
    v.ok,
    true,
    "excluding California must not reject a Nevada applicant",
  )
})

test("the excluded state is read from limits.location.base, not hardcoded", () => {
  const utah = {
    ...LIMITS,
    location: { ...LIMITS.location, base: "Provo, UT" },
  }
  const desc = `${SOFTWARE_BODY} Not eligible for hire in UT or ID.`
  assert.equal(bodyDisqualifiers(job({ description: desc }), utah).ok, false)
  assert.equal(bodyDisqualifiers(job({ description: desc }), LIMITS).ok, true)
})

// --- employment shape --------------------------------------------------------

test("flags a contract posting whose title looks permanent", () => {
  // Fusion HCR "Full Stack Developer", verbatim shape.
  const v = bodyDisqualifiers(
    job({
      title: "Full Stack Developer",
      description:
        "Position: Full Stack Developer Location: Las Vegas, NV " +
        `Type: Contract (Through End of Year) ${SOFTWARE_BODY}`,
    }),
    LIMITS,
  )
  assert.equal(v.ok, true, "flags by default so the user still sees it")
  assert.ok(v.flags.includes("employment:contract"))
})

test("employment shapes are labelled distinctly", () => {
  const cases = [
    ["This is a contract-to-hire position.", "employment:contract-to-hire"],
    ["Employment type: part-time", "employment:part-time"],
    ["This is a 6-month contract.", "employment:contract"],
    ["Fixed-term contract for one year.", "employment:fixed-term"],
    ["Position type: seasonal", "employment:seasonal"],
  ]
  for (const [phrase, expected] of cases) {
    const v = bodyDisqualifiers(
      job({ description: `${SOFTWARE_BODY} ${phrase}` }),
      LIMITS,
    )
    assert.ok(v.flags.includes(expected), `${phrase} -> ${v.flags.join(",")}`)
  }
})

test("employment.reject_types opts a shape into a hard reject", () => {
  const strict = { ...LIMITS, employment: { reject_types: ["contract"] } }
  const j = job({
    description: `${SOFTWARE_BODY} Type: Contract (Through End of Year)`,
  })
  assert.equal(bodyDisqualifiers(j, LIMITS).ok, true)
  const v = bodyDisqualifiers(j, strict)
  assert.equal(v.ok, false)
  assert.match(v.reasons.join(" "), /not full-time permanent/)
})

test("the word contract in ordinary prose is not an employment shape", () => {
  const v = bodyDisqualifiers(
    job({
      description: `${SOFTWARE_BODY} You will support contract negotiation workflows and vendor contracts.`,
    }),
    LIMITS,
  )
  assert.equal(v.ok, true)
  assert.deepEqual(v.flags, [])
})

// --- seniority hidden in the body -------------------------------------------

test("rejects a clean title whose body states a senior bar", () => {
  // Chainguard "Software Engineer (Libraries Platform)" — the case a title
  // filter provably cannot catch.
  const v = bodyDisqualifiers(
    job({
      title: "Software Engineer (Libraries Platform)",
      description: `${SOFTWARE_BODY} You will join us as a Senior Software Engineer on the Libraries team.`,
    }),
    LIMITS,
  )
  assert.equal(v.ok, false)
  assert.match(v.reasons.join(" "), /senior bar the title hid/)
})

test("a title that already says Senior is left to the title filter", () => {
  // Not a pass on merit — passesLimits' hard_filter rejects it first. The body
  // gate must not claim the title "hid" a level it stated outright.
  const v = bodyDisqualifiers(
    job({
      title: "Senior Backend Engineer, IAM",
      description: `${SOFTWARE_BODY} Join us as a Senior Software Engineer.`,
    }),
    LIMITS,
  )
  assert.ok(!v.reasons.some((r) => /title hid/.test(r)))
})

// --- on-site conflict --------------------------------------------------------

test("in-office language flags but never rejects", () => {
  // Twilio carries three contradictory location sentences pasted together, so
  // any single-sentence match is as likely to be stale boilerplate as truth.
  const v = bodyDisqualifiers(
    job({
      description:
        `${SOFTWARE_BODY} This role will be based in our San Francisco, California office. ` +
        "This role will be remote and based on the East Coast, USA.",
    }),
    LIMITS,
  )
  assert.equal(v.ok, true)
  assert.ok(v.flags.includes("onsite_conflict"))
})

test("in-office language naming a commutable city is not a conflict", () => {
  const v = bodyDisqualifiers(
    job({
      description: `${SOFTWARE_BODY} Hybrid role: 3 days per week in office at our Las Vegas campus.`,
    }),
    LIMITS,
  )
  assert.ok(!v.flags.includes("onsite_conflict"))
})

// --- shape contract ----------------------------------------------------------

test("returns the same {ok, reasons, flags} shape as passesLimits", () => {
  const v = bodyDisqualifiers(job({ description: SOFTWARE_BODY }), LIMITS)
  assert.deepEqual(Object.keys(v).sort(), ["flags", "ok", "reasons"])
  assert.ok(Array.isArray(v.reasons) && Array.isArray(v.flags))
})

test("reads job.requirements as well as job.description", () => {
  const v = bodyDisqualifiers(
    job({
      title: "Software Engineer",
      description: SOFTWARE_BODY,
      requirements: ["Must relocate to Seattle."],
    }),
    LIMITS,
  )
  assert.equal(v.ok, false)
  assert.match(v.reasons.join(" "), /relocat/)
})

test("empty limits do not throw — the gate degrades to no-op-ish", () => {
  assert.doesNotThrow(() =>
    bodyDisqualifiers(job({ description: SOFTWARE_BODY }), {}),
  )
})
