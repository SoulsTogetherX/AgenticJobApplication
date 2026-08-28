// Jobvite and SuccessFactors expose no JSON job list, so these two fetchers
// parse XML and HTML with regexes. That is fragile by nature: a career-site
// redesign would otherwise turn into a silently empty board rather than a
// visible failure. These fixtures are trimmed from the real responses.
import test from "node:test"
import assert from "node:assert/strict"
import {
  parseJobviteFeed,
  parseSuccessFactorsPage,
  parseSuccessFactorsTotal,
} from "../../src/leads/find-jobs.mjs"

const JOBVITE_BOARD = { slug: "agscareer", company: "AGS" }

const JOBVITE_XML = `<?xml version="1.0" encoding="utf-8"?>
<result>
  <job>
    <id>oyy8xfwv</id>
    <title>Senior Software Engineer</title>
    <location>Duluth, GA, United States</location>
    <category>Engineering</category>
    <date>11/26/2025</date>
    <detail-url><![CDATA[https://jobs.jobvite.com/agscareer/job/oyy8xfwv]]></detail-url>
    <apply-url><![CDATA[http://app.jobvite.com/CompanyJobs/Careers.aspx?c=qaNaVfwM&j=oyy8xfwv&k=Apply]]></apply-url>
    <briefdescription><![CDATA[Build &amp; ship gaming systems.]]></briefdescription>
    <description><![CDATA[<p>Work on C++ math engines.</p>]]></description>
  </job>
  <job>
    <id>abc123</id>
    <title>Game Mathematician</title>
    <location>Las Vegas, NV, United States</location>
    <date>7/2/2026</date>
    <detail-url><![CDATA[https://jobs.jobvite.com/agscareer/job/abc123]]></detail-url>
  </job>
</result>`

test("jobvite feed parses records, CDATA, entities and US dates", () => {
  const jobs = parseJobviteFeed(JOBVITE_XML, JOBVITE_BOARD)
  assert.equal(jobs.length, 2)

  const [a, b] = jobs
  assert.equal(a.id, "jobvite:agscareer:oyy8xfwv")
  assert.equal(a.title, "Senior Software Engineer")
  assert.equal(a.location, "Duluth, GA, United States")
  assert.equal(a.url, "https://jobs.jobvite.com/agscareer/job/oyy8xfwv")
  assert.equal(a.company, "AGS")
  assert.match(a.posted_at, /^2025-11-26/)
  assert.match(a.description, /Build & ship gaming systems/)

  assert.equal(b.title, "Game Mathematician")
  assert.match(b.posted_at, /^2026-07-02/)
})

test("jobvite parser yields nothing on an unrecognised feed, without throwing", () => {
  // A format change must fail loudly at the test, not silently in production.
  assert.deepEqual(parseJobviteFeed("<result></result>", JOBVITE_BOARD), [])
  assert.deepEqual(parseJobviteFeed("not xml at all", JOBVITE_BOARD), [])
})

const SF_BOARD = { host: "jobs.igt.com", company: "IGT" }

const SF_HTML = `
<span class="paginationLabel">Results 1 &ndash; 25 of <b>142</b></span>
<table>
 <tr>
  <td><a class="jobTitle-link" href="/IGT/job/Reno-Software-Engineer-NV-89521/1234567/">Software Engineer II</a></td>
  <td><span class="jobLocation">Reno, NV, US, 89521</span></td>
  <td><span class="jobDate">Jul 2, 2026</span></td>
 </tr>
 <tr>
  <td><a class="jobTitle-link" href="/IGT/job/Las-Vegas-Game-Mathematician-NV/7654321/">Game Mathematician</a></td>
  <td><span class="jobLocation">Las Vegas, NV, US</span></td>
  <td><span class="jobDate">Jul 20, 2026</span></td>
 </tr>
</table>`

test("successfactors page yields one record per row with fields kept in-row", () => {
  const jobs = parseSuccessFactorsPage(SF_HTML, SF_BOARD)
  assert.equal(jobs.length, 2)

  const [a, b] = jobs
  assert.equal(a.title, "Software Engineer II")
  assert.equal(a.location, "Reno, NV, US, 89521")
  assert.equal(a.id, "successfactors:jobs.igt.com:1234567")
  assert.equal(
    a.url,
    "https://jobs.igt.com/IGT/job/Reno-Software-Engineer-NV-89521/1234567/",
  )
  assert.match(a.posted_at, /^2026-07-02/)

  // The critical property: row two's location must not leak into row one.
  assert.equal(b.title, "Game Mathematician")
  assert.equal(b.location, "Las Vegas, NV, US")
  assert.match(b.posted_at, /^2026-07-20/)
})

test("a multi-site location sheds its '+N more' suffix", () => {
  // Real IGT markup: the cell wraps and appends a count of further sites.
  const html = `
   <a class="jobTitle-link" href="/IGT/job/x/999/">Security Systems Technician</a>
   <span class="jobLocation">Las Vegas, NV, US, 89113

                +1 more&hellip;</span>
   <span class="jobDate">Jul 9, 2026</span>`
  const [job] = parseSuccessFactorsPage(html, SF_BOARD)
  assert.equal(job.location, "Las Vegas, NV, US, 89113")
})

test("successfactors total is read from the pagination label", () => {
  assert.equal(parseSuccessFactorsTotal(SF_HTML), 142)
  assert.equal(parseSuccessFactorsTotal("<span>of <b>1,204</b></span>"), 1204)
  // Unknown total must not cap the loop at zero.
  assert.equal(parseSuccessFactorsTotal("<html>no label</html>"), Infinity)
})

test("successfactors parser survives markup it does not recognise", () => {
  assert.deepEqual(
    parseSuccessFactorsPage("<html>redesigned</html>", SF_BOARD),
    [],
  )
})
