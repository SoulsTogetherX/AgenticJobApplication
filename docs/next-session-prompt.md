# Next session — start prompt

Paste everything below the line into a fresh session.

---

Read `CLAUDE.md` first. Then do the task below. **Do not read the autonomy plan
(`docs/autonomy-plan-v2.md` or `docs/autonomy/`) — it is not this task, and
reading it has repeatedly pulled sessions into building runner infrastructure
the user did not ask for.**

## Task: teach `scan-page.js` to see a Yes/No button pair

**The bug is a SILENT MISS, not slowness.** On an Ashby form (Runpod,
2026-08-03) the question _"Will you now or in the future require sponsorship for
employment visa status?"_ is rendered as two `<button>` elements. The scanner
filed them under `btns` with role `other`, which `fill-plan.mjs` ignores
completely — so the plan reported four defers and **never mentioned that
question at all**. It was found only by hand-reading the DOM.

Left alone, an application goes out with a work-authorisation question
unanswered and nothing anywhere says so. `scan-page.js`'s own header calls this
the worse failure mode: _"A silence is not a refusal."_

**Why it slips through:** the button loop hands a control to the widget sweep
only if it carries `aria-checked` / `aria-pressed` / `aria-selected`. Ashby's
buttons carry none — the selected state is a build-hashed CSS class
(`_active_1svni_57`), unusable as a signal. The file already names this as its
known residual hole ("AND ONE NAME LIST, THREE ENTRIES, WHICH IS THE RESIDUAL
HOLE AND IS STATED AS ONE"). This is that hole, hit in production.

### Tier 1 — visibility. Do this first; it is the safety half.

Detect **structurally**, with no name list: two or more sibling `<button>`s, all
resolving to role `other` via `roleOf`, all short-labelled, under a container
whose text contains a question. Emit as a verb-less `widget` field.

It then lands in `fill-plan.mjs`'s `unsupported field type` defer — reported,
blocking, never acted on. Reporting is not a verb, so this grants no new
capability. Get tier 1 green before starting tier 2.

### Tier 2 — speed.

For a recognised closed answer set (Yes/No first) emit the real group shape
instead — the one the radio/checkbox branch near `scan-page.js:647` already
builds:

```
{ k: "g1", t: "radio", l: "<the question>", req, o: [{k, sel, l: "Yes"}, {k, sel, l: "No"}] }
```

That routes it through `verb === "check"` → the `confirm-widget` gate → the
exact-text bank exemption added in `ddf85d5`. A banked answer (`a-006` answers
this exact question) then fills it with no model turn, and `submitReadiness()`
still refuses the unattended path.

**The scanner change grants nothing the `confirm-widget` gate does not already
govern. That is what makes tier 2 safe — do not weaken that gate to make this
work.**

The name list in tier 2 is a **restriction on top of** the structural detector,
never the detector itself. An unrecognised wording must fall back to tier 1 and
defer loudly.

### Tests this needs

- A Yes/No pair with no aria state becomes a field (tier 1 defers it; tier 2
  fills it from an exact bank hit).
- **A hostile pair must NOT become a fillable field.** Add a fixture under
  `tests/fixtures/hostile/forms/` with something like "Delete my account" /
  "Keep". The fill engine clicks what the plan targets, and this is the file
  where that mistake gets made.
- Real submit / next / back / upload / auth buttons still land in `btns`
  untouched — assert `btns` is unchanged for the existing fixtures.
- The board fixtures under `tests/fixtures/boards/` produce the same scan as
  today apart from the intended addition.

### Constraints

- `.claude/skills/apply-job/scan-page.js` is **the highest-risk file in the
  repo** — every application goes through it — and it is in `.prettierignore` as
  a contract. Read the whole file before editing. Do not reformat it.
- The button loop runs **before** the widget sweep, and the sweep skips anything
  already stamped. That ordering is load-bearing; do not reorder it.
- `npm test` is the gate (floor 2113). Run the single relevant file while
  iterating; run the full gate once before committing.

## Then, if there is room

`.claude/skills/apply-job/SKILL.md` still says "NEVER click a button the scan
classifies `r: submit`", which contradicts hard rule 6 as it now stands. The
harness classifier blocked that edit twice on 2026-08-03. Try once; if it blocks
again, tell the user and move on rather than routing around it.

## Standing decisions — settled, do not relitigate

1. **The agent clicks submit.** Hard rule 6, revised 2026-08-03: when the user
   gives a posting URL, the application is sent. Do not reinstate a hand-off; it
   has been removed twice. `UNKNOWN` fields still block — that is rule 1, and
   rule 1 did not move.
2. **Never put the user's name or other personal details in a markdown file.**
   Write "the user". The only legitimate homes are `profile/` and the generated
   documents under `jobs/<slug>/`.
3. **Speed is the top priority, second only to security.** The user has said so
   explicitly and measures against Jobright.
4. **Do not build Phase 5 W4 or Phase 6.** The autonomy layer has consumed weeks
   and sent zero applications; the attended path has sent 13. If autonomy work
   seems necessary, say so and ask first.

## How to be fast, concretely

The apply flow budgets **5 browser calls for page 1** (navigate, scan,
scan-to-disk, fill, advance). The 2026-08-03 session used ~16. The waste was:

- navigating in the wrong browser first — use `mcp__playwright__*`, not the
  in-app browser, for anything the skill drives;
- polling by hand to see whether the form had hydrated instead of just
  re-scanning;
- **re-verifying after the fill engine had already verified.** The skill says it
  outright: _"Do not follow this with a verification scan — the verify already
  ran inside that call."_ Trust `report.uploads`, `verify.mismatch`,
  `verify.requiredEmpty` and `revealed`. In particular, a file input reading
  empty after an upload is **normal** — Ashby and Greenhouse both replace it
  with their own attached-file view. `seen: "attached"` with a matching
  `seenFile` is the answer; re-reading the DOM afterwards only manufactures
  doubt.

Batch independent tool calls into one message. Prefer a script over reasoning —
`assemble-resume.mjs` builds a tailored resume at `model_turns=0`.

## State as of 2026-08-03

- `dev` @ `ddf85d5`, clean, gate 2113 tests / 0 fail.
- 13 applications sent; 33 new leads unworked; the unattended runner has never
  run and ships `enabled: false`.
- One known open defect besides this task: the post-submit corpus is empty, so
  `classify.mjs` returns `unclassified` for every real board. It fills from
  attended applies via `scripts/apply/capture-post-submit.mjs`; the capture on
  the Runpod apply was lost to a classifier block.
