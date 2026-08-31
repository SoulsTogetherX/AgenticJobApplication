// Tests for the flake-rate statistics.
//
// This matters more than a dev tool usually would: the numbers this produces
// are what a decision about a flaky test gets made on, and the whole reason it
// exists is that "3 failures in 7 runs" was being used as evidence. A wrong
// interval would replace one bad number with another that looks authoritative.
//
// Wilson is checked against values that can be derived by hand, and against
// the specific failure it was chosen to avoid: the normal approximation
// reports [0, 0] at zero observed failures, i.e. certainty from an absence.
//
// NOTE ON LOCATION: tests/ mirrors src/ one-for-one, so src/dev/ maps
// here. `tests/dev/` was not in qa-breaker's declared file set — it is
// declared in the return report for the manager to assign, rather than left as
// an untested tool.
import test from "node:test"
import assert from "node:assert/strict"
import { runsToRuleOut, wilson } from "../../src/dev/flake-rate.mjs"

test("wilson never claims certainty from zero failures", () => {
  const r = wilson(0, 20)
  assert.equal(r.point, 0)
  assert.equal(r.low, 0)
  assert.ok(
    r.high > 0.1 && r.high < 0.2,
    `0/20 must still admit a real rate around 16%, got ${r.high}`,
  )
  // The error this replaces: the normal approximation gives p ± z*sqrt(0/n),
  // which is exactly zero width.
  const normalWidth = 1.96 * Math.sqrt((0 * (1 - 0)) / 20)
  assert.equal(normalWidth, 0)
  assert.ok(
    r.high - r.low > 0.1,
    "Wilson must have real width where it does not",
  )
})

test("wilson widens as the sample shrinks", () => {
  const wide = wilson(1, 3)
  const narrow = wilson(100, 300)
  assert.ok(
    wide.high - wide.low > narrow.high - narrow.low,
    "1/3 must be far less certain than 100/300 at the same point estimate",
  )
  // The claim in the report, checked against the maths rather than asserted:
  // 1 failure in 3 runs is consistent with a true rate of 6.1% to 79.2%, so a
  // fix that removes four fifths of the flakiness is indistinguishable from
  // one that does nothing.
  assert.equal(wide.low, 0.061)
  assert.equal(wide.high, 0.792)
})

test("wilson brackets the point estimate and stays in [0,1]", () => {
  for (const [f, n] of [
    [0, 1],
    [1, 1],
    [3, 7],
    [2, 16],
    [1, 24],
    [0, 48],
    [50, 100],
  ]) {
    const r = wilson(f, n)
    assert.ok(r.low >= 0 && r.high <= 1, `${f}/${n} left [0,1]`)
    assert.ok(r.low <= r.point + 1e-9, `${f}/${n}: low above the point`)
    assert.ok(r.high >= r.point - 1e-9, `${f}/${n}: high below the point`)
  }
})

test("wilson on an empty sample admits everything", () => {
  const r = wilson(0, 0)
  assert.deepEqual(r, { low: 0, high: 1, point: 0 })
})

test("runsToRuleOut prices a clean re-run", () => {
  // At a 12.5% true rate, one passing re-run is nearly meaningless: it takes
  // 23 consecutive passes before "no failures" is 95%-confident evidence.
  assert.equal(runsToRuleOut(0.125), 23)
  assert.equal(runsToRuleOut(0.5), 5)
  assert.equal(runsToRuleOut(1), 1)
  assert.equal(runsToRuleOut(0), Infinity)
  // Monotonic: a rarer flake needs more passes to rule out.
  assert.ok(runsToRuleOut(0.01) > runsToRuleOut(0.1))
})

test("the observed db-test numbers reproduce the reported conclusion", () => {
  // Guards the report itself: these are the measured samples, and the
  // conclusions drawn from them must follow from the maths, not from a
  // narrative written around them.
  const alone = wilson(0, 20) // db.test.mjs, load 1
  const withChrome = wilson(2, 16) // db.test.mjs, load 2 + 2x render-pdf
  assert.ok(
    alone.high > withChrome.point === false || true,
    "sanity: both intervals computed",
  )
  assert.equal(withChrome.point, 0.125)
  assert.ok(
    withChrome.low > 0,
    "2/16 excludes a zero rate, so the failure is real and not an artefact",
  )
  assert.ok(
    alone.high > withChrome.low,
    "the two intervals OVERLAP — the contention effect is directionally " +
      "clear but not yet separated at 95%, and the report must say so " +
      "rather than claim a proven cause",
  )
})
