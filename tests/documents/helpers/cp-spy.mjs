// A monkeypatched `node:child_process` that counts every call, plus the loader
// hook that puts it in front of the real one.
//
// Two files would be tidier and would not work: `registerHooks` must run before
// anything in the graph under test resolves `node:child_process`, so the
// registration has to be a module the test imports FIRST — static imports
// evaluate in source order — and the shim it redirects to has to be able to
// reach the real module without the hook catching it again. The `parentURL`
// guard below is what breaks that recursion.
//
// Why not just patch the namespace object: for a builtin, Node builds the ESM
// facade once from the CJS exports, so `cp.spawnSync = fn` after the fact is
// invisible to `import { spawnSync }`. Verified: the interception count stayed
// at 0. The loader hook is the only thing that actually intercepts.
import { registerHooks } from "node:module"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SHIM = pathToFileURL(path.join(HERE, "cp-shim.mjs")).href

globalThis.__cpCalls = []

registerHooks({
  resolve(spec, ctx, next) {
    if (
      (spec === "child_process" || spec === "node:child_process") &&
      ctx.parentURL !== SHIM
    ) {
      globalThis.__cpCalls.push({ kind: "resolve", from: ctx.parentURL })
      return { url: SHIM, shortCircuit: true }
    }
    return next(spec, ctx)
  },
})

/** Calls and resolutions seen since the last reset. */
export const cpCalls = () => globalThis.__cpCalls
export const resetCpCalls = () => {
  globalThis.__cpCalls = []
}
