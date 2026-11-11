import { test } from "node:test";
import assert from "node:assert/strict";
import { smokeUrls } from "../bin/smoke.mjs";

test("a local DNS failure falls back to Cloudflare's resolver", async () => {
  const fetchFn = async (url) => {
    if (String(url).startsWith("https://cloudflare-dns.com/")) return { status: 200, json: async () => ({ Answer: [{ type: 1, data: "104.21.43.119" }] }) };
    throw new TypeError("fetch failed: getaddrinfo ENOTFOUND");
  };
  const curl = (args) => ({ code: 0, stdout: args.includes("--resolve") ? "200" : "000", stderr: "" });
  const r = await smokeUrls("https://lab.example.com", ["/", "/data/projects.json"], { fetchFn, curl });
  assert.equal(r.ok, true);
  assert.deepEqual(r.results.map((x) => x.status), [200, 200]);
  assert.ok(r.results.every((x) => x.via === "doh"));
});

test("a real 500 is not papered over", async () => {
  const fetchFn = async () => ({ status: 500 });
  const r = await smokeUrls("https://lab.example.com", ["/"], { fetchFn, curl: () => { throw new Error("no fallback for http errors"); } });
  assert.equal(r.ok, false);
  assert.equal(r.results[0].status, 500);
});

test("unresolvable everywhere stays a failure", async () => {
  const fetchFn = async (url) => {
    if (String(url).startsWith("https://cloudflare-dns.com/")) return { status: 200, json: async () => ({ Status: 3 }) };
    throw new TypeError("fetch failed");
  };
  const r = await smokeUrls("https://nope.example.com", ["/"], { fetchFn, curl: () => ({ code: 0, stdout: "000" }) });
  assert.equal(r.ok, false);
  assert.equal(r.results[0].status, 0);
});
