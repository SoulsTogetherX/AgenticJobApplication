// The guardrails for the unattended path, expressed as code.
//
// WHY THEY LIVE HERE AND NOT IN A HOOK. Every other write path in this project
// is fenced by PreToolUse hooks (guard-files.mjs, guard-bash.mjs). A Windows
// scheduled task is not an agent tool call: no hook runs, nothing inspects the
// arguments, and nobody is watching. Every guarantee those hooks provide has to
// be re-established inside the process, or it simply is not there twice a day.
//
// Three controls, in the order they matter:
//
//   1. assertInsideJobs  — the filesystem boundary. The auto path writes to
//      jobs/ and nowhere else, ever.
//   2. the STOP kill switch — the user's brake, and the runner's own.
//   3. readOnlyProfile   — profile/ is read with readFileSync and hashed; the
//      auto path has no code that can write it.
//
// NOTE ON SCOPE. This module is the CHECK. The runner that calls it at each
// checkpoint is not built yet (hard rule 6: auto-submit ships disabled). Read
// nothing here as evidence that an unattended run is currently guarded — there
// is no unattended run. What is true is that the guards exist, are tested, and
// are structurally impossible for the runner to skip on the submit path, because
// scripts/auto/audit.mjs performs them before it will record anything.
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

export const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
)
export const JOBS_DIR = path.join(ROOT, "jobs")
export const AUTO_DIR = path.join(JOBS_DIR, ".auto")
export const RUNS_DIR = path.join(AUTO_DIR, "runs")
export const STOP_PATH = path.join(AUTO_DIR, "STOP")
export const INBOX_PATH = path.join(AUTO_DIR, "INBOX.md")
export const PROFILE_DIR = path.join(ROOT, "profile")

export class BoundaryError extends Error {
  constructor(message) {
    super(message)
    this.name = "BoundaryError"
    this.code = "EOUTSIDEJOBS"
  }
}

export class StopError extends Error {
  constructor(checkpoint, reason) {
    super(
      `STOP is set — halted at the "${checkpoint}" checkpoint.` +
        (reason ? `\nReason recorded: ${reason}` : "") +
        `\nDelete ${STOP_PATH} to allow the next run.`,
    )
    this.name = "StopError"
    this.code = "ESTOP"
    this.checkpoint = checkpoint
    this.reason = reason ?? null
  }
}

// The three points hard rule 6's blast-radius design requires the switch to be
// read at. A closed set, because "checked at start" and "checked before each
// submit" are different guarantees and a call site that names neither is a call
// site nobody can audit.
export const CHECKPOINTS = Object.freeze({
  RUN_START: "run-start",
  BETWEEN_JOBS: "between-jobs",
  PRE_SUBMIT: "pre-submit",
})
const CHECKPOINT_VALUES = new Set(Object.values(CHECKPOINTS))

// Resolve the deepest ANCESTOR of `p` that actually exists, so a path that does
// not exist yet (the normal case — we are about to create it) can still be
// checked for symlink escapes.
function realpathOfNearestAncestor(p) {
  let cur = path.resolve(p)
  for (;;) {
    try {
      return { real: fs.realpathSync(cur), at: cur }
    } catch {
      const parent = path.dirname(cur)
      if (parent === cur) return { real: cur, at: cur } // reached the root
      cur = parent
    }
  }
}

const withSep = (p) => (p.endsWith(path.sep) ? p : p + path.sep)

/**
 * Every write the auto path makes goes through here first.
 *
 * Two checks, because the lexical one alone is not enough: `path.resolve`
 * flattens `..` so a traversal is caught, but a SYMLINK inside jobs/ pointing
 * at somewhere else resolves lexically clean and writes outside anyway. So the
 * deepest existing ancestor is realpath'd and compared against the realpath of
 * jobs/ itself.
 *
 * @returns the resolved absolute path, so callers can write `fs.writeFileSync(assertInsideJobs(p), ...)`
 * @throws {BoundaryError}
 */
export function assertInsideJobs(target, { jobsDir = JOBS_DIR } = {}) {
  const resolved = path.resolve(String(target ?? ""))
  const base = path.resolve(jobsDir)

  if (resolved !== base && !resolved.startsWith(withSep(base))) {
    throw new BoundaryError(
      `refusing to write outside jobs/: ${resolved}\n(the unattended path may only write inside ${base})`,
    )
  }

  // Symlink escape. realpath the base too — on Windows the project may sit
  // under a junction, in which case an honest path realpaths to a different
  // prefix and a naive comparison would reject everything.
  let realBase
  try {
    realBase = fs.realpathSync(base)
  } catch {
    realBase = base // jobs/ does not exist yet; the lexical check above stands
  }
  const { real, at } = realpathOfNearestAncestor(resolved)
  if (real !== realBase && !real.startsWith(withSep(realBase))) {
    throw new BoundaryError(
      `refusing to write outside jobs/: ${resolved}\n` +
        `(${at} resolves to ${real}, which is outside ${realBase} — a link is pointing out of the tree)`,
    )
  }
  return resolved
}

// profile/ is READ-ONLY to this path, and the way that is enforced is that
// there is no function here that writes it. This one exists so an accidental
// write attempt is loud rather than silent.
export function assertNotProfile(target) {
  const resolved = path.resolve(String(target ?? ""))
  const base = path.resolve(PROFILE_DIR)
  if (resolved === base || resolved.startsWith(withSep(base))) {
    throw new BoundaryError(
      `refusing to write to the fact base: ${resolved}\n(hard rule 2 — profile/ changes go through save-answer.mjs after asking the user)`,
    )
  }
  return resolved
}

// --- the kill switch ---------------------------------------------------------

/**
 * Is the switch set?
 *
 * Deliberately EXISTENCE-based, not content-based: `type nul > jobs\.auto\STOP`
 * creates a zero-byte file, and that has to work. There is no YAML to get
 * wrong, no key to misspell, and no editor needed at 2am. An empty STOP stops
 * just as hard as an annotated one.
 */
export function stopActive({ stopPath = STOP_PATH } = {}) {
  return fs.existsSync(stopPath)
}

/** Whatever reason was recorded, or null. An empty file is a valid STOP. */
export function readStop({ stopPath = STOP_PATH } = {}) {
  try {
    const text = fs.readFileSync(stopPath, "utf8").trim()
    return text || null
  } catch {
    return null
  }
}

/**
 * Check the switch at a named checkpoint.
 *
 * @throws {StopError} when STOP exists.
 * @throws {TypeError} when the checkpoint is not one of CHECKPOINTS — an
 *   unnamed checkpoint cannot be audited, and "we check it somewhere" is the
 *   claim this is meant to make falsifiable.
 */
export function assertNotStopped(checkpoint, { stopPath = STOP_PATH } = {}) {
  if (!CHECKPOINT_VALUES.has(checkpoint)) {
    throw new TypeError(
      `unknown kill-switch checkpoint "${checkpoint}" (expected one of: ${[...CHECKPOINT_VALUES].join(", ")})`,
    )
  }
  if (stopActive({ stopPath })) {
    throw new StopError(checkpoint, readStop({ stopPath }))
  }
  return true
}

/**
 * The runner disabling itself. Called on anomaly: two job failures, a
 * post-submit page that is not a confirmation, or a submitReadiness failure
 * after a green classification.
 *
 * FIRST REASON WINS. An existing STOP is never overwritten, because the first
 * anomaly is the one that explains the run and a later, blander one would bury
 * it. Returns false when a STOP was already in place.
 *
 * THERE IS DELIBERATELY NO clearStop(). Self-disabling is the real rollback —
 * an application cannot be unsent — so re-enabling is the user's act, by
 * deleting the file. Code that could clear its own brake does not have one.
 */
export function raiseStop(
  reason,
  { stopPath = STOP_PATH, jobsDir = JOBS_DIR, meta = null } = {},
) {
  // `jobsDir` is a TESTABILITY seam and nothing else. Production callers pass
  // neither argument and get the real boundary. It is honest to say what that
  // costs: a caller that supplies both stopPath and jobsDir can point this
  // anywhere, so the boundary constrains ACCIDENTS, not a caller that has
  // decided to leave the tree. The controls against that are ownership and
  // review, not this function.
  const target = assertInsideJobs(stopPath, { jobsDir })
  fs.mkdirSync(path.dirname(target), { recursive: true })
  if (fs.existsSync(target)) return false
  const body =
    `STOPPED ${new Date().toISOString()}\n` +
    `${String(reason ?? "unspecified anomaly")}\n` +
    (meta ? `${JSON.stringify(meta, null, 2)}\n` : "") +
    `\nThe unattended runner set this itself and will not run again until this file is deleted.\n`
  fs.writeFileSync(target, body, "utf8")
  return true
}
