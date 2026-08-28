// prep-queue picks which leads to tailor ahead of time, so tailoring stops
// happening while the user waits at the apply step. The rules that matter:
// never re-tailor something already verified, never queue something already
// applied to.
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import {
  buildQueue,
  indexWorkspaces,
  applicability,
  preferApplicable,
  APPLICABILITY,
} from "../../scripts/leads/prep-queue.mjs"

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
)
const SCRIPT = path.join(ROOT, "scripts", "leads", "prep-queue.mjs")

const lead = (n, over = {}) => ({
  id: `gh:${n}`,
  company: `Co${n}`,
  title: "Full Stack Engineer",
  url: `https://x.test/${n}`,
  score: 10 - n,
  ...over,
})

test("queues leads with no workspace at all", () => {
  const q = buildQueue([lead(1), lead(2)], { top: 5 })
  assert.equal(q.length, 2)
  assert.equal(q[0].reason, "no_workspace")
  assert.equal(q[0].slug, null)
})

test("skips leads whose resume is already verified", () => {
  const workspaces = new Map([
    [
      "https://x.test/1",
      { slug: "co1-fse", resume_status: "verified", cover_status: "verified" },
    ],
  ])
  const q = buildQueue([lead(1), lead(2)], { workspaces, top: 5 })
  assert.equal(q.length, 1)
  assert.equal(q[0].company, "Co2")
})

test("approved and rendered also count as done", () => {
  for (const status of ["approved", "rendered"]) {
    const workspaces = new Map([
      ["https://x.test/1", { slug: "s", resume_status: status }],
    ])
    assert.equal(
      buildQueue([lead(1)], { workspaces, top: 5 }).length,
      0,
      status,
    )
  }
})

test("a workspace with an unfinished resume is still queued, with its slug", () => {
  const workspaces = new Map([
    ["https://x.test/1", { slug: "co1-fse", resume_status: "drafted" }],
  ])
  const q = buildQueue([lead(1)], { workspaces, top: 5 })
  assert.equal(q.length, 1)
  assert.equal(q[0].slug, "co1-fse")
  assert.equal(q[0].reason, "resume_drafted")

  const bare = new Map([
    ["https://x.test/1", { slug: "co1-fse", resume_status: null }],
  ])
  assert.equal(
    buildQueue([lead(1)], { workspaces: bare, top: 5 })[0].reason,
    "no_resume",
  )
})

test("never queues something already applied to, matching on company + title", () => {
  const applied = [{ company: "  co1 ", title: "FULL STACK ENGINEER" }]
  const q = buildQueue([lead(1), lead(2)], { applied, top: 5 })
  assert.equal(q.length, 1)
  assert.equal(
    q[0].company,
    "Co2",
    "case and whitespace must not defeat the match",
  )
})

test("respects --top after filtering, not before", () => {
  const workspaces = new Map([
    ["https://x.test/1", { slug: "a", resume_status: "verified" }],
    ["https://x.test/2", { slug: "b", resume_status: "verified" }],
  ])
  const q = buildQueue([lead(1), lead(2), lead(3), lead(4)], {
    workspaces,
    top: 2,
  })
  assert.deepEqual(
    q.map((x) => x.company),
    ["Co3", "Co4"],
    "the two verified leads are skipped, not counted against the limit",
  )
})

// ---------- clustering ----------
//
// A cluster member is a posting that a resume tailored for its leader already
// serves. Queueing it would pay for the same tailoring run twice.

test("a covered lead rides along on its leader instead of taking a slot", () => {
  const covered = new Map([["gh:2", "gh:1"]])
  const q = buildQueue([lead(1), lead(2), lead(3)], { top: 5, covered })
  assert.deepEqual(
    q.map((x) => x.id),
    ["gh:1", "gh:3"],
  )
  assert.deepEqual(
    q[0].covers.map((c) => c.id),
    ["gh:2"],
  )
  assert.deepEqual(q[1].covers, [], "an uncovered lead carries an empty list")
})

test("the top cut-off does not hide what a queued run already covers", () => {
  // Cluster members rank below their leader by construction, so a naive
  // `break` at the limit would drop exactly the postings worth reporting.
  const covered = new Map([["gh:4", "gh:1"]])
  const q = buildQueue([lead(1), lead(2), lead(3), lead(4)], {
    top: 2,
    covered,
  })
  assert.equal(q.length, 2)
  assert.deepEqual(
    q[0].covers.map((c) => c.id),
    ["gh:4"],
  )
})

test("a covered lead is not queued even when its leader is not", () => {
  // The leader was already applied to, so its tailored resume exists — the
  // member is served, not stranded.
  const applied = [{ company: "Co1", title: "Full Stack Engineer" }]
  const covered = new Map([["gh:2", "gh:1"]])
  const q = buildQueue([lead(1), lead(2)], { top: 5, applied, covered })
  assert.deepEqual(
    q.map((x) => x.id),
    [],
  )
})

test("indexWorkspaces reads status from context.json and tolerates junk", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prep-queue-"))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))

  const mk = (slug, job, ctx) => {
    fs.mkdirSync(path.join(dir, slug), { recursive: true })
    fs.writeFileSync(path.join(dir, slug, "job.json"), JSON.stringify(job))
    if (ctx !== undefined) {
      fs.writeFileSync(path.join(dir, slug, "context.json"), ctx)
    }
  }
  mk(
    "good",
    { company: "Co1", title: "T", source_url: "https://x.test/1" },
    JSON.stringify({ resume: { status: "verified" } }),
  )
  mk("no-ctx", { company: "Co2", title: "T", source_url: "https://x.test/2" })
  mk(
    "bad-ctx",
    { company: "Co3", title: "T", source_url: "https://x.test/3" },
    "{not json",
  )
  fs.mkdirSync(path.join(dir, "empty"), { recursive: true })

  const idx = indexWorkspaces(dir)
  assert.equal(idx.get("https://x.test/1").resume_status, "verified")
  assert.equal(idx.get("https://x.test/2").resume_status, null)
  assert.equal(idx.get("https://x.test/3").resume_status, null)
  assert.equal(idx.size, 3, "a directory without job.json is not a workspace")
})

test("indexWorkspaces on a missing directory is empty, not an error", () => {
  assert.equal(indexWorkspaces(path.join(ROOT, "no-such-dir-xyz")).size, 0)
})

test("usage errors exit 2", () => {
  const missing = spawnSync(
    process.execPath,
    [SCRIPT, "--leads", path.join(ROOT, "no-such-leads.json")],
    { cwd: ROOT, encoding: "utf8" },
  )
  assert.equal(missing.status, 2)
  assert.match(missing.stderr, /no lead store/)

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prep-queue-cli-"))
  const leads = path.join(dir, "leads.json")
  fs.writeFileSync(leads, JSON.stringify({ leads: [] }))
  const noProfile = spawnSync(
    process.execPath,
    [SCRIPT, "--leads", leads, "--profile", path.join(dir, "nope.yaml")],
    { cwd: ROOT, encoding: "utf8" },
  )
  fs.rmSync(dir, { recursive: true, force: true })
  assert.equal(noProfile.status, 2)
  assert.match(noProfile.stderr, /profile not found/)
})

// --- applicability ordering ----------------------------------------------------
//
// The defect these pin, from the 2026-08-09 cycle: ten prep slots all went to
// Adzuna leads that carry no apply_url and can never be submitted by the
// machine, while nine ready-to-apply Greenhouse/Ashby leads sat below the
// cut-off. Zero documents were prepared. Ranking by fit alone is what did it.

const ALLOW = [
  { domain: "job-boards.greenhouse.io", ats: "greenhouse" },
  { domain: "jobs.ashbyhq.com", ats: "ashby" },
]

test("applicability tiers a lead by how far the machine can carry it", () => {
  assert.equal(
    applicability(
      lead(1, { apply_url: "https://job-boards.greenhouse.io/acme/jobs/42" }),
      ALLOW,
    ),
    APPLICABILITY.AUTOMATABLE,
  )
  // Resolves to a real ATS posting, but no adapter ships for it.
  assert.equal(
    applicability(
      lead(2, { apply_url: "https://jobs.smartrecruiters.com/acme/7" }),
      ALLOW,
    ),
    APPLICABILITY.RESOLVED_OFF_ALLOWLIST,
  )
  assert.equal(applicability(lead(3), ALLOW), APPLICABILITY.MANUAL_ONLY)
})

test("an unparseable apply_url is manual-only, never trusted as resolved", () => {
  assert.equal(
    applicability(lead(4, { apply_url: "not a url" }), ALLOW),
    APPLICABILITY.MANUAL_ONLY,
  )
  // Empty allowlist: nothing is automatable, and a resolved lead does not get
  // promoted just because there is no list to check it against.
  assert.equal(
    applicability(
      lead(5, { apply_url: "https://job-boards.greenhouse.io/acme/jobs/42" }),
      [],
    ),
    APPLICABILITY.RESOLVED_OFF_ALLOWLIST,
  )
})

test("preferApplicable lifts submittable leads over higher-scoring dead ends", () => {
  // Exactly the shape of the real run: the aggregator leads outscore everything.
  const ranked = [
    lead(1, { company: "Trebecon", score: 15 }),
    lead(2, { company: "Centstone", score: 14 }),
    lead(3, {
      company: "Wynn",
      score: 9,
      apply_url: "https://jobs.smartrecruiters.com/wynn/7",
    }),
    lead(4, {
      company: "Cloudflare",
      score: 8,
      apply_url: "https://job-boards.greenhouse.io/cloudflare/jobs/42",
    }),
  ]
  const out = preferApplicable(ranked, ALLOW).map((l) => l.company)
  assert.deepEqual(out, ["Cloudflare", "Wynn", "Trebecon", "Centstone"])
})

test("preferApplicable orders but never drops — hand-apply leads survive", () => {
  const ranked = [lead(1), lead(2), lead(3)]
  const out = preferApplicable(ranked, ALLOW)
  assert.equal(out.length, 3, "no lead may be filtered out of the queue")
})

test("preferApplicable keeps score order inside a tier", () => {
  const ranked = [
    lead(1, { company: "A", score: 30 }),
    lead(2, { company: "B", score: 20 }),
    lead(3, { company: "C", score: 10 }),
  ]
  assert.deepEqual(
    preferApplicable(ranked, ALLOW).map((l) => l.company),
    ["A", "B", "C"],
  )
})

test("--by-score restores the fit-only ordering", () => {
  const ranked = [
    lead(1, { company: "Agg", score: 99 }),
    lead(2, {
      company: "Gh",
      score: 1,
      apply_url: "https://job-boards.greenhouse.io/gh/jobs/1",
    }),
  ]
  assert.equal(preferApplicable(ranked, ALLOW)[0].company, "Gh")
  // The flag path is main()'s; what it selects is the unsorted list itself.
  assert.equal(ranked[0].company, "Agg")
})

test("buildQueue reports the tier and the resolved posting", () => {
  const q = buildQueue(
    [
      lead(1, {
        apply_url: "https://job-boards.greenhouse.io/acme/jobs/42",
      }),
      lead(2),
    ],
    { top: 5, allowlist: ALLOW },
  )
  assert.equal(q[0].applicability, "automatable")
  assert.equal(q[0].apply_url, "https://job-boards.greenhouse.io/acme/jobs/42")
  assert.equal(q[1].applicability, "manual-only")
  assert.equal(q[1].apply_url, null)
})

// --- partition BEFORE the window, and the same scores as recommend ----------
//
// Measured 2026-08-17 on the real store: at the default --top 5 the queue read
// `manual_only=5 automatable=0` while `--top 20` read `automatable=17`. The
// window (`max(top*4, 20)` by score) was cut BEFORE the applicability
// partition, so twenty aggregator leads that outscore every board lead filled
// it and the partition had nothing automatable left to lift. Same shape as the
// 2026-08-09 defect above, one level up.

test("CLI: an automatable lead outside the score window still makes the default queue", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prep-queue-window-"))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  // Twenty-two identical aggregator leads with company names that sort first,
  // and one Greenhouse lead named to sort LAST — so on a tie the score-first
  // window would hold exactly the twenty-two and never reach it.
  const leads = []
  for (let i = 0; i < 22; i++)
    leads.push({
      id: `adzuna:${i}`,
      company: `Aaa Corp ${String(i).padStart(2, "0")}`,
      title: "Full Stack Engineer",
      url: `https://www.adzuna.com/land/ad/${i}`,
      status: "new",
      description: "React Node.js TypeScript",
    })
  leads.push({
    id: "greenhouse:zzz:1",
    company: "Zzz Robotics",
    title: "Full Stack Engineer",
    url: "https://job-boards.greenhouse.io/zzz/jobs/1",
    apply_url: "https://job-boards.greenhouse.io/zzz/jobs/1",
    status: "new",
    description: "React Node.js TypeScript",
  })
  const leadsFile = path.join(dir, "leads.json")
  fs.writeFileSync(leadsFile, JSON.stringify({ leads }))
  const limitsFile = path.join(dir, "limits.yaml")
  fs.writeFileSync(
    limitsFile,
    "auto_apply:\n  board_allowlist:\n    job-boards.greenhouse.io: greenhouse\n",
  )
  const r = spawnSync(
    process.execPath,
    [
      SCRIPT,
      "--leads",
      leadsFile,
      "--profile",
      path.join(ROOT, "tests", "fixtures", "profile.yaml"),
      "--limits",
      limitsFile,
      "--jobs-dir",
      path.join(dir, "jobs"),
      "--applications",
      path.join(dir, "applications.yaml"),
      "--json",
    ],
    { cwd: ROOT, encoding: "utf8" },
  )
  assert.equal(r.status, 0, r.stderr)
  const queue = JSON.parse(r.stdout)
  assert.equal(queue.length, 5)
  assert.equal(
    queue[0].id,
    "greenhouse:zzz:1",
    "the one lead the machine can finish leads the queue, whatever the " +
      "score window would have held",
  )
  assert.equal(queue[0].applicability, "automatable")

  // --by-score is the old ordering and must still be the old ordering.
  const byScore = spawnSync(
    process.execPath,
    [
      SCRIPT,
      "--leads",
      leadsFile,
      "--profile",
      path.join(ROOT, "tests", "fixtures", "profile.yaml"),
      "--limits",
      limitsFile,
      "--jobs-dir",
      path.join(dir, "jobs"),
      "--applications",
      path.join(dir, "applications.yaml"),
      "--by-score",
      "--json",
    ],
    { cwd: ROOT, encoding: "utf8" },
  )
  assert.equal(byScore.status, 0, byScore.stderr)
  assert.ok(
    JSON.parse(byScore.stdout).every((q) => q.applicability === "manual-only"),
    "--by-score restores fit-only ordering, aggregators first",
  )
})

test("CLI: the summary line reports the whole supply per tier, not just the queue", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prep-queue-supply-"))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const leads = [
    {
      id: "gh:1",
      company: "A",
      title: "Full Stack Engineer",
      url: "https://job-boards.greenhouse.io/a/jobs/1",
      apply_url: "https://job-boards.greenhouse.io/a/jobs/1",
      status: "new",
    },
    {
      id: "wd:1",
      company: "B",
      title: "Full Stack Engineer",
      url: "https://b.wd1.myworkdayjobs.com/x/job/1",
      apply_url: "https://b.wd1.myworkdayjobs.com/x/job/1",
      status: "new",
    },
    {
      id: "adzuna:1",
      company: "C",
      title: "Full Stack Engineer",
      url: "https://www.adzuna.com/land/ad/1",
      status: "new",
    },
  ]
  const leadsFile = path.join(dir, "leads.json")
  fs.writeFileSync(leadsFile, JSON.stringify({ leads }))
  const limitsFile = path.join(dir, "limits.yaml")
  fs.writeFileSync(
    limitsFile,
    "auto_apply:\n  board_allowlist:\n    job-boards.greenhouse.io: greenhouse\n",
  )
  const r = spawnSync(
    process.execPath,
    [
      SCRIPT,
      "--leads",
      leadsFile,
      "--profile",
      path.join(ROOT, "tests", "fixtures", "profile.yaml"),
      "--limits",
      limitsFile,
      "--jobs-dir",
      path.join(dir, "jobs"),
      "--applications",
      path.join(dir, "applications.yaml"),
      "--top",
      "1",
    ],
    { cwd: ROOT, encoding: "utf8", env: { ...process.env, CI: "1" } },
  )
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /queued=1 /)
  assert.match(r.stdout, /automatable=1 off_allowlist=0 manual_only=0/)
  assert.match(
    r.stdout,
    /supply=1\/1\/1/,
    "one of each tier exists in the store even though only one was queued",
  )
})

test("CLI: a lead screening already REJECTED is left out of the queue and counted, and --include-rejected puts it back", async (t) => {
  // 2026-08-18. The queue was built from `status === "new"` alone and never read
  // the screens table, so leads screen.mjs had rejected still took prep slots
  // (three of the top twenty on 2026-08-17). The verdict read is the same one
  // the runner's trust gate reads — model first, mechanical fallback.
  const { openDb, upsertLeads, recordScreens } =
    await import("../../scripts/lib/db.mjs")
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prep-queue-screened-"))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const dbFile = path.join(dir, "leads.db")
  const db = openDb(dbFile)
  upsertLeads(db, [
    {
      id: "gh:pass",
      company: "Alpha",
      title: "Full Stack Engineer",
      url: "https://job-boards.greenhouse.io/alpha/jobs/1",
      apply_url: "https://job-boards.greenhouse.io/alpha/jobs/1",
      status: "new",
      description: "React Node.js TypeScript",
    },
    {
      id: "gh:reject",
      company: "Beta",
      title: "Full Stack Engineer",
      url: "https://job-boards.greenhouse.io/beta/jobs/2",
      apply_url: "https://job-boards.greenhouse.io/beta/jobs/2",
      status: "new",
      description: "React Node.js TypeScript",
    },
    {
      id: "gh:model-pass",
      company: "Gamma",
      title: "Full Stack Engineer",
      url: "https://job-boards.greenhouse.io/gamma/jobs/3",
      apply_url: "https://job-boards.greenhouse.io/gamma/jobs/3",
      status: "new",
      description: "React Node.js TypeScript",
    },
  ])
  recordScreens(db, [
    { lead_id: "gh:pass", source: "mechanical", verdict: "pass" },
    {
      lead_id: "gh:reject",
      source: "mechanical",
      verdict: "reject",
      reason: "stale_33d",
    },
    // Mechanical said reject, the model said pass: the model wins, as it does
    // at the gate.
    { lead_id: "gh:model-pass", source: "mechanical", verdict: "reject" },
    { lead_id: "gh:model-pass", source: "model", verdict: "pass" },
  ])
  db.close()
  const limitsFile = path.join(dir, "limits.yaml")
  fs.writeFileSync(
    limitsFile,
    "auto_apply:\n  board_allowlist:\n    job-boards.greenhouse.io: greenhouse\n",
  )
  const args = (extra) => [
    SCRIPT,
    "--leads",
    dbFile,
    "--profile",
    path.join(ROOT, "tests", "fixtures", "profile.yaml"),
    "--limits",
    limitsFile,
    "--jobs-dir",
    path.join(dir, "jobs"),
    "--applications",
    path.join(dir, "applications.yaml"),
    ...extra,
  ]
  const r = spawnSync(process.execPath, args(["--json"]), {
    cwd: ROOT,
    encoding: "utf8",
  })
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(
    JSON.parse(r.stdout)
      .map((q) => q.id)
      .sort(),
    ["gh:model-pass", "gh:pass"],
    "the mechanically-rejected lead is out; the model-overridden one is in",
  )
  const terse = spawnSync(process.execPath, args([]), {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, CI: "1" },
  })
  assert.equal(terse.status, 0, terse.stderr)
  assert.match(terse.stdout, /queued=2 /)
  assert.match(terse.stdout, /screened_out=1/)

  const back = spawnSync(
    process.execPath,
    args(["--include-rejected", "--json"]),
    {
      cwd: ROOT,
      encoding: "utf8",
    },
  )
  assert.equal(back.status, 0, back.stderr)
  assert.equal(
    JSON.parse(back.stdout).length,
    3,
    "--include-rejected restores it",
  )
})
