# Post-submit fixture pages (Phase 5 W2)

What the loopback fixture returns **after** a submit click, so the click →
navigate → classify path can run end to end without an employer.

## These are the FIXTURE's pages, not any real board's

Read that sentence before adding a rule to `scripts/auto/classify.mjs` that
cites one of these. They are written by this repository. They are evidence about
what this repository serves and **evidence about nothing else** — in particular
they are not evidence about what Greenhouse, Lever or Ashby say after a submit,
and no rule justified by a page in this directory may fire off loopback.
`ruleApplies()` enforces that; this note explains it.

The temptation these pages create is the whole reason the enforcement exists. It
is very easy to write a page here that says what you _think_ a real
confirmation says, cite it as evidence, and ship a rule that reads a real
employer's page and gets it wrong — silently, in the direction that loses an
application. §4.6 forbids exactly that guess. A synthetic corpus is not a
smaller version of a real one; it is a different thing wearing its name.

## What a real corpus needs, and where it comes from

§4.10: attended applies capture the post-submit page. `apply-job` runs
`scripts/apply/capture-post-submit.mjs` after the user clicks submit, which
redacts and stages a candidate; the user reads it and promotes it. Those samples
carry `source: "capture"` and may fire on the hosts they came from.

## The seventh page

`not-a-confirmation.html` is the control, and it is the most important file
here. A classifier tested only on pages it is meant to recognise will happily
recognise everything. This page is a plausible, friendly, thank-you-shaped page
that is **not** an application receipt, and the corpus test asserts it comes
back `unclassified`.
