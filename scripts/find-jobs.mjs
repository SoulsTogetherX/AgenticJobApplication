#!/usr/bin/env node
// Deterministic job-lead finder (no LLM calls). Searches public, integration-
// friendly job APIs, filters every hit through docs/application-limits.yaml,
// dedupes against stored leads and application history, and maintains the
// lead store at jobs/leads.json.
//
// Usage:
//   node scripts/find-jobs.mjs search [--source all|hn|boards] [--query "full stack"] [--max-age N]
//   node scripts/find-jobs.mjs import <file.json>   # leads captured in-session (Playwright/WebFetch)
//   node scripts/find-jobs.mjs list [--status new|recommended|dismissed|applied|all]
//   node scripts/find-jobs.mjs mark <id-or-url> --status <status> [--notes "..."]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import yaml from "js-yaml";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LIMITS_PATH = path.join(ROOT, "docs", "application-limits.yaml");
const LEADS_PATH = path.join(ROOT, "jobs", "leads.json");
const APPLICATIONS_PATH = path.join(ROOT, "profile", "applications.yaml");

const STATUSES = ["new", "recommended", "dismissed", "applied"];

// Public JSON job boards intended for integration (Greenhouse/Lever/Ashby all
// document these endpoints). Most Fortune 500 companies run Workday or Taleo,
// which have no public feed — reach those via the find-jobs skill's
// URL-capture flow (Playwright/WebFetch + `import`) instead.
export const DEFAULT_BOARDS = [
  { type: "greenhouse", slug: "anthropic", company: "Anthropic" },
  { type: "greenhouse", slug: "cloudflare", company: "Cloudflare" },
  { type: "greenhouse", slug: "datadog", company: "Datadog" },
  { type: "greenhouse", slug: "gitlab", company: "GitLab" },
  { type: "greenhouse", slug: "mongodb", company: "MongoDB" },
  { type: "greenhouse", slug: "reddit", company: "Reddit" },
  { type: "lever", slug: "palantir", company: "Palantir" },
  { type: "ashby", slug: "openai", company: "OpenAI" },
  { type: "ashby", slug: "linear", company: "Linear" },
  { type: "ashby", slug: "ramp", company: "Ramp" },
];

// ---------------------------------------------------------------------------
// Pure logic (exported for tests)
// ---------------------------------------------------------------------------

export function passesLimits(job, limits, now = new Date()) {
  const reasons = [];
  const flags = [];

  const title = String(job.title ?? "").toLowerCase();
  const kws = limits.roles?.title_keywords ?? [];
  if (kws.length && !kws.some((k) => title.includes(String(k).toLowerCase()))) {
    reasons.push("title: not a targeted role");
  }

  const loc = String(job.location ?? "")
    .trim()
    .toLowerCase();
  if (!loc) {
    flags.push("unknown_location");
  } else {
    // "Remote" restricted to a non-US region is still a relocation for a
    // North Las Vegas applicant; an explicit US marker overrides.
    const NON_US =
      /(france|germany|italy|spain|poland|netherlands|ireland|dublin|london|united kingdom|\buk\b|europe|emea|apac|australia|sydney|canada|toronto|vancouver|india|singapore|japan|brazil|mexico)/;
    const US_MARK = /(united states|\busa?\b|u\.s\.|america)/;
    const nonUsOnly = NON_US.test(loc) && !US_MARK.test(loc);
    const onsiteOk = (limits.location?.onsite_allowed ?? []).some((a) =>
      loc.includes(String(a).toLowerCase()),
    );
    const remoteText = /\bremote\b/.test(loc) && !nonUsOnly;
    // Board-level remote flag with a contradictory on-site location string is
    // kept but flagged: screening must confirm it is truly remote-from-NV.
    const remoteFlagged = job.remote === true && !nonUsOnly;
    const remoteOk =
      (limits.location?.remote_ok ?? true) && (remoteText || remoteFlagged);
    if (!remoteOk && !onsiteOk) {
      reasons.push(
        `location: "${job.location}" would require relocating away from ${limits.location?.base ?? "base"}`,
      );
    } else if (remoteOk && !remoteText && !onsiteOk) {
      flags.push("remote_unverified");
    }
  }

  const maxAge = limits.freshness?.max_age_days ?? 30;
  if (job.posted_at) {
    const posted = new Date(job.posted_at);
    if (Number.isNaN(posted.getTime())) {
      flags.push("unknown_age");
    } else {
      const ageDays = (now.getTime() - posted.getTime()) / 86400000;
      if (ageDays > maxAge) {
        reasons.push(
          `stale: posted ${Math.round(ageDays)} days ago (max ${maxAge})`,
        );
      }
    }
  } else {
    flags.push("unknown_age");
  }

  return { ok: reasons.length === 0, reasons, flags };
}

export function normUrl(u) {
  try {
    const p = new URL(u);
    return (p.origin + p.pathname).replace(/\/+$/, "").toLowerCase();
  } catch {
    return String(u ?? "").toLowerCase();
  }
}

const companyTitleKey = (x) =>
  `${String(x.company ?? "").toLowerCase()}::${String(x.title ?? "").toLowerCase()}`;

export function dedupeLeads(candidates, existingLeads = [], applied = []) {
  const seen = new Set();
  for (const l of existingLeads) {
    if (l.id) seen.add(l.id);
    if (l.url) seen.add(normUrl(l.url));
    seen.add(companyTitleKey(l));
  }
  const appliedKeys = new Set(applied.map(companyTitleKey));
  const fresh = [];
  for (const c of candidates) {
    const keys = [
      c.id,
      c.url ? normUrl(c.url) : null,
      companyTitleKey(c),
    ].filter(Boolean);
    if (keys.some((k) => seen.has(k))) continue;
    if (appliedKeys.has(companyTitleKey(c))) continue;
    keys.forEach((k) => seen.add(k));
    fresh.push(c);
  }
  return fresh;
}

// ---------------------------------------------------------------------------
// Store I/O
// ---------------------------------------------------------------------------

export function loadLimits(file = LIMITS_PATH) {
  return yaml.load(fs.readFileSync(file, "utf8")) ?? {};
}

function loadLeads() {
  if (!fs.existsSync(LEADS_PATH)) return { leads: [] };
  return JSON.parse(fs.readFileSync(LEADS_PATH, "utf8"));
}

function saveLeads(store) {
  fs.mkdirSync(path.dirname(LEADS_PATH), { recursive: true });
  fs.writeFileSync(LEADS_PATH, JSON.stringify(store, null, 2) + "\n");
}

function loadApplied() {
  if (!fs.existsSync(APPLICATIONS_PATH)) return [];
  const doc = yaml.load(fs.readFileSync(APPLICATIONS_PATH, "utf8"));
  return doc?.applications ?? [];
}

// ---------------------------------------------------------------------------
// Fetchers → normalized lead shape:
// { id, source, company, title, location, url, posted_at }
// ---------------------------------------------------------------------------

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: {
      "user-agent": "agentic-job-application/0.1 (personal job search tool)",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

async function fetchGreenhouse(board) {
  const data = await fetchJson(
    `https://boards-api.greenhouse.io/v1/boards/${board.slug}/jobs`,
  );
  return (data.jobs ?? []).map((j) => ({
    id: `greenhouse:${board.slug}:${j.id}`,
    source: `greenhouse:${board.slug}`,
    company: j.company_name || board.company,
    title: j.title ?? "",
    location: j.location?.name ?? "",
    url: j.absolute_url,
    posted_at: j.first_published || j.updated_at || null,
  }));
}

async function fetchLever(board) {
  const data = await fetchJson(
    `https://api.lever.co/v0/postings/${board.slug}?mode=json`,
  );
  return (Array.isArray(data) ? data : []).map((j) => ({
    id: `lever:${board.slug}:${j.id}`,
    source: `lever:${board.slug}`,
    company: board.company,
    title: j.text ?? "",
    location: j.categories?.location ?? "",
    remote: j.workplaceType === "remote",
    url: j.hostedUrl,
    posted_at: j.createdAt ? new Date(j.createdAt).toISOString() : null,
  }));
}

async function fetchAshby(board) {
  const data = await fetchJson(
    `https://api.ashbyhq.com/posting-api/job-board/${board.slug}`,
  );
  return (data.jobs ?? [])
    .filter((j) => j.isListed !== false)
    .map((j) => ({
      id: `ashby:${board.slug}:${j.id}`,
      source: `ashby:${board.slug}`,
      company: board.company,
      title: j.title ?? "",
      location: [
        j.location,
        ...(j.secondaryLocations ?? []).map((s) => s.location),
      ]
        .filter(Boolean)
        .join(" / "),
      remote: j.isRemote === true,
      url: j.jobUrl || j.applyUrl,
      posted_at: j.publishedAt ?? null,
    }));
}

async function fetchHackerNews(query) {
  const q = encodeURIComponent(query || "full stack");
  const data = await fetchJson(
    `https://hn.algolia.com/api/v1/search_by_date?tags=job&query=${q}&hitsPerPage=50`,
  );
  return (data.hits ?? []).map((h) => {
    const title = h.title ?? "";
    // "Acme (YC W25) Is Hiring Full Stack Engineers (SF)" → company + location hint
    const company = title
      .split(/\s+is hiring/i)[0]
      .replace(/\s*\(YC [^)]*\)\s*/i, " ")
      .trim();
    const locMatch = /\(([^)]{2,40})\)\s*$/.exec(title);
    return {
      id: `hn:${h.objectID}`,
      source: "hn",
      company: company || "unknown",
      title,
      location: /remote/i.test(title) ? "Remote" : locMatch ? locMatch[1] : "",
      url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
      posted_at: h.created_at ?? null,
    };
  });
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function getFlag(args, name, fallback = null) {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] !== undefined ? args[i + 1] : fallback;
}

function summarize(kept, rejected) {
  for (const l of kept) {
    const flagStr = l.flags?.length ? `  [${l.flags.join(", ")}]` : "";
    console.log(
      `+ ${l.company} — ${l.title} (${l.location || "location?"})${flagStr}`,
    );
  }
  const byReason = {};
  for (const r of rejected) {
    const cat = r.reasons[0]?.split(":")[0] ?? "other";
    byReason[cat] = (byReason[cat] ?? 0) + 1;
  }
  console.log(
    `\nStored ${kept.length} new lead(s); rejected ${rejected.length} ` +
      `(${
        Object.entries(byReason)
          .map(([k, v]) => `${k}: ${v}`)
          .join(", ") || "none"
      }).`,
  );
}

function ingest(candidates, limits) {
  const store = loadLeads();
  const applied = loadApplied();
  const now = new Date();
  const kept = [];
  const rejected = [];
  for (const c of dedupeLeads(candidates, store.leads, applied)) {
    const verdict = passesLimits(c, limits, now);
    if (!verdict.ok) {
      rejected.push({ ...c, reasons: verdict.reasons });
      continue;
    }
    kept.push({
      ...c,
      flags: verdict.flags,
      status: "new",
      found_at: now.toISOString(),
      notes: "",
    });
  }
  store.leads.push(...kept);
  saveLeads(store);
  summarize(kept, rejected);
}

async function cmdSearch(args) {
  const limits = loadLimits();
  const source = getFlag(args, "--source", "all");
  const query = getFlag(args, "--query", "full stack");
  const maxAge = getFlag(args, "--max-age");
  if (maxAge) (limits.freshness ??= {}).max_age_days = Number(maxAge);

  const candidates = [];
  const failures = [];
  const jobsFor = {
    greenhouse: fetchGreenhouse,
    lever: fetchLever,
    ashby: fetchAshby,
  };
  if (source === "all" || source === "boards") {
    for (const board of DEFAULT_BOARDS) {
      try {
        candidates.push(...(await jobsFor[board.type](board)));
      } catch (e) {
        failures.push(`${board.type}:${board.slug} — ${e.message}`);
      }
    }
  }
  if (source === "all" || source === "hn") {
    try {
      candidates.push(...(await fetchHackerNews(query)));
    } catch (e) {
      failures.push(`hn — ${e.message}`);
    }
  }
  ingest(candidates, limits);
  for (const f of failures) console.error(`warn: source failed: ${f}`);
}

function cmdImport(args) {
  const file = args.find((a) => !a.startsWith("--"));
  if (!file) throw new Error("usage: find-jobs.mjs import <file.json>");
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  const candidates = Array.isArray(raw) ? raw : (raw.leads ?? []);
  ingest(candidates, loadLimits());
}

function cmdList(args) {
  const status = getFlag(args, "--status", "new");
  const { leads } = loadLeads();
  const shown = leads.filter((l) => status === "all" || l.status === status);
  for (const l of shown) {
    console.log(
      `[${l.status}] ${l.id}\n  ${l.company} — ${l.title}\n  ${l.location || "location?"} | posted ${l.posted_at ?? "?"} | ${l.url}`,
    );
  }
  console.log(
    `\n${shown.length} lead(s) with status "${status}" (${leads.length} total).`,
  );
}

function cmdMark(args) {
  const key = args.find((a) => !a.startsWith("--"));
  const status = getFlag(args, "--status");
  const notes = getFlag(args, "--notes");
  if (!key || !STATUSES.includes(status)) {
    throw new Error(
      `usage: find-jobs.mjs mark <id-or-url> --status <${STATUSES.join("|")}> [--notes "..."]`,
    );
  }
  const store = loadLeads();
  const lead = store.leads.find(
    (l) => l.id === key || normUrl(l.url) === normUrl(key),
  );
  if (!lead) throw new Error(`no lead matches "${key}"`);
  lead.status = status;
  if (notes) lead.notes = notes;
  saveLeads(store);
  console.log(`${lead.id} → ${status}`);
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === "search") await cmdSearch(args);
  else if (cmd === "import") cmdImport(args);
  else if (cmd === "list") cmdList(args);
  else if (cmd === "mark") cmdMark(args);
  else {
    console.error("usage: find-jobs.mjs <search|import|list|mark> [options]");
    process.exit(2);
  }
}

const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
