// The counting stand-in for node:child_process. cp-spy.mjs's resolve hook
// points every importer here; this module's own import of the real builtin is
// let through by the hook's parentURL guard.
import real from "node:child_process"

const WRAPPED = [
  "spawn",
  "spawnSync",
  "exec",
  "execSync",
  "execFile",
  "execFileSync",
  "fork",
]

const wrap = (name) =>
  function (...args) {
    globalThis.__cpCalls.push({ kind: "call", fn: name })
    return real[name](...args)
  }

export const spawn = wrap("spawn")
export const spawnSync = wrap("spawnSync")
export const exec = wrap("exec")
export const execSync = wrap("execSync")
export const execFile = wrap("execFile")
export const execFileSync = wrap("execFileSync")
export const fork = wrap("fork")
export const ChildProcess = real.ChildProcess

const patched = { ...real }
for (const n of WRAPPED) patched[n] = wrap(n)
export default patched
