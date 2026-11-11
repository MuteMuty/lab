import { test } from "node:test";
import assert from "node:assert/strict";
import { maintain } from "../bin/maintain.mjs";

const contract = { commands: { maintenance: "sh scripts/maintenance.sh" } };
function runner(maintOut, code = 0) {
  const calls = [];
  return {
    calls,
    fn: (cmd, args) => {
      const line = [cmd, ...args].join(" ");
      calls.push(line);
      if (line.includes("maintenance.sh")) return { code, stdout: maintOut, stderr: code ? "check failed" : "" };
      if (line.includes("ls-files") || line.includes("diff --name-only")) return { code: 0, stdout: "levels/daily/2026-12-02.json\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
  };
}

test("unchanged does nothing", async () => {
  const r = runner("UNCHANGED\n");
  let deployed = false;
  const res = await maintain("afterstep", { contract, dir: "/x", runner: r.fn, deployFn: async () => { deployed = true; return { ok: true }; } });
  assert.deepEqual([res.ok, res.changed, res.committed, deployed], [true, false, false, false]);
});

test("changed commits, pushes and deploys", async () => {
  const r = runner("2026-12-02: #23 medium\nCHANGED\n");
  const res = await maintain("afterstep", { contract, dir: "/x", runner: r.fn, deployFn: async () => ({ ok: true, versionId: "v" }) });
  assert.equal(res.changed, true);
  assert.equal(res.committed, true);
  assert.equal(res.deployed, true);
  assert.ok(r.calls.some((c) => c.startsWith("git commit")));
  assert.ok(r.calls.some((c) => c.startsWith("git push")));
});

test("failing maintenance reports and never commits", async () => {
  const r = runner("", 1);
  const res = await maintain("afterstep", { contract, dir: "/x", runner: r.fn, deployFn: async () => ({ ok: true }) });
  assert.equal(res.ok, false);
  assert.ok(!r.calls.some((c) => c.startsWith("git commit")));
});

test("project without maintenance is a no-op", async () => {
  const res = await maintain("hub", { contract: { commands: {} }, dir: "/x", runner: () => { throw new Error("should not run"); } });
  assert.deepEqual([res.ok, res.changed], [true, false]);
});
