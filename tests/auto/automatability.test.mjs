import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import {
  classify,
  classifyAll,
  boardKey,
  shapesForBoard,
  shapeBlockers,
  tierCounts,
  TIERS,
  DEFAULT_CACHE_MAX_AGE_DAYS,
} from "../../scripts/apply/automatability.mjs"
import { STAGE_IDS } from "../../scripts/leads/stages.mjs"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SOURCE = fs.readFileSync(
  path.resolve(HERE, "../../scripts/apply/automatability.mjs"),
  "utf8",
)

const GH_URL = "https://boards.greenhouse.io/acme/jobs/1001"
const today = () => new Date("2026-07-31T12:00:00Z")
const isoDay = (daysAgo) =>
  new Date(today().getTime() - daysAgo * 86400_000).toISOString().slice(0, 10)

// A remembered form shape. Keys are `label|type`, exactly as field-cache.mjs
// writes them, so predictedFields() and resolveFields() line up with it.
function cacheWith(
  fields,
  { ats = "greenhouse", url = GH_URL, updated = isoDay(1) } = {},
) {
  return { v: 3, forms: { fp1: { ats, url, updated, fields } } }
}

const TEXT_FORM = {
  "first name|text": { t: "text", l: "First name", req: true },
  "email|text": { t: "text", l: "Email", req: true },
}

// Resolutions keyed as predictedFields keys them: `${fingerprint}:${fieldKey}`.
const settled = (...keys) =>
  new Map(
    keys.map((k) => [`fp1:${k}`, { k: `fp1:${k}`, status: "OK", value: "x" }]),
  )

const ALL_TEXT_SETTLED = settled("first name|text", "email|text")

const OK_CTX = {
  cache: cacheWith(TEXT_FORM),
  resolvedByKey: ALL_TEXT_SETTLED,
  profileApproved: true,
  hasVerifiedResume: true,
  alreadyApplied: false,
  stages: { ok: true, stage: null, reasons: [] },
  now: today(),
}

const lead = (over = {}) => ({
  id: "l1",
  company: "Acme",
  title: "Full-Stack Developer",
  apply_url: GH_URL,
  ...over,
})

// --- the thing that must never happen ---------------------------------------

test("automatability is NOT a screening stage — nothing here can dismiss a lead", () => {
  assert.deepEqual(STAGE_IDS, ["l0", "l1", "l2", "l3"], "no l4 was added")
  assert.doesNotMatch(
    SOURCE,
    /registerStage/,
    "registering as a stage turns 'the engine cannot do this alone' into 'the user never sees this job'",
  )
  // And the tier vocabulary contains no rejection: the worst a lead gets is
  // `blocked`, which is a statement about US and is visible to the user.
  assert.deepEqual(TIERS, ["handoff", "blocked", "amber", "green"])
})

test("L2 fit is not consulted — the stage list this module expects excludes it", () => {
  assert.match(
    SOURCE,
    /\["l0", ?"l1", ?"l3"\]/,
    "the runner must pass only l0/l1/l3",
  )
  // A slim-chance job is still applied to; only scams and stale postings gate.
  const r = classify(lead(), {
    ...OK_CTX,
    stages: { ok: true, stage: null, reasons: [], fit_score: 0.05 },
  })
  assert.equal(r.tier, "green", "a poor fit is not a reason to refuse to apply")
})

// --- handoff -----------------------------------------------------------------

test("a Workday posting is handoff, not blocked and not hidden", () => {
  const r = classify(
    lead({
      apply_url: "https://acme.wd1.myworkdayjobs.com/en-US/careers/job/Dev_R1",
    }),
    OK_CTX,
  )
  assert.equal(r.tier, "handoff")
  assert.match(r.reason, /requires creating an account/)
})

test("handoff wins over every blocked condition, so the user is told WHY", () => {
  const r = classify(
    lead({
      apply_url: "https://acme.wd1.myworkdayjobs.com/en-US/careers/job/Dev_R1",
    }),
    {
      ...OK_CTX,
      profileApproved: false,
      alreadyApplied: true,
      hasVerifiedResume: false,
    },
  )
  assert.equal(r.tier, "handoff")
})

// --- blocked -----------------------------------------------------------------

test("an unapproved fact base blocks everything", () => {
  const r = classify(lead(), { ...OK_CTX, profileApproved: false })
  assert.equal(r.tier, "blocked")
  assert.match(r.reason, /approved_by_user/)
})

test("already applied blocks, and says so", () => {
  const r = classify(lead(), { ...OK_CTX, alreadyApplied: true })
  assert.equal(r.tier, "blocked")
  assert.match(r.reason, /already applied/)
})

test("no verified resume blocks — the runner cannot tailor", () => {
  const r = classify(lead(), { ...OK_CTX, hasVerifiedResume: false })
  assert.equal(r.tier, "blocked")
  assert.match(r.reason, /verify-claims-passed resume/)
})

test("an L3 risk rejection blocks and names the stage that decided", () => {
  const r = classify(lead(), {
    ...OK_CTX,
    stages: { ok: false, stage: "l3", reasons: ["l3: scam signals"] },
  })
  assert.equal(r.tier, "blocked")
  assert.match(r.reason, /l3.*scam signals/)
  assert.equal(r.evidence.stage, "l3")
})

test("a lead with no application URL is blocked, never green", () => {
  const r = classify({ id: "x", company: "A", title: "B" }, OK_CTX)
  assert.equal(r.tier, "blocked")
  assert.match(r.reason, /no application URL/)
})

// --- amber -------------------------------------------------------------------

test("an unscreened lead is amber, not green — unknown is never treated as safe", () => {
  const r = classify(lead(), { ...OK_CTX, stages: null })
  assert.equal(r.tier, "amber")
  assert.match(r.reason, /screening has not been run/)
})

test("a generic ATS is amber: no adapter means the form is unmapped", () => {
  const r = classify(
    lead({ apply_url: "https://careers.example.com/apply/9" }),
    OK_CTX,
  )
  assert.equal(r.tier, "amber")
  assert.match(r.reason, /generic ATS/)
})

test("a board that has never been scanned is amber", () => {
  const r = classify(
    lead({ apply_url: "https://boards.greenhouse.io/other/jobs/7" }),
    OK_CTX,
  )
  assert.equal(r.tier, "amber")
  assert.match(r.reason, /never been scanned/)
})

test("a stale remembered shape is amber", () => {
  const r = classify(lead(), {
    ...OK_CTX,
    cache: cacheWith(TEXT_FORM, {
      updated: isoDay(DEFAULT_CACHE_MAX_AGE_DAYS + 5),
    }),
  })
  assert.equal(r.tier, "amber")
  assert.match(r.reason, /days old/)
})

test("a remembered shape with no recorded date is amber", () => {
  // Built by hand rather than through cacheWith: an entry from before the cache
  // stored `updated` has the key ABSENT, and a helper with a default date would
  // quietly supply one and test nothing.
  const cache = {
    v: 3,
    forms: { fp1: { ats: "greenhouse", url: GH_URL, fields: TEXT_FORM } },
  }
  assert.equal("updated" in cache.forms.fp1, false)
  const r = classify(lead(), { ...OK_CTX, cache })
  assert.equal(r.tier, "amber")
  assert.match(r.reason, /no recorded date/)
})

// --- the two rules that are stricter than the original plan -------------------

test("a CHECKBOX in the remembered shape can never be green, whatever the bank holds", () => {
  const cache = cacheWith({
    ...TEXT_FORM,
    "are you legally authorized to work in the us?|checkbox": {
      t: "checkbox",
      l: "Are you legally authorized to work in the US?",
      req: true,
    },
  })
  const r = classify(lead(), {
    ...OK_CTX,
    cache,
    // Deliberately: the fact base DOES settle it. That is exactly the condition
    // that used to auto-tick 34 boxes.
    resolvedByKey: settled(
      "first name|text",
      "email|text",
      "are you legally authorized to work in the us?|checkbox",
    ),
  })
  assert.equal(r.tier, "amber")
  assert.match(r.reason, /checkbox group present/)
  assert.match(r.reason, /assent, not a value/)
})

test("a RADIO group is treated identically to a checkbox", () => {
  const cache = cacheWith({
    ...TEXT_FORM,
    "gender|radio": { t: "radio", l: "Gender", req: false },
  })
  const r = classify(lead(), { ...OK_CTX, cache })
  assert.equal(r.tier, "amber")
  assert.match(r.reason, /radio group present/)
})

test("an OPTIONAL widget still blocks green — submitReadiness allows no defer at all", () => {
  const cache = cacheWith({
    ...TEXT_FORM,
    "subscribe to updates|checkbox": {
      t: "checkbox",
      l: "Subscribe to updates",
      req: false,
    },
  })
  assert.equal(classify(lead(), { ...OK_CTX, cache }).tier, "amber")
})

test("a consent tickbox can never be green — those stay the user's, always", () => {
  const cache = cacheWith({
    ...TEXT_FORM,
    "i agree to the privacy policy|checkbox": {
      t: "checkbox",
      l: "I agree to the privacy policy",
      req: true,
    },
  })
  const r = classify(lead(), { ...OK_CTX, cache })
  assert.equal(r.tier, "amber")
  assert.match(r.reason, /consent tickbox present/)
})

test("consent is caught by SHAPE too, on wording no topic list contains", () => {
  // A long single tickbox ending like a sentence: looksLikeAgreementProse's
  // door, which needs no topic word at all. The 26th rewording is free, so a
  // topic match alone would never be enough.
  const label =
    "By ticking this box I confirm that the information I have provided in this " +
    "application is complete and correct to the best of my knowledge and belief."
  const cache = cacheWith({
    [`${label.toLowerCase()}|checkbox`]: { t: "checkbox", l: label, req: true },
    ...TEXT_FORM,
  })
  const r = classify(lead(), { ...OK_CTX, cache })
  assert.equal(r.tier, "amber")
  assert.match(r.reason, /consent tickbox present|checkbox group present/)
})

test("this module cannot tick anything: it emits no plan and no fill verbs", () => {
  // A source-text check on the WORD "consent_allowlist" would be tripped by
  // this file's own prose explaining why there is no allowlist, which is a
  // test asserting a comment. What is worth asserting is that nothing here
  // can produce an ACT: no plan items, no fill verbs, no board-supplied vouch.
  assert.doesNotMatch(
    SOURCE,
    /how:\s*["']check["']/,
    "no check verb is ever emitted",
  )
  assert.doesNotMatch(SOURCE, /items\.push/, "this module builds no fill plan")
  assert.doesNotMatch(
    SOURCE,
    /\.labelExact/,
    "a vouch that travelled through a board-shaped file is never read here",
  )
  // And the return shape carries a verdict only — nothing an engine could run.
  const r = classify(lead(), OK_CTX)
  assert.deepEqual(Object.keys(r).sort(), ["evidence", "reason", "tier"])
})

// --- required-field settlement ----------------------------------------------

test("a required field the fact base cannot answer is amber", () => {
  const r = classify(lead(), {
    ...OK_CTX,
    resolvedByKey: settled("first name|text"),
  })
  assert.equal(r.tier, "amber")
  assert.match(r.reason, /required field "Email" is unresolved/)
})

test("a CONFIRM resolution is amber — an asserted answer is not a settled one", () => {
  const resolved = new Map(ALL_TEXT_SETTLED)
  resolved.set("fp1:email|text", {
    k: "fp1:email|text",
    status: "CONFIRM",
    value: "x",
  })
  const r = classify(lead(), { ...OK_CTX, resolvedByKey: resolved })
  assert.equal(r.tier, "amber")
  assert.match(r.reason, /is confirm/)
})

test("NEEDS-CHOICE and MAYBE are amber too", () => {
  for (const status of ["NEEDS-CHOICE", "MAYBE", "UNKNOWN"]) {
    const resolved = new Map(ALL_TEXT_SETTLED)
    resolved.set("fp1:email|text", { k: "fp1:email|text", status })
    assert.equal(
      classify(lead(), { ...OK_CTX, resolvedByKey: resolved }).tier,
      "amber",
      `${status} must not be green`,
    )
  }
})

test("a required field matched against a TRUNCATED option list is amber", () => {
  const cache = cacheWith({
    ...TEXT_FORM,
    "country|combo": {
      t: "combo",
      l: "Country",
      req: true,
      opts: ["A", "B"],
      optsTruncated: true,
    },
  })
  const r = classify(lead(), {
    ...OK_CTX,
    cache,
    resolvedByKey: settled("first name|text", "email|text", "country|combo"),
  })
  assert.equal(r.tier, "amber")
  assert.match(r.reason, /truncated option list/)
})

test("an optional field the fact base cannot answer does NOT block green", () => {
  const cache = cacheWith({
    ...TEXT_FORM,
    "linkedin|text": { t: "text", l: "LinkedIn", req: false },
  })
  // buildPlan turns an optional unresolved field into a `how: "skip"` ITEM, not
  // a defer, so it costs nothing at the real gate either.
  assert.equal(classify(lead(), { ...OK_CTX, cache }).tier, "green")
})

// --- green -------------------------------------------------------------------

test("green: known adapter, fresh shape, every required field settled, no widgets", () => {
  const r = classify(lead(), OK_CTX)
  assert.equal(r.tier, "green")
  assert.equal(r.evidence.ats, "greenhouse")
  assert.equal(r.evidence.shapes, 1)
})

test("green requires EVERY remembered variant of the board to be automatable", () => {
  const cache = cacheWith(TEXT_FORM)
  // A second variant of the same board, this one with a consent box. We cannot
  // know which the posting will render until the page is open.
  cache.forms.fp2 = {
    ats: "greenhouse",
    url: GH_URL,
    updated: isoDay(1),
    fields: {
      "i agree to the terms|checkbox": {
        t: "checkbox",
        l: "I agree to the terms",
        req: true,
      },
    },
  }
  const r = classify(lead(), { ...OK_CTX, cache })
  assert.equal(r.evidence.shapes, 2)
  assert.equal(r.tier, "amber")
})

// --- board identity ----------------------------------------------------------

test("boardKey separates two employers on the same embedded Greenhouse host", () => {
  const tebra = boardKey(
    "https://job-boards.greenhouse.io/embed/job_app?for=tebra&jr_id=1",
  )
  const coinbase = boardKey(
    "https://job-boards.greenhouse.io/embed/job_app?token=8&for=coinbase&gh_jid=8",
  )
  assert.notEqual(
    tebra,
    coinbase,
    "one employer's form must not vouch for another's",
  )
  assert.match(tebra, /for=tebra/)
})

test("boardKey is stable across two postings on one board", () => {
  assert.equal(
    boardKey("https://boards.greenhouse.io/acme/jobs/1"),
    boardKey("https://boards.greenhouse.io/acme/jobs/2"),
  )
})

test("boardKey returns empty for junk rather than matching everything", () => {
  assert.equal(boardKey("not a url"), "")
  assert.equal(boardKey(null), "")
  assert.equal(boardKey(undefined), "")
})

test("a shape remembered for a DIFFERENT employer never matches this board", () => {
  const cache = cacheWith(TEXT_FORM, {
    url: "https://boards.greenhouse.io/other/jobs/9",
  })
  assert.deepEqual(shapesForBoard(cache, GH_URL, "greenhouse"), [])
  const r = classify(lead(), { ...OK_CTX, cache })
  assert.equal(r.tier, "amber")
})

test("a shape remembered under a different ATS never matches", () => {
  const cache = cacheWith(TEXT_FORM, { ats: "lever" })
  assert.deepEqual(shapesForBoard(cache, GH_URL, "greenhouse"), [])
})

// --- batching ----------------------------------------------------------------

test("classifyAll resolves the fact base ONCE for N leads, not N times", () => {
  let calls = 0
  const leads = Array.from({ length: 25 }, (_, i) =>
    lead({
      id: `l${i}`,
      apply_url: `https://boards.greenhouse.io/acme/jobs/${i}`,
    }),
  )
  const results = classifyAll(leads, {
    cache: cacheWith(TEXT_FORM),
    profileApproved: true,
    now: today(),
    resolve: (fields, opts) => {
      calls++
      return fields.map((f) => ({ k: f.k, status: "OK", value: "x" }))
    },
    perLead: () => ({
      hasVerifiedResume: true,
      alreadyApplied: false,
      stages: { ok: true, stage: null, reasons: [] },
    }),
  })
  assert.equal(calls, 1, "O(1) fact-base reads, not O(n)")
  assert.equal(results.length, 25)
  assert.equal(tierCounts(results).green, 25)
})

test("classifyAll does not resolve at all when no lead is on an adapted board", () => {
  let calls = 0
  const results = classifyAll(
    [lead({ apply_url: "https://careers.example.com/x" })],
    {
      cache: cacheWith(TEXT_FORM),
      profileApproved: true,
      now: today(),
      resolve: () => {
        calls++
        return []
      },
      perLead: () => ({
        hasVerifiedResume: true,
        stages: { ok: true, stage: null, reasons: [] },
      }),
    },
  )
  assert.equal(calls, 0)
  assert.equal(results[0].tier, "amber")
})

test("tierCounts reports every tier, including the ones with no members", () => {
  assert.deepEqual(tierCounts([]), {
    handoff: 0,
    blocked: 0,
    amber: 0,
    green: 0,
  })
})

// --- the blocker helper in isolation -----------------------------------------

test("shapeBlockers returns an empty list only for a genuinely clean shape", () => {
  const entry = {
    ats: "greenhouse",
    url: GH_URL,
    updated: isoDay(1),
    fields: TEXT_FORM,
  }
  assert.deepEqual(
    shapeBlockers("fp1", entry, ALL_TEXT_SETTLED, {
      now: today(),
      maxAgeDays: DEFAULT_CACHE_MAX_AGE_DAYS,
    }),
    [],
  )
})

test("shapeBlockers reports EVERY reason, not just the first", () => {
  const entry = {
    ats: "greenhouse",
    url: GH_URL,
    updated: isoDay(99),
    fields: {
      "email|text": { t: "text", l: "Email", req: true },
      "i agree|checkbox": {
        t: "checkbox",
        l: "I agree to the terms",
        req: true,
      },
    },
  }
  const blockers = shapeBlockers("fp1", entry, new Map(), {
    now: today(),
    maxAgeDays: 30,
  })
  assert.ok(
    blockers.length >= 3,
    `expected age + consent + unresolved, got ${blockers.length}`,
  )
  assert.ok(blockers.some((b) => /days old/.test(b)))
  assert.ok(blockers.some((b) => /consent tickbox/.test(b)))
  assert.ok(blockers.some((b) => /is unresolved/.test(b)))
})
