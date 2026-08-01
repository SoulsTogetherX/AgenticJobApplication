// THE CONTROL. Every other file in tests/security/ asserts that something
// hostile is STOPPED. This one asserts that something honest is NOT.
//
// WHY IT IS A SECURITY TEST AND NOT AN APPLY TEST. A suite made only of attacks
// cannot tell "safe" from "broken". A pipeline that deferred every field on
// every page — or one that crashed in resolveFields and returned nothing —
// passes every other assertion in this directory, because every one of them is
// of the form "no action reached the hostile control". This file is the other
// half of that pair, and it is deliberately owned by the agent whose job is to
// break things: a defence I add is not free, and this is where its cost shows.
//
// THE MEASUREMENT THAT PROMPTED IT (2026-07-31, command in the test below):
// across all ten scan fixtures then in tests/fixtures/boards/scans/, four
// reached `ready: true` and ALL FOUR were hostile and minimal — one or two
// fields each, built to isolate a single attack. Zero honest boards reached it.
// So `ready: true` — fill-plan.mjs's own "scan -> fill -> hand over, with no
// model step in between", the pipeline's headline latency feature — had never
// been demonstrated firing on a realistic application form. It was asserted
// only where it was cheap to reach.
//
// WHAT "HONEST" MEANS HERE, and the line this file must not cross: the fixture
// is the field set Greenhouse's job-boards UI renders for a posting with no
// custom questions, it contains no adversarial construction, and it was NOT
// trimmed until the gate passed. Two of its eleven fields are deliberately
// unanswerable. If a future change makes this page stop being ready, the
// honest response is to report that as a finding about the pipeline — not to
// delete a field from the fixture.
//
// Run: node --test tests/security/honest-board.test.mjs
import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import {
  buildPlan,
  resolveFields,
  readiness,
} from "../../scripts/apply/fill-plan.mjs"
import { detectAts } from "../../scripts/apply/ats/index.mjs"
import fillPage from "../../scripts/apply/fill-engine.mjs"
import { start } from "../fixtures/boards/server.mjs"
import { runScanner } from "../fixtures/boards/dom.mjs"
import { recordingPage } from "./engine-double.mjs"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, "..", "..")
const SCANS = path.join(ROOT, "tests/fixtures/boards/scans")
const PROFILE = path.join(ROOT, "tests/fixtures/profile.yaml")
const ANSWERS = path.join(ROOT, "tests/fixtures/answers-bank.yaml")

// Real paths, not placeholders. buildPlan does not stat them, but a fixture
// that pointed at a file which does not exist would be claiming an upload it
// could not perform.
const FILES = {
  resume: path.join(ROOT, "tests/fixtures/boards/docs/resume.md"),
  cover: path.join(ROOT, "tests/fixtures/boards/docs/cover-letter.md"),
}

const scanFixture = (n) =>
  JSON.parse(fs.readFileSync(path.join(SCANS, `${n}.scan.json`), "utf8"))

// THE WHOLE PATH, run end to end: served page -> real scanner -> real adapter
// detection -> resolveFields -> buildPlan -> the real fill engine. Nothing is
// hand-assembled except the profile and the answer bank, which are the two
// things a test is supposed to supply.
async function driveHonestBoard({ scan, url }) {
  const adapter = detectAts(url)
  const resolved = resolveFields(scan.fields, {
    profile: PROFILE,
    answers: ANSWERS,
  })
  const plan = buildPlan({ scan, resolved, adapter, url, files: FILES })
  const page = recordingPage({ url: plan.urlGuard })
  const report = await fillPage(page, plan)
  return { adapter, resolved, plan, page, report, ready: readiness(plan) }
}

let board
let liveScan
let liveUrl
test.before(async () => {
  board = await start()
  liveUrl = board.pageUrl("honest-greenhouse")
  liveScan = await runScanner(await (await fetch(liveUrl)).text(), {
    url: liveUrl,
  })
})
test.after(async () => {
  await board?.stop()
})

test("an ordinary application form reaches ready:true — the fast path, demonstrated firing", async () => {
  // THE FINDING ASSERTION, and everything in it is in ONE deepEqual so that a
  // change which buys readiness by dropping a fill (or by planning a fill that
  // never runs) cannot pass. `ready` alone would be satisfied by an empty plan.
  const d = await driveHonestBoard({ scan: liveScan, url: liveUrl })
  assert.deepEqual(
    {
      adapter: d.adapter.id,
      ready: d.ready,
      fills: d.plan.items.filter((i) => i.how === "fill").length,
      uploads: d.plan.items.filter((i) => i.how === "upload").length,
      // Optional and unanswerable: left blank, which is what an applicant does.
      skips: d.plan.items.filter((i) => i.how === "skip").map((i) => i.label),
      // The whole point of ready:true — nothing needs a human first.
      defer: d.plan.defer,
      // And the engine actually did it. `report.ok` counts successful actions;
      // `failures` empty means no fill was planned that the engine could not
      // perform, which is the difference between a plan and an application.
      engineOk: d.report.ok,
      engineFailures: d.report.failures,
    },
    {
      adapter: "greenhouse",
      ready: { ready: true, reason: null },
      fills: 7,
      uploads: 2,
      skips: ["LinkedIn Profile", "Pronouns"],
      defer: [],
      engineOk: 9,
      engineFailures: [],
    },
    "the honest board stopped reaching ready:true. Do NOT fix this by trimming " +
      "the fixture — report which control now defers, and why, as a finding",
  )
})

test("ready:true is earned field by field: every value comes from the fact base, and the right one", async () => {
  // WHAT ready:true IS NOT: "the pipeline typed something everywhere". Rule 1
  // applies to a form exactly as it applies to a resume — a value that is not
  // in profile.yaml or answers.yaml must not appear on a page under the user's
  // name. So the provenance of each of the nine actions is asserted, not just
  // the count.
  //
  // f5 is the one worth reading twice: the label says "Location (City)" and the
  // profile says "Springfield, IL". "Springfield" is the correct answer to the
  // question asked, and it is the kind of derivation that is easy to get wrong
  // in the direction of pasting the whole string.
  const d = await driveHonestBoard({ scan: liveScan, url: liveUrl })
  const bySource = d.resolved
    .filter((r) => r.status === "OK")
    .map((r) => [r.k, r.source, r.value])
  assert.deepEqual(bySource, [
    ["f1", "contact.name", "Jane"],
    ["f2", "contact.name", "Test"],
    ["f3", "contact.email", "jane@test.example"],
    ["f4", "contact.phone", "(555) 123-4567"],
    ["f5", "contact.location", "Springfield"],
    ["f9", "contact.website", "https://janetest.example"],
    // The bank, by exact label — the path that makes an answer approved once
    // resolve silently on every later application to the same ATS.
    ["f11", "a-005@exact", "Job Board"],
  ])

  // And the two attachments went to the right slots, which on this page is
  // decided by adapter.fileFields matching the LABEL (Greenhouse's newer UI
  // labels them informatively) rather than by fileOrder. Both branches exist;
  // pages/greenhouse-step1.html covers the other one.
  assert.deepEqual(
    d.plan.items
      .filter((i) => i.how === "upload")
      .map((i) => [i.label, path.basename(i.paths[0])]),
    [
      ["Resume/CV *", "resume.md"],
      ["Cover Letter", "cover-letter.md"],
    ],
  )
})

test("the honest page is the ONLY board fixture that reaches ready:true, and the four that used to are all hostile", () => {
  // THE MEASUREMENT, re-run as an assertion rather than quoted from a report.
  // Command equivalent: build a plan for every *.scan.json with the GENERIC
  // adapter and no files, and print readiness().ready.
  //
  // Why the generic adapter and no files here, when the test above uses the
  // real ones: this row is about the CORPUS, not about any one page, and the
  // hostile fixtures have no adapter of their own. The honest page is listed
  // twice on purpose — under generic-and-no-files it is NOT ready (its two
  // uploads have nowhere to come from), which is itself the point: readiness
  // depends on the caller supplying rendered documents, and a test that hid
  // that would be overstating the fast path.
  const GENERIC = {
    id: "generic",
    comboStrategies: [],
    fileFields: [],
    fileOrder: [],
  }
  const rows = []
  for (const f of fs.readdirSync(SCANS).sort()) {
    if (!f.endsWith(".scan.json")) continue
    const s = scanFixture(f.replace(/\.scan\.json$/, ""))
    const resolved = resolveFields(s.fields, {
      profile: PROFILE,
      answers: ANSWERS,
    })
    const plan = buildPlan({ scan: s, resolved, adapter: GENERIC, url: s.url })
    if (readiness(plan).ready) rows.push(f.replace(/\.scan\.json$/, ""))
  }
  assert.deepEqual(
    rows.sort(),
    [
      // All four are hostile fixtures with one or two fields, kept ready on
      // purpose so the attack they carry is the only reason a plan could be
      // unsafe. None of them is evidence that the fast path works.
      "consent-decoupled",
      "destructive-combobox",
      "escalated-aria-checkbox",
      "mislabelled-escalated",
    ],
    "the set of fixtures reaching ready:true under the generic adapter moved — " +
      "if a hostile fixture joined it, check what stopped deferring",
  )
})

test("the honest fixture was not trimmed: two of its eleven fields are unanswerable, and a required one would block", async () => {
  // GUARDS THE FIXTURE AGAINST ITSELF. The cheap way to make a board reach
  // ready:true is to delete whatever defers, and the result looks identical in
  // a report. So: the page keeps fields the fact base cannot answer, and the
  // ONLY reason they do not block is that the form does not require them.
  //
  // Proved by flipping `req` on one of them — the same field, the same
  // unanswerable label, one attribute different — and watching readiness fall.
  // If this stops going false, the fixture has been made easy.
  const s = JSON.parse(JSON.stringify(liveScan))
  const unanswerable = s.fields.filter((f) =>
    ["LinkedIn Profile", "Pronouns"].includes(f.l),
  )
  assert.equal(unanswerable.length, 2, "the unanswerable fields were removed")
  unanswerable[0].req = true

  const d = await driveHonestBoard({ scan: s, url: liveUrl })
  assert.deepEqual(
    {
      ready: d.ready.ready,
      why: d.plan.defer.map((x) => [x.label, x.why]),
    },
    {
      ready: false,
      why: [["LinkedIn Profile", "unknown"]],
    },
    "an unanswerable REQUIRED field no longer blocks the fast path — that is a " +
      "finding about fill-plan.mjs, not about this fixture",
  )
})

test("the served page and the stored scan agree, so the assertions above are about the pipeline", async () => {
  // The bridge, stated locally rather than left to scan-fidelity.test.mjs. Every
  // assertion in this file runs over `liveScan`, which is produced by the real
  // scanner at test time — but the stored fixture is what the rest of the
  // directory reads, and a divergence between them would make this file's
  // ready:true claim true of a page nothing else ever sees.
  const stored = scanFixture("honest-greenhouse")
  const strip = (o) => {
    const { url, ...rest } = JSON.parse(
      JSON.stringify(o, (k, v) => (k.startsWith("_") ? undefined : v)),
    )
    return rest
  }
  assert.deepEqual(strip(stored), strip(liveScan))
})

test("nothing in this file can reach a real employer", async () => {
  // Rule, restated as a check. The honest fixture is the one page here that a
  // careless edit could point at a real board — it is the only one shaped like
  // a page somebody might want to "try against the real thing".
  const u = new URL(liveUrl)
  assert.ok(
    ["127.0.0.1", "::1", "localhost"].includes(u.hostname),
    `the honest board fixture is served from ${u.hostname}, which is not loopback`,
  )
  // And the greenhouse.io string that selects the adapter is in the PATH, never
  // in the host — that is the whole trick, and it is what keeps DNS out of it.
  assert.equal(u.hostname === "127.0.0.1", true)
  assert.match(u.pathname, /boards\.greenhouse\.io/)
  assert.equal(detectAts(liveUrl).id, "greenhouse")
})
