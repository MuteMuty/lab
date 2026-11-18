import { test } from "node:test";
import assert from "node:assert/strict";
import { allowed, bucket, cleanEvent, isProduction, options, start, type AllowList, type Client, type Config } from "../web/analytics/guard.ts";
import { PROJECT, EVENTS } from "../web/analytics-events.ts";
import projects from "../projects.json" with { type: "json" };

const ALLOW = {
  $pageview: {},
  project_opened: { project: ["afterstep", "inkchime"] },
  puzzle_solved: { day: [1, 2, 3], moves_bucket: ["1-9", "10+"] },
} satisfies AllowList;

// A stand-in for posthog: records what it was asked to do, sends nothing.
function fakeClient() {
  const calls: { inits: { key: string; opts: Record<string, unknown> }[]; captured: [string, Record<string, unknown>][] } = { inits: [], captured: [] };
  const client: Client = {
    init(key, opts) { calls.inits.push({ key, opts: opts as Record<string, unknown> }); },
    capture(name, props) { calls.captured.push([name, props ?? {}]); },
  };
  return { client, calls };
}
const config = (): Config => ({ project: "afterstep", allow: ALLOW, queue: [] });
const KEY = "phc_test";

test("only lab subdomains in production send", () => {
  for (const h of ["lab.brightloopapps.com", "afterstep.brightloopapps.com"]) assert.equal(isProduction(h), true, h);
  for (const h of ["localhost", "127.0.0.1", "lab-hub.erik.workers.dev", "brightloopapps.com", "brightloopapps.com.evil.example", "xbrightloopapps.com", ""]) {
    assert.equal(isProduction(h), false, h);
  }
});

test("attaches the page's project and keeps only allow-listed properties and values", () => {
  assert.deepEqual(allowed(ALLOW, "afterstep", "$pageview"), { project: "afterstep" });
  assert.deepEqual(allowed(ALLOW, "afterstep", "puzzle_solved", { day: 2, moves_bucket: "10+", text: "hello", $set: { name: "x" } }),
    { project: "afterstep", day: 2, moves_bucket: "10+" });
  // A value off the list is dropped, not passed through or coerced.
  assert.deepEqual(allowed(ALLOW, "afterstep", "puzzle_solved", { day: 4, moves_bucket: "17" }), { project: "afterstep" });
  assert.deepEqual(allowed(ALLOW, "afterstep", "puzzle_solved", { day: "2" }), { project: "afterstep" });
});

test("drops events that aren't on the list, including inherited object keys", () => {
  for (const name of ["$autocapture", "$pageleave", "$exception", "$identify", "level_failed", "toString", "constructor", "__proto__"]) {
    assert.equal(allowed(ALLOW, "afterstep", name, {}), null, name);
  }
});

test("an event that names its own project must name a known one", () => {
  assert.deepEqual(allowed(ALLOW, "hub", "project_opened", { project: "inkchime" }), { project: "inkchime" });
  assert.equal(allowed(ALLOW, "hub", "project_opened", { project: "evil" }), null);
  assert.equal(allowed(ALLOW, "hub", "project_opened", {}), null);
});

test("buckets counts into labels", () => {
  const edges = [1, 5, 10];
  assert.equal(bucket(0, edges), "<1");
  assert.equal(bucket(1, edges), "1-4");
  assert.equal(bucket(4, edges), "1-4");
  assert.equal(bucket(5, edges), "5-9");
  assert.equal(bucket(10, edges), "10+");
  assert.equal(bucket(999, edges), "10+");
});

test("cleans what posthog is about to send: off-list events dropped, URLs trimmed, person properties gone", () => {
  const clean = cleanEvent(ALLOW, "afterstep");
  assert.equal(clean({ uuid: "u", event: "$pageleave", properties: { project: "afterstep" } }), null);
  assert.equal(clean({ uuid: "u", event: "$autocapture", properties: {} }), null);
  assert.equal(clean(null), null);
  const out = clean({
    uuid: "u",
    event: "puzzle_solved",
    properties: {
      token: KEY, distinct_id: "$posthog_cookieless", $lib: "web", $browser: "Chrome",
      $current_url: "https://afterstep.brightloopapps.com/play?seed=abc#level-3",
      $referrer: "https://news.example/item?id=42&user=erik", $referring_domain: "news.example",
      project: "afterstep", day: 3, moves_bucket: "1-9", title: "Afterstep", note: "typed text",
    },
    $set: { email: "x" }, $set_once: { first: "y" },
  });
  assert.deepEqual(out, {
    uuid: "u",
    event: "puzzle_solved",
    properties: {
      token: KEY, distinct_id: "$posthog_cookieless", $lib: "web", $browser: "Chrome",
      $current_url: "https://afterstep.brightloopapps.com/play",
      $referrer: "https://news.example/item", $referring_domain: "news.example",
      project: "afterstep", day: 3, moves_bucket: "1-9",
    },
  });
});

test("posthog runs cookieless in the EU with everything but named events off", () => {
  const o = options(ALLOW, "afterstep") as Record<string, unknown>;
  assert.equal(o.api_host, "https://eu.i.posthog.com");
  assert.equal(o.cookieless_mode, "always");
  assert.equal(o.persistence, "memory");
  assert.equal(o.disable_persistence, true);
  assert.equal(o.respect_dnt, true);
  assert.equal(o.person_profiles, "never");
  for (const off of ["autocapture", "capture_pageview", "capture_pageleave", "capture_heatmaps", "capture_dead_clicks", "capture_exceptions", "capture_performance", "rageclick", "save_campaign_params"]) {
    assert.equal(o[off], false, off);
  }
  for (const on of ["disable_session_recording", "disable_surveys", "disable_product_tours", "disable_conversations", "disable_web_experiments", "disable_external_dependency_loading", "advanced_disable_flags"]) {
    assert.equal(o[on], true, on);
  }
  assert.equal(typeof o.before_send, "function");
});

test("in production it sends a pageview, queued events and later events, all through the allow-list", () => {
  const { client, calls } = fakeClient();
  const c = config();
  c.queue.push(["puzzle_solved", { day: 1, moves_bucket: "10+", name: "Erik" }], ["level_failed", {}]);
  assert.equal(start({ key: KEY, hostname: "afterstep.brightloopapps.com", config: c, client }), true);
  assert.equal(calls.inits.length, 1);
  assert.equal(calls.inits[0]!.key, KEY);
  c.queue.push(["project_opened", { project: "inkchime" }], ["$autocapture", {}]);
  assert.deepEqual(calls.captured, [
    ["$pageview", { project: "afterstep" }],
    ["puzzle_solved", { project: "afterstep", day: 1, moves_bucket: "10+" }],
    ["project_opened", { project: "inkchime" }],
  ]);
});

test("sends nothing without a key, off production, or without a page config", () => {
  for (const [key, hostname] of [["", "lab.brightloopapps.com"], [KEY, "localhost"], [KEY, "lab-hub.erik.workers.dev"]]) {
    const { client, calls } = fakeClient();
    const c = config();
    c.queue.push(["$pageview", {}]);
    assert.equal(start({ key: key!, hostname: hostname!, config: c, client }), false);
    c.queue.push(["$pageview", {}]);
    assert.deepEqual(calls, { inits: [], captured: [] }, `${key || "no key"} on ${hostname}`);
    assert.equal(Array.from(c.queue as unknown as unknown[]).length, 0, "the queue doesn't grow");
  }
  const { client, calls } = fakeClient();
  assert.equal(start({ key: KEY, hostname: "lab.brightloopapps.com", config: undefined, client }), false);
  assert.deepEqual(calls, { inits: [], captured: [] });
});

test("a client that throws breaks nothing", () => {
  const client: Client = { init() { throw new Error("blocked"); }, capture() { throw new Error("blocked"); } };
  assert.equal(start({ key: KEY, hostname: "lab.brightloopapps.com", config: config(), client }), false);
});

test("the hub may send only $pageview and project_opened for a known project", () => {
  assert.equal(PROJECT, "hub");
  assert.deepEqual(Object.keys(EVENTS).sort(), ["$pageview", "project_opened"]);
  assert.deepEqual(EVENTS.$pageview, {});
  assert.deepEqual(EVENTS.project_opened, { project: projects.map((p) => p.name) });
  assert.deepEqual(allowed(EVENTS, PROJECT, "$pageview", { title: "BrightLoop Lab" }), { project: "hub" });
  assert.deepEqual(allowed(EVENTS, PROJECT, "project_opened", { project: "afterstep" }), { project: "afterstep" });
  assert.equal(allowed(EVENTS, PROJECT, "project_opened", { project: "hub" }), null);
});
