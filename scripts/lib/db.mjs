#!/usr/bin/env node
// Storage for the lead store. Deterministic, no LLM, no network.
//
// WHY SQLITE (and not MongoDB/MySQL, which were the other candidates):
// this is a single-user CLI on a Windows laptop. Mongo and MySQL both need a
// server daemon running before any script can do anything — if it is not up,
// the whole pipeline fails. SQLite is a single file with no daemon, it is
// built into Node 22.5+ as `node:sqlite` (so zero new dependencies on top of
// js-yaml and marked), and it is ACID.
//
// WHAT IT FIXES, measured on the real store (99 leads, 321 KB):
//   - jobs/leads.json was fully parsed AND fully rewritten on every mutation.
//     Marking 57 leads dismissed meant 57 full read+rewrite cycles — O(n^2).
//     A single-row UPDATE replaces that.
//   - reads filtered by status scanned every lead; now they hit an index.
//
// JSON is still a first-class input so tests can keep pointing --leads at a
// fixture, and so a store can be inspected or restored by hand.
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { loadYamlFile } from "./lib.mjs"

// node:sqlite is stable enough to depend on but still emits an
// ExperimentalWarning on first use. These scripts are parsed by agents from
// stdout/stderr, so a warning on every invocation is real noise; drop just
// that one and leave every other warning intact.
const emitWarning = process.emitWarning.bind(process)
process.emitWarning = (warning, ...rest) => {
  if (String(warning).includes("SQLite is an experimental feature")) return
  return emitWarning(warning, ...rest)
}
const { DatabaseSync } = await import("node:sqlite")

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
)
export const DB_PATH = path.join(ROOT, "jobs", "leads.db")
// Legacy location only. There is no standing leads.json any more — it was a
// snapshot that went stale the moment a sweep ran. This remains so a repo that
// still has one (or a fresh checkout restoring from a snapshot) can be read
// before `migrate.mjs` builds the database.
export const JSON_PATH = path.join(ROOT, "jobs", "leads.json")
export const APPLICATIONS_PATH = path.join(ROOT, "profile", "applications.yaml")

// The lead is stored as its own JSON document, with only the queried fields
// denormalized into columns for indexing.
//
// This shape was chosen after a column-per-field version failed its own
// round-trip check on 73 of 99 real leads: mapping fields by hand cannot
// distinguish `flags: []` from no flags, or `notes: ""` from `notes: null`,
// and each such case silently altered a lead. Keeping the document verbatim
// makes fidelity structural rather than something 15 mappings must get right,
// and json_set() keeps the denormalized columns in step on update.
const INDEXED = ["status", "company", "title", "posted_at"]

const SCHEMA = `
CREATE TABLE IF NOT EXISTS leads (
  id        TEXT PRIMARY KEY,
  status    TEXT,
  company   TEXT,
  title     TEXT,
  posted_at TEXT,
  doc       TEXT NOT NULL   -- the complete lead object, verbatim
);
CREATE INDEX IF NOT EXISTS idx_leads_status  ON leads(status);
CREATE INDEX IF NOT EXISTS idx_leads_company ON leads(company);
CREATE INDEX IF NOT EXISTS idx_leads_posted  ON leads(posted_at);

-- Keywords (tech/tooling) seen in a lead's title and description, extracted
-- once at ingest instead of re-parsed from raw descriptions on every analysis.
-- A separate table rather than a field on the lead so the interesting question
-- is a GROUP BY: "what do the jobs that rejected me keep asking for?"
CREATE TABLE IF NOT EXISTS lead_keywords (
  lead_id TEXT NOT NULL,
  keyword TEXT NOT NULL,
  PRIMARY KEY (lead_id, keyword)
);
CREATE INDEX IF NOT EXISTS idx_kw_keyword ON lead_keywords(keyword);

-- Submitted applications. profile/applications.yaml stays on disk as the
-- user-owned backup, but it is append-only and unbounded, and every consumer
-- re-parsed the whole file; this makes lookups indexed and updates single-row.
CREATE TABLE IF NOT EXISTS applications (
  slug       TEXT PRIMARY KEY,
  company    TEXT,
  title      TEXT,
  applied_at TEXT,
  status     TEXT,
  doc        TEXT NOT NULL   -- the complete application object, verbatim
);
CREATE INDEX IF NOT EXISTS idx_apps_company ON applications(company);
CREATE INDEX IF NOT EXISTS idx_apps_applied ON applications(applied_at);

-- Per-lead screening verdicts, keyed by WHO produced them.
--
-- The source column is the whole point. The mechanical screen
-- (scripts/leads/screen.mjs) is regex over stored text and costs ~125 ms for
-- the entire store, so caching it saves nothing; it is kept because a verdict
-- with no history cannot be audited. The expensive source is "model" — the
-- pipeline-jobs Stage A read, which fetches the live posting and judges
-- ghost/scam/culture signals. That verdict used to be discarded, so
-- re-screening a lead paid for it again. Now it is looked up.
--
-- Latest verdict per (lead, source), not an append-only log: nothing reads
-- screening history, and a row per re-run grows without bound. A mechanical
-- verdict must never satisfy a caller looking for a model one, which is exactly
-- what a single-verdict-per-lead table would have allowed.
--
-- doc holds the verdict verbatim (signals, reason, years_required, whatever a
-- later screen learns to emit) for the same reason leads.doc does: columns
-- mapped by hand lose the difference between "no signals" and "not recorded".
-- The stack/keywords half of a screen is NOT duplicated here — lead_keywords
-- already extracts that at ingest.
CREATE TABLE IF NOT EXISTS screens (
  lead_id     TEXT NOT NULL,
  source      TEXT NOT NULL,   -- 'mechanical' | 'model'
  verdict     TEXT NOT NULL,
  screened_at TEXT NOT NULL,
  doc         TEXT NOT NULL,
  PRIMARY KEY (lead_id, source)
);
CREATE INDEX IF NOT EXISTS idx_screens_source ON screens(source, verdict);

-- Archived job workspaces. jobs/<slug>/ is the live form while an application
-- is open — editable, diffable, and what verify-claims and render-pdf already
-- read. Once an application closes the directory is folded in here and removed,
-- so a listing of jobs/ shows live work only. (It reached ~100 folders, at
-- which point nobody could see which application was actually in flight.)
--
-- One row per FILE, holding the exact bytes. Same reasoning as leads.doc: a
-- schema that re-maps a file's contents into fields cannot round-trip it, and
-- an archive that cannot round-trip is not an archive. The bytes and sha256
-- columns are derived from content, not a second-hand copy of it, and exist so
-- that a restore can prove itself.
--
-- content IS NULL means "regenerable, deliberately not stored": PDFs are
-- deterministic output of render-pdf.mjs, so the markdown is the artifact worth
-- keeping and the PDF is rebuilt on demand. The row survives so a restore can
-- still say what was there.
--
-- Nothing rebuilds this table. Unlike leads (re-derivable from a sweep) and
-- applications (exported to YAML), an archived workspace has no other on-disk
-- source once the directory is gone — migrate.mjs must never touch it.
CREATE TABLE IF NOT EXISTS documents (
  slug        TEXT NOT NULL,
  name        TEXT NOT NULL,   -- file name within jobs/<slug>/
  content     BLOB,            -- exact bytes, or NULL when regenerable
  bytes       INTEGER NOT NULL,
  sha256      TEXT NOT NULL,
  archived_at TEXT NOT NULL,
  PRIMARY KEY (slug, name)
);
CREATE INDEX IF NOT EXISTS idx_docs_slug ON documents(slug);

-- Board productivity over time. A single audit is a snapshot; pruning a board
-- should be driven by history, so every sweep appends its counts here.
CREATE TABLE IF NOT EXISTS board_stats (
  board_id           TEXT PRIMARY KEY,
  type               TEXT,
  slug               TEXT,
  company            TEXT,
  last_swept         TEXT,
  live_postings      INTEGER DEFAULT 0,
  qualifying         INTEGER DEFAULT 0,
  solid              INTEGER DEFAULT 0,
  leads_produced     INTEGER DEFAULT 0,
  last_qualifying_at TEXT,
  -- The row is a SNAPSHOT: one row per board, upserted. Every counter above
  -- except leads_produced is overwritten each sweep, so "has this board been
  -- quiet for a while?" was not answerable from it — the only durable trace of
  -- a dry sweep was last_qualifying_at failing to move, which reads the same
  -- after one dry sweep as after twenty. These two make the streak additive:
  -- sweeps counts data points, zero_streak counts consecutive dry ones and
  -- resets to 0 the moment a board yields something reachable. A removal
  -- proposal needs both, because a streak of 0 is ambiguous on its own — it
  -- means "just yielded" AND "never counted yet".
  sweeps             INTEGER DEFAULT 0,
  zero_streak        INTEGER DEFAULT 0
);

-- Unattended auto-apply runs. One row per run of scripts/auto/auto-apply.mjs.
--
-- This is the SECOND of two copies, not the only one. jobs/.auto/runs/ holds
-- the same events as append-only JSONL, and that is the copy that survives:
-- jobs/ is gitignored, this database has no on-disk source for anything it
-- alone holds, and an unattended process is exactly the one whose history
-- nobody is watching accumulate. The table exists because the JSONL cannot be
-- queried ("how many times have we written to this company this week?" is a
-- cap question that must be answered before the next submit, cheaply).
--
-- profile_sha_start / profile_sha_end are the two hashes of profile.yaml and
-- answers.yaml taken at the ends of the run. The auto path is forbidden to
-- write to profile/ at all, so these differing is not an audit detail, it is
-- an alarm: either something wrote the fact base during an unattended run, or
-- the user edited it mid-run and the run was reasoning about a snapshot that
-- no longer holds.
CREATE TABLE IF NOT EXISTS auto_runs (
  run_id            TEXT PRIMARY KEY,
  started_at        TEXT NOT NULL,
  finished_at       TEXT,
  mode              TEXT,            -- 'dry_run' | 'live'
  outcome           TEXT,            -- 'ok' | 'stopped' | 'error' | 'running'
  planned           INTEGER DEFAULT 0,
  submitted         INTEGER DEFAULT 0,
  deferred          INTEGER DEFAULT 0,
  failed            INTEGER DEFAULT 0,
  stop_reason       TEXT,            -- why the runner disabled itself, if it did
  profile_sha_start TEXT,
  profile_sha_end   TEXT,
  jsonl             TEXT,            -- path to the surviving copy
  doc               TEXT NOT NULL    -- the complete run record, verbatim
);
CREATE INDEX IF NOT EXISTS idx_auto_runs_started ON auto_runs(started_at);

-- One row per application the auto path SUBMITTED, and the ledger the
-- blast-radius caps are counted from. Separate from auto_runs because
-- per_company_max_per_week is a GROUP BY over companies and dates, not a scan
-- of run documents.
--
-- confirmation_url is here for one reason: manual withdrawal. An application
-- cannot be unsent, so the least the record can do is make undoing it one
-- click rather than an archaeology exercise.
--
-- A dry-run row is recorded too, with mode 'dry_run' and no confirmation url:
-- the point of the dry run is that its counts and its cap arithmetic are the
-- same ones a live run would have done, so a cap query that silently ignored
-- them would be testing different code than it protects.
--
-- The outcome column exists because the row is written BEFORE the click, not
-- after it. (No backticks in here, ever: SCHEMA is a template literal and one
-- backtick in its SQL ends the string — which is exactly how this comment
-- failed the first time it was written.)
-- 'attempted' means the runner was about to click and nothing has confirmed
-- what happened next; 'submitted' means the click returned and was recorded.
-- The caps count BOTH, because the failure this shape exists for is the
-- process being killed one second after the click (Task Scheduler's
-- ExecutionTimeLimit): the application is in the employer's ATS, and a ledger
-- that only knows about acknowledged submits would let the next run apply
-- again. An attempt is a submission until proven otherwise.
-- THE KEY IS (slug, mode), NOT (run_id, slug), and not (slug) either.
--
-- (run_id, slug) was backwards for a row whose job is to be a CLAIM: the same
-- slug could be submitted once per RUN with no conflict at all, so the ledger
-- could not refuse a second application to the same posting tomorrow. (slug)
-- alone is wrong in the other direction: dry-run rows live in this same table
-- on purpose, so a rehearsal would pre-consume the live claim forever and the
-- first real run after an enable would find every slug already taken.
--
-- mode is NOT NULL DEFAULT 'live' because SQLite permits NULLs in the columns
-- of a non-INTEGER primary key, and a NULL mode would therefore not conflict
-- with anything -- an unlimited number of un-refusable duplicate rows. An
-- unknown mode counts as live everywhere else in this file too; nothing that
-- reached this ledger without saying it was a rehearsal gets the benefit of
-- the doubt.
CREATE TABLE IF NOT EXISTS auto_submissions (
  run_id           TEXT NOT NULL,
  slug             TEXT NOT NULL,
  company          TEXT,
  title            TEXT,
  submitted_at     TEXT NOT NULL,    -- of the ATTEMPT; refreshed when it is acknowledged
  mode             TEXT NOT NULL DEFAULT 'live',   -- 'dry_run' | 'live'
  plan_sha256      TEXT,
  confirmation_url TEXT,
  outcome          TEXT,             -- 'attempted' | 'submitted' | 'abandoned' | 'reconciled-not-sent'
  apply_url        TEXT,             -- where the click was aimed, for an orphaned attempt
  doc              TEXT NOT NULL,    -- verify block, consent labels, screenshots
  PRIMARY KEY (slug, mode)
);
CREATE INDEX IF NOT EXISTS idx_auto_subs_company ON auto_submissions(company, submitted_at);
CREATE INDEX IF NOT EXISTS idx_auto_subs_at ON auto_submissions(submitted_at);
CREATE INDEX IF NOT EXISTS idx_auto_subs_run ON auto_submissions(run_id);

-- The per-application ledger of an unattended run: one row per slug, carrying
-- the state machine, so a process killed at application 437 of 999 loses
-- nothing and the next invocation resumes by READING THIS TABLE rather than by
-- re-deriving what it thinks it already did.
--
-- Before this table there was no per-application state anywhere. auto_runs
-- holds counters (planned/submitted/deferred/failed) and auto_submissions gets
-- a row only at click time, so "which 436 were done" had no queryable answer.
--
-- slug is the primary key, and that is the coordination primitive: the claim is
-- an INSERT whose conflict clause only fires for a row still in 'queued', so
-- ZERO CHANGES MEANS ANOTHER WORKER OWNS THIS SLUG AND THIS ONE MUST NOT CLICK.
-- It is one statement, so two workers racing it cannot both win.
--
-- states, in order:
--   queued -> claimed -> planned -> authorized -> attempted
--             -> submitted | challenged | deferred | failed
--
-- 'attempted' is the one state that is NEVER reclaimed automatically. The click
-- may already have reached the employer, and re-running it is the carpet-bomb
-- this whole machinery exists to prevent; releaseStaleAutoClaims deliberately
-- refuses to touch it and leaves it for a human and the orphan-attempt brake.
--
-- origin is carried and not read. It is the exclusion key a later phase needs
-- (which sweep/board/source put this slug in the queue), and a column added
-- later cannot be back-filled for the rows that mattered.
--
-- reason_kind / reason_detail exist because hard rule 6 forbids a silent skip:
-- an application the runner declined to send must say WHY, in terms the user
-- can act on, and a terminal 'deferred' row with no reason is exactly the
-- silent skip the rule names.
--
-- posted_at is SNAPSHOTTED here rather than joined from leads, for the same
-- reason origin is carried: the metric it feeds -- how long a posting waits
-- between going up and being applied to -- must survive the lead being pruned
-- or archived, and a join that silently loses its oldest rows reports a
-- latency distribution missing exactly the tail anybody cares about.
--
-- reason_kind is a CLOSED type (AUTO_DEFER_KINDS / AUTO_FAILURE_KINDS below),
-- not a sentence, and reason_stage says where in the state machine the job
-- stopped. Together with board_key those three columns are what makes the
-- defer log aggregable: "unprobed-dropdown at plan on greenhouse cost 61
-- applications this week" is a GROUP BY, not a string match. reason_detail
-- carries the sanitised human half, and only that half is free text.
--
-- wall_ms is HOW LONG THIS JOB TOOK, end to end, in the worker that ran it:
-- claim to terminal state, browser included. runJob has computed it since the
-- queue existed and wrote it nowhere, so every per-application latency
-- question ("is a fill slower than it was last week", "which stage eats the
-- time") had no data behind it at all and the digest reported n=0.
--
-- It is a PER-JOB number and belongs on the per-job row: an average kept on
-- auto_runs could not answer the question anyone asks first, which is which
-- jobs are the slow ones. Read together with reason_stage it gives a
-- distribution per stage, which is the shape a regression shows up in --
-- a p95 that moves while the median does not is a tail, not a slowdown.
--
-- NULL means unrecorded, never zero: rows written before this column existed,
-- and the not-claimed case, which does no work and writes nothing.
CREATE TABLE IF NOT EXISTS auto_queue (
  slug          TEXT PRIMARY KEY,
  run_id        TEXT,
  board_key     TEXT,
  origin        TEXT,
  state         TEXT NOT NULL,
  attempt_no    INTEGER NOT NULL DEFAULT 0,
  plan_sha256   TEXT,
  reason_kind   TEXT,
  reason_stage  TEXT,
  reason_detail TEXT,
  posted_at     TEXT,
  claimed_at    TEXT,
  updated_at    TEXT,
  wall_ms       INTEGER
);
CREATE INDEX IF NOT EXISTS idx_auto_queue_state ON auto_queue(state);
CREATE INDEX IF NOT EXISTS idx_auto_queue_run ON auto_queue(run_id);

-- A board the breaker backed off from, made durable so the digest can report
-- it. Paused boards and the jobs they hold are a FIRST-CLASS RUN OUTCOME
-- reported as a number, not an absence: revision 1 of the plan left those jobs
-- sitting in 'queued' with nothing recorded anywhere, so the largest loss
-- bucket of a degraded run was indistinguishable from a run that simply had
-- less to do.
--
-- SCOPED BY run_id ON PURPOSE. A pause is a timed backoff with probe
-- re-admission, never terminal, and never inherited by the next invocation
-- without re-probing -- so readers ask for one run's pauses and a fresh run
-- starts with none. The row survives the process because the DIGEST needs it
-- after the run is over, not because the next run should obey it.
CREATE TABLE IF NOT EXISTS board_pauses (
  board_key     TEXT NOT NULL,
  run_id        TEXT NOT NULL,
  paused_at     TEXT NOT NULL,
  until         TEXT,           -- when the backoff expires and a probe may run
  reason_kind   TEXT,           -- the kind whose signature tripped the breaker
  reason_detail TEXT,
  cleared_at    TEXT,           -- set when a probe job succeeded and re-admitted it
  PRIMARY KEY (board_key, run_id, paused_at)
);
CREATE INDEX IF NOT EXISTS idx_board_pauses_run ON board_pauses(run_id);

-- What verify-claims actually decided, made durable.
--
-- Before this table verification wrote nothing: the only evidence that a
-- document had passed was that a resume.md existed on disk, so every tailored
-- file was "verified" whether it had ever been checked or not. That is a hard
-- rule 1 hole reachable by accident, on the path that submits unattended.
--
-- THE ROW IS ONLY EVIDENCE WHILE BOTH HASHES STILL HOLD. doc_sha256 pins the
-- exact bytes that were checked, so editing the resume invalidates its own
-- verification; profile_sha256 pins the fact base they were checked AGAINST, so
-- the user editing profile.yaml invalidates every outstanding verification at
-- once. A resume verified against yesterday's facts is not verified today --
-- the corpus R3/R4/R5/R6 compared it to no longer exists.
--
-- profile_sha256 is computed by ONE function (lib/verification.mjs's
-- factBaseSha256) used by both the writer and the reader, because a writer and
-- a reader that hash the fact base differently agree on nothing and fail open.
--
-- Keyed by (slug, mode, doc_sha256): re-verifying the same bytes updates in
-- place, and a second draft of the same document keeps its own row rather than
-- silently replacing the record of the first.
CREATE TABLE IF NOT EXISTS verifications (
  slug           TEXT NOT NULL,
  doc_sha256     TEXT NOT NULL,
  mode           TEXT NOT NULL,   -- 'resume' | 'cover-letter'
  verdict        TEXT NOT NULL,   -- 'pass' | 'fail'
  profile_sha256 TEXT NOT NULL,
  verified_at    TEXT NOT NULL,
  doc            TEXT,            -- the verify-claims report, verbatim
  PRIMARY KEY (slug, mode, doc_sha256)
);
CREATE INDEX IF NOT EXISTS idx_verifications_slug ON verifications(slug, mode);

-- The tech stack a job workspace's posting names, so reuse-check.mjs does not
-- re-run the whole tech lexicon over every sibling on every call (Phase 3
-- item 3.4). Derived data, cheap to rebuild, and it is a CACHE in the strict
-- sense: nothing may read it as a source of truth.
--
-- job_sha256 is the invalidation, and it is the whole design. A cached row is
-- used only when it matches the sha256 of the job.json currently on disk, so
-- an edited posting recomputes and a stale row can never be believed. That is
-- the same rule the verifications table uses for doc_sha256, for the same
-- reason: a keyed cache whose key does not cover its input fails open.
CREATE TABLE IF NOT EXISTS workspace_stacks (
  slug        TEXT PRIMARY KEY,
  job_sha256  TEXT NOT NULL,
  title       TEXT,
  company     TEXT,
  stack       TEXT NOT NULL,   -- JSON array of canonical tech terms
  title_toks  TEXT NOT NULL,   -- JSON array of title tokens
  updated_at  TEXT NOT NULL
);
`

export function openDb(file = DB_PATH) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  // FIRST, before any other statement. WAL lets readers run alongside a writer,
  // but writers still serialize, and a writer that arrives while another holds
  // the lock fails IMMEDIATELY unless the connection has been told to wait.
  // That matters now that pipeline-jobs fans out several job-worker subagents,
  // each opening its own connection.
  //
  // The ordering is not cosmetic: switching the journal mode below takes a
  // brief exclusive lock, so four processes opening the same store at once used
  // to have three of them die on `PRAGMA journal_mode = WAL` itself — before
  // any timeout they set afterwards could apply. Every write here is one short
  // statement or a small transaction, so waiting is the right answer and 5s is
  // far beyond what any of them need.
  db.exec("PRAGMA busy_timeout = 5000")
  db.exec("PRAGMA journal_mode = WAL")
  // Each `mark` is its own process, so per-call fsync cost is what the user
  // feels: at full durability 57 sequential updates cost ~246 ms, almost all
  // of it waiting on the disk. NORMAL is the documented companion to WAL —
  // still crash-safe, and it only risks losing the last commits on an OS-level
  // crash, which for a re-derivable lead store is an acceptable trade.
  db.exec("PRAGMA synchronous = NORMAL")
  try {
    // Before SCHEMA, not after: SCHEMA creates an index on screens(source),
    // and that statement is itself what fails against the old shape.
    healScreens(db)
    healAutoSubmissions(db)
    healAutoQueue(db)
    healBoardStats(db)
    db.exec(SCHEMA)
  } catch (e) {
    // An open that throws must not leave the handle behind. On Windows a
    // leaked one keeps a lock on the file, so the next thing to touch it fails
    // with EPERM and the real error is two layers down.
    db.close()
    throw e
  }
  return db
}

// The flat CREATE TABLE IF NOT EXISTS schema has exactly one blind spot: a
// table whose SHAPE changes is left alone, because it already exists. `screens`
// gained a `source` column after being built and never written to, so every
// database in existence has the old four-column version with zero rows in it.
//
// Rebuilding an empty table is not a migration — there is nothing to migrate.
// If it somehow has rows, this refuses rather than dropping them, because
// silently discarding recorded verdicts to fix a schema is the kind of repair
// that loses data. Kept deliberately narrow: it heals this one known case and
// nothing else, so it never becomes an ad-hoc migration chain.
function healScreens(db) {
  const cols = db.prepare("PRAGMA table_info(screens)").all()
  if (!cols.length) return // fresh database — SCHEMA is about to create it
  if (cols.some((c) => c.name === "source")) return
  const { c } = db.prepare("SELECT COUNT(*) c FROM screens").get()
  if (c > 0) {
    throw new Error(
      `screens holds ${c} row(s) in the pre-source schema; back up jobs/leads.db and drop the table to rebuild`,
    )
  }
  db.exec("DROP TABLE screens")
}

// The same blind spot, for auto_submissions: `outcome` and `apply_url` were
// added when the record moved to BEFORE the click, and CREATE TABLE IF NOT
// EXISTS will not add them to a database that already has the old shape.
//
// ADD COLUMN rather than healScreens's drop-and-rebuild, because these rows
// are submitted applications: there is no version of this repair that is
// allowed to lose one. Existing rows get NULL, and readOrphanAttempts treats
// NULL as "not an attempt" — correct, since every row written before this
// column existed was written after its click, by recordSubmission.
//
// THE SECOND PART IS A REBUILD, and it has to be. The primary key moved from
// (run_id, slug) to (slug, mode), and a primary key cannot be changed with ADD
// COLUMN. The same no-losses rule governs it, which forces two decisions:
//
//   * A legacy row with a NULL mode becomes 'live'. Unknown mode already counts
//     as live everywhere else in this file, and SQLite permits NULLs in the
//     columns of a non-INTEGER primary key — so a NULL mode would conflict with
//     nothing and the new key would go unenforced for exactly those rows.
//   * Two rows CAN collide on the new key: the same slug submitted under two
//     run_ids, which the old key permitted by construction. The survivor is the
//     one that most represents a real submission (submitted or legacy beats an
//     attempt, an attempt beats an abandonment, later beats earlier), and the
//     losers are NOT dropped — each is carried verbatim into the survivor's
//     `doc` under `superseded`, because the thing a user needs when withdrawing
//     an application is the record of it, not a tidy table.
function healAutoSubmissions(db) {
  const cols = db.prepare("PRAGMA table_info(auto_submissions)").all()
  if (!cols.length) return // fresh database — SCHEMA creates it with both
  const have = new Set(cols.map((c) => c.name))
  if (!have.has("outcome"))
    db.exec("ALTER TABLE auto_submissions ADD COLUMN outcome TEXT")
  if (!have.has("apply_url"))
    db.exec("ALTER TABLE auto_submissions ADD COLUMN apply_url TEXT")

  const keyCols = cols
    .filter((c) => c.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((c) => c.name)
  if (keyCols.length === 2 && keyCols[0] === "slug" && keyCols[1] === "mode")
    return // already re-keyed
  rebuildAutoSubmissions(db)
}

// Phase 4.1 added reason_stage. Purely additive, so this is an ALTER and not a
// rebuild: `CREATE TABLE IF NOT EXISTS` leaves an existing table alone, and
// every database that predates the column has rows worth keeping in it.
// Existing rows get NULL, which reads as "stage unknown" and is the truth —
// they were written before anything recorded one.
function healAutoQueue(db) {
  const cols = db.prepare("PRAGMA table_info(auto_queue)").all()
  if (!cols.length) return // fresh database — SCHEMA is about to create it
  const have = new Set(cols.map((c) => c.name))
  if (!have.has("reason_stage"))
    db.exec("ALTER TABLE auto_queue ADD COLUMN reason_stage TEXT")
  if (!have.has("posted_at"))
    db.exec("ALTER TABLE auto_queue ADD COLUMN posted_at TEXT")
  // Same additive story as the two above. Existing rows get NULL, which reads
  // as "nobody timed this job" and is the truth — they were written before
  // anything recorded a duration.
  if (!have.has("wall_ms"))
    db.exec("ALTER TABLE auto_queue ADD COLUMN wall_ms INTEGER")
}

// The same additive story again, for board_stats's sweeps/zero_streak.
//
// Deliberately NO `DEFAULT 0` here, unlike the fresh-table SCHEMA above. A
// database that predates these columns has been sweeping for weeks, and 0
// would be a claim about that history — "this board has never been swept" —
// that is simply false, and false in the direction that matters: the removal
// rules key off these counters, and a fabricated 0 would make every existing
// board look brand new. NULL says "not counted", which is the truth, and
// recordBoardStats COALESCEs it to 0 on the next sweep so counting starts here
// rather than pretending to reach backwards.
function healBoardStats(db) {
  const cols = db.prepare("PRAGMA table_info(board_stats)").all()
  if (!cols.length) return // fresh database — SCHEMA is about to create it
  const have = new Set(cols.map((c) => c.name))
  if (!have.has("sweeps"))
    db.exec("ALTER TABLE board_stats ADD COLUMN sweeps INTEGER")
  if (!have.has("zero_streak"))
    db.exec("ALTER TABLE board_stats ADD COLUMN zero_streak INTEGER")
}

// How much a row looks like a real application, for the collision above.
// A legacy NULL outcome ranks just under 'submitted' rather than at the bottom,
// on purpose: every row written before the outcome column existed was written
// AFTER its click.
function submissionRank(outcome) {
  if (outcome === "submitted") return 4
  if (outcome == null) return 3
  if (outcome === "abandoned") return 1
  return 2 // 'attempted', and anything a later version starts writing
}

function rebuildAutoSubmissions(db) {
  const rows = db.prepare("SELECT * FROM auto_submissions").all()
  const groups = new Map()
  for (const r of rows) {
    const key = JSON.stringify([r.slug, r.mode ?? "live"])
    const list = groups.get(key)
    if (list) list.push(r)
    else groups.set(key, [r])
  }

  db.exec("BEGIN IMMEDIATE")
  try {
    db.exec(
      "CREATE TABLE auto_submissions__rekeyed (" +
        "run_id TEXT NOT NULL, slug TEXT NOT NULL, company TEXT, title TEXT," +
        "submitted_at TEXT NOT NULL, mode TEXT NOT NULL DEFAULT 'live'," +
        "plan_sha256 TEXT, confirmation_url TEXT, outcome TEXT, apply_url TEXT," +
        "doc TEXT NOT NULL, PRIMARY KEY (slug, mode))",
    )
    const ins = db.prepare(
      `INSERT INTO auto_submissions__rekeyed
         (run_id, slug, company, title, submitted_at, mode, plan_sha256,
          confirmation_url, outcome, apply_url, doc)
       VALUES ($run_id, $slug, $company, $title, $submitted_at, $mode, $plan_sha256,
               $confirmation_url, $outcome, $apply_url, $doc)`,
    )
    for (const list of groups.values()) {
      const [winner, ...losers] = [...list].sort(
        (a, b) =>
          submissionRank(b.outcome) - submissionRank(a.outcome) ||
          String(b.submitted_at ?? "").localeCompare(
            String(a.submitted_at ?? ""),
          ) ||
          String(b.run_id ?? "").localeCompare(String(a.run_id ?? "")),
      )
      let doc = winner.doc
      if (losers.length) {
        let parsed = null
        try {
          parsed = JSON.parse(winner.doc)
        } catch {
          /* a doc that is not JSON is still kept, wrapped */
        }
        doc = JSON.stringify(
          parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? { ...parsed, superseded: losers }
            : { doc: winner.doc, superseded: losers },
        )
      }
      ins.run({
        run_id: winner.run_id,
        slug: winner.slug,
        company: winner.company ?? null,
        title: winner.title ?? null,
        submitted_at: winner.submitted_at,
        mode: winner.mode ?? "live",
        plan_sha256: winner.plan_sha256 ?? null,
        confirmation_url: winner.confirmation_url ?? null,
        outcome: winner.outcome ?? null,
        apply_url: winner.apply_url ?? null,
        doc,
      })
    }
    // Counted before the old table is destroyed. This is what turns "no version
    // of this repair loses a row" from a comment into a refusal.
    const kept = db
      .prepare("SELECT COUNT(*) c FROM auto_submissions__rekeyed")
      .get().c
    if (kept !== groups.size)
      throw new Error(
        `auto_submissions rebuild kept ${kept} of ${groups.size} distinct (slug, mode) row(s)`,
      )
    db.exec("DROP TABLE auto_submissions")
    db.exec("ALTER TABLE auto_submissions__rekeyed RENAME TO auto_submissions")
    db.exec("COMMIT")
  } catch (e) {
    db.exec("ROLLBACK")
    throw e
  }
}

// --- row <-> lead object -----------------------------------------------------

export function leadToRow(lead) {
  const row = { id: lead.id, doc: JSON.stringify(lead) }
  for (const c of INDEXED) row[c] = lead[c] ?? null
  return row
}

export function rowToLead(row) {
  return JSON.parse(row.doc)
}

// --- source resolution -------------------------------------------------------

// An explicit --leads path is always honoured verbatim (that is how the tests
// point at fixtures). Otherwise prefer the database, falling back to the JSON
// store so a repo that has not migrated yet still works.
export function resolveLeadSource(explicit = null) {
  if (explicit)
    return { kind: explicit.endsWith(".db") ? "db" : "json", file: explicit }
  if (fs.existsSync(DB_PATH)) return { kind: "db", file: DB_PATH }
  return { kind: "json", file: JSON_PATH }
}

// Returns { leads: [...] } — the same shape every consumer already expects.
export function readLeadStore(explicit = null) {
  const src = resolveLeadSource(explicit)
  if (src.kind === "json") {
    if (!fs.existsSync(src.file)) return { leads: [] }
    return JSON.parse(fs.readFileSync(src.file, "utf8"))
  }
  const db = openDb(src.file)
  try {
    const rows = db.prepare("SELECT * FROM leads").all()
    return { leads: rows.map(rowToLead) }
  } finally {
    db.close()
  }
}

export function writeLeadStore(store, explicit = null) {
  const src = resolveLeadSource(explicit)
  if (src.kind === "json") {
    fs.mkdirSync(path.dirname(src.file), { recursive: true })
    fs.writeFileSync(src.file, JSON.stringify(store, null, 2) + "\n")
    return
  }
  const db = openDb(src.file)
  try {
    upsertLeads(db, store.leads ?? [])
  } finally {
    db.close()
  }
}

// --- mutations ---------------------------------------------------------------

const UPSERT = `
INSERT INTO leads (id, ${INDEXED.join(", ")}, doc)
VALUES ($id, ${INDEXED.map((c) => "$" + c).join(", ")}, $doc)
ON CONFLICT(id) DO UPDATE SET
  ${INDEXED.map((c) => `${c} = excluded.${c}`).join(",\n  ")},
  doc = excluded.doc
`

export function upsertLeads(db, leads) {
  const stmt = db.prepare(UPSERT)
  db.exec("BEGIN")
  try {
    for (const l of leads) stmt.run(leadToRow(l))
    db.exec("COMMIT")
  } catch (e) {
    db.exec("ROLLBACK")
    throw e
  }
  return leads.length
}

// The whole point of the migration: one row, not one file. json_set keeps the
// stored document in step with the denormalized status column.
export function setLeadStatus(db, id, status, notes = undefined) {
  if (notes === undefined) {
    return db
      .prepare(
        "UPDATE leads SET status = ?, doc = json_set(doc, '$.status', ?) WHERE id = ?",
      )
      .run(status, status, id).changes
  }
  return db
    .prepare(
      "UPDATE leads SET status = ?, doc = json_set(doc, '$.status', ?, '$.notes', ?) WHERE id = ?",
    )
    .run(status, status, notes, id).changes
}

// --- keywords -----------------------------------------------------------------

// Replaces the whole keyword set for a lead, so re-ingesting a posting whose
// description changed cannot leave stale terms behind.
export function setLeadKeywords(db, leadId, keywords) {
  db.prepare("DELETE FROM lead_keywords WHERE lead_id = ?").run(leadId)
  const stmt = db.prepare(
    "INSERT OR IGNORE INTO lead_keywords (lead_id, keyword) VALUES (?, ?)",
  )
  for (const k of new Set(keywords)) stmt.run(leadId, String(k))
  return new Set(keywords).size
}

export function keywordsFor(db, leadId) {
  return db
    .prepare(
      "SELECT keyword FROM lead_keywords WHERE lead_id = ? ORDER BY keyword",
    )
    .all(leadId)
    .map((r) => r.keyword)
}

// Every lead's keywords in one query. Clustering compares each lead against
// every other one, so the per-lead keywordsFor() would be N round trips to
// answer a question the store can hand over in a single pass.
export function keywordMap(db) {
  const map = new Map()
  for (const r of db
    .prepare("SELECT lead_id, keyword FROM lead_keywords ORDER BY lead_id")
    .all()) {
    let set = map.get(r.lead_id)
    if (!set) map.set(r.lead_id, (set = new Set()))
    set.add(r.keyword)
  }
  return map
}

// Demand counts across the stored leads, optionally narrowed to one status —
// e.g. what the dismissed pile kept asking for.
export function keywordDemand(db, { status = null, limit = 50 } = {}) {
  const sql = status
    ? `SELECT k.keyword, COUNT(*) n FROM lead_keywords k
         JOIN leads l ON l.id = k.lead_id WHERE l.status = ?
         GROUP BY k.keyword ORDER BY n DESC, k.keyword LIMIT ?`
    : `SELECT keyword, COUNT(*) n FROM lead_keywords
         GROUP BY keyword ORDER BY n DESC, keyword LIMIT ?`
  return status
    ? db.prepare(sql).all(status, limit)
    : db.prepare(sql).all(limit)
}

// --- applications --------------------------------------------------------------

// The applications TABLE is the source of truth (user decision, 2026-07-29:
// applications are only ever created by scripts/applications/log-application.mjs after the
// user confirms a submission — nobody hand-edits them, so a file pretending to
// be authoritative bought nothing but a sync problem).
//
// profile/applications.yaml is now a one-way GENERATED export: written after
// every change, never read back except to bootstrap a database that does not
// exist yet. It exists because jobs/ is gitignored and this is the user's whole
// application history — a plain-text copy is cheap disaster recovery.
export function resolveApplicationSource(explicit = null) {
  if (explicit)
    return { kind: explicit.endsWith(".db") ? "db" : "yaml", file: explicit }
  if (!fs.existsSync(DB_PATH)) return { kind: "yaml", file: APPLICATIONS_PATH }
  return { kind: "db", file: DB_PATH }
}

// Always returns a plain array, the shape every consumer already expects.
export function readApplications(explicit = null) {
  const src = resolveApplicationSource(explicit)
  if (src.kind === "yaml") {
    if (!fs.existsSync(src.file)) return []
    return loadYamlFile(src.file)?.applications ?? []
  }
  const db = openDb(src.file)
  try {
    return db
      .prepare("SELECT doc FROM applications ORDER BY applied_at, slug")
      .all()
      .map((r) => JSON.parse(r.doc))
  } finally {
    db.close()
  }
}

export function deleteApplication(db, slug) {
  return db.prepare("DELETE FROM applications WHERE slug = ?").run(slug).changes
}

// Write the whole table back out as YAML. One-way: nothing reads this file
// except bootstrap, so it can be regenerated at will and never merged.
export function exportApplicationsYaml(
  db,
  file = APPLICATIONS_PATH,
  dumpYaml = null,
) {
  const applications = db
    .prepare("SELECT doc FROM applications ORDER BY applied_at, slug")
    .all()
    .map((r) => JSON.parse(r.doc))
  const header =
    "# APPLICATION LOG — GENERATED, do not edit.\n" +
    "# Source of truth is the `applications` table in jobs/leads.db.\n" +
    "# Regenerate: node scripts/applications/applications.mjs export\n" +
    "# Entries are only ever created by scripts/applications/log-application.mjs, after the\n" +
    "# user confirms they submitted the application.\n"
  const body = dumpYaml
    ? dumpYaml({ applications })
    : JSON.stringify({ applications }, null, 2)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, header + body, "utf8")
  return applications.length
}

// Save an application to the store of record, then refresh the export.
// `writeApplication` is the ONLY path that creates or changes an application;
// the "user confirmed they applied" rule still lives in the callers.
export function writeApplication(application, dumpYaml, dbFile = DB_PATH) {
  const db = openDb(dbFile)
  try {
    upsertApplications(db, [application])
    if (path.resolve(dbFile) === path.resolve(DB_PATH)) {
      exportApplicationsYaml(db, APPLICATIONS_PATH, dumpYaml)
    }
    return true
  } finally {
    db.close()
  }
}

const APPLICATION_UPSERT = `
    INSERT INTO applications (slug, company, title, applied_at, status, doc)
    VALUES ($slug, $company, $title, $applied_at, $status, $doc)
    ON CONFLICT(slug) DO UPDATE SET
      company = excluded.company,
      title = excluded.title,
      applied_at = excluded.applied_at,
      status = excluded.status,
      doc = excluded.doc`

const applicationRow = (a) => ({
  slug: a.slug,
  company: a.company ?? null,
  title: a.title ?? null,
  applied_at: a.applied_at ?? null,
  status: a.status ?? null,
  doc: JSON.stringify(a),
})

export function upsertApplications(db, applications) {
  const stmt = db.prepare(APPLICATION_UPSERT)
  db.exec("BEGIN")
  try {
    for (const a of applications) stmt.run(applicationRow(a))
    db.exec("COMMIT")
  } catch (e) {
    db.exec("ROLLBACK")
    throw e
  }
  return applications.length
}

// Merge a partial update into one application without rewriting the rest.
//
// BEGIN IMMEDIATE, and the word IMMEDIATE is the whole point. This is a
// read-modify-write: SELECT the doc, merge the patch into it, write it back. A
// DEFERRED transaction (SQLite's default, and what plain `BEGIN` gives) takes
// no write lock until its first write, so two of these can both READ, both
// merge onto the same base, and the second write silently discards the first
// patch. During a multi-hour unattended run that lost patch is the user
// recording an interview by hand — a fact nothing else in the system can
// reconstruct.
//
// IMMEDIATE takes the write lock at BEGIN, so the second caller waits (the
// connection's busy_timeout is 5s, set in openDb) and then reads the FIRST
// caller's merged doc as its base. The two patches compose instead of racing.
//
// The upsert is issued inline rather than through upsertApplications, because
// that function opens its own transaction and SQLite does not nest them.
export function updateApplication(db, slug, patch) {
  db.exec("BEGIN IMMEDIATE")
  try {
    const row = db
      .prepare("SELECT doc FROM applications WHERE slug = ?")
      .get(slug)
    if (!row) {
      db.exec("COMMIT")
      return 0
    }
    const merged = { ...JSON.parse(row.doc), ...patch }
    db.prepare(APPLICATION_UPSERT).run(applicationRow(merged))
    db.exec("COMMIT")
    return 1
  } catch (e) {
    db.exec("ROLLBACK")
    throw e
  }
}

// --- archived workspaces --------------------------------------------------

// Replaces the whole archive for a slug in one transaction, so a re-archive
// after a restore-and-edit cannot leave rows for files that no longer exist.
// Callers pass { name, content: Uint8Array|null, bytes, sha256 }.
export function writeDocuments(db, slug, files, at = null) {
  const archived_at = at ?? new Date().toISOString()
  const del = db.prepare("DELETE FROM documents WHERE slug = ?")
  const ins = db.prepare(
    `INSERT INTO documents (slug, name, content, bytes, sha256, archived_at)
     VALUES ($slug, $name, $content, $bytes, $sha256, $archived_at)`,
  )
  db.exec("BEGIN")
  try {
    del.run(slug)
    for (const f of files) {
      ins.run({
        slug,
        name: f.name,
        content: f.content ?? null,
        bytes: f.bytes,
        sha256: f.sha256,
        archived_at,
      })
    }
    db.exec("COMMIT")
  } catch (e) {
    db.exec("ROLLBACK")
    throw e
  }
  return files.length
}

export function readDocuments(db, slug) {
  return db
    .prepare(
      "SELECT name, content, bytes, sha256, archived_at FROM documents WHERE slug = ? ORDER BY name",
    )
    .all(slug)
}

// Summary only — deliberately does not select `content`, so listing an archive
// never pulls a megabyte of PDFs and markdown into memory to count them.
export function listDocuments(db) {
  return db
    .prepare(
      `SELECT slug,
              COUNT(*) files,
              SUM(bytes) bytes,
              SUM(content IS NULL) regenerable,
              MAX(archived_at) archived_at
         FROM documents GROUP BY slug ORDER BY archived_at DESC, slug`,
    )
    .all()
}

export function deleteDocuments(db, slug) {
  return db.prepare("DELETE FROM documents WHERE slug = ?").run(slug).changes
}

// --- screens ----------------------------------------------------------------

export const SCREEN_SOURCES = new Set(["mechanical", "model"])

// One screen = { lead_id, source, verdict, ...anything else the screen emits }.
// The extra fields ride along in doc untouched.
export function recordScreens(db, screens) {
  const stmt = db.prepare(
    `INSERT INTO screens (lead_id, source, verdict, screened_at, doc)
     VALUES ($lead_id, $source, $verdict, $screened_at, $doc)
     ON CONFLICT(lead_id, source) DO UPDATE SET
       verdict = excluded.verdict,
       screened_at = excluded.screened_at,
       doc = excluded.doc`,
  )
  db.exec("BEGIN")
  try {
    for (const s of screens) {
      if (!SCREEN_SOURCES.has(s.source))
        throw new Error(`unknown screen source: ${s.source}`)
      const screened_at = s.screened_at ?? new Date().toISOString()
      stmt.run({
        lead_id: s.lead_id,
        source: s.source,
        verdict: s.verdict,
        screened_at,
        doc: JSON.stringify({ ...s, screened_at }),
      })
    }
    db.exec("COMMIT")
  } catch (e) {
    db.exec("ROLLBACK")
    throw e
  }
  return screens.length
}

export function recordScreen(db, screen) {
  return recordScreens(db, [screen])
}

export function readScreens(db, { source = null } = {}) {
  const rows = source
    ? db.prepare("SELECT doc FROM screens WHERE source = ?").all(source)
    : db.prepare("SELECT doc FROM screens").all()
  return rows.map((r) => JSON.parse(r.doc))
}

// lead_id -> verdict document, for the "have we already paid for this?" check.
export function screenIndex(db, source) {
  const map = new Map()
  for (const s of readScreens(db, { source })) map.set(s.lead_id, s)
  return map
}

// --- unattended runs ---------------------------------------------------------

// Upsert, not insert: a run is written once at start (outcome 'running') and
// again at the end. A run that never gets its second write is a run that died,
// and it should be visible as 'running' with no finished_at rather than absent
// entirely — the silent no-op is the failure nobody notices.
export function upsertAutoRun(db, run) {
  // The profile hashes arrive as { "profile.yaml": sha, "answers.yaml": sha } —
  // two files, so a single column cannot hold them as a scalar. Stored as JSON
  // text rather than flattened to one combined digest, because "which of the
  // two changed" is the first question anyone asks when they differ, and a
  // combined hash destroys exactly that.
  const asText = (v) =>
    v == null ? null : typeof v === "object" ? JSON.stringify(v) : String(v)
  db.prepare(
    `INSERT INTO auto_runs
       (run_id, started_at, finished_at, mode, outcome, planned, submitted,
        deferred, failed, stop_reason, profile_sha_start, profile_sha_end, jsonl, doc)
     VALUES ($run_id, $started_at, $finished_at, $mode, $outcome, $planned, $submitted,
             $deferred, $failed, $stop_reason, $profile_sha_start, $profile_sha_end, $jsonl, $doc)
     ON CONFLICT(run_id) DO UPDATE SET
       finished_at = excluded.finished_at,
       mode = excluded.mode,
       outcome = excluded.outcome,
       planned = excluded.planned,
       submitted = excluded.submitted,
       deferred = excluded.deferred,
       failed = excluded.failed,
       stop_reason = excluded.stop_reason,
       profile_sha_end = excluded.profile_sha_end,
       jsonl = excluded.jsonl,
       doc = excluded.doc`,
  ).run({
    run_id: run.run_id,
    started_at: run.started_at,
    finished_at: run.finished_at ?? null,
    mode: run.mode ?? null,
    outcome: run.outcome ?? "running",
    planned: run.planned ?? 0,
    submitted: run.submitted ?? 0,
    deferred: run.deferred ?? 0,
    failed: run.failed ?? 0,
    stop_reason: run.stop_reason ?? null,
    profile_sha_start: asText(run.profile_sha_start),
    profile_sha_end: asText(run.profile_sha_end),
    jsonl: run.jsonl ?? null,
    doc: JSON.stringify(run),
  })
  return run.run_id
}

export function readAutoRuns(db, { limit = 20 } = {}) {
  return db
    .prepare("SELECT doc FROM auto_runs ORDER BY started_at DESC LIMIT ?")
    .all(limit)
    .map((r) => JSON.parse(r.doc))
}

// The heartbeat status.mjs warns on when it is over 26h old.
export function latestAutoRun(db) {
  const row = db
    .prepare("SELECT doc FROM auto_runs ORDER BY started_at DESC LIMIT 1")
    .get()
  return row ? JSON.parse(row.doc) : null
}

// A bounded retry on SQLITE_BUSY, for the ONE write that cannot be allowed to
// fail: the durable 'attempted' row, written immediately before a click.
//
// Nothing else in this file gets this, deliberately. Every other write can be
// retried by re-running the command; this one is the record that a click is
// about to happen, and losing it means a crash one second later leaves an
// application in an employer's ATS that no ledger knows about. The connection's
// busy_timeout (5s, openDb) already covers ordinary contention — this is the
// layer under it, for the case where the timeout itself expires.
//
// BOUNDED, and short. An unbounded retry in front of a click is a process that
// hangs holding an authorisation token; four tries over ~175ms either gets the
// lock or reports honestly that it did not.
const BUSY_RE = /SQLITE_BUSY|database is locked|database table is locked/i
const isBusy = (e) =>
  e?.code === "SQLITE_BUSY" ||
  e?.errcode === 5 ||
  BUSY_RE.test(String(e?.message ?? ""))

// Synchronous by necessity: node:sqlite's DatabaseSync is synchronous and this
// sits between a caller and a browser click, so there is no await to hang off.
const sleepSync = (ms) => {
  if (ms > 0)
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(ms))
}

export function withBusyRetry(
  fn,
  { attempts = 4, backoffMs = 25, sleep = sleepSync } = {},
) {
  let lastError
  for (let i = 0; i < attempts; i++) {
    try {
      return fn(i)
    } catch (e) {
      if (!isBusy(e)) throw e
      lastError = e
      if (i < attempts - 1) sleep(backoffMs * 2 ** i)
    }
  }
  throw lastError
}

/**
 * The terminal outcome reconcile.mjs writes when it has LOOKED at the board and
 * the board says no application exists (§4.9).
 *
 * It is the only outcome that does not hold the (slug, mode) claim, and the
 * only one besides 'abandoned' that does not count toward a cap. Both
 * exceptions mean the same thing — nothing reached an employer — and both are
 * written down here rather than as a bare string at three call sites, because a
 * typo in one of them silently restores the bug each exception exists to fix.
 */
export const RECONCILED_NOT_SENT = "reconciled-not-sent"

// THE CLAIM. Writes the intent row (outcome 'attempted', before the click) and
// REFUSES to overwrite an existing one.
//
// Returns the number of rows written: 1 means this caller owns the submit, and
// 0 MEANS THE SLUG ALREADY HAS A ROW IN THIS MODE AND THIS CALLER MUST NOT
// CLICK. The conflict handler refuses rather than overwrites, because a row
// whose job is to be a claim must refuse — a plain DO UPDATE would let a second
// caller quietly take a slug the first one had already attempted.
//
// The key is (slug, mode), so a dry-run rehearsal does not consume the live
// claim: `dry_run` and `live` are two different rows for one slug, and the
// caps count both on purpose.
//
// THE ONE OUTCOME THAT DOES NOT HOLD THE CLAIM is `reconciled-not-sent`, and
// §4.9 requires the exception in as many words. The failure it fixes: the
// reconciler proves an orphaned attempt never reached the employer, but under a
// plain DO NOTHING the row still occupies (slug, mode) forever — so that slug
// reports 0 changes on every future run, fails as `db-write-failed` each time,
// and after two in a row pauses the board. A posting nobody applied to would
// become permanently unappliable, loudly, for the rest of the machine's life.
//
// The critic's alternative — DELETE the row — is rejected and stays rejected:
// `auto_submissions` is the store of record for what was AIMED at an employer,
// and deleting evidence to unblock a retry is the shape hard rule 2 forbids for
// applications. A terminal outcome unblocks the retry and keeps the history.
//
// The WHERE clause is what keeps this narrow. Every other outcome —
// 'attempted', 'submitted', 'abandoned' — still hits it and reports 0.
export function recordAutoSubmission(db, sub, retry = {}) {
  const stmt = db.prepare(
    `INSERT INTO auto_submissions
       (run_id, slug, company, title, submitted_at, mode, plan_sha256, confirmation_url, outcome, apply_url, doc)
     VALUES ($run_id, $slug, $company, $title, $submitted_at, $mode, $plan_sha256, $confirmation_url, $outcome, $apply_url, $doc)
     ON CONFLICT(slug, mode) DO UPDATE SET
       run_id = excluded.run_id,
       company = excluded.company,
       title = excluded.title,
       submitted_at = excluded.submitted_at,
       plan_sha256 = excluded.plan_sha256,
       confirmation_url = excluded.confirmation_url,
       outcome = excluded.outcome,
       apply_url = excluded.apply_url,
       doc = excluded.doc
     WHERE auto_submissions.outcome = '${RECONCILED_NOT_SENT}'`,
  )
  const row = {
    run_id: sub.run_id,
    slug: sub.slug,
    company: sub.company ?? null,
    title: sub.title ?? null,
    submitted_at: sub.submitted_at ?? new Date().toISOString(),
    // Never NULL: see the SCHEMA comment. A NULL here would not conflict with
    // anything and the claim would not be a claim.
    mode: sub.mode ?? "live",
    plan_sha256: sub.plan_sha256 ?? null,
    confirmation_url: sub.confirmation_url ?? null,
    outcome: sub.outcome ?? "attempted",
    apply_url: sub.apply_url ?? null,
    doc: JSON.stringify(sub),
  }
  return withBusyRetry(() => stmt.run(row).changes, retry)
}

// THE ACKNOWLEDGEMENT. Resolves a claim this caller already holds: 'submitted'
// after the click returned, or 'abandoned' when the click was provably never
// issued.
//
// Separate from the claim because the two acts are opposites. The claim must
// refuse a slug someone else holds; the acknowledgement must NEVER be dropped —
// an application cannot be unsent, so failing to record its outcome is strictly
// worse than recording it late. Under the claim's DO NOTHING the second of the
// two writes per application would have vanished silently, which is exactly the
// crash-invisible state the ledger exists to prevent.
//
// COALESCE on apply_url and confirmation_url: acknowledging an attempt must
// never blank the URL the attempt recorded, because an orphaned attempt is only
// useful to the user if it still says where the click was aimed.
//
// run_id is deliberately NOT updated. The row belongs to the run that claimed
// it; an acknowledgement from elsewhere resolves that run's attempt rather than
// re-attributing it.
export function acknowledgeAutoSubmission(db, sub) {
  return db
    .prepare(
      `INSERT INTO auto_submissions
       (run_id, slug, company, title, submitted_at, mode, plan_sha256, confirmation_url, outcome, apply_url, doc)
     VALUES ($run_id, $slug, $company, $title, $submitted_at, $mode, $plan_sha256, $confirmation_url, $outcome, $apply_url, $doc)
     ON CONFLICT(slug, mode) DO UPDATE SET
       company = excluded.company,
       title = excluded.title,
       submitted_at = excluded.submitted_at,
       plan_sha256 = excluded.plan_sha256,
       confirmation_url = COALESCE(excluded.confirmation_url, auto_submissions.confirmation_url),
       outcome = excluded.outcome,
       apply_url = COALESCE(excluded.apply_url, auto_submissions.apply_url),
       doc = excluded.doc`,
    )
    .run({
      run_id: sub.run_id,
      slug: sub.slug,
      company: sub.company ?? null,
      title: sub.title ?? null,
      submitted_at: sub.submitted_at ?? new Date().toISOString(),
      mode: sub.mode ?? "live",
      plan_sha256: sub.plan_sha256 ?? null,
      confirmation_url: sub.confirmation_url ?? null,
      outcome: sub.outcome ?? "submitted",
      apply_url: sub.apply_url ?? null,
      doc: JSON.stringify(sub),
    }).changes
}

// The row a refused claim collided with, so the caller can say WHY it is not
// clicking in terms the user can act on rather than just reporting a zero.
export function readAutoSubmission(db, slug, mode = "live") {
  return (
    db
      .prepare(
        "SELECT run_id, slug, company, title, submitted_at, mode, outcome, apply_url, confirmation_url FROM auto_submissions WHERE slug = ? AND mode = ?",
      )
      .get(slug, mode) ?? null
  )
}

// How many auto submissions since `sinceIso`. `per_day_max`'s counter.
//
// Counts 'attempted' rows as well as 'submitted' ones, and that is the whole
// point of the outcome column: a run killed between the click and the
// acknowledgement has still put an application in front of an employer.
//
// TWO outcomes do not count, and both mean the same thing: no application
// reached an employer.
//
//   'abandoned'            — the runner asserted the click was never issued.
//                            If these consumed cap budget, a run of hundreds of
//                            jobs would exhaust the caps on transient
//                            click-site failures alone.
//   'reconciled-not-sent'  — reconcile.mjs went and LOOKED, and the board says
//                            no application exists (§4.9). Counting it would
//                            spend the user's daily budget on an application
//                            that provably never happened, which is the same
//                            error as 'abandoned' with better evidence behind
//                            it.
//
// IS NOT, not !=. `NULL != 'abandoned'` is NULL, which is falsy, so a row
// written before the outcome column existed would silently stop counting.
// `NULL IS NOT 'abandoned'` is 1. Those legacy rows are real submitted
// applications and must keep counting.
export function countAutoSubmissions(db, sinceIso) {
  return db
    .prepare(
      "SELECT COUNT(*) c FROM auto_submissions WHERE submitted_at >= ? AND outcome IS NOT 'abandoned' AND outcome IS NOT 'reconciled-not-sent'",
    )
    .get(sinceIso).c
}

// The unresolved attempts belonging to ONE run, for the check audit.mjs makes
// at finish(). Deliberately not filtered on the run's finished_at: the caller
// is the run itself, still open, asking what it is about to leave behind.
export function readAttemptsForRun(db, runId) {
  return db
    .prepare(
      `SELECT run_id, slug, company, submitted_at, mode, apply_url
         FROM auto_submissions
        WHERE run_id = ? AND outcome = 'attempted'
        ORDER BY submitted_at`,
    )
    .all(runId)
}

// Every attempt that was never acknowledged AND whose run never finished.
//
// This is the durable half of the crash story. The row is written before the
// click; if the process dies one second later, nothing updates it and nothing
// closes the run — so at the next startup this returns it, and the runner
// refuses to start until a human has looked at the URL.
//
// A run that FINISHED with an attempt still open is a different fault (the
// process survived and did not record), and audit.mjs catches that one at
// finish() while the run is still in memory.
export function readOrphanAttempts(db) {
  return db
    .prepare(
      `SELECT s.run_id, s.slug, s.company, s.submitted_at, s.mode, s.apply_url
         FROM auto_submissions s
         LEFT JOIN auto_runs r ON r.run_id = s.run_id
        WHERE s.outcome = 'attempted'
          AND (r.run_id IS NULL OR r.finished_at IS NULL)
        ORDER BY s.submitted_at`,
    )
    .all()
}

// --- the per-application queue -----------------------------------------------

// The states, in the order a job moves through them. Exported so a caller
// validates against ONE list rather than re-typing the strings.
export const AUTO_QUEUE_STATES = [
  "queued",
  "claimed",
  "planned",
  "authorized",
  "attempted",
  "submitted",
  "challenged",
  "deferred",
  "failed",
]

// Nothing further happens to a job in one of these.
export const AUTO_QUEUE_TERMINAL = new Set([
  "submitted",
  "challenged",
  "deferred",
  "failed",
])

// --- the closed reason taxonomy (Phase 4.1) ----------------------------------
//
// THE VALUE SET LIVES WITH THE COLUMN THAT STORES IT, for the same reason
// AUTO_QUEUE_STATES does: a caller validates against ONE list rather than
// re-typing a string, and a writer that cannot name a kind cannot write a row.
// The POLICY on top of these — which stage produced a kind, which class it
// aggregates into, which of several defers is the blocking one — is
// scripts/auto/taxonomy.mjs's. This is only the vocabulary.
//
// WHY TYPED AND NOT FREE TEXT. Every deferral already carried a reason, as a
// sentence. A sentence cannot be aggregated: "unprobed dropdown" and "dropdown
// was not probed" are the same loss and two buckets, so the defer log could
// never answer "what did NOT understanding this board cost us this week?" —
// which is the one question that turns deferrals into a prioritised backlog.
// Reworded strings would be matched by substring within a week, and that is
// string matching where a type belongs.
//
// CLOSED IS THE POINT. An unknown kind is rejected at write time rather than
// stored and counted under a name nobody chose, because a taxonomy that admits
// new members silently is a free-text column with extra steps.

// The machine did not understand something, or the environment declined.
// NOT a malfunction, and never a reason to stop the run.
export const AUTO_DEFER_KINDS = Object.freeze([
  "confirm-field",
  "confirm-widget",
  "consent-tickbox",
  "unknown-field",
  "unprobed-dropdown",
  "fill-failed",
  "identity-verification",
  "captcha",
  "bot-challenge",
  "email-code-challenge",
  "multipage-unresolvable",
  "freetext-disclosure",
  "doc-unverified",
  "fact-base-changed",
  "board-untrusted",
  "l3-rejected",
  "cap-company",
  // The user already applied to this posting. NOT `cap-company`, though both
  // are policy refusals read off the ledgers: a cap says "too many to this
  // employer this week", this says "this exact posting, already sent". Reusing
  // the cap kind would send a user to check a weekly budget that is nowhere
  // near tripping — measured 2026-08-17, three already-applied Cloudflare jobs
  // under a per_company_max_per_week of 5.
  "already-applied",
  "posting-gone",
  // Written to every job a board pause STRANDS. Without it those jobs sit in
  // 'queued' carrying no kind at all, so the largest single loss bucket in a
  // degraded run is invisible to the digest and to the defer-rate gate.
  "board-paused",
  // reconcile.mjs went and LOOKED at an orphaned attempt's board, and the board
  // says no application exists (§4.9). A DEFERRAL rather than a failure: the
  // machine did not malfunction, it recovered — and the honest reading is that
  // this posting was never applied to and may be applied to again.
  //
  // ITS OWN KIND rather than folded into `posting-gone`, which was the first
  // thing tried and is a different event with a different meaning. A posting
  // that vanished says NOTHING about whether the application landed; this kind
  // says the board was asked and answered. Reporting one as the other would put
  // the reconciler's only positive result in a bucket the digest reads as
  // "boards taking their listings down".
  "reconciled-not-sent",
])

// The machine malfunctioned. These are the ones worth waking somebody for.
export const AUTO_FAILURE_KINDS = Object.freeze([
  "nav-timeout",
  "browser-crash",
  "token-refused",
  "origin-mismatch",
  "post-submit-unclassified",
  "db-write-failed",
  "plan-error",
])

// A click went out and the board answered with a challenge instead of a
// confirmation. These are DEFER kinds — the machine did not malfunction, the
// board defended itself — but they are the only kinds a 'challenged' row may
// carry, because 'challenged' means "we do not know whether this landed".
export const AUTO_CHALLENGE_KINDS = Object.freeze([
  "captcha",
  "bot-challenge",
  "email-code-challenge",
])

const DEFER_KIND_SET = new Set(AUTO_DEFER_KINDS)
const FAILURE_KIND_SET = new Set(AUTO_FAILURE_KINDS)
const CHALLENGE_KIND_SET = new Set(AUTO_CHALLENGE_KINDS)

// Which kinds each terminal state may carry. A state that is absent from this
// map takes no reason at all — 'submitted' has nothing to explain.
const KINDS_FOR_STATE = new Map([
  ["deferred", DEFER_KIND_SET],
  ["failed", FAILURE_KIND_SET],
  ["challenged", CHALLENGE_KIND_SET],
])

export function autoReasonClass(kind) {
  if (DEFER_KIND_SET.has(kind)) return "deferred"
  if (FAILURE_KIND_SET.has(kind)) return "failed"
  return null
}

/**
 * The gate every terminal reason passes through.
 *
 * Hard rule 6 forbids a silent skip, so a deferral must say why; Phase 4.1
 * adds that the why must be a value the digest can count. Both checks are here
 * rather than at the call sites because there is no honest way to write this
 * row without them.
 */
export function assertReasonKind(state, kind) {
  const allowed = KINDS_FOR_STATE.get(state)
  if (!allowed) return null
  if (!kind)
    throw new TypeError(
      `a ${state} job requires a reason_kind — a silent skip is not a deferral (hard rule 6)`,
    )
  if (!allowed.has(kind))
    throw new TypeError(
      `unknown reason_kind ${JSON.stringify(kind)} for state "${state}" ` +
        `(expected one of ${[...allowed].join(", ")})`,
    )
  return kind
}

// Not finished, and NO CLICK HAS BEEN ISSUED. This is the resume set: after a
// process dies these are the jobs the next invocation may pick up, and
// 'attempted' is excluded on purpose — that click may already be an
// application, so it belongs to the orphan-attempt brake and to a human, never
// to an automatic retry.
export const AUTO_QUEUE_RESUMABLE = new Set([
  "queued",
  "claimed",
  "planned",
  "authorized",
])

// The same set as a SQL literal list, built ONCE from the frozen array above.
// Interpolating it is safe precisely because it never touches an argument: the
// values are code-owned identifiers, and building the list here means a state
// added to AUTO_QUEUE_RESUMABLE cannot be forgotten in a query that mixes named
// and positional binds (node:sqlite takes named parameters FIRST, and a query
// that does both is a bug waiting for the next person).
const RESUMABLE_SQL = [...AUTO_QUEUE_RESUMABLE].map((s) => `'${s}'`).join(", ")

const nowIso = (now) => (now instanceof Date ? now : new Date()).toISOString()

function assertQueueState(state) {
  if (!AUTO_QUEUE_STATES.includes(state))
    throw new TypeError(
      `unknown auto_queue state: ${JSON.stringify(state)} (expected one of ${AUTO_QUEUE_STATES.join(", ")})`,
    )
}

// The defer kinds a later enqueue may put back to 'queued'.
//
// WHY A LIST AT ALL. `deferred` is a terminal state and `enqueueAutoJobs` was
// `ON CONFLICT(slug) DO NOTHING`, so a slug that deferred ONCE was dead in the
// queue for good — nothing short of --reset-queue could ever look at it again.
// Measured 2026-08-17: three rows deferred on 2026-08-04, attempt_no=1, two of
// them Render jobs whose only blocker (an unprobed Ashby Location typeahead)
// had been FIXED IN CODE on 2026-08-07. Fixed in code, still blocking in data,
// for thirteen days, with nothing that could ever notice.
//
// WHY ONLY THESE. Each is a reason that the three lawful ways to defer less
// (rule 6: an adapter, a probed option list, a banked answer) or a cleared
// pause can change — the machine did not understand a control, or was told to
// wait. Re-queuing costs one page visit per cycle and NEVER a click: the
// re-plan runs the whole gate chain again, and a row whose reason still holds
// simply defers again with attempt_no one higher. Kinds NOT here stay
// terminal on purpose: `posting-gone`, `l3-rejected`, `cap-company`,
// `board-untrusted`, `reconciled-not-sent` and the challenge kinds are the
// board or the user's own policy speaking, and re-asking them daily is churn
// with no new information. `attempted`, `submitted`, `challenged` and `failed`
// rows are never touched — the CLAUDE.md §4.9 note and the "click unaccounted"
// refusal both depend on that.
export const AUTO_REQUEUEABLE_KINDS = Object.freeze([
  "confirm-field",
  "confirm-widget",
  "consent-tickbox",
  "unprobed-dropdown",
  "unknown-field",
  "fill-failed",
  "doc-unverified",
  "fact-base-changed",
  // A board pause strands its jobs as deferred/board-paused; the pause clears
  // on one success and nothing re-admitted the stranded rows. Same defect.
  "board-paused",
])
const REQUEUEABLE_SQL = AUTO_REQUEUEABLE_KINDS.map((k) => `'${k}'`).join(", ")

// Put slugs in the queue as 'queued'. Existing rows are left ALONE — re-running
// the planner over a queue that is already being worked must not reset a job
// another worker holds, and must not resurrect one that already finished —
// WITH ONE EXCEPTION: a 'deferred' row whose reason is one of
// AUTO_REQUEUEABLE_KINDS goes back to 'queued' with its plan cleared and its
// attempt count up by one, so a defer that code, a probe or a banked answer has
// since resolved is looked at again. Returns the number of rows added OR
// re-queued — the caller's next SELECT is what tells it which.
export function enqueueAutoJobs(db, jobs, { now = new Date() } = {}) {
  const at = nowIso(now)
  const stmt = db.prepare(
    `INSERT INTO auto_queue
       (slug, run_id, board_key, origin, state, attempt_no, plan_sha256, posted_at, updated_at)
     VALUES ($slug, $run_id, $board_key, $origin, 'queued', 0, $plan_sha256, $posted_at, $updated_at)
     ON CONFLICT(slug) DO UPDATE SET
       state = 'queued',
       run_id = excluded.run_id,
       board_key = COALESCE(excluded.board_key, auto_queue.board_key),
       origin = COALESCE(excluded.origin, auto_queue.origin),
       -- attempt_no is NOT touched here: the claim increments it, so a
       -- re-queued row reads attempt 2 the moment a worker picks it up.
       plan_sha256 = NULL,
       reason_kind = NULL,
       reason_detail = NULL,
       reason_stage = NULL,
       claimed_at = NULL,
       updated_at = excluded.updated_at
     WHERE auto_queue.state = 'deferred'
       AND auto_queue.reason_kind IN (${REQUEUEABLE_SQL})`,
  )
  let added = 0
  db.exec("BEGIN IMMEDIATE")
  try {
    for (const j of jobs) {
      if (!j?.slug) throw new TypeError("enqueueAutoJobs requires a slug")
      added += stmt.run({
        slug: j.slug,
        run_id: j.run_id ?? null,
        board_key: j.board_key ?? null,
        origin: j.origin ?? null,
        plan_sha256: j.plan_sha256 ?? null,
        posted_at: j.posted_at ?? null,
        updated_at: at,
      }).changes
    }
    db.exec("COMMIT")
  } catch (e) {
    db.exec("ROLLBACK")
    throw e
  }
  return added
}

/**
 * THE CLAIM. One statement, so two workers racing one slug cannot both win.
 *
 * Returns 1 when this caller now owns the slug and 0 when it does not. ZERO
 * MEANS ANOTHER WORKER OWNS IT AND THIS ONE MUST NOT CLICK — not an error and
 * not an anomaly; in a fan-out it is the ordinary outcome for every worker but
 * one, and the loser simply returns.
 *
 * The conflict clause fires only for a row still in 'queued'. For every other
 * state — claimed by someone, already attempted, already terminal — it degrades
 * to the plain `ON CONFLICT DO NOTHING` the plan specifies, which is what makes
 * "0 changes" mean one unambiguous thing. Writing it as a guarded DO UPDATE
 * rather than a bare DO NOTHING is what lets a PRE-PLANNED queue exist at all:
 * with a bare DO NOTHING a slug enqueued as 'queued' could never be claimed by
 * anybody, because the row would already be there.
 *
 * plan_sha256 is recorded on the claim so a retry with a DIFFERENT plan is a
 * visibly different act rather than a repeat of the same one.
 */
export function claimAutoJob(db, slug, opts = {}) {
  if (!slug) throw new TypeError("claimAutoJob requires a slug")
  const {
    run_id = null,
    board_key = null,
    origin = null,
    plan_sha256 = null,
    now = new Date(),
  } = opts
  const at = nowIso(now)
  return db
    .prepare(
      `INSERT INTO auto_queue
         (slug, run_id, board_key, origin, state, attempt_no, plan_sha256, claimed_at, updated_at)
       VALUES ($slug, $run_id, $board_key, $origin, 'claimed', 1, $plan_sha256, $at, $at)
       ON CONFLICT(slug) DO UPDATE SET
         run_id = excluded.run_id,
         board_key = COALESCE(excluded.board_key, auto_queue.board_key),
         origin = COALESCE(excluded.origin, auto_queue.origin),
         state = 'claimed',
         attempt_no = auto_queue.attempt_no + 1,
         plan_sha256 = excluded.plan_sha256,
         reason_kind = NULL,
         reason_stage = NULL,
         reason_detail = NULL,
         claimed_at = excluded.claimed_at,
         updated_at = excluded.updated_at
       WHERE auto_queue.state = 'queued'`,
    )
    .run({ slug, run_id, board_key, origin, plan_sha256, at }).changes
}

/**
 * Advance a claimed job. Returns 1 on success, 0 when the row is absent or is
 * held by a different run.
 *
 * `run_id` is checked when given: a worker may only move a job it owns, so a
 * stale worker waking up after its claim was released cannot drive somebody
 * else's job to 'submitted'. Passing no run_id is the maintenance path.
 *
 * A 'deferred', 'failed' or 'challenged' state MUST carry a reason_kind from
 * the closed taxonomy — hard rule 6 forbids a silent skip, and Phase 4.1 adds
 * that the reason must be countable. assertReasonKind is the single gate.
 */
export function setAutoJobState(db, slug, state, opts = {}) {
  assertQueueState(state)
  const {
    run_id = null,
    plan_sha256 = null,
    reason_kind = null,
    reason_stage = null,
    reason_detail = null,
    wall_ms = null,
    now = new Date(),
  } = opts
  assertReasonKind(state, reason_kind)
  return db
    .prepare(
      // wall_ms COALESCEs like plan_sha256 and unlike the reason columns. The
      // reasons are overwritten because each write states the CURRENT reason
      // and a stale one would be a lie; a duration is a fact about a job that
      // already happened, so an intermediate write that carries no timing
      // ('planned', 'authorized') must not erase the one that does.
      `UPDATE auto_queue
          SET state = $state,
              plan_sha256 = COALESCE($plan_sha256, plan_sha256),
              reason_kind = $reason_kind,
              reason_stage = $reason_stage,
              reason_detail = $reason_detail,
              wall_ms = COALESCE($wall_ms, wall_ms),
              updated_at = $at
        WHERE slug = $slug
          AND ($run_id IS NULL OR run_id = $run_id)`,
    )
    .run({
      slug,
      state,
      plan_sha256,
      reason_kind,
      reason_stage,
      reason_detail,
      // SQLite has no integer coercion for a float bind, and a duration is
      // whole milliseconds. A negative one is not a duration at all.
      wall_ms:
        typeof wall_ms === "number" && Number.isFinite(wall_ms) && wall_ms >= 0
          ? Math.round(wall_ms)
          : null,
      at: nowIso(now),
      run_id,
    }).changes
}

export function readAutoQueue(db, { state = null, run_id = null } = {}) {
  const where = []
  const params = {}
  if (state) {
    where.push("state = $state")
    params.state = state
  }
  if (run_id) {
    where.push("run_id = $run_id")
    params.run_id = run_id
  }
  const sql =
    "SELECT * FROM auto_queue" +
    (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
    " ORDER BY slug"
  const stmt = db.prepare(sql)
  return where.length ? stmt.all(params) : stmt.all()
}

/**
 * THE RESUME SELECTION — the answer to "which of the 999 still need doing?"
 * after a kill at number 437.
 *
 * Read from the database, never re-derived: a job is outstanding because its
 * row says so. Terminal rows are excluded because they are finished, and
 * 'attempted' rows because their click may already have landed.
 */
export function readResumableAutoJobs(db) {
  const states = [...AUTO_QUEUE_RESUMABLE]
  return db
    .prepare(
      `SELECT * FROM auto_queue
        WHERE state IN (${states.map(() => "?").join(", ")})
        ORDER BY slug`,
    )
    .all(...states)
}

// The rows a human has to look at before anything runs again: a click was
// issued and nothing ever said what happened next.
export function readStrandedAutoJobs(db) {
  return db
    .prepare(
      "SELECT * FROM auto_queue WHERE state = 'attempted' ORDER BY updated_at, slug",
    )
    .all()
}

// --- board pauses, and the jobs they strand ----------------------------------

/**
 * Record that the breaker backed off a board. Idempotent per (board, run,
 * instant): a second call in the same millisecond is the same pause.
 */
export function recordBoardPause(db, pause) {
  const at = nowIso(pause.paused_at ?? pause.now ?? new Date())
  if (!pause.board_key)
    throw new TypeError("recordBoardPause requires a board_key")
  if (!pause.run_id) throw new TypeError("recordBoardPause requires a run_id")
  return db
    .prepare(
      `INSERT INTO board_pauses
         (board_key, run_id, paused_at, until, reason_kind, reason_detail)
       VALUES ($board_key, $run_id, $paused_at, $until, $reason_kind, $reason_detail)
       ON CONFLICT(board_key, run_id, paused_at) DO NOTHING`,
    )
    .run({
      board_key: pause.board_key,
      run_id: pause.run_id,
      paused_at: at,
      until: pause.until ? nowIso(pause.until) : null,
      reason_kind: pause.reason_kind ?? null,
      reason_detail: pause.reason_detail ?? null,
    }).changes
}

/** A probe succeeded: the board is back in service. Returns rows cleared. */
export function clearBoardPause(
  db,
  board_key,
  { run_id, now = new Date() } = {},
) {
  return db
    .prepare(
      `UPDATE board_pauses SET cleared_at = $at
        WHERE board_key = $board_key AND cleared_at IS NULL
          AND ($run_id IS NULL OR run_id = $run_id)`,
    )
    .run({ board_key, run_id: run_id ?? null, at: nowIso(now) }).changes
}

/**
 * The boards paused RIGHT NOW, with the number of jobs each is holding.
 *
 * "Holding" counts only jobs that could still have been done — the resumable
 * states. A job that already reached a terminal state was not held by anything.
 */
export function readActiveBoardPauses(db, { run_id = null } = {}) {
  return db
    .prepare(
      `SELECT p.board_key, p.run_id, p.paused_at, p.until, p.reason_kind, p.reason_detail,
              (SELECT COUNT(*) FROM auto_queue q
                WHERE q.board_key = p.board_key
                  AND q.state IN (${RESUMABLE_SQL})) AS held
         FROM board_pauses p
        WHERE p.cleared_at IS NULL
          AND ($run_id IS NULL OR p.run_id = $run_id)
        ORDER BY p.board_key, p.paused_at`,
    )
    .all({ run_id: run_id ?? null })
}

/**
 * Close out a run by naming what its pauses cost.
 *
 * Every job left undone on a paused board becomes a 'deferred' row carrying
 * kind 'board-paused' — because a job that never ran, on a board the machine
 * backed away from, is a deferral with a stated reason and not an absence. It
 * is the difference between "we did 940 of 999" and "we did 940 of 999, and 47
 * of the other 59 were greenhouse jobs we stopped touching at 02:14".
 *
 * Called at RUN END, not at pause time: a pause is a timed backoff, so a job
 * held during one may still be done later in the same run.
 */
export function strandPausedBoardJobs(
  db,
  { run_id = null, board_keys = null, detail = null, now = new Date() } = {},
) {
  const keys =
    board_keys ?? readActiveBoardPauses(db, { run_id }).map((p) => p.board_key)
  if (!keys.length) return 0
  const stmt = db.prepare(
    `UPDATE auto_queue
        SET state = 'deferred',
            reason_kind = 'board-paused',
            reason_stage = 'queue',
            reason_detail = $detail,
            updated_at = $at
      WHERE board_key = $board_key
        AND state IN (${RESUMABLE_SQL})
        AND ($run_id IS NULL OR auto_queue.run_id IS NULL OR auto_queue.run_id = $run_id)`,
  )
  const at = nowIso(now)
  let stranded = 0
  db.exec("BEGIN IMMEDIATE")
  try {
    for (const board_key of keys)
      stranded += stmt.run({
        board_key,
        detail: detail ?? `board ${board_key} was paused when the run ended`,
        at,
        run_id,
      }).changes
    db.exec("COMMIT")
  } catch (e) {
    db.exec("ROLLBACK")
    throw e
  }
  return stranded
}

// --- what the defer log is FOR ------------------------------------------------

/**
 * Deferrals and failures grouped by (kind, stage, board_key).
 *
 * This is the query the whole typed-taxonomy argument exists to make possible:
 * it is a GROUP BY, and it stays a GROUP BY however anybody rewords a message,
 * because the thing being grouped is a value from a closed set rather than a
 * sentence. Its output is the product's own backlog — the kinds at the top are
 * the applications a deterministic understanding of a board would unlock.
 */
export function readReasonCounts(db, { run_id = null } = {}) {
  return db
    .prepare(
      `SELECT state, reason_kind, reason_stage, board_key, COUNT(*) AS n
         FROM auto_queue
        WHERE reason_kind IS NOT NULL
          AND ($run_id IS NULL OR run_id = $run_id)
        GROUP BY state, reason_kind, reason_stage, board_key
        ORDER BY n DESC, reason_kind, board_key`,
    )
    .all({ run_id: run_id ?? null })
}

/**
 * Challenge incidence per board, split into this run and everything before it.
 *
 * Employer-side flagging is SILENT — nobody is told their application was
 * scored down for looking automated — so a rising challenge rate is the only
 * applicant-observable proxy for it. `prior` is what makes the interesting
 * predicate expressible: a board with challenges now and none before has
 * changed its behaviour toward us, and that is an anomaly input even when the
 * absolute count is 1.
 */
export function readChallengeIncidence(db, { run_id = null } = {}) {
  const kinds = AUTO_CHALLENGE_KINDS.map((k) => `'${k}'`).join(", ")
  return db
    .prepare(
      `SELECT board_key,
              SUM(CASE WHEN $run_id IS NULL OR run_id = $run_id THEN 1 ELSE 0 END) AS current,
              SUM(CASE WHEN $run_id IS NOT NULL AND (run_id IS NULL OR run_id != $run_id) THEN 1 ELSE 0 END) AS prior
         FROM auto_queue
        WHERE reason_kind IN (${kinds})
        GROUP BY board_key
        ORDER BY current DESC, board_key`,
    )
    .all({ run_id: run_id ?? null })
}

/**
 * Age in milliseconds of every job still waiting, by state.
 *
 * Age is measured from `claimed_at` where there is one and `updated_at`
 * otherwise — the two are the same instant for a queued row and the claim is
 * the more meaningful clock for a claimed one. Percentiles are the caller's:
 * this returns the sample, so a digest and a benchmark compute the same number
 * from the same rows.
 */
export function readQueueAges(db, { now = new Date() } = {}) {
  const t = (now instanceof Date ? now : new Date()).getTime()
  return db
    .prepare(
      `SELECT slug, state, board_key, COALESCE(claimed_at, updated_at) AS since
         FROM auto_queue
        WHERE state IN (${RESUMABLE_SQL})`,
    )
    .all()
    .map((r) => ({
      slug: r.slug,
      state: r.state,
      board_key: r.board_key,
      since: r.since,
      // A row with no timestamp at all has an UNKNOWN age, not an age of zero.
      // Reporting it as fresh is how a stuck job hides in a p95.
      age_ms: r.since ? Math.max(0, t - new Date(r.since).getTime()) : null,
    }))
}

/**
 * Deferred rows that have been sitting longer than `olderThanMs`, oldest first.
 *
 * `deferred` is terminal, so it is not "outstanding" and the queue line said
 * `outstanding=0` on 2026-08-17 while three rows had been deferred since
 * 2026-08-04 — two of them on a reason that code had fixed on 08-07. Nothing
 * counted them, so nothing noticed. This is the count. `requeueable` says
 * whether the next enqueue will look at the row again (AUTO_REQUEUEABLE_KINDS)
 * or whether it is a decision that stands until a human changes something.
 */
export function readStaleDeferred(
  db,
  { now = new Date(), olderThanMs = 3 * 24 * 3600 * 1000 } = {},
) {
  const t = (now instanceof Date ? now : new Date()).getTime()
  const requeueable = new Set(AUTO_REQUEUEABLE_KINDS)
  return db
    .prepare(
      `SELECT slug, board_key, reason_kind, attempt_no, updated_at
         FROM auto_queue
        WHERE state = 'deferred'
        ORDER BY updated_at, slug`,
    )
    .all()
    .map((r) => ({
      slug: r.slug,
      board_key: r.board_key,
      reason_kind: r.reason_kind,
      attempt_no: r.attempt_no,
      since: r.updated_at,
      age_ms: r.updated_at
        ? Math.max(0, t - new Date(r.updated_at).getTime())
        : null,
      requeueable: requeueable.has(r.reason_kind),
    }))
    .filter((r) => r.age_ms === null || r.age_ms >= olderThanMs)
}

/**
 * How long each submitted application waited between the posting going up and
 * the click going out — the sample, in milliseconds.
 *
 * THIS IS THE NUMBER THE PRODUCT IS ACTUALLY FOR. Early applicants are read;
 * a machine that applies to 999 jobs a week behind everyone else has bought
 * volume and sold the only advantage volume was supposed to buy. Rows with no
 * `posted_at` are EXCLUDED rather than counted as zero — a posting whose date
 * nobody recorded has an unknown latency, and folding it in as instantaneous
 * flatters exactly the statistic it belongs to.
 */
export function readSubmitLatencies(db, { run_id = null, mode = null } = {}) {
  return db
    .prepare(
      `SELECT q.slug, q.board_key, q.posted_at, s.submitted_at, s.mode
         FROM auto_queue q
         JOIN auto_submissions s ON s.slug = q.slug
        WHERE q.posted_at IS NOT NULL
          AND s.submitted_at IS NOT NULL
          AND ($mode IS NULL OR s.mode = $mode)
          AND ($run_id IS NULL OR s.run_id = $run_id)`,
    )
    .all({ run_id: run_id ?? null, mode: mode ?? null })
    .map((r) => ({
      slug: r.slug,
      board_key: r.board_key,
      mode: r.mode,
      ms: new Date(r.submitted_at).getTime() - new Date(r.posted_at).getTime(),
    }))
    .filter((r) => Number.isFinite(r.ms))
}

/**
 * How long each finished job took in its worker — the sample, in milliseconds,
 * one row per job, with the stage it ended at.
 *
 * A DIFFERENT QUESTION FROM readSubmitLatencies, and the two must not be
 * merged. That one measures the market: how long a POSTING waited between
 * going up and being applied to, in hours, and it is the number the product
 * exists to improve. This one measures the MACHINE: how long our own worker
 * held a job, in milliseconds, which is the number that says whether the
 * pipeline got slower this week. Neither is a substitute for the other, and a
 * single "latency" reading both would be uninterpretable.
 *
 * `stage` is reason_stage where a terminal reason recorded one and the state
 * otherwise, so a submitted job groups under 'submitted' rather than vanishing
 * from the breakdown. Rows with no wall_ms are EXCLUDED, never counted as
 * zero — a job nobody timed is unknown, and folding it in as instantaneous
 * flatters the statistic it belongs to (the same rule readSubmitLatencies
 * applies to a posting with no date).
 */
export function readJobWallTimes(db, { run_id = null } = {}) {
  return db
    .prepare(
      `SELECT slug, state, board_key, reason_stage, wall_ms
         FROM auto_queue
        WHERE wall_ms IS NOT NULL
          AND ($run_id IS NULL OR run_id = $run_id)
        ORDER BY wall_ms DESC, slug`,
    )
    .all({ run_id: run_id ?? null })
    .map((r) => ({
      slug: r.slug,
      state: r.state,
      board_key: r.board_key,
      stage: r.reason_stage ?? r.state,
      ms: Number(r.wall_ms),
    }))
    .filter((r) => Number.isFinite(r.ms))
}

export function autoQueueCounts(db) {
  const out = Object.fromEntries(AUTO_QUEUE_STATES.map((s) => [s, 0]))
  for (const r of db
    .prepare("SELECT state, COUNT(*) c FROM auto_queue GROUP BY state")
    .all())
    out[r.state] = r.c
  return out
}

/**
 * Return jobs whose worker died holding the claim to the 'queued' pool.
 *
 * Without this a crash makes a slug permanently unclaimable: claimAutoJob only
 * upgrades a 'queued' row, so a row left at 'claimed' by a dead process is
 * owned by nobody and released by nothing, and "the next invocation resumes at
 * 437" quietly stops being true one job at a time.
 *
 * 'attempted' IS NEVER RELEASED. A released attempt would be re-claimed and
 * re-clicked, and the application may already be sitting in the employer's ATS.
 * That case is the orphan-attempt brake's, and its resolution is a human
 * opening the page.
 *
 * @param leaseMs how long a claim may sit untouched before it is presumed dead.
 */
export function releaseStaleAutoClaims(
  db,
  { leaseMs = 30 * 60 * 1000, now = new Date(), run_id = null } = {},
) {
  const cutoff = new Date(
    (now instanceof Date ? now : new Date()).getTime() - leaseMs,
  ).toISOString()
  return db
    .prepare(
      `UPDATE auto_queue
          SET state = 'queued', run_id = NULL, claimed_at = NULL, updated_at = $at
        WHERE state IN ('claimed', 'planned', 'authorized')
          AND COALESCE(claimed_at, updated_at, '') < $cutoff
          AND ($run_id IS NULL OR run_id = $run_id)`,
    )
    .run({ at: nowIso(now), cutoff, run_id }).changes
}

// --- verifications -----------------------------------------------------------

export const VERIFY_MODES = new Set(["resume", "cover-letter"])

// Record what verify-claims decided. Upsert: re-verifying the same bytes of the
// same document replaces the earlier verdict for those bytes, which is what
// makes a re-run after a fact-base edit actually restore verification.
export function recordVerification(db, v) {
  if (!v?.slug) throw new TypeError("recordVerification requires a slug")
  if (!VERIFY_MODES.has(v.mode))
    throw new TypeError(
      `recordVerification requires mode 'resume' or 'cover-letter', got ${JSON.stringify(v.mode)}`,
    )
  if (!v.doc_sha256 || !v.profile_sha256)
    throw new TypeError(
      "recordVerification requires both doc_sha256 and profile_sha256 — a row " +
        "missing either is not evidence of anything",
    )
  return db
    .prepare(
      `INSERT INTO verifications
         (slug, doc_sha256, mode, verdict, profile_sha256, verified_at, doc)
       VALUES ($slug, $doc_sha256, $mode, $verdict, $profile_sha256, $verified_at, $doc)
       ON CONFLICT(slug, mode, doc_sha256) DO UPDATE SET
         verdict = excluded.verdict,
         profile_sha256 = excluded.profile_sha256,
         verified_at = excluded.verified_at,
         doc = excluded.doc`,
    )
    .run({
      slug: v.slug,
      doc_sha256: v.doc_sha256,
      mode: v.mode,
      verdict: v.verdict === "pass" ? "pass" : "fail",
      profile_sha256: v.profile_sha256,
      verified_at: v.verified_at ?? new Date().toISOString(),
      doc: v.doc == null ? null : JSON.stringify(v.doc),
    }).changes
}

/**
 * Is there a PASSING verification for exactly these bytes, checked against
 * exactly this fact base?
 *
 * Both hashes are required and both are compared. A row matching only
 * doc_sha256 means the document is unchanged but the facts behind it are not
 * the ones it was checked against — a stale verdict about a corpus that no
 * longer exists, which is not verification.
 */
export function hasPassingVerification(
  db,
  { slug, mode = "resume", doc_sha256, profile_sha256 } = {},
) {
  if (!slug || !doc_sha256 || !profile_sha256) return false
  return !!db
    .prepare(
      `SELECT 1 FROM verifications
        WHERE slug = ? AND mode = ? AND doc_sha256 = ? AND profile_sha256 = ?
          AND verdict = 'pass'`,
    )
    .get(slug, mode, doc_sha256, profile_sha256)
}

// --- workspace stack cache ---------------------------------------------------

/**
 * Every cached workspace stack, as `Map<slug, { job_sha256, title, company,
 * stack: Set, title_toks: Set }>`. ONE query per run — the point of the cache
 * is to replace N lexicon scans with a single read, so reading it row by row
 * would give the saving straight back.
 *
 * A row whose JSON will not parse is dropped rather than thrown on: this is a
 * cache, and an unreadable entry must degrade to a recompute, never to a crash
 * in a script whose job is to rank resumes.
 */
export function readWorkspaceStacks(db) {
  const out = new Map()
  for (const r of db.prepare("SELECT * FROM workspace_stacks").all()) {
    try {
      out.set(r.slug, {
        job_sha256: r.job_sha256,
        title: r.title,
        company: r.company,
        stack: new Set(JSON.parse(r.stack)),
        title_toks: new Set(JSON.parse(r.title_toks)),
      })
    } catch {
      /* unreadable row — recompute */
    }
  }
  return out
}

/** Upsert one workspace's derived stack. `stack`/`title_toks` may be Sets. */
export function upsertWorkspaceStack(db, w) {
  if (!w?.slug) throw new TypeError("upsertWorkspaceStack requires a slug")
  if (!w.job_sha256)
    throw new TypeError(
      "upsertWorkspaceStack requires job_sha256 — a cache row with no " +
        "invalidation key is worse than no row",
    )
  return db
    .prepare(
      `INSERT INTO workspace_stacks
         (slug, job_sha256, title, company, stack, title_toks, updated_at)
       VALUES ($slug, $job_sha256, $title, $company, $stack, $title_toks, $updated_at)
       ON CONFLICT(slug) DO UPDATE SET
         job_sha256 = excluded.job_sha256,
         title      = excluded.title,
         company    = excluded.company,
         stack      = excluded.stack,
         title_toks = excluded.title_toks,
         updated_at = excluded.updated_at`,
    )
    .run({
      slug: w.slug,
      job_sha256: w.job_sha256,
      title: w.title ?? null,
      company: w.company ?? null,
      stack: JSON.stringify([...(w.stack ?? [])]),
      title_toks: JSON.stringify([...(w.title_toks ?? [])]),
      updated_at: w.updated_at ?? new Date().toISOString(),
    }).changes
}

export function readVerifications(db, slug = null) {
  return slug
    ? db
        .prepare(
          "SELECT * FROM verifications WHERE slug = ? ORDER BY mode, verified_at",
        )
        .all(slug)
    : db.prepare("SELECT * FROM verifications ORDER BY slug, mode").all()
}

// per_company_max_per_week's counter, and the one that matters most: carpet
// bombing one employer is the reputational damage that actually costs the
// user something.
//
// Counts BOTH ledgers deliberately. auto_submissions alone would let the
// runner send a fourth application to a company the user applied to three
// times by hand this week — from the employer's side those are the same four
// applications. Company names are compared case- and whitespace-insensitively
// because the two ledgers get their names from different places (a board
// payload and the user typing it into log-application.mjs).
export function countCompanySubmissions(db, company, sinceIso) {
  return companySubmissionBreakdown(db, company, sinceIso).total
}

// The same count, itemised by where each application came from.
//
// The itemisation is not decoration. The cap counts dry-run rows on purpose
// (the rehearsal has to exercise the arithmetic the live run will), so five
// dry runs against one employer followed by a live enable will refuse every
// application to that employer — and the refusal used to blame the user's
// manual applications, which for a first-time enable is a message that sends
// them looking through a ledger that says nothing of the kind. A defer the
// user cannot act on is the failure hard rule 6 names.
//
// `live` and `dry_run` come from auto_submissions and include 'attempted'
// rows; `manual` comes from applications, because from the employer's side
// four applications are four applications whoever sent them.
export function companySubmissionBreakdown(db, company, sinceIso) {
  const norm = (s) =>
    String(s ?? "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase()
  const key = norm(company)
  const out = { total: 0, live: 0, dry_run: 0, manual: 0 }
  if (!key) return out
  const auto = db
    .prepare(
      // Same IS NOT as countAutoSubmissions, for the same two reasons: an
      // abandoned attempt is not an application, and a legacy NULL outcome is.
      "SELECT company, mode FROM auto_submissions WHERE submitted_at >= ? AND outcome IS NOT 'abandoned' AND outcome IS NOT 'reconciled-not-sent'",
    )
    .all(sinceIso)
  const manual = db
    .prepare("SELECT company FROM applications WHERE applied_at >= ?")
    .all(sinceIso)
  for (const r of auto) {
    if (norm(r.company) !== key) continue
    // An unknown mode counts as live. Nothing that reached this ledger without
    // saying it was a rehearsal gets the benefit of the doubt.
    if (r.mode === "dry_run") out.dry_run += 1
    else out.live += 1
  }
  for (const r of manual) if (norm(r.company) === key) out.manual += 1
  out.total = out.live + out.dry_run + out.manual
  return out
}

// Every board's accumulated history, newest-yielding first. Ordered here rather
// than at the call site so the one consumer that matters — the removal
// proposal — reads boards in the order a human would review them: the ones
// that have gone quiet longest, first.
export function readBoardStats(db) {
  return db
    .prepare(
      `SELECT board_id, type, slug, company, last_swept, live_postings,
              qualifying, solid, leads_produced, last_qualifying_at,
              sweeps, zero_streak
         FROM board_stats
        ORDER BY COALESCE(zero_streak, 0) DESC, leads_produced ASC, company ASC`,
    )
    .all()
}

/**
 * Has this posting already been applied to? Returns the matching application
 * row (`{slug, company, title, applied_at, source_url}`) or null.
 *
 * WHY THIS HAS TO EXIST, and it is not a tidy-up. Nothing on the unattended
 * path consulted the application ledger: `selectEligible` filters on a passing
 * verification and the trust gate, and the submit gate's checks are about
 * authorisation, readiness and volume — none of them asks "did the user already
 * send this one?". The `auto_submissions` `(slug, mode)` claim looks like it
 * covers this, but it only knows about submissions THIS RUNNER made, and every
 * application on record so far was filed through the attended path, so that
 * table was empty and the claim guarded nothing.
 *
 * Measured 2026-08-17: 12 of 21 queued jobs had already been applied to, and a
 * dry-run rehearsal selected one of them (applied 12 days earlier) and drove it
 * through scan, plan and fill to the submit gate. What stopped it was an
 * unrelated CONFIRM deferral on a sponsorship question. With `per_run_max: 10`
 * a live run could have re-sent ten.
 *
 * MATCHES ON SLUG OR SOURCE URL, and not on company+title. The slug is exact
 * and is what both stores already key by. The URL catches the same posting
 * re-slugged. Fuzzy company+title matching is deliberately NOT here: two real
 * openings at one employer often differ only by a level or a team name, and a
 * false positive silently withholds an application the user wanted — the same
 * class of harm as the duplicate, in the other direction. A near-miss is the
 * user's to judge, which is what `check-applied.mjs` is for.
 */
export function findPriorApplication(db, { slug = null, urls = [] } = {}) {
  const rows = db.prepare("SELECT * FROM applications").all()
  const wanted = new Set(
    (Array.isArray(urls) ? urls : [urls]).filter(
      (u) => typeof u === "string" && u.trim(),
    ),
  )
  for (const r of rows) {
    let doc = {}
    try {
      doc = r.doc ? JSON.parse(r.doc) : {}
    } catch {
      // A row whose doc will not parse still has a usable slug column, and a
      // duplicate check that threw on one bad row would fail open.
    }
    const rowSlug = r.slug ?? doc.slug ?? null
    if (slug && rowSlug === slug)
      return { ...doc, slug: rowSlug, matched: "slug" }
    const src = doc.source_url ?? null
    if (src && wanted.has(src))
      return { ...doc, slug: rowSlug, matched: "source_url" }
  }
  return null
}

export function recordBoardStats(db, row) {
  db.prepare(
    `INSERT INTO board_stats
       (board_id, type, slug, company, last_swept, live_postings, qualifying, solid, leads_produced, last_qualifying_at, sweeps, zero_streak)
     VALUES ($board_id, $type, $slug, $company, $last_swept, $live_postings, $qualifying, $solid, $leads_produced, $last_qualifying_at, 1, $zero_streak)
     ON CONFLICT(board_id) DO UPDATE SET
       last_swept = excluded.last_swept,
       live_postings = excluded.live_postings,
       qualifying = excluded.qualifying,
       solid = excluded.solid,
       leads_produced = board_stats.leads_produced + excluded.leads_produced,
       last_qualifying_at = CASE
         WHEN excluded.solid > 0 THEN excluded.last_swept
         ELSE board_stats.last_qualifying_at END,
       -- COALESCE, not a bare +1: a row healed into this shape carries NULL
       -- for both, and NULL + 1 is NULL in SQL, so without it a pre-existing
       -- board would stay uncounted forever and never become proposable.
       sweeps = COALESCE(board_stats.sweeps, 0) + 1,
       zero_streak = CASE
         WHEN excluded.solid > 0 THEN 0
         ELSE COALESCE(board_stats.zero_streak, 0) + 1 END`,
  ).run({
    board_id: row.board_id,
    type: row.type ?? null,
    slug: row.slug ?? null,
    company: row.company ?? null,
    last_swept: row.last_swept ?? new Date().toISOString(),
    live_postings: row.live_postings ?? 0,
    qualifying: row.qualifying ?? 0,
    solid: row.solid ?? 0,
    leads_produced: row.leads_produced ?? 0,
    // Must be decided here, not only in the ON CONFLICT branch: on a board's
    // FIRST sweep there is no conflict, so a CASE in the update clause never
    // runs and a productive board was being recorded as never having yielded.
    last_qualifying_at:
      row.last_qualifying_at ??
      ((row.solid ?? 0) > 0
        ? (row.last_swept ?? new Date().toISOString())
        : null),
    // Seeded here for the same reason, and it is not symmetric with `sweeps`:
    // a board's first sweep is 1 sweep either way, but its first streak is 1
    // only if that sweep was dry. Seeding 0 unconditionally would hide the
    // very first dry sweep of every board added to the list.
    zero_streak: (row.solid ?? 0) > 0 ? 0 : 1,
  })
}
