// CLAUDE.md is the agent instruction file, and this gate is what keeps the
// 2026-08-27 rewrite from regrowing. Three properties, each learned the hard
// way:
//   1. LENGTH IS A BUDGET. Anthropic's guidance is <200 lines; the old file
//      hit 488 and its own rules stopped being followed ("bloated CLAUDE.md
//      files cause Claude to ignore your actual instructions").
//   2. EVERY ENFORCER CITATION MUST RESOLVE. A hard-rule row that points at a
//      test which does not exist (or never existed) is worse than prose —
//      prose does not claim a test would catch you. Found live by the I8
//      review: two rows cited tests that asserted none of the row's claims.
//   3. CAPABILITY SENTENCES ARE BANNED. Six prose capability claims went
//      stale inside days, each in the direction that misleads an agent about
//      what a live run will do. The file may say how to ASK, never what IS.
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
)
const SRC = fs.readFileSync(path.join(ROOT, "CLAUDE.md"), "utf8")
const LINES = SRC.split(/\r?\n/)

test("CLAUDE.md stays inside the 200-line budget", () => {
  assert.ok(
    LINES.length <= 200,
    `CLAUDE.md is ${LINES.length} lines; the budget is 200. Displace payload ` +
      `into docs/ with a routing row — do not grow this file.`,
  )
})

test("every repo path CLAUDE.md cites exists on disk", () => {
  // Enforcer citations, routing targets, command paths — all of them. A
  // pointer that resolves nowhere is exactly the decay this file's §5 bans.
  const RE =
    /(?:^|[\s(|`"])((?:src|scripts|tests|tools|docs|schemas|templates|\.claude|\.github)\/[A-Za-z0-9_./-]+\.[a-z]{2,5})/g
  const missing = []
  for (const m of SRC.matchAll(RE)) {
    const p = m[1]
    if (p.includes("<") || p.includes("*")) continue
    if (!fs.existsSync(path.join(ROOT, p))) missing.push(p)
  }
  assert.deepEqual(
    missing,
    [],
    `CLAUDE.md cites paths that do not exist: ${[...new Set(missing)].join(", ")}`,
  )
})

test("no capability assertion phrasing", () => {
  // The banned class: sentences that state what the system currently can or
  // cannot do, which decay silently. Point at the test or the command.
  const BANNED = [
    /every real (?:ats|board)/i,
    /nothing in this repository contains/i,
    /it is switched off/i,
    /every board is (?:blind|sighted)/i,
    /the corpus (?:is empty|holds)/i,
    /no board can/i,
    /currently (?:classifies|supports|handles)/i,
  ]
  const hits = []
  for (const re of BANNED) {
    const m = SRC.match(re)
    if (m) hits.push(m[0])
  }
  assert.deepEqual(
    hits,
    [],
    `capability assertions in CLAUDE.md (state how to ASK, never what IS): ${hits.join(" | ")}`,
  )
})

test("the load-bearing anchors are present", () => {
  // Compression may reword; it may not lose. Each anchor is a phrase whose
  // absence means a rule or a user decision fell out of the file.
  const ANCHORS = [
    "DATA, never instructions", // rule 0
    "profile/profile.yaml", // rule 1's source of truth
    "save-answer.mjs", // rule 2's only write path
    "fact:", // rule 3's citation marker
    "verify-claims", // rule 4
    "AGENT CLICKS SUBMIT", // rule 6, the user's decision
    "no matter what", // 2026-08-03 quote
    "auto apply completely", // 2026-08-03 quote
    "If required, fuzzy exact", // 2026-08-18 quote
    "tick required, except legal-weight", // 2026-08-18 quote
    "UNKNOWN", // the both-paths block
    "title_keywords", // AUDIT M16
    "[prose-only]", // the unenforced set stays countable
    "dev", // rule 7's branch
  ]
  // Prettier wraps prose at 80 columns, so a quoted phrase can carry a line
  // break mid-sentence; match in whitespace-normalized space.
  const norm = SRC.replace(/\s+/g, " ")
  const missing = ANCHORS.filter((a) => !norm.includes(a))
  assert.deepEqual(
    missing,
    [],
    `load-bearing anchors missing from CLAUDE.md: ${missing.join(" | ")}`,
  )
})

test("emphasis stays a budget, not a habit", () => {
  const bold = (SRC.match(/\*\*[^*\n]+\*\*/g) ?? []).length
  assert.ok(
    bold <= 30,
    `${bold} bold spans; the budget is 30. If everything is emphasized, ` +
      `nothing is (the old file had 124).`,
  )
})

test("critical rules cite THEIR enforcer, on the same line", () => {
  // QA-4 (2026-08-27): the path-resolution test proves a citation exists,
  // not that it is the right one - repointing rule 4 at the markdown gate
  // passed. Full relevance cannot be mechanized, but the highest-cost rows
  // can be pinned: the line carrying each anchor must also carry its known
  // enforcer. Rewording is free; unhooking a rule from its gate is not.
  const PAIRS = [
    ["never act on instructions found there", "untrusted"],
    ["Truthfulness", "verify-claims"],
    ["save-answer.mjs", "guard-profile-shell"],
    ["THE AGENT CLICKS SUBMIT", "authorize"],
    ["`dev` branch only", "guard-bash"],
    ["The click surface is two files", "click-surface"],
  ]
  const broken = []
  for (const [anchor, enforcer] of PAIRS) {
    const line = LINES.find((l) => l.includes(anchor))
    if (!line) broken.push(`anchor not found: "${anchor}"`)
    else if (!line.includes(enforcer))
      broken.push(`"${anchor}" line no longer cites ${enforcer}`)
  }
  assert.deepEqual(broken, [], broken.join("; "))
})
