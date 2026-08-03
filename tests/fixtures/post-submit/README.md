# The post-click classifier's corpus (§4.10, Phase 5 W2)

**This directory is currently empty of real samples, and that is the accurate
state of the evidence rather than a TODO nobody got to.**

`corpus.json` lists post-submit pages captured from **real** attended applies,
redacted and promoted by the user. `scripts/auto/classify.mjs` may only carry a
rule that cites one of them, and such a rule fires only on the hosts its sample
came from.

## Why it cannot be filled in from memory

A rule written from an idea of what Greenhouse says after a submit is §4.6's
forbidden guess with the model taken out and this repository's imagination left
in. It fails in the one direction that cannot be recovered: a page misread as a
confirmation records an application that was never sent, the caps count it, the
digest reports it as sent, and the user never applies to that posting again.
Nothing later corrects that.

The opposite error is cheap. A real confirmation misread as anything else costs
one human look at one URL, and **cannot** cause a duplicate — the `(slug, mode)`
row in `auto_submissions` is written before the click, and its `ON CONFLICT DO
NOTHING` refuses the second claim.

So: `unclassified` is the default, `unclassified` is the one hard STOP left in
§4.6, and an empty corpus means every real board stops after the click rather
than guessing. That is the system working.

## Filling it

1. Apply to a job the normal way — `apply-job`, with the user on the submit
   button (hard rule 6).
2. After the click, the page is staged:
   `node scripts/apply/capture-post-submit.mjs stage --url <url> --html-file <f> --board <k>`
   It redacts against `profile/` plus generic identifier patterns, and **refuses
   to write anything** if an identifier survived.
3. Read it: `node scripts/apply/capture-post-submit.mjs review <id>`.
   Prints the redacted visible text. Read it — this is the step that decides
   what goes into git.
4. Promote it:
   `node scripts/apply/capture-post-submit.mjs promote <id> --kind confirmation --user-approved`

Promoting a sample does **not** create a rule. A human reads the sample and
writes one, citing it in `evidence.sample` with the hosts it may fire on.
Auto-generating a regex from a page is the guess again, one layer down.

## `captures/`

Redacted page bodies, committed, one per promoted sample. They are real
employers' pages with the user's identifiers removed — not the user's data, and
not a secret, but read one before adding another.
