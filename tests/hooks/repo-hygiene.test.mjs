// Repo hygiene checks that belong to the pipeline rather than to any feature.
//
// Written because of a real near-miss on 2026-07-31: the `*.html` rule in
// .gitignore silently swallowed all ten HTML fixtures for the fake ATS board
// and the hostile-form corpus the moment they were created. Every test using
// them passed on the machine that wrote them and would have failed — or worse,
// found nothing — on a fresh clone. Nothing in the suite would have noticed,
// because a test's inputs are invisible to the test.
//
// Owned by ci-engineer (tests/hooks/), like .gitignore itself.
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
)

function gitAvailable() {
  const res = spawnSync("git", ["--version"], { cwd: ROOT, encoding: "utf8" })
  return res.status === 0
}

function walk(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name)
    if (ent.isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

test("nothing under tests/ is gitignored", (t) => {
  if (!gitAvailable()) {
    // Explicit and attributed: the gate rejects a skip with no reason.
    return t.skip("git is not on PATH, so ignore rules cannot be evaluated")
  }
  const files = walk(path.join(ROOT, "tests")).map((p) =>
    path.relative(ROOT, p).split(path.sep).join("/"),
  )
  assert.ok(files.length > 50, "sanity: the walk found the test tree")

  // check-ignore exits 0 and echoes the paths it WOULD ignore.
  const res = spawnSync("git", ["check-ignore", "--stdin"], {
    cwd: ROOT,
    input: files.join("\n"),
    encoding: "utf8",
  })
  const ignored = res.stdout.split("\n").filter(Boolean)
  assert.deepEqual(
    ignored,
    [],
    `these test files would never reach a clone:\n  ${ignored.join("\n  ")}\nFix .gitignore (ci-engineer owns it) rather than moving the fixture.`,
  )
})

// Every hook wired in .claude/settings.json must actually exist on disk.
//
// Written on 2026-07-31, when guard-profile-shell.mjs moved from scripts/hooks/
// to .claude/hooks/ and settings.json was repointed by hand. If that edit had
// been missed, or a later reorg moves a hook again, the guard is simply GONE:
// Claude Code cannot run a file that is not there, and nothing else in the
// suite reads settings.json. The 2026-07-29 reorg already did exactly this to
// `npm run verify`, which pointed at a moved path and did nothing at all for
// two days. A guardrail that silently stopped being loaded is the worst kind of
// green.
test("every hook command in .claude/settings.json points at a file that exists", () => {
  const settingsPath = path.join(ROOT, ".claude", "settings.json")
  const raw = fs.readFileSync(settingsPath, "utf8")
  let settings
  assert.doesNotThrow(() => {
    settings = JSON.parse(raw)
  }, "settings.json must be valid JSON or Claude Code loads NO hooks at all")

  const commands = []
  for (const [event, matchers] of Object.entries(settings.hooks ?? {})) {
    for (const m of matchers) {
      for (const h of m.hooks ?? []) {
        if (h.type === "command") {
          commands.push({ event, matcher: m.matcher, command: h.command })
        }
      }
    }
  }
  assert.ok(
    commands.length >= 4,
    `expected the guardrail hooks to be wired, found ${commands.length}`,
  )

  for (const { event, matcher, command } of commands) {
    // `node <script>` — take the first .js/.mjs argument as the script path.
    const m = command.match(/([\w./\\-]+\.m?js)/)
    assert.ok(m, `cannot find a script path in ${event} hook: ${command}`)
    const scriptPath = path.join(ROOT, m[1])
    assert.ok(
      fs.existsSync(scriptPath),
      `${event} (${matcher}) is wired to "${m[1]}", which does not exist. ` +
        "That hook is silently not running.",
    )
  }
})

// The fact base has two doors: the Edit/Write tool path and the shell path.
// Both must be wired, and the shell one must be on BOTH shell tools.
test("both fact-base guards are wired, and the shell guard covers Bash AND PowerShell", () => {
  const settings = JSON.parse(
    fs.readFileSync(path.join(ROOT, ".claude", "settings.json"), "utf8"),
  )
  const pre = settings.hooks?.PreToolUse ?? []
  const commandsFor = (toolName) =>
    pre
      .filter((m) => String(m.matcher).split("|").includes(toolName))
      .flatMap((m) => (m.hooks ?? []).map((h) => h.command))
      .join(" ")

  // Edit/Write door.
  assert.match(
    commandsFor("Edit"),
    /protect-profile\.js/,
    "profile/ is unguarded on the Edit tool path",
  )
  // Shell door — a Bash call carries no file_path, so protect-profile.js never
  // sees it. This project uses both shell tools; guarding one is guarding none.
  for (const tool of ["Bash", "PowerShell"]) {
    assert.match(
      commandsFor(tool),
      /guard-profile-shell\.mjs/,
      `profile/ is unguarded on the ${tool} tool path`,
    )
  }
  // And it must be the copy agents cannot rewrite.
  assert.match(
    commandsFor("Bash"),
    /\.claude\/hooks\/guard-profile-shell\.mjs/,
    "the shell guard must be wired from .claude/hooks/ (agent-unwritable), " +
      "not from scripts/hooks/ where the agents it constrains could edit it",
  )
  // The git branch policy still has to be there too.
  assert.match(commandsFor("Bash"), /guard-bash\.mjs/)
})

test("the fake board and hostile fixtures are committable", (t) => {
  if (!gitAvailable()) {
    return t.skip("git is not on PATH, so ignore rules cannot be evaluated")
  }
  // Named explicitly so the check keeps meaning something if the walk above is
  // ever narrowed: these are the inputs the Phase 1 security gate depends on.
  const required = [
    "tests/fixtures/boards",
    "tests/fixtures/hostile",
    "tests/security",
  ]
  for (const rel of required) {
    const dir = path.join(ROOT, rel)
    if (!fs.existsSync(dir)) {
      // These land with qa-adversary's work; do not invent a pass for a
      // directory that is not here yet, but do not fail the whole suite on
      // ordering either — the security gate is what requires tests/security.
      t.diagnostic(`${rel} does not exist yet`)
      continue
    }
    const files = walk(dir).map((p) =>
      path.relative(ROOT, p).split(path.sep).join("/"),
    )
    const res = spawnSync("git", ["check-ignore", "--stdin"], {
      cwd: ROOT,
      input: files.join("\n"),
      encoding: "utf8",
    })
    assert.equal(
      res.stdout.trim(),
      "",
      `gitignored fixtures under ${rel}: ${res.stdout.trim()}`,
    )
  }
})
