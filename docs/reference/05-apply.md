# 05 — `scripts/apply/` + the browser engine

This is the newest and most mechanically intricate part of the project: the
form-filling path.

**The governing idea:** forms are filled by _scripts_, not by the model. The model
is in the loop exactly twice per application — once to write the approval message,
once to hand the user the submit button.

> **Partially rewritten during Phase 1 of `docs/autonomy-plan.md`
> (2026-07-31).** `.claude/skills/apply-job/fill-page.js` **no longer exists**;
> the engine is `scripts/apply/fill-engine.mjs` and it runs Playwright-side. The
> `addScriptTag` bootstrap this file used to document was the round-trip RCE
> (AUDIT **C6**) and is closed — see "The bootstrap it prints" and "the execution
> engine" below, both corrected. The `scan-page.js` / `scan.driver.mjs` sections
> describe files that `w2-engine` is still changing; treat their line counts and
> step lists as approximate and read the file.
>
> **Second sweep, 2026-07-31 (`doc-scribe`).** Four more sections had gone stale
> against code that landed the same day, each corrected inline below: the scan
> output no longer has only the nine short keys (`n` / `ac` / `lSeen` were
> added), `readiness()` no longer counts a consent defer (**H10 is closed**),
> `buildPlan` no longer reads `scan.fields[].labelExact` at all, and
> `matchOption`'s prefix rule now has a grounding check (**C1 / C2 closed**).
> Line counts throughout were re-derived on 2026-07-31 with `wc -l`.

---

## The division of labour

```
.claude/skills/apply-job/scan.driver.mjs   ← runs Playwright-side (real locators)
.claude/skills/apply-job/scan-page.js      ← runs in the PAGE (DOM access)
scripts/apply/scan-engine.mjs              ← the same scan for the local runner
        │  produces the scan
        ▼
scripts/apply/field-cache.mjs      remembers the SHAPE of forms already seen
scripts/apply/answer-bank.mjs      scan fields → answers, from facts only
scripts/apply/ats/*.mjs            per-ATS knowledge (never behaviour)
scripts/apply/fill-plan.mjs        the DECISIONS happen here
        │  produces fill-plan.js (a self-contained driver) / .json
        ▼
scripts/apply/fill-engine.mjs      ← the EXECUTION engine, no decisions,
                                      Playwright-side, never in the page
scripts/apply/browser.mjs          ← reads the engine's own text off disk
scripts/apply/pending-questions.mjs        every open question, across all jobs
```

---

## `scan-page.js` (863 lines) — the page scanner

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

Four more, added 2026-07-31 by `w2-engine` and absent from the list above until
this correction:

| key        | on                    | what it is                                                                                                |
| ---------- | --------------------- | --------------------------------------------------------------------------------------------------------- |
| `n`        | any field             | the element's `name` attribute, verbatim                                                                  |
| `ac`       | any field             | the element's `autocomplete`, verbatim, minus the reserved `on`/`off`                                     |
| `lSeen`    | any field             | the **visible** label, present only when `l` is text the user cannot read and something visible disagrees |
| `labelWhy` | checkbox/radio groups | why the `labelExact` vouch was refused — advisory, for a human reading a defer; nothing decides on it     |

`n` and `ac` exist because a consumer was reverse-engineering identity back out
of the `sel` **selector** string, and `stableSel()` tries `#id` first, so on any
page whose inputs have ids — most pages — `sel` carried the id and nothing else.

> **Do not describe `n` / `ac` / `t` as a defence against a lying label.**
> `scan-page.js`'s own header says so in as many words, and it is right: the
> page chooses all three, so renaming `name` to agree with the lie defeats the
> comparison in one line with nothing a user could see changing. Measured by
> `innov-resilience` on 2026-07-31, running the real scanner over a variant of
> the mislabelled fixture with `id`, `name` and `autocomplete` all renamed to
> match: **3 of 4 hostile fields undetected.** `autocomplete` in particular
> appears on **zero** of the four honest board pages in
> `tests/fixtures/boards/pages/`, and only on hostile fixtures under
> `tests/fixtures/hostile/forms/` (verified by `grep` on 2026-07-31); a signal only an attacker supplies is not a guard input. What
> these keys are legitimately for is choosing the **verb** (`t` decides type /
> tick / upload) and making a substitution **non-silent** — showing a target's
> real `name` beside its label in an approval message means a swapped field is
> visible to the user even when no check caught it. The real control against a
> government ID reaching a form is value-side: such a value never enters the
> answer bank (`findSensitiveValues`, see [02-lib.md](02-lib.md)).

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

## `scan.driver.mjs` (198 lines) — one tool call, no pasted code

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

## `field-cache.mjs` (216 lines) — remember the shape, never the answers

The expensive half of a page scan is probing custom dropdowns — up to 15 of them,
in the browser, every time. Everything it learns is identical on the next
application to the same board.

```js
CACHE_VERSION = 3
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

## `answer-bank.mjs` (950 lines) — fields → answers, from facts only

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

Tries: exact (case-insensitive) → **prefix either way, grounded** → long-form
Yes/No (`YES_LONG`/`NO_LONG`). Accepts an ordered list of acceptable answers; the
first the form actually offers wins. Forms rarely offer a bare Yes/No — Affirm's
prior-employment question offers _"I have not previously been employed at
Affirm"_ — which is what the long-form patterns are for.

The two prefix directions are **not** symmetric, and that asymmetry is the fix:

- **The option is longer** and merely starts with the banked value — the option
  may be asserting something new, so it is accepted only when
  `remainderIsGrounded()` finds every surviving token already present in the
  **field's own label** (negation cues excepted).
- **The value is longer** and starts with the option — the option is a clean
  truncation of a more detailed true statement ("Yes, US citizen, no sponsorship
  needed." → "Yes"). Truncation can only drop detail, never invent it, so no
  grounding is needed; only a real word boundary, so "November" cannot truncate
  to "No" on a two-letter coincidence.

> **AUDIT C1 / C2 — CLOSED**, verified 2026-07-31 by reading
> `answer-bank.mjs`'s `matchOption` / `remainderIsGrounded`. The original entry,
> kept because it is what the guard exists to stop: the prefix rule silently
> upgraded a generic answer into a specific claim and marked it `OK` — a banked
> "Yes" plus options `["Yes, 5+ years professionally", …]` resolved to _"Yes, 5+
> years professionally"_. **That is a false claim on a real job application,
> produced deterministically, with no human review.** It also picked "None of the
> above" for a resolved "No", inventing a list-negation the label never offered.
> `none\b` is now deliberately absent from `NO_LONG`, because the pattern cannot
> tell a two-option form from a multi-select by option text alone, and one extra
> defer beats guessing wrong on a form the engine cannot re-ask.

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

## `fill-plan.mjs` (1389 lines) — where the decisions happen

```bash
node scripts/apply/fill-plan.mjs <slug> [--scan p] [--url u] [--resume pdf]
                                 [--cover pdf] [--no-cache] [--invalidate] [--json]
```

Exit **0** ok, **2** usage/missing scan, **3** the ATS needs a human.

### The consent branch — two doors, one gate

`isConsent(label)` matches arbitration, terms and conditions, privacy notice,
confirm receipt, "I agree/consent/acknowledge/understand/certify", e-signature,
background check, "consent to", code of conduct. These are the user's to accept,
so they **never** become plan items no matter how confidently the bank resolves
them. It deliberately does **not** match "Are you legally authorized to work…" —
that is a fact about the user, not a promise being extracted from them.

**A topic list cannot be exhaustive, and that is the finding it was rebuilt
around** (`w3-resolution` + `innov-resilience`, pinned in
`tests/security/hostile-forms.test.mjs`): whatever wordings you add, the 26th rewording is
free, and a consent box that matched nothing fell through to the ordinary
checkbox branch where none of these controls run again. So entry to the
protected branch is now **two doors**:

- `isConsent(label)` — a **topic** match.
- `looksLikeAgreementProse(field, label)` — a **shape** match, needing no topic
  word at all: a single-option checkbox whose label is ≥ 8 words and ends in `.`
  or `!`. A legal clause is written as a full sentence stating what is agreed to,
  because that is what makes it legally meaningful; an ordinary toggle ("Current
  role", "Subscribe to job alerts") is short and does not end like a sentence.
  Both signals are required, so a false positive costs exactly one extra defer.

Either door leads to the **same** gate — never a bypass of its own. A box only
becomes a `check` item when **all** of: our own scanner vouched for the exact
text, the exact normalized label is on the user's `--consent-allowlist`,
`isHardConsent` does **not** recognise it (arbitration / dispute resolution /
background check / e-signature / jury-trial waiver are excluded _regardless_ of
the allowlist), and it is a single-option checkbox. Otherwise it defers.

> **Nothing auto-ticks on any path that runs today, and this is a fact about
> plumbing rather than about the gate.** The vouch is the in-process
> `vouchedLabels` argument (below), and it has **no producer on this CLI's
> scan-file path** — so `vouchedSet` is empty and every consent box defers,
> allowlist or not. Since H10 closed, that costs nothing: a consent defer does
> not block `ready`.

### `labelExact` is no longer a control — the vouch travels out of band

`scan-page.js` computes `labelExact` to mean "`l` is the complete, visible text
of this control's label". It used to travel as a **boolean field inside the
scan**, and a boolean inside a JSON document is only worth the document's own
trustworthiness — a hand-written scan with `labelExact: true` on truncated
wording was indistinguishable from a real one.

So, as of `58d89b6`:

- `scan-engine.mjs` returns `{ scan, vouchedLabels }` — the vouch is a **second
  return value**, in-process, never serialised and never stashed in the page.
- `buildPlan` takes `vouchedLabels` as a parameter and **ignores
  `scan.fields[].labelExact` entirely**, with a belt-and-braces `delete` of the
  flag on every field and option.
- It **fails closed**: with no vouch, every consent box defers.

The honest limit, which `scan-engine.mjs` states about itself: `labelExact` says
the text is complete and visible, not that it is _honest_. A board can display a
short, complete, entirely misleading clause. The floor under the vouch is the
allowlist — the attacker has to reproduce text the user typed into their own
file.

### `buildPlan` decisions, in order

1. `isConsent(label) || looksLikeAgreementProse(f, label)` → the consent branch
   above. Outranks everything.
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

### `readiness(plan)` and `submitReadiness(plan)`

```js
// readiness — "does a MODEL need to think before the engine can run?"
{ ready: false, reason: "N deferred field(s) need a human" }  // any NON-consent defer
{ ready: false, reason: "nothing to fill" }                   // no fillable items
{ ready: true,  reason: null }
```

The planner already knows the answer — it counted the defers and knows whether
anything is left to fill. Emitting a boolean means the caller branches on a flag
instead of reading the plan and forming an opinion. On `ready=true` the path is
scan → fill → hand over, with **no model step in between**.

> **AUDIT H10 — CLOSED 2026-07-31 (`w3-resolution`, `58d89b6`).** The text below
> is the entry as written, kept because it records why the obvious fix was
> refused; only its "still open" status changed.
>
> ~~**Defect, still open:** consent defers count against `ready`, and consent
> boxes are universal, so `ready=true` is effectively unreachable — the
> documented fast path has never once executed. `pending-questions.mjs` excludes
> consent for exactly this reason, so the two scripts disagree.~~
>
> **Do not close this by auto-ticking consent.** That was tried and withdrawn:
> the allowlist, `isHardConsent` and the scanner's `labelExact` vouch all read
> one page-supplied string, so they are one control wearing three hats.
>
> **What shipped is the redefinition, not an auto-tick.** `readiness()` now
> filters `d.why !== "consent"`, so a consent-only defer no longer blocks
> `ready`, and the two scripts agree with `pending-questions.mjs` at last. The
> question `ready` answers is "does a **model** need to think before the engine
> can run?" — and a consent box does not change that answer, because the user
> ticks it in a browser they are already looking at, reviewing the filled form
> before clicking Submit themselves. **Nothing ticks a consent box.** Hard rule
> 6 is untouched by what either function returns.
>
> The stricter twin `submitReadiness(plan)` answers a different question —
> "is there anything at all left undecided, consent included?" — and **any**
> defer blocks it, consent included. It is the plan-side half of the two-key
> pre-submit gate in `docs/autonomy-plan.md` §3.3; the fuller gate needs the
> fill **report** (verify mismatches, required-empty fields, which button is
> submit-shaped) and so cannot exist until Phase 3 builds it. The CLI prints
> both: `ready=… submitReady=…`.

### The bootstrap it prints

```
mcp__playwright__browser_run_code_unsafe
  { filename: "jobs/<slug>/fill-plan.js" }
```

`buildDriverSource()` **generates** `jobs/<slug>/fill-plan.js` — a single
`async (page) => { … }` with the engine's text and the plan embedded as string
literals. Both were read in an ordinary Node process (fill-plan.mjs itself); the
vm the MCP tool runs it in has no `fs`, no `require`, and no working dynamic
`import`. `filename` rather than `code` is what keeps a large form's plan out of
agent context.

The generated driver does exactly this:

```js
const runFill = (0, eval)(ENGINE) // ENGINE came off OUR OWN disk
return await runFill(page, PLAN) // PLAN travels as an argument
```

> **AUDIT C6 — CLOSED (`fc645f5`, `1cc7d9b`).** The version this replaced
> `addScriptTag`ed the engine **into** the page, read `window.__ajFillSrc` back
> **out**, and eval'd that host-side where `page` lives. Any script on a
> third-party application page could define that global as a getter and choose
> what ran with a live `page` handle — navigate, read everything already typed,
> `setInputFiles` the user's `.env` into its own form, click Submit. Nothing is
> read back out of the page any more. **Do not reintroduce a read-back**, and do
> not "fix" the loading path back to `addScriptTag`: a nonce-CSP board (Ashby)
> refuses an inline `<script>` outright, which broke the fill step on a live
> application.
>
> Still open from the original entry: `resolveFields` passes the whole scan as a
> command-line argument, which on Windows has a ~32K limit — AUDIT **M15**.

---

## `fill-engine.mjs` — the execution engine

An ordinary ES module with one default export, `fillPage(page, plan)`. **Every
statement in it is a Playwright call** (`page.locator`, `page.keyboard`,
`loc.fill`); the only code that ever executes inside the page is the inline
arrows handed to `page.evaluate`, which Playwright serialises itself. It never
needed to be loaded into the page, and it no longer is.

Two consumers: `browser.mjs` simply `import`s it, and `fill-plan.mjs` reads this
file's **text** off its own disk and embeds it in the generated bootstrap.
Because of the second one, everything in it must stay self-contained — no
imports, no closure over module scope, no reference to anything the file does not
itself define.

Values that come back from the page (a scan result, a field's current text) are
**data**, and are only ever read as data: never eval'd, never dispatched on.

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
- A stale/detached-element error immediately after `locate()` is retried **once**
  with a freshly re-resolved locator (`actOn` / `isStaleError`). Ashby's
  resume-autofill parses the uploaded PDF and remounts the form
  _asynchronously_, after the upload settle delay has already waited for the
  upload itself — a live run logged `f3` as failed while its value had in fact
  landed. Safe because fill/select/check are idempotent.

### The safety property

> "SAFETY: there is deliberately no verb that clicks a button. _Never click submit_
> is not a rule this engine follows — it is a thing it cannot express."

That is the right way to build a guarantee, and it is now structural: with the
C6 round-trip closed, no third party gets to choose what runs against `page`, so
the absence of a click verb actually means what it says. It did not, while the
bootstrap read its own engine back out of an untrusted page.

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

## `pending-questions.mjs` (317 lines) — ask once, for everything

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
