import { test } from "node:test";
import assert from "node:assert/strict";
import { deploy } from "../bin/deploy.mjs";

const PREV = "11111111-1111-1111-1111-111111111111";
const NEXT = "22222222-2222-2222-2222-222222222222";

function fakeRunner({ buildFails = false } = {}) {
  const calls = [];
  const runner = (cmd, args, opts) => {
    const line = [cmd, ...args].join(" ");
    calls.push(line);
    if (line.includes("deployments list")) {
      return { code: 0, stdout: JSON.stringify([
        { created_on: "2026-11-10T10:00:00Z", versions: [{ version_id: "00000000-0000-0000-0000-000000000000" }] },
        { created_on: "2026-11-11T09:00:00Z", versions: [{ version_id: PREV }] },
      ]), stderr: "" };
    }
    if (line.includes("npm run build")) return { code: buildFails ? 1 : 0, stdout: "", stderr: buildFails ? "boom" : "" };
    if (line.includes("wrangler deploy")) return { code: 0, stdout: `Uploaded afterstep\nCurrent Version ID: ${NEXT}\n`, stderr: "" };
    if (line.includes("wrangler rollback")) return { code: 0, stdout: "rolled back", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  return { runner, calls };
}
const env = { CLOUDFLARE_API_TOKEN: "t", CLOUDFLARE_ACCOUNT_ID: "a" };
const contract = { url: "https://x", commands: { build: "npm run build", deploy: "npx wrangler deploy" }, smoke: ["/"] };
const base = { contract, dir: "/lab/afterstep", env, sleep: async () => {} };

test("happy path deploys and parses the version", async () => {
  const { runner, calls } = fakeRunner();
  const r = await deploy("afterstep", { ...base, runner, smokeFn: async () => ({ ok: true, results: [] }) });
  assert.equal(r.ok, true);
  assert.equal(r.versionId, NEXT);
  assert.equal(r.previousVersionId, PREV);
  assert.equal(r.rolledBack, false);
  assert.ok(!calls.some((c) => c.includes("rollback")));
});

test("failing smoke test rolls back to the previous version", async () => {
  const { runner, calls } = fakeRunner();
  let smokes = 0;
  // healthy before the deploy, broken after it
  const r = await deploy("afterstep", { ...base, runner, smokeFn: async () => { smokes++; return smokes === 1 ? { ok: true, results: [] } : { ok: false, results: [{ path: "/", status: 500 }] }; } });
  assert.equal(r.ok, false);
  assert.equal(r.rolledBack, true);
  assert.equal(smokes, 7);
  assert.ok(calls.some((c) => c.includes(`wrangler rollback ${PREV}`)));
});

test("build failure never deploys", async () => {
  const { runner, calls } = fakeRunner({ buildFails: true });
  const r = await deploy("afterstep", { ...base, runner, smokeFn: async () => ({ ok: true }) });
  assert.equal(r.ok, false);
  assert.equal(r.step, "build");
  assert.ok(!calls.some((c) => /wrangler deploy($|\s)/.test(c)));
});

test("dry run builds but never deploys", async () => {
  const { runner, calls } = fakeRunner();
  const r = await deploy("afterstep", { ...base, runner, dryRun: true, smokeFn: async () => ({ ok: true }) });
  assert.equal(r.ok, true);
  assert.equal(r.dryRun, true);
  assert.ok(calls.some((c) => c.includes("npm run build")));
  assert.ok(!calls.some((c) => /wrangler deploy($|\s)/.test(c)));
});

test("missing scoped token refuses to deploy", async () => {
  const { runner, calls } = fakeRunner();
  const r = await deploy("afterstep", { ...base, env: {}, runner, smokeFn: async () => ({ ok: true }) });
  assert.equal(r.ok, false);
  assert.match(r.error, /token/);
  assert.equal(calls.length, 0);
});

test("no rollback when the site was already down before the deploy", async () => {
  const { runner, calls } = fakeRunner();
  const r = await deploy("afterstep", { ...base, runner, smokeFn: async () => ({ ok: false, results: [{ path: "/", status: 0 }] }) });
  assert.equal(r.ok, false);
  assert.equal(r.rolledBack, false);
  assert.equal(r.wasHealthy, false);
  assert.ok(!calls.some((c) => c.includes("wrangler rollback")));
});
