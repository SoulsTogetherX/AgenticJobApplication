#!/usr/bin/env node
// Capture the page an ATS shows AFTER the user clicks submit (§4.10, Phase 5 W2).
//
// ===========================================================================
// WHY THIS EXISTS, AND WHY IT IS THE ONLY LAWFUL SOURCE
// ===========================================================================
//
// `scripts/auto/classify.mjs` types the post-click page. §4.10 requires its
// corpus to be REAL confirmation, identity-verification, bot-challenge,
// email-code, error and not-a-confirmation pages, and §4.6 forbids the guess
// that would otherwise fill the gap: somebody writing "a confirmation says
// 'thank you for applying'" from memory. That guess fails in the one direction
// that cannot be recovered — a page misread as a confirmation records an
// application that was never sent, and nothing later corrects it.
//
// The user is on the submit button for every application today (hard rule 6).
// So the pages exist; they are simply not being kept. This script keeps them.
//
// ===========================================================================
// THE THREE STEPS, AND WHY IT IS NOT ONE
// ===========================================================================
//
//   stage    — right after the user's click. Redacts, writes to a GITIGNORED
//              directory under jobs/, and REFUSES if any known identifier
//              survived the redaction.
//   review   — prints the redacted page's visible text, so the user reads what
//              they are about to publish rather than trusting a summary of it.
//   promote  — copies it into the committed corpus, and only with an explicit
//              --user-approved flag.
//
// One step would be simpler and wrong. A confirmation page carries the user's
// name, their email, often their phone and address, and an application
// reference that identifies them to that employer. The committed corpus lives
// in git and goes wherever this repository goes. So the boundary between "on
// this machine" and "in the repository" is a step the user takes deliberately,
// after reading the bytes — not a default this script picks for them.
//
// REDACTION IS CHECKED, NOT ASSUMED. `assertRedacted` re-reads the output and
// throws if any identifier from the fact base is still present. A redactor that
// silently missed a pattern is worse than no redactor, because the staging
// directory's whole purpose is to be the thing that was safe to look at.
//
// ===========================================================================
// WHAT THIS SCRIPT MAY NOT DO
// ===========================================================================
//
// It never writes profile/ (hard rule 2 — there is no code here that can).
// It never decides a page's KIND: the user says which kind a promoted sample
// is, because "what does this page mean" is exactly the judgement §4.6 keeps
// away from anything automatic. And it contains no click.
import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import { fileURLToPath } from "node:url"
import { loadYamlFile } from "../lib/lib.mjs"
import { assertInsideJobs, JOBS_DIR, PROFILE_DIR } from "../auto/guard.mjs"
import { visibleText, CLASSIFICATIONS } from "../auto/classify.mjs"

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
)

/** Gitignored, under jobs/, because a raw-ish capture is the user's data and
 *  must not be committable by accident. */
export const STAGING_DIR = path.join(JOBS_DIR, ".auto", "post-submit")

/** The committed corpus. Reached only through `promote`. */
export const CORPUS_DIR = path.join(ROOT, "tests", "fixtures", "post-submit")
export const CORPUS_MANIFEST = path.join(CORPUS_DIR, "corpus.json")

const REDACTED = "[REDACTED]"

// ---------------------------------------------------------------------------
// identifiers
// ---------------------------------------------------------------------------

/**
 * Everything about the user that must not survive into the corpus.
 *
 * Pulled from the FACT BASE rather than guessed, because the fact base is
 * exactly the list of true things about the user this system knows — which
 * makes it exactly the list that could appear on a page they just filled in.
 *
 * EACH LITERAL CARRIES A LABEL, NOT JUST A VALUE, and that is a privacy
 * property rather than ergonomics. The redaction report is written to disk and
 * printed to a terminal, so a report that said `redacted 3x jane@test.example`
 * would republish the exact string the redaction exists to remove — in the one
 * place nobody thinks to check. Reports name `contact.email`; only the redactor
 * ever sees the value.
 *
 * @returns {{literals: Array<{value, label}>, digits: Array<{value, label}>}}
 *   `digits` are phone-like runs compared after stripping punctuation, because
 *   a page renders "(555) 123-4567" in a format nobody can predict.
 */
export function identifiersFromProfile({ profileDir = PROFILE_DIR } = {}) {
  const literals = new Map()
  const digits = new Map()

  const add = (v, label) => {
    const s = String(v ?? "").trim()
    // Two characters or fewer is not an identifier, it is a substring of every
    // page. Redacting "IL" would blank the word "will".
    if (s.length > 2 && !literals.has(s)) literals.set(s, label)
  }
  const addDigits = (v, label) => {
    const d = String(v ?? "").replace(/\D+/g, "")
    if (d.length >= 7 && !digits.has(d)) digits.set(d, label)
  }

  let profile = null
  try {
    profile = loadYamlFile(path.join(profileDir, "profile.yaml"))
  } catch {
    profile = null
  }
  const c = profile?.contact ?? {}
  for (const field of [
    "name",
    "email",
    "location",
    "github",
    "website",
    "linkedin",
    "phone",
  ])
    add(c[field], `contact.${field}`)
  addDigits(c.phone, "contact.phone")

  // Name parts too: a confirmation page routinely greets "Jane" alone.
  for (const part of String(c.name ?? "").split(/\s+/))
    add(part, "contact.name")

  // Answers can hold an address or a second contact route the user banked.
  let answers = null
  try {
    answers = loadYamlFile(path.join(profileDir, "answers.yaml"))
  } catch {
    answers = null
  }
  for (const a of answers?.answers ?? []) {
    const v = a?.value
    if (typeof v !== "string") continue
    if (/@/.test(v) || /\d{5}/.test(v)) add(v, "answers.value")
  }

  // LONGEST FIRST. Redacting "Jane" before "Jane Test" leaves " Test" on the
  // page — the longer match has to be taken while it still exists.
  return {
    literals: [...literals]
      .map(([value, label]) => ({ value, label }))
      .sort((a, b) => b.value.length - a.value.length),
    digits: [...digits].map(([value, label]) => ({ value, label })),
  }
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

// Patterns that catch what the fact base cannot name: the employer's own
// reference number, a tracking token in a URL, an email address belonging to
// somebody else entirely. DENY BY DEFAULT on anything that looks like an
// identifier, because the cost of over-redacting a corpus page is that a rule
// cannot cite that phrase, and the cost of under-redacting is a person's data
// in a git history.
const GENERIC = [
  // Any email address, not only the user's.
  [/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "email"],
  // UUIDs and long hex — application ids, session tokens, upload keys.
  [
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
    "uuid",
  ],
  [/\b[0-9a-f]{24,}\b/gi, "hex-token"],
  // Phone-shaped runs in any punctuation.
  [/\+?\d[\d\s().-]{8,}\d/g, "phone-like"],
  // A bare run of 6+ digits: reference numbers, and anything id-shaped.
  [/\b\d{6,}\b/g, "digit-run"],
]

/**
 * Redact a captured page.
 *
 * @returns {{html, findings: Array<{kind, count}>}}
 */
export function redactCapture(html, identifiers) {
  let out = String(html ?? "")
  const findings = []
  const count = (kind, n) => {
    if (n > 0) findings.push({ kind, count: n })
  }

  // The fact base first and LONGEST-FIRST (identifiersFromProfile sorts them),
  // so redacting "Jane" cannot destroy the longer "Jane Test" match that would
  // otherwise have been made.
  for (const { value, label } of identifiers?.literals ?? []) {
    const re = new RegExp(escapeRe(value), "gi")
    const n = (out.match(re) ?? []).length
    out = out.replace(re, REDACTED)
    // The LABEL, never the value — this record is written to disk and printed.
    count(`profile:${label}`, n)
  }

  for (const [re, kind] of GENERIC) {
    const n = (out.match(re) ?? []).length
    out = out.replace(re, REDACTED)
    count(kind, n)
  }

  // Digit runs that survive punctuation stripping — the phone written as
  // "5 5 5 . 1 2 3 . 4 5 6 7" that no single pattern above catches.
  for (const { value, label } of identifiers?.digits ?? []) {
    const spaced = value.split("").join("[^0-9A-Za-z]{0,3}")
    const re = new RegExp(spaced, "g")
    const n = (out.match(re) ?? []).length
    out = out.replace(re, REDACTED)
    count(`profile:${label}:digits`, n)
  }

  return { html: out, findings }
}

/**
 * Did anything survive?
 *
 * THE CHECK THAT MAKES THE REDACTION A GUARANTEE RATHER THAN AN INTENTION. It
 * re-reads the OUTPUT — never the input, never the findings list — because the
 * failure being guarded against is precisely a pattern that did not fire.
 *
 * @throws {Error} naming which identifier survived, without printing it.
 */
export function assertRedacted(html, identifiers) {
  const hay = String(html ?? "")
  const bare = hay.replace(/\D+/g, "")
  const survivors = []
  for (const { value, label } of identifiers?.literals ?? [])
    if (new RegExp(escapeRe(value), "i").test(hay))
      survivors.push(`${label} (${value.length} chars)`)
  for (const { value, label } of identifiers?.digits ?? [])
    if (bare.includes(value))
      survivors.push(`${label} as a ${value.length}-digit run`)

  if (survivors.length)
    throw new Error(
      `redaction did not remove ${survivors.length} identifier(s): ` +
        `${survivors.join("; ")}. NOTHING WAS STAGED. The value itself is not ` +
        `printed here — add a pattern to GENERIC in this file, or report the ` +
        `shape, and re-run.`,
    )
  return true
}

// ---------------------------------------------------------------------------
// stage / review / promote
// ---------------------------------------------------------------------------

const stamp = (buf) =>
  crypto.createHash("sha256").update(buf).digest("hex").slice(0, 12)

/**
 * Redact and stage one capture. Returns the staged record.
 *
 * `kind` is NOT taken here even when the caller thinks it knows. What a page
 * means is the user's call at promote time, after they have read it.
 */
export function stageCapture({
  url,
  html,
  board = null,
  slug = null,
  stagingDir = STAGING_DIR,
  jobsDir = JOBS_DIR,
  profileDir = PROFILE_DIR,
  at = new Date(),
} = {}) {
  if (!url || !html) throw new TypeError("stageCapture requires { url, html }")

  const identifiers = identifiersFromProfile({ profileDir })
  const { html: redacted, findings } = redactCapture(html, identifiers)
  // Throws before anything is written. A staging directory whose contents may
  // still hold the user's email is not a safer place than the page itself.
  assertRedacted(redacted, identifiers)

  const id = `${board ?? "board"}-${stamp(redacted)}`
  const dir = assertInsideJobs(stagingDir, { jobsDir })
  fs.mkdirSync(dir, { recursive: true })

  const record = {
    id,
    // The URL is kept because the classifier is a function of (url, html) and a
    // sample without its URL cannot test the half that reads the URL. Its query
    // string is dropped: that is where tracking tokens live.
    url: stripQuery(url),
    host: hostOf(url),
    board,
    slug,
    captured_at: at.toISOString(),
    bytes: Buffer.byteLength(redacted),
    redactions: findings,
    // Deliberately absent: `kind`. The user supplies it at promote time.
    promoted: false,
  }
  fs.writeFileSync(
    assertInsideJobs(path.join(dir, `${id}.html`), { jobsDir }),
    redacted,
    "utf8",
  )
  fs.writeFileSync(
    assertInsideJobs(path.join(dir, `${id}.json`), { jobsDir }),
    JSON.stringify(record, null, 2) + "\n",
    "utf8",
  )
  return record
}

function stripQuery(url) {
  try {
    const u = new URL(String(url))
    u.search = ""
    u.hash = ""
    return u.toString()
  } catch {
    return String(url)
  }
}

function hostOf(url) {
  try {
    return new URL(String(url)).hostname.toLowerCase()
  } catch {
    return null
  }
}

/** Everything staged and not yet promoted. */
export function listStaged({ stagingDir = STAGING_DIR } = {}) {
  let names = []
  try {
    names = fs.readdirSync(stagingDir).filter((n) => n.endsWith(".json"))
  } catch {
    return []
  }
  return names
    .map((n) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(stagingDir, n), "utf8"))
      } catch {
        return null
      }
    })
    .filter(Boolean)
}

/** The redacted VISIBLE TEXT of a staged capture — what the user reads before
 *  deciding. Text rather than HTML on purpose: markup is where a skim misses
 *  something, and the classifier reads the text anyway. */
export function reviewStaged(id, { stagingDir = STAGING_DIR } = {}) {
  const html = fs.readFileSync(path.join(stagingDir, `${id}.html`), "utf8")
  const meta = JSON.parse(
    fs.readFileSync(path.join(stagingDir, `${id}.json`), "utf8"),
  )
  return { meta, text: visibleText(html), html }
}

/**
 * Move a reviewed capture into the committed corpus.
 *
 * @param kind         the user's judgement of what this page is.
 * @param userApproved REQUIRED. This is the step that puts bytes captured from
 *   a real employer's page into git, and it does not happen because a script
 *   decided the redaction looked fine.
 */
export function promoteCapture({
  id,
  kind,
  userApproved = false,
  stagingDir = STAGING_DIR,
  corpusDir = CORPUS_DIR,
  manifestPath = CORPUS_MANIFEST,
} = {}) {
  if (!CLASSIFICATIONS.includes(kind) || kind === "unclassified")
    throw new TypeError(
      `promote needs --kind from: ${CLASSIFICATIONS.filter((k) => k !== "unclassified").join(", ")}` +
        `\n(a sample expected to be \`unclassified\` belongs in the ` +
        `not-a-confirmation control set, which is fixture-side)`,
    )
  if (userApproved !== true)
    throw new Error(
      "promote requires --user-approved. This copies bytes captured from a " +
        "real employer's page into the git repository; run `review` first and " +
        "read the text.",
    )

  const { meta, html } = reviewStaged(id, { stagingDir })
  const capturesDir = path.join(corpusDir, "captures")
  fs.mkdirSync(capturesDir, { recursive: true })
  fs.writeFileSync(path.join(capturesDir, `${id}.html`), html, "utf8")

  const manifest = readManifest(manifestPath)
  manifest.samples = manifest.samples.filter((s) => s.id !== id)
  manifest.samples.push({
    id,
    kind,
    file: `captures/${id}.html`,
    url: meta.url,
    hosts: meta.host ? [meta.host] : [],
    source: "capture",
    captured_at: meta.captured_at,
    board: meta.board ?? null,
    redactions: meta.redactions ?? [],
  })
  manifest.samples.sort((a, b) => a.id.localeCompare(b.id))
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true })
  fs.writeFileSync(
    manifestPath,
    JSON.stringify(manifest, null, 2) + "\n",
    "utf8",
  )

  meta.promoted = true
  fs.writeFileSync(
    path.join(stagingDir, `${id}.json`),
    JSON.stringify(meta, null, 2) + "\n",
    "utf8",
  )
  return manifest.samples.find((s) => s.id === id)
}

export function readManifest(manifestPath = CORPUS_MANIFEST) {
  try {
    const m = JSON.parse(fs.readFileSync(manifestPath, "utf8"))
    return { samples: Array.isArray(m?.samples) ? m.samples : [] }
  } catch {
    return { samples: [] }
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function flag(argv, name, fallback = null) {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--")
    ? argv[i + 1]
    : i >= 0
      ? true
      : fallback
}

async function main(argv) {
  const cmd = argv[0]
  const agent = !process.stdout.isTTY

  if (cmd === "stage") {
    const file = flag(argv, "html-file")
    const url = flag(argv, "url")
    if (!file || !url) {
      console.error(
        "usage: capture-post-submit.mjs stage --url <url> --html-file <f> [--board <k>] [--slug <s>]",
      )
      process.exit(2)
    }
    const rec = stageCapture({
      url,
      html: fs.readFileSync(file, "utf8"),
      board: flag(argv, "board"),
      slug: flag(argv, "slug"),
    })
    if (agent) console.log(JSON.stringify(rec))
    else {
      console.log(`staged ${rec.id} (${rec.bytes} bytes, redacted)`)
      for (const f of rec.redactions) console.log(`  ${f.count}x ${f.kind}`)
      console.log(
        `\nRead it before promoting:\n  node scripts/apply/capture-post-submit.mjs review ${rec.id}`,
      )
    }
    return
  }

  if (cmd === "review") {
    const id = argv[1]
    if (!id) {
      const staged = listStaged()
      if (agent) console.log(JSON.stringify(staged))
      else if (!staged.length) console.log("nothing staged")
      else
        for (const s of staged)
          console.log(
            `${s.promoted ? "promoted" : "staged   "} ${s.id}  ${s.host ?? "?"}  ${s.captured_at}`,
          )
      return
    }
    const { meta, text } = reviewStaged(id)
    console.log(`--- ${meta.id} — ${meta.url}`)
    console.log(`--- captured ${meta.captured_at}, redactions:`)
    for (const f of meta.redactions) console.log(`      ${f.count}x ${f.kind}`)
    console.log(`--- visible text follows; READ IT before promoting.\n`)
    console.log(text)
    return
  }

  if (cmd === "promote") {
    const sample = promoteCapture({
      id: argv[1],
      kind: flag(argv, "kind"),
      userApproved: flag(argv, "user-approved") === true,
    })
    console.log(
      agent
        ? JSON.stringify(sample)
        : `promoted ${sample.id} as ${sample.kind}`,
    )
    return
  }

  console.error(
    "usage: capture-post-submit.mjs <stage|review|promote>\n" +
      "  stage   --url <url> --html-file <f> [--board <k>] [--slug <s>]\n" +
      "  review  [<id>]\n" +
      "  promote <id> --kind <classification> --user-approved",
  )
  process.exit(2)
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
)
  main(process.argv.slice(2)).catch((e) => {
    console.error(e.message)
    process.exit(1)
  })
