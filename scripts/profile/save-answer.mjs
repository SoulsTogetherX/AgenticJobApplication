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
//
// THE QUESTION IS THIRD-PARTY TEXT AND THIS IS ITS ONLY DOOR.
//
// An answer's text comes from the user. The QUESTION does not — it is a form
// label copied off an employer's application page by the scanner, and under
// --source model the ANSWER is an option label off the same page. Both land in
// answers.yaml, which is:
//
//   * permanent — nothing expires it,
//   * global — every future application reads it, not just this employer's,
//   * and part of the verify-claims evidence corpus, which is the thing that
//     decides whether a claim may appear on the user's resume.
//
// A hostile label is therefore worth more to an attacker than a hostile job
// description: the description influences one tailoring run, an entry in
// answers.yaml influences all of them. So text goes through untrusted.mjs
// here, at the boundary, and an instruction-shaped label is REFUSED rather
// than stored redacted — a permanent record is not the place to keep a
// neutralised attack, and the user is in the conversation and can be told.
//
// AND THE VALUE SIDE IS THE OTHER HALF OF THE SAME BOUNDARY.
//
// The store is not only a place hostile text gets IN; it is the supply of
// everything this pipeline types OUT into other people's forms. A field's
// meaning is decided server-side, so a control labelled "Phone number" can
// POST to a column called `ssn` and no scanner can tell. That makes the blast
// radius of every label-lie routing attack exactly the contents of this file —
// so a government or financial identifier is refused here (exit 4) and the
// user types it themselves, in the browser, on the page they are looking at.
//
// Exit codes: 0 saved, 1 conflict, 2 usage, 3 instruction-shaped, 4 sensitive.
import fs from "node:fs"
import { loadYamlFile, dumpYaml } from "../lib/lib.mjs"
import {
  sanitizeUntrusted,
  describeFindings,
  isDisqualifying,
  SANITIZER_LIMITS,
  findSensitiveValues,
  describeSensitive,
  SENSITIVE_LIMITS,
} from "../lib/untrusted.mjs"

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
const [rawQuestion, rawAnswer] = args

if (!rawQuestion?.trim() || !rawAnswer?.trim()) {
  console.error(
    'Usage: save-answer.mjs "<question>" "<answer>" [--id a-NNN] [--source user|model] [--replace] [--file answers.yaml]',
  )
  process.exit(2)
}
if (!SOURCES.has(source)) {
  console.error(`--source must be one of ${[...SOURCES].join("|")}`)
  process.exit(2)
}

// --- the untrusted boundary -------------------------------------------------
//
// Exit 3 = refused as untrusted, distinct from 1 (conflict) and 2 (usage), so
// the caller can tell "the form is hostile" from "you typed it wrong".
//
// Two outcomes, not one:
//
//   refuse   an instruction-shaped label. There is no honest reason for an
//            application form to address an assistant, and storing it
//            redacted would leave a permanent entry whose question text is
//            "[redacted: ...]" — unmatchable by answer-bank forever after.
//   clean    invisible characters, homoglyphs, a stray HTML fragment. These
//            have dull causes (a CMS, a paste from Word) and the fix is to
//            store the readable form, which is also what the user saw on
//            screen. Reported on stderr so it is never silent.
const scan = { q: sanitizeUntrusted(rawQuestion), a: sanitizeUntrusted(rawAnswer) }
const hostile = [...scan.q.findings, ...scan.a.findings].filter(isDisqualifying)
if (hostile.length) {
  console.error(
    `Refusing to save: this text is instruction-shaped (${describeFindings(hostile)}).\n` +
      `A form label is written by the employer and answers.yaml is permanent, global, and part of\n` +
      `the verify-claims evidence corpus — so it is not somewhere to file a neutralised attack.\n` +
      `Quote the field to the user and ask what to record, or edit ${file} yourself.\n` +
      `Note: ${SANITIZER_LIMITS}`,
  )
  process.exit(3)
}

const question = scan.q.text
const answer = scan.a.text
if (!question.trim() || !answer.trim()) {
  console.error("Refusing to save: nothing readable left after sanitising.")
  process.exit(3)
}
if (!scan.q.clean || !scan.a.clean) {
  console.error(
    `Note: hidden characters removed before saving (${describeFindings([...scan.q.findings, ...scan.a.findings])}).`,
  )
}

// --- the sensitive-value boundary -------------------------------------------
//
// Exit 4 = a government or financial identifier, distinct from 3 (the form is
// hostile), 1 (conflict) and 2 (usage). The caller needs to tell "this page is
// attacking you" from "this is yours to type yourself".
//
// WHY THE REFUSAL IS HERE and not at the field that types it.
//
// A field's meaning is decided SERVER-SIDE. An input named `phone`, labelled
// "Phone number", typed `tel` can POST to a column called `ssn`, and nothing in
// the document says so — so no scanner downstream can recover it and every
// field-level guard is permanently mitigation. What that leaves is: the blast
// radius of a label-lie routing attack is exactly the contents of the answer
// bank. Bounding the bank is therefore the structural fix, and it holds no
// matter what any page claims about any field.
//
// Checked on the SANITISED text, because that is what would be written — an
// identifier padded with zero-width characters is reassembled by the sanitiser
// first and then seen here.
const sensitive = findSensitiveValues(question, answer)
if (sensitive.length) {
  // The refusal never echoes the value. Printing it while refusing to store it
  // would put it in a terminal, a transcript and a log — the whole disclosure,
  // performed by the defence.
  console.error(
    `Refusing to save: this looks like a ${describeSensitive(sensitive)}. Nothing was written.\n` +
      `\n` +
      `This is your own data on your own machine, so this is not about trusting you — it is about\n` +
      `where it would end up. answers.yaml is permanent, global to every future application, and read\n` +
      `by a script that types it into third-party forms unattended. A form can label a field "Phone\n` +
      `number" while the value it POSTs lands in a column called "ssn"; the page decides that\n` +
      `server-side and nothing here can see it. So this pipeline must never be in a position to type a\n` +
      `government or financial ID into someone else's form, which means never holding one.\n` +
      `\n` +
      `If a form genuinely asks for this, it is yours to type — in the browser, on the submit page you\n` +
      `are looking at (hard rule 6 already puts you there). If this is NOT that, rephrase the answer\n` +
      `without the number, or record what the form actually needs to know.\n` +
      `Note: ${SENSITIVE_LIMITS}`,
  )
  process.exit(4)
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
