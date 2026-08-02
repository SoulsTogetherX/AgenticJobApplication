## 5. What we are deleting

### 5.1 From the plan

| Deleted                                                                            | Reason                                                                                  |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| §3.5's premise, "the runner cannot tailor"                                         | False. C1.                                                                              |
| The count-based circuit breaker                                                    | Arithmetically a volume throttle at N=999 (median halt job 292). C2.                    |
| `-ExecutionTimeLimit 01:00` and one-invocation-is-one-campaign                     | Cannot fit the requirement; a longer limit covers one of three interruption causes. C3. |
| The 26h recency heartbeat as the health signal                                     | Never built, and the wrong statistic once runs are resumable. C4.                       |
| R6 (split `CLAUDE.md`) from this critical path                                     | The runner has no model in it. C5.                                                      |
| "Half-filled applications are an accepted cost"                                    | The one reputational cost that scales with volume, arriving through the defer path. C7. |
| **Revision 1's `PRIMARY KEY (slug)` claim**                                        | Dry-run rows would have pre-consumed the live claim forever. C8.                        |
| **Revision 1's "one persistent context is forced" and its `board_key` mitigation** | The branch exists; the key is tenant-scoped and the hazard is origin-scoped. C9.        |
| **Revision 1's all-dry-run validation ladder**                                     | Never exercised the post-click path before a real employer did. C10.                    |
| **Revision 1's Phase-4 placement of the fill harness**                             | Baseline would have absorbed five un-budgeted fill-path changes. C11.                   |
| **Revision 1's non-gating, target-free supply check**                              | The arithmetic misses by an order of magnitude and nothing could have said so. C12.     |
| **Revision 1's "post-submit page is not a confirmation ⇒ hard STOP"**              | Expected environmental outcome on the launch board, with probability rising in N. C13.  |
| **Revision 1's heartbeat single-flight**                                           | A non-sequitur that re-derives the frozen-process failure in a new column. §4.3.        |
| **Revision 1's wall-clock composite**                                              | Its isolation model and its divisor were both invalidated. §4.7.                        |
| **Revision 1's §6.1 concurrency proposal of 8**                                    | Transplanted from a workload 76× shorter and presented to the user as measured. §6.1.   |

### 5.2 From the codebase

| Deleted                                                                         | Where                        | Reason                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AUTO_RUN_LOCK`                                                                 | `lock.mjs:176`               | Zero callers (verified) **and the wrong shape** — a single global run mutex is what a worker pool must not have. Leaving it invites someone to "complete" it into the thing that caps concurrency at 1. Extends R8. |
| The file-existence `hasVerifiedResume` block                                    | `automatability.mjs:454-473` | Makes any `resume.md` on disk green, verified or not. A rule-1 hole reachable by accident, on the auto path.                                                                                                        |
| `auto_runs`' `planned` / `deferred` / `failed` counters                         | `db.mjs:189-204`             | Counters with no rows behind them — a database with no source of truth. Derived from `auto_queue`.                                                                                                                  |
| `auto_submissions` `PRIMARY KEY (run_id, slug)` and its `ON CONFLICT DO UPDATE` | `db.mjs:232-246`, `785-813`  | Backwards for a row whose job is to be a claim. Replaced by `(slug, mode)` + `DO NOTHING`.                                                                                                                          |
| `auth-sync`'s `SKIP_DIRS` denylist                                              | `auth-sync.mjs:119-141`      | An allowlist costs the same and removes the class.                                                                                                                                                                  |
| The dead consent-allowlist grant branch                                         | in flight                    | Already landing. Dead code is a lie about intent.                                                                                                                                                                   |

### 5.3 Never build

- **LinkedIn Easy Apply submission.** The one vector that demonstrably gets comparable tools' users
  restricted, and LinkedIn's ToS prohibits automated systems simulating human activity. This
  pipeline's direct-to-ATS architecture structurally avoids it. If LinkedIn is ever used, discovery
  only.
- **Internal-endpoint replay** for Greenhouse/Ashby/Lever. Not a documented API; it bypasses the
  vendor's client-side integrity signals. **Strengthened on review:** Greenhouse's submit path
  carries a reCAPTCHA token, so replay without the browser trips exactly the integrity signal this
  entry predicted. Recruitee's documented lane is the clean version of the same idea.
- **Model resolution of `UNKNOWN` fields on the unattended path.** Written into rule 6 by Phase 2.4.
- **Human-pacing theatrics** (randomised typing speed, mouse jitter). **CORRECTION (review,
  accepted): revision 1's stated basis for this was factually false.** It claimed typing-speed
  detection claims "come exclusively from competing auto-apply vendors' blogs, with no
  vendor-primary source" — but Greenhouse's own support documentation says its bot detection analyses
  "mouse movements and typing patterns" on the flagship launch board. **The decision stands on
  correct grounds:** jitter theatrics are unlikely to beat v3-class scoring whose dominant inputs are
  IP reputation, Google cookies and event-stream absence, and building on a defeated countermeasure
  is worse than not building. Detection is handled as a **measured per-board incidence** (Phase 4.4),
  not as a nonexistent threat. Left uncorrected, this entry would have been cited in six months as
  evidence that behavioural detection does not exist on the boards we submit to.
- **Email plus-aliasing or any identity variation.** Fragments the candidate across Workday profiles
  and intersects Real Talent's email-domain screening.
- **Minutes-level continuous sweep.** §4.7.

---
