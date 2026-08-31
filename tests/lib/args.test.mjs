// Strict flag validation — src/lib/args.mjs.
//
// The cases that matter are the two fail-open typos measured 2026-08-24:
// `--skip-aply` (cycle submits instead of preparing) and `--enqeue`
// (auto-apply submits instead of enqueuing). Everything else here exists to
// keep the checker from being so eager that someone turns it off.
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
)
import { assertKnownFlags, nearestFlag, positionals } from "#lib/args.mjs"

const CYCLE = {
  known: ["--top", "--limit", "--json", "--skip-search", "--skip-apply"],
  valueFlags: ["--top", "--limit"],
  script: "cycle.mjs",
}

test("a correctly spelled flag set passes", () => {
  assert.equal(
    assertKnownFlags(["--skip-apply", "--top", "10", "--json"], CYCLE),
    true,
  )
})

test("an empty argv passes — a bare run is not a usage error here", () => {
  assert.equal(assertKnownFlags([], CYCLE), true)
})

test("THE INCIDENT: --skip-aply is refused, not ignored", () => {
  assert.throws(
    () => assertKnownFlags(["--skip-aply"], CYCLE),
    (e) => {
      assert.match(e.message, /Unrecognised flag --skip-aply/)
      // The suggestion is the whole point: the user meant the real flag.
      assert.match(e.message, /Did you mean --skip-apply\?/)
      // And the consequence, because "unknown flag" alone reads as pedantry.
      assert.match(e.message, /submits applications|NOT ignored/)
      return true
    },
  )
})

test("THE OTHER INCIDENT: --enqeue is refused with the right suggestion", () => {
  assert.throws(
    () =>
      assertKnownFlags(["--enqeue"], {
        known: ["--enqueue", "--limit", "--fixture"],
        script: "auto-apply.mjs",
      }),
    /Did you mean --enqueue\?/,
  )
})

test("--fixtur is refused — the isolation guard only fires when it parses", () => {
  assert.throws(
    () =>
      assertKnownFlags(["--fixtur", "--db", "/tmp/x.db"], {
        known: ["--fixture", "--db", "--enqueue"],
        valueFlags: ["--db"],
        script: "auto-apply.mjs",
      }),
    /Did you mean --fixture\?/,
  )
})

test("a value is not mistaken for a flag", () => {
  // `25` follows a value flag and must not be inspected at all.
  assert.equal(assertKnownFlags(["--limit", "25"], CYCLE), true)
  // A value that LOOKS like a path is equally fine.
  assert.equal(
    assertKnownFlags(["--jobs-dir", "jobs"], {
      known: ["--jobs-dir"],
      valueFlags: ["--jobs-dir"],
      script: "x",
    }),
    true,
  )
})

test("a value flag followed by another flag is refused, not silently bound", () => {
  // `--jobs-dir --json` used to set jobsDir to the literal "--json".
  assert.throws(
    () =>
      assertKnownFlags(["--jobs-dir", "--json"], {
        known: ["--jobs-dir", "--json"],
        valueFlags: ["--jobs-dir"],
        script: "x",
      }),
    /--jobs-dir needs a value/,
  )
})

test("a value flag at the end of argv is refused", () => {
  assert.throws(() => assertKnownFlags(["--top"], CYCLE), /--top needs a value/)
})

test("--flag=value is checked on the name half only", () => {
  assert.equal(assertKnownFlags(["--top=10"], CYCLE), true)
  assert.throws(() => assertKnownFlags(["--tpo=10"], CYCLE), /--tpo/)
})

test("everything after -- is left alone", () => {
  assert.equal(
    assertKnownFlags(["--json", "--", "--not-a-flag", "--nonsense"], CYCLE),
    true,
  )
})

test("positionals are not flags and are not checked", () => {
  assert.equal(assertKnownFlags(["some-slug", "--json"], CYCLE), true)
})

test("a wildly wrong flag gets no suggestion rather than a misleading one", () => {
  // Suggesting --limit for --xyzzy would teach people to ignore the hint.
  assert.equal(nearestFlag("--xyzzy", CYCLE.known), null)
  assert.throws(
    () => assertKnownFlags(["--xyzzy"], CYCLE),
    (e) => {
      assert.match(e.message, /Unrecognised flag --xyzzy/)
      assert.doesNotMatch(e.message, /Did you mean/)
      return true
    },
  )
})

test("the message lists the known flags, so the fix needs no second command", () => {
  assert.throws(
    () => assertKnownFlags(["--nope"], CYCLE),
    /Known flags: --top --limit --json --skip-search --skip-apply/,
  )
})

// --- positionals: a flag's value is not the positional -----------------------
//
// MEASURED 2026-08-24 in six scripts. Each read a flag value with indexOf+1
// without splicing, then took `args.find((a) => !a.startsWith("--"))` as the
// positional — so the value of the first flag WAS the positional.
// docs/operate/01-commands.md recorded it as a find-jobs.mjs-only defect for
// three weeks.

test("THE DEFECT: a flag value is not mistaken for the positional", () => {
  // `ats-lint.mjs --html f.html r.md` linted f.html as the markdown.
  assert.deepEqual(positionals(["--html", "f.html", "r.md"], ["--html"]), [
    "r.md",
  ])
  // `keyword-plan.mjs --jobs-dir jobs acme` used the slug "jobs".
  assert.deepEqual(
    positionals(["--jobs-dir", "jobs", "acme"], ["--jobs-dir"]),
    ["acme"],
  )
  // `find-jobs.mjs mark --status dismissed <id>` looked for a lead "dismissed".
  assert.deepEqual(
    positionals(["mark", "--status", "dismissed", "gh:acme:1"], ["--status"]),
    ["mark", "gh:acme:1"],
  )
})

test("positional-first still works — the documented workaround must not break", () => {
  assert.deepEqual(positionals(["r.md", "--html", "f.html"], ["--html"]), [
    "r.md",
  ])
})

test("a boolean flag does not eat the next token", () => {
  assert.deepEqual(positionals(["--json", "acme"], ["--jobs-dir"]), ["acme"])
})

test("--flag=value carries its own value and eats nothing", () => {
  assert.deepEqual(positionals(["--jobs-dir=jobs", "acme"], ["--jobs-dir"]), [
    "acme",
  ])
})

test("everything after -- is a positional, even if it looks like a flag", () => {
  assert.deepEqual(positionals(["--json", "--", "--weird"], []), ["--weird"])
})

test("order is preserved, so a two-positional command still works", () => {
  // render-pdf.mjs and verify-claims.mjs both take two.
  assert.deepEqual(positionals(["in.md", "out.pdf", "--letter"], ["--css"]), [
    "in.md",
    "out.pdf",
  ])
})

test("no script finds its positional by scanning for the first non-flag token", () => {
  // THE REPO-WIDE GUARD. `args.find((a) => !a.startsWith("--"))` returns the
  // first non-flag token, which is the VALUE of the first flag whenever a flag
  // comes first — and every one of these scripts read its flag values with
  // indexOf+1 without splicing. Nine sites carried it; two of them
  // (applications.mjs remove, fill-plan.mjs) WRITE.
  //
  // Asserted over the source because the defect is a shape, not a behaviour of
  // any one command: a new script copying the old idiom would reintroduce it
  // silently, and there is no runtime moment at which that is detectable.
  const dir = path.join(ROOT, "src")
  const offenders = []
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith(".mjs")) {
        const src = fs.readFileSync(p, "utf8")
        for (const line of src.split(/\r?\n/)) {
          // Skip prose: several files legitimately QUOTE the old idiom while
          // explaining why it was removed.
          if (/^\s*(\/\/|\*)/.test(line)) continue
          if (
            /\.find\(\s*\(\w+\)\s*=>\s*!\w+\.startsWith\("--"\)\s*\)/.test(line)
          )
            offenders.push(`${path.relative(ROOT, p)}: ${line.trim()}`)
        }
      }
    }
  }
  walk(dir)
  assert.deepEqual(
    offenders,
    [],
    "use positionals(argv, VALUE_FLAGS) instead:\n" + offenders.join("\n"),
  )
})
