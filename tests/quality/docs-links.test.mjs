// Gate #9: doc-path truth.
//
// The 2026-08-27 re-layout rewrote ~1,700 path references across the docs. A
// runtime or test miss fails loudly; a PROSE miss fails silently exactly once
// — an agent reads `scripts/leads/screen.mjs`, the file is not there, and it
// spends a turn discovering the doc was stale. This gate is the payoff that
// makes the sweep sustainable: from here on, doc-path drift is permanently
// loud.
//
// SCOPE: CLAUDE.md, README.md and every docs/**/*.md EXCEPT
//   docs/plans/**       historical plans, true as of their date;
//   docs/measurements.md  a dated ledger of runs, same reason;
//   docs/roster-log.md    a dated record of who was hired when.
// Those three are archives. Rewriting an archive to keep a link green is
// falsifying a record, which is worse than a dead link.
//
// FENCED CODE BLOCKS ARE INCLUDED, DELIBERATELY. A path inside a fence is the
// one an agent copies and runs, so it is the one that most needs to be true.
//
// Owned by ci-engineer; the CONTENT it checks is doc-scribe's.
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { ROOT } from "./helpers/bins.mjs"

// Markdown links whose target is a relative path.
const LINK_RE = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g
// Bare path-like tokens in prose or in a fence. The trailing (?![A-Za-z0-9])
// matters: without it `docs/scorecard.jsonl` matches as `docs/scorecard.json`
// and reports a file that is really there under a name one letter longer.
const TOKEN_RE =
  /(?<![A-Za-z0-9_./-])(?:src|scripts|tests|tools|docs|schemas|templates)\/[A-Za-z0-9_./-]+\.(?:mjs|cjs|md|json|yaml|yml|cmd|js|css)(?![A-Za-z0-9])/g

// ---------------------------------------------------------------------------
// Known-dangling, SHRINK-ONLY.
//
// First measured at 23 of 3,123 targets on 2026-08-27 and down to ONE the
// same day: the P4 documentation pass cleared 21 within the hour — including
// every reference to `audit-2026-08-05.md`, a document cited thirteen times
// that is not in the tree — and the autonomy-plan entry left when the reaper
// comments it was quoted from were corrected at the source. The shrink-only
// test below is what made each removal mandatory rather than optional: it
// goes red the moment an entry stops dangling, whether because the file
// appeared or because the reference was corrected. That is the mechanism,
// observed rather than hoped for — it fired six times in one afternoon.
//
// Routed to the documentation owner on 2026-08-27, along with two references
// that were on this list and have since been corrected in prose:
// `src/apply/ats/workable.mjs` (an adapter the docs described but nobody
// wrote) and `tests/apply/longform.test.mjs` (a test the docs named that does
// not exist — corroborated independently by src/apply/longform.mjs sitting on
// the tests-mirror exemption list for having no name-matched test).
//
// A NEW dangling path is a failure. Entries may only be deleted from this
// list, never added to. The one below is deliberate: 06-apply-scanning names
// the file a deleted gotcha index USED to live at, explicitly marked
// "deleted 2026-08-06", so a reader can find it in git history — the exact
// filename is the value, so it stays.
const KNOWN_DANGLING = [
  "docs/code/06-apply-scanning.md :: docs/reference/09-gotchas.md",
]

// QA-3 (2026-08-27): the fixed-list test catches a stale exemption, not a
// quietly added one. The pin closes the growth direction; lower it in the
// same edit that deletes an entry, never raise it.
const KNOWN_DANGLING_CEILING = 1

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

function currentDocs() {
  return [
    path.join(ROOT, "CLAUDE.md"),
    path.join(ROOT, "README.md"),
    path.join(ROOT, "scripts", "README.md"),
    path.join(ROOT, "tools", "ci", "README.md"),
    ...walk(path.join(ROOT, "src")).filter((f) => f.endsWith("README.md")),
    ...walk(path.join(ROOT, "docs")).filter((f) => f.endsWith(".md")),
  ].filter((f) => {
    const rel = path.relative(ROOT, f).replace(/\\/g, "/")
    return (
      !rel.startsWith("docs/plans/") &&
      rel !== "docs/measurements.md" &&
      rel !== "docs/roster-log.md"
    )
  })
}

/**
 * A markdown link target worth resolving, or null.
 * Skips URLs, in-page anchors, and anything holding a character that cannot
 * be in a path — `<slug>` placeholders, `*.mjs` patterns, and the
 * `[A-Za-z0-9]+` that markdown's link syntax swallows out of a documented
 * regular expression.
 */
function linkTarget(raw) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return null
  if (raw.startsWith("#")) return null
  if (/[<>*?|"[\]()+\\]/.test(raw)) return null
  return raw.split("#")[0] || null
}

function scanLinks(file, relFile, text, acc) {
  for (const m of text.matchAll(LINK_RE)) {
    const target = linkTarget(m[1])
    if (!target) continue
    acc.checked++
    const abs = path.resolve(path.dirname(file), decodeURIComponent(target))
    if (!fs.existsSync(abs)) acc.dangling.add(`${relFile} :: ${m[1]}`)
  }
}

function scanTokens(file, relFile, text, acc) {
  for (const m of text.matchAll(TOKEN_RE)) {
    acc.checked++
    if (!fs.existsSync(path.join(ROOT, m[0])))
      acc.dangling.add(`${relFile} :: ${m[0]}`)
  }
}

/** Returns { dangling: Set<"file :: target">, checked: number }. */
function scan(kind) {
  const acc = { dangling: new Set(), checked: 0 }
  const visit = kind === "link" ? scanLinks : scanTokens
  for (const f of currentDocs()) {
    visit(
      f,
      path.relative(ROOT, f).replace(/\\/g, "/"),
      fs.readFileSync(f, "utf8"),
      acc,
    )
  }
  return acc
}

const REMEDY =
  "\nFix the path in the document. Do NOT add it to KNOWN_DANGLING — that " +
  "list is frozen at its 2026-08-27 measurement and may only shrink. If the " +
  "file genuinely moved, the reference is what is wrong."

test("every relative markdown link in the current docs resolves", () => {
  const { dangling } = scan("link")
  const unknown = [...dangling]
    .filter((d) => !KNOWN_DANGLING.includes(d))
    .sort()
  assert.deepEqual(
    unknown,
    [],
    `dangling markdown links:\n  ${unknown.join("\n  ")}${REMEDY}`,
  )
})

test("every inline repo path token in the current docs resolves", () => {
  const { dangling } = scan("token")
  const unknown = [...dangling]
    .filter((d) => !KNOWN_DANGLING.includes(d))
    .sort()
  assert.deepEqual(
    unknown,
    [],
    `paths named in prose or in a fenced block that are not on disk:\n  ` +
      `${unknown.join("\n  ")}${REMEDY}`,
  )
})

test("the known-dangling list is shrink-only — every entry still dangles", () => {
  const all = new Set([...scan("link").dangling, ...scan("token").dangling])
  const fixed = KNOWN_DANGLING.filter((d) => !all.has(d)).sort()
  assert.deepEqual(
    fixed,
    [],
    `these are recorded as known-dangling but resolve now (or the reference ` +
      `was deleted):\n  ${fixed.join("\n  ")}\nRemove those lines from ` +
      `KNOWN_DANGLING. An exemption list that outlives what it exempts starts ` +
      `hiding the next real break.`,
  )
})

test("the doc-link scan is not vacuous", () => {
  const docs = currentDocs()
  assert.ok(
    docs.length >= 30,
    `only ${docs.length} documents were scanned; the filter or the walk is broken`,
  )
  const total = scan("link").checked + scan("token").checked
  assert.ok(
    total > 2000,
    `only ${total} targets were checked (expected >2000 as of 2026-08-27). ` +
      `Every assertion above passes over an empty set, so the size is checked ` +
      `too — a regex that stopped matching would otherwise read as "all ` +
      `links are fine".`,
  )
})

test("the exemption list only shrinks", () => {
  assert.ok(
    KNOWN_DANGLING.length <= KNOWN_DANGLING_CEILING,
    `KNOWN_DANGLING has ${KNOWN_DANGLING.length} entries; the ceiling is ` +
      `${KNOWN_DANGLING_CEILING}. Fix the path in the document instead of ` +
      `exempting it - this list is a debt record, not a valve.`,
  )
})
