// The local fake ATS itself. If this file is red, nothing else in
// tests/security/ means anything, because every other suite is reasoning about
// bytes this server produced.
//
// Run: node --test tests/security/fake-board.test.mjs
import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import {
  start,
  ROUTES,
  assertLoopback,
  ASHBY_NONCE,
} from "../fixtures/boards/server.mjs"
import { detectAts } from "../../src/apply/ats/index.mjs"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, "..", "..")

// One server for the whole file. Ephemeral port, read off the listener —
// never hardcoded, because CI runs legs in parallel and a fixed port is a
// flake waiting for a second job.
let board
test.before(async () => {
  board = await start()
})
test.after(async () => {
  await board?.stop()
})

test("binds an ephemeral loopback port the caller reads back", () => {
  assert.equal(board.host, "127.0.0.1")
  assert.ok(board.port > 0, "listen(0) must yield a real assigned port")
  assert.match(board.url, /^http:\/\/127\.0\.0\.1:\d+$/)
})

test("refuses to bind anything that is not loopback", () => {
  // The only thing that makes an attack corpus safe to keep in a repository is
  // that it can never be served to anyone. That is enforced, not remembered.
  for (const host of ["0.0.0.0", "192.168.1.10", "example.com", "::"]) {
    assert.throws(
      () => assertLoopback(host),
      /loopback-only/,
      `${host} must be refused`,
    )
  }
  for (const host of ["127.0.0.1", "::1", "localhost"]) {
    assert.doesNotThrow(() => assertLoopback(host))
  }
})

test("every declared route serves a page, and the route table is honest", async () => {
  assert.ok(
    ROUTES.length >= 9,
    `expected the full fixture set, got ${ROUTES.length}`,
  )
  for (const r of ROUTES) {
    assert.ok(fs.existsSync(r.file), `${r.name}: missing ${r.file}`)
    const res = await fetch(board.url + r.path)
    assert.equal(res.status, 200, `${r.name} did not serve`)
    assert.equal(res.headers.get("x-aj-fixture"), "local-fake-ats")
    const html = await res.text()
    assert.match(html, /<form/i, `${r.name} must actually contain a form`)
    assert.ok(r.proves.length > 10, `${r.name} must say what it proves`)
  }
})

test("the URL shape selects the adapter each fixture claims", () => {
  // Fidelity that matters: a replica whose URL does not route to the adapter it
  // is imitating tests the generic adapter and quietly proves nothing.
  for (const r of ROUTES) {
    assert.equal(
      detectAts(board.url + r.path).id,
      r.ats,
      `${r.name} (${r.path}) must be detected as ${r.ats}`,
    )
  }
})

test("FINDING (w2-engine): detectAts matches a substring of the WHOLE URL, so any board can impersonate any ATS", () => {
  // This is what lets the loopback fixture select a real adapter at all, and
  // it is the same property a hostile board gets for free. The adapter decides
  // combo strategies, file ordering and value aliases — so impersonating
  // Greenhouse changes what gets typed where, and impersonating Workday makes
  // the pipeline hand off instead of applying.
  //
  // Not a high-severity hole on its own (an adapter contributes knowledge, not
  // behaviour), but it is a third party choosing a code path, and it is
  // recorded here rather than left as folklore.
  // FIVE INDEPENDENT SPOOFS, EVALUATED TOGETHER. Written as five assert.equal
  // calls in series — which is what this was — fixing the first would abort the
  // test and hide the other four, and a reader would believe the class was
  // closed when one instance was.
  //
  // This one is a CHARACTERISATION test and says so: it pins the complete
  // current surface rather than a wanted behaviour, because the fake board
  // itself depends on this property (see the note in server.mjs — a loopback
  // fixture can only select a real adapter by carrying the host token in its
  // path). A partial fix therefore goes red and NAMES which spoofs changed,
  // which is the prompt to finish the job and re-cut the fixture URLs. A test
  // that quietly kept passing through a partial fix would be the masking this
  // is here to remove.
  // BASELINE re-measured 2026-07-31 after w2-engine narrowed HANDOFF to match
  // the URL's HOSTNAME. Both Workday spoofs are now dead; the three adapter
  // spoofs remain, because ADAPTERS still match the whole URL — which is what
  // lets this fake board select a real adapter from 127.0.0.1 at all.
  //
  // This test caught that change and named it, which is the point of writing
  // it as one set comparison instead of five serial asserts.
  const spoofs = [
    ["https://evil.example/apply?ref=boards.greenhouse.io", "greenhouse"],
    ["https://evil.example/jobs.lever.co/apply", "lever"],
    ["https://evil.example/#jobs.ashbyhq.com", "ashby"],
    // Dead since the HANDOFF narrowing. Kept so a regression is visible.
    ["https://evil.example/x?q=myworkdayjobs.com", "workday"],
    ["https://boards.greenhouse.io/x/jobs/1?utm=myworkdayjobs.com", "workday"],
  ]
  const EXPECTED_WORKING = [
    "greenhouse <- https://evil.example/apply?ref=boards.greenhouse.io",
    "lever <- https://evil.example/jobs.lever.co/apply",
    "ashby <- https://evil.example/#jobs.ashbyhq.com",
  ]
  const working = spoofs
    .filter(([url, impersonated]) => detectAts(url).id === impersonated)
    .map(([url, impersonated]) => `${impersonated} <- ${url}`)

  assert.deepEqual(
    working,
    EXPECTED_WORKING,
    "the set of working ATS impersonations changed. If a HANDOFF spoof came " +
      "back, that is a regression. If an ADAPTER spoof was fixed, " +
      "tests/fixtures/boards/server.mjs must stop putting the host token in " +
      "its route paths and the fixtures must select adapters another way",
  )
})

test("FINDING (w2-engine): a hostile board can force a Workday hand-off on a REAL posting", () => {
  // The one spoof above with a consequence, split out so it can be fixed
  // WITHOUT the fake board having to change: HANDOFF is checked before every
  // adapter, and it matches a substring of the whole URL. So any board — or
  // any tracking parameter appended to a genuine Greenhouse link — makes the
  // pipeline refuse to apply and tell the user to go do it themselves.
  //
  // Fail-safe rather than fail-dangerous, which is why it is one finding and
  // not five. It is still a third party deciding that an application does not
  // happen, and on the unattended path that is a silent denial of service
  // against the user's own job search.
  //
  // Narrow fix that does not touch adapter selection: match HANDOFF against
  // the URL's HOSTNAME only. The fake board's routes carry no Workday token,
  // so nothing here has to move.
  const real = detectAts(
    "https://boards.greenhouse.io/fixtureco/jobs/1?utm_source=myworkdayjobs.com",
  )
  assert.equal(
    real.id,
    "greenhouse",
    `a query parameter turned a Greenhouse posting into a ${real.id} hand-off` +
      (real.handoff ? " — the pipeline will refuse to apply" : ""),
  )
})

test("same URL, same bytes", async () => {
  for (const r of ROUTES) {
    const a = await (await fetch(board.url + r.path)).text()
    const b = await (await fetch(board.url + r.path)).text()
    assert.equal(a, b, `${r.name} is not deterministic`)
  }
})

test("Greenhouse serves TWO different pages at ONE URL", async () => {
  // This is why fill-plan.mjs's urlGuard cannot catch a stale scan: the URL is
  // byte-identical between steps. A GET is step 1; the POST that "Save and
  // Continue" performs is step 2.
  const url = board.pageUrl("greenhouse")
  const step1 = await (await fetch(url)).text()
  const step2 = await (await fetch(url, { method: "POST" })).text()

  assert.notEqual(step1, step2, "the two steps must differ in content")
  assert.match(step1, /Save and Continue/)
  assert.match(step1, /id="first_name"/)
  assert.doesNotMatch(step1, /Submit Application/)

  assert.match(step2, /Submit Application/)
  assert.match(step2, /id="linkedin"/)
  assert.doesNotMatch(step2, /id="first_name"/)

  // ?step=2 is the deterministic no-browser equivalent, for a plain fetch.
  const viaQuery = await (await fetch(url + "?step=2")).text()
  assert.equal(viaQuery, step2)
})

test("Ashby sends a nonce-based CSP with no unsafe-inline", async () => {
  // The reason the fill bootstrap loads by `filename` and injects with
  // page.evaluate + eval rather than page.addScriptTag({ path }): an injected
  // inline <script> is refused outright by this policy, which broke a live
  // application.
  const res = await fetch(board.pageUrl("ashby"))
  const csp = res.headers.get("content-security-policy")
  assert.ok(csp, "the Ashby replica must send a CSP")
  assert.match(csp, new RegExp(`script-src 'nonce-${ASHBY_NONCE}'`))
  assert.doesNotMatch(
    csp,
    /unsafe-inline/,
    "unsafe-inline would defeat the fixture",
  )

  const html = await res.text()
  assert.match(html, new RegExp(`<script nonce="${ASHBY_NONCE}"`))
  // A nonce-less inline script must be present, so a browser-based test can
  // prove the policy is ENFORCED rather than merely sent.
  assert.match(html, /window\.__ajCspProof/)
})

test("no other board sends a CSP", async () => {
  // Greenhouse and Lever do not, and a fixture that CSPs everything would hide
  // the one board where it matters.
  for (const name of ["greenhouse", "lever"]) {
    const res = await fetch(board.pageUrl(name))
    assert.equal(res.headers.get("content-security-policy"), null, name)
  }
})

test("path traversal out of the fixture directories is refused", async () => {
  const attempts = [
    "/postings/../../../package.json",
    "/scans/../../../../CLAUDE.md",
    "/postings/..%2f..%2f..%2fpackage.json",
    "/scans/%2e%2e/%2e%2e/%2e%2e/package.json",
  ]
  for (const a of attempts) {
    const res = await fetch(board.url + a)
    assert.equal(res.status, 404, `${a} must not resolve`)
    const body = await res.text()
    assert.doesNotMatch(
      body,
      /agentic-job-application/,
      `${a} leaked repo content`,
    )
  }
})

test("an unknown path 404s rather than falling through to a file", async () => {
  for (const p of ["/nope", "/greenhouse", "/hostile/", "/pages/ashby.html"]) {
    assert.equal((await fetch(board.url + p)).status, 404, p)
  }
})

test("the server contains no code path that reaches off this machine", () => {
  // "Nothing found" needs a method: this reads server.mjs and asserts the
  // absence of every outbound primitive. A fixture server that could proxy is
  // one config mistake away from sending traffic to a real employer.
  const src = fs.readFileSync(
    path.join(ROOT, "tests/fixtures/boards/server.mjs"),
    "utf8",
  )
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1")
  for (const forbidden of [
    /\bfetch\s*\(/,
    /\bhttps?\.request\s*\(/,
    /\bhttps?\.get\s*\(/,
    /\bnet\.connect\s*\(/,
    /child_process/,
    /\bproxy\b/i,
  ]) {
    assert.doesNotMatch(
      code,
      forbidden,
      `server.mjs must not contain ${forbidden}`,
    )
  }
})

test("postings and scans are served as JSON from the fixture tree", async () => {
  const posting = await fetch(board.url + "/postings/title-poisoning.json")
  assert.equal(posting.status, 200)
  const job = await posting.json()
  assert.equal(job.title, "Full-Stack Engineer (React, Kubernetes, Terraform)")

  const scan = await fetch(board.url + "/scans/greenhouse-step1.scan.json")
  assert.equal(scan.status, 200)
  assert.ok((await scan.json()).fields.length > 0)
})

test("routes.json matches the exported route table exactly", async () => {
  // bench-apply.mjs and a human read the same list, so it cannot drift from
  // what is actually served.
  const served = await (await fetch(board.url + "/routes.json")).json()
  assert.deepEqual(
    served.map((r) => r.path).sort(),
    ROUTES.map((r) => r.path).sort(),
  )
})

test("stop() releases the port", async () => {
  const tmp = await start()
  const { port } = tmp
  assert.equal((await fetch(tmp.url + "/routes.json")).status, 200)
  await tmp.stop()
  await assert.rejects(
    fetch(`http://127.0.0.1:${port}/routes.json`),
    "the port must be free after stop()",
  )
})
