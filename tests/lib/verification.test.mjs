// What "verified" means. A resume.md existing on disk is not evidence that
// anything checked it, and a verdict recorded against yesterday's fact base is
// not evidence about today's.
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  factBaseSha256,
  sha256File,
  slugForDocument,
  verificationIdentity,
  hasVerifiedResume,
  verifiedResumeUrls,
} from "../../src/lib/verification.mjs"
import {
  openDb,
  recordVerification,
  hasPassingVerification,
  readVerifications,
} from "../../src/lib/db.mjs"
import { classify } from "../../src/apply/automatability.mjs"

function ws(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aj-verify-"))
  const jobsDir = path.join(root, "jobs")
  const profileDir = path.join(root, "profile")
  fs.mkdirSync(jobsDir, { recursive: true })
  fs.mkdirSync(profileDir, { recursive: true })
  const profilePath = path.join(profileDir, "profile.yaml")
  const answersPath = path.join(profileDir, "answers.yaml")
  fs.writeFileSync(profilePath, "meta:\n  approved_by_user: true\n")
  fs.writeFileSync(answersPath, "answers: []\n")

  const handles = []
  t.after(() => {
    for (const d of handles) {
      try {
        d.close()
      } catch {
        /* already closed */
      }
    }
    try {
      fs.rmSync(root, { recursive: true, force: true })
    } catch {
      /* a leaked Windows lock must not fail a passing test */
    }
  })

  return {
    root,
    jobsDir,
    profilePath,
    answersPath,
    opts: { jobsDir, profilePath, answersPath },
    db() {
      const d = openDb(path.join(root, "leads.db"))
      handles.push(d)
      return d
    },
    job(slug, { resume = "# Resume\n", url = `https://boards.test/${slug}` }) {
      const dir = path.join(jobsDir, slug)
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, "resume.md"), resume)
      fs.writeFileSync(
        path.join(dir, "job.json"),
        JSON.stringify({ slug, apply_url: url }),
      )
      return { dir, resume: path.join(dir, "resume.md"), url }
    },
  }
}

// --- the fact-base digest ------------------------------------------------------

test("profile_sha256 covers BOTH fact-base files, in a fixed order", (t) => {
  const w = ws(t)
  const before = factBaseSha256(w.opts)

  fs.writeFileSync(w.answersPath, "answers:\n  - id: a1\n    text: hello\n")
  const afterAnswers = factBaseSha256(w.opts)
  assert.notEqual(
    afterAnswers,
    before,
    "an answer can be the sole support for a claim; editing answers.yaml must count",
  )

  fs.writeFileSync(w.profilePath, "meta:\n  approved_by_user: true\n# edited\n")
  assert.notEqual(factBaseSha256(w.opts), afterAnswers)
})

test("a missing fact-base file hashes differently from an empty one, and never throws", (t) => {
  const w = ws(t)
  fs.writeFileSync(w.answersPath, "")
  const empty = factBaseSha256(w.opts)
  fs.rmSync(w.answersPath)
  const absent = factBaseSha256(w.opts)
  assert.notEqual(empty, absent)
  assert.match(absent, /^[0-9a-f]{64}$/)
})

test("the digest is stable across calls and independent of file order on disk", (t) => {
  const w = ws(t)
  assert.equal(factBaseSha256(w.opts), factBaseSha256(w.opts))
  // Swapping the two files' CONTENTS changes the digest: the names are in it.
  const p = fs.readFileSync(w.profilePath, "utf8")
  const a = fs.readFileSync(w.answersPath, "utf8")
  const original = factBaseSha256(w.opts)
  fs.writeFileSync(w.profilePath, a)
  fs.writeFileSync(w.answersPath, p)
  assert.notEqual(factBaseSha256(w.opts), original)
})

// --- which documents get a row -------------------------------------------------

test("only a document inside a job workspace has a slug", (t) => {
  const w = ws(t)
  const { resume } = w.job("acme-dev", {})
  assert.equal(slugForDocument(resume, { jobsDir: w.jobsDir }), "acme-dev")
  assert.equal(
    slugForDocument(path.join(w.root, "scratch.md"), { jobsDir: w.jobsDir }),
    null,
    "a scratch file vouches for nothing and must not write a row",
  )
  assert.equal(
    slugForDocument(path.join(w.jobsDir, "loose.md"), { jobsDir: w.jobsDir }),
    null,
    "a file directly in jobs/ has no slug",
  )
  assert.equal(
    slugForDocument(path.join(w.jobsDir, ".auto", "runs", "x.jsonl"), {
      jobsDir: w.jobsDir,
    }),
    null,
    "jobs/.auto is machinery, not a workspace",
  )
  assert.equal(
    slugForDocument(path.join(w.jobsDir, "a", "b", "c.md"), {
      jobsDir: w.jobsDir,
    }),
    null,
  )
})

test("verificationIdentity pins the bytes and the fact base, or returns null", (t) => {
  const w = ws(t)
  const { resume } = w.job("acme-dev", { resume: "# One\n" })
  const id = verificationIdentity(resume, w.opts)
  assert.equal(id.slug, "acme-dev")
  assert.equal(id.doc_sha256, sha256File(resume))
  assert.equal(id.profile_sha256, factBaseSha256(w.opts))
  assert.equal(verificationIdentity(path.join(w.root, "nope.md"), w.opts), null)
})

// --- the falsifiable check -----------------------------------------------------

test("a resume with no passing row is not verified, however present the file is", (t) => {
  const w = ws(t)
  const db = w.db()
  const { resume } = w.job("acme-dev", {})
  assert.ok(fs.existsSync(resume), "the file exists — that is the old evidence")
  assert.equal(
    hasVerifiedResume(db, "acme-dev", {
      ...w.opts,
      hasPassing: hasPassingVerification,
    }),
    false,
  )
})

test("a recorded FAILURE is not verification either", (t) => {
  const w = ws(t)
  const db = w.db()
  const { resume } = w.job("acme-dev", {})
  recordVerification(db, {
    ...verificationIdentity(resume, w.opts),
    mode: "resume",
    verdict: "fail",
  })
  assert.equal(
    hasVerifiedResume(db, "acme-dev", {
      ...w.opts,
      hasPassing: hasPassingVerification,
    }),
    false,
  )
})

test("editing profile.yaml invalidates an existing verification", (t) => {
  const w = ws(t)
  const db = w.db()
  const { resume } = w.job("acme-dev", {})
  recordVerification(db, {
    ...verificationIdentity(resume, w.opts),
    mode: "resume",
    verdict: "pass",
  })
  const check = () =>
    hasVerifiedResume(db, "acme-dev", {
      ...w.opts,
      hasPassing: hasPassingVerification,
    })
  assert.equal(check(), true)

  fs.appendFileSync(w.profilePath, "\n# the user added a job\n")
  assert.equal(
    check(),
    false,
    "the corpus the document was checked against no longer exists",
  )

  // Re-verifying against the new fact base restores it, and does not pile up
  // a second row for the same bytes.
  recordVerification(db, {
    ...verificationIdentity(resume, w.opts),
    mode: "resume",
    verdict: "pass",
  })
  assert.equal(check(), true)
  assert.equal(readVerifications(db, "acme-dev").length, 1)
})

test("editing the resume invalidates its own verification", (t) => {
  const w = ws(t)
  const db = w.db()
  const { resume } = w.job("acme-dev", {})
  recordVerification(db, {
    ...verificationIdentity(resume, w.opts),
    mode: "resume",
    verdict: "pass",
  })
  fs.writeFileSync(resume, "# Resume\n- invented: Kubernetes\n")
  assert.equal(
    hasVerifiedResume(db, "acme-dev", {
      ...w.opts,
      hasPassing: hasPassingVerification,
    }),
    false,
  )
  // The old row is still there — it is just no longer about this document.
  assert.equal(readVerifications(db, "acme-dev").length, 1)
})

test("a cover-letter verification does not vouch for the resume", (t) => {
  const w = ws(t)
  const db = w.db()
  const { resume } = w.job("acme-dev", {})
  recordVerification(db, {
    ...verificationIdentity(resume, w.opts),
    mode: "cover-letter",
    verdict: "pass",
  })
  assert.equal(
    hasVerifiedResume(db, "acme-dev", {
      ...w.opts,
      hasPassing: hasPassingVerification,
    }),
    false,
  )
})

test("hasVerifiedResume refuses to run without a real check rather than failing open", (t) => {
  const w = ws(t)
  const db = w.db()
  w.job("acme-dev", {})
  assert.throws(
    () => hasVerifiedResume(db, "acme-dev", w.opts),
    /requires db.mjs's hasPassingVerification/,
  )
})

// --- the map the tier classifier consumes --------------------------------------

test("verifiedResumeUrls returns only slugs whose row still matches disk", (t) => {
  const w = ws(t)
  const db = w.db()
  const good = w.job("good-co", { url: "https://boards.test/good" })
  const edited = w.job("edited-co", { url: "https://boards.test/edited" })
  const stale = w.job("stale-co", { url: "https://boards.test/stale" })
  w.job("never-checked", { url: "https://boards.test/never" })

  for (const doc of [good, edited, stale])
    recordVerification(db, {
      ...verificationIdentity(doc.resume, w.opts),
      mode: "resume",
      verdict: "pass",
    })
  fs.writeFileSync(edited.resume, "# edited after verification\n")
  // stale-co's row is against a fact base that is about to change...
  const before = new Map(
    verifiedResumeUrls(db, { ...w.opts, hasPassing: hasPassingVerification }),
  )
  assert.deepEqual(
    [...before.keys()].sort(),
    ["https://boards.test/good", "https://boards.test/stale"],
    "the edited document and the never-checked one are both out",
  )

  fs.appendFileSync(w.profilePath, "\n# user edit\n")
  const after = verifiedResumeUrls(db, {
    ...w.opts,
    hasPassing: hasPassingVerification,
  })
  assert.equal(
    after.size,
    0,
    "a fact-base edit invalidates all of them at once",
  )
})

test("verifiedResumeUrls drops a verified slug whose workspace is gone or unreadable", (t) => {
  const w = ws(t)
  const db = w.db()
  const gone = w.job("gone-co", { url: "https://boards.test/gone" })
  const broken = w.job("broken-co", { url: "https://boards.test/broken" })
  for (const doc of [gone, broken])
    recordVerification(db, {
      ...verificationIdentity(doc.resume, w.opts),
      mode: "resume",
      verdict: "pass",
    })
  fs.rmSync(gone.dir, { recursive: true, force: true })
  fs.writeFileSync(path.join(broken.dir, "job.json"), "{not json")

  assert.equal(
    verifiedResumeUrls(db, { ...w.opts, hasPassing: hasPassingVerification })
      .size,
    0,
  )
})

test("verifiedResumeUrls refuses to run without the verification check", (t) => {
  const w = ws(t)
  const db = w.db()
  assert.throws(
    () => verifiedResumeUrls(db, w.opts),
    /requires db.mjs's hasPassingVerification/,
  )
})

// --- and what the classifier does with it --------------------------------------

const LEAD = {
  id: "l1",
  company: "Acme",
  title: "Dev",
  apply_url: "https://boards.greenhouse.io/acme/jobs/1",
}

test("a resume with no passing verification row classifies as blocked", (t) => {
  const w = ws(t)
  const db = w.db()
  w.job("acme-dev", { url: LEAD.apply_url })
  const verified = verifiedResumeUrls(db, {
    ...w.opts,
    hasPassing: hasPassingVerification,
  })
  const r = classify(LEAD, {
    profileApproved: true,
    hasVerifiedResume: verified.has(LEAD.apply_url),
    stages: { ok: true },
  })
  assert.equal(r.tier, "blocked")
  assert.match(r.reason, /no passing verify-claims row/)
})

test("the same lead is not blocked once a matching row exists", (t) => {
  const w = ws(t)
  const db = w.db()
  const doc = w.job("acme-dev", { url: LEAD.apply_url })
  recordVerification(db, {
    ...verificationIdentity(doc.resume, w.opts),
    mode: "resume",
    verdict: "pass",
  })
  const verified = verifiedResumeUrls(db, {
    ...w.opts,
    hasPassing: hasPassingVerification,
  })
  assert.equal(verified.get(LEAD.apply_url), "acme-dev")
  const r = classify(LEAD, {
    profileApproved: true,
    hasVerifiedResume: verified.has(LEAD.apply_url),
    stages: { ok: true },
  })
  assert.notEqual(r.tier, "blocked")
})

test("the model-written resume_status is not load-bearing for the tier", (t) => {
  const w = ws(t)
  const db = w.db()
  w.job("acme-dev", { url: LEAD.apply_url })
  // A context.json claiming the resume is verified is a MODEL's assertion, and
  // the classifier must not take it as one. There is no ctx key for it, and
  // passing one changes nothing.
  const r = classify(
    {
      ...LEAD,
      resume_status: "verified",
      context: { resume_status: "verified" },
    },
    {
      profileApproved: true,
      hasVerifiedResume: verifiedResumeUrls(db, {
        ...w.opts,
        hasPassing: hasPassingVerification,
      }).has(LEAD.apply_url),
      stages: { ok: true },
      resume_status: "verified",
    },
  )
  assert.equal(r.tier, "blocked")
  assert.match(r.reason, /no passing verify-claims row/)
})

// --- the row's own guards -------------------------------------------------------

test("a verification row without both hashes is refused", (t) => {
  const w = ws(t)
  const db = w.db()
  assert.throws(
    () =>
      recordVerification(db, {
        slug: "s",
        mode: "resume",
        verdict: "pass",
        doc_sha256: "a".repeat(64),
      }),
    /requires both doc_sha256 and profile_sha256/,
  )
  assert.throws(
    () =>
      recordVerification(db, {
        slug: "s",
        mode: "keyword-plan",
        verdict: "pass",
        doc_sha256: "a".repeat(64),
        profile_sha256: "b".repeat(64),
      }),
    /mode 'resume' or 'cover-letter'/,
  )
  assert.throws(
    () =>
      recordVerification(db, {
        mode: "resume",
        verdict: "pass",
        doc_sha256: "a".repeat(64),
        profile_sha256: "b".repeat(64),
      }),
    /requires a slug/,
  )
  assert.equal(readVerifications(db).length, 0)
})

test("hasPassingVerification is false when any part of the key is missing", (t) => {
  const w = ws(t)
  const db = w.db()
  assert.equal(hasPassingVerification(db, {}), false)
  assert.equal(
    hasPassingVerification(db, { slug: "s", doc_sha256: "a".repeat(64) }),
    false,
    "a doc hash alone is not evidence",
  )
})
