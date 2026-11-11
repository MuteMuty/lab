import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startLog, stepBegin, stepEnd, finishLog, findUnfinished } from "../bin/log.mjs";

function dir() {
  const d = mkdtempSync(join(tmpdir(), "ns-log-"));
  return d;
}

test("unfinished log is detected", () => {
  const d = dir();
  writeFileSync(join(d, "2026-11-11.md"), "---\nstatus: running\ndial: normal\nmode: full\n---\n\n- [x] preflight: ok\n- [ ] deploy: afterstep\n");
  assert.deepEqual(findUnfinished(d), { date: "2026-11-11", openSteps: [{ id: "deploy", detail: "afterstep" }] });
});

test("log round trip marks steps and finishes", () => {
  const d = dir();
  const path = startLog("2026-11-12", { dial: "low", mode: "full" }, d);
  stepBegin("2026-11-12", "maintain", "afterstep", d);
  assert.deepEqual(findUnfinished(d).openSteps, [{ id: "maintain", detail: "afterstep" }]);
  stepEnd("2026-11-12", "maintain", "ok", "levels through 2026-12-03", d);
  let text = readFileSync(path, "utf8");
  assert.match(text, /^- \[x\] maintain: levels through 2026-12-03$/m);
  assert.match(text, /^status: running$/m);
  stepBegin("2026-11-12", "build", "afterstep#5", d);
  stepEnd("2026-11-12", "build", "failed", "tests red", d);
  assert.match(readFileSync(path, "utf8"), /^- \[!\] build: tests red$/m);
  finishLog("2026-11-12", "done", d);
  assert.match(readFileSync(path, "utf8"), /^status: done$/m);
  assert.equal(findUnfinished(d), null);
});

test("no logs means nothing unfinished", () => {
  assert.equal(findUnfinished(dir()), null);
  assert.equal(findUnfinished(join(dir(), "missing")), null);
});
