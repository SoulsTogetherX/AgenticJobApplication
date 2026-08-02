import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  authorizeSubmit,
  consumeSubmitToken,
  assertTokenMatches,
  isSubmitToken,
  tokenSpent,
  planSha256,
  screeningFindingKinds,
  SUBMIT_CHECKS,
  AuthorizationInputError,
  TokenError,
} from "../../scripts/auto/authorize.mjs"
import { StopError } from "../../scripts/auto/guard.mjs"
import { openDb, upsertApplications } from "../../scripts/lib/db.mjs"
import { startRun } from "../../scripts/auto/audit.mjs"

// --- fixtures ----------------------------------------------------------------

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aj-authz-"))
  const jobsDir = path.join(root, "jobs")
  const autoDir = path.join(jobsDir, ".auto")
  const profileDir = path.join(root, "profile")
  fs.mkdirSync(autoDir, { recursive: true })
  fs.mkdirSync(profileDir, { recursive: true })
  fs.writeFileSync(path.join(profileDir, "profile.yaml"), "name: x\n")
  fs.writeFileSync(path.join(profileDir, "answers.yaml"), "answers: []\n")
  return {
    root,
    jobsDir,
    autoDir,
    profileDir,
    dbFile: path.join(jobsDir, "leads.db"),
    stopPath: path.join(autoDir, "STOP"),
    runOpts: { autoDir, profileDir, dbFile: path.join(jobsDir, "leads.db") },
  }
}

// A plan with one fillable field, nothing deferred: the only shape that is
// allowed anywhere near an unattended submit.
const readyPlan = () => ({
  v: 1,
  slug: "acme-dev",
  items: [{ k: "name", label: "Full name", how: "fill", value: "X" }],
  defer: [],
})

// The user's SHIPPED block, verbatim from docs/application-limits.yaml, with
// enabled flipped per test. Their caps are 999/999/5 — not the plan's 3/5/1.
const enabledConfig = (over = {}) => ({
  enabled: true,
  dry_run: false,
  per_run_max: 999,
  per_day_max: 999,
  per_company_max_per_week: 5,
  ...over,
})

const passingScreen = () => ({
  ok: true,
  stage: null,
  reasons: [],
  flags: [],
  risk_signals: [],
})

function input(s, over = {}) {
  const plan = over.plan ?? readyPlan()
  return {
    lead: { slug: "acme-dev", company: "Acme", apply_url: "https://b.test/1" },
    plan,
    planSha: planSha256(plan),
    report: null,
    config: enabledConfig(),
    trustVerdict: { ok: true, reason: "allowlisted ATS: greenhouse" },
    screening: passingScreen(),
    sentThisRun: 0,
    runId: "r-1",
    dbFile: s.dbFile,
    stopPath: s.stopPath,
    jobsDir: s.jobsDir,
    ...over,
  }
}

const named = (r, name) => r.checks.find((c) => c.name === name)

// --- the happy path ----------------------------------------------------------

test("a fully cleared application yields a frozen token bound to slug, plan and mode", () => {
  const s = sandbox()
  const inp = input(s)
  const token = authorizeSubmit(inp)

  assert.equal(token.deferred, false)
  assert.equal(isSubmitToken(token), true)
  assert.equal(token.slug, "acme-dev")
  assert.equal(token.planSha, inp.planSha)
  assert.equal(token.mode, "live")
  assert.equal(token.runId, "r-1")
  assert.ok(Object.isFrozen(token))
  assert.throws(
    () => {
      "use strict"
      token.mode = "live"
    },
    TypeError,
    "a token whose mode can be rewritten authorises nothing",
  )
})

test("the mode comes from the user's file, never from the caller", () => {
  const s = sandbox()
  assert.equal(authorizeSubmit(input(s)).mode, "live")
  assert.equal(
    authorizeSubmit(input(s, { config: enabledConfig({ dry_run: true }) }))
      .mode,
    "dry_run",
    "dry_run: true is a rehearsal token, whatever the runner thinks it is doing",
  )
})

test("every check is evaluated and reported, even after one fails", () => {
  const s = sandbox()
  const r = authorizeSubmit(
    input(s, { config: enabledConfig({ enabled: false }) }),
  )
  assert.equal(r.deferred, true)
  assert.deepEqual(
    r.checks.map((c) => c.name),
    [...SUBMIT_CHECKS],
    "a dry-run report is only readable if the other checks ran too",
  )
  assert.deepEqual(r.failed, ["enabled"])
  for (const n of SUBMIT_CHECKS)
    if (n !== "enabled")
      assert.equal(
        named(r, n).ok,
        true,
        `${n} should still have been evaluated`,
      )
})

// --- the switch --------------------------------------------------------------

test("auto_apply.enabled is read STRICTLY: only true is true", () => {
  const s = sandbox()
  for (const v of [false, undefined, null, "true", 1, "yes", {}]) {
    const cfg = enabledConfig()
    if (v === undefined) delete cfg.enabled
    else cfg.enabled = v
    const r = authorizeSubmit(input(s, { config: cfg }))
    assert.equal(r.deferred, true, `enabled=${JSON.stringify(v)} must defer`)
    assert.match(r.reason, /^enabled: /)
  }
})

test("no auto_apply block at all defers, and says whose file it is", () => {
  const s = sandbox()
  const r = authorizeSubmit(input(s, { config: null }))
  assert.equal(r.deferred, true)
  assert.match(r.reason, /no auto_apply block/)
  assert.match(r.reason, /no agent edits that file/)
})

test("a non-boolean dry_run is not interpreted", () => {
  const s = sandbox()
  for (const v of ["false", 0, undefined]) {
    const cfg = enabledConfig()
    if (v === undefined) delete cfg.dry_run
    else cfg.dry_run = v
    const r = authorizeSubmit(input(s, { config: cfg }))
    assert.equal(r.deferred, true)
    assert.equal(r.mode, null)
    assert.equal(named(r, "mode").ok, false)
  }
})

// --- the trust gate (wave B supplies the verdict; the slot exists now) --------

test("an untrusted board defers with the gate's own reason", () => {
  const s = sandbox()
  const r = authorizeSubmit(
    input(s, {
      trustVerdict: { ok: false, reason: "board not on the allowlist" },
    }),
  )
  assert.equal(r.deferred, true)
  assert.match(r.reason, /trust_gate: .*not on the allowlist/)
})

test("a missing or malformed trust verdict THROWS — it never defers", () => {
  const s = sandbox()
  for (const v of [undefined, null, {}, { ok: "yes" }, true]) {
    const inp = input(s)
    inp.trustVerdict = v
    assert.throws(
      () => authorizeSubmit(inp),
      AuthorizationInputError,
      `trustVerdict=${JSON.stringify(v)} must throw, because a defer reads as a considered decision`,
    )
  }
})

// --- the screening verdict ---------------------------------------------------

test("an unscreened lead defers rather than being assumed safe", () => {
  const s = sandbox()
  const r = authorizeSubmit(input(s, { screening: null }))
  assert.equal(r.deferred, true)
  assert.match(r.reason, /screening: no stored/)
})

test("a stage rejection defers and carries the stage and its reasons", () => {
  const s = sandbox()
  const r = authorizeSubmit(
    input(s, {
      screening: {
        ok: false,
        stage: "l3",
        reasons: ["scam_signals:fee_request"],
      },
    }),
  )
  assert.equal(r.deferred, true)
  assert.match(r.reason, /screening rejected at l3: scam_signals:fee_request/)
})

test("an instruction-shaped finding defers, whichever carrier it arrived in", () => {
  const s = sandbox()
  const carriers = [
    { ...passingScreen(), findings: [{ kind: "override_instructions" }] },
    { ...passingScreen(), risk_signals: ["injection:override_instructions"] },
    {
      ...passingScreen(),
      reasons: ["injection_attempt:override_instructions"],
    },
    {
      ...passingScreen(),
      stages: { l3: { risk_signals: ["injection:override_instructions"] } },
    },
  ]
  for (const screening of carriers) {
    const r = authorizeSubmit(input(s, { screening }))
    assert.equal(r.deferred, true, JSON.stringify(screening))
    assert.match(r.reason, /instruction-shaped text/)
    assert.match(r.reason, /hard rule 0/)
  }
})

test("a merely messy finding does not defer — a CMS emits those", () => {
  const s = sandbox()
  const screening = {
    ...passingScreen(),
    risk_signals: ["injection:hidden_html", "injection:invisible_characters"],
  }
  const r = authorizeSubmit(input(s, { screening }))
  assert.equal(r.deferred, false, "hidden HTML alone is messy, not hostile")
})

test("screeningFindingKinds reads all four carriers and de-duplicates", () => {
  const kinds = screeningFindingKinds({
    findings: ["a", { kind: "b" }],
    risk_signals: ["injection:b", "repost_count:3"],
    reasons: ["injection_attempt:c+d", "stale_posting"],
    stages: { l3: { findings: [{ kind: "e" }] } },
  })
  assert.deepEqual(kinds.sort(), ["a", "b", "c", "d", "e"])
})

// --- the plan ----------------------------------------------------------------

test("a deferred field blocks the submit, and OUR OWN key is the one that fires", () => {
  const s = sandbox()
  const plan = {
    ...readyPlan(),
    defer: [
      { k: "auth", label: "Are you authorised to work?", why: "confirm" },
    ],
  }
  const r = authorizeSubmit(input(s, { plan, planSha: planSha256(plan) }))
  assert.equal(r.deferred, true)
  assert.match(r.reason, /^plan_defer: /)
  assert.match(r.reason, /Are you authorised to work\?/)
  assert.equal(
    named(r, "plan_defer").ok,
    false,
    "this assertion is independent of submitReadiness on purpose: a future " +
      "relaxation there must not widen the unattended gate",
  )
})

test("submitReadiness still gates independently of the defer count", () => {
  const s = sandbox()
  // Zero defers, so plan_defer PASSES — and the fill revealed a field the plan
  // never knew about, which only submitReadiness can see.
  const r = authorizeSubmit(input(s, { report: { revealed: [{ k: "x" }] } }))
  assert.equal(named(r, "plan_defer").ok, true)
  assert.equal(named(r, "submit_readiness").ok, false)
  assert.equal(r.deferred, true)
  assert.match(r.reason, /^submit_readiness: /)
})

test("a plan with nothing fillable is not a submittable plan", () => {
  const s = sandbox()
  const plan = { ...readyPlan(), items: [{ k: "x", how: "skip" }] }
  const r = authorizeSubmit(input(s, { plan, planSha: planSha256(plan) }))
  assert.equal(r.deferred, true)
  assert.match(r.reason, /nothing to fill/)
})

// --- the caps ----------------------------------------------------------------

test("the company cap defers at the user's shipped number, counting both ledgers", () => {
  const s = sandbox()
  const db = openDb(s.dbFile)
  try {
    upsertApplications(
      db,
      ["m1", "m2", "m3", "m4", "m5"].map((slug) => ({
        slug,
        company: "Acme",
        title: "x",
        applied_at: new Date().toISOString(),
        status: "applied",
      })),
    )
  } finally {
    db.close()
  }
  const r = authorizeSubmit(input(s))
  assert.equal(r.deferred, true)
  assert.match(
    r.reason,
    /^caps: per_company_max_per_week reached for Acme \(5\/5\)/,
  )
  assert.match(r.reason, /5 applied manually/)
})

test("per_run_max is enforced from the run's own counter", () => {
  const s = sandbox()
  const r = authorizeSubmit(
    input(s, { config: enabledConfig({ per_run_max: 2 }), sentThisRun: 2 }),
  )
  assert.equal(r.deferred, true)
  assert.match(r.reason, /per_run_max reached \(2\/2\)/)
})

test("a lead with no company defers instead of skipping the company cap", () => {
  // Silently counting against the empty string would disable the one cap whose
  // failure costs the user their reputation.
  const s = sandbox()
  const r = authorizeSubmit(
    input(s, { lead: { slug: "acme-dev", apply_url: "https://b.test/1" } }),
  )
  assert.equal(r.deferred, true)
  assert.match(r.reason, /^company_known: /)
  assert.equal(named(r, "caps").ok, false, "and the caps are not waved through")
})

// --- the kill switch ---------------------------------------------------------

test("STOP is read after every other check, and it THROWS rather than defers", () => {
  const s = sandbox()
  fs.writeFileSync(s.stopPath, "user pulled the brake")
  assert.throws(
    () => authorizeSubmit(input(s)),
    (e) => e instanceof StopError && e.checkpoint === "pre-submit",
    "a defer would let the run continue through a switch the user pulled",
  )
})

test("no token is ever minted while STOP is set", () => {
  const s = sandbox()
  const inp = input(s)
  assert.ok(authorizeSubmit(inp).planSha, "clear first")
  fs.writeFileSync(s.stopPath, "")
  let minted = null
  try {
    minted = authorizeSubmit(inp)
  } catch {}
  assert.equal(minted, null)
})

// --- the token as a capability -----------------------------------------------

test("consumeSubmitToken reads the switch, and that read is the pre-click one", () => {
  // The gate's own read happens before beginSubmit writes the intent row, which
  // costs an openDb/INSERT/close. This one has nothing between it and the
  // caller's click.
  const s = sandbox()
  const inp = input(s)
  const token = authorizeSubmit(inp)
  const spec = {
    slug: "acme-dev",
    planSha: inp.planSha,
    mode: "live",
    stopPath: s.stopPath,
  }

  fs.writeFileSync(s.stopPath, "pulled during the window")
  assert.throws(
    () => consumeSubmitToken(token, spec),
    (e) => e instanceof StopError && e.checkpoint === "pre-submit",
  )
  assert.equal(
    tokenSpent(token),
    false,
    "a token refused by the switch is not burned — the click never happened",
  )

  fs.rmSync(s.stopPath)
  assert.equal(consumeSubmitToken(token, spec), token)
})

test("assertTokenMatches checks without spending", () => {
  const s = sandbox()
  const inp = input(s)
  const token = authorizeSubmit(inp)
  const spec = {
    slug: "acme-dev",
    planSha: inp.planSha,
    mode: "live",
    stopPath: s.stopPath,
  }

  assertTokenMatches(token, spec)
  assertTokenMatches(token, spec)
  assert.equal(tokenSpent(token), false, "beginSubmit must not burn the click")
  assert.throws(
    () => assertTokenMatches(token, { ...spec, mode: "dry_run" }),
    TokenError,
  )
  assert.equal(consumeSubmitToken(token, spec), token)
})

test("consumeSubmitToken spends the token exactly once", () => {
  const s = sandbox()
  const inp = input(s)
  const token = authorizeSubmit(inp)
  const spec = {
    slug: "acme-dev",
    planSha: inp.planSha,
    mode: "live",
    stopPath: s.stopPath,
  }

  assert.equal(consumeSubmitToken(token, spec), token)
  assert.equal(tokenSpent(token), true)
  assert.throws(
    () => consumeSubmitToken(token, spec),
    (e) => e instanceof TokenError && /already been spent/.test(e.message),
  )
})

test("a token cannot be manufactured, forged or borrowed", () => {
  const s = sandbox()
  const inp = input(s)
  const real = authorizeSubmit(inp)
  const spec = {
    slug: "acme-dev",
    planSha: inp.planSha,
    mode: "live",
    stopPath: s.stopPath,
  }

  for (const fake of [
    undefined,
    null,
    {},
    { ok: true },
    { kind: "aj.submit-authorization", deferred: true },
    // Hand-built and shape-perfect, with a nonce nobody issued.
    { ...real, nonce: "deadbeefdeadbeef" },
  ]) {
    assert.throws(
      () => consumeSubmitToken(fake, spec),
      TokenError,
      `${JSON.stringify(fake)} must not authorise a click`,
    )
  }
  assert.equal(tokenSpent(real), false, "and none of that spent the real one")
})

test("a spread COPY of a spent token does not buy a second click", () => {
  // The hole this closes, found while writing the test above: the first draft
  // keyed the spend ledger on object identity, so `{...token}` was a fresh
  // identity carrying a valid authorisation. The nonce survives the copy.
  const s = sandbox()
  const inp = input(s)
  const token = authorizeSubmit(inp)
  const spec = {
    slug: "acme-dev",
    planSha: inp.planSha,
    mode: "live",
    stopPath: s.stopPath,
  }

  consumeSubmitToken(token, spec)
  assert.throws(
    () => consumeSubmitToken({ ...token }, spec),
    (e) =>
      e instanceof TokenError &&
      /already been spent, was copied/.test(e.message),
  )
})

test("a token for one job cannot submit another, or a plan that changed", () => {
  const s = sandbox()
  const inp = input(s)
  const token = authorizeSubmit(inp)
  assert.throws(
    () =>
      consumeSubmitToken(token, {
        slug: "other-job",
        planSha: inp.planSha,
        mode: "live",
        stopPath: s.stopPath,
      }),
    /is for "acme-dev"/,
  )
  assert.throws(
    () =>
      consumeSubmitToken(token, {
        slug: "acme-dev",
        planSha: planSha256({ tampered: true }),
        mode: "live",
        stopPath: s.stopPath,
      }),
    /bound to plan/,
  )
  assert.equal(tokenSpent(token), false, "a rejected spend is not a spend")
})

test("a dry-run token cannot be spent on a live click", () => {
  // This is what makes `dry_run: true` mechanical rather than advisory.
  const s = sandbox()
  const inp = input(s, { config: enabledConfig({ dry_run: true }) })
  const token = authorizeSubmit(inp)
  assert.equal(token.mode, "dry_run")
  assert.throws(
    () =>
      consumeSubmitToken(token, {
        slug: "acme-dev",
        planSha: inp.planSha,
        mode: "live",
      }),
    (e) =>
      e instanceof TokenError &&
      /dry_run run, but a live submit/.test(e.message),
  )
})

test("the token drives beginSubmit, and the run's mode must agree with it", () => {
  const s = sandbox()
  const inp = input(s, { config: enabledConfig({ dry_run: true }) })
  const token = authorizeSubmit(inp)

  const dryRun = startRun({ mode: "dry_run", ...s.runOpts })
  assert.ok(
    dryRun.beginSubmit(
      { slug: "acme-dev", company: "Acme" },
      inp.planSha,
      "https://b.test/1",
      token, // POSITIONAL and required — the runner's contract, item 3
    ),
  )
  dryRun.recordSubmission({
    slug: "acme-dev",
    company: "Acme",
    title: "Dev",
    plan_sha256: inp.planSha,
    verify: { ok: true },
    consent_labels: [],
    screenshots: { before: "b.png", after: "a.png" },
    confirmation_url: "https://b.test/done",
  })
  dryRun.finish()

  const liveRun = startRun({ mode: "live", ...s.runOpts })
  assert.throws(
    () => liveRun.beginSubmit({ slug: "acme-dev" }, inp.planSha, "u", token),
    /is for a dry_run run, but a live submit was attempted/,
    "the run's mode is checked against the mode from the user's file",
  )
})

// --- programmer errors throw; they never defer -------------------------------

test("a missing or malformed input throws, and names what is wrong", () => {
  const s = sandbox()
  const cases = [
    [undefined, /input must be an object/],
    [{}, /lead must be an object/],
    [{ ...input(s), lead: { slug: "  " } }, /non-empty slug/],
    [{ ...input(s), plan: null }, /plan must be an object/],
    [{ ...input(s), planSha: "short" }, /64-character sha256/],
    [{ ...input(s), planSha: "A".repeat(64) }, /64-character sha256/],
    [{ ...input(s), sentThisRun: -1 }, /non-negative integer/],
    [{ ...input(s), sentThisRun: 1.5 }, /non-negative integer/],
    [{ ...input(s), config: 7 }, /config must be the auto_apply object/],
    [
      { ...input(s), screening: "clean" },
      /screening must be the evaluateStages/,
    ],
  ]
  for (const [inp, re] of cases) {
    assert.throws(() => authorizeSubmit(inp), AuthorizationInputError)
    assert.throws(() => authorizeSubmit(inp), re)
  }
})

test("an ABSENT config or screening key throws; an explicit null defers", () => {
  const s = sandbox()
  const noConfig = input(s)
  delete noConfig.config
  assert.throws(() => authorizeSubmit(noConfig), /config is required/)

  const noScreening = input(s)
  delete noScreening.screening
  assert.throws(() => authorizeSubmit(noScreening), /screening is required/)

  assert.equal(authorizeSubmit(input(s, { config: null })).deferred, true)
  assert.equal(authorizeSubmit(input(s, { screening: null })).deferred, true)
})

test("planSha256 is stable and discriminating", () => {
  const a = readyPlan()
  assert.equal(planSha256(a), planSha256(readyPlan()))
  assert.notEqual(planSha256(a), planSha256({ ...a, defer: [{ k: "x" }] }))
  assert.match(planSha256(a), /^[0-9a-f]{64}$/)
})
