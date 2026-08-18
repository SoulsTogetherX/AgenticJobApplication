#!/usr/bin/env node
// Deterministic resume assembly — the tailoring step with the model removed.
//
// WHY THIS EXISTS, and it is not "a faster tailorer". Every other way this
// repository produces a resume routes the fact base through a model, and a
// model is the one component in the document pipeline that CAN lie. Rule 1 is
// enforced afterwards by verify-claims, which is a check: it catches an
// invention that was already proposed. This file removes the operation
// instead. It emits each selected fact's text VERBATIM, byte for byte, with the
// `<!-- fact:ID -->` annotation naming where it came from. Verbatim emission
// cannot invent a skill, an employer, a date or a metric, so R1-R7 hold by
// construction rather than by inspection.
//
// The second thing it buys is the ceiling. A supervised model batch produces
// as many documents as a human will sit through; this produces as many as
// there are leads. That is the constraint Phase 3 exists to lift.
//
// WHAT READS THE POSTING. Only keyword-plan.mjs's buildPlan, and it already
// sanitises: a posting is DATA, never instructions (hard rule 0). The posting
// influences exactly one thing here — WHICH of the user's own facts are
// selected — and it can never contribute a word of text to the document. No
// title mirror, no posting-derived phrasing, nothing. That is why the rule-0
// test can assert BYTE-IDENTICAL output for a posting with an instruction
// payload and the same posting without it: a payload can only move selection,
// and sanitizeUntrusted removes the payload before extractTech sees it.
//
// Usage:
//   node scripts/documents/assemble-resume.mjs <slug> [--jobs-dir jobs]
//        [--profile profile/profile.yaml] [--answers profile/answers.yaml]
//        [--limits docs/application-limits.yaml] [--budget 3800]
//        [--out <file>] [--stdout] [--json] [--diff] [--no-selection-file]
//   node scripts/documents/assemble-resume.mjs <slug> --audit-rephrase <file.md>
//
// WHAT THE POSTING SELECTS. Bullets, by keyword coverage — and, since
// 2026-08-17, WHICH summary variant and WHICH skills groups. A profile may bank
// several approved summary paragraphs (one per track); exactly one is emitted,
// the one whose terms best cover what the posting asks for, ties to profile
// order. Skills groups compete the same way with a floor of one. Before this,
// every variant was mandatory: five stacked summaries ate the budget and six
// unrelated jobs got byte-identical resumes with no bullets under four of five
// jobs. When a profile has two or more variants and NONE covers a term the
// posting asks for, assembly REFUSES (exit 3, `no-summary-fit`) — the user's
// call, in their words: "if nothing matches, I shouldn't have applied to this
// job in the first place." That refusal guards a CHOICE: a single variant is
// always carried, because with one there is nothing to mis-choose.
//
// Exit codes: 0 = assembled (or the rephrase audit passed), 1 = the rephrase
// audit failed, 2 = usage / refused, 3 = refused: no summary variant fits the
// posting (`no-summary-fit`; nothing is written).
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import {
  loadYamlFile,
  buildFactIndex,
  evidenceText,
  isTerse,
} from "../lib/lib.mjs"
import { extractTech } from "../lib/keywords.mjs"
import { buildPlan } from "./keyword-plan.mjs"
import { profileText } from "../profile/profile-gaps.mjs"
import { loadFactContext, verifyDocument } from "./verify-claims.mjs"

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
)

// Rendered characters of CONTENT — the header line, the summary, every heading
// and every bullet, with the `<!-- fact:ID -->` annotations and the section
// markers excluded because neither reaches the page. 3800 is a one-page resume
// at a normal body size; the number is a knob because page density is a
// per-user judgement, not a fact about the pipeline.
export const DEFAULT_BUDGET = 3800

// A required term the posting asks for is worth two of a merely-mentioned one.
// Not tuned — declared, so the ranking is readable off the source rather than
// reverse-engineered from output.
const WEIGHT_REQUIRED = 2
const WEIGHT_MENTIONED = 1

const ANNOTATION = (id) => `<!-- fact:${id} -->`

// The exit code for a refused assembly, exported so cycle.mjs can tell "no
// summary variant fits this posting" apart from every other failure without
// parsing stderr. Distinct from 2 (usage/refused) on purpose: 2 means the
// caller got something wrong, 3 means the caller did everything right and the
// posting simply is not one this profile can be tailored to.
export const EXIT_NO_FIT = 3

/**
 * Thrown by selectItems when the profile carries two or more summary variants
 * and none of them covers a single term the posting asks for. Carries the
 * ranked variants and the must_use list so the refusal is auditable: the user
 * can see every score was 0 rather than take the word for it.
 */
export class NoSummaryFit extends Error {
  constructor({ mustUse, variants }) {
    const asked = [...mustUse.entries()]
      .map(([t, req]) => (req ? `${t}*` : t))
      .sort()
    const scored = variants.map((v) => `${v.id} ${v.score}`)
    super(
      `no summary variant covers a term the posting asked for — must_use: ` +
        `${asked.join(", ") || "(none)"}; variants scored: ${scored.join(", ")}`,
    )
    this.name = "NoSummaryFit"
    this.code = "no-summary-fit"
    this.must_use = asked
    this.variants = variants.map((v) => ({ id: v.id, score: v.score }))
  }
}

// ---------------------------------------------------------------------------
// Item model
//
// Every line the document can contain is an ITEM with a fact id, a rendered
// line, and a content cost. Items come in three kinds:
//
//   MANDATORY   the contact header, every employment heading, education — a
//               resume without an employment history is not a resume,
//               whatever the budget says. Charged first, unconditionally.
//   SELECTABLE  bullets, which is where the posting gets most of its say.
//   POOLED      `pool: "summary"` — the banked summary variants, of which
//               EXACTLY ONE is emitted; `pool: "skills"` — the skills groups,
//               of which AT LEAST ONE is emitted. The posting picks which.
// ---------------------------------------------------------------------------

const joinNonEmpty = (parts, sep) =>
  parts
    .map((p) => String(p ?? "").trim())
    .filter(Boolean)
    .join(sep)

function expHeading(exp) {
  const left = joinNonEmpty([exp.title, exp.company], " — ")
  const dates = String(exp.dates ?? "").trim()
  return dates
    ? `### ${left} <span class="dates">${dates}</span>`
    : `### ${left}`
}

function prjHeading(prj) {
  const tech = String(prj.tech ?? "").trim()
  return tech ? `### ${prj.name} (${tech})` : `### ${prj.name}`
}

function eduLine(edu) {
  const tail = joinNonEmpty(
    [edu.degrees, edu.graduated, edu.gpa ? `GPA ${edu.gpa}` : "", edu.honors],
    ", ",
  )
  return joinNonEmpty([edu.school, tail], " — ")
}

// Content cost: what the reader sees. The annotation is an HTML comment and the
// markdown list marker is a glyph, so neither is charged — charging them would
// make the budget depend on how long the fact IDS are.
const costOf = (text) => String(text).length

/**
 * Every emittable line, in document order, with its fact id and cost.
 * Pure: profile in, items out. `factIndex` is passed in because it is built
 * ONCE per run (3.4) and shared with verification.
 */
export function planItems(profile, factIndex) {
  const items = []
  const notEmitted = []
  let order = 0
  const push = (it) => {
    items.push({ ...it, order: order++ })
  }

  const contact = profile.contact ?? {}
  push({
    id: "__contact",
    section: "header",
    mandatory: true,
    fact: null,
    lines: [
      `# ${String(contact.name ?? "").trim()}`,
      "",
      joinNonEmpty([contact.location, contact.phone, contact.email], " | "),
    ],
    text: joinNonEmpty(
      [contact.name, contact.location, contact.phone, contact.email],
      " | ",
    ),
    covers: [],
  })

  // Summary VARIANTS, not summaries: the user banks one approved paragraph per
  // track and selection emits exactly one. `mandatory: true` here is the bug
  // this file carried until 2026-08-17 — every variant went in, ~2,100 chars
  // of a 3,800 budget, and the bullets got 9.
  for (const s of profile.summary ?? []) {
    push({
      id: s.id,
      section: "summary",
      mandatory: false,
      pool: "summary",
      fact: s.id,
      lines: [`${s.text} ${ANNOTATION(s.id)}`],
      text: String(s.text),
      covers: [...extractTech(s.text)],
      contextual: true,
    })
  }

  for (const exp of profile.experience ?? []) {
    push({
      id: exp.id,
      section: "experience",
      mandatory: true,
      fact: exp.id,
      lines: [`${expHeading(exp)} ${ANNOTATION(exp.id)}`],
      text: expHeading(exp),
      covers: [],
      isHeading: true,
    })
    for (const b of exp.bullets ?? []) {
      push({
        id: b.id,
        section: "experience",
        mandatory: false,
        parent: exp.id,
        fact: b.id,
        lines: [`- ${b.text} ${ANNOTATION(b.id)}`],
        text: String(b.text),
        covers: [...extractTech(b.text)],
        contextual: true,
      })
    }
  }

  for (const prj of profile.projects ?? []) {
    // A project heading is emitted only if one of its bullets survives
    // selection — a project with nothing relevant under it is a line of noise.
    push({
      id: prj.id,
      section: "projects",
      mandatory: false,
      conditional: true,
      fact: prj.id,
      lines: [`${prjHeading(prj)} ${ANNOTATION(prj.id)}`],
      text: prjHeading(prj),
      covers: [],
      isHeading: true,
    })
    for (const b of prj.bullets ?? []) {
      push({
        id: b.id,
        section: "projects",
        mandatory: false,
        parent: prj.id,
        fact: b.id,
        lines: [`- ${b.text} ${ANNOTATION(b.id)}`],
        text: String(b.text),
        covers: [...extractTech(b.text)],
        contextual: true,
      })
    }
  }

  for (const sk of profile.skills ?? []) {
    // The fact index's text for a skills group IS "Group: a, b, c", so this
    // line is the fact verbatim, not a re-rendering of it.
    //
    // Pooled with a floor of one rather than mandatory: a resume needs A skills
    // block, not every group the user ever banked. The best-scoring group is
    // always kept; the rest compete for what the bullets leave. Deliberately
    // NOT `contextual` — see selectItems on why the skills block never seeds
    // coverage.
    const text = factIndex.get(sk.id)?.text ?? ""
    push({
      id: sk.id,
      section: "skills",
      mandatory: false,
      pool: "skills",
      fact: sk.id,
      lines: [`- ${text} ${ANNOTATION(sk.id)}`],
      text,
      covers: [...extractTech(text)],
    })
  }

  for (const edu of profile.education ?? []) {
    push({
      id: edu.id,
      section: "education",
      mandatory: true,
      fact: edu.id,
      lines: [`- ${eduLine(edu)} ${ANNOTATION(edu.id)}`],
      text: eduLine(edu),
      covers: [],
    })
  }

  // Sections the assembled shape has no place for. Recorded rather than
  // silently absent: hard rule 5's diff has to be able to say a fact was not
  // considered, and why, or the user cannot tell it from a fact that lost.
  for (const org of profile.organizations ?? [])
    notEmitted.push({
      id: org.id,
      section: "organizations",
      reason: "the assembled resume shape has no organizations section",
    })
  for (const ex of profile.extras ?? [])
    notEmitted.push({
      id: ex.id,
      section: "extras",
      reason: "the assembled resume shape has no extras section",
    })
  for (const a of profile.__answers ?? [])
    notEmitted.push({
      id: a.id,
      section: "answers",
      reason: "answers.yaml holds form answers, not resume prose",
    })

  return { items, notEmitted }
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

/**
 * Choose which items fit, by keyword coverage, under `budget`.
 *
 * Phases, in this order and for these reasons:
 *
 *   STRUCTURAL   every mandatory item — contact, employment headings,
 *                education. Charged unconditionally.
 *   SUMMARY      the banked variants ranked by RAW weighted overlap with
 *                must_use; the best is taken. Ties break to profile order, so
 *                the order of `summary:` in profile.yaml is load-bearing: the
 *                one listed first is the tie-break default. With two or more
 *                variants and a best score of 0 this THROWS NoSummaryFit — a
 *                posting none of the user's tracks addresses is not one to
 *                pick a paragraph for. A single variant is always taken: there
 *                is nothing to mis-choose.
 *   SKILLS FLOOR the best-scoring skills group, always. A resume needs a
 *                skills block; it does not need every group ever banked.
 *   COVERAGE     bullets, greedy on MARGINAL gain — the one that adds the most
 *                not-yet-covered must_use terms per line. This is the phase
 *                the posting drives hardest.
 *   SKILLS       the remaining groups that score above 0, on RAW score, while
 *                budget remains. Raw, not marginal: the skills block is the
 *                literal parser's keyword region (keyword-plan.mjs's header),
 *                and marginal scoring would shrink it for exactly the postings
 *                the bullets cover well. After COVERAGE, not before, or an
 *                18-term group out-scores any bullet and eats the freed budget
 *                before the prose both gatekeepers actually reward.
 *   FILL         whatever is left — bullets and zero-score groups alike — in
 *                profile order, while budget remains. A bullet that matches
 *                no keyword is still the user's real work, and a page with
 *                room on it should carry it.
 *
 * Emission order is always PROFILE order, never selection order: the posting
 * decides what is on the page, never how the page reads.
 *
 * COVERAGE COUNTS CONTEXT ONLY — the chosen summary and the bullets, never the
 * skills block. That is not a detail: the skills block lists every term the
 * user has, so counting it made every must_use term "already covered" before
 * the first bullet was considered, the greedy phase found zero marginal gain
 * every time, and selection silently degenerated to "profile order until the
 * budget runs out" — the posting had no influence on the document at all. It
 * also matches what the two gatekeepers actually reward: the literal parser
 * wants the term listed, the LLM layer wants it used in a sentence about real
 * work, and only bullets do the second job. Skills groups now compete for
 * INCLUSION, in their own phase, and they still never seed `covered`.
 *
 * Fully deterministic. Ties break on cost, then on profile order.
 */
export function selectItems(items, mustUse, budget) {
  const weight = (t) =>
    mustUse.get(t) === true ? WEIGHT_REQUIRED : WEIGHT_MENTIONED
  const relevant = (it) => it.covers.filter((t) => mustUse.has(t))
  const score = (it) => relevant(it).reduce((s, t) => s + weight(t), 0)
  // A pool ranked best-first. `order` is unique per item, so nothing beyond it
  // is needed to make the sort total.
  const ranked = (pool) =>
    items
      .filter((it) => it.pool === pool)
      .map((it) => ({ it, id: it.id, score: score(it), terms: relevant(it) }))
      .sort((a, b) => b.score - a.score || a.it.order - b.it.order)

  const byId = new Map(items.map((it) => [it.id, it]))
  const chosen = new Map() // id -> { how, covers, reason }
  let spent = 0

  // --- STRUCTURAL ---
  const mandatory = items.filter((it) => it.mandatory)
  for (const it of mandatory) {
    spent += costOf(it.text)
    chosen.set(it.id, {
      how: "mandatory",
      covers: relevant(it),
      reason: it.isHeading
        ? "employment history — every entry is carried"
        : "structural section — a resume without it is not a resume",
    })
  }

  // --- SUMMARY ---
  //
  // `how: "mandatory"` for the chosen one, deliberately. It IS structural
  // that a summary exists; what the posting decided is which text fills the
  // slot, and the reason line carries that. Keeping the `how` vocabulary at
  // its four values also keeps every reader of resume-selection.json honest.
  const variants = ranked("summary")
  let summary = null
  if (variants.length === 1) {
    summary = variants[0]
    spent += costOf(summary.it.text)
    chosen.set(summary.id, {
      how: "mandatory",
      covers: summary.terms,
      reason: "the only summary variant — carried for every posting",
    })
  } else if (variants.length > 1) {
    if (variants[0].score === 0) throw new NoSummaryFit({ mustUse, variants })
    summary = variants[0]
    const runnerUp = variants[1]
    spent += costOf(summary.it.text)
    chosen.set(summary.id, {
      how: "mandatory",
      covers: summary.terms,
      reason:
        `summary variant chosen for this posting — scored ${summary.score} ` +
        `(${summary.terms.join(", ")}); ${runnerUp.id} scored ${runnerUp.score}`,
    })
  }

  // --- SKILLS FLOOR ---
  const groups = ranked("skills")
  if (groups.length) {
    const g = groups[0]
    spent += costOf(g.it.text)
    chosen.set(g.id, {
      how: "mandatory",
      covers: g.terms,
      reason:
        g.score > 0
          ? `skills block — lists ${g.terms.join(", ")} (scored ${g.score}), the best match for this posting`
          : "skills block — no group lists a term the posting asked for; first in profile order kept because a resume without a skills block is not a resume",
    })
  }

  // --- COVERAGE ---
  const bullets = items.filter(
    (it) => !it.mandatory && !it.conditional && !it.pool,
  )
  // A bullet drags its project heading in with it the first time.
  const extraCost = (it) =>
    it.parent && byId.get(it.parent)?.conditional && !chosen.has(it.parent)
      ? costOf(byId.get(it.parent).text)
      : 0
  const take = (it, how, reason) => {
    const parent = it.parent ? byId.get(it.parent) : null
    if (parent?.conditional && !chosen.has(parent.id)) {
      spent += costOf(parent.text)
      chosen.set(parent.id, {
        how: "carried",
        covers: [],
        reason: `heading for ${it.id}`,
      })
    }
    spent += costOf(it.text)
    chosen.set(it.id, { how, covers: relevant(it), reason })
  }

  // Seeded from the CHOSEN summary only. Never from a skills group — see the
  // header — and never from the un-chosen variants, which are not on the page.
  const covered = new Set(summary ? summary.terms : [])

  for (;;) {
    let best = null
    for (const it of bullets) {
      if (chosen.has(it.id)) continue
      const gain = relevant(it)
        .filter((t) => !covered.has(t))
        .reduce((s, t) => s + weight(t), 0)
      if (gain === 0) continue
      const cost = costOf(it.text) + extraCost(it)
      if (spent + cost > budget) continue
      if (
        !best ||
        gain > best.gain ||
        (gain === best.gain && cost < best.cost) ||
        (gain === best.gain && cost === best.cost && it.order < best.it.order)
      )
        best = { it, gain, cost }
    }
    if (!best) break
    const added = relevant(best.it).filter((t) => !covered.has(t))
    take(
      best.it,
      "coverage",
      `covers ${added.join(", ")}${added.some((t) => mustUse.get(t)) ? " (posting requires " + added.filter((t) => mustUse.get(t)).join(", ") + ")" : ""}`,
    )
    for (const t of added) covered.add(t)
  }

  // --- SKILLS --- the scoring groups beyond the floor, raw score, `covered`
  // untouched.
  for (const g of groups.slice(1)) {
    if (g.score === 0) continue
    const cost = costOf(g.it.text)
    if (spent + cost > budget) continue
    take(
      g.it,
      "coverage",
      `lists ${g.terms.join(", ")} — terms the posting asked for (scored ${g.score})`,
    )
  }

  // --- FILL --- everything still standing, in profile order: bullets and the
  // zero-score skills groups alike. That is what "compete" means at a tight
  // budget — a group listing nothing the posting asked for waits its turn
  // behind the user's real work.
  const dropped = []
  const fillable = items.filter(
    (it) => !it.mandatory && !it.conditional && it.pool !== "summary",
  )
  for (const it of fillable) {
    if (chosen.has(it.id)) continue
    const cost = costOf(it.text) + extraCost(it)
    if (spent + cost <= budget) {
      take(
        it,
        "fill",
        "no term the posting asked for; included to fill the page",
      )
    } else {
      const terms = relevant(it)
      const isGroup = it.pool === "skills"
      dropped.push({
        id: it.id,
        section: it.section,
        chars: cost,
        covers: terms,
        reason:
          `budget exhausted — needs ${cost} chars, ${Math.max(0, budget - spent)} left` +
          (terms.length
            ? isGroup
              ? `; lists ${terms.join(", ")}, which the posting asked for`
              : `; its terms (${terms.join(", ")}) are already covered`
            : isGroup
              ? "; lists nothing the posting asked for"
              : "; covers nothing the posting asked for"),
      })
    }
  }

  // --- DROPPED --- the un-chosen summary variants, with the score that lost.
  for (const v of variants) {
    if (chosen.has(v.id)) continue
    dropped.push({
      id: v.id,
      section: "summary",
      chars: costOf(v.it.text),
      covers: v.terms,
      reason: `summary variant not chosen — scored ${v.score} against the posting; ${summary.id} scored ${summary.score}`,
    })
  }
  for (const it of items) {
    if (it.conditional && !chosen.has(it.id))
      dropped.push({
        id: it.id,
        section: it.section,
        chars: costOf(it.text),
        covers: [],
        reason: "no bullet under it was selected",
      })
  }

  return {
    chosen,
    dropped,
    spent,
    budget,
    over_budget: spent > budget,
    summary_choice: {
      chosen: summary ? summary.id : null,
      ranked: variants.map((v) => ({
        id: v.id,
        score: v.score,
        terms: v.terms,
      })),
    },
  }
}

// ---------------------------------------------------------------------------
// Emission
// ---------------------------------------------------------------------------

const SECTION_TITLE = {
  summary: "Summary",
  experience: "Experience",
  projects: "Projects",
  skills: "Technical Skills",
  education: "Education",
}

// A markdown list is ONE block; a heading and a paragraph each stand alone.
// Emitting the blank lines that rule implies is what makes the output a
// prettier fixed point — and that is what lets the golden files be compared
// byte for byte, since prettier runs on anything an agent edits.
function emit(items, chosen) {
  const out = []
  const blank = () => {
    if (out.length && out[out.length - 1] !== "") out.push("")
  }
  let section = null
  for (const it of items) {
    if (!chosen.has(it.id)) continue
    if (it.section !== "header" && it.section !== section) {
      section = it.section
      blank()
      out.push(`## ${SECTION_TITLE[section]}`)
      blank()
    }
    for (const line of it.lines) {
      if (line === "") blank()
      else if (line.startsWith("- ")) out.push(line)
      else {
        blank()
        out.push(line)
        blank()
      }
    }
  }
  const text = out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
  return text + "\n"
}

/**
 * The whole of item 3.1: (job, profile, answers, plan) -> markdown + the
 * selection record hard rule 5's approval message is built from.
 *
 * Pure. No I/O, no clock, no randomness — the same four inputs give the same
 * bytes, which is what makes the golden-file test meaningful.
 */
export function assembleResume({
  job,
  profile,
  answers,
  plan,
  budget = DEFAULT_BUDGET,
  factIndex = null,
}) {
  const index = factIndex ?? buildFactIndex(profile, answers)
  const { items, notEmitted } = planItems(
    { ...profile, __answers: answers?.answers ?? [] },
    index,
  )
  const mustUse = new Map(
    (plan?.must_use ?? []).map((m) => [m.skill, m.required === true]),
  )
  const { chosen, dropped, spent, over_budget, summary_choice } = selectItems(
    items,
    mustUse,
    budget,
  )
  const markdown = emit(items, chosen)

  const placed = new Set()
  for (const [id, rec] of chosen) {
    void id
    for (const t of rec.covers) placed.add(t)
  }
  const missing = [...mustUse.keys()].filter((t) => !placed.has(t))

  const selection = {
    slug: job?.slug ?? null,
    company: job?.company ?? null,
    budget,
    chars_used: spent,
    over_budget,
    included: items
      .filter((it) => chosen.has(it.id))
      .map((it) => ({
        id: it.id,
        section: it.section,
        how: chosen.get(it.id).how,
        chars: costOf(it.text),
        covers: chosen.get(it.id).covers,
        reason: chosen.get(it.id).reason,
      })),
    dropped,
    not_emitted: notEmitted,
    // Which summary variant was chosen and how every variant scored, so the
    // rule-5 diff can show the choice was mechanical and the runner-up was
    // not close — or was, and profile order decided.
    summary_choice,
    keyword_coverage: {
      must_use: mustUse.size,
      placed: mustUse.size - missing.length,
      missing,
      missing_required: missing.filter((t) => mustUse.get(t) === true),
    },
  }
  return { markdown, selection }
}

/**
 * Hard rule 5, mechanically (item 3.5).
 *
 * The rule asks the agent to show what was emphasised, dropped and rephrased
 * before a PDF is rendered. Until now that was a model describing its own
 * work, which is the one source that cannot be checked. This is the selection
 * itself: fact ids in, fact ids out, and the reason each one moved. Nothing
 * here is generated text.
 */
export function formatSelectionDiff(selection) {
  const L = []
  const kc = selection.keyword_coverage
  L.push(
    `SELECTION for ${selection.slug ?? "(no slug)"} — ${selection.chars_used}/${selection.budget} chars` +
      (selection.over_budget ? " (OVER BUDGET)" : ""),
  )
  // The summary choice gets its own line because it is the one decision a
  // reader most wants to check: which of the user's own paragraphs went out,
  // and how close the others came.
  const sc = selection.summary_choice
  if (sc?.chosen) {
    const ranked = sc.ranked ?? []
    const winner = ranked.find((v) => v.id === sc.chosen)
    const others = ranked.filter((v) => v.id !== sc.chosen)
    L.push(
      ranked.length === 1
        ? `SUMMARY   ${sc.chosen} — the only variant`
        : `SUMMARY   ${sc.chosen} chosen (scored ${winner?.score ?? "?"}: ${(winner?.terms ?? []).join(", ") || "no terms"}); ` +
            others.map((v) => `${v.id} ${v.score}`).join(", "),
    )
  }
  L.push("")
  L.push(`INCLUDED (${selection.included.length})`)
  for (const i of selection.included)
    L.push(`  + ${i.id.padEnd(16)} ${i.section.padEnd(11)} ${i.reason}`)
  L.push("")
  L.push(`DROPPED (${selection.dropped.length})`)
  for (const d of selection.dropped)
    L.push(`  - ${d.id.padEnd(16)} ${d.section.padEnd(11)} ${d.reason}`)
  if (selection.not_emitted.length) {
    L.push("")
    L.push(`NOT CONSIDERED (${selection.not_emitted.length})`)
    for (const n of selection.not_emitted)
      L.push(`  . ${n.id.padEnd(16)} ${n.section.padEnd(11)} ${n.reason}`)
  }
  L.push("")
  L.push(
    `KEYWORDS  ${kc.placed}/${kc.must_use} placed` +
      (kc.missing.length ? `; missing: ${kc.missing.join(", ")}` : "") +
      (kc.missing_required.length
        ? `; MISSING AND REQUIRED: ${kc.missing_required.join(", ")}`
        : ""),
  )
  L.push(
    "Every line above is a fact id from profile.yaml. No sentence in the " +
      "document was written by a model.",
  )
  return L.join("\n")
}

// ---------------------------------------------------------------------------
// Item 3.2 — the model rephrase pass, kept available and kept re-verified
// ---------------------------------------------------------------------------

const FACT_RE = /<!--\s*fact:\s*([A-Za-z0-9_,\s-]+?)\s*-->/

/** Annotated lines of a document: `[{ ids, content }]`, in document order. */
export function annotatedLines(markdown) {
  const out = []
  for (const line of String(markdown).split(/\r?\n/)) {
    const m = line.match(FACT_RE)
    if (!m) continue
    out.push({
      ids: m[1]
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      content: line
        .replace(FACT_RE, "")
        .replace(/^\s*[-*●]\s+/, "")
        .trim(),
    })
  }
  return out
}

/**
 * Compare a model-rephrased document against the deterministic assembly of the
 * same job, per fact id.
 *
 * 3.2 keeps the rephrase pass available for ATTENDED sessions, and the whole
 * condition on keeping it is that it is re-verified. This is the diff half; the
 * caller runs verifyDocument for the verification half, and the CLI refuses to
 * run at all under --unattended. A rephrase is a model turn, and a model turn
 * is exactly what the unattended path must not contain.
 */
export function rephraseAudit({ baseline, edited, factIndex }) {
  const base = new Map()
  for (const l of annotatedLines(baseline))
    for (const id of l.ids) base.set(id, l.content)
  const rows = []
  const seen = new Set()
  for (const l of annotatedLines(edited)) {
    for (const id of l.ids) {
      seen.add(id)
      const known = factIndex.has(id)
      if (!known) rows.push({ id, status: "unknown-fact", edited: l.content })
      else if (!base.has(id))
        rows.push({ id, status: "added", edited: l.content })
      else if (base.get(id) === l.content)
        rows.push({ id, status: "verbatim", edited: l.content })
      else
        rows.push({
          id,
          status: "rephrased",
          baseline: base.get(id),
          edited: l.content,
        })
    }
  }
  for (const [id, content] of base)
    if (!seen.has(id)) rows.push({ id, status: "dropped", baseline: content })
  const counts = {}
  for (const r of rows) counts[r.status] = (counts[r.status] ?? 0) + 1
  return { rows, counts, ok: !counts["unknown-fact"] }
}

// ---------------------------------------------------------------------------
// CLI — thin
// ---------------------------------------------------------------------------

function flag(args, name, dflt = null) {
  const i = args.indexOf(name)
  return i !== -1 && args[i + 1] !== undefined ? args[i + 1] : dflt
}

export function main(argv = process.argv.slice(2)) {
  const die = (m) => {
    console.error(m)
    process.exit(2)
  }
  const slug = argv.find((a) => !a.startsWith("--") && !isFlagValue(argv, a))
  if (!slug)
    die(
      "usage: assemble-resume.mjs <slug> [--budget N] [--out f] [--json] [--diff]",
    )

  const jobsDir = flag(argv, "--jobs-dir") || path.join(ROOT, "jobs")
  const profilePath =
    flag(argv, "--profile") || path.join(ROOT, "profile", "profile.yaml")
  const answersPath =
    flag(argv, "--answers") || path.join(ROOT, "profile", "answers.yaml")
  const limitsPath =
    flag(argv, "--limits") || path.join(ROOT, "docs", "application-limits.yaml")
  const budget = Number(flag(argv, "--budget", String(DEFAULT_BUDGET)))
  const rephraseFile = flag(argv, "--audit-rephrase")

  if (!Number.isFinite(budget) || budget <= 0) die(`bad --budget: ${budget}`)

  const jobFile = path.join(jobsDir, slug, "job.json")
  if (!fs.existsSync(jobFile))
    die(`no job workspace at ${jobFile} — run new-job.mjs first`)
  if (!fs.existsSync(profilePath)) die(`profile not found at ${profilePath}`)

  const job = { slug, ...JSON.parse(fs.readFileSync(jobFile, "utf8")) }
  // ONE fact index per run (3.4), shared by assembly and verification.
  const ctx = loadFactContext({ profilePath, answersPath })
  if (ctx.profile?.meta?.approved_by_user !== true)
    die(
      `${profilePath} has meta.approved_by_user != true — the fact base is not ` +
        `approved for tailoring. Ask the user; never set it yourself.`,
    )

  const limits = fs.existsSync(limitsPath)
    ? (loadYamlFile(limitsPath) ?? {})
    : {}
  const blob = evidenceText(profileText(ctx.profile), ctx.answers)
  const plan = buildPlan({
    job,
    profileBlob: blob,
    targets: limits.roles?.title_keywords ?? [],
  })

  let markdown, selection
  try {
    ;({ markdown, selection } = assembleResume({
      job,
      profile: ctx.profile,
      answers: ctx.answers,
      plan,
      budget,
      factIndex: ctx.factIndex,
    }))
  } catch (e) {
    // The refusal is decided before anything is written: no resume.md, no
    // resume-selection.json, so a workspace that fit yesterday keeps
    // yesterday's document rather than losing it to today's posting. Its own
    // exit code, so cycle.mjs can record "this posting is not one the profile
    // addresses" without parsing this message.
    if (e?.code === "no-summary-fit") {
      console.error(`refused: no-summary-fit — ${e.message}`)
      // process.exit here, matching `die` above, rather than a return value:
      // main()'s return is discarded by the entry wrapper, and a refusal that
      // exits 0 is a refusal cycle.mjs would count as a prepared document.
      process.exit(EXIT_NO_FIT)
    }
    throw e
  }

  if (rephraseFile) return auditRephrase({ argv, rephraseFile, ctx, markdown })

  const outFile = flag(argv, "--out") || path.join(jobsDir, slug, "resume.md")
  if (argv.includes("--stdout")) {
    process.stdout.write(markdown)
  } else {
    fs.mkdirSync(path.dirname(outFile), { recursive: true })
    fs.writeFileSync(outFile, markdown)
  }
  if (!argv.includes("--no-selection-file") && !argv.includes("--stdout")) {
    fs.writeFileSync(
      path.join(path.dirname(outFile), "resume-selection.json"),
      JSON.stringify(selection, null, 2),
    )
  }

  if (argv.includes("--json")) {
    console.log(JSON.stringify(selection, null, 2))
  } else if (argv.includes("--diff")) {
    console.log(formatSelectionDiff(selection))
  } else if (!argv.includes("--stdout")) {
    const kc = selection.keyword_coverage
    if (isTerse()) {
      console.log(
        `assembled=${outFile} facts=${selection.included.length} dropped=${selection.dropped.length} ` +
          `chars=${selection.chars_used}/${selection.budget} keywords=${kc.placed}/${kc.must_use} ` +
          `summary=${selection.summary_choice?.chosen ?? "none"} model_turns=0`,
      )
    } else {
      console.log(formatSelectionDiff(selection))
      console.log(`\nWritten to ${outFile}`)
    }
  }
  return 0
}

// `--out foo` must not make "foo" look like the slug.
function isFlagValue(argv, token) {
  const i = argv.indexOf(token)
  return i > 0 && argv[i - 1].startsWith("--")
}

function auditRephrase({ argv, rephraseFile, ctx, markdown }) {
  if (argv.includes("--unattended")) {
    console.error(
      "refused: --audit-rephrase is an ATTENDED-session step. The rephrase " +
        "pass is a model turn, and the unattended path must not contain one.",
    )
    process.exit(2)
  }
  if (!fs.existsSync(rephraseFile)) {
    console.error(`No such file: ${rephraseFile}`)
    process.exit(2)
  }
  const edited = fs.readFileSync(rephraseFile, "utf8")
  const audit = rephraseAudit({
    baseline: markdown,
    edited,
    factIndex: ctx.factIndex,
  })
  // The re-verification half. A rephrase that no longer verifies is not a
  // rephrase, it is an invention, and it must not be reported as a diff.
  const report = verifyDocument({ doc: edited, mode: "resume", ctx })
  const ok = audit.ok && report.ok
  console.log(
    JSON.stringify(
      {
        file: rephraseFile,
        ok,
        counts: audit.counts,
        rows: audit.rows,
        verification: { ok: report.ok, violations: report.violations },
      },
      null,
      2,
    ),
  )
  process.exit(ok ? 0 : 1)
}

const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (isMain) main()
