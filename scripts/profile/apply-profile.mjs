#!/usr/bin/env node
// Apply a reviewed profile update: replaces profile/profile.yaml with
// profile/profile.proposed.yaml AFTER enforcing the merge guarantees:
//   - every existing fact id must still exist   (no silent deletions)
//   - every existing fact's text must be unchanged (no silent rewrites)
//   - all ids unique, contact.name/email present
// Overrides (only with explicit user approval): --allow-edits, --allow-removals.
// The old profile is backed up to profile/profile.backup.yaml.
//
// Usage: node scripts/profile/apply-profile.mjs [--proposal profile/profile.proposed.yaml]
//        [--target profile/profile.yaml] [--allow-edits] [--allow-removals]
import fs from "node:fs"
import path from "node:path"
import { loadYamlFile, buildFactIndex } from "#lib/lib.mjs"

const args = process.argv.slice(2)
function flagBool(name) {
  const i = args.indexOf(name)
  if (i !== -1) {
    args.splice(i, 1)
    return true
  }
  return false
}
function flag(name, dflt) {
  const i = args.indexOf(name)
  if (i !== -1) {
    const v = args[i + 1]
    args.splice(i, 2)
    return v
  }
  return dflt
}
const allowEdits = flagBool("--allow-edits")
const allowRemovals = flagBool("--allow-removals")
const proposalPath = flag("--proposal", "profile/profile.proposed.yaml")
const targetPath = flag("--target", "profile/profile.yaml")

if (!fs.existsSync(proposalPath)) {
  console.error(
    `No proposal found at ${proposalPath}. The update-profile skill writes it for user review first.`,
  )
  process.exit(2)
}
if (!fs.existsSync(targetPath)) {
  console.error(`No current profile at ${targetPath}.`)
  process.exit(2)
}

let proposal, target, proposalIdx, targetIdx
try {
  proposal = loadYamlFile(proposalPath)
  proposalIdx = buildFactIndex(proposal, { answers: [] })
} catch (e) {
  console.error(`Proposal is invalid: ${e.message}`)
  process.exit(1)
}
try {
  target = loadYamlFile(targetPath)
  targetIdx = buildFactIndex(target, { answers: [] })
} catch (e) {
  console.error(
    `Current profile failed to parse (${e.message}) — fix it before applying updates.`,
  )
  process.exit(1)
}

if (!proposal?.contact?.name || !proposal?.contact?.email) {
  console.error("Proposal is missing contact.name or contact.email.")
  process.exit(1)
}
if (!proposal?.meta) {
  console.error("Proposal is missing the meta block.")
  process.exit(1)
}

const removed = [...targetIdx.keys()].filter((id) => !proposalIdx.has(id))
const changed = [...targetIdx.keys()].filter(
  (id) =>
    proposalIdx.has(id) && proposalIdx.get(id).text !== targetIdx.get(id).text,
)
const added = [...proposalIdx.keys()].filter((id) => !targetIdx.has(id))

const problems = []
if (removed.length && !allowRemovals) {
  problems.push(
    `Facts would be DELETED (pass --allow-removals only with user approval): ${removed.join(", ")}`,
  )
}
if (changed.length && !allowEdits) {
  problems.push(
    `Facts would be REWRITTEN (pass --allow-edits only with user approval): ${changed.join(", ")}`,
  )
}
if (problems.length) {
  console.error(problems.join("\n"))
  process.exit(1)
}

const backupPath = path.join(path.dirname(targetPath), "profile.backup.yaml")
fs.copyFileSync(targetPath, backupPath)
fs.copyFileSync(proposalPath, targetPath)
fs.unlinkSync(proposalPath)

console.log(
  JSON.stringify(
    {
      applied: true,
      added,
      changed: allowEdits ? changed : [],
      removed: allowRemovals ? removed : [],
      backup: backupPath,
    },
    null,
    2,
  ),
)
