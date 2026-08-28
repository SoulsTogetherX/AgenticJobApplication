# The safety machinery: gates, breakers and the audit trail

There are two ways this project can send a job application. In the **attended**
way, you hand the agent a posting URL, it fills the form in a browser you can
see, and it clicks submit. In the **unattended** way, a scheduled program wakes
up at two in the morning, walks a queue of jobs, and may click submit on each
one with nobody watching the screen. Everything in this document exists because
of the second one. These eleven files are the chain of independent checks an
application has to pass before that click can happen, the ledger that records
what happened, and the brakes that stop the machine when something on the page
was not understood.

The single sentence that explains the whole design is in the header of
`src/auto/guard.mjs`:

> "Every other write path in this project is fenced by PreToolUse hooks
> (guard-files.mjs, guard-bash.mjs). A Windows scheduled task is not an agent
> tool call: no hook runs, nothing inspects the arguments, and nobody is
> watching. Every guarantee those hooks provide has to be re-established inside
> the process, or it simply is not there twice a day."

**What you will learn here**

- Why "is this board safe?" is answered by a list you wrote and a screening
  record, and never by a model's impression of the page — and why a page that
  _looks_ trustworthy is the one worth worrying about.
- How permission to click is made into an **object** you must hold, rather than
  a question you are trusted to ask.
- Why the page that comes back after a submit click reads as `unclassified` on
  every real job board today, why that is a hard stop, why it is correct, and
  what the only lawful way to change it is.
- The difference between a **timed board pause** (the machine backing off for
  five minutes) and a **durable scoped STOP** (a brake only a human clears) —
  and why merging them would undo the whole design.
- What an **orphaned attempt** is (a click that may have reached an employer,
  with nothing able to say whether it did), how `reconcile.mjs` narrows the
  damage to one company, and why widening the list of outcomes that release a
  claim would re-open a permanent-deadlock bug.
- What is written into the audit record, into which two places, and why every
  string is scrubbed on the way in.
- Nine real defects found in a 2026-08-05 audit of this area, marked as such.

**Before this**

These documents are being written alongside this one; you may want them first.

- [`../guide/03-programming-basics.md`](../guide/03-programming-basics.md) —
  functions, objects, errors, files.
- [`../guide/05-architecture.md`](../guide/05-architecture.md) — how the pieces
  of the whole system fit together.
- [`../guide/06-data-model.md`](../guide/06-data-model.md) — the tables in
  `jobs/leads.db`, which this document names constantly.
- [`../guide/07-safety-model.md`](../guide/07-safety-model.md) — the ten hard
  rules in plain English. Rules 0, 1, 2 and 6 are the ones this code implements.
- [`../guide/08-glossary.md`](../guide/08-glossary.md) — every term, in one
  place.

Nearby code documents: [`09-auto-runner.md`](09-auto-runner.md) is the runner
that calls all of this; [`07-apply-planning.md`](07-apply-planning.md) and
[`08-apply-filling.md`](08-apply-filling.md) are the machinery that produces the
plan the gate checks; [`01-lib-foundation.md`](01-lib-foundation.md) covers
`src/lib/db.mjs` and `src/lib/untrusted.mjs`, both of which this area
leans on heavily.

**The files covered here**

| File                                   | Lines | One-line purpose                                                                                         |
| -------------------------------------- | ----: | -------------------------------------------------------------------------------------------------------- |
| [`src/auto/trust.mjs`](#trust)         |   411 | Five mechanical facts that decide whether a job board may be submitted to unattended.                    |
| [`src/auto/guard.mjs`](#guard)         |   587 | The filesystem boundary, the STOP kill switch and its four scopes, and the append-only alert inbox.      |
| [`src/auto/preflight.mjs`](#preflight) |   606 | "Would a run start right now?" — six read-only checks, including a scan of the fact base.                |
| [`src/auto/authorize.mjs`](#authorize) |   796 | Eleven preconditions in one place, and the frozen single-use token that is the only permission to click. |
| [`src/auto/classify.mjs`](#classify)   |   333 | Types the page that comes back after the click, into one of seven kinds. Rules carry their evidence.     |
| [`src/auto/breaker.mjs`](#breaker)     |   326 | The circuit breaker: retry a transient, pause one board, or stop the run.                                |
| [`src/auto/reconcile.mjs`](#reconcile) |   288 | Ask the board, read-only, whether an orphaned attempt became an application.                             |
| [`src/auto/audit.mjs`](#audit)         |  1028 | The run ledger, written twice: an append-only text file and SQLite.                                      |
| [`src/auto/taxonomy.mjs`](#taxonomy)   |   394 | The closed vocabulary of reasons, and which single one gets recorded when several apply.                 |
| [`src/auto/digest.mjs`](#digest)       |   290 | "Is the machine working?" — the `auto` section of `node src/status.mjs`.                                 |
| [`src/auto/notify.mjs`](#notify)       |    81 | A Windows toast when the runner disables itself. Best-effort, cannot throw.                              |

---

## The words this document uses

These nine words have precise meanings in this codebase, and most of the design
is invisible until you have them. Read this table once; everything after it
assumes you have.

| Word                          | What it means here                                                                                                                                                                       |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **defer**                     | Decline to submit _this_ application, with a stated reason the user can act on. This is normal, healthy, and the designed outcome — not a failure. Never silent.                         |
| **fail**                      | The machine malfunctioned: a timeout, a crash, a database write that did not land. A different thing from a defer, counted separately.                                                   |
| **challenge**                 | A click went out and the board answered with a CAPTCHA, an ID check, or an emailed code. Nobody knows whether the application landed.                                                    |
| **orphan / orphaned attempt** | The "I am about to click" row was written, the process died, and nothing ever recorded what happened. There may already be an application sitting in an employer's system.               |
| **STOP**                      | A brake made of a file: its _existence_ halts things. Durable. Only a human deletes it. Four scopes: `global`, `run`, `board`, `company`.                                                |
| **board pause**               | A _timed_ backoff on one job board inside one run. Expires by itself after five minutes; cleared entirely by one success. **Not** a STOP, and confusing the two would undo the design.   |
| **token**                     | A frozen, single-use JavaScript object minted by `authorizeSubmit()`. The function that clicks cannot run without spending one.                                                          |
| **claim**                     | A database row whose job is to say "this posting is mine". A second caller trying to write the same row gets `0` back and must not click.                                                |
| **corpus**                    | The committed collection of _real_ post-submit pages captured from the owner's own attended applications. Today it is empty, deliberately, and that empties the classifier of authority. |

A word on **scope**, because it recurs. A brake with a scope says what it has
evidence _about_. A brake on one company says "this employer's state is unknown"
and proves nothing about the other 998 companies in the queue. A global brake
says "an invariant of the system is broken" and costs the whole night. The
difference exists because of one measured failure, quoted from `guard.mjs`:

> "every hard-STOP input used to halt EVERY future invocation until a human
> deleted one file. Right at N=3 and wrong at N=999, for one reason — the blast
> radius of the halt scaled with the run and the trigger did not. One
> undecidable orphan on one employer took down a night that would otherwise have
> sent 900 applications."

### The chain, in the order one job passes through it

```text
preflight.mjs   would a run start at all?  (kill switch, caps configured,
                 profile approved, fact base free of identifiers)
   |
audit.mjs       startRun()  — opens the run, hashes profile/, brakes any
                 company a previous run left a click unaccounted for
   |
trust.mjs       trustBoard() — is this board mechanically trustworthy?
                 (five yes/no facts; no model, no reading the page)
   |
authorize.mjs   authorizeSubmit() — eleven checks; mints a single-use TOKEN
   |
audit.mjs       beginSubmit() — writes the durable "I am about to click" row
   |
authorize.mjs   consumeSubmitToken() — spends the token; the last STOP read
   |
submit.mjs      THE ONE CLICK  (covered in 09-auto-runner.md)
   |
classify.mjs    what page came back?  -> one of seven kinds
   |
audit.mjs       recordSubmission() / recordRehearsal() / abandonAttempt()
   |
breaker.mjs     record() — was that a malfunction? pause a board? stop the run?
   |
reconcile.mjs   (later) an attempt nobody resolved — ask the board, or brake
                 that one company
   |
digest.mjs      is the machine working?  (read by `node src/status.mjs`)
notify.mjs      a Windows toast when the runner disables itself
taxonomy.mjs    the closed vocabulary every deferral and failure is recorded in
```

---

<a id="trust"></a>

## 1. `src/auto/trust.mjs` — the board trust gate

### 1.1 What it is and why it exists

Without this file there is no answer to the question: _is this website safe to
type the user's name, phone number, work-authorisation answers and résumé into,
with nobody looking?_

The tempting way to answer that is to let a model read the posting and judge
whether it looks legitimate. That is precisely the thing hard rule 6 forbids,
and the file's own header says why in capitals:

> "It is MECHANICAL. Five facts, each one either true or false without anything
> reading the page … No model, no impression of the page, no 'this posting reads
> as legitimate'."

**Why "it looked legitimate" is not merely weak but backwards.** A page that
looks trustworthy is exactly the page an attacker builds. A crude scam page is
caught by every reader; a careful one is caught by none, and the model reading
it is the least equipped reader in the chain, because it is the one that will
then act on what it read. Worse, the page is _attacker-controlled input to the
same context window that holds the user's fact base_ — so a "does this look
real?" judgement hands a hostile page a lever on the decision about itself. The
five checks below cannot be talked out of their answers, because none of them
reads the page at all.

The header also states, up front, the limit the allowlist **cannot** cover, and
this is the single most important paragraph in the file:

> "Every Greenhouse tenant is same-origin with every other Greenhouse tenant and
> with the cookie holding the user's Greenhouse session, and ATS tenancy is
> self-service — anyone can have one. So the allowlist answers 'is this the
> vendor's software' while the gate is being asked 'is this party safe to submit
> to unattended'. THE ALLOWLIST CAN NEVER BE LOAD-BEARING AGAINST A HOSTILE
> TENANT, and no amount of pattern-matching added below will change that."

> _Multi-tenant SaaS_: one company (Greenhouse) runs the software, and thousands
> of employers each rent a "tenant" on it. They all share one internet address —
> `boards.greenhouse.io` — so from the browser's point of view they are the same
> site. Anyone can sign up for a tenant. The allowlist proves you are on
> Greenhouse's software; it does not prove the employer behind that particular
> tenant is honest.

The two controls that _do_ survive a hostile tenant are named in the header and
live elsewhere: carry no session cookie on boards that do not need one, and
never read anything back out of the page to make a decision.

**Why this file deliberately does not call `detectAts()`.** There is a function
elsewhere in the repo, `detectAts()` in `src/apply/ats/index.mjs`, that
guesses which job-board software a URL belongs to. It matches its patterns
against the **whole URL string**, which is right for picking a form-filling
strategy (guess wrong and you just defer more fields) and dangerous for a trust
decision:

> "For a TRUST decision it is fail-dangerous, because a third party controls the
> query string:
> `https://evil.example/apply?utm_source=boards.greenhouse.io`
> would 'match greenhouse'. So the ATS is not inferred from the URL at all here.
> It is DECLARED, by the user, next to the domain in their own file."

> _Query string_: the part of a web address after the `?`. Anyone who writes a
> link can put anything there, including the name of a job board they have
> nothing to do with.

### 1.2 How you run or use it

This is a **library** — there is no command line and no `main()`. It is imported
by:

- `src/auto/auto-apply.mjs` — `trustBoard`, `allowlistProblems`,
  `readLimits`. Used in `selectEligible()` to filter the queue before anything is
  enqueued, and `allowlistProblems()` is printed to stderr at startup.
- `src/auto/job.mjs` — `trustBoard`, re-run per job, so a configuration
  change between queueing and execution cannot slip through.
- `src/auto/cycle.mjs` — `trustBoard`, `readLimits`.
- `tests/auto/trust.test.mjs`.

### 1.3 Everything it exposes

| Export                          | Signature / value                                                    | What it is                                                                                                                                 |
| ------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `TRUST_CHECKS`                  | frozen `["allowlist","adapter","screening","https","origin_stable"]` | The closed list of check names. A sixth check must be added **here**, not smuggled in as an early return.                                  |
| `ADAPTER_IDS`                   | frozen array — today `["greenhouse","lever","ashby"]`                | The job-board adapters this repository actually ships, taken from `ADAPTERS` in `src/apply/ats/index.mjs`.                                 |
| `isLoopbackHost(host)`          | `-> boolean`                                                         | Literal membership of `{"127.0.0.1", "[::1]", "::1", "localhost"}`, lowercased.                                                            |
| `domainMatches(host, domain)`   | `-> boolean`                                                         | `h === d                                                                                                   \|     \| h.endsWith("." + d)`. |
| `normalizeAllowlist(raw)`       | `-> [{domain, ats}]`                                                 | Accepts a YAML map or a list of objects. A bare list of domain strings is refused on purpose.                                              |
| `allowlistProblems(raw)`        | `-> string[]`                                                        | Human-actionable complaints about the user's allowlist.                                                                                    |
| `allowlistEntry(host, entries)` | `-> {domain, ats} \| null`                                           | The longest matching domain wins, so a specific entry beats a broad one.                                                                   |
| `trustBoard({...})`             | `-> frozen {ok, reason, kind, checks, failed, entry, origin}`        | The gate itself.                                                                                                                           |
| `readLimits(file)`              | `-> parsed YAML \| null`                                             | Absent file gives `null`. A **malformed** file throws, deliberately.                                                                       |

`trustBoard` takes one options object:

| Parameter           | Default | Meaning                                                                                              |
| ------------------- | ------- | ---------------------------------------------------------------------------------------------------- |
| `lead`              | —       | The stored lead. Only `apply_url` is read.                                                           |
| `limits`            | `null`  | The parsed `docs/application-limits.yaml`, either the whole document or just its `auto_apply` block. |
| `screening`         | `null`  | The stored screening verdict for this lead.                                                          |
| `recordedOrigin`    | `null`  | The origin stored on the `auto_queue` row when this job was queued.                                  |
| `allowLoopbackHttp` | `false` | The fixture exemption. Only the runner's `--fixture` flag sets it.                                   |

Why `readLimits` throws on a malformed file rather than returning `null`:
_"silently treating unparseable YAML as 'no config' is how a typo turns into an
open gate."_

`allowlistProblems` exists separately from the gate, and its docstring explains
the split:

> "the gate refuses ONE job and says why, while this answers 'why is nothing
> being submitted' in one line at startup. A typo'd ats id would otherwise show
> up only as every job deferring `board-untrusted`, which reads as 'the boards
> are untrusted' rather than 'your file says `greenhosue`'."

### 1.4 How it works, step by step

`trustBoard` builds an array of check results using a local helper
`add(name, ok, detail, kind = "board-untrusted")`, then returns all five.

1. `const auto = limits?.auto_apply ?? limits ?? null` — accepts either the whole
   YAML document or just the `auto_apply` block.
2. `normalizeAllowlist(auto?.board_allowlist)` turns the user's list into
   `[{domain, ats}]`.
3. `const applyUrl = lead?.apply_url ?? null` — **`apply_url`, never `url`.** For
   a lead found through an aggregator site, `url` is the aggregator, not the
   board. It is parsed with `new URL()` inside a `try/catch`.
4. **Check 1, `allowlist`.** Fails with a specific sentence for each of: no
   `apply_url` at all, an unparseable one, an empty allowlist, or a hostname no
   entry covers.
5. **Check 2, `adapter`.** `ADAPTER_IDS.includes(entry.ats)` — the id the _user
   declared_, checked against what the repository ships.
6. **Check 3, `screening`.** Delegated to the private `screeningVerdict()`. Three
   outcomes: no stored verdict at all gives `kind: "board-untrusted"`; an
   explicit rejection (`verdict === "reject"`, `rejected === true`, or
   `status === "dismissed"`) gives `kind: "l3-rejected"`; and any finding whose
   kind passes `isDisqualifying()` (from `src/lib/untrusted.mjs`) also gives
   `l3-rejected`. Findings are gathered from four possible carriers on the stored
   verdict: `screening`, `screening.stages?.l3`, `screening.l3`, `screening.risk`.

   The comment on why those two failure kinds differ is load-bearing:

   > "NEVER SCREENED IS NOT THE SAME EVENT AS REJECTED … Collapsing them would
   > put a plumbing problem in the bucket the user reads as 'boards rejecting
   > me'."

7. **Check 4, `https`.** `protocol === "https:"` passes. The only exemption is
   `allowLoopbackHttp === true` **and** `http:` **and** `isLoopbackHost(hostname)`
   — _"The exemption is scoped to BOTH conditions — flag on AND literally this
   machine — so turning the flag on cannot widen the gate to the internet."_
8. **Check 5, `origin_stable`.** Compares `submitOrigin(applyUrl)` (imported from
   `authorize.mjs`) against `recordedOrigin`, the origin stored on the queue row.
   A mismatch is recorded with `kind: "origin-mismatch"`, which is a **failure**
   kind rather than a defer kind:

   > "A MISMATCH HERE IS A MALFUNCTION OF OURS, not a board declining … Filing
   > that under `board-untrusted` would report our own inconsistency as the
   > board's fault."

9. Returns a frozen object: `ok` (no failures), `reason` (`"<first failing
check>: <detail>"`), `kind` (the first failing check's kind), `checks` (**all
   five**, passing ones included, _"because the report the user reads before
   enabling this needs to show the ones that passed too"_), `failed`, `entry`,
   `origin`.

**Worked example.** Say the lead is:

```js
{
  slug: "acme-fullstack",
  company: "Acme",
  apply_url: "https://boards.greenhouse.io/acme/jobs/12345",
}
```

with `auto_apply.board_allowlist: { "boards.greenhouse.io": "greenhouse" }`, a
screening verdict of `{ verdict: "pass", findings: [] }`, and
`recordedOrigin: "https://boards.greenhouse.io"`. Every check passes:

| Check           | Result                                                                       |
| --------------- | ---------------------------------------------------------------------------- |
| `allowlist`     | `boards.greenhouse.io is covered by allowlist entry "boards.greenhouse.io"`  |
| `adapter`       | `allowlist declares ats "greenhouse", which is a shipped adapter`            |
| `screening`     | `cleared L0-L3, no disqualifying finding`                                    |
| `https`         | `apply_url is https`                                                         |
| `origin_stable` | `origin https://boards.greenhouse.io matches the one recorded at queue time` |

Now change one character in the URL to
`https://boards.greenhouse.io.evil.test/acme/jobs/1`. This is a domain an
attacker can register, and it _starts with_ the allowlisted name.
`domainMatches("boards.greenhouse.io.evil.test", "boards.greenhouse.io")` asks
whether the host ends with `.boards.greenhouse.io` — it does not — so check 1
fails with:

```text
allowlist: boards.greenhouse.io.evil.test is not on auto_apply.board_allowlist
```

and `kind: "board-untrusted"`. That leading dot is the entire reason
`domainMatches` exists rather than a bare `endsWith`:

> "The dot is what stops `evilgreenhouse.io` matching an entry of
> `greenhouse.io` — a bare `endsWith` would accept it, and that is the whole bug
> this function exists to not have."

### 1.5 What it reads and writes

**Reads:** the lead object (`apply_url` only), the parsed
`docs/application-limits.yaml` (`auto_apply.board_allowlist` only), the stored
screening verdict, and a `recordedOrigin` string.

**Writes:** nothing. No file, no database, no stdout.

### 1.6 Traps and things not to "fix"

- **Five checks, closed list.** A sixth must be added to `TRUST_CHECKS` so a
  report can name it.
- **Never infer the ATS from the URL.** See §1.1.
- **`apply_url`, not `url`.**
- **`recordedOrigin` must come from the queue row**, not from another field of
  the same lead — _"comparing a row against itself is a tautology: the point is
  to catch the lead store changing under a queued job."_
- **`isDisqualifying` is not re-listed here** — _"a second copy of that list is a
  second thing to forget to update (rule 0)."_
- **A malformed limits file throws and should keep throwing.**

> **Known defect (2026-08-05 audit).** `trust.mjs`'s `isLoopbackHost` is a
> literal four-member set, while `classify.mjs` has its own private loopback test
> that accepts any complete `127.x.y.z` address and any host ending in
> `.localhost`. Both carry careful comments explaining why _their_ version is
> right, and both are defensible in isolation — but a fixture served on
> `127.0.0.2` is "loopback" to the classifier and "not loopback" to the trust
> gate, and an edit to one will not be mirrored in the other. One exported
> predicate (the stricter `classify.mjs` semantics, which already handles the
> `127.0.0.1.evil.test` trap) imported by both would fix it.

### 1.7 Dependencies

**Imports:** `node:fs`; `ADAPTERS` from `../apply/ats/index.mjs`; `loadYamlFile`
from `../lib/lib.mjs`; `submitOrigin` from `./authorize.mjs`; `isDisqualifying`
from `../lib/untrusted.mjs`; `safeText` from `./untrusted-text.mjs`.

**Depended on by:** `auto-apply.mjs`, `job.mjs`, `cycle.mjs`,
`tests/auto/trust.test.mjs`.

---

<a id="guard"></a>

## 2. `src/auto/guard.mjs` — the boundary, the kill switch, the inbox

### 2.1 What it is and why it exists

Three separate controls live in this one file, because all three are things that
have to be true inside the process rather than around it:

1. **The filesystem boundary** — the unattended path may write inside `jobs/` and
   nowhere else, ever.
2. **The STOP kill switch** — the user's brake, and the runner's own, with four
   scopes.
3. **The append-only `INBOX.md` alert channel** — a log a human reads.

The header contains a correction of an earlier, false claim, and it teaches the
difference between a _check_ and an _enforcement_ better than anything else in
the repository:

> "This paragraph previously claimed the guards were 'structurally impossible for
> the runner to skip on the submit path, because src/auto/audit.mjs performs
> them before it will record anything'. That was written in the indicative about
> something that had not been built … It was also wrong on its own terms —
> RECORDING HAPPENS AFTER SUBMITTING. A check on the path to the record runs
> after the click, and an application cannot be unsent."

And, plainly: _"These functions are checks. They enforce nothing by existing."_
What makes them unskippable is `authorize.mjs`'s token, plus the test
`tests/auto/click-surface.test.mjs`.

### 2.2 How you run or use it

A **library**. Imported by `audit.mjs`, `authorize.mjs`, `preflight.mjs`,
`reconcile.mjs`, `digest.mjs`, `auto-apply.mjs`, `job.mjs` and
`src/apply/capture-post-submit.mjs`, plus four test files.

Setting the brake by hand is a one-line shell command, and that is deliberate:

```powershell
# Windows, in the project root — an empty file is a valid STOP
New-Item -ItemType File jobs\.auto\STOP
```

### 2.3 Everything it exposes

**Path constants.** All derived from `import.meta.url`, so they are correct no
matter what working directory a scheduled task happens to start in.

| Constant      | Path                         |
| ------------- | ---------------------------- |
| `ROOT`        | the repository root          |
| `JOBS_DIR`    | `<root>/jobs`                |
| `AUTO_DIR`    | `<root>/jobs/.auto`          |
| `RUNS_DIR`    | `<root>/jobs/.auto/runs`     |
| `STOP_PATH`   | `<root>/jobs/.auto/STOP`     |
| `STOPS_DIR`   | `<root>/jobs/.auto/stops`    |
| `INBOX_PATH`  | `<root>/jobs/.auto/INBOX.md` |
| `PROFILE_DIR` | `<root>/profile`             |

**Error classes.**

| Class           | `name`          | `code`         | Extra fields                                 |
| --------------- | --------------- | -------------- | -------------------------------------------- |
| `BoundaryError` | `BoundaryError` | `EOUTSIDEJOBS` | —                                            |
| `StopError`     | `StopError`     | `ESTOP`        | `checkpoint`, `reason`, `scope`, `key`, `at` |

> _An error `code`_: a short machine-readable string on the error object, so
> other code can react to _which_ error it is (`e.code === "ESTOP"`) without
> matching on the human-readable message, which is allowed to change.

`StopError`'s message differs by scope. A global one says
`STOP is set — halted at the "pre-submit" checkpoint.`; a scoped one adds
_"Only this company is held back; everything else keeps running."_ Both end with
`Delete <path> to allow the next run.`

**Checkpoints.**

```js
export const CHECKPOINTS = Object.freeze({
  RUN_START: "run-start",
  BETWEEN_JOBS: "between-jobs",
  PRE_SUBMIT: "pre-submit",
})
```

> _"A closed set, because 'checked at start' and 'checked before each submit' are
> different guarantees and a call site that names neither is a call site nobody
> can audit."_

**The boundary.**

| Function                                                | Returns / throws                                   |
| ------------------------------------------------------- | -------------------------------------------------- |
| `assertInsideJobs(target, { jobsDir = JOBS_DIR } = {})` | the resolved absolute path; throws `BoundaryError` |
| `assertNotProfile(target)`                              | the resolved path; throws `BoundaryError`          |

`assertInsideJobs` does **two** checks, and the second is the one people forget:

1. _Lexical_ — `path.resolve()` flattens any `..` segments, then the result must
   equal the base or start with the base plus a path separator.
2. _Symlink_ — a private `realpathOfNearestAncestor()` walks up until it finds a
   path that exists and can be resolved to its real location, and compares that
   against the real location of `jobs/`. The base is resolved too, and the
   comment explains why: _"on Windows the project may sit under a junction, in
   which case an honest path realpaths to a different prefix and a naive
   comparison would reject everything."_

> _Symlink / junction_: a filesystem entry that is a pointer to somewhere else. A
> path like `jobs/sneaky/` can be a pointer to `C:\Windows\`, and comparing the
> text of the path would never notice.

`assertNotProfile` is a loud version of a property that is really enforced by
absence: _"profile/ is READ-ONLY to this path, and the way that is enforced is
that there is no function here that writes it."_

**The kill switch.**

| Function                                    | Returns          |
| ------------------------------------------- | ---------------- |
| `stopActive({ stopPath = STOP_PATH } = {})` | `boolean`        |
| `readStop({ stopPath = STOP_PATH } = {})`   | `string \| null` |

It is existence-based, not content-based, and the header says why:

> "`type nul > jobs\.auto\STOP` creates a zero-byte file, and that has to work.
> There is no YAML to get wrong, no key to misspell, and no editor needed at 2am.
> An empty STOP stops just as hard as an annotated one."

**Scopes.**

| Export                                                       | Signature                                              |
| ------------------------------------------------------------ | ------------------------------------------------------ |
| `STOP_SCOPES`                                                | frozen `["global","run","board","company"]`            |
| `stopKey(raw)`                                               | `-> string`; **throws `TypeError`** on an empty result |
| `scopedStopPath(scope, key, { stopPath, stopsDir })`         | `-> string` path                                       |
| `activeStops({ board, company, runId, stopPath, stopsDir })` | `-> [{scope, key, at, reason}]`, global first          |
| `assertNotStopped(checkpoint, {...})`                        | `-> true`; throws `StopError` or `TypeError`           |

The scope doctrine, quoted verbatim because paraphrasing it loses the argument:

> "company — this employer's state is unknown … It proves nothing about any other
> company. board — this ATS behaved in a way nothing understood … run — this
> run's own bookkeeping is broken … global — a broken invariant. RESERVED FOR THE
> FOUR §4.6 BREACHES and nothing else, because global is the one that costs a
> night."

**And the sentence this whole document exists partly to preserve:**

> "A SCOPED STOP IS NOT A BOARD PAUSE, and conflating the two would undo §4.6.
> The pause (`board_pauses` in db.mjs) is a TIMED backoff with probe
> re-admission, cleared by one success, never persisted across invocations
> without re-probing — it is the breaker absorbing a wifi drop. A board-scoped
> STOP is a BRAKE: durable, and cleared only by a human deleting the file,
> exactly like the global one. The breaker must never reach for this."

> "THERE IS STILL NO clearStop(), AT ANY SCOPE. Self-disabling is the real
> rollback, an application cannot be unsent, and code that can clear its own
> brake does not have one."

`stopKey` turns arbitrary text into a filename:

```js
String(raw ?? "")
  .toLowerCase()
  .replace(/[^a-z0-9._-]+/g, "-")
  .replace(/^[-.]+|[-.]+$/g, "")
  .slice(0, 80)
```

> _Regular expression_: a compact pattern language for describing text.
> `[^a-z0-9._-]+` means "one or more characters that are **not** a lowercase
> letter, digit, dot, underscore or hyphen", and `.replace(..., "-")` swaps each
> such run for a single hyphen. So `"Acme, Inc."` becomes `"acme-inc"`.

Two properties matter. First, it **throws** when the result is empty, _"because
an unkeyed scope would silently become global"_. Second, the mapping is
deliberately many-to-one:

> _"'Acme, Inc.' and 'Acme Inc' land on the same key. For a brake that is the
> safe direction: a collision can only ever over-block, never under-block."_

**The alert channel.**

| Function                                                                                | Returns                                                                    |
| --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `appendInbox({kind, summary, detail, meta, at}, {inboxPath, jobsDir})`                  | `boolean` — **never throws**                                               |
| `raiseSecurityAlert(finding, {inboxPath, jobsDir, at})`                                 | `boolean`                                                                  |
| `raiseStop(reason, {scope, key, stopPath, stopsDir, jobsDir, meta, inboxPath, notify})` | `true` if the brake file was newly written, `false` if one already existed |

The asymmetry between the brake and the notification is the design:

> "raiseStop's first-reason-wins rule is exactly right for the brake … Applied to
> NOTIFICATION the same rule is dangerous — a benign STOP at job 3 would swallow
> a credential exposure at job 400, and the user would read the benign one and
> delete the file. So INBOX.md is APPEND-ONLY and takes everything."

### 2.4 How `raiseStop` works, and why it throws rather than widening

`raiseStop` is the runner disabling itself. Its parameter contract has three
refusals, and the third is the one worth understanding:

| Situation                                        | Result                                                      |
| ------------------------------------------------ | ----------------------------------------------------------- |
| unknown `scope`                                  | `TypeError`                                                 |
| `scope === "global"` **with** a `key`            | `TypeError` — a caller that named a key meant to scope this |
| non-global scope with a missing or unkeyable key | `TypeError` from `stopKey`                                  |

The docstring is explicit that the last one is the point:

> "`key` — required for every non-global scope, and a missing one THROWS. That is
> the load-bearing half of this change: a caller that meant 'pause this board'
> and passed no key must fail loudly, never quietly widen to a brake on
> everything."

Think about the alternative. If `raiseStop("greenhouse is behaving oddly",
{scope: "board"})` silently fell back to a global brake, then a bug in one caller
— a caller that _thought_ it was pausing one board — would halt every future
run of the machine, and the log would say "board". The failure would be
invisible in code review and only visible at 6am with nothing applied. A loud
crash in one caller, on the other hand, is a bug that gets fixed the first time
it happens. **Fail loudly on the narrow thing, never quietly on the wide thing.**

The order of operations inside `raiseStop` is also deliberate:

1. Validate the scope and compute the brake file's path (`scopedStopPath`, which
   calls `stopKey` and may throw).
2. `assertInsideJobs` the target path, and create the directory.
3. Note whether a brake file already exists there.
4. **Append to `INBOX.md` first**, and unconditionally, whether or not a brake was
   already set — _"The second STOP of a run is the one most likely to be the
   serious one, and it is the one the brake file will never mention."_
5. Call `notify()` (the Windows toast) inside a `try/catch` — _"a cosmetic
   notification must never be able to break the brake."_
6. If a brake file already existed, return `false` **without overwriting it**.
   First reason wins.
7. Otherwise write the brake file and return `true`.

The brake file body looks like this:

```text
STOPPED 2026-08-04T02:14:07.113Z
scope: company
key: Acme, Inc. (filed as acme-inc)
a submit attempt from a run that never finished may already be an application at Acme, Inc.:
  - acme-fullstack (Acme, Inc., live) attempted 2026-08-04T01:59:58.412Z at https://boards.greenhouse.io/acme/jobs/12345
Check that page, log or withdraw as appropriate, then delete this file. Other companies are unaffected and will keep running.
{
  "orphan": { ... }
}

The unattended runner set this itself. Jobs on this company will not run until this file is deleted.
```

**Worked example of `assertNotStopped`.** Call:

```js
assertNotStopped("pre-submit", {
  company: "Acme, Inc.",
  board: "greenhouse",
  runId: "2026-08-04T02-10-00-000Z-a1b2c3",
})
```

1. `"pre-submit"` is one of `CHECKPOINTS`, so it proceeds. (An unknown checkpoint
   throws a `TypeError` — _"an unnamed checkpoint cannot be audited"_.)
2. `activeStops(...)` looks for `jobs/.auto/STOP` first, pushing a `global` entry
   if it exists, then for `["run", runId]`, `["board", board]` and
   `["company", company]` in that order — skipping any that are null or blank,
   computing `jobs/.auto/stops/<scope>/<stopKey(raw)>` for each, and pushing the
   ones that exist. A company brake at `jobs/.auto/stops/company/acme-inc` is
   found here.
3. `const [first] = ...` — the **global** one is reported first when several
   apply, _"it is the one that explains the most"_.
4. A `StopError` is thrown naming the checkpoint, the reason read from the file,
   the scope, the key and the path.

### 2.5 What it reads and writes

| Path                             | Read / written                                                                  |
| -------------------------------- | ------------------------------------------------------------------------------- |
| `jobs/.auto/STOP`                | read by `stopActive`/`readStop`; written by `raiseStop` at global scope         |
| `jobs/.auto/stops/<scope>/<key>` | read by `activeStops`; written by `raiseStop` at any non-global scope           |
| `jobs/.auto/INBOX.md`            | appended by `appendInbox`; never truncated, never rewritten, never read by code |

No database access at all.

`INBOX.md` is Markdown with one `## <ISO timestamp> — <KIND>` section per entry
and an optional fenced JSON block, and it opens with a header that tells you what
it is not:

> "Append-only. Every STOP and every security-class finding lands here, newest at
> the bottom. Deleting entries is safe — nothing reads this file — but the brake
> is `STOP`, not this, and clearing one does not clear the other."

### 2.6 Traps and things not to "fix"

- **There is no `clearStop()` at any scope. Do not add one.**
  `tests/auto/guard.test.mjs` asserts twice that this module does not export a
  clear or reset function.
- **`stopActive` is existence-based.** An empty file is a valid STOP. Do not
  "improve" it into a parsed config file.
- **`appendInbox` swallows every error on purpose** — _"an alert channel that can
  break the caller is worse than no alert channel, because the caller is usually
  mid-anomaly."_ This has a real consequence, recorded in `audit.mjs`: if
  `jobsDir` is redirected but `inboxPath` is not, the alert is refused by
  `assertInsideJobs` and vanishes silently. That is why **every `raiseStop` call
  in `audit.mjs` names `inboxPath` explicitly.**
- **`jobsDir` is a testability seam, and the file is honest about the cost:**
  _"a caller that supplies both stopPath and jobsDir can point this anywhere, so
  the boundary constrains ACCIDENTS, not a caller that has decided to leave the
  tree."_
- **`activeStops` swallows an unkeyable value; `raiseStop` throws on one.** That
  asymmetry is intentional on the read side and is the root of a real defect on
  the write side — see below.

> **Known defect (2026-08-05 audit).** A company name containing no ASCII letters
> or digits crashes the orphan brake instead of setting it. `stopKey` throws when
> the normalised key is empty (`"楽天"` → `"-"` → `""` → throw), but
> `audit.mjs`'s `companyScope()` only tests whether the trimmed name is truthy,
> so a truthy-but-unkeyable name selects `scope: "company"` and the throw
> propagates. It is reachable from `assertNoOrphanAttempts`, `finish()`,
> `beginSubmit` and `reconcileAll`. The result: `startRun` throws a bare
> `TypeError`, **no brake file is written at all**, and the orphan protection is
> defeated in the one case it exists for. `activeStops` already handles this on
> the read side with `try { … } catch { continue }`; the fix is the same
> treatment on the write side, falling back to the **global** brake, which is the
> pessimistic direction `companyScope`'s own docstring argues for.

### 2.7 Dependencies

**Imports:** `node:fs`, `node:path`, `fileURLToPath` from `node:url`, and `toast`
from `./notify.mjs`.

**Depended on by:** `audit.mjs`, `authorize.mjs`, `preflight.mjs`,
`reconcile.mjs`, `digest.mjs` (only `stopActive`/`readStop`), `auto-apply.mjs`
(`StopError`, `ROOT`), `job.mjs` (`StopError`), and
`src/apply/capture-post-submit.mjs`.

---

<a id="preflight"></a>

## 3. `src/auto/preflight.mjs` — "would a run start right now?"

### 3.1 What it is and why it exists

A read-only gate that runs **before** an unattended run and refuses to let one
start if the kill switch is on, the caps are not configured, live mode is not
authorised, the profile is not approved, or **the fact base holds something that
looks like a government or financial identifier, or like an instruction aimed at
the agent**.

The header contains the clearest explanation in the repository of why a
write-time guard is not the same thing as an invariant:

> "save-answer.mjs refuses a government or financial identifier at the WRITE
> boundary — exit 4, no override … So the invariant that actually shipped is:
> 'this script never puts one there' which is NOT: 'the fact base never holds
> one'."

Three gaps separate those two sentences. (1) Entries stored before the guard
existed — a write boundary cannot reach backwards. (2) A hand-edit of
`profile/answers.yaml`, which bypasses the script — _"and it is CORRECT to bypass
it — hard rule 2 makes the fact base the user's"_. (3) The one nobody had
covered:

> "the write boundary only guards `answers.yaml`. `profile/profile.yaml` is typed
> into third-party forms by exactly the same pipeline, and NO script writes it,
> so every value in it arrived by hand and none of them ever passed a check."

There is also a specification bug that was found and corrected, and it is a
lesson about guards in general:

> "The original blast-radius spec said this preflight would refuse 'if
> answers.yaml has keys matching SSN / DOB / bank / passport patterns'. Keys
> only. That was corrected on 2026-07-31 … a-002 — 'Do you have a valid Nevada
> driver's license?' -> 'No' — matches the licence KEY. A key-only guard throws
> out a truthful 'No'. A guard that refuses an honest answer gets bypassed, and a
> bypassed guard protects nothing."

So the matching is **two-factor**: the shared helper `findSensitiveValues()` in
`src/lib/untrusted.mjs` refuses on the value alone only for shapes that carry
their own proof (a Social Security number's 3-2-4 grouping, an IBAN that passes
its mod-97 checksum, a card number that passes the Luhn check _and_ has a real
issuer prefix), and otherwise needs the question and the value to agree.

### 3.2 How you run or use it

It is **both** a command-line tool and a library.

```text
usage: preflight.mjs [--mode dry_run|live] [--answers <file>] [--profile <file>]
                     [--limits <file>] [--json]
       Reports only. This script never writes anything.
```

A real run against the test fixtures:

```console
$ node src/auto/preflight.mjs --mode dry_run \
    --profile tests/fixtures/profile.yaml \
    --answers tests/fixtures/answers.yaml \
    --limits docs/application-limits.yaml
Preflight (dry_run) — nothing written.
  ok     stop_switch: no jobs/.auto/STOP
  ok     auto_apply_caps: per_run_max=10 per_day_max=10 per_company_max_per_week=5
  ok     auto_submit_authorised: mode=dry_run — nothing is submitted, so authorisation is not required (auto_apply.enabled=true)
  ok     profile_approved: meta.approved_by_user is true
  ok     answer_bank_scan: 1 entries, 0 error / 0 review
  ok     profile_fact_scan: 45 scalar facts scanned, 0 sensitive

CLEAR to run in dry_run mode.

Limits: a boundary, not a proof: shape matching only, no view of where a value is POSTED, and no ability to tell a false answer from a true one. It bounds what an unattended run can type into a form; it does not certify that what it types is right.
```

And a refusal, pointing at a limits file with `enabled: false`:

```console
$ node src/auto/preflight.mjs --mode live --limits /tmp/limits-off.yaml ...
Preflight (live) — nothing written.
  ok     stop_switch: no jobs/.auto/STOP
  ok     auto_apply_caps: per_run_max=10 per_day_max=10 per_company_max_per_week=5
  REFUSE auto_submit_authorised: auto_apply.enabled is not true — auto-submit ships disabled and the user turns it on
  ok     profile_approved: meta.approved_by_user is true
  ok     answer_bank_scan: 1 entries, 0 error / 0 review
  ok     profile_fact_scan: 45 scalar facts scanned, 0 sensitive

REFUSED: auto_submit_authorised (exit 1).
```

As a library, `auto-apply.mjs` imports `{ preflight, EXIT, DEFAULT_LIMITS }` and
calls `preflight({mode, limitsDoc, profileDoc, answersDoc})` in `main()`; a
non-`OK` exit aborts the run unless `--enqueue` was passed.

**A test guard at the bottom of the CLI is itself a control:**

> "On 2026-07-31 two agents wrote fabricated answers into the real fact base.
> This script cannot write, so it cannot repeat that — but it CAN read the user's
> private profile and print findings about it into a transcript."

So when `process.env.NODE_TEST_CONTEXT` is set (which `node --test` does
automatically), the CLI refuses to fall back to the real `profile/` and demands
`--answers` and `--profile` pointing at fixtures.

### 3.3 Everything it exposes

| Export                            | Value / signature                                                                         |
| --------------------------------- | ----------------------------------------------------------------------------------------- |
| `PREFLIGHT_LIMITS`                | The honest-limits sentence printed with every report.                                     |
| `EXIT`                            | frozen `{ OK: 0, REFUSED: 1, USAGE: 2, INSTRUCTION_SHAPED: 3, SENSITIVE: 4 }`             |
| `DEFAULT_ANSWERS`                 | `<root>/profile/answers.yaml`                                                             |
| `DEFAULT_PROFILE`                 | `<root>/profile/profile.yaml`                                                             |
| `DEFAULT_LIMITS`                  | `<root>/docs/application-limits.yaml`                                                     |
| `MAX_FACT_NODES`                  | `20_000`                                                                                  |
| `flattenFacts(doc, { maxNodes })` | `-> { facts: [{path, question, value}], truncated: boolean }`                             |
| `scanProfileFacts(doc, opts)`     | `-> { findings, truncated, scanned }`                                                     |
| `preflight({...})`                | `-> { ok, mode, exit, checked_at, checks, refusals, warnings, limits, sensitive_limits }` |

| Exit code | Meaning                                                                |
| --------: | ---------------------------------------------------------------------- |
|         0 | clear to run                                                           |
|         1 | refused for a reason that is not the fact base (STOP, caps, approval)  |
|         2 | usage error, or a file could not be read or parsed                     |
|         3 | refused: stored text is instruction-shaped (hard rule 0)               |
|         4 | refused: the fact base holds something identifier-shaped (hard rule 2) |

> "3 and 4 keep save-answer's meanings so that 'what would the write boundary have
> done with this entry?' has one answer across both scripts."

The library function's `mode` parameter has **no default**: _"an unattended
process that has to guess whether it may send real applications is already wrong,
whichever way it guesses."_ The CLI defaults to the safe one, `dry_run`.

### 3.4 How it works, step by step

Six checks, each producing `{ id, verdict: "pass"|"warn"|"refuse", detail,
remedy?, findings? }`.

1. **`stop_switch`** — `stopActive({stopPath})`, quoting only the first line of
   the reason. _"the preflight is what a human runs to ask 'would a run start
   right now?', and answering that without reading the brake would be answering a
   different question."_
2. **`auto_apply_caps`** — the `auto_apply` block must exist and carry finite
   non-negative `per_run_max`, `per_day_max` and `per_company_max_per_week`, plus
   **boolean** `enabled` and `dry_run`. No defaults are ever supplied:
   _"an unattended process inventing its own blast radius is exactly what the
   block exists to prevent."_
3. **`auto_submit_authorised`** — only asked in `live` mode: `enabled === true`
   **and** `dry_run === false`. In `dry_run` mode it passes with a message naming
   the current `enabled` value, because _"reading a dry run they trust is how the
   user decides to enable it."_
4. **`profile_approved`** — `profileDoc.meta.approved_by_user === true`.
5. **`answer_bank_scan`** — delegates to `rescanAnswerBank(answersDoc, {now})`.
   `error` severity refuses; `review` severity only warns. **The stored `value` is
   stripped from every finding before it is returned:**

   > "rescanAnswerBank attaches the stored value to a high-reach finding so a
   > HUMAN can eyeball it; the preflight's output goes to a scheduled task's log,
   > which is not that human. Found the expensive way once already: the first live
   > --rescan printed the user's home address into an agent transcript."

6. **`profile_fact_scan`** — `scanProfileFacts(profileDoc)`. Any finding refuses;
   truncation only warns.

Then the verdict, and the exit code is chosen last so the most specific reason
wins:

```js
let exit = EXIT.OK
if (refusals.length) exit = EXIT.REFUSED
if (allFindings.some((f) => f.kind === "instruction_shaped"))
  exit = EXIT.INSTRUCTION_SHAPED
if (allFindings.some((f) => f.kind === "sensitive_value")) exit = EXIT.SENSITIVE
```

> "The most specific reason wins the exit code, so a caller that only reads the
> number still learns the worst thing found."

**`flattenFacts` — turning a YAML tree into question/value pairs.** `profile.yaml`
has no questions, only a nested tree, so the key path stands in for the question.
`experience[0].bank_account_number` becomes question `"experience bank account
number"`, path `"experience.bank_account_number"`, and the scalar as the value.
Separators `[_\-.]` are normalised to spaces _"because every key regex in
untrusted.mjs is word-boundary based and would otherwise miss the snake_case form
of the exact key it is looking for"_, and array indices are dropped.

One branch in that walk is a real bug fix, not a style point, and the comment
says so:

> "FOUND BY THE TEST, and it was a real hole rather than a style point. A Date IS
> an object, so the object branch below claimed it first, found no own enumerable
> keys, and produced nothing — meaning a date of birth hand-written into
> profile.yaml UNQUOTED (js-yaml parses it into a Date) was silently skipped by
> the scan that exists to find it."

So `Date` is tested **before** objecthood. An invalid `Date` becomes `""` and is
skipped; a valid one becomes `YYYY-MM-DD`. A `WeakSet` guards against YAML
anchors producing a cycle, and `maxNodes` (20 000) caps the walk while
**reporting** truncation — _"a scan that stopped early and said nothing is worse
than no scan."_

`scanProfileFacts` sanitises both the question and the value with
`sanitizeUntrusted(...).text` **before** matching, so an identifier padded with
invisible zero-width characters is reassembled first. Findings carry
`{entry, severity: "error", kind: "sensitive_value", detail, remedy}` and **never
the value**:

> "Echoing the SSN back while refusing to hold it would be the whole attack,
> performed by the defence."

**Worked example.** Suppose `profile.yaml` held `identity: { ssn: "123-45-6789" }`.
Checks 1 through 5 pass; check 6 refuses with one finding:

```json
{
  "entry": "identity.ssn",
  "severity": "error",
  "kind": "sensitive_value",
  "detail": "profile.yaml value at \"identity.ssn\" looks like a US Social Security number (matched: ssn). The value is NOT printed.",
  "remedy": "open profile/profile.yaml and remove \"identity.ssn\" yourself. No script writes that file, so nothing else will do it, and the unattended path types stored facts into third-party forms"
}
```

and the process exits `4`.

### 3.5 What it reads and writes

Reads three YAML documents (paths overridable by flag). **Writes nothing** — and
this is asserted by a test, not merely claimed: `tests/auto/preflight.test.mjs`
checks that the source contains no write call. The header makes the same point in
a falsifiable form: _"grep this file for `writeFileSync` and you will find none."_

### 3.6 Traps and things not to "fix"

- **Two-factor matching only; never key-only.** See §3.1.
- **Findings never carry values, at any depth.** A test asserts it.
- **`review` severity must never refuse:** _"a check that is red on a healthy
  store is a check that gets switched off."_
- **A missing or unreadable `answers.yaml` refuses** rather than passing
  vacuously.
- **The `NODE_TEST_CONTEXT` guard** must stay: it stops a test reading the real
  private profile.

> **Known defect (2026-08-05 audit).** `preflight()` can report CLEAR while every
> job in the run will defer `board-untrusted`. It never looks at
> `auto_apply.board_allowlist`, even though `trust.mjs` exports
> `allowlistProblems()` for exactly this purpose ("answer 'why is nothing being
> submitted' in one line at startup"). `auto-apply.mjs` prints those problems to
> stderr and does not refuse. So a typo like `greenhosue` passes preflight,
> passes the run, and surfaces only as N jobs deferring for a reason that reads
> like "the boards are untrusted". The fix is an `allowlist` check inside
> `preflight()` — `refuse` in `live` mode, `warn` in `dry_run`.

> **Known defect (2026-08-05 audit).** The `stop_switch` check reads **only the
> global** `jobs/.auto/STOP`. Since brakes became scoped, the ones actually
> written in production are company-scoped, and a preflight can therefore say
> "no jobs/.auto/STOP" while a dozen companies are braked. Same blind spot as
> `digest.mjs` — see §10.6.

### 3.7 Dependencies

**Imports:** `node:fs`, `node:path`, `node:url`; `loadYamlFile` from
`../lib/lib.mjs`; `findSensitiveValues`, `describeSensitive`,
`sanitizeUntrusted`, `rescanAnswerBank`, `rescanSummary`, `SENSITIVE_LIMITS` from
`../lib/untrusted.mjs`; `stopActive`, `readStop`, `STOP_PATH`, `ROOT` from
`./guard.mjs`.

**Depended on by:** `auto-apply.mjs`, `tests/auto/preflight.test.mjs`.

---

<a id="authorize"></a>

## 4. `src/auto/authorize.mjs` — the only thing that can produce permission to click

### 4.1 What it is and why it exists

This file evaluates **eleven** preconditions in one place and, only if all of
them pass, mints a **frozen single-use token** bound to the job slug, the plan's
hash, the run mode and the origin. The function that clicks cannot run without
spending one.

The header explains the shift in thinking, and it is the most important idea in
this whole area:

> "Every guard this directory had before was a function the runner was TRUSTED TO
> CALL. preflight.mjs reads auto_apply.enabled — in exactly one place, and nothing
> bound it to a run, so a runner that called startRun({mode:'live'}) and never
> called preflight would send real applications while the user's file said
> `enabled: false`."

> "So the API is inverted. Nothing here is asked 'may I?'; the caller cannot
> proceed at all without an object it has no way to manufacture."

> _"Ask" versus "capability"_: if permission is a question, then any code that
> forgets to ask has permission by default. If permission is an **object you must
> be handed**, then code that forgets to ask has no object and cannot proceed. The
> second shape is called capability-based security, and it is the difference
> between a rule and a lock.

**THE RUNNER'S CONTRACT**, quoted whole, because it is the architecture:

> "1. EXACTLY ONE function in the tree may contain a click. 2. Its FIRST statement
> is consumeSubmitToken(token, {..., pageUrl}). 3. The token is a POSITIONAL,
> REQUIRED parameter of that function. Not an option, not a field on an options
> bag, not defaulted, not nullable. 4. `pageUrl` is the LIVE page's url at that
> moment — page.url(), read there, not carried from the plan."

The fixed call order at the one call site:

```js
const token = authorizeSubmit({ ... })      // every precondition, once
if (token.deferred) { run.deferJob(job, token.reason); return }
run.beginSubmit(job, planSha, url, token)   // durable intent + run/config mode binding
clickSubmit(page, token)                    // consumeSubmitToken FIRST
run.recordSubmission({ ... })               // resolves the intent
// on any failure PROVABLY before the click:
run.abandonAttempt(slug, reason, { beforeClick: true })
```

**Two failure modes, kept apart on purpose:**

> "POLICY -> { deferred: true, reason } a decision about this application …
> PROGRAMMER ERROR -> throws. A missing or malformed input is NOT a defer. A defer
> looks like a considered decision, and a considered decision about an input
> nobody supplied is a lie that reads as a clean run: a hundred jobs 'deferred:
> trust verdict absent' is indistinguishable in a report from a hundred jobs
> correctly held back."

The dividing line: _"anything sourced from the USER'S FILES or from the lead is
data, and bad data defers. Anything the CALLER is responsible for wiring up … is
a programmer error and throws."_

### 4.2 How you run or use it

A **library**. Imported by `job.mjs` (`authorizeSubmit` and more), `submit.mjs`
(`consumeSubmitToken`, `assertTokenMatches`, `isSubmitToken`, `submitOrigin`,
`TokenError`), `advance.mjs` (validates a token without spending it — a "Next"
button is not a submit), `audit.mjs` (`assertTokenMatches` inside `beginSubmit`),
and `auto-apply.mjs` and `trust.mjs` (`submitOrigin` only).

### 4.3 Everything it exposes

| Export                                                                       | Signature / value                                                               |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `AuthorizationInputError`                                                    | `extends TypeError`, `code: "EAUTHINPUT"` — a caller wired this wrong           |
| `TokenError`                                                                 | `extends Error`, `code: "EBADTOKEN"` — a token was missing, spent or mismatched |
| `SUBMIT_CHECKS`                                                              | frozen list of the eleven check names (below)                                   |
| `submitOrigin(u)`                                                            | `-> "https://host[:port]" \| null`                                              |
| `planSha256(plan)`                                                           | `-> 64-character lowercase hex string`                                          |
| `screeningFindingKinds(screening)`                                           | `-> string[]`                                                                   |
| `authorizeSubmit(input)`                                                     | `-> frozen token \| frozen {deferred: true, ...}`                               |
| `isSubmitToken(t)`                                                           | `-> boolean` (shape test)                                                       |
| `assertTokenMatches(token, {slug, planSha, mode})`                           | `-> token`; throws `TokenError`. **Does not spend.**                            |
| `assertPageOrigin(token, pageUrl)`                                           | `-> origin`; throws                                                             |
| `consumeSubmitToken(token, {slug, planSha, mode, pageUrl, stopPath, board})` | `-> token`; **spends it**                                                       |
| `tokenSpent(token)`                                                          | `-> boolean`. For reports and assertions; never a gate.                         |

`SUBMIT_CHECKS`, in evaluation order:

```js
;[
  "auto_apply_block",
  "enabled",
  "mode",
  "trust_gate",
  "apply_origin",
  "screening",
  "plan_defer",
  "label_flag",
  "submit_readiness",
  "company_known",
  "caps",
]
```

`submitOrigin` accepts only `http:` and `https:`, and the reason is subtle:

> "`new URL(x).origin` is the string 'null' for file:, data: and about:blank — so
> two DIFFERENT file:// pages compare equal, and an about:blank token would be
> spendable on any other about:blank. An opaque origin is not an origin, and
> treating it as one is how a same-origin check becomes a same-nothing check."

> _Origin_: the scheme, host and port of a web address —
> `https://boards.greenhouse.io` — with the path and query stripped off. It is the
> boundary the browser uses for cookies and storage, so it is what "still the same
> site" actually means.

### 4.4 The token

```js
Object.freeze({
  kind: "aj.submit-authorization",
  deferred: false,
  nonce, // crypto.randomBytes(16).toString("hex")
  slug,
  company, // trimmed lead.company, or null
  apply_url, // lead.apply_url ?? lead.url ?? null
  planSha, // 64-hex sha256 of the plan
  mode, // "dry_run" | "live", derived from the USER'S file
  runId,
  issued_at, // ISO timestamp string
  checks, // frozen array of all eleven {name, ok, detail}
})
```

and, when any check failed:

```js
Object.freeze({ deferred: true, reason, slug, mode, checks, failed })
```

> _A nonce_: a random number used once. Here it is 16 random bytes as hex, and its
> job is to survive being copied — see below.

**The spend ledger** is a module-level `const liveNonces = new Set()`, and the
comment records a hole found by the file's own test:

> "KEYED ON THE NONCE, NOT ON OBJECT IDENTITY. The first draft used a WeakSet of
> token objects, and writing its own test found the hole: `{...token}` is a
> shape-identical copy with a fresh identity, so a caller could spend an
> authorisation twice by spreading it. A nonce survives the copy."

And, crucially, what the nonce is **not**:

> "A SPEND-ONCE LEDGER, NOT A SECRET, and nothing may be built on the second
> reading … beginSubmit writes `authorized: {nonce, issued_at}` into the intent
> row, which reaches both the JSONL and the database, so the nonce is on disk in
> two places by design. What makes replay fail is DELETION ON SPEND … Do not add
> a check that relies on the nonce being unguessable, and do not remove the
> deletion thinking the randomness is doing the work."

### 4.5 How it works, step by step

`requireInput(input)` runs first and **throws** on: a non-object input; a `lead`
with no non-empty string `slug`; a non-object `plan`; a `planSha` that does not
match `/^[0-9a-f]{64}$/`; an **absent** `config` key (an explicit `null` is fine
and means "the user's file has no auto_apply block"); a `config` that is neither
null nor an object; a `trustVerdict` that is not `{ok: boolean}`; an **absent**
`screening` key (explicit `null` is fine); and a `sentThisRun` that is not a
non-negative integer.

The present-versus-null distinction is spelled out:

> "The key must be PRESENT even when there is no block: `config: null` says 'the
> user's limits file has no auto_apply block', which is a policy state and defers.
> An absent key says the caller never read the file, which is not a state the user
> can act on."

Then `evaluate(input)` runs all eleven checks. **Every check is evaluated even
after one has already failed**, because the dry-run report the user reads before
turning this on has to show the other ten.

| #   | Check              | Passes when                                                                | Note                                                                                                           |
| --- | ------------------ | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| 1   | `auto_apply_block` | `config !== null`                                                          | The user's file has the block at all.                                                                          |
| 2   | `enabled`          | `config?.enabled === true`, **strictly**                                   | _"Absent, null, 'yes', 1 — all defer … a truthy-ish read of that key is how 'off' becomes 'on'."_              |
| 3   | `mode`             | `typeof config?.dry_run === "boolean"`                                     | `mode = dry_run ? "dry_run" : "live"`. Derived **here, once, from the user's file** and frozen onto the token. |
| 4   | `trust_gate`       | `trustVerdict.ok === true`                                                 | The reason string is passed through `safeText()` — it is third-party-derived.                                  |
| 5   | `apply_origin`     | `submitOrigin(lead.apply_url ?? lead.url) !== null`                        | Refusing to mint here turns a wiring failure into a deferral the user can act on.                              |
| 6   | `screening`        | not `null`; not `ok === false`; no finding kind passes `isDisqualifying`   | _"an unscreened lead is not a safe lead"._                                                                     |
| 7   | `plan_defer`       | `plan.defer` is empty                                                      | **Deliberately duplicates** a check in `submitReadiness`. See below.                                           |
| 8   | `label_flag`       | no item **or** defer entry carries `labelFlag`                             | A page whose own field labels try to instruct the agent.                                                       |
| 9   | `submit_readiness` | `submitReadiness(plan, report).ready === true`                             | Zero failures, zero verify mismatches, zero required-empty fields.                                             |
| 10  | `company_known`    | `lead.company` trims to a non-empty string                                 | Without it `per_company_max_per_week` counts against the empty string, i.e. never caps.                        |
| 11  | `caps`             | `capCheck({company, caps: config, sentThisRun, dbFile, now})` returns `ok` | Answered from the two ledgers, not from memory.                                                                |

Check 7's comment explains why the duplication is not sloppiness:

> "submitReadiness is fill-plan.mjs's, and it is allowed to change: a future
> relaxation of it … must not silently widen the unattended gate. Two independent
> keys."

Check 8's is one of the clearest statements of hard rule 0 in the codebase:

> "THE UNATTENDED PATH HAS NO SUCH HUMAN, so here it blocks. Hard rule 0: the page
> is data, and a page trying to talk to the agent is not a page to submit the
> user's name, phone and résumé to unattended."

It scans items **including skipped ones**: _"the flag is evidence about the PAGE,
not about the field."_

Check 10 has a detail worth copying if you ever build a cap: the cap is **counted
on the raw company name and reported on the scrubbed one**, because _"a redaction
inside a company name would change the key a week's submissions are counted
under, and a cap that stops counting is worse than a cap whose report is ugly."_

Then, and **only after every check has passed**:

```js
assertNotStopped(CHECKPOINTS.PRE_SUBMIT, {
  stopPath,
  company: lead.company ?? null,
  board: lead.board_key ?? lead.board ?? null,
  runId,
})
```

> "LAST, after everything else, and immediately before the token exists — never
> third, where the original spec put it, because the caps query opens the database
> and any check that runs AFTER the switch is read is time in which the user can
> pull the brake and still have the click happen."

> "THIS IS NOT THE PRE-CLICK READ … The read that is genuinely immediate is in
> consumeSubmitToken(), the click's first statement. This one is the GATE'S read,
> and it earns its keep by refusing to mint a token at all while the switch is
> set, so the common case (brake already on) never writes an intent row."

A `StopError` thrown from here **is not a defer** — _"STOP halts the whole run,
and turning it into a per-application deferral would let a run keep going through
a switch the user pulled."_

### 4.6 `assertTokenMatches` versus `consumeSubmitToken`

`assertTokenMatches(token, {slug, planSha, mode})` checks, in order: shape
(`isSubmitToken`), **the nonce is still live**, slug match, plan-hash match, mode
match. It does **not** spend.

> "Two callers, and the difference between them is the whole point:
>
> - audit.mjs's beginSubmit passes THIS RUN'S mode — the one startRun was opened
>   with. That comparison … happens NOWHERE ELSE IN THE TREE. It is the only thing
>   standing between 'the runner decided it was live' and 'the user's file says
>   dry_run: true'.
> - consumeSubmitToken passes the mode the CALLER states it is about to perform,
>   which is the caller vouching for itself."

`assertPageOrigin(token, pageUrl)` is the redirect defence:

> "The threat is a redirect the attacker controls. A posting sends the browser
> from the allowlisted ATS to somewhere else — an 'apply on our site' hop, a meta
> refresh, an interstitial — and every other check on the token still passes …
> So the click lands, with the user's name, phone, work-authorisation answers and
> résumé, on a form nobody vetted."

> "The comparison is ORIGIN, not URL: an ATS legitimately moves between paths and
> query strings … Origin is the boundary cookies and storage are scoped to."

A missing `pageUrl` throws `AuthorizationInputError`, **not** `TokenError` —
_"a runner catching TokenError and deferring the job would turn a wiring bug into
a hundred applications 'deferred' for a reason the user cannot act on."_

`consumeSubmitToken` runs four steps, and each position is justified:

1. `assertTokenMatches` — _"so a forged token is reported as forged rather than as
   an origin mismatch"_;
2. `assertPageOrigin`;
3. `assertNotStopped(PRE_SUBMIT, {stopPath, company: token.company, runId:
token.runId, board})` — **company and run come off the token**, `board` from
   the caller:

   > "those two are frozen into the token at authorisation and a caller that could
   > name a different company here could read a brake that does not apply to the
   > click it is about to make. `board` has no place on the token — it is a
   > property of the page, not of the authorisation."

4. `liveNonces.delete(token.nonce)` — the spend.

A `StopError` thrown here _"leaves an intent row open, and that is correct and
recoverable: a refusal AT this point is provably before the click"_, so the caller
may `abandonAttempt(..., {beforeClick: true})`.

**Worked example.**

```js
const plan = { items: [/* … */], defer: [] }
const planSha = planSha256(plan) // "3f9c…" — 64 hex characters
const token = authorizeSubmit({
  lead: {
    slug: "acme-fullstack",
    company: "Acme",
    apply_url: "https://boards.greenhouse.io/acme/jobs/12345",
    board_key: "greenhouse",
  },
  plan,
  planSha,
  config: {
    enabled: true,
    dry_run: false,
    per_run_max: 10,
    per_day_max: 10,
    per_company_max_per_week: 5,
  },
  trustVerdict: { ok: true, reason: "allowlisted ATS" },
  screening: { ok: true, findings: [] },
  report: fillReport,
  sentThisRun: 3,
  runId: "2026-08-04T02-10-00-000Z-a1b2c3",
})
// -> { kind: "aj.submit-authorization", deferred: false, nonce: "8f2c…",
//      slug: "acme-fullstack", company: "Acme", mode: "live", … }
```

Flip `config.dry_run` to `true` and the same call yields `mode: "dry_run"`.
`audit.mjs`'s `beginSubmit`, inside a run opened as `live`, then throws:

```text
TokenError: submit authorization is for a dry_run run, but a live submit was attempted
```

Spend the same token twice and the second call throws:

```text
TokenError: submit authorization for "acme-fullstack" has already been spent, was
copied, or was not issued by authorizeSubmit() in this process — one authorisation
is one click
```

### 4.7 What it reads and writes

**Reads:** the lead, the plan, the fill report, the `auto_apply` config object,
the screening verdict, and — through `capCheck` — the `auto_submissions` and
`applications` tables in `jobs/leads.db`.

**Writes:** nothing durable. The only mutable state is the module-level
`liveNonces` set, which is per-process and shrinks on every spend.

### 4.8 Traps and things not to "fix"

- The eleven checks are a **closed list** (`SUBMIT_CHECKS`).
- **Every check is evaluated even after one fails.**
- **Bad data defers; bad wiring throws.**
- **`enabled` is compared with `=== true`.** Not truthiness.
- **The mode comes from the user's file**, never from a caller argument.
- **Do not make the gate `async`.** `caps.mjs` exists as a separate file
  specifically so that a dynamic `import()` was not needed here.
- **`liveNonces` is not a secret.** Deletion on spend is the control.
- **`plan_defer` and `label_flag` deliberately duplicate checks in
  `fill-plan.mjs`. Do not "de-duplicate" them.**

### 4.9 Dependencies

**Imports:** `node:crypto`; `CHECKPOINTS`, `STOP_PATH`, `assertNotStopped` from
`./guard.mjs`; `safeText` from `./untrusted-text.mjs`; `capCheck` from
`./caps.mjs`; `submitReadiness` from `../apply/fill-plan.mjs`; `isDisqualifying`
from `../lib/untrusted.mjs`; `DB_PATH` from `../lib/db.mjs`.

**Depended on by:** `job.mjs`, `submit.mjs`, `advance.mjs`, `audit.mjs`,
`auto-apply.mjs`, `trust.mjs`, and four test files.

---

<a id="classify"></a>

## 5. `src/auto/classify.mjs` — the post-click classifier

### 5.1 What it is and why it exists

A pure function `(url, html) -> {kind, rule, why}` that types the page the
browser landed on _after_ the submit click, choosing from seven possible kinds.
It is the only place in the unattended path that reads page content to make a
decision, and its output is a **type**, never a value and never an instruction.

> _A pure function_: same inputs, same output, every time, with no side effects —
> no clock, no network, no database, no files. That property is what makes a
> committed collection of test pages a meaningful test of it.

**The asymmetry that decides every rule in the file.** The two ways to be wrong
here are not equally bad:

> "SAYING `confirmation` WHEN NOTHING WAS SUBMITTED loses an application silently.
> The queue row goes to `submitted`, the caps count it, the digest reports it as
> sent, and the user never applies to that posting again. There is no later signal
> that corrects this. It is the worst outcome available.
>
> SAYING anything else WHEN IT WAS A CONFIRMATION costs one human look at one URL.
> It CANNOT cause a duplicate application: the `(slug, mode)` row in
> `auto_submissions` was written BEFORE the click (submit.mjs precondition 7) and
> `recordAutoSubmission`'s ON CONFLICT DO NOTHING refuses the second claim."

Therefore: `confirmation` is the hardest kind to earn, every blocking signal is
tested before it, and `unclassified` is the default and a hard stop.

### 5.2 Why a fixture-sourced rule may fire only on loopback

This is the section to get right, because the behaviour it produces looks exactly
like a bug and is not.

> "§4.10 requires the corpus to be REAL confirmation, identity-verification,
> bot-challenge, email-code, error and not-a-confirmation pages, and names their
> only lawful source: attended applies capturing the post-submit page. §4.6 says
> the guess this system must never make is a model deciding what a page means.
> Writing 'if the HTML says "Thank you for applying" it is a confirmation' from
> memory is the SAME guess with the model removed and this repository's
> imagination left in — it just fails silently instead of expensively."

So every rule declares where its evidence came from, and that provenance **bounds
where the rule may fire**:

| `evidence.source` | Justified by                                                                      | May fire on                               |
| ----------------- | --------------------------------------------------------------------------------- | ----------------------------------------- |
| `"fixture"`       | a test page under `tests/fixtures/` that this repository itself wrote             | **loopback only** (this machine)          |
| `"capture"`       | a real post-submit page from an attended apply, redacted and promoted by the user | only the hosts listed in `evidence.hosts` |

> _Loopback_: the network address that means "this same computer" —
> `127.0.0.1`, `localhost`, `::1`. A page served on loopback cannot have come from
> a job board.

And the consequence, stated in the file itself because it is the point:

> "THE CONSEQUENCE, STATED PLAINLY BECAUSE IT IS THE POINT: with no captures
> promoted, every real board classifies as `unclassified`, and a live submit
> against a real board therefore hard-STOPs after the click. That is not a bug to
> be worked around by relaxing the rule — it is this file correctly reporting that
> nothing in the repository has ever seen what that board says after a submit. The
> fix is a capture, never a plausible-looking regex."

**Measured state today (verified 2026-08-05):**
`tests/fixtures/post-submit/corpus.json` contains `{"samples": []}`.
`capturedKinds()` returns `[]`. All six shipped rules are fixture-sourced.
`tests/auto/classify.test.mjs` therefore _skips_ a test with a stated reason
rather than passing quietly:

> "no captured post-submit page for: confirmation, identity-verification,
> bot-challenge, email-code-challenge, posting-gone, error — W2 is GATED on this
> and it is not a code gap. The only lawful source is an attended apply: run
> apply-job, and after the submit click src/apply/capture-post-submit.mjs
> stages a redacted candidate for review. Until then every real board classifies
> as `unclassified`, which hard-STOPs — the safe direction, and the honest one."

**The only lawful way to change this** is `src/apply/capture-post-submit.mjs`,
driven from an attended apply the user is watching:

```text
usage: capture-post-submit.mjs <stage|review|promote>
  stage   --url <url> --html-file <f> [--board <k>] [--slug <s>]
  review  [<id>]
  promote <id> --kind <classification> --user-approved
```

`stage` redacts the captured page against the fact base and writes it to the
gitignored `jobs/.auto/post-submit/`; `review` prints it for a human to read; and
`promote` requires an explicit `--user-approved` before the page enters the
corpus. The user adjudicates every promotion. Nothing about that flow can be
automated away, and `.claude/skills/apply-job/SKILL.md` already instructs the
attended path to run it.

### 5.3 How you run or use it

A **library**, and — importantly — it is **injected** rather than imported by the
code that clicks. `submit.mjs` never imports it; the runner hands it in as the
`classify` stage via `src/auto/stages.mjs`, and a live submit without one
throws `ClassifierRequired`. So the live path is a refusal, not a stub.

Also imported by `reconcile.mjs` (the fixture probe uses the **same** function,
_"so the fixture's confirmation page means the same thing here as it does
there"_) and by `capture-post-submit.mjs` (for `visibleText` and the kind
vocabulary).

### 5.4 Everything it exposes

| Export                         | Signature / value                                                                                                              |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `CLASSIFICATIONS`              | frozen `["confirmation","identity-verification","bot-challenge","email-code-challenge","posting-gone","error","unclassified"]` |
| `CHALLENGE_KINDS`              | frozen `["identity-verification","bot-challenge","email-code-challenge"]`                                                      |
| `isFixtureUrl(url)`            | `-> boolean` — is this URL on loopback?                                                                                        |
| `visibleText(html)`            | `-> string` — the text a human would see                                                                                       |
| `ruleApplies(rule, url)`       | `-> boolean` — **fails closed**                                                                                                |
| `classify(url, html, {rules})` | `-> { kind, rule, why }`                                                                                                       |
| `shippedRules()`               | `-> [{id, kind, evidence}]`                                                                                                    |
| `capturedKinds(rules)`         | `-> string[]` — today, `[]`                                                                                                    |

### 5.5 How it works, step by step

**Loopback detection** is a whole-host match, never a prefix, and the comment
records the hole a prefix version actually had:

```js
const IPV4_LOOPBACK = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/
```

> "`127.0.0.1.evil.test` starts with `127.` and is an ORDINARY DOMAIN an attacker
> can register a subdomain of. Under the prefix version it read as loopback, which
> would let a fixture-sourced rule … decide a page served by somebody else."

The private predicate accepts `localhost`, `[::1]`, `::1`, anything matching
`/(^|\.)localhost$/`, and a complete dotted quad `127.x.y.z` where every part is
255 or less.

**`visibleText(html)`** performs seven chained text replacements, in this order:
strip `<script>…</script>`, then `<style>`, then `<noscript>`, then HTML
comments, then all remaining tags, then `&nbsp;`, then collapse whitespace, then
trim. Dropping the scripts **first** is load-bearing:

> "a confirmation page's analytics blob routinely contains the word 'captcha'
> (the vendor's own feature flags), and a rule reading raw HTML would classify a
> successful submit as a bot challenge."

**The six shipped rules**, in evaluation order — all with
`evidence.source: "fixture"`:

| Rule id                         | Kind                    | What it looks for                                                                                                                                  |
| ------------------------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fixture-recaptcha-resubmit`    | `bot-challenge`         | a reCAPTCHA marker **in the raw HTML** _and_ a "verify you're not a robot" / "complete the security check" / "resubmit" phrase in the visible text |
| `fixture-email-code`            | `email-code-challenge`  | "we sent you a … code", "enter the code we sent", "verification code sent to your email"                                                           |
| `fixture-identity-verification` | `identity-verification` | "verify your identity", "identity verification", "upload a photo of your government-issued photo ID"                                               |
| `fixture-posting-gone`          | `posting-gone`          | "this job/position/posting/role is no longer accepting applications/available/open", "posting has been closed/removed"                             |
| `fixture-error`                 | `error`                 | "something went wrong", "an unexpected error occurred", "we could not process/submit your application", "please try again later"                   |
| `fixture-application-received`  | `confirmation`          | **last and narrowest**: an application-received phrase _and_ the word "application" present                                                        |

The confirmation rule's comment explains the double requirement:

> "Two independent signals required, not one. A single phrase match is how a
> 'thanks for your interest, the role is closed' page becomes a recorded
> application: the page genuinely thanks you, and the sentence that changes its
> meaning is somewhere else entirely."

`RULES` is built as `SHIPPED.map(r => Object.freeze({...r}))` — _"a classifier
whose rules can be edited by whatever imported it is not a pure function of its
arguments in any sense that matters."_

**`ruleApplies` fails closed.** An unparseable URL, an unknown `evidence.source`,
a missing `evidence` block, or a `capture` rule with no non-empty `hosts` array
all return `false`.

**`classify`** computes `visibleText` **once** for all rules, then, for each rule
in order: skip it unless `ruleApplies`; run `rule.test(url, text, raw)` inside a
`try/catch` (_"A rule that throws is a broken rule, and a broken rule must not be
able to decide a page. Skipping it lands on `unclassified`, which stops."_);
return on the first hit. Otherwise it returns `unclassified` with a `why` that
names the host.

**Worked example.** The exact same HTML, two different URLs:

```js
classify(
  "http://127.0.0.1:53411/apply/thanks",
  "<h1>Your application has been received</h1>",
)
// -> { kind: "confirmation",
//      rule: "fixture-application-received",
//      why:  "matched fixture-application-received (evidence: fixture/greenhouse-confirmation)" }

classify(
  "https://boards.greenhouse.io/acme/jobs/1",
  "<h1>Your application has been received</h1>",
)
// -> { kind: "unclassified",
//      rule: null,
//      why:  "no rule with evidence for this host recognised the page after the
//             click — this repository holds no captured post-submit page for
//             boards.greenhouse.io, so nothing may conclude what it says" }
```

The second case is asserted by a test named _"every real board is unclassified
today, and says why"_. Downstream, `job.mjs` turns it into a terminal queue row
with `reason_kind: "post-submit-unclassified"` — a **failure** kind — and the
run stops rather than recording a submission.

### 5.6 What it reads and writes

Nothing, in either direction. It is pure. Its consumers do the work:

- `submit.mjs` maps `confirmation` to `confirmationUrl = url` and everything else
  to a non-confirmation outcome;
- `job.mjs` maps `bot-challenge` and `email-code-challenge` to the queue state
  `challenged`, `identity-verification` to `challenged` with kind `captcha` (see
  the defect note below), `posting-gone` to deferred, and anything else to a
  failed row with kind `post-submit-unclassified`.

### 5.7 Traps and things not to "fix"

- **Do not "fix" a real board reading `unclassified`.** That reading is correct.
  The fix is a capture.
- Do not add a rule without `evidence`; `ruleApplies` refuses it.
- Do not turn the loopback test into a prefix test.
- Do not read raw HTML in a rule unless the rule genuinely needs markup. Only the
  reCAPTCHA rule does, and it pairs it with a visible-text requirement.
- The function must stay **pure** — no clock, no network, no database.

> **Known defect (2026-08-05 audit).** `AUTO_CHALLENGE_KINDS` in
> `src/lib/db.mjs` is `["captcha","bot-challenge","email-code-challenge"]`, so
> a queue row in state `challenged` cannot carry `identity-verification` even
> though that kind exists in `AUTO_DEFER_KINDS` and `classify.mjs` returns it.
> `job.mjs` therefore maps `["identity-verification", "captcha"]`, and the
> digest's `by_kind` reports "the board asked for your ID document" as "the board
> showed a CAPTCHA" — two very different signals. Fix: add
> `identity-verification` to `AUTO_CHALLENGE_KINDS` and drop the mapping.

> **Known defect (2026-08-05 audit).** The unattended path throws away the exact
> bytes the corpus needs. `submit.mjs` does `html = await page.content()`, calls
> `classify(url, html)`, and returns only `{outcome, confirmationUrl, clicked,
url, row}`; when the answer is `unclassified` — which, by design, is what every
> real board says today — `job.mjs` records `post-submit-unclassified` and the
> HTML is discarded. Meanwhile `capture-post-submit.mjs` already has
> `stageCapture()`, which redacts against the fact base, re-checks the redaction,
> and writes into the gitignored `jobs/.auto/post-submit/`, with promotion still
> requiring `--user-approved`. Calling `stageCapture()` with the bytes already in
> hand would change no decision, write only inside `jobs/`, and leave every
> promotion to the user — the one sanctioned way the corpus could grow from the
> unattended path.

> **Known defect (2026-08-05 audit), performance.** `visibleText` chains seven
> `.replace()` calls over the raw HTML, making seven full copies of the string. On
> a 2 MB ATS page that is roughly 14 MB of transient garbage per classification,
> multiplied by the documented concurrency of 8. A single pass, or truncation to a
> bounded prefix and suffix before scanning, would fix it — with a test asserting
> the fixture pages still classify identically.

### 5.8 Dependencies

**Imports:** only `safeText` from `./untrusted-text.mjs`.

**Depended on by:** `stages.mjs`, `reconcile.mjs`,
`src/apply/capture-post-submit.mjs`, and two test files.

---

<a id="breaker"></a>

## 6. `src/auto/breaker.mjs` — the anomaly circuit breaker

### 6.1 What it is and why it exists

It watches the outcome of every job in a run and decides, **from the last few
attempts only**, whether to (a) retry a transient failure, (b) **pause one board**
for a timed backoff, or (c) **stop the whole run**.

> _A circuit breaker_: named after the electrical device. When something keeps
> failing, you stop trying it for a while rather than hammering it. The design
> question is always "what counts as 'keeps failing'", and getting that wrong is
> what this file's header is about.

The property the whole file exists to hold:

> "A run must never halt because one board is broken, and a healthy run of 999
> must be no likelier to halt than a healthy run of 3."

And the revision that had to be thrown away:

> "Revision 1's breaker counted failures over the whole run, which is a rule whose
> fire probability rises with N — so a healthy 999-job night would have halted
> where a healthy 3-job night did not, and the pressure would then have been to
> weaken the single-sample proofs that actually matter. Fixing the RULE is the
> fix; loosening the proofs is not."

> _N-invariant_: a rule whose chance of firing does not depend on how many jobs
> the run has. "Three failures total" is not N-invariant — a 999-job run will hit
> it by luck. "Three of the last five on this board" is.

The three rules, and the measured cost of them:

> "\* same signature twice CONSECUTIVELY — identical (kind, stage) — pauses that
> BOARD;
>
> - same board failing >= 3 of its LAST 5 — pauses that BOARD;
> - `>= 8` of the LAST 10 attempts across >= 2 distinct boards — stops the RUN.
>
> Simulated at 20,000 trials (N=3) and 2,000 (N=999): the run-level stop fires
> 0.00% at both sizes at p=5%, and 0.45% at p=15%. The cost the simulation
> exposed: ~2 boards pause per 999-job run at p=5%, stranding ~3 applications
> (0.3%); at p=15% it is ~16 boards and ~28 applications (2.8%). THOSE NUMBERS ARE
> WRITTEN DOWN SO A RUN EXCEEDING THEM IS DETECTABLE."

**A pause is not a STOP and not a throttle:**

> "\* A pause is a TIMED backoff with probe re-admission. One job is let through
> when the backoff expires; a success clears the pause entirely.
>
> - It is NEVER terminal for the run, and NEVER persisted across invocations
>   without re-probing — the next run starts every board admitted.
> - It only ever fires on a board that has actually just failed repeatedly. A
>   healthy board is never slowed by any code in this file.
>
> A board-scoped STOP (guard.mjs) is a different thing entirely: durable, and
> cleared only by a human. The breaker must never reach for that, and does not."

The two mechanisms side by side:

|                    | Board pause (`breaker.mjs`)                     | Board-scoped STOP (`guard.mjs`)                            |
| ------------------ | ----------------------------------------------- | ---------------------------------------------------------- |
| Made of            | in-memory state, plus a `board_pauses` row      | a file at `jobs/.auto/stops/board/<key>`                   |
| Lifetime           | five minutes, inside one run                    | forever                                                    |
| Cleared by         | the backoff expiring, then one probe succeeding | a human deleting the file. There is no code that clears it |
| Survives a restart | no — the next run starts every board admitted   | yes                                                        |
| Set by             | the breaker                                     | `raiseStop`, called by `audit.mjs` or `reconcile.mjs`      |

Finally, transients are retried **before** they count:

> "A 20-second wifi drop at job 41 would have paused Greenhouse for the rest of a
> run holding 900 Greenhouse leads, and reported the outcome as `ok`."

### 6.2 How you run or use it

A **library** with one production caller, `src/auto/auto-apply.mjs`:

```js
const breaker = makeBreaker({ db, runId: run.id, now: () => now() })
```

- `breaker.admit(row)` is the first thing done for each job; a refusal writes the
  queue row as `deferred / board-paused / queue`, so the loss is a **number**
  rather than an absence.
- `breaker.record({...result, board_key: row.board_key})` runs after every job,
  _"including the good ones — a success is what CLEARS a pause, so a breaker fed
  only failures could pause a board and never let it back."_
- `runPool`'s `shouldStop: () => breaker.runStopReason` halts **new** work only,
  _"because killing them mid-fill would leave exactly the ambiguous half-states
  the ledger exists to avoid."_
- `breaker.pausedBoards()` is included in the run result.

### 6.3 Everything it exposes

| Export               | Signature                                                                         |
| -------------------- | --------------------------------------------------------------------------------- |
| `isTransient(kind)`  | `-> boolean`. `TRANSIENT` is `new Set(["nav-timeout", "browser-crash"])`.         |
| `movesBreaker(kind)` | `-> boolean`. Falsy kind gives `false`; otherwise `!NOT_A_MALFUNCTION.has(kind)`. |
| `makeBreaker({...})` | `-> { admit(job), record(result), get runStopReason, pausedBoards() }`            |

`makeBreaker` options:

| Option       | Default            | Meaning                                                      |
| ------------ | ------------------ | ------------------------------------------------------------ |
| `db`         | `null`             | An open database handle. Without it, nothing is recorded.    |
| `runId`      | `null`             | Without it, nothing is recorded.                             |
| `backoffMs`  | `5 * 60 * 1000`    | How long a paused board stays paused before one probe.       |
| `maxRetries` | `2`                | Bounded job-level retries for a transient kind.              |
| `now`        | `() => new Date()` | Injected clock. _"a test that sleeps is one people delete."_ |
| `onPause`    | `null`             | Optional callback when a board is paused.                    |

`NOT_A_MALFUNCTION` is the set that makes this a breaker rather than a throttle:

```text
confirm-field, confirm-widget, consent-tickbox, unknown-field, unprobed-dropdown,
freetext-disclosure, doc-unverified, doc-unrendered, board-unsighted,
fact-base-changed, board-untrusted, l3-rejected, cap-company, board-paused,
reconciled-not-sent, already-applied
```

> "A run whose every job defers because the user has not banked an answer yet is a
> run that is WORKING … and a breaker that paused boards over it would convert the
> system's normal caution into a throughput limit, which is exactly the bug the
> unlimited-volume decision forbids."

And the deliberate _inclusion_ of challenges:

> "`bot-challenge` and `email-code-challenge` are in here and that is C13's whole
> point: Greenhouse documents Invisible reCAPTCHA analysing mouse and typing
> patterns, and a Playwright fill emits near-zero input events — so being
> challenged is THE BOARD WORKING AS DESIGNED against automation, and its
> incidence rises with N. They are not malfunctions, so they are never a run STOP;
> but they are strong evidence about ONE BOARD, so they feed the pause."

The failure "signature" is just `` `${kind}|${stage}` ``.

### 6.4 How it works, step by step

State lives inside one `makeBreaker()` closure — all in memory, nothing persisted
across runs:

```js
const boardHistory = new Map() // board -> [{ok, sig}], newest last, capped at 5
const recent = [] // last 10 across the whole run: [{board, ok}]
const paused = new Map() // board -> {until, reason, probing}
const retries = new Map() // slug -> count
let runStopReason = null
```

**`admit(job)`**

1. If `runStopReason` is set, refuse: `{ok: false, reason, until: null, probe: false}`.
2. Work out the board from `job.board_key ?? job.board`. If it is not paused,
   `{ok: true}`.
3. If the backoff has not expired, refuse and carry `until` as an ISO string.
4. If the backoff has expired but another job is already the probe, refuse with
   _"(a re-admission probe is already in flight)"_ — _"Two probes would double the
   traffic at a board that just failed repeatedly, which is the opposite of a
   backoff."_
5. Otherwise mark `probing = true` and return `{ok: true, probe: true}`.

**`record(result)`** returns `{action, board, reason}` where `action` is one of
`none`, `retry`, `pause-board`, `stop-run`.

1. `failed = Boolean(kind) && movesBreaker(kind)`.
2. **Transient retry.** If the failure is transient and this slug's retry count is
   still within `maxRetries`, return `retry` **and record nothing in any history**
   — _"A wifi drop that is about to be retried successfully must leave no trace in
   the windows the rules read, or the retry is decorative."_
3. Push `{ok: !failed, sig}` onto the board's history (capped at 5) **and**
   `{board, ok}` onto `recent` (capped at 10). _"BOTH OUTCOMES GO INTO BOTH
   WINDOWS. '3 of the last 5' is a ratio, and a history holding only failures
   cannot express one."_
4. **Success path.** If the board was paused, delete the pause, reset its history,
   and call `clearBoardPause(db, board, {run_id})` inside a `try/catch` (_"the
   record is for a human; it must not break the run"_). Return `none`.
5. **Rule 3 first** — 8 or more failures among the last 10 attempts across 2 or
   more distinct boards sets `runStopReason` and returns `stop-run`. Checked
   before the board rules because _"checking it before the board rules keeps a
   genuinely systemic failure from being reported as a series of unrelated board
   pauses."_ There is no "the window must be full" guard, and the comment records
   that as a real bug rather than a simplification:

   > "Requiring 10 entries first meant a run whose first 8 attempts ALL failed
   > across several boards sailed past the rule — precisely the run that should
   > never have been allowed to reach job 11."

6. **Rule 1** — the last two entries for this board are both failures with the
   same signature: pause.
7. **Rule 2** — 3 or more failures in this board's last 5 attempts: pause.

`pause()` sets `paused[board] = {until: now + backoffMs, reason, probing: false}`,
calls `recordBoardPause(db, {...})` inside a `try/catch`, calls `onPause` if one
was given, and returns `{action: "pause-board", board, reason}`.

**Worked example.** Five-minute backoff, two retries, a run holding Greenhouse
and Lever jobs.

| Step | What happens                                               | `record()` returns                                                                                                                                    |
| ---- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | `greenhouse/job-a` fails `nav-timeout` at `plan`           | `{action: "retry", reason: "nav-timeout (attempt 1 of 3) — a transient is retried before it counts toward a signature"}`. **Nothing recorded.**       |
| 2    | the retry succeeds                                         | `{action: "none"}`; the board history becomes `[ok]`                                                                                                  |
| 3    | `greenhouse/job-b` fails `token-refused\|authorize`        | `{action: "none"}`; history `[ok, fail]`                                                                                                              |
| 4    | `greenhouse/job-c` fails `token-refused\|authorize`        | **rule 1 fires** — `{action: "pause-board", board: "greenhouse", reason: 'the same failure twice in a row on this board (token-refused\|authorize)'}` |
| 5    | the next Greenhouse job calls `admit`                      | refused, with `until` reported. Lever jobs are untouched. The refused jobs get queue rows `deferred / board-paused / queue`                           |
| 6    | five minutes later, one job is admitted with `probe: true` | if it succeeds, the pause and the history are wiped and `board_pauses.cleared_at` is set; if it fails again, `record` re-pauses with a fresh backoff  |

### 6.5 What it reads and writes

**Writes:** rows in `board_pauses` — columns `board_key`, `run_id`, `paused_at`,
`until`, `reason_kind`, `reason_detail`, `cleared_at`, with primary key
`(board_key, run_id, paused_at)` — and **only** when both `db` and `runId` were
supplied. A test asserts _"the breaker records nothing to a db it was not given."_

**Reads:** nothing. Every rule is answered from memory.

`board_pauses` is scoped by `run_id` on purpose, and `db.mjs`'s schema comment
says why:

> "A pause is a timed backoff with probe re-admission, never terminal, and never
> inherited by the next invocation without re-probing -- so readers ask for one
> run's pauses and a fresh run starts with none. The row survives the process
> because the DIGEST needs it after the run is over, not because the next run
> should obey it."

### 6.6 Traps and things not to "fix"

- **Every rule is a statement about the last few attempts, never a count over the
  run.** If you add a rule, check the N-invariance.
- **A pause never sets `runStopReason`.** A test asserts it.
- **Deferrals (`NOT_A_MALFUNCTION`) must never move the breaker.**
- **Challenges must move it (board-scoped), and must never stop the run.**
- The clock is injected so the timed backoff is testable without sleeping.
- A job with **no board** can never be paused and never pauses anything.
- Database failures around pause records are swallowed by design.

### 6.7 Dependencies

**Imports:** `recordBoardPause`, `clearBoardPause` from `../lib/db.mjs`;
`safeText` from `./untrusted-text.mjs`.

**Depended on by:** `auto-apply.mjs`, `tests/auto/breaker.test.mjs`.

---

<a id="reconcile"></a>

## 7. `src/auto/reconcile.mjs` — resolving an orphaned submit attempt

### 7.1 What it is and why it exists

For each `auto_submissions` row stuck at `outcome = 'attempted'` whose run never
finished, this module goes back to the board **read-only** and tries to establish
whether the application exists. If it cannot, it files a **company-scoped STOP**
so exactly one employer is held back.

> "submit.mjs writes the durable `(slug, mode)` attempt row BEFORE the click
> (precondition 7), because 'an attempt is a submission until proven otherwise'. A
> process killed between the click returning and the acknowledgement being written
> therefore leaves a row saying an application MAY exist at an employer, with
> nothing able to say whether it does."

> "Before scoping, one such row halted every future invocation until a human
> deleted a file. §4.9's instruction is precise about the fix and about what the
> fix is not: **do not weaken the protection — make it mechanically resolvable,
> and scope the halt.**"

**The honest limit, stated first on purpose.** This is the part most likely to be
misread from a file listing:

> "Reconciliation by re-reading the board works only where the board exposes
> application state to a candidate. On the recommended launch allowlist that is
> CLOSE TO NONE OF IT:
>
> - Lever hosted boards — no candidate login, no already-applied state.
> - Ashby hosted boards — the same.
> - Greenhouse — exposes it only through a MyGreenhouse account, which needs
>   exactly the logged-in session §6.4 excluded as a structural security control.
>
> So this module ships DESCOPED to the boards that can answer, and on today's
> allowlist that set is empty."

> "This paragraph is here rather than in a design document because the tempting
> mistake is to read `reconcile.mjs` in a file listing and conclude orphans are
> handled. They are handled the way §4.9 says: narrowly, and mostly by telling the
> user exactly which one slug needs a person."

**What it may not do:**

> "It never clicks a control (§4.9, and tests/auto/click-surface.test.mjs enforces
> the absence) … A reconciler that could click could re-submit the very
> application it was sent to ask about, which is the one irreversible mistake in
> this whole subsystem."

> "It also never RESOLVES OPTIMISTICALLY. `undecidable` is the default and every
> error path lands on it … Resolving an orphan to `reconciled-not-sent` releases
> the (slug, mode) claim and lets the runner apply to that posting again, so
> guessing 'probably not sent' is guessing in the direction of a duplicate
> application."

### 7.2 How you run or use it

A **library** — and, as of this survey, **it has no production caller.** See the
defect note in §7.6. The orphan handling that actually runs today is
`audit.mjs`'s `assertNoOrphanAttempts()` at `startRun`, which brakes the affected
companies rather than resolving them.

### 7.3 Everything it exposes

| Export                                                                          | Signature / value                                         |
| ------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `VERDICTS`                                                                      | frozen `["submitted", "not-sent", "undecidable"]`         |
| `PROBES`                                                                        | `new Map([["fixture", async (page, {applyUrl}) => {…}]])` |
| `reconcileOne(orphan, {openPage, probes, dbFile, db})`                          | `-> { slug, verdict, why, outcome, confirmationUrl }`     |
| `reconcileAll({dbFile, openPage, probes, stopPath, stopsDir, jobsDir, notify})` | `-> { resolved, undecidable, results, blocked }`          |

A probe is `async (page, {applyUrl, slug}) -> {verdict, why, confirmationUrl}`
and **must not click**.

`PROBES` is _"DELIBERATELY EMPTY FOR EVERY PRODUCTION BOARD, and the emptiness is
the finding rather than a gap somebody forgot."_ The single `"fixture"` entry
exists _"so the resolution path, the DB transition and the
kill-between-click-and-ack recovery are all exercised by a test rather than
shipped unrun."_

The fixture probe navigates to `applyUrl` with `waitUntil: "domcontentloaded"`,
reads `page.url()` and `page.content()`, and runs `classify(url, html)`:

- `confirmation` → `{verdict: "submitted", why, confirmationUrl: url}`;
- `posting-gone` → **`undecidable`**, with the reasoning spelled out:

  > "THE POSTING IS GONE, WHICH IS NOT EVIDENCE EITHER WAY. A req taken down after
  > a successful submit looks identical to one taken down before it. Reading this
  > as `not-sent` would release the claim on a posting the user may well have
  > applied to."

- anything else → `undecidable`.

### 7.4 How it works, step by step

**`reconcileOne`**

1. Work out the board from `orphan.board_key ?? orphan.board`, then
   `probes.get(board)`.
2. Default `verdict = "undecidable"`. When no probe exists, the default `why` is a
   full sentence written for the user: _"no reconciler probe for board `<board>` —
   this board exposes no candidate-visible application state, so a human
   adjudicates this one slug."_
3. If there is a probe **and** an injected `openPage` function, open a session,
   run the probe, accept the result only if `VERDICTS.includes(got.verdict)`,
   `safeText` the reason, and **always** `await session?.close?.()` in a `finally`
   (_"a leaked page must not turn a decision into an error"_). Any throw gives
   `undecidable` with `"the probe could not decide: …"`.
4. Turn the verdict into an outcome: `"submitted"`, `RECONCILED_NOT_SENT`
   (`"reconciled-not-sent"`), or `null`.
5. If there is an outcome, call `writeResolution(...)`.

**`writeResolution`** performs both writes in **one** database transaction:

```js
conn.exec("BEGIN IMMEDIATE")
acknowledgeAutoSubmission(conn, {
  run_id,
  slug,
  company,
  mode,
  apply_url,
  confirmation_url,
  outcome,
  reconciled: true,
})
setAutoJobState(
  conn,
  slug,
  outcome === "submitted" ? "submitted" : "deferred",
  outcome === "submitted"
    ? {}
    : {
        reason_kind: "reconciled-not-sent",
        reason_stage: "post-submit",
        reason_detail:
          "the board was asked and shows no application; the (slug, mode) claim was released",
      },
)
conn.exec("COMMIT") // ROLLBACK on any throw
```

> _A transaction_: a group of database writes that either all happen or none do. If
> the process dies halfway through, the database rolls back to before the group
> started, so there is no half-finished state.

> "§4.9 requires it: resolving the submission while leaving the queue row
> non-terminal (or the reverse) produces exactly the half-state the whole ledger
> exists to make impossible, and a crash between two separate writes is not a rare
> case at this volume — it is the case this module was written for."

**`reconcileAll`** opens the database, reads the orphans with
`readOrphanAttempts(db)`, closes it, then runs `reconcileOne` on each orphan
sequentially. For every `undecidable` result it calls `raiseStop` with
`scope: "company"` when a company is known (otherwise a **global** brake), and
collects the company names into `blocked`. The STOP reason it writes is a
sentence for a human:

> "an orphaned submit attempt for "\<slug\>" at \<url\> could not be resolved
> automatically: \<why\>. Open that page, log or withdraw as appropriate, then
> delete this file. Nothing else is held back."

**Worked example.** `auto_submissions` holds:

```json
{
  "run_id": "2026-08-04T02-10-00-000Z-a1b2c3",
  "slug": "acme-fullstack",
  "company": "Acme",
  "mode": "live",
  "outcome": "attempted",
  "apply_url": "https://boards.greenhouse.io/acme/jobs/12345"
}
```

and `auto_runs` has no `finished_at` for that run. Calling `reconcileAll({openPage})`:

- `readOrphanAttempts` returns that row.
- No probe exists for Greenhouse, so the verdict is `undecidable`.
- `raiseStop(..., {scope: "company", key: "Acme"})` writes
  `jobs/.auto/stops/company/acme` and appends an entry to `jobs/.auto/INBOX.md`.
- The call returns `{resolved: 0, undecidable: 1, results: [...], blocked: ["Acme"]}`.
- Every other company keeps running. On the next run,
  `assertNotStopped({company: "Acme"})` inside `beginJob` and `authorizeSubmit`
  refuses only Acme's jobs.

### 7.5 `reconciled-not-sent`, and why the exception must stay exactly one wide

This is the most subtle piece of database reasoning in the project, and the
comment in `src/lib/db.mjs` is worth reading twice.

The `auto_submissions` row for a slug **is** the claim: `recordAutoSubmission`
returns `1` when this caller owns the submit and `0` when a row already exists for
that `(slug, mode)` — and `0` means _do not click_. That is what stops a second
application to the same posting tomorrow.

Now suppose the reconciler proves an orphaned attempt never reached the employer.
Under a plain refuse-everything conflict rule, the row would still occupy
`(slug, mode)` forever:

> "The failure it fixes: the reconciler proves an orphaned attempt never reached
> the employer, but under a plain DO NOTHING the row still occupies (slug, mode)
> forever — so that slug reports 0 changes on every future run, fails as
> `db-write-failed` each time, and after two in a row pauses the board. A posting
> nobody applied to would become permanently unappliable, loudly, for the rest of
> the machine's life."

So the conflict clause carries a narrow exception:

```sql
ON CONFLICT(slug, mode) DO UPDATE SET …
WHERE auto_submissions.outcome = 'reconciled-not-sent'
```

Every other outcome — `attempted`, `submitted`, `abandoned` — still hits the
conflict and reports `0`.

> _Note: several comments in the codebase describe `recordAutoSubmission` as
> "`ON CONFLICT DO NOTHING`". The SQL is actually a `DO UPDATE` with the narrow
> `WHERE` above. The behaviour is identical for every outcome except
> `reconciled-not-sent`; the shorthand in those comments is just older than the
> exception._

And the rejected alternative, which stays rejected:

> "The critic's alternative — DELETE the row — is rejected and stays rejected:
> `auto_submissions` is the store of record for what was AIMED at an employer, and
> deleting evidence to unblock a retry is the shape hard rule 2 forbids."

**Why widening the list would re-open the deadlock.** The exception is safe only
because `reconciled-not-sent` means one very specific thing: _the board was asked,
and answered no_. Add `posting-gone` to the list and you release the claim on a
posting that may well have received an application — the req was taken down, which
says nothing. Add `attempted` and you release the claim on exactly the case the
claim exists for. Every widening trades a _loud, recoverable_ deadlock (a posting
that cannot be applied to, reported every run) for a _silent, unrecoverable_
duplicate (a second application at an employer who now sees two). The first can be
fixed by a person in thirty seconds. The second cannot be fixed at all.

`reconciled-not-sent` is also one of only two outcomes that do not count toward a
cap — the other is `abandoned` — and both mean the same thing: nothing reached an
employer. `countAutoSubmissions` counts every other row, including `attempted`,
because _an attempt is a submission until proven otherwise_. The SQL uses
`IS NOT` rather than `!=`, and the reason is a SQL trap worth knowing:

> "`NULL != 'abandoned'` is NULL, which is falsy, so a row written before the
> outcome column existed would silently stop counting."

### 7.6 What it reads and writes

- Reads `auto_submissions` via `readOrphanAttempts`.
- Writes `auto_submissions` via `acknowledgeAutoSubmission` and `auto_queue` via
  `setAutoJobState`, in one transaction.
- Writes STOP files and `INBOX.md` via `raiseStop`.

### 7.7 Traps and things not to "fix"

- **No click. Ever.** Asserted by `tests/auto/reconcile.test.mjs` and by
  `tests/auto/click-surface.test.mjs`.
- **`undecidable` is the default, not a fallback.** Every error path lands there.
- **`posting-gone` is not evidence.**
- **`reconciled-not-sent` is the only outcome that releases the claim.** See §7.5.
- `openPage` is injected, exactly as `job.mjs` injects its stages.

> **Known defect (2026-08-05 audit).** `reconcile.mjs` has **no production
> caller**. `reconcileAll` and `reconcileOne` are imported only by
> `tests/auto/reconcile.test.mjs`; no file under `src/` imports
> `./reconcile.mjs`. The orphan path that actually runs is
> `assertNoOrphanAttempts`, which brakes and never resolves — so
> `reconciled-not-sent`, the whole exception in `recordAutoSubmission`'s `WHERE`
> clause, and the release-the-claim path can never fire in production. Either call
> `reconcileAll` from `auto-apply.mjs` before `startRun` (which is safe: with no
> probe for any production board every orphan resolves `undecidable`, which is
> what `assertNoOrphanAttempts` does today anyway), or state in the docs that
> orphan resolution is a manual step and give it a command line.

> **Known defect (2026-08-05 audit).** `readOrphanAttempts` selects only
> `run_id, slug, company, submitted_at, mode, apply_url` — it does **not** select
> `board_key`. `reconcileOne` looks up its probe with
> `orphan?.board_key ?? orphan?.board`, so for a real orphan the board is always
> `undefined` and `probes.get(undefined)` is always `undefined`. Even if a
> production probe were written, it could never be selected. The fix is to add
> `board_key` to the query (it would need to come from `auto_queue`, since
> `auto_submissions` has no such column) or to pass the board in another way.

### 7.8 Dependencies

**Imports:** `openDb`, `DB_PATH`, `readOrphanAttempts`,
`acknowledgeAutoSubmission`, `setAutoJobState`, `RECONCILED_NOT_SENT` from
`../lib/db.mjs`; `classify` from `./classify.mjs`; `safeText` from
`./untrusted-text.mjs`; `raiseStop`, `JOBS_DIR`, `STOP_PATH` from `./guard.mjs`.

**Depended on by:** only `tests/auto/reconcile.test.mjs`. See the defect above.

---

<a id="audit"></a>

## 8. `src/auto/audit.mjs` — the run ledger, written twice

### 8.1 What it is and why it exists

The largest file in this area. It opens and closes a run; writes every event to
**two independent copies**; holds the durable "I am about to click" intent;
resolves it afterwards; hashes the fact base at both ends of the run; and raises
scoped brakes when the bookkeeping says something is wrong.

**Two copies, neither derived from the other:**

> "jobs/.auto/runs/\<runid\>.jsonl is append-only text and it is the copy that
> SURVIVES: jobs/leads.db is gitignored, has no on-disk source for anything it
> alone holds, and a database file is exactly the thing that is unreadable at the
> moment you need it most. The auto_runs / auto_submissions tables exist because
> the JSONL cannot be QUERIED, and 'how many applications have gone to this
> company in the last seven days?' has to be answered cheaply, before the next
> submit, or per_company_max_per_week is decoration.
>
> Neither copy is derived from the other. A record present in one and absent from
> the other is itself a finding."

> _JSONL_ ("JSON Lines"): a text file with one complete JSON object per line.
> Appending is a single write with no parsing, so a file that is cut off
> mid-crash still has every earlier line intact. A regular JSON file, by contrast,
> is one giant object — truncate it and the whole thing is unreadable.

**What it enforces versus merely records:**

> "An attempt is a submission until proven otherwise. The row is written before
> the click with outcome 'attempted', so a process killed one second after the
> click still leaves a ledger entry, still counts against
> per_company_max_per_week, and still names the URL the user needs to check."

> "recordSubmission still refuses to acknowledge a submit with no preceding intent
> — that is a DETECTOR (it records anyway and stops the runner), and it is honest
> about being one. Prevention is authorize.mjs's token."

**And why every string is scrubbed on the way in:**

> "Every string written to either copy is scrubbed of instruction-shaped text
> first (untrusted-text.mjs), because the record is the one artefact of an
> unattended run that a human later hands to a model. Hard rule 0 does not stop
> applying because the page text has been through a database."

That last one is worth expanding, because it is easy to think a database is a
safe place to put attacker text. The run record contains field labels, consent
sentences and deferral reasons copied verbatim off third-party pages. The first
convenience feature anyone builds on top of an overnight runner is "summarise last
night's run" — and at that moment every one of those strings becomes prompt text
in a session that can read `profile/` and write documents. `untrusted-text.mjs`'s
own header makes the point:

> "So the labels are scrubbed HERE, on the way in, once — not on the way out by
> whatever reads the record later, because there will be more than one reader and
> only one of them will remember."

### 8.2 How you run or use it

A **library**. `auto-apply.mjs` imports `startRun`; the returned run object is
threaded into `runJob` and from there into the submit path. Also used by five
test files and by `tests/fixtures/auto/kill-at.mjs`, a harness that kills the
process at a chosen instant to prove the crash-recovery paths.

### 8.3 Everything it exposes

| Export                                                                        | Signature                                                                                                    |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `PROFILE_FILES`                                                               | `["profile.yaml", "answers.yaml"]`                                                                           |
| `hashProfile({profileDir})`                                                   | `-> { "profile.yaml": <sha256 hex \| null>, "answers.yaml": <sha256 hex \| null> }`                          |
| `newRunId(now)`                                                               | `-> "2026-08-04T02-10-00-000Z-a1b2c3"` (ISO timestamp with `:` and `.` replaced by `-`, plus 3 random bytes) |
| `startRun({mode, dbFile, autoDir, runsDir, profileDir, stopPath, now, meta})` | `-> the run object`. **`mode` is required**: `'dry_run'` or `'live'`.                                        |
| `assertNoOrphanAttempts({dbFile, stopPath, jobsDir, inboxPath, stopsDir})`    | `-> {ok, blocked}`; throws `StopError` when an orphan has no company                                         |

**The run object** returned by `startRun`:

| Member                                        | What it does                                                      |
| --------------------------------------------- | ----------------------------------------------------------------- |
| `get id()`, `get mode()`, `get state()`       | `state` is a shallow copy, so a caller cannot mutate the real one |
| `openAttempts()`                              | the intents **this process** currently holds open                 |
| `jsonl`                                       | the path to the surviving copy                                    |
| `event(type, data)`                           | append an arbitrary event                                         |
| `beginJob(job)`                               | CHECKPOINT 2 of 3; increments `planned`                           |
| `deferJob(job, reason)`                       | increments `deferred`                                             |
| `failJob(job, error)`                         | increments `failed`; returns the new count                        |
| `beginSubmit(job, planSha, url, token)`       | the durable intent; returns the attempt row                       |
| `abandonAttempt(slug, reason, {beforeClick})` | the click never happened                                          |
| `recordRehearsal(sub)`                        | dry-run only                                                      |
| `recordSubmission(sub)`                       | an application that has already happened                          |
| `stop(reason, meta, {scope, key})`            | the runner disabling itself                                       |
| `finish({outcome, now})`                      | close the run; idempotent                                         |

### 8.4 How it works, step by step

**`startRun`**

1. `mode` must be `'dry_run'` or `'live'` — no default, same reasoning as
   `preflight`.
2. **CHECKPOINT 1 of 3:** `assertNotStopped(CHECKPOINTS.RUN_START, {stopPath})` —
   _"Before anything is created, before the browser exists."_
3. `assertNoOrphanAttempts(...)` — second, not first, _"because an already-set
   STOP is the more specific answer and raiseStop keeps the first reason."_ Note
   the explicit `inboxPath`, and why:

   > "`raiseStop` defaults `inboxPath` to the REAL tree while taking `jobsDir` from
   > the caller, so a redirected tree that does not also redirect the inbox writes
   > an alert that assertInsideJobs refuses — and appendInbox swallows that
   > failure by design … The result was an alert that silently went nowhere,
   > invisible in production the day anything runs with a non-default jobsDir.
   > Every raiseStop call in this file now names it."

4. Generate the run id, create `jobs/.auto/runs/` through `assertInsideJobs`, and
   compute the JSONL path.
5. Hash `profile/`.
6. Build the run `state` object, append a `run.start` event, `persist()` it into
   `auto_runs`, and return the run object.

**`assertNoOrphanAttempts` — the company-scoped narrowing.** The scenario is what
makes this design legible:

> "Task Scheduler's ExecutionTimeLimit (01:00) kills the process one second after
> a submit click. The application is sitting in the employer's ATS. Nothing
> acknowledged it, nothing closed the run — and without this, `alreadyApplied` is
> false and the next run applies to the same company again. Carpet-bombing one
> employer is the reputational damage that actually costs the user something, and
> it would have arrived through a crash rather than through a bug in the caps."

> "NOTHING ABOUT THE ACTUAL PROTECTION IS WEAKER. The damage this exists to
> prevent is a second application to THE SAME employer, and a company-scoped brake
> blocks exactly that, for as long as the global one did … What it stops doing is
> taking the other 998 companies down with it."

> "AN ORPHAN WITH NO COMPANY STILL GOES GLOBAL, because a brake has to be filed
> against something and 'we do not know which employer may hold an application' is
> not a case to be optimistic about."

The flow: read the orphans; for each one with a company, `raiseStop({scope:
"company", key: company})` and push `stopKey(company)` into `blocked`; collect the
rows with no company and, if any exist, write one **global** `raiseStop` and throw
a `StopError`.

**`beginSubmit(job, planSha, url, token)` — the durable intent**

1. `slug` is required; `planSha` is required — _"the intent row is what the user
   reads if this attempt is later found orphaned"_.
2. `assertTokenMatches(token, {slug, planSha, mode: state.mode})` — **the only
   place in the tree** where the run's mode is compared against the mode
   `authorizeSubmit` derived from the user's file:

   > "So a runner that opened `live` while the user's file says `dry_run: true` is
   > caught here and nowhere else. When this argument was optional, that binding
   > was optional — which is why it is not any more."

3. **A per-slug pending map**, and the comment records why it is not a single slot:

   > "At concurrency 1 the slot was correct … At concurrency 8 that is the ORDINARY
   > state — eight workers legitimately hold eight attempts at once — so the slot
   > would have raised STOP on every healthy concurrent run … THE OVERWRITE
   > DETECTOR SURVIVES, PER SLUG."

   Two `beginSubmit` calls for the **same** slug with nothing in between produce a
   `submit.unresolved` event, a **company-scoped** `raiseStop` on the stale
   attempt's company, and a thrown `StopError` that halts this run in-process
   without writing a global file.

4. Build the `attempt` row through `scrubbed()` **once** and use the same object
   for both copies (_"two copies that disagree about what a page said are worse
   than either copy alone"_), including
   `authorized: { nonce: token.nonce, issued_at: token.issued_at }`.
5. **The ledger claim:** `recordAutoSubmission(db, attempt)`.

   > "recordAutoSubmission is an INSERT … ON CONFLICT DO NOTHING on (slug, mode),
   > so it returns 0 when this slug already has a row in this mode … After a
   > successful auto_queue claim that must not be possible, so it is an anomaly,
   > not a race … It stops the runner rather than clicking again, because
   > carpet-bombing one employer is the damage that actually costs the user
   > something."

   On `0`, it reads the colliding row with `readAutoSubmission`, emits
   `submit.refused`, raises a **company-scoped** STOP, and throws a `StopError`.
   _"(A `dry_run` row never collides with a `live` one. The rehearsal is a
   different row, deliberately, so it cannot pre-consume the live claim.)"_

**A note that saves a wasted investigation.** A `0` from `claimAutoJob` on the
`auto_queue` table is **ordinary** — another worker got the slug first, and the
loser simply returns. A `0` from `recordAutoSubmission` **inside `beginSubmit`**
is an **anomaly**, because the queue claim should already have made it
impossible. Same return value, different meaning, because of where in the sequence
it happened.

**The three resolutions**

`abandonAttempt(slug, reason, {beforeClick})` — the click **never happened**.

> "Without it, every failure between beginSubmit() and a confirmed click leaves an
> 'attempted' row … Each one fires the 'this may already be an application' brake
> and halts the run … at hundreds of jobs per run transient click-site failures
> are certain, not possible — and a brake that fires on healthy runs is a brake
> the user deletes."

> "THE DISCIPLINE, and it is the caller's to keep: only a failure PROVABLY BEFORE
> the click may use this. A timeout DURING a click is ambiguous … `beforeClick:
true` is required rather than defaulted so that asserting it is a deliberate act
> at the call site, visible in review."

It throws a `TypeError` when `beforeClick !== true`, when the reason is missing,
or when there is no open attempt for that slug. It uses
`acknowledgeAutoSubmission`, not `recordAutoSubmission`: _"Going through the claim
would report 0 changes and silently drop the abandonment."_ The row is kept with
`outcome: "abandoned"` and consumes no cap budget.

`recordRehearsal(sub)` — a dry run that passed every precondition and stopped. It
refuses in a live run: _"a live run that rehearsed a slug would consume its (slug,
'live') claim without submitting anything."_ It writes `outcome: "submitted"` plus
`rehearsal: true` and `confirmation_url: null`, and increments the submitted
count.

> "the schema is explicit that dry-run rows count on purpose: the rehearsal has to
> exercise the same cap arithmetic the live run will, or the first live night
> meets caps it has never once tested."

`recordSubmission(sub)` — an application that **has already happened**.

> "This never refuses to record. An application cannot be unsent, so losing its
> record is strictly worse than recording an incomplete one."

- No matching intent produces a `submit.unchecked` event and a **GLOBAL**
  `raiseStop`:

  > "§4.6 reserves global for a broken invariant, and this is the durable-attempt
  > invariant broken from the other end: a click reached an employer without the
  > row that was supposed to exist BEFORE it."

- The required fields are `slug`, `plan_sha256`, `verify`, `consent_labels`,
  `screenshots`, `confirmation_url`. Any missing one still lets the row land,
  carrying `audit_incomplete: [...]`, and then raises a **company-scoped** STOP:
  _"the record cannot support a manual withdrawal."_
- `apply_url` and `attempted_at` are carried forward from the intent **before** the
  `...sub` spread, so an explicit value still wins but the acknowledgement can
  never blank the URL.

**`stop()` and `finish()`**

`stop(reason, meta, {scope, key})` records first and brakes second, _"so the
reason is in the durable copy even if the STOP write fails."_ The reason goes
through `safeText(reason, 400)` because _"it is the shortest path from a hostile
page to a human's screen."_ Only `global` or `run` scope sets `state.stop_reason`:

> "A board or company brake leaves the run running and reporting `ok`, which is
> the entire point of scoping — writing stop_reason here would make a
> 998-application success read as a stopped run."

`finish({outcome, now})` is idempotent (a second call just returns the state):

1. Re-hash `profile/` and compare against the start.
2. Clear the in-memory pending map and **query the ledger** for unresolved
   attempts:

   > "THE LEDGER IS QUERIED, NOT THE IN-MEMORY MAP … The map is per-PROCESS: a
   > worker that died, a run resumed from a previous invocation, or an attempt
   > whose resolve path itself threw all leave a row the map never knew about.
   > readAttemptsForRun is the only reading that catches every one of them."

3. If there are unresolved attempts and no stop reason yet, write one listing each
   slug and URL.
4. Set the outcome (`"stopped"` if there is a stop reason), append `run.finish`,
   persist.
5. **One brake per unresolved attempt**, company-scoped (global when the company
   is unknown).
6. If `profile/` changed, raise a **run-scoped** brake, and the comment is a
   correction worth quoting:

   > "RUN-SCOPED, not global, and that is a correction rather than a loosening.
   > §4.6 classes `fact-base-changed` as a DEFERRAL — the user answered a
   > save-answer.mjs prompt at 21:40, which is them using the system correctly …
   > A global brake here would have the machine halt every future night because
   > the user edited their own file."

**Worked example — a killed process.**

| Time     | What happens                                                                                                                                                         |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 21:59:58 | `beginSubmit` writes a `submit.attempt` line to the JSONL and an `auto_submissions` row for `('acme-fullstack','live')` with `outcome='attempted'` and the apply URL |
| 21:59:59 | the click goes out                                                                                                                                                   |
| 22:00:00 | Task Scheduler kills the process. `auto_runs.finished_at` for that run stays `NULL`                                                                                  |

On the next invocation, `startRun`:

- `assertNotStopped(RUN_START)` passes;
- `readOrphanAttempts` returns the row (outcome `attempted`, run never finished);
- `raiseStop({scope: "company", key: "Acme"})` writes
  `jobs/.auto/stops/company/acme` and an INBOX entry naming the URL;
- `blocked: ["acme"]` is carried on the run state as `blocked_companies`;
- **the run starts normally** and every non-Acme job proceeds.

### 8.5 What it reads and writes

**Copy 1 — `jobs/.auto/runs/<run_id>.jsonl`.** One JSON object per line, flushed
per event with `fs.appendFileSync`, never batched: _"a run that dies is precisely
the run whose last event matters most, and a buffer loses exactly that one."_

Two transformations happen on the way in:

- `scrubRecord()` — deny-by-default. Every string is scrubbed unless its key is
  machine-shaped (`untrusted-text.mjs`'s `VERBATIM_KEYS` — `t`, `run_id`, `slug`,
  `mode`, `outcome`, `kind`, `code`, `tier`, `nonce`, `at`, `pid`, `id`, `v` —
  plus keys ending in `_url`, `_at`, `_sha256`, `_path`, `_id`, `_ts` and
  similar). Those are still **scanned**, so a hostile confirmation URL still
  produces a finding; they are just not **rewritten**, because a mangled
  confirmation URL costs the user their one-click withdrawal. When anything is
  found, an `untrusted_findings: [{kind, count}]` field is attached:

  > "Redacting silently would leave the report saying '3 fields deferred' when the
  > truth is '3 fields deferred and one of them was talking to your agent'."

- U+2028 and U+2029 are escaped:

  > "U+2028/U+2029 are legal inside a JSON string and are LINE TERMINATORS in JS
  > source. Nothing evals this record, but it carries labels copied verbatim off
  > third-party pages and is meant to be pasted, grepped and re-embedded."

If anything was found, `raiseSecurityAlert()` also appends to `INBOX.md`.

Event types: `run.start`, `job.begin`, `job.defer`, `job.fail`, `submit.attempt`,
`submit.unresolved`, `submit.refused`, `submit.abandoned`, `submit.rehearsed`,
`submit.done`, `submit.unchecked`, `run.stop`, `run.finish`. Every event carries
`at` (an ISO timestamp) and `run_id`.

**Copy 2 — SQLite, in `jobs/leads.db`.**

`auto_runs`: `run_id` (primary key), `started_at`, `finished_at`, `mode`,
`outcome`, `planned`, `submitted`, `deferred`, `failed`, `stop_reason`,
`profile_sha_start`, `profile_sha_end`, `jsonl`, `doc` (the complete run record
verbatim).

`auto_submissions`: `run_id`, `slug`, `company`, `title`, `submitted_at`, `mode`,
`plan_sha256`, `confirmation_url`, `outcome`, `apply_url`, `doc`, with
**`PRIMARY KEY (slug, mode)`**.

That key is load-bearing, and both alternatives have been tried:

> "(run_id, slug) was backwards for a row whose job is to be a CLAIM: the same slug
> could be submitted once per RUN with no conflict at all, so the ledger could not
> refuse a second application to the same posting tomorrow. (slug) alone is wrong
> in the other direction: dry-run rows live in this same table on purpose, so a
> rehearsal would pre-consume the live claim forever and the first real run after
> an enable would find every slug already taken.
>
> mode is NOT NULL DEFAULT 'live' because SQLite permits NULLs in the columns of a
> non-INTEGER primary key, and a NULL mode would therefore not conflict with
> anything -- an unlimited number of un-refusable duplicate rows."

> _That last point is a genuine SQLite trap and it will not warn you._ Only
> `INTEGER PRIMARY KEY` is implicitly `NOT NULL`. In every other primary key a
> NULL column is allowed, and **a NULL conflicts with nothing** — so the key
> silently stops being enforced for exactly the rows that have one. Before adding
> a composite primary key to a text-keyed table, ask which of its columns can be
> NULL, because that is the column the key will not enforce.

The in-memory run `state` object carries: `run_id`, `started_at`, `finished_at`,
`mode`, `outcome`, `planned`, `submitted`, `deferred`, `failed`, `stop_reason`,
`profile_sha_start`, `profile_sha_end`, `blocked_companies`, `jsonl`, and an
optional `meta`.

### 8.6 Traps and things not to "fix"

- **Two copies, neither derived from the other.**
- **Write the intent before the click. Always.**
- **`persist()` after every counter change** so a crash cannot lose the count.
- **Never use `recordAutoSubmission` for a resolution** — use
  `acknowledgeAutoSubmission`, or the claim reports 0 changes and the resolution
  is silently dropped.
- **`abandonAttempt` requires an explicit `{beforeClick: true}`.**
- **A timeout during a click is ambiguous and must stay an orphan.**
- **`finish()` queries the ledger, not the in-memory map.**
- **Every `raiseStop` in this file passes `inboxPath` explicitly.** See §8.4.
- The JSONL is append-only; a test asserts earlier events survive every later
  write.
- `hashProfile` returns `null` for a missing file rather than throwing: _"a run
  that cannot start because of a hash is a run that stops applying for the wrong
  reason."_

> **Known defect (2026-08-05 audit), performance.** One SQLite connection is
> opened and closed per event, per job. `persist()` calls `openDb` and `close`
> every time, and it is called from `startRun`, `beginJob`, `deferJob`, `failJob`,
> `recordRehearsal`, `recordSubmission`, `stop` and `finish` — plus separate
> `openDb` calls inside `beginSubmit`, `abandonAttempt`, `recordSubmission` and
> `finish`, plus one per `authorizeSubmit` in `caps.mjs` and one in `submit.mjs`.
> Each `openDb` runs `mkdirSync`, three `PRAGMA`s, three `PRAGMA table_info` heal
> checks and the **entire** schema (about twenty `CREATE TABLE IF NOT EXISTS` and
> fifteen `CREATE INDEX IF NOT EXISTS`). That is roughly six to eight full opens
> per job — about 7 000 for a 999-job night — while `auto-apply.mjs` already holds
> an open connection and passes it to `runJob`. The fix is to let `startRun` and
> `capCheck` accept an optional `db`, exactly as `reconcile.mjs`'s
> `writeResolution` already does with its `db ?? openDb(dbFile)` plus an `owned`
> flag, and thread the campaign's connection through. Latency is a stated priority
> for this project, so this is a real defect and not a nitpick.

> **Known defect (2026-08-05 audit).** The header of this file says _"There is no
> runner yet (hard rule 6 ships auto-submit disabled), and nothing in this file
> should be read as evidence that an unattended application path is currently
> guarded — there is no unattended application path."_ That is stale.
> `auto-apply.mjs` imports `launchBrowser` from `../apply/browser.mjs` and calls
> it in `main()` with real stages from `makeStages({ jobsDir })`. `guard.mjs`'s
> header carries a matching stale claim (_"`auto_apply.enabled` is false in the
> user's file and there is no `board_allowlist` in it"_), as does
> `authorize.mjs`'s (_"THERE IS STILL NO RUNNER"_). The user's
> `docs/application-limits.yaml` currently reads `enabled: true`, `dry_run: false`
> and carries a four-entry `board_allowlist`. The project's own guidance names
> this exact failure mode — _"a control stated as fact gets believed in instead of
> implemented"_ — so the fix is to delete the configuration assertions from those
> comments and state capability rather than inventory. **Do not edit
> `docs/application-limits.yaml`; that file is the user's.** The genuine remaining
> brake on an unattended live submit is `classify.mjs` returning `unclassified` on
> every real board (§5.2), not the configuration.

### 8.7 Dependencies

**Imports:** `node:fs`, `node:path`, `node:crypto`; a large slice of
`./guard.mjs`; `openDb`, `upsertAutoRun`, `recordAutoSubmission`,
`acknowledgeAutoSubmission`, `readAutoSubmission`, `readOrphanAttempts`,
`readAttemptsForRun`, `DB_PATH` from `../lib/db.mjs`; `assertTokenMatches` from
`./authorize.mjs`; `safeText` and `scrubRecord` from `./untrusted-text.mjs`.

**Depended on by:** `auto-apply.mjs`, five test files, and
`tests/fixtures/auto/kill-at.mjs`.

---

<a id="taxonomy"></a>

## 9. `src/auto/taxonomy.mjs` — the closed vocabulary of reasons

### 9.1 What it is and why it exists

The vocabulary itself — `AUTO_DEFER_KINDS`, `AUTO_FAILURE_KINDS`,
`AUTO_CHALLENGE_KINDS`, `autoReasonClass`, `assertReasonKind` — lives in
`src/lib/db.mjs`, _"beside the column that stores it, because a closed value
set is only closed if the writer enforces it"_. This file is the **policy** on
top of it: which stage produced a reason, which class it aggregates into, and,
when several reasons apply at once, **which single one is recorded**.

That last question is the whole point:

> "A single application often defers for several reasons at once — a consent
> tickbox AND an unprobed dropdown AND two unknown fields. The row records ONE …
> That is not a simplification; it is the arithmetic the backlog depends on.
>
> The defer log's whole job is to answer 'what would building X unlock?'. If a job
> blocked by a consent tickbox were counted under `unprobed-dropdown` because a
> dropdown also went unprobed, then building the dropdown probe would be credited
> with an application it cannot deliver — the tickbox still stops it. So the
> recorded kind is the LEAST REMOVABLE one: the constraint that would still be
> there after every engineering fix on the list."

### 9.2 How you run or use it

A **library**. `job.mjs` imports `classifyPlanDefers`, `reasonRecord` and
`toStateOpts`; `digest.mjs` imports `reasonClass` and `newlyChallengedBoards`;
`src/dev/bench-runner.mjs` imports `classifyPlanDefers` and `toStateOpts`.

### 9.3 Everything it exposes

| Export                                                          | Signature / value                                                                                       |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| re-exports from `db.mjs`                                        | `AUTO_DEFER_KINDS`, `AUTO_FAILURE_KINDS`, `AUTO_CHALLENGE_KINDS`, `autoReasonClass`, `assertReasonKind` |
| `STAGES`                                                        | frozen `["queue","claim","plan","authorize","attempt","post-submit","reconcile"]`                       |
| `REASON_CLASSES`                                                | frozen object: `understanding`, `assent`, `environment`, `policy`, `malfunction`                        |
| `reasonClass(kind)`                                             | `-> class name \| null`                                                                                 |
| `DEFER_PRIORITY`                                                | frozen array of the twenty defer kinds, least-removable first                                           |
| `TaxonomyError`                                                 | `extends Error`, `code: "ETAXONOMY"`                                                                    |
| `kindForWhy(why)`                                               | `-> kind \| null`                                                                                       |
| `reasonRecord({kind, stage, board_key, origin, detail, state})` | `-> frozen {kind, stage, board_key, origin, detail, state, class}`                                      |
| `toStateOpts(record)`                                           | `-> {reason_kind, reason_stage, reason_detail}`                                                         |
| `classifyPlanDefers(defers, ctx)`                               | `-> a reasonRecord \| null`                                                                             |
| `newlyChallengedBoards(rows)`                                   | `-> [{board_key, challenges, why}]`                                                                     |

`STAGES` is closed _"because 'somewhere in the pipeline' is not a stage anybody
can act on, and because the same kind means different things at different stages:
`posting-gone` at `plan` is a lead that rotted, at `attempt` it is a race with the
employer."_

`REASON_CLASSES` — the five buckets, with the docstring meanings:

| Class           | Kinds                                                                                                                                          | What it means                                                                                                                                                                      |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `understanding` | `unknown-field`, `unprobed-dropdown`, `fill-failed`, `multipage-unresolvable`                                                                  | _"THE ONLY CLASS THAT SHRINKS WITH ENGINEERING, and the only sanctioned throughput lever: an adapter, a probed option list, or a banked answer. Never a model reading the field."_ |
| `assent`        | `confirm-field`, `confirm-widget`, `consent-tickbox`, `freetext-disclosure`                                                                    | _"Does not shrink with engineering and MUST NOT: shrinking it is the failure mode hard rule 6 is written to prevent."_                                                             |
| `environment`   | `captcha`, `bot-challenge`, `email-code-challenge`, `identity-verification`, `posting-gone`, `board-paused`, `reconciled-not-sent`             | The board or the posting declined. Not ours, not a bug.                                                                                                                            |
| `policy`        | `doc-unverified`, `doc-unrendered`, `fact-base-changed`, `board-untrusted`, `board-unsighted`, `l3-rejected`, `cap-company`, `already-applied` | _"Working exactly as intended."_                                                                                                                                                   |
| `malfunction`   | every kind in `AUTO_FAILURE_KINDS`                                                                                                             | _"The only class worth waking for."_                                                                                                                                               |

**Two module-load assertions** — not tests; they throw at `import` time:

1. Every kind in `AUTO_DEFER_KINDS` and `AUTO_FAILURE_KINDS` must have a class,
   _"because a kind added to db.mjs and forgotten here would otherwise aggregate
   into `null` and quietly vanish from the digest."_
2. Every defer kind must have a position in `DEFER_PRIORITY`, _"an unranked kind
   cannot be chosen against another one."_

So adding a kind to `db.mjs` without adding it here **crashes the program at
import**. That is the design: a loud crash on the developer's machine, rather than
a silently wrong number in a report months later.

### 9.4 How it works, step by step

**`kindForWhy`** maps a field-level reason to a countable kind. The two
vocabularies are deliberately unmerged:

> "`why` describes a FIELD ('consent', 'long-free-text', 'UNRESOLVED') and is shown
> to a human looking at one form; a kind describes an APPLICATION and is counted
> across a campaign."

The exact map: `consent`→`consent-tickbox`, `confirm`→`confirm-field`,
`confirm-widget`→`confirm-widget`,
`identity-verification`→`identity-verification`,
`long-free-text`→`freetext-disclosure`,
`disclosure-budget`→`freetext-disclosure`, `captcha`→`captcha`,
`bot-challenge`→`bot-challenge`, `unresolved`→`unknown-field`,
`unknown`→`unknown-field`, **`needs-choice`→`unknown-field`**,
**`maybe`→`unknown-field`**, `unprobed-dropdown`→`unprobed-dropdown`,
`fill-failed`→`fill-failed`.

The two marked entries carry a bug report in the comment:

> "Only the first was mapped, so a real Greenhouse form deferring two fields the
> bank could not choose between reported as `plan-error` — a FAILURE kind, read as
> 'the planner is broken', when the truth was 'two dropdowns need an answer the
> user has not banked'."

A second list, `WHY_PREFIXES`, handles reasons that are built as sentences —
matched by **prefix, never substring**:

> "a substring rule is the string matching this taxonomy exists to replace, and it
> is also how a hostile label could steer its own classification."

`unsupported field type`→`unknown-field`,
`optional and not in the fact base`→`unknown-field`, `no rendered`→`doc-unrendered`,
`unrecognised attachment slot`→`unknown-field` (both re-typed 2026-08-18: they
used to map to `doc-unverified`, which is about verification, and the digest
sent readers to verify-claims for a missing PDF). The last two were added after a
real run:

> "a workspace that simply had not been rendered to PDF yet reported as a code
> fault — '3 deferred field(s) carry a reason the taxonomy does not classify' — and
> the honest reading of that message is 'something is broken', which sends the next
> reader into the planner instead of into the jobs/ directory."

**`null` is a real answer** and callers must handle it:

> "Defaulting an unrecognised reason to `unknown-field` would be the same mistake
> in a nicer coat: the digest would show a growing `unknown-field` bucket that no
> dropdown probe or adapter could ever shrink."

**Worked example of `classifyPlanDefers`.** Input:

```js
;[
  { label: "I agree to the terms", why: "consent" },
  { label: "How did you hear about us?", why: "unprobed-dropdown" },
  { label: "Desired salary", why: "unresolved" },
]
```

1. Map each `why` to a kind:
   `["consent-tickbox", "unprobed-dropdown", "unknown-field"]`. None unmapped.
2. Rank by position in `DEFER_PRIORITY`. `consent-tickbox` is at index 0 and wins.
3. Build the detail line:
   `"3 field(s) need a human; first: I agree to the terms (also unprobed-dropdown, unknown-field)"`.
4. Return:

```js
{
  kind: "consent-tickbox",
  stage: "plan",
  board_key: "greenhouse",
  origin: "https://boards.greenhouse.io",
  detail: "3 field(s) need a human; first: I agree to the terms (also unprobed-dropdown, unknown-field)",
  state: "deferred",
  class: "assent",
}
```

Note what that says to whoever reads the backlog: building the dropdown probe
would **not** unlock this application. The consent tickbox still stops it.

If any `why` is unrecognised, the whole record becomes `kind: "plan-error"` — a
**failure** kind, loudly:

> "The alternative — bucketing it under some plausible defer kind — produces a
> number that looks like a product problem and is actually a mapping bug, and
> nobody would ever find it because the digest would look healthy."

**`reasonRecord`** throws `TaxonomyError` on an unknown kind or stage, and passes
the one free-text field through `safeText(detail, 240)`. Its `state` parameter
exists for exactly one case:

> "The class implies the state — EXCEPT for a challenge, where the class is
> 'deferred' (the machine did not malfunction) and the state must be 'challenged'
> (a click went out and we do not know whether it landed). Only the caller knows
> which side of the click it is on."

**`newlyChallengedBoards`** takes `readChallengeIncidence` rows
`[{board_key, current, prior}]` and returns those with `current > 0 && prior === 0`:

> "Said explicitly so a caller cannot read this as 'the board is broken'. A
> challenge is the board working as designed against automation; what is anomalous
> is that it started, not that it happened."

### 9.5 What it reads and writes

Reads nothing, writes nothing. It produces the three `auto_queue` columns
`reason_kind`, `reason_stage` and `reason_detail`, via `toStateOpts` →
`setAutoJobState`. Those three columns are what make the defer log a `GROUP BY`
rather than a string match — "unprobed-dropdown at plan on greenhouse cost 61
applications this week" is a query, not a search.

### 9.6 Traps and things not to "fix"

- **Adding a kind to `db.mjs` without adding it here crashes at import.** That is
  the design; do not weaken the assertion into a warning.
- **The recorded kind is the least removable, not the first or the worst.**
- **`kindForWhy` returning `null` must stay a real answer.**
- **Prefix matching, never substring.** A hostile field label must not be able to
  steer its own classification; a test asserts this.

### 9.7 Dependencies

**Imports:** from `../lib/db.mjs` and `./untrusted-text.mjs`.

**Depended on by:** `job.mjs`, `digest.mjs`, `src/dev/bench-runner.mjs`,
`tests/auto/taxonomy.test.mjs`.

---

<a id="digest"></a>

## 10. `src/auto/digest.mjs` — "is the machine working?"

### 10.1 What it is and why it exists

It computes the `auto` section of `node src/status.mjs`: queue depth,
deferral counts by kind and class, latency percentiles, paused boards, orphans,
the STOP switch, and a list of warnings.

> "IT REPORTS PROGRESS, NOT RECENCY. The distinction is the whole item. A digest
> that says '3 applications submitted in the last 24 hours' is compatible with a
> queue of 900 that has not moved since Tuesday, a board that has been paused since
> 02:14, and a STOP nobody noticed. Every number here exists to close one of those
> blind spots, and the most informative of them is QUEUE DEPTH: a depth that is not
> falling is the single clearest statement the auto path can make about itself."

> "Nothing in this file decides anything. It reads rows and computes statistics;
> the brake, the caps and the trust gate live elsewhere and are not consulted."

### 10.2 How you run or use it

A **library**, called only from `src/status.mjs`. That script wraps the call
in a `try/catch` and returns `{unavailable: <message>}` on error: _"'where do
things stand?' must not fail because a feature the user has not switched on has no
rows."_ Command-line flags that reach it: `--cadence-hours`, `--stop-path`,
`--db`.

```console
node src/status.mjs
```

### 10.3 Everything it exposes

| Export                                                   | Signature / value                            |
| -------------------------------------------------------- | -------------------------------------------- |
| `DEFAULT_CADENCE_MS`                                     | `12 * 60 * 60 * 1000` (twelve hours)         |
| `percentile(values, p)`                                  | nearest-rank; **`null`** on an empty sample  |
| `buildAutoStatus(db, {now, runId, cadenceMs, stopPath})` | the `auto` object                            |
| `formatAutoTerse(a)`                                     | `-> string[]`, one fact per line, for agents |
| `formatAutoProse(a)`                                     | `-> string[]`, human sentences               |

`percentile` returns `null`, not zero, on an empty sample:

> "'nothing has happened yet' and 'everything is instant' are opposite pieces of
> news and a digest that renders them the same is worse than one that omits the
> row."

`DEFAULT_CADENCE_MS` is a _default the caller may override_, not a value written
into the user's config, _"because docs/application-limits.yaml is the user's
file."_

> _Percentile, nearest-rank_: sort the numbers, then p50 is the middle one and p95
> is the one 95% of the way up. p95 is more useful than an average here, because
> one job stuck for three days moves an average a little and moves p95 a lot.

### 10.4 The returned object, field by field

```js
{
  run_id, run_outcome, run_started_at,
  submitted_24h,          // countAutoSubmissions(db, now - 24h)
  submitted_total,        // auto_queue rows in state 'submitted'
  challenged, orphans,
  deferrals: { total, failures, by_kind, by_class, by_board },
  queue: { depth: {queued, claimed, planned, authorized}, outstanding,
           age_p95_ms: {queued, claimed}, age_unknown },
  latency: { n, p50_ms, p95_ms, p50_hours, p95_hours },
  wall: { n, p50_ms, p95_ms,                       // per-JOB wall time, in ms
          by_stage: { [stage]: {n, p50_ms, p95_ms} },  // slowest stage first
          slowest: {slug, ms, stage} | null },
  paused_boards: [{board_key, held, since, until, reason_kind}],
  newly_challenged: [{board_key, challenges, why}],
  stop: { active, reason },
  warnings: [{kind, n, detail}],
}
```

Warning kinds emitted: `queue-stalled` (a job older than one scheduler cadence),
`age-unknown`, `orphan-attempt`, `unconfirmed` (challenged rows), `board-paused`,
`new-challenge`, `stopped`.

> "These are WARN and not FAIL on purpose. This command reports; it does not stop
> anything. The brake is jobs/.auto/STOP and it is set by the runner or by the
> user, never by a digest."

**Worked example — the terse rendering:**

```text
auto run=2026-08-04T02-10-00-000Z-a1b2c3 outcome=ok stop=clear
auto submitted 24h=7 total=7 challenged=1 orphans=0
auto queue outstanding=42 queued=40 claimed=1 planned=1 authorized=0 age_p95_queued=39600000 age_p95_claimed=- age_unknown=0
auto deferrals total=53 failures=2 consent-tickbox=21 unknown-field=17 unprobed-dropdown=13 board-paused=2
auto class assent=21 understanding=30 environment=2
auto latency n=7 p50h=18.4 p95h=41.2
auto wall n=60 p50ms=4180 p95ms=39210 slowest=acme-sre(39210ms@plan)
auto wall by_stage plan=5100/39210(n=31) authorize=3900/9100(n=22) submitted=3200/4400(n=7)
auto paused greenhouse(12)
auto WARN queue-stalled n=6
auto WARN board-paused n=12
```

Read that as: seven applications went out, one of them got challenged, the queue
still has 42 outstanding and the oldest 5% have been waiting eleven hours,
consent tickboxes are the biggest single blocker at 21, Greenhouse is paused
holding twelve jobs, and six jobs have been sitting longer than one scheduler
cadence.

### 10.5 What it reads and writes

Reads, all from `../lib/db.mjs`: `latestAutoRun`, `autoQueueCounts`,
`readReasonCounts`, `readQueueAges`, `readSubmitLatencies`,
`readActiveBoardPauses`, `readChallengeIncidence`, `readOrphanAttempts`,
`countAutoSubmissions`. Plus `stopActive` and `readStop` from `./guard.mjs`.
Writes nothing.

`readSubmitLatencies` joins `auto_queue.posted_at` to
`auto_submissions.submitted_at` — the "the posting went up, and we applied" gap.
That is the number the owner benchmarks this pipeline against a commercial
service on, so it is a first-class output rather than a nice-to-have.

### 10.6 Traps and things not to "fix"

- **The digest never decides or brakes anything.**
- **`percentile` must not turn an empty sample into 0.**
- **`age_unknown` rows are reported rather than dropped:** _"It is the one row
  most likely to be the stuck one."_

> **Known defect (2026-08-05 audit).** Scoped STOPs are invisible to
> `status.mjs`. `buildAutoStatus` computes
> `stop: { active: stopActive(...), reason: readStop(...) }` from the **global**
> path only, and the `stopped` warning fires only on that. Nothing in `src/`
> calls `activeStops` except `assertNotStopped`. Since brakes became scoped, the
> durable ones that actually get written are company-scoped — the kind only a
> human can clear — so a company brake never appears in the one command that
> answers "is the machine working?", and the affected jobs just keep deferring.
> The fix is to enumerate `jobs/.auto/stops/**` in `buildAutoStatus`, add a
> `scoped_stops` array, and add a warning.

> **Known defect (2026-08-05 audit).** `buildAutoStatus`'s `runId` is silently
> ignored for deferrals and latency. The calls to `readReasonCounts` and
> `readSubmitLatencies` hardcode `{ run_id: null }`, while `readActiveBoardPauses`
> and `readChallengeIncidence` receive the resolved `run_id`. Both readers accept
> a `run_id`. So "what did last night's run defer, and why" is not answerable, and
> `by_kind` grows without bound across every run ever recorded. Either pass
> `run_id` through, or report both a run-scoped and an all-time block and label
> which is which.

### 10.7 Dependencies

**Imports:** nine readers from `../lib/db.mjs`, `stopActive`/`readStop` from
`./guard.mjs`, `reasonClass`/`newlyChallengedBoards` from `./taxonomy.mjs`.

**Depended on by:** `src/status.mjs`, `tests/auto/digest.test.mjs`.

---

<a id="notify"></a>

## 11. `src/auto/notify.mjs` — the desktop toast

### 11.1 What it is and why it exists

Raises a Windows toast notification when the runner disables itself. Best-effort
by design: it cannot throw and cannot block.

> "The STOP file is the brake and INBOX.md is the record; both are durable and both
> are checked by code. A toast is neither. It exists because the runner is a
> scheduled task that fires while nobody is looking, and a brake nobody notices for
> eleven hours has stopped the machine without telling anyone — but if the
> notification API is missing, or the shell is locked down, or the user is on a
> different OS, that must degrade to 'no toast' and never to 'no stop'."

> "NO DEPENDENCY, DELIBERATELY. The usual answer is the BurntToast module, which
> means installing something onto the user's machine for a cosmetic feature. This
> uses the WinRT ToastNotificationManager that ships with Windows 10, through the
> PowerShell AppID that is already registered — no install, and no new thing to
> remove later."

That matches the owner's standing preference that installed tooling be removed
when the job is done — the best way to honour it is not to install anything.

### 11.2 How you run or use it

A **library**, used from one place: `raiseStop`'s `notify` option defaults to
`toast`, and the call there is wrapped in a `try/catch`.

### 11.3 Everything it exposes

```js
export function toast(title, body, { platform = process.platform, env = process.env } = {})
// -> { attempted: boolean, reason: string | null }   // synchronous; never throws
```

Four early returns, in order:

| #   | Condition                      | Returns                                                         |
| --- | ------------------------------ | --------------------------------------------------------------- |
| 1   | `env.AJ_NO_TOAST` is set       | `{attempted: false, reason: "AJ_NO_TOAST is set"}`              |
| 2   | `env.NODE_TEST_CONTEXT` is set | `{attempted: false, reason: "running under node --test"}`       |
| 3   | `platform !== "win32"`         | `{attempted: false, reason: "no toast backend for <platform>"}` |
| 4   | otherwise                      | spawns PowerShell detached; `{attempted: true, reason: null}`   |

The second one is there for a reason worth remembering:

> "it is here because relying on a suite to remember an env var is how a green run
> ends with forty notifications on somebody's desktop"

The spawn is
`spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script(title, body)], {detached: true, stdio: "ignore", windowsHide: true})`,
followed by a no-op `error` handler and `child.unref()`. Any throw is caught and
returned as `{attempted: false, reason: <message>}`.

The PowerShell script loads the WinRT types, builds a `ToastText02` XML document,
and shows it through `CreateToastNotifier(APP_ID)` where `APP_ID` is PowerShell's
own registered application id:

> "A toast needs one that exists in the start menu or Windows silently drops it;
> borrowing PowerShell's is the only way to raise one without registering an
> application first."

**Both strings are XML-escaped** (`&`, `<`, `>`, `"`):

> "because the title and body carry text that may have come off a third-party page.
> A toast is a render target like any other."

`raiseStop` also truncates the body to 200 characters before passing it in.

### 11.4 What it reads and writes

Nothing on disk. It spawns one detached PowerShell process per call.

### 11.5 Traps and things not to "fix"

- **Nothing in this file may throw.** Everything is inside a `try/catch` or an
  early return.
- **Detached plus `unref()`** — _"the notification must outlive the process that
  raised it, and a runner exiting must never wait on a cosmetic child."_
- **The XML escaping is a security control, not cosmetics.** Page-derived text
  reaches this function.
- One PowerShell process is spawned per `raiseStop`.

### 11.6 Dependencies

**Imports:** `spawn` from `node:child_process`.

**Depended on by:** `guard.mjs`, `tests/auto/inbox.test.mjs`.

---

## The four brakes, side by side

Keep this table handy. Confusing any two of these rows is the most likely way to
break this area.

| Mechanism       | Where it lives                                 | Lifetime           | Cleared by                        | Scope                     |
| --------------- | ---------------------------------------------- | ------------------ | --------------------------------- | ------------------------- |
| **Global STOP** | `jobs/.auto/STOP`                              | durable, forever   | a human deleting the file         | everything                |
| **Scoped STOP** | `jobs/.auto/stops/{run,board,company}/<key>`   | durable, forever   | a human deleting the file         | one run / board / company |
| **Board pause** | `breaker.mjs` memory plus a `board_pauses` row | one run, 5 minutes | expiry, then one successful probe | one board                 |
| **Defer**       | `auto_queue.reason_kind`                       | this job only      | nothing — it _is_ the answer      | one application           |

## The invariants nobody should "fix" back

1. `auto_submissions` is keyed `(slug, mode)`.
2. A **0** from a claim means somebody else owns the slug; do not click.
3. `reconciled-not-sent` is the only outcome that releases the claim.
4. A scoped STOP is durable; a board pause is timed. Never merge them.
5. `raiseStop` throws on a keyless non-global scope rather than widening to
   global.
6. There is no `clearStop()` at any scope.
7. A fixture-sourced classifier rule fires on loopback only; a real board reading
   `unclassified` is correct.
8. The trust gate never infers the ATS from the URL.
9. `preflight` and `authorize` supply **no defaults** for anything in the user's
   file.
10. An `UNKNOWN` field blocks on both the attended and the unattended path,
    always.
11. The token is spent by deletion, not by a flag.
12. Every string that reaches a record goes through `safeText` or `scrubRecord`.

---

## If you were rebuilding this

Three decisions carry almost all the weight. Everything else in these eleven
files follows from them, and each one is a thing a reasonable person gets wrong
on the first attempt.

**1. Make permission an object, not a question.** The instinct is to write
`if (isAllowed(job)) { click() }`. That works until someone adds a second place
that clicks — and there is always a second place, because "just this one build
step is awkward" is how it starts. Then the check is a convention, and a
convention is not a control. The fix is to make the clicking function
_structurally unable to run_ without an object only one function can mint, spend
that object by **deleting** it from a ledger rather than by setting a flag on it
(a frozen object can be copied with `{...token}`; a nonce cannot be un-deleted),
and back the whole arrangement with a test that asserts the click appears in
exactly the files you expect. The naive version — a boolean returned from a
checker — fails silently and looks fine in review.

**2. Scope every brake to what it actually has evidence about.** The first
version of this system had one brake: a file whose existence halted everything
until a human deleted it. That is correct at three jobs a night and catastrophic
at nine hundred, because the blast radius of the halt scaled with the run and the
trigger did not — one unresolvable orphan at one employer took down a night that
would otherwise have sent 900 applications. The fix is not to make the brake
weaker; it is to make it _narrower_: a company brake for "this employer's state is
unknown", a board brake for "this ATS did something nothing understood", a run
brake for "this run's own bookkeeping is broken", and global reserved for a
genuinely broken invariant. And then — this is the part people skip — make the
function that files a brake **throw** when a caller names a narrow scope without a
key, rather than falling back to global. Falling back to global is the "safe"
choice that turns one caller's bug into every night's outage, invisibly.

Keep the _timed_ backoff and the _durable_ brake as separate mechanisms with
separate names. They feel like the same idea (stop trying this thing) and they are
not: one absorbs a wifi drop and clears itself on the next success; the other says
a human has to look. Merging them means either your wifi drop needs a human, or
your "a person must check this" gets cleared by a retry.

**3. Make evidence a property of the rule, not of the author's confidence.** The
post-submit classifier is the sharpest version of this. Writing `if (html
.includes("Thank you for applying")) return "confirmation"` feels obviously fine.
It is the same guess a model would make, with the model removed and your
imagination left in — and it fails in the one direction that cannot be recovered,
because a page misread as a confirmation records an application that was never
sent, and nothing later corrects it. Attaching `evidence: {source, sample}` to
each rule, and letting the source _bound where the rule may fire_, converts "I
believe this" into "this repository has actually seen this". The uncomfortable
consequence — every real board reads `unclassified` and hard-stops until the owner
captures real pages from their own attended applications — is the system correctly
reporting the state of its own evidence. Resist every instinct to route around it.
The naive mistake here is not the regex; it is treating an empty corpus as a
placeholder to be filled with plausible guesses rather than as a measurement.

A fourth, smaller one, which will save you a week: **decide early what a `0` from a
database write means, and write it down beside the SQL.** In this system a `0` from
the queue claim is the ordinary result for every worker but one, and a `0` from the
submission claim in the same run is an anomaly serious enough to brake a company.
Same value, opposite meanings, and the only thing distinguishing them is where in
the sequence it happened. Undocumented, that is a bug that takes days to find and
about four lines to fix.
