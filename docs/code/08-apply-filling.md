# Typing into the page

The scanner has read the form and the planner has decided what belongs in each
box. This document is about the step that actually happens in the browser: a
program taking a plan and putting your answers on a real employer's application
page — typing into text boxes, opening dropdowns and choosing rows, ticking
boxes, attaching your résumé — and then reading the page back to find out whether
any of that worked. That last half is the part most people leave out, and it is
the part this codebase has spent the most incidents learning. A fill that
_reports_ success is worthless; a fill that can _prove_ what landed is the only
kind worth sending an application on.

**What you will learn**

- How a program controls a real browser at all: what Playwright is, what a
  **locator** is, why an element is addressed by an attribute this pipeline
  stamped onto it rather than by "the third input on the page", and what people
  mean when they say "the page can change under you".
- The fill loop control type by control type — text, textarea, `<select>`,
  combobox/typeahead, radio, checkbox, file upload. For each one: how the value
  is set, how it is checked afterwards, and the specific ways each can go wrong.
- Why a fill is retried when the element goes stale, why Ashby rebuilds its form
  in the middle of a fill, and why the retry limit is exactly three.
- Uploads in full: why `setInputFiles` not throwing is **not** evidence that a
  file attached, what the DOM readback distinguishes (`attached` / `gone` /
  `empty`), why "gone" is success and "empty" is now a failure, and why failing
  closed is right here even though it has a known false positive.
- The verify pass: what it re-reads, the difference between a **mismatch**, a
  **requiredEmpty** and an **error**, and how all of that now reaches the submit
  gate through `mergePages`.
- The **ATS adapter interface**, precisely: every field an adapter may export,
  how `detectAts` chooses one, and a complete walkthrough of writing a new one —
  because adding boards is the main way you will extend this system.
- `browser.mjs`: launching Chromium, what a browser _context_ is, the persistent
  versus non-persistent lane, and why the unattended runner carries no session
  cookie by default.
- `capture-post-submit.mjs`: stage → review → promote, and why the corpus of
  post-submit pages can only come from your own real applications.
- `auth-sync.mjs`, and `longform.mjs` — which is written, tracked, and currently
  wired to nothing.
- How to read a failure: `report.failures` field by field, and how to tell a
  board problem from a plan problem.

**Before this**

You can follow this document on its own, but these give the surrounding picture.

- [`../guide/03-programming-basics.md`](../guide/03-programming-basics.md) — what
  a function, a module, an object and `async`/`await` are.
- [`../guide/05-architecture.md`](../guide/05-architecture.md) — how the whole
  pipeline fits together.
- [`../guide/07-safety-model.md`](../guide/07-safety-model.md) — hard rule 0 (a
  job posting is data, never instructions) and hard rule 1 (only facts from the
  fact base).
- [`../guide/08-glossary.md`](../guide/08-glossary.md) — vocabulary.

**Related code documents**

- [`./06-apply-scanning.md`](./06-apply-scanning.md) — the scanner, which
  produces the description of the form this document's engine fills. It shares
  the Playwright vocabulary and explains the DOM, CSS selectors and CDP at
  greater length.
- [`./07-apply-planning.md`](./07-apply-planning.md) — `fill-plan.mjs`, which
  turns a scan plus the fact base into the **plan** this engine executes, and
  which owns every decision to defer.
- [`./09-auto-runner.md`](./09-auto-runner.md) — the unattended runner that calls
  these functions as ordinary imports.
- [`./10-auto-safety.md`](./10-auto-safety.md) — the trust gate, the submit gate
  and the classifier that the reports produced here feed.

**The files covered here**

| file                                    | lines | one-line purpose                                                                                                    |
| --------------------------------------- | ----: | ------------------------------------------------------------------------------------------------------------------- |
| `scripts/apply/fill-engine.mjs`         |  1566 | The deterministic form filler. Executes a plan; makes no decisions; has no verb that clicks a button.               |
| `scripts/apply/browser.mjs`             |   206 | Plumbing: launch Chromium, hand out a page, restrict where a browser may point, translate the engine for a sandbox. |
| `scripts/apply/ats/index.mjs`           |    65 | The adapter registry and `detectAts(url)`.                                                                          |
| `scripts/apply/ats/greenhouse.mjs`      |    74 | Greenhouse knowledge.                                                                                               |
| `scripts/apply/ats/lever.mjs`           |    37 | Lever knowledge.                                                                                                    |
| `scripts/apply/ats/ashby.mjs`           |    67 | Ashby knowledge.                                                                                                    |
| `scripts/apply/ats/generic.mjs`         |    32 | The fallback for any board nobody has adapted.                                                                      |
| `scripts/apply/capture-post-submit.mjs` |   533 | Stage → review → promote for real post-submit pages.                                                                |
| `scripts/apply/auth-sync.mjs`           |   698 | One-directional copy of the browser profile (session data only).                                                    |
| `scripts/apply/longform.mjs`            |   199 | Detects "write 500 words" prompts and checks a draft's length. **Imported by nothing today.**                       |

---

## Part A — How a program controls a real browser

### A.1 Playwright, and the three objects it gives you

**Playwright** is a Node.js library that remote-controls a real Chromium browser
from outside it. Your program holds a handle to the browser and asks it to do
things; the browser does them for real, the same way it would if a person were
sitting at the keyboard. It is not a simulation of a browser and it is not an
HTTP client that fetches pages — it is Chrome, running, with your code as its
driver.

Three objects matter, and they nest:

| object      | what it is                                                                                                                                     | rough analogy                                         |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| **browser** | One running Chromium process.                                                                                                                  | The application in your dock.                         |
| **context** | An isolated profile inside that browser: its own cookies, its own `localStorage`, its own logged-in state. Contexts see nothing of each other. | An incognito window. Open two and they share nothing. |
| **page**    | One tab inside a context.                                                                                                                      | A tab.                                                |

The distinction between a browser and a context is the whole of Part G, so it is
worth fixing now: **cookies live on the context, not on the browser.** Two pages
in one context share your logged-in session. Two pages in two contexts do not.

Everything in `fill-engine.mjs` is a call on a `page`: `page.locator(...)`,
`page.keyboard.type(...)`, `page.evaluate(...)`, `page.waitForTimeout(...)`.

### A.2 Playwright-side and page-side

There are two places code can run, and almost every design decision in this area
follows from the difference.

| where               | runs in                        | can                                                                                                  | cannot                                                                                   |
| ------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| **Playwright-side** | your Node process              | hold the `page` handle, produce genuine mouse and keyboard input, read files off your disk, navigate | look at the page's contents directly — it has to ask the browser                         |
| **page-side**       | inside the web page, in Chrome | see the whole document, read every element's properties and computed styles                          | read your disk, import anything, touch the `page` handle, produce a click React believes |

The bridge between them is `page.evaluate(fn, arg)`. It does not send a live
function across a wire. It sends the **text** of `fn`, the browser compiles and
runs that text inside the page, and the **return value comes back as plain
data** — numbers, strings, arrays, plain objects. Never functions, never DOM
elements.

```js
// Playwright-side (Node)
const title = await page.evaluate(() => document.title)
// `title` is now an ordinary string, copied out of the page.
```

`fill-engine.mjs` is entirely Playwright-side. The only code that ever runs
page-side is the small inline arrow functions it hands to `page.evaluate` —
Playwright serialises those itself. Nothing is ever read back out of the page and
then executed.

> **Why that sentence is load-bearing.** An earlier version of this engine wrote
> its own source code into a page global called `window.__ajFillSrc`, read that
> value back into Node, and `eval`'d it Node-side, where the live `page` handle
> is. A job-application page is written by a third party. Any script on that page
> could have defined `__ajFillSrc` as a **getter** — a property that runs code
> when something reads it — and thereby chosen exactly what ran with a live
> browser handle: navigate, read everything typed so far, `setInputFiles` your
> `.env` file into its own form, click Submit. The header of `fill-engine.mjs`
> states the replacement rule plainly: values that come back from the page are
> **data** and are only ever read as data.

### A.3 A locator: a question, not a grabbed element

This is the single most useful idea in Part A, and it is where beginners get
bitten.

In plain browser JavaScript, `document.querySelector("#email")` hands you the
element object. You are now holding a specific thing. If the page rebuilds itself
and creates a new `#email` element, your variable still points at the old one —
which is no longer on the page, and setting its value changes nothing anybody can
see.

Playwright's **locator** is different. `page.locator("#email")` does not go and
find anything. It records the _question_ "the element matching `#email`", and
every operation on it — `.fill()`, `.click()`, `.count()` — re-asks that question
at the moment of the call.

```js
const loc = page.locator("#email") // nothing has happened yet
await loc.fill("a@b.example") // NOW the browser is asked: find #email, type into it
await loc.fill("c@d.example") // asked again, fresh — possibly a different element
```

A locator is therefore mostly immune to the page changing between when you build
it and when you use it. Mostly, not entirely: if the page changes _during_ one
call — after the element is found but before the typing lands — Playwright
raises the error `"Element is not attached to the DOM"`. Section A.5 and Part C.9
are about that gap.

The engine's `locate` helper builds locators and insists on uniqueness:

```js
const locate = async (item) => {
  const cands = []
  if (item.sel) cands.push(item.sel)
  if (item.k) cands.push('[data-aj="' + item.k + '"]')
  for (const sel of cands) {
    try {
      const loc = page.locator(sel)
      if ((await loc.count()) === 1) return loc
    } catch {}
  }
  return null
}
```

`count() === 1` is not fussiness. A selector matching two elements would let the
engine type your phone number into whichever the browser happened to list first.
A selector matching zero is a field that is not there. Both are failures with the
message `no unique element for <selector>`, and neither is guessed at.

### A.4 Why an element is addressed by a stamped attribute

When the scanner walks the form (see
[`./06-apply-scanning.md`](./06-apply-scanning.md)) it writes an attribute onto
every control it collects: `data-aj="f7"`, `data-aj="b3"`. A `data-` attribute is
an ordinary HTML attribute reserved for an application's own use — the browser
ignores it, and CSS can select on it: `[data-aj="f7"]`.

Why stamp at all, rather than saying "the seventh input"?

- **Position is not identity.** A form that renders an extra "if yes, explain"
  box, or hides an EEO block, shifts every position after it. Answers would land
  one field over, silently.
- **Labels are not unique.** Greenhouse labels both of its attachment inputs
  "Attach". Two fields called "Location" appear on plenty of forms.
- **The stamp survives the round trip.** The scan is written to a file, a plan is
  built from it minutes later, and the plan has to name the same elements the
  scan saw. A short key that is physically on the element does that.

But a stamp has one fatal weakness, and the engine is built around it: **a
`data-aj` attribute is written into the live DOM, and a React remount throws the
DOM away and builds a new one.** The stamps do not come back. That is why
`locate` tries `item.sel` **first**:

- `item.sel` is a **stable, app-owned selector** the scanner derived from the
  page's own markup — `#first_name`, `input[name="email"]`, `[data-testid="phone"]`.
  The employer's own code puts those back after a remount, because they are part
  of how the employer's own code addresses its form.
- `[data-aj="f7"]` is _ours_, and it is only valid until something rebuilds the
  page.

So: **`sel` first, `data-aj` as the fallback.** The scanner works hard to produce
a `sel` for every field precisely so the fill has something durable to aim at.

### A.5 "The page can change under you"

A modern application form is not a static document. It is a program — usually a
React program — that draws the form and redraws it whenever its internal state
changes. Four flavours of change matter here:

1. **Hydration.** The server sends HTML; the JavaScript then takes over and
   replaces or re-binds it. Until that finishes, the page you can see is not the
   page that will accept input. (The scanner waits for a button to exist before
   trusting a scan, for exactly this reason.)
2. **A remount.** React decides a chunk of the form must be rebuilt, discards
   those DOM nodes and creates fresh ones. Everything about the old nodes goes
   with them, including our `data-aj` stamps. **Uploading a file remounts the
   form on every board this pipeline has measured** — the file input is swapped
   out for an "attached file" view.
3. **An asynchronous remount.** Ashby's resume-autofill reads the PDF you just
   uploaded, extracts your name, email and work history, and _then_ rebuilds the
   form to show what it found. That arrives long after the upload itself
   finished — well after any settle delay the engine waited out — and it can land
   in the middle of the very next field's fill.
4. **A timed remount.** A component library's autosave that re-renders on an
   interval. `tests/fixtures/hostile/forms/remount-mid-fill.html` models one at
   400 ms. No number of retries wins against that, because there is nothing to
   wait for.

The concrete consequence, and it is worth memorising: **a value can land
correctly on the page while the call that set it still throws.** Playwright found
the element, began the action, the element was destroyed mid-flight, and
Playwright reports "not attached" — but React's own re-render may well have
carried the typed value into the new element. An engine that treats every throw
as a failure will report failures for fields that are correctly filled. An engine
that ignores throws will report successes for fields that are empty. The way out
is not cleverer error handling; it is **to go and look at the page afterwards**,
which is what the verify pass in Part E does.

### A.6 What the engine is not allowed to be

Two constraints shape every line of `fill-engine.mjs`, and both look strange
until you know why.

**Constraint 1 — it must be able to run as a plain string in a stripped-down
sandbox.** On the attended path, the agent drives the browser through the
Playwright MCP tool, whose JavaScript sandbox has `page` and the standard
built-ins and nothing else: no `require`, no working `import`, no `fs`, no
`setTimeout`, no `console`. `fill-plan.mjs` therefore reads this file's **text**
off disk and embeds it as a string constant in the generated
`jobs/<slug>/fill-plan.js`, which the sandbox `eval`s.

That is why `fill-engine.mjs` **imports nothing**, closes over nothing, and
refers to nothing it does not define itself. `browser.mjs`'s
`engineSandboxSource()` enforces it mechanically:

```js
const DEFAULT_EXPORT =
  /^export default\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/m
```

It requires a named default-exported function declaration, strips
`export default`, appends the function's name so that `eval`'s result **is** the
function, and throws if any line in the file looks like `import `, `export ` or
`import(`. Break that rule and you get a module that compiles fine in Node and
throws only in the browser, only in production. `tests/apply/fill-page.test.mjs`
pins all of it.

It is also why the file uses `page.waitForTimeout(...)` rather than `setTimeout`,
and why every locator call passes an explicit timeout: the sandbox sets no
default action timeout, so Playwright's stock 30 seconds would otherwise apply to
a call that should give up in 2.5.

**Constraint 2 — it must not be able to submit anything.** From the header:

> `// SAFETY: there is deliberately no verb that clicks a button. "Never click
submit" is not a rule this engine follows — it is a thing it cannot express.`

Be precise about what that means, because the engine _does_ click. It clicks a
dropdown control to open it, and it clicks an option row to choose it. What it
has no way to express is "click that button". Two mechanisms keep it that way:

- The verb table has no entry that takes a button. The verbs are `fill`,
  `select`, `check`, `type`, `combo`, `upload`, `skip`, and anything else throws
  `unknown verb <how>`.
- `kindOf` inspects the element before any action and refuses anything that is
  not a form control:

```js
if (tag === "input" || tag === "textarea" || tag === "select") return tag
if (el.isContentEditable) return "richtext"
// …combobox shapes…
return "forbidden:" + tag
```

A plan item aimed at a `<button>` produces
`refusing to touch a <button> — not a form control`. So even a plan that had been
tampered with cannot make this file press Submit. Submitting lives in
`scripts/auto/submit.mjs` and advancing a page lives in `scripts/auto/advance.mjs`
— two files, pinned by `tests/auto/click-surface.test.mjs`.

---

## Part B — The plan, the guards and the report

### B.1 What the engine is handed

```js
export default async function fillPage(page, plan)
```

Two arguments: a live Playwright page, and a plan built by `fill-plan.mjs`. The
engine reads exactly five keys off the plan.

| key                    | shape      | meaning                                                            |
| ---------------------- | ---------- | ------------------------------------------------------------------ |
| `plan.items`           | array      | what to do, one entry per control                                  |
| `plan.defer`           | array      | fields the planner refused to fill; copied through into the report |
| `plan.urlGuard`        | string     | the URL the plan was built against                                 |
| `plan.pageGuard`       | `string[]` | selectors that must each match exactly one element                 |
| `plan.comboStrategies` | `string[]` | the order to try dropdown strategies for this board                |

One item looks like this:

```js
{
  k: "f3",                    // the scanner's stamp
  sel: "#first_name",         // the stable, app-owned selector (preferred)
  how: "fill",                // the verb
  value: "Alex",              // what to put there
  label: "First Name",        // for the report a human reads
  req: true
}
```

An upload item carries `paths` (absolute paths to files on our own disk) and
`labelMatch` (a regular-expression **source string**, not a live RegExp, because
the plan is JSON) instead of `value`.

The verbs, and which scanner field type produces each (the mapping lives in
`VERB` in `scripts/apply/fill-plan.mjs`):

| scan type `t`                                                         | verb     | what the engine does                    |
| --------------------------------------------------------------------- | -------- | --------------------------------------- |
| `text`, `email`, `tel`, `url`, `number`, `date`, `search`, `textarea` | `fill`   | `loc.fill(value)`                       |
| `select`                                                              | `select` | `loc.selectOption({ label: value })`    |
| `combo`                                                               | `combo`  | the strategy ladder in Part C.7         |
| `checkbox`, `radio`                                                   | `check`  | `loc.check()` / `loc.uncheck()`         |
| `richtext`                                                            | `type`   | the three-rung ladder in Part C.6       |
| `file`                                                                | `upload` | `setInputFiles`, then the readback      |
| —                                                                     | `skip`   | nothing; carried so the report says why |

### B.2 The three guards, in the order they run

**Guard 1 — the URL guard.** The very first thing the engine does:

```js
const bare = (u) => String(u || "").split("#")[0].split("?")[0]
if (plan.urlGuard && bare(plan.urlGuard) !== bare(page.url())) { … }
```

Fragments (`#section`) and query strings (`?utm_source=…`) are stripped before
comparing, because those change without the form changing. A mismatch produces
one failure — `{ k: "-", how: "guard", why: "plan built for X but page is Y" }` —
and the function returns immediately, having touched nothing. A plan is built
against one specific form; running it on a different page would put your answers
in whatever fields happened to match.

**Guard 2 — the page guard.** A URL comparison cannot tell page 2 of a multi-step
form from page 1 when both live at the same URL. (The Greenhouse replica under
`tests/fixtures/boards/` is exactly that: one GET/POST pair on a single path.)
So the planner may supply `plan.pageGuard`, a list of selectors that must each
match **exactly one** element for this plan to belong to this page. Any count
other than 1 refuses the whole fill:

```
this plan expects <selector> on the page and found 0 — the form is not the one the plan was built for
```

This guard is absent by default. Nothing is asserted when the planner does not
supply it.

**Guard 3 — the floor.** After resolving every non-upload item once (the
"pre-flight" pass), if there are targets and **not one of them resolved**, the
engine refuses with:

```
not one of the plan's 14 fields exists on this page — same URL, different form
(a multi-step form on one URL does this); re-scan before filling
```

Each field would have failed individually anyway; what this buys is one clear
sentence instead of fourteen indistinguishable "no unique element" lines. Its
limit is stated in the code rather than hidden: it cannot catch a page 2 that
_reuses_ page 1's selectors. A shared `input[name=email]` defeats it. Only guard
2 catches that, and only when the planner supplies it.

### B.3 The report

Everything downstream reads this object. Learning its shape is learning what the
system can and cannot know about a fill.

```js
{
  ok: 6,                 // COUNT of items that succeeded
  failed: 1,             // COUNT of failures
  deferred: 2,           // plan.defer.length, copied through
  ms: 2754,              // wall time of the whole fill
  url: "https://…",
  failures: [ { k, how, why, stale? } ],
  verify: { mismatch: [], errors: [], requiredEmpty: [], landed: [], revealed: [] },
  defer: [ … ],          // plan.defer, verbatim
  next: { btn: "b3", label: "Submit application", role: "submit" } | null,
  signals: [ … ],        // whatever the end-of-run scan reported
  revealed: [ … ],       // required + empty + never in the plan
  reconciled: [ … ],     // stale failures the verify pass overturned
  uploads: [ { k, tag, file, match, how, target, free?, attached, settled?, seen?, seenFile? } ],
  comboVia: { f9: "type-click" },   // which strategy worked, per field
  comboStrategy: "type-click"       // the board-level winner
}
```

Two rules about reading it, both written into the code as comments because both
were paid for:

**`ok` is a count, and a count cannot be wrong about which file went where.** The
engine's own comment:

> "a count cannot say that the cover letter was attached on top of the resume —
> which is exactly what happened, was reported as `ok=6 failed=0`, and reached
> the approval message as 'both files attached'. Anything that tells the user
> what was attached must read THIS [`uploads`], not `ok`."

**`verify.landed` carries keys, not values, on purpose.** Every value in the plan
came out of `profile/profile.yaml` or `profile/answers.yaml`. The fill report is
what the unattended runner appends to `jobs/.auto/runs/<runid>.jsonl`, which is
durable and append-only. A run log full of your answers is the same exposure as
copying `profile/` with extra steps. A caller that holds the plan can join keys
to values itself; the log does not have to carry them.

---

## Part C — The fill loop, control type by control type

The engine does uploads first, then everything else, then verifies once. This
part covers "everything else"; uploads get Part D.

### C.1 The shared preamble: `actOn`

Every non-upload item goes through one function, so the retry in C.9 can replay
the identical sequence against a freshly re-resolved locator:

```js
const actOn = async (loc, item) => {
  let kind
  try {
    kind = await kindOf(loc)
  } catch (e) {
    throw new Error("unreadable element: " + e.message)
  }
  if (String(kind).startsWith("forbidden:"))
    throw new Error("refusing to touch a <…> — not a form control")
  await loc.scrollIntoViewIfNeeded({ timeout: 2500 })
  // …verb dispatch…
}
```

Three things happen before any verb runs:

1. **`kindOf`** asks the page what this element actually is. It answers with the
   tag name for `input`/`textarea`/`select`, `"richtext"` for anything
   contenteditable, `"combo"` for the combobox shapes, and `"forbidden:<tag>"`
   for everything else.
2. **The refusal** turns `forbidden:` into a thrown error. This is what makes the
   scanner's `widget: "buttons"` marker honest: a row of `<button>`s that the
   scanner recognised as a question but that reached `items` as `how: "check"`
   would be an instruction the engine _cannot_ carry out, and it says so rather
   than doing something approximate.
3. **`scrollIntoViewIfNeeded`** — Playwright refuses to interact with an element
   that is not in view, so this brings it there. It is **not** wrapped in a
   `catch` here: if it times out, the item fails. (The scanner's dropdown probe
   deliberately does the opposite and swallows the same error; the reasoning is
   in [`./06-apply-scanning.md`](./06-apply-scanning.md).)

A small, honest note on the combobox test: `kindOf` recognises
`role="combobox"`, `aria-haspopup="listbox"` and a `select__control` class, while
the readback helper `shownValue` recognises those **plus**
`aria-autocomplete="list"`. In practice the difference is small — an
`<input aria-autocomplete="list">` still passes `kindOf` as `input` because the
tag check comes first — but the two lists are not literally identical, whatever
the comment beside them says.

### C.2 Text boxes and email/tel/url/number/date (`fill`)

**How it is set.**

```js
await loc.fill(String(item.value), { timeout: 2500 })
```

`locator.fill()` is one CDP call. It focuses the element, clears it, sets the
value, and dispatches the `input` and `change` events that a framework listens
for. Cost does not grow with the length of the text.

**How it is verified.** Not immediately — the verify pass at the end reads it
back (Part E). This matters: a fill that Playwright accepted is not yet evidence.

**What goes wrong.**

- **A React "controlled input" ignores a value that was not set the way React
  expects.** This is why the engine never fakes events by hand. The header
  records the measurement: `dispatchEvent(new MouseEvent(...))` "does NOT
  register in React state; the value appears on screen and the field still
  validates as empty." Everything must be a genuine Playwright input event.
- **A masked or formatted field rewrites what you typed.** A phone field that
  turns `7025551234` into `(702) 555-1234` will not read back equal to the
  planned value. The verify pass's comparison allows containment, which covers
  most of these; a field that reformats more aggressively shows up as a
  `mismatch`, which blocks an unattended submit and is exactly the right outcome.
- **The field is `readonly` or `disabled`.** Playwright waits for it to become
  editable and then times out: `locator.fill: Timeout 2500ms exceeded`.

**Worked example.**

```js
{ k: "f1", sel: "#first_name", how: "fill", value: "Alex", label: "First Name" }
```

→ locator resolves `#first_name` (count 1) → `kindOf` returns `"input"` →
scrolled into view → `fill("Alex")` → `out.ok++`. Later, the verify pass reads
`#first_name` and finds `"Alex"`, so `f1` goes into `verify.landed`.

### C.3 Textareas (`fill`)

A `<textarea>` takes the same `fill` verb and behaves identically — one CDP call
regardless of length. A 3,000-character cover letter costs the same as a
postcode.

The interesting case is the box that _looks_ like a textarea and is not: a
rich-text editor built out of a `contenteditable` `<div>`. The scanner types
those as `richtext`, and they get the `type` verb instead (C.6).

### C.4 Native dropdowns — `<select>` (`select`)

**How it is set.**

```js
await loc.selectOption({ label: String(item.value) }, { timeout: 2500 })
```

Note `{ label: … }`. An HTML option has two strings:

```html
<option value="us">United States</option>
```

`value` is what gets submitted; the label is what a human reads. The engine
selects by **label**, because the plan's value came from matching your answer
against the option text the scanner read off the page — which is the label. If
you ever build a plan whose value is the `value` attribute, this call will not
find it.

**How it is verified.** The verify pass reads `el.value` — which is the option's
`value` attribute, not its label. So a `<select>` whose value and label differ
(`us` versus `United States`) will read back as a **mismatch** even when the
selection is correct. That is a real, if benign, source of noise: it costs a
deferral rather than a wrong answer, which is the direction this codebase
consistently chooses.

**What goes wrong.** `selectOption` throws when no option carries that label,
which is the honest outcome — the answer the fact base holds is not one this form
offers.

### C.5 Checkboxes and radio buttons (`check`)

**How it is set.**

```js
const on = item.value === false || item.value === "false" ? false : true
if (on) await loc.check({ timeout: 2500 })
else await loc.uncheck({ timeout: 2500 })
```

`check()` is idempotent: if the box is already ticked, it does nothing and
succeeds. That property is what makes the retry in C.9 safe.

**How it is verified.** The verify pass reads `el.checked` and renders it as the
string `"true"` or `""`, so a ticked box "holds the value true".

**What goes wrong, and the rule around it.** Almost every problem with these
controls is decided _before_ the engine sees them, in the planner. A checkbox or
radio group carries **assent** rather than a value: ticking "I agree to binding
arbitration" is an act you perform, not a fact retrieved from a file. The rules
in `CLAUDE.md` are specific:

- On the **unattended** path, a checkbox or radio group **never** auto-acts,
  whatever its answer class. The planner defers it and the submit gate refuses.
- On the **user-directed** path (you hand the agent a URL), consent tickboxes and
  `confirm-widget` controls **may** be actuated — and every one that is must be
  named in the report with its label quoted.
- Arbitration agreements and "I personally completed this application"
  certifications are a hard stop on both paths.

The engine has no opinion about any of this. If a `check` item reaches it, the
decision has already been made and recorded. If you are wondering why a consent
box was not ticked, the answer is in
[`./07-apply-planning.md`](./07-apply-planning.md), not here.

A specific trap worth knowing: a component library's
`<div role="checkbox" aria-checked="false">` is not a real checkbox. It has no
`checked` property, it fails `kindOf` (`forbidden:div`), and the scanner types it
as a widget so that it defers. The verify pass's sweep reads `aria-checked`
**first and for any tag**, precisely so that such a control is not reported as
filled because its `innerText` happened to be non-empty.

### C.6 Rich text: the three-rung ladder (`type`)

A `contenteditable` editor may ignore `fill()` entirely. The engine tries three
ways, fastest first, and **checks after each rung** rather than assuming.

```js
const TYPE_MAX = 800
const typeInto = async (loc, text) => {
  try {
    await loc.fill(text, { timeout: 2500 })
    if (await landed(loc, text)) return
  } catch (e) {
    if (isStaleError(e)) throw e
  }
  await loc.click({ timeout: 2500 })
  try {
    await page.keyboard.insertText(text)
    if (await landed(loc, text)) return
  } catch (e) {
    if (isStaleError(e)) throw e
  }
  await page.keyboard.type(text.slice(0, TYPE_MAX), { delay: 15 })
  if (text.length > TYPE_MAX)
    throw new Error("typed the first 800 of N characters — …")
}
```

| rung | call                    | cost                    | why it might be the one that works                                                                                               |
| ---- | ----------------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 1    | `loc.fill(text)`        | one CDP call            | Playwright accepts `[contenteditable]` as well as inputs.                                                                        |
| 2    | `keyboard.insertText()` | one CDP call            | This is what a **paste** looks like to React — an `input` event with no keydown. An editor that ignores rung 1 often takes this. |
| 3    | `keyboard.type()`       | 15 ms **per character** | Genuine per-key events. The only thing some editors believe.                                                                     |

`landed()` re-reads the element and asks whether the first 40 normalised
characters of the text are present. A rung the widget silently ignored therefore
falls through to the next one instead of leaving the box empty and reporting
success.

**Why rung 3 is capped at 800 characters.** It used to be uncapped: a
3,000-character cover letter was **45 seconds inside one call**. And a cap that
silently truncates is worse than slow — so exceeding it **throws**, with a
message written for a person to act on:

```
typed the first 800 of 3120 characters — this box takes neither fill() nor
insertText, so finish it by hand
```

That becomes a fill failure, which blocks an unattended submit and appears in the
report you read. It is not left for you to discover on a sent application.

### C.7 Comboboxes and typeaheads (`combo`) — the hardest control on any form

A "combobox" here means a custom dropdown built out of `<div>`s and an
`<input>` — react-select and its many imitators. It is the control that has
caused the most incidents in this codebase, and the reasons are worth
understanding in order.

#### C.7.1 The three strategies

```js
const strategies = {
  "type-enter": async (loc, value) => {
    await openCombo(loc)
    await page.keyboard.type(String(value).slice(0, 60), { delay: 20 })
    await page.waitForTimeout(500)
    await page.keyboard.press("Enter")
  },
  "type-click": async (loc, value) => {
    await openCombo(loc)
    await page.keyboard.type(String(value).slice(0, 40), { delay: 20 })
    const row = await optionLocator(loc, value)
    await row.waitFor({ state: "attached", timeout: 500 }).catch(() => {})
    await row.click({ timeout: 2500 })
  },
  "click-option": async (loc, value) => {
    await openCombo(loc)
    const row = await optionLocator(loc, value)
    await row.click({ timeout: 2500 })
  },
}
```

`openCombo` scrolls the control into view (swallowing a failure), clicks it, and
waits 220 ms for the menu to appear.

| strategy       | what it does                                           | when it is the right first choice                          |
| -------------- | ------------------------------------------------------ | ---------------------------------------------------------- |
| `type-enter`   | filter the list, then commit the highlighted row       | lists that filter as you type and highlight the best match |
| `type-click`   | filter, then click the row whose text **is** the value | when Enter would commit a near-match                       |
| `click-option` | open and click the row directly                        | short lists that do not filter at all                      |

The order comes from the ATS adapter (Part F). `setCombo` walks it, and after
each attempt reads the committed value back and tests it. On failure it presses
Escape, waits 120 ms so the menu is shut, and tries the next strategy. If none
worked, the item fails with the last reason — for example
`after type-enter the field reads ""`.

**The 500 ms inside `type-enter` is not removable, and the reason generalises.**
The condition it stands for is "the list has finished narrowing", and the DOM
does not expose that. Options are attached the moment the menu opens, _before_
any filtering — so waiting on "an option exists" would press Enter against the
unfiltered list and commit whatever row happens to be highlighted. The comment
concludes: "A wrong dropdown value on a submitted application is not worth
400ms." `type-click`'s 500 ms is a different thing: it is a **ceiling on a
precise condition** (the row whose text is the value now exists), so a list that
filters in 80 ms costs 80 ms.

#### C.7.2 Reading a combobox back: the value is not in the box

This is the most important paragraph in Part C.

**Measured on Affirm's Greenhouse form, 2026-08-04.** All ten dropdowns were
reported `verify.landed`, `comboVia: type-enter`, zero failures. Every backing
input was still **empty**, and the page itself rendered "This field is required."
The application could not have been submitted, and nothing in the run said so.

The cause: reading `el.value` off a `role="combobox"` input reads back **the
string we just typed**. The visible input of such a widget is a **search
filter**, not the answer. A readback that can be satisfied by the act of typing
is not a readback.

`shownValue(loc)` therefore looks for the widget's **committed store** — the
place the form will actually read from when it submits. It walks the element
itself plus up to four ancestors, and stops early at `<form>`, `<body>`, `<html>`,
or at any container holding more than one combobox. Within that scope, in order:

1. **A rendered selection node** — `[class*='single-value']`,
   `[class*='singleValue']`. react-select clears its search input on a successful
   commit, so the box is empty and only this node holds the choice. Checking the
   input first would read `""` and fail a fill that worked.
2. **A non-visible `<input>` or `<select>` in the same wrapper.** That is a
   backing store, and it is what gets submitted. Visible inputs are excluded
   deliberately: a neighbouring visible textbox belongs to a different question
   (a phone widget's number sits beside its country picker), and reading one
   would answer this field from another's value.
3. **Nothing found** → fall through to `el.value` / `innerText`. That is the
   right reading for a plain typeahead that commits into its own box, which is
   what Ashby's Location control is.

Two details in there are each a separate fix:

**"Not painted" is wider than `display:none`.** Greenhouse's required store is a
real, laid-out text input rendered with `opacity:0; pointer-events:none;
position:absolute` and about 3 pixels of width. Every obvious visibility test
says it is visible. So `unpainted(n)` counts `type=hidden`, a box under 5×5,
`visibility:hidden`, `display:none`, `opacity:0` — **and also
`pointer-events:none`**, which is the one that had to be added.

**An empty store is still a store.** Once a store has been found it is the
authority whether or not it holds anything:

```js
if (sawStore) return ""
```

Returning only non-empty findings, and otherwise falling through to `el.value`,
reproduces the original defect exactly — an uncommitted widget has an empty
store, falls through, and answers with the filter text again. "This widget has
somewhere to put an answer and there is nothing in it" is precisely the
observation that was missing.

And the container bound is load-bearing in the other direction: without it the
walk reaches the `<form>`, where every other question's hidden store is in scope,
so a plain typeahead with no store of its own "finds" a neighbour's, reads it
empty, and a fill that worked is reported failed.

#### C.7.3 Blurring first

```js
const committedValue = async (loc) => {
  try {
    await loc.evaluate((el) => el.blur && el.blur())
    await page.waitForTimeout(150)
  } catch (e) {
    if (isStaleError(e)) throw e
  }
  return await shownValue(loc)
}
```

**Measured on Oracle Recruiting Cloud, 2026-08-04.** There, the visible input is
a filter and the widget reverts to empty the moment focus leaves it. Reading
straight after typing therefore read back what we typed, the check passed, the
strategy was recorded as working — and the application was submitted with three
required pickers empty while the run reported every one filled.

Blurring separates "the widget accepted this" from "the box is showing what I
typed": a widget that committed keeps its value, one that did not reverts. It
costs one CDP call and 150 ms per attempt, and it leaves the menu shut before the
next strategy runs. It is necessary but **not sufficient** — a widget that leaves
its filter text sitting in the box defeats it completely, which is why C.7.2's
store lookup exists as well.

#### C.7.4 Picking the right row

**Two defects, measured on a real Oracle Recruiting Cloud application, that
together put a materially false claim on a submitted form: "Veteran Status" ended
up holding "Protected Veteran".**

1. **The match was a substring.** Playwright's `filter({ hasText: value })` means
   _contains_. On a list reading

   ```
   I am not a protected veteran
   Protected Veteran
   I do not wish to identify my protected veteran status
   ```

   more than one row matches almost anything, and `.first()` picks whichever the
   board rendered first. These are three different statements and two of them are
   untrue. A near-miss on a dropdown is not a near-miss in meaning.

2. **The search was page-wide.** Every open menu, every closed-but-attached menu,
   and the phone country-code widget were all in scope, so a row belonging to a
   different question could win.

The fixes:

```js
const exactRe = (value) =>
  new RegExp("^\\s*" + rxEsc(norm(value)).replace(/ /g, "\\s+") + "\\s*$", "i")
```

Whole-string, whitespace-tolerant, case-insensitive. Case is the one liberty
taken, because boards routinely upper-case option text in CSS and in markup, and
no two options on a real list differ only by case.

`menuScope(loc)` reads the control's `aria-controls` attribute — the page's own
statement of "this is my menu" — **at fill time** rather than carrying it through
the plan, so it works on a cached scan too. When the control names a menu, the
search is scoped to it. When it names none:

```js
const rowSel = named
  ? "[class*='__option'], [role='option']"
  : "[class*='__option']:visible, [role='option']:visible"
```

`:visible` is a Playwright pseudo-class (not real CSS) meaning "has a non-empty
bounding box". It is there because Affirm's page holds exactly **one**
`[role=listbox]` at all times: the phone widget's country list, 244 rows,
permanently attached and usually hidden. An unfiltered page-wide search answers
every unnamed dropdown out of a list of countries — which is how "Afghanistan+93"
became the first candidate row for a question about pronouns.

#### C.7.5 Accepting an answer

```js
const accepts = (got, want) => {
  const g = norm(got),
    w = norm(want)
  if (!g || !w) return false
  if (g === w) return true
  return g.startsWith(w) && /[\s(,\-:/]/.test(g.charAt(w.length))
}
```

This used to be `got.includes(want)`, which accepts any superstring in any
position — so "Protected Veteran" satisfied a request for "Veteran". Containment
existed for the genuine case where a widget renders a fuller form of what was
asked for ("United States" → "United States of America"). A **prefix at a word
boundary** keeps exactly that case and drops the rest: an option that merely
mentions the words later in its text is a different option.

| `want`          | `got`                      | accepted? | why                          |
| --------------- | -------------------------- | --------- | ---------------------------- |
| `United States` | `United States`            | yes       | equal                        |
| `United States` | `United States of America` | yes       | prefix, next char is a space |
| `Veteran`       | `Protected Veteran`        | **no**    | not a prefix                 |
| `Yes`           | `Yes, with restrictions`   | yes       | prefix, next char is a comma |
| `No`            | `Not currently`            | **no**    | prefix, but next char is `t` |

#### C.7.6 What the run learns

When a strategy works, the engine records it:

```js
if (r.via) out.comboVia[item.k] = r.via
```

and afterwards picks the strategy that won for the most combos on this form as
`out.comboStrategy` (ties go to whichever won first, so the answer does not
depend on object key order). `field-cache.mjs`'s `recordVia` persists both, and
`fill-plan.mjs` reorders the next plan's `comboStrategies` to put the board's
known winner first. That is worth real money: a strategy that does not work still
costs 1.5–2.5 seconds before it is ruled out, and rediscovering it per field per
application is the most expensive avoidable thing in the fill.

### C.8 The typeahead special case

Ashby's Location control renders as an `<input role="combobox">` whose list is
built from a **server query** as you type. Opened with no query it renders "No
results" and declares no `[role=option]` at all — so the scanner correctly
records zero options. There is no list to enumerate, now or ever.

Before 2026-08-06 that field resolved `NEEDS-CHOICE` with "field was not probed",
and a human typed the value by hand on every single application. The Ashby
adapter now declares the shape:

```js
typeaheadFields: [{ match: /^\s*location\s*\**\s*$/i }],
```

and `fill-plan.mjs` promotes such a field to a normal item — but only when
**all** of these hold: the adapter names it, no options were recorded, the status
is `NEEDS-CHOICE` (never `UNKNOWN`), and the value came from an approved source
(a profile fact or a banked answer). The engine then treats it as an ordinary
combo item: type the value, and `shownValue` falls through to `el.value` because
there is no store. If the widget does not commit, the verify pass reports a
mismatch and the submit is blocked. Nothing here is taken on trust.

This is worth pausing on, because it is the shape of every legitimate way to make
this system defer less. `CLAUDE.md` rule 6 permits exactly three: an **adapter**
that knows a board's shape, a **probed option list** read off the live form, or a
**banked answer** you approved. Never a model reading the field and deciding.

### C.9 The stale-locator retry

```js
const isStaleError = (e) =>
  /not attached to the dom/i.test(String((e && e.message) || e))

const STALE_ATTEMPTS = 3
let loc = first
let lastErr = null
for (let attempt = 1; attempt <= STALE_ATTEMPTS; attempt++) {
  try {
    await actOn(loc, item)
    lastErr = null
    break
  } catch (e) {
    lastErr = e
    if (!isStaleError(e) || attempt === STALE_ATTEMPTS) break
    await page.waitForTimeout(150 * attempt) // 150 ms, then 300 ms
    const again = await locate(item)
    if (!again) {
      lastErr = new Error("no unique element for … after a stale-locator retry")
      break
    }
    loc = again
  }
}
if (!lastErr) out.ok++
else fail(item, lastErr.message, isStaleError(lastErr))
```

Five things to get right about this:

1. **Only a stale error is retried.** A refused element, an unknown verb, a combo
   that never took the value — none of those are retried. A genuine failure still
   reaches `fail()` rather than being retried forever.
2. **Replay is safe because the verbs are idempotent.** `fill`, `select` and
   `check` each set a state; doing it twice is the same as doing it once. This is
   what licenses the whole mechanism.
3. **Three attempts, and the number is argued rather than picked.** One replay
   absorbs Ashby's single asynchronous remount and nothing more. A form that
   remounts on a timer detaches the replay too, so a single retry would report a
   failure for a value that in fact landed. Each attempt costs one re-resolve and
   the backoff grows.
4. **The staleness flag travels on the failure record** (`stale: true`), because
   the verify pass can overturn exactly that kind of failure and no other. A
   detached element means the call could not be **completed**, not that the value
   is absent.
5. **The rungs of the long-text ladder rethrow staleness rather than swallowing
   it**, so a remount during rung 2 still reaches this loop and replays the whole
   item.

**Why Ashby specifically.** Ashby's resume-autofill parses the PDF you uploaded
and rebuilds the form to show the fields it extracted. That happens
asynchronously, after the upload's own settle wait has already completed, so it
lands squarely in the middle of the next few fills. Playwright reports it on
whichever call was in flight — `kindOf`'s evaluate, `scrollIntoViewIfNeeded`, or
the fill itself. The remount is not a bug on Ashby's side; it is a feature that
happens to be hostile to automation.

**And the case retries cannot fix.** When every attempt detached, the answer is
not decided here at all. It is handed to the verify pass, which reads the DOM in
**one** `page.evaluate` — one turn of the page's event loop — so it cannot be
raced by a remount the way a locator handle can. Part E.5.

---

## Part D — Uploads and the readback

### D.1 Uploads go first

The upload loop runs before every other item. The reason is mechanical: attaching
a file remounts the form, and a remount destroys every `data-aj` stamp on the
page — including the stamp for the second upload. Doing uploads last would
corrupt everything already filled.

### D.2 `setInputFiles`, not the file chooser

```js
await page
  .locator('[data-ajup="' + tag + '"]')
  .setInputFiles(item.paths, { timeout: 5000 })
```

A file input can be driven two ways. The realistic one is to click it, wait for
the operating system's file-chooser dialog, and answer it. The engine does **not**
do that, for a specific reason: Playwright MCP installs its own `filechooser`
handler, so a `page.waitForEvent("filechooser")` inside the engine never fires —
it stalls the whole call as a pending modal.

`setInputFiles` instead attaches the file directly to the input and dispatches
the `change` event. Verified on Greenhouse that React does process it: the input
is swapped out for the attached-file view. Do not "fix" this into a real chooser.

### D.3 Routing: which file goes to which input

**The measured bug**, on the Greenhouse fixture where both attachment inputs sit
in one `<form>`:

```
[ { id: 'resume',       ajup: 'u2', files: ['cover-letter.pdf'] },
  { id: 'cover_letter', ajup: null, files: []                   } ]
report ok=6 failed=0 failures=[]
```

The cover letter went out **as the résumé**, no cover letter was attached at all,
and every control downstream — including the approval message read before pressing
Submit — was told the fill succeeded.

Three separate defects produced that, and each fix alone would have been enough.

**1. A shared container discriminates nothing.** The old walk climbed up to eight
ancestors and took the first input whose ancestor text matched. `/cover letter/`
matched the `<form>` that wraps **both** inputs — its `innerText` reads
"… Resume Attach Cover Letter Attach …" — three levels above the résumé input, and
stamped the résumé input. Depth 8 reaches a common section on most boards, so this
was not a fixture quirk. The walk now **stops** as soon as an ancestor holds more
than one `input[type=file]`: such an ancestor's text belongs to all of them and
identifies none. Among inputs that do have a discriminating ancestor, the nearest
one wins; ties break on shorter ancestor text, then document order.

**2. A stamp is a claim.** An input already carrying `data-ajup`, already holding
a file, or already taken earlier in this pass is not a candidate for anything.

**3. The fallback now does what its comment always said.** It read "the first
input still awaiting a file"; the code was `inputs[0]` unconditionally, which
could clobber a filled input.

The whole walk lives in one page-side function, `resolveUploads(specs, commit)`,
with two callers told apart by `commit`. Each result:

```js
{ ok: true, claimed: true, how: "label" | "order", depth: 2, target: "resume", inputs: 3, free: 2 }
```

- `how: "label"` — some text near this input identified it.
- `how: "order"` — nothing did; it was placed by document order.
- `free` — how many inputs were still awaiting a file when this choice was made.

### D.4 The ambiguity refusal, and why it turns on one number

`how: "order"` means the file was placed by DOM order and hope. Whether that is
acceptable turns on `free`, and on nothing else:

| `free` | meaning                                                                        | policy                |
| ------ | ------------------------------------------------------------------------------ | --------------------- |
| 1      | exactly one input still awaiting a file. Positional is **forced**, not chosen. | proceed silently      |
| ≥ 2    | two or more empty inputs and nothing told them apart.                          | **refuse the upload** |

The refusal message is written to fit inside `fail()`'s 140-character cap, because
it reaches you verbatim:

```
nothing on this page tells its 2 empty file inputs apart, so placing documents by
DOM order would be a guess — attach them by hand
```

**Why a dry pass.** When the plan holds two or more uploads, `resolveUploads` is
run once with `commit: false` **before anything is attached**, against the
pristine DOM — the best possible moment, since no remount has happened and every
input is present. If any spec would land ambiguously, every upload in the set is
refused. Deciding per item would attach file 1 positionally and then refuse file
2: a wrong document on the form **and** an incomplete application, which is worse
than either alone. The per-item check still runs afterwards, because a remount
between the dry pass and the real one can change the answer, and because a plan
with a single upload never took the dry pass at all — yet one upload on a page
with three empty file inputs is still a guess among three.

**Why refusing is the right direction.** The costs are not symmetric. Refusing
costs one manual attach on a board whose markup is unusual, and a human looking at
the page can tell the slots apart instantly. Attaching costs a document that is
not your résumé going out as your résumé, silently.

**And why it is a `fail()` rather than a quiet skip.** `fail()` is the only
vocabulary this engine has for "this did not happen and a human has to look", and
hard rule 6 already routes a failed fill to a blocked submit and a deferred
application. The engine does not defer — that is the planner's verb — so a failure
carrying its reason **is** the deferral, expressed in the words available here.

### D.5 The upload record

Before the upload is attempted (so a failure still says which slot it was aimed
at), the engine pushes one record per upload:

```js
{
  k: "f12",              // the plan item's key
  tag: "u1",             // the data-ajup stamp used for this upload
  file: "resume.pdf",    // basename of a path WE chose off OUR disk — never page text
  match: "resume|\\bcv\\b",  // the pattern that routed it
  how: "label",          // or "order"
  target: "resume",      // the input's id or name, sliced to 60 chars, page-controlled
  free: 2,               // only present on a positional placement
  attached: false,       // set true if setInputFiles did not throw
  settled: "detached"    // what the settle watch SAW — see below
}
```

`settled` records **what the settle stage observed this input do** with its file,
and the vocabulary is about the page rather than about our clock:

| value        | what the page did                                                    |
| ------------ | -------------------------------------------------------------------- |
| `"detached"` | the input left the DOM — the board consumed it (the Greenhouse swap) |
| `"reset"`    | the input is still there and its `FileList` is gone                  |
| `"held"`     | the file was still sitting on the input when the watching stopped    |
| `"unknown"`  | the page could not be observed at all (a test double)                |

A `held` upload is less settled than a `detached` one, which is exactly the kind
of thing this record exists to be able to say. `reset` is not a verdict — the
readback (D.6) rules on whether an emptied input means the board took the file or
dropped it.

> **Was a known defect (2026-08-05 audit); fixed 2026-08-10, see M11.** Until
> then each upload was followed by its own
> `waitFor({state: "detached", timeout: 1000})`, and on every board in this
> repository that wait never once exited early — `settled: "timeout"` on all
> three fixtures, every run, billing its full second per upload (two seconds on a
> two-attachment Greenhouse form) out of a ~2,750 ms median fill. The old
> vocabulary had a `"timeout"` value for exactly that, which is the tell: paying
> a ceiling is a cost, not a conclusion about the page. The window a board gets
> to react is now opened **once**, before the verify pass, and can end early —
> see E.1a.

### D.6 The readback — the change that landed on 2026-08-05

This is the part the brief for this document singles out, and it deserves the
space.

**`setInputFiles` not throwing is not evidence that a file attached.** It means
Playwright's call completed. Whether the board kept the file is a different
question, and the only thing that can answer it is the page.

So after the upload loop, one `page.evaluate` reads every file input on the page:

```js
const seen = await page.evaluate(() =>
  [...document.querySelectorAll("input[type=file]")].map((el) => ({
    tag: el.getAttribute("data-ajup"),
    names: el.files ? [...el.files].map((f) => f.name) : [],
  })),
)
```

Each upload record is matched against that snapshot, and gets one of three
answers:

| `rec.seen`   | what the DOM showed                                         | how it is read                 | why                                                                                                                                                             |
| ------------ | ----------------------------------------------------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `"gone"`     | the stamped input is no longer in the DOM                   | **success**, and only data     | The board swapped it for an attached-file view. Greenhouse does this. There is nothing left to read, and calling it a failure would break every Greenhouse run. |
| `"attached"` | the input is present and holds one or more files            | **success**                    | `seenFile` names the first one.                                                                                                                                 |
| `"empty"`    | the input is **still on the page** and holds **zero** files | **failure** (since 2026-08-05) | This is not "nothing observed". It is positive evidence that the file did not land.                                                                             |

Until 2026-08-05 nothing in this repository read that field. The measured
consequence, recorded in `tests/dev/b1-browser-fill.test.mjs`: **7 runs out of 7**
reported `fill: ok=4 failed=0 deferred=2` while the résumé input held zero files.
An application submitted with no résumé, and a report saying everything succeeded.

Now, an `empty` readback demotes the record:

```js
if (rec.seen === "empty" && rec.attached) {
  rec.attached = false
  out.ok--
  fail(
    itemByTag.get(rec.tag) || { k: rec.k, how: "upload" },
    "upload-readback-empty: the file input is still on the page holding no file — " +
      (rec.file || "the document") +
      " did not attach; attach it by hand",
  )
}
```

Three details in there are deliberate:

- **`attached` is corrected to `false` as well.** That key is what a caller reads
  to say "the file is on the field", and the DOM has just said it is not.
- **Only a record we counted is demoted.** An upload whose `setInputFiles` threw
  already went through `fail()`; failing it twice would double-count one document.
- **The tag comes first in the sentence**, so the 140-character cap can never eat
  it. `upload-readback-empty` is the one part that has to survive to make a
  board-wide pattern countable.

**There is a sibling check, added 2026-08-06.** `seen: "attached"` only ever meant
"some file is here". Measured on three live Ashby applications: those forms carry
a **third** file input labelled "Name" that matched neither `fileFields` regex, so
it fell to the positional fallback and was planned the résumé — which planned the
résumé twice. A document landing in a slot nobody meant it for was counted
`attached: true`, `ok++`, and reported as a clean fill. So the readback now checks
**membership, not equality**: our file must be among the names the input holds. (A
board that _appends_ to an input it had already populated leaves our file present
beside another one, which is not a mis-target. Our file being **absent** is the
defect.) The failure reads:

```
upload-wrong-file: the input holds a file this run did not send it — resume.pdf is
not attached here; attach it by hand
```

### D.7 Why failing closed is right, and the honest false positive

There is a board behaviour that makes `empty` the wrong reading: some boards read
the file out of the input into their own XHR uploader and then reset
`input.value`. On such a board a **working** upload reads `empty`, and this demotes
it.

The DOM cannot tell that page apart from a board that simply dropped the file.
Both leave an input that is present and holds nothing. There is no reading of the
evidence that gets both cases right, so the only choice is **which way to be
wrong**:

| wrong this way          | cost                                                                                                                                                                  |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| demote a working upload | a **stated deferral**. You are told which document did not appear to attach and you attach it by hand. One question, recoverable, visible.                            |
| trust `setInputFiles`   | an application submitted in your name **with no résumé**, reported as `ok`. That is the exact shape that shipped 7 runs out of 7, and nothing downstream corrects it. |

So this fails closed and stays that way. The comment names three tempting fixes
and refuses all three: do not trust `setInputFiles`; do not demote only when the
board is unknown; do not enumerate the boards that reset the input. A denylist
over third-party markup is exactly how the failure comes back.

What **is** owed to the false-positive case is legibility, and that is what the
`upload-readback-empty` tag buys. A board that always resets its inputs produces
that same tag on every application to it, and a run log full of one tag on one
board is a board behaviour you can see and act on — by writing an adapter, which
is rule 6's lawful route. One tag on one job is the ordinary failure.

### D.8 Uploads: the whole worked example

Plan:

```js
items: [
  {
    k: "f10",
    how: "upload",
    labelMatch: "resume|\\bcv\\b",
    paths: ["C:/…/jobs/acme/resume.pdf"],
    label: "Resume",
  },
  {
    k: "f11",
    how: "upload",
    labelMatch: "cover letter",
    paths: ["C:/…/jobs/acme/cover.pdf"],
    label: "Cover Letter",
  },
]
```

Page (simplified Greenhouse):

```html
<div class="field"><label>Resume</label><input type="file" id="resume" /></div>
<div class="field">
  <label>Cover Letter</label><input type="file" id="cover_letter" />
</div>
```

1. Two upload items → the **dry pass** runs `resolveUploads` with `commit: false`.
   Spec 1 walks up from `#resume`, finds the `div.field` whose text is "Resume",
   matches `/resume|\bcv\b/i` → `{ how: "label", depth: 1, free: 2 }`. Spec 2 does
   the same for `#cover_letter`. Neither is `how: "order"`, so nothing is
   ambiguous; `refuseAll` stays null.
2. Item 1 runs `resolveUploads` for real with `commit: true`: `#resume` gets
   `data-ajup="u1"`. `setInputFiles(["…/resume.pdf"])`. The stamped input detaches
   within 200 ms → `settled: "detached"`, `attached: true`, `ok = 1`.
3. Item 2 the same → `data-ajup="u2"` on `#cover_letter`, `ok = 2`.
4. The readback reads every `input[type=file]`. Both stamps are gone (Greenhouse
   swapped both inputs) → `rec.seen = "gone"` for both. Success; nothing is
   demoted.

Report fragment:

```js
uploads: [
  {
    k: "f10",
    tag: "u1",
    file: "resume.pdf",
    match: "resume|\\bcv\\b",
    how: "label",
    depth: 1,
    target: "resume",
    attached: true,
    settled: "detached",
    seen: "gone",
  },
  {
    k: "f11",
    tag: "u2",
    file: "cover.pdf",
    match: "cover letter",
    how: "label",
    depth: 1,
    target: "cover_letter",
    attached: true,
    settled: "detached",
    seen: "gone",
  },
]
```

Now change one thing: the board is one that reads the file by XHR and clears the
input. Both inputs stay on the page holding zero files. Both records become
`seen: "empty"`, both `attached` flip to `false`, `ok` drops to 0, and two
`upload-readback-empty` failures appear. The submit gate refuses, and you attach
two files by hand. That is the false positive, and it is the cheap direction.

---

## Part E — The verify pass

### E.1 Why it exists at all

Everything up to here reports what the _calls_ did. The verify pass reports what
the **page** holds. Those are different facts, and three separate incidents in
this file exist because something confused them.

It runs once, at the end, after blurring whatever has focus and letting the page
settle:

```js
await page.evaluate(
  () => document.activeElement && document.activeElement.blur(),
)
// ...then the settle loop, below.
```

The blur matters because a widget that reverts on blur must have reverted before
we read it.

### E.1a The settle stage — one loop, two conditions

Until 2026-08-10 the blur was followed by a flat `waitForTimeout(450)`, and every
upload had already paid its own `waitFor({state: "detached", timeout: 1000})`.
Both were measured settling by **timeout**, on every fixture board, in every run
(`docs/measurements.md`, B1): Greenhouse paid 2 × 1007 ms + 456 ms — 2,470 ms of
a 2,754 ms fill. A ceiling paid in full every time is a flat sleep wearing a
condition's name.

They are now one polling stage before the verify pass. **Both** old ceilings are
kept, and neither is paid unless the page offers no evidence:

| arm         | ends early when                                                                                                                    | otherwise pays                             |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| **uploads** | every stamped input has visibly reacted — gone from the DOM (the Greenhouse swap), or its `FileList` taken (Ashby's parse remount) | 1000 ms after the **last** `setInputFiles` |
| **quiet**   | validation text has appeared **and then repeated** between two polls                                                               | 450 ms                                     |

Three things follow, and each is deliberate:

- **The upload window opens once**, not per file, and it is anchored at the last
  upload — so every non-upload item filled since then has already spent part of
  it. A second upload adds no waiting at all.
- **Silence is not evidence.** The quiet arm will not exit because nothing has
  rendered yet: a 300 ms debounce looks exactly like a board that will never
  speak, and `verify.errors` is a submit-gate input, so exiting on silence would
  mean submitting into a form the board had already flagged. Silence pays the
  ceiling, exactly as the flat sleep did — no regression against it.
- **A fill that touched nothing settles nothing.** Every item skipped or deferred
  means no interaction happened, so there is no reaction to wait out. The old
  flat sleep was paid there too, on every page of a multi-page walk.

The upload readback (Part D) runs **after** this stage rather than straight after
the uploads, because this is the most-settled DOM the fill will ever see. Reading
earlier is how a board whose remount drops the file at 700 ms gets reported as a
clean upload.

`report.settle` carries `{ms, quiet, uploads}` — the stage's wall cost and which
arm resolved, so a ceiling paid in full is never re-read as a settle time. Each
upload's `settled` says what the watch saw: `detached`, `reset`, `held`, or
`unknown` for a page that could not be observed.

> **Measured (M11).** Fill wall, medians: greenhouse 2895.55 → 1111.64 ms, lever
> 1831.72 → 1159.57, ashby 1726.45 → 783.65, every fill report unchanged. All
> three fixtures are static forms that **hold** the file, so they pay the upload
> ceiling in full; the real Greenhouse swaps the input out and has evidence to
> exit on, which no fixture in this repository can show.

### E.2 What it re-reads

The engine builds one probe per non-`skip` item:

```js
const probes = items
  .filter((i) => i.how !== "skip")
  .map((i) => ({
    k: i.k,
    sel: i.sel || (i.k ? '[data-aj="' + i.k + '"]' : null),
    want: i.how === "upload" ? null : i.value,
    how: i.how,
  }))
```

and hands the whole list to **one** `page.evaluate`. That single call is the
mechanism, not an optimisation: a `page.evaluate` body runs inside one turn of the
page's event loop, so no remount can happen in the middle of it. It is the one
reading in this entire file that a redrawing page cannot race.

Inside, `read(el)` mirrors `shownValue` exactly — checkbox/radio → `checked`,
combobox → the committed store via `comboValue`, otherwise `el.value`, otherwise
the rendered selection or `innerText`. It has to carry its own copy because it
cannot call through a locator from inside the page, and the copy is not
decoration: the verify pass had the identical combobox bug, which is why Affirm's
ten empty dropdowns came back in `landed` even once the fill itself had started
failing them correctly. `tests/apply/combo-commit.test.mjs` pins the two readbacks
to the same answers.

### E.3 The three findings, and how they differ

| finding             | what it means                                                                                    | who produced the evidence |
| ------------------- | ------------------------------------------------------------------------------------------------ | ------------------------- |
| **`mismatch`**      | We planned value X for field F; the page shows something else.                                   | Our readback vs our plan. |
| **`requiredEmpty`** | Field F is marked required (`required` or `aria-required="true"`) and holds nothing.             | The page's own markup.    |
| **`errors`**        | The form itself rendered validation text — "This field is required.", "Please select an option". | The board's own script.   |

They are in increasing order of authority. A mismatch is our reading disagreeing
with our intention. A `requiredEmpty` is the page's markup disagreeing with the
state of the page. An `error` is the form telling us, in its own words, that it
will not accept what is on it. The engine's comment calls rendered validation text
"the only reliable signal that the app itself considers a field unset — element
state alone lied to us before."

The error sweep collects text from
`[class*='error-message'], [class*='errorMessage'], [role='alert'], [id$='-error']`,
de-duplicates, and drops anything over 120 characters.

A field that is neither a mismatch nor empty goes into `landed` — **keys only**,
for the privacy reason in B.3.

### E.4 `revealed` — the fields the plan could not have known about

Consider: "Have you worked here before? [Yes] → If yes, when?" The second control
**does not exist** until the first is answered. It is not in the scan, not in the
plan, not in `probes`, and every check above is blind to it. The run would report a
clean fill of a form that cannot be submitted.

So a second loop asks the **page** what is still required:

- It walks
  `input,select,textarea,[contenteditable='true'],[role='checkbox'],[role='radio'],[role='switch'],[role='combobox']`.
- It skips anything already in the plan, anything disabled, and the types
  `submit|button|reset|image|hidden|file`.
- It keeps only controls that are **required**, have a non-zero box, and read
  empty.
- It reads `aria-checked` **first, for any tag**, because a
  `<div role="checkbox" aria-checked="false">` has no `checked` property and its
  `innerText` is whatever the widget draws.
- It records `{ label, type, sel }` for each.

Nothing is filled. There is no answer for these fields in this process — the fact
base is not here — and inventing one is exactly what this pipeline does not do.
They go back as data so the caller defers them, and so that an unattended run does
not submit a form with an unanswered required field.

> **Known defect (2026-08-05 audit).** The sweep silently caps at 400 controls
> examined and 20 findings recorded (`all.slice(0, 400)`, `res.revealed.length >= 20`).
> Because `revealed` is a hard blocker in `submitReadiness`, a form large enough to
> push its required-but-empty controls past the 400-element slice produces an
> **empty** `revealed` and the gate passes vacuously. Every other cut in this
> pipeline announces itself — `optsTruncated`, `MAX_WIDGET`'s signal — and this one
> says nothing.

### E.5 Reconciliation: overturning a stale failure

```js
const landedKeys = new Set(out.verify?.landed || [])
for (const f of out.failures) {
  if (f.stale && landedKeys.has(f.k)) {
    out.failed--
    out.ok++
    out.reconciled.push({ k: f.k, how: f.how, why: f.why })
    continue
  }
  kept.push(f)
}
```

**Only** a stale failure is reconsidered, and only when the verify pass read the
wanted value back off the page. A refused element, an unknown verb, a combo that
never took the value — none are touched. A field whose value is not on the page
stays failed, which is the safe direction: a failure blocks the unattended path and
a false `ok` would not.

Every promotion is listed in `reconciled`, so it is never invisible. A live Ashby
run recorded a field as failed whose value had in fact landed; that is the case
this closes.

> **Known defect (2026-08-05 audit).** The verify pass decides `landed` versus
> `mismatch` with `n(got).includes(n(p.want))` — the exact loose containment that
> `accepts()` was rewritten to remove after it put "Protected Veteran" on a
> submitted form. Because `landed` feeds reconciliation, a combo that threw "not
> attached" and left a **wrong-but-containing** value on the page is promoted to
> `ok` and its failure record deleted. The fix is to reuse `accepts()`'s
> prefix-at-a-word-boundary rule inside the verify evaluate, exactly as
> `comboValue` already mirrors `shownValue`.

### E.6 The last thing the engine does

```js
const scan = await page.evaluate(() =>
  typeof window.__ajScan === "function" ? window.__ajScan(false) : null,
)
if (scan) {
  out.signals = scan.signals || []
  const btn = (scan.btns || []).find((b) => b.r === "next" || b.r === "submit")
  if (btn) out.next = { btn: btn.k, label: btn.l, role: btn.r }
}
```

It **reports the way forward and never takes it**. `out.next` is a key and a
label; the engine does not click it.

> **Known defect (2026-08-05 audit).** This end-of-run scan calls
> `window.__ajScan` — the page global — rather than the local binding the rest of
> the architecture insists on. Installing the scanner unconditionally does not
> fully close it: a page that defined `__ajScan` first and made it non-writable
> makes our own assignment fail silently, and the page's function is what answers.
> `out.next` is what the attended skill is told to click. The engine cannot import
> anything, but the plan can carry the scanner expression the bootstrap already
> embeds, and the engine could then call it through a local binding the way
> `scan-engine.mjs` does.

### E.7 How all of this now reaches the submit gate

This is the second change the brief for this document singles out, and it is a
good illustration of a whole class of bug: **a gate cannot refuse evidence it was
never handed.**

The chain has three links.

**Link 1 — the engine produces the evidence.** `failed`, `failures`, `verify.mismatch`,
`verify.requiredEmpty`, `verify.errors`, `revealed`, `uploads`.

**Link 2 — `mergePages` in `scripts/auto/multipage.mjs` combines one report per
page into one report for the whole form.** Until 2026-08-05 it rebuilt the report
as `{ uploads, revealed }` and dropped everything else on the floor. The engine had
just learned to demote an unattached upload to a fill failure — and that failure
stopped existing one call before any gate. The unattended path submits the merged
report or nothing, so a key missing from that object does not exist as far as the
gates are concerned. An application with no résumé attached passed both.

`mergePages` now carries `failed`, `failures`, `verify.mismatch`,
`verify.requiredEmpty`, `verify.errors`, `plan.actuated`, `uploads` and `revealed`
through the walk, page-tagging each entry ("a field failed to fill" is not
actionable on a four-page form without knowing which page). Three refinements are
worth naming because each is a distinct kind of forgery it prevents:

- **A list that is present and is not a list** is not an empty list. Something
  produced it, and a shape nothing can read is evidence the page was not
  understood — so it is recorded as a fill failure, in the vocabulary every gate
  already reads.
- **The failure count is carried beside the list rather than derived from it.** They
  agree in everything the engine emits, and the gate checks both, so a report where
  they disagree still refuses instead of being resolved in favour of the clean
  number.
- **`verify` is absent, not empty, when no page ran a verify pass.** "Nothing
  measured this" and "this measured zero" are different facts. Synthesising
  `{mismatch: [], requiredEmpty: []}` would hand the gate a clean bill of health
  nobody ever wrote. And the per-page half of the same forgery is closed too: a
  walk where page 1 verified and page 2 did not is recorded as a failure —
  _"a partly-measured form is not a measured one"_.

**Link 3 — `submitReadiness(plan, report)` in `scripts/apply/fill-plan.mjs`
refuses on any of it.** In order: any label that tried to instruct the agent, any
deferred field, any widget ticked from a banked answer, nothing to fill, an
unreadable report, any `revealed` field, any fill failure, any verify
`mismatch` / `requiredEmpty` / `errors`. Each refusal returns a sentence written to
be read:

```
1 field(s) failed to fill: Resume (f10) [upload] upload-readback-empty: the file
input is still on the page holding no file — resume.pdf did not attach; attach it
by hand
```

Note what it does **not** read: `report.uploads`. That is not an oversight. An
attachment that did not attach arrives as a `failures` entry, because the engine
demoted it. `uploads` remains the list a **human** reads to see which file reached
which field — a thing that must never be reconstructed from the plan, because the
plan says only what was _attempted_.

And note the compatibility rule that runs through the whole thing: `null` and
`undefined` mean "no fill ran, nobody measured this", and reading a missing key as
a failure would refuse every submit ever attempted. Only a **present** non-zero
count refuses.

---

## Part F — The ATS adapter interface

### F.1 What an adapter is, and the one rule the directory lives by

An **ATS** (Applicant Tracking System) is the software an employer uses to receive
applications: Greenhouse, Lever, Ashby, Workday, Oracle Recruiting Cloud, and
dozens more. Each renders its forms differently.

An **adapter** in `scripts/apply/ats/` is a plain JavaScript object, exported as
the module's default, describing one board. There is no class, no interface file,
no registration function. The registry's header states the rule the whole directory
follows:

> "An adapter contributes only knowledge, never behaviour: which combo strategy to
> try first, which file field takes which document, and where an ATS renders a
> value differently from the option text it was chosen by. The fill engine itself
> contains no ATS-specific code, so an unrecognised board still works — it just
> defers more fields to the user."

Read that twice. It means an adapter never opens a page, never does input or
output, never calls a model, never reads the fact base, and never decides a value.
Every function in an adapter takes a string and returns a string. Adding a board
cannot introduce a new behaviour, only new knowledge.

### F.2 Every field an adapter may export

```js
export default {
  id: "greenhouse", // REQUIRED, string
  match: /(^|\.)greenhouse\.io/i, // REQUIRED, RegExp
  comboStrategies: ["type-enter", "type-click", "click-option"], // REQUIRED, string[]
  fileOrder: ["resume", "cover"], // REQUIRED, string[]
  fileFields: [{ match: /resume|\bcv\b/i, doc: "resume" }], // REQUIRED
  valueAliases: [], // REQUIRED (may be empty)
  typeaheadFields: [{ match: /^\s*location\s*\**\s*$/i }], // OPTIONAL
  applicationUrl(url) {
    /* string -> string */
  }, // OPTIONAL
}
```

**`id` — string.** The board's name. It is written onto the plan as `plan.ats`,
hashed into the field cache's fingerprint, stored as `entry.ats`, used by
`automatability.mjs` to decide whether a board is _known_, and matched against
**your allowlist in `docs/application-limits.yaml`** by the unattended trust gate.
It must be lowercase and stable: changing it orphans every cache entry and breaks
your allowlist.

**`match` — RegExp.** Tested by `detectAts` against the whole URL string. Every
shipped adapter anchors the host portion with `(^|\.)` so a lookalike domain —
`notgreenhouse.io.evil.test` — does not match. A new adapter must do the same;
`tests/apply/fill-plan.test.mjs` pins exactly that property.

**`comboStrategies` — ordered strategy names.** The order `setCombo` walks (Part
C.7.1). The evidence for each shipped order is written into the adapter:

- Greenhouse: _"type-enter first: it resolved 16 of 19 dropdowns in the live run.
  The education selects (School/Degree/Discipline) needed the exact row clicked,
  which is what type-click does, so it is the immediate fallback."_
- Lever: _"Native `<select>` elements are handled by the `select` verb, so the
  combo strategies here only matter for Lever's few custom pickers."_
- Generic: exact row **first**, because `type-enter` commits whatever row the
  widget has highlighted, and on Oracle Recruiting Cloud that put "Protected
  Veteran" into a Veteran Status field.

A new adapter should start with **generic's order** and only reorder once measured
on a real form of that board. The board-level winner is also learned automatically
and cached (`recordVia`), so a wrong guess costs latency on the first application
and then corrects itself.

**`fileOrder` — document kinds in the order the board renders its slots.** Used
only when the form labels its attachment inputs uninformatively — a bare "Attach".
All four adapters carry the identical comment: _"every one of these boards renders
the resume slot first."_

**`fileFields` — `[{ match: RegExp, doc: "resume" | "cover" }]`.** Maps an
attachment control's label (or, failing that, its section heading) to which
document belongs in it. `fill-plan.mjs` resolves in this order:

1. `fileFields.find(s => s.match.test(label))`
2. else `fileFields.find(s => s.match.test(f.section))` — the scanner reports the
   heading above a field separately from its label, and on Greenhouse that heading
   is the only thing distinguishing two inputs both labelled "Attach"
3. else, **and only if the label is genuinely uninformative**, fall back to
   `fileOrder[fileIndex]`

Step 3's condition is not a detail. It used to fire for _any_ label no spec
matched, which turned "nothing here identifies this slot" into "it must be the
résumé, then". Measured on three live Ashby applications: those forms carry a third
file input labelled "Name", matching neither regex; it took `fileOrder[0]`, was
planned the résumé, and so the résumé was planned **twice**. An unrecognised slot
must not be handed the first document — and must not consume a **position** either,
or the real "Attach" input after it is offered slot 1 and gets the cover letter.

Lever's cover matcher is wider than the others (`/cover letter|additional information/i`)
because Lever labels its second attachment "Additional information". That is
exactly the sort of knowledge an adapter is for.

**`valueAliases` — `[{ label: RegExp, value: RegExp, accept: RegExp }]`.** Intended
for the case where an ATS renders a chosen value differently from the option text
it was chosen by. Only Greenhouse defines one:

```js
valueAliases: [
  { label: /^country/i, value: /united states/i, accept: /\+1|united states/i },
]
```

> **Known defect (2026-08-05 audit).** This key is inert. `fill-plan.mjs` copies
> `adapter.valueAliases` onto the plan, the plan is serialised to JSON, and
> `JSON.stringify` turns a RegExp into `{}`. A real generated plan contains
> `"valueAliases":[{"label":{},"value":{},"accept":{}}]`. Nothing reads
> `plan.valueAliases` anywhere in the repository, so the Greenhouse country-picker
> fix its comment describes does not exist at runtime. Either serialise each
> pattern as a **source string** and rebuild it with `new RegExp` inside the
> engine's verify step, or delete the key from all four adapters and both write
> sites. A new adapter should carry `valueAliases: []` for shape and expect nothing
> from it today.

**`typeaheadFields` — `[{ match: RegExp }]`, optional.** Declares "this control
looks like a dropdown and is not one" — a server-queried typeahead with no
enumerable list (Part C.8). Only Ashby ships one. Its comment is careful about why
this is not the defer list being quietly shortened: rule 6 permits three ways to
defer less, and an adapter that knows a board's shape is the first of them. An
enumerated dropdown nobody probed is still an unknown and still blocks; a control
with no enumeration to miss was never "unprobed" in the first place.

**`applicationUrl(url)` — `string -> string`, optional.** "Where the form is, given
a posting URL." Every implementation guards its own hostname first, returns early
if the URL is already the form URL, and returns the input **unchanged** when the
shape is not recognised — it never invents a path.

| adapter    | posting shape                | form shape                                         |
| ---------- | ---------------------------- | -------------------------------------------------- |
| greenhouse | `<host>/<org>/jobs/<digits>` | `<same origin>/embed/job_app?for=<org>&token=<id>` |
| lever      | `<host>/<org>/<id>`          | `.../apply`                                        |
| ashby      | `<host>/<org>/<uuid>`        | `.../application`                                  |

Two measured failures put it there. On Ashby, the ad carries no fields at all, so a
runner handed the posting scans it, finds nothing to fill, and defers with "nothing
to fill". On Greenhouse, `job-boards.greenhouse.io/coinbase/jobs/8022068` answered
with a redirect to `www.coinbase.com/careers/positions/...` — the company's own
site, a **different origin** from the one the submit token was bound to, so even a
filled form could not have been submitted.

The Greenhouse implementation preserves the **origin** rather than hardcoding a
host, and that is load-bearing rather than tidy: an earlier version hardcoded
`job-boards.greenhouse.io`, which silently moved a posting served from
`boards.greenhouse.io` onto a different origin, so the trust gate refused a board
you had allowlisted.

> **Known defect (2026-08-05 audit).** The **attended** path never calls
> `applicationUrl`. Its only caller is `scripts/auto/auto-apply.mjs`, the
> unattended runner, which ships disabled. The `apply-job` skill navigates to
> whatever URL you paste and scans it — so on Ashby and Lever the agent scans an ad
> page with no fields and defers "nothing to fill", and on Greenhouse the board URL
> can redirect off-origin. Resolving the URL once at the start of the skill is one
> deterministic call and zero model tokens, and removes a whole wasted
> scan-and-defer round trip per Ashby/Lever apply.

### F.3 `detectAts` — how one adapter is chosen

```js
export function detectAts(url) {
  const u = String(url ?? "")
  const host = hostnameOf(u)
  for (const h of HANDOFF)
    if (h.match.test(host)) return { id: h.id, handoff: true, reason: h.reason }
  for (const a of ADAPTERS) if (a.match.test(u)) return a
  return generic
}
```

Five steps:

1. Coerce the URL to a string; `null` becomes `""` rather than throwing.
2. Parse the hostname inside a `try`; a parse failure yields `""`.
3. **Hand-off first**, tested against the **hostname only**. A hit returns
   `{ id, handoff: true, reason }` — note this is _not_ an adapter object. It has
   no `comboStrategies`, no `fileFields`. Callers must check `.handoff` first.
4. **Adapters second**, tested against the **whole URL string**, in array order
   (greenhouse, lever, ashby). First match wins; the adapter object itself is
   returned, not a copy.
5. Fall through to `generic`.

**Worked examples.**

| input                                                    | result                                                                                                                  |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `https://job-boards.greenhouse.io/coinbase/jobs/8022068` | the greenhouse adapter                                                                                                  |
| `https://jobs.ashbyhq.com/render/2f0a…`                  | the ashby adapter                                                                                                       |
| `https://myworkdayjobs.com/en-US/acme/job/123`           | `{ id: "workday", handoff: true, reason: "Workday requires creating an account to apply — the agent cannot do that…" }` |
| `https://notgreenhouse.io.evil.test/apply`               | `generic` — the `(^                                                                                                     | \.)` anchor is what makes this true |
| `https://jobs.example.com/careers/42`                    | `generic`                                                                                                               |

**Workday is detected and deliberately not adapted.** Applying there requires
creating an account, which the agent is not permitted to do (that is one of the
prohibited actions, not a capability gap). Naming it produces an honest hand-off —
`fill-plan.mjs` prints the reason and exits 3 — instead of a confusing stall at a
login wall.

**Why the hostname/whole-URL asymmetry.** The hand-off loop used to match the whole
URL, so a tracking parameter on a real Greenhouse posting
(`?utm_source=myworkdayjobs.com`) forced a Workday hand-off. That is fail-safe
rather than fail-dangerous — the pipeline refuses to apply rather than filling
something wrong — but it is still a third party silently denying an application you
could otherwise submit, and on the unattended path that is a denial of service with
nobody watching. So hand-off matching was narrowed to the parsed hostname.

> **Known defect (2026-08-05 audit).** Adapter selection was **not** narrowed. It
> still tests each adapter's regex against the entire URL string, so
> `https://evil.example/apply?utm_source=boards.greenhouse.io` selects the
> Greenhouse adapter and gets Greenhouse's combo order, file map and (once wired)
> its `applicationUrl` rewrite. The file names the finding itself and defers it
> because this repository's own fake-board fixture depends on the property to
> select a real adapter at all — closing it means switching each `match` to the
> parsed hostname and updating `tests/fixtures/boards/server.mjs` in the same
> change. **Never use `detectAts` for a trust decision.** `scripts/auto/trust.mjs`
> works around it by refusing to call `detectAts` at all; trust reads a
> **user-declared** ATS id out of your own file instead.

### F.4 The four shipped adapters, and what each exists to say

| adapter        | in `ADAPTERS`? | combo order                                | `applicationUrl` | extra                    | what it exists to say                                                                                                                  |
| -------------- | -------------- | ------------------------------------------ | ---------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| **greenhouse** | yes            | `type-enter`, `type-click`, `click-option` | yes              | the one `valueAliases`   | "This board is react-select everywhere, its ad redirects off-origin, and the form lives at an embed URL."                              |
| **lever**      | yes            | `click-option`, `type-enter`, `type-click` | yes              | wider cover-letter regex | "This board is mostly native inputs and `<select>`s, so combos barely matter; its second attachment is called Additional information." |
| **ashby**      | yes            | `type-enter`, `click-option`, `type-click` | yes              | `typeaheadFields`        | "This board has a control that looks like a dropdown and has no list, and its ad page carries no fields at all."                       |
| **generic**    | **no**         | `type-click`, `type-enter`, `click-option` | no               | —                        | "Nothing is known about this board, so prefer the strategy whose failure mode is an empty field rather than a wrong one."              |

Two structural points hide in that table.

**`generic` is deliberately not in `ADAPTERS`.** `ADAPTERS` means "the boards this
repository can fill". `automatability.mjs` builds a set of those ids and asks "is
the detected id in it?" to mean "is this a **known** board", and
`scripts/auto/trust.mjs` re-exports the same list as one of its trust checks. If
`generic` were in the array, every unknown board would read as known. Its `match`
is the never-matching regex `/.^/` — a dot followed by start-of-string, which
nothing can satisfy — so the object is _shaped_ like an adapter and the loop stays
uniform, while it can only ever be reached by falling through.

**Adding an adapter widens the trust gate.** Because a board you allowlist must
declare an ATS id that appears in `ADAPTERS`, adding a file to this directory
changes what the unattended runner will accept. That is a real security consequence
of a five-minute edit, and it belongs in your head before you make one.

### F.5 Writing a new adapter — the complete walkthrough

Suppose a board keeps coming up in your leads — call it **Workable**, served from
`apply.workable.com`. Here is the whole job.

#### Step 0 — decide whether you need one at all

You do not need an adapter for a board to work. `generic` fills unknown boards
already; an adapter makes it fill **more** of them and **faster**. Write one when a
board shows up often enough that you notice the same manual step every time.

#### Step 1 — measure the board, do not guess it

Open one real posting and answer four questions:

1. **Are the ad and the form the same page?** If the posting URL shows a form with
   fields, you need no `applicationUrl`. If it shows a description and an "Apply"
   button, find the form's URL and note the shape of the transformation.
2. **Are the dropdowns native `<select>`s or custom widgets?** View the page source
   or use your browser's inspector. Native selects need no combo strategy at all.
3. **What are the attachment inputs labelled?** "Resume"? "CV"? "Attach"? Is there
   a heading above them? Is there a third input that is not an attachment slot (a
   profile-import control, an avatar)?
4. **Does any control look like a dropdown but offer no list until you type?**

Write down what you saw. Every comment in the shipped adapters carries a date and a
board because these facts expire.

#### Step 2 — create the file

`scripts/apply/ats/workable.mjs`:

```js
// Workable (apply.workable.com). Measured against <a real posting URL> on
// <date>: native <select> for most pickers, one custom multi-select for
// "How did you hear about us?", a single attachment input labelled "Resume".
export default {
  id: "workable",
  match: /(^|\.)workable\.com/i,

  // Start with generic's order: exact row first, because a wrong dropdown value
  // is worse than an empty one. Reorder only after measuring on a real form.
  comboStrategies: ["type-click", "type-enter", "click-option"],

  // Only consulted when the board labels its attachment inputs uninformatively.
  fileOrder: ["resume", "cover"],

  fileFields: [
    { match: /resume|\bcv\b/i, doc: "resume" },
    { match: /cover letter/i, doc: "cover" },
  ],

  valueAliases: [],
}
```

Four things to get right in that snippet:

- **`(^|\.)` on the host portion of `match`.** Without it,
  `notworkable.com.evil.test` matches.
- **`id` lowercase and final.** It becomes a cache key and an allowlist entry.
- **`valueAliases: []`** for shape, expecting nothing from it (F.2).
- **A comment naming the board, the URL you measured and the date.** The shipped
  adapters all do this, and it is the only thing that lets a future reader tell
  knowledge from folklore.

#### Step 3 — register it

In `scripts/apply/ats/index.mjs`:

```js
import workable from "./workable.mjs"

export const ADAPTERS = [greenhouse, lever, ashby, workable]
```

Order matters only if two `match` regexes could both hit one URL. Keep the new
entry last unless you have a reason.

**Stop and notice what you just did:** `scripts/auto/trust.mjs` derives its list of
acceptable ATS ids from `ADAPTERS`, so `workable` is now an id you are allowed to
put in `docs/application-limits.yaml`'s `board_allowlist`. Nothing is trusted yet —
you still have to put it there yourself — but the door now exists.

#### Step 4 — add `applicationUrl` only if the ad and the form differ

Only after checking the real board. Suppose you measured that the ad lives at
`/<org>/j/<id>` and the form at `/<org>/j/<id>/apply`:

```js
  // WHERE THE FORM IS, given a POSTING url. Knowledge only: a string in, a
  // string out, nothing opened, and an unrecognised shape returned untouched.
  applicationUrl(url) {
    try {
      const u = new URL(String(url))
      if (!/(^|\.)workable\.com$/i.test(u.hostname)) return String(url)
      if (/\/apply\/?$/i.test(u.pathname)) return u.toString()
      if (!/^\/[^/]+\/j\/[^/]+\/?$/.test(u.pathname)) return String(url)
      u.pathname = u.pathname.replace(/\/?$/, "") + "/apply"
      return u.toString()
    } catch {
      return String(url)
    }
  },
```

The four guards, in order, are the same four every shipped implementation has:

1. **Wrap everything in `try`/`catch`** and return the input on a parse failure. A
   malformed URL must not throw out of a knowledge function.
2. **Check the hostname yourself.** `match` is whole-URL and therefore looser than
   you want here.
3. **Return early if it is already the form URL**, so the function is idempotent.
4. **Return the input unchanged on any path shape you do not recognise.**
   Appending to a path you did not measure invents a page.

#### Step 5 — add `typeaheadFields` only for a control with no enumerable list

If the board has a Location box that queries a server as you type and offers
nothing until it does:

```js
  typeaheadFields: [{ match: /^\s*location\s*\**\s*$/i }],
```

Match the label **exactly** (anchored, tolerating a trailing required asterisk).
This is a declaration that a specific control has no list to read — not a general
"trust the label", and not a way to fill a dropdown whose options were simply never
probed.

#### Step 6 — write the tests

Two at minimum, in the style of `tests/apply/fill-plan.test.mjs`:

```js
import assert from "node:assert/strict"
import { test } from "node:test"
import { detectAts, ADAPTERS } from "../../scripts/apply/ats/index.mjs"

test("a real Workable posting selects the workable adapter", () => {
  assert.equal(
    detectAts("https://apply.workable.com/acme/j/ABC123/").id,
    "workable",
  )
})

test("a lookalike hostname does not", () => {
  assert.equal(
    detectAts("https://notworkable.com.evil.test/apply").id,
    "generic",
  )
})
```

If you added `applicationUrl`, test it three ways: a posting URL becomes the form
URL; a form URL comes back unchanged; an unrecognised path comes back unchanged.

Put them where the existing ones live: `tests/apply/fill-plan.test.mjs` holds the
detection tests (including the assertion that `workday` is **not** in `ADAPTERS`
and that a lookalike hostname resolves to `generic`), and
`tests/auto/auto-apply.test.mjs` is where `applicationUrl` is exercised today.
Run that single file while iterating
(`node --test tests/apply/<file>.test.mjs`) and `npm test` once before
committing. (`npm test` is the count-asserting gate, not a bare `node --test`; and
never pass a bare directory to `node --test`, which does not recurse on Node 24.)

#### Step 7 — there is no step 7

There is no behaviour to implement. The fill engine contains no per-board code, so
an adapter is finished when its knowledge is written down and tested.

#### What an adapter may never do

Open a page. Do file or network I/O. Call a model. Read `profile/`. Decide a value.
Every file in `ats/` repeats "knowledge, not behaviour", and the reason is rule 6:
throughput may only rise through deterministic understanding. An adapter is one of
the three lawful routes. A model reading the field and deciding is not.

---

## Part G — `browser.mjs`: launching, contexts and lanes

### G.1 What this file is for

Two things reach the engines with a `page` in hand, and this file serves both:

1. **The local runner** — `scripts/auto/*` and the tests against the fake board
   under `tests/fixtures/boards/`. Ordinary Node, ordinary `import`:
   `launchBrowser()` here, then `fillPage(page, plan)` / `scanPage(page)`. No MCP,
   no model.
2. **The MCP path** — whose sandbox has no working `import` and no `fs`.
   `fill-plan.mjs` reads the engine's text off our own disk with
   `engineSandboxSource()` and embeds it in the generated `jobs/<slug>/fill-plan.js`.

Its header carries the same safety sentence as the engine: nothing in this file
clicks a button, and neither engine has a verb for it. _"Do not add a submit helper
here to 'complete' the API."_

### G.2 Launching Chromium

```js
export async function loadChromium() {
  try {
    const pw = await import("playwright-core")
    return pw.chromium ?? pw.default?.chromium
  } catch (e) {
    throw new Error(
      "playwright-core is not installed — `npm i -D playwright-core` …",
    )
  }
}
```

**`playwright-core`, never `playwright`.** The two packages contain the same
library; the difference is that `playwright`'s postinstall script downloads roughly
150 MB of browser binaries **on every install, including every CI run**. This
repository avoids that deliberately: the browser binary comes from your machine,
named by `PLAYWRIGHT_CHROMIUM` (a path) or `PLAYWRIGHT_CHANNEL` (an installed
channel such as `chrome`), or is installed once on purpose with
`npm run browser:install`.

The `await import(...)` is a **dynamic import** — an import performed at run time
rather than at load time — which is what makes the dependency optional and lets the
failure be a sentence you can act on rather than a module-not-found stack trace.

```js
export async function launchBrowser(opts = {}) {
  const {
    userDataDir = null,
    headless = true,
    executablePath = process.env.PLAYWRIGHT_CHROMIUM || undefined,
    channel = process.env.PLAYWRIGHT_CHANNEL || undefined,
    timeout = 30000,
    args = [],
    localOnly,
  } = opts
  …
}
```

**Headless** means the browser runs with no visible window. It is the default
because the runner has no screen to draw on. `AUTO_HEADED` in `auto-apply.mjs`
flips it when you want to watch.

It returns `{ browser, context, page, localOnly, goto, close }`.

### G.3 The persistent and non-persistent lanes

This is the important distinction in the file, and it decides whether the browser
carries your logged-in sessions.

```js
if (userDataDir) {
  context = await chromium.launchPersistentContext(userDataDir, common)
} else {
  browser = await chromium.launch(common)
  context = await browser.newContext()
}
```

| lane               | how it is chosen                | cookies                        | on disk                 | isolation                                                                      |
| ------------------ | ------------------------------- | ------------------------------ | ----------------------- | ------------------------------------------------------------------------------ |
| **non-persistent** | `userDataDir` is null (default) | none — starts empty every time | nothing                 | a fresh context per job, so jobs share nothing                                 |
| **persistent**     | `userDataDir` is a directory    | whatever is in that directory  | a real Chromium profile | one shared context; the origin exclusion in `pool.mjs` is then doing real work |

A **user data directory** (Chromium's `--user-data-dir`) is a folder holding a
browser profile: cookies, local storage, saved passwords, history. Two facts about
it matter here:

- **Chromium takes an exclusive lock on it.** Two processes on one directory
  corrupt it. That is why the persistent lane can only ever be one shared context,
  and why nothing may run two runners against one profile.
- **The lock is why `close()` is wrapped in `try`/`finally` everywhere.** An
  orphaned Chromium keeps the lock and blocks the next run. `withBrowser(opts, fn)`
  exists for that guarantee.

> **Known defect (2026-08-05 audit).** `withBrowser` has **no caller** anywhere in
> `scripts/` or `tests/` — the only search hits are a same-named local variable in a
> bench test. It is a helper with no user, and a reader will look for a contract
> that is not there. The same finding names two other dead parameters in this area.

**Why the unattended runner carries no session cookie by default.**
`auto-apply.mjs` chooses its lane from an environment variable:

```js
const userDataDir = process.env.AUTO_PROFILE || null
```

Unset — the default — means the non-persistent lane: a fresh `browser.newContext()`
per job, no cookies, nothing on disk. That is genuine per-job isolation, and it is
what makes "at most one job per origin" a courtesy rather than a load-bearing
security control. The reasoning is not only privacy: a browser that visits hundreds
of third-party application forms unattended is a browser you want carrying as
little of your identity as possible. The boards on the allowlist do not require a
login to apply, so the session buys nothing and risks everything.

`AUTO_PROFILE` exists for boards that genuinely need a session, and Part I is about
the script that populates such a profile safely.

### G.4 Where a browser is allowed to point

```js
const LOOPBACK = /^(localhost|127(\.\d+){1,3}|\[?::1\]?|0\.0\.0\.0)$/i

export function isLocalUrl(url) { … }          // file: and loopback http(s) only
export function assertAllowedTarget(url, { localOnly } = {}) { … }
```

"Loopback" is the network name for _this machine_: `localhost`, `127.0.0.1`, `::1`.
By default, `launchBrowser`'s returned `goto` refuses anything else:

```
refusing to open https://boards.greenhouse.io/…: this runner is restricted to
localhost and file: URLs (pass { localOnly: false } or set
AJ_BROWSER_ALLOW_REMOTE=1 to allow a real board)
```

The default is the safe one: `localOnly === undefined` means **restrict**, and
lifting it must be deliberate. This is what stops a test or a benchmark from being
pointed at a real employer's board by editing one argument.

Its limit is worth stating: **the guard only wraps `session.goto`.** A caller
holding `session.page` can call `page.goto` directly and bypass it entirely. It is a
runner-level convention, not a sandbox.

> **Known defect (2026-08-05 audit).** `auto-apply.mjs`'s `makeOpenPage` destructures
> `{ localOnly = true }` and never uses it; both browser lanes call `page.goto(url)`
> directly rather than `session.goto(url)`. `main()` passes
> `localOnly: !!args.fixture` in the belief that it confines a fixture run to
> loopback. A guard that silently does nothing is worse than no guard, especially on
> the path that runs unattended.

### G.5 The sandbox translation

Three small exports serve the MCP path.

`ENGINE_PATH` is resolved from `import.meta.url` — the module's own location —
never from `process.cwd()`, because a scheduled task's working directory is not
ours to assume.

`readEngineSource(file)` reads that file as UTF-8 text.

`engineSandboxSource(src)` performs the one-keyword translation described in A.6
and enforces the self-containment contract.

`embedLiteral(value)` is the safe way to turn a value into JavaScript source:

```js
export function embedLiteral(value) {
  return JSON.stringify(value).replace(
    LINE_SEPARATORS,
    (c) => "\\u" + c.charCodeAt(0).toString(16),
  )
}
```

`JSON.stringify`'s output is a valid JavaScript literal with exactly one
exception: **U+2028 and U+2029** are legal inside a JSON string and are **line
terminators** in JavaScript source. A plan carries labels copied verbatim off a
third-party page. So they are escaped here rather than trusted to the parser inside
the sandbox — a small, precise instance of hard rule 0.

---

## Part H — `capture-post-submit.mjs`

### H.1 The problem this solves, stated as a chain

After you press Submit, the board shows you something. It might be a confirmation.
It might be an identity check, a bot challenge, an "we emailed you a code" page, a
"this posting is gone" page, or a plain error. `scripts/auto/classify.mjs` is the
component that types that page, and its verdict decides whether an application is
recorded as sent.

Every rule in that classifier is **bounded by its evidence**: a rule justified by a
fixture page may fire only on loopback. So on a real ATS, the classifier answers
`unclassified`, which is the one remaining hard STOP on the unattended path. The
chain is:

> no real post-submit pages → no evidence → no rule may fire on a real board →
> every unattended submit stops as `unclassified` → the unattended path cannot
> advance.

The tempting shortcut is for somebody to write "a confirmation says 'thank you for
applying'" from memory. That is hard rule 0's forbidden guess with the model
removed, and it fails in the one direction that cannot be recovered: **a page
misread as a confirmation records an application that was never sent, and nothing
later corrects it.**

**Why only your own applies can supply the corpus.** Reaching a confirmation page
requires actually submitting an application. There is no crawl that produces one,
no public dataset, no way to synthesise it honestly. You are on the submit button
for every application today, so the pages exist — they are simply not being kept.
This script keeps them.

### H.2 Three steps, and why it is not one

```
stage    — right after the click. Redacts, writes to a GITIGNORED directory under
           jobs/, and REFUSES if any known identifier survived the redaction.
review   — prints the redacted page's visible text, so you read what you are about
           to publish rather than trusting a summary of it.
promote  — copies it into the committed corpus, and only with an explicit
           --user-approved flag.
```

One step would be simpler and wrong. A confirmation page carries your name, your
email, often your phone and address, and an application reference that identifies
you to that employer. The committed corpus lives in git and goes wherever this
repository goes. So the boundary between "on this machine" and "in the repository"
is a step you take deliberately, after reading the bytes.

| path                                     | what it is                                                                        |
| ---------------------------------------- | --------------------------------------------------------------------------------- |
| `jobs/.auto/post-submit/`                | the staging directory. Gitignored, under `jobs/`, guarded by `assertInsideJobs`.  |
| `tests/fixtures/post-submit/captures/`   | the committed corpus. Reached only through `promote`.                             |
| `tests/fixtures/post-submit/corpus.json` | the manifest: id, kind, file, url, hosts, source, captured_at, board, redactions. |

### H.3 Redaction, and why it is checked rather than assumed

`identifiersFromProfile()` builds the list of things that must not survive, **from
the fact base** — because the fact base is exactly the list of true things about
you this system knows, which makes it exactly the list that could appear on a page
you just filled in. It reads `contact.name`, `email`, `location`, `github`,
`website`, `linkedin`, `phone`, plus each part of your name separately (a
confirmation page routinely greets you by first name alone), plus phone digits with
punctuation stripped.

Two details:

- **Each literal carries a label, not just a value**, and that is a privacy
  property rather than ergonomics. The redaction report is written to disk and
  printed to a terminal, so a report saying `redacted 3x jane@test.example` would
  republish the exact string the redaction exists to remove, in the one place
  nobody thinks to check. Reports name `contact.email`; only the redactor sees the
  value.
- **Longest first.** Redacting "Jane" before "Jane Test" leaves " Test" on the
  page.

`GENERIC` then removes what the fact base cannot name — any email address, UUIDs,
long hex tokens, phone-shaped runs, and any bare run of six or more digits (a
reference number, an application id).

And then `assertRedacted` **re-reads the output** and throws if any identifier is
still present:

```
redaction did not remove 1 identifier(s): contact.email (18 chars). NOTHING WAS
STAGED. The value itself is not printed here — add a pattern to GENERIC in this
file, or report the shape, and re-run.
```

It reads the output, never the input and never the findings list, because the
failure being guarded against is precisely a pattern that did not fire. A redactor
that silently missed something is worse than no redactor, because the staging
directory's whole purpose is to be the thing that was safe to look at.

> **Known defect (2026-08-05 audit).** The loop over banked answers reads the wrong
> key: `for (const a of answers?.answers ?? []) { const v = a?.value; … }`, while
> every entry written by `save-answer.mjs` carries `answer:`. The loop can therefore
> never add anything, so a banked mailing address or a second email is never in
> `identifiers.literals` — and because `assertRedacted` checks that same list, the
> "checked, not assumed" guarantee cannot catch it either. `GENERIC` still strips
> emails and long digit runs, so the exposure is narrower than it sounds, but a
> banked street address would pass straight through. The fix is one word plus a
> test that stages a page containing a banked address.

### H.4 The three commands

```bash
node scripts/apply/capture-post-submit.mjs stage --url "<the post-submit url>" \
  --html-file <temp file> --board <greenhouse|lever|ashby> --slug <slug>

node scripts/apply/capture-post-submit.mjs review <id>

node scripts/apply/capture-post-submit.mjs promote <id> --kind confirmation --user-approved
```

`stage` does **not** take a `kind`, even when the caller thinks it knows one. What a
page _means_ is your call at promote time, after you have read it — that judgement
is precisely what is kept away from anything automatic.

`review` prints the **visible text**, not the HTML. Markup is where a skim misses
something, and the classifier reads the text anyway.

`promote` refuses without `--user-approved`, and refuses a `--kind` outside the
closed list `confirmation`, `identity-verification`, `bot-challenge`,
`email-code-challenge`, `posting-gone`, `error` (`unclassified` is excluded: a
sample expected to classify as unclassified belongs in the fixture-side
not-a-confirmation control set).

The file states its own limits at the top: it never writes `profile/` — there is no
code here that can — it never decides a page's kind, and it contains no click.

---

## Part I — `auth-sync.mjs` and `longform.mjs`

### I.1 `auth-sync.mjs` — copying a session, in one direction only

**Why two profiles exist.** Chromium takes an exclusive lock on a user data
directory, and two processes on one directory corrupt it. The thing being corrupted
would be the store holding your real ATS session cookies; losing those turns every
gated board into a login wall and re-establishing them is manual work on a dozen
sites. So the directories are split by role, and the split is one-directional:

| directory                  | owner                                                                                     |
| -------------------------- | ----------------------------------------------------------------------------------------- |
| `.playwright-mcp/profile`  | MCP-owned. The **only** place a login happens. Nothing in this script writes to it, ever. |
| `.playwright-auto/profile` | the unattended runner's. Disposable by design: if it is wrong, delete it and re-sync.     |

This script is the only bridge, it runs one way, and it is run **explicitly** —
never on a schedule, because a copy that fires unattended is a copy that will
eventually fire while a browser is open.

**Liveness detection is a mitigation, not a proof, and the file says so.** There is
no portable, sound test for "is a Chromium using this directory". Three signals are
OR-ed, and any one of them refuses the copy:

| signal               | how it works                                               | where it is sound                                                                                                                |
| -------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| singleton artifacts  | `SingletonLock` and friends exist                          | POSIX. **They do not exist on Windows**, so on this machine this leg finds nothing, and that is expected rather than reassuring. |
| exclusive-open probe | `fs.openSync(p, "r+")` fails with `EBUSY`/`EPERM`/`EACCES` | Windows. On Linux file locking is advisory and this never fires.                                                                 |
| recent mtime         | a candidate file changed within 90 seconds                 | everywhere, weakly. **A browser open and untouched for two minutes passes it.** This is the honest weak point.                   |

It is deliberately **not** a PID probe. `lock.mjs` had one and it was deleted, not
disabled: a recorded process id is reused by the operating system, so "is that pid
alive" answers a question about a number rather than about the resource.

**What is copied is an allowlist, and that is the most important change in the
file.** It used to be a denylist of caches, which was wrong the way denylists are
always wrong: it answered "what is too big to copy?" when the question is "what does
a session need?". Measured in the real MCP profile, everything the denylist did not
name came across, including `Login Data` (saved site passwords), `Web Data`
(autofill profiles and payment cards), `History`, `Top Sites` and
`trusted_vault.pb` — into a profile whose entire purpose is to visit hundreds of
third-party application forms unattended.

What a session actually needs, and nothing else:

| file                         | why                                                                                                                                                                                                                        |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Local State`                | holds `os_crypt.encrypted_key`. Chromium encrypts cookie **values** with a key stored here, not in the cookie file — copy the cookies without it and every cookie decrypts to garbage, which reads as a silent login wall. |
| `<profile>/Network/Cookies`  | the session itself (modern layout)                                                                                                                                                                                         |
| `<profile>/Cookies`          | the pre-M96 location, kept because an old profile still has it there                                                                                                                                                       |
| `<profile>/Local Storage/**` | the database many ATS single-page apps keep auth state in rather than in a cookie                                                                                                                                          |
| `<profile>/Preferences`      | **rewritten, not copied**                                                                                                                                                                                                  |

`minimalPreferences()` synthesises a Preferences file rather than copying the real
one, and the forced values are the point: the auto profile has the password manager
and autofill turned **off**, so it cannot re-accumulate the very files the allowlist
just excluded. One value is carried over — `intl.accept_languages`, and only if it
is short — because a session cookie replayed from a browser advertising a different
`Accept-Language` is exactly the shape a fraud system flags.

Three more guards worth naming:

- **`assertSyncDirection`** refuses to write inside `.playwright-mcp/`, outside the
  project, or inside `profile/` or `jobs/` — whatever the caller passes.
- **The gitignore check.** A sync creates a second directory with the same cookies
  in it. At the time this was written `.playwright-auto/` was not ignored, so the
  first successful sync would have armed `git add -A` to commit your live sessions.
  That entry belongs to somebody else, so this script does not add it — it refuses
  to run until it is there. (It is there now.)
- **Staged and swapped, then re-probed.** The copy goes into a sibling staging
  directory; liveness is probed a third time immediately before the swap, because a
  browser opened during a copy that takes a minute is exactly what a single up-front
  check misses. A torn snapshot is discarded and the previous auto profile is left
  untouched.

```bash
node scripts/apply/auth-sync.mjs --check   # probe liveness, copy nothing
node scripts/apply/auth-sync.mjs           # do the copy
```

### I.2 `longform.mjs` — written, argued, and wired to nothing

Some form fields want **prose**: "Why do you want to work here?", "Describe a
project you are proud of (500 words minimum)". They are the highest-signal fields on
the form, and the fact base cannot answer an open-ended prompt, so today they
resolve `UNKNOWN` and defer as one more anonymous "a human must answer this" — after
which you write 500 words by hand out of facts that were already in
`profile/profile.yaml`.

This module is the deterministic quarter of a four-way split designed to fix that:

```
deterministic (here)   is this a prose prompt, and how long must it be?
model (the skill)      the draft
deterministic again    verify-claims R4-R6 over the draft: every number, date and
                       technology in it must already exist in the fact base
the user               approval, before anything is typed into a form
```

The detector is **structural, not a word list**: a `<textarea>` _is_ the signal,
because a board renders one when it expects sentences and would have used an input
for a datum. So there is no list of "describe / tell us / why / explain" for the
26th rewording to walk through. A plain text input only qualifies when the form
states a length demand in words, or in at least 120 characters (below that, a
character demand is a format rule such as "min 5 characters", not a request for
prose).

```js
export function parseLengthDemand(text)  // -> {min, max, unit:"words"|"chars"} | null
export function longFormPrompt(field)    // -> { need, why } | null
export function describeNeed(need)       // -> "200-500 words"
export function draftShortfall(draft, need) // -> the reason it falls short, or null
```

Ranges are parsed **first** (`"200-500 words"`, `"200 to 500 words"`), because the
single-bound patterns would report one number and drop the other, and a draft
written to the wrong bound is rejected by the form. A "range" whose numbers run
backwards is not a range, and falls through rather than being invented. A minimum
above a maximum is a contradiction in the page's own words, and both are reported so
a human can see it.

**Worked example.** Field
`{ t: "textarea", l: "Why do you want to work at Acme?", h: "Please write 200-500 words." }`
→ `parseLengthDemand` matches the range → `{min: 200, max: 500, unit: "words"}` →
`longFormPrompt` returns `{ need, why: "the form asks for 200-500 words" }`. A
412-word draft → `draftShortfall` returns `null`. A 150-word draft →
`"150 words, and the form asks for at least 200"`.

> **Known defect (2026-08-05 audit).** `longform.mjs` is tracked in git, carries a
> 35-line header arguing carefully why it is lawful under hard rule 1, and is
> **imported by nothing**. A repository-wide search for `longform`,
> `longFormPrompt`, `draftShortfall` and `parseLengthDemand` returns only the file
> itself and documentation. There is no `tests/apply/longform.test.mjs`, so
> `CLAUDE.md`'s "new features need tests" is unmet. Either wire it — `fill-plan.mjs`
> emits a `compose` defer carrying the parsed length demand, the skill drafts,
> `verify-claims` and `draftShortfall` gate the draft, you approve it — or delete it.
> Leaving it is the worst option, because a reader assumes prose prompts are handled
> and they are not.

There is a second, quieter obstacle worth knowing if you decide to wire it. A
related audit finding records that `field-cache.mjs` stores only
`{t, l, req, opts, optsTruncated, optsTotal, sel, via}` per field — it **drops `h`**,
the help text — and `longFormPrompt` reads `` `${field.l} ${field.h}` ``, which is
exactly where "500 words minimum" lives. Storing `h` would let the pipeline say,
before any browser opens, that a board asks for an essay. That change needs a
`CACHE_VERSION` bump (4 → 5), which discards every remembered form shape.

---

## Part J — Troubleshooting a fill

### J.1 Start with the report, not the browser

Every fill produces one object. Read it in this order:

1. **`failed` and `failures`** — did anything fail outright?
2. **`verify.errors`** — did the form itself say something was wrong? This is the
   highest-authority signal there is.
3. **`verify.mismatch` and `verify.requiredEmpty`** — did the page end up holding
   what we planned?
4. **`revealed`** — did the fill create a required field nobody knew about?
5. **`uploads`** — which file reached which input? Never answer that from `ok`.
6. **`reconciled`** — was anything promoted from failure to success? If so, the page
   is remounting under you, and that is worth knowing even when the outcome was
   fine.
7. **`deferred` and `defer`** — these are **not failures**. They are the planner
   saying the fact base cannot answer something, and they belong to
   [`./07-apply-planning.md`](./07-apply-planning.md).

### J.2 Reading `report.failures`

Each entry is `{ k, how, why, stale? }`. `k` is the scanner's stamp, `how` is the
verb that was attempted, `why` is a sentence capped at 140 characters, and `stale`
is present only when the failure was a detached element that the verify pass then
declined to overturn.

To turn `k` into something you recognise, look up the same key in `plan.items` or
`plan.defer` and read its `label`. `submitReadiness` does that for you when it
builds its refusal sentence, which is why the gate says `Résumé (f10)` and not
`f10`.

| `why` starts with…                                                    | what happened                                                                                 | what to do                                                                                                                                                  |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `plan built for … but page is …`                                      | The URL guard refused. Nothing was touched.                                                   | Re-scan the page you are actually on and rebuild the plan.                                                                                                  |
| `this plan expects … and found N`                                     | The page guard refused: a selector the planner said must be present is not, or is duplicated. | You are on a different step of the form. Re-scan.                                                                                                           |
| `not one of the plan's N fields exists on this page`                  | Same URL, different form.                                                                     | Re-scan. This is normal on a multi-page form that never changes its URL.                                                                                    |
| `no unique element for <sel>`                                         | The selector matched zero or two elements.                                                    | The board changed its markup, or the scan is stale. Re-scan; if it persists, the field's `sel` is not unique and the scanner needs to pick a different one. |
| `… after a stale-locator retry`                                       | The element kept vanishing and did not come back.                                             | The form is remounting hard. See J.4.                                                                                                                       |
| `unreadable element: …`                                               | `kindOf`'s evaluate threw.                                                                    | Almost always staleness. See J.4.                                                                                                                           |
| `refusing to touch a <button> — not a form control`                   | The plan aimed a fill verb at something that is not a control.                                | A plan problem. The scanner typed the control as fillable when it is a widget.                                                                              |
| `unknown verb <how>`                                                  | The plan carries a verb the engine does not have.                                             | A plan problem, and a serious one — nothing should produce this.                                                                                            |
| `after <strategy> the field reads "…"`                                | Every combo strategy ran and none committed the value.                                        | Either the value is not on the board's list, or the widget needs a strategy order this adapter does not have. See J.5.                                      |
| `typed the first 800 of N characters`                                 | A rich-text box refused both fast rungs.                                                      | Paste the remainder by hand. The report tells you exactly how much landed.                                                                                  |
| `nothing on this page tells its N empty file inputs apart`            | The ambiguity refusal (D.4).                                                                  | Attach the documents by hand. Then consider whether an adapter's `fileFields` can name them.                                                                |
| `no file input left for /<pattern>/`                                  | Every file input was already claimed or already held a file.                                  | Check whether the board pre-populated an input, or whether the plan holds two uploads for one slot.                                                         |
| `upload-readback-empty: …`                                            | The input is still on the page and holds nothing (D.6).                                       | Attach by hand. If the **same board** produces this on every application, it is a board that reads files by XHR — see J.6.                                  |
| `upload-wrong-file: …`                                                | The input holds a file this run did not send it.                                              | Attach by hand and check the adapter's `fileFields` against the board's real labels.                                                                        |
| `page N reported … as something other than a list`                    | A merge-level failure: one page's report was malformed.                                       | The fill stage on that page did not return what it should have. Check for an exception swallowed upstream.                                                  |
| `page N ran a fill but reported no verify pass while other pages did` | Mixed measurement coverage across a multi-page walk.                                          | A partly-measured form is not a measured one. Re-run the walk.                                                                                              |
| `locator.<something>: Timeout 2500ms exceeded`                        | Playwright's own message: the element never became actionable.                                | Usually disabled, `readonly`, covered by an overlay, or off-screen behind a sticky element.                                                                 |

### J.3 Board problem, plan problem, or fact-base problem?

Three different things fail, and the fixes are in three different files.

| symptom                                                                                                                                 | most likely                    | where the fix is                                                             |
| --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ | ---------------------------------------------------------------------------- |
| Deferred fields, `UNKNOWN` statuses, "needs a human"                                                                                    | **fact base**                  | `scripts/profile/save-answer.mjs` — answer the question once and bank it.    |
| Guard refusals, "no unique element" on many fields at once, `unknown verb`, a fill aimed at a button                                    | **plan**                       | Re-scan; then `fill-plan.mjs` / the scanner.                                 |
| One board, every time: the same combo strategy fails first; the same document lands in the wrong slot; the same upload reads back empty | **board**                      | An **adapter** (Part F). This is the lawful way to make a board work better. |
| Failures that move around between runs; `reconciled` entries; "not attached to the DOM"                                                 | **board timing** (a remount)   | Nothing to fix. Verify the result and re-run. See J.4.                       |
| The page's own red text in `verify.errors`                                                                                              | **the form disagrees with us** | Read the message. It is the most reliable signal on the page.                |

A quick discriminator: **failures that are the same every run point at a plan or an
adapter; failures that move point at timing.**

### J.4 When a form remounts under you

Symptoms: `"Element is not attached to the DOM"` in `failures`, entries in
`reconciled`, different fields failing on each run.

What to check, in order:

1. **Did it happen right after an upload?** That is the expected case, and the
   engine is built for it: uploads run first, the retry absorbs one remount, and the
   verify pass settles the rest. If the values are on the page, the run is fine.
2. **Are values landing anyway?** Look at `verify.landed` and `reconciled`. A field
   in `reconciled` failed and then turned out to be filled.
3. **Is it remounting on a timer?** Three failed attempts with growing backoff and
   the value **not** on the page is the signature. No retry count fixes that; the
   form has to be filled with the page in a quieter state, or by hand.

### J.5 When a dropdown will not take a value

1. **Is the value actually on the board's list?** Look at the scan's `opts` for that
   field. If the list is truncated (`optsTruncated: true` with `optsTotal` well above
   40), the answer may exist past the cut.
2. **Which strategies ran?** The `why` names the last one tried. If `type-enter`
   left the field reading the typed text, the widget is a filter that never
   committed — that is C.7.2's case, and the readback is doing its job.
3. **Does the board need a different order?** Try the generic order (`type-click`
   first) mentally against the widget's behaviour: does its list filter as you type?
   Does Enter commit the highlighted row, or something else? Then write it into an
   adapter with the measurement in a comment.
4. **Is the control a typeahead with no list at all?** Then it needs a
   `typeaheadFields` declaration, not a strategy change (C.8).

### J.6 When an upload keeps reading back empty on one board

One `upload-readback-empty` on one job is the ordinary failure — attach the file by
hand and move on. **The same tag on every application to the same board** is a
different fact: that board reads the file out of the input into its own uploader and
resets `input.value`, so a working upload looks empty to the DOM. That is a board
behaviour, it is visible in your run log precisely because the tag is countable, and
the answer is an adapter — deterministic knowledge about that board — not weakening
the check for everybody.

### J.7 Reproducing without touching a real employer

The fixtures under `tests/fixtures/boards/` are a small HTTP server serving replicas
of the real boards, and the engine tests drive them end to end:

```bash
node --test tests/apply/fill-page.test.mjs        # the engine's contract and sandbox rules
node --test tests/apply/combo-commit.test.mjs     # the two readbacks agree
node --test tests/apply/upload-import-control.test.mjs   # upload routing and the import-control skip
node --test tests/apply/oracle-orc.test.mjs       # the option reader against the ORC fixture
```

Run one file while you iterate, and `npm test` once before committing. Remember that
`npm test` is the count-asserting gate (a bare `node --test` exits 0 on an empty
run), and that `node --test <directory>` does not recurse on Node 24 — use the quoted
glob form.

The loopback guard in `browser.mjs` means these cannot accidentally reach a real
board.

---

## If you were rebuilding this

Four decisions carry the weight, and each one has a naive version that works on your
test page and fails silently on a real board.

**1. Never let "the call did not throw" stand in for "the page holds the value".**
Every serious incident in this file has that shape. `setInputFiles` returned, so the
résumé must be attached — it was not, for 7 runs out of 7. The combo box shows the
text I typed, so the dropdown must be set — the backing store was empty on ten
fields at once. Build the readback **first**, make it read what the form would
_send_ rather than what the box _shows_, and let the fill report be a claim the
readback can contradict.

**2. When evidence is ambiguous, pick your direction of error deliberately and write
down why.** The upload readback cannot distinguish a dropped file from a board that
clears its own input. There is no reading that gets both right. The costs are not
symmetric — one is a question you answer in ten seconds, the other is an application
sent in your name with no résumé — so the code fails closed, states the false
positive plainly, and refuses the three tempting ways to weaken it. Doing this well
means writing the asymmetry into the comment, not just the conclusion.

**3. A gate cannot refuse evidence it was never handed.** The engine learned to
demote an unattached upload to a failure, and that failure went nowhere for a whole
phase because the function that merged multi-page reports rebuilt them as
`{ uploads, revealed }`. Meanwhile another file's comment claimed to gate on
failures and mismatches. If you build a pipeline of producers and consumers, the
plumbing between them is a place bugs hide **in silence** — and "absent" must never
be allowed to read as "zero", because that is how a missing measurement becomes a
clean bill of health nobody wrote.

**4. Put board knowledge in data, and keep behaviour uniform.** The adapter
directory is the whole reason this system can learn a new board in an afternoon
without touching the engine. The rule that makes it work is the boring one: an
adapter is knowledge, never behaviour — a string in, a string out, nothing opened,
nothing decided. The moment an adapter is allowed to _do_ something, every board
becomes a special case and the engine stops being testable.

And one smaller habit that pays constantly: **wait for a condition with a ceiling,
never for a flat duration.** `waitFor({ state: "detached", timeout: 1000 })` and
`waitForTimeout(1000)` have the same worst case and completely different average
cost. The exceptions here are deliberate and argued in comments — the 500 ms inside
`type-enter` stands for a condition the DOM genuinely does not expose — and the two
that are _not_ argued (the 450 ms before verify, the 220 ms after opening a combo)
are exactly the ones the benchmark names as removable.

---

## Where to go next

**The two halves either side of this one:**

- [`./06-apply-scanning.md`](./06-apply-scanning.md) — the scanner that produces the
  form description this engine fills, and a longer treatment of the DOM, CSS
  selectors, CDP and the CSP nonce problem.
- [`./07-apply-planning.md`](./07-apply-planning.md) — `fill-plan.mjs`: how a scan
  plus the fact base becomes the plan, every reason a field is deferred, and
  `submitReadiness` in full.

**Where these reports are consumed:**

- [`./09-auto-runner.md`](./09-auto-runner.md) — `walkPages`, `mergePages`, the
  browser pool and the per-job state machine.
- [`./10-auto-safety.md`](./10-auto-safety.md) — the trust gate, the submit gate,
  the post-click classifier that `capture-post-submit.mjs` feeds, and the breaker.
- [`./11-record-and-profile.md`](./11-record-and-profile.md) — how a sent
  application becomes a record, and `save-answer.mjs`, the only way anything enters
  the fact base.

**For the rules that shape every decision here:**

- [`../guide/07-safety-model.md`](../guide/07-safety-model.md) — hard rule 0, hard
  rule 1, and hard rule 6 in full.
- [`../guide/05-architecture.md`](../guide/05-architecture.md) ·
  [`../guide/08-glossary.md`](../guide/08-glossary.md)

**For running and fixing it:**

- [`../operate/01-commands.md`](../operate/01-commands.md) ·
  [`../operate/02-recipes.md`](../operate/02-recipes.md) ·
  [`../operate/03-troubleshooting.md`](../operate/03-troubleshooting.md) ·
  [`../operate/04-config-reference.md`](../operate/04-config-reference.md)

**For the tests that pin everything above:**
[`./14-tests.md`](./14-tests.md) — `fill-page`, `combo-commit`,
`upload-import-control`, `oracle-orc`, `ashby-typeahead`, `click-surface`, and the
security suites.

**For the full list of what is broken:**
[`../audit-2026-08-05.md`](../audit-2026-08-05.md) — 247 findings with evidence. The
defect notes in this document are the ones that touch these ten files, not a summary
of the whole report.
