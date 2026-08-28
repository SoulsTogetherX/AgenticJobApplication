// Gate #13: the lint config guards ITSELF.
//
// The rule this protects is the single most expensive one to get wrong here.
// `n/recommended` and every `unicorn` preset enable `no-process-exit`. This
// repository contains ~160 `process.exit` calls and they ARE the safety
// semantics: `save-answer.mjs` exits 4 on a government or financial
// identifier and THAT EXIT HAS NO OVERRIDE BY DESIGN. A thrown error can be
// caught by a caller; an exit cannot. So a lint rule that pressures an agent
// to "clean up" those exits is a safety regression wearing a tidiness
// costume, and the pressure is real — the fix it suggests looks like an
// improvement in every diff.
//
// Prose in eslint.config.mjs asks nicely. This asserts it, over the RESOLVED
// config for two real files: src/status.mjs (an ordinary entry point) and
// scripts/profile/save-answer.mjs (the one whose exit 4 is load-bearing, and
// which lives on a carved-out path because a sealed .claude hook pins that
// literal string).
//
// It also pins the shape of the config: everything outside eslint:recommended
// must be one of the hand-picked rules listed below. That is what makes
// "someone added a preset" a build failure rather than a diff nobody read.
import test from "node:test"
import assert from "node:assert/strict"
import { BIN, runBin } from "./helpers/bins.mjs"

const FILES = ["src/status.mjs", "scripts/profile/save-answer.mjs"]

// Every spelling of the rule that must never be on.
const FORBIDDEN = [
  "no-process-exit",
  "n/no-process-exit",
  "unicorn/no-process-exit",
]

// Rules this config enables ON TOP of eslint:recommended. Exhaustive on
// purpose: a preset would add dozens of ids that are not in this list.
const HAND_PICKED = [
  "complexity",
  "import-x/no-cycle",
  "import-x/no-self-import",
  "import-x/no-unresolved",
  "import-x/no-useless-path-segments",
  "max-depth",
  "max-lines",
  "max-lines-per-function",
  "max-nested-callbacks",
  "max-params",
  "n/no-extraneous-import",
  "n/no-missing-import",
  "n/no-unsupported-features/node-builtins",
  "promise/catch-or-return",
  "promise/no-return-wrap",
  "sonarjs/cognitive-complexity",
]

// A representative slice of eslint:recommended. If these are gone, the whole
// preset is gone — which is the other way to make lint green by removing it.
const RECOMMENDED_SAMPLE = [
  "no-undef",
  "no-unused-vars",
  "no-const-assign",
  "no-dupe-keys",
  "no-unreachable",
  "use-isnan",
]

function printConfig(file) {
  const res = runBin(BIN.eslint, ["--print-config", file])
  assert.equal(
    res.status,
    0,
    `eslint --print-config ${file} failed:\n${res.stdout}\n${res.stderr}`,
  )
  return JSON.parse(res.stdout)
}

// QA-5 (2026-08-27): when the config file itself cannot be resolved (a syntax
// error, a bad plugin entry), --print-config aborts, and every test below
// fails AT THE SAME HELPER with six different headlines — five of them false
// ("no-process-exit is enabled" when nothing is). This canary runs first and
// says the true thing; when it is red, read only it.
test("CANARY: the config resolves at all — when this fails, every other headline in this file is noise", () => {
  for (const file of FILES) printConfig(file)
})

function severityOf(entry) {
  const v = Array.isArray(entry) ? entry[0] : entry
  if (v === "off") return 0
  if (v === "warn") return 1
  if (v === "error") return 2
  return Number(v)
}

function enabledRules(cfg) {
  return Object.entries(cfg.rules ?? {})
    .filter(([, entry]) => severityOf(entry) > 0)
    .map(([id]) => id)
}

for (const file of FILES) {
  test(`${file}: no rule that pressures process.exit is enabled`, () => {
    const cfg = printConfig(file)
    const on = enabledRules(cfg).filter((id) => FORBIDDEN.includes(id))
    assert.deepEqual(
      on,
      [],
      `${on.join(", ")} is enabled for ${file}.\n` +
        `This repo's process.exit calls are the safety semantics, not style:\n` +
        `save-answer.mjs exits 4 on a government or financial identifier and\n` +
        `that exit has NO OVERRIDE BY DESIGN. Turning this rule on invites a\n` +
        `refactor to a throwable error, which a caller can swallow.\n` +
        `The usual way it arrives is a preset — n/recommended and every\n` +
        `unicorn preset enable it. Never extend a preset here.`,
    )
  })
}

test("no unicorn rule is enabled, and the plugin is not registered at all", () => {
  for (const file of FILES) {
    const cfg = printConfig(file)
    const unicornRules = enabledRules(cfg).filter((id) =>
      id.startsWith("unicorn/"),
    )
    assert.deepEqual(
      unicornRules,
      [],
      `unicorn rules are enabled for ${file}: ${unicornRules.join(", ")}. ` +
        `The plan rejected unicorn outright — its presets enable ` +
        `no-process-exit, and its opinionated renames produce large diffs on ` +
        `safety-critical files for no correctness gain.`,
    )
    const plugins = (cfg.plugins ?? []).map(String)
    assert.ok(
      !plugins.some((p) => p.includes("unicorn")),
      `the unicorn plugin is registered for ${file}: ${plugins.join(", ")}`,
    )
  }
})

test("the complexity and size ratchets are enabled at error with the agreed limits", () => {
  const cfg = printConfig(FILES[0])
  const want = {
    complexity: 15,
    "max-depth": 4,
    "max-nested-callbacks": 3,
    "max-params": 4,
    "sonarjs/cognitive-complexity": 15,
  }
  for (const [id, limit] of Object.entries(want)) {
    const entry = cfg.rules?.[id]
    assert.ok(entry, `${id} is not in the resolved config at all`)
    assert.equal(severityOf(entry), 2, `${id} must be "error", not warn/off`)
    assert.equal(
      Array.isArray(entry) ? entry[1] : undefined,
      limit,
      `${id} limit changed. Raising a ratchet limit is how debt becomes ` +
        `invisible — freeze the existing violations in eslint-suppressions.json ` +
        `instead, so the count can only go down.`,
    )
  }

  // Size rules MUST skip comments and blank lines. The safety-critical files
  // here are roughly half comments, and the comments are why the code has the
  // shape it does. A size rule that counts them pressures their deletion.
  for (const id of ["max-lines", "max-lines-per-function"]) {
    const entry = cfg.rules?.[id]
    assert.ok(entry, `${id} is not in the resolved config`)
    assert.equal(severityOf(entry), 2, `${id} must be "error"`)
    const opts = entry[1] ?? {}
    assert.equal(opts.skipComments, true, `${id} must set skipComments`)
    assert.equal(opts.skipBlankLines, true, `${id} must set skipBlankLines`)
  }
  assert.equal(cfg.rules["max-lines"][1].max, 500)
  assert.equal(cfg.rules["max-lines-per-function"][1].max, 80)
  assert.equal(cfg.rules["max-lines-per-function"][1].IIFEs, true)
})

test("eslint:recommended really is in the resolved config", () => {
  const cfg = printConfig(FILES[0])
  const on = new Set(enabledRules(cfg))
  const missing = RECOMMENDED_SAMPLE.filter((id) => !on.has(id))
  assert.deepEqual(
    missing,
    [],
    `these eslint:recommended rules are not enabled: ${missing.join(", ")}. ` +
      `Dropping the recommended set is the other way to make lint green ` +
      `without fixing anything.`,
  )
})

test("no plugin preset leaked in — the non-recommended rules are exactly the hand-picked set", () => {
  const cfg = printConfig(FILES[0])
  const on = enabledRules(cfg)
  // Anything namespaced (plugin/rule) or in the KISS/size family that is not
  // on the hand-picked list came from a preset somebody extended.
  const extras = on.filter(
    (id) =>
      (id.includes("/") || id.startsWith("max-") || id === "complexity") &&
      !HAND_PICKED.includes(id),
  )
  assert.deepEqual(
    extras,
    [],
    `unexpected rules are enabled: ${extras.join(", ")}.\n` +
      `Every rule in eslint.config.mjs is hand-picked and commented. If these ` +
      `arrived from a preset (n/recommended, sonarjs/recommended, a unicorn ` +
      `config), remove the preset and add back only the rules somebody read. ` +
      `If a rule was added deliberately, add its id to HAND_PICKED here in the ` +
      `same commit — that is the review record.`,
  )
})
