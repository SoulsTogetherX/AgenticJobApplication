import test from "node:test"
import assert from "node:assert/strict"
import path from "node:path"
import { fileURLToPath } from "node:url"
import {
  passesLimits,
  dedupeLeads,
  normUrl,
  loadLimits,
  loadSources,
  parseSalaryMax,
  parseWorkdayPostedOn,
  workdayLocationFromPath,
} from "../scripts/find-jobs.mjs"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const NOW = new Date("2026-07-27T12:00:00Z")

const LIMITS = {
  location: {
    base: "North Las Vegas, NV",
    relocation: false,
    remote_ok: true,
    onsite_allowed: ["north las vegas", "las vegas", "henderson"],
  },
  freshness: { max_age_days: 30 },
  roles: {
    title_keywords: [
      "full-stack",
      "full stack",
      "fullstack",
      "software engineer",
    ],
  },
}

const job = (over = {}) => ({
  company: "Acme",
  title: "Full Stack Engineer",
  location: "Remote",
  url: "https://example.com/jobs/1",
  posted_at: "2026-07-20T00:00:00Z",
  ...over,
})

// ---------- hard / soft title filters ----------

const LEVEL_LIMITS = {
  ...LIMITS,
  roles: {
    ...LIMITS.roles,
    // Mirrors the real docs/application-limits.yaml, which also targets the
    // gaming-math titles Xavier applies to.
    title_keywords: [...LIMITS.roles.title_keywords, "game mathematician"],
    hard_filter: ["senior", "sr", "staff", "principal", "lead", "specialist"],
    soft_filter: ["ii", "iii", "platform", "java"],
  },
}

test("hard filter rejects titles above the experience bar", () => {
  // Stated minimums observed on 2026-07-28: Senior 4-10y, Staff 7-12y,
  // Principal 8-12y — none reachable at ~2.5 years.
  for (const title of [
    "Senior Software Engineer",
    "Sr. Software Engineer",
    "Staff Software Engineer",
    "Principal Software Engineer",
    "Senior Staff Software Engineer, Payments",
    "Analytics Lead, Full Stack",
    "Technical Systems Integrations Specialist",
  ]) {
    const v = passesLimits(job({ title }), LEVEL_LIMITS, NOW)
    assert.equal(v.ok, false, `expected reject for "${title}"`)
    assert.match(v.reasons.join(" "), /hard-filtered/)
  }
})

test("hard filter matches whole words only", () => {
  // "sales" must not fire on "Salesforce"; "sr" must not fire on "usr".
  for (const title of [
    "Software Engineer, Salesforce Platform",
    "Software Engineer, usr tooling",
  ]) {
    const v = passesLimits(
      job({ title }),
      {
        ...LEVEL_LIMITS,
        roles: { ...LEVEL_LIMITS.roles, hard_filter: ["sales", "sr"] },
      },
      NOW,
    )
    assert.equal(v.ok, true, `"${title}" should survive: ${v.reasons}`)
  }
})

test("soft filter flags for review but never rejects", () => {
  const v = passesLimits(
    job({ title: "Software Engineer II, Backend" }),
    LEVEL_LIMITS,
    NOW,
  )
  assert.equal(v.ok, true, v.reasons.join(";"))
  assert.ok(v.flags.includes("title_watch:ii"))
})

test("mid-level titles Xavier actually applied to still pass ingest", () => {
  // Regression guard: these four are real applications. A level filter that
  // rejects them is too aggressive.
  for (const title of [
    "Software Eng (Dev) II",
    "Game Mathematician III",
    "Software Engineer II, Backend (Test Infra)",
    "Software Engineer II, Backend (Unified Data Platform)",
  ]) {
    const v = passesLimits(
      job({ title, location: "Las Vegas, NV" }),
      LEVEL_LIMITS,
      NOW,
    )
    assert.equal(v.ok, true, `"${title}" must survive: ${v.reasons}`)
  }
})

test("a title with no seniority word survives so screening can read the body", () => {
  // Chainguard's "Software Engineer (Libraries Platform)" carried no seniority
  // word yet wanted 5+ years. The title filter cannot catch that — it must
  // pass through flagged rather than be silently dropped or silently trusted.
  const v = passesLimits(
    job({ title: "Software Engineer (Libraries Platform)" }),
    LEVEL_LIMITS,
    NOW,
  )
  assert.equal(v.ok, true)
  assert.ok(v.flags.includes("title_watch:platform"))
})

// ---------- passesLimits ----------

test("remote and Las Vegas metro jobs pass", () => {
  for (const loc of [
    "Remote",
    "Remote (US)",
    "Las Vegas, NV",
    "Henderson, NV",
    "North Las Vegas",
  ]) {
    const v = passesLimits(job({ location: loc }), LIMITS, NOW)
    assert.equal(v.ok, true, `expected pass for ${loc}: ${v.reasons}`)
  }
})

test("jobs requiring relocation away from base are rejected", () => {
  for (const loc of [
    "San Francisco",
    "New York, NY",
    "Sydney, Australia",
    "London, United Kingdom",
  ]) {
    const v = passesLimits(job({ location: loc }), LIMITS, NOW)
    assert.equal(v.ok, false, `expected reject for ${loc}`)
    assert.match(v.reasons.join(" "), /location/)
  }
})

test("a board-level remote flag passes an off-base location but is flagged for screening", () => {
  const v = passesLimits(
    job({ location: "San Francisco", remote: true }),
    LIMITS,
    NOW,
  )
  assert.equal(v.ok, true)
  assert.ok(v.flags.includes("remote_unverified"))
})

test("remote restricted to non-US regions is still rejected", () => {
  for (const loc of [
    "France, Remote; Germany, Remote",
    "Remote - Europe",
    "London, UK (Remote)",
    "Remote (Canada only)",
  ]) {
    const v = passesLimits(job({ location: loc }), LIMITS, NOW)
    assert.equal(v.ok, false, `expected reject for ${loc}`)
  }
  const us = passesLimits(
    job({ location: "Remote - United States" }),
    LIMITS,
    NOW,
  )
  assert.equal(us.ok, true)
})

test("stale postings are rejected; fresh ones pass", () => {
  const stale = passesLimits(
    job({ posted_at: "2026-05-01T00:00:00Z" }),
    LIMITS,
    NOW,
  )
  assert.equal(stale.ok, false)
  assert.match(stale.reasons.join(" "), /stale/)
  const fresh = passesLimits(
    job({ posted_at: "2026-07-25T00:00:00Z" }),
    LIMITS,
    NOW,
  )
  assert.equal(fresh.ok, true)
})

test("missing posted_at passes but is flagged unknown_age", () => {
  const v = passesLimits(job({ posted_at: null }), LIMITS, NOW)
  assert.equal(v.ok, true)
  assert.ok(v.flags.includes("unknown_age"))
})

test("missing location passes but is flagged unknown_location", () => {
  const v = passesLimits(job({ location: "" }), LIMITS, NOW)
  assert.equal(v.ok, true)
  assert.ok(v.flags.includes("unknown_location"))
})

test("a commutable posting gets a looser title test, flagged for screening", () => {
  // Caesars' "Staff Engineer - Booking Engine" is a real Las Vegas software
  // job that matches none of the title keywords. Local postings are rare
  // enough to be worth a look; remote ones are not.
  const v = passesLimits(
    job({
      title: "Staff Engineer - Booking Engine",
      location: "Las Vegas, NV",
    }),
    LIMITS,
    NOW,
  )
  assert.equal(v.ok, true)
  assert.ok(v.flags.includes("title_loose"))
})

test("the loose title test does NOT apply to remote postings", () => {
  // There are thousands of remote postings; the keyword gate is what keeps
  // them manageable.
  const v = passesLimits(
    job({ title: "Staff Engineer - Booking Engine", location: "Remote - US" }),
    LIMITS,
    NOW,
  )
  assert.equal(v.ok, false)
  assert.match(v.reasons.join(" "), /title/)
})

test("local trades roles are still rejected", () => {
  // A casino's "engineers" are overwhelmingly facilities staff, and the stems
  // must match inflections: /\bplumb\b/ does not match "Plumber".
  for (const title of [
    "Maintenance Engineer - Facilities and Engineering",
    "General Engineer Plumber - Red Rock",
    "Engineer III- Day-Painter-Silver Legacy",
    "Stationary Engineer- Full Time",
    "Table Games Floor Supervisor",
  ]) {
    const v = passesLimits(
      job({ title, location: "Las Vegas, NV" }),
      LIMITS,
      NOW,
    )
    assert.equal(v.ok, false, `expected reject for ${title}`)
  }
})

test("an exact keyword hit passes without the loose flag", () => {
  const v = passesLimits(
    job({ title: "Senior Software Engineer", location: "Las Vegas, NV" }),
    LIMITS,
    NOW,
  )
  assert.equal(v.ok, true)
  assert.ok(!v.flags.includes("title_loose"))
})

test("an opaque 'N Locations' string is flagged, not rejected", () => {
  // Workday collapses multi-site postings this way. Rejecting them dropped
  // exactly the roles most likely to include Las Vegas among their sites.
  for (const location of ["2 Locations", "3 locations", "10 Locations"]) {
    const v = passesLimits(job({ location }), LIMITS, NOW)
    assert.equal(v.ok, true, `expected pass for ${location}`)
    assert.ok(
      v.flags.includes("unknown_location"),
      `expected unknown_location for ${location}`,
    )
  }
})

test("a real location that merely contains a digit is still gated", () => {
  const v = passesLimits(
    job({ location: "1 Infinite Loop, Cupertino" }),
    LIMITS,
    NOW,
  )
  assert.equal(v.ok, false)
  assert.match(v.reasons.join(" "), /location/)
})

test("non-targeted titles are rejected", () => {
  for (const title of ["Accountant", "DevOps Engineer", "Product Manager"]) {
    const v = passesLimits(job({ title }), LIMITS, NOW)
    assert.equal(v.ok, false, `expected reject for ${title}`)
    assert.match(v.reasons.join(" "), /title/)
  }
})

// ---------- dedupeLeads ----------

test("dedupe drops candidates already in the store by id, url, or company+title", () => {
  const existing = [job({ id: "x:1", url: "https://example.com/jobs/1" })]
  const candidates = [
    job({ id: "x:1", url: "https://other.com/a" }), // same id
    job({ id: "y:2", url: "https://EXAMPLE.com/jobs/1/?utm=x" }), // same url modulo noise
    job({ id: "z:3", url: "https://third.com/b" }), // same company+title
    job({
      id: "w:4",
      url: "https://fourth.com/c",
      title: "Full Stack Developer II",
    }), // genuinely new
  ]
  const fresh = dedupeLeads(candidates, existing, [])
  assert.deepEqual(
    fresh.map((f) => f.id),
    ["w:4"],
  )
})

test("dedupe drops jobs already applied to (company+title match)", () => {
  const applied = [{ company: "acme", title: "full stack engineer" }]
  const fresh = dedupeLeads([job({ id: "a:1" })], [], applied)
  assert.equal(fresh.length, 0)
})

test("dedupe keeps the first of two identical candidates in one batch", () => {
  const fresh = dedupeLeads([job({ id: "a:1" }), job({ id: "a:1" })], [], [])
  assert.equal(fresh.length, 1)
})

// ---------- misc ----------

test("normUrl strips query, hash, trailing slash, and case", () => {
  assert.equal(
    normUrl("https://Ex.com/Jobs/1/?a=b#c"),
    "https://ex.com/Jobs/1".toLowerCase(),
  )
  assert.equal(normUrl("not a url"), "not a url")
})

test("the real application-limits.yaml loads and matches the documented policy", () => {
  const limits = loadLimits(path.join(ROOT, "docs", "application-limits.yaml"))
  assert.equal(limits.location.relocation, false)
  assert.equal(limits.location.remote_ok, true)
  assert.ok(limits.location.onsite_allowed.includes("north las vegas"))
  assert.ok(limits.freshness.max_age_days >= 1)
  assert.ok(limits.roles.title_keywords.length > 0)
})

// ---------- salary gate ----------

const SALARY_LIMITS = {
  ...LIMITS,
  compensation: { min_salary: 100000, flag_missing: true },
}

test("salary gate rejects below-minimum, passes at/above, inactive when unset", () => {
  const low = passesLimits(job({ salary_max: 90000 }), SALARY_LIMITS, NOW)
  assert.equal(low.ok, false)
  assert.match(low.reasons.join(" "), /salary/)

  const ok = passesLimits(job({ salary_max: 150000 }), SALARY_LIMITS, NOW)
  assert.equal(ok.ok, true)

  const inactive = passesLimits(job({ salary_max: 90000 }), LIMITS, NOW)
  assert.equal(
    inactive.ok,
    true,
    "gate must be inactive when min_salary is null",
  )
})

test("salary gate flags missing salary info instead of rejecting", () => {
  const v = passesLimits(job({}), SALARY_LIMITS, NOW)
  assert.equal(v.ok, true)
  assert.ok(v.flags.includes("no_salary"))
})

test("parseSalaryMax reads $K shorthand, ranges, and full amounts", () => {
  assert.equal(parseSalaryMax("$150K – $220K • 0.15% – 0.2%"), 220000)
  assert.equal(parseSalaryMax("$95,000 - $120,000 per year"), 120000)
  assert.equal(parseSalaryMax("competitive salary"), null)
  assert.equal(parseSalaryMax(null), null)
})

// ---------- workday helpers ----------

test("parseWorkdayPostedOn maps relative dates; 30+ lands past the freshness gate", () => {
  const today = parseWorkdayPostedOn("Posted Today", NOW)
  assert.equal(new Date(today).toISOString().slice(0, 10), "2026-07-27")

  const three = parseWorkdayPostedOn("Posted 3 Days Ago", NOW)
  assert.equal(new Date(three).toISOString().slice(0, 10), "2026-07-24")

  const old = parseWorkdayPostedOn("Posted 30+ Days Ago", NOW)
  const v = passesLimits(job({ posted_at: old }), LIMITS, NOW)
  assert.equal(v.ok, false, "30+ days must fail the default freshness gate")

  assert.equal(parseWorkdayPostedOn("gibberish", NOW), null)
})

test("workdayLocationFromPath extracts the location segment", () => {
  assert.equal(
    workdayLocationFromPath("/job/US-CA-Santa-Clara/Senior-Engineer_JR123"),
    "US CA Santa Clara",
  )
  assert.equal(workdayLocationFromPath("no-job-segment"), "")
})

// ---------- sources ----------

test("loadSources reads the real job-sources.yaml with valid board entries", () => {
  const boards = loadSources()
  assert.ok(boards.length >= 10)
  for (const b of boards) {
    assert.ok(
      b.type && b.company,
      `board missing type/company: ${JSON.stringify(b)}`,
    )
    // Host-based ATSs identify a board by host+site; the rest use a slug.
    if (b.type === "workday") {
      assert.ok(
        b.host && b.tenant && b.site,
        "workday boards need host/tenant/site",
      )
    } else if (b.type === "oracle_cloud") {
      assert.ok(b.host && b.site, "oracle_cloud boards need host/site")
    } else if (b.type === "successfactors") {
      assert.ok(b.host, "successfactors boards need host")
    } else {
      assert.ok(b.slug, `${b.type} board needs slug`)
    }
  }
})

test("loadSources falls back to defaults when the file is missing", () => {
  const boards = loadSources(path.join(ROOT, "docs", "no-such-sources.yaml"))
  assert.ok(boards.length >= 1)
  assert.equal(boards[0].type, "greenhouse")
})
