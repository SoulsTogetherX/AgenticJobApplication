// Strict flag validation, shared.
//
// ===========================================================================
// WHY THIS EXISTS
// ===========================================================================
//
// Measured 2026-08-24, auditing every CLI entry point under scripts/: 32 of 38
// silently IGNORE an unrecognised flag, and 11 of those perform a mutating side
// effect while doing so. The incident that started the audit was
// `reverify.mjs --help`, which ignored the flag and ran a 61-job reverification
// sweep, writing a `verifications` row for every stale document. A flag passed
// to ASK A QUESTION performed a write.
//
// Two of the ignoring scripts can send real job applications on a typo, and
// they are why this module landed before the wider rollout:
//
//   * `cycle.mjs` gates the applier on `!argv.includes("--skip-apply")`. The
//     user's 7:00 Windows task passes `--skip-apply` to PREPARE ONLY. Any
//     misspelling — `--skip-aply`, `--skipapply` — fails OPEN and the cycle
//     submits applications unattended. One character.
//   * `auto-apply.mjs` reads `--enqueue` with `has()`, so `--enqeue` skips
//     enqueue-only mode and goes straight to submitting; and `--fixtur`
//     silently disarms `assertFixtureIsolation`, which only fires when
//     `--fixture` actually parsed, pointing a fixture run at the real store.
//
// A fail-open flag on a path that can act in the world is not a usability
// problem. It is the same class as a missing gate.
//
// ===========================================================================
// WHAT THIS IS NOT
// ===========================================================================
//
// This is deliberately NOT a general argument parser. It validates the SHAPE of
// argv against a declared flag set and leaves reading values to the caller's
// existing code, so it can be adopted one script at a time without rewriting
// working parsers. The full parser (value-flag maps, positional protection,
// `--` handling) is `save-answer.mjs:160-268`, which is strict already and is
// load-bearing for a user-owned hook — see the note in `assertKnownFlags`.
//
// The value-flag list matters even here: `--limit 25` must not read `25` as an
// unknown flag, and `--jobs-dir --json` must not silently make `--json` the
// directory. Both are checked.

/**
 * The positional arguments, with flag VALUES excluded.
 *
 * THE DEFECT THIS REPLACES, in six scripts at once. Each read a flag's value
 * with `args.indexOf(name) + 1` and did NOT splice it out, then took the
 * positional as `args.find((a) => !a.startsWith("--"))` — the first non-flag
 * token. So the value of the first flag became the positional:
 *
 *   ats-lint.mjs --html f.html r.md      lints f.html AS the markdown
 *   keyword-plan.mjs --jobs-dir jobs acme uses the slug "jobs"
 *   flake-rate.mjs --runs 20 t.test.mjs   runs the target "20"
 *   find-jobs.mjs mark --status dismissed <id>   looks for a lead id "dismissed"
 *
 * docs/operate/01-commands.md recorded this as a find-jobs.mjs-only defect for
 * three weeks; it is in `applications.mjs` and `manage-sources.mjs` too, both
 * of which WRITE.
 *
 * `--` ends the flags, and `--flag=value` consumes no following token.
 *
 * @param {string[]} argv
 * @param {string[]} valueFlags flags that take a following value
 * @returns {string[]} the real positionals, in order
 */
export function positionals(argv = [], valueFlags = []) {
  const takesValue = new Set(valueFlags)
  const out = []
  let flagsEnded = false
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]
    if (!flagsEnded && tok === "--") {
      flagsEnded = true
      continue
    }
    if (!flagsEnded && typeof tok === "string" && tok.startsWith("--")) {
      // `--flag=value` carries its own value; a bare `--flag` in the
      // value-taking set eats the NEXT token, which is therefore not a
      // positional.
      if (tok.indexOf("=") === -1 && takesValue.has(tok)) i++
      continue
    }
    out.push(tok)
  }
  return out
}

/**
 * A usage error, tagged so a caller can map it to exit 2 without matching on
 * the message text. `EXIT.USAGE` is 2 in preflight.mjs and save-answer.mjs
 * alike; docs/operate/01-commands.md promises that number repo-wide, and until
 * now it was unreachable for the commonest mistake there is.
 */
export function usageError(message) {
  const e = new Error(message)
  e.isUsage = true
  e.exitCode = 2
  return e
}

/** Levenshtein distance, bounded — only used to suggest a near-miss. */
function editDistance(a, b) {
  if (a === b) return 0
  if (Math.abs(a.length - b.length) > 3) return 99
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const row = [i]
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(
        prev[j] + 1,
        row[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
    }
    prev = row
  }
  return prev[b.length]
}

/**
 * The closest known flag to `name`, or null when nothing is close enough.
 *
 * The threshold is deliberately tight. `--enqeue` -> `--enqueue` (distance 1)
 * is the case worth catching; suggesting `--limit` for `--fixture` would be
 * noise that teaches people to ignore the hint.
 */
export function nearestFlag(name, known) {
  let best = null
  let bestD = 3
  for (const k of known) {
    const d = editDistance(name, k)
    if (d < bestD) {
      bestD = d
      best = k
    }
  }
  return best
}

/**
 * Refuse an argv holding a flag this script does not know.
 *
 * @param {string[]} argv
 * @param {object}   spec
 * @param {string[]} spec.known       every flag this script accepts, with `--`
 * @param {string[]} [spec.valueFlags] the subset taking a value, so the value
 *                                     is not itself checked as a flag
 * @param {string}   spec.script      shown in the message, e.g. "cycle.mjs"
 * @param {string}   [spec.note]      one line on why an ignored flag is unsafe
 *                                    HERE — the reverify incident showed that a
 *                                    generic "unknown flag" is read as pedantry
 *                                    unless it says what would have happened.
 * @throws {Error} listing the offending flag, the nearest match, and `note`.
 */
export function assertKnownFlags(
  argv = [],
  { known = [], valueFlags = [], script = "this script", note = "" } = {},
) {
  const knownSet = new Set(known)
  const valueSet = new Set(valueFlags)
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]
    if (tok === "--") break
    if (typeof tok !== "string" || !tok.startsWith("--")) continue
    // `--flag=value` is checked on the name half only.
    const eq = tok.indexOf("=")
    const name = eq === -1 ? tok : tok.slice(0, eq)
    if (!knownSet.has(name)) {
      const near = nearestFlag(name, known)
      throw usageError(
        `Unrecognised flag ${name} for ${script}.` +
          (near ? ` Did you mean ${near}?` : "") +
          `\nNothing ran. An unknown flag is NOT ignored here` +
          (note ? `: ${note}` : ".") +
          `\nKnown flags: ${known.join(" ")}`,
      )
    }
    // A value flag consumes the next token, so that token is not a flag.
    // Guard the case where the value is MISSING and the next token is itself a
    // flag — `--jobs-dir --json` would otherwise set jobsDir to "--json".
    if (eq === -1 && valueSet.has(name)) {
      const next = argv[i + 1]
      if (next === undefined || next.startsWith("--"))
        throw usageError(
          `${name} needs a value (${script}).` +
            `\nNothing ran. It was followed by ` +
            (next === undefined ? "nothing" : next) +
            `, which would have been read as the value.`,
        )
      i++
    }
  }
  return true
}
