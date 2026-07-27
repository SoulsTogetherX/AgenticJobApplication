import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dueFollowUps, MAX_FOLLOW_UPS } from "../scripts/follow-ups.mjs";
import { applyUpdate, STATUSES } from "../scripts/update-application.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NOW = new Date("2026-07-27T12:00:00Z");

const app = (over = {}) => ({
  slug: "acme-dev",
  company: "Acme",
  title: "Backend Developer",
  applied_at: "2026-07-10",
  ...over,
});

// ---------- dueFollowUps ----------

test("an application with no response is due after the threshold", () => {
  const due = dueFollowUps([app()], NOW, 10);
  assert.equal(due.length, 1);
  assert.equal(due[0].next_step, "first follow-up");
  assert.equal(due[0].days_since_last_touch, 17);
});

test("not due before the threshold", () => {
  assert.equal(
    dueFollowUps([app({ applied_at: "2026-07-20" })], NOW, 10).length,
    0,
  );
});

test("a recent follow-up resets the clock; an old one makes the second due", () => {
  const recent = app({ follow_ups: ["2026-07-25"], status: "followed_up" });
  assert.equal(dueFollowUps([recent], NOW, 10).length, 0);

  const old = app({ follow_ups: ["2026-07-12"], status: "followed_up" });
  const due = dueFollowUps([old], NOW, 10);
  assert.equal(due.length, 1);
  assert.equal(due[0].next_step, "second (final) follow-up");
});

test("capped after MAX_FOLLOW_UPS; responded applications never appear", () => {
  const capped = app({
    follow_ups: ["2026-06-01", "2026-06-15"],
    status: "followed_up",
  });
  assert.equal(capped.follow_ups.length, MAX_FOLLOW_UPS);
  assert.equal(dueFollowUps([capped], NOW, 10).length, 0);

  for (const status of ["interviewing", "offer", "rejected", "withdrawn"]) {
    assert.equal(
      dueFollowUps([app({ status })], NOW, 10).length,
      0,
      `expected exclusion for ${status}`,
    );
  }
});

test("unparseable applied_at is skipped, not guessed", () => {
  assert.equal(
    dueFollowUps([app({ applied_at: "sometime" })], NOW, 10).length,
    0,
  );
  assert.equal(dueFollowUps([app({ applied_at: null })], NOW, 10).length, 0);
});

test("most-overdue first", () => {
  const due = dueFollowUps(
    [
      app({ slug: "b", applied_at: "2026-07-14" }),
      app({ slug: "a", applied_at: "2026-07-01" }),
    ],
    NOW,
    10,
  );
  assert.deepEqual(
    due.map((d) => d.slug),
    ["a", "b"],
  );
});

// ---------- applyUpdate ----------

test("applyUpdate records status changes and validates them", () => {
  const apps = [app()];
  const { entry } = applyUpdate(apps, "acme-dev", { status: "interviewing" });
  assert.equal(entry.status, "interviewing");

  assert.throws(
    () => applyUpdate(apps, "acme-dev", { status: "ghosted" }),
    /unknown status/,
  );
  assert.throws(
    () => applyUpdate(apps, "nobody", { status: "rejected" }),
    /no logged application/,
  );
  assert.throws(() => applyUpdate(apps, "acme-dev", {}), /nothing to do/);
  assert.ok(STATUSES.includes("rejected"));
});

test("applyUpdate matches by company name too", () => {
  const { entry } = applyUpdate([app()], "ACME", { status: "rejected" });
  assert.equal(entry.status, "rejected");
});

test("follow-ups append, bump applied -> followed_up, and refuse duplicates", () => {
  const apps = [app()];
  const { entry } = applyUpdate(apps, "acme-dev", {
    followedUpOn: "2026-07-27",
  });
  assert.deepEqual(entry.follow_ups, ["2026-07-27"]);
  assert.equal(entry.status, "followed_up");

  assert.throws(
    () => applyUpdate(apps, "acme-dev", { followedUpOn: "2026-07-27" }),
    /already recorded/,
  );
  assert.throws(
    () => applyUpdate(apps, "acme-dev", { followedUpOn: "yesterday" }),
    /invalid follow-up date/,
  );
});

test("a follow-up never downgrades a responded status", () => {
  const apps = [app({ status: "interviewing" })];
  const { entry } = applyUpdate(apps, "acme-dev", {
    followedUpOn: "2026-07-27",
  });
  assert.equal(entry.status, "interviewing");
});

// ---------- CLI round-trip ----------

test("update-application and follow-ups CLIs round-trip a real yaml store", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "followups-"));
  const file = path.join(dir, "applications.yaml");
  try {
    fs.writeFileSync(
      file,
      "applications:\n  - slug: acme-dev\n    company: Acme\n    title: Backend Developer\n    applied_at: 2026-07-01\n",
    );
    const run = (script, argsArr) =>
      spawnSync(
        process.execPath,
        [path.join(ROOT, "scripts", script), ...argsArr],
        {
          cwd: ROOT,
          encoding: "utf8",
        },
      );

    const due = run("follow-ups.mjs", ["--file", file, "--json"]);
    assert.equal(due.status, 0);
    assert.equal(JSON.parse(due.stdout).due.length, 1);

    const upd = run("update-application.mjs", [
      "acme-dev",
      "--followed-up",
      "--date",
      "2026-07-20",
      "--file",
      file,
    ]);
    assert.equal(upd.status, 0, upd.stderr);
    assert.match(fs.readFileSync(file, "utf8"), /follow_ups:/);

    const rej = run("update-application.mjs", [
      "Acme",
      "--status",
      "rejected",
      "--file",
      file,
    ]);
    assert.equal(rej.status, 0, rej.stderr);

    const after = run("follow-ups.mjs", ["--file", file, "--json"]);
    assert.equal(
      JSON.parse(after.stdout).due.length,
      0,
      "rejected must drop off the list",
    );

    const bad = run("update-application.mjs", [
      "nobody",
      "--status",
      "rejected",
      "--file",
      file,
    ]);
    assert.equal(bad.status, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
