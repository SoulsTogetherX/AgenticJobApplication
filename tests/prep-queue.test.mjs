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
import { buildQueue, indexWorkspaces } from "../scripts/prep-queue.mjs"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const SCRIPT = path.join(ROOT, "scripts", "prep-queue.mjs")

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
