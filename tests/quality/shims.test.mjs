// Gate #16: shim parity, for as long as the shims live.
//
// Four paths in scripts/ are pinned by something this repo cannot edit:
// .claude/settings.json wires the three hook paths and is the user's file
// alone, and the Windows Scheduled Task invokes scripts\auto\cycle.cmd by
// absolute path at 07:00 daily. Until the user repoints both, the shims sit
// ON THE GUARDRAIL PATH — a `guard-bash` shim that silently did nothing would
// disarm the branch protection hook and every run would look normal.
//
// THAT IS NOT HYPOTHETICAL. A naive re-export shim
// (`export * from "../../src/hooks/guard-bash.mjs"`) runs NOTHING and exits 0,
// because the target's entry-point guard compares process.argv[1] against its
// own path and decides it was merely imported. Measured 2026-08-27. The
// working shim rewrites process.argv[1] BEFORE the dynamic import, and the
// only way to know it still does is to run both and compare.
//
// So: identical stdin to the shim and to the real file, then assert equal exit
// codes AND equal stdout. stdout is the hook protocol channel — the
// deprecation notice goes to stderr, and the third assertion checks that the
// notice is there, on stderr, where it cannot corrupt a hook decision.
//
// Delete this file when the shims are deleted, not before.
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { ROOT } from "./helpers/bins.mjs"

// Each probe is chosen so the hook must DO something observable — deny, or
// mutate a file. QA-1 (2026-08-27) proved the original design vacuous: it fed
// an ALLOWED command, and a hook that runs NO logic also allows (empty
// stdout, exit 0), so a two-line no-op shim that kept the "[shim]" banner
// passed all four tests while branch protection was silently gone. The
// original comment argued the opposite ("an allow decision is only produced
// by the hook running its logic to the end") and was exactly backwards.
//
// Each probe therefore asserts THREE things: the REAL hook produces the
// expected guarded outcome (so the guard itself has not rotted), the shim
// reproduces it byte-for-byte on the protocol channel, and the shim announces
// itself on stderr only.
const DENY_PROBES = {
  "guard-bash": {
    input: JSON.stringify({
      tool_name: "Bash",
      tool_input: { command: "git checkout main" },
    }),
    expectWhy:
      "branch protection must DENY a main checkout (hard rule 7); an empty " +
      "response means the hook never ran its logic",
  },
  "guard-files": {
    input: JSON.stringify({
      tool_name: "Write",
      tool_input: { file_path: "C:\\Windows\\shim-parity-probe.txt" },
      cwd: ROOT,
    }),
    expectWhy:
      "the filesystem boundary must DENY a write outside the project " +
      "(hard rule 9); an empty response means the hook never ran its logic",
  },
}

function runNode(rel, input) {
  const res = spawnSync(process.execPath, [path.join(ROOT, rel)], {
    cwd: ROOT,
    input,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  })
  return {
    status: res.status,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  }
}

for (const [name, probe] of Object.entries(DENY_PROBES)) {
  test(`scripts/hooks/${name}.mjs forwards a real DENY, not a vacuous allow`, () => {
    const real = runNode(`src/hooks/${name}.mjs`, probe.input)
    const shim = runNode(`scripts/hooks/${name}.mjs`, probe.input)

    // 1. Non-vacuity: the real hook still guards. If THIS fails, the shim is
    //    not the problem — the guard itself stopped denying.
    assert.match(
      real.stdout,
      /deny/i,
      `src/hooks/${name}.mjs did not deny the probe. ${probe.expectWhy}.\n` +
        `real stdout: ${JSON.stringify(real.stdout)}`,
    )

    // 2. Parity on the protocol channel and the exit code.
    assert.equal(
      shim.status,
      real.status,
      `exit code differs: shim ${shim.status} vs real ${real.status}.\n` +
        `shim stderr: ${shim.stderr}\nreal stderr: ${real.stderr}`,
    )
    assert.equal(
      shim.stdout,
      real.stdout,
      `stdout differs, and stdout is the hook protocol channel — a ` +
        `difference here is a different permission decision.\n` +
        `shim: ${JSON.stringify(shim.stdout)}\n` +
        `real: ${JSON.stringify(real.stdout)}`,
    )

    // 3. The forwarding must announce itself, on stderr only.
    assert.match(
      shim.stderr,
      /\[shim\]/,
      "the shim did not announce itself on stderr",
    )
    assert.ok(
      !shim.stdout.includes("[shim]"),
      "the deprecation notice reached stdout, where a hook consumer parses JSON",
    )
  })
}

test("scripts/hooks/prettify.mjs actually formats through the shim", () => {
  // prettify has no deny path, so its non-vacuous probe is the side effect:
  // feed it a misformatted file and demand the bytes change. A no-op shim
  // leaves the file ugly (measured in the QA pass). logs/ is gitignored,
  // inside the repo, and not asserted by the structure gate, so a transient
  // probe file here cannot race a concurrently running test.
  const probeAbs = path.join(ROOT, "logs", "prettify-shim-probe.mjs")
  const ugly = "const   a=1;;\n"
  fs.mkdirSync(path.dirname(probeAbs), { recursive: true })
  try {
    const payload = JSON.stringify({
      tool_name: "Write",
      tool_input: { file_path: probeAbs },
      cwd: ROOT,
    })

    fs.writeFileSync(probeAbs, ugly)
    const shim = runNode("scripts/hooks/prettify.mjs", payload)
    const viaShim = fs.readFileSync(probeAbs, "utf8")
    assert.notEqual(
      viaShim,
      ugly,
      "the file came back byte-identical: the shim never ran prettify " +
        "(the exact no-op failure QA-1 demonstrated)",
    )

    fs.writeFileSync(probeAbs, ugly)
    const real = runNode("src/hooks/prettify.mjs", payload)
    const viaReal = fs.readFileSync(probeAbs, "utf8")
    assert.equal(
      viaShim,
      viaReal,
      "shim and real hook formatted the same input differently",
    )
    assert.equal(shim.status, real.status, "exit codes differ")
    assert.match(
      shim.stderr,
      /\[shim\]/,
      "the shim did not announce itself on stderr",
    )
  } finally {
    fs.rmSync(probeAbs, { force: true })
  }
})

test("scripts/auto/cycle.cmd forwards exit codes from src/auto/cycle.cmd", (t) => {
  if (process.platform !== "win32") {
    return t.skip(
      "cmd.exe exists only on Windows; the Scheduled Task this shim serves is Windows-only",
    )
  }
  // A deliberately bogus flag. cycle.mjs refuses unknown flags with exit 2
  // rather than ignoring them, and its own message says why: "the applier
  // runs unless --skip-apply is spelled exactly, so a typo here submits
  // applications". That refusal is what makes this probe safe — the cycle
  // does not run, nothing is searched, nothing is applied to, no browser
  // opens — AND it is a nonzero code, so it proves the .cmd propagates
  // %ERRORLEVEL% instead of swallowing it.
  //
  // NOTE: cycle.cmd logs unconditionally, so this test appends two entries to
  // logs/cycle.log per run. That is accepted: logs/ is gitignored and machine
  // local, and the entries are honest records of two real invocations.
  // Arguments are passed as separate argv entries, never concatenated into one
  // quoted string: node spawns cmd.exe directly (no shell), so nothing gets a
  // second chance to re-parse them.
  const runWithFlag = (rel) =>
    spawnSync(
      "cmd.exe",
      ["/c", rel.split("/").join("\\"), "--parity-probe-bogus"],
      { cwd: ROOT, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
    )

  const shim = runWithFlag("scripts/auto/cycle.cmd")
  const real = runWithFlag("src/auto/cycle.cmd")

  assert.equal(
    real.status,
    2,
    `src/auto/cycle.cmd exited ${real.status} for an unknown flag; expected 2. ` +
      `cycle.mjs refuses unrecognised flags on purpose — if that refusal is ` +
      `gone, a typo like --skip-aply runs the applier.`,
  )
  assert.equal(
    shim.status,
    2,
    `the shim exited ${shim.status} where the real file exited ${real.status}. ` +
      `A batch wrapper that does not end with \`exit /b %ERRORLEVEL%\` reports ` +
      `success for a failed cycle, and the 07:00 Scheduled Task calls THIS path.`,
  )
})
