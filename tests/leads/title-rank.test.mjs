// P2 — titleScore's config escape hatch (docs/application-limits.yaml's
// roles.title_rank, absent -> today's hardcoded ladder) and the ranking-
// honesty interim (isFlatRanking / the CLI's flat-ranking notice).
//
// Regression origin: four nursing leads scored 4, 4, 4, 4 — identical — so
// the sort fell through entirely to alphabetical-by-company, and the file's
// own comment claimed titleScore read docs/application-limits.yaml when it
// never did. Both bugs get a test here: the config actually being read, and
// a flat result actually announcing itself instead of posing as a ranking.
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import {
  titleScore,
  isFlatRanking,
  rankLeads,
} from "../../scripts/leads/recommend.mjs"

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
)
const NOW = new Date("2026-07-27T12:00:00Z")

// ---------- titleScore, no config (byte-identical default) -----------------

test("absent title_rank reproduces the old hardcoded ladder exactly", () => {
  assert.equal(titleScore("Senior Full-Stack Developer"), 6)
  assert.equal(titleScore("Backend Engineer"), 4)
  assert.equal(titleScore("Software Engineer"), 2)
  assert.equal(titleScore("Web Developer"), 2)
  assert.equal(titleScore("Developer"), 2)
  assert.equal(titleScore("Marketing Manager"), 0)
  // Same with an explicit empty opts object — the real call shape from
  // scoreLead when no limits were loaded.
  assert.equal(titleScore("Backend Engineer", {}), 4)
  assert.equal(titleScore("Backend Engineer", { limits: null }), 4)
})

test("the first matching rank wins — a title is not double-scored", () => {
  // Contains both "full-stack" and "developer"; must score as full-stack (6),
  // not full-stack + generic (8) — matches the old if/else-if chain.
  assert.equal(titleScore("Full-Stack Developer"), 6)
})

// ---------- titleScore, configured (the retarget path) ---------------------

test("a custom title_rank retargets titleScore without touching the code", () => {
  const limits = {
    roles: {
      title_rank: [
        ["registered nurse", "rn"],
        ["licensed practical nurse", "lpn"],
        ["certified nursing assistant", "cna"],
      ],
    },
  }
  // Position derives the weight: 3 groups -> 6, 4, 2.
  assert.equal(titleScore("Registered Nurse - ICU", { limits }), 6)
  assert.equal(titleScore("RN, Med-Surg", { limits }), 6)
  assert.equal(titleScore("Licensed Practical Nurse", { limits }), 4)
  assert.equal(titleScore("Certified Nursing Assistant", { limits }), 2)
  // Off the new list entirely, including terms that WOULD have scored under
  // the software default — confirms the default is fully replaced, not
  // merged.
  assert.equal(titleScore("Full-Stack Developer", { limits }), 0)
})

test("a single-string entry (no synonym group) still works", () => {
  const limits = { roles: { title_rank: ["surgeon", "nurse"] } }
  assert.equal(titleScore("Trauma Surgeon", { limits }), 4)
  assert.equal(titleScore("ICU Nurse", { limits }), 2)
})

test("title_rank position controls the spread, not just the order", () => {
  // A 5-group list produces a wider ladder (10..2) than the 3-group default
  // (6..2) purely from length — no per-rank number the user has to invent.
  const limits = {
    roles: { title_rank: ["a", "b", "c", "d", "e"] },
  }
  assert.equal(titleScore("a", { limits }), 10)
  assert.equal(titleScore("e", { limits }), 2)
  assert.equal(titleScore("z", { limits }), 0)
})

// ---------- isFlatRanking ----------------------------------------------------

test("isFlatRanking is true when every score ties", () => {
  assert.equal(
    isFlatRanking([{ score: 4 }, { score: 4 }, { score: 4 }, { score: 4 }]),
    true,
  )
})

test("isFlatRanking is false when scores differ", () => {
  assert.equal(isFlatRanking([{ score: 4 }, { score: 4 }, { score: 3 }]), false)
})

test("isFlatRanking is false for 0 or 1 leads — nothing to fall through to", () => {
  assert.equal(isFlatRanking([]), false)
  assert.equal(isFlatRanking([{ score: 4 }]), false)
})

// ---------- rankLeads threads limits through to titleScore -----------------

test("rankLeads honours a custom title_rank end to end", () => {
  const leads = [
    {
      id: "1",
      company: "Zeta Health",
      title: "Registered Nurse",
      posted_at: NOW.toISOString(),
    },
    {
      id: "2",
      company: "Acme Health",
      title: "Certified Nursing Assistant",
      posted_at: NOW.toISOString(),
    },
  ]
  const limits = {
    roles: {
      title_rank: [["registered nurse"], ["certified nursing assistant"]],
    },
  }
  const ranked = rankLeads(leads, "", { now: NOW, limits })
  // RN (rank 0, score 4) outscores CNA (rank 1, score 2) — without limits both
  // would score 0 and fall through to Acme-before-Zeta alphabetically instead.
  assert.equal(ranked[0].company, "Zeta Health")
  assert.equal(isFlatRanking(ranked), false)
})

// ---------- CLI: the flat-ranking notice actually prints --------------------

function runRecommend(leads, extra = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "title-rank-"))
  try {
    const leadsPath = path.join(dir, "leads.json")
    fs.writeFileSync(leadsPath, JSON.stringify({ leads }))
    return spawnSync(
      process.execPath,
      [
        path.join(ROOT, "scripts", "leads", "recommend.mjs"),
        "--leads",
        leadsPath,
        "--jobs-dir",
        dir,
        "--profile",
        path.join(ROOT, "tests", "fixtures", "profile.yaml"),
        ...extra,
      ],
      { encoding: "utf8" },
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

test("CLI: a flat (all-tied) result announces itself in terse mode", () => {
  // All nursing titles, all missing from the default (software) title_rank
  // and profile stack, all posted the same day — nothing left to break the
  // tie, so every score comes out identical.
  const leads = ["Zeta", "Yankee", "Acme", "Beta"].map((company, i) => ({
    id: `n:${i}`,
    company,
    title: "Registered Nurse",
    location: "Remote",
    posted_at: "2026-07-25T00:00:00Z",
    status: "new",
    flags: [],
  }))
  const res = runRecommend(leads, ["--quiet"])
  assert.equal(res.status, 0, res.stderr)
  assert.match(res.stdout, /flat=true/)
})

test("CLI: a non-flat result does NOT claim to be flat", () => {
  const leads = [
    {
      id: "s:1",
      company: "Acme",
      title: "Full Stack Engineer",
      location: "Remote",
      posted_at: "2026-07-25T00:00:00Z",
      status: "new",
      flags: [],
    },
    {
      id: "s:2",
      company: "Zeta",
      title: "Marketing Manager",
      location: "Remote",
      posted_at: "2020-01-01T00:00:00Z",
      status: "new",
      flags: [],
    },
  ]
  const res = runRecommend(leads, ["--quiet"])
  assert.equal(res.status, 0, res.stderr)
  assert.doesNotMatch(res.stdout, /flat=true/)
})

test("CLI: human mode prints the NOTE and marks the summary line UNRANKED", () => {
  const leads = ["Zeta", "Acme"].map((company, i) => ({
    id: `n:${i}`,
    company,
    title: "Registered Nurse",
    location: "Remote",
    posted_at: "2026-07-25T00:00:00Z",
    status: "new",
    flags: [],
  }))
  const res = runRecommend(leads, ["--verbose"])
  assert.equal(res.status, 0, res.stderr)
  assert.match(res.stdout, /NOT a ranking/)
  assert.match(res.stdout, /UNRANKED \(all tied\)/)
})
