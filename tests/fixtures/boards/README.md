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

| fixture                | proves                                                                                                                                                                                                                                     | owner if it fails |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------- |
| `fillsrc-getter`       | The code round-trip stays dead: `window.__ajFillSrc` / `__ajPlan` getters that click Submit and `setInputFiles(".env")`, counting every read.                                                                                              | `w2-engine`       |
| `label-injection`      | A field **label** is third-party text bound for `answers.yaml`, which is the R6 evidence corpus. Corpus poisoning with and without brackets, an instruction addressed to the agent, a zero-width-hidden one, and a "do not tell the user". | `w1-security`     |
| `consent-decoupled`    | The two holes that disabled consent auto-tick: `aria-label` decoupling (matched string ≠ displayed string) and the 120-character truncation collision. Plus a reworded box that no pattern list catches.                                   | `w3-resolution`   |
| `destructive-combobox` | Withdraw / Delete / Submit wearing `role="combobox"`, `data-ui="select"` and `class="Select__control"` — which the scan probe clicks with `force: true`. Keeps one genuine dropdown so an over-correction is visible.                      | `w2-engine`       |
| `remount-mid-fill`     | A form that remounts every 400ms **preserving typed values**, so a field that filled correctly is reported as failed. A one-shot retry is not enough on its own.                                                                           | `w2-engine`       |
| `mislabelled-inputs`   | Labels that name a different field from the input they wrap: `Phone number` → `name="ssn"`, and a visible `Email` label beside an `aria-label` of `Emergency contact phone`.                                                               | `w3-resolution`   |

## What else lives here

- `pages/` — the honest replicas.
- `scans/*.scan.json` — what `scan-page.js` produces for each page. There is no
  browser in this suite, so consumer tests feed product code these. That is one
  step from asserting the mock, which is why
  `tests/security/board-fidelity.test.mjs` re-derives every label from the
  served HTML with the same normalisation `txt()` applies and fails if the two
  drift. **What it does not prove** is that `labelOf()` picks the label the
  fixture claims — that needs a DOM, and belongs to whoever runs
  `scan-engine.mjs` against this server.
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
- `board-fidelity.test.mjs` — the replicas carry the traits they claim, and the
  scan fixtures describe the HTML actually served.
- `rce-round-trip.test.mjs` — the gate on the autonomy phase.
- `bypass-corpus.test.mjs` — 25 carriers, asserted at the consumer.
- `corpus-poisoning.test.mjs` — title and form-label poisoning, asserted at
  `verify-claims`' exit code.
- `hostile-forms.test.mjs` — labels, consent, destructive controls.
