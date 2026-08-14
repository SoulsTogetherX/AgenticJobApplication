// The post-click classifier (§4.10). Phase 5 W2.
//
// A PURE TYPED FUNCTION OVER (url, html). No I/O, no network, no DOM, no
// database, no model, and no clock. Same bytes in, same type out, forever —
// which is what makes a committed corpus a meaningful test of it.
//
// ===========================================================================
// THE ASYMMETRY THAT DECIDES EVERY RULE IN THIS FILE
// ===========================================================================
//
// The two ways to be wrong are not equally bad, and the design leans hard on
// which one is survivable:
//
//   SAYING `confirmation` WHEN NOTHING WAS SUBMITTED loses an application
//   silently. The queue row goes to `submitted`, the caps count it, the digest
//   reports it as sent, and the user never applies to that posting again. There
//   is no later signal that corrects this. It is the worst outcome available.
//
//   SAYING anything else WHEN IT WAS A CONFIRMATION costs one human look at one
//   URL. It CANNOT cause a duplicate application: the `(slug, mode)` row in
//   `auto_submissions` was written BEFORE the click (submit.mjs precondition 7)
//   and `recordAutoSubmission`'s ON CONFLICT DO NOTHING refuses the second
//   claim, so a re-run of that slug stops rather than clicking again.
//
// So: `confirmation` is the hardest kind to earn, every blocking signal is
// tested BEFORE it, and `unclassified` is the default. `unclassified` is the
// one remaining hard STOP in §4.6 precisely because an unrecognised page is the
// case that must stop.
//
// ===========================================================================
// WHY RULES CARRY THEIR EVIDENCE, AND WHY A FIXTURE RULE CANNOT FIRE ON A REAL
// BOARD
// ===========================================================================
//
// §4.10 requires the corpus to be REAL confirmation, identity-verification,
// bot-challenge, email-code, error and not-a-confirmation pages, and names
// their only lawful source: attended applies capturing the post-submit page.
// §4.6 says the guess this system must never make is a model deciding what a
// page means. Writing "if the HTML says 'Thank you for applying' it is a
// confirmation" from memory is the SAME guess with the model removed and this
// repository's imagination left in — it just fails silently instead of
// expensively.
//
// So every rule declares where its evidence came from, and that provenance
// BOUNDS WHERE IT MAY FIRE:
//
//   evidence.source === 'fixture'  — justified by a page in tests/fixtures/,
//     which this repository wrote. It may fire ONLY on loopback. It is evidence
//     about the fixture and about nothing else.
//
//   evidence.source === 'capture'  — justified by a real post-submit page from
//     an attended apply, redacted and promoted into the corpus by the user.
//     It may fire on the hosts its capture came from.
//
// THE CONSEQUENCE, STATED PLAINLY BECAUSE IT IS THE POINT: with no captures
// promoted, every real board classifies as `unclassified`, and a live submit
// against a real board therefore hard-STOPs after the click. That is not a bug
// to be worked around by relaxing the rule — it is this file correctly
// reporting that nothing in the repository has ever seen what that board says
// after a submit. The fix is a capture, never a plausible-looking regex.
//
// ===========================================================================
// WHAT THIS FILE DOES NOT DO
// ===========================================================================
//
// It does not read the page for anything except its own type. Its output is a
// TYPE, never an instruction and never a value that reaches a form. Rule 0
// still holds at full force here: `html` is attacker-controlled text, and the
// only thing this function is permitted to conclude from it is which of seven
// enum members it is.
import { safeText } from "./untrusted-text.mjs"

/** The closed set §4.10 names. A kind not on this list is a bug, not a page. */
export const CLASSIFICATIONS = Object.freeze([
  "confirmation",
  "identity-verification",
  "bot-challenge",
  "email-code-challenge",
  "posting-gone",
  "error",
  "unclassified",
])

/** The kinds that mean "a human or a challenge is now between us and the
 *  submission". job.mjs maps these to `challenged`, which counts toward caps
 *  and is reported as unconfirmed — never as sent. */
export const CHALLENGE_KINDS = Object.freeze([
  "identity-verification",
  "bot-challenge",
  "email-code-challenge",
])

// A whole-host match, never a prefix or a substring, and the reason is a hole a
// prefix check actually had: `127.0.0.1.evil.test` starts with `127.` and is an
// ORDINARY DOMAIN an attacker can register a subdomain of. Under the prefix
// version it read as loopback, which would let a fixture-sourced rule — this
// repository's guess about what a confirmation says — decide a page served by
// somebody else. `127.` must be a complete dotted quad, and `localhost` must be
// the whole host or the whole final label.
const IPV4_LOOPBACK = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

const isLoopbackHost = (h) => {
  const host = String(h ?? "").toLowerCase()
  if (host === "localhost" || host === "[::1]" || host === "::1") return true
  if (/(^|\.)localhost$/.test(host)) return true
  const m = IPV4_LOOPBACK.exec(host)
  return Boolean(m) && m.slice(1).every((o) => Number(o) <= 255)
}

/** Loopback, and nothing else. The whole fixture-scoping guarantee rests on
 *  this returning false for every host that is not literally this machine. */
export function isFixtureUrl(url) {
  try {
    return isLoopbackHost(new URL(String(url)).hostname)
  } catch {
    return false
  }
}

// Text-only view of the HTML, so a rule matching "verify your identity" is not
// defeated by markup between the words and is not accidentally satisfied by an
// attribute or a script string.
//
// SCRIPTS AND STYLES ARE DROPPED FIRST, and that is load-bearing rather than
// tidy: a confirmation page's analytics blob routinely contains the word
// "captcha" (the vendor's own feature flags), and a rule reading raw HTML would
// classify a successful submit as a bot challenge. Dropping them is also the
// cheapest defence against a rule being satisfied by text no user can see.
export function visibleText(html) {
  return String(html ?? "")
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style\s*>/gi, " ")
    .replace(/<noscript\b[\s\S]*?<\/noscript\s*>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;?/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
}

/**
 * A rule.
 *
 * @property id        stable, so a report can name the rule that fired.
 * @property kind      one of CLASSIFICATIONS, never `unclassified`.
 * @property evidence  {source: 'fixture'|'capture', sample: <corpus id>}.
 *                     A rule with no evidence is not a rule; addRule refuses it.
 * @property test      (url, text, html) -> boolean. `text` is visibleText(html),
 *                     computed once per classify() call rather than per rule.
 */

// The shipped rules.
//
// Two provenances now (first captures promoted by the user 2026-08-13):
// fixture-sourced rules fire on loopback only, and capture-sourced rules fire
// on exactly the two hosts their captures came from — job-boards.greenhouse.io
// (10 confirmations + 1 email-code page) and jobs.ashbyhq.com (3
// confirmations). Everything else — boards.greenhouse.io and jobs.lever.co
// included — still classifies `unclassified` and hard-STOPs, because this
// repository has never seen what those hosts say after a submit. That is not
// a gap to fill with better guesses; it is the accurate state of the
// evidence, and `npm test` reports what is still missing by kind
// (tests/auto/classify.test.mjs).
const SHIPPED = [
  // --- blocking signals, tested before confirmation ------------------------
  {
    id: "fixture-recaptcha-resubmit",
    kind: "bot-challenge",
    evidence: { source: "fixture", sample: "greenhouse-recaptcha-resubmit" },
    test: (_u, t, html) =>
      /\bg-recaptcha\b|\bgrecaptcha\b|recaptcha\/api\.js/i.test(html) &&
      /(verify|confirm) (that )?you(’|')?re (not a robot|human)|please complete the (security )?(check|challenge)|resubmit/i.test(
        t,
      ),
  },
  {
    id: "fixture-email-code",
    kind: "email-code-challenge",
    evidence: { source: "fixture", sample: "greenhouse-email-code" },
    test: (_u, t) =>
      /we (have )?(sent|emailed) (you )?a (\d+[- ])?(digit )?code|enter the code we (sent|emailed)|verification code (was )?sent to your email/i.test(
        t,
      ),
  },
  {
    id: "fixture-identity-verification",
    kind: "identity-verification",
    evidence: { source: "fixture", sample: "greenhouse-identity" },
    test: (_u, t) =>
      /verify your identity|identity verification|upload (a photo of )?(your )?(government[- ]issued )?(photo )?id\b/i.test(
        t,
      ),
  },
  {
    id: "fixture-posting-gone",
    kind: "posting-gone",
    evidence: { source: "fixture", sample: "greenhouse-posting-gone" },
    test: (_u, t) =>
      /this (job|position|posting|role) is no longer (accepting applications|available|open)|posting (has been )?(closed|removed)|no longer accepting applications/i.test(
        t,
      ),
  },
  {
    id: "fixture-error",
    kind: "error",
    evidence: { source: "fixture", sample: "greenhouse-error" },
    test: (_u, t) =>
      /(something went wrong|an (unexpected )?error occurred|we could not (process|submit) your application|please try again later)/i.test(
        t,
      ),
  },
  {
    // A REAL page from the user's attended Reddit apply (2026-08-04, promoted
    // 2026-08-13): mid-submit, Greenhouse held the application and demanded an
    // 8-character code sent to the applicant's email address. Worth noting:
    // the fixture email-code rule above would NOT have matched this page — it
    // guesses "sent to your email", and the real page says "sent to
    // <address>". That miss is the whole argument for captures over guessed
    // wordings.
    id: "capture-greenhouse-email-code",
    kind: "email-code-challenge",
    evidence: {
      source: "capture",
      sample: "greenhouse-c894c4c48db0",
      samples: ["greenhouse-c894c4c48db0"],
      hosts: ["job-boards.greenhouse.io"],
    },
    test: (_u, t) =>
      /a verification code was sent to/i.test(t) &&
      /enter the \d+[- ]character code/i.test(t),
  },

  // --- confirmation, LAST and narrowest ------------------------------------
  //
  // Two independent signals required, not one. A single phrase match is how a
  // "thanks for your interest, the role is closed" page becomes a recorded
  // application: the page genuinely thanks you, and the sentence that changes
  // its meaning is somewhere else entirely. Requiring an explicit
  // application-received statement AND the absence of every blocking signal
  // above is the narrowest thing that still recognises the fixture.
  {
    id: "fixture-application-received",
    kind: "confirmation",
    evidence: { source: "fixture", sample: "greenhouse-confirmation" },
    test: (_u, t) =>
      /(your )?application (has been |was )?(received|submitted|sent)|thank you for applying|we(’|')?ve received your application/i.test(
        t,
      ) && /application/i.test(t),
  },
  {
    // Ten real job-boards.greenhouse.io confirmations (Reddit, Affirm ×3,
    // Cloudflare, GitLab, Coinbase ×2, Twilio ×2), promoted by the user
    // 2026-08-13. The second signal is the post-submit "Back to job post"
    // navigation rather than an application-received sentence, and that is
    // MEASURED, not stylistic: GitLab's whole message is "Thank you for
    // applying to GitLab!", and Twilio's and Affirm's received-wordings each
    // differ — the only pair present on all ten captures is the thank-you and
    // the navigation. Both are absent from the one real non-confirmation this
    // host has produced (the email-code page above), which the rule ordering
    // also outranks.
    id: "capture-greenhouse-confirmation",
    kind: "confirmation",
    evidence: {
      source: "capture",
      sample: "greenhouse-250b54c4a7f1",
      samples: [
        "greenhouse-250b54c4a7f1",
        "greenhouse-2c457b41f353",
        "greenhouse-3d6249906bcc",
        "greenhouse-496f1e2ffe51",
        "greenhouse-526858411c5a",
        "greenhouse-6e653ac54297",
        "greenhouse-90dde7222080",
        "greenhouse-b399e76c43bc",
        "greenhouse-cba054edde62",
        "greenhouse-e089eb86d7c5",
      ],
      hosts: ["job-boards.greenhouse.io"],
    },
    test: (_u, t) =>
      /thank you for applying/i.test(t) && /back to job post/i.test(t),
  },
  {
    // Three real jobs.ashbyhq.com confirmations (OpenAI, Render, Tailor),
    // promoted by the user 2026-08-13. Ashby confirms in place — the page
    // keeps the whole job description and appends an "Application Success"
    // block — so both signals come from that block, and the application FORM
    // for the same job (the one staged capture the user did not promote)
    // carries neither.
    id: "capture-ashby-confirmation",
    kind: "confirmation",
    evidence: {
      source: "capture",
      sample: "ashby-2eb1b029f99d",
      samples: [
        "ashby-2eb1b029f99d",
        "ashby-bca2995fb1cd",
        "ashby-dfd533f3acb6",
      ],
      hosts: ["jobs.ashbyhq.com"],
    },
    test: (_u, t) =>
      /application success\b/i.test(t) &&
      /application was successfully submitted/i.test(t),
  },
]

// Frozen so a caller cannot mutate the shipped set at runtime — a classifier
// whose rules can be edited by whatever imported it is not a pure function of
// its arguments in any sense that matters.
const RULES = SHIPPED.map((r) => Object.freeze({ ...r }))

/**
 * May this rule fire on this URL?
 *
 * A fixture-sourced rule may fire ONLY on loopback. This one function is the
 * whole guarantee that this repository's idea of what a board says never
 * reaches a decision about a real employer, so it fails CLOSED: an unparseable
 * URL, an unknown evidence source, or a missing evidence block all return
 * false.
 */
export function ruleApplies(rule, url) {
  const src = rule?.evidence?.source
  if (src === "fixture") return isFixtureUrl(url)
  if (src === "capture") {
    // A capture-sourced rule fires on the hosts its capture came from — since
    // 2026-08-13 that is job-boards.greenhouse.io and jobs.ashbyhq.com, and
    // nothing else. This branch predates the first promotion on purpose, so
    // the shape of a promoted rule was reviewable before one existed.
    const hosts = rule.evidence.hosts
    if (!Array.isArray(hosts) || !hosts.length) return false
    let host
    try {
      host = new URL(String(url)).hostname.toLowerCase()
    } catch {
      return false
    }
    return hosts.some(
      (h) =>
        typeof h === "string" &&
        (host === h.toLowerCase() || host.endsWith(`.${h.toLowerCase()}`)),
    )
  }
  return false
}

/**
 * Type the page that came back from a submit click.
 *
 * @param url  the LIVE url after the click — page.url(), never the planned one.
 * @param html the page's HTML.
 * @returns {{kind, rule, why}} — `rule` is the id that fired, or null.
 */
export function classify(url, html, { rules = RULES } = {}) {
  const text = visibleText(html)
  const raw = String(html ?? "")

  for (const rule of rules) {
    if (!ruleApplies(rule, url)) continue
    let hit = false
    try {
      hit = rule.test(url, text, raw) === true
    } catch {
      // A rule that throws is a broken rule, and a broken rule must not be able
      // to decide a page. Skipping it lands on `unclassified`, which stops.
      hit = false
    }
    if (hit)
      return {
        kind: rule.kind,
        rule: rule.id,
        why: `matched ${rule.id} (evidence: ${rule.evidence.source}/${rule.evidence.sample})`,
      }
  }

  return {
    kind: "unclassified",
    rule: null,
    why:
      `no rule with evidence for this host recognised the page after the click` +
      (isFixtureUrl(url)
        ? ""
        : ` — this repository holds no captured post-submit page for ` +
          `${safeText(hostOf(url), 60)}, so nothing may conclude what it says`),
  }
}

function hostOf(url) {
  try {
    return new URL(String(url)).hostname
  } catch {
    return "an unparseable url"
  }
}

/** The shipped rules, for the corpus test and for reports. Never mutated. */
export function shippedRules() {
  return RULES.map((r) => ({
    id: r.id,
    kind: r.kind,
    evidence: { ...r.evidence },
  }))
}

/** Which kinds this repository has REAL captured evidence for. Since
 *  2026-08-13: `confirmation` and `email-code-challenge`. The corpus test
 *  still names what is missing (identity-verification, bot-challenge,
 *  posting-gone, error) rather than passing quietly on the gap. */
export function capturedKinds(rules = RULES) {
  return [
    ...new Set(
      rules.filter((r) => r.evidence?.source === "capture").map((r) => r.kind),
    ),
  ].sort()
}
