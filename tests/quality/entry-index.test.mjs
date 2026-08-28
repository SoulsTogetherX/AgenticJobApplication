// Entry-point discoverability: 97 runnable scripts existed and package.json
// named 6 of them; everything else was findable only by walking the tree.
// The rule this pins: every script a human can invoke appears in the command
// catalogue, and the catalogue cannot silently rot because this test
// enumerates by SCANNING, not by reading the doc it checks (the same reason
// the args source-scan guard exists — an audit that enumerates by reading
// finds what it read).
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
const CATALOGUE = fs.readFileSync(
  path.join(ROOT, "docs", "operate", "01-commands.md"),
  "utf8",
)

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) yield* walk(p)
    else yield p
  }
}

// A script is an ENTRY POINT when it carries the repo's main-guard idiom —
// comparing import.meta.url against argv[1]. Pure library modules do not.
function isEntryPoint(file) {
  const src = fs.readFileSync(file, "utf8")
  return src.includes("import.meta.url") && src.includes("process.argv[1]")
}

test("every runnable script appears in docs/operate/01-commands.md", () => {
  const roots = [path.join(ROOT, "src"), path.join(ROOT, "scripts", "profile")]
  const missing = []
  for (const root of roots) {
    for (const f of walk(root)) {
      if (!f.endsWith(".mjs")) continue
      if (!isEntryPoint(f)) continue
      const rel = path.relative(ROOT, f).split(path.sep).join("/")
      const base = path.basename(f)
      // Named by full path or by basename — the catalogue uses both forms.
      if (!CATALOGUE.includes(rel) && !CATALOGUE.includes(base))
        missing.push(rel)
    }
  }
  assert.deepEqual(
    missing,
    [],
    `runnable scripts not in the command catalogue (add a section or index ` +
      `row to docs/operate/01-commands.md): ${missing.join(", ")}`,
  )
})

test("the catalogue does not name scripts that no longer exist", () => {
  // The reverse direction: a documented command whose file is gone sends a
  // reader (or an agent) to a dead path. Scan the doc's fenced `node <path>`
  // invocations and demand each file exists.
  const RE = /node\s+((?:src|scripts|tools)\/[A-Za-z0-9_./-]+\.(?:mjs|cjs))/g
  const dead = []
  for (const m of CATALOGUE.matchAll(RE)) {
    if (!fs.existsSync(path.join(ROOT, m[1]))) dead.push(m[1])
  }
  assert.deepEqual(
    dead,
    [],
    `01-commands.md documents commands whose script is gone: ${[...new Set(dead)].join(", ")}`,
  )
})
