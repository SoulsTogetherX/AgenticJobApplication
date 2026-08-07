# Glossary

This is the dictionary for every other document in this set. The rest of the
documentation teaches ideas in order — what the project is, how a computer runs
a program, what the code is made of, how the pieces fit, how the data is stored,
what keeps it safe. This document is the opposite shape: it is a flat,
alphabetical list you dip into when you meet a word cold and want one honest
paragraph about it before going back to what you were reading.

Two kinds of word live here side by side, and telling them apart matters.

Some are **ordinary computing vocabulary** — a race condition, a primary key, a
regular expression. Those mean the same thing here as anywhere, and if you learn
them you have learned something portable.

Others are **this project's own vocabulary** — a lead, a defer, an intent, the
trust gate. Those are inventions of this repository. Nobody outside it will know
what you mean, and several of them are ordinary English words given a narrow
technical meaning, which is the worst kind of trap. Where a word means one thing
in the wider world and something specific here, this glossary gives **both**,
labelled, so you never carry the wrong one across.

Every entry ends with an arrow pointing at the document that covers the term
properly. This glossary defines; those documents explain.

**What you will learn**

- **A definition for every term** you will meet in this documentation, in one to
  three plain sentences, with no assumed background.
- **Which words are general knowledge and which are local jargon**, so you know
  what transfers if you rebuild this on your own and what you would have to
  re-invent.
- **The exact identifiers this project uses** — real file paths, real function
  names, real database table and column names, real command-line flags — because
  a definition that paraphrases the code is a definition you cannot search for.
- **Where each idea is taught in full**, via a link on every entry.
- **Which named things are broken today**, marked
  `> **Known defect (2026-08-05 audit).**` where the defect is part of what the
  word now means in practice.

How to read an entry:

- **term** — **In general:** what it means in computing at large. **Here:** what
  it means in this repository, when that is different. → link to the full
  treatment.

Terms are alphabetised ignoring any leading `a`, `an` or `the`. Symbols,
filenames and numbered things (`L0`, `R6`, `.env`) are filed under the letter
they are spoken as: `L0` under L, `R6` under R, `.env` under E.

---

## A

- **accessibility tree** — A parallel description of a web page that browsers
  build for screen readers, saying what each element _is_ (a button, a checkbox,
  a text box) and what it is _called_, rather than how it looks. This project's
  form scanner reads it because a page's visual layout is unreliable but its
  accessibility roles usually are not. →
  [`../code/06-apply-scanning.md`](../code/06-apply-scanning.md)

- **ACID** — Four promises a serious database makes about a group of changes:
  Atomicity (all of them happen or none do), Consistency, Isolation (concurrent
  work does not see half-finished changes) and Durability (once it says saved, a
  power cut cannot lose it). SQLite, the database used here, provides all four. →
  [`./06-data-model.md`](./06-data-model.md)

- **adapter (ATS adapter)** — A small file that knows the quirks of one job
  board's application form: which order it renders its file-upload slots in, and
  which sequence of typing and clicking actually commits a value in its dropdown
  widgets. This repository ships three named adapters —
  `scripts/apply/ats/greenhouse.mjs`, `lever.mjs`, `ashby.mjs` — plus
  `generic.mjs`, a fallback whose `match` pattern is `/.^/`, a regular expression
  deliberately written so it can never match anything and can therefore only be
  chosen explicitly as the last resort. →
  [`../code/08-apply-filling.md`](../code/08-apply-filling.md)

- **advance** — `scripts/auto/advance.mjs`, the only file besides `submit.mjs`
  allowed to contain a browser click, and it may click only a control the plan
  has typed as a `next`-role page-advance button — never a submit. →
  [`../code/09-auto-runner.md`](../code/09-auto-runner.md)

- **agent** — **In general:** an AI model given tools and a goal, allowed to
  decide for itself which tools to call and in what order. **Here:** Claude
  running inside Claude Code with permission to read files, run scripts and drive
  a browser. The whole design of this repository is about narrowing what the
  agent is trusted to decide. →
  [`./04-ai-and-agents.md`](./04-ai-and-agents.md)

- **aggregator** — A site that republishes other companies' job postings rather
  than hosting its own (Adzuna, Jobicy, Remotive). Useful for breadth, weaker for
  trust, because the aggregator is not the employer. →
  [`../code/02-leads-finding.md`](../code/02-leads-finding.md)

- **alias (keyword)** — In `scripts/lib/keywords.mjs`, a way an outsider's job ad
  might refer to a skill. Deliberately **not** interchangeable with `surface`:
  folding aliases into a truthfulness check would let a stranger's vocabulary
  vouch for a claim your own facts cannot back. →
  [`../code/01-lib-foundation.md`](../code/01-lib-foundation.md)

- **allowlist** — A list of the things that are permitted, with everything else
  refused by default. The opposite of a denylist. This project prefers allowlists
  for anything that decides whether an action may happen, because a denylist is
  only as good as the author's imagination. →
  [`./07-safety-model.md`](./07-safety-model.md)

- **amber** — One of the four automatability tiers. It means "this form might be
  fillable without a human, but nothing here can know that yet" — usually because
  the form's shape has never been cached. →
  [`../code/07-apply-planning.md`](../code/07-apply-planning.md)

- **answer bank** — `profile/answers.yaml`: the file of questions you have
  already answered on some earlier application, so the same question is never put
  to you twice. Each entry stores the question as it was asked, your answer, and
  a class saying whether it is a fact or an act of assent. Only
  `scripts/profile/save-answer.mjs` may write it. →
  [`../code/11-record-and-profile.md`](../code/11-record-and-profile.md)

- **API** — Application Programming Interface: a way for one program to ask
  another for data, instead of a human reading a web page. Most job boards here
  are read through public JSON APIs, which is why the sweep is fast and does not
  need a browser. →
  [`../code/02-leads-finding.md`](../code/02-leads-finding.md)

- **append-only log** — A file or table you only ever add rows to, never edit or
  delete. Appending is safe when several programs write at once, because nobody
  has to read the file first, so nobody can overwrite what another writer just
  added. →
  [`./06-data-model.md`](./06-data-model.md)

- **argument (positional)** — A value you type after a command with no name
  attached, identified purely by its place: in
  `node scripts/documents/keyword-plan.mjs render-postgres-product-engineer`, the
  slug is positional. Contrast a **flag**. →
  [`../operate/01-commands.md`](../operate/01-commands.md)

- **ARIA** — A set of HTML attributes (`role`, `aria-label`, `aria-required`,
  `aria-checked`, `aria-controls`, `aria-expanded`) that tell assistive
  technology what a piece of a page means. The form scanner leans on them heavily
  because `role="combobox"` is a far more reliable signal than any styling. →
  [`../code/06-apply-scanning.md`](../code/06-apply-scanning.md)

- **Ashby** — A modern applicant tracking system used by many startups
  (`jobs.ashbyhq.com`). Notable here for two reasons: its React front end
  re-mounts parts of the form while you are filling it, which invalidates element
  references, and it has both a lead fetcher and a fill adapter in this repo. →
  [`../code/08-apply-filling.md`](../code/08-apply-filling.md)

- **assent** — **In general:** agreeing to something. **Here:** a precise
  category distinct from a _value_. "What is your phone number?" asks for a
  value; "I agree to the terms" and "I consent to a background check" ask you to
  _perform an act_. The system may fill values from your fact base but treats
  assent as something only a person can give. →
  [`./07-safety-model.md`](./07-safety-model.md)

- **assertion (answer class)** — One of the two classes an answer bank entry
  carries, the other being `datum`. A `datum` is a fact about you (your city). An
  `assertion` is something you _claim_ rather than merely state — work
  authorisation, willingness to relocate, agreement to arbitration. An assertion
  never fills silently on the unattended path. →
  [`../code/07-apply-planning.md`](../code/07-apply-planning.md)

- **assertion (testing)** — A single check inside a test: "this value must equal
  that one". A test with no assertion proves nothing, which is why the test gate
  counts tests rather than trusting an exit code. →
  [`../code/14-tests.md`](../code/14-tests.md)

- **async / await** — JavaScript keywords for work that takes time, such as a
  network request. `await` pauses one function until the result arrives while the
  rest of the program keeps running. →
  [`./03-programming-basics.md`](./03-programming-basics.md)

- **atomic** — An operation that either completes entirely or does not happen at
  all, with no observable half-state. A single SQL `UPDATE ... WHERE` is atomic,
  which is why this project uses one as the mechanism by which two workers decide
  which of them owns a job. →
  [`./06-data-model.md`](./06-data-model.md)

- **ATS (applicant tracking system)** — The software an employer buys to receive
  and manage job applications. Almost no employer writes its own; they rent one,
  so learning six ATS products covers thousands of companies. This project reads
  leads from thirteen ATS types and can fill forms on three of them. →
  [`./01-what-this-is.md`](./01-what-this-is.md)

- **attended path** — Applying with you present: you gave the agent a posting
  URL, you see the approval message, and the agent applies. Contrast the
  **unattended path**. Under hard rule 6 the agent does click submit on this path.
  →
  [`./07-safety-model.md`](./07-safety-model.md)

- **audit (the)** — `docs/audit-2026-08-05.md`, a full read of every source file
  by seventeen independent readers, each finding carrying the code or executed
  output that proves it. Every `> **Known defect (2026-08-05 audit).**` note in
  this documentation traces back to it. →
  [`../audit-2026-08-05.md`](../audit-2026-08-05.md)

- **automatability** — `scripts/apply/automatability.mjs`: a judgement about
  whether the deterministic pipeline could fill a given posting's form without a
  human. Four tiers, first match wins: `handoff`, `blocked`, `amber`, `green`. It
  is deliberately **not** a screening stage, because "we cannot do this one alone"
  must never turn into "you never see this job". →
  [`../code/07-apply-planning.md`](../code/07-apply-planning.md)

## B

- **backoff** — Waiting before retrying something that just failed, usually
  waiting longer after each failure. The board pause in
  `scripts/auto/breaker.mjs` is a timed backoff. →
  [`../code/10-auto-safety.md`](../code/10-auto-safety.md)

- **baseline** — A recorded measurement that later runs are compared against. The
  performance gate keeps one and fails the build when a new run is worse. →
  [`../code/15-benchmarks.md`](../code/15-benchmarks.md)

- **benchmark** — A program that measures how long something takes, run enough
  times to be believable. `scripts/dev/bench-apply.mjs` and
  `scripts/dev/bench-runner.mjs` are this project's. A single sample is not a
  measurement. →
  [`../code/15-benchmarks.md`](../code/15-benchmarks.md)

- **blast radius** — How much damage one thing going wrong can do. Most of the
  unattended-path design is blast-radius arithmetic: a scoped STOP brakes one
  company instead of the night, and `scripts/auto/caps.mjs` limits how many
  applications a single run can send. →
  [`../code/10-auto-safety.md`](../code/10-auto-safety.md)

- **BLOB** — Binary Large OBject: a database column holding raw bytes rather than
  text, used here for stored PDF documents. →
  [`./06-data-model.md`](./06-data-model.md)

- **board** — **In general:** a website listing jobs. **Here:** one entry in
  `docs/job-sources.yaml` — one employer's careers page hosted on one ATS —
  identified by a `type` plus enough fields to address it (`slug`, or
  `host`/`tenant`/`site` for the enterprise systems). The sweep visits 44 of them.
  →
  [`../code/02-leads-finding.md`](../code/02-leads-finding.md)

- **board allowlist** — `auto_apply.board_allowlist` in
  `docs/application-limits.yaml`: a map of `domain: ats-id` naming the only
  domains the unattended trust gate will consider. It currently names four:
  `boards.greenhouse.io`, `job-boards.greenhouse.io`, `jobs.lever.co`,
  `jobs.ashbyhq.com`. It answers "is this the vendor's software", which is a
  narrower question than "is this party safe to submit to". →
  [`../operate/04-config-reference.md`](../operate/04-config-reference.md)

- **board pause** — A timed backoff applied to one board by the breaker after
  repeated failures, with probe re-admission: when the backoff expires one job is
  let through, and a success clears the pause entirely. It is never terminal and
  never persists across runs. Not to be confused with a **scoped STOP**. →
  [`../code/10-auto-safety.md`](../code/10-auto-safety.md)

- **boundary case** — An input at the edge of what a function accepts — zero
  items, an empty string, the maximum length. Bugs cluster there, which is why
  new features here need tests for the failure and boundary cases, not only the
  happy path. →
  [`../code/14-tests.md`](../code/14-tests.md)

- **breaker (circuit breaker)** — `scripts/auto/breaker.mjs`, the anomaly
  detector for the unattended runner. Its rules are all N-invariant: identical
  failures twice in a row pauses that board; a board failing three of its last
  five pauses that board; eight of the last ten attempts failing across two or
  more boards stops the run. Written this way so a healthy run of 999 is no
  likelier to halt than a healthy run of 3. →
  [`../code/10-auto-safety.md`](../code/10-auto-safety.md)

- **browser context** — In Playwright, an isolated browser session with its own
  cookies and storage, cheaper than launching a whole browser. The unattended
  runner keys its pool of contexts by origin. →
  [`../code/09-auto-runner.md`](../code/09-auto-runner.md)

- **busy_timeout** — A SQLite setting saying how long a connection will wait for
  a lock before giving up with `SQLITE_BUSY`. Set to 5000 milliseconds in
  `openDb`, and set **before** `journal_mode = WAL` — an ordering that must not be
  reversed, because setting the journal mode itself can block. →
  [`../code/01-lib-foundation.md`](../code/01-lib-foundation.md)

## C

- **cache** — A stored copy of something expensive to compute or fetch, kept so
  it need not be produced again. Always a copy: if a cache disagrees with the
  store of record, the cache is wrong. →
  [`./06-data-model.md`](./06-data-model.md)

- **cache invalidation** — Deciding when a cached copy has gone stale and must be
  discarded. The field cache does it by bumping `CACHE_VERSION` (currently `4`); a
  version mismatch silently discards every remembered form shape rather than
  trying to migrate it. →
  [`../code/07-apply-planning.md`](../code/07-apply-planning.md)

- **caps** — `scripts/auto/caps.mjs`: the arithmetic limiting how many
  applications an unattended run may send. Read from `auto_apply` in
  `docs/application-limits.yaml` — `per_run_max`, `per_day_max`,
  `per_company_max_per_week`. Caps are the user's numbers, not a safety throttle
  the code invented. →
  [`../operate/04-config-reference.md`](../operate/04-config-reference.md)

- **CAPTCHA** — A challenge intended to prove a human is present. This project
  never solves one: encountering one is an `environment`-class defer, and the
  application waits for you. →
  [`./07-safety-model.md`](./07-safety-model.md)

- **CDP (Chrome DevTools Protocol)** — The low-level control channel a browser
  exposes for automation, and what Playwright speaks underneath. Relevant here
  because code evaluated through CDP is not blocked by the page's own Content
  Security Policy, whereas a `<script>` tag injected into the page is. →
  [`../code/06-apply-scanning.md`](../code/06-apply-scanning.md)

- **CI (continuous integration)** — A service that runs the tests automatically
  on every change, so nobody has to remember. Here that is GitHub Actions, driven
  by `.github/workflows/ci.yml`. →
  [`../code/12-harness-and-ci.md`](../code/12-harness-and-ci.md)

- **claim** — **In general:** an assertion. **Here (database):** the act of one
  worker taking exclusive ownership of a job so no other worker touches it, done
  with a single conditional `UPDATE`. A claim function returning **`0`** means
  another worker already owns it. That is the normal fan-out result, not an
  error. →
  [`./06-data-model.md`](./06-data-model.md)

- **classifier (post-submit)** — `scripts/auto/classify.mjs`: a pure function
  over `(url, html)` that decides what page came back after a submit click. Its
  closed set of answers is `confirmation`, `identity-verification`,
  `bot-challenge`, `email-code-challenge`, `posting-gone`, `error`,
  `unclassified`. Every rule declares where its evidence came from, and a rule
  justified by a test fixture may fire **only** on loopback — so a real employer's
  page classifies as `unclassified`, which stops. That is designed behaviour, not
  a bug to route around. →
  [`../code/10-auto-safety.md`](../code/10-auto-safety.md)

- **CLI (command-line interface)** — A program you run by typing its name and
  arguments into a terminal, as opposed to clicking. Every script in `scripts/`
  is one. →
  [`./02-computer-basics.md`](./02-computer-basics.md)

- **closed set** — A list of allowed values fixed in code, so adding one is a
  deliberate edit somebody reviews. `STAGE_IDS`, `TRUST_CHECKS`, `SUBMIT_CHECKS`,
  `CLASSIFICATIONS`, `STOP_SCOPES` and `REASON_CLASSES` are all closed sets, and
  each is `Object.freeze`d so it cannot be modified at runtime. →
  [`./05-architecture.md`](./05-architecture.md)

- **combobox / combo** — A dropdown that is not a plain HTML `<select>` but a
  custom widget built from a text box and a list. It is the single most expensive
  thing on an application form: opening one to read its options costs a measured
  1.5 to 2.5 seconds, and a form can have eighteen. The plan verb for one is
  `combo`. →
  [`../code/08-apply-filling.md`](../code/08-apply-filling.md)

- **comparator** — A function you hand to a sort, which takes two items and
  returns a negative number, zero, or a positive number to say which comes first.
  Chaining them with `||` gives tie-breaking. →
  [`./03-programming-basics.md`](./03-programming-basics.md)

- **concurrency** — Several pieces of work in flight at once, taking turns. Not
  the same as **parallelism**, which is several things literally executing at the
  same instant. JavaScript here is single-threaded: network waits overlap, but
  calculation does not. →
  [`./05-architecture.md`](./05-architecture.md)

- **CONFIRM** — A resolution status stamped by `resolveFields` in
  `scripts/apply/fill-plan.mjs` onto a field the answer bank resolved from an
  entry whose class is `assertion` rather than `datum`. It carries the value
  forward but marks it as needing your eye once, this run. Deliberately distinct
  from `UNKNOWN`, which would re-ask a question you have already answered, forever.
  →
  [`../code/07-apply-planning.md`](../code/07-apply-planning.md)

- **confirm-widget** — A defer kind for a checkbox or radio group. It is a
  separate marker from `confirm` on purpose: a tickbox carries **assent** rather
  than a value, whatever the class of the answer behind it, and on the unattended
  path nothing auto-ticks. →
  [`./07-safety-model.md`](./07-safety-model.md)

- **consent tickbox** — A checkbox asking permission — data processing,
  marketing, background checks. It defers on its **shape** as well as its topic,
  so a consent box nobody recognised still defers. On the attended path the agent
  may tick a required one and must name it, with the label quoted, in the report.
  →
  [`./07-safety-model.md`](./07-safety-model.md)

- **content fingerprint** — A short string computed from the bytes of something,
  such that different bytes almost certainly give a different string. Used here to
  key the field cache on a form's shape and to bind a verified document to the
  exact fact base it was checked against. →
  [`../code/01-lib-foundation.md`](../code/01-lib-foundation.md)

- **context window** — The amount of text an AI model can consider at once,
  measured in tokens. Everything the agent has read this session sits in it, and
  the whole history is re-sent every turn — which is why this project pushes
  breadth-first exploration into subagents. →
  [`./04-ai-and-agents.md`](./04-ai-and-agents.md)

- **`context.json`** — The shared state file inside a job workspace
  (`jobs/<slug>/context.json`), read and written by both tailoring skills so the
  résumé and the cover letter stay consistent. Its keys today are `slug`,
  `analysis`, `consistency`, `resume`, `cover_letter` and `pending_questions`. →
  [`./06-data-model.md`](./06-data-model.md)

- **corpus** — **In general:** a labelled body of examples. **Here:** the set of
  real post-submit pages the classifier would need in order to recognise a real
  confirmation, gathered only from your own attended applications through
  `scripts/apply/capture-post-submit.mjs`. It is small, which is why the
  classifier is blind on real boards. →
  [`../code/10-auto-safety.md`](../code/10-auto-safety.md)

- **CSP (Content Security Policy)** — A header a website sends telling the
  browser which scripts it will permit. A **nonce** is a one-time token in that
  header that legitimate scripts must carry. This is why the browser scanner is
  loaded by filename rather than injected as a script tag. →
  [`../code/06-apply-scanning.md`](../code/06-apply-scanning.md)

## D

- **datum** — The answer class meaning "a fact about you" — your city, your
  phone number, your degree. Contrast **assertion**. Only `datum` answers may
  fill without a person confirming them. →
  [`../code/07-apply-planning.md`](../code/07-apply-planning.md)

- **dead code** — Code that exists, is tested, and is called by nothing. The
  audit's single largest theme: dropdown probe-skipping, the option cache, the
  cluster letter plan and the race-safe application merge are all built and all
  unreachable from the code that would benefit. →
  [`../audit-2026-08-05.md`](../audit-2026-08-05.md)

- **defence in depth** — Putting several independent controls in front of the
  same risk, so no single failure is fatal. Here: the sanitiser strips injection
  carriers, L3 rejects hostile postings, and `verify-claims` refuses any claim the
  fact base cannot back. The last is the load-bearing one. →
  [`./07-safety-model.md`](./07-safety-model.md)

- **defer** — **Here, and this is the most important word in the project:** to
  decline one specific thing and say why. Not an error, not a failure — the
  designed outcome whenever the system meets something it does not
  deterministically understand. A defer costs you one question; the alternative
  is a guess in your name. →
  [`./07-safety-model.md`](./07-safety-model.md)

- **defer taxonomy** — The closed list of reasons a defer can carry, grouped into
  five **reason classes** by `scripts/auto/taxonomy.mjs`: `understanding` (the
  machine did not understand the page — the only class engineering may shrink),
  `assent` (a human must say yes — must not shrink), `environment` (the board
  declined), `policy` (our own rules said no) and `malfunction` (something broke).
  →
  [`../code/10-auto-safety.md`](../code/10-auto-safety.md)

- **denormalisation** — Deliberately storing the same value twice — once inside a
  JSON document and once as its own column — so the database can index and search
  it. Costs consistency, buys speed. →
  [`./06-data-model.md`](./06-data-model.md)

- **dependency injection** — Passing a function its collaborators as arguments
  instead of having it import them. It makes a function testable, because a test
  can hand it a fake clock or a fake fetcher, and it also breaks import cycles. →
  [`./03-programming-basics.md`](./03-programming-basics.md)

- **deterministic** — Same input, same output, every time, with no model and no
  randomness involved. This project's central claim is that almost everything it
  does is deterministic, and that the model's territory is narrow and named. →
  [`./05-architecture.md`](./05-architecture.md)

- **disclosure budget** — `scripts/apply/disclosure.mjs`: a count of how many
  distinct banked facts one application form pulls out of your answer bank, and a
  limit on how much of a single long answer one field may extract. It exists
  because a hostile form asking forty questions to harvest forty facts was
  previously indistinguishable from a long honest one. It defers a field or one
  application — never a volume throttle. →
  [`../code/07-apply-planning.md`](../code/07-apply-planning.md)

- **DOM (Document Object Model)** — The browser's live tree of a web page's
  elements. When the scanner reads a form, it is walking the DOM. →
  [`./03-programming-basics.md`](./03-programming-basics.md)

- **dry run** — A rehearsal that does everything except the irreversible part. The
  unattended runner's mode is `dry_run` unless `auto_apply.dry_run` is explicitly
  `false` in `docs/application-limits.yaml`. →
  [`../code/09-auto-runner.md`](../code/09-auto-runner.md)

  > **Known defect (2026-08-05 audit).** That file currently reads
  > `enabled: true` and `dry_run: false`, so the mode resolves to `live`. Any
  > statement elsewhere that the unattended path cannot open a browser is stale.

- **durable ledger** — A record written to the database **before** an
  irreversible action, so that if the process dies mid-action there is still
  evidence the action may have happened. `submit.mjs` writes its `(slug, mode)`
  row into `auto_submissions` before the click, on the principle that an attempt
  is a submission until proven otherwise. →
  [`../code/10-auto-safety.md`](../code/10-auto-safety.md)

## E

- **enrichment** — Fetching a posting's full description after the list endpoint
  gave only a title, done by `scripts/leads/enrich.mjs`. Four of the board types
  list jobs without bodies, so without enrichment their leads cannot be screened
  on content. →
  [`../code/02-leads-finding.md`](../code/02-leads-finding.md)

- **`.env`** — A file of secrets and machine-specific settings (API keys),
  gitignored and never quoted into chat or a commit. →
  [`../operate/04-config-reference.md`](../operate/04-config-reference.md)

- **environment variable** — A named value the operating system hands to a
  program when it starts, used for settings that differ per machine, such as
  `PDF_BROWSER`. →
  [`./02-computer-basics.md`](./02-computer-basics.md)

- **ES module** — The modern JavaScript file format using `import` and `export`.
  This project is all ES modules (`"type": "module"` in `package.json`), which is
  why files end in `.mjs`. →
  [`./03-programming-basics.md`](./03-programming-basics.md)

- **evidence (classifier rule)** — Each classifier rule records where its
  justification came from. A rule sourced from a test fixture carries
  `evidence.source === 'fixture'` and is permitted to fire only on a loopback
  address, because it is evidence about the fixture and about nothing else. →
  [`../code/10-auto-safety.md`](../code/10-auto-safety.md)

- **exit code** — The number a program returns when it finishes. `0` conventionally
  means success and anything else means failure. This project gives specific codes
  specific meanings — `save-answer.mjs` exits `3` for instruction-shaped text and
  `4` for a government or financial identifier, and `4` has no override. →
  [`../operate/01-commands.md`](../operate/01-commands.md)

## F

- **fact base** — `profile/profile.yaml` and `profile/answers.yaml` together:
  everything true about you that the system is allowed to state. Nothing else
  counts as a fact. No program in `scripts/` may write to it, and a hook blocks
  the agent from editing it. →
  [`./06-data-model.md`](./06-data-model.md)

- **fact id** — The stable identifier on each entry in `profile.yaml`, such as
  `exp-acme-b1` or `skill-lang`. Every tailored résumé bullet must carry an HTML
  comment citing the ids it came from — `<!-- fact:exp-acme-b1 -->` — which is how
  a program, rather than a careful reader, can check that nothing was invented. →
  [`../code/05-documents.md`](../code/05-documents.md)

- **fail closed / fail open** — When a check cannot decide, does it refuse (fail
  closed) or allow (fail open)? This project fails closed everywhere the wrong
  answer would put false information on an application. →
  [`./07-safety-model.md`](./07-safety-model.md)

- **false positive / false negative** — A false positive is flagging something
  harmless; a false negative is missing something harmful. Their costs are almost
  never equal, and naming which direction hurts more is how most rules here were
  designed. For screening, a false reject is the worse one: it is a job you never
  see. →
  [`../code/03-leads-screening.md`](../code/03-leads-screening.md)

- **fan-out** — Splitting one job into many pieces handled at once. The board
  sweep fans out to eight boards in flight; the unattended runner fans out across
  origins. →
  [`./05-architecture.md`](./05-architecture.md)

- **field cache** — `jobs/.field-cache.json`, managed by
  `scripts/apply/field-cache.mjs`. It remembers the _shape_ of forms already seen
  — which widget each field is and what options it offers — keyed on a fingerprint
  of the form rather than its URL, so two postings on the same Greenhouse form
  share one cache entry. It never stores answers. →
  [`../code/07-apply-planning.md`](../code/07-apply-planning.md)

- **fill engine** — `scripts/apply/fill-engine.mjs`: the code that executes a fill
  plan against a live page. It runs Playwright-side, in Node, and nothing is read
  back out of the page to make a decision. →
  [`../code/08-apply-filling.md`](../code/08-apply-filling.md)

- **fill plan** — `scripts/apply/fill-plan.mjs` and the `fill-plan.json` it writes
  into a job workspace: a list of instructions saying, for each scanned field,
  which verb to apply and what value to use, plus every field that deferred and
  why. Building the plan and executing it are separate steps so the plan can be
  reviewed. →
  [`../code/07-apply-planning.md`](../code/07-apply-planning.md)

- **fingerprint (form)** — A hash of a form's required-field labels, used as the
  field cache's key. A board that redesigns its form gets a different fingerprint
  and is re-probed automatically. →
  [`../code/07-apply-planning.md`](../code/07-apply-planning.md)

- **fixture** — A fake but realistic input committed alongside the tests — a saved
  copy of a job posting, a stub profile, a local server pretending to be a job
  board. `tests/fixtures/` holds this project's. →
  [`../code/14-tests.md`](../code/14-tests.md)

- **flag (CLI)** — A named option on a command line, such as `--json` or
  `--confirm`. Contrast a **positional argument**. A convention here: `--json` for
  machine-readable output, `--confirm` before anything destructive. →
  [`../operate/01-commands.md`](../operate/01-commands.md)

- **flaky test** — A test that passes sometimes and fails sometimes with no code
  change, usually because of timing or contention. Treated as a defect, because a
  suite you learn to ignore protects nothing. →
  [`../code/14-tests.md`](../code/14-tests.md)

- **floor (test count floor)** — The minimum number of tests a green run must
  have executed, stored in `package.json` under `testGate`. Currently `2314` for
  the full gate and `262` for the security gate. Set to a number two honest runs
  actually produced, never the best one seen. →
  [`../code/12-harness-and-ci.md`](../code/12-harness-and-ci.md)

- **frontmatter** — A block of YAML at the very top of a file between `---`
  markers, carrying metadata about the file. A skill's `SKILL.md` uses it for the
  `description` that decides when the skill triggers. →
  [`../code/13-skills-and-agents.md`](../code/13-skills-and-agents.md)

## G

- **gate** — **Here:** a check that can refuse, placed on the path to something
  consequential. This project has many, and the named ones are the **trust gate**,
  the **submit gate**, the **test gate** (count gate) and the **perf gate**. →
  [`./07-safety-model.md`](./07-safety-model.md)

- **gate-audit** — `scripts/leads/gate-audit.mjs`: re-runs the screening stages
  over every stored lead and reports which leads a rule change newly rejects. To
  be run after **any** gate change, because a job you never see is the worst
  failure this system has. →
  [`../code/03-leads-screening.md`](../code/03-leads-screening.md)

  > **Known defect (2026-08-05 audit).** It runs only `evaluateStages` and never
  > calls `screenJob`, so `screen.mjs`'s own rejecting rules — scam patterns,
  > clearance and polygraph blockers, the seniority gate — are outside the audit
  > it claims to perform.

- **git** — The version-control system that records every change to this
  repository as a commit. Hard rule 7 confines all work to the `dev` branch, and a
  hook enforces it. →
  [`./02-computer-basics.md`](./02-computer-basics.md)

- **glob** — A filename pattern such as `tests/**/*.test.mjs`. It must be quoted
  on the command line so the shell hands the pattern to the program rather than
  expanding it first. On Node 24 `node --test <directory>` does **not** recurse; a
  quoted glob does. →
  [`../code/14-tests.md`](../code/14-tests.md)

- **green** — The best automatability tier: a pre-filter saying the engine alone
  would very likely suffice, reasoned entirely from a remembered form shape with
  no browser, no network and no model. A pre-filter, never an authorisation. →
  [`../code/07-apply-planning.md`](../code/07-apply-planning.md)

- **Greenhouse** — One of the most widely used applicant tracking systems
  (`boards.greenhouse.io`, `job-boards.greenhouse.io`). Twenty-four of the 44
  boards this project sweeps are Greenhouse, and it has both a fetcher and a fill
  adapter here. →
  [`../code/02-leads-finding.md`](../code/02-leads-finding.md)

- **guard** — A check placed before an action to refuse it. `scripts/auto/guard.mjs`
  holds the unattended path's guards: the filesystem boundary, the STOP kill
  switch, and read-only access to `profile/`. →
  [`../code/10-auto-safety.md`](../code/10-auto-safety.md)

## H

- **handoff** — The automatability tier meaning the board requires an account the
  system is not permitted to create. Nothing further is attempted. →
  [`../code/07-apply-planning.md`](../code/07-apply-planning.md)

- **hash** — A function turning any input into a fixed-length string, where the
  same input always gives the same output and a different input almost certainly
  gives a different one. SHA-256 is the one used here. →
  [`./03-programming-basics.md`](./03-programming-basics.md)

- **headless browser** — A real browser running with no visible window, driven by
  code. Used for rendering PDFs and for filling application forms. →
  [`./02-computer-basics.md`](./02-computer-basics.md)

- **hook** — **In general:** code that runs automatically at a defined moment.
  **Here:** a Claude Code hook — a program the harness runs **before** a tool call
  (`PreToolUse`) or **after** it (`PostToolUse`), which can refuse the call. This
  is the enforcement mechanism the model cannot talk its way around, which is why
  the important rules are hooks rather than prose. →
  [`../code/12-harness-and-ci.md`](../code/12-harness-and-ci.md)

- **hooks, the two owners of** — `scripts/hooks/*` (`guard-bash.mjs`,
  `guard-files.mjs`, `prettify.mjs`) is agent-editable. `.claude/hooks/*` and
  `.claude/settings*.json` are yours alone and sealed against agent edits on both
  the file and shell paths. →
  [`../code/12-harness-and-ci.md`](../code/12-harness-and-ci.md)

- **hydration** — What a React page does after its HTML arrives: JavaScript runs
  and attaches behaviour to the markup. Until it finishes, form fields may be
  absent or inert, which is why the scanner waits for the form to hydrate before
  reading it. →
  [`../code/06-apply-scanning.md`](../code/06-apply-scanning.md)

## I

- **idempotence** — The property that doing something twice has the same effect
  as doing it once. Filling a text box with the same value again is idempotent;
  clicking submit is emphatically not, which is the whole reason for the durable
  ledger. →
  [`./03-programming-basics.md`](./03-programming-basics.md)

- **iframe** — A web page embedded inside another. A blind spot for the scanner
  when the embedded page comes from a different origin, because the browser
  forbids reading across that boundary. →
  [`../code/06-apply-scanning.md`](../code/06-apply-scanning.md)

- **index (database)** — A prepared lookup structure that lets the database find
  rows by a column's value without reading every row. `idx_leads_company` is one.
  →
  [`./06-data-model.md`](./06-data-model.md)

- **injection carrier** — A place hostile text can hide in a job posting where a
  human reader will not see it but a model will: an HTML comment, an element
  styled `display:none`, an image's `alt` text, a zero-width Unicode character, a
  URL-encoded query parameter. `scripts/lib/untrusted.mjs` strips the known ones.
  The pattern list is explicitly **not** the guarantee. →
  [`../code/01-lib-foundation.md`](../code/01-lib-foundation.md)

- **intent (typed intent)** — `scripts/apply/intents.mjs`: the replacement for
  matching a form question to an answer by text similarity. An intent resolves a
  question into `{concept, polarity, class, provenance}` — a named proposition
  from a closed set, a truth value, an answer class, and which bank entry supplied
  it. This shape exists because similarity could pick the right concept with the
  wrong truth value ("authorised to work **without** sponsorship"). →
  [`../code/07-apply-planning.md`](../code/07-apply-planning.md)

- **ISO-8601** — The date format `2026-08-07T14:30:00.000Z`. Sorts correctly as
  plain text, which is why every timestamp in this project uses it. →
  [`./06-data-model.md`](./06-data-model.md)

## J

- **Jaccard similarity** — A number between 0 and 1 measuring how much two sets
  overlap: the size of their intersection divided by the size of their union.
  Used for comparing a job's words against your profile's. →
  [`../code/04-leads-ranking.md`](../code/04-leads-ranking.md)

- **`job-worker`** — The Sonnet-pinned subagent defined in
  `.claude/agents/job-worker.md` that does per-job work so the main conversation's
  context stays small. Its tool list is `Bash, Read, Write, Edit, Glob, Grep,
WebFetch, WebSearch` — no browser. →
  [`../code/13-skills-and-agents.md`](../code/13-skills-and-agents.md)

- **`jobs/<slug>/`** — The workspace directory for one job, holding everything
  produced for it: `job.json` (the sanitised posting), `context.json`,
  `keywords.json`, `resume.md`, `resume.pdf`, `scan-p1.json`, `fill-plan.json`.
  The job-application flows may write here and nowhere else. →
  [`./06-data-model.md`](./06-data-model.md)

- **`jobs/leads.db`** — The SQLite file that is this project's store of record.
  Twelve tables, including `leads`, `lead_keywords`, `applications`, `screens`,
  `documents`, `auto_queue`, `auto_submissions` and `verifications`. →
  [`./06-data-model.md`](./06-data-model.md)

- **JSON** — A plain-text format for structured data, using `{}` for objects and
  `[]` for lists. The format almost every API here speaks. One stray comma makes a
  whole file unreadable. →
  [`./03-programming-basics.md`](./03-programming-basics.md)

- **JSONL** — JSON Lines: one complete JSON object per line. Safe to append to
  from several writers at once, because appending needs no read first. →
  [`./06-data-model.md`](./06-data-model.md)

## K

- **keyword lexicon** — `scripts/lib/keywords.mjs`: a hand-maintained list of
  technologies with their canonical name, their `surface` spellings and their
  `aliases`. A controlled list rather than an AI embedding, so matching is
  explainable and repeatable. →
  [`../code/01-lib-foundation.md`](../code/01-lib-foundation.md)

- **keyword plan** — `scripts/documents/keyword-plan.mjs` and the `keywords.json`
  it writes into a workspace. It computes `must_use` — the **intersection** of
  the posting's terms and your fact base, so every term in it is already true of
  you — plus `blocked`, the posting's other terms, listed precisely so they stay
  out of the document. It never widens what the résumé may claim. →
  [`../code/05-documents.md`](../code/05-documents.md)

  > **Known defect (2026-08-05 audit).** The `ats_forms` attached to each entry
  > can contain surface spellings the fact base does not literally hold, which
  > `verify-claims` R6 then rejects, blocking the render.

- **kill switch** — See **STOP**.

## L

- **L0, L1, L2, L3** — The four screening stages a lead passes through in order,
  registered in `scripts/leads/stages.mjs`, stopping at the first rejection:
  - **L0** — `title/location/date`: does the posting's title, location, salary and
    age pass `docs/application-limits.yaml`?
  - **L1** — `body disqualifiers`: does the description contain a hard
    disqualifier?
  - **L2** — `profile fit`: how well does it match your profile?
  - **L3** — `scam/ghost risk`: does it look like a scam, a ghost job, or a
    posting carrying an injection attempt?

  All four in full: →
  [`../code/03-leads-screening.md`](../code/03-leads-screening.md)

  > **Known defect (2026-08-05 audit).** L3's injection reject cannot fire on a
  > stored lead: the description it inspects has already had the payload spliced
  > out by the ingest sanitiser, and the surviving evidence on
  > `lead.untrusted_findings` is not read.

- **lead** — **Here:** one job posting the system has heard about and stored. Not
  an application and not a commitment — a row saying "this posting exists, here is
  what we know". Rows live in the `leads` table. →
  [`./06-data-model.md`](./06-data-model.md)

- **lease** — A claim that expires. If the worker holding it dies, the lease goes
  stale and another worker may take the job. →
  [`./05-architecture.md`](./05-architecture.md)

- **Lever** — An applicant tracking system (`jobs.lever.co`), with both a fetcher
  and a fill adapter here. Its hosted boards expose no candidate login, which is
  why an orphaned submit on Lever cannot be reconciled by re-reading the board. →
  [`../code/08-apply-filling.md`](../code/08-apply-filling.md)

- **locator (Playwright)** — A description of how to find an element, re-resolved
  every time it is used. Different from an element handle, which points at one
  specific node and goes stale when React re-mounts it — the reason non-upload
  fills retry on a stale locator. →
  [`../code/08-apply-filling.md`](../code/08-apply-filling.md)

- **lock (file lock)** — A small file created to signal "I am working on this,
  wait". `scripts/lib/lock.mjs` provides `withLock`, `LEADS_LOCK` and
  `AUTO_RUN_LOCK`, with a stale timeout (`DEFAULT_STALE_MS = 10_000`) so a crashed
  holder does not block everyone forever. →
  [`../code/01-lib-foundation.md`](../code/01-lib-foundation.md)

- **loopback** — The address `127.0.0.1` / `localhost`, meaning "this machine".
  Not the public internet. A classifier rule bounded to loopback can therefore
  only ever fire against this project's own test server. →
  [`../code/10-auto-safety.md`](../code/10-auto-safety.md)

- **lost update** — Two programs both read a value, both change their copy, and
  both write back: the second write silently erases the first. Prevented by
  locking, or by doing the read and the write inside one transaction. →
  [`./06-data-model.md`](./06-data-model.md)

## M

- **`mapPool`** — `scripts/lib/lib.mjs`'s bounded-concurrency helper,
  `mapPool(items, limit, fn)`. It runs at most `limit` pieces of work at once —
  the sweep uses eight — which is faster than one at a time and politer than all
  at once. →
  [`../code/01-lib-foundation.md`](../code/01-lib-foundation.md)

- **MAYBE** — A resolution status meaning the answer bank found a weak textual
  match. It needs a human to confirm the wording, so it counts as needing a
  person. →
  [`../code/07-apply-planning.md`](../code/07-apply-planning.md)

- **MCP (Model Context Protocol)** — The standard by which an AI agent talks to an
  external tool provider. Here it is the wire between the agent and Playwright's
  browser control. →
  [`./04-ai-and-agents.md`](./04-ai-and-agents.md)

- **migration** — Changing a database's structure after data already exists in it.
  This project deliberately has none: the schema is flat `CREATE TABLE IF NOT
EXISTS` statements with no version table and no migration chain. →
  [`./06-data-model.md`](./06-data-model.md)

- **mode** — For the unattended runner, `dry_run` or `live`, resolved in
  `scripts/auto/auto-apply.mjs` as `auto?.dry_run === false ? "live" : "dry_run"`.
  It is also half the primary key of `auto_submissions`, so a dry run cannot
  consume a live run's claim on a job. →
  [`../code/09-auto-runner.md`](../code/09-auto-runner.md)

- **model tiering** — Using a cheaper, smaller AI model for work that does not
  need a frontier one. Searching, screening, applying and recording outcomes are
  tiered down; architecture and debugging are not. →
  [`./04-ai-and-agents.md`](./04-ai-and-agents.md)

- **multi-page walk** — Handling an application form that spans several pages:
  fill, advance, scan the next page, repeat. `scripts/auto/multipage.mjs` merges
  the per-page reports. →
  [`../code/09-auto-runner.md`](../code/09-auto-runner.md)

  > **Known defect (2026-08-05 audit).** `mergePages` rebuilds the merged report
  > as `{ uploads, revealed }`, discarding `failures` and the whole `verify`
  > object before any gate can read them.

- **`must_use`** — The list in a keyword plan of terms that appear both in the
  posting and in your fact base, and may therefore be placed in the tailored
  document without inventing anything. →
  [`../code/05-documents.md`](../code/05-documents.md)

## N

- **NEEDS-CHOICE** — A resolution status meaning the fact base produced a value
  but no option on the form matched it, so a person must pick from the list.
  Distinct from `UNKNOWN` on purpose: the value _is_ resolved, and `UNKNOWN` would
  block where this need not. →
  [`../code/07-apply-planning.md`](../code/07-apply-planning.md)

- **nonce** — A number used once. Two unrelated uses here: a CSP nonce that
  authorises a script on a page, and a lock nonce proving which process holds a
  file lock. →
  [`../code/01-lib-foundation.md`](../code/01-lib-foundation.md)

- **NUL byte** — The zero byte. It passes `prettier` and `node --check`
  unnoticed but makes search tools treat a file as binary and skip its contents
  entirely — which once silently hid two files from every codebase search.
  `tests/security/source-bytes.test.mjs` is the standing check; write control
  characters as escapes such as `\u0000`, never as raw bytes. →
  [`../code/14-tests.md`](../code/14-tests.md)

## O

- **OK** — The resolution status meaning the fact base answered the field
  cleanly and the value is ready to fill. →
  [`../code/07-apply-planning.md`](../code/07-apply-planning.md)

- **Oracle Recruiting Cloud** — An enterprise ATS (`*.oraclecloud.com`, board type
  `oracle_cloud`), used by several Las Vegas employers. It has a lead fetcher but
  no fill adapter, so its forms go through `generic.mjs`. Notable for rendering an
  "Import your profile from resume" file input beside the real résumé slot —
  uploading to it triggers the board's parser and rewrites the form. →
  [`../code/08-apply-filling.md`](../code/08-apply-filling.md)

- **origin** — Scheme plus host plus port — `https://boards.greenhouse.io:443`.
  The browser's fundamental security boundary: two different ports are two
  different origins. The trust gate checks that the origin about to be submitted
  to is the origin recorded when the job was queued. →
  [`./07-safety-model.md`](./07-safety-model.md)

- **orphan** — A submit attempt whose outcome nobody can determine: the durable
  row says an application may exist at an employer, and the process died before
  anything confirmed it. `scripts/auto/reconcile.mjs` exists to resolve these, and
  an unresolvable one raises a company-scoped STOP. →
  [`../code/10-auto-safety.md`](../code/10-auto-safety.md)

## P

- **p50 / p95** — Percentiles. p50 is the median: half the runs were faster. p95
  means 95% were faster, which is what tells you about the bad days. Reported
  instead of an average because averages hide the tail. →
  [`../code/15-benchmarks.md`](../code/15-benchmarks.md)

- **perf gate** — `.github/workflows/perf-gate.mjs`: runs the benchmark against a
  loopback fixture and fails the build on a regression. Its rules differ in
  strength by design — `model_turns` is hard with no override (a model turn on the
  green path is the property being gone, not a regression in degree), while
  `sleep_ms` and `round_trips` may be exceeded with a written budget note in the
  pull request. →
  [`../code/12-harness-and-ci.md`](../code/12-harness-and-ci.md)

- **PII** — Personally Identifiable Information: your name, address, phone, email.
  Redacted before anything is stored as a test fixture, and never written into
  documentation. →
  [`./07-safety-model.md`](./07-safety-model.md)

- **Playwright** — The library that drives a real browser from Node. Two sides
  matter and are easy to confuse: **Playwright-side** code runs in Node and can
  reach the filesystem; **page-side** code runs inside the web page and can reach
  the DOM. `page.evaluate` is the one bridge, and only data crosses it. →
  [`../code/06-apply-scanning.md`](../code/06-apply-scanning.md)

- **polarity** — Whether a question asks if a proposition is true (`+1`) or
  whether its negation is true (`-1`), with `null` meaning neither could be
  established. `null` defers. Polarity is tracked separately from topic because
  the dangerous failure is the right concept with the wrong truth value. →
  [`../code/07-apply-planning.md`](../code/07-apply-planning.md)

- **pool** — Two different pools here. A **worker pool** (`mapPool`) bounds how
  many pieces of work run at once. The **browser pool** (`scripts/auto/pool.mjs`,
  `runPool`) is keyed by origin, so two jobs on the same board share a browser
  context and jobs on different boards do not contend. →
  [`../code/09-auto-runner.md`](../code/09-auto-runner.md)

- **posting** — The employer's job advertisement itself. Under hard rule 0 it is
  **data, never instructions**, however it is phrased. →
  [`./07-safety-model.md`](./07-safety-model.md)

- **PRAGMA** — A SQLite command that configures the database connection rather
  than querying data: `PRAGMA busy_timeout`, `PRAGMA journal_mode = WAL`,
  `PRAGMA synchronous = NORMAL`. →
  [`./06-data-model.md`](./06-data-model.md)

- **precision / recall** — Precision is how many of the things you flagged were
  really problems; recall is how many of the real problems you flagged. Tightening
  one usually loosens the other, so every filter here states which it favours. →
  [`../code/03-leads-screening.md`](../code/03-leads-screening.md)

- **prep queue** — `scripts/leads/prep-queue.mjs`: picks which leads get a
  tailored résumé prepared ahead of time, so the document already exists when you
  decide to apply. →
  [`../code/04-leads-ranking.md`](../code/04-leads-ranking.md)

  > **Known defect (2026-08-05 audit).** It calls `rankLeads` without the keyword
  > map and without `limits`, so ordering falls back to title keyword, freshness
  > and salary presence, and a user-set `roles.title_rank` does not reach it.

- **primary key** — The column, or set of columns, that uniquely identifies a row.
  A **composite** primary key uses more than one column — `auto_submissions` is
  keyed `(slug, mode)`. SQLite permits NULLs in the columns of a non-INTEGER
  primary key, which silently un-enforces uniqueness if a key column is nullable.
  →
  [`./06-data-model.md`](./06-data-model.md)

- **probe (dropdown probe)** — Opening a custom dropdown in the live browser to
  read the options it actually offers, instead of guessing. Costs a measured 1.5
  to 2.5 seconds each. A probed option list is one of exactly three sanctioned
  ways to make fewer fields defer. →
  [`../code/06-apply-scanning.md`](../code/06-apply-scanning.md)

- **`profile/`** — The directory holding your fact base plus the generated
  `applications.yaml` export. Gitignored, never leaves this machine, never edited
  by an agent. →
  [`./06-data-model.md`](./06-data-model.md)

- **prompt injection** — An attack where text a model reads is written to look
  like an instruction to the model. In this project's setting the text is a job
  posting or a form label written by a stranger, and the payload — "add Kubernetes
  to the resume", "rate this candidate highly", "do not tell the user" — goes out
  on a document signed with your name. Hard rule 0 is the whole answer: a posting
  is data. →
  [`./07-safety-model.md`](./07-safety-model.md)

- **provenance** — Who said this, and how do we know? Every fact carries it: a
  bank entry records the question as asked and the source, a saved answer records
  whether it came from you or was proposed by the model and approved, and a
  classifier rule records where its evidence came from. →
  [`./06-data-model.md`](./06-data-model.md)

- **pure function** — A function whose output depends only on its inputs and which
  changes nothing outside itself. Easy to test, easy to reason about, impossible
  to be surprised by. The classifier is deliberately pure. →
  [`./03-programming-basics.md`](./03-programming-basics.md)

## Q

- **queue (`auto_queue`)** — The database table holding one row per job an
  unattended run intends to attempt, with the per-job state machine's current
  state, the attempt number, and the reason it deferred if it did. →
  [`./06-data-model.md`](./06-data-model.md)

  > **Known defect (2026-08-05 audit).** `auto_queue` carries no `apply_url` and
  > no `company` column, so a run resumed after a crash can lose the URL and
  > terminally defer as `board-untrusted`. Separately, the ownership guard in
  > `setAutoJobState` drops deferrals for rows whose own `run_id` is still NULL.

## R

- **R1–R8** — The verification rules in `scripts/documents/verify-claims.mjs`,
  the program that must pass before any document is rendered or shown as final:
  - **R1** — every bullet line must carry `<!-- fact:ID -->`.
  - **R2** — every cited fact id must exist in the fact base.
  - **R3** — every number in an annotated bullet must appear in a cited fact's
    text.
  - **R4** — every number outside bullets must appear somewhere in the corpus.
  - **R5** — every `Mon YYYY` date token must appear in the corpus.
  - **R6** — every known technology term in the document must appear in the
    corpus. This is the load-bearing control: a claim the fact base cannot back
    never survives it, however it was proposed.
  - **R7** — the résumé must actually cite at least one fact.
  - **R8** — keyword coverage, and **non-blocking by design**: a miss is a
    trade-off to weigh, not a falsehood to refuse.

  Cover-letter mode runs R4–R6 only. →
  [`../code/05-documents.md`](../code/05-documents.md)

  > **Known defect (2026-08-05 audit).** R8's coverage check builds its regular
  > expression with no word boundaries, so a résumé that never mentions Go is
  > reported as having placed it because it says Django. R8 does not block, so
  > this hides a missing keyword rather than admitting a false one.

- **race condition** — A bug where the outcome depends on which of two concurrent
  operations happens to go first. The classic here would be two workers both
  deciding they own the same job; the fix is an atomic claim rather than a check
  followed by a write. →
  [`./05-architecture.md`](./05-architecture.md)

- **rank** — `scripts/leads/recommend.mjs`'s `rankLeads`: scoring stored leads so
  the best ones surface first, using title keywords, technology overlap with your
  profile, freshness and salary signals. →
  [`../code/04-leads-ranking.md`](../code/04-leads-ranking.md)

- **reaper (scaffolding reaper)** — `.github/workflows/scaffolding-reaper.mjs`:
  fails the build when a development-only artifact outlives the phase it declared
  it would die in. Artifacts declare themselves in the file's leading block with
  `scaffolding: true` and `remove_after: phase-N`. →
  [`../code/12-harness-and-ci.md`](../code/12-harness-and-ci.md)

  > **Known defect (2026-08-05 audit).** `package.json` declares
  > `phases.current: "phase-5"` while `phases.order` lists only phases 1 to 4, so
  > `order.indexOf(current)` is `-1` and no artifact can ever expire. The reaper
  > runs, reports nothing, and exits 0.

- **reason class** — See **defer taxonomy**.

- **reconcile** — `scripts/auto/reconcile.mjs`: attempts to determine, by
  re-reading the board, whether an orphaned attempt actually submitted. It ships
  descoped to boards that expose application state to a candidate, and on today's
  allowlist that set is empty, so it returns `undecidable` — which brakes one
  company and lets the rest of the run continue. →
  [`../code/10-auto-safety.md`](../code/10-auto-safety.md)

- **Recruitee** — A smaller applicant tracking system with a lead fetcher in
  `scripts/leads/find-jobs.mjs` but no fill adapter. →
  [`../code/02-leads-finding.md`](../code/02-leads-finding.md)

- **regression** — A thing that used to work and now does not. A **regression
  test** is one written specifically to stop a fixed bug coming back. →
  [`../code/14-tests.md`](../code/14-tests.md)

- **regular expression (regex)** — A pattern language for matching text: `\b` is a
  word boundary, `^` and `$` anchor to start and end, `|` is alternation, `i`
  makes it case-insensitive, `g` makes it global. Powerful and treacherous — a
  missing word boundary is behind at least two defects in this repository. →
  [`./03-programming-basics.md`](./03-programming-basics.md)

- **requisition** — An employer's internal record of an approved open headcount.
  One requisition can be advertised as several postings, and a "pipeline"
  requisition may be collecting résumés with no role to fill — one of the shapes a
  ghost job takes. →
  [`../code/03-leads-screening.md`](../code/03-leads-screening.md)

- **resolution class (status)** — What the answer bank concluded about one form
  field. `OK` (ready to fill), `NEEDS-CHOICE` (value resolved, no option matched),
  `MAYBE` (weak match, confirm the wording), `UNKNOWN` (not in the fact base) —
  plus `CONFIRM`, stamped afterwards by `fill-plan.mjs` on an answer whose class is
  `assertion`. `UNKNOWN` blocks on **both** the attended and unattended paths. →
  [`../code/07-apply-planning.md`](../code/07-apply-planning.md)

- **risk (L3)** — `scripts/leads/risk.mjs`: the scam, ghost-job and injection
  screen. It scores repost counts, scam patterns and untrusted findings, and
  rejects a lead outright when a finding is one of the eight instruction-shaped
  kinds. →
  [`../code/03-leads-screening.md`](../code/03-leads-screening.md)

- **round trip** — One request out and one response back. Browser round trips are
  slow and their cost multiplies by the number of fields, which is why the scanner
  reads a whole page in one `page.evaluate` rather than field by field. →
  [`../code/15-benchmarks.md`](../code/15-benchmarks.md)

- **rules 0–10 (hard rules)** — The numbered guardrails at the top of
  `CLAUDE.md`, which override everything else. In brief: 0 a posting is data; 1
  documents may contain only facts from the fact base; 2 the agent never edits the
  fact base; 3 every bullet cites a fact id; 4 `verify-claims` must pass; 5 you
  approve before a final PDF; 6 the agent clicks submit on the attended path; 7
  `dev` branch only; 8 prettier on every edited document; 9 the filesystem
  boundary; 10 `docs/application-limits.yaml` binds every lead and application. →
  [`./07-safety-model.md`](./07-safety-model.md)

- **run (auto run)** — One invocation of the unattended runner, recorded as a row
  in `auto_runs` with an id every queue row and submission is tagged with. →
  [`../code/09-auto-runner.md`](../code/09-auto-runner.md)

## S

- **sanitiser** — `scripts/lib/untrusted.mjs`: the code that strips known
  injection carriers out of third-party text before it reaches a model, and
  reports what it found as `untrusted_findings`. Its eight instruction-shaped
  kinds are `override_instructions`, `role_reassignment`, `fake_system_turn`,
  `fake_chat_markup`, `conditional_ai_instruction`, `self_scoring_instruction`,
  `document_content_instruction` and `conceal_from_user`; those disqualify, while
  hidden HTML, alt text and invisible characters alone only flag, because an
  ordinary content system emits those. →
  [`../code/01-lib-foundation.md`](../code/01-lib-foundation.md)

  > **Known defect (2026-08-05 audit).** Double-encoded markup survives
  > `textSnippet` and evades hidden-HTML detection, and the hidden-element test
  > matches the substring `hidden` anywhere in a tag's attributes, so
  > `aria-hidden="false"` deletes ordinary posting text.

- **scan** — Reading a live application form into a plain data structure:
  `[{ k, t, l, req?, opts? }, ...]` — a key, a type, a label, whether it is
  required, and its options. Written to `jobs/<slug>/scan-p1.json`. Everything
  downstream reasons about this data, never about the page. →
  [`../code/06-apply-scanning.md`](../code/06-apply-scanning.md)

- **`scan-page.js`** — The scanner that runs **inside** the browser page. Listed
  in `.prettierignore` deliberately, and loaded by filename rather than injected
  as a script tag so a nonce-based CSP does not block it. →
  [`../code/06-apply-scanning.md`](../code/06-apply-scanning.md)

- **schema** — The shape of stored data: which tables exist, which columns they
  have, which types. This project's lives in `SCHEMA` in `scripts/lib/db.mjs` —
  and note it is a template literal, so a backtick inside its SQL would end the
  string. →
  [`./06-data-model.md`](./06-data-model.md)

- **scoped STOP** — A durable brake that says what it has evidence about, at one
  of four scopes: `company`, `board`, `run` or `global`. Only a human clears one,
  by deleting the file; there is deliberately no `clearStop()` at any scope.
  `raiseStop` **throws** if given a non-global scope with no key rather than
  quietly widening to global — that refusal is the load-bearing half. Not the same
  as a **board pause**. →
  [`../code/10-auto-safety.md`](../code/10-auto-safety.md)

- **screen / screening** — Running a lead through the L0–L3 stages and recording
  a verdict of `pass`, `caution` or `reject` in the `screens` table
  (`scripts/leads/screen.mjs`). Screening never deletes a lead; it marks it. →
  [`../code/03-leads-screening.md`](../code/03-leads-screening.md)

- **SHA-256** — The cryptographic hash used throughout for fingerprints, from the
  fact-base binding on a verified document to the field cache's form key. →
  [`../code/01-lib-foundation.md`](../code/01-lib-foundation.md)

- **skill** — **Here:** a directory under `.claude/skills/<name>/` containing a
  `SKILL.md`. Its YAML frontmatter `description` is always loaded and decides when
  the skill triggers; its body is loaded only once triggered, and is effectively a
  program written in English for the agent to follow. Eleven exist, including
  `apply-job`, `find-jobs`, `tailor-resume` and `pipeline-jobs`. →
  [`../code/13-skills-and-agents.md`](../code/13-skills-and-agents.md)

- **slug** — **In general:** a URL-safe short name. **Here:** the filesystem-safe
  identifier for one job, lowercase with hyphens —
  `render-postgres-product-engineer`. It names the workspace directory and is how
  every part of the system refers to that job. →
  [`./06-data-model.md`](./06-data-model.md)

- **SmartRecruiters** — An applicant tracking system with a lead fetcher here and
  no fill adapter. →
  [`../code/02-leads-finding.md`](../code/02-leads-finding.md)

- **SQLite** — A database that is a single file on disk with no server process to
  install or run. Node has it built in as `node:sqlite`. This project's whole
  store of record is one SQLite file, `jobs/leads.db`. →
  [`./06-data-model.md`](./06-data-model.md)

- **stage** — One screening step (L0–L3), registered into `scripts/leads/stages.mjs`'s
  registry so no stage file has to import any other and no import cycle forms. →
  [`../code/03-leads-screening.md`](../code/03-leads-screening.md)

- **state machine** — A design where a thing is always in exactly one named state
  and may move only along defined transitions. Two here: a document's
  `pending → drafted → verified → approved → rendered`, and the per-job unattended
  states in `auto_queue`. →
  [`./05-architecture.md`](./05-architecture.md)

- **STOP** — The kill switch: a file whose presence halts the unattended path at
  the next checkpoint. Global by default; see **scoped STOP** for the narrower
  forms. →
  [`../code/10-auto-safety.md`](../code/10-auto-safety.md)

- **store of record** — For any piece of information, the one copy that is
  authoritative. `jobs/leads.db` is this project's; `profile/applications.yaml` is
  a **generated export**, so hand-editing it loses the edit. →
  [`./06-data-model.md`](./06-data-model.md)

- **subagent** — **Here:** a separate agent defined in `.claude/agents/<name>.md`,
  spawned with its own fresh context window. Its frontmatter `model:` pins which
  model runs it and `tools:` is a capability allowlist — a subagent simply cannot
  call a tool not on its list. Seven exist, including `job-worker`, `implementer`
  and `qa`. →
  [`../code/13-skills-and-agents.md`](../code/13-skills-and-agents.md)

- **submit gate** — `authorizeSubmit` in `scripts/auto/authorize.mjs`: the only
  place that reads every precondition for an unattended submit together. Eleven
  named checks — `auto_apply_block`, `enabled`, `mode`, `trust_gate`,
  `apply_origin`, `screening`, `plan_defer`, `label_flag`, `submit_readiness`,
  `company_known`, `caps` — kept as a frozen closed list so a report can name
  which one refused and a twelfth has to be added there rather than smuggled in as
  an early return. →
  [`../code/10-auto-safety.md`](../code/10-auto-safety.md)

  > **Known defect (2026-08-05 audit).** `submitReadiness` reads only
  > `report.revealed`, not the `failures`, `verify.mismatch` and
  > `verify.requiredEmpty` the comment in `authorize.mjs` says it checks — so a
  > résumé upload that demonstrably did not attach does not block the submit.

- **SuccessFactors** — SAP's enterprise applicant tracking system, board type
  `successfactors`, addressed by `host`. Lead fetcher only. →
  [`../code/02-leads-finding.md`](../code/02-leads-finding.md)

- **surface (keyword)** — The different spellings one honest person might use for
  the same skill — `PostgreSQL` and `Postgres`. Folding these together is safe.
  Folding **aliases** together is not. →
  [`../code/01-lib-foundation.md`](../code/01-lib-foundation.md)

## T

- **tailoring** — Rewriting your résumé and cover letter to emphasise what a
  specific posting asks for. Rephrasing and reordering are allowed; inventing
  skills, employers, dates, metrics or technologies is forbidden and is what
  `verify-claims` exists to catch. →
  [`../code/05-documents.md`](../code/05-documents.md)

- **Taleo / iCIMS** — Older enterprise applicant tracking systems. They appear in
  this repository only inside board-discovery candidate lists
  (`docs/candidates/*.yaml`); there is **no** fetcher and **no** fill adapter for
  either. →
  [`../code/02-leads-finding.md`](../code/02-leads-finding.md)

- **TAP (Test Anything Protocol)** — The machine-readable format Node's test
  runner prints, with lines such as `not ok 12 - name`. The test gate parses it to
  count what actually ran. →
  [`../code/12-harness-and-ci.md`](../code/12-harness-and-ci.md)

- **tenant** — **Here:** one employer's slice of a multi-tenant ATS. Greenhouse
  hosts thousands of tenants on one domain, and anyone can sign up for one — which
  is exactly why the board allowlist answers a narrower question than it looks
  like it answers. Workday entries name their tenant explicitly (`tenant:
mgmresorts`). →
  [`../code/02-leads-finding.md`](../code/02-leads-finding.md)

- **terse output** — Every script here checks `process.stdout.isTTY`: a human at a
  terminal gets prose, and an agent reading piped output gets compact
  tab-separated records. This is why you should never pass `--verbose` from a tool
  call. →
  [`../operate/01-commands.md`](../operate/01-commands.md)

- **test gate (count gate)** — `.github/workflows/test-gate.mjs`, run by
  `npm test`. It exists because `node --test` exits `0` when it runs **zero**
  tests, so an exit code alone is not evidence anything happened. The gate asserts
  the count against a floor, that no test failed, that `todo` count is `0`, and
  that every skip carries a reason. →
  [`../code/12-harness-and-ci.md`](../code/12-harness-and-ci.md)

- **token** — The unit an AI model reads and writes text in — roughly three
  quarters of a word. Cost and context limits are both measured in tokens, which
  is why "read what you need, not the file that contains it" is a rule here. →
  [`./04-ai-and-agents.md`](./04-ai-and-agents.md)

- **transaction** — A group of database changes that either all take effect or
  none do, bracketed by `BEGIN` and `COMMIT` (or undone by `ROLLBACK`). `BEGIN
IMMEDIATE` takes the write lock at once, which is what stops two concurrent
  read-modify-writes clobbering each other. →
  [`./06-data-model.md`](./06-data-model.md)

- **trust gate** — `scripts/auto/trust.mjs`: five mechanical facts checked before
  an unattended application may proceed — `allowlist` (the domain is on the list
  you wrote), `adapter` (that list names an ATS this repo ships an adapter for),
  `screening` (the lead cleared every stage), `https`, and `origin_stable` (the
  origin now matches the one recorded when the job was queued). No model, no
  impression of the page. It deliberately does **not** infer the ATS from the URL,
  because a third party controls the query string. →
  [`../code/10-auto-safety.md`](../code/10-auto-safety.md)

## U

- **unattended path** — Applying with nobody watching, driven by
  `scripts/auto/auto-apply.mjs` on a schedule. Everything about it is gated more
  tightly than the attended path: `CONFIRM`, `confirm-widget`, consent tickboxes,
  `UNKNOWN`, an unprobed dropdown, a failed fill, an unverified document, an
  untrusted board or an L3 rejection each block the submit and defer the
  application. →
  [`../code/09-auto-runner.md`](../code/09-auto-runner.md)

- **`unclassified`** — The classifier's default answer, and the one remaining hard
  STOP on the unattended path. An unrecognised post-submit page is exactly the
  case that must stop, because calling a non-confirmation a confirmation loses an
  application silently and nothing later corrects it. →
  [`../code/10-auto-safety.md`](../code/10-auto-safety.md)

- **UNKNOWN** — The resolution status meaning nothing deterministic understood the
  field. It blocks on **both** paths, attended and unattended. It is not a gap in
  the system's knowledge to be filled in by a model — it is the system correctly
  reporting that filling the field would require a guess. →
  [`./07-safety-model.md`](./07-safety-model.md)

- **untrusted text** — Any text a third party wrote: a posting body, a form label,
  a company name, a URL. Treated as data everywhere, and passed through
  `safeText`/the sanitiser before it can reach a model or be interpolated into
  anything. →
  [`../code/01-lib-foundation.md`](../code/01-lib-foundation.md)

- **upsert** — Insert a row, or update it if one with that key already exists —
  SQL's `INSERT ... ON CONFLICT ... DO UPDATE`. Used here both for storing leads
  and, with a `WHERE` clause on the update branch, as the atomic mechanism behind
  a job claim. →
  [`./06-data-model.md`](./06-data-model.md)

## V

- **verb (plan verb)** — The instruction in a fill plan saying how to operate a
  field. The complete map from scanned field type to verb, in
  `scripts/apply/fill-plan.mjs`, is: text/email/tel/url/number/date/search/textarea
  → `fill`, select → `select`, combo → `combo`, checkbox/radio → `check`, richtext
  → `type`, file → `upload`. →
  [`../code/07-apply-planning.md`](../code/07-apply-planning.md)

- **verdict** — The recorded outcome of screening one lead: `pass`, `caution` or
  `reject`, stored in the `screens` table together with the source that decided it.
  →
  [`../code/03-leads-screening.md`](../code/03-leads-screening.md)

- **verification (document)** — A row in the `verifications` table binding one
  rendered document to the SHA-256 of the exact fact base it was checked against,
  so a later change to your profile invalidates it rather than silently leaving a
  stale approved document in play. →
  [`../code/05-documents.md`](../code/05-documents.md)

- **`verify-claims`** — `scripts/documents/verify-claims.mjs`, the truthfulness
  gate. It runs R1–R8 over a document and refuses it if any claim cannot be traced
  to a fact id. Hard rule 4 requires it to pass before anything is rendered or
  shown as final. →
  [`../code/05-documents.md`](../code/05-documents.md)

## W

- **WAL mode** — Write-Ahead Logging: a SQLite journalling mode where writers
  append to a side file (`leads.db-wal`, with `leads.db-shm` alongside) instead of
  rewriting the main database in place. It lets readers keep reading while a
  writer writes, which is what makes eight concurrent workers viable. Enabled in
  `openDb` — and `busy_timeout` is set **before** it, deliberately. →
  [`./06-data-model.md`](./06-data-model.md)

- **Workable** — An applicant tracking system with a lead fetcher here and no fill
  adapter. →
  [`../code/02-leads-finding.md`](../code/02-leads-finding.md)

- **Workday** — A large enterprise ATS on `*.myworkdayjobs.com`, addressed by
  `host`, `tenant` and `site` rather than a single slug. Lead fetcher only; its
  application forms are not filled by this project. →
  [`../code/02-leads-finding.md`](../code/02-leads-finding.md)

- **worker pool** — See **pool**.

- **workspace** — `jobs/<slug>/`: the directory holding everything produced for
  one job. The job-application flows may write here and via the deterministic
  scripts, and nowhere else. →
  [`./06-data-model.md`](./06-data-model.md)

## Y

- **YAML** — A human-editable data format used for every file you own:
  `profile/profile.yaml`, `profile/answers.yaml`, `docs/job-sources.yaml`,
  `docs/application-limits.yaml`. Indentation is significant, so a misplaced space
  changes meaning. Note that parsing a YAML file and writing it back out loses
  every comment, which is why the scripts that edit these files edit them
  line-by-line instead. →
  [`../operate/04-config-reference.md`](../operate/04-config-reference.md)

---

## Where to go next

- **[`./01-what-this-is.md`](./01-what-this-is.md)** — start here if a definition
  above assumed a purpose you have not met yet. It explains what the project is
  for and why it exists in this shape.
- **[`./02-computer-basics.md`](./02-computer-basics.md)** — files, paths,
  terminals, processes, git. The vocabulary underneath most of section C and E
  above.
- **[`./03-programming-basics.md`](./03-programming-basics.md)** — JavaScript
  itself: functions, modules, `async`/`await`, regular expressions, pure
  functions. Where the general-computing entries here are taught properly.
- **[`./04-ai-and-agents.md`](./04-ai-and-agents.md)** — tokens, context windows,
  tool calls, skills, subagents, hallucination, prompt injection.
- **[`./05-architecture.md`](./05-architecture.md)** — the whole pipeline in one
  diagram, and where each named component sits relative to the others.
- **[`./06-data-model.md`](./06-data-model.md)** — every table and column in
  `jobs/leads.db`, every file in a workspace, and who is allowed to write each one.
- **[`./07-safety-model.md`](./07-safety-model.md)** — the ten hard rules, the
  gates, the guards, and how they interlock. The home of `defer`, `fail closed`,
  `prompt injection` and every assent-related term above.
- **[`../code/00-file-index.md`](../code/00-file-index.md)** — every file in the
  repository with one line on what it does, for when you know a term and want the
  file.
- **[`../operate/01-commands.md`](../operate/01-commands.md)** — the command
  catalogue, with flags and exit codes.
- **[`../operate/03-troubleshooting.md`](../operate/03-troubleshooting.md)** — what
  to do when one of the gates above refuses and you need to know why.
- **[`../audit-2026-08-05.md`](../audit-2026-08-05.md)** — the full audit behind
  every `Known defect` note here, with the evidence for each.
- **[`../../CLAUDE.md`](../../CLAUDE.md)** — the hard rules in their authoritative
  form. Where any entry above disagrees with that file, that file is right.
