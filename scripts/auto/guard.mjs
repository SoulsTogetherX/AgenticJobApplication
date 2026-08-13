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
// NOTE ON SCOPE, AND A SENTENCE THAT USED TO BE FALSE HERE.
//
// This module is the CHECK. As of Phase 5 W1 the runner that calls it DOES
// exist — job.mjs demands the token and submit.mjs contains the one click — so
// the sentence that used to sit here ("the runner is not built yet") is gone
// rather than left to rot. What is still true, and it is the operative fact:
// `auto_apply.enabled` is false in the user's file and there is no
// `board_allowlist` in it, so the trust gate refuses every board and the click
// is unreachable. Read nothing here as evidence that an unattended run is
// currently happening — there is none.
//
// This paragraph previously claimed the guards were "structurally impossible
// for the runner to skip on the submit path, because scripts/auto/audit.mjs
// performs them before it will record anything". That was written in the
// indicative about something that had not been built, which is the exact
// failure autonomy-plan §3.4 records twice: a control stated as fact gets
// believed in instead of implemented. It was also wrong on its own terms —
// RECORDING HAPPENS AFTER SUBMITTING. A check on the path to the record runs
// after the click, and an application cannot be unsent. audit.mjs's
// intent/record pairing is a DETECTOR: it stops the next application, not this
// one.
//
// What is actually true now:
//
//   * These functions are checks. They enforce nothing by existing.
//   * scripts/auto/authorize.mjs is the only place that reads every
//     precondition together — auto_apply.enabled, the run mode, this file's
//     STOP switch, the caps, submitReadiness plus its own zero-defer
//     assertion, the stored L3 verdict, and the board trust verdict — and it
//     is the only place that can mint the frozen single-use token that a
//     clicking function will have to spend. A caller cannot manufacture one.
//   * CHECKPOINTS.PRE_SUBMIT is read TWICE, by two different callers, and the
//     second one is the one this comment used to get wrong. authorizeSubmit()
//     reads it before minting a token, so the common case (brake already on)
//     never writes an intent row. consumeSubmitToken() reads it again as the
//     first statement of the click, where "immediately before the click" is
//     literally true — the gate's read is separated from the click by an
//     openDb/INSERT/close in beginSubmit(), so it does not qualify.
//   * That is prevention only for a caller that demands the token, and since
//     W1 there is one: submit.mjs spends the token as the statement before its
//     click, and job.mjs cannot reach that click by any other route.
//   * The STOP read has a SCOPE since W2 (§4.9). A caller that names a board or
//     a company is stopped by a brake filed against it; a caller that names
//     neither still gets the global answer and only that, so nothing written
//     before scopes existed changed meaning. See "the scope of a STOP" below —
//     in particular the part about why a board-scoped STOP is NOT the breaker's
//     board pause.
//
// So: the token makes the guards unskippable BY CONSTRUCTION for the code that
// clicks. What keeps that from being merely a design commitment is
// tests/auto/click-surface.test.mjs — `.click(` appears under scripts/auto/
// only in submit.mjs — not this comment.
//
// The three sentences that runner must satisfy are written in authorize.mjs's
// header under "THE RUNNER'S CONTRACT". They are load-bearing for every
// property in this directory; read them before writing the runner, not after.
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { toast } from "./notify.mjs"

export const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
)
export const JOBS_DIR = path.join(ROOT, "jobs")
export const AUTO_DIR = path.join(JOBS_DIR, ".auto")
export const RUNS_DIR = path.join(AUTO_DIR, "runs")
export const STOP_PATH = path.join(AUTO_DIR, "STOP")
export const STOPS_DIR = path.join(AUTO_DIR, "stops")
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
  constructor(
    checkpoint,
    reason,
    { scope = "global", key = null, at = null } = {},
  ) {
    super(
      (scope === "global"
        ? `STOP is set — halted at the "${checkpoint}" checkpoint.`
        : `A ${scope}-scoped STOP is set for "${key}" — halted at the ` +
          `"${checkpoint}" checkpoint. Only this ${scope} is held back; ` +
          `everything else keeps running.`) +
        (reason ? `\nReason recorded: ${reason}` : "") +
        `\nDelete ${at ?? STOP_PATH} to allow the next run.`,
    )
    this.name = "StopError"
    this.code = "ESTOP"
    this.checkpoint = checkpoint
    this.reason = reason ?? null
    this.scope = scope
    this.key = key
    this.at = at ?? (scope === "global" ? STOP_PATH : null)
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

// --- the scope of a STOP (§4.9) ----------------------------------------------
//
// THE PROBLEM THIS SOLVES, stated as the plan states it: every hard-STOP input
// used to halt EVERY future invocation until a human deleted one file. Right at
// N=3 and wrong at N=999, for one reason — the blast radius of the halt scaled
// with the run and the trigger did not. One undecidable orphan on one employer
// took down a night that would otherwise have sent 900 applications.
//
// So a STOP now says WHAT IT HAS EVIDENCE ABOUT. Four scopes, and the ordering
// matters because it is the ordering of how much the trigger actually proves:
//
//   company — this employer's state is unknown. §4.9's orphan case: an attempt
//             nobody can resolve means THIS company may already hold an
//             application. It proves nothing about any other company.
//   board   — this ATS behaved in a way nothing understood. Proves nothing
//             about the other boards in the run.
//   run     — this run's own bookkeeping is broken (its ledger, its profile
//             snapshot). The next invocation starts clean and may proceed.
//   global  — a broken invariant. RESERVED FOR THE FOUR §4.6 BREACHES and
//             nothing else, because global is the one that costs a night.
//
// A SCOPED STOP IS NOT A BOARD PAUSE, and conflating the two would undo §4.6.
// The pause (`board_pauses` in db.mjs) is a TIMED backoff with probe
// re-admission, cleared by one success, never persisted across invocations
// without re-probing — it is the breaker absorbing a wifi drop. A board-scoped
// STOP is a BRAKE: durable, and cleared only by a human deleting the file,
// exactly like the global one. The breaker must never reach for this.
//
// THERE IS STILL NO clearStop(), AT ANY SCOPE. Self-disabling is the real
// rollback, an application cannot be unsent, and code that can clear its own
// brake does not have one.
export const STOP_SCOPES = Object.freeze(["global", "run", "board", "company"])
const SCOPE_VALUES = new Set(STOP_SCOPES)

/**
 * A scope key as a filename.
 *
 * The key is DATA — a company name off a lead, a board key, a run id — so it is
 * reduced to a closed character class rather than escaped. `..` and every path
 * separator are outside that class, so a traversal cannot survive the mapping;
 * `assertInsideJobs` on the joined path is the second net, not the first.
 *
 * The mapping is deliberately MANY-TO-ONE — "Acme, Inc." and "Acme Inc" land on
 * the same key. For a brake that is the safe direction: a collision can only
 * ever over-block, never under-block, and the file body carries the original
 * string so a human reading it knows which company they are looking at.
 */
export function stopKey(raw) {
  const key = String(raw ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 80)
  if (!key)
    throw new TypeError(
      `a scoped STOP needs a non-empty key, and ${JSON.stringify(raw)} ` +
        `normalises to nothing — an unkeyed scope would silently become global`,
    )
  return key
}

/** Where a scoped brake lives. `stopsDir` defaults NEXT TO `stopPath` so a test
 *  (or a fixture run) that redirects the global switch redirects the scoped ones
 *  with it — a seam that moved only half of them would let a test pass while
 *  reading the real tree. */
export function scopedStopPath(
  scope,
  key,
  { stopPath = STOP_PATH, stopsDir = null } = {},
) {
  if (!SCOPE_VALUES.has(scope))
    throw new TypeError(
      `unknown STOP scope "${scope}" (expected one of: ${STOP_SCOPES.join(", ")})`,
    )
  if (scope === "global") return stopPath
  const dir = stopsDir ?? path.join(path.dirname(stopPath), "stops")
  return path.join(dir, scope, stopKey(key))
}

/**
 * Every brake that applies to this job, in order of blast radius.
 *
 * Callers pass only the scopes they can name. A caller that knows nothing but
 * the checkpoint gets the global answer and only that — which is exactly the
 * pre-scope behaviour, so no existing call site changed meaning.
 */
export function activeStops({
  board = null,
  company = null,
  runId = null,
  stopPath = STOP_PATH,
  stopsDir = null,
} = {}) {
  const out = []
  const at = (scope, key) => scopedStopPath(scope, key, { stopPath, stopsDir })
  if (fs.existsSync(stopPath))
    out.push({
      scope: "global",
      key: null,
      at: stopPath,
      reason: readStop({ stopPath }),
    })
  for (const [scope, raw] of [
    ["run", runId],
    ["board", board],
    ["company", company],
  ]) {
    if (raw == null || String(raw).trim() === "") continue
    let p
    try {
      p = at(scope, raw)
    } catch {
      continue // an unkeyable value cannot have a brake filed under it
    }
    if (fs.existsSync(p))
      out.push({
        scope,
        key: stopKey(raw),
        at: p,
        reason: readStop({ stopPath: p }),
      })
  }
  return out
}

/**
 * Check the switch at a named checkpoint.
 *
 * @param board   this job's board_key, when the caller knows it.
 * @param company this job's company, when the caller knows it.
 * @param runId   this run's id, when the caller knows it.
 * @throws {StopError} when STOP exists at global scope, or at any scope the
 *   caller named. The GLOBAL one is reported first when several are set — it is
 *   the one that explains the most.
 * @throws {TypeError} when the checkpoint is not one of CHECKPOINTS — an
 *   unnamed checkpoint cannot be audited, and "we check it somewhere" is the
 *   claim this is meant to make falsifiable.
 */
export function assertNotStopped(
  checkpoint,
  {
    stopPath = STOP_PATH,
    stopsDir = null,
    board = null,
    company = null,
    runId = null,
  } = {},
) {
  if (!CHECKPOINT_VALUES.has(checkpoint)) {
    throw new TypeError(
      `unknown kill-switch checkpoint "${checkpoint}" (expected one of: ${[...CHECKPOINT_VALUES].join(", ")})`,
    )
  }
  const [first] = activeStops({ board, company, runId, stopPath, stopsDir })
  if (first) {
    throw new StopError(checkpoint, first.reason, {
      scope: first.scope,
      key: first.key,
      at: first.at,
    })
  }
  return true
}

// --- the alert channel -------------------------------------------------------
//
// THE BRAKE AND THE NOTIFICATION ARE DIFFERENT THINGS, and conflating them is
// the defect this fixes. raiseStop's first-reason-wins rule is exactly right
// for the brake: the first anomaly is the one that explains the run, and a
// later blander one must not overwrite it. Applied to NOTIFICATION the same
// rule is dangerous — a benign STOP at job 3 would swallow a credential
// exposure at job 400, and the user would read the benign one and delete the
// file.
//
// So INBOX.md is APPEND-ONLY and takes everything: every STOP, whether or not
// a brake was already set, and every security-class finding, which never sets a
// brake at all. It is a log a human reads top to bottom, not a state file, and
// nothing in this repository ever truncates or rewrites it.

const INBOX_HEADER =
  "# Auto-path inbox\n\n" +
  "Append-only. Every STOP and every security-class finding lands here, newest\n" +
  "at the bottom. Deleting entries is safe — nothing reads this file — but the\n" +
  "brake is `STOP`, not this, and clearing one does not clear the other.\n"

/**
 * Append one alert. Never throws: an alert channel that can break the caller is
 * worse than no alert channel, because the caller is usually mid-anomaly.
 *
 * @returns true when the entry was written.
 */
export function appendInbox(
  { kind, summary, detail = null, meta = null, at = new Date() } = {},
  { inboxPath = INBOX_PATH, jobsDir = JOBS_DIR } = {},
) {
  try {
    const target = assertInsideJobs(inboxPath, { jobsDir })
    fs.mkdirSync(path.dirname(target), { recursive: true })
    const fresh = !fs.existsSync(target)
    const stamp = (at instanceof Date ? at : new Date()).toISOString()
    const body =
      (fresh ? INBOX_HEADER : "") +
      `\n## ${stamp} — ${String(kind ?? "alert").toUpperCase()}\n\n` +
      `${String(summary ?? "(no summary)")}\n` +
      (detail ? `\n${detail}\n` : "") +
      (meta ? `\n\`\`\`json\n${JSON.stringify(meta, null, 2)}\n\`\`\`\n` : "")
    fs.appendFileSync(target, body, "utf8")
    return true
  } catch {
    // Deliberately silent. The record that matters is already in the run JSONL
    // and the auto_runs row; this is the copy a human happens to read.
    return false
  }
}

/**
 * A security-class finding: instruction-shaped text, a label that addressed the
 * agent, a hostile consent box. These do NOT stop the run — rule 0 says a
 * posting is data, and the machinery for handling hostile data is deferral and
 * sanitisation, not halting — but the user must be able to find out that a
 * board tried something, without reading a JSONL.
 */
export function raiseSecurityAlert(
  finding,
  { inboxPath = INBOX_PATH, jobsDir = JOBS_DIR, at = new Date() } = {},
) {
  return appendInbox(
    {
      kind: "security",
      at,
      summary:
        finding?.summary ??
        `${finding?.findings?.length ?? 0} instruction-shaped finding(s) on ${finding?.slug ?? "an unnamed job"}`,
      detail:
        "Kinds and counts only — the payload itself is never copied here. " +
        "Nothing was acted on; this is a report.",
      meta: finding ?? null,
    },
    { inboxPath, jobsDir },
  )
}

/**
 * The runner disabling itself. Called on anomaly: two job failures, a
 * post-submit page that is not a confirmation, or a submitReadiness failure
 * after a green classification.
 *
 * FIRST REASON WINS FOR THE BRAKE, PER KEY. An existing STOP at the same scope
 * and key is never overwritten, because the first anomaly is the one that
 * explains the run and a later, blander one would bury it. Returns false when a
 * brake was already in place there. A company-scoped stop on `acme` says
 * nothing about `globex`, so it does not suppress it.
 *
 * THE INBOX ENTRY AND THE TOAST ARE UNCONDITIONAL, and that asymmetry is the
 * point — see the alert-channel note above. A second STOP changes nothing about
 * the brake and is still news.
 *
 * @param scope one of STOP_SCOPES. **`global` is the default and it is the
 *   wrong answer for almost every caller** — it is reserved for the four §4.6
 *   invariant breaches. It stays the default only so that a caller written
 *   before scopes existed cannot silently become narrower than it was.
 * @param key   required for every non-global scope, and a missing one THROWS.
 *   That is the load-bearing half of this change: a caller that meant "pause
 *   this board" and passed no key must fail loudly, never quietly widen to a
 *   brake on everything.
 *
 * THERE IS DELIBERATELY NO clearStop(), AT ANY SCOPE. Self-disabling is the
 * real rollback — an application cannot be unsent — so re-enabling is the
 * user's act, by deleting the file. Code that could clear its own brake does
 * not have one.
 */
export function raiseStop(
  reason,
  {
    scope = "global",
    key = null,
    stopPath = STOP_PATH,
    stopsDir = null,
    jobsDir = JOBS_DIR,
    meta = null,
    inboxPath = INBOX_PATH,
    notify = toast,
  } = {},
) {
  if (!SCOPE_VALUES.has(scope))
    throw new TypeError(
      `unknown STOP scope "${scope}" (expected one of: ${STOP_SCOPES.join(", ")})`,
    )
  if (scope === "global" && key != null)
    throw new TypeError(
      `a global STOP takes no key, but "${key}" was passed — a caller that ` +
        `named a key meant to scope this, and silently ignoring it would halt ` +
        `every board instead of one`,
    )
  // Throws on a missing or unkeyable value; see stopKey.
  const scopedPath = scopedStopPath(scope, key, { stopPath, stopsDir })

  // `jobsDir` is a TESTABILITY seam and nothing else. Production callers pass
  // neither argument and get the real boundary. It is honest to say what that
  // costs: a caller that supplies both stopPath and jobsDir can point this
  // anywhere, so the boundary constrains ACCIDENTS, not a caller that has
  // decided to leave the tree. The controls against that are ownership and
  // review, not this function.
  const target = assertInsideJobs(scopedPath, { jobsDir })
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const already = fs.existsSync(target)
  const text = String(reason ?? "unspecified anomaly")
  const what =
    scope === "global"
      ? "every future run"
      : `every ${scope} "${stopKey(key)}" job`

  // Notify FIRST, and notify whether or not the brake was already on. The
  // second STOP of a run is the one most likely to be the serious one, and it
  // is the one the brake file will never mention.
  appendInbox(
    {
      kind: "stop",
      summary: `[${scope}${scope === "global" ? "" : `:${stopKey(key)}`}] ${text}`,
      detail: already
        ? `A ${scope} STOP was ALREADY set here when this fired — the brake ` +
          `file names the earlier reason, not this one. Both are real.`
        : `The runner disabled ${what}. It will not resume until ` +
          `${target} is deleted.`,
      meta:
        meta == null
          ? { scope, key: key ?? null }
          : { scope, key: key ?? null, ...meta },
    },
    { inboxPath, jobsDir },
  )
  try {
    notify(
      scope === "global"
        ? "Job runner stopped"
        : `Job runner stopped: ${scope} ${stopKey(key)}`,
      text.slice(0, 200),
    )
  } catch {
    /* a cosmetic notification must never be able to break the brake */
  }

  if (already) return false
  const body =
    `STOPPED ${new Date().toISOString()}\n` +
    `scope: ${scope}${scope === "global" ? "" : `\nkey: ${key} (filed as ${stopKey(key)})`}\n` +
    `${text}\n` +
    (meta ? `${JSON.stringify(meta, null, 2)}\n` : "") +
    `\nThe unattended runner set this itself. ${
      scope === "global"
        ? "It will not run again"
        : `Jobs on this ${scope} will not run`
    } until this file is deleted.\n`
  fs.writeFileSync(target, body, "utf8")
  return true
}
