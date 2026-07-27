#!/usr/bin/env node
// Record what HAPPENED to a logged application — the only sanctioned way for
// the agent to update profile/applications.yaml, and only with outcomes the
// user reported in chat. Never creates entries (log-application.mjs does) and
// never deletes them.
//
// Usage:
//   node scripts/update-application.mjs <slug-or-company> --status <status>
//   node scripts/update-application.mjs <slug-or-company> --followed-up [--date YYYY-MM-DD]
//   (flags combine; --file overrides the store for tests)
import fs from "node:fs"
import { loadYamlFile, dumpYaml } from "./lib.mjs"

export const STATUSES = [
  "applied",
  "followed_up",
  "interviewing",
  "offer",
  "rejected",
  "withdrawn",
]

// Pure core (exported for tests): returns { entry } or throws.
export function applyUpdate(applications, key, { status, followedUpOn } = {}) {
  const norm = (s) =>
    String(s ?? "")
      .trim()
      .toLowerCase()
  const entry = applications.find(
    (a) => norm(a.slug) === norm(key) || norm(a.company) === norm(key),
  )
  if (!entry) throw new Error(`no logged application matches "${key}"`)

  if (followedUpOn) {
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(followedUpOn) ||
      Number.isNaN(Date.parse(followedUpOn))
    ) {
      throw new Error(
        `invalid follow-up date "${followedUpOn}" (expected YYYY-MM-DD)`,
      )
    }
    entry.follow_ups ??= []
    if (entry.follow_ups.includes(followedUpOn)) {
      throw new Error(
        `a follow-up on ${followedUpOn} is already recorded for ${entry.slug}`,
      )
    }
    entry.follow_ups.push(followedUpOn)
    // A follow-up only bumps the status forward from plain "applied".
    if (!entry.status || entry.status === "applied")
      entry.status = "followed_up"
  }

  if (status) {
    if (!STATUSES.includes(status)) {
      throw new Error(
        `unknown status "${status}" (known: ${STATUSES.join(", ")})`,
      )
    }
    entry.status = status
  }

  if (!followedUpOn && !status) {
    throw new Error("nothing to do — pass --status and/or --followed-up")
  }
  return { entry }
}

function flag(args, name) {
  const i = args.indexOf(name)
  return i !== -1 ? (args[i + 1] ?? true) : null
}

function main() {
  const args = process.argv.slice(2)
  const file = flag(args, "--file") || "profile/applications.yaml"
  const status = flag(args, "--status")
  const followedUp = args.includes("--followed-up")
  const date = flag(args, "--date") || new Date().toISOString().slice(0, 10)
  // First positional token that is neither a flag nor a value-taking flag's
  // argument. --followed-up is a boolean flag, so its neighbor stays eligible.
  const VALUE_FLAGS = new Set(["--file", "--status", "--date"])
  let key = null
  for (let i = 0; i < args.length; i++) {
    if (VALUE_FLAGS.has(args[i])) {
      i++ // skip the flag's value
    } else if (!args[i].startsWith("--")) {
      key = args[i]
      break
    }
  }

  if (!key) {
    console.error(
      "Usage: update-application.mjs <slug-or-company> [--status <s>] [--followed-up] [--date YYYY-MM-DD]",
    )
    process.exit(2)
  }
  if (!fs.existsSync(file)) {
    console.error(`${file} not found — nothing has been logged yet.`)
    process.exit(2)
  }
  const data = loadYamlFile(file) ?? {}
  if (!Array.isArray(data.applications)) {
    console.error(`${file} is malformed: "applications" is not a list`)
    process.exit(2)
  }

  try {
    const { entry } = applyUpdate(data.applications, key, {
      status: typeof status === "string" ? status : null,
      followedUpOn: followedUp ? date : null,
    })
    fs.writeFileSync(file, dumpYaml(data))
    const fu = entry.follow_ups?.length
      ? `, follow-ups: ${entry.follow_ups.join(", ")}`
      : ""
    console.log(`${entry.slug}: status=${entry.status}${fu}`)
  } catch (e) {
    console.error(e.message)
    process.exit(1)
  }
}

import { pathToFileURL } from "node:url"
import path from "node:path"
const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (isMain) main()
