// ESLint 10 flat config — the correctness/complexity half of the enforcement
// layer (P3 of the 2026-08-27 conventions plan). The formatting half is
// prettier; the two do not overlap and no stylistic rule is enabled here.
//
// =====================================================================
// ABSOLUTE CONSTRAINTS. Read these before adding anything to this file.
// =====================================================================
//
// 1. NEVER extend `n/recommended`, `unicorn/recommended`, or any other
//    plugin preset. Every rule in this file is hand-picked, one line each,
//    and that is the point: a preset is a promise to accept rules nobody in
//    this repo has read.
//
// 2. `no-process-exit` MUST NEVER BE ENABLED — not the core rule, not
//    `n/no-process-exit`, not `unicorn/no-process-exit`. This repository
//    contains ~160 `process.exit` calls and they ARE the safety semantics,
//    not a style choice. The clearest example: `save-answer.mjs` exits 4 on a
//    government or financial identifier and that exit HAS NO OVERRIDE BY
//    DESIGN. `n/recommended` turns `no-process-exit` on, which is why point 1
//    exists. A lint rule that pressures an agent to replace `process.exit(4)`
//    with a thrown error — which a caller can catch — is a safety regression
//    dressed as a cleanup. `tests/quality/eslint-config-guard.test.mjs`
//    asserts the resolved config for two real files and fails the build if any
//    of those three rule ids is ever enabled, and if any `unicorn/` rule is
//    enabled at all.
//
// 3. Size rules use `skipComments` and `skipBlankLines`. The safety-critical
//    files here are roughly half comments — the comments are why the code is
//    the shape it is — and a size rule that counts them pressures their
//    deletion, which is the opposite of what this repo needs.
//
// 4. The complexity/size rules below are RATCHETS, frozen by
//    `eslint-suppressions.json`. A number going green because a suppression
//    covers it is not evidence of improvement, and splitting the four
//    safety-critical giants (fill-plan, db, fill-engine, answer-bank — they
//    are the gate chain) is deliberate human-reviewed work, not a lint fix.
//    Never widen a suppression to make a change green.

// `@eslint/js` is a SEPARATE devDependency, not something eslint ships.
// ESLint 10 dropped it from its own dependency list (`require("@eslint/js")`
// fails on a clean install of eslint@10.9.1 alone, measured 2026-08-27) and
// the package's versions diverged too — the current release is 10.0.1, not
// 10.9.x. The alternative was reading `builtinRules` out of
// `eslint/use-at-your-own-risk` and filtering on `meta.docs.recommended`,
// which is an unsupported API and a poor thing for a config guard to depend
// on. One extra devDependency, published by the ESLint team, no transitive
// deps.
import js from "@eslint/js"
import { importX, createNodeResolver } from "eslint-plugin-import-x"
import n from "eslint-plugin-n"
import promise from "eslint-plugin-promise"
import sonarjs from "eslint-plugin-sonarjs"

// Node globals, written out rather than pulled from the `globals` package.
// Two versions of that package are already in this tree (15.x under
// eslint-plugin-n, 17.x under eslint-plugin-sonarjs), so which one a config
// resolved would depend on hoisting order — a silent, machine-dependent input
// to a gate. This list is explicit, and its completeness is verified the only
// way that means anything: the suppressions baseline was generated with
// `no-undef` at error and contains ZERO `no-undef` entries. If a new file uses
// a global that is missing here, the build goes red with the name in the
// message. Add it here; never silence `no-undef`.
const NODE_GLOBALS = Object.fromEntries(
  [
    "AbortController",
    "AbortSignal",
    "Blob",
    "Buffer",
    "ByteLengthQueuingStrategy",
    "CompressionStream",
    "CountQueuingStrategy",
    "Crypto",
    "CryptoKey",
    "CustomEvent",
    "DecompressionStream",
    "Event",
    "EventTarget",
    "File",
    "FormData",
    "Headers",
    "Intl",
    "MessageChannel",
    "MessageEvent",
    "MessagePort",
    "Navigator",
    "PerformanceEntry",
    "PerformanceObserver",
    "ReadableStream",
    "Request",
    "Response",
    "SubtleCrypto",
    "TextDecoder",
    "TextDecoderStream",
    "TextEncoder",
    "TextEncoderStream",
    "TransformStream",
    "URL",
    "URLSearchParams",
    "WebAssembly",
    "WebSocket",
    "WritableStream",
    "__dirname",
    "__filename",
    "atob",
    "btoa",
    "clearImmediate",
    "clearInterval",
    "clearTimeout",
    "console",
    "crypto",
    "exports",
    "fetch",
    "global",
    "module",
    "navigator",
    "performance",
    "process",
    "queueMicrotask",
    "require",
    "setImmediate",
    "setInterval",
    "setTimeout",
    "structuredClone",
  ].map((name) => [name, "readonly"]),
)

// Browser globals for PAGE-SIDE code: function bodies that Playwright
// serialises into a page and runs there, not in Node.
//
// Granted to a NAMED FILE LIST below, never repo-wide. `document` being
// undefined in ordinary Node code is a real bug shape and `no-undef` is the
// only thing in this rule set that catches it — handing every file a DOM
// would retire that. The cost is one line when a new file starts evaluating
// something in the page, and the build says exactly which name was missing.
const DOM_GLOBALS = Object.fromEntries(
  [
    "CSS",
    "DOMParser",
    "Element",
    "HTMLElement",
    "MutationObserver",
    "Node",
    "NodeFilter",
    "XPathResult",
    "document",
    "getComputedStyle",
    "indexedDB",
    "localStorage",
    "location",
    "sessionStorage",
    "window",
  ].map((name) => [name, "readonly"]),
)

// The files whose bodies (or `page.evaluate` callbacks) run in the page.
// Measured from a `no-undef`-at-error run over the whole repo on 2026-08-27:
// these are exactly the files that reported a DOM global, and the list is
// what makes the other ~250 files still prove they do not touch one.
const PAGE_SIDE_FILES = [
  "src/apply/scan-engine.mjs",
  "src/apply/fill-engine.mjs",
  "src/apply/browser.mjs",
  "src/dev/bench-apply.mjs",
  "tests/fixtures/boards/**/*.mjs",
  "tests/apply/ashby-combo-probe.test.mjs",
  "tests/apply/bench-apply.test.mjs",
  "tests/apply/choice-group-verify.test.mjs",
  "tests/apply/combo-commit.test.mjs",
  "tests/apply/fill-page.test.mjs",
  "tests/apply/greenhouse-embed-rerender.test.mjs",
  "tests/apply/multi-select.test.mjs",
  "tests/apply/widget-verb.test.mjs",
  "tests/auto/isolation.test.mjs",
  "tests/security/browser-vouch.test.mjs",
  "tests/security/enter-never-submits.test.mjs",
]

export default [
  // ---- what is not linted -------------------------------------------
  {
    ignores: [
      "node_modules/**",
      // Data and user-owned trees. `profile/` and `jobs/` hold personal data
      // and never leave this machine; linting them would be pointless and
      // reading them into a tool's memory is exactly what the gitignore
      // rules exist to prevent.
      "jobs/**",
      "profile/**",
      "logs/**",
      ".playwright-mcp/**",
      // Prose, not code.
      "docs/**",
      // Sealed: .claude/hooks/* and .claude/settings*.json are the user's
      // alone, and .claude/skills/apply-job/scan-page.js + scan.driver.mjs
      // are loaded as bare function expressions, not modules — they are not
      // parseable as either script or module.
      ".claude/**",
      // Deliberate attack shapes: hidden text, invisible characters,
      // misnested markup, byte-precise on purpose. Formatting or "fixing"
      // them defuses what they test.
      "tests/fixtures/hostile/**",
      "package-lock.json",
    ],
  },

  // ---- the linted surface -------------------------------------------
  {
    files: [
      "src/**/*.mjs",
      "src/**/*.cjs",
      "scripts/**/*.mjs",
      "tests/**/*.mjs",
      "tools/**/*.mjs",
    ],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: NODE_GLOBALS,
    },
    plugins: {
      "import-x": importX,
      n,
      promise,
      sonarjs,
    },
    settings: {
      // The modern resolver (unrs/oxc under the hood). It is the one that
      // understands package.json "imports" subpaths, which this repo uses for
      // `#lib/*` — the legacy eslint-import-resolver-node does not, and would
      // report every `#lib/lib.mjs` as unresolved. Verified against
      // src/profile/profile-gaps.mjs, which imports four of them.
      "import-x/resolver-next": [createNodeResolver()],
    },
    rules: {
      // ---- 2. correctness ------------------------------------------
      ...js.configs.recommended.rules,

      // ---- 3. import hygiene ---------------------------------------
      "import-x/no-unresolved": "error",
      "import-x/no-self-import": "error",
      "import-x/no-useless-path-segments": ["error", { commonjs: true }],
      "import-x/no-cycle": ["error", { maxDepth: Infinity }],

      // ---- 4. Node-24 compatibility --------------------------------
      // Hand-picked, three rules. NOT `n/recommended` — see constraint 1.
      //
      // BOTH `n/no-missing-import` AND `import-x/no-unresolved` are on, and
      // that overlap is deliberate. The brief allowed dropping one if they
      // double-reported; measured over the whole repo on 2026-08-27 they
      // report ZERO between them, so keeping both costs nothing today. They
      // use DIFFERENT resolvers — import-x goes through unrs-resolver, n
      // through its own path logic — and both were checked against this
      // repo's `#lib/*` subpath imports (src/profile/profile-gaps.mjs has
      // four) with neither producing a false miss. A resolver regression in
      // one is then still caught by the other. The cost, stated: a genuinely
      // missing import will be reported twice.
      "n/no-missing-import": "error",
      "n/no-extraneous-import": "error",
      "n/no-unsupported-features/node-builtins": ["error", { version: ">=24" }],

      // ---- 7. promise hygiene (ratchet) ----------------------------
      "promise/no-return-wrap": "error",
      "promise/catch-or-return": "error",

      // ---- 5. KISS proxies (ratchet) -------------------------------
      // A number going green is not evidence of improvement. See constraint 4.
      complexity: ["error", 15],
      "sonarjs/cognitive-complexity": ["error", 15],
      "max-depth": ["error", 4],
      "max-nested-callbacks": ["error", 3],
      "max-params": ["error", 4],

      // ---- 6. file and function size (ratchet) ---------------------
      "max-lines": [
        "error",
        { max: 500, skipComments: true, skipBlankLines: true },
      ],
      "max-lines-per-function": [
        "error",
        { max: 80, skipComments: true, skipBlankLines: true, IIFEs: true },
      ],
    },
  },

  // ---- CommonJS files -------------------------------------------------
  // src/dev/spawn-counter.cjs is .cjs on purpose: it is spawned as a plain
  // script and must not be parsed as a module.
  {
    files: ["**/*.cjs"],
    languageOptions: { sourceType: "commonjs" },
  },

  // ---- test files -----------------------------------------------------
  // `max-lines` is OFF for tests/, and this is the one rule relaxation in
  // this config that is a judgement rather than a mechanical fact. The
  // argument, and it is not "the rule was annoying":
  //
  // In a source module, length is a proxy for surface area — how much one
  // file is responsible for. In a test file, length is a proxy for HOW MANY
  // CASES EXIST. Those are opposite things, and the rule cannot tell them
  // apart. It measured its own irrelevance here: 24 of the 39 `max-lines`
  // entries in the first baseline were test files.
  //
  // Then it demonstrated the harm. On 2026-08-27, while this config was being
  // written, somebody added cases to tests/lib/db.test.mjs, it crossed 500
  // lines at 529, and the build went red WITH NO OTHER CHANGE. The two ways
  // to clear that red are "split the file" (churn) and "delete some tests"
  // (catastrophic). In a repository whose central control is a test-count
  // floor — `node --test` exits 0 on an empty run, so the count is the only
  // evidence anything ran — a rule whose gradient points at fewer tests is a
  // safety regression, however tidy it looks.
  //
  // Everything else stays on for tests. `max-lines-per-function` in
  // particular: a single 400-line test body is genuinely unreadable, and its
  // 14 existing violations stay frozen in the baseline rather than waived.
  {
    files: ["tests/**/*.mjs"],
    rules: { "max-lines": "off" },
  },

  // ---- page-side code -------------------------------------------------
  // These files contain function bodies that Playwright serialises into the
  // page. They run in a DOM. Nothing is read back out of the page (see
  // CLAUDE.md gotchas A) — the DOM globals are used, not returned.
  {
    files: PAGE_SIDE_FILES,
    languageOptions: { globals: { ...NODE_GLOBALS, ...DOM_GLOBALS } },
    rules: {
      // Declaring the DOM globals above makes them visible to
      // n/no-unsupported-features/node-builtins, which then reports
      // `localStorage`/`sessionStorage` as experimental NODE features
      // (8 hits in tests/auto/isolation.test.mjs, measured 2026-08-27). They
      // are not Node features here — they are the browser's, inside a
      // page.evaluate body. Named exactly, so the rule still reports the
      // things it is here for in these same files: `node:sqlite` and
      // `module.registerHooks` are still flagged everywhere.
      "n/no-unsupported-features/node-builtins": [
        "error",
        {
          version: ">=24",
          // Only names the rule actually tracks may appear here. It validates
          // this list against its own enum and REFUSES TO START on an unknown
          // one — measured: "indexedDB" is not in the enum and eslint exited 2
          // before linting a single file. That refusal is the right
          // behaviour: a typo here cannot silently widen the ignore list.
          ignores: ["localStorage", "sessionStorage", "navigator"],
        },
      ],
    },
  },
]
