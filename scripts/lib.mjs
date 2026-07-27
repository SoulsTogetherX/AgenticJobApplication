// Shared helpers for the job-application pipeline. Pure/deterministic — no LLM.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

export function loadYamlFile(file) {
  return yaml.load(fs.readFileSync(file, 'utf8'));
}

export function dumpYaml(obj) {
  return yaml.dump(obj, { lineWidth: 100 });
}

// ---------------------------------------------------------------------------
// Fact index: id -> { id, text } from profile.yaml (+ answers.yaml)
// ---------------------------------------------------------------------------
export function buildFactIndex(profile, answers) {
  const index = new Map();
  const add = (id, text) => {
    if (!id) return;
    if (index.has(id)) throw new Error(`Duplicate fact id: ${id}`);
    index.set(id, { id, text: String(text) });
  };

  for (const s of profile.summary ?? []) add(s.id, s.text);

  for (const exp of profile.experience ?? []) {
    add(exp.id, `${exp.title} ${exp.company} ${exp.dates}`);
    for (const b of exp.bullets ?? []) add(b.id, b.text);
  }
  for (const prj of profile.projects ?? []) {
    add(prj.id, `${prj.name} ${prj.tech ?? ''} ${prj.year ?? ''} ${prj.role ?? ''}`);
    for (const b of prj.bullets ?? []) add(b.id, b.text);
  }
  for (const sk of profile.skills ?? []) add(sk.id, `${sk.group}: ${(sk.items ?? []).join(', ')}`);
  for (const edu of profile.education ?? []) {
    add(
      edu.id,
      `${edu.school} ${edu.degrees} ${edu.graduated ?? ''} GPA ${edu.gpa ?? ''} ${edu.honors ?? ''} ` +
        `${(edu.coursework ?? []).join(', ')}`
    );
  }
  for (const org of profile.organizations ?? []) add(org.id, org.name);
  for (const ex of profile.extras ?? []) add(ex.id, ex.text);

  for (const a of answers?.answers ?? []) add(a.id, `${a.question} ${a.answer}`);

  return index;
}

// ---------------------------------------------------------------------------
// Token extraction
// ---------------------------------------------------------------------------
export function extractNumbers(text) {
  // "4,000" -> "4000"; "45+" -> "45"; "3.75" stays; "100,000-spin" -> "100000"
  const out = new Set();
  for (const m of String(text).matchAll(/\d+(?:,\d{3})*(?:\.\d+)?/g)) {
    out.add(m[0].replaceAll(',', ''));
  }
  return out;
}

export function extractMonthYears(text) {
  const out = new Set();
  const re = /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(\d{4})\b/g;
  for (const m of String(text).matchAll(re)) out.add(`${m[1]} ${m[2]}`);
  return out;
}

// Dictionary of tech terms the verifier watches for. Includes both terms the
// user knows AND common terms they do NOT — so invented experience is caught.
export const TECH_TERMS = [
  // in profile
  'Python', 'TypeScript', 'JavaScript', 'C++', 'GDScript', 'SQL', 'HTML', 'CSS',
  'React Native', 'React', 'Node.js', 'Next.js', 'AWS', 'PostgreSQL', 'Docker',
  'Vite', 'GitHub Actions', 'Git', 'Godot', 'GameMaker', 'n8n', 'nginx',
  'WebSockets', 'Cognito', 'EC2', 'EventBridge', 'Claude', 'ChatGPT', 'Codex',
  'MCP', 'Monte Carlo', 'JSON', 'Agile', 'Scrum',
  // common terms NOT in profile — presence in a document must be justified
  'Kubernetes', 'Terraform', 'Ansible', 'Java', 'C#', 'Ruby', 'Rust', 'Golang',
  'PHP', 'Swift', 'Kotlin', 'Scala', 'Angular', 'Vue', 'Svelte', 'Django',
  'Flask', 'FastAPI', 'Spring', 'Rails', 'Laravel', 'GraphQL', 'MongoDB',
  'Redis', 'MySQL', 'SQLite', 'DynamoDB', 'Kafka', 'RabbitMQ', 'Elasticsearch',
  'Azure', 'GCP', 'Firebase', 'Heroku', 'Vercel', 'Netlify', 'Jenkins',
  'CircleCI', 'Webpack', 'Babel', 'Jest', 'Mocha', 'Cypress', 'Playwright',
  'Selenium', 'Puppeteer', 'TensorFlow', 'PyTorch', 'Keras', 'Pandas', 'NumPy',
  'Spark', 'Hadoop', 'Tailwind', 'Bootstrap', 'jQuery', 'Express', 'NestJS',
  'Deno', 'Bun', 'Remix', 'Astro', 'Flutter', 'Unity', 'Unreal',
];

function termRegex(term) {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Boundaries that tolerate ".", "+", "#" inside terms (C++, Node.js, C#).
  return new RegExp(`(?<![A-Za-z0-9+#.])${escaped}(?![A-Za-z0-9+#])`);
}

// Which TECH_TERMS appear in `text`? Longest-first so "React Native" wins and
// its "React" substring is not separately reported.
export function techTermsIn(text) {
  const found = [];
  let remaining = String(text);
  for (const term of [...TECH_TERMS].sort((a, b) => b.length - a.length)) {
    if (termRegex(term).test(remaining)) {
      found.push(term);
      remaining = remaining.replaceAll(term, ' ');
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// Lightweight validators (mirror schemas/*.schema.json)
// ---------------------------------------------------------------------------
const STATUSES = ['pending', 'drafted', 'verified', 'approved', 'rendered'];

export function validateJob(job) {
  const errors = [];
  if (!job || typeof job !== 'object') return ['job.json is not an object'];
  for (const key of ['slug', 'company', 'title']) {
    if (typeof job[key] !== 'string' || !job[key].trim()) errors.push(`job.${key} missing or empty`);
  }
  return errors;
}

export function validateContext(ctx) {
  const errors = [];
  if (!ctx || typeof ctx !== 'object') return ['context.json is not an object'];
  if (typeof ctx.slug !== 'string' || !ctx.slug.trim()) errors.push('context.slug missing or empty');
  if (!ctx.analysis || typeof ctx.analysis !== 'object') {
    errors.push('context.analysis missing');
  } else {
    if (!Array.isArray(ctx.analysis.key_requirements)) errors.push('analysis.key_requirements must be an array');
    if (!Array.isArray(ctx.analysis.matched_fact_ids)) errors.push('analysis.matched_fact_ids must be an array');
  }
  for (const section of ['resume', 'cover_letter']) {
    const s = ctx[section];
    if (!s || typeof s !== 'object') errors.push(`context.${section} missing`);
    else if (!STATUSES.includes(s.status)) errors.push(`${section}.status must be one of ${STATUSES.join('|')}`);
  }
  return errors;
}

export function repoRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}
