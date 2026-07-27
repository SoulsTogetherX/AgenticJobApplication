#!/usr/bin/env node
// Check the application log: has this job (slug) or company already been
// applied to, and how long ago?
//
// Usage: node scripts/check-applied.mjs "<company, title, or slug>"
//        [--file profile/applications.yaml] [--today YYYY-MM-DD]
//
// Output: JSON { query, job_already_applied, matches: [{... days_ago}] }
// Exit codes: 0 = ran fine (match or not), 2 = usage error.
import fs from 'node:fs';
import { loadYamlFile } from './lib.mjs';

const args = process.argv.slice(2);
function flag(name, dflt) {
  const i = args.indexOf(name);
  if (i !== -1) { const v = args[i + 1]; args.splice(i, 2); return v; }
  return dflt;
}
const file = flag('--file', 'profile/applications.yaml');
const today = flag('--today', new Date().toISOString().slice(0, 10));
const query = args[0];

if (!query?.trim()) {
  console.error('Usage: check-applied.mjs "<company, title, or slug>" [--today YYYY-MM-DD]');
  process.exit(2);
}
if (!/^\d{4}-\d{2}-\d{2}$/.test(today) || Number.isNaN(Date.parse(today))) {
  console.error(`Invalid --today "${today}" (expected YYYY-MM-DD)`);
  process.exit(2);
}

const q = query.trim().toLowerCase();
const data = fs.existsSync(file) ? (loadYamlFile(file) ?? {}) : {};
const applications = Array.isArray(data.applications) ? data.applications : [];

const todayMs = Date.parse(today);
const matches = applications
  .filter((a) =>
    a.slug?.toLowerCase() === q ||
    a.company?.toLowerCase().includes(q) ||
    a.title?.toLowerCase().includes(q)
  )
  .map((a) => ({
    ...a,
    days_ago: Number.isNaN(Date.parse(a.applied_at)) ? null
      : Math.floor((todayMs - Date.parse(a.applied_at)) / 86_400_000),
  }))
  .sort((a, b) => (a.days_ago ?? Infinity) - (b.days_ago ?? Infinity));

console.log(JSON.stringify({
  query: query.trim(),
  checked: applications.length,
  job_already_applied: applications.some((a) => a.slug?.toLowerCase() === q),
  matches,
}, null, 2));
