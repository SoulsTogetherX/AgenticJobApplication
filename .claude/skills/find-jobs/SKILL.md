---
name: find-jobs
description:
  Search ethical public job sources (Hacker News, Greenhouse/Lever/Ashby
  boards including Anthropic, or a user-given site/URL) for Full-Stack roles that
  pass docs/application-limits.yaml, and store leads in jobs/leads.json to
  recommend later. Use when the user asks to find, search for, scan, or recommend
  jobs, or gives a job board URL or place to look.
---

Find job leads, filter them through the user's limits, and store them for later
recommendation. Never applies to anything — that is pipeline-jobs / apply-job.

## Source ethics (hard boundaries)

- Only public, integration-friendly sources: documented JSON APIs
  (Greenhouse/Lever/Ashby boards, HN Algolia), public careers pages, and pages
  the user explicitly points at.
- Never log in, create accounts, bypass CAPTCHAs/bot walls, or scrape sites
  whose ToS forbid it (LinkedIn, Indeed, Glassdoor are OFF limits — tell the
  user to browse those themselves and paste postings in).
- One polite pass per site; no hammering, no pagination crawls beyond a few
  pages.

## Limits

`docs/application-limits.yaml` is the contract: no relocation away from North
Las Vegas (remote OK, Las Vegas metro on-site OK, occasional travel OK), no
stale postings (default > 30 days), Full-Stack roles only.
`scripts/leads/find-jobs.mjs` enforces it mechanically on everything stored.

## Flows

**1. API sweep (default)** — run:

```bash
node scripts/leads/find-jobs.mjs search --source all --query "full stack"
```

Covers every board in `docs/job-sources.yaml`, Hacker News job posts, and —
when `.env` is configured — the Adzuna aggregator. Add `--max-age N` to
tighten freshness. To track or untrack a company, use the manage-sources
skill (prescreens the board, refuses duplicates); never hand-edit the YAML.

**Adzuna** (`--source adzuna`, auto-included in `all`): a job aggregator with
salary data covering thousands of employers, including Fortune 500 companies
whose Workday/Taleo portals have no public feed. Needs credentials: the user
copies `.env.example` to `.env` and fills `ADZUNA_APP_ID` / `ADZUNA_APP_KEY`
(free at https://developer.adzuna.com/). Never read the `.env` values aloud or
into a document; if unconfigured, `all` skips it with a warning.

**2. User-given place or URL** — when the user names a site, company, or URL:

- If it is a Greenhouse/Lever/Ashby board, prefer the JSON API
  (`boards-api.greenhouse.io/v1/boards/<slug>/jobs`,
  `api.lever.co/v0/postings/<slug>?mode=json`,
  `api.ashbyhq.com/posting-api/job-board/<slug>`).
- Otherwise capture the page with WebFetch (static) or Playwright MCP
  (JS-heavy), extract postings, normalize each to
  `{ company, title, location, url, posted_at }`, write the array to a temp
  JSON file, and run `node scripts/leads/find-jobs.mjs import <file>` so the same
  limits/dedupe apply. Never hand-edit jobs/leads.json.
- Fortune 500 companies mostly run Workday/Taleo (no public API): use their
  public careers-site search page via this capture flow, or WebSearch
  `site:<company careers domain> full stack`.

**3. LinkedIn URL (paste-and-go)** — when the user pastes a
`linkedin.com/jobs/...` link, NEVER fetch or scrape it (LinkedIn's ToS forbid
automated access). Instead:

1. Pull whatever the URL itself reveals (company/title often appear in the
   slug).
2. WebSearch for the same posting on the employer's own site or ATS board
   (`"<company>" "<title>" careers`, `site:boards.greenhouse.io <company>`,
   etc.) — most LinkedIn ads are syndicated from one of these.
3. Capture from that canonical source and `import` it, storing the pasted
   LinkedIn URL in the lead's `notes` for provenance/dedupe.
4. If no public canonical source exists, ask the user to paste the posting
   text from their browser and import that (`source: "linkedin:manual"`).

**4. HN "Who is hiring"** — for the monthly thread, fetch it via Algolia
(`search?tags=story,author_whoishiring`), read top-level comments matching the
limits, and import the same way.

## Recommending

When asked "what did you find" / "recommend jobs":

1. **Rank deterministically first — do not read the lead store by hand:**
   ```bash
   node scripts/leads/recommend.mjs --top 10
   ```
   It scores every lead on tech overlap with the profile, role-title fit,
   freshness, salary signal, and risk flags, and prints one compact line per
   lead with matched/missing tech.
2. Add judgment only on top of that ranking (why a top hit fits, whether a
   score is misleading). Do not re-derive the ranking.
3. Present a short table: company, title, location, age, URL, one-line fit
   rationale. Mention any `unknown_location` / `unknown_age` flags.
4. `node scripts/leads/find-jobs.mjs mark <id> --status recommended` for the ones
   surfaced; `--status dismissed --notes "why"` for the ones the user rejects.

The store lives at `jobs/leads.json` (gitignored, like all personal data).
