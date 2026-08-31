#!/usr/bin/env node
// What "verified" means, in one place.
//
// THE HOLE THIS CLOSES. Until now the only evidence that a tailored document
// had passed verify-claims was that the file existed: automatability.mjs walked
// jobs/*/ and treated any workspace holding a resume.md as verified. So a draft
// nobody had ever checked, or one checked and then edited, or one checked
// against a fact base the user has since rewritten, all read as "verified" —
// on the path that decides whether an application may be sent unattended. Hard
// rule 1 is the guarantee that a tailored document contains only facts from the
// fact base, and file existence is not evidence of it.
//
// A verification is now a ROW (db.mjs's `verifications`), and it is evidence
// only while BOTH of its hashes still hold:
//
//   doc_sha256      the exact bytes that were checked. Edit the document and
//                   its own verification stops applying to it.
//   profile_sha256  the fact base they were checked AGAINST. The user edits
//                   profile.yaml and every outstanding verification lapses at
//                   once, because the corpus R3/R4/R5/R6 compared the document
//                   to no longer exists.
//
// ONE FUNCTION COMPUTES profile_sha256, and that is the point of this module.
// verify-claims.mjs writes the row and automatability.mjs reads it; if the two
// hashed the fact base differently they would never agree, and the failure
// would be silent and OPEN — "no matching row" reads exactly like "never
// verified", so a hashing mismatch would look like a conservative refusal right
// up until someone "fixed" it by loosening the comparison.
//
// WHAT profile_sha256 COVERS: profile/profile.yaml and profile/answers.yaml,
// hashed as raw bytes, combined in a FIXED order (profile.yaml first) with each
// file's name in the digest input. Both files, because buildFactIndex and
// evidenceText both read both — an answer in answers.yaml can be the sole
// support for a claim, so a change there must invalidate just as a change to
// profile.yaml does. Named and ordered rather than concatenated, so a byte
// moving from one file to the other changes the digest. A missing file
// contributes the literal "-" rather than throwing: an absent answers.yaml is a
// legitimate state, and it must produce a different digest from an empty one.
import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
)

export const PROFILE_PATH = path.join(ROOT, "profile", "profile.yaml")
export const ANSWERS_PATH = path.join(ROOT, "profile", "answers.yaml")
export const JOBS_DIR = path.join(ROOT, "jobs")

const hex = (buf) => crypto.createHash("sha256").update(buf).digest("hex")

/** sha256 of a file's raw bytes, or null when it does not exist. */
export function sha256File(file) {
  try {
    return hex(fs.readFileSync(file))
  } catch {
    return null
  }
}

/**
 * The one digest of the fact base. See the header for what it covers and why.
 *
 * Always returns a hash, even when both files are missing — the caller that
 * needs to know a file was absent asks for it directly, and a verifier that
 * threw here would fail for a reason that has nothing to do with the document.
 */
export function factBaseSha256({
  profilePath = PROFILE_PATH,
  answersPath = ANSWERS_PATH,
} = {}) {
  const parts = [
    ["profile.yaml", sha256File(profilePath)],
    ["answers.yaml", sha256File(answersPath)],
  ]
  return hex(parts.map(([name, h]) => `${name}:${h ?? "-"}`).join("\n"))
}

/**
 * The slug a document belongs to, or null.
 *
 * A slug exists only for a file sitting directly inside `<jobsDir>/<slug>/`.
 * That is deliberately narrow, and it is what keeps verification rows out of
 * the store when the tests (and anyone verifying a scratch file) point
 * verify-claims at a fixture: no workspace, no slug, no row. It also means a
 * row can never be written for a slug that has no workspace to hold the
 * document it vouches for.
 */
export function slugForDocument(file, { jobsDir = JOBS_DIR } = {}) {
  const abs = path.resolve(file)
  const rel = path.relative(path.resolve(jobsDir), abs)
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null
  const parts = rel.split(path.sep).filter(Boolean)
  if (parts.length !== 2) return null // <slug>/<file>, nothing deeper
  if (parts[0].startsWith(".")) return null // jobs/.auto, jobs/.field-cache…
  return parts[0]
}

/**
 * The identity of one verification: which slug, which bytes, which fact base.
 * Returns null when the document is not in a job workspace.
 */
export function verificationIdentity(
  file,
  {
    jobsDir = JOBS_DIR,
    profilePath = PROFILE_PATH,
    answersPath = ANSWERS_PATH,
  } = {},
) {
  const slug = slugForDocument(file, { jobsDir })
  if (!slug) return null
  const doc_sha256 = sha256File(file)
  if (!doc_sha256) return null
  return {
    slug,
    doc_sha256,
    profile_sha256: factBaseSha256({ profilePath, answersPath }),
  }
}

/**
 * Does a passing verification exist for the resume currently on disk for this
 * slug, against the fact base currently on disk?
 *
 * Three ways this is false, and none of them is "the file is missing" alone:
 * no row, a row for different document bytes, or a row for a different fact
 * base. All three are the same answer to the caller — not verified — and all
 * three are fixed the same way: re-run verify-claims.
 *
 * `hasPassing` is db.mjs's hasPassingVerification, INJECTED rather than
 * imported: this module is also loaded by verify-claims.mjs, which must stay
 * usable without pulling in node:sqlite when the document is not in a
 * workspace. Required — a default would have to be "no check", and a verifier
 * that defaults to no check fails open.
 */
export function hasVerifiedResume(
  db,
  slug,
  {
    jobsDir = JOBS_DIR,
    profilePath = PROFILE_PATH,
    answersPath = ANSWERS_PATH,
    mode = "resume",
    file = null,
    hasPassing,
  } = {},
) {
  if (typeof hasPassing !== "function")
    throw new TypeError(
      "hasVerifiedResume requires db.mjs's hasPassingVerification — without " +
        "it there is no verification check at all",
    )
  if (!slug) return false
  const doc = file ?? path.join(jobsDir, slug, "resume.md")
  const doc_sha256 = sha256File(doc)
  if (!doc_sha256) return false
  const profile_sha256 = factBaseSha256({ profilePath, answersPath })
  return !!hasPassing(db, { slug, mode, doc_sha256, profile_sha256 })
}

/**
 * Every slug whose resume.md on disk has a passing verification against the
 * fact base on disk, mapped to the apply URL its workspace names.
 *
 * THE DIRECTION OF THE WALK IS THE FIX. The deleted heuristic walked every
 * directory in jobs/ and asked "is there a resume here?"; this walks the
 * verification ROWS and asks "does the file those bytes were checked as still
 * exist, unchanged, and does its workspace name a URL?". A workspace with no
 * row is never reached, which is exactly the case that used to pass.
 *
 * @param hasPassing db.mjs's hasPassingVerification, injected so this file does
 *   not import node:sqlite for callers that already hold a connection.
 */
export function verifiedResumeUrls(
  db,
  {
    jobsDir = JOBS_DIR,
    profilePath = PROFILE_PATH,
    answersPath = ANSWERS_PATH,
    rows = null,
    hasPassing,
  } = {},
) {
  if (typeof hasPassing !== "function")
    throw new TypeError(
      "verifiedResumeUrls requires db.mjs's hasPassingVerification — without " +
        "it there is no verification check, only a directory listing",
    )
  const profile_sha256 = factBaseSha256({ profilePath, answersPath })
  const candidates =
    rows ??
    db
      .prepare(
        "SELECT DISTINCT slug FROM verifications WHERE mode = 'resume' AND verdict = 'pass'",
      )
      .all()
  const out = new Map()
  for (const { slug } of candidates) {
    const doc_sha256 = sha256File(path.join(jobsDir, slug, "resume.md"))
    if (!doc_sha256) continue // the verified document is gone
    if (!hasPassing(db, { slug, mode: "resume", doc_sha256, profile_sha256 }))
      continue // edited since, or the fact base moved under it
    let job
    try {
      job = JSON.parse(
        fs.readFileSync(path.join(jobsDir, slug, "job.json"), "utf8"),
      )
    } catch {
      continue // an unreadable workspace vouches for nothing
    }
    const url = job.apply_url || job.url || job.source_url
    if (url) out.set(url, slug)
  }
  return out
}
