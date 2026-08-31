# `src/profile/` — reading the fact base

**Owner:** `implementer`.

Two read-only analyses over `profile/`. **The two writers are not here** — see
below, because that split is deliberate and load-bearing.

## Entry points

| Command                | What it does                                                            |
| ---------------------- | ----------------------------------------------------------------------- |
| `profile-gaps.mjs`     | What are the jobs asking for that the fact base cannot answer?          |
| `keyword-coverage.mjs` | What do you have but never wrote down? Read-only, proposes nothing.     |

## The two writers live in `scripts/profile/`

`save-answer.mjs` and `apply-profile.mjs` are **real files at
`scripts/profile/`**, not shims and not copies. `.claude/hooks/guard-profile-shell.mjs`
— sealed, the user's alone — matches that literal path to decide whether a shell
command is a sanctioned fact-base write, and then requires `--file <temp>`,
`--user-approved` or `--rescan` on it.

Move them and the regex stops matching, the approval requirement never fires,
and the command is allowed through unguarded. Full trace:
[`../../scripts/README.md`](../../scripts/README.md).

## The rule this directory exists under

The agent never edits `profile/`. New facts go through `save-answer.mjs` after
the user answers **in chat**; a form option the agent picked may be saved
`--source model` only once the user approved that pick in the approval message.
A silent guess is never written.

`save-answer.mjs` exit codes worth knowing: **3** is an instruction-shaped label,
**4** is a government or financial identifier, and 4 has **no override by
design**.

## Traps

- `profile.yaml`'s `meta.approved_by_user` must be `true` before any real
  tailoring.
- One `save-answer` write invalidates every recorded verification. Run
  `src/documents/reverify.mjs` before applying.
- A resurfaced question usually means stale derived state, not a missing fact.
  Check the bank before asking the user again.
- Years-of-experience and start-date answers are **computed against today**,
  never banked as frozen prose.

Detail: [`../../docs/code/11-record-and-profile.md`](../../docs/code/11-record-and-profile.md).
