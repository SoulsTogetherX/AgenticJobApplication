// FORWARDING SHIM — the real hook moved to src/hooks/guard-files.mjs in the
// 2026-08-27 re-layout. This path survives because the user-sealed
// .claude/settings.json wires the hook here; delete this file only after the
// user repoints that wiring to src/hooks/. process.argv[1] is rewritten
// BEFORE the import so the target's entry-point guard sees itself as
// directly invoked — a bare re-export shim runs nothing and exits 0
// (measured 2026-08-27). stdin, stdout and the exit code pass through
// untouched; the notice below goes to stderr, never stdout, because stdout
// is the hook protocol channel.
import { fileURLToPath } from "node:url"
const target = new URL("../../src/hooks/guard-files.mjs", import.meta.url)
process.argv[1] = fileURLToPath(target)
process.stderr.write("[shim] scripts/hooks/guard-files.mjs -> src/hooks/\n")
await import(target.href)
