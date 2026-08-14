// The post-click classifier's corpus test (§4.10, Phase 5 W2).
//
// Two jobs, and the second one is the reason this file is worth reading:
//
//   1. Every page in the corpus classifies to its declared kind. Ordinary.
//   2. The corpus SAYS WHAT IT DOES NOT CONTAIN. §4.10 requires REAL
//      confirmation, identity-verification, bot-challenge, email-code, error
//      and not-a-confirmation pages, captured from attended applies. This
//      repository has none. A suite that tested only the fixture pages would go
//      green and read as "the classifier works", when what it actually
//      established is "the classifier recognises pages we wrote ourselves".
//
// So the coverage test below reports the gap by name and by kind. It is a
// `skip` with a stated reason rather than a silent pass, matching how this
// suite already reports advance.mjs's unbuilt assertion — an outstanding check
// must read as outstanding, never as satisfied.
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import {
  classify,
  visibleText,
  isFixtureUrl,
  ruleApplies,
  shippedRules,
  capturedKinds,
  CLASSIFICATIONS,
  CHALLENGE_KINDS,
} from "../../scripts/auto/classify.mjs"
import { POST_SUBMIT_KINDS } from "../fixtures/boards/server.mjs"
import {
  readManifest,
  CORPUS_DIR,
  CORPUS_MANIFEST,
} from "../../scripts/apply/capture-post-submit.mjs"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PAGES = path.resolve(
  HERE,
  "..",
  "fixtures",
  "boards",
  "pages",
  "post-submit",
)

// A loopback URL shaped exactly like the one the fixture serves, so the
// fixture-scoping rule is exercised rather than bypassed.
const fixtureUrl = (kind) => `http://127.0.0.1:8123/fixture-submit/${kind}`
const page = (kind) => fs.readFileSync(path.join(PAGES, `${kind}.html`), "utf8")

// The declared expectation for each fixture page. `not-a-confirmation` is the
// control and expects `unclassified` — the one hard STOP, and the correct
// outcome for a page nothing understood.
const EXPECTED = new Map([
  ["confirmation", "confirmation"],
  ["bot-challenge", "bot-challenge"],
  ["email-code-challenge", "email-code-challenge"],
  ["identity-verification", "identity-verification"],
  ["posting-gone", "posting-gone"],
  ["error", "error"],
  ["not-a-confirmation", "unclassified"],
])

// --- the corpus ---------------------------------------------------------------

test("every fixture post-submit page classifies to its declared kind", () => {
  for (const kind of POST_SUBMIT_KINDS) {
    const got = classify(fixtureUrl(kind), page(kind))
    assert.equal(
      got.kind,
      EXPECTED.get(kind),
      `${kind}.html classified as ${got.kind} (${got.why})`,
    )
  }
})

test("the corpus covers every kind the classifier can return", () => {
  // A kind with no sample is a kind nothing has ever tested. Catching that here
  // is cheaper than catching it on the page that produces it.
  const covered = new Set([...EXPECTED.values()])
  for (const kind of CLASSIFICATIONS)
    assert.ok(covered.has(kind), `no corpus sample expects ${kind}`)
})

test("the CONTROL page does not read as a confirmation", () => {
  // Called out separately from the loop because it is the assertion that would
  // matter most on the day a rule is loosened. This page thanks the reader,
  // mentions their interest AND the word "application", and is not a receipt.
  const got = classify(
    fixtureUrl("not-a-confirmation"),
    page("not-a-confirmation"),
  )
  assert.equal(got.kind, "unclassified")
  assert.equal(got.rule, null, "and no rule claimed it")
})

// --- what the corpus does NOT have --------------------------------------------

test("every PROMOTED capture classifies to the kind the user promoted it as", () => {
  // §4.10's "a test asserts the correct typed outcome for each", over the real
  // corpus. It runs zero times today because the corpus is empty — which is why
  // the count is asserted against the manifest rather than left implicit. A
  // loop that silently iterated nothing would report coverage it does not have,
  // the same failure `npm test`'s count gate exists for.
  const manifest = readManifest(CORPUS_MANIFEST)
  let checked = 0
  for (const s of manifest.samples) {
    const html = fs.readFileSync(path.join(CORPUS_DIR, s.file), "utf8")
    const got = classify(s.url, html)
    assert.equal(
      got.kind,
      s.kind,
      `${s.id} was promoted as ${s.kind} but classifies as ${got.kind} (${got.why})`,
    )
    checked += 1
  }
  assert.equal(checked, manifest.samples.length)
})

test("REAL captured pages, one per kind (§4.10's actual requirement)", (t) => {
  const have = capturedKinds()
  const need = CLASSIFICATIONS.filter((k) => k !== "unclassified")
  const missing = need.filter((k) => !have.includes(k))

  if (missing.length) {
    t.skip(
      `no captured post-submit page for: ${missing.join(", ")} — W2 is GATED ` +
        `on this and it is not a code gap. The only lawful source is an ` +
        `attended apply: run apply-job, and after the submit click ` +
        `scripts/apply/capture-post-submit.mjs stages a redacted candidate for ` +
        `review. Until then every real board classifies as \`unclassified\`, ` +
        `which hard-STOPs — the safe direction, and the honest one.`,
    )
    return
  }
  assert.deepEqual(missing, [])
})

test("a fixture-sourced rule can NEVER fire on a real board", () => {
  // THE GUARANTEE THAT MAKES THE FIXTURE PAGES SAFE TO SHIP. Without it, this
  // repository's idea of what a confirmation says becomes a decision about a
  // real employer — §4.6's forbidden guess with the model removed and our
  // imagination left in, failing silently in the direction that loses an
  // application.
  for (const rule of shippedRules()) {
    if (rule.evidence.source !== "fixture") continue
    for (const live of [
      "https://boards.greenhouse.io/acme/jobs/1",
      "https://jobs.lever.co/acme/abc/apply",
      "https://jobs.ashbyhq.com/acme/xyz",
      "https://careers.example.com/apply",
    ])
      assert.equal(
        ruleApplies(rule, live),
        false,
        `${rule.id} must not apply to ${live}`,
      )
  }
})

test("a real board with NO captures is unclassified, and says why", () => {
  // The corollary, asserted behaviourally rather than inferred from the rule
  // table: feed a capture-less host the fixture's own confirmation bytes and
  // it still refuses to call it a confirmation. boards.greenhouse.io is the
  // sharpest host for this — same vendor, one label away from the evidenced
  // job-boards.greenhouse.io, and still blind.
  const got = classify(
    "https://boards.greenhouse.io/acme/jobs/1",
    page("confirmation"),
  )
  assert.equal(got.kind, "unclassified")
  assert.match(
    got.why,
    /no captured post-submit page for boards\.greenhouse\.io/,
  )
})

// --- the capture-sourced rules (first promotions 2026-08-13) -------------------

const captureRules = () =>
  shippedRules().filter((r) => r.evidence.source === "capture")

const corpusSample = (id) => {
  const manifest = readManifest(CORPUS_MANIFEST)
  const s = manifest.samples.find((x) => x.id === id)
  assert.ok(s, `corpus sample ${id} exists`)
  return { ...s, html: fs.readFileSync(path.join(CORPUS_DIR, s.file), "utf8") }
}

test("a capture rule fires ONLY on its evidenced hosts", () => {
  const rules = captureRules()
  assert.ok(rules.length >= 3, "the promoted rules exist")
  const foreign = [
    "https://boards.greenhouse.io/acme/jobs/1",
    "https://jobs.lever.co/acme/abc/apply",
    "https://careers.example.com/apply",
    "http://127.0.0.1:8123/fixture-submit/confirmation",
  ]
  for (const rule of rules) {
    for (const h of rule.evidence.hosts)
      assert.equal(
        ruleApplies(rule, `https://${h}/x/y`),
        true,
        `${rule.id} applies on its own host ${h}`,
      )
    for (const live of foreign) {
      const host = new URL(live).hostname
      if (rule.evidence.hosts.includes(host)) continue
      assert.equal(
        ruleApplies(rule, live),
        false,
        `${rule.id} must not apply to ${live}`,
      )
    }
  }
})

test("a REAL confirmation's bytes on an unevidenced host stay unclassified", () => {
  // The sharpest poisoning case: genuine confirmation HTML, wrong host. If
  // this ever passes as `confirmation`, host scoping is broken and a page
  // served by anybody could record an application.
  const s = corpusSample("greenhouse-250b54c4a7f1")
  for (const live of [
    "https://boards.greenhouse.io/acme/jobs/1",
    "https://jobs.lever.co/acme/abc/apply",
  ])
    assert.equal(classify(live, s.html).kind, "unclassified", live)
})

test("the capture confirmation rules need BOTH signals", () => {
  // Strip one of the two signals from a real capture and it must fall back to
  // unclassified on its own host — a single phrase is how a thanks-but-closed
  // page becomes a recorded application.
  const gh = corpusSample("greenhouse-250b54c4a7f1")
  assert.equal(classify(gh.url, gh.html).kind, "confirmation")
  assert.equal(
    classify(gh.url, gh.html.replace(/back to job post/gi, "")).kind,
    "unclassified",
    "greenhouse without the navigation signal",
  )
  assert.equal(
    classify(gh.url, gh.html.replace(/thank you for applying/gi, "")).kind,
    "unclassified",
    "greenhouse without the thank-you signal",
  )

  const ab = corpusSample("ashby-2eb1b029f99d")
  assert.equal(classify(ab.url, ab.html).kind, "confirmation")
  assert.equal(
    classify(
      ab.url,
      ab.html.replace(/application was successfully submitted/gi, ""),
    ).kind,
    "unclassified",
    "ashby without the submitted signal",
  )
})

test("the email-code capture outranks confirmation wording on the same page", () => {
  // The ordering property, on the capture side this time: a page demanding an
  // emailed code did NOT submit anything, however warmly it thanks the
  // applicant further down.
  const code = corpusSample("greenhouse-c894c4c48db0")
  const conf = corpusSample("greenhouse-250b54c4a7f1")
  const got = classify(code.url, code.html + conf.html)
  assert.equal(got.kind, "email-code-challenge")
  assert.equal(got.rule, "capture-greenhouse-email-code")
})

test("capture rules cite samples the manifest holds and hosts the manifest backs", () => {
  // The rule table and the corpus must never drift apart: every cited sample
  // id exists, and every host a rule may fire on is a host the user's own
  // promoted captures actually came from.
  const manifest = readManifest(CORPUS_MANIFEST)
  const byId = new Map(manifest.samples.map((s) => [s.id, s]))
  for (const rule of captureRules()) {
    const cited = [rule.evidence.sample, ...(rule.evidence.samples ?? [])]
    assert.ok(cited.length > 0, `${rule.id} cites at least one sample`)
    const backedHosts = new Set()
    for (const id of cited) {
      const s = byId.get(id)
      assert.ok(s, `${rule.id} cites ${id}, which the manifest holds`)
      assert.equal(
        s.kind,
        rule.kind,
        `${rule.id} cites ${id} whose promoted kind matches the rule's`,
      )
      for (const h of s.hosts ?? []) backedHosts.add(h.toLowerCase())
    }
    for (const h of rule.evidence.hosts)
      assert.ok(
        backedHosts.has(h.toLowerCase()),
        `${rule.id} may fire on ${h} only because a cited capture came from it`,
      )
  }
})

test("every promoted greenhouse confirmation carries the rule's two signals", () => {
  // Pins the measured claim the rule's comment makes: the thank-you and the
  // navigation are present on ALL ten, whatever each employer's received-
  // wording says. If a future capture breaks this, the rule needs remeasuring,
  // not loosening.
  const manifest = readManifest(CORPUS_MANIFEST)
  const ghConfirmations = manifest.samples.filter(
    (s) =>
      s.kind === "confirmation" &&
      (s.hosts ?? []).includes("job-boards.greenhouse.io"),
  )
  assert.ok(ghConfirmations.length >= 10, "the ten promotions are present")
  for (const s of ghConfirmations) {
    const t = visibleText(
      fs.readFileSync(path.join(CORPUS_DIR, s.file), "utf8"),
    )
    assert.match(t, /thank you for applying/i, s.id)
    assert.match(t, /back to job post/i, s.id)
  }
})

test("ruleApplies fails CLOSED on anything it cannot reason about", () => {
  const base = { id: "x", kind: "confirmation" }
  for (const rule of [
    { ...base },
    { ...base, evidence: {} },
    { ...base, evidence: { source: "vibes" } },
    { ...base, evidence: { source: "capture" } },
    { ...base, evidence: { source: "capture", hosts: [] } },
  ])
    assert.equal(ruleApplies(rule, "http://127.0.0.1/x"), false)

  // And a fixture rule on an unparseable URL.
  assert.equal(
    ruleApplies(
      { ...base, evidence: { source: "fixture", sample: "s" } },
      "not a url",
    ),
    false,
  )
})

// --- purity and rule 0 ---------------------------------------------------------

test("classify is pure — same bytes in, same type out, no side effects", () => {
  const url = fixtureUrl("confirmation")
  const html = page("confirmation")
  const a = classify(url, html)
  const b = classify(url, html)
  assert.deepEqual(a, b)
  assert.equal(
    html,
    page("confirmation"),
    "and it did not mutate what it was handed",
  )
})

test("a rule that throws cannot decide a page — it lands on unclassified", () => {
  const exploding = [
    {
      id: "boom",
      kind: "confirmation",
      evidence: { source: "fixture", sample: "s" },
      test: () => {
        throw new Error("rule is broken")
      },
    },
  ]
  const got = classify(fixtureUrl("confirmation"), page("confirmation"), {
    rules: exploding,
  })
  assert.equal(
    got.kind,
    "unclassified",
    "a broken rule must not stop the world",
  )
})

test("script and style contents cannot satisfy a rule", () => {
  // A real confirmation page's analytics blob routinely contains the word
  // "captcha" as a vendor feature flag. Reading raw HTML would classify a
  // successful submit as a bot challenge and lose the application record.
  const poisoned =
    page("confirmation") +
    `<script>var flags={grecaptcha:true};/* please complete the security check */</script>` +
    `<style>/* verify your identity */</style>`
  assert.equal(
    classify(fixtureUrl("confirmation"), poisoned).kind,
    "confirmation",
  )
})

test("hidden markup between words does not defeat a rule", () => {
  const split = page("posting-gone").replace(
    "no longer accepting applications",
    "no <span>longer</span> accepting <b>applications</b>",
  )
  assert.equal(classify(fixtureUrl("posting-gone"), split).kind, "posting-gone")
})

test("a blocking signal beats a confirmation phrase on the same page", () => {
  // THE ORDERING PROPERTY. A bot challenge that also thanks you is a bot
  // challenge: nothing was submitted. Reading it as a confirmation would record
  // an application that does not exist.
  const both = page("bot-challenge") + page("confirmation")
  assert.equal(
    classify(fixtureUrl("bot-challenge"), both).kind,
    "bot-challenge",
  )

  const goneAndThanks = page("posting-gone") + page("confirmation")
  assert.equal(
    classify(fixtureUrl("posting-gone"), goneAndThanks).kind,
    "posting-gone",
  )
})

test("empty, absent and non-string pages are unclassified, not crashes", () => {
  for (const html of ["", null, undefined, 0, {}, []])
    assert.equal(
      classify(fixtureUrl("confirmation"), html).kind,
      "unclassified",
    )
  assert.equal(classify(null, page("confirmation")).kind, "unclassified")
})

test("visibleText drops what a user cannot read", () => {
  assert.equal(visibleText("<p>a</p><script>b</script><style>c</style>"), "a")
  assert.equal(visibleText("<!-- d --><p>e</p>"), "e")
  assert.equal(visibleText("<p>f&nbsp;g</p>"), "f g")
})

test("isFixtureUrl is loopback and NOTHING else", () => {
  for (const u of [
    "http://127.0.0.1:8123/x",
    "http://localhost:3000/x",
    "http://127.9.9.9/x",
  ])
    assert.equal(isFixtureUrl(u), true, u)

  for (const u of [
    "https://boards.greenhouse.io/x",
    // THE NEAR-MISSES, and one of these was a live hole. `127.0.0.1.evil.test`
    // is an ordinary registrable domain whose subdomain anyone can create; it
    // passed a `^127\.` prefix check, which would have let a fixture-sourced
    // rule decide a page an attacker served.
    "https://127.0.0.1.evil.test/x",
    "https://127.0.0.1x.test/x",
    "https://1270.0.0.1/x",
    "https://127.999.0.1/x",
    "https://localhost.evil.test/x",
    "https://notlocalhost/x",
    "https://example.com/?host=127.0.0.1",
    "https://example.com/#127.0.0.1",
    "",
    null,
  ])
    assert.equal(isFixtureUrl(u), false, String(u))
})

test("the challenge kinds are the ones job.mjs treats as unconfirmed", () => {
  for (const k of CHALLENGE_KINDS) assert.ok(CLASSIFICATIONS.includes(k))
  assert.ok(!CHALLENGE_KINDS.includes("confirmation"))
  assert.ok(!CHALLENGE_KINDS.includes("posting-gone"))
})
