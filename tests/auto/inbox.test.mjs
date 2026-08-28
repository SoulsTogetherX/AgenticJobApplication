// Phase 4.3 — INBOX.md as an append-only alert channel.
//
// The defect being fixed is a single-line one with a large blast radius:
// raiseStop's FIRST-REASON-WINS rule is correct for the brake and wrong for
// notification. A benign STOP at job 3 leaves the brake file describing job 3
// forever, so a credential-exposure STOP at job 400 arrives as nothing at all —
// the user opens STOP, reads the benign reason, and deletes it.
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  raiseStop,
  appendInbox,
  raiseSecurityAlert,
  readStop,
  scopedStopPath,
} from "../../src/auto/guard.mjs"
import { toast } from "../../src/auto/notify.mjs"

function tree(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aj-inbox-"))
  t.after(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* a leaked handle must not fail a passing assertion */
    }
  })
  const jobsDir = path.join(dir, "jobs")
  fs.mkdirSync(path.join(jobsDir, ".auto"), { recursive: true })
  return {
    jobsDir,
    stopPath: path.join(jobsDir, ".auto", "STOP"),
    inboxPath: path.join(jobsDir, ".auto", "INBOX.md"),
    read: (p) => (fs.existsSync(p) ? fs.readFileSync(p, "utf8") : ""),
  }
}

const noToast = () => ({ attempted: false, reason: "test" })

test("a second STOP is invisible in the brake file and loud in the inbox", (t) => {
  const x = tree(t)
  const opts = { ...x, notify: noToast }

  assert.equal(raiseStop("a benign timeout at job 3", opts), true)
  assert.equal(
    raiseStop("CREDENTIAL EXPOSURE at job 400", opts),
    false,
    "the brake keeps the first reason — that part is correct and unchanged",
  )

  // The brake still names only the first anomaly.
  const stop = readStop({ stopPath: x.stopPath })
  assert.match(stop, /benign timeout at job 3/)
  assert.doesNotMatch(stop, /CREDENTIAL EXPOSURE/)

  // The inbox has both, in order, and says so about the second.
  const inbox = x.read(x.inboxPath)
  assert.match(inbox, /benign timeout at job 3/)
  assert.match(inbox, /CREDENTIAL EXPOSURE at job 400/)
  assert.ok(
    inbox.indexOf("benign timeout") < inbox.indexOf("CREDENTIAL EXPOSURE"),
    "append-only means oldest first",
  )
  assert.match(inbox, /A global STOP was ALREADY set here when this fired/)
})

test("first-reason-wins is PER KEY — one company's brake never buries another's", (t) => {
  // The suppression rule is right for the brake and would be a defect across
  // scopes: a company-scoped stop on acme is not evidence about globex, so it
  // must not be the reason globex's own brake goes unwritten.
  const x = tree(t)
  const opts = { ...x, notify: noToast }

  assert.equal(
    raiseStop("orphan at acme", { ...opts, scope: "company", key: "Acme" }),
    true,
  )
  assert.equal(
    raiseStop("orphan at globex", { ...opts, scope: "company", key: "Globex" }),
    true,
    "a different key is a different brake and gets written",
  )
  assert.equal(
    raiseStop("a later, blander acme reason", {
      ...opts,
      scope: "company",
      key: "acme",
    }),
    false,
    "the SAME key still keeps its first reason",
  )

  const acme = readStop({
    stopPath: scopedStopPath("company", "Acme", { stopPath: x.stopPath }),
  })
  assert.match(acme, /orphan at acme/)
  assert.doesNotMatch(acme, /blander/)
  assert.match(
    readStop({
      stopPath: scopedStopPath("company", "Globex", { stopPath: x.stopPath }),
    }),
    /orphan at globex/,
  )
  assert.equal(
    readStop({ stopPath: x.stopPath }),
    null,
    "and none of it touched the global brake",
  )
})

test("the inbox is append-only — nothing rewrites or truncates it", (t) => {
  const x = tree(t)
  appendInbox({ kind: "stop", summary: "first" }, x)
  const afterFirst = x.read(x.inboxPath)
  appendInbox({ kind: "security", summary: "second" }, x)
  const afterSecond = x.read(x.inboxPath)
  assert.ok(
    afterSecond.startsWith(afterFirst),
    "every earlier byte survives verbatim",
  )
  assert.match(afterSecond, /second/)
  // The header is written once, not per entry.
  assert.equal(afterSecond.match(/# Auto-path inbox/g).length, 1)
})

test("a security finding is reported without stopping anything", (t) => {
  const x = tree(t)
  raiseSecurityAlert(
    {
      summary: "2 instruction-shaped findings on acme-swe",
      slug: "acme-swe",
      findings: [{ kind: "instruction", count: 2 }],
    },
    x,
  )
  const inbox = x.read(x.inboxPath)
  assert.match(inbox, /SECURITY/)
  assert.match(inbox, /acme-swe/)
  assert.equal(
    fs.existsSync(x.stopPath),
    false,
    "rule 0's answer to hostile page text is sanitisation and deferral, not halting",
  )
})

test("the inbox carries kinds and counts, never the payload", (t) => {
  const x = tree(t)
  raiseSecurityAlert(
    {
      summary: "1 instruction-shaped finding on acme-swe",
      slug: "acme-swe",
      findings: [{ kind: "instruction", count: 1 }],
    },
    x,
  )
  const inbox = x.read(x.inboxPath)
  assert.match(inbox, /"kind": "instruction"/)
  assert.doesNotMatch(inbox, /IGNORE ALL PREVIOUS/i)
})

test("the alert channel cannot break its caller — it is mid-anomaly by definition", (t) => {
  const x = tree(t)
  // Pointed outside the boundary: refused, reported false, never thrown.
  assert.equal(
    appendInbox(
      { kind: "stop", summary: "x" },
      { inboxPath: path.join(os.tmpdir(), "escape.md"), jobsDir: x.jobsDir },
    ),
    false,
  )
  // And the brake still works when the inbox cannot be written.
  assert.equal(
    raiseStop("still stops", {
      ...x,
      inboxPath: path.join(os.tmpdir(), "escape.md"),
      notify: noToast,
    }),
    true,
  )
  assert.match(readStop({ stopPath: x.stopPath }), /still stops/)
})

test("a toast failure never reaches the brake", (t) => {
  const x = tree(t)
  const explode = () => {
    throw new Error("no notification subsystem")
  }
  assert.equal(
    raiseStop("brake wins", { ...x, notify: explode }),
    true,
    "a cosmetic notification must not be able to prevent a stop",
  )
  assert.match(readStop({ stopPath: x.stopPath }), /brake wins/)
})

test("toast is inert under the test runner and on non-Windows, and never throws", () => {
  assert.equal(
    toast("t", "b", { env: { NODE_TEST_CONTEXT: "1" } }).attempted,
    false,
  )
  assert.equal(toast("t", "b", { env: { AJ_NO_TOAST: "1" } }).attempted, false)
  const linux = toast("t", "b", { platform: "linux", env: {} })
  assert.equal(linux.attempted, false)
  assert.match(linux.reason, /no toast backend for linux/)
})
