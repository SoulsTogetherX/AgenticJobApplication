---
name: manage-sources
description: Add or remove companies in the daily job-sweep list
  (docs/job-sources.yaml), prescreening each new board with a live API check
  and refusing duplicates. Use when the user says to add, track, watch, stop
  tracking, or remove a company from the job search, or to check which boards
  are broken.
---

The daily sweep only reads `docs/job-sources.yaml`. This skill maintains that
list. Adding a board always prescreens it (live API call) and refuses
duplicates, so a broken or repeated entry can never waste a daily run.

## Adding a company ("track Stripe", "add Costco to the search")

1. **Discover which ATS hosts their jobs.** In order:
   - Probe the public APIs with likely slugs (lowercase company name, no
     spaces): `boards-api.greenhouse.io/v1/boards/<slug>/jobs`,
     `api.lever.co/v0/postings/<slug>?mode=json`,
     `api.ashbyhq.com/posting-api/job-board/<slug>`,
     `api.smartrecruiters.com/v1/companies/<slug>/postings`,
     `apply.workable.com/api/v1/widget/accounts/<slug>`,
     `<slug>.recruitee.com/api/offers/`
   - If none hit, WebFetch the company's careers page and look for the real
     board in links/redirects: `myworkdayjobs.com` URLs give
     `https://<tenant>.wdN.myworkdayjobs.com/<site>` → host/tenant/site;
     greenhouse/lever/ashby embeds give the slug.
   - Still nothing (custom portal, Taleo, SuccessFactors): tell the user the
     company has no public feed — it is still reachable through Adzuna (if
     configured) and the URL-capture flow in find-jobs.
2. **Add via the script** (it prescreens and dedupes — never edit the YAML
   for the user by hand):
   ```bash
   node src/leads/manage-sources.mjs add --type <ats> --slug <slug> --company "Name"
   ```
   Workday: `--host <tenant>.wdN.myworkdayjobs.com --tenant <tenant> --site <Site>`.
3. Report the prescreen result (how many postings visible). A "duplicate"
   error means it is already tracked — say so, don't work around it.

## Removing ("stop tracking Reddit")

```bash
node src/leads/manage-sources.mjs remove "<company or slug>"
```

## Maintenance

`node src/leads/manage-sources.mjs verify` live-checks every tracked board and
prints ok/BROKEN per line (exit 1 if any broke) — run it when the daily sweep
reports source failures, and offer to remove boards that stay broken.
