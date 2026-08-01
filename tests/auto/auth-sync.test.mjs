// Tests for scripts/apply/auth-sync.mjs.
//
// Placed in tests/auto/ rather than tests/apply/ to follow the precedent set by
// tests/auto/automatability.test.mjs: the script lives under scripts/apply/ but
// is owned by w4-autonomy, and tests/apply/ belongs to qa-breaker. Flagged to
// the manager as a mirror-convention deviation rather than decided here.

import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"

import {
  isIgnored,
  probeLiveness,
  assertSyncDirection,
  syncProfile,
  AuthSyncError,
  SKIP_DIRS,
  RECENT_MS,
  MCP_PROFILE,
  AUTO_PROFILE,
  ROOT,
} from "../../scripts/apply/auth-sync.mjs"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SCRIPT = path.resolve(HERE, "../../scripts/apply/auth-sync.mjs")

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aj-auth-"))
  const src = path.join(root, "mcp", "profile")
  const dst = path.join(root, "auto", "profile")
  fs.mkdirSync(path.join(src, "Default", "Network"), { recursive: true })
  fs.writeFileSync(path.join(src, "Local State"), "{}")
  fs.writeFileSync(path.join(src, "Default", "LOCK"), "")
  fs.writeFileSync(
    path.join(src, "Default", "Network", "Cookies"),
    "cookie-bytes",
  )
  fs.mkdirSync(path.join(src, "Cache"), { recursive: true })
  fs.writeFileSync(path.join(src, "Cache", "big.bin"), "x".repeat(4096))
  const gitignorePath = path.join(root, ".gitignore")
  fs.writeFileSync(gitignorePath, "node_modules/\n")
  // Age every file out of the freshness window so a sandbox is idle by default.
  const old = new Date(Date.now() - 10 * RECENT_MS)
  for (const p of [
    path.join(src, "Local State"),
    path.join(src, "Default", "LOCK"),
    path.join(src, "Default", "Network", "Cookies"),
  ])
    fs.utimesSync(p, old, old)
  return {
    root,
    src,
    dst,
    gitignorePath,
    lockPath: path.join(root, "sync.lock"),
    // The sandbox IS the project root for these tests (syncProfile takes
    // projectRoot for exactly this), so the destination is `auto/profile` and
    // the gitignore entry that covers it is `auto/`.
    ignoreAll: () => fs.writeFileSync(gitignorePath, "auto/\n"),
  }
}

const sync = (s, over = {}) =>
  syncProfile({
    src: s.src,
    dst: s.dst,
    gitignorePath: s.gitignorePath,
    lockPath: s.lockPath,
    projectRoot: s.root,
    ...over,
  })

// --- isIgnored ---------------------------------------------------------------

test("isIgnored recognises the shapes a person actually writes", () => {
  for (const line of [
    ".playwright-auto/",
    ".playwright-auto",
    "/.playwright-auto/",
    ".playwright-auto/*",
  ])
    assert.equal(isIgnored(line, ".playwright-auto/profile"), true, line)
})

test("isIgnored ignores comments and blank lines", () => {
  assert.equal(
    isIgnored(
      "# .playwright-auto/\n\n   \nnode_modules/\n",
      ".playwright-auto/profile",
    ),
    false,
  )
})

test("isIgnored honours a later negation — the last matching rule wins", () => {
  assert.equal(
    isIgnored(".playwright-auto/\n!.playwright-auto/\n", ".playwright-auto"),
    false,
  )
  assert.equal(
    isIgnored("!.playwright-auto/\n.playwright-auto/\n", ".playwright-auto"),
    true,
  )
})

test("isIgnored does not match a different directory that shares a prefix", () => {
  assert.equal(
    isIgnored(".playwright-mcp/\n", ".playwright-auto/profile"),
    false,
  )
  assert.equal(
    isIgnored(".playwright-auto-old/\n", ".playwright-auto/profile"),
    false,
  )
})

test("isIgnored is false on an empty or missing gitignore", () => {
  assert.equal(isIgnored("", ".playwright-auto"), false)
  assert.equal(isIgnored(null, ".playwright-auto"), false)
})

test("the real repo already ignores .playwright-mcp, and .playwright-auto is the open question", () => {
  // Falsifiable statement of the current tree, not an assertion about what it
  // ought to be: .gitignore is ci-engineer's file.
  const gi = fs.readFileSync(path.join(ROOT, ".gitignore"), "utf8")
  assert.equal(isIgnored(gi, ".playwright-mcp"), true)
})

// --- direction guard ---------------------------------------------------------

test("assertSyncDirection refuses to write into the MCP profile", () => {
  assert.throws(
    () => assertSyncDirection(AUTO_PROFILE, MCP_PROFILE),
    AuthSyncError,
  )
  assert.throws(
    () => assertSyncDirection(AUTO_PROFILE, path.join(MCP_PROFILE, "Default")),
    AuthSyncError,
  )
  assert.throws(
    () => assertSyncDirection(AUTO_PROFILE, path.join(ROOT, ".playwright-mcp")),
    AuthSyncError,
  )
})

test("assertSyncDirection refuses the fact base, jobs/, and anywhere outside the project", () => {
  for (const bad of [
    path.join(ROOT, "profile"),
    path.join(ROOT, "profile", "answers.yaml"),
    path.join(ROOT, "jobs", "acme"),
    path.join(os.tmpdir(), "elsewhere"),
  ])
    assert.throws(
      () => assertSyncDirection(MCP_PROFILE, bad),
      AuthSyncError,
      bad,
    )
})

test("assertSyncDirection refuses a self-copy and accepts the real pair", () => {
  assert.throws(
    () => assertSyncDirection(MCP_PROFILE, MCP_PROFILE),
    AuthSyncError,
  )
  const r = assertSyncDirection(MCP_PROFILE, AUTO_PROFILE)
  assert.equal(r.dst, path.resolve(AUTO_PROFILE))
})

// --- liveness ----------------------------------------------------------------

test("a directory that does not exist is not live", () => {
  const r = probeLiveness(path.join(os.tmpdir(), "aj-no-such-profile-dir"))
  assert.equal(r.live, false)
  assert.equal(r.exists, false)
})

test("an idle sandbox profile shows no signal", () => {
  const s = sandbox()
  assert.deepEqual(probeLiveness(s.src).signals, [])
})

test("a SingletonLock means live, even left behind by a crash", () => {
  const s = sandbox()
  fs.writeFileSync(path.join(s.src, "SingletonLock"), "")
  const r = probeLiveness(s.src)
  assert.equal(r.live, true)
  assert.equal(r.signals[0].kind, "singleton")
})

test("a recently written lock file means live, and ageing it out clears the signal", () => {
  const s = sandbox()
  const p = path.join(s.src, "Default", "LOCK")
  fs.utimesSync(p, new Date(), new Date())
  const hot = probeLiveness(s.src)
  assert.equal(hot.live, true)
  assert.ok(hot.signals.some((x) => x.kind === "recent_write"))

  const old = new Date(Date.now() - 10 * RECENT_MS)
  fs.utimesSync(p, old, old)
  assert.equal(probeLiveness(s.src).live, false)
})

test("the freshness window is configurable and bounds the heuristic", () => {
  const s = sandbox()
  const p = path.join(s.src, "Default", "LOCK")
  const t = new Date(Date.now() - 5000)
  fs.utimesSync(p, t, t)
  assert.equal(probeLiveness(s.src, { recentMs: 1000 }).live, false)
  assert.equal(probeLiveness(s.src, { recentMs: 60_000 }).live, true)
})

// --- the sync ----------------------------------------------------------------

test("the sync refuses while the destination is not gitignored", async () => {
  const s = sandbox()
  await assert.rejects(sync(s), (err) => {
    assert.equal(err.code, "not_ignored")
    assert.match(err.message, /gitignore/)
    return true
  })
  assert.equal(fs.existsSync(s.dst), false, "it created the destination anyway")
})

test("the sync refuses when there is no MCP profile to copy", async () => {
  const s = sandbox()
  s.ignoreAll()
  await assert.rejects(sync(s, { src: path.join(s.root, "nope") }), (err) => {
    assert.equal(err.code, "no_source")
    return true
  })
})

test("the sync refuses while the MCP browser looks live, and copies nothing", async () => {
  const s = sandbox()
  s.ignoreAll()
  fs.writeFileSync(path.join(s.src, "SingletonLock"), "")
  await assert.rejects(sync(s), (err) => {
    assert.equal(err.code, "browser_live")
    assert.ok(err.signals.some((x) => x.where === "mcp"))
    return true
  })
  assert.equal(fs.existsSync(s.dst), false)
})

test("the sync refuses while the AUTO browser looks live", async () => {
  const s = sandbox()
  s.ignoreAll()
  fs.mkdirSync(s.dst, { recursive: true })
  fs.writeFileSync(path.join(s.dst, "SingletonLock"), "")
  await assert.rejects(sync(s), (err) => {
    assert.equal(err.code, "browser_live")
    assert.ok(err.signals.some((x) => x.where === "auto"))
    return true
  })
})

test("--check probes and copies nothing", async () => {
  const s = sandbox()
  s.ignoreAll()
  const r = await sync(s, { checkOnly: true })
  assert.equal(r.checked_only, true)
  assert.equal(fs.existsSync(s.dst), false)
})

test("a clean sync copies the session files and skips the caches", async () => {
  const s = sandbox()
  s.ignoreAll()
  const r = await sync(s)
  assert.equal(r.ok, true)
  assert.equal(r.replaced, false)
  assert.equal(
    fs.readFileSync(path.join(s.dst, "Default", "Network", "Cookies"), "utf8"),
    "cookie-bytes",
  )
  assert.equal(
    fs.existsSync(path.join(s.dst, "Cache")),
    false,
    "copied a cache directory",
  )
  assert.ok(SKIP_DIRS.has("Cache"))
  assert.equal(r.files, 3)
  assert.ok(
    r.bytes > 0 && r.bytes < 4096,
    `bytes=${r.bytes} — the cache leaked in`,
  )
})

test("a second sync replaces the previous auto profile and leaves no staging directory", async () => {
  const s = sandbox()
  s.ignoreAll()
  await sync(s)
  fs.writeFileSync(path.join(s.dst, "STALE"), "from the last sync")
  const r = await sync(s)
  assert.equal(r.replaced, true)
  assert.equal(
    fs.existsSync(path.join(s.dst, "STALE")),
    false,
    "the old profile survived the swap",
  )
  const leftovers = fs
    .readdirSync(path.dirname(s.dst))
    .filter((n) => n.includes(".staging-") || n.includes(".old-"))
  assert.deepEqual(leftovers, [])
})

test("a browser opening mid-copy discards the staged copy and keeps the previous profile", async () => {
  const s = sandbox()
  s.ignoreAll()
  await sync(s)
  fs.writeFileSync(path.join(s.dst, "KEEP"), "previous profile")

  // The pre-check is run with a clock in the past, so the freshness leg sees a
  // negative age and passes; the re-probe uses the real clock and sees the same
  // file as hot. That is precisely the "opened during the copy" case.
  const now = new Date()
  fs.utimesSync(path.join(s.src, "Default", "LOCK"), now, now)
  await assert.rejects(sync(s, { now: Date.now() - 2 * RECENT_MS }), (err) => {
    assert.equal(err.code, "browser_live_midcopy")
    return true
  })
  assert.equal(
    fs.readFileSync(path.join(s.dst, "KEEP"), "utf8"),
    "previous profile",
  )
  assert.deepEqual(
    fs.readdirSync(path.dirname(s.dst)).filter((n) => n.includes(".staging-")),
    [],
  )
})

test("the lock is released whether the sync succeeds or is refused", async () => {
  const s = sandbox()
  s.ignoreAll()
  await sync(s)
  assert.equal(fs.existsSync(s.lockPath), false)

  const now = new Date()
  fs.utimesSync(path.join(s.src, "Default", "LOCK"), now, now)
  await assert.rejects(sync(s, { now: Date.now() - 2 * RECENT_MS }))
  assert.equal(fs.existsSync(s.lockPath), false)
})

test("a symlink inside the profile is never followed out of it", async () => {
  const s = sandbox()
  s.ignoreAll()
  const outside = path.join(s.root, "outside.txt")
  fs.writeFileSync(outside, "should not travel")
  try {
    fs.symlinkSync(outside, path.join(s.src, "escape.txt"))
  } catch {
    return // Windows without developer mode cannot create symlinks; nothing to assert.
  }
  await sync(s)
  assert.equal(fs.existsSync(path.join(s.dst, "escape.txt")), false)
})

// --- CLI ---------------------------------------------------------------------

test("CLI refuses to touch the real browser profiles from a test context", () => {
  let status = 0
  let stderr = ""
  try {
    execFileSync(process.execPath, [SCRIPT], {
      encoding: "utf8",
      env: { ...process.env, NODE_TEST_CONTEXT: "children" },
    })
  } catch (err) {
    status = err.status
    stderr = err.stderr ?? ""
  }
  assert.equal(status, 2)
  assert.match(stderr, /Refusing to touch the real browser profiles/)
})

test("CLI rejects an unknown argument", () => {
  let status = 0
  try {
    execFileSync(process.execPath, [SCRIPT, "--wat"], {
      encoding: "utf8",
      env: { ...process.env, NODE_TEST_CONTEXT: "" },
    })
  } catch (err) {
    status = err.status
  }
  assert.equal(status, 2)
})

test("CLI --help states the limitation rather than hiding it", () => {
  const out = execFileSync(process.execPath, [SCRIPT, "--help"], {
    encoding: "utf8",
    env: { ...process.env, NODE_TEST_CONTEXT: "" },
  })
  assert.match(out, /mitigation, not a proof/)
})
