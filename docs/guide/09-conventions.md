# Conventions, and how each one is enforced

This is a decision record, not a style guide. It says which rules this project
adopted, which mechanism enforces each one, which candidate rules were
**rejected** and why, and which rules genuinely cannot be mechanised and
therefore survive only as prose.

It exists because of one finding from the 2026-08-27 survey: an instruction file
is **advisory**, and a gate is **deterministic**. `CLAUDE.md` asks; a failing
test refuses. Every rule that can be converted into a check has been, and the
standing rule for anything new is at the bottom of this page.

**The order matters.** A rule that lives only in prose is a rule that will be
broken by an agent under pressure, at 2am, in a long session, with the best of
intentions. That is not a criticism of agents; it is what "advisory" means.

---

## 1. What is enforced, and by what

Every gate below runs **twice**: as a counted `node:test` under `tests/quality/`
(so `npm test` catches it locally and the count-asserting gate proves it ran) and
as a job in `.github/workflows/ci.yml`. The tests spawn `process.execPath` and a
plain-JS bin such as `node_modules/eslint/bin/eslint.js` — never `npx` or a
`.cmd` shim, which fails with `EINVAL` on Windows.

| #   | Rule                        | Mechanism                                                                                                                                 | Mode                       |
| --- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| 1   | Formatting, whole repo      | `prettier --check .` — `tests/quality/format.test.mjs`                                                                                    | hard fail                  |
| 2   | Correctness lint            | ESLint 10 `eslint:recommended` — `tests/quality/lint.test.mjs`                                                                            | hard fail                  |
| 3   | Import hygiene              | `import-x/no-unresolved`, `no-self-import`, `no-useless-path-segments`, `no-cycle`                                                        | hard fail                  |
| 4   | Node-24 compatibility       | `n/no-missing-import`, `n/no-extraneous-import`, `n/no-unsupported-features/node-builtins >=24`                                           | hard fail                  |
| 5   | KISS proxies                | `complexity` 15, `sonarjs/cognitive-complexity` 15, `max-depth` 4, `max-nested-callbacks` 3, `max-params` 4                               | ratchet                    |
| 6   | File and function size      | `max-lines` 500, `max-lines-per-function` 80, both `skipComments` + `skipBlankLines`                                                      | ratchet                    |
| 7   | Promise hygiene             | `promise/no-return-wrap`, `promise/catch-or-return`                                                                                       | ratchet                    |
| 9   | Doc-path truth              | every repo path and relative link in current docs resolves — `tests/quality/docs-links.test.mjs`                                          | hard fail                  |
| 11  | Structure                   | root allowlist, `src/` domain allowlist, `scripts/` ≡ the six pinned files, kebab-case, tests mirror — `tests/quality/structure.test.mjs` | hard fail                  |
| 12  | `.prettierignore` contracts | required entries present — `tests/quality/format.test.mjs`                                                                                | hard fail                  |
| 13  | Lint-config guard           | resolved config has no `no-process-exit` and no `n/`/`unicorn/` preset — `tests/quality/eslint-config-guard.test.mjs`                     | hard fail                  |
| 14  | YAML/JSON validity          | parse only, never edit, over `docs/**/*.yaml` and `schemas/*.json` — `tests/quality/yaml-valid.test.mjs`                                  | hard fail                  |
| 15  | Import fragility            | deep-relative (`../../`) specifier count ≤ stored baseline — `tests/quality/import-fragility.test.mjs`                                    | ratchet                    |
| 16  | Shim parity                 | each shim's exit code and stdout match direct invocation — `tests/quality/shims.test.mjs`                                                 | hard fail while shims live |
| 17  | Markdown lint               | `markdownlint-cli2` over docs and root markdown — `tests/quality/markdown.test.mjs`                                                       | hard fail                  |
| 18  | Pre-existing gates          | test-count floors, the security suite, click-surface, source-bytes, hostile-forms, perf-gate                                              | unchanged semantics        |

Gates 8 (CLAUDE.md budget and integrity) and 10 (entry-point catalogue) are part
of the same design and land with their test files; until each has a file under
`tests/quality/`, the rule it encodes is prose like any other and should be
treated as such.

### The thresholds, and why those numbers

The complexity and size numbers are **not** aspirations. They were chosen so that
the ratchet baseline freezes today's tree and every new file has to clear a bar
the existing code mostly clears too:

- `complexity: 15` and `sonarjs/cognitive-complexity: 15` — cyclomatic and
  cognitive complexity respectively. They disagree often, which is the point:
  cyclomatic counts branches, cognitive counts nesting and control-flow breaks.
- `max-depth: 4`, `max-nested-callbacks: 3`, `max-params: 4`.
- `max-lines: 500` and `max-lines-per-function: 80`, both with `skipComments` and
  `skipBlankLines`. **This is load-bearing.** The safety-critical files here are
  roughly half comments, and the comments are why the code has the shape it has.
  A size rule that counted them would apply steady pressure to delete the
  explanation of a bug rather than the bug — the exact failure this repository's
  comment convention exists to prevent.

## 2. The ratchet, and what it is not

A ratchet rule is at `error`, and the existing violations are frozen in
`eslint-suppressions.json` (ESLint 10's first-party bulk-suppression file,
generated with `--suppress-all`). As of 2026-08-27 that baseline covers **128
files**: 135 `complexity`, 113 `sonarjs/cognitive-complexity`, 93
`max-lines-per-function`, 39 `max-lines`, 36 `no-unused-vars`, 32
`no-useless-assignment`, 37 `no-empty`, 22 `max-depth`, and a long tail.

Three mechanics matter:

1. The gate runs with `--pass-on-unpruned-suppressions`, so **fixing** a
   violation never turns CI red. Fixing something must never cost you a build.
2. **Pruning** the suppressions file is therefore a deliberate maintenance act,
   done on its own, not a side effect of a feature.
3. **Never widen a suppression, and never lower a floor to make a phase green.**
   That converts a debt record into a lie, and the next reader cannot tell which
   entries were earned and which were bought.

**A complexity number going green is not evidence of improvement.** A function
split into three that still has to be understood as one is a worse artefact with
a better score. In particular, the four safety-critical giants — `buildPlan` and
`submitReadiness` in `src/apply/fill-plan.mjs`, `evaluate` in
`src/auto/authorize.mjs`, and `submitOnce` in `src/auto/submit.mjs` — are the
gate chain. They are split only in a dedicated, human-reviewed effort with the
test suite watching, never as a lint fix.

## 3. The preset ban

`eslint.config.mjs` extends **no plugin preset**. Every rule is hand-picked and
written on one line, and that is the point: a preset is a promise to accept rules
nobody in this repo has read.

The concrete reason is one rule. `n/recommended` and every `unicorn` preset
enable **`no-process-exit`**. This repository contains roughly 160 `process.exit`
calls and they **are** the safety semantics, not a style choice. The clearest
case: `scripts/profile/save-answer.mjs` exits **4** on a government or financial
identifier, and that exit **has no override by design**. A thrown error can be
caught by a caller; an exit cannot. A lint rule that pressures an agent to
"clean up" `process.exit(4)` into a throw is a safety regression wearing a
tidiness costume — and it looks like an improvement in every diff, which is what
makes it dangerous.

Prose in the config asks for this. `tests/quality/eslint-config-guard.test.mjs`
asserts it, over the **resolved** config for two real files, and fails the build
if any of the three `no-process-exit` rule ids is ever enabled or if any
`unicorn/` rule appears at all.

## 4. What was rejected, and why

Recording rejections is half the value of a decision record: without them the
same tool gets re-proposed every quarter.

| Candidate                                   | Verdict  | Reason                                                                                                                                                                                                                                    |
| ------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `eslint-plugin-unicorn`                     | rejected | Lowest confidence and most opinionated of the candidates, and it enables `no-process-exit`. Its useful rules are individually adoptable later if a specific defect motivates one.                                                         |
| `jscpd` (copy-paste detector)               | rejected | Cannot distinguish copy-paste from **deliberately independent** fixtures. This repo's board fixtures and hostile-form fixtures are near-duplicates on purpose; a shared helper would let one edit silently change what four tests assert. |
| `knip` (dead-code finder)                   | rejected | Cannot distinguish dead code from a **safety net**. With ~97 entry points here, its output is dominated by exports that exist to be called by a future failure path, and pruning one of those is exactly the wrong edit.                  |
| `dependency-cruiser`                        | rejected | `import-x/no-cycle` already covers the one property that was actually wanted (no import cycles) with no extra dependency and no extra config file.                                                                                        |
| Splitting `src/lib/` into `core/` + `text/` | rejected | Breaks the one-for-one `tests/<domain>` ↔ `src/<domain>` mirror for a taxonomy-only gain. `src/lib/` is seven files with a written boundary in `src/lib/README.md` instead.                                                               |
| A `cli/` regroup                            | rejected | Same reason, larger blast radius: it would separate each command from the domain code it drives and multiply the mapping risk across ~50 entry points.                                                                                    |

Rejected does not mean forbidden forever. It means: do not re-add it without a
specific defect it would have caught.

## 5. What cannot be mechanised

These are in `CLAUDE.md` as prose, tagged `[prose-only]`, because no honest lint
proxy exists. Writing a bad proxy is worse than writing nothing, because a green
check is read as evidence.

- **SRP, OCP, LSP, ISP, DIP.** Every available proxy measures a symptom (file
  length, fan-out, parameter count) and none measures the property. A file can
  have one responsibility and 600 lines, or five responsibilities and 80.
- **DRY versus deliberate duplication.** See `jscpd` above. In a repo whose
  fixtures encode attacks, two near-identical files are frequently the design.
- **KISS on the gate chains.** A gate chain is a list of refusals; simplifying it
  means removing a refusal. The complexity numbers are a ratchet on new code, not
  a mandate to simplify `submitReadiness`.
- **Comment quality.** "Explain why, with the consequence named" cannot be
  checked by a machine. What _is_ checked is that comments are not deleted to
  make a size rule pass, which is why the size rules skip comments.
- **The dated decision records.** Whether a paragraph in `CLAUDE.md` faithfully
  states what the user decided is a question only the user can settle.

## 6. The standing rule for new conventions

1. If it can be a gate, it lands as a gate **first** — a test under
   `tests/quality/` plus a CI job — and only then, if useful, as one line of
   prose pointing at the gate.
2. If it cannot be mechanised, say so explicitly and tag it `[prose-only]` where
   it is written down, so a reader knows nothing will catch a violation.
3. A gate nobody has watched fail is not a gate. Every gate here has a canary
   case: `lint.test.mjs` lints a file that **must** be rejected;
   `test-gate.mjs` refuses to believe a green run without counting the tests.
4. Never lower a floor, widen a suppression, or narrow a scope to make today's
   change green. Record the debt instead — visible and shrink-only.

---

**Where to go next**

- [`../code/12-harness-and-ci.md`](../code/12-harness-and-ci.md) — the hooks, the
  test gate, the CI jobs and every dotfile, file by file.
- [`07-safety-model.md`](07-safety-model.md) — the ten hard rules, what each
  protects against, and how strongly each is enforced.
- [`05-architecture.md`](05-architecture.md) — the folder layout these structure
  rules assert.
