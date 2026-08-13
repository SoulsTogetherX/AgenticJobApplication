// Long-form written questions — the ones a form expects PROSE for.
//
// "What is your most recent achievement? (500 words minimum)". "Why do you want
// to work here?". "Describe a project you are proud of." Every board has one or
// two, they are the highest-signal fields on the form, and until now the
// pipeline had nothing to say about them: the fact base cannot answer an
// open-ended prompt, so the field resolved UNKNOWN and deferred as one more
// anonymous "a human must answer this". The user then wrote 500 words by hand,
// from facts that were already in `profile/profile.yaml`.
//
// WHAT THIS MODULE DOES, AND WHAT IT DELIBERATELY DOES NOT. It RECOGNISES the
// field and states what the form is asking for. It writes nothing. The drafting
// is a model turn in the apply-job skill, and the draft is not fillable until
// `verify-claims.mjs answer <file>` passes over it and the user has approved it
// in the one approval message they already get. So the split is:
//
//   deterministic (here)   is this a prose prompt, and how long must it be?
//   model (the skill)      the draft
//   deterministic again    verify-claims R4-R6 over the draft: every number,
//                          date and technology in it must already exist in the
//                          fact base
//   the user               approval, before anything is typed into a form
//
// THIS IS NOT A ROUTE AROUND RULE 1. Rule 1 permits rephrasing and reordering
// facts and forbids inventing them, and a composed answer is rephrasing by
// definition — the verifier is what makes that claim checkable rather than
// asserted. A draft that names a technology the user has never used, or a
// metric that is not in the profile, fails R6/R4 and never reaches the form.
//
// AND IT IS NOT AVAILABLE UNATTENDED. `compose` is a defer, so it blocks
// `submitReadiness()` like every other defer. Hard rule 6: throughput may only
// rise through deterministic understanding, and a model writing prose in
// response to a third-party prompt is the opposite of deterministic. On the
// attended path the user reads the draft; on the unattended path there is
// nobody to read it, so the application defers. That asymmetry is the point.

// THE DETECTOR IS STRUCTURAL, NOT A LIST OF PROMPT WORDINGS. A <textarea> IS
// the signal: a board renders one when it expects sentences, and a form that
// wanted a datum would have used an input. So there is no list of "describe /
// tell us / why / explain" to be defeated by the 26th rewording — the same
// lesson the scanner's Shape E paid for twice.
//
// A plain text input needs a second signal, because a text input normally
// holds a datum (a name, a URL, a salary). The signal is the form's own stated
// length demand: nothing asks for 500 words in a field meant for a phone
// number.
const PROSE_TYPES = new Set(["textarea", "richtext"])

// Below this, a stated character demand is a datum's format rule ("min 5
// characters") rather than a request for prose. Word demands carry no such
// ambiguity, so they have no floor.
const MIN_PROSE_CHARS = 120

const CHUNK = "(\\d[\\d,]*)"
const UNIT = "(word|character|char)s?"

// Written out rather than generated, because each of these is a real phrasing
// seen on a real form and a reader should be able to check them one by one.
const MIN_PATTERNS = [
  new RegExp(
    `\\b(?:at least|minimum(?: of)?|min\\.?|no (?:fewer|less) than|not less than)\\s*${CHUNK}\\s*${UNIT}`,
    "i",
  ),
  new RegExp(
    `\\b${CHUNK}\\s*${UNIT}\\s*(?:or more|minimum|min\\.?|and (?:above|over))`,
    "i",
  ),
  new RegExp(`\\b${CHUNK}\\s*\\+\\s*${UNIT}`, "i"),
]

const MAX_PATTERNS = [
  new RegExp(
    `\\b(?:at most|maximum(?: of)?|max\\.?|no more than|up to|under|limited? to)\\s*${CHUNK}\\s*${UNIT}`,
    "i",
  ),
  new RegExp(
    `\\b${CHUNK}\\s*${UNIT}\\s*(?:limit|maximum|max\\.?|or (?:fewer|less))`,
    "i",
  ),
]

// "200-500 words", "200 to 500 words". Checked FIRST: a range read by the
// single-bound patterns above would report one of its numbers and drop the
// other, and a draft written to the wrong bound is rejected by the form.
const RANGE_PATTERN = new RegExp(
  `\\b${CHUNK}\\s*(?:[-–—]|to)\\s*${CHUNK}\\s*${UNIT}`,
  "i",
)

const num = (s) => {
  const n = Number(String(s).replace(/,/g, ""))
  return Number.isFinite(n) && n > 0 ? n : null
}
const unitOf = (s) => (/^word/i.test(String(s)) ? "words" : "chars")

/**
 * The length the form says it wants, read off its own words.
 *
 * @returns {{min: number|null, max: number|null, unit: "words"|"chars"} | null}
 *   null when the text states no demand at all — which is the common case and
 *   is NOT a reason to skip the field. A prompt with no stated length is still
 *   a prompt; it just leaves the length to judgement.
 */
export function parseLengthDemand(text) {
  const s = String(text ?? "").replace(/\s+/g, " ")
  if (!s) return null

  const range = RANGE_PATTERN.exec(s)
  if (range) {
    const lo = num(range[1])
    const hi = num(range[2])
    // A "range" whose numbers run backwards is not a range, it is two numbers
    // that happened to sit next to a dash. Fall through rather than invent one.
    if (lo && hi && lo < hi) return { min: lo, max: hi, unit: unitOf(range[3]) }
  }

  let min = null
  let max = null
  let unit = null
  for (const re of MIN_PATTERNS) {
    const m = re.exec(s)
    if (m) {
      min = num(m[1])
      unit = unitOf(m[2])
      break
    }
  }
  for (const re of MAX_PATTERNS) {
    const m = re.exec(s)
    if (m) {
      max = num(m[1])
      unit ??= unitOf(m[2])
      break
    }
  }
  if (min == null && max == null) return null
  // A min above a max is a contradiction in the page's own words. Report both
  // and let the human see it, rather than picking one and writing to it.
  return { min, max, unit: unit ?? "words" }
}

/**
 * Is this field a long-form written question?
 *
 * @param field a scan field ({t, l, h, ...})
 * @returns {{need: object|null, why: string} | null}
 */
export function longFormPrompt(field) {
  if (!field) return null
  const t = String(field.t ?? "")
  const text = `${field.l ?? ""} ${field.h ?? ""}`
  const need = parseLengthDemand(text)

  if (PROSE_TYPES.has(t)) {
    return {
      need,
      why: need
        ? `the form asks for ${describeNeed(need)}`
        : "a free-text box with no stated length — the form expects sentences",
    }
  }
  // A text input has to be TOLD it wants prose.
  if (need && (need.unit === "words" || (need.min ?? 0) >= MIN_PROSE_CHARS)) {
    return { need, why: `the form asks for ${describeNeed(need)}` }
  }
  return null
}

/** One human-readable phrase for a length demand. */
export function describeNeed(need) {
  if (!need) return "no stated length"
  const u = need.unit
  if (need.min != null && need.max != null)
    return `${need.min}-${need.max} ${u}`
  if (need.min != null) return `at least ${need.min} ${u}`
  return `at most ${need.max} ${u}`
}

/**
 * Does a draft meet what the form asked for? Deterministic, so the skill does
 * not have to eyeball a word count — and so "500 words minimum" is CHECKED
 * rather than intended.
 *
 * @returns {string|null} the reason it does not, or null when it does.
 */
export function draftShortfall(draft, need) {
  const text = String(draft ?? "").trim()
  if (!text) return "the draft is empty"
  if (!need) return null
  const n =
    need.unit === "words"
      ? text.split(/\s+/).filter(Boolean).length
      : text.length
  if (need.min != null && n < need.min)
    return `${n} ${need.unit}, and the form asks for at least ${need.min}`
  if (need.max != null && n > need.max)
    return `${n} ${need.unit}, and the form allows at most ${need.max}`
  return null
}
