#!/usr/bin/env node
// PreToolUse hook (Bash|PowerShell): keep the user-owned fact base out of reach
// of a SHELL command. Sibling of .claude/hooks/protect-profile.js, which guards
// the Edit/Write tool path. Between them, profile/ has no unguarded writer.
//
// WHY THIS EXISTS — two real incidents on 2026-07-31, both accidents.
//
// protect-profile.js blocks Edit/Write to profile/*.yaml, and guard-bash.mjs
// guards Bash — but only for git branch policy. A shell command that wrote to
// the fact base therefore passed BOTH: the Edit guard never saw it (there is no
// file_path on a Bash call) and the Bash guard did not look. So
// `node scripts/profile/save-answer.mjs ...` was completely unguarded.
//
// Both incidents were the same typo. save-answer.mjs took `--file <path>` and
// SILENTLY IGNORED unknown flags, so an agent verifying the script's behaviour
// passed `--answers <tmpfile>`, the flag was dropped, the path fell through to
// the default, and test values landed in the REAL profile/answers.yaml stamped
// `source: user`. Four entries across the two incidents. One was a fabricated
// phone number saved under the label "Phone number" — which resolves OK on
// nearly every application form, and would have been typed into a real
// application as fact.
//
// save-answer.mjs now exits 2 on an unrecognised flag, which closes that
// specific typo. This hook closes the CLASS: no shell command reaches the fact
// base by accident, whatever any script does with its arguments.
//
// THE THREAT MODEL IS ACCIDENT, NOT A DETERMINED AGENT. Both incidents were
// agents doing legitimate verification work who never intended to touch the
// real file. So the rule is that writing to the real fact base must be
// something you SAY you are doing: `--user-approved` marks the one sanctioned
// path (the user approved this answer in chat), and a test writes to its own
// `--file`. Neither incident carried either, so both are denied here. A
// determined agent could pass the flag — that is what review and CLAUDE.md hard
// rule 2 are for, and no hook substitutes for them.
//
// READS STAY ALLOWED, deliberately and load-bearingly. Agents read the fact
// base constantly — keyword-coverage, answer-bank and verify-claims all do.
// Only write OPERATIONS are matched, never the mere mention of a path.
//
// KNOWN RESIDUALS, stated so nobody mistakes this for a wall:
//   - THIS FILE IS AGENT-EDITABLE. protect-profile.js only denies writes under
//     .claude/hooks/, and CLAUDE.md already records that the guards in
//     scripts/hooks/ are not agent-protected. Moving this file to
//     .claude/hooks/ and repointing the one line in .claude/settings.json makes
//     it self-protecting; that move needs the user, because the agent cannot
//     write there — which is the guard working.
//   - .claude/settings.json wires this hook and is not itself write-protected.
//   - An arbitrary compiled program that opens the file is only caught when its
//     command line names a profile path AND a write call (the `node -e` case).
//   - Fails OPEN on unparseable input, matching the sibling hook. A guard that
//     denied every shell command on a malformed payload would be worse.
//
// NOTE: no process.exit() after writing — on Windows, exiting immediately after
// console.log drops buffered pipe output, which silently disables the deny.
// protect-profile.js and guard-bash.mjs both carry this note; it was a real bug.

let raw = ""
process.stdin.on("data", (d) => (raw += d))
process.stdin.on("end", () => {
  let input = {}
  // Strip a UTF-8 BOM (PowerShell pipes add one) so parse never fails silently.
  try {
    input = JSON.parse(raw.replace(/^﻿/, ""))
  } catch {
    return
  }

  const cmd = String(input.tool_input?.command ?? "")
  if (!cmd.trim()) return

  // Normalise separators so a Windows path matches the same rules.
  const c = cmd.replace(/\\/g, "/")

  const deny = (reason) => {
    console.log(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: reason,
        },
      }),
    )
  }

  const OWNED =
    "profile/ is the user-owned fact base (CLAUDE.md hard rule 2). " +
    "Only the user decides what is true about them."

  // ---------------------------------------------------------------------
  // 1. The sanctioned writers, aimed at the DEFAULT fact base.
  //
  // save-answer.mjs and apply-profile.mjs are ALLOWED to write profile/ —
  // that is their job. What is not allowed is doing it without saying so.
  // ---------------------------------------------------------------------
  // The script must be EXECUTED, not merely named. Matching a bare mention
  // denied `grep -n ... scripts/profile/save-answer.mjs` within a minute of
  // this hook being written — reading a script is not writing the fact base.
  // guard-bash.mjs learned the identical lesson when it denied
  // `git branch --show-current`; an over-matching guard gets switched off.
  if (
    /\bnode(?:\.exe)?\b[^|;&]*\bscripts\/profile\/(?:save-answer|apply-profile)\.mjs/i.test(
      c,
    )
  ) {
    const hasExplicitFile = /(?:^|\s)--file[\s=]/.test(c)
    const hasApproval = /(?:^|\s)--user-approved(?:[\s=]|$)/.test(c)
    if (!hasExplicitFile && !hasApproval) {
      return deny(
        `This writes the REAL fact base, and says neither that it is a test nor that the user approved it. ${OWNED}\n` +
          "  - testing?       add `--file <temp path>` so it cannot touch profile/\n" +
          "  - user said yes? add `--user-approved`, only after they approved it in chat\n" +
          "Two agents wrote fabricated answers into the real file on 2026-07-31 with " +
          "exactly this shape of command. One was a phone number that would have been " +
          "typed into a real application as fact.",
      )
    }
    return
  }

  // ---------------------------------------------------------------------
  // 2. Raw shell writes to a profile path.
  //
  // Matched as OPERATIONS, never as a bare mention, so reads stay allowed.
  // ---------------------------------------------------------------------
  const namesProfile =
    /(?:^|[\s"'=(,;|&>])(?:[^\s"']*\/)?profile\/(?:profile|answers|applications)\.yaml/i.test(
      c,
    ) || /(?:^|[\s"'=(,;|&>])(?:[^\s"']*\/)?profile\/source\//i.test(c)
  if (!namesProfile) return

  // Redirection into a profile path: `> profile/answers.yaml`, `>>`, `1>`.
  if (/\d?>>?\s*(?:"|')?(?:[^\s"']*\/)?profile\//i.test(c)) {
    return deny(
      `Shell redirection into the fact base. ${OWNED} Ask the user to make the change.`,
    )
  }

  // POSIX mutators. `cp`/`mv` match on a profile path appearing anywhere,
  // because it is the DESTINATION that matters and quoting makes
  // last-argument parsing unreliable. Copying OUT of profile/ for a backup is
  // rare enough that an explained denial beats a silent overwrite.
  if (
    /\b(?:rm|mv|cp|tee|truncate|shred|dd|install)\b/i.test(c) ||
    /\bsed\b[^|;&]*\s-i/i.test(c) ||
    /\bperl\b[^|;&]*\s-i/i.test(c)
  ) {
    return deny(
      `A shell command that writes, moves or deletes files names a profile path. ${OWNED} Ask the user to make the change.`,
    )
  }

  // PowerShell mutators.
  if (
    /\b(?:Set-Content|Add-Content|Out-File|Clear-Content|Remove-Item|Move-Item|Copy-Item|New-Item|Set-ItemProperty)\b/i.test(
      c,
    )
  ) {
    return deny(
      `A PowerShell cmdlet that writes or removes files names a profile path. ${OWNED} Ask the user to make the change.`,
    )
  }

  // Inline programs that both name a profile path and call a write API.
  // Catches `node -e "fs.writeFileSync('profile/answers.yaml', ...)"`.
  if (
    /\b(?:writeFileSync|appendFileSync|createWriteStream|writeFile|appendFile|truncateSync|unlinkSync|rmSync|renameSync|copyFileSync)\b/i.test(
      c,
    ) &&
    /\bnode\b|\bpython3?\b|\bdeno\b|\bbun\b/i.test(c)
  ) {
    return deny(
      `An inline program names a profile path and calls a file-write API. ${OWNED} ` +
        "Use save-answer.mjs with `--user-approved` after the user approves, or `--file <temp path>` for a test.",
    )
  }
})
