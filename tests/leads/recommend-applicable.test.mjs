// recommend.mjs --applicable: the same ranking, with the leads the machine can
// finish lifted to the top and every row carrying its tier.
//
// MEASURED 2026-08-17: four of the fit-ranked top five were Adzuna redirects
// that canonical.mjs cannot resolve (403 — a bot wall), and the digest read
// them out every morning as recommendations nothing could act on. The rank was
// not wrong; the presentation was.
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
)
const SCRIPT = path.join(ROOT, "scripts", "leads", "recommend.mjs")
const PROFILE = path.join(ROOT, "tests", "fixtures", "profile.yaml")

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "recommend-applicable-"))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  // Identical text so fit ties, and company names chosen so the aggregator
  // leads sort FIRST on the tie-break — that is the shape of the real store.
  const leads = [
    {
      id: "adzuna:1",
      company: "Aaa Staffing",
      title: "Full Stack Engineer",
      url: "https://www.adzuna.com/land/ad/1",
      status: "new",
      description: "React Node.js TypeScript",
    },
    {
      id: "adzuna:2",
      company: "Abb Staffing",
      title: "Full Stack Engineer",
      url: "https://www.adzuna.com/land/ad/2",
      status: "new",
      description: "React Node.js TypeScript",
    },
    {
      id: "wd:1",
      company: "Mmm Water District",
      title: "Full Stack Engineer",
      url: "https://mmm.wd1.myworkdayjobs.com/x/job/1",
      apply_url: "https://mmm.wd1.myworkdayjobs.com/x/job/1",
      status: "new",
      description: "React Node.js TypeScript",
    },
    {
      id: "greenhouse:zzz:1",
      company: "Zzz Robotics",
      title: "Full Stack Engineer",
      url: "https://job-boards.greenhouse.io/zzz/jobs/1",
      apply_url: "https://job-boards.greenhouse.io/zzz/jobs/1",
      status: "new",
      description: "React Node.js TypeScript",
    },
  ]
  const leadsFile = path.join(dir, "leads.json")
  fs.writeFileSync(leadsFile, JSON.stringify({ leads }))
  const limitsFile = path.join(dir, "limits.yaml")
  fs.writeFileSync(
    limitsFile,
    "auto_apply:\n  board_allowlist:\n    job-boards.greenhouse.io: greenhouse\n",
  )
  return { dir, leadsFile, limitsFile }
}

const run = (args, env = {}) =>
  spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, CI: "1", ...env },
  })

test("--applicable lifts the automatable lead to the top and cuts AFTER lifting", (t) => {
  const { leadsFile, limitsFile } = fixture(t)
  const r = run([
    "--leads",
    leadsFile,
    "--profile",
    PROFILE,
    "--limits",
    limitsFile,
    "--top",
    "2",
    "--applicable",
    "--json",
  ])
  assert.equal(r.status, 0, r.stderr)
  const out = JSON.parse(r.stdout)
  assert.equal(out.length, 2)
  assert.equal(out[0].id, "greenhouse:zzz:1")
  assert.equal(out[0].applicability, "automatable")
  assert.equal(out[1].id, "wd:1", "resolved-but-off-allowlist is tier 1")
  assert.equal(out[1].applicability, "off-allowlist")
})

test("without --applicable the order is fit-only, and every row still carries its tier", (t) => {
  const { leadsFile, limitsFile } = fixture(t)
  const r = run([
    "--leads",
    leadsFile,
    "--profile",
    PROFILE,
    "--limits",
    limitsFile,
    "--top",
    "2",
    "--json",
  ])
  assert.equal(r.status, 0, r.stderr)
  const out = JSON.parse(r.stdout)
  assert.deepEqual(
    out.map((x) => x.id),
    ["adzuna:1", "adzuna:2"],
    "the old ordering is the old ordering",
  )
  assert.ok(out.every((x) => x.applicability === "manual-only"))
})

test("terse output names the tier and prefers apply_url over the posting url", (t) => {
  const { leadsFile, limitsFile } = fixture(t)
  const r = run([
    "--leads",
    leadsFile,
    "--profile",
    PROFILE,
    "--limits",
    limitsFile,
    "--top",
    "1",
    "--applicable",
  ])
  assert.equal(r.status, 0, r.stderr)
  const [line, summary] = r.stdout.trim().split(/\r?\n/)
  assert.match(
    line,
    /\|automatable\|https:\/\/job-boards\.greenhouse\.io\/zzz\/jobs\/1$/,
  )
  assert.match(summary, /^ranked=1 of=4 applicable=true/)
})

// --- tier 3: already applied ------------------------------------------------
//
// MEASURED 2026-08-24. `--applicable` ranked
// torc-robotics-software-engineer-ii-build-tools FIRST while the applications
// ledger held a row for it dated 2026-08-18. applicability() asked only where
// the posting LIVES; nothing in recommend.mjs consulted the ledger at all, and
// all four Torc leads were still `status: "new"` days after being applied to.
import {
  applicability,
  preferApplicable,
  APPLICABILITY,
  APPLICABILITY_NAMES,
} from "../../scripts/leads/applicability.mjs"

// The shape normalizeAllowlist() actually produces: `domain`, not `host`.
const ALLOW = [{ domain: "job-boards.greenhouse.io", ats: "greenhouse" }]
const lead = (slug, host = "job-boards.greenhouse.io") => ({
  slug,
  apply_url: `https://${host}/acme/jobs/1`,
})

test("an applied lead is tier ALREADY_APPLIED, whatever its board", () => {
  const l = lead("acme-swe")
  // Without the predicate it is automatable — the board is on the allowlist.
  assert.equal(applicability(l, ALLOW), APPLICABILITY.AUTOMATABLE)
  // With it, "already done" outranks every question about reachability.
  assert.equal(
    applicability(l, ALLOW, { isApplied: () => true }),
    APPLICABILITY.ALREADY_APPLIED,
  )
})

test("applied leads are RANKED LAST, never dropped", () => {
  // The module's own principle: an unactionable lead is still information.
  // Silently shrinking the list is how the user stops trusting the count.
  const applied = lead("done")
  const fresh = lead("todo")
  const ordered = preferApplicable([applied, fresh], ALLOW, {
    isApplied: (l) => l.slug === "done",
  })
  assert.deepEqual(
    ordered.map((l) => l.slug),
    ["todo", "done"],
  )
  assert.equal(ordered.length, 2, "nothing may be dropped")
})

test("the tier has a name, so the row can say why it is last", () => {
  assert.equal(
    APPLICABILITY_NAMES[APPLICABILITY.ALREADY_APPLIED],
    "already-applied",
  )
})

test("no predicate means the previous behaviour, exactly", () => {
  // Every existing caller passes no predicate; none of them may change.
  for (const host of ["job-boards.greenhouse.io", "www.adzuna.com"])
    assert.equal(
      applicability(lead("x", host), ALLOW),
      applicability(lead("x", host), ALLOW, { isApplied: null }),
    )
})
