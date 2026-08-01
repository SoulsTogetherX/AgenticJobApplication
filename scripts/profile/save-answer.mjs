#!/usr/bin/env node
// Persist a user-provided answer into profile/answers.yaml (the ONLY sanctioned
// way for the agent to add to the fact base).
//
// Usage: node scripts/profile/save-answer.mjs "<question>" "<answer>" [--id a-007]
//        [--source user|model] [--class datum|assertion] [--replace]
//        [--file profile/answers.yaml]
//        node scripts/profile/save-answer.mjs "<question>" --set-class datum|assertion
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
// AND EVERY ANSWER IS CLASSIFIED datum OR assertion.
//
// A datum is a fact about the user (email, city, a skill, a salary figure);
// typing it into a form commits them to nothing. An assertion is something they
// ASSERT or AGREE TO — authorisation to work, willingness to relocate, consent
// to a background check, an e-signature — and it must never be acted on
// unattended, whatever widget a board renders it as. See untrusted.mjs for why
// this lives with the ANSWER and not with the control: a board authors the page
// and can defeat any test of the page, but it cannot change what kind of thing
// the user recorded.
//
// AND THE BANK IS AUDITABLE AFTER THE FACT.
//
// Everything above is a WRITE-TIME control and the stored bank predates all of
// them. `--rescan` is the read-time counterpart: it re-runs every check on this
// boundary against what is ALREADY stored and prints a report. It never writes —
// there is no --fix and no --apply, because an auditor that repairs the fact
// base is a writer wearing a different hat, and hard rule 2 says the agent is
// not one. Every finding prints the command a HUMAN would run.
//
// AND ONE WRITER AT A TIME, ON A FILE THAT SURVIVES A KILL.
//
// Everything above assumes the write itself lands. It did not. answers.yaml was
// read at process start and rewritten whole at the end, with no lock and no
// atomic replacement — a textbook lost update.
//
// MEASURED, by spawning N writers at the same target and comparing the answers
// on disk against the number of processes that exited 0:
//
//   committed version, 6 writers x 5 trials: 4 trials lost 1-3 answers each,
//     7 of 30 lost in total, and EVERY PROCESS EXITED 0 IN EVERY TRIAL.
//   with this lock, 6 writers x 5 trials:  0 lost.
//   with this lock, 20 writers x 5 trials: 0 of 100 lost.
//
// That is the user's own data disappearing while every caller reports success —
// and `pipeline-jobs` runs one subagent per job, so overlapping writers are the
// design rather than an edge case. The lock section further down carries the
// mechanism, the stale-lock rule, and the measurement that killed the first
// version of it.
//
// Exit codes: 0 saved, 1 conflict, 2 usage, 3 instruction-shaped, 4 sensitive,
// 5 the bank was locked by another writer and nothing was written (retryable).
// --rescan reuses 0 (clean) and 1 (findings) and never 3 or 4 — those mean "this
// write was refused" and a rescan performs no write.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import crypto from "node:crypto"
import { loadYamlFile, dumpYaml } from "../lib/lib.mjs"
import {
  sanitizeUntrusted,
  describeFindings,
  isDisqualifying,
  SANITIZER_LIMITS,
  findSensitiveValues,
  describeSensitive,
  SENSITIVE_LIMITS,
  classifyAnswer,
  answerClass,
  describeClass,
  ANSWER_CLASSES,
  CLASS_LIMITS,
  rescanAnswerBank,
  rescanSummary,
  RESCAN_LIMITS,
} from "../lib/untrusted.mjs"
// The dangerous halves of the lock live in ONE place now. This script keeps its
// own acquire loop (see LOCK_TIMEOUT_MS below for the one reason why), but the
// read, the break and the win32 error classification are shared — those are the
// three that diverged between the two implementations, and the divergence in
// `breakStale` alone was the difference between 43 mutual-exclusion violations
// and 0 under 20 concurrent writers.
import {
  readLock as readLockAt,
  breakStale,
  isRetryableCreateError,
} from "../lib/lock.mjs"

const SOURCES = new Set(["user", "model"])
const DEFAULT_FILE = "profile/answers.yaml"

const USAGE =
  'Usage: save-answer.mjs "<question>" "<answer>" [--id a-NNN] [--source user|model]\n' +
  "                      [--class datum|assertion] [--replace] [--file answers.yaml]\n" +
  '       save-answer.mjs "<question>" --set-class datum|assertion [--file answers.yaml]\n' +
  "       save-answer.mjs --rescan [--file answers.yaml] [--json]   (report only, never writes)"

function usage(msg) {
  console.error(`${msg}\n${USAGE}`)
  process.exit(2)
}

// --- STRICT ARGUMENT PARSING ------------------------------------------------
//
// THIS IS AN INCIDENT FIX, not tidiness. The old parser looked up each flag it
// knew about and ignored everything else, so an unrecognised flag was silently
// DROPPED and the run continued as if it had never been typed. On 2026-07-31
// an agent verifying this script by execution invoked it with `--answers <tmp>`
// — the real flag is `--file` — and the write went to the user's REAL fact
// base. Three probe values landed in profile/answers.yaml stamped
// `source: user`, which was false, and one of them (a fabricated phone number)
// then resolved OK on the exact label that appears on nearly every application
// form.
//
// A usage error must never fall through to a successful write, and the file
// this script writes is the one file the agent is otherwise forbidden to touch.
// So: any token starting with "--" that is not a known flag is exit 2, and so
// is a third positional argument — because that is what a swallowed
// `--answers <path>` looks like once the flag has been dropped.
//
// `--` ends flag parsing, so an answer that genuinely begins with "--" is still
// expressible.
const VALUE_FLAGS = new Map([
  ["--file", "file"],
  ["--id", "id"],
  ["--source", "source"],
  ["--class", "cls"],
  ["--set-class", "setClass"],
])
// Named near-misses get told what to type instead. A bare "unknown flag" on the
// exact mistake that caused the incident would be a wasted opportunity.
const HINTS = new Map([
  ["--answers", "--file"],
  ["--answers-file", "--file"],
  ["--path", "--file"],
  ["--out", "--file"],
  ["--output", "--file"],
  ["--replace-all", "--replace"],
  ["--overwrite", "--replace"],
  ["--type", "--class"],
  ["--kind", "--class"],
])

const argv = process.argv.slice(2)
const opts = {
  file: DEFAULT_FILE,
  id: null,
  source: "user",
  cls: null,
  setClass: null,
}
let wantReplace = false
let fileGiven = false
let sourceGiven = false
let userApproved = false
let wantRescan = false
let wantJson = false
const positional = []
let endOfFlags = false
for (let i = 0; i < argv.length; i++) {
  const tok = argv[i]
  if (!endOfFlags && tok === "--") {
    endOfFlags = true
    continue
  }
  if (!endOfFlags && tok.startsWith("--")) {
    const eq = tok.indexOf("=")
    const name = eq === -1 ? tok : tok.slice(0, eq)
    if (VALUE_FLAGS.has(name)) {
      const v = eq === -1 ? argv[++i] : tok.slice(eq + 1)
      if (v === undefined) usage(`${name} needs a value.`)
      opts[VALUE_FLAGS.get(name)] = v
      if (name === "--file") fileGiven = true
      // --source has a DEFAULT, so `opts.source !== null` cannot tell "the
      // caller typed it" from "nobody did". Every other write flag is detected
      // by being non-null; this one needs its own bit, and without it --rescan
      // silently accepted --source and exited 0 — the swallowed-flag shape that
      // caused both 2026-07-31 contamination incidents, sitting inside the fix
      // for them.
      if (name === "--source") sourceGiven = true
      continue
    }
    if (name === "--replace" && eq === -1) {
      wantReplace = true
      continue
    }
    // Report-only audit of the stored bank. Parsed here with the other flags so
    // the strict-parsing guarantee covers it too; the mode itself is handled
    // below, AFTER the NODE_TEST_CONTEXT guard and BEFORE any code that writes.
    if (name === "--rescan" && eq === -1) {
      wantRescan = true
      continue
    }
    if (name === "--json" && eq === -1) {
      wantJson = true
      continue
    }
    // --user-approved asserts, on the command line where a PreToolUse hook can
    // see it, that the user personally gave this answer in chat. It grants
    // nothing: `source` already records provenance, and an agent that would lie
    // in the flag would lie in `--source` too. The one thing it does do here is
    // count as a write flag under --rescan, which refuses it (see below) — a
    // report-only audit has no approval to carry.
    //
    // It exists for .claude/hooks/guard-profile-shell.mjs, which denies any
    // shell invocation of this script that targets the DEFAULT fact base unless
    // it carries one of THREE things: --file (a test writes its own), this flag
    // (the user said it), or --rescan (an audit that cannot write at all).
    // Both 2026-07-31 incidents carried none of them, because neither agent
    // intended to touch the real file — so requiring the writer to STATE which
    // case it is stops the accident class, not just the one typo that --file's
    // strict parsing already closed.
    //
    // NOTE THE COUPLING, because the hook's own comment names it as its weak
    // point: the --rescan allowance means the hook is TRUSTING this script to
    // keep refusing every write under --rescan. The conflict check below is
    // what makes that trust good. If it ever stops being exhaustive, the hook
    // has a hole — which is exactly what `--rescan --source model` was.
    if (name === "--user-approved" && eq === -1) {
      userApproved = true
      continue
    }
    const hint = HINTS.get(name)
    usage(
      `Unrecognised flag ${name}.${hint ? ` Did you mean ${hint}?` : ""}\n` +
        `Nothing was written. An unknown flag is NOT ignored here: this script writes the fact base,\n` +
        `and a dropped --file would have sent it to ${DEFAULT_FILE}.`,
    )
  }
  positional.push(tok)
}

// A TEST PROCESS MAY NEVER REACH THE REAL FACT BASE.
//
// Found the honest way, by doing it: while canarying the strict-parsing fix
// above — deliberately breaking the guard to prove the test goes red — a test
// invocation with no --file fell through to the default and wrote `a-053` into
// the user's real profile/answers.yaml. Same class of incident as the one this
// commit exists to fix, caused by the person fixing it, and it is the argument
// the coordinator asked for: the default path is fine for a human at a terminal
// and is NOT fine for anything spawned by a test runner.
//
// So the default stands (CLAUDE.md documents the command without --file, and
// breaking that would be a worse cure), but it is unreachable from a test.
// NODE_TEST_CONTEXT is set by `node --test` and is inherited by a spawned
// child, which is exactly the shape every test in this suite has.
//
// This is a belt to the test helper's braces: tests/profile/save-answer.test.mjs
// also refuses to build an argv without --file. Two independent guards, because
// the thing they prevent is silent, permanent and in the one file the agent is
// otherwise forbidden to touch.
if (!fileGiven && process.env.NODE_TEST_CONTEXT) {
  console.error(
    `Refusing to write the default ${DEFAULT_FILE} from a test process.\n` +
      `NODE_TEST_CONTEXT is set, so this is running under \`node --test\`. Pass --file <tmpfile>.\n` +
      `A test that writes the real fact base leaves permanent, global, unattributable entries in it —\n` +
      `this exact accident happened twice on 2026-07-31, once to an agent verifying by execution and\n` +
      `once to the agent fixing that.`,
  )
  process.exit(2)
}

const file = opts.file

// --json belongs to --rescan and to nothing else. CAUGHT BY AN EXISTING TEST,
// not by review: "every near-miss flag exits 2 rather than writing somewhere
// else" already listed --json among the flags a WRITE must refuse, and adding
// it to the parser made a save silently accept and ignore it. That is precisely
// the swallowed-flag shape that put four fabricated entries in the real fact
// base on 2026-07-31 — reintroduced, in the same file, by the fix for it.
// Recognising a flag is not the same as accepting it in every mode.
if (wantJson && !wantRescan)
  usage("--json only applies to --rescan; a save has no JSON output.")

// --- --rescan: the read-time audit ------------------------------------------
//
// PLACED HERE ON PURPOSE. Every line below this block can write; this one
// cannot reach any of them, because it exits. The ordering is the guarantee:
// there is no path from --rescan into write(), so "report only" is a property
// of the control flow rather than a promise in a comment.
//
// It sits AFTER the NODE_TEST_CONTEXT guard deliberately, so a test must still
// name its own --file. Reading the real bank from a test is harmless in itself,
// but a test that silently depends on the user's private fact base passes or
// fails for reasons that are not in the repository.
//
// EXIT CODES, and why finding something is not exit 2:
//   0  the scan ran and found nothing at `error` severity
//   1  the scan ran and found at least one `error` — the same meaning 1 already
//      carries here ("the store is not in the state you wanted"), so a caller
//      can gate on it. `review` findings never change the exit code: they are
//      true of a healthy bank, and a check that is red on a healthy store is a
//      check that gets switched off.
//   2  usage, or the file could not be read
// 3 and 4 are never used: they mean "this write was refused", and there is no
// write here to refuse.
if (wantRescan) {
  // A rescan combined with a write flag is a usage error, not a rescan that
  // quietly ignores the rest of the command line. That is the exact failure
  // shape — a dropped flag continuing as if it had never been typed — that put
  // four fabricated entries in the real fact base on 2026-07-31.
  const conflicting = []
  if (positional.length) conflicting.push(`${positional.length} positional argument(s)`)
  if (wantReplace) conflicting.push("--replace")
  if (opts.id !== null) conflicting.push("--id")
  if (opts.cls !== null) conflicting.push("--class")
  if (opts.setClass !== null) conflicting.push("--set-class")
  if (sourceGiven) conflicting.push("--source")
  if (userApproved) conflicting.push("--user-approved")
  if (conflicting.length)
    usage(
      `--rescan reports and never writes, so it cannot be combined with ${conflicting.join(", ")}.\n` +
        `Run the rescan on its own, then run any correction it prints as a separate command.`,
    )

  if (!fs.existsSync(file)) {
    console.error(`No such file: ${file}`)
    process.exit(2)
  }
  let doc
  try {
    doc = loadYamlFile(file) ?? {}
  } catch (err) {
    console.error(`Could not parse ${file}: ${err.message}`)
    process.exit(2)
  }

  const findings = rescanAnswerBank(doc)
  const counts = rescanSummary(findings)
  const entries = Array.isArray(doc?.answers) ? doc.answers.length : 0

  // A finding may carry the stored VALUE (the high-reach check needs a human to
  // look at it). It is revealed only to a human at a terminal. Found by running
  // the first version: it printed the user's home address and personal email
  // into an agent transcript, where nobody needed them and nothing forgets.
  const human = Boolean(process.stdout.isTTY)
  if (wantJson) {
    console.log(
      JSON.stringify(
        {
          file,
          entries,
          ...counts,
          // `value` is dropped entirely from JSON: --json is what a script or an
          // agent reads, and neither is the reader the value exists for.
          findings: findings.map(({ value, ...f }) => f),
          limits: RESCAN_LIMITS,
        },
        null,
        2,
      ),
    )
    process.exit(counts.errors ? 1 : 0)
  }

  const bySeverity = (sev) => findings.filter((f) => f.severity === sev)
  const render = (f) =>
    `  ${(f.entry ?? "bank").padEnd(7)} ${f.kind}: ${f.detail}` +
    (human && f.value ? `\n          value: ${f.value}` : "") +
    (f.remedy ? `\n          -> ${f.remedy}` : "")

  console.log(`Rescan of ${file} — ${entries} entries, nothing written.`)
  const errs = bySeverity("error")
  const revs = bySeverity("review")
  if (errs.length) {
    console.log(
      `\nERROR (${errs.length}) — a write today would refuse this, or it silently weakens a control:`,
    )
    for (const f of errs) console.log(render(f))
  }
  if (revs.length) {
    console.log(
      `\nREVIEW (${revs.length}) — normal in a healthy bank; these are for you to read, not faults:`,
    )
    for (const f of revs) console.log(render(f))
  }
  if (!findings.length) console.log("\nNo findings.")
  console.log(
    `\n${counts.errors} error, ${counts.review} review. This tool NEVER edits ${file} — ` +
      `corrections are yours to make.\nNote: ${RESCAN_LIMITS}`,
  )
  process.exit(counts.errors ? 1 : 0)
}

const forcedId = opts.id
const source = opts.source
if (!SOURCES.has(source)) {
  console.error(`--source must be one of ${[...SOURCES].join("|")}`)
  process.exit(2)
}
if (opts.cls !== null && !ANSWER_CLASSES.has(opts.cls))
  usage(`--class must be one of ${[...ANSWER_CLASSES].join("|")}.`)
if (opts.setClass !== null && !ANSWER_CLASSES.has(opts.setClass))
  usage(`--set-class must be one of ${[...ANSWER_CLASSES].join("|")}.`)

// --set-class corrects the CLASSIFICATION of an entry that already exists and
// never touches the answer, so it takes the question alone.
const wantSetClass = opts.setClass !== null
const maxPositional = wantSetClass ? 1 : 2
if (positional.length > maxPositional) {
  usage(
    `Too many arguments (${positional.length}); expected ${maxPositional}.\n` +
      `A swallowed flag looks exactly like this — check the spelling of every --flag above.`,
  )
}
if (wantSetClass && (wantReplace || opts.cls !== null))
  usage("--set-class cannot be combined with --replace or --class.")

const [rawQuestion, rawAnswer] = positional
if (!rawQuestion?.trim() || (!wantSetClass && !rawAnswer?.trim())) {
  console.error(USAGE)
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
if (!question.trim() || (!wantSetClass && !answer.trim())) {
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

const header = `# ANSWERS BANK — user-editable. Agent adds entries ONLY via scripts/profile/save-answer.mjs.\n`

// --- THE WRITE LOCK, AND WHY THE READ IS INSIDE IT --------------------------
//
// TWO SEPARATE DEFECTS LIVED HERE, and the second is the worse one.
//
// 1. LOST UPDATE. The bank was read at process start and rewritten whole at the
//    end. Two writers overlapping means the second one's document — built from
//    a snapshot taken before the first one's write — replaces it. Measured,
//    not theorised: six concurrent writers against the committed version lost
//    answers in four trials out of five, 7 of 30 in total. Every process exited
//    0 in every trial, so nothing anywhere detected it. The fix is not
//    "write carefully":
//    the READ, the duplicate check, the id allocation and the write must all
//    be one critical section, because each of them is a decision made about a
//    document that another process is entitled to change.
//
// 2. PARTIAL FILE. `writeFileSync` opens with O_TRUNC: the old contents are
//    destroyed before the new ones are written, which is a property of the call
//    rather than a race anyone has to be lucky to hit. A reader hot-looping
//    during a save was reported to observe a short file 1 read in 66 on a
//    685 KB bank (inherited measurement, NOT re-run here — the lost-update
//    numbers above were re-measured, this one was not). A process killed in
//    that window leaves the file short PERMANENTLY, and a truncated
//    answers.yaml is worse than a lost answer: it
//    loses every answer, and `verify-claims` reads this file to decide what
//    the user's resume may claim. Hence write-to-temp + rename, which is
//    all-or-nothing: a crash leaves either the whole old file or the whole new
//    one, never half of either.
//
// STALE LOCKS — the failure a lock introduces, and how it is bounded.
// A lockfile that outlives its holder would wedge the fact base forever, which
// would be a worse bug than the one being fixed. ONE rule bounds it, and it is
// deliberately one rule:
//
//   A lock whose mtime is older than LOCK_STALE_MS is abandoned and may be
//   broken. NOTHING ELSE BREAKS A LOCK.
//
// WHY NOT A PID PROBE — the obvious mechanism, which was implemented here first
// and which caused the exact bug this lock exists to prevent.
//
// The first version also broke a lock when `process.kill(holder.pid, 0)`
// reported ESRCH, so that a killed writer recovered in milliseconds instead of
// seconds. MEASURED with six concurrent writers over five trials (2026-08-01):
// it broke locks whose holders had acquired them 11ms, 13ms and 18ms earlier,
// and produced `exit0=6/6 onDisk=5` — six processes all reporting success with
// one of the user's answers missing.
//
// The probe is not lying: a direct experiment on this host returned "alive"
// 400/400 for a live sibling process and ESRCH only after death. What is wrong
// is the INFERENCE. "The holder process is no longer running" is not the same
// claim as "the lock is abandoned", because a healthy writer's process is gone
// milliseconds after it acquires — so any race that leaves its lockfile behind
// for an instant looks exactly like a crash. Two writers then enter the
// critical section together, and the second one's document, built from a
// snapshot taken before the first one's write, replaces it.
//
// The trade the probe was making: risk the primary defect in order to save a
// few seconds in the rare case where a writer is KILLED mid-save. That is badly
// skewed, and age alone is both simpler and strictly safer:
//
//   * `statSync().mtimeMs` is one syscall returning a number. It cannot be
//     misparsed, and it does not depend on reading the file's contents while
//     five other processes poll the same path.
//   * The critical section measures in single-digit milliseconds and
//     LOCK_STALE_MS is ten SECONDS — a thousandfold margin, so a healthy lock
//     is never a candidate. (If that section ever grows past about a second,
//     this needs a heartbeat that touches the mtime. Today it does not.)
//   * LOCK_TIMEOUT_MS is longer than LOCK_STALE_MS on purpose, so a single
//     waiter outlives a full stale window and recovers a killed writer's lock
//     by itself. Nobody has to delete a lockfile by hand.
//
// THE COST, STATED PLAINLY: a writer killed mid-save blocks other writers for
// up to LOCK_STALE_MS rather than for milliseconds. That is the price of not
// letting the recovery path cause the bug.
//
// Breaking is a rename to a unique name, which is atomic — so when N waiters
// all judge the same lock stale, exactly one rename succeeds and the other N-1
// get ENOENT and go back to polling. The breaker then CHECKS WHAT IT TOOK,
// because between the stat that judged the lock old and the rename that takes
// it, the holder may have released and a new writer acquired; a file that turns
// out to be fresh is put back rather than deleted.
//
// And the converse, which is the last line of defence: a holder whose lock was
// broken out from under it re-checks ownership immediately before publishing
// and ABORTS rather than writing a document built from a snapshot it no longer
// owns. Refusing to write is recoverable; a silent clobber is the bug we
// started with.
//
// THE HONEST LIMIT. This is a cooperative, advisory lock: it binds processes
// that go through this script, and nothing else. A human editing answers.yaml
// in a text editor, or any future script that writes the bank without taking
// this lock, is not serialised by it. The atomic rename still protects such a
// writer from producing a torn file, but not from a lost update. The guarantee
// is "save-answer.mjs does not lose its own writes", not "this file cannot be
// clobbered".
// A TEST SEAM ON THE TIMEOUT, AND WHY IT CANNOT WEAKEN THE CONTROL.
//
// LOCK_TIMEOUT_MS bounds how long a writer WAITS before giving up with exit 5
// and writing nothing. Every value of it produces the same safety property:
// lowering it makes this process surrender sooner, and there is no value that
// lets it write while another process holds the lock. So it is safe to make
// configurable, and asserting the locked-out path in a test costs milliseconds
// instead of fifteen seconds.
//
// LOCK_STALE_MS is deliberately NOT configurable. Lowering THAT would let a
// writer declare a live holder abandoned and break a lock somebody is using,
// which is the lost update wearing a different hat. The two constants look
// alike and are not: one bounds patience, the other bounds trust.
function envMs(name, fallback) {
  const raw = process.env[name]
  if (raw === undefined) return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

const LOCK_STALE_MS = 10_000 // an untouched lock older than this is abandoned
const LOCK_TIMEOUT_MS = envMs("AJ_LOCK_TIMEOUT_MS", 20_000) // > LOCK_STALE_MS
const LOCK_POLL_MS = 12 // between acquisition attempts
// (the read-retry counts now live in lib/lock.mjs alongside readLock itself)
const UNLINK_ATTEMPTS = 20 // release runs in an exit handler: keep it under ~100ms
const UNLINK_BACKOFF_MS = 5
const RENAME_ATTEMPTS = 60 // see writeFileAtomic: EPERM on win32 is transient
const RENAME_BACKOFF_MS = 15

// Synchronous sleep. This script is a short-lived CLI with no event loop work
// to interleave, so blocking is the honest primitive; an async rewrite would
// buy nothing and would make the "no path from --rescan into write()" ordering
// guarantee above harder to read.
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

const lockPath = `${file}.lock`
const lockNonce = crypto.randomUUID()

// READING THE LOCK, AND WHY IT REPORTS THREE STATES RATHER THAN TWO.
//
// The first version returned the holder record or `null`, and `null` meant BOTH
// "there is no lock" and "I could not read the lock right now". Those are
// opposite facts, and collapsing them is a bug with teeth: six processes
// polling one path with readFileSync produce transient failures, and every one
// of them was read as "my lock is gone". A holder would then skip its own
// release — leaking a lock that the next waiter reads as a crash — or abort a
// write it was perfectly entitled to make.
//
// An empty or half-written file is a holder mid-acquire, not a corpse, so a
// parse failure is retried rather than believed. Only ENOENT is an immediate
// answer, because a missing file is unambiguous.
//
// The implementation is lib/lock.mjs's; this is the path-bound wrapper.
const readLock = () => readLockAt(lockPath)

// null means "not old" — gone, or unreadable. Never treat an unknown age as an
// expired one: that is the direction that breaks a live writer's lock.
function lockAgeMs() {
  try {
    return Date.now() - fs.statSync(lockPath).mtimeMs
  } catch {
    return null
  }
}

// Break a lock judged abandoned. The rename is atomic, so simultaneous breakers
// cannot both succeed; the loser sees ENOENT and goes back to polling.
//
// Then it verifies what it took. Between the stat that judged the lock old and
// this rename, the holder may have released and a NEW writer acquired — in
// which case we are holding a live writer's lock, and deleting it would put two
// processes in the critical section at once. A file that turns out to be fresh
// goes straight back.
//
// The implementation is lib/lock.mjs's, which is this one plus an `fs.linkSync`
// restore (atomic create-or-EEXIST, so the put-back can never clobber a lock
// created in the meantime, where the old `existsSync` + rename could).
const breakStaleLock = () => breakStale(lockPath, lockNonce, LOCK_STALE_MS)

function acquireLock() {
  const deadline = Date.now() + LOCK_TIMEOUT_MS
  let broke = null
  for (;;) {
    try {
      // "wx" is create-exclusively-or-fail, and that atomicity IS the lock.
      const fd = fs.openSync(lockPath, "wx")
      try {
        fs.writeSync(
          fd,
          JSON.stringify({
            pid: process.pid,
            host: os.hostname(),
            nonce: lockNonce,
            at: new Date().toISOString(),
          }),
        )
      } finally {
        fs.closeSync(fd)
      }
      return broke
    } catch (err) {
      // "COULD NOT CREATE RIGHT NOW" IS NOT ONLY EEXIST ON WIN32. `wx` returns
      // EPERM — not EEXIST — when the path is delete-pending, which is exactly
      // what a NORMAL release looks like from a waiter's side. Measured on this
      // host, one churner against one waiter over 3s: 7357 attempts, EEXIST
      // 3529, EPERM 636 (8.6%). Rethrowing that 8.6% put raw stack traces out
      // of live writer processes. EPERM/EACCES/EBUSY belong on the poll path.
      // This is platform classification, not a pattern list to keep extending.
      if (!isRetryableCreateError(err.code)) throw err
    }

    // THE DEADLINE IS CHECKED BEFORE ANY BRANCH THAT CAN `continue`. It used to
    // be checked only on the fall-through, so a break that kept failing looped
    // with neither a deadline test nor a sleep — a hot spin for the full
    // timeout. Nothing below may outlive this.
    if (Date.now() >= deadline) {
      const r = readLock()
      const holder = r.state === "held" ? r.holder : null
      const who = holder ? `pid ${holder.pid} on ${holder.host} since ${holder.at}` : "another writer"
      const e = new Error(
        `Timed out after ${LOCK_TIMEOUT_MS / 1000}s waiting for the answer-bank lock (held by ${who}).\n` +
          `NOTHING WAS WRITTEN — this is safe to retry. If ${lockPath} is left over from a process that\n` +
          `died, it is broken automatically once it is ${LOCK_STALE_MS / 1000}s old, or you can delete it.`,
      )
      e.lockTimeout = true
      throw e
    }

    // AGE IS THE ONLY THING THAT MAY BREAK A LOCK. There is deliberately no pid
    // probe: see the long note above LOCK_STALE_MS, and lib/lock.mjs's header
    // for the A/B that removed it from there too (43 mutual-exclusion
    // violations with it, 0 without, over 20 writers x 5 trials).
    const age = lockAgeMs()
    if (age !== null && age > LOCK_STALE_MS) {
      if (breakStaleLock())
        broke = `it was untouched for ${Math.round(age / 1000)}s`
      continue // the deadline is re-checked at the top; this cannot spin forever
    }
    sleepSync(LOCK_POLL_MS)
  }
}

// Do we still hold the lock we took? Called immediately before publishing. If a
// waiter judged us stale and broke our lock, another writer may now be building
// its own document from the same snapshot, and publishing ours would be exactly
// the lost update this whole section exists to prevent.
//
// AN UNREADABLE LOCK COUNTS AS NOT HELD, deliberately. The two possible
// mistakes are wildly unequal in cost: writing when we no longer own the lock
// is the lost update, and refusing to write when we do own it costs the caller
// one retry. readLock() retries first, so this is rare rather than routine.
function stillHoldLock() {
  const r = readLock()
  return r.state === "held" && r.holder?.nonce === lockNonce
}

// Only ever unlink a lock that is provably ours. An unreadable lock is LEFT IN
// PLACE — it ages out on its own, and unlinking something we cannot identify is
// precisely how a live writer's lock gets deleted.
//
// The retry is the same win32 fact writeFileAtomic documents: removing a file
// another process has open for reading fails transiently. Without it a release
// silently failed, the lock leaked, and the next waiter read the leak as a
// crashed writer.
function releaseLock() {
  if (!stillHoldLock()) return
  for (let i = 0; i < UNLINK_ATTEMPTS; i++) {
    try {
      fs.unlinkSync(lockPath)
      return
    } catch (err) {
      if (err.code === "ENOENT") return
      if (!["EPERM", "EACCES", "EBUSY"].includes(err.code)) return
      sleepSync(UNLINK_BACKOFF_MS)
    }
  }
}

// All-or-nothing replacement: full contents into a sibling temp file, fsync,
// then rename over the target.
//
// The temp file MUST be in the same directory — rename is only atomic within a
// filesystem, and a temp in os.tmpdir() would degrade to a copy.
//
// MEASURED WINDOWS BEHAVIOUR, and the reason for the retry loop: renaming over
// a file that ANOTHER PROCESS HAS OPEN FOR READING fails with EPERM on win32
// (verified on this machine; on POSIX it succeeds). answer-bank.mjs and
// verify-claims.mjs both read this file, so that collision is routine rather
// than exotic. The retry rides it out. What we never do is fall back to a
// truncating write — that would trade the lost-update bug for the partial-file
// bug, which is the worse of the two. On exhaustion the ORIGINAL file is
// untouched and the caller is told.
function writeFileAtomic(target, text) {
  const dir = path.dirname(path.resolve(target))
  const tmp = path.join(dir, `.${path.basename(target)}.tmp-${process.pid}-${lockNonce}`)
  const fd = fs.openSync(tmp, "wx")
  try {
    fs.writeFileSync(fd, text, "utf8")
    fs.fsyncSync(fd) // the bytes are on disk BEFORE anything points at them
  } finally {
    fs.closeSync(fd)
  }
  let lastErr
  for (let i = 0; i < RENAME_ATTEMPTS; i++) {
    try {
      fs.renameSync(tmp, target)
      return
    } catch (err) {
      lastErr = err
      if (!["EPERM", "EACCES", "EBUSY"].includes(err.code)) break
      sleepSync(RENAME_BACKOFF_MS)
    }
  }
  try {
    fs.unlinkSync(tmp)
  } catch {
    /* best effort; the temp is dotfile-named and inert */
  }
  throw new Error(
    `Could not replace ${target} (${lastErr?.code ?? lastErr?.message}). NOTHING WAS WRITTEN and the\n` +
      `existing file is intact. On Windows this happens when another process is holding the file open;\n` +
      `close anything reading it and retry.`,
  )
}

// --- ENTERING THE CRITICAL SECTION ------------------------------------------
//
// Everything from here to write() is ONE indivisible decision about the bank:
// what is already in it, whether this question duplicates an entry, which id is
// free, and what the file becomes. Every one of those is derived from a
// document another process is entitled to change, so performing them outside a
// lock is the lost update — not a race that is unlikely, a race that was
// measured losing answers in most trials.
//
// THE LOCK IS TAKEN HERE, AND NOT EARLIER, ON PURPOSE. Exits 2, 3 and 4 all
// happen above this line, so a refused save never creates a lockfile at all:
// an instruction-shaped label cannot wedge the fact base against other writers,
// and a usage error leaves nothing behind to clean up. `--rescan` exits far
// above this too, so the read-only audit takes no lock and cannot be blocked
// by one.
//
// Registered before the acquire rather than after, so a failure DURING
// acquisition still releases. releaseLock() is nonce-guarded, so running it
// when we never held the lock — or when a waiter already broke it — does
// nothing rather than deleting somebody else's claim.
process.on("exit", releaseLock)

let brokeStale = null
try {
  brokeStale = acquireLock()
} catch (err) {
  if (err.lockTimeout) {
    console.error(err.message)
    process.exit(5)
  }
  if (err.code === "ENOENT") {
    console.error(
      `Cannot create ${lockPath}: its directory does not exist. Nothing was written.`,
    )
    process.exit(2)
  }
  throw err
}
// Said out loud, never only logged: breaking a lock is the one moment this
// script overrides another process's claim on the user's fact base. A bank that
// needs it repeatedly has a writer that keeps dying, and that is worth seeing.
if (brokeStale)
  console.error(`Note: broke an abandoned lock on ${file} — ${brokeStale}.`)

let data
try {
  data = fs.existsSync(file) ? (loadYamlFile(file) ?? {}) : {}
} catch (err) {
  // AN UNPARSEABLE BANK IS NOT AN EMPTY BANK. Falling through to `{}` here
  // would replace the user's entire file with a fresh one-entry document — the
  // largest possible version of the data loss this whole section exists to
  // prevent, performed by the fix for it.
  console.error(
    `Could not parse ${file}: ${err.message}\n` +
      `NOTHING WAS WRITTEN. Repair the YAML by hand, or move the file aside if you meant to start over.`,
  )
  process.exit(2)
}
data.answers ??= []
if (!Array.isArray(data.answers)) {
  console.error(`${file} is malformed: "answers" is not a list`)
  process.exit(2)
}

const dupQ = data.answers.find(
  (a) => a.question?.trim().toLowerCase() === question.trim().toLowerCase(),
)

// THE ONLY WRITER. Every success path below goes through this and nothing else
// touches the file. Two things happen here that did not before:
//
//   * the ownership re-check, so a writer whose lock was broken out from under
//     it refuses to publish a document built from a snapshot it no longer owns;
//   * the all-or-nothing replacement, so no reader and no kill can observe a
//     half-written bank.
//
// Both report exit 5, which means "nothing was written, this is safe to retry".
// That is deliberately neither 1 (a conflict the caller must resolve by
// choosing something different) nor 2 (the command line was wrong): retrying
// either of those unchanged is pointless, and retrying this one is the fix.
const write = () => {
  if (!stillHoldLock()) {
    console.error(
      `Aborting: another process broke this writer's lock on ${file} before it published.\n` +
        `NOTHING WAS WRITTEN and the existing file is intact — re-run the command. A lock is only\n` +
        `broken after ${LOCK_STALE_MS / 1000}s untouched, so this means the save stalled that long.`,
    )
    process.exit(5)
  }
  try {
    writeFileAtomic(file, header + dumpYaml(data))
  } catch (err) {
    console.error(err.message)
    process.exit(5)
  }
}

// --- classification ---------------------------------------------------------
//
// Three provenances, and the difference between them is the whole control:
//
//   user      the user said which it is (--class, with the default --source).
//   model     the agent proposed it and the user approved the save, exactly the
//             rule that already governs a model-derived ANSWER (hard rule 2).
//   inferred  nobody said, so classifyAnswer read the recorded question. This
//             is recorded AS inferred rather than laundered into a decision
//             somebody made, so a wrong call is visible in the file and can be
//             corrected with --set-class instead of being silently re-decided
//             on every future application.
//
// The reasons are stored for an inferred assertion because that is the only
// case where somebody will later ask "why does this one not fill?" and deserve
// an answer better than "the script said so".
function classifyFor(q, a) {
  if (opts.cls !== null) return { cls: opts.cls, src: source, reasons: [] }
  const got = classifyAnswer(q, a)
  return { cls: got.class, src: "inferred", reasons: got.reasons }
}
function applyClass(entry, cls, src, reasons) {
  entry.class = cls
  entry.class_source = src
  if (cls === "assertion" && reasons.length) entry.class_reasons = reasons
  else delete entry.class_reasons
}

// --- the --set-class correction path ----------------------------------------
//
// Correcting a CLASSIFICATION is not correcting a fact, so this never touches
// the answer and is not governed by --replace's "the agent may not overwrite
// what the user said" rule — that rule is about the answer's truth.
//
// It is asymmetric on purpose. TIGHTENING (datum -> assertion) is always
// allowed: the worst it costs is a field the user fills by hand. LOOSENING
// (assertion -> datum) is the direction that grants unattended auto-action to
// something the user asserts, so the agent may not do it — an agent declaring
// --source model is refused, and the change is the user's to make.
if (wantSetClass) {
  if (!dupQ) {
    console.error(
      `No entry matches "${question.trim()}" in ${file}. --set-class corrects an existing answer; ` +
        `it does not create one.`,
    )
    process.exit(1)
  }
  const before = answerClass(dupQ)
  if (opts.setClass === "datum" && before.class === "assertion") {
    if (source === "model") {
      console.error(
        `Refusing to reclassify ${dupQ.id} from assertion to datum on a model-derived request.\n` +
          `"${dupQ.question}" is recorded as something the user ASSERTS (${before.reasons.join(", ") || "declared"}),\n` +
          `and datum means "may be filled unattended on any form, in any widget". That is the user's call to\n` +
          `make, not a pick the agent proposes. Ask them, then re-run without --source model.\n` +
          `Note: ${CLASS_LIMITS}`,
      )
      process.exit(1)
    }
    console.error(
      `Note: ${dupQ.id} is now a datum and may be filled unattended. It was an assertion` +
        `${before.reasons.length ? ` (${before.reasons.join(", ")})` : ""}.`,
    )
  }
  applyClass(dupQ, opts.setClass, source, [])
  write()
  console.log(
    `Reclassified ${dupQ.id}: ${before.class}/${before.source} -> ${opts.setClass}/${source}` +
      ` -> ${file}`,
  )
  process.exit(0)
}

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
  // The answer changed, so the class is re-derived rather than inherited. An
  // entry whose answer was replaced with an agreement token must not keep the
  // datum class the old answer earned.
  const k = classifyFor(question, answer)
  applyClass(dupQ, k.cls, k.src, k.reasons)
  write()
  console.log(
    `Replaced ${dupQ.id} (was model-derived): "${question.trim()}" ` +
      `[${describeClass(answerClass(dupQ))}] -> ${file}`,
  )
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

const entry = {
  id,
  question: question.trim(),
  answer: answer.trim(),
  source,
  added: new Date().toISOString().slice(0, 10),
}
const k = classifyFor(question, answer)
applyClass(entry, k.cls, k.src, k.reasons)
data.answers.push(entry)

write()
// The TARGET PATH is printed on every success, not only when it was passed.
// The incident on 2026-07-31 was a dropped --file flag: the run reported
// success and the operator had no way to see it had gone to the real fact base
// instead of their temp file. Strict parsing now stops that case outright, and
// this makes any future variant of it visible in the one line a caller reads.
console.log(
  `Saved ${id} (source: ${source}, class: ${describeClass(answerClass(entry))}): ` +
    `"${question.trim()}" -> ${file}${fileGiven ? "" : " (default)"}`,
)
if (entry.class === "assertion") {
  // Said out loud because it changes what happens on every future application:
  // this answer will be presented, not auto-acted.
  console.error(
    `Note: recorded as an ASSERTION (${k.reasons.join(", ") || "declared"}) — something you assert or\n` +
      `agree to, not a fact about you. It will not be acted on unattended, whatever control a board\n` +
      `renders it as. Correct with: --set-class datum\n` +
      `Note: ${CLASS_LIMITS}`,
  )
}
