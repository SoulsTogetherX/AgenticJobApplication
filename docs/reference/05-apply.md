# 05 — `scripts/apply/` + the browser engine

Eight scripts plus three browser-side files. This is the newest and most
mechanically intricate part of the project: the form-filling path.

**The governing idea:** forms are filled by _scripts_, not by the model. The model
is in the loop exactly twice per application — once to write the approval message,
once to hand the user the submit button.

---

## The division of labour

```
.claude/skills/apply-job/scan.driver.mjs   ← runs Playwright-side (real locators)
.claude/skills/apply-job/scan-page.js      ← runs in the PAGE (DOM access)
        │  produces the scan
        ▼
scripts/apply/field-cache.mjs      remembers the SHAPE of forms already seen
scripts/apply/answer-bank.mjs      scan fields → answers, from facts only
scripts/apply/ats/*.mjs            per-ATS knowledge (never behaviour)
scripts/apply/fill-plan.mjs        the DECISIONS happen here
        │  produces fill-plan.js / .json
        ▼
.claude/skills/apply-job/fill-page.js      ← the EXECUTION engine, no decisions
scripts/apply/pending-questions.mjs        every open question, across all jobs
```

---

## `scan-page.js` (364 lines) — the page scanner

**Not a module.** It is eval'd as a bare function expression, so no imports, no
exports, and no leading semicolon — which is why it lives in `.prettierignore`
(prettier's leading-semicolon guard would make it unparseable). It is the **single
source of truth**; `scan.driver.mjs` reads it off disk and injects it as
`window.__ajScan`.

```js
window.__ajScan = async (PROBE = true) => { … }
```

Returns `{ url, heading, kind, fields[], btns[], iframes?, signals? }`.

### The output keys are short on purpose

`k`=key, `t`=type, `l`=label, `req`=required, `v`=current value, `opts`=choices,
`o`=stamped sub-options, `h`=help text, `sel`=stable selector. Every byte of this
lands in agent context.

### `data-aj` vs `sel` — why both exist

Every interactive element is stamped `data-aj="f7"`, so `[data-aj="f7"]` is a
unique Playwright `target`. But **`data-aj` stamps are DOM attributes and do not
survive a React remount** — uploading a file on Greenhouse re-renders the form and
drops every stamp. So each field also carries `sel`, a selector built from
attributes the _app_ owns: `#id`, then `name` / `data-testid` / `data-qa` /
`aria-label`, each verified unique before being used.

The two escapers are different and both are needed: an `id` goes into a CSS
identifier position and needs `CSS.escape`; an attribute **value** sits inside
quotes and only needs the quote and backslash escaped — `CSS.escape` would turn a
space into `\20` and break the match.

### `labelOf(el)` — six strategies in order

`aria-labelledby` → `aria-label` → `label[for=id]` → wrapping `<label>` →
`<fieldset><legend>` → walk up 4 ancestors looking for a label/legend/`[class*=label]`/
`[class*=question]` that does not contain the element → `placeholder` → `name`.

That ordering is the difference between a usable scan and a useless one; real ATS
forms use all six.

### Field classification

- Custom dropdown containers (`[role=combobox]`, `[aria-haspopup=listbox]`,
  `[class*=select__control]`, `[data-ui=select]`) **claim their descendants**, so
  the raw `<input>` inside a react-select is not scanned separately.
- `type=password` → **skipped**, and pushes the signal _"password field — login
  wall, hand off to the user"_. The scanner never even records it.
- radios and checkboxes are grouped by `name` into one field with an `o` array of
  stamped options.
- `contenteditable=true` → `t: "richtext"`.
- Fields are sorted into **document order** via `compareDocumentPosition`.

### Button classification — `roleOf(label)`

`submit` | `next` | `back` | `start` | `upload` | `auth` | `other`. Links whose
role is `other` are dropped. This classification is what the skill's hard boundary
rests on: **never click `r:"submit"`**, and never click `r:"start"` on a page that
already has fields, because on most ATSs the final button is worded
"Apply"/"Submit Application" and the scanner cannot tell by text alone.

### Page-level `kind`

`login` (a password field was seen) → `confirm` (thank-you text) → `form` (there
are fields) → `ad` (only a start button) → `unknown`. Plus signals for CAPTCHA
iframes and for an application embedded in a Greenhouse/Lever/Ashby/Workday iframe
(which cannot be scanned or filled through the parent frame — you must navigate to
the embedded URL).

### The probe

`PROBE=true` opens each combo in the page and reads its options. **This does not
work on react-select** — React ignores the programmatic `el.click()` that
page-context code can make, so menus never opened and every dropdown came back
empty, which meant the planner deferred them all to the user. That is why the real
probe lives in `scan.driver.mjs`, where Playwright's click is a real input event.

> **Defect:** `MAX_OPTS = 40` silently truncates option lists, and the in-page
> `MAX_PROBE = 15` disagrees with the driver's 18. AUDIT **H3**, **L12**.

---

## `scan.driver.mjs` (83 lines) — one tool call, no pasted code

```
mcp__playwright__browser_run_code_unsafe
  { filename: ".claude/skills/apply-job/scan.driver.mjs" }
```

Also not a module (same `.prettierignore` reason). Deliberately small: it is echoed
back in the tool result, and a big driver would put that cost straight back into
context.

1. `addInitScript({ path })` — makes `window.__ajScan` survive every later
   navigation in the session, so a structure-only re-scan is the ~30-token call
   `browser_evaluate () => window.__ajScan(false)`.
2. `addScriptTag({ path })` for the current document; on strict CSP that throws and
   it falls back to `page.reload()`.
3. `__ajScan(false)`, then **retry once** if `btns` is empty — scanning before React
   hydrates returns the raw inputs behind the custom widgets instead of the widgets
   themselves, and no buttons at all, which is the tell.
4. For each combo with no options (capped at 18): real Playwright click → read
   options → Escape. It tries `[class*='__option']` **first**, because a bare
   `[role=option]` also matches the phone country-code widget, which is always in
   the DOM and would hand every dropdown the same list of countries.
5. Stashes the result as `window.__ajLastScan` so it can be written to disk without
   paying for it twice.

> **Defect:** the CSP fallback reloads the page, discarding anything already typed
> into the form — and the comment above it is a truncated fragment. AUDIT **M14**.

---

## `field-cache.mjs` (119 lines) — remember the shape, never the answers

The expensive half of a page scan is probing custom dropdowns — up to 15 of them,
in the browser, every time. Everything it learns is identical on the next
application to the same board.

```js
CACHE_VERSION = 2
fingerprint(scan, atsId)   // sha1 of atsId + sorted REQUIRED labels, 16 hex chars
loadCache / saveCache
applyCache(scan, entry)    // fill gaps; a fresh probe always wins
recordCache(cache, {…})    // merge what this scan learned
invalidate(cache, fp)
```

**Keyed by the form's shape, not its URL:** two Coinbase postings are different
URLs but the same Greenhouse form, and a board that redesigns its form gets a
different fingerprint and re-probes automatically.

**Required labels only** in the fingerprint: optional fields (EEO blocks
especially) come and go between postings on the same board and would churn the key
for no reason.

`fieldKey` is `label|type`, not label alone — composite widgets put a picker and a
text input under one label (a phone country selector next to the number), and a
label-only key would hand the country list to the text input.

`applyCache` reports `hits` against **every** field that needs an option list, not
just the ones the cache knew — otherwise a total miss and an empty form both read
as `0/0` and there is no way to tell them apart.

**The cache never stores answers**, only structure. Answers live in
`profile/answers.yaml` and go through `save-answer.mjs`.

> **Defects:** `opts.slice(0, 60)` truncates silently, and entries never expire.
> AUDIT **H3**, **M11**.

---

## `answer-bank.mjs` (746 lines) — fields → answers, from facts only

```bash
cat scan-p1.json | node scripts/apply/answer-bank.mjs
node scripts/apply/answer-bank.mjs --fields '<json array>' [--json]
```

Output per field: `<key> \t <status> \t <source> \t <value>`

| status         | meaning                                                          |
| -------------- | ---------------------------------------------------------------- |
| `OK`           | ready to fill                                                    |
| `NEEDS-CHOICE` | a value resolved but no offered option matched — the agent picks |
| `MAYBE`        | weak bank match — the agent confirms wording                     |
| `UNKNOWN`      | not in the fact base — ask the user, then `save-answer.mjs`      |
| `SKIP`         | a file or rich-text field (undocumented in the header block)     |

**It never invents an answer.** Anything it cannot resolve comes back UNKNOWN.

### Resolution order — and why exact-match is first

```
1. SKIP_TYPES (file, richtext)          → SKIP
2. no label                             → UNKNOWN
3. exactBank.get(normalizeQuestion(l))  → the answer saved for THIS exact question
4. EEO_RE                               → the "decline to answer" option
5. QUESTION_RULES  (label is a question)
   + CONTACT_RULES
   + PROFILE_RULES (only when the label is NOT a question)
6. bestAnswer(label) ≥ 0.70             → OK
   bestAnswer(label) ≥ 0.45             → MAYBE
7. otherwise                            → UNKNOWN
```

**Step 3 sits ahead of the rules deliberately.** The rules fire first by design —
they map a form's wording onto profile facts. But a rule that resolves a value the
form does not actually offer returns `NEEDS-CHOICE`, and it will do so on that same
field for _every future application_, because a rule hit short-circuits the bank
and the pick the user approved last time is never consulted. Checking exact
matches first is what makes an approved pick stick.

There is no fuzzy tier at step 3: the 0.45 MAYBE band exists precisely because
near-matches are unreliable, and this path skips the concept guard.

### `IS_QUESTION` — why questions get different rules

```js
/\?\s*\*?\s*$|^\s*(are|do|did|does|have|has|were|was|will|would|can|could|is|
                   to your knowledge|please confirm)\b/i
```

Labels phrased as questions are **not** profile fields, however many field-ish
words they contain. Without this, _"were you referred to this position by a senior
leader?"_ was answered with the job title, and _"authorized to work in the country
where this position is located?"_ with the home city.

> **Defect:** the list omits why/what/which/where/how/tell us/describe, so
> "Why you are interested in this position" is treated as a field and filled with
> the user's current job title, marked `OK`. AUDIT **M1**.

### The concept guard

Some questions are near-identical in wording but **opposite in meaning**. _"Do you
require sponsorship?"_ and _"Are you legally authorized to work?"_ share almost
every token, so token similarity ranked the authorization answer ("Yes") against
the sponsorship question — which would have claimed the user needs a visa.

```js
CONCEPTS = [
  ["sponsorship", /sponsor|visa/],
  ["work_authorization", /authorized to work|right to work|…/],
]
```

Concepts are matched **before**, and constrain, the fuzzy pass. Order matters: a
label naming both ("…sponsorship… to maintain authorization to work…") is about
sponsorship.

### `matchOption(value, opts)`

Tries: exact (case-insensitive) → **prefix either way** → long-form Yes/No
(`YES_LONG`/`NO_LONG`). Accepts an ordered list of acceptable answers; the first the
form actually offers wins. Forms rarely offer a bare Yes/No — Affirm's
prior-employment question offers _"I have not previously been employed at
Affirm"_ — which is what the long-form patterns are for.

> **Defect — the most serious in the project.** The prefix rule silently upgrades a
> generic answer into a specific claim and marks it `OK`: a banked "Yes" plus
> options `["Yes, 5+ years professionally", …]` resolves to _"Yes, 5+ years
> professionally"_. That is a false claim on a real job application, produced
> deterministically, with no human review. It also picks "None of the above" for a
> resolved "No". AUDIT **C1**, **C2**.

### The rule tables

**`CONTACT_RULES`** — name (first/last/full), email, phone, LinkedIn, GitHub,
portfolio, city, state, other-links, address lines. Details that were learned the
hard way:

- _"Name Pronunciation"_ asks how to say it, not what it is — an anchored
  `/^name\b/` answered that with the name itself on a real Affirm form.
- `stateCandidates` offers **both** "Nevada" and "NV", because option lists
  overwhelmingly spell states out while a profile address abbreviates.
- A street address is **not** the city-level `contact.location`. Greenhouse asks
  for "Address Line 1"/"Line 2" alongside separate City/State fields, and letting
  the generic location rule match them put "North Las Vegas, NV" in the street slot
  and then repeated it on line 2. Street addresses are not a profile fact — they
  resolve from the answer bank by exact question match and nowhere else. An empty
  result is `UNKNOWN`, which is correct: line 2 is optional and stays blank.
- "Other links" only emits GitHub/website if this same form has **no dedicated
  field** for them, so a catch-all box does not duplicate what is captured
  elsewhere.

**`PROFILE_RULES`** — current employer, job title, start/end month and year,
school, degree, discipline. `"current role"` must precede the title rule, or a
"Current role" checkbox gets answered with the job title instead of being ticked.
"Current" means the role still **running**, not the one that started most
recently — a short contract begun later must not displace the ongoing job.
`DEGREE_LEVELS` restates "B.S. Computer Science & B.S. Mathematics" as
"Bachelor's Degree", the wording ATS dropdowns actually offer — a restatement, not
a new claim.

**`QUESTION_RULES`** — prior employment and "how did you hear about us".
`priorEmployment` answers **only the negative**: the profile can prove someone is
_absent_ from a complete employment history, but not in what capacity they were
employed if they are present.

---

## `ats/` — knowledge, never behaviour

```
index.mjs      detectAts(url) → adapter; HANDOFF list checked first
greenhouse.mjs lever.mjs ashby.mjs generic.mjs
```

An adapter contributes only knowledge: which combo strategy to try first, which
file field takes which document, and where an ATS renders a value differently from
the option text. **The fill engine contains no ATS-specific code**, so an
unrecognised board still works — it just defers more fields.

| adapter    | combo order                          | why                                                                                                        |
| ---------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| greenhouse | type-enter, type-click, click-option | type-enter resolved 16 of 19 dropdowns in the live run; the education selects needed the exact row clicked |
| lever      | click-option, type-enter, type-click | mostly native selects; its few custom pickers do not filter                                                |
| ashby      | type-enter, click-option, type-click | react-style dropdowns                                                                                      |
| generic    | type-enter, type-click, click-option | `match: /.^/` — never auto-matches, selected only as the fallback                                          |

**Workday is detected but deliberately not adapted.** Its application flow requires
creating an account, which the agent is not permitted to do. `fill-plan.mjs` exits
**3** with an honest hand-off message rather than stalling at a login wall.

> **Defect:** `valueAliases` — Greenhouse's documented fix for its country picker
> rendering "United States +1" — is defined on every adapter and read by **nothing**.
> AUDIT **H8**. And `detectAts` tests the whole URL rather than the hostname —
> AUDIT **L6**.

---

## `fill-plan.mjs` (459 lines) — where the decisions happen

```bash
node scripts/apply/fill-plan.mjs <slug> [--scan p] [--url u] [--resume pdf]
                                 [--cover pdf] [--no-cache] [--invalidate] [--json]
```

Exit **0** ok, **2** usage/missing scan, **3** the ATS needs a human.

### `isConsent(label)` — always defer

Arbitration, terms and conditions, privacy notice, confirm receipt,
"I agree/consent/acknowledge/understand/certify", e-signature, background check,
"consent to", code of conduct. These are the user's to accept, so they **never**
become plan items no matter how confidently the bank resolves them.

Deliberately does **not** match "Are you legally authorized to work…" — that is a
fact about the user, not a promise being extracted from them.

### `buildPlan` decisions, in order

1. `isConsent` → defer. Outranks everything.
2. `duplicateCombo` → skip. intl-tel-input exposes a picker **and** a text input
   under the same label; filling both puts the phone number into the country
   selector, which then fails every strategy and reports a bogus failure. The
   picker is marked `skip` so it stays visible in the plan rather than silently
   vanishing.
3. file field → match `adapter.fileFields` by label, else fall back to
   `adapter.fileOrder` by document order. Greenhouse labels both attachment inputs
   just "Attach" — the real heading sits outside the element the scanner reads.
4. unsupported type → defer.
5. `UNKNOWN`/`NEEDS-CHOICE`/`MAYBE` → **defer if required, `skip` if optional**.
   Asking the user for a Twitter handle they do not have is noise, and noise is
   what makes an approval message get skimmed. Still counted and listed, so nothing
   disappears silently.
6. radio/checkbox → target the **option's** key (`r.pick`), since the group has no
   element of its own.
7. otherwise → `{ how: VERB[f.t], value }`.

Then a post-pass: a ticked "current role" box disables the end-date pair on every
one of these boards, so those defers are converted to `skip` rather than being
asked about.

### `readiness(plan)`

```js
{ ready: false, reason: "N deferred field(s) need a human" }  // any defer
{ ready: false, reason: "nothing to fill" }                   // no fillable items
{ ready: true,  reason: null }
```

The planner already knows the answer — it counted the defers and knows whether
anything is left to fill. Emitting a boolean means the caller branches on a flag
instead of reading the plan and forming an opinion. On `ready=true` the path is
scan → fill → hand over, with **no model step in between**.

> **Defect:** consent defers count against `ready`, and consent boxes are
> universal, so `ready=true` is effectively unreachable — which defeats the fast
> path the flag exists to enable. `pending-questions.mjs` excludes consent for
> exactly this reason, so the two scripts disagree. AUDIT **H10**.

### The bootstrap it prints

```js
;async (page) => {
  for (const p of [
    ".claude/skills/apply-job/fill-page.js",
    "jobs/<slug>/fill-plan.js",
  ])
    await page.addScriptTag({ path: p })
  const [src, plan] = await page.evaluate(() => [
    window.__ajFillSrc,
    window.__ajPlan,
  ])
  return await eval("(" + src + ")")(page, plan)
}
```

`addScriptTag` loads the engine and the plan **off disk**, so nothing but those six
lines enters agent context regardless of how big the form is.

> **Defect:** it reads executable code back **out of the untrusted page** and
> `eval`s it host-side. A hostile ATS page can replace `window.__ajFillSrc`. AUDIT
> **C6**. And `resolveFields` passes the whole scan as a command-line argument,
> which on Windows has a ~32K limit — AUDIT **M15**.

---

## `fill-page.js` (400 lines) — the execution engine

Also shipped as **source**, not a module: the driver loads it into the page, reads
the string back, and evals it Playwright-side where `page` and real locators exist.
Everything must be self-contained — no closure over module scope, no imports.

**Sandbox facts:** the Playwright MCP vm context has `page` and the standard
built-ins but **no `setTimeout`, no `console`, no `require`**. Use
`page.waitForTimeout`. There is also no default action timeout in that context, so
every locator call passes an explicit one.

### The interaction choices, all learned the hard way on Greenhouse

- `dispatchEvent(new MouseEvent(…))` does **not** register in React state; the value
  appears on screen and the field still validates as empty.
- Custom dropdowns need **real** input events: `locator.click()`,
  `keyboard.type()`, `keyboard.press('Enter')`.
- `locator.setInputFiles()` **does** register with React — verified on Greenhouse,
  where the input is swapped for the attached-file view. Do **not** "fix" this into
  a real file chooser: Playwright MCP owns the `filechooser` event, so a
  `waitForEvent` in here never fires and stalls the call as a pending modal.
- Uploads remount the form and `data-aj` stamps do not survive, hence **uploads
  first** and `sel`-first resolution everywhere else.

### The safety property

> "SAFETY: there is deliberately no verb that clicks a button. _Never click submit_
> is not a rule this engine follows — it is a thing it cannot express."

That is the right way to build a guarantee. (AUDIT **C6** explains how the current
bootstrap undermines it.)

### Sequence

1. **urlGuard** — a plan is built against one specific form; filling a different
   page with it would silently put answers in the wrong fields.
2. **uploads**, found by the text _around_ the input via `stampInput`, because the
   first upload remounts the form and invalidates the stamp for the second.
3. **everything else** — `locate` (sel then `data-aj`), `kindOf` (refuse anything
   that is not a real form control), then `fill` / `select` / `check` / `type` /
   `combo`.
4. **`setCombo`** walks the adapter's strategy order, verifying `shownValue` after
   each attempt and pressing Escape before the next.
5. **verify once** — blur, wait, read every field back, and sweep the page's own
   rendered validation text. That last part matters: element state alone lied
   before, and rendered error text is the only reliable signal that the app itself
   considers a field unset.
6. **report `next`** and never click it.

> **Defect:** `stampInput`'s fallback stamps `inputs[0]` regardless, despite the
> comment claiming "the first input still awaiting a file" — so a cover letter can
> land in the resume slot. AUDIT **M12**.

---

## `pending-questions.mjs` (301 lines) — ask once, for everything

```bash
node scripts/apply/pending-questions.mjs [<slug> …] [--no-predict] [--json]
```

`profile/answers.yaml` is **global**: "Do you require sponsorship?" answered once
resolves it for every application ever. Asking per job, while the user waits at a
form, means the same question gets asked N times and N−1 of those are pure latency.

Two sources:

- **`plan`** — a defer already computed for a scanned form. Certain, tied to slugs.
- **`predicted`** — a required field remembered in `.field-cache.json` for an ATS
  these jobs use, that the fact base still cannot resolve. Likely, and available
  **before any browser is opened**. `predictedFields` turns cached shapes back into
  scanner-shaped fields so the same `answer-bank` pass resolves both.

`ASKABLE` filters the defers down to the ones that are genuinely _questions_
(`unknown`, `needs-choice`, `maybe`, `unresolved`, `no option matched…`).
Everything else `buildPlan` defers — a missing PDF, an unsupported widget, a
consent box — is a different kind of problem, and batching it in would bury the
real questions.

**Consent, terms and e-signature fields are never listed.** They are the user's to
tick in the browser, not questions with answers worth storing.

`mergeQuestions` keys on the normalized label — exactly what `answer-bank`'s
exact-match bank is keyed on, so one saved answer resolves every merged entry. Sorted
most-shared-first: the question that unblocks four applications belongs at the top of
the message.

Prediction only uses cache entries that recorded whether a field was **required**;
a cache written before that was stored says nothing about which fields the form
insists on.
