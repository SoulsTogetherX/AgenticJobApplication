import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import yaml from "js-yaml"
import {
  findDuplicate,
  formatEntry,
  addEntryToText,
  removeEntryFromText,
} from "../scripts/manage-sources.mjs"
import { loadEnv, normalizeAdzunaJob } from "../scripts/find-jobs.mjs"

const BOARDS = [
  { type: "greenhouse", slug: "anthropic", company: "Anthropic" },
  { type: "ashby", slug: "openai", company: "OpenAI" },
  {
    type: "workday",
    company: "NVIDIA",
    host: "nvidia.wd5.myworkdayjobs.com",
    tenant: "nvidia",
    site: "NVIDIAExternalCareerSite",
  },
]

// ---------- duplicate detection ----------

test("findDuplicate matches by company name (case-insensitive)", () => {
  const dup = findDuplicate(BOARDS, {
    type: "lever",
    slug: "anthropic-x",
    company: "ANTHROPIC",
  })
  assert.equal(dup?.slug, "anthropic")
})

test("findDuplicate matches by type+slug and workday tenant", () => {
  assert.ok(
    findDuplicate(BOARDS, { type: "ashby", slug: "OpenAI", company: "Other" }),
  )
  assert.ok(
    findDuplicate(BOARDS, { type: "workday", tenant: "nvidia", company: "X" }),
  )
  assert.equal(
    findDuplicate(BOARDS, { type: "lever", slug: "openai", company: "Novel" }),
    null,
    "same slug on a different ATS is not a duplicate",
  )
})

// ---------- yaml text editing (comment-preserving) ----------

const SAMPLE = `# keep this comment
boards:
  - { type: greenhouse, slug: anthropic, company: Anthropic }
  - { type: ashby, slug: openai, company: OpenAI }
`

test("addEntryToText appends a parseable single-line entry and keeps comments", () => {
  const out = addEntryToText(SAMPLE, {
    type: "lever",
    slug: "acme",
    company: "Acme, Inc.",
  })
  assert.ok(out.includes("# keep this comment"))
  const doc = yaml.load(out)
  assert.equal(doc.boards.length, 3)
  assert.equal(doc.boards[2].company, "Acme, Inc.")
})

test("removeEntryFromText deletes by company or slug and keeps everything else", () => {
  const byCompany = removeEntryFromText(SAMPLE, "openai")
  assert.equal(byCompany.removed, 1)
  const doc = yaml.load(byCompany.text)
  assert.equal(doc.boards.length, 1)
  assert.ok(byCompany.text.includes("# keep this comment"))

  const bySlug = removeEntryFromText(SAMPLE, "anthropic")
  assert.equal(bySlug.removed, 1)

  const miss = removeEntryFromText(SAMPLE, "nonexistent")
  assert.equal(miss.removed, 0)
})

test("formatEntry quotes values that need it and round-trips through yaml", () => {
  const line = formatEntry({
    type: "lever",
    slug: "acme",
    company: "Acme: Iron & Co",
  })
  const parsed = yaml.load(line.replace(/^\s*-\s*/, ""))
  assert.equal(parsed.company, "Acme: Iron & Co")
  const wd = formatEntry({
    type: "workday",
    company: "X Corp",
    host: "x.wd1.myworkdayjobs.com",
    tenant: "x",
    site: "External",
  })
  assert.ok(wd.includes("host:") && wd.includes("site:"))
})

test("formatEntry omits absent fields instead of writing the string 'undefined'", () => {
  // An oracle_cloud board has no slug. Writing `slug: undefined` produced
  // entries that prescreened OK on add and then failed every later fetch,
  // because the identifying fields were never persisted.
  const line = formatEntry({
    type: "oracle_cloud",
    company: "Caesars Entertainment",
    host: "edmn.fa.us2.oraclecloud.com",
    site: "CX_1",
    slug: undefined,
  })
  assert.ok(!/undefined/.test(line), line)
  const parsed = yaml.load(line.replace(/^\s*-\s*/, ""))
  assert.deepEqual(parsed, {
    type: "oracle_cloud",
    company: "Caesars Entertainment",
    host: "edmn.fa.us2.oraclecloud.com",
    site: "CX_1",
  })
})

test("findDuplicate matches host-based boards on their own identity field", () => {
  const boards = [
    {
      type: "oracle_cloud",
      company: "Caesars Entertainment",
      host: "edmn.fa.us2.oraclecloud.com",
      site: "CX_1",
    },
  ]
  // Same site, different company name -> still the same board.
  assert.ok(
    findDuplicate(boards, {
      type: "oracle_cloud",
      company: "Caesars",
      host: "edmn.fa.us2.oraclecloud.com",
      site: "CX_1",
    }),
  )
  // A different site on the same host is a genuinely different board.
  assert.equal(
    findDuplicate(boards, {
      type: "oracle_cloud",
      company: "Someone Else",
      host: "edmn.fa.us2.oraclecloud.com",
      site: "CX_2",
    }),
    null,
  )
})

// ---------- .env parsing ----------

test("loadEnv parses KEY=value, quotes, comments; real env wins", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "env-test-"))
  const file = path.join(dir, ".env")
  try {
    fs.writeFileSync(
      file,
      '# comment\nADZUNA_APP_ID=abc123\nADZUNA_APP_KEY="quoted-key"\nBAD LINE\nMANAGE_SOURCES_TEST_OVERRIDE=from-file\n',
    )
    process.env.MANAGE_SOURCES_TEST_OVERRIDE = "from-env"
    const env = loadEnv(file)
    assert.equal(env.ADZUNA_APP_ID, "abc123")
    assert.equal(env.ADZUNA_APP_KEY, "quoted-key")
    assert.equal(env.MANAGE_SOURCES_TEST_OVERRIDE, "from-env")
    assert.deepEqual(loadEnv(path.join(dir, "missing.env")), {})
  } finally {
    delete process.env.MANAGE_SOURCES_TEST_OVERRIDE
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// ---------- adzuna normalization ----------

test("normalizeAdzunaJob maps fields including salary for the gate", () => {
  const lead = normalizeAdzunaJob({
    id: 12345,
    title: "Full Stack Developer",
    company: { display_name: "Acme" },
    location: { display_name: "Las Vegas, NV" },
    redirect_url: "https://www.adzuna.com/land/ad/12345",
    created: "2026-07-20T00:00:00Z",
    salary_min: 90000,
    salary_max: 120000,
  })
  assert.equal(lead.id, "adzuna:12345")
  assert.equal(lead.source, "adzuna")
  assert.equal(lead.company, "Acme")
  assert.equal(lead.location, "Las Vegas, NV")
  assert.equal(lead.salary_max, 120000)
  assert.equal(lead.posted_at, "2026-07-20T00:00:00Z")
})

test("normalizeAdzunaJob tolerates missing fields", () => {
  const lead = normalizeAdzunaJob({ id: 1 })
  assert.equal(lead.company, "unknown")
  assert.equal(lead.salary_max, null)
  assert.equal(lead.posted_at, null)
})
