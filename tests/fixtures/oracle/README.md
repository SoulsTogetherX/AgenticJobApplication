# Oracle Recruiting Cloud (ORC) fixtures

Two pages reproducing the markup shapes that made a real ORC application
(`*.fa.*.oraclecloud.com/.../job/<id>`, driven by hand on 2026-08-04)
unfillable and — worse on two of the four counts — **fillable with false
values**.

These are **not** copies of an employer's page. They are hand-written from the
four defects observed in that run, reduced to the smallest markup that
reproduces each one. What is reproduced verbatim is the SHAPE (Oracle JET's
`oj-*` wrappers, a combobox `input` that carries `role="combobox"` and points at
its listbox through `aria-controls`, option rows that are not `role="option"`,
answer sets rendered without a single `input[type=radio]`) and, in one case, the
WORDING — the sponsorship question — because the wording is the defect: it is
the parenthetical `(e.g. H-1B status, etc)` that made the label extractor start
the question mid-sentence and hand back a fragment with the opposite meaning.

## The four defects, and where each lives

| #   | defect                                             | page                     | reproduced by                                                                                                  |
| --- | -------------------------------------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------- |
| 1   | required consent checkbox reported NOWHERE         | `orc-email-gate.html`    | `input[type=checkbox]` at `opacity: 0` under an `oj-checkboxset` that carries the `id` and the `aria-required` |
| 2   | question label starts mid-sentence, inverting it   | `orc-questionnaire.html` | `(e.g. H-1B status, etc)` inside the question                                                                  |
| 3   | combo options unreadable, and set to the WRONG one | `orc-questionnaire.html` | `aria-controls` listbox whose rows are not `role="option"`                                                     |
| 4   | answer options reported as N loose phantom fields  | `orc-questionnaire.html` | answer rows that are focusable `<li>`s, no `aria-checked` anywhere                                             |

## The behaviour script is load-bearing (browser leg only)

`orc-questionnaire.html` carries a `<script>` implementing the ORC combobox the
way the real one behaves, because defect 3's second half is a BEHAVIOUR and not
a shape:

- the listbox is only populated/shown once the control is clicked;
- typing filters the rows and puts text in the `input`, but **does not commit**;
- the committed value lives in a separate hidden input — the "form model";
- blurring without picking a row **reverts** the visible text to the model.

That last rule is what made the old fill path report success on a value the
form never received. `tests/fixtures/boards/dom.mjs` ignores `<script>`, so the
DOM-harness tests read the shapes and the browser tests read the behaviour.

Nothing here is served by `tests/fixtures/boards/server.mjs`, and these pages
are deliberately NOT in `tests/fixtures/boards/pages/`: that corpus is the
honest-board false-positive denominator ("the honest board pages gain not one
field") and an ORC page legitimately contains controls the sweep must report.
