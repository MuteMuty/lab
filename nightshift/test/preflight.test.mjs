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
