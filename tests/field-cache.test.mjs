// The cache exists to skip re-probing dropdowns in the browser. The risks are
// that it goes stale silently, or that it overwrites something freshly read —
// both would be worse than not caching at all.
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import {
  fingerprint,
  loadCache,
  saveCache,
  applyCache,
  recordCache,
  invalidate,
  CACHE_VERSION,
} from "../scripts/field-cache.mjs"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

const scanOf = (fields) => ({
  url: "https://job-boards.greenhouse.io/x/jobs/1",
  fields,
})

test("the key follows the form's required shape, not its URL", () => {
  const a = scanOf([
    { k: "f1", t: "text", l: "First Name", req: true },
    { k: "f2", t: "combo", l: "Degree", req: true },
  ])
  // Same required labels in a different order, different URL, different options.
  const b = scanOf([
    { k: "fA", t: "combo", l: "  degree  ", req: true, opts: ["x"] },
    { k: "fB", t: "text", l: "First Name", req: true },
  ])
  b.url = "https://job-boards.greenhouse.io/y/jobs/99"
  assert.equal(fingerprint(a, "greenhouse"), fingerprint(b, "greenhouse"))
})

test("optional fields do not churn the key", () => {
  const base = [{ k: "f1", t: "text", l: "First Name", req: true }]
  const a = scanOf(base)
  const b = scanOf([...base, { k: "f2", t: "combo", l: "Veteran Status" }])
  assert.equal(fingerprint(a, "greenhouse"), fingerprint(b, "greenhouse"))
})

test("a redesigned form gets a different key, so it re-probes", () => {
  const a = scanOf([{ k: "f1", t: "text", l: "First Name", req: true }])
  const b = scanOf([
    { k: "f1", t: "text", l: "First Name", req: true },
    { k: "f2", t: "combo", l: "Work Authorization", req: true },
  ])
  assert.notEqual(fingerprint(a, "greenhouse"), fingerprint(b, "greenhouse"))
})

test("the same shape on a different ATS is a different key", () => {
  const s = scanOf([{ k: "f1", t: "text", l: "First Name", req: true }])
  assert.notEqual(fingerprint(s, "greenhouse"), fingerprint(s, "lever"))
})

test("cached options fill in a scan that skipped the probe", () => {
  const cache = { v: CACHE_VERSION, forms: {} }
  const probed = scanOf([
    {
      k: "f1",
      t: "combo",
      l: "Degree*",
      req: true,
      opts: ["Bachelor's Degree", "Master's Degree"],
      sel: "#deg",
    },
  ])
  const fp = fingerprint(probed, "greenhouse")
  recordCache(cache, { fp, scan: probed, atsId: "greenhouse", url: probed.url })

  const unprobed = scanOf([{ k: "fZ", t: "combo", l: "Degree*", req: true }])
  const stats = applyCache(unprobed, cache.forms[fp])
  assert.equal(stats.hits, 1)
  assert.deepEqual(unprobed.fields[0].opts, [
    "Bachelor's Degree",
    "Master's Degree",
  ])
  assert.equal(unprobed.fields[0].sel, "#deg", "the selector is remembered too")
})

test("a fresh probe always beats a remembered one", () => {
  const cache = { v: CACHE_VERSION, forms: {} }
  const old = scanOf([
    { k: "f1", t: "combo", l: "Degree", req: true, opts: ["stale"] },
  ])
  const fp = fingerprint(old, "greenhouse")
  recordCache(cache, { fp, scan: old, atsId: "greenhouse" })

  const fresh = scanOf([
    { k: "f1", t: "combo", l: "Degree", req: true, opts: ["current"] },
  ])
  const stats = applyCache(fresh, cache.forms[fp])
  assert.deepEqual(
    fresh.fields[0].opts,
    ["current"],
    "live data must never be overwritten",
  )
  assert.equal(stats.hits, 0)
  assert.equal(stats.probed, 1)
})

test("recording twice keeps what the later scan did not see", () => {
  const cache = { v: CACHE_VERSION, forms: {} }
  const full = scanOf([
    { k: "f1", t: "combo", l: "Degree", req: true, opts: ["A", "B"] },
  ])
  const fp = fingerprint(full, "greenhouse")
  recordCache(cache, { fp, scan: full, atsId: "greenhouse" })
  // A later run without a probe must not erase what we already knew.
  recordCache(cache, {
    fp,
    scan: scanOf([{ k: "f1", t: "combo", l: "Degree", req: true }]),
    atsId: "greenhouse",
  })
  assert.deepEqual(cache.forms[fp].fields["degree|combo"].opts, ["A", "B"])
})

test("a composite widget's options do not leak onto its text input", () => {
  // Greenhouse's phone field is a country picker plus a tel input, both
  // labelled "Phone". Handing the country list to the tel input made the phone
  // number resolve to NEEDS-CHOICE and bounced it to the user for no reason.
  const cache = { v: CACHE_VERSION, forms: {} }
  const probed = scanOf([
    {
      k: "f1",
      t: "combo",
      l: "Phone",
      opts: ["United States +1", "Canada +1"],
    },
    { k: "f2", t: "tel", l: "Phone", req: true },
  ])
  const fp = fingerprint(probed, "greenhouse")
  recordCache(cache, { fp, scan: probed, atsId: "greenhouse" })

  const unprobed = scanOf([
    { k: "f1", t: "combo", l: "Phone" },
    { k: "f2", t: "tel", l: "Phone", req: true },
  ])
  applyCache(unprobed, cache.forms[fp])
  assert.deepEqual(unprobed.fields[0].opts, ["United States +1", "Canada +1"])
  assert.equal(
    unprobed.fields[1].opts,
    undefined,
    "the tel input has no options",
  )
})

test("invalidate drops the entry", () => {
  const cache = {
    v: CACHE_VERSION,
    forms: { abc: { ats: "greenhouse", fields: {} } },
  }
  assert.equal(invalidate(cache, "abc"), true)
  assert.equal(cache.forms.abc, undefined)
  assert.equal(
    invalidate(cache, "abc"),
    false,
    "evicting twice is not an error",
  )
})

test("a corrupt or outdated cache file starts clean instead of throwing", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "field-cache-"))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))

  const f = path.join(dir, "c.json")
  fs.writeFileSync(f, "{ not json")
  assert.deepEqual(loadCache(f).forms, {})

  saveCache(f, { v: CACHE_VERSION + 99, forms: { old: { fields: {} } } })
  assert.deepEqual(
    loadCache(f).forms,
    {},
    "a version bump discards rather than guesses",
  )

  assert.deepEqual(loadCache(path.join(dir, "missing.json")).forms, {})
})

test("end to end: a second run reuses the shape the first one learned", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fill-plan-cache-"))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const slug = "acme-swe"
  const jobDir = path.join(dir, slug)
  fs.mkdirSync(jobDir, { recursive: true })

  const probed = scanOf([
    { k: "f1", t: "text", l: "First Name", req: true },
    {
      k: "f2",
      t: "combo",
      l: "Degree*",
      req: true,
      opts: ["Bachelor's Degree"],
    },
  ])
  fs.writeFileSync(path.join(jobDir, "probed.json"), JSON.stringify(probed))

  // Same form, scanned without opening any dropdown.
  const unprobed = scanOf([
    { k: "f1", t: "text", l: "First Name", req: true },
    { k: "f2", t: "combo", l: "Degree*", req: true },
  ])
  fs.writeFileSync(path.join(jobDir, "unprobed.json"), JSON.stringify(unprobed))

  const run = (scanFile) =>
    spawnSync(
      process.execPath,
      [
        path.join(ROOT, "scripts", "fill-plan.mjs"),
        slug,
        "--jobs-dir",
        dir,
        "--scan",
        path.join(jobDir, scanFile),
        "--profile",
        path.join(ROOT, "tests", "fixtures", "profile.yaml"),
        "--answers",
        path.join(ROOT, "tests", "fixtures", "answers-bank.yaml"),
      ],
      { cwd: ROOT, encoding: "utf8" },
    )

  const cold = run("probed.json")
  assert.equal(cold.status, 0, cold.stderr)
  assert.match(
    cold.stdout,
    /cache=0\/1/,
    "nothing known yet; one field was probed live",
  )

  const warm = run("unprobed.json")
  assert.equal(warm.status, 0, warm.stderr)
  assert.match(
    warm.stdout,
    /cache=1\/1/,
    "the dropdown did not need re-probing",
  )
  assert.ok(fs.existsSync(path.join(dir, ".field-cache.json")))
})
