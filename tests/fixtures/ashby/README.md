# Ashby fixtures

One page reproducing the markup shapes that made a real Ashby application
(`jobs.ashbyhq.com/render/<id>/application`, driven by hand on 2026-08-04 while
applying from the backlog) submit-blocked on fields the form answers perfectly
well — and, on the first count below, **one click from submitting with a
required field silently empty**.

This is **not** a copy of an employer's page. It is hand-written from the three
defects observed in that run, reduced to the smallest markup that reproduces
each. What is reproduced verbatim is the SHAPE:

- a required marker carried **only** as a CSS-module class on the `<label>`
  (`_required_f7cvd_91`), with no `required` attribute, no `aria-required`, and
  no asterisk in the label TEXT — the asterisk is CSS `::after` content;
- a dropdown whose menu opens from a **chevron `<button>` beside the box**, not
  from the `role="combobox"` input itself;
- an async typeahead that, with no query, renders a `No results` box and
  declares **no `[role=option]` at all**.

## Why it is not in `tests/fixtures/boards/pages/`

Same reason as `tests/fixtures/oracle/`. That directory is the **honest board
corpus**: `fill-page.test.mjs`'s "SHAPE F: the honest board pages gain not one
field" runs the real scanner over every page in it and asserts the aria sweep
contributes nothing, as a broad false-positive check. These pages are the
opposite — deliberate reproductions of broken shapes, including always-present
`role="listbox"` menus that the DOM harness cannot see the stylesheet hiding.
Putting them in that corpus makes a defect reproduction look like a scanner
regression.

## What each defect cost

| Shape                       | Symptom                                                                            | Direction                                                                                                                       |
| --------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `_required_` class only     | required Location read as optional, skipped as "optional and not in the fact base" | **silent** — the submit proceeds with the field empty                                                                           |
| menu opens from the chevron | every dropdown probes as 0 options → `NEEDS-CHOICE`                                | loud — blocks the submit, defers an 11-option list to a human                                                                   |
| `No results` empty state    | `["No results"]` stored as the COMPLETE option list                                | **silent, and durable** — the field cache keeps it; the real answer then resolves as "not on offer" on every future application |

Pinned by `tests/apply/ashby-combo-probe.test.mjs` (browser arm) and
`tests/apply/ashby-required-class.test.mjs` (DOM harness, no browser).

The fourth control on the page — `Withdraw application` — is the **bound**. It
is a `<button>` in the same container as a combobox, so the only thing
separating it from a chevron is that it has a name of its own. If the toggle
search is ever loosened, that test fails before anything reaches a real board.
