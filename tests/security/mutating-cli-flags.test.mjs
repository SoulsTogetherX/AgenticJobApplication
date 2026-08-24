// A command that WRITES must not ignore what it was told.
//
// ===========================================================================
// THE INCIDENT, AND WHY THIS IS A SECURITY TEST
// ===========================================================================
//
// Measured 2026-08-24, auditing every CLI entry point under scripts/: 32 of 38
// silently ignored an unrecognised flag, and 11 of those performed a mutating
// side effect while doing so. The one that started it was
// `reverify.mjs --help`, which ignored the flag and ran a 61-job sweep writing
// a `verifications` row per stale document — a flag typed to ASK A QUESTION
// performed a write.
//
// Two of them could send real job applications on a single mistyped character:
//
//   * `cycle.mjs` gates the applier on `!argv.includes("--skip-apply")`, and
//     the user's 7:00 Windows task passes exactly that flag to PREPARE ONLY.
//     Any misspelling failed OPEN and the cycle submitted.
//   * `auto-apply.mjs` read `--enqueue` with `includes()`, so `--enqeue`
//     skipped enqueue-only mode and went straight to submitting; and
//     `--fixtur` left `assertFixtureIsolation` unarmed, pointing a fixture run
//     at the real lead store.
//
// A fail-open flag on a path that can act in the world is not a usability
// problem, which is why this lives in tests/security/ rather than beside the
// unit tests. The gate this file guards is: **the dangerous scripts refuse
// input they do not understand, and refuse it before doing anything.**
//
// SPAWNED, NOT IMPORTED. The property under test is what the PROCESS does with
// argv — importing the module would test something else entirely, and for
// several of these the import used to be the dangerous act.
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
)

// script -> a plausible NEAR-MISS of one of its real flags, and the real flag
// it is one edit away from. Near-misses on purpose: `--xyzzy` would be caught
// by any check at all, while `--dry-run` typed as `--dryrun` is the mistake a
// person actually makes, and it is the one that used to reach the write.
const DANGEROUS = [
  ["scripts/auto/cycle.mjs", "--skip-aply", "--skip-apply"],
  ["scripts/auto/auto-apply.mjs", "--enqeue", "--enqueue"],
  ["scripts/auto/auto-apply.mjs", "--fixtur", "--fixture"],
  ["scripts/maintenance/migrate.mjs", "--dryrun", "--dry-run"],
  ["scripts/documents/reverify.mjs", "--prune-orphan", "--prune-orphans"],
  ["scripts/apply/rebuild-plans.mjs", "--dryrun", "--dry-run"],
  ["scripts/leads/gate-audit.mjs", "--no-sav", "--no-save"],
  ["scripts/dev/scorecard.mjs", "--no-recrd", "--no-record"],
  ["scripts/leads/screen.mjs", "--no-recrd", "--no-record"],
  ["scripts/auto/requeue.mjs", "--lst", "--list"],
]

function run(script, args, env = {}) {
  return spawnSync(process.execPath, [path.join(ROOT, script), ...args], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, ...env },
  })
}

for (const [script, typo, real] of DANGEROUS) {
  test(`${script} refuses ${typo} instead of ignoring it`, () => {
    const r = run(script, [typo])
    assert.equal(
      r.status,
      2,
      `expected exit 2 (usage) from ${script} ${typo}, got ${r.status}.\n` +
        `stdout: ${String(r.stdout).slice(0, 300)}\n` +
        `stderr: ${String(r.stderr).slice(0, 300)}`,
    )
    const out = `${r.stdout}${r.stderr}`
    assert.match(out, /Unrecognised flag/, "the refusal must name the flag")
    assert.match(
      out,
      new RegExp(`Did you mean \\${real}\\?`),
      "a near-miss must suggest the real flag — a bare refusal gets worked " +
        "around, and working around it is how the write happened",
    )
    assert.match(
      out,
      /Nothing ran|Nothing was written/,
      "the refusal must say that nothing happened, so the user does not " +
        "assume a partial run",
    )
  })
}

test("every dangerous script answers --help without doing its work", () => {
  // `--help` is the canary: it is the flag someone types when they are NOT
  // sure what the command does, which is exactly when a write is least wanted.
  for (const [script] of DANGEROUS) {
    const r = run(script, ["--help"])
    assert.ok(
      r.status === 0 || r.status === 2,
      `${script} --help exited ${r.status}; it must print usage, not run`,
    )
    const out = `${r.stdout}${r.stderr}`
    assert.ok(out.trim().length > 0, `${script} --help printed nothing at all`)
  }
})

test("THE 7:00 TASK: a mistyped --skip-apply cannot start the applier", () => {
  // The single highest-consequence case in this file, asserted on its own so a
  // failure names itself. The registered Windows task passes --skip-apply; one
  // wrong character used to mean the prepare-only cycle submitted applications
  // unattended, with nothing in logs/cycle.log saying so.
  for (const typo of ["--skip-aply", "--skipapply", "--skip_apply"]) {
    const r = run("scripts/auto/cycle.mjs", [typo])
    assert.equal(r.status, 2, `cycle.mjs ${typo} must refuse, not run`)
    assert.doesNotMatch(
      `${r.stdout}`,
      /^search:/m,
      `cycle.mjs ${typo} started a stage before refusing`,
    )
  }
})

test("the cycle states its mode, so the log says whether it could submit", () => {
  // A prepare-only run and a submitting run used to produce identical logs;
  // the only way to tell them apart afterwards was to notice the ABSENCE of an
  // apply stage. Checked on the source because running a real cycle here would
  // sweep live boards.
  const src = fs.readFileSync(path.join(ROOT, "scripts/auto/cycle.mjs"), "utf8")
  assert.match(src, /mode: willApply \? "prepare\+apply" : "prepare-only"/)
  assert.match(src, /process\.stdout\.write\(`mode: \$\{out\.mode\}\\n`\)/)
})

test("migrate.mjs does not migrate when imported", () => {
  // It used to run the whole migration at module top level, so importing the
  // file for one of its helpers rebuilt the store.
  const probe = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "migrate-import-")),
    "probe.mjs",
  )
  const url = new URL(
    `file://${path.join(ROOT, "scripts/maintenance/migrate.mjs").replace(/\\/g, "/")}`,
  ).href
  fs.writeFileSync(
    probe,
    `await import(${JSON.stringify(url)})\nconsole.log("IMPORTED")\n`,
  )
  const r = spawnSync(process.execPath, [probe], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 60_000,
  })
  assert.match(String(r.stdout), /IMPORTED/)
  assert.doesNotMatch(
    String(r.stdout),
    /built .*leads\.db|applications:/,
    "importing migrate.mjs performed a migration",
  )
  fs.rmSync(path.dirname(probe), { recursive: true, force: true })
})
