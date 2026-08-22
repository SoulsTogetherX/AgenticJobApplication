# Reading an application form: the scanner

Before this pipeline can fill in a job application, something has to look at the
live web page and answer a very ordinary question: _what is on this form?_ Which
boxes are there, what does each one ask, which are required, which are
dropdowns, and what choices does each dropdown offer? That is what the
**scanner** does. It walks the page, gives every control a short identifier,
works out what question each one is asking, opens the custom dropdowns to read
their option lists, and hands back one compact object describing the whole form.
Everything downstream — matching your saved answers to questions, deciding what
can be filled and what has to be deferred to you, remembering the shape of a
board you have applied to before, and the approval message you read — starts from
that object. If the scan is wrong, everything after it is confidently wrong.

**What you will learn here**

- What the DOM, a CSS selector, Playwright and CDP are, in plain English, and why
  a "round trip" between the controlling script and the page is the thing this
  code spends its time on.
- Why `scan-page.js` is _evaluated inside the web page_ instead of being imported
  like a normal file, and what that costs it (no filesystem, no imports, no
  Playwright).
- The Content-Security-Policy nonce problem: why adding a `<script>` tag to a
  page like Ashby's is refused outright, why the bootstrap therefore loads **by
  filename**, and why `scan-engine.mjs` installs the scanner **unconditionally**.
  Both look like odd choices. Both are load-bearing, and both were paid for with
  a broken live application.
- How the scanner works out what question a box is asking (label, `aria-label`,
  `aria-labelledby`, placeholder, surrounding text) and how it stamps `data-aj`
  attributes so a later step can find the same element again.
- What "probing a dropdown" means, why it is the slowest part of a scan, and the
  rules that decide what the probe is allowed to click.
- What is genuinely broken or unwired today, said plainly.

**Before this**

These are companion documents; you do not need them to follow this one, but they
give the surrounding picture.

- [../guide/03-programming-basics.md](../guide/03-programming-basics.md) — what a
  function, a module and an object are.
- [../guide/05-architecture.md](../guide/05-architecture.md) — how the whole
  pipeline fits together.
- [../guide/07-safety-model.md](../guide/07-safety-model.md) — why a job posting
  is treated as data written by a stranger, never as instructions.
- [../guide/08-glossary.md](../guide/08-glossary.md) — vocabulary.

**Related code documents**

- [07-apply-planning.md](07-apply-planning.md) — `fill-plan.mjs`, which reads the
  scan and decides what to do about each field.
- [08-apply-filling.md](08-apply-filling.md) — `fill-engine.mjs`, the other half
  of the browser work. This document mentions it only by reference.
- [09-auto-runner.md](09-auto-runner.md) — the unattended runner that calls the
  scanner as an ordinary function.

**The files covered here**

| file                                       | lines | one-line purpose                                                                                                                                           |
| ------------------------------------------ | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.claude/skills/apply-job/scan-page.js`    | 2329  | The scanner itself. Runs **inside** the web page, walks the DOM, returns a description of the form.                                                        |
| `scripts/apply/scan-engine.mjs`            | 768   | Installs the scanner, runs it, opens (probes) every custom dropdown. The version used by the local runner and the tests.                                   |
| `.claude/skills/apply-job/scan.driver.mjs` | 440   | The same job in one MCP tool call, for the attended path the `apply-job` skill uses. A near-twin of the engine with fewer powers.                          |
| `scripts/apply/browser.mjs`                | 206   | Plumbing: launch a browser, hand out a page, decide where a browser is allowed to point, and turn the fill engine's text into something a sandbox can run. |

---

## Part A — the vocabulary you need first

Nothing else in this document will make sense without these seven ideas. Each one
is short.

### The DOM

When a browser loads a web page, it does not keep the HTML text you would see in
"View Source". It builds a **tree of objects in memory** — one object per tag —
and that tree is what is actually on screen. That tree is the **DOM** (Document
Object Model). "The DOM" and "the page" mean the same thing in practice.

A tiny page:

```html
<form>
  <label for="email">Email address</label>
  <input id="email" type="email" required />
</form>
```

becomes a tree: a `form` object, holding a `label` object and an `input` object.
JavaScript running in that page can walk the tree, read each object's properties
(`input.value`, `input.required`), and change them.

Two properties come up constantly below:

- **`innerText`** — the text of an element _as rendered_. Text inside a
  `display:none` box is not in `innerText`. Reading it forces the browser to work
  out the page's layout, so it is not free.
- **`getComputedStyle(el)`** — the final CSS values the browser actually applied
  to an element, after every stylesheet and inherited value. This is how the
  scanner asks "is this text really visible to a human?" rather than trusting the
  markup.

### A CSS selector

A **CSS selector** is a short pattern that describes elements in that tree. You
already meet them in stylesheets; the DOM lets code use them to _find_ elements.

| selector               | means                                                       |
| ---------------------- | ----------------------------------------------------------- |
| `input`                | every `<input>` element                                     |
| `#email`               | the element whose `id` is `email`                           |
| `.select__control`     | every element with the CSS class `select__control`          |
| `[role='combobox']`    | every element with the attribute `role` set to `combobox`   |
| `[class*='__option']`  | every element whose `class` attribute _contains_ `__option` |
| `[data-aj="f7"]`       | the element whose `data-aj` attribute is exactly `f7`       |
| `input[type='submit']` | `<input>` elements whose `type` is `submit`                 |

`document.querySelectorAll("select,textarea,input")` means "give me every
`<select>`, `<textarea>` and `<input>` on the page, in document order". That one
call is the backbone of the scanner.

### Playwright, and "Playwright-side" vs "page-side"

**Playwright** is a Node.js library that remote-controls a real Chromium browser
from _outside_ it. Your Node program holds a `page` object; calling
`page.click(...)` makes the browser produce a genuine mouse click, exactly as if a
human had done it.

That gives two different places code can run, and the difference decides almost
every design choice in this area:

| where                              | what it can do                                                                                     | what it cannot do                                                                                                 |
| ---------------------------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| **Playwright-side** (Node process) | Hold the `page` handle, click, type, upload files, read and write our own files on disk, navigate. | See the DOM directly. It has to ask the browser.                                                                  |
| **Page-side** (inside the page)    | See and read the whole DOM: `document`, `window`, `getComputedStyle`, `innerText`.                 | Read our disk. Import anything. Touch the `page` handle. Produce a click React will believe (more on this below). |

Page-side code also runs **alongside the employer's own JavaScript**, sharing one
`window` object with it. That is the single most important security fact in this
document.

### `page.evaluate` — the bridge, and what it carries

`page.evaluate(fn, arg)` is how Playwright-side code makes something happen
page-side. It does **not** send a live function across. It sends the _text_ of
`fn`, the browser compiles and runs that text inside the page, and the **return
value comes back as plain data** — numbers, strings, arrays, plain objects. Not
functions, not DOM elements.

```js
// Playwright-side (Node)
const title = await page.evaluate(() => document.title)
// `title` is now a plain string, copied out of the page.
```

This is the only channel between the two worlds, and it is one-way for
executable code: text goes in, data comes out. Everything this pipeline reads
back from a job page — a scan, a field's current value — is **data**, and is only
ever read as data. It is never executed.

> **The failure that taught this.** An earlier version of the _fill_ engine wrote
> its own source code into a page global called `window.__ajFillSrc`, read that
> value back into Node, and `eval`'d it Node-side, where the live `page` handle
> is. A job page is written by a stranger. Any script on it could have defined
> `__ajFillSrc` as a **getter** — a property that runs code when you read it — and
> thereby chosen exactly what ran with a live browser handle: it could navigate,
> read everything typed so far, attach the user's `.env` file to its own form, and
> click Submit. `browser.mjs`'s header states the rule that replaced it: _"Neither
> path reads executable code back out of the page."_

### CDP, and what a "round trip" costs

Playwright talks to Chromium over the **Chrome DevTools Protocol (CDP)** — the
same protocol your browser's own DevTools panel uses. Every Playwright call is one
or more messages over a socket, out to the browser and back. That out-and-back is
a **round trip**.

Two consequences run through this whole area:

1. **Round trips are the unit of cost.** A single `page.evaluate` that reads
   forty things costs one round trip; forty small calls cost forty. That is why
   the scanner is one big function that returns one big object, rather than a
   collection of small queries. The performance baseline in
   `docs/perf-baseline.json` counts `round_trips_per_app: 60`.
2. **A single `page.evaluate` is atomic with respect to the page.** All of it runs
   in one turn of the page's own event loop, so the page cannot re-render halfway
   through it. That property is used deliberately elsewhere in the fill engine.

### Content Security Policy and a "nonce"

A **Content Security Policy (CSP)** is a rule a website sends with its pages
saying which scripts the browser is allowed to run. The strictest common form
uses a **nonce** (a "number used once"): the server invents a random string per
page load, puts it in the policy header, and tags its own script elements with
it.

```
Content-Security-Policy: script-src 'nonce-r4nd0mX9' https://cdn.ashbyprd.com
```

```html
<script nonce="r4nd0mX9">
  /* the board's own code — allowed */
</script>
<script>
  /* anything else, injected by anyone — REFUSED, silently to the user */
</script>
```

Any `<script>` element added to the page without that nonce is refused outright.
The browser does not run it. This is the problem that shapes how the scanner gets
into the page, and Part C.2 is entirely about it.

### Hydration

Modern job boards send a nearly empty HTML page and then build the form in the
browser with JavaScript (React, usually). The moment when the JavaScript takes
over and the real form appears is called **hydration**. Scan too early and you
see either nothing or the plain `<input>`s hiding underneath the custom widgets —
which is worse than nothing, because it looks like a real answer. Both engines
have a specific guard for this, described in Part D.

---

## Part B — how the four files fit together

There are two ways this pipeline reaches a live page, and they use different
files for the same job.

```
THE ATTENDED PATH (what the apply-job skill does today)

  agent  ──▶ mcp__playwright__browser_run_code_unsafe
             { filename: ".claude/skills/apply-job/scan.driver.mjs" }
                    │
                    ▼
             scan.driver.mjs      (Playwright-side, inside an MCP sandbox)
                    │  installs, runs, probes, strips every vouch
                    ▼
             scan-page.js         (PAGE-side: walks the DOM)
                    │
                    ▼
             the scan object  ──▶  jobs/<slug>/scan-p1.json


THE LOCAL-RUNNER / TEST PATH

  scripts/auto/stages.mjs ─┐
  scripts/dev/bench-apply  ├─▶ scan-engine.mjs   (an ordinary Node module)
  tests/apply/*.test.mjs  ─┘        │  installs, runs, probes, keeps the vouch
                                    ▼
                             scan-page.js        (PAGE-side, same file)
                                    │
                                    ▼
                       { scan, vouchedLabels }   (stays in this process)

  scripts/apply/browser.mjs supplies the browser to that path
  and re-exports scanPage / fillPage for convenience.
```

`scan-page.js` is the **single source of truth**. It exists once. The two drivers
are two ways of getting it into a page and two ways of dealing with what comes
back — and the difference between them is not cosmetic. It is a difference in how
much the result can be trusted, explained in Part E.

---

## Part C — `.claude/skills/apply-job/scan-page.js`

### C.1 What it is and why it exists

This is the scanner. It is 2,329 lines of JavaScript whose whole job is to look
at a live DOM and produce one compact description of the form on it.

Without it there is no idea of "what fields are on this page", and therefore
nothing for `answer-bank.mjs` to match your saved answers against, nothing for
`fill-plan.mjs` to plan, nothing for `field-cache.mjs` to remember, and nothing
to show you in an approval message. Every other file in the apply path takes its
`fields` array as input.

It is also the file where a mistake is most expensive, because a mistake here is
usually **silent**. The file's own header states the governing principle, and it
is worth memorising: **a silence is not a refusal, and a silence is the worse of
the two failure modes.** A field the scanner reports but cannot handle becomes a
visible "you need to fill this in yourself". A field the scanner never mentions
just quietly is not filled, the submit fails or the board picks a default, and
nothing in any log says why.

### C.2 It is evaluated inside the page, not imported — and why that matters

This is the single most important structural fact about the file, and it explains
half of what looks strange about it.

**It is not a module.** Its own header line says so:

> `// NOT a module: no imports, no exports, no leading semicolon (see .prettierignore).`

Its entire body is **one assignment statement**:

```js
window.__ajScan = async (PROBE = true) => {
  /* 2,130 lines */
}
// --- scanner ends here; nothing below is part of the function ---------------
try {
  Object.defineProperty(window, "__ajScan", {
    value: window.__ajScan,
    writable: false,
    configurable: false,
  })
} catch (e) {}
```

Nothing anywhere does `import scanPage from "./scan-page.js"`. Instead, three
different callers read its **text** and evaluate that text inside the browser
page:

1. `scan-engine.mjs` reads the file off disk and evaluates it page-side with
   `page.evaluate((s) => { (0, eval)(s) }, scannerSrc)`. It then _also_ slices the
   arrow function out of the text (see `scannerExpression()` in Part D) and
   evaluates just that expression, so the function it calls is a **local
   variable** that no page script can reach.
2. `scan.driver.mjs` hands Playwright the file's **path** and lets Playwright
   load it, then calls the global `window.__ajScan(false)`.
3. `fill-plan.mjs` embeds the whole text as a string constant inside the
   generated `jobs/<slug>/fill-plan.js` bootstrap.

Five consequences follow, and all five are things a newcomer would try to "fix":

**Consequence 1 — it runs page-side, so it is powerless in specific ways.** It
has `document`, `window` and `getComputedStyle`. It does **not** have `require`,
`fs`, `page`, or Playwright. In particular it cannot produce a click that React
believes: a programmatic `el.click()` from page context does not carry the trusted
input events React listens for, so react-select menus never open for it. That is
precisely why the real dropdown probe lives in the two Playwright-side drivers
and not here (Part D.5).

**Consequence 2 — it cannot import anything, so everything it needs it defines
itself.** The probe-refusal rules, the `DESTRUCTIVE_LABEL` word list, the option
reader (`rowsIn` / `leavesOnly` / `menuOf`) and the empty-state filter all exist
here _and_ in `scan-engine.mjs` _and_ in `scan.driver.mjs`. That triplication is
deliberate. `tests/apply/fill-page.test.mjs` pins the copies against each other:

```js
test("all three copies of the probe guard are identical", () => {
  // A click happens in three places and none of them can import the other two:
  // the engine (module), the MCP driver (vm, no module loader) and the
  // scanner's own probe loop (page context). Copies drift — the flat sleeps
  // already proved that — so the drift is made loud here.
```

**Consequence 3 — a syntax error here breaks production, not CI.** The file never
passes through a module loader during a normal test run, so a mistake in it would
not show up as a build failure. `tests/apply/scan-page.test.mjs` and the fake-DOM
harness at `tests/fixtures/boards/dom.mjs` exist to run the real text against a
hand-built DOM for exactly this reason.

**Consequence 4 — it is in `.prettierignore`, on purpose.** From that file:

```
# Loaded and eval'd as bare function expressions, not modules — prettier's
# leading-semicolon guard would make them unparseable.
.claude/skills/apply-job/scan.driver.mjs
.claude/skills/apply-job/scan-page.js
```

Prettier defends against a JavaScript quirk by prepending a `;` to lines starting
with `(` or `[`. On a file that must be _one bare expression_, that guard changes
the meaning of the file. CLAUDE.md calls `.prettierignore` entries **contracts**;
this is one of them. Do not remove either line, and do not "tidy" these two files
with prettier.

**Consequence 5 — two literal strings in the file are load-bearing anchors.**
`scan-engine.mjs`'s `scannerExpression()` slices the file between them:

- the file must keep starting a line with `window.__ajScan =`;
- the file must keep the literal comment line `// --- scanner ends here`.

The end marker exists because of that trailing `Object.defineProperty` statement:
slicing to end-of-file would hand `eval` two statements where it needs one
expression. The trailing lock itself is explicitly **not** load-bearing —
`scan-engine.mjs` never reads `window.__ajScan` — it just removes a free move
from a hostile page, which can no longer quietly swap the scanner out after
install.

### C.3 How you run it

You do not run it directly; it has no CLI. In practice it reaches a page one of
three ways:

```
# 1. attended path — the apply-job skill, one tool call
mcp__playwright__browser_run_code_unsafe
  { filename: ".claude/skills/apply-job/scan.driver.mjs" }

# 2. a cheap re-scan on later pages, once the scanner is installed (~30 tokens)
browser_evaluate  () => window.__ajScan(false)

# 3. local runner / tests — an ordinary import of the engine that installs it
import scanPage from "scripts/apply/scan-engine.mjs"
const { scan, vouchedLabels } = await scanPage(page)
```

Its only parameter is `PROBE`, which defaults to `true`. **Both engine paths pass
`false`.**

> **Known defect (checked 2026-08-05).** Because both engines call
> `window.__ajScan(false)`, the file's own probe loop — the `if (PROBE) { … }`
> block near the end, with its `MAX_PROBE = 15` cap and its `sleep(200)` /
> `sleep(80)` pauses — **never runs in production**. It is reachable only by
> pasting the function into `browser_evaluate` with no argument, which the
> header documents as a manual fallback. `scripts/dev/bench-apply.mjs` records
> this explicitly as an unmeasured quantity. It is not dead code exactly — the
> fallback path is real — but do not reason about scan timings from it.

### C.4 What it returns: the output contract

The top-level return, verbatim from the end of the function:

```js
return {
  url: location.href,
  heading: txt(
    (document.querySelector("h1") || {}).innerText || document.title,
    100,
  ),
  kind,
  fields,
  btns,
  iframes: iframes.length ? iframes : undefined,
  signals: signals.length ? uniq(signals) : undefined,
}
```

| key       | shape                                   | meaning                                                                            |
| --------- | --------------------------------------- | ---------------------------------------------------------------------------------- |
| `url`     | string                                  | the page's own address at scan time                                                |
| `heading` | string, ≤ 100 chars                     | the page's `<h1>`, or its `<title>` if there is none                               |
| `kind`    | `login`/`confirm`/`form`/`ad`/`unknown` | what sort of page this is; the `apply-job` skill routes on it before anything else |
| `fields`  | array of field objects                  | the form itself — see below                                                        |
| `btns`    | array of `{ k, l, r }`                  | classified buttons, capped at 40                                                   |
| `iframes` | array of `{ src, title }`, or absent    | visible embedded frames, at most 6                                                 |
| `signals` | array of strings, or absent             | advisory notes: CAPTCHA, password field, blind spots, caps that were hit           |

**The field keys are short on purpose.** Every byte of a scan can land in an
agent's context window, and a form can have fifty fields.

| key                                                             | meaning                                                                                                                                    |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `k`                                                             | key — `f1`, `f2`… for fields, `b1`, `b2`… for buttons, `g1`, `g2`… for groups. Also written into the page as `data-aj`.                    |
| `t`                                                             | type — `text`, `email`, `tel`, `file`, `select`, `textarea`, `richtext`, `combo`, `checkbox`, `radio`, `widget`, or `aria-<role>`.         |
| `l`                                                             | label — the question, as resolved by the label waterfall (C.5). Cut at 120 characters, with one exception.                                 |
| `req`                                                           | `true` when the field is required; absent otherwise.                                                                                       |
| `v`                                                             | the control's current rendered value or text, cut at 60 chars.                                                                             |
| `opts`                                                          | the option list for a `<select>` or a probed dropdown, cut at `MAX_OPTS = 40`.                                                             |
| `o`                                                             | sub-options of a checkbox/radio group or a button pair: `[{ k, sel, l, on? }]`. Each carries its own stamp.                                |
| `h`                                                             | help text, from `aria-describedby`, cut at 160 chars.                                                                                      |
| `sel`                                                           | a **stable, app-owned** CSS selector (`#id`, or `tag[name=…]` / `[data-testid]` / `[data-qa]` / `[aria-label]`) that survives a re-render. |
| `n`                                                             | the element's `name` attribute, verbatim, when it has one.                                                                                 |
| `ac`                                                            | the element's `autocomplete` attribute, verbatim, minus the reserved values `on`/`off`.                                                    |
| `optsTruncated` / `optsTotal`                                   | the option list was cut, and this is how long it really was.                                                                               |
| `section`                                                       | the section heading this field sits under, when there is one worth reporting.                                                              |
| `multi`                                                         | `true` for `<select multiple>`.                                                                                                            |
| `widget`                                                        | `"aria"` or `"buttons"` — "no verb in this pipeline can operate this control".                                                             |
| `labelExact`                                                    | `true`, or **absent — never `false`**. The scanner's positive vouch that `l` is the complete, visible label text. Checkbox/radio only.     |
| `labelWhy`                                                      | why a vouch was refused, or that a label was inferred. Advisory, for a human reading a defer.                                              |
| `lSeen`                                                         | the **visible** label, present only when `l` is not text a human can read and something visible says something different.                  |
| `probe_refused` / `probe_skipped` / `probe_error` / `opts_from` | added later by the Playwright-side probe, not by this file. See Part D.                                                                    |

A button is `{ k, l, r }` where `r` is a role: `submit`, `next`, `back`, `start`,
`upload`, `auth`, or `other`.

#### A worked example

Given this fragment of a form:

```html
<h2>Application</h2>
<label for="email">Email address *</label>
<input id="email" name="email" type="email" required />

<label for="loc">Location</label>
<div class="_inputContainer_">
  <input id="loc" role="combobox" placeholder="Start typing..." />
  <button class="_toggleButton_"><svg /></button>
</div>

<button type="submit">Submit application</button>
```

the scan (before any dropdown probing) contains roughly:

```json
{
  "url": "https://jobs.ashbyhq.com/example/1234/application",
  "heading": "Frontend Engineer",
  "kind": "form",
  "fields": [
    {
      "k": "f1",
      "sel": "#email",
      "n": "email",
      "t": "email",
      "l": "Email address *",
      "req": true,
      "section": "Application"
    },
    {
      "k": "f2",
      "sel": "#loc",
      "t": "combo",
      "l": "Location",
      "req": true,
      "section": "Application"
    }
  ],
  "btns": [{ "k": "b1", "l": "Submit application", "r": "submit" }]
}
```

and the page itself now carries `data-aj="f1"`, `data-aj="f2"` and
`data-aj="b1"` on those three elements.

Note `f2.req: true` with nothing in the markup saying "required" — that comes
from a rule described in C.7.

#### Three keys that are reported, never trusted

`n` (name), `ac` (autocomplete) and `t` (type) are all chosen by the page. The
header is emphatic about what they are not, and it is worth reproducing because
the temptation to use them as a defence is strong:

> `type` has no token for any sensitive category. There is no `type="ssn"` and no
> `type="salary"`; a real SSN box is `type="text"`. … `autocomplete` appears on
> zero of the four honest board pages in `tests/fixtures/boards/pages/` and on
> exactly one page in this repo, the hostile one. A signal only attackers supply
> must never be a guard input. … a field's MEANING is decided server-side. An
> input named `phone`, labelled "Phone number" and typed `tel` can POST into a
> column called `ssn`, and that fact is not in the document.
>
> **If anyone describes these three keys as closing that finding, that is a
> documentation defect.**

What they _are_ for: choosing the right verb (typing vs ticking vs attaching a
file is decided by `t`), and making a substitution visible — showing a field's
real `name` beside its label in an approval message means a swapped field is at
least visible to you even when no automated check caught it.

### C.5 How it works out what question a field is asking

This is the **label waterfall**, in `labelDetail(el, skipAttr)`. It tries seven
sources in order and stops at the first that yields text, recording _which_
source it used (`src`) and _which DOM nodes_ the text came from (`nodes`). Those
two extra facts are what makes the vouch in C.6 possible.

| order | `src`        | where the text comes from                                                                                                           |
| ----- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| 1     | `labelledby` | `aria-labelledby="a b"` → look up elements with those ids and join their `innerText`                                                |
| 2     | `arialabel`  | the `aria-label` **attribute** — never visible on screen                                                                            |
| 3     | `for`        | `<label for="thisId">` somewhere in the document                                                                                    |
| 4     | `wrap`       | an enclosing `<label>` element                                                                                                      |
| 5     | `legend`     | the `<legend>` of an enclosing `<fieldset>` — a group heading                                                                       |
| 6     | `near`       | walk up 4 ancestors looking for a `label`, `legend`, `[class*='label']` or `[class*='question']` that does not contain this element |
| 7     | `attr`       | last resort: the `placeholder` attribute, then the `name` attribute                                                                 |

Worked example. For:

```html
<label for="loc">Location</label>
<input id="loc" role="combobox" placeholder="Start typing..." />
```

route 1 finds nothing (no `aria-labelledby`), route 2 finds nothing (no
`aria-label`), route 3 finds `<label for="loc">` and returns
`{ text: "Location", src: "for", nodes: [<label>] }`. `labelOf(el)` then wraps
that as `txt(...)` — whitespace collapsed, cut at 120 characters.

Real ATS forms use all seven routes. Deleting any one of them turns a usable scan
into a useless one.

Two rules about `l` that look like omissions and are not:

- **`l` is never repointed.** When the page contradicts itself — an
  `aria-label="Emergency contact phone"` on an input that also has
  `<label for>Email</label>` — the visible text is reported _beside_ `l` as
  `lSeen`, not merged into it. The comment gives the reason: `l` "is what
  answer-bank matches on, what the field cache keys on and what the form
  fingerprint hashes, and silently repointing all of that at a different string is
  a bigger change than the one being fixed." A page contradicting itself is
  information; you get shown both.
- **`section` is reported, never merged into `l`** for the same reason.
  Greenhouse labels **both** of its attachment inputs "Attach"; the only thing on
  the page that says which is the résumé and which the cover letter is the
  section heading above each. So `section` carries it, and a consumer can tell
  them apart without the label string changing.

The one place a group's `l` **is** replaced, and why it is not an exception to
the first rule: a radio/checkbox **group** has no element of its own, so it has
no label of its own either — the field loop names it when it meets its first
option and, with no `<legend>` to take, falls back to that option's own text.
An option is an _answer_, and an answer never names a question. So after every
option is in, a group with two or more options whose `l` is one of them is
given the question from the options' container — the same five-ancestor walk
and the same bounds the button-pair detector (C.7) uses, so a Yes/No rendered
as `<button>`s and the same Yes/No rendered as `<input type=radio>` get the
**same** `l` — marked `labelWhy: "label source is group question"` and never
vouched. Measured on Ashby's texting-consent radios (2026-08-18) and on
`pages/lever.html`, whose sponsorship group read `"l": "Yes"` until then. A
group whose container holds nothing but its options keeps the old label: nothing
found means nothing changes. In the same pass, an Ashby "select all that apply"
checkbox — `name="Atlanta, GA"`, its own option text — groups by its
`<fieldset>` rather than by `name`, which had split one 15-option question into
fifteen one-option groups.

#### The E8 trap: a wrong label is worse than an empty one

In the widget sweep (C.7), the precedence is deliberately **not** "label first".
The comment records the measurement:

> the waterfall's `near` route walks ANCESTORS for a label-ish element, so on
> `<label for="n">Full name</label><input id="n">` `<span tabindex="0">I agree to
binding arbitration</span>` it stamped "Full name" onto the consent span. **A
> wrong label is worse than an empty one, because the user acts on it.**

So for swept-up custom controls the order is: a label the control itself
_declares_ wins; failing that, the element's own rendered text wins (a
`<div role="checkbox">I agree</div>` carries its label as content); and only if
there is neither is an inferred label used — marked
`labelWhy: "label inferred from a nearby element, not declared by the control"`
so nothing downstream mistakes it for the control's own words.

### C.6 Stamping: `data-aj`, and why `sel` exists too

`stamp(el, prefix)` does three things at once:

```js
const stamp = (el, prefix) => {
  const k = prefix + (prefix === "b" ? ++nb : ++nf)
  el.setAttribute("data-aj", k)
  elOf.set(k, el)
  return k
}
```

It invents the next key (`f7`, `b3`), **writes it into the page** as a `data-aj`
attribute, and remembers the element in a `Map` called `elOf`. Writing it into
the page is the point: `[data-aj="f7"]` is now a CSS selector that matches
exactly one element, so any later Playwright call can address that field without
re-deriving anything.

Every field also carries `sel`, produced by `stableSel(el)`, and both are needed:

> `data-aj` stamps are DOM attributes and do **not** survive a React remount —
> uploading a file on Greenhouse re-renders the form and drops every stamp.

`stableSel` tries `#id` first (CSS-escaped), then `tag[name="…"]`,
`[data-testid]`, `[data-qa]` and `[aria-label]`, accepting each only if it matches
exactly one element on the page; it returns `undefined` when nothing unique
exists. The fill plan tries `sel` **first**, because it is app-owned and outlives
a re-render, and falls back to `[data-aj="…"]`.

There are two different escaping helpers, and swapping them breaks things:

```js
const escIdent = (s) =>
  window.CSS && CSS.escape
    ? CSS.escape(s)
    : String(s).replace(/[^\w-]/g, "\\$&")
const escAttr = (s) => String(s).replace(/(["\\])/g, "\\$1")
```

An `id` goes into a CSS _identifier_ position and needs full `CSS.escape`. An
attribute **value** sits inside quotes and only needs the quote and backslash
escaped — `CSS.escape` would turn a space into `\20` and the selector would stop
matching.

#### `claimedNow`, and the second-scan bug

Every collecting pass skips elements that an earlier pass already took. The
obvious way to ask that is `el.closest("[data-aj]")` — "is this element, or any
ancestor, already stamped?" That was the code, and it was wrong. The comment is
worth reading in full because the bug it describes is invisible:

> Every collecting loop below used to ask `el.closest("[data-aj]")`, which reads a
> DOM ATTRIBUTE THAT SURVIVES THE SCAN THAT WROTE IT. A second scan of the same
> document therefore skipped every control the first scan had stamped, and came
> back with a form made only of native `<input>`s — which is not a theoretical
> path: `scan-engine.mjs` and `scan.driver.mjs` both RE-SCAN when the first pass
> found no buttons (the React-hydration tell), so on a page that hydrates slowly
> the second scan silently lost every combo, every richtext box and every custom
> widget.

The fix is `claimedNow(el)`, which walks up the ancestors asking not "is there a
stamp" but "is there a stamp **this run** wrote", checked against the `elOf` map,
which is rebuilt from empty on every run:

```js
const claimedNow = (el) => {
  let p = el
  while (p) {
    const k = p.getAttribute && p.getAttribute("data-aj")
    if (k && elOf.get(k) === p) return true
    p = p.parentElement
  }
  return false
}
```

Do not simplify this back to `closest("[data-aj]")`.

### C.7 The passes, in order — and the order is load-bearing

Each pass stamps what it takes; every later pass skips anything stamped **by this
run**. That is how "a button is not a field" is expressed _structurally_ rather
than as one more selector list every later pass has to route around. The file
says so twice, in two different blocks.

| #   | pass                      | what it collects                                                                                                                                              |
| --- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Custom dropdowns**      | `COMBO_SEL` = `[role='combobox'], [aria-haspopup='listbox'], [class*='select__control'], [class*='Select__control'], [data-ui='select']`. Emits `t: "combo"`. |
| 2   | **Native fields**         | `select, textarea, input`. Skips disabled ones and the types `submit`/`button`/`reset`/`image`/`hidden`.                                                      |
| 3   | **Contenteditable**       | `[contenteditable='true']` → `t: "richtext"`.                                                                                                                 |
| 4   | **Button-pair questions** | a question answered by a row of custom option controls (see below). Runs **before** the button loop.                                                          |
| 5   | **Buttons**               | `button, [role='button'], input[type='submit'], input[type='button'], a[href]` → `btns`, classified by `roleOf`.                                              |
| 6   | **The widget sweep**      | everything focusable, role-declaring or state-declaring that no earlier pass took. Emits `t: "aria-<role>"` or `t: "widget"`.                                 |
| 7   | **`section`**             | attach the nearest preceding heading whose parent also contains the field.                                                                                    |
| 8   | **Sort**                  | fields into document order, via `compareDocumentPosition`.                                                                                                    |
| 9   | **Page context**          | iframes, CAPTCHA classification, embedded-ATS signal, blind-spot signals.                                                                                     |
| 10  | **`kind`**                | classify the page, last, because it reads `fields` and `btns`.                                                                                                |

A few of these carry incidents you would otherwise re-introduce.

**Password fields are skipped and shout about it.** `type === "password"` pushes
the signal `"password field — login wall, hand off to the user"` and the field is
never recorded. Rule: this pipeline does not authenticate.

**A combo claims itself, not only its descendants.** react-select puts
`role="combobox"` on a wrapper `<div>` with the real `<input>` inside it, so
claiming descendants was enough there. Oracle Recruiting Cloud puts
`role="combobox"` **on the `<input>` itself**, so claiming descendants claimed
nothing, and the same element came back twice — once as `t:"text"` and once as
`t:"combo"`. `fill-plan.mjs`'s `duplicateCombo()` then did what it exists to do
for a phone-country-picker pair: kept the typable half, skipped the picker. The
plan issued `fill` against a combobox, the text landed in the visible input, the
widget never committed it, the value reverted on blur, "the application went out
with the field empty and the run reported it filled."

**A custom dropdown's label belongs to its inner input.** Greenhouse's Country
picker is a `select__control` shell inside a `<fieldset>` with a visually-hidden
`<legend>Phone</legend>`, and the real labelling (`aria-labelledby`,
`aria-required`) sits on the inner `<input id="country">`. Read off the shell, the
field came back labelled "Phone" and _not required_ — and `duplicateCombo()` then
threw it away as the picker half of a phone widget. `labelHost(el)` fixes this by
taking the label and `req` from an inner input **only when that input states its
own name**. Identity stays on the shell, because that is what a human clicks.

**Required-ness can live in a CSS class.** Measured on Ashby: a required Location
typeahead renders as
`<label class="_heading_f7cvd_52 _required_f7cvd_91">Location</label>` with the
asterisk drawn by CSS `::after`. The label _text_ is the bare word "Location" and
the control carries neither `required` nor `aria-required`, so the field came back
optional, was skipped as "optional and not in the fact base", and the application
was one click from going out with a required field empty. Two rules bound the
fix, because a class list is page-controlled text:

```js
const REQ_TOKEN = /(?:^|[\s_-])(?:is-)?required(?:_[A-Za-z0-9]+)?(?:$|[\s_-])/i
const REQ_NEGATED = /(?:^|[\s_-])(?:not|non|un)-?required|optional/i
```

Only a **whole class token** counts (so `_required_f7cvd_91` matches and
`requiredness` does not), and a negated token (`not-required`, `optional`)
disqualifies the node outright rather than being reinterpreted.

**A restyled checkbox is not an invisible one.** The field loop drops anything
invisible, and that rule is right: a hidden `<input>` is usually a board's own
backing store, and reporting one would put a control you are not looking at into
your approval message. But the same test dropped Oracle's **required consent
checkbox**, which is the ordinary accessible idiom — the native box at
`opacity: 0` with the tick painted on its `<label>`. It "was reported nowhere at
all: not a field, not a widget, not a button", so the plan named two decorative
progress widgets as the reason the form was not ready and never mentioned the one
control that actually blocked it. `presentedUnpainted(el, type)` grants the
exception on evidence, and every clause matters: checkbox/radio only; a visible
label from a declared source; not `tabindex="-1"`; not `aria-hidden`.

**A question answered by a row of buttons.** Ashby renders "Will you now or in the
future require sponsorship…?" as two `<button>`s. `roleOf` names neither, so both
landed in `btns` — a list `fill-plan.mjs` never reads — and "a required
work-authorisation answer went missing and nothing anywhere said so." The
detector that fixes it carries **no name list**; it is structural: two or more
option-shaped controls that `roleOf` could not name, all short-labelled, under the
nearest ancestor that _asks a question_ and holds nothing else. It has two tiers.
Tier 1 emits `t: "widget"` — a type the fill plan has no verb for, so it defers
loudly. Tier 2, when the answer set is recognised (`CLOSED_SETS = [["no","yes"]]`)
and the question is not destructive, emits the same group shape a radio group
produces. **Both tiers carry `widget: "buttons"`,** and the comment explains why
removing it from the recognised tier would be wrong: the fill engine's `kindOf()`
answers `"forbidden:button"` for a `<button>`, so a plan claiming to tick one
"does not make the click work; it makes the plan lie."

> **The worst thing this file has ever done**, and the reason a bias is written
> into it. On Oracle Recruiting Cloud the container text was: _"WILL YOU NOW OR IN
> THE FUTURE REQUIRE SPONSORSHIP for employment visa status (e.g. H-1B status,
> etc) to work legally for our Company in the United States?"_ — and `"(e.g. "`
> ends in `". "`, so the sentence-boundary walk started there and labelled the
> group `"H-1B status, etc) to work legally for our Company in the United
States?"`. That is not a truncation. It is a **different question**: the real one
> asks whether you require sponsorship (answer: No); the fragment reads as an
> authorisation question (answer: Yes). A fuzzy match returns the right concept
> with the wrong truth value, and that produces a false statement on a submitted
> application.
>
> Three structural rejections now guard it, none of them a word list: inside a
> parenthetical (`openParenAt`), after a dotted initialism
> (`INITIALISM = /(?:^|[\s("'[])(?:\p{L}\.)+\p{L}$/u`), and before a lowercase
> continuation. And the bias is stated: **when a boundary is ambiguous, keep more
> text.** An over-long label fails to match the answer bank and defers to you —
> one extra decision. A short label matches the wrong answer silently.

**Tabs are excluded even when they declare state.** Every Ashby posting renders an
"Overview"/"Application" tab strip, both `role="tab"`, so every scan emitted two
`aria-tab` fields, the plan deferred both, and "the result was an application that
could never be submitted unattended, on every Ashby posting, forever, because of
the page's own navigation." The justification is structural, not convenient:
`aria-selected` on a tab says which panel is showing — "it changes what the user
SEES, not what the form SENDS."

**A CAPTCHA vendor is not a CAPTCHA challenge.** Matching the vendor name alone
"shut the entire pipeline, and the failure was invisible because it looked like
the guardrail working": Greenhouse, Lever and Ashby all embed reCAPTCHA in its
`size=invisible` score-based form, which asks a human nothing. A frame counts as
passive only when it positively identifies itself as invisible **and** does not
look like a challenge frame; everything else still hands off. And the
classification reads `iframeEls` — the raw elements — not the truncated `iframes`
copy, because on a real Greenhouse anchor the `size=invisible` parameter sits past
the 160-character cut: "the first attempt at this fix read the truncated string,
never matched, and every board stayed blocked while the tests passed." The signal
prefix `"captcha passive:"` is pinned, because `fill-plan.mjs` treats any _other_
captcha signal as blocking, so an unrecognised one fails closed.

**Blind spots are declared, not papered over.** `document.querySelectorAll` stops
at a shadow-DOM boundary and at a document boundary, so a form inside a web
component's shadow root or inside a same-origin iframe is invisible here. Rather
than come back short and look complete, the scanner detects both and pushes a
signal saying so.

### C.8 The `labelExact` vouch

This is the safety mechanism the whole file is organised around, because
`fill-plan.mjs` requires it before a consent checkbox may ever be ticked without
you watching. `labelExact: true` is a **positive assertion** with one meaning:
_this field's `l` is the complete, visible text of the control's label._

Two demonstrated attacks it exists to stop, quoted from the file:

> **DECOUPLING** `<input aria-label="I certify the information is true">` beside
> `<span>I agree to binding arbitration and waive a jury trial.</span>` — the page
> picks what is MATCHED independently of what is DISPLAYED. So an attribute
> (aria-label, title, placeholder, name) can never establish exactness: it is not
> text the user can read. Only rendered DOM text can.
>
> **TRUNCATION** a 131-char certification and the same text plus " I also agree to
> binding arbitration." used to slice to the identical 120 chars. So a vouched
> label is never truncated.

That is why every label is computed at **full length** and only cut on the way
out, and why a vouched `l` may exceed 120 characters — the one exception to the
cut in the whole file.

`vouchFail(el, d)` returns `""` when the label can be vouched for, and otherwise
a human-readable reason. It requires, in order: a `VOUCHABLE` source
(`labelledby`, `for` or `wrap` — never an attribute); words in the text; at most
`MAX_EXACT = 1000` characters; at least one source node; every source node
visible to the eye; every source node adjacent to the control; no CSS
`::before`/`::after` content carrying letters or digits; the label covering only
this one control; exactly one `label[for]`; a unique `id`; and no rival label
(`aria-label`, `title`, an enclosing `<label>`) saying anything different.

`visibleToEye(el)` is where the CSS-only attacks are handled, and the comment
explains why the obvious check is not enough:

> THE DECOUPLING ATTACK DOES NOT NEED JAVASCRIPT. Hiding text from the eye while
> leaving it in innerText is pure CSS … `color: transparent` … `font-size: 0` …
> `opacity: 0` on an **ANCESTOR** — opacity does not inherit, so the element's own
> computed opacity is still "1" and a check on the element alone passes. This is
> the one that made the rest of the list reachable … another element painted over
> the top.

So it walks up to 30 ancestors checking opacity, rejects alpha-0 colours, rejects
font sizes under 6, rejects boxes smaller than 8×8, rejects elements parked off
the top-left of the document, and does an occlusion check with
`document.elementFromPoint` **only when the element is actually in the viewport**
— with the limit stated out loud: _a label below the fold is vouched without an
occlusion check._

**Everything fails closed.** There is deliberately no attribute, flag or option a
page can set to make `labelExact` true. The only way is to have a plain, visible,
unambiguous label — and then the vouched string _is_ the one on screen.

### C.9 What it reads and writes

**Reads:** the live DOM only. No files, no database, no network.

**Writes:** into the page — a `data-aj` attribute on every collected element, and
(in `scan-engine.mjs`'s and `scan.driver.mjs`'s probe) a `data-aj-toggle`
attribute on a dropdown's chevron button. It returns the scan; the drivers stash
a copy on `window.__ajLastScan`. The scan reaches disk only when a caller writes
it, conventionally to `jobs/<slug>/scan-p1.json`.

### C.10 Constants

| constant                    | value                                                                        | meaning                                                                  |
| --------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `MAX_OPTS`                  | 40                                                                           | option-list cut; always stated via `optsTruncated`/`optsTotal`           |
| `MAX_PROBE`                 | 15                                                                           | page-side probe cap — not reached in production (C.3)                    |
| `MAX_EXACT`                 | 1000                                                                         | longest vouchable label                                                  |
| `VOUCHABLE`                 | `{ labelledby, for, wrap }`                                                  | the only label sources that can vouch                                    |
| `AC_RESERVED`               | `{ on, off }`                                                                | autocomplete values that name no field, so they are omitted              |
| `REQ_TOKEN` / `REQ_NEGATED` | see C.7                                                                      | required-ness from a class name, with its negation                       |
| `CHOICE_TYPE`               | `{ checkbox, radio }`                                                        | the only types `presentedUnpainted` allows                               |
| `COMBO_SEL`                 | see C.7                                                                      | custom-dropdown shapes                                                   |
| `PAIR_OPT_MAX`              | 40                                                                           | longest option label in a button pair                                    |
| `PAIR_OPT_COUNT_MAX`        | 4                                                                            | cap when candidates merely share an ancestor                             |
| `PAIR_LIST_COUNT_MAX`       | 12                                                                           | cap when they share a **parent** — a sibling row is one answer set       |
| `PAIR_QUESTION_MAX`         | 300                                                                          | question-label cut, wider than the usual 120 so a long question survives |
| `MAX_PAIRS`                 | 8                                                                            | with a stated signal when exceeded                                       |
| `CLOSED_SETS`               | `[["no","yes"]]`                                                             | the tier-2 recognition list, sorted                                      |
| `CONTROL_ROLE`              | 13 roles                                                                     | picks the `aria-<role>` type string                                      |
| `NAVIGATION_ROLE`           | `{ tab, tablist, tabpanel }`                                                 | excluded **whatever state they declare**                                 |
| `ACTION_ROLE`               | `{ button, link, menuitem }`                                                 | excluded unless stateful                                                 |
| `MAX_WIDGET`                | 25                                                                           | with a stated signal                                                     |
| `OPTION_SEL`                | `[role='option'],[role='listbox'] li,[class*='__option'],[class*='menu'] li` | page-wide fallback only                                                  |
| `MENU_NODES_MAX`            | 400                                                                          | guards the leaf walk                                                     |
| `CAPTCHA_VENDOR`            | `/recaptcha\|hcaptcha\|turnstile/i`                                          |                                                                          |
| `CAPTCHA_CHALLENGE`         | `/bframe\|frame=challenge\|frame=checkbox\|checkbox/i`                       |                                                                          |

### C.11 Traps — things not to "fix"

1. **Do not run prettier on this file.** It is in `.prettierignore` as a
   contract.
2. **Do not remove `window.__ajScan =` from the start of a line, and do not
   remove or move the `// --- scanner ends here` marker.** `scannerExpression()`
   slices between them.
3. **Do not replace `claimedNow` with `closest("[data-aj]")`.** See C.6.
4. **Do not reorder the passes.** The pair detector must run before the button
   loop; the button loop must run before the widget sweep.
5. **Do not merge `lSeen` or `section` into `l`.** Downstream matching, caching
   and fingerprinting all key on `l`.
6. **Do not change `t` from `aria-<role>`/`widget` to `checkbox`** to "make it
   fillable". Operating those controls takes a click, and the fill engine
   deliberately has no verb that clicks. Reporting is not a verb.
7. **Do not delete `widget: "buttons"` from the recognised tier-2 group.**
8. **Do not add `tab` back to `CONTROL_ROLE`.**
9. **Do not match a CAPTCHA on the vendor name alone**, and do not classify from
   the truncated `iframes` array.
10. **Do not shorten an ambiguous question.** The bias is: keep more text.
11. **Do not add a 27th word to any word list and call it a fix.** The word lists
    in this file describe themselves as backstops; the structural rules are the
    load-bearing half.

### C.12 What it depends on, and what depends on it

**Depends on:** nothing. No imports, by construction. Only the browser's own DOM
APIs.

**Depended on by:** `scripts/apply/scan-engine.mjs` (reads its text),
`.claude/skills/apply-job/scan.driver.mjs` (loads it by path),
`scripts/apply/fill-plan.mjs` (embeds its text in the generated bootstrap, via
`readScannerSource()`), `scripts/apply/answer-bank.mjs` (consumes the `fields`
array), `scripts/apply/field-cache.mjs` (keys on `l`, caches `opts`),
`scripts/auto/advance.mjs` (relies on `roleOf`'s meaning of `next`), and the scan
fixtures in `tests/fixtures/boards/scans/*.scan.json`.

---

## Part D — `scripts/apply/scan-engine.mjs`

### D.1 What it is and why it exists

`scan-engine.mjs` is the Playwright-side half of scanning: it installs the
scanner, runs it, and opens every custom dropdown to read its options — in one
call, with nothing pasted into an agent's context.

Three jobs no other file can do:

1. **Install the scanner on a CSP-locked board without reloading the page**
   (D.4).
2. **Open dropdowns with a real click.** From its header:

   > WHY the probe lives here and not in `scan-page.js`: React ignores the
   > programmatic `el.click()` that page-context code can make, so react-select
   > menus never opened and every dropdown came back with no options — which meant
   > the planner deferred them all to the user. Playwright's click is a real input
   > event and does open them.

3. **Carry the label vouch out of band**, so a scan object cannot assert its own
   trustworthiness (D.7).

### D.2 How you use it

It is a **library**, not a CLI. There is no `main`, no argument parsing.

```js
import scanPage from "../apply/scan-engine.mjs"

const { scan, vouchedLabels } = await scanPage(page, {
  probeMax: 24,
})
```

Real callers today:

| caller                        | how                                                                                                                                                                 |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/auto/stages.mjs`     | `scanPage(page, { ...(scannerSrc === undefined ? {} : { scannerSrc }), url })`                                                                                      |
| `scripts/apply/fill-plan.mjs` | imports `probeRefusal` only, to filter its "worth probing" list                                                                                                     |
| `scripts/apply/browser.mjs`   | re-exports `scanPage`, `SCANNER_PATH`, `readScannerSource`                                                                                                          |
| `scripts/dev/bench-apply.mjs` | the benchmark harness                                                                                                                                               |
| tests                         | `fill-page`, `edge-cases`, `oracle-orc`, `ashby-combo-probe`, `greenhouse-portal-combo`, and `tests/security/rce-round-trip.test.mjs` (which imports `untrustScan`) |

### D.3 Everything it exposes

```js
export const SCANNER_PATH // absolute path to .claude/skills/apply-job/scan-page.js
export function readScannerSource(file = SCANNER_PATH)
export const DESTRUCTIVE_LABEL // RegExp
export function probeRefusal(f, norm = (s) => key(s))
export const SCANNER_END = "// --- scanner ends here"
export function scannerExpression(src = readScannerSource())
export default async function scanPage(page, opts = {})
export function untrustScan(scan, why)
```

| symbol                   | in                          | out                                                                                                                                                                          |
| ------------------------ | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SCANNER_PATH`           | —                           | absolute path, built from `import.meta.url`, **never from `process.cwd()`** — "the Node runner is started by a scheduled task whose working directory is not ours to assume" |
| `readScannerSource`      | a path                      | the file's UTF-8 text (synchronous read)                                                                                                                                     |
| `DESTRUCTIVE_LABEL`      | —                           | the word-list backstop, mirrored in two other files                                                                                                                          |
| `probeRefusal(f)`        | a scan field                | `""` if the probe may open this control, else the reason it may not                                                                                                          |
| `SCANNER_END`            | —                           | the marker string `scannerExpression` slices at                                                                                                                              |
| `scannerExpression`      | the scanner's text          | the arrow function alone, as one expression; throws if the anchor is gone                                                                                                    |
| `scanPage(page, opts)`   | a Playwright page + options | `{ scan, vouchedLabels }`                                                                                                                                                    |
| `untrustScan(scan, why)` | a scan + a reason           | `{ scan, stripped }`; deletes every `labelExact` in place                                                                                                                    |

`scanPage`'s options:

| key             | default                 | meaning                                                                                               |
| --------------- | ----------------------- | ----------------------------------------------------------------------------------------------------- |
| `scannerPath`   | `SCANNER_PATH`          | where to read the scanner from                                                                        |
| `scannerSrc`    | read from `scannerPath` | the scanner's text. Passing `null` or `""` deliberately forces the weaker "no source" path.           |
| `knownOpts`     | `{}`                    | `{ "label or key": ["option", …] }` already remembered — those dropdowns are not probed               |
| `skipProbe`     | `[]`                    | labels/keys the fact base already answers — not probed                                                |
| `probeMax`      | `24`                    | how many dropdowns may be opened at most                                                              |
| `probeBudgetMs` | `60000`                 | wall-clock ceiling on the whole probe loop; `0` disables it                                           |
| `now`           | `Date.now`              | injectable clock, so the budget is testable without burning a minute. Nothing in production passes it |

`DESTRUCTIVE_LABEL`, exactly:

```js
export const DESTRUCTIVE_LABEL =
  /\b(withdraw|delete|deactivate|remove|revoke)\b|\bsubmit\b|\bsend (my |the )?applicat|\bconfirm and\b|\bclose (my )?(account|profile)\b/i
```

> **Known gap (checked 2026-08-05).** `knownOpts` and `skipProbe` are read by
> `scanPage` but **no production caller passes either one.** `stages.mjs` passes
> only `scannerSrc` and `url`; `bench-apply.mjs` passes nothing. They appear
> outside this file only in `tests/apply/fill-page.test.mjs`. `fill-plan.mjs`
> exports `combosNeedingProbe(fields, resolved)` and its comment is addressed
> explicitly to a future wiring job — _"NOTE for whoever wires this into
> scan-engine.mjs's `skipProbe`"_ — including the warning that `skipProbe` must
> be the **complement** of that function's output, not its output. So the
> cache-aware probe skipping this file describes is designed and tested but not
> connected: every scan today probes every unknown dropdown up to the cap.

> **Known defect (checked 2026-08-05).** `stages.mjs` passes `url` to `scanPage`,
> and `scanPage` never reads it. Harmless, but it is dead.

> **Minor oddity, deliberate and safe.** `probeRefusal(f, norm = (s) => key(s))`
> uses `key` in a default parameter, and `key` is declared with `const` a few
> lines _below_ it. That works because a default parameter is evaluated when the
> function is called, not when it is defined — by which time `key` exists. It
> reads like a bug and is not one. The second parameter is never passed by any
> caller.

### D.4 The CSP nonce problem, concretely

This is the part that looks most like a mistake and is most load-bearing.

There are two ways to get a piece of JavaScript to run inside a page you are
driving:

**Option A — `page.addScriptTag({ path })`.** Playwright inserts a real
`<script>` element into the page's DOM, with your code inside it. This is exactly
what a page's own author would do, which is precisely the problem: it is subject
to the page's Content Security Policy. On a board with a nonce-based CSP — Ashby —
the browser refuses it and logs:

```
Executing inline script violates the following Content Security Policy directive
'script-src 'nonce-...' https://cdn.ashbyprd.com ...'
```

**That broke a live application.** The scanner never installed; nothing on the
page said so in a way the run could see.

**Option B — `page.evaluate((s) => { (0, eval)(s) }, src)`.** Playwright sends
this over CDP as a `Runtime.evaluate` message. It is **not a script the page
loaded**, so the page's CSP does not gate it — the same reason your browser's
DevTools console can run code on a CSP-locked page. Verified live on Greenhouse
(where `addScriptTag` happened to work too) and on Ashby (where only this works).

The engine's header states it:

> INSTALLING INTO THIS DOCUMENT goes through `page.evaluate` + `(0, eval)` when
> the caller hands us the scanner source, and NOT `page.addScriptTag({ path })`
> … The `addScriptTag` path is kept only as the fallback for a caller that has no
> source string, and its own fallback is a reload, which costs whatever the user
> has already typed into the form.

The `(0, eval)(s)` spelling is not a typo. Written as a bare `eval(s)`, JavaScript
treats it as a _direct_ eval, which runs in the enclosing function's scope; the
`(0, eval)` form is an _indirect_ eval, which runs in global scope — which is what
you want when the code you are evaluating is meant to define a global.

**The related half — "loads by filename".** When the `apply-job` skill runs the
fill step, the generated bootstrap `jobs/<slug>/fill-plan.js` is handed to the
MCP tool as a **`filename`**, not as an inline `code` string. Two different
reasons, both real:

1. The MCP server reads that file itself with an unrestricted `fs.readFile`
   before its sandbox exists — the sandbox has no filesystem, so there is no
   other way to get a large file in.
2. Engine text plus plan is roughly 180 KB. Putting that in an agent's context
   window costs an enormous amount for zero benefit.

CLAUDE.md's gotcha list states it as a rule: _"Bootstrap loads by `filename`,
**never** `addScriptTag` (nonce-CSP boards)."_ **Do not "fix" this back.**

### D.5 Control flow, step by step

**Step 1 — resolve the scanner source.**

```js
const scannerSrc =
  opts.scannerSrc === undefined
    ? readScannerSource(scannerPath)
    : opts.scannerSrc
```

Note the `=== undefined` test rather than a falsy test: passing `null` or `""`
_deliberately_ selects the weaker install path, which the tests use.

**Step 2 — register for future navigations.**

```js
await page.addInitScript(
  scannerSrc ? { content: scannerSrc } : { path: scannerPath },
)
```

An **init script** is code Playwright injects before any of the page's own scripts
run, on **every new document** in that browser context. So after this, navigating
to page 2 of a multi-page application still has `window.__ajScan` available. That
is what makes the ~30-token re-scan in `SKILL.md` possible:

```
browser_evaluate  () => window.__ajScan(false)
```

**Step 3 — install into _this_ document.** If we have the text, one
`page.evaluate` with `(0, eval)` (D.4). If we do not, `page.addScriptTag({ path })`,
and if that throws, `page.reload({ waitUntil: "domcontentloaded" })` — the fallback
of last resort, which "costs whatever the user has already typed into the form".

**Step 4 — build a local binding.** This is the part that makes the result
trustworthy:

```js
let expr = null
try {
  if (scannerSrc) expr = scannerExpression(scannerSrc)
} catch {
  expr = null
}
const runScan = (probe) =>
  expr
    ? page.evaluate((a) => (0, eval)("(" + a.scanner + ")")(a.probe), {
        scanner: expr,
        probe,
      })
    : page.evaluate(() => window.__ajScan(false))
```

When `expr` is available, the scanner function is created **inside a page-side
arrow function**, used immediately, and thrown away. It is a local value; nothing
on the page can reach it or replace it. The comment is blunt: _"A board can
define `window.__ajScan` all it likes; nothing below ever reads it."_

Falling back to the global when the slice fails is deliberate too: _"a scanner
that refuses to run is worse than one whose provenance is unknown, and the unknown
case is failed closed at the bottom of this function (every vouch stripped)."_

**Step 5 — wait for hydration, then scan.**

```js
await page.waitForLoadState("load").catch(() => {})
let scan = await runScan(false)
if (!scan.btns || !scan.btns.length) {
  await page
    .locator("button, [role='button'], input[type=submit]")
    .first()
    .waitFor({ state: "attached", timeout: 1500 })
    .catch(() => {})
  scan = await runScan(false)
}
```

_No buttons at all_ is the tell that React has not finished building the form. The
comment insists on the shape of the retry, and the distinction is the difference
between a fast pipeline and a slow one: **"Wait for a button to EXIST rather than
for a flat 1.5 seconds… Same ceiling; a page that hydrates in 200ms costs 200ms."**
A flat sleep taxes every application to cover the slowest one.

**Step 6 — decide which dropdowns to open.** For every field with `t === "combo"`
and no options yet, in **this exact order**:

| order | check                          | result                                                        |
| ----- | ------------------------------ | ------------------------------------------------------------- |
| 1     | `probeRefusal(f)` returns text | `f.probe_refused = <reason>`, `stats.refused++`               |
| 2     | `knownOpts` hit                | `f.opts = cached`, `f.opts_from = "cache"`, `stats.cached++`  |
| 3     | `skipProbe` hit                | `f.probe_skipped = "answer already known"`, `stats.skipped++` |
| 4     | `todo.length >= probeMax`      | `f.probe_skipped = "probe cap"`, `stats.capped++`             |
| 5     | otherwise                      | queued in `todo`                                              |

**The refusal check runs first, on purpose.** From the comment: _"Before anything
else, and independent of what the caller asked for: a caller that forgets to pass
`skipProbe` must not be able to make the scanner click Withdraw."_

**Step 7 — probe each queued dropdown, one at a time.** This is D.6. Before each
control is touched, the wall-clock budget is checked; once it is gone the rest of
the queue is marked `probe_skipped: "probe budget"` rather than opened.

**Step 8** — `scan.probe = stats`, where
`stats = { probed, cached, skipped, capped, refused }`.

**Step 9 — collect the vouch out of band**, then **Step 10** — `untrustScan(scan, …)`
strips every `labelExact` from the scan itself. Both explained in D.7.

**Step 11** — stash the scan on `window.__ajLastScan` so a caller can write it to
disk with one cheap call instead of paying for the whole object twice.

**Step 12** — `return { scan, vouchedLabels }`.

#### `scannerExpression()`, worked

```js
export function scannerExpression(src = readScannerSource()) {
  const m = /^window\.__ajScan\s*=\s*/m.exec(String(src))
  if (!m) {
    throw new Error(
      "scan-page.js no longer starts with a `window.__ajScan =` assignment " +
        "at the start of a line — scannerExpression() depends on it",
    )
  }
  const rest = src.slice(m.index + m[0].length)
  const end = rest.indexOf(SCANNER_END)
  return (end < 0 ? rest : rest.slice(0, end)).trim()
}
```

Given a file that reads:

```js
// … 124 lines of header comment, including the words "async (PROBE" in prose …
window.__ajScan = async (PROBE = true) => {
  /* … */
}
// --- scanner ends here; nothing below is part of the function ------------
try {
  Object.defineProperty(window, "__ajScan", { … })
} catch (e) {}
```

the function returns exactly `async (PROBE = true) => { /* … */ }`.

Two details are anchored by comments and both were learned:

- The anchor is the **assignment at the start of a line** (`/^window\.__ajScan\s*=\s*/m`,
  where `m` makes `^` mean "start of any line"), not the arrow's own text.
  `scan-page.js`'s header quotes `"async (PROBE"` in prose when telling a human
  where to paste from, so searching for that lands inside a comment and returns
  prose.
- It stops at `SCANNER_END` because the file is a _script_ with a second statement
  after the function, and slicing to end-of-file would hand `eval` two statements
  where it needs one expression.

### D.6 Probing a dropdown — the expensive part

**What "probing" means.** A native `<select>` carries its options in the markup,
so reading them is free. A **custom** dropdown — a react-select widget, an Ashby
typeahead, an Oracle picker — usually has no options in the DOM at all until you
open it. To know what a form offers, something has to actually **click the thing
and read the menu that appears.** That is a probe.

**Why it is the slowest part of a scan.** Each probe is a real click, a wait for
the menu to render, a DOM read, an Escape, and a wait for the menu to close —
several browser round trips plus whatever the board's own JavaScript takes.
`fill-plan.mjs` records the measurement as **1.5–2.5 seconds each**, and the cap
is 24 dropdowns. The pre-instrumentation estimate in `docs/measurements.md` is
"~9.1s (380ms × ≤24 dropdowns)" — and that document is explicit that this is an
**estimate, not a measurement.** Either way, on a form with many pickers the probe
dominates the scan.

**Two bounds, and the second is the one that was actually meant.** `probeMax`
caps the COUNT at 24; `probeBudgetMs` caps the wall-clock TIME at 60 seconds,
checked before each control is touched so it can only stop work that has not
started. The count was always a proxy for the time — the cap's own comment says
"a long form should not spend a minute in here" — and that proxy holds only
while a single control is cheap. When the cap went 18 → 24 and the click ceiling
went 2s → 6s (D.6 step 4), the pathological form where every control times out
went from roughly 72s to roughly 264s. The budget puts the worst case back to
about a minute while a healthy 24-combo form, at well under a second each, never
approaches it. A field the budget stops states `probe_skipped: "probe budget"`,
so it is never mistaken for a field that was probed and found empty.

That is why `knownOpts` and `skipProbe` exist at all, and why the `apply-job`
skill tells the agent to skip the probe on a board applied to before.

#### What the probe is allowed to click

This is a click on somebody's live application, fired by the **scanner** — before
a plan exists, before anything is approved. The header states the asymmetry:

> The cost of not probing a control is that the user picks that value themselves.
> The cost of probing the wrong control is a click on someone's live application …
> Those costs are not symmetric, so this refuses on any doubt.

The scanner identifies dropdowns **by shape alone** — `[role=combobox]`,
`[aria-haspopup=listbox]`, `[class*=select__control]`, `[data-ui=select]` — and
shape cannot tell a country picker from a button a board decorated with
`role="combobox"` and labelled "Withdraw my application". The hostile fixture
`tests/fixtures/hostile/forms/destructive-combobox.html` makes the honest and the
hostile control **identical in shape**, so that no shape rule can separate them and
a rule that tries is theatre.

So there are two rules, and only the first is structural:

> 1. **A PICKER'S NAME COMES FROM OUTSIDE IT; A BUTTON'S NAME IS ITS OWN TEXT.** A
>    dropdown renders a placeholder ("Select...") or its current value and takes
>    its NAME from a separate label — that is what makes it a picker. A control
>    whose accessible name is exactly the words rendered inside it is a button
>    wearing a dropdown's clothes.
> 2. **A WORD LIST, as a backstop, named as one.** It has a word list's weakness —
>    the next rewording is free — and it exists only to catch shapes rule 1 misses.
>    Nothing rests on it alone, and **adding a 27th word is not a fix.**

`probeRefusal(f)` in full:

```js
export function probeRefusal(f, norm = (s) => key(s)) {
  const name = norm(f?.l)
  const own = norm(f?.v)
  if (!name) return "no label to identify it as a picker"
  if (
    own &&
    (name === own ||
      (own.length >= 12 && (name.startsWith(own) || own.startsWith(name))))
  ) {
    return "its name is its own text, so it is a button, not a picker"
  }
  if (DESTRUCTIVE_LABEL.test(String(f?.l ?? ""))) {
    return "label reads as an action on the application, not a choice"
  }
  return ""
}
```

Worked, with realistic values:

| field                                                            | outcome                                                                            |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `{ l: "Country", v: "Select..." }`                               | `""` — probe allowed. Different strings, `v` is under 12 chars, no bad words       |
| `{ l: "How did you hear about us?", v: "Select..." }`            | `""` — probe allowed                                                               |
| `{ l: "", v: "Select..." }`                                      | `"no label to identify it as a picker"`                                            |
| `{ l: "Withdraw my application", v: "Withdraw my application" }` | `"its name is its own text, so it is a button, not a picker"` (rule 1 fires first) |
| `{ l: "Submit application now", v: "" }`                         | `"label reads as an action on the application, not a choice"`                      |

This function is mirrored **character-for-character** in `scan.driver.mjs` and in
`scan-page.js`'s own probe loop, because a click happens in three places and none
of them can import the others. `tests/apply/fill-page.test.mjs` pins all three
against each other so a drift is loud.

#### One probe, step by step, on Ashby

Suppose the scan came back with
`{ k: "f7", t: "combo", l: "How did you hear about us?", v: "Select...", req: true }`
and no `opts`.

1. `probeRefusal(f)` returns `""`. Probe allowed.
2. `const loc = page.locator('[data-aj="f7"]')`. A **locator** is a lazy query —
   it does not hold an element, it re-runs the selector every time it is used,
   which is what makes it survive a re-render.
3. `await loc.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {})` —
   **swallowing the error is the fix, not a lapse.** Measured on Oracle Recruiting
   Cloud, 2026-08-04, when this ceiling was 2000 ms: every required picker came
   back with `probe_error: "locator.scrollIntoViewIfNeeded: Timeout 2000ms exceeded"`
   and no options at all, because this call threw before the click was ever
   attempted. _"Scrolling is preparation, not the probe."_
4. `await loc.click({ timeout: 6000 })` — **not `force: true`.** A forced click
   skips every actionability check (is it visible, is it covered by an overlay,
   does it receive pointer events), _"which is precisely 'click something the user
   could not have clicked'."_ A genuinely unclickable control fails here, becomes
   `probe_error`, and defers to you — the designed failure mode.

   The ceiling is 6 seconds because 2 was not enough. On Coinbase's Greenhouse
   form, 2026-08-07, it fired on control after control that a human clicks
   without noticing a delay — `probe_error: "locator.click: Timeout 2000ms exceeded"`
   on 13 of 19 required combos. A timeout that fires on a clickable control is
   not a safety property; it defers a field that would have answered. The
   actionability checks, which _are_ the safety property, are unchanged.

5. **Read the aria from the element that carries it, which is not always the
   element we stamped.** The scanner stamps the `.select__control` shell —
   deliberately, because that is what a human clicks and what every `data-aj`
   selector must resolve to (D.4) — but react-select puts `aria-controls` and
   `aria-expanded` on the `input.select__input` **inside** it:

   ```html
   <div class="select__control">
     <!-- stamped; carries no aria at all -->
     <div class="select__value-container">
       <input
         class="select__input"
         role="combobox"
         aria-controls="react-select-3-listbox"
         aria-expanded="false"
       />
     </div>
   </div>
   ```

   Read off the shell, both attributes returned `null`, so the menu was never
   named **and** `aria-expanded` never read `"false"`, which meant the chevron
   fallback in step 6 could not fire either. Both halves of the probe were
   looking at an element that says nothing. `ariaOf()` asks the shell first and
   falls through to the inner combobox only when the shell is silent, so
   identity stays on the shell and a control that names its own menu — every
   Oracle picker, where `role="combobox"` is on the input and the input _is_ the
   stamped element — is untouched.

6. Wait for the menu to **render, not for a flat 300 ms**. If the control names its
   own menu with `aria-controls`, wait up to 300 ms for that element to be
   _visible_. Otherwise wait for `[class*='__option']` to be _attached_. The
   comment says why not a bare `[role=option]`: _"a bare `[role=option]` also
   matches the phone country-code widget, which is always in the DOM — so waiting
   on that would return instantly on every form with a phone field, and reading it
   would hand every dropdown the same list of countries."_
7. **The box is not always what opens the menu.** Read `aria-expanded`. On Ashby it
   is still `"false"`, because its dropdown is

   ```html
   <div class="_inputContainer_">
     <input role="combobox" aria-expanded="false" />
     <button class="_toggleButton_"><svg chevron /></button>
   </div>
   ```

   and clicking the input only focuses it. So the engine runs a small
   `page.evaluate` that looks inside the control's **own parent element** for a
   `<button>` with **no innerText and no `aria-label`**, stamps it
   `data-aj-toggle="f7"`, and Playwright clicks that. What may be clicked is
   bounded hard, and it is the same distinction `probeRefusal` draws: _"A chevron
   has none; 'Withdraw my application' has plenty."_ Then `aria-controls` is
   re-read, because "a control that was closed may only NAME its menu once it has
   one".

   Before this, "every Ashby dropdown probed as zero options and came back
   NEEDS-CHOICE, blocking the submit on a form whose lists are perfectly readable:
   an 11-option 'How did you hear about us?' was deferred to a human for no reason
   at all."

8. Read the options with **one** `page.evaluate`. Inside the page:
   - find the menu the control names (`aria-controls` / `aria-owns` →
     `getElementById` → it must be visible), reading those attributes through the
     same shell-then-inner-input redirection as step 5;
   - **otherwise, if exactly one `[class*='select__menu-list']` is visible
     anywhere on the page, that is the menu** — react-select renders
     `.select__menu` in a **portal**, a sibling of `<body>` rather than a
     descendant of the control, so every container-scoped lookup misses it. This
     is sound only because the probe opens exactly one control at a time and
     presses Escape before the next, so a single visible menu-list is
     unambiguously the one just opened. Two or more means that assumption does
     not hold — a stale menu, or a board rendering several — and the read
     declines to choose between them rather than guessing;
   - take `[role='option']` rows if the page declares them;
   - otherwise take the menu's **text leaves** — elements holding text with no
     text-holding descendant — each climbed back out to the outermost ancestor
     with the same text, so `<li><span>X</span></li>` yields the `<li>` once
     rather than the span and the `li` twice;
   - if the menu has more than 400 nodes, fall back to visible leaves;
   - if no menu is found at all, fall back to the page-wide
     `"[role='option'],[role='listbox'] li,[class*='__option'],[class*='menu'] li"`,
     reduced to leaves;
   - drop empty-state decoration with
     `/^(no results?|no options?|no matches?|nothing found|start typing|type to search)\b/i`;
   - return `{ opts: all.slice(0, 40), total: all.length }`.

   The named menu always wins over the portal read, and that ordering is the
   bound: the portal read is a fallback for controls that name nothing, never a
   replacement for what the page told us. `tests/apply/greenhouse-portal-combo.test.mjs`
   pins it with a control whose own menu is open while a decoy sits visible in
   the portal.

   Two further incidents live in that list. On ORC the rows are neither `[role='option']`
   nor `[class*='__option']`, and the only `<li>` inside the listbox is the
   scroller holding every row — so three required pickers came back with **one**
   option each, and that option was every option run together and cut at 60
   characters: `"Billboard Built In Facebook Indeed LinkedIn Radio Ad Referra"`. On
   Ashby, an async Location typeahead opened with no query renders
   `<div role="listbox"><div class="_noResults_"><p>No results</p>` and declares no
   `[role=option]` at all, so the leaf fallback returned `["No results"]` **as the
   option list**. _"A blob is worse than nothing"_ — the field cache stores a
   returned list as the complete one, so the real answer then resolves "not on
   offer" on every future application to that board. Note the empty-state filter
   only ever **removes**, so its own failure mode is a defer, never a wrong fill.

9. The return shape is checked rather than assumed. A bare array is accepted (the
   shape this returned before the truncation flag existed); anything unexpected is
   coerced. _"an unexpected one used to become `probe_error` on every dropdown at
   once, which reads as 'this board refuses to open its menus' and is
   indistinguishable from the real thing."_
10. If `total > opts.length`: `f.optsTruncated = true; f.optsTotal = total`. **The
    cut is stated, never silent** — 40 survivors of a 200-option country list are
    otherwise indistinguishable from a genuine 40-option list, the cache stores the
    short list as complete, and an answer the form really does offer, past the cut,
    resolves as "not on offer" and is deferred for no reason.
11. `stats.probed++`, press `Escape`, then wait up to 80 ms for
    `[class*='__option']` to be **detached**, so the next dropdown is not clicked
    through an open menu. (If the board's rows do not carry a `__option` class,
    that wait has nothing to watch and confirms nothing — it is a react-select
    shape, like the open wait in step 6.)
12. Any throw at all: `f.probe_error = String(e.message).slice(0, 60)` and the loop
    continues to the next dropdown. One bad picker never costs the rest of the
    scan.

### D.7 The vouch travels out of band

`labelExact` used to be a boolean **inside** the scan. The comment states the
principle, and it generalises well beyond this file:

> a boolean inside the data that crosses a trust boundary is not a boundary — it
> is a field, and every producer of a scan object can set it. There are three
> producers: this file, `.claude/skills/apply-job/scan.driver.mjs`, and the bare
> `browser_evaluate () => window.__ajScan(false)` re-scan that `apply-job/SKILL.md`
> documents for page 2 onward, which runs neither of the other two and whose
> output still becomes `scan-p<N>.json`.

So the vouch is now a **second return value**. `vouchedLabels` is a plain array of
complete visible label strings, held in this Node process. It never goes into the
page, it is never stashed on `window`, and it is not in the scan written to disk.
It is collected **only when `expr` is set** — that is, only when the scanner was
called through a local binding and we therefore know whose function answered.

Then `untrustScan(scan, why)` deletes `labelExact` from every field and every
sub-option, records `f.labelWhy = why`, and appends
`"scan not vouched: <why>"` to `scan.signals`. It runs on **both** paths, with
different reasons:

| path                    | `why`                                                        |
| ----------------------- | ------------------------------------------------------------ |
| local binding available | `"the vouch is carried out of band and is not in this file"` |
| fell back to the global | `"the scanner was called through window.__ajScan"`           |

`scripts/auto/stages.mjs` then keeps the array in a `WeakMap` keyed on the scan
object (`vouchOf`), precisely so it never travels _inside_ the scan again: the
planner gets a vouch only for a scan this process actually produced, and a scan
loaded from anywhere else has no entry and therefore no vouch.

The file states its own honest limit, which is worth carrying forward exactly:

> `labelExact` is still COMPUTED in the page, so a board that patches
> `HTMLElement.prototype` (innerText, getBoundingClientRect, getComputedStyle) can
> lie to an honest scanner. No Playwright-based scanner can close that —
> `locator.innerText()` runs in the page too. **What IS closed is the page
> choosing WHICH FUNCTION answers.**

### D.8 What it reads and writes

**Reads:** the file at `SCANNER_PATH` (text). Nothing from SQLite; nothing from
`profile/`.

**Writes:** nothing to disk. It mutates the `scan` object in memory and sets
`window.__ajLastScan` in the page. Keys it adds to the scan:

| key                               | where     | meaning                                                     |
| --------------------------------- | --------- | ----------------------------------------------------------- |
| `scan.probe`                      | top level | `{ probed, cached, skipped, capped, refused }`              |
| `scan.signals[]`                  | top level | may gain `"scan not vouched: <why>"`                        |
| `f.opts`                          | per field | the probed option list, at most 40 strings                  |
| `f.opts_from`                     | per field | `"cache"` when it came from `knownOpts`                     |
| `f.optsTruncated` / `f.optsTotal` | per field | the cut was stated                                          |
| `f.probe_refused`                 | per field | `probeRefusal`'s reason                                     |
| `f.probe_skipped`                 | per field | `"answer already known"`, `"probe cap"` or `"probe budget"` |
| `f.probe_error`                   | per field | first 60 characters of the thrown message                   |
| `f.labelWhy`                      | per field | set by `untrustScan`                                        |
| `f.labelExact`                    | per field | **deleted** by `untrustScan`                                |

### D.9 Traps — things not to "fix"

1. **Install unconditionally.** This is the second odd-looking, load-bearing
   choice in this file, and it deserves its own paragraph. The code used to skip
   installing when `typeof window.__ajScan === "function"`, saving about one
   millisecond. From the comment:

   > A board that defines that global before the runner arrives was therefore
   > "ready", the real scanner was never installed, and every field key, label,
   > selector and FLAG in the scan was chosen by the board. The flag that matters
   > is `labelExact`: `fill-plan.mjs` treats it as the precondition for ticking a
   > consent box unattended, so a page-supplied scanner could assert it over any
   > wording it liked.

   So: install every time (one CDP round trip, ~1 ms) and read the authoritative
   scan through a local binding no page script can reach. CLAUDE.md lists this in
   the "never fix these back" section.

2. **`scrollIntoViewIfNeeded` must stay non-fatal**, and **the click must stay
   unforced.** Both carry measured incidents (D.6 steps 3–4).
3. **The refusal check runs before the cache and skip checks.** Order matters.
4. **Do not read `window.__ajScan` for the authoritative scan.**
5. **Do not remove `untrustScan`'s call on the strong path.** The vouch leaving
   out of band is the whole design; leaving a copy inside the scan re-opens what
   it closed.
6. **Do not "fix" `probeRefusal`'s temporal-dead-zone-looking default parameter.**
7. **Keep this file and `scan.driver.mjs` in step** on everything that does not
   need a parameter. The header records that they drifted once already, and
   `tests/apply/fill-page.test.mjs` pins the shared ceilings:

   ```js
   assert.ok(driverCode.includes("todo.length >= 24"))
   assert.ok(engine.includes("opts.probeMax === undefined ? 24"))
   ```

### D.10 Dependencies

**Imports:** `node:fs`, `node:path`, `node:url`. Nothing else.

**Depended on by:** `scripts/auto/stages.mjs`, `scripts/apply/browser.mjs`
(re-export), `scripts/apply/fill-plan.mjs` (`probeRefusal` only),
`scripts/dev/bench-apply.mjs`, and five test files.

---

## Part E — `.claude/skills/apply-job/scan.driver.mjs`

### E.1 What it is and why it exists

This is the MCP twin of `scan-engine.mjs`: it installs the scanner, runs it,
probes dropdowns, strips every vouch, and returns the scan — in **one tool call
with no pasted code**. It is the path the `apply-job` skill actually uses today,
which makes it the one that runs on a normal attended application.

It exists because `scan-engine.mjs` cannot run there. The Playwright MCP server's
`browser_run_code_unsafe` tool reads a file and evaluates its contents inside a
`vm` sandbox with `vm.runInContext("(" + code + ")", context)`. That sandbox has:

- no working `import` — playwright-core's `runCode.ts` supplies no
  `importModuleDynamically` callback, so even `await import("node:fs")` throws
  `ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING`;
- no `require`, no `fs`, no `setTimeout`, no `console`.

So the file must be a **bare function expression** — `async (page) => { … }` —
with no `export`, no leading semicolon, and no imports. That is exactly why it
sits in `.prettierignore` alongside `scan-page.js`, and its own header says so:

> NOT a module: the Playwright MCP server eval's these contents as a bare function
> expression in a vm sandbox — no imports, no require, no fs, no setTimeout, and
> no leading semicolon (see .prettierignore).

### E.2 How you run it

```
mcp__playwright__browser_run_code_unsafe
  { filename: ".claude/skills/apply-job/scan.driver.mjs" }
```

That is the whole invocation. The MCP server does a real `fs.readFile` of that
filename **before** the sandbox exists (which is why the scanner can be loaded by
path at all), and it passes **no arguments** other than `page`.

It returns the `scan` object directly. `SKILL.md` then writes it to disk with a
second, cheap call:

```
browser_evaluate { function: "() => window.__ajLastScan", filename: "scan-p1.json" }
```

**It has no options and no exported symbols.** It is one anonymous async function
taking `page`.

### E.3 How it works, step by step

1. `const path = ".claude/skills/apply-job/scan-page.js"` — a **relative** path,
   resolved against the MCP server's working directory.
2. `const preOwned = await page.evaluate(() => typeof window.__ajScan === "function")`
   — "was something already answering to `__ajScan` before we installed
   anything?"
3. **If not pre-owned**, install: `page.addInitScript({ path })`, then
   `page.addScriptTag({ path })`, and on a throw
   `page.reload({ waitUntil: "domcontentloaded" })` with the comment _"strict CSP
   blocks injected script tags; the init script survives a reload"._
4. `await page.waitForLoadState("load").catch(() => {})`, then
   `scan = await page.evaluate(() => window.__ajScan(false))`, with the same
   no-buttons hydration re-scan as the engine.
5. Its own copy of `probeRefusal`, character-identical to the engine's.
6. The probe loop — same `stats` object, same non-fatal scroll, same unforced
   click, same `aria-controls` menu wait, same Ashby chevron fallback, same
   page-side option reader with the same empty-state filter, same Escape and
   detach wait. The cap is hardcoded: `if (todo.length >= 24)`, as is the 60s budget.
7. **Strip every vouch, unconditionally.**
8. `await page.evaluate((s) => (window.__ajLastScan = s), scan)`.
9. `return scan`.

### E.4 The two differences that matter

**Difference 1 — it cannot be told what to skip.** Stated in its own header:

> This driver cannot be told WHICH dropdowns to skip: `browser_run_code_unsafe`
> takes a filename and passes no arguments, and this vm has no fs to read a hint
> file with. `scripts/apply/scan-engine.mjs` — the ordinary-module twin used by
> the local runner — takes `{ knownOpts, skipProbe }` and probes only what is
> genuinely unknown. Keep the two in step on everything that does NOT need a
> parameter, which is every wait below.

Consequence: `stats.cached` and `stats.skipped` are always `0` on this path.

**Difference 2 — no vouch ever survives it.** This is the one thing the two files
deliberately do **not** share, and the reasoning is worth having verbatim:

> `labelExact` is `fill-plan.mjs`'s precondition for ticking a consent box
> unattended. It can only mean anything if BOTH the code that computed it and the
> channel that carried it are out of the page's reach. Neither is true here: this
> driver cannot embed the scanner's text (no fs in this vm), so it must call
> `window.__ajScan` and cannot know whose function answered; and the scan is
> carried out of the page again by
> `browser_evaluate { function: "() => window.__ajLastScan", filename }` where a
> getter on that global can return anything at all. … Here the user is on the
> submit button anyway, so the cost of stripping is one tick in the browser.

So the stripping reason is one of two strings, and both are recorded in
`scan.signals`:

| condition    | `why`                                              |
| ------------ | -------------------------------------------------- |
| `preOwned`   | `"a script on this page already defined __ajScan"` |
| ordinary run | `"the MCP scan path cannot vouch for a label"`     |

The practical effect: on the attended path, **no consent box is ever ticked
automatically because of a scanner vouch.** You tick it in the browser. That is
one click, and it is the correct trade.

> **A real limitation, recorded rather than fixed.** When `preOwned` is true this
> driver **skips installation entirely** and runs whatever function the page
> already put there — so a hostile board supplies the whole scan. It cannot be
> fixed the way the engine fixes it, because the fix needs the scanner's text and
> this sandbox has no filesystem. What it does instead is record the fact and
> fail closed on the thing that matters: every vouch is stripped and a signal is
> appended. `docs/reference/09-gotchas.md` makes the point that reading the
> unconditional-install rule as covering both files is the mistake — **only
> `scan-engine.mjs` gets the strong version.**

### E.5 Traps

1. **Keep it small.** Its header: _"it is echoed back in the tool result, and a
   big driver would put that cost straight back into context."_ This is a
   token-cost invariant, and it is in direct tension with "keep the two files in
   step" — which is exactly why the shared parts are the waits and the guards, and
   the differences are all parameter-driven.
2. **`.prettierignore` contract**, same as `scan-page.js`.
3. **The two files have drifted before**, and the drift landed in the path that
   actually runs: _"the flat sleeps this file removed sat in the driver, which is
   the path that actually runs today."_ The pinning test in
   `tests/apply/fill-page.test.mjs` checks that both carry the same ceilings
   (`timeout: 300` menu wait, `state: "detached", timeout: 80`,
   `state: "attached", timeout: 1500`), the same 6000 ms click and 5000 ms scroll
   ceilings, and the same probe cap and 60s budget.
4. **Do not add a vouch back to this path** to "match the engine".

### E.6 Dependencies

**Depends on:** `scan-page.js` (loaded by path at runtime) and the Playwright MCP
server's `page`. No imports — it cannot have any.

**Depended on by:** `.claude/skills/apply-job/SKILL.md` (step A of the apply
flow), `scripts/dev/bench-apply.mjs` (counts it as a protocol step),
`tests/apply/fill-page.test.mjs` (pins its mirrored guard and ceilings).

---

## Part F — `scripts/apply/browser.mjs`

### F.1 What it is and why it exists

This is the Node-side plumbing for the browser path: launch a browser, open a
page, decide where a browser is allowed to point, and translate the fill engine's
module text into something a sandbox can evaluate.

Without it there is no browser at all on the local-runner path, and no way to turn
`fill-engine.mjs` (an ES module) into the string the MCP sandbox needs. It also
holds the **loopback-only guard**, so tests and benchmarks cannot be pointed at a
real employer's board by editing one argument.

Its header sets out the two ways the engines reach a `page`:

> 1. The **LOCAL RUNNER** (`scripts/auto/*`, tests against the fake board under
>    `tests/fixtures/boards/`). Ordinary Node, ordinary `import` — `launchBrowser()`
>    here, then `fillPage(page, plan)` / `scanPage(page)`. No MCP, no model.
> 2. The **MCP path** (`browser_run_code_unsafe { filename }`), whose vm has no
>    working `import` and no `fs`. `scripts/apply/fill-plan.mjs` reads the engine
>    text off OUR OWN DISK with `engineSandboxSource()` below and embeds it in the
>    generated `jobs/<slug>/fill-plan.js`, which `eval`s that one string.

And the safety note, which is a rule about what must **not** be added:

> SAFETY: nothing in this file clicks a button, and neither engine has a verb for
> it. **Do not add a submit helper here to "complete" the API.**

### F.2 How you use it

A library, imported. No CLI, no `main`.

```js
import { launchBrowser } from "../apply/browser.mjs"

const session = await launchBrowser({ headless: true })
try {
  await session.goto("http://127.0.0.1:8931/greenhouse-p1.html")
  const { scan } = await scanPage(session.page)
} finally {
  await session.close()
}
```

Real importers: `scripts/apply/fill-plan.mjs` (`embedLiteral`,
`engineSandboxSource`, `readScannerSource`), `scripts/auto/auto-apply.mjs`
(`launchBrowser`), and six test files.

### F.3 Everything it exposes

```js
export { fillPage, scanPage, SCANNER_PATH, readScannerSource } // re-exports
export const ENGINE_PATH
export function readEngineSource(file = ENGINE_PATH)
export function embedLiteral(value)
export function engineSandboxSource(src = readEngineSource())
export function isLocalUrl(url)
export function assertAllowedTarget(url, { localOnly } = {})
export async function loadChromium()
export async function launchBrowser(opts = {})
export async function withBrowser(opts, fn)
```

| symbol                                    | in                          | out                                                                                                   |
| ----------------------------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------- |
| `ENGINE_PATH`                             | —                           | absolute path to `scripts/apply/fill-engine.mjs`, built from `import.meta.url`                        |
| `readEngineSource(file)`                  | a path                      | the file's UTF-8 text                                                                                 |
| `embedLiteral(value)`                     | any JSON-serialisable value | a **JavaScript source literal** string                                                                |
| `engineSandboxSource(src)`                | the engine's text           | a string whose `eval` result **is** the `fillPage` function; throws if the engine breaks its contract |
| `isLocalUrl(url)`                         | a URL string                | `true`/`false`                                                                                        |
| `assertAllowedTarget(url, { localOnly })` | a URL + optional override   | the URL, or **throws**                                                                                |
| `loadChromium()`                          | —                           | the `chromium` object from `playwright-core`                                                          |
| `launchBrowser(opts)`                     | see below                   | `{ browser, context, page, localOnly, goto, close }`                                                  |
| `withBrowser(opts, fn)`                   | opts + an async callback    | whatever `fn` returns; closes the browser in a `finally`                                              |

`launchBrowser` options:

| key              | default                           | meaning                                                                                         |
| ---------------- | --------------------------------- | ----------------------------------------------------------------------------------------------- |
| `userDataDir`    | `null`                            | non-null ⇒ a **persistent** context, which is how a logged-in ATS session survives between runs |
| `headless`       | `true`                            | run without a visible window                                                                    |
| `executablePath` | `process.env.PLAYWRIGHT_CHROMIUM` | which browser binary to use                                                                     |
| `channel`        | `process.env.PLAYWRIGHT_CHANNEL`  | an installed channel, e.g. `chrome`                                                             |
| `timeout`        | `30000`                           | default action timeout, applied with `context.setDefaultTimeout`                                |
| `args`           | `[]`                              | extra Chromium command-line arguments                                                           |
| `localOnly`      | `undefined`                       | `undefined` means **restrict** (the safe default); `false` must be passed deliberately          |

Environment variables it reads:

| variable                  | effect                                                         |
| ------------------------- | -------------------------------------------------------------- |
| `PLAYWRIGHT_CHROMIUM`     | path to a browser binary                                       |
| `PLAYWRIGHT_CHANNEL`      | an installed browser channel name                              |
| `AJ_BROWSER_ALLOW_REMOTE` | `"1"` lifts the loopback restriction when `localOnly` is unset |

There are no exit codes: nothing here is a command-line program.

### F.4 How it works — the three interesting functions

**`engineSandboxSource(src)` — a module becomes a script.** The MCP sandbox has no
module loader, so `export default async function fillPage(...)` cannot be
`import`ed there. The translation is exactly one keyword:

```js
const DEFAULT_EXPORT =
  /^export default\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/m

export function engineSandboxSource(src = readEngineSource()) {
  const m = DEFAULT_EXPORT.exec(src)
  if (!m)
    throw new Error(
      "fill-engine.mjs must default-export a named function declaration",
    )
  const body = src.replace(/^export default\s+/m, "")
  const stray = body
    .split(/\r?\n/)
    .find((l) => /^\s*(import\s|export\s|import\()/.test(l))
  if (stray) {
    throw new Error(
      `fill-engine.mjs must stay self-contained for the sandbox; found: ${stray.trim().slice(0, 60)}`,
    )
  }
  return `${body}\n${m[1]}\n`
}
```

Worked: given a file beginning `export default async function fillPage(page, plan) {`,
this strips `export default `, leaving a plain function declaration, and appends a
final line containing just `fillPage`. Evaluating the whole string therefore
_produces_ the function. (That last-expression value is JavaScript's **completion
value**: `eval("const a = 1\na")` returns `1`.)

Everything it asserts is a real constraint on `fill-engine.mjs`, not decoration:

> an `import` line or a second export would compile as a module and throw as a
> script, i.e. **it would break only in the browser, only in production.**
> `tests/apply/fill-page.test.mjs` pins all of it.

That is why `fill-engine.mjs` may never import anything.

**`embedLiteral(value)` — never a bare `JSON.stringify`.**

```js
const LINE_SEPARATORS = new RegExp("[\\u2028\\u2029]", "g")

export function embedLiteral(value) {
  return JSON.stringify(value).replace(
    LINE_SEPARATORS,
    (c) => "\\u" + c.charCodeAt(0).toString(16),
  )
}
```

The comment gives the reason:

> JSON.stringify's output is a valid JS literal with exactly one exception: U+2028
> and U+2029 are legal inside a JSON string and are LINE TERMINATORS in JS source.
> The plan carries labels copied verbatim off a third-party page, so escape them
> rather than trust the parser version inside the MCP vm.

In plain terms: those two Unicode characters (LINE SEPARATOR and PARAGRAPH
SEPARATOR) look like ordinary invisible whitespace, are perfectly legal inside
JSON, and — in older JavaScript parsers — end a line of source code. A board that
put one inside a field label could therefore break the generated bootstrap file
in two. `fill-plan.mjs`'s `buildDriverSource()` uses this for every value it
embeds.

**`assertAllowedTarget(url, { localOnly })` — where a browser may point.**

```js
const LOOPBACK = /^(localhost|127(\.\d+){1,3}|\[?::1\]?|0\.0\.0\.0)$/i
```

`isLocalUrl` returns `true` for any `file:` URL and for `http`/`https` URLs whose
hostname matches that pattern; a malformed URL returns `false`. `assertAllowedTarget`
throws unless the URL is local, unless `localOnly === false` was passed or
`AJ_BROWSER_ALLOW_REMOTE=1` is set. The header explains the intent:

> This build's runners and tests never touch a real employer's board, and that is
> enforced here rather than remembered: a fixture server on 127.0.0.1 passes, a
> real ATS host does not.

**`launchBrowser`** loads `playwright-core` with a dynamic `import()` inside
`loadChromium()`, so the dependency is optional at install time and a missing one
produces a useful message rather than a module-not-found. That message is
specific for a reason: `npm i -D playwright-core`, **not** `playwright`, whose
postinstall downloads about 150 MB of browsers on every CI leg.

With a `userDataDir` it uses `chromium.launchPersistentContext`, which is how a
logged-in ATS session survives between runs — "and why two processes must never
share one directory: Chromium takes an exclusive SingletonLock on it." Otherwise
it launches a fresh browser and makes a context. It then sets the default timeout,
takes the first page (or opens one), and returns a small session object whose
`goto()` runs `assertAllowedTarget` first and whose `close()` closes the context
and then the browser, each inside its own `try/catch`.

### F.5 What it reads and writes

**Reads:** `scripts/apply/fill-engine.mjs` and (via the re-exported
`readScannerSource`) `.claude/skills/apply-job/scan-page.js`, both as text; three
environment variables. **Writes:** nothing to disk. It creates browser processes
and, with `userDataDir`, a Chromium profile directory owned by the caller.

### F.6 Traps

1. **Paths come from `import.meta.url`, never `process.cwd()`.** From the
   comment: _"a scheduled task's working directory is not ours to assume."_
2. **`localOnly === undefined` means restrict.** The safe default is the one you
   get by forgetting.
3. **`assertAllowedTarget` guards `session.goto()` only.** A caller holding
   `session.page` can call `page.goto` directly and bypass it. It is a
   runner-level convention, not a sandbox. Do not describe it as one.
4. **Do not add a submit helper here.** The absence of a click verb in both
   engines is a structural safety property, not a rule someone remembers to
   follow: it is _a thing the engines cannot express_. The only clicks in
   `scripts/auto/` live in `submit.mjs` and `advance.mjs`, and
   `tests/auto/click-surface.test.mjs` keeps it at exactly those two.
5. **`playwright-core`, never `playwright`.**

> **Known defect (checked 2026-08-05).** `withBrowser(opts, fn)` is exported and
> **has no caller anywhere in the repository.** The only other occurrence of that
> name is a local variable in `tests/apply/bench-apply.test.mjs` that has nothing
> to do with it. The function itself is correct and its rationale is sound (an
> orphaned Chromium keeps the SingletonLock and blocks the next run) — but nothing
> uses it today, so every real caller repeats the `try/finally` by hand.

### F.7 Dependencies

**Imports:** `node:fs`, `node:path`, `node:url`, `./fill-engine.mjs`,
`./scan-engine.mjs`, and `playwright-core` lazily.

**Depended on by:** `scripts/apply/fill-plan.mjs`, `scripts/auto/auto-apply.mjs`,
and six test files.

---

## If you were rebuilding this

Three decisions carry almost all the weight. Getting any of them wrong the
obvious way produces something that works on your test page and fails silently on
a real board.

**1. Decide early where each piece of code runs, and never move data across that
line as code.** You need something inside the page (only page-side code can read
the DOM) and something outside it (only Playwright-side code can produce a click
React believes, or read a file). The naive design has the page-side half hand
work back to the outside half through a page global. That is the round-trip
remote-code-execution hole: a page you do not control gets to choose what runs
with a live browser handle. The rule that replaces it is one sentence — _values
that come back from the page are **data**, and are only ever read as data_ — and
it is worth writing into the code as a comment, because it is the kind of rule
that looks like paranoia until the day it does not.

Corollary: whatever gets into the page must get there in a way the page cannot
gate or intercept. That means CDP evaluation, not an injected `<script>` tag
(nonce CSP refuses those), and it means calling your scanner through a **local
binding**, not through `window.something` — otherwise a board that defines that
global first supplies your entire scan, including any flag your safety checks
depend on.

**2. Make every cut, every cap and every refusal say so.** Nearly every incident
recorded in these files has the same shape: something was silently shortened,
silently skipped, or silently substituted, and the failure looked exactly like
success. Forty options out of two hundred with nothing saying so. A "No results"
box read as the option list. A cover letter attached where the résumé should be,
reported as `ok=6 failed=0`. A required question that reached no list at all.
Design in the opposite direction: a scan says `optsTruncated`, a probe says
`probe_refused` with a reason, a skipped question pushes a `signal`, an unvouched
label carries `labelWhy`. The extra bytes are cheap. The naive version — return
what you found and say nothing about what you did not — produces a system whose
worst failures are invisible, and CLAUDE.md is right that this is a worse outcome
than an honest refusal.

**3. Prefer a structural rule to a word list, and when you must use a word list,
say in the code that it is one.** "Is this dropdown safe to click?" cannot be
answered by a list of dangerous words — the twenty-seventh rewording is free to
write and costs you a code change every time. It **can** be answered structurally:
_a picker takes its name from outside itself; a button's name is its own rendered
text._ The same pattern repeats all over these files: the button-pair detector
carries no name list; the widget sweep detects on focusability and state rather
than on a role list; the sentence-boundary rules reject a parenthetical and a
dotted initialism rather than enumerating abbreviations. Where a word list
survives, it is labelled as a backstop and nothing rests on it alone.

And a fourth, smaller one that is easy to get wrong: **wait for a condition with a
ceiling, never for a flat duration.** `waitFor({ state: "attached", timeout: 1500 })`
and `page.waitForTimeout(1500)` have the same worst case and completely different
average cost — the first is free on a page that hydrates in 200 ms, the second
taxes every application to cover the slowest one. The exceptions in this codebase
are deliberate, argued in comments, and rare.
