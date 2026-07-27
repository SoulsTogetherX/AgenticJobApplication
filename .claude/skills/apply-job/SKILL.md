---
name: apply-job
description: Apply to a job in the browser via Playwright MCP - capture the
  posting, tailor resume and cover letter, fill the application form from
  approved facts, and hand off to the user for the final submit. Use when the
  user gives a job posting URL to apply to, or asks to apply for a job.
---

Drive one job application end-to-end using the Playwright MCP browser tools
(`browser_navigate`, `browser_snapshot`, `browser_click`, `browser_type`,
`browser_fill_form`, `browser_file_upload`, ...).

## Hard boundaries (never cross these)
- **NEVER click the final Submit/Apply/Send button.** The user always submits.
- Never create accounts, log in, enter passwords, or handle payment/identity
  data — if a login wall appears, pause and ask the user to log in in the
  Playwright browser window, then continue.
- Never solve CAPTCHAs — hand off to the user.
- Every form answer must come from `profile/profile.yaml` or
  `profile/answers.yaml`. Unknown → ask the user, save with
  `node scripts/save-answer.mjs`, then fill it in.

## Flow

1. **Preconditions**: Playwright MCP tools must be available (this session must
   be started in this project folder with the `.mcp.json` playwright server
   approved — check with `/mcp`). If they are not, say so and stop.
   `profile/profile.yaml` must have `meta.approved_by_user: true`.

2. **Capture the posting**: `browser_navigate` to the URL the user gave (or
   snapshot the already-open page). Extract company, title, location, full
   description, and explicit requirements.

3. **History check**: `node scripts/check-applied.mjs "<Company>"` — if this
   job/company already has an application, report what and when, and get the
   user's go-ahead before continuing.

4. **Workspace**: `node scripts/new-job.mjs <slug> --company ... --title ...
   --url ...`, then fill `job.json` with the captured description/requirements.

5. **Tailor documents**: run the tailor-resume flow, then tailor-cover-letter
   (they share `jobs/<slug>/context.json`). Both include their own verify +
   user-approval + render steps. Skip either if the form doesn't accept it.

6. **Fill the application form**:
   - Work field by field from a `browser_snapshot`. Fill contact fields from
     `contact:` in the profile (email = the job-application email).
   - Screening questions: answer from profile/answers only. Record every
     question encountered into `job.json` `questions`. For anything unknown,
     ask the user in chat first, save the answer, then fill it.
   - Upload the rendered PDFs with `browser_file_upload`.
   - Do not fabricate anything (years-of-experience numbers included).

7. **Hand-off**: take a final `browser_snapshot`, summarize exactly what was
   filled in (field → value), point out anything left blank, and tell the user
   the form is ready — **they review the browser window and click Submit**.

8. **After the user confirms they submitted**:
   ```bash
   node scripts/log-application.mjs <slug> --company "<Company>" --title "<Title>" --url "<posting url>"
   ```
   Update `context.json` statuses and confirm the log entry to the user.
