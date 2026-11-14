import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decide, fetchLikes, likesTrend } from "../bin/preflight.mjs";

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

// Likes (lab#19). Every fetch here is a fake: the tests never reach the network.
const reply = (status, body) => async () => ({ status, ok: status >= 200 && status < 300, json: async () => (typeof body === "string" ? JSON.parse(body) : body) });
const LIVE = { afterstep: { total: 1, week: 1 }, inkchime: { total: 0, week: 0 }, juryloop: { total: 0, week: 0 } };

test("likes come from the like API", async () => {
  let asked;
  const fetch = async (url, init) => { asked = { url, init }; return reply(200, LIVE)(); };
  assert.deepEqual(await fetchLikes({ fetch }), LIVE);
  assert.equal(asked.url, "https://lab.brightloopapps.com/api/likes");
  assert.ok(asked.init.signal instanceof AbortSignal);
});

test("likes are null when the API can't be reached", async () => {
  assert.equal(await fetchLikes({ fetch: async () => { throw new TypeError("fetch failed"); } }), null);
});

test("likes are null on anything but a 200", async () => {
  for (const status of [204, 404, 500, 503]) assert.equal(await fetchLikes({ fetch: reply(status, LIVE) }), null);
});

test("likes are null on bad JSON or the wrong shape", async () => {
  for (const body of ["{not json", "null", "[]", '"likes"', '{"afterstep":{"total":"1","week":1}}', '{"afterstep":{"total":1}}', '{"afterstep":{"total":-1,"week":0}}', '{"error":"resting"}']) {
    assert.equal(await fetchLikes({ fetch: reply(200, body) }), null, body);
  }
});

test("a slow like API times out to null", async () => {
  const fetch = (url, { signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
  assert.equal(await fetchLikes({ fetch, timeoutMs: 20 }), null);
});

const PROJECTS = [
  { name: "afterstep", public: true }, { name: "hub", public: true },
  { name: "inkchime", public: true }, { name: "juryloop", public: false },
];
const L = (a, i, extra = {}) => ({ afterstep: { total: a[0], week: a[1] }, inkchime: { total: i[0], week: i[1] }, ...extra });

test("no likes means no trend", () => {
  assert.equal(likesTrend({ likes: null, history: [], projects: PROJECTS, today: "2026-11-14" }), null);
});

test("the likes line compares totals with the last earlier record", () => {
  const history = [
    { date: "2026-11-12", likes: L([1, 1], [0, 0]) },
    { date: "2026-11-13", likes: { afterstep: { total: 8, week: 8 } } },
    { date: "2026-11-14", likes: L([99, 99], [99, 99]) }, // an earlier run today is not "previous"
  ];
  const t = likesTrend({ likes: L([12, 12], [3, 3]), history, projects: PROJECTS, today: "2026-11-14" });
  assert.equal(t.line, "Likes this week: afterstep 12 (+4), inkchime 3 (new)");
  assert.equal(t.previous, "2026-11-13");
});

test("the likes line shows launched projects only, and no change as +0 or a drop as -n", () => {
  const history = [{ date: "2026-11-13", likes: L([5, 2], [3, 1]) }];
  const t = likesTrend({ likes: L([5, 2], [2, 0], { juryloop: { total: 7, week: 7 } }), history, projects: PROJECTS, today: "2026-11-14" });
  assert.equal(t.line, "Likes this week: afterstep 2 (+0), inkchime 0 (-1)");
});

test("with no history every project is new", () => {
  const t = likesTrend({ likes: L([1, 1], [0, 0]), history: [], projects: PROJECTS, today: "2026-11-14" });
  assert.equal(t.line, "Likes this week: afterstep 1 (new), inkchime 0 (new)");
  assert.equal(t.previous, null);
});

test("the top project is the most-liked launched one this week, none on a tie or no likes", () => {
  const top = (likes) => likesTrend({ likes, history: [], projects: PROJECTS, today: "2026-11-14" }).top;
  assert.equal(top(L([9, 1], [3, 3], { juryloop: { total: 50, week: 50 } })), "inkchime");
  assert.equal(top(L([9, 2], [3, 2])), null);
  assert.equal(top(L([9, 0], [3, 0])), null);
});

test("the 14-day check needs a record from at least 14 days ago", () => {
  const history = [{ date: "2026-11-01", likes: L([0, 0], [0, 0]) }];
  assert.equal(likesTrend({ likes: L([4, 4], [0, 0]), history, projects: PROJECTS, today: "2026-11-14" }).quiet, null);
});

test("a launched project with no new likes in 14 days while others got some is flagged", () => {
  const history = [
    { date: "2026-10-30", likes: L([1, 1], [2, 2]) },
    { date: "2026-10-31", likes: L([3, 0], [2, 0]) },
    { date: "2026-11-02", likes: L([6, 1], [2, 0]) },
  ];
  const t = likesTrend({ likes: L([9, 4], [2, 0]), history, projects: PROJECTS, today: "2026-11-14" });
  assert.deepEqual(t.quiet, { since: "2026-10-31", projects: ["inkchime"] });
});

test("nobody is flagged when nobody got likes, and a project launched since isn't judged", () => {
  const history = [{ date: "2026-10-31", likes: { afterstep: { total: 3, week: 0 } } }];
  const none = likesTrend({ likes: L([3, 0], [0, 0]), history, projects: PROJECTS, today: "2026-11-14" });
  assert.deepEqual(none.quiet, { since: "2026-10-31", projects: [] });
  const some = likesTrend({ likes: L([5, 2], [0, 0]), history, projects: PROJECTS, today: "2026-11-14" });
  assert.deepEqual(some.quiet, { since: "2026-10-31", projects: [] });
});
