# The local fake ATS

A tiny Node `http` server serving static replicas of Greenhouse, Lever and Ashby
application forms, plus hostile variants. It is the reason the browser path is
testable in CI at all, and the reason QA never touches a live employer's board.

**Nothing in this tree is a tool.** The hostile pages are real attack strings.
The only thing that makes them safe to keep in a repository is that the server
binds loopback and refuses to bind anything else — `assertLoopback()` throws on
`0.0.0.0`, on a LAN address, on a hostname. There is no proxy, no upstream
fetch, no redirect off-host: `tests/security/fake-board.test.mjs` asserts the
absence of every outbound primitive in `server.mjs`.

## Run it by hand

```
node tests/fixtures/boards/server.mjs             # ephemeral port, prints the URL
node tests/fixtures/boards/server.mjs --port 8899 # fixed port
```

It prints every route and stays up until Ctrl-C. `GET /` is an index page and
`GET /routes.json` is the same list as JSON, so `bench-apply.mjs` and a human
read one source and it cannot drift from what is served.

## Use it from a test

```js
import { start } from "../fixtures/boards/server.mjs"

const board = await start() // listen(0) — read the port, never hardcode one
const url = board.pageUrl("ashby")
// ...
await board.stop()
```

`listen(0)` is not a style choice: CI runs legs in parallel and a fixed port is
a flake waiting for a second job.

## Determinism

Same URL, same bytes. The Ashby CSP nonce is a fixed constant
(`ajfixturenonce`) rather than a per-request random value for this reason —
real Ashby randomises it, and the fidelity that matters is that the policy is
**nonce-based at all**, which is why the fill bootstrap cannot use
`addScriptTag`.

The one intentional exception is Greenhouse's multi-step form: the same URL
returns step 1 to a `GET` and step 2 to a `POST`. That is the trait being
reproduced, and it is deterministic per method. `?step=2` is the equivalent for
a plain `fetch` with no browser.

## Why the real board hostname is in the URL path

`detectAts()` tests its regex against the **whole URL string**, not the
hostname. A loopback fixture can therefore only select the Greenhouse adapter
by carrying `boards.greenhouse.io` somewhere in its URL. Without that, the
entire fake board would exercise the `generic` adapter and `fileFields`,
`comboStrategies` and `valueAliases` would go untested — coverage that looks
real and is not.

That same property is a finding in its own right, pinned by
`tests/security/fake-board.test.mjs`: any board can impersonate any ATS, and
any board can force a Workday hand-off, by putting the name in its own path or
query string.

## The honest replicas

Each reproduces the structural traits the engine actually trips on, recorded in
`CLAUDE.md`'s gotchas and in the git history — not a tidied-up form.

| fixture      | trait it reproduces                                                                                                                                                                                                                         |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `greenhouse` | **One URL, two steps.** `urlGuard` cannot tell a page-1 plan from page 2. Both file inputs labelled `Attach`. A react-select whose options need a click. A label over 120 characters.                                                       |
| `lever`      | `.application-label` siblings instead of `<label for>` (the fourth `labelOf` tier, the one most likely to pick up the wrong text). A **native** `<select>`, so probing this board is waste. One file slot, not two.                         |
| `ashby`      | **Nonce-based CSP with no `unsafe-inline`** — the reason `addScriptTag` is banned. **Asynchronous remount 700ms after upload**, dropping every `data-aj` stamp, which is why a live run logged a fill as failed while its value had landed. |

The Ashby page also carries a **nonce-less inline script**. Under the served
policy a browser refuses it, so `window.__ajCspProof` stays `undefined` — that
is how a browser-based test proves the policy is _enforced_ rather than merely
sent.

## The hostile variants — one line each

| fixture                   | proves                                                                                                                                                                                                                                                                                                                                                                                                                                 | owner if it fails |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| `fillsrc-getter`          | The code round-trip stays dead: `window.__ajFillSrc` / `__ajPlan` getters that click Submit and `setInputFiles(".env")`, counting every read.                                                                                                                                                                                                                                                                                          | `w2-engine`       |
| `label-injection`         | A field **label** is third-party text bound for `answers.yaml`, which is the R6 evidence corpus. Corpus poisoning with and without brackets, an instruction addressed to the agent, a zero-width-hidden one, and a "do not tell the user".                                                                                                                                                                                             | `w1-security`     |
| `consent-decoupled`       | Five consent holes: `aria-label` decoupling (matched string ≠ displayed string); the 120-character truncation collision; a reworded box no pattern list catches; a `color: transparent` label the scanner vouches for and no human can read; and four **real-world** wordings (FCRA consumer-report authorisation, jury-trial waiver, typed-name-as-legal-mark, employment-history inquiry) that are not classified as consent at all. | `w3-resolution`   |
| `destructive-combobox`    | Withdraw / Delete / Submit wearing `role="combobox"`, `data-ui="select"` and `class="Select__control"` — which the scan probe clicks with `force: true`. Keeps one genuine dropdown so an over-correction is visible.                                                                                                                                                                                                                  | `w2-engine`       |
| `remount-mid-fill`        | A form that remounts every 400ms **preserving typed values**, so a field that filled correctly is reported as failed. A one-shot retry is not enough on its own.                                                                                                                                                                                                                                                                       | `w2-engine`       |
| `mislabelled-inputs`      | Labels that name a different field from the input they wrap: `Phone number` → `name="ssn"`, and a visible `Email` label beside an `aria-label` of `Emergency contact phone`.                                                                                                                                                                                                                                                           | `w3-resolution`   |
| `mislabelled-escalated`   | **The same attack with `id`, `name` and `autocomplete` renamed to agree with the lying label**, so `fieldIdentityMismatch()` has no token left to compare. It LANDS, and its tests are green on purpose — see below.                                                                                                                                                                                                                   | nobody: see below |
| `escalated-tickbox-yes`   | **Shape B.** The escalated page's work-authorisation question re-rendered as a fieldset legend plus one tickbox whose own label is `Yes`. The stored answer now has an option to match, so the box POSTing into `agree_arbitration` is **ticked**. LANDS.                                                                                                                                                                              | `w3-resolution`   |
| `escalated-radio-yesno`   | **Shape C.** The same question as a `Yes`/`No` **radio pair** — the commonest real ATS rendering, and the cheapest version of the attack. Same tick. `looksLikeAgreementProse()` cannot even be reached: it returns false for any group whose `t` is not `checkbox`. LANDS.                                                                                                                                                            | `w3-resolution`   |
| `escalated-aria-checkbox` | **Shape E.** The same question as `<div role="checkbox" aria-checked aria-required>`. `scan-page.js` collects from `select,textarea,input`, `[contenteditable]` and its combobox list, so it emits **zero fields** for this control: the consent is neither ticked nor deferred nor shown. Blindness, not defence.                                                                                                                     | `w2-engine`       |

### `mislabelled-escalated` is a landed attack, deliberately asserted green

Added 2026-07-31. `fieldIdentityMismatch()` closed `mislabelled-inputs` by
comparing the label against the element's own `n`/`sel`. Every token it reads is
chosen by the board, so four attribute renames defeat it, and nothing a human
could see on the page changes. Measured at `buildPlan` over the two scans:

| page                    | defers with an identity reason | fields filled |
| ----------------------- | ------------------------------ | ------------- |
| `mislabelled-inputs`    | 3                              | 0             |
| `mislabelled-escalated` | 0                              | 2             |

One of the two fills is the contact phone number going into a control whose
server destination is the `ssn` column, with every token in the plan record —
label, `name`, `type` — consistent with an honest phone field.

**Why the tests are green rather than red or skipped.** `tests/security/` is the
`npm run test:security` gate; a permanently-red line in it would be paid for by
every other finding in the same suite, because a gate that is always red stops
being read. A skip is right when a test cannot run (see the browser legs below);
this one runs and yields the numbers above. So `hostile-forms.test.mjs` section
4b asserts the landed outcome under names beginning `LANDS`, and it goes red if
anyone moves the behaviour in either direction — which is the alarm worth having.

**CORRECTION, 2026-07-31 — the "one control that still holds" was not a control.**
This section used to claim the consent-shaped box on the page is not ticked
"because a checkbox defers on its SHAPE, and shape is not an attribute a board
can rewrite." That was false about the page it described. `#esc-auth`'s label is
`Are you legally authorized to work in the United States?`; it is 10 words and
ends in `?`, and `looksLikeAgreementProse()` requires `/[.!]$/`. It returns
**false**, as do `isConsent()` and `isHardConsent()`. **No consent control runs on
that field at all.**

What actually prevents the tick is a rendering accident: that page draws a lone
tickbox whose single option label _is the question_, so the fact base's stored
`Yes` has no option to match. Change the rendering and the tick lands —
`escalated-tickbox-yes` and `escalated-radio-yesno` are the same question, the
same input name and the same server destination, and both are **ticked**. Worse,
on `mislabelled-escalated` itself the field is optional, so `buildPlan` emits a
`skip` item rather than a defer: the arbitration box never reaches the approval
message either.

Filed by `innov-resilience` (verdict: **patch**) against the previous
`qa-adversary` instance's claim, and corrected here, in
`hostile-forms.test.mjs` (the test now named `NOT A CONTROL:`), in
`mislabelled-escalated.scan.json`'s `_note`, and in the page's own header
comment. `doc-scribe` holds the two documentation instances
(`docs/reference/01-control-flow.md`, `docs/reference/05-apply.md`).

**Where the escalated attack IS actually bounded.** At the value side: a field's
meaning is decided server-side, so the blast radius of a label-lie routing attack
is exactly the contents of the answer bank, and `save-answer.mjs` refuses a
government or financial identifier at the write boundary (`w1-security`, exit 4).
Section 4b's last test asserts that at the answers file, not at the detector.
Hard rule 6 — the user is on the Submit button — is the other floor, and it is
the only thing standing between shapes B and C and a signed arbitration waiver.

### The three renderings, and which control each one actually exercises

State this explicitly or the corpus repeats the mistake above: `mislabelled-escalated`
was built to defeat the **identity** guard and only incidentally missed the
**consent** path, and it was then read as evidence about a control it never
touched. Question text, input `name` and server destination are identical across
all four rows — a test in `hostile-forms.test.mjs` asserts that, so a future edit
cannot weaken the finding to "a differently-worded question also ticks".

| rendering                              | outcome                   | exercises                                                                             | does **not** exercise                                                                          |
| -------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `mislabelled-escalated` (lone tickbox) | not ticked, and not shown | `resolveFields` option matching (no option equals `Yes`), then the optional-skip path | any consent control — all three predicates are false; the vouch; the allowlist                 |
| B `escalated-tickbox-yes`              | **ticked**                | the ordinary checkbox branch of `buildPlan`                                           | the consent branch, the vouch, the allowlist (`why` is absent, not `consent:allowlisted`)      |
| C `escalated-radio-yesno`              | **ticked**                | the same branch, from a `radio` group                                                 | the consent branch — and it **cannot** reach it: `looksLikeAgreementProse` requires `checkbox` |
| E `escalated-aria-checkbox`            | **invisible** — no field  | `scan-page.js`'s field collection                                                     | every part of `fill-plan.mjs` — there is nothing for it to decide about                        |

Shape E is a different failure from B and C and gets its own test. Nothing is
asserted on the user's behalf, which is the safe half; what is lost is the
**defer**, the mechanism by which an unanswered required question reaches the
approval message and `pending-questions.mjs`. `readiness()` returns
`{ ready: true }` on that page. A silence is not a refusal.

## What else lives here

- `pages/` — the honest replicas.
- `scans/*.scan.json` — what `scan-page.js` produces for each page. There is no
  browser in this suite, so consumer tests feed product code these. That is one
  step from asserting the mock, so **every one of them is generated by running
  the real scanner and deep-compared to it on every run** by
  `tests/security/scan-fidelity.test.mjs`. Do not hand-edit a `scans/` file:
  change the page, re-run the scanner, and keep the `_`-prefixed annotations
  (those are the only keys the comparison ignores).
- `dom.mjs` — the DOM that makes the above possible without a browser or a new
  dependency: it parses the served HTML and runs the real
  `.claude/skills/apply-job/scan-page.js` text over it. **Its stated limit is
  layout** — every rendered element gets the same box, so a carrier that hides
  text by geometry (clipping, off-screen parking, an overlay) cannot be
  reproduced here and must not have its fixture regenerated from the harness.
  `scan-fidelity.test.mjs`'s last test fails loudly if a page grows one.
- `tests/security/board-fidelity.test.mjs` remains the check on the other
  direction: that the served **page** still carries the traits the corpus says
  it does (a CSP, a remount, two file inputs labelled `Attach`).
- `../hostile/forms/` — the hostile pages, served by the same server.
- `../hostile/postings/` — hostile posting payloads, served at `/postings/<name>.json`.
- `../hostile/bypasses.mjs` — the 25-carrier bypass corpus, as data.
- `../hostile/answers-label-poisoned.yaml` — a fact base poisoned through a form
  label. Hostile answer files live here because rule 2 forbids touching
  `profile/`.

## The suites that use it

```
node --test "tests/security/**/*.test.mjs"
```

- `fake-board.test.mjs` — the server itself. If this is red, nothing else in
  `tests/security/` means anything.
- `board-fidelity.test.mjs` — the replicas carry the traits they claim.
- `scan-fidelity.test.mjs` — every scan fixture IS what the real scanner
  produces for the page it names. Added 2026-07-31 after four fixtures were
  found claiming shapes `scan-page.js` cannot emit; one of them
  (`sel: input[name="ssn"]`, where the scanner emits `#m-phone`) was the only
  input to a live product guard, so the guard had never been exercised on real
  scanner output.
- `rce-round-trip.test.mjs` — the gate on the autonomy phase: the engine
  round-trip, and the three carriers that can still hand `buildPlan` a scan
  asserting its own vouch (a scan **file**, the `__ajLastScan` read-back, and
  the bare `__ajScan(false)` re-scan).
- `bypass-corpus.test.mjs` — 25 carriers, asserted at the consumer.
- `corpus-poisoning.test.mjs` — title and form-label poisoning, asserted at
  `verify-claims`' exit code.
- `hostile-forms.test.mjs` — labels, consent, destructive controls.
- `browser-vouch.test.mjs` — **needs a real browser.** The `color: transparent`
  carrier is invisible in the markup: an honest label and an unreadable one are
  identical HTML and only `getComputedStyle` differs. Runs against this server.
  Without `playwright-core` it **skips loudly**, naming what is unverified.
  Since 2026-07-31 the browserless legs are no longer empty on this carrier:
  the consent scan fixture carries the box (it was missing for the fixture's
  whole life), `scan-fidelity.test.mjs` pins the scanner's refusal to vouch,
  and `hostile-forms.test.mjs` asserts at `buildPlan` that it defers. What only
  this leg can prove is that Chromium's computed colour agrees with the
  harness's shim.

## Ordering rule for every test here

**Where a test exists to pin a defect, the defect assertion must be the one
that cannot be pre-empted.** Assert it first, or make the auxiliary checks
non-fatal. A precondition, a fixture-integrity check, or a characterisation of
today's behaviour placed ahead of the finding will abort the test when the
product changes — and the finding disappears behind a message about something
else. Four instances were found in these files by other agents and eleven more
by a sweep of all 107 tests. The pattern to copy is `bypass-corpus.test.mjs`'s
BASELINE test: the number first, corpus-integrity checks after.

Where several assertions are genuinely equal in weight (five ATS spoofs, four
injection payloads, three engine breaches), they are **evaluated together and
compared as one set**, so fixing one cannot hide the rest.

Nothing in this tree needs to be byte-exact: every assertion normalises
whitespace the way `scan-page.js`'s `txt()` does, so prettier may reflow these
files freely. No `.prettierignore` entry is required.
