// Copy the MCP browser profile to the unattended runner's own profile, and
// refuse to do it while either browser is live.
//
// ---------------------------------------------------------------------------
// WHY TWO PROFILES AT ALL
// ---------------------------------------------------------------------------
//
// Chromium takes an EXCLUSIVE lock on its `--user-data-dir`. Two processes on
// one directory corrupt it — and the thing being corrupted is the store that
// holds the user's real ATS session cookies. Losing those means every gated
// board becomes a login wall, and re-establishing them is manual work on a
// dozen sites.
//
// So the directories are split by role and the split is one-directional:
//
//   .playwright-mcp/profile   MCP-owned. The ONLY place a login ever happens.
//                             Nothing in this file writes to it, ever.
//   .playwright-auto/profile  The unattended runner's. Disposable by design:
//                             if it is wrong, delete it and re-sync.
//
// This script is the only bridge, it runs in one direction, and it is run
// explicitly — never on a schedule, because a copy that fires unattended is a
// copy that will eventually fire while a browser is open.
//
// ---------------------------------------------------------------------------
// LIVENESS IS A MITIGATION, NOT A PROOF — SAY SO PLAINLY
// ---------------------------------------------------------------------------
//
// There is no portable, sound test for "is a Chromium using this directory".
// What exists is three signals, and they cover different platforms:
//
//   1. SINGLETON ARTIFACTS (`SingletonLock` and friends). Sound on POSIX, where
//      Chromium creates them. They do not exist on Windows, which is this
//      user's platform, so on Windows this leg finds nothing and that is
//      expected rather than reassuring.
//   2. EXCLUSIVE-OPEN PROBE. Windows denies a second opener on files a running
//      Chromium holds, so `open(p, "r+")` failing with EBUSY/EPERM/EACCES is a
//      real positive there. On Linux file locking is advisory and this leg
//      never fires. Between 1 and 2 every platform has one sound signal.
//   3. RECENT MTIME. The fallback for an idle browser that is holding nothing
//      we can see. It is a heuristic — a browser open and untouched for two
//      minutes passes it — and it is the honest weak point of this control.
//
// DELIBERATELY NOT A PID PROBE. `lock.mjs` had one and it was DELETED, not
// disabled: a recorded pid is reused by the OS, and "is that pid alive" answers
// a question about a number rather than about the resource. Re-deriving it here
// under a different name would be the same mistake with a new spelling.
//
// The failure this leaves open is stated in the report and in --help: an idle
// browser can be missed. What makes that survivable is that the copy is staged
// and swapped rather than written in place, so the worst case is a stale AUTO
// profile, never a damaged MCP one. Nothing here can corrupt the directory the
// user's cookies actually live in, because nothing here opens it for writing.
//
// ---------------------------------------------------------------------------
// AND IT REFUSES IF THE DESTINATION IS NOT GITIGNORED
// ---------------------------------------------------------------------------
//
// `.playwright-mcp/` is in `.gitignore` because it holds real session cookies.
// A sync creates a SECOND directory with the same cookies in it, and at the
// time this was written `.playwright-auto/` was NOT ignored — so the first
// successful sync would have armed `git add -A` to commit the user's live
// sessions. That entry belongs to `ci-engineer`, so this script does not add
// it; it refuses to run until it is there. A guard that cannot fix the problem
// can still refuse to create it.

import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { repoRoot } from "../lib/lib.mjs"
import { acquire, lockPathFor } from "../lib/lock.mjs"

export const ROOT = repoRoot()
export const MCP_PROFILE = path.join(ROOT, ".playwright-mcp", "profile")
export const AUTO_PROFILE = path.join(ROOT, ".playwright-auto", "profile")
export const AUTH_SYNC_LOCK = lockPathFor(path.join(ROOT, ".playwright-auto"))

export const AUTH_SYNC_LIMITS =
  "liveness detection is a mitigation, not a proof: an idle browser holding no visible handle and " +
  "touching no file for the freshness window is not detected. The copy is staged and swapped, so a " +
  "miss costs a stale auto profile and never a damaged MCP one."

export class AuthSyncError extends Error {
  constructor(message, { code = "refused", signals = null } = {}) {
    super(message)
    this.name = "AuthSyncError"
    this.code = code
    if (signals) this.signals = signals
  }
}

// POSIX-only. Chromium writes these as symlinks, so lstat, not stat: a dangling
// SingletonLock left by a crash still means "something claimed this directory",
// and `existsSync` follows the link and reports false.
const SINGLETONS = ["SingletonLock", "SingletonSocket", "SingletonCookie"]

// Files a running Chromium keeps open, cheapest first. `Default/LOCK` is
// leveldb's and is present in the real profile; the rest are best-effort.
const HELD_CANDIDATES = [
  "lockfile",
  "Default/LOCK",
  "Default/Local Storage/leveldb/LOCK",
  "Default/Session Storage/LOCK",
  "Default/Network/Cookies",
  "Local State",
]

// How recently a candidate must have changed to count as "in use". Ninety
// seconds is a compromise nobody should mistake for a guarantee: Chromium
// flushes session state well inside it while a tab is being used, and not at
// all while a window sits idle.
export const RECENT_MS = 90_000

// Caches. Excluded because they are the bulk of a profile by far and carry no
// authentication — the point of the sync is cookies and local storage. A
// smaller copy is also a shorter window in which the source can go live.
export const SKIP_DIRS = new Set([
  "Cache",
  "Code Cache",
  "GPUCache",
  "GraphiteDawnCache",
  "DawnGraphiteCache",
  "DawnWebGPUCache",
  "ShaderCache",
  "GrShaderCache",
  "GPUPersistentCache",
  "component_crx_cache",
  "extensions_crx_cache",
  "BrowserMetrics",
  "Crashpad",
  "Safe Browsing",
  "CacheStorage",
  "Service Worker",
  "optimization_guide_model_store",
  "segmentation_platform",
])

/**
 * Three signals, OR-ed. Any one of them means "do not touch this directory".
 *
 * @returns { live, signals: [{ kind, detail }] } — `signals` is empty when the
 *   directory looks idle, which is NOT the same as "no browser is running".
 */
export function probeLiveness(
  dir,
  { now = Date.now(), recentMs = RECENT_MS } = {},
) {
  const signals = []
  if (!fs.existsSync(dir)) return { live: false, signals, exists: false }

  for (const name of SINGLETONS) {
    const p = path.join(dir, name)
    try {
      fs.lstatSync(p)
      signals.push({
        kind: "singleton",
        detail: `${name} exists — a Chromium claimed this directory (delete it only if you are sure nothing is running)`,
      })
    } catch {
      // Absent is the normal case on Windows; nothing to record.
    }
  }

  for (const rel of HELD_CANDIDATES) {
    const p = path.join(dir, ...rel.split("/"))
    let st
    try {
      st = fs.statSync(p)
    } catch {
      continue
    }
    if (!st.isFile()) continue

    // Signal 2: can we open it for writing? Never actually written to.
    let fd = null
    try {
      fd = fs.openSync(p, "r+")
    } catch (err) {
      if (["EBUSY", "EPERM", "EACCES"].includes(err.code))
        signals.push({
          kind: "held_open",
          detail: `${rel} is open by another process (${err.code})`,
        })
      // ENOENT/EISDIR and anything else: not evidence either way.
    } finally {
      if (fd !== null) fs.closeSync(fd)
    }

    // Signal 3: freshness.
    const age = now - st.mtimeMs
    if (age >= 0 && age < recentMs)
      signals.push({
        kind: "recent_write",
        detail: `${rel} changed ${Math.round(age / 1000)}s ago (under the ${Math.round(recentMs / 1000)}s window)`,
      })
  }

  return { live: signals.length > 0, signals, exists: true }
}

/**
 * The direction guard. Enforced here rather than left to the caller because the
 * whole design is one-directional: MCP is where the user logs in, and a script
 * that could write into it is a script that could destroy the session store it
 * exists to protect.
 *
 * `projectRoot` is injectable so a test can sandbox in a temp directory, the
 * same way guard.mjs takes `jobsDir`. The CLI never passes it: an agent or a
 * scheduled task gets the real root and nothing else, so widening the boundary
 * is not something a caller can do by accident.
 */
export function assertSyncDirection(src, dst, { projectRoot = ROOT } = {}) {
  const s = path.resolve(src)
  const d = path.resolve(dst)
  const root = path.resolve(projectRoot)
  const inside = (child, parent) => {
    const rel = path.relative(parent, child)
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))
  }
  if (s === d)
    throw new AuthSyncError("source and destination are the same directory")
  // The MCP profile is off limits as a DESTINATION whatever the root is: the
  // real .playwright-mcp/ is checked unconditionally, and a sandboxed root gets
  // the same rule applied to its own copy of the layout.
  for (const mcp of [
    path.dirname(MCP_PROFILE),
    path.join(root, ".playwright-mcp"),
  ])
    if (inside(d, mcp))
      throw new AuthSyncError(
        `refusing to write inside .playwright-mcp/ — that directory is MCP-owned and is where the user logs in (${d})`,
      )
  if (!inside(d, root))
    throw new AuthSyncError(
      `destination is outside the project directory (${d})`,
    )
  for (const forbidden of [path.join(root, "profile"), path.join(root, "jobs")])
    if (inside(d, forbidden))
      throw new AuthSyncError(
        `refusing to write inside ${path.relative(root, forbidden)}/ (${d})`,
      )
  return { src: s, dst: d }
}

/**
 * Is the destination kept out of git?
 *
 * Textual, not `git check-ignore`. Two reasons: the unattended path never
 * shells out to git (that is what keeps the branch policy moot rather than
 * bypassed), and a subprocess is a dependency this check does not need.
 *
 * The cost of being textual is stated rather than hidden: it understands a
 * literal directory entry and nothing else. A user who ignores the directory by
 * some cleverer pattern gets a false refusal, which is the safe direction.
 */
export function isIgnored(gitignoreText, relDir) {
  const want = relDir.replace(/\\/g, "/").replace(/\/+$/, "")
  const wantTop = want.split("/")[0]
  let ignored = false
  for (const raw of String(gitignoreText ?? "").split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith("#")) continue
    const negated = line.startsWith("!")
    const body = (negated ? line.slice(1) : line)
      .replace(/^\/+/, "")
      .replace(/\/+$/, "")
    const bare = body.replace(/\/\*+$/, "")
    if (bare === want || bare === wantTop) ignored = !negated
  }
  return ignored
}

async function copyTree(src, dst, { onFile = null } = {}) {
  let files = 0
  let bytes = 0
  await fsp.mkdir(dst, { recursive: true })
  const entries = await fsp.readdir(src, { withFileTypes: true })
  for (const e of entries) {
    if (e.isSymbolicLink()) continue // never follow a link out of the profile
    const from = path.join(src, e.name)
    const to = path.join(dst, e.name)
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue
      const sub = await copyTree(from, to, { onFile })
      files += sub.files
      bytes += sub.bytes
      continue
    }
    if (!e.isFile()) continue
    try {
      await fsp.copyFile(from, to)
      bytes += (await fsp.stat(to)).size
      files += 1
    } catch (err) {
      // A file that vanished or is locked mid-copy is reported, not fatal: the
      // profile is a live store and a transient miss on a journal file is not
      // worth discarding a whole sync over. A LIVE browser is caught by the
      // re-probe below, which is the check that matters.
      if (!["ENOENT", "EBUSY", "EPERM", "EACCES"].includes(err.code)) throw err
    }
    if (onFile) await onFile()
  }
  return { files, bytes }
}

/**
 * The sync. Staged into a sibling directory and swapped, so an interruption
 * leaves the previous auto profile intact rather than half-overwritten.
 *
 * Liveness is probed THREE times: both directories before the copy, and the
 * source again immediately before the swap. The last one is the one that earns
 * its keep — a browser opened during a copy that takes a minute is exactly the
 * case a single up-front check misses.
 */
export async function syncProfile({
  src = MCP_PROFILE,
  dst = AUTO_PROFILE,
  gitignorePath = path.join(ROOT, ".gitignore"),
  checkOnly = false,
  now = Date.now(),
  recentMs = RECENT_MS,
  lockPath = AUTH_SYNC_LOCK,
  lockOpts = {},
  projectRoot = ROOT,
} = {}) {
  const resolved = assertSyncDirection(src, dst, { projectRoot })

  if (!fs.existsSync(resolved.src))
    throw new AuthSyncError(
      `no MCP profile at ${resolved.src} — log in through the MCP browser once first`,
      { code: "no_source" },
    )

  const relDst = path.relative(projectRoot, resolved.dst).replace(/\\/g, "/")
  const gitignore = fs.existsSync(gitignorePath)
    ? fs.readFileSync(gitignorePath, "utf8")
    : ""
  if (!isIgnored(gitignore, relDst))
    throw new AuthSyncError(
      `${relDst} is not gitignored, and a synced profile holds the user's real session cookies.\n` +
        `Add "${relDst.split("/")[0]}/" to .gitignore first. That file is ci-engineer's, so this is a\n` +
        `request rather than something this script will do for you.`,
      { code: "not_ignored" },
    )

  const srcLive = probeLiveness(resolved.src, { now, recentMs })
  const dstLive = probeLiveness(resolved.dst, { now, recentMs })
  const signals = [
    ...srcLive.signals.map((s) => ({ ...s, where: "mcp" })),
    ...dstLive.signals.map((s) => ({ ...s, where: "auto" })),
  ]
  if (signals.length)
    throw new AuthSyncError(
      `a browser looks live — refusing to copy:\n` +
        signals.map((s) => `  ${s.where}: ${s.kind} — ${s.detail}`).join("\n"),
      { code: "browser_live", signals },
    )

  if (checkOnly)
    return {
      ok: true,
      checked_only: true,
      src: resolved.src,
      dst: resolved.dst,
      signals: [],
    }

  const handle = acquire(lockPath, {
    staleMs: 30_000,
    timeoutMs: 60_000,
    ...lockOpts,
  })
  const staging = `${resolved.dst}.staging-${process.pid}-${Date.now().toString(36)}`
  try {
    await fsp.rm(staging, { recursive: true, force: true })
    let sinceTouch = Date.now()
    const stats = await copyTree(resolved.src, staging, {
      onFile: async () => {
        // Keep the lock fresh across a copy that may run for minutes. The
        // callback is the natural heartbeat: withLock's synchronous body could
        // never fire a timer, which is why it refuses heartbeatMs outright.
        if (Date.now() - sinceTouch > 2000) {
          handle.touch()
          sinceTouch = Date.now()
        }
      },
    })

    // THE RE-PROBE. If the user opened the MCP browser while this was copying,
    // the staged copy is a torn snapshot of a live SQLite store. Discard it.
    const after = probeLiveness(resolved.src, { now: Date.now(), recentMs })
    if (after.live) {
      await fsp.rm(staging, { recursive: true, force: true })
      throw new AuthSyncError(
        `the MCP browser became live during the copy — staged copy discarded, the previous auto profile is untouched:\n` +
          after.signals.map((s) => `  ${s.kind} — ${s.detail}`).join("\n"),
        { code: "browser_live_midcopy", signals: after.signals },
      )
    }

    const retired = `${resolved.dst}.old-${Date.now().toString(36)}`
    const had = fs.existsSync(resolved.dst)
    await fsp.mkdir(path.dirname(resolved.dst), { recursive: true })
    if (had) await fsp.rename(resolved.dst, retired)
    await fsp.rename(staging, resolved.dst)
    if (had) await fsp.rm(retired, { recursive: true, force: true })

    return {
      ok: true,
      checked_only: false,
      src: resolved.src,
      dst: resolved.dst,
      replaced: had,
      ...stats,
      limits: AUTH_SYNC_LIMITS,
    }
  } finally {
    handle.release()
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const isMain = (() => {
  try {
    return (
      process.argv[1] &&
      fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
    )
  } catch {
    return false
  }
})()

const USAGE =
  "usage: auth-sync.mjs [--check] [--src <dir>] [--dst <dir>] [--json]\n" +
  "  Copies .playwright-mcp/profile -> .playwright-auto/profile, one direction only.\n" +
  "  --check probes liveness and copies nothing.\n" +
  "  Refuses while either browser looks live, and refuses if the destination is not gitignored.\n" +
  `  ${AUTH_SYNC_LIMITS}`

if (isMain) {
  const argv = process.argv.slice(2)
  let checkOnly = false
  let wantJson = false
  let src = null
  let dst = null
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const take = () => {
      const v = argv[++i]
      if (v === undefined) {
        console.error(`${a} needs a value\n\n${USAGE}`)
        process.exit(2)
      }
      return v
    }
    if (a === "--check") checkOnly = true
    else if (a === "--json") wantJson = true
    else if (a === "--src") src = take()
    else if (a === "--dst") dst = take()
    else if (a === "--help" || a === "-h") {
      console.log(USAGE)
      process.exit(0)
    } else {
      console.error(`Unknown argument: ${a}\n\n${USAGE}`)
      process.exit(2)
    }
  }

  // Same reasoning as preflight.mjs: a test that silently reaches for the real
  // browser profile passes or fails for reasons that are not in this repository
  // — and this one can WRITE, which preflight cannot.
  if (process.env.NODE_TEST_CONTEXT && (!src || !dst)) {
    console.error(
      "Refusing to touch the real browser profiles from a test: pass --src and --dst.",
    )
    process.exit(2)
  }

  try {
    const res = await syncProfile({
      ...(src ? { src } : {}),
      ...(dst ? { dst } : {}),
      checkOnly,
    })
    if (wantJson) console.log(JSON.stringify(res, null, 2))
    else if (res.checked_only)
      console.log("No liveness signal. A sync would be allowed to start.")
    else
      console.log(
        `Synced ${res.files} files (${(res.bytes / 1e6).toFixed(1)} MB) -> ${path.relative(ROOT, res.dst)}` +
          `${res.replaced ? " (previous profile replaced)" : ""}\n\n${AUTH_SYNC_LIMITS}`,
      )
    process.exit(0)
  } catch (err) {
    if (err instanceof AuthSyncError) {
      if (wantJson)
        console.log(
          JSON.stringify(
            { ok: false, code: err.code, message: err.message },
            null,
            2,
          ),
        )
      else console.error(err.message)
      process.exit(1)
    }
    throw err
  }
}
