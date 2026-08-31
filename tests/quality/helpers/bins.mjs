// Shared plumbing for the tests/quality gates.
//
// WHY EVERY GATE SPAWNS `process.execPath` AND A PLAIN-JS BIN, NEVER `npx`
// AND NEVER A `.cmd`:
//
//   * `npx` resolves through the network/cache and can install something. A
//     gate whose behaviour depends on a registry lookup is not deterministic.
//   * On Windows, `child_process.spawn` of a `.cmd`/`.bat` without a shell
//     fails with EINVAL since the CVE-2024-27980 fix, and spawning one WITH a
//     shell reintroduces the argument-injection that fix closed. Both halves
//     are wrong, so neither is used: the `.js`/`.mjs` entry point of each tool
//     is handed to node directly.
//
// This file is NOT a *.test.mjs, so the test gate does not discover it as a
// suite — it is only imported.
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

export const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
)

/** Plain-JS entry points. Never the `.cmd` shims in node_modules/.bin. */
export const BIN = {
  eslint: path.join(ROOT, "node_modules", "eslint", "bin", "eslint.js"),
  prettier: path.join(ROOT, "node_modules", "prettier", "bin", "prettier.cjs"),
  markdownlint: path.join(
    ROOT,
    "node_modules",
    "markdownlint-cli2",
    "markdownlint-cli2-bin.mjs",
  ),
}

/**
 * Run a tool from BIN under node, from the repo root.
 * Returns { status, stdout, stderr } — never throws on a nonzero exit, because
 * several of these gates assert that a nonzero exit HAPPENS.
 */
export function runBin(bin, args, opts = {}) {
  const res = spawnSync(process.execPath, [bin, ...args], {
    cwd: opts.cwd ?? ROOT,
    encoding: "utf8",
    // These tools print more than the default 1MB when a repo is unhappy, and
    // a truncated buffer would turn a real failure into an unreadable one.
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, ...(opts.env ?? {}) },
  })
  return {
    status: res.status,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
    error: res.error,
  }
}

/**
 * Every file git would take: tracked, PLUS untracked ones that no ignore rule
 * covers. POSIX separators.
 *
 * `--others --exclude-standard` is the load-bearing half. Tracked-only would
 * answer "what did the last commit contain", and the structure gates need to
 * answer "what is about to be committed" — a stray helper dropped beside a
 * sealed shim, or a scratch file at the repo root, must fail BEFORE it is
 * committed, not one commit later. It is also what keeps the gate honest for
 * an agent that has written a file and not yet handed it to the manager.
 *
 * Ignored trees stay invisible by construction, which is what keeps personal
 * data out of this: profile/, jobs/, logs/, .env and .playwright-mcp/ are all
 * covered by .gitignore, so --exclude-standard drops them.
 */
export function trackedFiles(...paths) {
  const res = spawnSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard", ...paths],
    { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  )
  if (res.status !== 0) return null
  return [...new Set(res.stdout.split("\0").filter(Boolean))]
}

/** True when `git` is on PATH — the gates skip WITH A REASON when it is not. */
export function gitAvailable() {
  return spawnSync("git", ["--version"], { cwd: ROOT }).status === 0
}
