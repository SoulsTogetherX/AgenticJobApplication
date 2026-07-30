// The lexicon is the single source for every "what technology is named here?"
// question, and it feeds a truthfulness guardrail (verify-claims R6), so the
// tests here are mostly about what it must NOT do.
import test from "node:test"
import assert from "node:assert/strict"
import {
  SKILLS,
  GROUPS,
  TECH_TERMS,
  TECH_LEXICON,
  SKILL_BY_NAME,
  extractTech,
  atsFormsFor,
  adjacentTo,
  checkWrittenForm,
  preferredForm,
} from "../../scripts/lib/keywords.mjs"
import { techTermsIn } from "../../scripts/lib/lib.mjs"

// Every literal the R6 watchlist carried before the two lexicons were merged.
// Losing any one of these silently weakens the truthfulness gate, which is the
// one thing this refactor was not allowed to do.
const PRE_MERGE_TECH_TERMS = [
  "Python",
  "TypeScript",
  "JavaScript",
  "C++",
  "GDScript",
  "SQL",
  "HTML",
  "CSS",
  "React Native",
  "React",
  "Node.js",
  "Next.js",
  "AWS",
  "PostgreSQL",
  "Docker",
  "Vite",
  "GitHub Actions",
  "Git",
  "Godot",
  "GameMaker",
  "n8n",
  "nginx",
  "WebSockets",
  "Cognito",
  "EC2",
  "EventBridge",
  "Claude",
  "ChatGPT",
  "Codex",
  "MCP",
  "Monte Carlo",
  "JSON",
  "Agile",
  "Scrum",
  "Kubernetes",
  "Terraform",
  "Ansible",
  "Java",
  "C#",
  "Ruby",
  "Rust",
  "Golang",
  "PHP",
  "Swift",
  "Kotlin",
  "Scala",
  "Angular",
  "Vue",
  "Svelte",
  "Django",
  "Flask",
  "FastAPI",
  "Spring",
  "Rails",
  "Laravel",
  "GraphQL",
  "MongoDB",
  "Redis",
  "MySQL",
  "SQLite",
  "DynamoDB",
  "Kafka",
  "RabbitMQ",
  "Elasticsearch",
  "Azure",
  "GCP",
  "Firebase",
  "Heroku",
  "Vercel",
  "Netlify",
  "Jenkins",
  "CircleCI",
  "Webpack",
  "Babel",
  "Jest",
  "Mocha",
  "Cypress",
  "Playwright",
  "Selenium",
  "Puppeteer",
  "TensorFlow",
  "PyTorch",
  "Keras",
  "Pandas",
  "NumPy",
  "Spark",
  "Hadoop",
  "Tailwind",
  "Bootstrap",
  "jQuery",
  "Express",
  "NestJS",
  "Deno",
  "Bun",
  "Remix",
  "Astro",
  "Flutter",
  "Unity",
  "Unreal",
]

test("R6 watchlist did not lose a single pre-merge term", () => {
  const have = new Set(TECH_TERMS)
  const lost = PRE_MERGE_TECH_TERMS.filter((t) => !have.has(t))
  assert.deepEqual(
    lost,
    [],
    `dropped from the R6 watchlist: ${lost.join(", ")}`,
  )
})

test("every canonical skill name is unique", () => {
  const names = SKILLS.map((s) => s.canonical)
  assert.equal(new Set(names).size, names.length)
})

test("every skill declares a known group and at least one ATS form", () => {
  for (const s of SKILLS) {
    assert.ok(GROUPS.includes(s.group), `${s.canonical} has group "${s.group}"`)
    assert.ok(s.ats?.length, `${s.canonical} has no ATS form`)
    assert.ok(s.aliases?.length, `${s.canonical} has no detection alias`)
  }
})

test("every adjacent skill points at a real canonical name", () => {
  for (const s of SKILLS) {
    for (const a of s.adjacent ?? []) {
      assert.ok(
        SKILL_BY_NAME.has(a),
        `${s.canonical}.adjacent names "${a}", which is not a skill`,
      )
    }
  }
})

test("every alias compiles as a regex", () => {
  for (const s of SKILLS) {
    for (const a of s.aliases) {
      assert.doesNotThrow(
        () => new RegExp(a, "i"),
        `${s.canonical} alias "${a}" is not a valid regex`,
      )
    }
  }
})

// The reason `surface` and `aliases` are separate fields. Folding surface forms
// into the detection regex was tried and matched every one of these; a lexicon
// that indexes "Spring 2027 internship" as the Spring framework poisons demand
// analysis and the fit score built on top of it.
test("detection does not fire on ambiguous prose", () => {
  const cases = [
    ["Go", "We go to production weekly and go-live is smooth."],
    ["Spring", "Spring 2027 internship cohort starts soon."],
    ["Lambda", "Use a lambda function in your Python code."],
    ["Bun", "Free lunch: bagels, a bun, and coffee."],
    ["Remix", "A remix of our culture deck."],
    ["S3", "Section S3 of the handbook."],
    ["Unity", "We value unity and collaboration."],
    ["Rails", "Do not go off the rails."],
  ]
  for (const [name, text] of cases) {
    assert.ok(
      !extractTech(text).has(name),
      `"${text}" was read as evidence of ${name}`,
    )
  }
})

// A negative corpus: text where NO software skill should be detected at all.
// Half of it is real hospitality/facilities prose, because the local Las Vegas
// boards are overwhelmingly casino postings and those are what actually reach
// the lexicon on a loose title match.
//
// This caught three live false positives when it was written, two of them
// inherited from the pre-merge lexicon: "do not go off the rails" -> Ruby, and
// "deliver express service to every guest" -> Express. Add to this list
// whenever a new alias is added; it is cheaper than finding out from a demand
// report that says the Las Vegas market wants Express.
const NON_TECHNICAL_PROSE = [
  "A remix of our culture deck.",
  "Free lunch: bagels, a bun, and coffee.",
  "We go to production weekly and go-live is smooth.",
  "Spring 2027 internship cohort starts soon.",
  "Section S3 of the handbook.",
  "We value unity and collaboration.",
  "Do not go off the rails.",
  "Use a lambda function in your code.",
  "Maintain cleanliness of guest rooms and the casino floor.",
  "Pick up supplies and parts from vendors; perform preventive maintenance.",
  "Greet each guest with a smile and deliver express service at the front desk.",
  "Must be able to lift 50 lbs and stand for long periods.",
  "Reconcile accounts payable and process invoices and purchase orders.",
  "Our team is like a family; we work hard and play hard.",
  "Beverage server needed for banquet and buffet service.",
  "Compensation includes medical, dental, vision and a 401k match.",
  "Please submit your application through our careers portal.",
  "The role reports to the general manager and supports the kitchen staff.",
  "Bartending experience preferred; must obtain a health card.",
  "We offer flexible scheduling and a fast-paced environment.",
]

test("no skill is detected anywhere in non-technical prose", () => {
  const hits = []
  for (const text of NON_TECHNICAL_PROSE) {
    for (const name of extractTech(text)) hits.push(`${name} <- "${text}"`)
  }
  assert.deepEqual(hits, [], `false positives:\n  ${hits.join("\n  ")}`)
})

test("detection still fires on the real thing", () => {
  const cases = [
    ["Go", "Backend services written in Golang."],
    ["Spring", "Must have worked on Spring Boot microservices."],
    ["Lambda", "Event handlers on AWS Lambda."],
    ["Unity", "Shipped mobile titles in Unity3D."],
    ["Express", "Backend on Node.js/Express with MongoDB."],
    ["Express", "Built REST endpoints using Express.js."],
    ["Ruby", "Five years of Ruby on Rails."],
    ["Kubernetes", "Deploys run on k8s with Helm charts."],
    ["CI/CD", "We run continuous integration on GitHub Actions."],
    ["Testing", "Strong TDD discipline; pytest and Cypress."],
    ["Auth", "Implement SSO and RBAC across services."],
  ]
  for (const [name, text] of cases) {
    assert.ok(extractTech(text).has(name), `"${text}" did not yield ${name}`)
  }
})

// A posting that only names Tailwind is still CSS work. The pre-merge lexicon
// counted it that way and splitting Tailwind into its own entry must not lose
// the broader signal.
test("Tailwind and Sass still imply HTML/CSS", () => {
  const found = extractTech("Styling with TailwindCSS and SCSS modules.")
  assert.ok(found.has("HTML/CSS"))
  assert.ok(found.has("Tailwind"))
  assert.ok(found.has("Sass"))
})

test("terms with punctuation survive the word boundaries", () => {
  assert.ok(extractTech("Strong C++ and C# background").has("C++"))
  assert.ok(extractTech("Strong C++ and C# background").has("C#"))
  assert.ok(extractTech("Built on Node.js and Next.js").has("Node.js"))
  assert.ok(extractTech("Built on Node.js and Next.js").has("Next.js"))
})

test("techTermsIn reports React Native without also reporting React", () => {
  assert.deepEqual(techTermsIn("Built a React Native app"), ["React Native"])
})

test("atsFormsFor returns acronym and expansion for compound skills", () => {
  const forms = atsFormsFor("CI/CD")
  assert.ok(forms.includes("CI/CD"))
  assert.ok(forms.some((f) => /continuous integration/i.test(f)))
})

test("atsFormsFor falls back to the name for an unknown skill", () => {
  assert.deepEqual(atsFormsFor("Cobol"), ["Cobol"])
})

test("adjacentTo suggests neighbours and never something already evidenced", () => {
  const out = adjacentTo(["React"], new Set(["React", "TypeScript"]))
  assert.ok(out.has("Redux"), "React should suggest Redux")
  assert.ok(!out.has("TypeScript"), "already evidenced, must not be suggested")
  assert.deepEqual(out.get("Redux"), ["React"], "records what implied it")
})

test("adjacentTo on an empty input suggests nothing", () => {
  assert.equal(adjacentTo([], new Set()).size, 0)
  assert.equal(adjacentTo(["NotASkill"], new Set()).size, 0)
})

// --- written form: one spelling, and acronyms paired once --------------------

test("common misspellings are caught with the canonical form to use", () => {
  const issues = checkWrittenForm(
    "Built with Javascript, NodeJS and Postgres. Ran CICD.",
  )
  const found = Object.fromEntries(issues.map((i) => [i.found, i.prefer]))
  assert.equal(found.Javascript, "JavaScript")
  assert.equal(found.NodeJS, "Node.js")
  assert.equal(found.Postgres, "PostgreSQL")
  assert.equal(found.CICD, "CI/CD")
})

test("correct spellings raise nothing", () => {
  const issues = checkWrittenForm(
    "Built with JavaScript, Node.js and PostgreSQL. Ran CI/CD (continuous integration).",
  )
  assert.deepEqual(
    issues.filter((i) => i.issue === "noncanonical_spelling"),
    [],
  )
})

test("URLs and emails are not read as misspellings", () => {
  // "github.com/xalva" is correct lowercase. Flagging it trains the reader to
  // ignore the whole report.
  const issues = checkWrittenForm(
    "Contact me@github.com or github.com/xalva — built with JavaScript.",
  )
  assert.deepEqual(issues, [])
})

test("an acronym used without its expansion is flagged once", () => {
  const issues = checkWrittenForm("Deployed to AWS every day.")
  const aws = issues.find((i) => i.found === "AWS")
  assert.equal(aws.issue, "unpaired_acronym")
  assert.match(aws.prefer, /AWS \(Amazon Web Services\)/)
})

test("an expansion used without its acronym is flagged too", () => {
  const issues = checkWrittenForm("Deployed to Amazon Web Services every day.")
  assert.equal(issues[0].issue, "unpaired_expansion")
})

test("pairing them satisfies the check", () => {
  assert.deepEqual(checkWrittenForm("Deployed to AWS (Amazon Web Services)."), [])
})

test("the pair list stays short enough not to cry wolf", () => {
  // A first draft flagged API/SQL/UI/UX/ML and produced eight warnings on a
  // perfectly good resume. Nobody indexes "Structured Query Language".
  const realistic =
    "Full-Stack Developer. Built REST APIs in TypeScript with SQL, improved the UI and UX, wrote unit tests."
  assert.deepEqual(checkWrittenForm(realistic), [])
})

test("preferredForm returns the single form to use throughout", () => {
  assert.equal(preferredForm("CI/CD"), "CI/CD")
  assert.equal(preferredForm("Node.js"), "Node.js")
  assert.equal(preferredForm("Nonexistent"), "Nonexistent")
})

test("checkWrittenForm handles empty input", () => {
  assert.deepEqual(checkWrittenForm(""), [])
  assert.deepEqual(checkWrittenForm(null), [])
})
