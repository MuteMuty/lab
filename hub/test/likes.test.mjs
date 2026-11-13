import { test } from "node:test";
import assert from "node:assert/strict";
import { d1 } from "./d1.mjs";
import { likeable, allowedOrigin, ipHash, getLikes, addLike, removeLike, cleanupLikes } from "../src/likes.js";
import worker from "../src/worker.js";

const projects = ["afterstep", "inkchime", "juryloop"];
const at = (iso) => new Date(`${iso}T12:00:00Z`);
const ctx = (db, day = "2026-11-13", ip = "203.0.113.7") => ({ db, projects, ip, salt: "pepper", now: at(day) });
const counts = async (db, day = "2026-11-13") => (await getLikes({ db, projects, now: at(day) })).json;
const rows = (db) => db.raw.prepare("select * from likes order by id").all();

test("likeable projects are the hub's cards plus preview-only lab projects, never the hub", () => {
  const hub = [{ name: "afterstep" }, { name: "inkchime" }];
  const lab = [
    { name: "afterstep", public: true },
    { name: "hub", public: true },
    { name: "inkchime", public: true },
    { name: "juryloop", public: false },
    { name: "hub", public: false },
  ];
  assert.deepEqual(likeable(hub, lab), ["afterstep", "inkchime", "juryloop"]);
});

test("every project starts at zero", async () => {
  const r = await getLikes({ db: d1(), projects, now: at("2026-11-13") });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, {
    afterstep: { total: 0, week: 0 },
    inkchime: { total: 0, week: 0 },
    juryloop: { total: 0, week: 0 },
  });
});

test("a like is counted and comes with a random receipt", async () => {
  const db = d1();
  const a = await addLike("afterstep", ctx(db));
  assert.equal(a.status, 200);
  assert.match(a.json.receipt, /^[0-9a-f]{32}$/);
  assert.equal(a.json.total, 1);
  assert.equal(a.json.week, 1);
  const b = await addLike("inkchime", ctx(db));
  assert.notEqual(b.json.receipt, a.json.receipt);
  assert.deepEqual((await counts(db)).afterstep, { total: 1, week: 1 });
  // Only the receipt's hash is stored.
  assert.ok(rows(db).every((r) => r.receipt_hash !== a.json.receipt && r.receipt_hash !== b.json.receipt));
});

test("unknown projects get 404 and store nothing", async () => {
  const db = d1();
  assert.equal((await addLike("nope", ctx(db))).status, 404);
  assert.equal((await addLike("hub", ctx(db))).status, 404);
  assert.equal((await addLike("../x", ctx(db))).status, 404);
  assert.equal((await removeLike("nope", { receipt: "a".repeat(32) }, ctx(db))).status, 404);
  assert.equal(rows(db).length, 0);
});

test("liking twice from the same ip on the same day counts once", async () => {
  const db = d1();
  assert.equal((await addLike("afterstep", ctx(db))).status, 200);
  const again = await addLike("afterstep", ctx(db));
  assert.equal(again.status, 409);
  assert.equal(again.json.receipt, undefined);
  assert.equal(again.json.total, 1);
  // True whether the earlier like was this person's (on another device) or someone else's on the network.
  assert.equal(again.json.error, "This network already liked it today.");
  assert.equal((await counts(db)).afterstep.total, 1);
  // Another project, another ip, or another day is fine.
  assert.equal((await addLike("inkchime", ctx(db))).status, 200);
  assert.equal((await addLike("afterstep", ctx(db, "2026-11-13", "198.51.100.2"))).status, 200);
  assert.equal((await addLike("afterstep", ctx(db, "2026-11-14"))).status, 200);
  assert.equal((await counts(db, "2026-11-14")).afterstep.total, 3);
});

test("a burst of requests is rate-limited with 429", async () => {
  const db = d1();
  const statuses = [];
  for (let i = 0; i < 25; i++) {
    const project = projects[i % 3];
    const r = i % 2 ? await addLike(project, ctx(db)) : await removeLike(project, { receipt: "0".repeat(32) }, ctx(db));
    statuses.push(r.status);
  }
  assert.ok(statuses.includes(429), `no 429 in ${statuses}`);
  assert.ok(statuses.indexOf(429) >= 10, "limit kicks in too early");
  // Someone else isn't affected.
  assert.equal((await addLike("afterstep", ctx(db, "2026-11-13", "198.51.100.2"))).status, 200);
  // A minute later it's fine again.
  const later = { ...ctx(db), now: new Date("2026-11-13T12:01:30Z") };
  assert.notEqual((await addLike("inkchime", later)).status, 429);
});

test("unliking with the receipt works on a later day", async () => {
  const db = d1();
  const { receipt } = (await addLike("afterstep", ctx(db, "2026-11-10"))).json;
  await addLike("afterstep", ctx(db, "2026-11-10", "198.51.100.2"));
  const r = await removeLike("afterstep", { receipt }, ctx(db, "2026-11-13"));
  assert.equal(r.status, 200);
  assert.equal(r.json.total, 1);
  assert.deepEqual((await counts(db)).afterstep, { total: 1, week: 1 });
});

test("a wrong, reused or other project's receipt removes nothing", async () => {
  const db = d1();
  const { receipt } = (await addLike("afterstep", ctx(db))).json;
  await addLike("inkchime", ctx(db));
  assert.equal((await removeLike("afterstep", { receipt: "f".repeat(32) }, ctx(db))).status, 404);
  assert.equal((await removeLike("inkchime", { receipt }, ctx(db))).status, 404);
  assert.equal(rows(db).length, 2);
  assert.equal((await removeLike("afterstep", { receipt }, ctx(db))).status, 200);
  const reused = await removeLike("afterstep", { receipt }, ctx(db));
  assert.equal(reused.status, 404);
  assert.equal(reused.json.total, 0);
  assert.equal(rows(db).length, 1);
  assert.deepEqual(await counts(db), {
    afterstep: { total: 0, week: 0 },
    inkchime: { total: 1, week: 1 },
    juryloop: { total: 0, week: 0 },
  });
});

test("a malformed unlike is rejected", async () => {
  const db = d1();
  assert.equal((await removeLike("afterstep", null, ctx(db))).status, 400);
  assert.equal((await removeLike("afterstep", { receipt: 42 }, ctx(db))).status, 400);
  assert.equal((await removeLike("afterstep", { receipt: "x" }, ctx(db))).status, 400);
});

test("week counts the last seven days, total counts everything", async () => {
  const db = d1();
  await addLike("afterstep", ctx(db, "2026-11-06")); // 7 days before the 13th: outside the week
  await addLike("afterstep", ctx(db, "2026-11-07")); // inside
  await addLike("afterstep", ctx(db, "2026-11-13"));
  assert.deepEqual((await counts(db, "2026-11-13")).afterstep, { total: 3, week: 2 });
});

test("after 30 days only the ip hash is cleared: likes still count and can still be undone", async () => {
  const db = d1();
  const old = (await addLike("afterstep", ctx(db, "2026-10-01"))).json.receipt;
  await addLike("inkchime", ctx(db, "2026-10-01"));
  await addLike("afterstep", ctx(db, "2026-10-20"));
  await cleanupLikes(db, at("2026-11-13"));
  const r = rows(db);
  assert.equal(r.length, 3);
  assert.equal(r[0].ip_hash, null);
  assert.equal(r[1].ip_hash, null);
  assert.match(r[2].ip_hash, /^[0-9a-f]{64}$/); // 24 days old: kept for abuse limits
  assert.ok(r.every((row) => row.receipt_hash && row.day));
  assert.deepEqual((await counts(db)).afterstep, { total: 2, week: 0 });
  assert.equal((await removeLike("afterstep", { receipt: old }, ctx(db))).status, 200);
  assert.deepEqual((await counts(db)).afterstep, { total: 1, week: 0 });
  assert.equal((await counts(db)).inkchime.total, 1);
});

test("the cleanup also forgets old rate-limit hits", async () => {
  const db = d1();
  await addLike("afterstep", ctx(db, "2026-11-12"));
  await cleanupLikes(db, at("2026-11-13"));
  assert.equal(db.raw.prepare("select count(*) as n from like_hits").get().n, 0);
});

test("the same ip gives different hashes on different days, and never the raw ip", async () => {
  const a = await ipHash("pepper", "203.0.113.7", "2026-11-13");
  const b = await ipHash("pepper", "203.0.113.7", "2026-11-14");
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.notEqual(a, b);
  assert.equal(a, await ipHash("pepper", "203.0.113.7", "2026-11-13"));
  assert.notEqual(a, await ipHash("salt", "203.0.113.7", "2026-11-13"));

  const db = d1();
  await addLike("afterstep", ctx(db, "2026-11-13"));
  await addLike("afterstep", ctx(db, "2026-11-14"));
  const [x, y] = rows(db);
  assert.notEqual(x.ip_hash, y.ip_hash);
  const everything = JSON.stringify([rows(db), db.raw.prepare("select * from like_hits").all()]);
  assert.ok(!everything.includes("203.0.113.7"));
});

test("without the likes tables every call answers 503 instead of throwing", async () => {
  const db = d1(["0001_suggestions.sql"]);
  for (const r of [
    await getLikes({ db, projects, now: at("2026-11-13") }),
    await addLike("afterstep", ctx(db)),
    await removeLike("afterstep", { receipt: "a".repeat(32) }, ctx(db)),
  ]) {
    assert.equal(r.status, 503);
    assert.equal(typeof r.json.error, "string");
  }
  await cleanupLikes(db, at("2026-11-13")); // doesn't throw either
});

test("only the lab's own origins are allowed", () => {
  for (const o of [
    "https://lab.brightloopapps.com",
    "https://afterstep.brightloopapps.com",
    "https://juryloop.erko-erka1.workers.dev",
    "https://1a2b3c4d-inkchime.erko-erka1.workers.dev",
  ]) assert.ok(allowedOrigin(o), o);
  for (const o of [
    null, "", "null",
    "http://lab.brightloopapps.com",
    "https://brightloopapps.com.evil.com",
    "https://evilbrightloopapps.com",
    "https://lab.brightloopapps.com:8443",
    "https://x.other.workers.dev",
    "https://erko-erka1.workers.dev.evil.com",
    "https://a.b.erko-erka1.workers.dev",
    "https://example.com",
  ]) assert.ok(!allowedOrigin(o), o);
});

// ── Through the worker: routing, CORS, status codes and headers.
const env = (db = d1()) => ({ DB: db, SUGGEST_SALT: "pepper", ASSETS: { fetch: () => new Response("asset") } });
const waitUntil = { waitUntil() {} };
const call = (e, path, init = {}, origin) => worker.fetch(new Request(`https://lab.brightloopapps.com${path}`, {
  ...init,
  headers: { "CF-Connecting-IP": "203.0.113.7", ...(origin ? { Origin: origin } : {}), ...init.headers },
}), e, waitUntil);

test("worker: like, list and unlike", async () => {
  const e = env();
  const list = await call(e, "/api/likes");
  assert.equal(list.status, 200);
  const all = await list.json();
  assert.ok("afterstep" in all && "inkchime" in all && !("hub" in all));
  const liked = await call(e, "/api/likes/afterstep", { method: "POST" });
  assert.equal(liked.status, 200);
  const { receipt } = await liked.json();
  assert.equal((await (await call(e, "/api/likes")).json()).afterstep.total, 1);
  const unliked = await call(e, "/api/likes/afterstep", { method: "DELETE", body: JSON.stringify({ receipt }), headers: { "content-type": "application/json" } });
  assert.equal(unliked.status, 200);
  assert.equal((await (await call(e, "/api/likes")).json()).afterstep.total, 0);
  for (const r of [list, liked, unliked]) {
    assert.equal(r.headers.get("set-cookie"), null);
    assert.equal(r.headers.get("cache-control"), "no-store");
  }
});

test("worker: unknown projects and paths get 404, wrong methods 405", async () => {
  const e = env();
  assert.equal((await call(e, "/api/likes/nope", { method: "POST" })).status, 404);
  assert.equal((await call(e, "/api/likes/hub", { method: "POST" })).status, 404);
  assert.equal((await call(e, "/api/likes/afterstep/x", { method: "POST" })).status, 404);
  assert.equal((await call(e, "/api/likes/", { method: "POST" })).status, 404);
  assert.equal((await call(e, "/api/likes", { method: "POST" })).status, 405);
  assert.equal((await call(e, "/api/likes/afterstep")).status, 405);
});

test("worker: CORS headers only for the lab's own origins", async () => {
  const e = env();
  const ok = await call(e, "/api/likes", {}, "https://afterstep.brightloopapps.com");
  assert.equal(ok.headers.get("access-control-allow-origin"), "https://afterstep.brightloopapps.com");
  assert.match(ok.headers.get("vary") ?? "", /origin/i);
  const pre = await call(e, "/api/likes/afterstep", { method: "OPTIONS", headers: { "Access-Control-Request-Method": "DELETE" } }, "https://juryloop.erko-erka1.workers.dev");
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get("access-control-allow-origin"), "https://juryloop.erko-erka1.workers.dev");
  assert.match(pre.headers.get("access-control-allow-methods"), /DELETE/);
  for (const origin of ["https://example.com", "https://brightloopapps.com.evil.com"]) {
    for (const r of [
      await call(e, "/api/likes", {}, origin),
      await call(e, "/api/likes/afterstep", { method: "OPTIONS" }, origin),
      await call(e, "/api/likes/inkchime", { method: "POST" }, origin),
    ]) {
      for (const [k] of r.headers) assert.ok(!k.startsWith("access-control-"), `${origin} got ${k}`);
    }
  }
});

test("worker: without the likes tables it answers 503 JSON, and 204 to the lab page's quiet request", async () => {
  const e = env(d1(["0001_suggestions.sql"]));
  const r = await call(e, "/api/likes");
  assert.equal(r.status, 503);
  assert.match(r.headers.get("content-type"), /json/);
  assert.equal(typeof (await r.json()).error, "string");
  assert.equal((await call(e, "/api/likes/afterstep", { method: "POST" })).status, 503);
  const quiet = await call(e, "/api/likes?quiet=1");
  assert.equal(quiet.status, 204);
  assert.equal(await quiet.text(), "");
  // With the tables, the quiet request is the normal list.
  assert.equal((await call(env(), "/api/likes?quiet=1")).status, 200);
});

test("worker: the suggestion box and static files are untouched", async () => {
  const e = env();
  assert.equal(await (await call(e, "/")).text(), "asset");
  assert.equal((await call(e, "/api/suggest")).status, 405);
});
