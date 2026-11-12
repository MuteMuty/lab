import { test } from "node:test";
import assert from "node:assert/strict";
import { planWindow } from "../bin/dayshift.mjs";

const at = (h, m = 0) => new Date(2026, 10, 12, h, m);

test("default runs until 23:00 with a 45-minute wrap-up", () => {
  assert.deepEqual(planWindow({ now: at(9, 5) }), { date: "2026-11-12", startedAt: "09:05", noNewWorkAfter: "22:15", hardStop: "23:00" });
});

test("--until sets the hard stop", () => {
  const w = planWindow({ now: at(13), until: "18:00" });
  assert.equal(w.hardStop, "18:00");
  assert.equal(w.noNewWorkAfter, "17:15");
});

test("--hours counts from now", () => {
  assert.equal(planWindow({ now: at(13, 20), hours: "5" }).hardStop, "18:20");
});

test("never runs past 23:30, so the night window stays free", () => {
  assert.equal(planWindow({ now: at(20), hours: "8" }).hardStop, "23:30");
});

test("refuses the night's hours and windows too short to finish a task", () => {
  assert.throws(() => planWindow({ now: at(5, 30) }), /too early/);
  assert.throws(() => planWindow({ now: at(22, 30) }), /at least 90/);
  assert.throws(() => planWindow({ now: at(13), until: "14:00" }), /at least 90/);
});

test("rejects unreadable options", () => {
  assert.throws(() => planWindow({ now: at(13), until: "6pm" }), /HH:MM/);
  assert.throws(() => planWindow({ now: at(13), hours: "lots" }), /--hours/);
});
