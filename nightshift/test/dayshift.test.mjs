import { test } from "node:test";
import assert from "node:assert/strict";
import { planWindow, stillAhead } from "../bin/dayshift.mjs";

const at = (h, m = 0) => new Date(2026, 10, 12, h, m);

test("default runs until 23:00 with a 45-minute wrap-up", () => {
  const w = planWindow({ now: at(9, 5), blockHours: 5 });
  assert.equal(w.date, "2026-11-12");
  assert.equal(w.startedAt, "09:05");
  assert.equal(w.hardStop, "23:00");
  assert.equal(w.noNewWorkAfter, "22:15");
});

test("a long shift is split into 5-hour blocks with a gap, and a short tail joins the last block", () => {
  const w = planWindow({ now: at(9, 5), blockHours: 5 });
  assert.deepEqual(w.blocks, [
    { start: "09:05", noNewWorkAfter: "13:20", hardStop: "14:05" },
    { start: "14:10", noNewWorkAfter: "18:25", hardStop: "19:10" },
    { start: "19:15", noNewWorkAfter: "22:15", hardStop: "23:00" },
  ]);
});

test("--tomorrow plans the whole next day from 06:30", () => {
  const w = planWindow({ now: at(23, 10), tomorrow: true, blockHours: 5 });
  assert.equal(w.date, "2026-11-13");
  assert.equal(w.startedAt, "06:30");
  assert.equal(w.hardStop, "23:00");
  assert.deepEqual(w.blocks.map((b) => b.start), ["06:30", "11:35", "16:40"]);
  assert.equal(w.blocks.at(-1).hardStop, "23:00"); // 21:45–23:00 would be too short alone
});

test("--from plans later today, never earlier than now or 06:30", () => {
  assert.equal(planWindow({ now: at(9), from: "13:00", blockHours: 5 }).startedAt, "13:00");
  assert.equal(planWindow({ now: at(9), from: "08:00", blockHours: 5 }).startedAt, "09:00");
  assert.equal(planWindow({ now: at(23), tomorrow: true, from: "05:00", blockHours: 5 }).startedAt, "06:30");
});

test("short shifts stay in one block", () => {
  assert.equal(planWindow({ now: at(13), until: "18:00", blockHours: 5 }).blocks.length, 1);
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
  assert.throws(() => planWindow({ now: at(13), from: "1pm" }), /--from/);
});

test("a planned or running shift counts as still ahead; a finished one doesn't", () => {
  assert.equal(stillAhead({ date: "2026-11-13", hardStop: "23:00" }, at(23)), true);
  assert.equal(stillAhead({ date: "2026-11-12", hardStop: "23:00" }, at(22)), true);
  assert.equal(stillAhead({ date: "2026-11-12", hardStop: "23:00" }, at(23, 5)), false);
  assert.equal(stillAhead(undefined, at(12)), false);
});
