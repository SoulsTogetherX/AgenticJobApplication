#!/usr/bin/env node
// Profile-gap analysis (deterministic, no LLM calls): what do the jobs you're
// pursuing keep asking for that your profile doesn't evidence?
//
// Demand side: every captured job workspace (jobs/*/job.json description +
// requirements) and, weakly, stored lead titles (jobs/leads.json).
// Supply side: all text in profile/profile.yaml (bullets, tech, skills).
// Jobs whose application ended in rejection or silence count double — those
// are the requirements that are actually costing interviews.
//
// Usage: node scripts/profile/profile-gaps.mjs [--json] [--min-demand N]
//        [--profile <path>] [--jobs-dir <path>] [--leads <path>] [--applications <path>]
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { loadYamlFile, isTerse } from "../lib/lib.mjs"
import {
  readLeadStore,
  resolveLeadSource,
  readApplications,
} from "../lib/db.mjs"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")

// Tech lexicon: term → detection regex (word-boundary, case-insensitive).
// Alias groups count as one term.
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
const term = (name, aliases = [name]) => ({
  name,
  re: new RegExp(
    `(^|[^a-z0-9+#.])(${aliases.map(esc).join("|")})($|[^a-z0-9+#])`,
    "i",
  ),
})
export const TECH_LEXICON = [
  term("TypeScript", ["typescript"]),
  term("JavaScript", ["javascript", "js", "es6"]),
  term("Python", ["python"]),
  term("Java", ["java"]),
  term("C#", ["c#", ".net", "dotnet"]),
  term("Go", ["golang"]),
  term("Rust", ["rust"]),
  term("Ruby", ["ruby", "rails"]),
  term("PHP", ["php", "laravel"]),
  term("React", ["react", "react.js", "reactjs"]),
  term("Next.js", ["next.js", "nextjs"]),
  term("Vue", ["vue", "vue.js", "nuxt"]),
  term("Angular", ["angular"]),
  term("Svelte", ["svelte", "sveltekit"]),
  term("Node.js", ["node", "node.js", "nodejs"]),
  term("Express", ["express", "express.js"]),
  term("GraphQL", ["graphql"]),
  term("REST APIs", ["rest api", "rest apis", "restful"]),
  term("gRPC", ["grpc"]),
  term("PostgreSQL", ["postgres", "postgresql"]),
  term("MySQL", ["mysql", "mariadb"]),
  term("SQL", ["sql"]),
  term("MongoDB", ["mongodb", "mongo"]),
  term("Redis", ["redis"]),
  term("Elasticsearch", ["elasticsearch", "opensearch"]),
  term("Kafka", ["kafka"]),
  term("RabbitMQ", ["rabbitmq"]),
  term("AWS", ["aws", "amazon web services", "ec2", "s3", "lambda"]),
  term("GCP", ["gcp", "google cloud"]),
  term("Azure", ["azure"]),
  term("Docker", ["docker", "containers", "containerized"]),
  term("Kubernetes", ["kubernetes", "k8s"]),
  term("Terraform", ["terraform"]),
  term("CI/CD", [
    "ci/cd",
    "cicd",
    "continuous integration",
    "github actions",
    "jenkins",
  ]),
  term("Linux", ["linux", "unix"]),
  term("Git", ["git"]),
  term("Testing", [
    "unit test",
    "unit testing",
    "jest",
    "pytest",
    "cypress",
    "playwright",
    "tdd",
  ]),
  term("Microservices", ["microservice", "microservices"]),
  term("Serverless", ["serverless"]),
  term("Observability", [
    "datadog",
    "grafana",
    "prometheus",
    "observability",
    "monitoring",
  ]),
  term("Auth", ["oauth", "oidc", "sso", "authentication"]),
  term("WebSockets", ["websocket", "websockets"]),
  term("HTML/CSS", ["html", "css", "tailwind", "sass"]),
  term("AI/LLM integration", [
    "llm",
    "openai api",
    "anthropic api",
    "rag",
    "prompt engineering",
    "genai",
    "generative ai",
  ]),
  term("Machine Learning", ["machine learning", "pytorch", "tensorflow"]),
]

export function extractTech(text, lexicon = TECH_LEXICON) {
  const found = new Set()
  const t = String(text ?? "")
  for (const { name, re } of lexicon) {
    if (re.test(t)) found.add(name)
  }
  return found
}

// Flatten every string in the profile into one searchable blob.
export function profileText(profile) {
  const parts = []
  const walk = (v) => {
    if (typeof v === "string") parts.push(v)
    else if (Array.isArray(v)) v.forEach(walk)
    else if (v && typeof v === "object") Object.values(v).forEach(walk)
  }
  walk(profile)
  return parts.join("\n")
}

// Pure core: jobs = [{slug, text, weight}] → ranked demand vs evidence.
export function computeGaps(
  jobs,
  profileBlob,
  { minDemand = 2, lexicon = TECH_LEXICON } = {},
) {
  const evidenced = extractTech(profileBlob, lexicon)
  const demand = new Map() // term → { weight, jobs: [slug] }
  for (const job of jobs) {
    const terms = extractTech(job.text, lexicon)
    for (const t of terms) {
      const d = demand.get(t) ?? { weight: 0, jobs: [] }
      d.weight += job.weight ?? 1
      d.jobs.push(job.slug)
      demand.set(t, d)
    }
  }
  const rows = [...demand.entries()]
    .map(([tech, d]) => ({
      tech,
      demand: d.weight,
      jobs: d.jobs,
      evidenced: evidenced.has(tech),
    }))
    .filter((r) => r.demand >= minDemand)
    .sort((a, b) => b.demand - a.demand)
  return {
    gaps: rows.filter((r) => !r.evidenced),
    covered: rows.filter((r) => r.evidenced),
    profile_tech: [...evidenced].sort(),
  }
}

// Weight: jobs that got a rejection or silence after ≥1 follow-up teach the
// most — they demonstrably didn't convert.
export function jobWeight(application) {
  if (!application) return 1
  if (application.status === "rejected") return 2
  if (
    (application.status === "followed_up" ||
      application.status === "applied") &&
    (application.follow_ups?.length ?? 0) >= 1
  )
    return 2
  return 1
}

function flag(args, name) {
  const i = args.indexOf(name)
  return i !== -1 ? (args[i + 1] ?? true) : null
}

function gatherJobs(jobsDir, leadsPath, applications) {
  const bySlug = new Map(applications.map((a) => [a.slug, a]))
  const jobs = []
  if (fs.existsSync(jobsDir)) {
    for (const slug of fs.readdirSync(jobsDir)) {
      const jobFile = path.join(jobsDir, slug, "job.json")
      if (!fs.existsSync(jobFile)) continue
      try {
        const j = JSON.parse(fs.readFileSync(jobFile, "utf8"))
        jobs.push({
          slug,
          text: [j.title, j.description, ...(j.requirements ?? [])].join("\n"),
          weight: jobWeight(bySlug.get(slug)),
        })
      } catch {
        console.error(`warn: unreadable ${jobFile}, skipped`)
      }
    }
  }
  if (fs.existsSync(leadsPath)) {
    try {
      const { leads } = readLeadStore(leadsPath)
      for (const l of leads ?? []) {
        if (l.status === "dismissed") continue
        jobs.push({ slug: l.id, text: l.title ?? "", weight: 0.5 }) // titles only: weak signal
      }
    } catch {
      console.error(`warn: unreadable ${leadsPath}, skipped`)
    }
  }
  return jobs
}

function main() {
  const args = process.argv.slice(2)
  const profilePath =
    flag(args, "--profile") || path.join(ROOT, "profile", "profile.yaml")
  const jobsDir = flag(args, "--jobs-dir") || path.join(ROOT, "jobs")
  // Defaults to jobs/leads.db when it exists, else the legacy JSON store.
  const leadsPath = flag(args, "--leads") || resolveLeadSource().file
  const applicationsPath =
    flag(args, "--applications") ||
    path.join(ROOT, "profile", "applications.yaml")
  const minDemand = Number(flag(args, "--min-demand") || 2)

  if (!fs.existsSync(profilePath)) {
    console.error(`profile not found at ${profilePath}`)
    process.exit(2)
  }
  const profile = loadYamlFile(profilePath)
  const applications = readApplications(
    applicationsPath.endsWith("applications.yaml") ? null : applicationsPath,
  )
  const jobs = gatherJobs(jobsDir, leadsPath, applications)
  if (!jobs.length) {
    console.error(
      "no captured jobs or leads to analyze — run a search or capture some postings first",
    )
    process.exit(2)
  }

  const result = computeGaps(jobs, profileText(profile), { minDemand })
  if (args.includes("--json")) {
    console.log(
      JSON.stringify({ analyzed_jobs: jobs.length, ...result }, null, 2),
    )
    return
  }
  if (isTerse()) {
    const fmt = (rows) => rows.map((r) => `${r.tech}(${r.demand})`).join(" ")
    console.log(`analyzed=${jobs.length}`)
    console.log(`gaps: ${fmt(result.gaps) || "none"}`)
    console.log(`covered: ${fmt(result.covered) || "none"}`)
    return
  }
  console.log(`Analyzed ${jobs.length} job(s)/lead(s).\n`)
  console.log("GAPS (demanded, not evidenced in profile):")
  for (const g of result.gaps) console.log(`  ${g.tech}  (demand ${g.demand})`)
  if (!result.gaps.length) console.log("  none at this threshold")
  console.log("\nCOVERED (demanded and evidenced):")
  for (const c of result.covered)
    console.log(`  ${c.tech}  (demand ${c.demand})`)
}

const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (isMain) main()
