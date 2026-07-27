import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  passesLimits,
  dedupeLeads,
  normUrl,
  loadLimits,
} from "../scripts/find-jobs.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NOW = new Date("2026-07-27T12:00:00Z");

const LIMITS = {
  location: {
    base: "North Las Vegas, NV",
    relocation: false,
    remote_ok: true,
    onsite_allowed: ["north las vegas", "las vegas", "henderson"],
  },
  freshness: { max_age_days: 30 },
  roles: {
    title_keywords: [
      "full-stack",
      "full stack",
      "fullstack",
      "software engineer",
    ],
  },
};

const job = (over = {}) => ({
  company: "Acme",
  title: "Full Stack Engineer",
  location: "Remote",
  url: "https://example.com/jobs/1",
  posted_at: "2026-07-20T00:00:00Z",
  ...over,
});

// ---------- passesLimits ----------

test("remote and Las Vegas metro jobs pass", () => {
  for (const loc of [
    "Remote",
    "Remote (US)",
    "Las Vegas, NV",
    "Henderson, NV",
    "North Las Vegas",
  ]) {
    const v = passesLimits(job({ location: loc }), LIMITS, NOW);
    assert.equal(v.ok, true, `expected pass for ${loc}: ${v.reasons}`);
  }
});

test("jobs requiring relocation away from base are rejected", () => {
  for (const loc of [
    "San Francisco",
    "New York, NY",
    "Sydney, Australia",
    "London, United Kingdom",
  ]) {
    const v = passesLimits(job({ location: loc }), LIMITS, NOW);
    assert.equal(v.ok, false, `expected reject for ${loc}`);
    assert.match(v.reasons.join(" "), /location/);
  }
});

test("a board-level remote flag passes an off-base location but is flagged for screening", () => {
  const v = passesLimits(
    job({ location: "San Francisco", remote: true }),
    LIMITS,
    NOW,
  );
  assert.equal(v.ok, true);
  assert.ok(v.flags.includes("remote_unverified"));
});

test("remote restricted to non-US regions is still rejected", () => {
  for (const loc of [
    "France, Remote; Germany, Remote",
    "Remote - Europe",
    "London, UK (Remote)",
    "Remote (Canada only)",
  ]) {
    const v = passesLimits(job({ location: loc }), LIMITS, NOW);
    assert.equal(v.ok, false, `expected reject for ${loc}`);
  }
  const us = passesLimits(
    job({ location: "Remote - United States" }),
    LIMITS,
    NOW,
  );
  assert.equal(us.ok, true);
});

test("stale postings are rejected; fresh ones pass", () => {
  const stale = passesLimits(
    job({ posted_at: "2026-05-01T00:00:00Z" }),
    LIMITS,
    NOW,
  );
  assert.equal(stale.ok, false);
  assert.match(stale.reasons.join(" "), /stale/);
  const fresh = passesLimits(
    job({ posted_at: "2026-07-25T00:00:00Z" }),
    LIMITS,
    NOW,
  );
  assert.equal(fresh.ok, true);
});

test("missing posted_at passes but is flagged unknown_age", () => {
  const v = passesLimits(job({ posted_at: null }), LIMITS, NOW);
  assert.equal(v.ok, true);
  assert.ok(v.flags.includes("unknown_age"));
});

test("missing location passes but is flagged unknown_location", () => {
  const v = passesLimits(job({ location: "" }), LIMITS, NOW);
  assert.equal(v.ok, true);
  assert.ok(v.flags.includes("unknown_location"));
});

test("non-targeted titles are rejected", () => {
  for (const title of ["Accountant", "DevOps Engineer", "Product Manager"]) {
    const v = passesLimits(job({ title }), LIMITS, NOW);
    assert.equal(v.ok, false, `expected reject for ${title}`);
    assert.match(v.reasons.join(" "), /title/);
  }
});

// ---------- dedupeLeads ----------

test("dedupe drops candidates already in the store by id, url, or company+title", () => {
  const existing = [job({ id: "x:1", url: "https://example.com/jobs/1" })];
  const candidates = [
    job({ id: "x:1", url: "https://other.com/a" }), // same id
    job({ id: "y:2", url: "https://EXAMPLE.com/jobs/1/?utm=x" }), // same url modulo noise
    job({ id: "z:3", url: "https://third.com/b" }), // same company+title
    job({
      id: "w:4",
      url: "https://fourth.com/c",
      title: "Full Stack Developer II",
    }), // genuinely new
  ];
  const fresh = dedupeLeads(candidates, existing, []);
  assert.deepEqual(
    fresh.map((f) => f.id),
    ["w:4"],
  );
});

test("dedupe drops jobs already applied to (company+title match)", () => {
  const applied = [{ company: "acme", title: "full stack engineer" }];
  const fresh = dedupeLeads([job({ id: "a:1" })], [], applied);
  assert.equal(fresh.length, 0);
});

test("dedupe keeps the first of two identical candidates in one batch", () => {
  const fresh = dedupeLeads([job({ id: "a:1" }), job({ id: "a:1" })], [], []);
  assert.equal(fresh.length, 1);
});

// ---------- misc ----------

test("normUrl strips query, hash, trailing slash, and case", () => {
  assert.equal(
    normUrl("https://Ex.com/Jobs/1/?a=b#c"),
    "https://ex.com/Jobs/1".toLowerCase(),
  );
  assert.equal(normUrl("not a url"), "not a url");
});

test("the real application-limits.yaml loads and matches the documented policy", () => {
  const limits = loadLimits(path.join(ROOT, "docs", "application-limits.yaml"));
  assert.equal(limits.location.relocation, false);
  assert.equal(limits.location.remote_ok, true);
  assert.ok(limits.location.onsite_allowed.includes("north las vegas"));
  assert.ok(limits.freshness.max_age_days >= 1);
  assert.ok(limits.roles.title_keywords.length > 0);
});
