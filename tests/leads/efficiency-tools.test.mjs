import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { outputMode, isTerse } from "../../src/lib/lib.mjs"
import {
  scoreLead,
  titleScore,
  freshnessScore,
  rankLeads,
} from "../../src/leads/recommend.mjs"
import { screenJob, extractYearsRequired } from "../../src/leads/screen.mjs"
import { buildStatus } from "../../src/status.mjs"
import { extractTech } from "../../src/profile/profile-gaps.mjs"

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
)
const NOW = new Date("2026-07-27T12:00:00Z")

// ---------- output mode ----------

test("outputMode: flags win, otherwise TTY decides", () => {
  assert.equal(outputMode(["--verbose"]), "human")
  assert.equal(outputMode(["--quiet"]), "terse")
  // Tests run with stdout piped, so detection must say terse.
  assert.equal(outputMode([]), process.stdout.isTTY ? "human" : "terse")
  assert.equal(isTerse(["--quiet"]), true)
  assert.equal(isTerse(["--verbose"]), false)
})

test("scripts emit compact output when stdout is not a TTY", () => {
  const res = spawnSync(
    process.execPath,
    [path.join(ROOT, "src", "status.mjs")],
    {
      encoding: "utf8",
    },
  )
  assert.equal(res.status, 0, res.stderr)
  // Terse format is key=value records, not sentences.
  assert.match(res.stdout, /leads total=\d+/)
  assert.ok(
    !/Follow-ups due:/.test(res.stdout),
    "human phrasing must not appear",
  )
})

// ---------- recommend ----------

const lead = (over = {}) => ({
  id: "x:1",
  company: "Acme",
  title: "Full Stack Engineer",
  location: "Remote",
  url: "https://example.com/1",
  posted_at: "2026-07-25T00:00:00Z",
  ...over,
})

test("titleScore ranks full-stack above backend above generic", () => {
  assert.ok(
    titleScore("Senior Full-Stack Developer") > titleScore("Backend Engineer"),
  )
  assert.ok(titleScore("Backend Engineer") > titleScore("Software Engineer"))
  assert.equal(titleScore("Marketing Manager"), 0)
})

test("freshnessScore decays with age and tolerates junk", () => {
  assert.ok(
    freshnessScore("2026-07-26T00:00:00Z", NOW) >
      freshnessScore("2026-07-15T00:00:00Z", NOW),
  )
  assert.equal(freshnessScore(null, NOW), 0)
  assert.equal(freshnessScore("not a date", NOW), 0)
})

test("scoreLead rewards profile tech overlap and penalizes risk flags", () => {
  const profileTech = extractTech("React, Node.js and PostgreSQL experience")
  const strong = scoreLead(
    lead({ job_text: "React, Node.js, PostgreSQL" }),
    profileTech,
    NOW,
  )
  const flagged = scoreLead(
    lead({
      job_text: "React, Node.js, PostgreSQL",
      flags: ["remote_unverified"],
    }),
    profileTech,
    NOW,
  )
  assert.ok(strong.score > flagged.score, "flags must cost points")
  assert.deepEqual(strong.matched_tech, ["Node.js", "PostgreSQL", "React"])

  const unrelated = scoreLead(
    lead({ job_text: "COBOL mainframes" }),
    profileTech,
    NOW,
  )
  assert.ok(strong.score > unrelated.score)
})

test("scoreLead reports missing tech as the gap for that lead", () => {
  const profileTech = extractTech("React only")
  const r = scoreLead(
    lead({ job_text: "React and Kubernetes" }),
    profileTech,
    NOW,
  )
  assert.ok(r.matched_tech.includes("React"))
  assert.ok(r.missing_tech.includes("Kubernetes"))
})

test("rankLeads sorts by score and honors --top", () => {
  const profileTech = "React and PostgreSQL"
  const ranked = rankLeads(
    [
      lead({ id: "a", title: "Marketing Manager", job_text: "" }),
      lead({
        id: "b",
        title: "Full Stack Engineer",
        job_text: "React PostgreSQL",
      }),
    ],
    profileTech,
    { top: 1, now: NOW },
  )
  assert.equal(ranked.length, 1)
  assert.equal(ranked[0].id, "b")
})

// ---------- screen ----------

test("screenJob rejects scam wording", () => {
  for (const description of [
    "Pay a $50 fee to apply for this position today",
    "Send your social security number and bank account to begin",
    "Interview via Telegram — contact us to apply",
  ]) {
    const r = screenJob({ id: "s", company: "X", title: "Dev", description })
    assert.equal(r.verdict, "reject", `expected reject for: ${description}`)
    assert.ok(r.signals.length)
  }
})

test("screenJob cautions on stale postings and flag clusters", () => {
  const stale = screenJob(
    {
      id: "s",
      company: "X",
      title: "Dev",
      description: "A".repeat(300),
      posted_at: "2026-05-01",
    },
    { ghost_signals: { repost_age_days: 45 } },
    NOW,
  )
  assert.equal(stale.verdict, "caution")
  assert.ok(stale.signals.some((s) => s.startsWith("stale_")))

  const culture = screenJob({
    id: "c",
    company: "X",
    title: "Dev",
    description:
      "We are a fast-paced team, like a family, where you wear many hats. " +
      "A".repeat(200),
  })
  assert.equal(culture.verdict, "caution")
})

test("screenJob passes a clean, specific posting", () => {
  const r = screenJob(
    {
      id: "ok",
      company: "Acme",
      title: "Full Stack Engineer",
      posted_at: "2026-07-25",
      description:
        "You will build and maintain our customer portal using React, Node.js and PostgreSQL, working with a team of six engineers on the platform group. Responsibilities include API design, database schema work, and code review. ".repeat(
          2,
        ),
    },
    {},
    NOW,
  )
  assert.equal(r.verdict, "pass")
  assert.deepEqual(r.signals, [])
})

// ---------- seniority bar ----------

const seniorityJob = (description) => ({
  id: "y",
  company: "Acme",
  title: "Software Engineer",
  posted_at: "2026-07-25",
  description:
    description +
    " You will build and maintain our customer portal with React, Node.js and PostgreSQL alongside a team of six engineers, covering API design, schema work and code review.",
})

test("extractYearsRequired reads fractional bars, not the digit after the point", () => {
  // Regression: with a plain \b, "1.5+ years" matched the "5" — a decimal
  // point is a word boundary — turning an entry-level bar into a 5-year one.
  assert.equal(extractYearsRequired("a total of 1.5+ years of experience"), 1.5)
  assert.equal(extractYearsRequired("2.5 years of experience"), 2.5)
  assert.equal(extractYearsRequired("5+ years of experience"), 5)
  assert.equal(extractYearsRequired("10+ years of experience"), 10)
  // Highest demand wins when several are stated.
  assert.equal(
    extractYearsRequired("8+ years of experience, 3+ years of track record"),
    8,
  )
  // A legal minimum is not a seniority bar.
  assert.equal(extractYearsRequired("Must be at least 18 years of age"), 0)
  assert.equal(extractYearsRequired("no numbers here"), 0)
})

test("screenJob rejects a posting demanding years beyond the stretch", () => {
  // 2.5-year profile, stretch 2 → ceiling 4.5.
  const r = screenJob(
    seniorityJob("We are looking for 5+ years of experience."),
    { experience: { stretch_years: 2 } },
    NOW,
    2.5,
  )
  assert.equal(r.verdict, "reject")
  assert.ok(r.signals.includes("over_bar_5y"))
})

test("screenJob leaves a reachable bar alone", () => {
  for (const [desc, years] of [
    ["You have a total of 1.5+ years of experience.", 1.5],
    ["We ask for 3+ years of experience.", 3],
    ["4 years of experience preferred.", 4],
  ]) {
    const r = screenJob(
      seniorityJob(desc),
      { experience: { stretch_years: 2 } },
      NOW,
      2.5,
    )
    assert.equal(
      r.verdict,
      "pass",
      `${years}y should be reachable: ${r.signals}`,
    )
  }
})

test("the seniority gate is off without a profile tenure", () => {
  const r = screenJob(
    seniorityJob("We require 12+ years of experience."),
    { experience: { stretch_years: 2 } },
    NOW,
    null,
  )
  assert.ok(!r.signals.some((s) => s.startsWith("over_bar")))
})

test("screenJob flags thin descriptions and unidentified companies", () => {
  const thin = screenJob({
    id: "t",
    company: "Acme",
    title: "Dev",
    description: "Dev needed.",
  })
  assert.ok(thin.signals.includes("thin_description"))
  const anon = screenJob({ id: "u", company: "unknown", title: "Dev" })
  assert.ok(anon.signals.includes("unidentified_company"))
})

// ---------- status ----------

test("buildStatus tallies leads, applications, and due follow-ups", () => {
  const s = buildStatus(
    [{ status: "new" }, { status: "new" }, { status: "dismissed" }],
    [
      { slug: "a", company: "A", applied_at: "2026-07-01" },
      { slug: "b", company: "B", applied_at: "2026-07-26", status: "applied" },
      { slug: "c", company: "C", applied_at: "2026-06-01", status: "rejected" },
    ],
    { now: NOW, days: 10 },
  )
  assert.equal(s.leads.total, 3)
  assert.equal(s.leads.by_status.new, 2)
  assert.equal(s.applications.total, 3)
  assert.equal(s.applications.awaiting_response, 2, "rejected is not awaiting")
  assert.equal(s.follow_ups_due, 1, "only the 2026-07-01 one is past threshold")
  assert.equal(s.due_list[0].slug, "a")
})

test("buildStatus handles empty stores", () => {
  const s = buildStatus([], [], { now: NOW })
  assert.equal(s.leads.total, 0)
  assert.equal(s.follow_ups_due, 0)
})

// ---------- CLI smoke for recommend/screen ----------

test("recommend and screen CLIs run against a temp lead store", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eff-"))
  try {
    const leadsPath = path.join(dir, "leads.json")
    fs.writeFileSync(
      leadsPath,
      JSON.stringify({
        leads: [
          {
            id: "x:1",
            company: "Acme",
            title: "Full Stack Engineer",
            location: "Remote",
            url: "https://example.com/1",
            // Relative, not literal: a hardcoded date crossed the staleness
            // gate on 2026-08-24 and turned this test red by calendar alone.
            posted_at: new Date(Date.now() - 5 * 86_400_000).toISOString(),
            status: "new",
            flags: [],
          },
        ],
      }),
    )
    const run = (script, extra) =>
      spawnSync(
        process.execPath,
        [
          path.join(ROOT, "src", script),
          "--leads",
          leadsPath,
          "--jobs-dir",
          dir,
          ...extra,
        ],
        { encoding: "utf8" },
      )

    const rec = run("leads/recommend.mjs", [
      "--profile",
      path.join(ROOT, "tests", "fixtures", "profile.yaml"),
      "--json",
    ])
    assert.equal(rec.status, 0, rec.stderr)
    assert.equal(JSON.parse(rec.stdout)[0].company, "Acme")

    const scr = run("leads/screen.mjs", ["--json"])
    assert.equal(scr.status, 0, scr.stderr)
    assert.equal(JSON.parse(scr.stdout).results[0].verdict, "pass")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
