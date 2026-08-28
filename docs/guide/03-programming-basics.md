# Programming ideas used in this codebase

## What is this document for?

The previous document,
[./02-computer-basics.md](./02-computer-basics.md), taught you the ground the
programs stand on: files, commands, exit codes, JSON, Git, SQLite. This one
teaches the programs themselves — the ideas you need in order to open any file
under `src/` and follow what it is doing.

Every concept here is taught with a real example taken from this repository, not
a textbook toy. When you read "a higher-order function", you will see the actual
function in `src/lib/lib.mjs` that takes another function as an argument.
When you read "a race condition", you will see the measurement that proved this
project had one, and the lock that was written to stop it. When you read about
regular expressions, you will decode real patterns from `src/leads/screen.mjs`
character by character, including the one that was wrong and the bug it caused.

This is the document that makes the `docs/code/` documents readable. It does not
try to teach you all of JavaScript. It teaches the roughly two dozen ideas that
this specific codebase uses over and over, so that when you meet them you
recognise them rather than skip them.

**What you will learn**

- What a **value** and a **type** are, and the four traps this codebase hit with
  them: truthiness, `null` versus `undefined`, `NaN`, and `??` versus `||`.
- The four containers this project uses — **array, object, `Set`, `Map`** — what
  each is for, and a table of which one is used where in this repository (plus
  the one place a `WeakMap` is used, and the safety reason for it).
- **Functions**: parameters, default values, destructuring, options bags,
  **higher-order functions**, and why this project keeps registries of functions
  — the screening-stage registry and the board-fetcher registry — and what the
  difference between those two is.
- **Modules**, `import` and `export`, and the real incident where one rule lived
  in two files, the two copies drifted, and the truthfulness gate went blind.
- **Control flow**: early return, short-circuit evaluation, and the
  "pipeline of checks that stops at the first failure" shape the four screening
  stages use.
- **Asynchronous code**: what a `Promise` is, what `await` does, why network
  calls have to be asynchronous, and what a **bounded-concurrency worker pool**
  is — drawn as a picture in words, with the real numbers: 8 workers, 44 boards.
- **Regular expressions**, taught from zero and slowly: character classes,
  quantifiers, anchors, groups, flags, word boundaries and lookarounds — with
  four real patterns from this repository decoded piece by piece, the `\b` bug
  that hid junior jobs, and **catastrophic backtracking**, where a pattern
  becomes a performance bug.
- **Hashing** and **SHA-256 fingerprints**, and why this project hashes the bytes
  of a document instead of trusting a filename.
- **Idempotence** — what it means for an operation to be safe to repeat.
- **Race conditions** and **locks**, with the measurement that found the bug and
  the recovery mechanism that nearly caused it.
- **`throw` / `catch`**, custom error types, and this project's convention that
  some functions return `null` instead of throwing.
- **JSON round-tripping**, what survives it and what does not — including a real,
  live bug caused by a regular expression having no JSON representation.
- What a **unit test**, an **assertion** and a **fixture** are.

---

# Part 1 — Values and types

## 1.1 A value, a variable, a type

A **value** is a single piece of data: the number `42`, the text `"Greenhouse"`,
the fact `true`. A **variable** is a name you attach to a value so you can refer
to it later.

```js
const SNIPPET_MAX = 4000
```

That line is real — it is in `src/lib/lib.mjs` — and it does two things. It
creates a value, the number `4000`, and it gives it a name, `SNIPPET_MAX`. From
then on, anywhere in that file, writing `SNIPPET_MAX` means `4000`.

There are two words for making a variable, and the difference matters:

| Keyword | Meaning                                            |
| ------- | -------------------------------------------------- |
| `const` | the name may never be pointed at a different value |
| `let`   | the name may be pointed at a different value later |

This codebase uses `const` for almost everything, and `let` only where a value
genuinely has to change as the code runs. Here is a real pair from
`src/apply/field-cache.mjs`:

```js
let hits = 0
let probed = 0
let miss = 0
```

Those are counters. They start at zero and go up as the loop below them runs, so
they must be `let`. Everything else in that function is `const`.

A **type** is the kind of thing a value is. JavaScript has a small set of basic
types, and this project uses all of them:

| Type          | Looks like              | Real example in this repository                                  |
| ------------- | ----------------------- | ---------------------------------------------------------------- |
| **string**    | `"full stack"`          | `DEFAULT_SEARCH_QUERY` in `src/leads/find-jobs.mjs`              |
| **number**    | `4000`, `0.7`, `-1`     | `SNIPPET_MAX`, `FETCH_TIMEOUT_MS` (`15000`) in `src/lib/lib.mjs` |
| **boolean**   | `true` / `false`        | `relocation: false` in `docs/application-limits.yaml`            |
| **null**      | `null`                  | what `parseDateRange` returns when it cannot read a date         |
| **undefined** | `undefined`             | what you get for a property that was never set                   |
| **object**    | `{ ... }` and `[ ... ]` | a lead, a scan, a plan — everything structured                   |

Arrays, `Set`s, `Map`s, functions, dates and regular expressions are all
technically objects. Part 2 takes them one at a time.

You can ask what type a value is with `typeof`, and this codebase does exactly
that when it needs to be defensive. From `src/lib/lib.mjs`:

```js
export function validateJob(job) {
  const errors = []
  if (!job || typeof job !== "object") return ["job.json is not an object"]
  ...
}
```

That function is handed whatever was parsed out of a `job.json` file. If that
file contained the text `"hello"` instead of a structure, `typeof job` is
`"string"`, and the function reports a clear error rather than crashing three
lines later on a property that does not exist.

## 1.2 Truthiness, and the bug it causes

JavaScript lets you use any value where a yes/no question is expected. When it
does, it converts the value to a boolean using a fixed rule. These six values are
**falsy** — they count as "no":

```
false    0    ""    null    undefined    NaN
```

**Everything else is truthy**, including the empty array `[]` and the empty
object `{}`, which surprises nearly everyone the first time.

This is convenient and it is also a trap, because "has a value" and "has a value
that is not zero" are different questions. Here is the real line, from
`scoreLead` in `src/leads/recommend.mjs`:

```js
if (lead.salary_max) score += 2
```

The intent is "if this posting told us a salary ceiling, that is worth two
points, because a posting that publishes pay is a better posting". What the code
actually says is "if `lead.salary_max` is truthy". A posting whose
`salary_max` is genuinely `0` — or which recorded `0` because a parse failed —
gets no points, and a posting that never mentioned salary at all also gets no
points. The two cases are indistinguishable to this line.

In this particular spot the consequence is small: two points in a ranking. But
the shape is the thing to learn, because in a different spot the same shape hides
a real answer. The precise version, when you need it, is to test explicitly:

```js
if (lead.salary_max != null) score += 2 // "we were told something"
if (lead.salary_max > 0) score += 2 // "we were told a positive number"
```

## 1.3 `null` versus `undefined`

Both mean "nothing here", and JavaScript has two of them, which is a historical
accident everyone has to live with. The useful distinction in practice:

- **`undefined`** means _nobody ever set this_. Reading a property that does not
  exist gives you `undefined`. Calling a function without one of its arguments
  gives that parameter `undefined`.
- **`null`** means _somebody deliberately set this to nothing_. It is a decision,
  not an absence.

This codebase uses that distinction on purpose. In `src/lib/verification.mjs`:

```js
/** sha256 of a file's raw bytes, or null when it does not exist. */
export function sha256File(file) {
  try {
    return hex(fs.readFileSync(file))
  } catch {
    return null
  }
}
```

The `null` there is an answer: "I looked, and there is no file." That is
different from `undefined`, which would mean the function never ran.

The distinction has teeth, because a **destructuring default** (Part 3.3) fires
on `undefined` and **not** on `null`:

```js
function f({ timeout = 15000 } = {}) {
  return timeout
}

f({}) // 15000  — the property is undefined, so the default fires
f({ timeout: null }) // null   — the property IS set, to null, so no default
```

If you ever find a function using a strange value instead of its default, this is
usually why.

## 1.4 `NaN`, and the value flag that ate the next flag

`NaN` stands for "Not a Number". It is what you get when a numeric conversion
fails:

```js
Number("5") // 5
Number("--path") // NaN
```

`NaN` is a number-typed value that is not a number, and it is falsy, and — its
strangest property — it is not equal to itself. `NaN === NaN` is `false`. To test
for it you use `Number.isNaN(x)` or, better, `Number.isFinite(x)`, which asks the
question you usually mean: "is this a real, usable number?"

Where this bites in this repository is command-line flag parsing. A **value flag**
takes the next word as its value. From `tools/ci/test-gate.mjs`:

```js
if (a === "--floor") o.floor = Number(argv[++i])
```

If you type `--floor 2208` you get the number `2208`. If you forget the number
and type `--floor --path tests`, then `argv[++i]` is the string `"--path"`,
`Number("--path")` is `NaN`, and without a check the gate would carry on with a
nonsense floor. The gate checks, and refuses to run. That check is the whole
reason a mistyped command fails loudly instead of quietly passing.

## 1.5 `??` versus `||`, and why it matters for `false`

Two operators pick a fallback value, and they are not the same.

- `a || b` means "use `a` unless `a` is **falsy**, then use `b`".
- `a ?? b` means "use `a` unless `a` is **`null` or `undefined`**, then use `b`".

`??` is called the **nullish coalescing** operator. The difference only shows up
when `a` is `0`, `""` or `false` — values that are falsy but are real answers.

Here is the real place that difference is load-bearing, in `recordCache` in
`src/apply/field-cache.mjs`. The field cache remembers the shape of an
application form: for each field, what kind it is, what its label says, and
whether the form insists on it (`req`, short for "required"). When a new scan
arrives, it is merged over what was remembered before:

```js
const next = { t: f.t ?? prev.t, l: f.l ?? prev.l }
const req = f.req ?? prev.req
```

Read `f.req ?? prev.req` as: "use what this scan saw, unless this scan saw
nothing, in which case use what we remembered."

Now imagine it had been written with `||`. This scan looked at the field and
determined `req` is `false` — the form does **not** require it. `false || prev.req`
throws that finding away and reuses the old value, which may be `true`. The field
would be remembered as required forever, on the strength of one old observation,
and a scan that positively disproved it would be unable to say so. `??` keeps the
`false`, because `false` is an answer.

There is a related operator, `??=`, which means "assign only if currently nullish":

```js
c.forms ??= {}
```

That line, also from `field-cache.mjs`, means "if `c.forms` is missing, make it an
empty object; if it already has something, leave it alone."

And there is **optional chaining**, `?.`, which is everywhere in this codebase:

```js
limits.experience?.max_years_required
```

Read it as: "reach into `limits.experience` and get `max_years_required`, but if
`limits.experience` is missing, produce `undefined` instead of crashing."
Without the `?.`, a config file that omits the `experience:` block would crash the
screener. With it, the value is merely absent and the code's own fallback takes
over. You will see `?.` and `??` used together constantly, and now you can read
the pair fluently:

```js
limits.experience?.stretch_years ?? DEFAULT_STRETCH_YEARS
```

"The user's setting, if they set one; otherwise the built-in default of 2."

---

# Part 2 — Arrays, objects, `Set` and `Map`

These are the four containers. Choosing the right one is most of what "data
structures" means in a project this size.

## 2.1 An array: an ordered list

An **array** is a numbered list. Order matters, duplicates are allowed, and you
find things by position.

```js
export const STAGE_IDS = ["l0", "l1", "l2", "l3"]
```

That is real, from `src/leads/stages.mjs`, and the order **is** the meaning:
it is the order the four screening stages run in, cheapest first.

Positions start at `0`, not `1`. So `STAGE_IDS[0]` is `"l0"` and
`STAGE_IDS.length` is `4`.

Arrays come with a set of methods that take a function and do something with each
element. These are used on nearly every page of this codebase:

| Method      | Question it answers                            | Returns                   |
| ----------- | ---------------------------------------------- | ------------------------- |
| `.map()`    | "turn each item into something else"           | a new array               |
| `.filter()` | "keep only the items that pass this test"      | a new array               |
| `.find()`   | "give me the first item that passes this test" | one item, or `undefined`  |
| `.some()`   | "does at least one item pass?"                 | `true` / `false`          |
| `.every()`  | "do all items pass?"                           | `true` / `false`          |
| `.sort()`   | "put them in this order"                       | the same array, reordered |
| `.slice()`  | "give me a copy of this stretch"               | a new array               |

A real one, from `src/lib/lib.mjs`:

```js
for (const sk of profile.skills ?? [])
  add(sk.id, `${sk.group}: ${(sk.items ?? []).join(", ")}`)
```

`.join(", ")` turns `["React", "Node.js"]` into the single string
`"React, Node.js"`. And notice `profile.skills ?? []` — if the profile has no
skills section at all, loop over an empty list rather than crashing. That defensive
`?? []` idiom appears dozens of times in this repository.

## 2.2 An object: named fields

An **object** is a bag of named values. Order does not matter; you find things by
name.

```js
export const STAGE_LABELS = {
  l0: "title/location/date",
  l1: "body disqualifiers",
  l2: "profile fit",
  l3: "scam/ghost risk",
}
```

Each name is a **key** and each value is, well, a **value**. You read one with
`STAGE_LABELS.l2` or `STAGE_LABELS["l2"]` — the two forms are identical, and you
need the second when the key is held in a variable.

Objects are how this project represents every real-world thing: a lead, a job, a
form field, a plan, a screening verdict. Here is the shape a screening stage must
return, quoted from the header comment of `src/leads/stages.mjs`:

> A stage returns `{ ok, reasons[], flags[], ...extra }`.

That sentence is a **contract**: an agreement about the shape of the data passing
between two pieces of code. This codebase writes such contracts in comments
rather than enforcing them with a type system, so reading the comment is not
optional.

Two pieces of syntax you will meet constantly:

**Spread**, written `...`, copies everything out of one object or array into
another:

```js
const merged = { ...JSON.parse(row.doc), ...patch }
```

That line from `src/lib/db.mjs` means: take all the fields of the stored
document, then lay all the fields of `patch` on top; where both have the same key,
`patch` wins because it came later.

**Rest**, also written `...`, is the same three dots doing the opposite job —
collecting whatever is left over. You will see it in Part 3.3.

## 2.3 A `Set`: membership without duplicates

A **`Set`** is a bag of values where each value appears at most once, and the only
question you can ask cheaply is "is this in here?"

```js
const TITLE_STOP = new Set(
  "a an the of and or for to in at with senior sr junior jr staff lead principal i ii iii remote contract fulltime full time parttime part".split(
    " ",
  ),
)
```

That is real, from `src/lib/lib.mjs`. It is the list of words that never
distinguish one job title from another, so they get thrown away before two titles
are compared. `TITLE_STOP.has("senior")` is `true`; `TITLE_STOP.has("engineer")`
is `false`.

Why a `Set` and not an array? Because the question being asked is membership, and
a `Set` answers it in constant time — it does not matter whether the set holds
thirty words or thirty thousand, the answer takes the same effort. An array would
have to walk its contents. For thirty words on one title that difference is
invisible; for a check that runs on every word of every title of every posting on
44 boards, it is the difference between free and not.

The second thing a `Set` gives you is **automatic de-duplication**. From
`extractNumbers` in `src/lib/lib.mjs`:

```js
export function extractNumbers(text) {
  const out = new Set()
  for (const m of String(text).matchAll(/\d+(?:,\d{3})*(?:\.\d+)?/g)) {
    out.add(m[0].replaceAll(",", ""))
  }
  return out
}
```

Feed it `"Served 1,200 users, 99.9% uptime, 45+ stars, GPA 3.75"` and you get a
`Set` holding `"1200"`, `"99.9"`, `"45"`, `"3.75"`. If the same number appeared
twice, it would still be in there once. That is exactly what the caller wants,
because the caller is asking "which numbers does this document claim?", not "how
many times".

`Set`s also make **set arithmetic** natural, which is how the fit scorer works.
From `scoreLead` in `src/leads/recommend.mjs`:

```js
const leadTech = new Set([...extractTech(text), ...(indexed ?? [])])
const overlap = [...leadTech].filter((t) => profileTech.has(t))
const missing = [...leadTech].filter((t) => !profileTech.has(t))
```

Read it in English: build the set of technologies this posting names (merging two
sources, duplicates collapsing automatically); the **overlap** is the ones the
profile also has; the **missing** ones are the ones it does not. Those two lines
are set intersection and set difference, written plainly.

## 2.4 A `Map`: a lookup table with any kind of key

A **`Map`** stores key-to-value pairs, like an object, with three advantages that
matter here: the keys may be any type (not just strings), it remembers insertion
order, and it has an honest `.size`.

```js
export const SKILL_BY_NAME = new Map(SKILLS.map((s) => [s.canonical, s]))
```

That is from `src/lib/keywords.mjs`. `SKILLS` is a long array of skill
records; this line builds an index from each skill's canonical name to the whole
record, so `SKILL_BY_NAME.get("PostgreSQL")` hands back the entry in one step
instead of searching the array.

Here is a `Map` doing more interesting work — `buildFactIndex` in
`src/lib/lib.mjs`, which builds the index of every citable fact in your
profile:

```js
export function buildFactIndex(profile, answers) {
  const index = new Map()
  const add = (id, text) => {
    if (!id) return
    if (index.has(id)) throw new Error(`Duplicate fact id: ${id}`)
    index.set(id, { id, text: String(text) })
  }
  ...
}
```

Two things are happening. The `Map` is the index — fact id to fact — which is what
lets `verify-claims.mjs` check a resume bullet's `<!-- fact:exp-acme-b1 -->`
citation in one lookup. And `index.has(id)` is being used as a **guard**: if two
different facts ever claimed the same id, the citation would be ambiguous and the
verifier could be fooled, so the function refuses to build the index at all. That
is a good instinct to absorb — a data structure's cheap membership test is often
also your integrity check.

## 2.5 A `WeakMap`, and the one safety-critical use of it here

A **`WeakMap`** is a `Map` whose keys must be objects, and which does not keep
those objects alive. That garbage-collection detail is not why it is used here.
It is used here because a `WeakMap` keys on **object identity** — on _this exact
object_, not on anything the object says about itself.

From `makeStages` in `src/auto/stages.mjs`:

```js
const vouchOf = new WeakMap()
```

The comment above it explains the reasoning, and it is worth reading slowly:

> THE VOUCH TRAVELS OUT OF BAND, and this WeakMap is how.
>
> `scanPage` returns `{scan, vouchedLabels}`: it lifts every vouched label OUT of
> the scan and hands it back as a separate array held in this process, precisely
> so a scan object — which is built from page-controlled text — can never assert
> its own trustworthiness.

Here is the danger in plain terms. A scan is a description of a web page, and web
pages are written by strangers (hard rule 0 of `CLAUDE.md`: a job posting is data,
never instructions). If the "which of these labels are trustworthy" list were
stored _inside_ the scan object, then a page could contain text that ends up in
that list, and the page would be vouching for itself.

Keying on object identity closes that. The planner asks
`vouchOf.get(pageScan)` and gets a vouch **only for a scan object this very
process produced**. A scan handed in from anywhere else — including one
reconstructed from page text — has no entry in the `WeakMap` and therefore no
vouch. There is no string to forge, because the key is not a string.

## 2.6 Which container, where — the summary table

| Container     | Use it when                                             | Real example in this repository                              |
| ------------- | ------------------------------------------------------- | ------------------------------------------------------------ |
| **array**     | order matters, or you will iterate all of it            | `STAGE_IDS` in `src/leads/stages.mjs` — the order stages run |
| **object**    | a fixed set of named fields describing one thing        | a stage's `{ ok, reasons, flags }` return value              |
| **`Set`**     | "is this one of them?", or de-duplicating               | `TITLE_STOP`, `VOID_ELEMENTS` in `src/lib/untrusted.mjs`     |
| **`Map`**     | look one thing up by a key, many times                  | `SKILL_BY_NAME`, the fact index from `buildFactIndex`        |
| **`WeakMap`** | attach data to an object without the object carrying it | `vouchOf` in `src/auto/stages.mjs`                           |

---

# Part 3 — Functions

## 3.1 What a function is

A **function** is a named piece of code you can run, optionally handing it some
values and optionally getting one back. The values you hand in are
**arguments**; the names they arrive under inside the function are
**parameters**; what comes back is the **return value**.

```js
export function jaccard(a, b) {
  if (!a.size || !b.size) return 0
  let inter = 0
  for (const t of a) if (b.has(t)) inter++
  return inter / (a.size + b.size - inter)
}
```

That is real, from `src/lib/lib.mjs`. It answers "how similar are these two
sets?" — count how many members they share, and divide by the total number of
distinct members across both. Two identical sets score `1`; two sets with nothing
in common score `0`. This project uses it to ask whether two job postings are the
same job wearing different clothes.

Notice the first line. Two empty sets technically share "all" of their zero
members, and a naive formula would score them `1` — a perfect match. The comment
in the file states the judgement explicitly:

> Empty on either side scores 0 rather than 1: two postings we know nothing about
> are not evidence of a match.

That is a **guard clause**, and Part 5 comes back to the shape.

Functions get written three ways in this codebase, all meaning roughly the same
thing:

```js
export function jaccard(a, b) { ... }        // a function declaration
export const isTerse = (argv = process.argv) => outputMode(argv) === "terse"
const add = (id, text) => { ... }            // an arrow function
```

The `=>` form is called an **arrow function**. When its body is a single
expression, that expression is automatically the return value — which is why
`isTerse` above has no `return` keyword and still returns a boolean.

## 3.2 Default parameter values

A parameter can carry a default, used when the caller does not supply that
argument:

```js
export function outputMode(argv = process.argv) {
  if (argv.includes("--verbose")) return "human"
  if (argv.includes("--quiet")) return "terse"
  return process.stdout.isTTY ? "human" : "terse"
}
```

Called as `outputMode()`, it looks at the real command line. Called as
`outputMode(["--quiet"])` — which is what the tests do — it looks at whatever list
you gave it. One function, usable in production and testable in isolation,
because of one `= process.argv`.

That pattern is used deliberately throughout. `parseDateRange(dates, now = new Date())`
defaults to the real clock but lets a test pass a fixed date, so a test written
today still passes next year. `screenJob(job, limits = {}, now = new Date(), profileYears = null)`
does the same three times over.

## 3.3 Destructuring: unpacking a value into names

**Destructuring** pulls fields out of an object (or items out of an array) and
gives each one its own name, in a single statement.

```js
const { ok, reasons, flags } = run(job, ctx)
```

instead of

```js
const result = run(job, ctx)
const ok = result.ok
const reasons = result.reasons
const flags = result.flags
```

The real version in `evaluateStages` (`src/leads/stages.mjs`) does four
things at once, and it is worth taking apart:

```js
const {
  ok,
  reasons = [],
  flags: newFlags = [],
  ...rest
} = run({ ...job, flags: [...flags] }, ctx)
```

- `ok` — take the `ok` field under its own name.
- `reasons = []` — take the `reasons` field; if the stage did not provide one,
  use an empty array. That default is why a stage may return a bare
  `{ ok: true }` without every caller having to check.
- `flags: newFlags = []` — take the `flags` field but **call it `newFlags`
  locally**, because there is already a variable called `flags` in this function
  (the accumulated set from earlier stages), and defaulting to an empty array
  again.
- `...rest` — **rest**: collect every other field the stage returned, whatever it
  was, into an object called `rest`. This is what lets a stage attach extra
  information (a fit score, a risk verdict) without `evaluateStages` needing to
  know its name in advance.

Destructuring also works on parameters, which is how this project writes
**options bags** — a single object argument holding a set of named settings:

```js
export async function fetchText(url, { timeoutMs = FETCH_TIMEOUT_MS } = {}) {
```

The caller writes `fetchText(url)` or `fetchText(url, { timeoutMs: 3000 })`. The
trailing `= {}` matters: without it, calling `fetchText(url)` with no second
argument would try to destructure `undefined` and crash.

You will see the pattern with many settings at once. From `src/auto/stages.mjs`:

```js
export function makeStages({
  jobsDir,
  profilePath = path.join(ROOT, "profile", "profile.yaml"),
  answersPath = path.join(ROOT, "profile", "answers.yaml"),
  limitsFile = path.join(ROOT, "docs", "application-limits.yaml"),
  scannerSrc = undefined,
} = {}) {
```

Five settings, four with sensible defaults, and every call site reads as prose
because each value is labelled at the point of use.

## 3.4 Higher-order functions

A **higher-order function** is a function that takes another function as an
argument, or returns one. This sounds abstract and is completely ordinary: it is
what `.map()` and `.filter()` already do.

```js
const overlap = [...leadTech].filter((t) => profileTech.has(t))
```

`.filter()` is higher-order: `(t) => profileTech.has(t)` is a function being
handed to it as data.

The important one in this codebase is `mapPool`, from `src/lib/lib.mjs`:

```js
export async function mapPool(items, limit, fn) {
```

Its third parameter is literally called `fn` and it is a function. `mapPool`'s job
is to run `fn` once for every item, at most `limit` at a time. It knows nothing at
all about what `fn` does — fetching a board, enriching a lead, probing a URL. That
separation is exactly the point: the "run these concurrently but not too
concurrently" logic is written **once**, and six files under `src/leads/`
reuse it — `find-jobs.mjs`, `enrich.mjs`, `canonical.mjs`, `board-yield.mjs`,
`discover-boards.mjs` and `find-boards.mjs`. Part 6 takes it apart in detail.

Another shape you will meet is a **factory function** — a function that returns a
function. From `src/documents/reuse-check.mjs`:

```js
export function makeSha256(createHash) {
  return (s) => createHash("sha256").update(String(s)).digest("hex")
}
```

Call `makeSha256(createHash)` once and you get back a small, ready-to-use hashing
function. Why bother? Because `createHash` comes from Node's `node:crypto`
module, and passing it in rather than importing it means the file can be loaded
and tested without pulling in the crypto module at all. That technique —
**dependency injection** — appears all over this project, and §3.6 explains why it
is more than a testing convenience here.

## 3.5 Storing functions in a registry, and the two kinds in this repo

A function is a value. That means you can put one in an array, in an object, or in
a `Map`, and get it back out later and call it. A collection of functions stored
by name is called a **registry**, and this project has two — built differently, for
different reasons. The contrast is instructive.

### The screening-stage registry: a real `Map`

From `src/leads/stages.mjs`:

```js
const REGISTRY = new Map()

export function registerStage(id, run) {
  if (!STAGE_IDS.includes(id)) throw new Error(`unknown stage id "${id}"`)
  REGISTRY.set(id, run)
}

registerStage("l0", (job, ctx) => passesLimits(job, ctx.limits, ctx.now))
registerStage("l1", (job, ctx) => bodyDisqualifiers(job, ctx.limits))
registerStage("l2", (job, ctx) =>
  scoreFit(job, ctx.profileTech ?? new Set(), {
    limits: ctx.limits,
    indexed: ctx.keywords,
  }),
)
registerStage("l3", (job, ctx) =>
  scoreRisk(job, ctx.history ?? null, { limits: ctx.limits }),
)
```

Four stages, each a function, each stored under a short id. The code that runs
them does not name any of them:

```js
for (const id of STAGE_IDS) {
  if (!only.includes(id)) continue
  const run = REGISTRY.get(id)
  if (!run) continue // stage not registered (l2/l3 before phase B)
  ...
}
```

`REGISTRY.get(id)` fetches the function; `run(...)` calls it. Adding a fifth
screening stage means writing one function and one `registerStage` line. The loop
never changes.

Three details in that registry are deliberate and worth noticing:

1. **`registerStage` validates the id.** A typo registers nothing and throws
   immediately, rather than quietly creating a stage that never runs. A screening
   stage that silently does not run is invisible, and an invisible screening stage
   means jobs disappear for no stated reason — which `CLAUDE.md` calls the worst
   failure in this system.
2. **`if (!run) continue`** tolerates a missing stage, so the pipeline could ship
   with `l2` and `l3` unbuilt and still work.
3. **Registration happens in this file, not in each check's own module.** The
   comment states why:

   > Letting `fit.mjs` and `risk.mjs` self-register would mean importing this file
   > from there and this file importing them back — a cycle. The checks stay pure
   > functions in their own modules; this file is the only thing that knows the
   > order they run in.

   That is a **circular import** — two files each needing the other to be loaded
   first — and the registry file is the standard way out of one. Part 4 comes back
   to it.

### The board-fetcher registry: a plain object

From `src/leads/find-jobs.mjs`:

```js
const BOARD_FETCHERS = {
  greenhouse: fetchGreenhouse,
  lever: fetchLever,
  ashby: fetchAshby,
  smartrecruiters: fetchSmartRecruiters,
  workable: fetchWorkable,
  recruitee: fetchRecruitee,
  workday: fetchWorkday,
  oracle_cloud: fetchOracleCloud,
  jobvite: fetchJobvite,
  successfactors: fetchSuccessFactors,
  jobicy: fetchJobicy,
  remotive: fetchRemotive,
  remoteok: fetchRemoteOk,
}

export const BOARD_TYPES = Object.keys(BOARD_FETCHERS)

export async function fetchBoard(board, query = DEFAULT_SEARCH_QUERY) {
  const fetcher = BOARD_FETCHERS[board.type]
  if (!fetcher) throw new Error(`unknown board type "${board.type}"`)
  return fetcher(board, query)
}
```

Thirteen applicant tracking systems, thirteen functions, one lookup. This is the
same idea as the stage registry, built on a plain object instead of a `Map`.

Why the difference? Because the two registries answer different needs. The stage
registry is **filled at run time** by calls to `registerStage`, so it wants a
container designed for insertion and a place to put the validation. The board
fetchers are a **fixed table written out in full at the top of the file**, and
writing it as an object literal makes the whole set readable at a glance.

The object form also buys something concrete: `Object.keys(BOARD_FETCHERS)`
produces `BOARD_TYPES`, the authoritative list of board types this project can
read — derived from the table rather than typed out a second time beside it. That
is the same anti-drift instinct Part 4 is about, applied in miniature: there is no
second list to forget to update.

Both registries share the real payoff, which is worth stating on its own:
**adding a board, or a stage, does not require editing the code that runs them.**
The sweep loop in `find-jobs.mjs` never mentions Greenhouse. The stage loop in
`stages.mjs` never mentions risk scoring. Each looks up a name and calls what it
finds.

## 3.6 Dependency injection, and where it becomes a safety control

Passing a function in as an argument, rather than importing it, is called
**dependency injection**. In most codebases it is a testing convenience. In this
one it is occasionally a control. From `src/lib/verification.mjs`:

```js
export function hasVerifiedResume(
  db,
  slug,
  { ..., hasPassing } = {},
) {
  if (typeof hasPassing !== "function")
    throw new TypeError(
      "hasVerifiedResume requires db.mjs's hasPassingVerification — without " +
        "it there is no verification check at all",
    )
  ...
}
```

The comment above it says exactly why there is no default:

> Required — a default would have to be "no check", and a verifier that defaults to
> no check fails open.

"**Fails open**" means: when something goes wrong, the gate lets everything
through. "**Fails closed**" means: when something goes wrong, the gate refuses.
For a check that decides whether a document was truthfully verified before an
application is sent, failing open is the unacceptable direction — so the function
throws rather than assume. The type check plus the thrown `TypeError` is the whole
mechanism.

---

# Part 4 — Modules, and the drift incident

## 4.1 What a module is

A **module** is one file of code that declares what it offers to other files and
what it needs from them.

- `export` marks something as available to other files.
- `import` pulls something in from another file.

```js
// in src/lib/lib.mjs
export const SNIPPET_MAX = 4000
export function jaccard(a, b) { ... }
```

```js
// in src/leads/enrich.mjs
import { fetchJson, fetchText, mapPool, decodeEntities } from "../lib/lib.mjs"
```

Those curly braces mean these are **named exports** — you ask for them by their
exact names. There is a second kind, a **default export**, which is a file's one
main thing:

```js
// in src/auto/stages.mjs
import scanPage from "../apply/scan-engine.mjs"
import fillPage from "../apply/fill-engine.mjs"
```

No braces, and the name is yours to choose — `scanPage` is what this file decided
to call whatever `scan-engine.mjs` exports as its default.

The `../` is an ordinary relative path (see
[./02-computer-basics.md](./02-computer-basics.md) §1): from
`src/auto/stages.mjs`, `..` climbs to `src/`, then `apply/scan-engine.mjs`
goes back down.

## 4.2 The real incident: one rule, two copies, and a blind gate

Here is the thing modules are actually for, told through what happened when this
project did not use one.

This pipeline needs to answer the question "what technology is named in this
text?" in two different places:

- **`verify-claims.mjs`**, the truthfulness gate. Rule 1 of `CLAUDE.md` says a
  tailored document may only contain facts from your profile. So before a resume
  is rendered, the verifier checks: does this document name a technology that your
  fact base cannot support? If yes, the render is blocked.
- **`profile-gaps.mjs` and the lead keyword index**, which read _job postings_ and
  ask which technologies employers keep demanding.

Both need a list of technology names. So there were two lists — one in
`lib.mjs` called `TECH_TERMS`, one in `profile-gaps.mjs` called `TECH_LEXICON`.
And, exactly as you would expect, they drifted. From the header of
`src/lib/keywords.mjs`:

> They disagreed in both directions: `TECH_LEXICON` knew Svelte, Kafka and
> Observability; `TECH_TERMS` knew Cognito, EventBridge and Monte Carlo.

Think about what that means for the gate. The verifier's job is to catch an
invented skill. A skill the verifier's list has never heard of cannot be caught by
it — the verifier does not recognise the word as a technology claim at all, and
the render proceeds. Every term missing from `TECH_TERMS` was a hole in the
truthfulness gate, and nobody could see the holes, because each list looked
complete on its own.

The fix was one shared file. `src/lib/keywords.mjs` now holds a single table,
`SKILLS`, and both consumers are **projections** of it:

- `TECH_LEXICON` is built from the table's `aliases` field — the loose,
  case-insensitive forms for reading someone else's job posting.
- The surface forms are built from the table's `surface` field — the exact way a
  resume would really write it.

And `lib.mjs` now contains this:

```js
export { TECH_TERMS } from "./keywords.mjs"
import { TECH_TERMS, CASE_SENSITIVE_SURFACE } from "./keywords.mjs"
```

That first line is a **re-export**: `lib.mjs` passes `TECH_TERMS` straight through
from `keywords.mjs`, so every file that already imported it from `lib.mjs` keeps
working, while there is now only one place the list actually lives. The comment
above it says so:

> Re-exported rather than moved outright so every existing importer keeps working.

The same reasoning appears a second time in `lib.mjs`, around the `AFFIRMATIVE`
regular expression that decides whether an answer counts as an unambiguous "yes":

> EXPORTED so the answer-bank rescan can answer "which stored entries currently
> promote their QUESTION into the R6 corpus?" using the same predicate the corpus
> builder uses. A second copy of this regex living in the auditor would drift from
> this one, and the audit would then report on a corpus that is not the corpus.
> One definition, two readers.

**"One definition, two readers"** is the whole idea of a module, in four words.
If two pieces of code must agree about a rule, they must not each hold a copy of
it. Copies do not stay equal, and when they diverge nothing announces it.

## 4.3 Two module details you will meet

**Circular imports.** If `a.mjs` imports `b.mjs` and `b.mjs` imports `a.mjs`,
neither can be fully loaded before the other, and you get strange half-initialised
values. §3.5 showed the standard escape: a third file that imports both and knows
about the relationship, while neither of the two knows about it. That is precisely
what `src/leads/stages.mjs` is.

**Dynamic import.** Normal `import` statements sit at the top of a file and always
run. Sometimes you want to load a module only if you actually need it:

```js
const { openDb, resolveLeadSource, setLeadKeywords } =
  await import("../lib/db.mjs")
```

That is from `src/leads/enrich.mjs`. The database module is only needed when
the file is being run as a command; a test that imports `enrich.mjs` for one pure
function does not pay for loading `node:sqlite`. `await import(...)` returns a
promise, which is Part 6's subject.

---

# Part 5 — Control flow

**Control flow** is the order in which statements run: which branch is taken,
which loop repeats, when a function stops early.

## 5.1 The basics: `if`, loops, `continue`

```js
for (const [re, name] of SCAM_PATTERNS) {
  if (re.test(text)) {
    signals.push(name)
    verdict = "reject"
  }
}
```

That is from `screenJob` in `src/leads/screen.mjs`. `for...of` walks a list
one item at a time. `SCAM_PATTERNS` is an array of pairs, and
`const [re, name]` destructures each pair into two names.

`continue` skips the rest of this turn of the loop and goes on to the next item:

```js
for (const f of scan.fields ?? []) {
  if (!norm(f.l)) continue
  ...
}
```

"If this field has no usable label, skip it; otherwise carry on." Using `continue`
for the skip case keeps the interesting code at the left margin instead of nested
one level deeper inside an `if`.

## 5.2 Early return, and the guard clause

A function can stop at any point with `return`. Returning early to handle a
special case first is called a **guard clause**, and it is the dominant style in
this codebase.

```js
export function hostOf(url) {
  const raw = String(url ?? "").trim()
  if (!raw) return "?"
  try {
    return new URL(raw).hostname.toLowerCase().replace(/^www\./, "") || "?"
  } catch {
    return "?"
  }
}
```

The empty case is dealt with and dismissed on line two. Everything after it can
assume there is a string to work with.

Note the `"?"` — a **sentinel value**, a deliberate stand-in meaning "no answer".
The comment in `src/apply/field-cache.mjs` explains why a sentinel rather than
an error:

> A scan with no URL, or one that does not parse as a URL, returns the sentinel
> `"?"` rather than throwing or falling back to the old basis. That keeps a cache
> entry POSSIBLE for such a scan (they still collide with each other, which is no
> worse than before) while keeping it distinct from every real host, so a URL-less
> scan can never be served a real board's remembered shape.

The sentinel is chosen so that unknown hosts group with each other and with
nothing else. That is a design decision, not a fallback.

## 5.3 Short-circuit evaluation

`&&` and `||` do not always evaluate both sides. They stop as soon as the answer
is determined:

- `a && b` — if `a` is falsy, the answer is `a` and `b` is never evaluated.
- `a || b` — if `a` is truthy, the answer is `a` and `b` is never evaluated.

This is called **short-circuiting**, and it is used for more than logic. Two real
uses in this repository:

```js
const url = job.apply_url || job.url || job.source_url
```

From `verifiedResumeUrls` in `src/lib/verification.mjs`: try the apply URL;
if there isn't one, the posting URL; if there isn't one, the source URL. Three
fallbacks in one line.

```js
if (demanded && profileYears != null) { ... }
```

From `screenJob`. If `demanded` is `0` — the posting stated no years requirement —
the second test never runs and the whole seniority gate is skipped. That is
short-circuiting used as a guard.

You will also meet the **conditional (ternary) operator**, which is an `if`/`else`
that produces a value:

```js
return process.stdout.isTTY ? "human" : "terse"
```

Read it as: "if `process.stdout.isTTY`, the answer is `"human"`, otherwise
`"terse"`."

## 5.4 The pipeline that stops at the first failure

This is the single most important control-flow shape in the project, and it is
worth understanding as a design idea and not only as syntax.

The screening system asks four questions about every job posting it finds. They
are deliberately ordered from cheapest to most expensive. From the header of
`src/leads/stages.mjs`:

> Stages run cheapest-first and stop at the first rejection, because the whole
> design is that an expensive check only ever sees what the cheap ones let
> through:
>
> - **L0 title** — board list payload only (title, location, date, salary).
>   Free. Discards thousands.
> - **L1 body** — hard disqualifiers stated in the description. Needs the text,
>   which for four ATS types costs one fetch per surviving posting.
> - **L2 fit** — can this profile actually do this job? Free, given L1's text.
> - **L3 risk** — is this job real? scam / ghost / repost signals. Free.

The cost structure is the whole argument. L0 works on data the board already
handed over in its list response — no extra network call, no extra time. L1 needs
the full job description, and for four of the thirteen board types that means one
HTTP request **per surviving posting**. So every posting L0 discards is a request
never made.

Here is the loop, in full, from `evaluateStages`:

```js
for (const id of STAGE_IDS) {
  if (!only.includes(id)) continue
  const run = REGISTRY.get(id)
  if (!run) continue

  const {
    ok,
    reasons = [],
    flags: newFlags = [],
    ...rest
  } = run({ ...job, flags: [...flags] }, ctx)
  newFlags.forEach((f) => flags.add(f))
  stages[id] = { ok, reasons, flags: newFlags, ...rest }
  extra = { ...extra, ...rest }

  if (!ok) {
    return {
      ok: false,
      stage: id,
      reasons: reasons.map((r) => (r.includes(":") ? r : `${id}: ${r}`)),
      flags: [...flags],
      stages,
      ...extra,
    }
  }
}

return {
  ok: true,
  stage: null,
  reasons: [],
  flags: [...flags],
  stages,
  ...extra,
}
```

Trace one posting through it:

1. `id` is `"l0"`. `REGISTRY.get("l0")` hands back the title/location/date check.
   It runs and returns `{ ok: true, flags: ["loose_title_match"] }`. `ok` is
   true, so the loop continues — and the flag it raised is added to the running
   `flags` set.
2. `id` is `"l1"`. The body check runs. This time it returns
   `{ ok: false, reasons: ["requires active clearance"] }`. The `if (!ok)` fires
   and the function **returns immediately**. `l2` and `l3` never run.
3. The returned object records `stage: "l1"` — **which check rejected it**.

That third point is the reason the whole thing was built. The same header comment:

> Before this, the same decisions were spread across three places with no shared
> vocabulary … and nothing recorded WHICH check had discarded a posting. "Why did
> I never see this job?" was not an answerable question.

Three further details in that loop repay a close look:

**Flags accumulate across stages.** `run({ ...job, flags: [...flags] }, ctx)`
hands each stage a copy of the job with every flag raised so far attached. The
comment says why: L1's "did this arrive on a loose title match?" test depends on a
flag L0 raised. Stages are independent functions but they are not blind to each
other.

**Reasons are labelled with their stage.**
`reasons.map((r) => (r.includes(":") ? r : `${id}: ${r}`))` prefixes each reason
with the stage id, unless it already carries one. So a stored verdict reads
`l1: requires active clearance` — the reason _and_ who decided it.

**The two returns have the same shape.** Success and failure both produce
`{ ok, stage, reasons, flags, stages, ...extra }`. A caller never has to check
which kind of thing it got before reading a field.

One general lesson to carry away, stated in `CLAUDE.md` in a security context but
true here too: **the order of checks in a function can itself be a control.** In
this case the ordering is about cost. In `src/apply/ats/index.mjs`, the
hand-off list is checked before the adapter list, so an ATS the agent cannot
handle produces an honest hand-off instead of a confusing stall. Order is not
arbitrary; when you see a comment defending one, believe it.

---

# Part 6 — Asynchronous code

## 6.1 The problem: waiting

Most of what a program does is fast. Adding two numbers, comparing two strings,
walking an array of forty items — all effectively instantaneous.

Fetching a web page is not. You send a request across the internet and wait for an
answer, and that wait is somewhere between 100 milliseconds and, if the far end is
unhealthy, forever. Measured against everything else the program does, it is an
eternity of doing nothing.

If a program stopped and waited each time — **blocking** — then sweeping
44 job boards one after another would take 44 waits stacked end to end. The user
of this project benchmarks its speed against a commercial product, so that is not
an acceptable design.

The answer is **asynchronous** code: start the wait, go do something else, come
back when the answer arrives.

## 6.2 A `Promise`

A **`Promise`** is an object that stands for a value that is not available yet. It
is a receipt. It is in one of three states:

- **pending** — still waiting;
- **fulfilled** — the value arrived;
- **rejected** — it failed, and carries an error explaining why.

A function that does something slow returns a promise immediately, rather than
returning the answer. Node's built-in `fetch` works this way: call it and you get
a promise back on the same line, long before any bytes come home.

## 6.3 `async` and `await`

Writing code that reacts to promises is awkward. `async` and `await` make it read
like ordinary sequential code.

- Mark a function `async` and it automatically returns a promise.
- Inside an `async` function, `await` a promise and the function **pauses** at
  that line until the promise settles, then continues with the value.

```js
export async function fetchText(url, { timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  return withTimeout(url, timeoutMs, async (signal) => {
    const res = await fetch(url, { headers: { ... }, signal })
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
    return res.text()
  })
}
```

Read the middle three lines as ordinary steps: send the request and wait for a
response; if the response is not OK, throw; otherwise read the body as text — and
that read is itself slow, so `res.text()` is awaited too, one level up.

The crucial thing `await` does **not** mean: it does not mean the whole program
stops. It means _this function_ is paused. Node is free to run other work while it
waits, which is what makes the pool in §6.5 possible.

Because an `async` function returns a promise, its caller must `await` it as well
— asynchrony propagates up the call chain. That is why so many functions in this
codebase are `async`.

A rejected promise surfaces as a thrown error at the `await`, so ordinary
`try`/`catch` works:

```js
async function withTimeout(url, timeoutMs, fn) {
  try {
    return await fn(AbortSignal.timeout(timeoutMs))
  } catch (e) {
    const timedOut = [e?.name, e?.cause?.name].some(
      (n) => n === "TimeoutError" || n === "AbortError",
    )
    if (timedOut) throw new Error(`timeout after ${timeoutMs}ms for ${url}`)
    throw e
  }
}
```

This wrapper, in `src/lib/lib.mjs`, exists because of a measured problem. Its
comment:

> Every fetch is bounded. Neither of these carried a signal, so a board that
> accepted the connection and never answered held one of `mapPool`'s eight workers
> until the OS gave up on the TCP connection — minutes, for one dead board, on the
> wall clock the user benchmarks against Jobright. Measured before this: a loopback
> server that accepts and never replies was STILL HANGING after 8s with no sign of
> stopping.

`AbortSignal.timeout(15000)` is the fix: a signal that cancels the request after
15 seconds. And notice what the `catch` block does — it converts a timeout into an
`Error` shaped exactly like an HTTP failure, carrying the URL, because that is
what every caller already knows how to handle. The comment again:

> Raw, the abort surfaces as a `DOMException` named `TimeoutError` whose message
> ("The operation was aborted due to timeout") names neither the URL nor the
> budget, which is the difference between a warn line a human can act on and one
> they cannot.

## 6.4 `Promise.all`

`Promise.all` takes a list of promises and gives you one promise that settles when
all of them have. It is how you say "start all of these, tell me when they are all
finished".

```js
await Promise.all(workers)
```

If any one of them rejects, `Promise.all` rejects immediately with that error.
That behaviour matters for §6.6.

## 6.5 The bounded-concurrency worker pool, in pictures

Here is `mapPool` in full, from `src/lib/lib.mjs`:

```js
export async function mapPool(items, limit, fn) {
  const out = new Array(items.length)
  let next = 0
  const workers = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    async () => {
      for (;;) {
        const i = next++
        if (i >= items.length) return
        out[i] = await fn(items[i], i)
      }
    },
  )
  await Promise.all(workers)
  return out
}
```

Twelve lines. Let us give them the real numbers.

`docs/job-sources.yaml` currently lists **44 boards**. The sweep in
`src/leads/find-jobs.mjs` calls:

```js
const concurrency = Number(getFlag(args, "--concurrency", 8))
const results = await mapPool(boards, concurrency, async (board) => { ... })
```

So: **44 items, limit 8**.

### One at a time

```
board 1  ▓▓▓▓
board 2      ▓▓▓▓
board 3          ▓▓▓▓
board 4              ▓▓▓▓
...
board 44                                            ... ▓▓▓▓
|-------------------- 44 waits, end to end --------------------|
```

Every board waits for the one before it to finish. If each board took exactly one
second, the sweep would take 44 seconds — and almost all of that time the program
is sitting idle, doing nothing, waiting for a server somewhere.

### Unbounded — all 44 at once

You could start all 44 requests simultaneously. It would be fast, and it is the
wrong answer, for two reasons. It opens 44 sockets at once, which the operating
system and your network may not appreciate; and if several of those boards happen
to be the same ATS, you have just sent that company a burst of simultaneous
traffic from one script, which is rude at best and looks like an attack at worst.

### Bounded: 8 workers, a shared queue

`mapPool` creates **8 workers**. A worker is not a thread or a separate process —
it is an `async` function running a loop. All 8 share one counter, `next`.

```
                       shared counter `next` starts at 0
                                    │
   ┌────────┬────────┬────────┬─────┴──┬────────┬────────┬────────┐
worker 1  worker 2  worker 3  worker 4  worker 5  worker 6  worker 7  worker 8
   │        │        │        │        │        │        │        │
takes 0  takes 1  takes 2  takes 3  takes 4  takes 5  takes 6  takes 7
   │        │        │        │        │        │        │        │
 (awaits the network — Node is free to run the other seven meanwhile)
   │        │        │        │        │        │        │        │
 done ────► takes 8
            done ──► takes 9
                     done ──► takes 10
                                       ... and so on, until `next` reaches 44
```

Each worker's loop is: take the next index, do the work, repeat, and return when
the indexes run out. Nobody is assigned a fixed share. A worker that draws a fast
board comes back for another one immediately; a worker stuck on a slow board holds
exactly one slot and does not stall anyone else.

With 44 items and 8 workers, if every board took one second, you would get roughly
six rounds — about 6 seconds instead of 44. (That is arithmetic, not a
measurement. Real boards vary enormously, which is exactly why the
take-the-next-one design beats splitting the list into eight fixed chunks.)

Now the details that make the twelve lines correct:

**Why the worker count is `Math.max(1, Math.min(limit, items.length))`.**
`Math.min(limit, items.length)` avoids creating 8 workers for 3 boards — five of
them would immediately find the list empty and return. `Math.max(1, ...)` protects
the other end: with zero items, `Math.min(8, 0)` is `0`, and the outer `Math.max`
makes it `1`. A worker pool that created zero workers would call `Promise.all([])`
— which resolves instantly, so that is fine here — but the guard also covers a
caller passing `limit: 0`, which would otherwise create a pool that never does any
work and never finishes. There is a test for the empty case:

```js
test("mapPool handles an empty list without hanging", async () => {
  assert.deepEqual(await mapPool([], 4, async () => 1), [])
})
```

**Why results come back in the right order.** `out` is created up front at full
length, and each worker writes its result to `out[i]` — the position it took from
the counter — not by appending. Worker 6 might finish before worker 2; it does not
matter, because each writes to its own slot. The output array is always in input
order. There is a test for that too:

```js
test("mapPool preserves input order and respects the concurrency cap", async () => {
  let inFlight = 0
  let peak = 0
  const items = Array.from({ length: 20 }, (_, i) => i)
  const out = await mapPool(items, 4, async (n) => {
    inFlight++
    peak = Math.max(peak, inFlight)
    await new Promise((r) => setTimeout(r, 1))
    inFlight--
    return n * 2
  })
  assert.deepEqual(
    out,
    items.map((n) => n * 2),
  )
  assert.ok(peak <= 4, `concurrency exceeded: ${peak}`)
})
```

That test asserts both properties at once: the output is exactly the input doubled
in order, and no more than 4 pieces of work were ever in flight.

**Why `next++` needs no lock.** In a language with real threads, eight workers
sharing one counter would be a textbook race condition (Part 9). In JavaScript it
is safe, and the reason is worth knowing: **JavaScript runs one piece of code at a
time.** A function runs to completion or to its next `await`; it is never
interrupted mid-statement. `const i = next++` is such a stretch of uninterrupted
code, so two workers cannot both read `next` as `5`.

This is also the limit of the technique. Concurrency here means _overlapping
waiting_, not _simultaneous computing_. Eight workers doing eight network fetches
genuinely overlap, because the waiting happens outside JavaScript. Eight workers
doing eight heavy calculations would not overlap at all — they would take turns.
`mapPool` is a tool for I/O-bound work, and job-board sweeps are exactly that.

## 6.6 What `mapPool` does not do, and how the callers cope

`Promise.all` rejects as soon as any one promise rejects. So if `fn` throws for one
item, the whole `mapPool` call throws and every result is lost — including the ones
that had already succeeded.

For a 44-board sweep that would be intolerable: one dead board would destroy the
whole run. So the caller does not let `fn` throw. From
`src/leads/find-jobs.mjs`:

```js
const results = await mapPool(boards, concurrency, async (board) => {
  const label = `${board.type}:${board.slug ?? board.tenant ?? board.host}`
  try {
    return { board, label, postings: await fetchBoard(board, query) }
  } catch (e) {
    return { board, label, postings: [], error: e.message }
  }
})
for (const r of results) {
  if (r.error) failures.push(`${r.label} — ${r.error}`)
  else candidates.push(...r.postings)
}
```

The `try`/`catch` sits **inside** the function handed to `mapPool`, and a failure
is turned into an ordinary return value carrying an `error` field. This technique
is called **errors as values**, and its effect is exactly what the timeout comment
promised: a slow or broken board costs one board, never the sweep.

---

# Part 7 — Regular expressions

## 7.1 What they are, and why this codebase is full of them

A **regular expression** (a "regex", or "regexp") is a small pattern language for
describing shapes of text. You write a pattern, and then you can ask a string:
does this pattern occur in you? where? what did it match?

This project is full of them because almost everything it does is reading text
somebody else wrote — job descriptions, HTML pages, form labels, dates in a resume
— and finding structure in it. There are patterns for spotting a scam posting, for
extracting "5+ years of experience", for stripping HTML tags, for detecting
prompt-injection attempts, for cleaning up entity-encoded characters.

They also have a bad reputation, and it is deserved in the specific ways this
section will show you: a pattern that is subtly wrong fails silently, and a pattern
that is badly shaped can be a performance bug. Both have happened here, and both
are documented in the code.

A regex is written between slashes, with optional letters after the closing slash
called **flags**:

```js
/fast[- ]paced/i
 ^─────────────^ the pattern
                ^ the flag
```

You test one with `.test()`, which returns `true` or `false`:

```js
;/\bfast[- ]paced\b/i.test("We are a fast-paced startup") // true
```

## 7.2 Literal characters

Most characters in a pattern mean themselves.

```js
;/clearance/
```

matches the letters `c`, `l`, `e`, `a`, `r`, `a`, `n`, `c`, `e` in that order,
anywhere in the text.

A dozen characters are special and mean something else: `. * + ? ^ $ | ( ) [ ] { } \`.
To match one of those literally, put a backslash in front of it. `\.` means a real
full stop. `\+` means a real plus sign. §7.12 covers what to do when the text you
want to match is not known in advance.

## 7.3 Character classes: "any one of these"

Square brackets mean "match exactly one character, from this set".

| Pattern       | Matches                                                                 |
| ------------- | ----------------------------------------------------------------------- |
| `[abc]`       | one `a`, `b`, or `c`                                                    |
| `[a-z]`       | one lowercase letter (a **range**)                                      |
| `[0-9]`       | one digit                                                               |
| `[A-Za-z0-9]` | one letter or digit                                                     |
| `[^>]`        | one character that is **not** `>` (the `^` inside brackets means "not") |

A real one, from `src/leads/screen.mjs`:

```js
;/\bfast[- ]paced\b/i
```

`[- ]` is a two-member class: a hyphen or a space. So this matches both
"fast-paced" and "fast paced". A hyphen at the very start or very end of a class
is a literal hyphen rather than a range marker, which is why it is written
`[- ]` and not `[ -]`.

There are shorthands for the most common classes:

| Shorthand      | Means                                         | Long form      |
| -------------- | --------------------------------------------- | -------------- |
| `\d`           | a digit                                       | `[0-9]`        |
| `\w`           | a "word character": letter, digit, underscore | `[A-Za-z0-9_]` |
| `\s`           | whitespace: space, tab, newline               |                |
| `\D` `\W` `\S` | the negation of each                          |                |
| `.`            | any character except a newline                |                |

And the Unicode property escapes, used once in `src/lib/untrusted.mjs`:

```js
const WORD_RUN = /[\p{L}\p{M}\p{N}]+/gu
```

`\p{L}` is "any letter in any alphabet", `\p{M}` a combining mark, `\p{N}` any
numeric character. The `u` flag is required to use them. That pattern exists
because the sanitiser has to handle text in scripts other than Latin — the whole
point of the check is that an attacker may not be writing in English.

## 7.4 Quantifiers: "how many"

A quantifier applies to the thing immediately before it.

| Quantifier | Means                  |
| ---------- | ---------------------- |
| `*`        | zero or more           |
| `+`        | one or more            |
| `?`        | zero or one (optional) |
| `{3}`      | exactly three          |
| `{1,2}`    | between one and two    |
| `{0,60}`   | up to sixty            |

```js
;/\d{1,2}/ // one or two digits: matches "5" and "45"
;/\s+/ // one or more whitespace characters
;/[^>]{0,4000}/ // up to 4000 non-'>' characters
```

Quantifiers are **greedy** by default: they take as much as they can while still
letting the rest of the pattern match. Adding `?` after a quantifier makes it
**lazy** — take as little as possible. The difference is easiest to see on HTML:

```js
;/<.*>/.test("<b>hello</b>") // the .* matches "b>hello</b" — the WHOLE thing
;/<.*?>/.test("<b>hello</b>") // the .*? matches just "b" — the first tag only
```

Greediness is behind a whole class of subtle bugs, and it is half of the
performance problem in §7.13.

## 7.5 Anchors and word boundaries

Anchors match a _position_, not a character.

| Anchor | Means                                               |
| ------ | --------------------------------------------------- |
| `^`    | start of the text (or of a line, with the `m` flag) |
| `$`    | end of the text (or of a line, with `m`)            |
| `\b`   | a **word boundary**                                 |
| `\B`   | not a word boundary                                 |

A **word boundary** is the position between a word character (`\w`) and a
non-word character, or at the very start or end of the text. It is what stops
`/rest/` from matching inside "interested".

Watch what it buys, using a real pattern from `src/lib/lib.mjs`:

```js
const NON_PROFESSIONAL_TITLE =
  /\b(intern|internship|teacher assistant|teaching assistant|tutor|volunteer)\b/i
```

Decoded left to right:

- `\b` — must start at a word boundary.
- `(` — open a group.
- `intern|internship|teacher assistant|teaching assistant|tutor|volunteer` —
  **alternation**: the `|` means "or". Match any one of these six phrases.
- `)` — close the group.
- `\b` — must end at a word boundary.
- `/i` — the **case-insensitive** flag, so "Intern" and "INTERN" match too.

Without the boundaries, "intern" would match inside "**intern**ational" and
"tutor" inside "**tutor**ial". With them, it matches the words and not the
fragments. The function using it, `yearsOfExperience`, skips such roles when
totalling your professional tenure — "a posting asking for '5 years' does not mean
five years of tutoring", as the comment puts it. A false match there would
understate your experience and cause real jobs to be filtered out.

## 7.6 Groups, and capturing what matched

Parentheses do two jobs at once.

1. They **group** so that a quantifier or alternation applies to the whole group,
   as in the pattern above.
2. They **capture** — remember what that part matched, so you can read it out.

Captures are numbered from 1, in the order their opening parentheses appear.

```js
const re =
  /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(\d{4})\b/g
for (const m of String(text).matchAll(re)) out.add(`${m[1]} ${m[2]}`)
```

That is `extractMonthYears` in `src/lib/lib.mjs`. Given `"Jan 2024 – Present"`
it produces `"Jan 2024"`. Reading the pieces:

- `(Jan|Feb|…|Dec)` — **capture group 1**: the three-letter month.
- `[a-z]*` — any number of lowercase letters, so "January" also matches (the
  "uary" is consumed here).
- `\.?` — an optional literal full stop, so "Jan." matches.
- `\s+` — one or more whitespace characters.
- `(\d{4})` — **capture group 2**: exactly four digits, the year.

In the match object `m`, `m[0]` is always the whole match, `m[1]` is the first
capture, `m[2]` the second. So `${m[1]} ${m[2]}` is `"Jan 2024"` — normalised,
whatever the source spelling was.

When you want grouping without capturing, use `(?:...)`, a **non-capturing
group**. It keeps the numbering clean and is very slightly cheaper:

```js
;/\d+(?:,\d{3})*(?:\.\d+)?/g
```

That is the number pattern in `extractNumbers`. Decoded:

- `\d+` — one or more digits.
- `(?:,\d{3})*` — then, zero or more times, a comma followed by exactly three
  digits. This is what makes `1,200` and `1,234,567` single matches.
- `(?:\.\d+)?` — then, optionally, a full stop followed by one or more digits, so
  `99.9` and `3.75` are one match each rather than two.
- `/g` — find every occurrence, not just the first.

`"Served 1,200 users, 99.9% uptime, 45+ stars, GPA 3.75"` gives `1,200`, `99.9`,
`45`, `3.75` — and the caller strips the commas afterwards.

## 7.7 The flags

| Flag | Name             | Effect                                                          |
| ---- | ---------------- | --------------------------------------------------------------- |
| `i`  | case-insensitive | `A` matches `a`                                                 |
| `g`  | global           | find every match, not just the first                            |
| `m`  | multiline        | `^` and `$` match at each line break, not only the text ends    |
| `s`  | dotAll           | `.` also matches a newline                                      |
| `u`  | unicode          | required for `\p{...}` and proper handling of astral characters |

The `i` flag has a real safety history in this project. From
`src/lib/keywords.mjs`:

> R6 was CASE-SENSITIVE, so a document claiming "kubernetes" and "terraform" in
> lowercase produced zero violations and exited 0. The load-bearing truthfulness
> gate was blind to any invention that simply used the wrong case.

That is a missing single letter in a flag, and it left the gate that stops a
resume claiming skills you do not have unable to see lowercase claims.

But `i` is not free either, and this is a nice illustration of why security
choices are rarely "just be stricter". Making everything case-insensitive means
`"go to the store"` matches the language **Go**, and `"Spring 2027 internship"`
matches the framework **Spring**. The resolution in this codebase is an
enumerated exception list, `CASE_SENSITIVE_SURFACE` in
`src/lib/keywords.mjs`. Its rule, in the file's own words: _"a term is listed
here when its lowercase form is an ordinary English word a truthful resume or
cover letter might really contain."_ So `Go`, `Spring`, `Express`, `Rails` and
`REST` are on it; `Docker`, `Python` and `Kubernetes` are not, because this
project already treats their lowercase forms as mis-spelled technology claims.
The list is consulted in `termRegex`, in `src/lib/lib.mjs`:

```js
function termRegex(term, flags = "") {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return new RegExp(
    `(?<![A-Za-z0-9+#.])${escaped}(?![A-Za-z0-9+#])`,
    CASE_SENSITIVE_SURFACE.has(term) ? flags : `${flags}i`,
  )
}
```

The last line is the decision: add `i` unless this term is on the exception list.

## 7.8 The `g` flag is stateful, and that has bitten this project twice

A regex with the `g` flag carries a hidden property, `lastIndex`, remembering
where it got to. Reuse the same regex object and it picks up where it left off:

```js
const re = /a/g
re.test("aaa") // true  — lastIndex is now 1
re.test("aaa") // true  — lastIndex is now 2
re.test("aaa") // true  — lastIndex is now 3
re.test("aaa") // false — reached the end; lastIndex resets to 0
```

The same regex, the same string, four different answers. This is a classic source
of tests that pass alone and fail in a suite.

Both directions of the problem show up in `src/lib/untrusted.mjs`. First,
**missing** `g` when you need it:

> All are global. They were not, and `String.replace` with a non-global regex
> replaces exactly one occurrence — so a posting that stated its injection twice
> had the second copy delivered verbatim to the model and the finding count
> understated the attempt.

Second, **sharing** a `g` regex when you must not. The pattern that detects fake
prompt-delimiter tags is not stored as a constant. It is stored as a _function
that returns a fresh one_:

```js
function FAKE_TURN_TAG_SOURCE() {
  return /<\s*\/?\s*(?:system|assistant|user|instructions?|prompt|context|document|job[_\s-]?(?:posting|description|ad)|im_start|im_end|end_of_[a-z_]+|inst)\s*\/?\s*>/gi
}
```

The comment says exactly why:

> Declared as a function so the same source can be used in both passes without two
> regex objects sharing a `lastIndex`.

Two scanning passes need this pattern — one over raw markup, one over flattened
text. Sharing one object would mean the second pass started reading from wherever
the first one stopped, and would silently miss things.

The safe habits: use `String.matchAll(re)` (which handles this for you and
requires `g`), or build a fresh regex where you need it, or do not put `g` on a
pattern you only use with `.test()`.

## 7.9 Lookahead and lookbehind

A **lookaround** asserts that something does or does not appear next to the
current position, without consuming it — the matched text does not include it.

| Syntax     | Name                | Means                             |
| ---------- | ------------------- | --------------------------------- |
| `(?=...)`  | positive lookahead  | what follows must match this      |
| `(?!...)`  | negative lookahead  | what follows must not match this  |
| `(?<=...)` | positive lookbehind | what precedes must match this     |
| `(?<!...)` | negative lookbehind | what precedes must not match this |

Look again at `termRegex` above. Its core is:

```
(?<![A-Za-z0-9+#.])   ESCAPED-TERM   (?![A-Za-z0-9+#])
```

That is a hand-built word boundary. It says: the character before the term must
not be a letter, digit, `+`, `#` or `.`; and the character after must not be a
letter, digit, `+` or `#`.

Why not use `\b`? Because `\b` is defined in terms of `\w`, which does not
include `+`, `#` or `.`. So `\bC\b` matches the `C` inside `C++`, and `\bNode\b`
matches the `Node` inside `Node.js`. For a lexicon that contains `C++`, `C#` and
`Node.js` as terms in their own right, `\b` gives the wrong answer. The
lookarounds define exactly the boundary this project needs. The comment in
`lib.mjs`:

> Boundaries that tolerate ".", "+", "#" inside terms (C++, Node.js, C#).

Note the asymmetry: the lookbehind excludes `.` but the lookahead does not. That
lets "Node.js" match at the start of a term without letting a trailing sentence
full stop break it.

Here is the second real lookbehind, in `src/lib/lib.mjs`:

```js
const SENTENCE_BREAK = /(?<=\.)\s+(?=[A-Z])/
```

"Whitespace that is preceded by a full stop and followed by a capital letter." It
splits a question into sentences. The comment explains why it is not a bare full
stop:

> The sentence break is "period, space, capital" rather than just a period, because
> "Do you have experience with Node.js?" must not lose its own subject to the dot in
> the middle of a tech term.

## 7.10 Worked example: the pattern that caused a real bug

This is the most instructive regex in the repository, because the fix is visible
in it. From `extractYearsRequired` in `src/leads/screen.mjs`:

```js
const re =
  /(?<![\d.])(\d{1,2}(?:\.\d+)?)\s*\)?\s*\+?\s*years?\b([^.\n]{0,60})/gi
```

Its job: find the highest years-of-experience demand stated in a job posting, so
the screener can reject postings far above your tenure. Piece by piece:

| Piece                 | Meaning                                                                                                |
| --------------------- | ------------------------------------------------------------------------------------------------------ |
| `(?<![\d.])`          | not preceded by a digit or a full stop — **the fix**, below                                            |
| `(\d{1,2}(?:\.\d+)?)` | capture group 1: one or two digits, optionally a decimal part                                          |
| `\s*`                 | any amount of whitespace, including none                                                               |
| `\)?`                 | an optional literal `)`, for postings that write `(5) years`                                           |
| `\s*`                 | more optional whitespace                                                                               |
| `\+?`                 | an optional literal `+`, for `5+ years`                                                                |
| `\s*`                 | more optional whitespace                                                                               |
| `years?`              | `year` with an optional `s` — the `?` applies to the `s` only                                          |
| `\b`                  | a word boundary, so "yearsold" does not match                                                          |
| `([^.\n]{0,60})`      | capture group 2: up to 60 characters that are not a full stop or newline — the words immediately after |
| `/gi`                 | every occurrence, case-insensitive                                                                     |

Now the fix. The comment above it:

> The number may be fractional, and the lookbehind is load-bearing: with a plain
> `\b`, "1.5+ years" matched the "5" (a decimal point is a word boundary) and read
> an entry-level 1.5-year bar as a 5-year one — which rejected precisely the junior
> postings this profile is looking for.

Trace it. A full stop is not a word character, so in `1.5+ years` there is a word
boundary between the `.` and the `5`. A pattern beginning `\b(\d{1,2}...)` is
perfectly happy to start there, capture `5`, and report a five-year requirement.
The posting asked for 1.5 years.

The consequence is the worst kind this project names: junior postings — exactly
the ones being searched for — were being silently rejected. `(?<![\d.])` fixes it
by refusing to start a match immediately after a digit or a dot.

And look at what capture group 2 is for. The two lines that follow in the source:

```js
if (/\bof age\b|\bold\b/i.test(tail)) continue
if (!/experien|background|track record/i.test(tail)) continue
```

The 60 characters after the number are inspected. If they say "of age" — as in "you
must be 18 years of age" — the match is discarded, because a legal minimum age is
not a seniority bar. And unless they mention experience, background or a track
record, the match is discarded too. A bare "5 years" in a sentence about company
history is not a requirement. Two short guards turn a crude number-finder into
something usable.

## 7.11 Worked example: a prompt-injection pattern

From `INJECTION_PATTERNS` in `src/lib/untrusted.mjs`:

```js
;/\b(?:ignore|disregard|forget|override)\s+(?:all\s+|any\s+|the\s+)?(?:previous|prior|earlier|above|preceding|system|initial)\s+(?:instruction|prompt|direction|rule|context|message)/gi
```

Three non-capturing groups in a row, each an alternation, describing the shape of
an instruction aimed at an AI assistant:

1. `(?:ignore|disregard|forget|override)` — a verb of dismissal;
2. `(?:all\s+|any\s+|the\s+)?` — an optional quantifier word, each with its
   trailing space inside the alternative;
3. `(?:previous|prior|earlier|above|preceding|system|initial)` — a word referring
   to earlier context;
4. `(?:instruction|prompt|direction|rule|context|message)` — the noun.

So it matches "ignore all previous instructions", "disregard the prior prompt",
"override system rules", and dozens of other phrasings — 4 × 4 × 7 × 6 = 672
combinations from one line.

But read the header of that file before you feel safe:

> THE PATTERN LIST IS NOT THE GUARANTEE. It is a filter with known, permanent holes,
> and the holes are not bugs waiting to be fixed — they are what pattern matching is:
>
> - A non-English instruction is not matched. "Ignora todas las instrucciones
>   anteriores" and "忽略之前的所有指示" both walk straight through.
> - A reworded instruction is not matched.
> - A brand-new carrier is not matched until someone adds it.

This is the most important thing to understand about regular expressions as a
security tool. **A pattern list describes what someone thought of.** An attacker
is free to write something else. The actual guarantee in this project is elsewhere
— `verify-claims` rule R6 plus hard rule 1: a technology term that cannot be traced
to your profile cannot appear in a generated document, no matter who proposed it.
The pattern list is defence in depth, and the file says so in as many words.
[./07-safety-model.md](./07-safety-model.md) develops this properly.

## 7.12 Escaping text before you build a pattern from it

You often need a pattern built from a string that is not known when you write the
code — a skill name from a table, a term the user typed. If you drop that string
straight into a pattern, any special character in it changes the pattern's
meaning. `C++` would be read as "a `C`, then one-or-more `+`, then one-or-more of
nothing" — which is a syntax error. `Node.js` would have its `.` read as
"any character", so it would happily match "NodeXjs".

The fix is to escape every special character first. This exact line appears in
several files, `src/lib/lib.mjs` and `src/lib/keywords.mjs` among them:

```js
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
```

Reading it: find every character in that class — `.` `*` `+` `?` `^` `$` `{` `}`
`(` `)` `|` `[` `]` `\` — and replace it with a backslash followed by itself.
`$&` in a replacement string means "whatever was matched". So `C++` becomes
`C\+\+`, which means a literal `C` followed by two literal plus signs.

There is a general rule here that goes far beyond regexes: **when data becomes
part of a program — a pattern, a query, a command — it must be escaped at the
boundary.** The same failure with a database query is called SQL injection; with a
shell command, command injection. The mechanism is identical: text that was meant
to be data got read as structure.

## 7.13 Catastrophic backtracking: when a pattern is a performance bug

A regex engine finds matches by trying possibilities and backing up when one fails.
Usually that is quick. But some patterns create an enormous number of possibilities
to try, and the time taken explodes.

The classic shape is a quantifier inside a quantifier where the alternatives can
match the same text. `(a+)+b` against a long string of `a`s with no `b` has to try
every possible way of splitting those `a`s into groups before it can conclude
failure — and the number of ways doubles with each extra `a`. Thirty `a`s is a
billion attempts. This is called **catastrophic backtracking**, and as a security
issue it is "ReDoS": regular-expression denial of service. Hand a program a crafted
input and it hangs.

This repository is aware of the risk and defends against it. From
`src/lib/untrusted.mjs`:

```js
// Tolerates ">" inside a quoted attribute value; the alternation branches are
// disjoint on their first character, so this cannot backtrack catastrophically.
// The bound is belt-and-braces against a pathological unterminated tag.
const OPEN_TAG = /<([a-zA-Z][a-zA-Z0-9]*)((?:"[^"]*"|'[^']*'|[^>"']){0,4000})>/g
```

Two defences in one line. The three alternatives inside the group start with `"`,
`'`, and "none of those" respectively — **disjoint on their first character**, so at
any position exactly one branch can apply and there is nothing to backtrack over.
And `{0,4000}` puts a hard ceiling on the repetition rather than letting `*` run
free.

That is good practice, and it is not quite enough:

> **Known defect (2026-08-05 audit).** `OPEN_TAG` still costs seconds on crafted
> input. The `{0,4000}` bound stops the growth being exponential but leaves a
> 4000× constant per starting position, and nothing caps the size of the input
> before `scrubMarkup` runs — `enrich.mjs` hands whatever a detail-page fetch
> returned straight to `sanitizeHtmlSnippet`, and `SNIPPET_MAX` (4000) is applied
> only at the end. Measured on `<a` repeated with no `>` anywhere: 100,000
> characters took 874 ms, 200,000 took 1,803 ms, 400,000 took 3,615 ms. Honest
> input is unaffected — 234 KB of realistic HTML scrubs in 1 ms, and a real
> 3,908-character posting takes 0.25 ms — so this is a crafted-input latency risk,
> not something you will hit by accident. The suggested fixes are to cap the input
> size before the tag walk, or lower the `{0,4000}` bound to a realistic attribute
> length. See [../audit-2026-08-05.md](../audit-2026-08-05.md).

The lesson to keep: **a regular expression has a cost, and the cost depends on the
input, and an attacker may choose the input.** When you write one that runs on
third-party text, ask what the worst input would do.

There is a milder cousin of the same idea worth knowing, also from the audit:

> **Known defect (2026-08-05 audit).** `techTermsIn` in `src/lib/lib.mjs`
> copies `TECH_TERMS`, sorts it longest-first, and constructs 153 fresh `RegExp`
> objects **on every call** — none of which depends on the input text. Measured
> over about 3 KB of text: 128.1 ms per 500 calls, against 47.5 ms for a
> module-level cached array of compiled patterns, a 2.7× difference. It compounds:
> `evidenceText` calls `questionEvidence`, which calls `techTermsIn`, once per
> affirmative answer, so a 200-answer bank pays 200 × 153 regex compilations to
> build one corpus.

Building a regex is real work. Building the same one 76,500 times is real work
done 76,499 times too many. Nothing about the behaviour is wrong here — only the
cost.

---

# Part 8 — Hashing and SHA-256 fingerprints

## 8.1 What a hash is

A **hash function** takes any amount of data and produces a short, fixed-length
value — a **digest** — that acts as a fingerprint of the input.

```js
const hex = (buf) => crypto.createHash("sha256").update(buf).digest("hex")
```

That is real, from `src/lib/verification.mjs`. Feed it anything and you get 64
hexadecimal characters back.

The properties that make it useful:

1. **Deterministic.** The same input always produces the same digest. Always.
2. **Fixed size.** A one-byte file and a one-gigabyte file both produce 64
   characters.
3. **Avalanche.** Change one byte of input and the digest changes completely — not
   slightly. There is no "close".
4. **One-way.** You cannot work backwards from a digest to the input.
5. **Collision-resistant.** For a good hash, finding two different inputs with the
   same digest is computationally infeasible.

A hash is **not encryption**. Encryption is reversible with a key; hashing is not
reversible at all. Hashing answers exactly one question: _are these two things the
same bytes?_

## 8.2 Why this project hashes document bytes

Hard rule 4 of `CLAUDE.md` says `verify-claims` must pass before any document is
rendered or shown as final. The obvious way to record that a document passed is to
note that it did. The problem is what "it" means.

Here is what used to happen, from the header of `src/lib/verification.mjs`:

> Until now the only evidence that a tailored document had passed verify-claims was
> that the file existed: `automatability.mjs` walked `jobs/*/` and treated any
> workspace holding a `resume.md` as verified. So a draft nobody had ever checked,
> or one checked and then edited, or one checked against a fact base the user has
> since rewritten, all read as "verified" — on the path that decides whether an
> application may be sent unattended.

The presence of a file is not evidence about its contents. So a verification is
now a row in the database, and it counts as evidence only while **two** hashes
still hold:

| Column           | What it fingerprints              | What changing it means                                          |
| ---------------- | --------------------------------- | --------------------------------------------------------------- |
| `doc_sha256`     | the exact bytes that were checked | edit the document and its own verification stops applying to it |
| `profile_sha256` | the fact base checked against     | edit `profile.yaml` and every outstanding verification lapses   |

The second one is the clever half. The verifier's job is to confirm that a document
contains only facts your profile supports. If you rewrite your profile, that
comparison was against a corpus that no longer exists, and every verification made
before the edit silently stops meaning anything. Hashing the fact base makes that
lapse automatic — nobody has to remember to invalidate anything.

Here is how the fact base digest is computed:

```js
export function factBaseSha256({
  profilePath = PROFILE_PATH,
  answersPath = ANSWERS_PATH,
} = {}) {
  const parts = [
    ["profile.yaml", sha256File(profilePath)],
    ["answers.yaml", sha256File(answersPath)],
  ]
  return hex(parts.map(([name, h]) => `${name}:${h ?? "-"}`).join("\n"))
}
```

Four decisions are visible in six lines, and the file's header defends each:

- **Both files**, because an answer in `answers.yaml` can be the sole support for
  a claim, so a change there must invalidate just as a change to `profile.yaml`
  does.
- **A fixed order**, `profile.yaml` first, so the digest is reproducible.
- **Each file's name included in the digest input**, so a byte moving from one file
  to the other changes the result. Plain concatenation would not notice.
- **A missing file contributes the literal `"-"`** rather than throwing, because an
  absent `answers.yaml` is a legitimate state — and it must produce a different
  digest from an empty one.

And there is a further point about why this lives in one file, which is Part 4's
lesson wearing different clothes:

> ONE FUNCTION COMPUTES `profile_sha256`, and that is the point of this module.
> `verify-claims.mjs` writes the row and `automatability.mjs` reads it; if the two
> hashed the fact base differently they would never agree, and the failure would be
> silent and OPEN — "no matching row" reads exactly like "never verified", so a
> hashing mismatch would look like a conservative refusal right up until someone
> "fixed" it by loosening the comparison.

Read that twice. Two copies of a hashing rule that disagree do not produce an
error. They produce a system where nothing is ever verified, that looks exactly
like a system being careful — until someone removes the check to make it work.

## 8.3 A hash as a cache key

The second use of hashing here is as a **key**: turn a complicated thing into a
short string you can look up.

From `src/apply/field-cache.mjs`:

```js
export function fingerprint(scan, atsId) {
  const labels = (scan.fields ?? [])
    .filter((f) => f.req)
    .map((f) => norm(f.l))
    .filter(Boolean)
    .sort()
  const basis = `${atsId}|${hostOf(scan.url)}|${labels.join("\n")}`
  return crypto.createHash("sha1").update(basis).digest("hex").slice(0, 16)
}
```

The idea is to remember what an application form looks like, so the next form of
the same shape does not have to be re-probed from scratch. Follow the steps:

1. Take the scan's fields, keep only the **required** ones. Optional fields (EEO
   blocks especially) come and go between postings and would churn the key for no
   reason.
2. Normalise each label and drop the empties.
3. `.sort()` them — so the same set of labels in a different DOM order produces the
   same key.
4. Join them into a **basis string** with the ATS id and the host.
5. Hash it, and keep the first 16 hex characters.

Points worth absorbing:

- **Normalising before hashing is the whole game.** A hash has no notion of
  "similar", so every decision about what counts as the same form has to be made
  _before_ the hash, in how the basis string is built. Sorting the labels is such a
  decision. So is dropping optional fields.
- **SHA-1, not SHA-256, and truncated to 16 characters.** SHA-1 is broken for
  security purposes — it is possible to construct two inputs with the same digest.
  For a cache key that is not a threat model: nobody gains anything by colliding
  with your own remembered form shape. It is chosen for being short and fast, and
  the security-critical hashes in `verification.mjs` use SHA-256.
- **The host is in the basis, and that was a bug fix.** The comment records it:

  > the basis was `atsId + "|" + labels`, which is cross-tenant BY CONSTRUCTION —
  > every employer on the same ATS whose required fields carry the same labels
  > (name, email, resume: the common case) shared one fingerprint, so employer B was
  > served employer A's remembered option lists and selectors.

  Every employer on Greenhouse asks for a name, an email and a resume. Without the
  host in the basis, all of them hashed to the same key, and one company's "How did
  you hear about us?" list was re-served on another company's form. That is wrong
  _data_, not a missed optimisation — and the fix was one more piece in the basis
  string.

---

# Part 9 — Idempotence

## 9.1 The idea

An operation is **idempotent** if doing it twice has the same effect as doing it
once.

Pressing a lift's call button is idempotent — the lift comes, and pressing it
again changes nothing. Adding an item to a shopping basket is not: press it twice
and you have two.

This matters enormously in any system that can be interrupted and restarted. If an
operation is idempotent, "did that finish?" stops being a question you have to
answer — you can just run it again. If it is not, you must know precisely what
happened before you retry.

## 9.2 Where this project relies on it

**The database build.** From the header of `src/maintenance/migrate.mjs`:

> Running it twice is a no-op, running it after a schema addition just fills in the
> new tables. A single-user tool whose inputs are all re-derivable does not need
> incremental migrations — it needs one idempotent build step that can always be
> re-run.

This is why the project has no migration chain and no schema version table — a
deliberate design choice made possible by idempotence. Every `CREATE TABLE` is a
`CREATE TABLE IF NOT EXISTS`, and every import is an upsert.

**The backfill.** From `src/leads/enrich.mjs`:

> Flat and idempotent: a lead that already has a description is skipped, so
> re-running costs nothing.

You never have to work out which leads you already enriched. Run it; it sorts
itself out.

**Form filling.** From `src/apply/fill-engine.mjs`:

> …idempotent, so replaying one item is safe. THREE attempts, not one

Typing a value into a text field, choosing an option in a dropdown, ticking a box
that is already ticked — each of these leaves the same end state whether it happens
once or three times. That is what makes a retry safe when a React component
remounts mid-fill and a locator goes stale.

## 9.3 Where it deliberately does not apply

**Clicking submit is not idempotent.** Sending an application twice sends two
applications, and there is no undo. That is why the unattended runner writes a
durable claim row _before_ the click rather than after it, and why the claim
refuses rather than overwrites. Part 10 covers the mechanism.

The general rule this suggests: **make everything idempotent that you can, and be
very deliberate about the things you cannot.** The things you cannot are the places
that need locks, claims and ledgers.

---

# Part 10 — Race conditions and locks

## 10.1 What a race condition is

A **race condition** is when the result depends on the timing of two things that
run at the same time — and one of the possible timings is wrong.

The classic shape is **read-modify-write**. Two programs each:

1. read the current contents of a file,
2. change one thing in memory,
3. write the whole file back.

If they interleave, the second write is based on what the file looked like before
the first write, and the first program's change vanishes. Both programs report
success. This is called a **lost update**.

## 10.2 The measurement that proved this project had one

This is not theory here. From the header of `src/lib/lock.mjs`:

> WHY THIS EXISTS — measured, not hypothesised. Six concurrent `save-answer.mjs`
> writers over five trials lost 1 to 3 of the 6 answers in four of them, and EVERY
> process exited 0.

Six processes saving six answers to your answer bank. Four trials out of five lost
work. Nothing failed. Every process exited `0`, meaning success.

That is what makes a race condition dangerous: it has no symptom. The exit code
says fine, the log says fine, and the data is wrong.

The comment goes on to name the same shape elsewhere in the system:

> The same shape is live in the lead store: `upsertLeads` rewrites every lead in one
> transaction, so a manual sweep overlapping the scheduled one silently drops a set
> of repost counters. SQLite's own `busy_timeout` does not help there — both writers
> are individually well-formed transactions; the loss is in the read that preceded
> them.

That last sentence is worth understanding, because it is the sharpest point in this
whole section. A database transaction guarantees that a _write_ happens completely
or not at all. It does not guarantee that the _read you based the write on_ is
still current. Both writers were correct. The loss happened before either of them
started writing.

## 10.3 A lock

A **lock** is a token that only one participant can hold at a time. Before touching
the shared thing, take the lock; when finished, release it. The stretch of code in
between is the **critical section**.

The mechanism here is one line, and the comment says so:

> THE MECHANISM is `fs.openSync(path, "wx")`: create-exclusively-or-fail. That
> single syscall's atomicity IS the lock. Nothing else here is clever; everything
> else is about the one failure a lock introduces.

`"wx"` means "create this file, and fail if it already exists". The operating
system guarantees that when two processes attempt it at the same instant, exactly
one succeeds. The winner holds the lock. The loser waits and tries again.

## 10.4 The failure a lock introduces, and the fix that caused the bug

Locks have a well-known failure mode: a process crashes while holding one, and the
lockfile stays behind forever, blocking everyone. This project takes that seriously,
because:

> A guard that wedges the fact base gets deleted by the user, and a deleted guard
> protects nothing — so staleness recovery is not a nicety, it is what makes the
> lock survivable.

The rule is stated once and in capitals:

> ONE RULE BREAKS A LOCK, AND ONLY ONE: A lock whose mtime is older than `staleMs`
> is abandoned and may be broken. NOTHING ELSE BREAKS A LOCK.

Now the part that is genuinely educational. The first version of this file had a
_second_ recovery rule, which sounds like an unambiguous improvement: also break
the lock if the
process that created it is no longer running. Check the recorded process id; if
that process is gone, the lock is orphaned.

They tested it. A/B on that single variable, 20 writers × 5 trials, four
repetitions:

```
with the pid probe      LOST 7,2,13,9   MUTEX-VIOLATIONS 43,28,25,33
without it (age only)   LOST 0,0,0,0    MUTEX-VIOLATIONS  0, 0, 0, 0
```

The "safety" feature was causing the exact bug the file exists to prevent. Over 112
instrumented breaks, the pid check fired 112 times, the age check 0 times, and in
every single case the lock destroyed belonged to a _live_ holder, at an age of 0 ms.

The diagnosis is the lesson:

> The probe is not lying about the pid. What is wrong is the INFERENCE: "the process
> that wrote this record is no longer running" does not imply "this lockfile is
> abandoned", because a short-lived CLI writer's pid dies milliseconds after it
> acquires, and the lockfile you are looking at may already be a different holder's.
> An invalid inference cannot be repaired by guarding it, so the probe is gone rather
> than gated.

The cost of removing it is stated plainly rather than hidden: a holder killed
mid-critical-section blocks other waiters for up to `staleMs` (10 seconds by
default) instead of milliseconds. That is the price of not letting the recovery path
cause the bug it recovers from.

## 10.5 Locks in the database: a claim

For the unattended application runner, the shared resource is not a file — it is
the right to submit an application for a particular job. The mechanism is a
database row. From `src/lib/db.mjs`:

```js
export function recordAutoSubmission(db, sub, retry = {}) {
  const stmt = db.prepare(
    `INSERT INTO auto_submissions (...) VALUES (...)
     ON CONFLICT(slug, mode) DO UPDATE SET ...
     WHERE auto_submissions.outcome = '${RECONCILED_NOT_SENT}'`,
  )
  ...
  return withBusyRetry(() => stmt.run(row).changes, retry)
}
```

The comment states the contract:

> Returns the number of rows written: 1 means this caller owns the submit, and 0
> MEANS THE SLUG ALREADY HAS A ROW IN THIS MODE AND THIS CALLER MUST NOT CLICK.

This is a **compare-and-set**: one atomic database statement that both claims and
reports whether the claim succeeded. Two workers that both try it get `1` and `0`,
and only the `1` proceeds. Note what `0` means and does not mean — from
`CLAUDE.md`'s gotcha list:

> A **0** from `claimAutoJob`/`recordAutoSubmission` means another worker owns the
> slug and this one must not click. Not an error; the normal fan-out result.

Two more design details in that one statement:

- **The key is `(slug, mode)`**, not `(slug)` and not `(run_id, slug)`. With
  `(run_id, slug)`, one job could be submitted once per run — an unbounded number of
  times over many runs. With `(slug)` alone, a rehearsal in dry-run mode would
  consume the real claim. The composite key gives a dry run and a live run separate
  rows for the same job.
- **The `WHERE` clause is a deliberate, single exception.** A claim that refuses
  forever would deadlock a job the reconciler has proved was never sent; the
  `WHERE auto_submissions.outcome = 'reconciled-not-sent'` clause lets exactly that
  one case be re-claimed, and nothing else.

## 10.6 The honest limit

The last paragraph of the lock file's header is a model of how to document a
control:

> THE HONEST LIMIT. This is COOPERATIVE and ADVISORY. It binds processes that take
> the lock and nothing else. A hand-edit, a text editor, a script that has not been
> taught to take it, or any tool from outside this repository is not serialised by
> it. It is a coordination protocol between our own processes, not a mandatory OS
> lock — and stating that is not a caveat, it is the contract.

An advisory lock is a convention among willing participants. It is genuinely useful
and it is not a wall. Knowing which of those you have is the difference between
relying on something and over-relying on it.

---

# Part 11 — Errors: `throw`, `catch`, and returning `null`

## 11.1 Throwing

When a function cannot do its job, one option is to **throw** an error. Execution
stops immediately and jumps to the nearest enclosing `catch`, or, if there is none,
the program crashes with a message.

```js
if (index.has(id)) throw new Error(`Duplicate fact id: ${id}`)
```

Throwing is right when continuing would be worse than stopping. A duplicate fact id
makes every citation ambiguous, so building the index at all would be a mistake.

## 11.2 Catching

```js
try {
  return await fn(AbortSignal.timeout(timeoutMs))
} catch (e) {
  if (timedOut) throw new Error(`timeout after ${timeoutMs}ms for ${url}`)
  throw e
}
```

- `try { ... }` — run this, watching for errors.
- `catch (e) { ... }` — if one is thrown, `e` is it; handle it here.
- `finally { ... }` — an optional third block that runs either way, used for
  cleanup that must happen whatever occurred.

Notice this `catch` **rethrows**. It does not swallow the error; it improves it,
then passes it on. An unrecognised error is rethrown untouched, so an unexpected
failure is never disguised as a timeout.

You will also meet a deliberately empty `catch`:

```js
try {
  await page.waitForSelector("input,select,textarea,[contenteditable='true']", {
    timeout: 10_000,
    state: "attached",
  })
} catch {
  /* no control appeared; let the scan say so */
}
```

From `src/auto/stages.mjs`. An empty `catch` is usually a smell — it hides
problems. Here it is correct, and the comment carries the argument: the wait is an
optimisation, not a requirement. A page that genuinely has no form controls is a
real answer (a login wall, a closed posting), and throwing would lose that answer
and replace it with a timeout error. The rule to take away: an empty `catch` needs a
comment stating why the error is genuinely not interesting. Without one, assume it
is a bug.

## 11.3 Custom error types

An error can carry more than a message. `src/auto/submit.mjs` defines several:

```js
export class SubmitRefused extends Error {
  constructor(precondition, detail) {
    super(`submitOnce refused at precondition "${precondition}": ${detail}`)
    this.name = "SubmitRefused"
    this.code = "ESUBMITREFUSED"
    this.precondition = precondition
    this.detail = detail
  }
}
```

`extends Error` means "this is an Error, plus extra". The extra here is
`precondition` — **which** of the eleven checks said no — so a queue row's stored
reason is actionable rather than the useless "submit refused".

The types are distinct on purpose, and the reasoning is the most interesting part.
`ClassifierRequired` is a separate type, and its comment explains why:

> NOT a `SubmitRefused`, because it is not one of the eleven — those are properties
> of the job, and this is a property of how the runner was wired. Reusing a
> precondition name for it would put a wiring error in the bucket the user reads as
> "the board declined", and would quietly make the closed list of eleven mean twelve
> things.

And `SubmitAmbiguous`:

> The click was issued and something went wrong AFTER it. Deliberately a different
> type from `SubmitRefused`: this one must never be retried and must never be
> abandoned, because the request may have reached the ATS.

Three failures, three types, three different correct responses. If they shared one
type, a caller could not tell "we did not send it" from "we may have sent it" — and
those need opposite handling.

## 11.4 The convention: returning `null` instead of throwing

Many functions here do **not** throw when they fail. They return `null`.

| Function                                       | Returns `null` when                          |
| ---------------------------------------------- | -------------------------------------------- |
| `parseDateRange` (`src/lib/lib.mjs`)           | no month-year can be read from the text      |
| `sha256File` (`src/lib/verification.mjs`)      | the file does not exist                      |
| `slugForDocument` (`src/lib/verification.mjs`) | the file is not inside a job workspace       |
| `textSnippet` (`src/lib/lib.mjs`)              | there is no text left after stripping markup |

The distinction is not about severity. It is about whether "no answer" is a
**legitimate outcome of asking the question**.

- "What date range does this string describe?" — `"Various"` is a real thing a
  profile might say, and the honest answer is "no range". `parseDateRange`'s own
  comment: _"Returns null when no month-year can be read, so callers can skip the
  entry rather than guess at a duration."_ Guessing is the failure being prevented.
- "Which job workspace does this file belong to?" — a fixture in `tests/` belongs to
  none, and that is fine. `slugForDocument` returning `null` is what keeps
  verification rows out of the store when the tests point `verify-claims` at a
  fixture.
- "What is this document's hash?" — for a file that does not exist, `null`.
  `hasVerifiedResume` then returns `false`, which is the safe direction.

Contrast with `buildFactIndex`, which throws on a duplicate id. A duplicate id is
not a legitimate state of a profile; it is corruption, and no caller has a sensible
way to carry on.

The rough guide: **throw when the caller cannot sensibly continue; return `null`
when "nothing" is a real answer the caller can handle.** And whichever you choose,
say so in the function's comment, because the caller cannot tell by looking.

There is a third pattern, seen in Part 6: **errors as values**, where a failure
becomes an ordinary return value with an `error` field. That is right when many
things are being done in a batch and one failure must not end the batch.

---

# Part 12 — JSON round-tripping, and a real bug

## 12.1 Serialisation

**Serialisation** is turning a structure that lives in memory into text that can be
stored in a file or a database column. **Deserialisation** — parsing — is turning
it back. Doing both is a **round trip**.

```js
JSON.stringify(value) // structure  -> text
JSON.parse(text) // text       -> structure
```

This project round-trips constantly. `src/lib/db.mjs` stores whole leads as
JSON text in a `doc` column:

```js
const row = { id: lead.id, doc: JSON.stringify(lead) }
...
return JSON.parse(row.doc)
```

And that design choice was itself driven by round-trip fidelity. From
[./02-computer-basics.md](./02-computer-basics.md) §9: a column-per-field version
failed its own round-trip check on 73 of 99 real leads, because mapping fields by
hand could not tell `flags: []` from no flags at all.

## 12.2 What survives, and what does not

JSON has exactly six kinds of value: object, array, string, number, boolean, and
`null`. Anything else must be converted into one of those — or it is lost. Here is
what actually happens, run in Node:

```js
JSON.stringify({ label: /^country/i })
// {"label":{}}

JSON.stringify({
  a: new Set([1, 2]),
  b: new Map([["x", 1]]),
  c: undefined,
  d: new Date(0),
  e: NaN,
  f: Infinity,
})
// {"a":{},"b":{},"d":"1970-01-01T00:00:00.000Z","e":null,"f":null}
```

| Value in memory                       | After a JSON round trip               | Silent? |
| ------------------------------------- | ------------------------------------- | ------- |
| `RegExp`                              | `{}` — an empty object                | yes     |
| `Set`                                 | `{}` — contents gone                  | yes     |
| `Map`                                 | `{}` — contents gone                  | yes     |
| `undefined`                           | the key disappears entirely           | yes     |
| `Date`                                | a string; parses back as a **string** | yes     |
| `NaN`, `Infinity`                     | `null`                                | yes     |
| a function                            | the key disappears entirely           | yes     |
| a cycle (an object containing itself) | **throws**                            | no      |

Every row but the last is silent. No error, no warning. The data is not there any
more, and the shape still looks plausible.

This is why the codebase converts explicitly at the boundary. From
`src/lib/db.mjs`, where sets are stored and read back:

```js
stack: JSON.stringify([...(w.stack ?? [])])
```

```js
stack: new Set(JSON.parse(r.stack))
```

Spread the `Set` into an array on the way out; rebuild the `Set` on the way in. Two
short conversions, and the round trip is faithful.

## 12.3 The real bug: a regex with no JSON representation

The first row of that table is not hypothetical here.

Each supported applicant tracking system has an **adapter** — a plain object of
knowledge about that board's quirks. `src/apply/ats/greenhouse.mjs` contains:

```js
// Greenhouse renders its country picker with the dial code appended
// ("United States +1") and shows only "+1" once chosen, so an exact-match
// verification would report a false mismatch.
valueAliases: [
  {
    label: /^country/i,
    value: /united states/i,
    accept: /\+1|united states/i,
  },
],
```

Sensible: a note that Greenhouse displays a chosen country differently from the way
it was listed, so a verification step should not flag the difference as a failure.
`src/apply/fill-plan.mjs` copies it onto the plan:

```js
valueAliases: adapter.valueAliases ?? [],
```

And then the plan is serialised to JSON and inlined into a generated driver file.
Here is what is in a real generated plan on this machine right now,
`jobs/affirm-senior-swe-backend-lake-analytics/fill-plan.js`:

```
"valueAliases":[{"label":{},"value":{},"accept":{}}]
```

Three empty objects. `JSON.stringify` has no representation for a `RegExp`, so it
falls back to the default object serialisation — and a `RegExp`'s own enumerable
properties are none. The patterns are gone.

> **Known defect (2026-08-05 audit).** The documented Greenhouse country-picker fix
> does not exist at run time. The regular expressions serialise to `{}` and are
> unrecoverable. It causes no visible harm today only because nothing reads
> `plan.valueAliases` — a search across `src/` finds the adapter definitions and
> the two write sites, and no reader at all. The fix is to serialise each pattern as
> its `source` string and rebuild it with `new RegExp` on the far side, or to delete
> the key from all four adapters and both write sites. Full detail in
> [../audit-2026-08-05.md](../audit-2026-08-05.md).
>
> Two files involved here — `src/apply/fill-plan.mjs` and `src/apply/ats/greenhouse.mjs`
> — are under active repair as of this writing, so check their current state before
> acting on this.

Three lessons, in increasing order of importance:

1. **A `RegExp` cannot cross a JSON boundary.** If a pattern must be stored or sent
   somewhere, store `re.source` and `re.flags` as strings and rebuild it.
2. **The failure is silent in both directions.** The producing code looks right, the
   consuming code looks right, and the plan file is valid JSON. Nothing anywhere
   says "these three patterns evaporated". The only way to find it was to open the
   generated file and look.
3. **A feature nobody reads looks exactly like a feature that works.** The comment
   in `greenhouse.mjs` describes real, correct behaviour that has never happened.
   Documentation describing intent is not evidence of function; the only evidence is
   a test, or reading the output.

That third lesson is why `docs/code/14-tests.md` exists and why this project asserts
so much of its own behaviour.

---

# Part 13 — Unit tests, assertions and fixtures

## 13.1 A unit test

A **unit test** is a small program that runs one piece of your code with known
inputs and checks that the output is what it should be. "Unit" means it tests one
function or one small behaviour, not the whole system.

This project has **123 test files** under `tests/`, and `npm test` currently
requires at least **2,208** individual tests to run before it will report success.

A test looks like this, from `tests/lib/lib.test.mjs`:

```js
import test from "node:test"
import assert from "node:assert/strict"
import { extractNumbers } from "../../src/lib/lib.mjs"

test("extractNumbers normalizes separators and suffixes", () => {
  const n = extractNumbers(
    "Served 1,200 users, 99.9% uptime, 45+ stars, C++17, ≤250 ms, GPA 3.75",
  )
  assert.deepEqual(
    [...n].sort(),
    ["1200", "17", "250", "3.75", "45", "99.9"].sort(),
  )
})
```

Three parts. `test("...", () => { ... })` gives the test a name and a body — and
that name is the failure message, so it is written as a sentence describing the
behaviour. The body sets up an input and calls the function. Then it asserts.

## 13.2 An assertion

An **assertion** is a statement that must be true. If it is, nothing happens. If it
is not, the test fails and prints what it expected against what it got.

The ones this project uses:

| Assertion                | Checks                                           |
| ------------------------ | ------------------------------------------------ |
| `assert.equal(a, b)`     | `a` and `b` are the same value                   |
| `assert.deepEqual(a, b)` | two structures have the same contents throughout |
| `assert.ok(x)`           | `x` is truthy                                    |
| `assert.throws(fn)`      | calling `fn` throws                              |

`deepEqual` is the one you need for arrays and objects, because two arrays with
identical contents are still two different objects and `equal` would say no.

Note the import: `node:assert/strict`. The strict version uses `===` — no type
coercion — so `assert.equal(1, "1")` fails, as it should.

## 13.3 A fixture

A **fixture** is a fixed, known input that a test runs against. It exists so a test
is repeatable and does not depend on whatever happens to be on the machine.

The most important fixtures here are the fake profile and fake answer bank. From
`tests/fixtures/profile.yaml`:

```yaml
# Fake profile used ONLY by tests (real profile is gitignored).
meta:
  version: 1
  target_role: Full-Stack Developer
  approved_by_user: true

contact:
  name: Jane Test
  location: "Springfield, IL"
  ...
experience:
  - id: exp-acme
    title: Full-Stack Developer
    company: Acme Corp
    dates: Jan 2024 – Present
    bullets:
      - id: exp-acme-b1
        text: Built a customer portal in React and Node.js serving 1,200 users with 99.9% uptime.
```

Two reasons this file exists, and both matter:

1. **Repeatability.** Every test that needs a profile gets _this_ profile, with
   these exact fact ids, on every machine, forever. A test asserting that
   `exp-acme-b1` verifies correctly means the same thing next year.
2. **Privacy.** Your real `profile/profile.yaml` is gitignored and never leaves your
   machine. Tests cannot use it, and must not — so there is a fake one, with a fake
   name, committed to the repository.

There is a matching fixture resume, `tests/fixtures/good-resume.md`, whose bullets
cite the fixture profile's ids:

```markdown
- Built a customer portal in React and Node.js serving 1,200 users with 99.9% uptime. <!-- fact:exp-acme-b1 -->
```

And a set of deliberately broken ones — `bad-invented-number.md`,
`bad-unknown-fact-id.md`, `bad-unknown-tech.md`, `bad-missing-annotation.md` — one
per truthfulness rule, each existing so a test can prove the verifier **rejects**
it. That is the other half of testing: a gate is only proven by showing it can say
no.

## 13.4 Boundary cases

A **boundary case** is an input at the edge of what a function handles: empty,
zero, one, the maximum, absent. Most bugs live there, which is why `CLAUDE.md`
requires new features to have tests covering "success AND failure/boundary cases".

The two `mapPool` tests from §6.5 are exactly this pair. One is the happy path with
twenty items. The other is:

```js
test("mapPool handles an empty list without hanging", async () => {
  assert.deepEqual(await mapPool([], 4, async () => 1), [])
})
```

An empty list is the boundary. `Math.max(1, Math.min(4, 0))` is where the code
handles it, and this one-line test is what proves the handling is there — and would
catch its removal.

The full account of the test suite, the `npm test` gate, the test-count floor and
the fixture corpus is [../code/14-tests.md](../code/14-tests.md).

---

# Where to go next

You now have the vocabulary. These are the natural next steps:

- **[./04-ai-and-agents.md](./04-ai-and-agents.md)** — the other half of how this
  project works: tokens, context windows, skills, subagents, hooks, and prompt
  injection.
- **[./05-architecture.md](./05-architecture.md)** — how the pieces fit together
  end to end.
- **[./07-safety-model.md](./07-safety-model.md)** — the guardrails and why each
  exists. Part 7.11's point about pattern lists not being guarantees is developed
  properly there.
- **[./08-glossary.md](./08-glossary.md)** — every term in one place, for when you
  meet one cold.

When you are ready to read actual code, start with these, in this order:

- **[../code/01-lib-foundation.md](../code/01-lib-foundation.md)** — `src/lib/`
  line by line, including the deep version of `mapPool` from Part 6.
- **[../code/03-leads-screening.md](../code/03-leads-screening.md)** — the four
  screening stages from Part 5.4, each one in full.
- **[../code/14-tests.md](../code/14-tests.md)** — the deep version of Part 13.
- **[../code/00-file-index.md](../code/00-file-index.md)** — a map of all 88 files
  in `src/`, for when you want to find something specific.

And two references for when you are working rather than learning:

- **[../operate/01-commands.md](../operate/01-commands.md)** — the command
  catalogue.
- **[../audit-2026-08-05.md](../audit-2026-08-05.md)** — the full audit, including
  every "Known defect" flagged in this document.
