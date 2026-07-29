#!/usr/bin/env node
// Persist a user-provided answer into profile/answers.yaml (the ONLY sanctioned
// way for the agent to add to the fact base).
//
// Usage: node scripts/profile/save-answer.mjs "<question>" "<answer>" [--id a-007] [--file profile/answers.yaml]
import fs from "node:fs"
import { loadYamlFile, dumpYaml } from "../lib/lib.mjs"

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
const [question, answer] = args

if (!question?.trim() || !answer?.trim()) {
  console.error(
    'Usage: save-answer.mjs "<question>" "<answer>" [--id a-NNN] [--file answers.yaml]',
  )
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
  console.error(
    `Question already answered as ${dupQ.id}: "${dupQ.answer}". Edit ${file} to change it.`,
  )
  process.exit(1)
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
  added: new Date().toISOString().slice(0, 10),
})

const header = `# ANSWERS BANK — user-editable. Agent adds entries ONLY via scripts/profile/save-answer.mjs.\n`
fs.writeFileSync(file, header + dumpYaml(data), "utf8")
console.log(`Saved ${id}: "${question.trim()}"`)
