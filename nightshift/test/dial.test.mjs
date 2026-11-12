import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveDial, parseUntil } from "../bin/dial.mjs";

const now = new Date(2026, 10, 11, 2, 0); // Wed 2026-11-11 02:00

test("missing dial defaults to normal", () => {
  const d = resolveDial(undefined, now);
  assert.equal(d.level, "normal");
  assert.equal(d.tasks, 2);
  assert.equal(d.fixRounds, 1);
});

test("low means one task and no fix rounds", () => {
  const d = resolveDial({ level: "low" }, now);
  assert.equal(d.tasks, 1);
  assert.equal(d.fixRounds, 0);
});

test("max fills the window with two lanes", () => {
  const d = resolveDial({ level: "max" }, now);
  assert.equal(d.level, "max");
  assert.equal(d.tasks, "fill");
  assert.equal(d.fixRounds, 2);
  assert.equal(d.parallel, 2);
});

test("every level says how many run at once", () => {
  for (const level of ["off", "low", "normal", "high"]) {
    assert.equal(resolveDial({ level }, now).parallel, 1, level);
  }
});

test("expired until reverts to then", () => {
  const d = resolveDial({ level: "off", until: "2026-11-12", then: "normal" }, new Date(2026, 10, 12, 2));
  assert.equal(d.level, "normal");
  assert.equal(d.expired, true);
});

test("until in the future keeps the level", () => {
  const d = resolveDial({ level: "off", until: "2026-11-12", then: "normal" }, now);
  assert.equal(d.level, "off");
  assert.equal(d.expired, false);
  assert.equal(d.tasks, 0);
});

test("unknown level falls back to normal", () => {
  assert.equal(resolveDial({ level: "turbo" }, now).level, "normal");
});

test("garbage dial falls back to normal", () => {
  assert.equal(resolveDial("garbage", now).level, "normal");
  assert.equal(resolveDial(null, now).level, "normal");
});

test("parseUntil weekday is the next such day", () => {
  assert.equal(parseUntil("monday", now), "2026-11-16");
  assert.equal(parseUntil("Wednesday", now), "2026-11-18");
});

test("parseUntil accepts ISO dates", () => {
  assert.equal(parseUntil("2026-11-20", now), "2026-11-20");
});

test("parseUntil rejects nonsense", () => {
  assert.throws(() => parseUntil("someday", now));
});
