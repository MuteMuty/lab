import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchUsage, usageTrend, USAGE_QUERY, type ProjectUsage, type Usage } from "../bin/usage.ts";
import { loadEnvFile } from "../bin/deploy.ts";
import { startLog, usageHistory, likesHistory } from "../bin/log.ts";

const KEY = "phx_SECRET_never_print_me_0123456789";
const ENV = { POSTHOG_PERSONAL_API_KEY: KEY, POSTHOG_PROJECT_ID: "12345" };
const COLUMNS = ["project", "visitors", "started", "finished", "visitors14", "finished14", "first_seen"];
const ROWS = [
  ["afterstep", 140, 100, 61, 250, 110, "2026-10-20T08:00:00Z"],
  ["hub", 300, 0, 0, 500, 0, "2026-10-19T08:00:00Z"],
];

type Call = { url: string; init?: RequestInit };
function server(status: number, body: unknown, calls: Call[] = []) {
  return async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return { status, json: async () => body };
  };
}

test("asks PostHog's private API once, with the key only in the Authorization header", async () => {
  const calls: Call[] = [];
  const usage = await fetchUsage({ fetch: server(200, { columns: COLUMNS, results: ROWS }, calls), env: ENV, apiHost: "https://eu.posthog.com" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "https://eu.posthog.com/api/projects/12345/query/");
  assert.equal((calls[0]!.init!.headers as Record<string, string>).authorization, `Bearer ${KEY}`);
  assert.deepEqual(JSON.parse(String(calls[0]!.init!.body)), { query: { kind: "HogQLQuery", query: USAGE_QUERY } });
  assert.deepEqual(usage!.afterstep, { visitors: 140, started: 100, finished: 61, finishRate: 0.61, visitors14: 250, finished14: 110, firstSeen: "2026-10-20" });
  assert.equal(usage!.hub!.finishRate, null);
  assert.doesNotMatch(JSON.stringify(usage), /phx_|SECRET/);
});

test("no env file, or a file missing either value, means null and no request", async () => {
  const calls: Call[] = [];
  const fetch = server(200, { columns: COLUMNS, results: ROWS }, calls);
  const missing = loadEnvFile(join(mkdtempSync(join(tmpdir(), "ns-usage-")), "posthog.env"));
  assert.equal(await fetchUsage({ fetch, env: missing }), null);
  assert.equal(await fetchUsage({ fetch, env: { POSTHOG_PERSONAL_API_KEY: KEY } }), null);
  assert.equal(await fetchUsage({ fetch, env: { ...ENV, POSTHOG_PROJECT_ID: "../x" } }), null);
  assert.equal(calls.length, 0);
});

test("a failed call is null, whatever went wrong", async () => {
  assert.equal(await fetchUsage({ fetch: async () => { throw new TypeError("fetch failed"); }, env: ENV }), null);
  for (const status of [401, 403, 429, 500]) assert.equal(await fetchUsage({ fetch: server(status, { detail: KEY }), env: ENV }), null);
  for (const body of [null, [], { results: ROWS }, { columns: ["project"], results: [] }, { columns: COLUMNS, results: [["afterstep", -1, 0, 0, 0, 0, "2026-10-20"]] }, { columns: COLUMNS, results: ["x"] }]) {
    assert.equal(await fetchUsage({ fetch: server(200, body), env: ENV }), null, JSON.stringify(body));
  }
  const slow = async (_: string, init?: RequestInit) => new Promise<never>((_, reject) => init!.signal!.addEventListener("abort", () => reject(new Error("aborted"))));
  assert.equal(await fetchUsage({ fetch: slow, env: ENV, timeoutMs: 20 }), null);
});

test("rows whose project isn't a lab name are skipped, not trusted", async () => {
  const usage = await fetchUsage({ fetch: server(200, { columns: COLUMNS, results: [...ROWS, ["<b>x</b>", 1, 1, 1, 1, 1, "2026-10-20"]] }), env: ENV });
  assert.deepEqual(Object.keys(usage!).sort(), ["afterstep", "hub"]);
});

const PROJECTS = [
  { name: "hub", public: true }, { name: "afterstep", public: true }, { name: "inkchime", public: true },
  { name: "dial", public: true }, { name: "juryloop", public: false },
];
const U = (p: Partial<ProjectUsage>): ProjectUsage => ({ visitors: 0, started: 0, finished: 0, finishRate: null, visitors14: 0, finished14: 0, firstSeen: "2026-10-01", ...p });
const rated = (visitors: number, started: number, finished: number, extra: Partial<ProjectUsage> = {}) =>
  U({ visitors, started, finished, finishRate: started ? Math.round((finished / started) * 100) / 100 : null, visitors14: visitors * 2, finished14: finished * 2, ...extra });

test("null usage gives no trend", () => {
  assert.equal(usageTrend({ usage: null, history: [], projects: PROJECTS, today: "2026-11-19" }), null);
});

test("the line: launched projects only, a project with no events shows 0, (+n) is finish-rate points", () => {
  const usage: Usage = { hub: U({ visitors: 300 }), afterstep: rated(140, 100, 61), inkchime: rated(38, 50, 11), juryloop: rated(5, 5, 5) };
  const history = [{ date: "2026-11-18", usage: { afterstep: rated(100, 100, 56) } }, { date: "2026-11-19", usage: { afterstep: rated(1, 1, 1) } }];
  const t = usageTrend({ usage, history, projects: PROJECTS, today: "2026-11-19" })!;
  assert.equal(t.line, "Usage this week: afterstep 140 visitors, 61% finish (+5) · inkchime 38 visitors, 22% finish (new) · dial 0 visitors, no plays");
  assert.equal(t.previous, "2026-11-18");
});

test("stuck: 30+ starts and a finish rate under half the median", () => {
  const usage: Usage = { afterstep: rated(200, 100, 60), inkchime: rated(80, 40, 8), dial: rated(90, 60, 30) };
  // Median of 0.6, 0.2, 0.5 is 0.5; half is 0.25; inkchime's 0.2 is under it.
  const t = usageTrend({ usage, history: [], projects: PROJECTS, today: "2026-11-19" })!;
  assert.deepEqual(t.stuck, ["inkchime"]);
  assert.equal(t.median, 0.5);
  // Under 30 starts it isn't judged.
  const few: Usage = { ...usage, inkchime: rated(80, 29, 1) };
  assert.deepEqual(usageTrend({ usage: few, history: [], projects: PROJECTS, today: "2026-11-19" })!.stuck, []);
});

test("stalled: seen for 14+ days, 20+ visitors in 14 days, at most 5% finishing", () => {
  const usage: Usage = {
    afterstep: rated(20, 30, 0, { visitors14: 40, finished14: 2, firstSeen: "2026-11-05" }),
    inkchime: rated(20, 30, 0, { visitors14: 40, finished14: 0, firstSeen: "2026-11-06" }),
    dial: rated(5, 5, 0, { visitors14: 19, finished14: 0, firstSeen: "2026-10-01" }),
  };
  assert.deepEqual(usageTrend({ usage, history: [], projects: PROJECTS, today: "2026-11-19" })!.stalled, ["afterstep"]);
});

test("the log records usage next to likes, history reads it back, and no key is ever written", () => {
  const d = mkdtempSync(join(tmpdir(), "ns-log-"));
  const usage: Usage = { afterstep: rated(140, 100, 61) };
  startLog("2026-11-18", { dial: "low", mode: "full", likes: { afterstep: { total: 1, week: 1 } }, usage }, d);
  const path = startLog("2026-11-19", { dial: "low", mode: "full", likes: null, usage: null }, d);
  writeFileSync(join(d, "2026-11-17.md"), "---\nstatus: done\n---\n\nusage: {broken\n");
  const text = readFileSync(join(d, "2026-11-18.md"), "utf8");
  assert.match(text, /^likes: \{.*\}$/m);
  assert.match(text, /^usage: \{"afterstep":\{.*\}\}$/m);
  assert.doesNotMatch(readFileSync(path, "utf8"), /^usage:/m);
  assert.deepEqual(usageHistory(d), [{ date: "2026-11-18", usage }]);
  assert.equal(likesHistory(d).length, 1);
  assert.doesNotMatch(text, /phx_/);
});
