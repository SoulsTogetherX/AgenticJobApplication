#!/usr/bin/env node
// Scaffold a per-job workspace: jobs/<slug>/{job.json, context.json}
//
// Usage: node scripts/new-job.mjs <slug> --company "Acme" --title "Full-Stack Developer" [--url <url>] [--root jobs]
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
function flag(name, dflt) {
  const i = args.indexOf(name);
  if (i !== -1) { const v = args[i + 1]; args.splice(i, 2); return v; }
  return dflt;
}
const company = flag('--company', null);
const title = flag('--title', null);
const url = flag('--url', null);
const root = flag('--root', 'jobs');
const slug = args[0];

if (!slug || !/^[a-z0-9][a-z0-9-]*$/.test(slug) || !company?.trim() || !title?.trim()) {
  console.error('Usage: new-job.mjs <kebab-slug> --company "X" --title "Y" [--url Z]');
  process.exit(2);
}

const dir = path.join(root, slug);
if (fs.existsSync(dir)) {
  console.error(`Workspace already exists: ${dir}`);
  process.exit(1);
}
fs.mkdirSync(dir, { recursive: true });

const job = {
  slug,
  company: company.trim(),
  title: title.trim(),
  source_url: url,
  location: null,
  captured_at: new Date().toISOString().slice(0, 10),
  description: null,
  requirements: [],
  questions: [],
};

const context = {
  slug,
  analysis: { key_requirements: [], matched_fact_ids: [], gaps: [], keywords: [], tone: null },
  consistency: { emphasized_skills: [], lead_experience: null, notes: null },
  resume: { status: 'pending', facts_used: [], dropped: [] },
  cover_letter: { status: 'pending', facts_used: [], key_points: [] },
  pending_questions: [],
};

fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify(job, null, 2) + '\n', 'utf8');
fs.writeFileSync(path.join(dir, 'context.json'), JSON.stringify(context, null, 2) + '\n', 'utf8');
console.log(`Created ${dir}/job.json and context.json`);
