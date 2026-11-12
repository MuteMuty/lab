import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decide } from "../bin/preflight.mjs";

const at = (h, m = 0) => new Date(2026, 10, 12, h, m);
const base = { dialRaw: undefined, stopExists: false, dryRun: false, recover: null };

test("stop file stops", () => {
  const r = decide({ ...base, now: at(2), stopExists: true });
  assert.equal(r.mode, "stop");
  assert.equal(r.go, false);
});

test("late start is maintenance-only", () => {
  assert.equal(decide({ ...base, now: at(8, 10) }).mode, "maintenance");
});

test("too early is maintenance-only", () => {
  assert.equal(decide({ ...base, now: at(1, 0) }).mode, "maintenance");
});

test("normal start is a full night", () => {
  const r = decide({ ...base, now: at(2) });
  assert.equal(r.mode, "full");
  assert.equal(r.go, true);
  assert.equal(r.dial.tasks, 2);
  assert.equal(r.date, "2026-11-12");
});

test("dial max is a full night that fills the window", () => {
  const r = decide({ ...base, now: at(2), dialRaw: { level: "max" } });
  assert.equal(r.mode, "full");
  assert.equal(r.dial.tasks, "fill");
  assert.equal(r.dial.parallel, 2);
});

test("dial off is maintenance-only", () => {
  assert.equal(decide({ ...base, now: at(2), dialRaw: { level: "off" } }).mode, "maintenance");
});

test("dry run wins over the window", () => {
  assert.equal(decide({ ...base, now: at(14), dryRun: true }).mode, "dry-run");
});

test("recover info is passed through", () => {
  const recover = { date: "2026-11-11", openSteps: [{ id: "deploy", detail: "afterstep" }] };
  assert.deepEqual(decide({ ...base, now: at(2), recover }).recover, recover);
});

test("force runs a full night outside the window (supervised runs)", () => {
  const r = decide({ ...base, now: at(15, 40), force: true });
  assert.equal(r.mode, "full");
});

test("force never overrides STOP or dial off", () => {
  assert.equal(decide({ ...base, now: at(15), force: true, stopExists: true }).mode, "stop");
  assert.equal(decide({ ...base, now: at(15), force: true, dialRaw: { level: "off" } }).mode, "maintenance");
});

const day = (o = {}) => ({ date: "2026-11-12", noNewWorkAfter: "17:15", hardStop: "18:00", ...o });

test("night runs get the night window", () => {
  const r = decide({ ...base, now: at(2) });
  assert.deepEqual(r.window, { kind: "night", noNewWorkAfter: "05:15", hardStop: "06:00" });
});

test("a day shift is a full run outside the night window", () => {
  const r = decide({ ...base, now: at(13, 30), dayShiftRaw: day() });
  assert.equal(r.mode, "full");
  assert.deepEqual(r.window, { kind: "day", noNewWorkAfter: "17:15", hardStop: "18:00" });
});

test("a day-shift rehearsal is a dry run", () => {
  const r = decide({ ...base, now: at(13, 30), dayShiftRaw: day({ dryRun: true }) });
  assert.equal(r.mode, "dry-run");
  assert.equal(r.window.kind, "day");
});

test("a stale or finished day shift is ignored", () => {
  assert.equal(decide({ ...base, now: at(13), dayShiftRaw: day({ date: "2026-11-11" }) }).mode, "maintenance");
  assert.equal(decide({ ...base, now: at(18, 0), dayShiftRaw: day() }).mode, "maintenance");
  const night = decide({ ...base, now: at(2), dayShiftRaw: day({ date: "2026-11-11" }) });
  assert.equal(night.window.kind, "night");
});

test("a malformed day shift is ignored", () => {
  for (const bad of [day({ hardStop: "25:00" }), day({ noNewWorkAfter: "19:00" }), "garbage", null]) {
    assert.equal(decide({ ...base, now: at(13), dayShiftRaw: bad }).mode, "maintenance");
  }
});

test("STOP still wins over a day shift", () => {
  assert.equal(decide({ ...base, now: at(13), stopExists: true, dayShiftRaw: day() }).mode, "stop");
});

test("dial off makes a day shift maintenance-only", () => {
  assert.equal(decide({ ...base, now: at(13), dialRaw: { level: "off" }, dayShiftRaw: day() }).mode, "maintenance");
});

const blocked3 = { date: "2026-11-12", startedAt: "06:30", noNewWorkAfter: "22:15", hardStop: "23:00", blocks: [
  { start: "06:30", noNewWorkAfter: "10:45", hardStop: "11:30" },
  { start: "11:35", noNewWorkAfter: "15:50", hardStop: "16:35" },
  { start: "16:40", noNewWorkAfter: "22:15", hardStop: "23:00" },
] };

test("a planned day shift doesn't touch the night run on the same date", () => {
  const r = decide({ ...base, now: at(2), dayShiftRaw: blocked3 });
  assert.equal(r.window.kind, "night");
  assert.equal(r.mode, "full");
});

test("each block run gets its own block's window", () => {
  assert.deepEqual(decide({ ...base, now: at(6, 31), dayShiftRaw: blocked3 }).window, { kind: "day", noNewWorkAfter: "10:45", hardStop: "11:30" });
  assert.deepEqual(decide({ ...base, now: at(11, 36), dayShiftRaw: blocked3 }).window, { kind: "day", noNewWorkAfter: "15:50", hardStop: "16:35" });
  assert.equal(decide({ ...base, now: at(16, 40), dayShiftRaw: blocked3 }).window.hardStop, "23:00");
});

test("between blocks it is not a day shift", () => {
  assert.equal(decide({ ...base, now: at(11, 32), dayShiftRaw: blocked3 }).mode, "maintenance");
});
