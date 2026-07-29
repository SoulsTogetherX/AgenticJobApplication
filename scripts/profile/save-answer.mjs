#!/usr/bin/env node
// Persist a user-provided answer into profile/answers.yaml (the ONLY sanctioned
// way for the agent to add to the fact base).
//
// Usage: node scripts/profile/save-answer.mjs "<question>" "<answer>" [--id a-007]
//        [--source user|model] [--replace] [--file profile/answers.yaml]
//
// --source records provenance. `user` (the default) means the user said it in
// chat. `model` means the agent picked an option off a form and the user
// approved that pick in the approval message — still approved, but derived, so
// a wrong one has to be findable and reversible.
//
// --replace overwrites an existing entry for the same question, but ONLY when
// that entry is source: model. A user-stated answer is never overwritten by
// this script; correcting one is a deliberate edit of the file by its owner.
import fs from "node:fs"
import { loadYamlFile, dumpYaml } from "../lib/lib.mjs"

const SOURCES = new Set(["user", "model"])

const args = process.argv.slice(2)
function flag(name, dflt) {
  const i = args.indexOf(name)
  if (i !== -1) {
    const v = args[i + 1]
    args.splice(i, 2)
    return v
  }
  return dflt
}
const file = flag("--file", "profile/answers.yaml")
const forcedId = flag("--id", null)
const source = flag("--source", "user")
const replaceIdx = args.indexOf("--replace")
const wantReplace = replaceIdx !== -1
if (wantReplace) args.splice(replaceIdx, 1)
const [question, answer] = args

if (!question?.trim() || !answer?.trim()) {
  console.error(
    'Usage: save-answer.mjs "<question>" "<answer>" [--id a-NNN] [--source user|model] [--replace] [--file answers.yaml]',
  )
  process.exit(2)
}
if (!SOURCES.has(source)) {
  console.error(`--source must be one of ${[...SOURCES].join("|")}`)
  process.exit(2)
}

const data = fs.existsSync(file) ? (loadYamlFile(file) ?? {}) : {}
data.answers ??= []
if (!Array.isArray(data.answers)) {
  console.error(`${file} is malformed: "answers" is not a list`)
  process.exit(2)
}

const dupQ = data.answers.find(
  (a) => a.question?.trim().toLowerCase() === question.trim().toLowerCase(),
)
if (dupQ) {
  // Entries written before provenance existed have no source. Those came from
  // the user, so they get the user's protection.
  const dupSource = dupQ.source ?? "user"
  if (!wantReplace) {
    console.error(
      `Question already answered as ${dupQ.id} (source: ${dupSource}): "${dupQ.answer}". ` +
        `Pass --replace to overwrite a model-derived pick, or edit ${file} to change it.`,
    )
    process.exit(1)
  }
  if (dupSource !== "model") {
    console.error(
      `${dupQ.id} is a ${dupSource}-stated answer: "${dupQ.answer}". ` +
        `--replace only overwrites model-derived picks; edit ${file} to change this one.`,
    )
    process.exit(1)
  }
  dupQ.answer = answer.trim()
  dupQ.source = source
  dupQ.added = new Date().toISOString().slice(0, 10)
  const header = `# ANSWERS BANK — user-editable. Agent adds entries ONLY via scripts/profile/save-answer.mjs.\n`
  fs.writeFileSync(file, header + dumpYaml(data), "utf8")
  console.log(`Replaced ${dupQ.id} (was model-derived): "${question.trim()}"`)
  process.exit(0)
}

let id = forcedId
if (id) {
  if (data.answers.some((a) => a.id === id)) {
    console.error(`Duplicate id: ${id}`)
    process.exit(1)
  }
} else {
  const used = new Set(data.answers.map((a) => a.id))
  let n = data.answers.length + 1
  do {
    id = `a-${String(n).padStart(3, "0")}`
    n++
  } while (used.has(id))
}

data.answers.push({
  id,
  question: question.trim(),
  answer: answer.trim(),
  source,
  added: new Date().toISOString().slice(0, 10),
})

const header = `# ANSWERS BANK — user-editable. Agent adds entries ONLY via scripts/profile/save-answer.mjs.\n`
fs.writeFileSync(file, header + dumpYaml(data), "utf8")
console.log(`Saved ${id} (source: ${source}): "${question.trim()}"`)
