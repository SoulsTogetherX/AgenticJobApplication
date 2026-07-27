#!/usr/bin/env node
// Record a submitted application in profile/applications.yaml (the ONLY
// sanctioned way for the agent to write the application log).
//
// Usage: node scripts/log-application.mjs <slug> --company "X" --title "Y"
//        [--url <url>] [--date YYYY-MM-DD] [--notes "..."] [--file profile/applications.yaml]
import fs from 'node:fs';
import { loadYamlFile, dumpYaml } from './lib.mjs';

const args = process.argv.slice(2);
function flag(name, dflt) {
  const i = args.indexOf(name);
  if (i !== -1) { const v = args[i + 1]; args.splice(i, 2); return v; }
  return dflt;
}
const file = flag('--file', 'profile/applications.yaml');
const company = flag('--company', null);
const title = flag('--title', null);
const url = flag('--url', null);
const date = flag('--date', new Date().toISOString().slice(0, 10));
const notes = flag('--notes', null);
const slug = args[0];

if (!slug?.trim() || !company?.trim() || !title?.trim()) {
  console.error('Usage: log-application.mjs <slug> --company "X" --title "Y" [--url U] [--date YYYY-MM-DD] [--notes N]');
  process.exit(2);
}
if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) {
  console.error(`Invalid --date "${date}" (expected YYYY-MM-DD)`);
  process.exit(2);
}

const data = fs.existsSync(file) ? (loadYamlFile(file) ?? {}) : {};
data.applications ??= [];
if (!Array.isArray(data.applications)) {
  console.error(`${file} is malformed: "applications" is not a list`);
  process.exit(2);
}

const dup = data.applications.find((a) => a.slug === slug.trim());
if (dup) {
  console.error(`Already logged: applied to ${dup.company} — ${dup.title} on ${dup.applied_at} (slug ${dup.slug}). Edit ${file} to change it.`);
  process.exit(1);
}

data.applications.push({
  slug: slug.trim(),
  company: company.trim(),
  title: title.trim(),
  applied_at: date,
  source_url: url,
  notes,
});

const header = `# APPLICATION LOG — user-editable. Agent adds entries ONLY via scripts/log-application.mjs.\n`;
fs.writeFileSync(file, header + dumpYaml(data), 'utf8');
console.log(`Logged application: ${company.trim()} — ${title.trim()} (${date})`);
