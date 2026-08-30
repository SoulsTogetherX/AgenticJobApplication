// Gate #16: shim parity, for as long as the shims live.
//
// THREE paths in scripts/ are pinned by something this repo cannot edit:
// .claude/settings.json wires the three hook paths and is the user's file
// alone. (A fourth, scripts\auto\cycle.cmd, served the Windows Scheduled Task
// until the user repointed it on 2026-08-28; that shim is gone.) Until the
// user repoints the hooks too, these shims sit ON THE GUARDRAIL PATH — a
// `guard-bash` shim that silently did nothing would disarm the branch
// protection hook and every run would look normal.
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
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { ROOT, trackedFiles } from "./helpers/bins.mjs"

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
      // OUTSIDE THE PROJECT, ON WHATEVER PLATFORM THIS RUNS. The filesystem
      // root is the one place guaranteed to be outside both the repo and
      // os.tmpdir(), which guard-files exempts on purpose.
      //
      // This was a literal C: path, which is a WINDOWS-ONLY absolute path:
      // on Linux it is a RELATIVE filename, so resolving it against cwd
      // lands INSIDE the project, guard-files correctly does not deny, and
      // the test failed on CI while passing on the machine that wrote it
      // (2026-08-30). A cross-platform probe must never hardcode one
      // platform's idea of "absolute".
      tool_input: {
        file_path: path.join(path.parse(ROOT).root, "aj-shim-parity-probe.txt"),
      },
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

// The scripts/auto/cycle.cmd SHIM was deleted 2026-08-28, the same hour the
// user repointed the Scheduled Task to src\auto\cycle.cmd. What the shim's
// parity test was really protecting outlives it, so it is kept below and
// aimed at the real file: the task now invokes THAT path directly, from a
// working directory it chooses, and a wrapper that swallows a failure code
// reports a broken cycle as a success.
test("src/auto/cycle.cmd refuses an unknown flag with exit 2, from a foreign cwd", (t) => {
  if (process.platform !== "win32") {
    return t.skip(
      "cmd.exe exists only on Windows; the Scheduled Task this serves is Windows-only",
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
  // cwd is os.tmpdir(), NOT the repo: the registered task has no "Start In"
  // directory, so it runs from wherever the scheduler puts it, and the only
  // thing that makes the repo root resolvable is cycle.cmd's own %~dp0. A
  // probe run from the repo would pass even if that self-location broke.
  //
  // NOTE: cycle.cmd logs unconditionally, so this appends one entry pair to
  // logs/cycle.log per run. Accepted: logs/ is gitignored and machine-local,
  // and the entries are honest records of a real invocation.
  const res = spawnSync(
    "cmd.exe",
    ["/c", path.join(ROOT, "src", "auto", "cycle.cmd"), "--parity-probe-bogus"],
    { cwd: os.tmpdir(), encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  )
  assert.equal(
    res.status,
    2,
    `src/auto/cycle.cmd exited ${res.status} for an unknown flag; expected 2. ` +
      `Either cycle.mjs stopped refusing unrecognised flags (a typo like ` +
      `--skip-aply then RUNS the applier), or the wrapper stopped propagating ` +
      `%ERRORLEVEL% and every failed 07:00 cycle now reports success.\n` +
      `stdout: ${res.stdout}\nstderr: ${res.stderr}`,
  )
})

test("every batch file is CRLF — cmd.exe parses by byte offset", () => {
  // Measured 2026-08-28. .gitattributes forces `* text=auto eol=lf`, which
  // gave src/auto/cycle.cmd 38 bare LFs and zero CRLFs. cmd.exe lost sync
  // inside the REM header and executed the word REGISTERING as a command,
  // printing "is not recognized" into logs/cycle.log on EVERY run of the
  // 07:00 task. The cycle still exited 0 — which is exactly why it survived
  // unnoticed for a day. A bare-LF batch file is silent damage until a
  // comment edit shifts the parse onto a line that matters.
  //
  // The fix is the `*.cmd text eol=crlf` rule in .gitattributes; this is the
  // assertion that keeps it, because the blanket LF rule above it looks more
  // authoritative than it is.
  const offenders = []
  for (const rel of trackedFiles("src", "scripts", "tools")) {
    if (!/\.(cmd|bat)$/i.test(rel)) continue
    const buf = fs.readFileSync(path.join(ROOT, rel))
    let bare = 0
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] === 0x0a && (i === 0 || buf[i - 1] !== 0x0d)) bare++
    }
    if (bare > 0) offenders.push(`${rel} has ${bare} bare LF line ending(s)`)
  }
  assert.deepEqual(
    offenders,
    [],
    `${offenders.join("; ")}\nAdd the extension to .gitattributes' eol=crlf ` +
      `rule and re-checkout. cmd.exe requires CRLF; with LF it silently ` +
      `mis-parses and runs comment text as commands.`,
  )
})
