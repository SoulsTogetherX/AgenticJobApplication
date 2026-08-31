#!/usr/bin/env node
// List applications that are due a follow-up (deterministic, no LLM calls).
// Reads profile/applications.yaml; never writes anything — recording a sent
// follow-up or an outcome goes through src/applications/update-application.mjs.
//
// Policy: a follow-up is due N days (default 10) after the application (or
// after the previous follow-up). At most 2 follow-ups per application — after
// that the lead is considered gone cold and stops appearing. Applications
// whose status shows a response (interviewing/offer/rejected/withdrawn) never
// appear.
//
// Usage: node src/applications/follow-ups.mjs [--days N] [--json] [--file <path>]
import fs from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { loadYamlFile, isTerse } from "#lib/lib.mjs"
import { readApplications } from "#lib/db.mjs"

export const MAX_FOLLOW_UPS = 2
const OPEN_STATUSES = new Set(["applied", "followed_up", undefined, null, ""])

// Pure core (exported for tests).
export function dueFollowUps(applications, now = new Date(), days = 10) {
  const out = []
  for (const a of applications ?? []) {
    if (!OPEN_STATUSES.has(a.status ?? "")) continue
    const followUps = Array.isArray(a.follow_ups)
      ? [...a.follow_ups].sort()
      : []
    if (followUps.length >= MAX_FOLLOW_UPS) continue

    const anchor = followUps.at(-1) ?? a.applied_at
    const anchorDate = new Date(anchor)
    if (!anchor || Number.isNaN(anchorDate.getTime())) continue // unparseable → skip, don't guess
    const daysSince = Math.floor(
      (now.getTime() - anchorDate.getTime()) / 86400000,
    )
    if (daysSince < days) continue

    out.push({
      slug: a.slug,
      company: a.company,
      title: a.title,
      applied_at: a.applied_at,
      follow_ups_sent: followUps.length,
      days_since_last_touch: daysSince,
      next_step:
        followUps.length === 0 ? "first follow-up" : "second (final) follow-up",
    })
  }
  return out.sort((x, y) => y.days_since_last_touch - x.days_since_last_touch)
}

function flag(args, name) {
  const i = args.indexOf(name)
  return i !== -1 ? (args[i + 1] ?? true) : null
}

function main() {
  const args = process.argv.slice(2)
  const file = flag(args, "--file") || "profile/applications.yaml"
  const days = Number(flag(args, "--days") || 10)
  if (!Number.isFinite(days) || days < 1) {
    console.error(`invalid --days "${flag(args, "--days")}"`)
    process.exit(2)
  }
  const applications = readApplications(
    file === "profile/applications.yaml" ? null : file,
  )
  const due = dueFollowUps(applications, new Date(), days)

  if (args.includes("--json")) {
    console.log(JSON.stringify({ days_threshold: days, due }, null, 2))
    return
  }
  if (isTerse()) {
    for (const d of due) {
      console.log(
        `${d.slug}|${d.company}|${d.title}|days=${d.days_since_last_touch}|sent=${d.follow_ups_sent}`,
      )
    }
    console.log(`due=${due.length} threshold=${days}`)
    return
  }
  for (const d of due) {
    console.log(
      `${d.company} — ${d.title} (${d.slug})\n  applied ${d.applied_at}, ${d.days_since_last_touch} days since last touch, ${d.follow_ups_sent} follow-up(s) sent → ${d.next_step}`,
    )
  }
  console.log(
    due.length
      ? `\n${due.length} application(s) due a follow-up (threshold ${days} days).`
      : `Nothing due (threshold ${days} days).`,
  )
}

const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (isMain) main()
