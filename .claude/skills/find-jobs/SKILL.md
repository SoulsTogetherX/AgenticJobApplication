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
`scripts/find-jobs.mjs` enforces it mechanically on everything stored.

## Flows

**1. API sweep (default)** — run:

```bash
node scripts/find-jobs.mjs search --source all --query "full stack"
```

Covers the default boards (Anthropic, Cloudflare, Datadog, GitLab, MongoDB,
Reddit, Palantir, OpenAI, Linear, Ramp) plus Hacker News job posts. Add
`--max-age N` to tighten freshness.

**2. User-given place or URL** — when the user names a site, company, or URL:

- If it is a Greenhouse/Lever/Ashby board, prefer the JSON API
  (`boards-api.greenhouse.io/v1/boards/<slug>/jobs`,
  `api.lever.co/v0/postings/<slug>?mode=json`,
  `api.ashbyhq.com/posting-api/job-board/<slug>`).
- Otherwise capture the page with WebFetch (static) or Playwright MCP
  (JS-heavy), extract postings, normalize each to
  `{ company, title, location, url, posted_at }`, write the array to a temp
  JSON file, and run `node scripts/find-jobs.mjs import <file>` so the same
  limits/dedupe apply. Never hand-edit jobs/leads.json.
- Fortune 500 companies mostly run Workday/Taleo (no public API): use their
  public careers-site search page via this capture flow, or WebSearch
  `site:<company careers domain> full stack`.

**3. HN "Who is hiring"** — for the monthly thread, fetch it via Algolia
(`search?tags=story,author_whoishiring`), read top-level comments matching the
limits, and import the same way.

## Recommending

When asked "what did you find" / "recommend jobs":

1. `node scripts/find-jobs.mjs list --status new`
2. Rank against `profile/profile.yaml` strengths (stack overlap, seniority).
3. Present a short table: company, title, location, age, URL, one-line fit
   rationale. Mention any `unknown_location` / `unknown_age` flags.
4. `node scripts/find-jobs.mjs mark <id> --status recommended` for the ones
   surfaced; `--status dismissed --notes "why"` for the ones the user rejects.

The store lives at `jobs/leads.json` (gitignored, like all personal data).
