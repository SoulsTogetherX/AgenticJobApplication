// Blocker prescreen: requirements no application can satisfy (clearance) and
// seniority bars far above the candidate's own tenure. These exist because two
// real postings (Allegiant 12+ yrs, MAXIMUS TS/SCI) reached the apply flow and
// wasted a browser session each before anyone noticed they were unwinnable.
import test from "node:test"
import assert from "node:assert/strict"
import { screenJob, extractYearsRequired } from "../../src/leads/screen.mjs"
import { yearsOfExperience, parseDateRange } from "../../src/lib/lib.mjs"
import {
  textSnippet,
  SNIPPET_MAX,
  backfillDescriptions,
} from "../../src/leads/find-jobs.mjs"

const NOW = new Date("2026-07-27T00:00:00Z")

// Mirrors the real profile's shape: ~2.5 professional years, with an
// internship and a TA role that must NOT count toward tenure.
const PROFILE = {
  experience: [
    { title: "Full-Stack Developer", dates: "Jan 2024 – Present" },
    { title: "Full-Stack Developer", dates: "Jul 2024 – Mar 2025" },
    { title: "QA / Software Development Intern", dates: "Jun 2023 – Aug 2023" },
    { title: "Teacher Assistant", dates: "May 2019 - May 2023" },
  ],
}

const YEARS = yearsOfExperience(PROFILE, NOW)

// A description long enough not to trip the thin_description signal.
const filler =
  "We are building products used by millions of customers worldwide and are looking for engineers who care deeply about reliability, performance, and the craft of shipping software that people depend on every single day of the year. "

function job(overrides) {
  return {
    id: "x1",
    company: "Acme",
    title: "Software Engineer",
    description: filler,
    requirements: [],
    ...overrides,
  }
}

test("profile tenure unions overlapping roles and excludes training roles", () => {
  // Jan 2024 -> Jul 2026 is 30 months; the concurrent contract must not add to
  // it, and the internship/TA years must not count at all.
  assert.equal(YEARS, 2.5)
})

test("parseDateRange handles Present and returns null when unparseable", () => {
  const r = parseDateRange("Jan 2024 – Present", NOW)
  assert.equal(r.start.getUTCFullYear(), 2024)
  assert.equal(r.end.getUTCFullYear(), 2026)
  assert.equal(parseDateRange("sometime last year", NOW), null)
  assert.equal(parseDateRange("", NOW), null)
})

test("extractYearsRequired reads the highest genuine demand", () => {
  assert.equal(
    extractYearsRequired(
      "Minimum twelve (12) years' of development experience as a seasoned middleware engineer.",
    ),
    12,
  )
  assert.equal(
    extractYearsRequired(
      "10 years of overall experience in the functional area.",
    ),
    10,
  )
  assert.equal(
    extractYearsRequired(
      "5+ years of professional full-stack engineering experience shipping consumer products.",
    ),
    5,
  )
})

test("extractYearsRequired ignores age and non-experience durations", () => {
  // The exact string that appears on Greenhouse forms — must never be read as
  // a seniority bar.
  assert.equal(extractYearsRequired("Are you at least 18 years of age?"), 0)
  assert.equal(extractYearsRequired("The company was founded 12 years ago."), 0)
  assert.equal(
    extractYearsRequired("Postings older than 45 days are stale."),
    0,
  )
})

test("active clearance is a hard reject", () => {
  const r = screenJob(
    job({ description: filler + "An active TS/SCI clearance required." }),
    {},
    NOW,
    YEARS,
  )
  assert.equal(r.verdict, "reject")
  assert.ok(r.signals.includes("clearance_required"))

  const r2 = screenJob(
    job({ description: filler + "Must have an active security clearance." }),
    {},
    NOW,
    YEARS,
  )
  assert.equal(r2.verdict, "reject")
})

test("a bar far above tenure rejects, and says how far", () => {
  const r = screenJob(
    job({
      description:
        filler +
        "Minimum twelve (12) years' of development experience required.",
    }),
    {},
    NOW,
    YEARS,
  )
  assert.equal(r.verdict, "reject")
  assert.ok(r.signals.includes("over_bar_12y"))
})

test("a genuinely reachable bar still passes — the Affirm case must not regress", () => {
  // Policy change (user, 2026-07-28): Senior roles are never worth pursuing at
  // this tenure, so the stretch narrowed from 3 years to 2 and the gate now
  // rejects instead of cautioning. This test previously asserted that a
  // "Senior ... 5+ years" posting should pass; under the current policy such a
  // title never even reaches screening — find-jobs hard-filters it at ingest.
  //
  // The real regression risk is now the opposite one: rejecting an ENTRY-LEVEL
  // posting. Affirm's "Software Engineer II" asks for "1.5+ years", which the
  // extractor once misread as 5 because "." is a word boundary.
  const r = screenJob(
    job({
      title: "Software Engineer II, Backend",
      description:
        filler +
        "You have a total of 1.5+ years of experience as a software engineer.",
    }),
    {},
    NOW,
    YEARS,
  )
  assert.equal(r.verdict, "pass")
  assert.equal(
    r.signals.filter((s) => s.startsWith("over_bar")).length,
    0,
    "1.5 years is below a 2.5-year profile and must never be flagged",
  )
})

test("stretch_years widens the band; max_years_required overrides it entirely", () => {
  const twelve = job({
    description: filler + "Minimum twelve (12) years of experience required.",
  })
  // Widen the stretch enough to swallow a 12-year bar.
  const wide = screenJob(
    twelve,
    { experience: { stretch_years: 10 } },
    NOW,
    YEARS,
  )
  assert.equal(wide.verdict, "pass")

  // An absolute ceiling ignores derived tenure in both directions.
  const capped = screenJob(
    twelve,
    { experience: { max_years_required: 15 } },
    NOW,
    YEARS,
  )
  assert.equal(capped.verdict, "pass")

  const strict = screenJob(
    job({
      description: filler + "5+ years of engineering experience required.",
    }),
    { experience: { max_years_required: 3 } },
    NOW,
    YEARS,
  )
  assert.equal(strict.verdict, "reject")
  assert.ok(strict.signals.includes("over_bar_5y"))
})

test("without a profile the seniority gate stays off rather than guessing", () => {
  const r = screenJob(
    job({
      description: filler + "Minimum twelve (12) years of experience required.",
    }),
    {},
    NOW,
    null,
  )
  assert.equal(r.verdict, "pass")
  assert.equal(r.signals.filter((s) => s.startsWith("over_bar")).length, 0)
})

test("textSnippet unwraps Greenhouse's double-encoded HTML", () => {
  // Greenhouse returns entity-encoded markup, so a single decode still leaves
  // tags behind — the blocker regexes would then miss text split by them.
  const raw =
    "&lt;p&gt;Requires an &lt;strong&gt;active TS/SCI clearance&lt;/strong&gt;.&lt;/p&gt;"
  const out = textSnippet(raw)
  assert.equal(out, "Requires an active TS/SCI clearance .")
  assert.match(out, /active TS\/SCI clearance/)
})

test("textSnippet strips scripts, collapses space, caps length, nulls empties", () => {
  assert.equal(textSnippet("<script>alert(1)</script> real text"), "real text")
  // Horizontal whitespace collapses; a line break is structure and survives.
  // This used to assert "a b" — every newline was flattened, which destroyed
  // the only section structure a posting has. See the block-boundary comment
  // in textSnippet: the L2 fit stage reads headings to separate a REQUIRED
  // skill from a "nice to have" one, and it found a requirements heading in
  // 0 of 92 stored leads while descriptions arrived as one unbroken line.
  assert.equal(textSnippet("a\n\n   b"), "a\nb")
  assert.equal(
    textSnippet("keep   these    on  one line"),
    "keep these on one line",
  )
  assert.equal(textSnippet(null, undefined, ""), null)
  assert.equal(textSnippet("<p></p>"), null)
  assert.equal(textSnippet("x".repeat(SNIPPET_MAX + 500)).length, SNIPPET_MAX)
})

test("textSnippet turns block tags into breaks but inline tags into spaces", () => {
  assert.equal(
    textSnippet("<p>About us.</p><h3>Requirements</h3><ul><li>React</li></ul>"),
    "About us.\nRequirements\nReact",
  )
  assert.equal(textSnippet("the <b>fast</b> path"), "the fast path")
  assert.equal(textSnippet("one<br>two"), "one\ntwo")
})

test("a truncated aggregator teaser is not flagged as a thin posting", () => {
  const teaser = job({ description: "Short teaser from the aggregator." })

  const partial = screenJob(
    { ...teaser, partial_description: true },
    {},
    NOW,
    YEARS,
  )
  assert.equal(partial.verdict, "pass")
  assert.ok(!partial.signals.includes("thin_description"))

  // A genuinely thin captured posting still cautions.
  const captured = screenJob(
    { ...teaser, partial_description: false },
    {},
    NOW,
    YEARS,
  )
  assert.ok(captured.signals.includes("thin_description"))
})

test("blockers still fire on a partial snippet", () => {
  // The whole point of storing snippets at sweep time.
  const r = screenJob(
    job({
      description: "Senior role. An active TS/SCI clearance required.",
      partial_description: true,
    }),
    {},
    NOW,
    YEARS,
  )
  assert.equal(r.verdict, "reject")
  assert.ok(r.signals.includes("clearance_required"))
})

test("backfill adds snippets to already-stored leads without overwriting", () => {
  const leads = [
    { id: "gh:1", url: "https://x.test/a", title: "A" },
    { id: "gh:2", url: "https://x.test/b", title: "B", description: "kept" },
    { id: "gh:3", url: "https://x.test/c", title: "C" },
  ]
  const n = backfillDescriptions(
    [
      { id: "gh:1", url: "https://x.test/a", description: "fresh A" },
      { id: "gh:2", url: "https://x.test/b", description: "should not win" },
      { id: "gh:9", url: "https://x.test/z", description: "unrelated" },
    ],
    leads,
  )
  assert.equal(n, 1)
  assert.equal(leads[0].description, "fresh A")
  assert.equal(leads[1].description, "kept", "existing text is never clobbered")
  assert.equal(leads[2].description, undefined)
})

test("backfill matches on url when the id has changed", () => {
  const leads = [{ id: "old:1", url: "https://x.test/a", title: "A" }]
  const n = backfillDescriptions(
    [{ id: "new:1", url: "https://x.test/a", description: "by url" }],
    leads,
  )
  assert.equal(n, 1)
  assert.equal(leads[0].description, "by url")
})

test("clearance outranks the seniority gate in the verdict", () => {
  // MAXIMUS: both signals fire; reject must win over caution.
  const r = screenJob(
    job({
      description:
        filler +
        "An active TS/SCI clearance required. 10 years of overall experience in the functional area.",
    }),
    {},
    NOW,
    YEARS,
  )
  assert.equal(r.verdict, "reject")
  assert.ok(r.signals.includes("clearance_required"))
  assert.ok(r.signals.includes("over_bar_10y"))
})
