import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import {
  extractTech,
  profileText,
  computeGaps,
  jobWeight,
} from "../../scripts/profile/profile-gaps.mjs"
import { loadYamlFile } from "../../scripts/lib/lib.mjs"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")

// ---------- extractTech ----------

test("extractTech finds terms across alias variants", () => {
  const found = extractTech(
    "Experience with React.js, Postgres, k8s, and GitHub Actions pipelines",
  )
  assert.ok(found.has("React"))
  assert.ok(found.has("PostgreSQL"))
  assert.ok(found.has("Kubernetes"))
  assert.ok(found.has("CI/CD"))
})

test("extractTech avoids the classic false positives", () => {
  assert.ok(
    !extractTech("go to market strategy").has("Go"),
    "'go to' is not Golang",
  )
  assert.ok(!extractTech("handle the rest of the team").has("REST APIs"))
  assert.ok(
    !extractTech("JavaScript experience").has("Java"),
    "'javascript' is not Java",
  )
  assert.ok(extractTech("Golang services").has("Go"))
  assert.ok(extractTech("Java 17 backend").has("Java"))
})

// ---------- profileText ----------

test("profileText flattens nested profile strings", () => {
  const blob = profileText(
    loadYamlFile(path.join(ROOT, "tests", "fixtures", "profile.yaml")),
  )
  assert.match(blob, /React/)
  assert.match(blob, /PostgreSQL query caching/)
})

// ---------- computeGaps ----------

const JOBS = [
  { slug: "j1", text: "React, Node.js, PostgreSQL, Kubernetes", weight: 1 },
  { slug: "j2", text: "Kubernetes, Terraform, PostgreSQL", weight: 2 },
  { slug: "j3", text: "Rust only", weight: 1 },
]

test("computeGaps splits demanded terms into gaps vs covered, ranked by weight", () => {
  const { gaps, covered } = computeGaps(
    JOBS,
    "I build React and Node.js apps with PostgreSQL",
  )
  const gapNames = gaps.map((g) => g.tech)
  assert.ok(gapNames.includes("Kubernetes"))
  assert.equal(
    gaps.find((g) => g.tech === "Kubernetes").demand,
    3,
    "weights sum",
  )
  assert.ok(covered.map((c) => c.tech).includes("PostgreSQL"))
  assert.ok(
    !gapNames.includes("Rust"),
    "single-job demand is below min_demand=2",
  )
})

test("computeGaps respects minDemand", () => {
  const { gaps } = computeGaps(JOBS, "", { minDemand: 1 })
  assert.ok(gaps.map((g) => g.tech).includes("Rust"))
})

// ---------- jobWeight ----------

test("jobWeight doubles rejected and ignored-after-follow-up applications", () => {
  assert.equal(jobWeight(undefined), 1)
  assert.equal(jobWeight({ status: "rejected" }), 2)
  assert.equal(
    jobWeight({ status: "followed_up", follow_ups: ["2026-07-01"] }),
    2,
  )
  assert.equal(
    jobWeight({ status: "applied" }),
    1,
    "no follow-up yet = no signal",
  )
  assert.equal(jobWeight({ status: "interviewing" }), 1)
})

// ---------- CLI smoke ----------

test("profile-gaps CLI produces a json report from fixtures", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gaps-"))
  try {
    fs.mkdirSync(path.join(dir, "jobs", "acme-dev"), { recursive: true })
    fs.writeFileSync(
      path.join(dir, "jobs", "acme-dev", "job.json"),
      JSON.stringify({
        title: "Backend Developer",
        description: "Kubernetes and Terraform in production",
        requirements: ["Kubernetes", "PostgreSQL"],
      }),
    )
    fs.mkdirSync(path.join(dir, "jobs2", "other-dev"), { recursive: true })
    fs.writeFileSync(
      path.join(dir, "jobs2", "other-dev", "job.json"),
      JSON.stringify({
        title: "x",
        description: "Kubernetes again",
        requirements: [],
      }),
    )
    // merge both jobs into one dir for the scan
    fs.cpSync(
      path.join(dir, "jobs2", "other-dev"),
      path.join(dir, "jobs", "other-dev"),
      {
        recursive: true,
      },
    )

    const res = spawnSync(
      process.execPath,
      [
        path.join(ROOT, "scripts", "profile", "profile-gaps.mjs"),
        "--json",
        "--profile",
        path.join(ROOT, "tests", "fixtures", "profile.yaml"),
        "--jobs-dir",
        path.join(dir, "jobs"),
        "--leads",
        path.join(dir, "no-leads.json"),
        "--applications",
        path.join(dir, "no-apps.yaml"),
      ],
      { encoding: "utf8" },
    )
    assert.equal(res.status, 0, res.stderr)
    const report = JSON.parse(res.stdout)
    assert.equal(report.analyzed_jobs, 2)
    assert.ok(report.gaps.map((g) => g.tech).includes("Kubernetes"))
    assert.ok(report.profile_tech.includes("React"))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("profile-gaps CLI errors cleanly with no profile or no jobs", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gaps-empty-"))
  try {
    const missingProfile = spawnSync(
      process.execPath,
      [
        path.join(ROOT, "scripts", "profile", "profile-gaps.mjs"),
        "--profile",
        path.join(dir, "nope.yaml"),
      ],
      { encoding: "utf8" },
    )
    assert.equal(missingProfile.status, 2)

    const noJobs = spawnSync(
      process.execPath,
      [
        path.join(ROOT, "scripts", "profile", "profile-gaps.mjs"),
        "--profile",
        path.join(ROOT, "tests", "fixtures", "profile.yaml"),
        "--jobs-dir",
        path.join(dir, "empty-jobs"),
        "--leads",
        path.join(dir, "no-leads.json"),
        "--applications",
        path.join(dir, "no-apps.yaml"),
      ],
      { encoding: "utf8" },
    )
    assert.equal(noJobs.status, 2)
    assert.match(noJobs.stderr, /no captured jobs/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
