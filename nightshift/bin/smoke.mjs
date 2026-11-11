#!/usr/bin/env node
// Smoke test: every path in a project's lab.json "smoke" list must return 200.
// If this Mac can't resolve the host (e.g. a cached "no such host" right after a
// new subdomain goes live), it asks Cloudflare's DNS-over-HTTPS resolver for the
// address and retries with curl --resolve, so a real outage isn't confused with
// a stale local cache. HTTP errors (4xx/5xx) are never retried this way.
// CLI: smoke.mjs <project> [baseUrl]
import { pathToFileURL } from "node:url";
import { run, findProject, loadContract } from "./lib.mjs";

async function dohLookup(host, fetchFn) {
  try {
    const r = await fetchFn(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=A`, {
      headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(10000),
    });
    const d = await r.json();
    return (d.Answer ?? []).find((a) => a.type === 1)?.data ?? null;
  } catch {
    return null;
  }
}

export async function smokeUrls(root, paths, { fetchFn = fetch, curl = (args) => run("curl", args) } = {}) {
  const base = root.replace(/\/$/, "");
  const host = new URL(base).hostname;
  let ip;
  const results = [];
  for (const path of paths) {
    let status = 0, via = "local";
    try {
      status = (await fetchFn(base + path, { redirect: "follow", signal: AbortSignal.timeout(15000) })).status;
    } catch {
      status = 0;
    }
    if (status === 0) {
      ip ??= (await dohLookup(host, fetchFn)) ?? "";
      if (ip) {
        const r = curl(["-s", "-o", "/dev/null", "-w", "%{http_code}", "-L", "--max-time", "15", "--resolve", `${host}:443:${ip}`, base + path]);
        const code = Number(r.stdout.trim());
        if (code) { status = code; via = "doh"; }
      }
    }
    results.push({ path, status, via });
  }
  return { ok: results.every((r) => r.status === 200), results };
}

export async function smoke(projectName, base, opts) {
  const contract = loadContract(findProject(projectName));
  if (!contract) return { ok: false, results: [], error: "no lab.json" };
  return smokeUrls(base ?? contract.url, contract.smoke ?? ["/"], opts);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const r = await smoke(process.argv[2], process.argv[3]);
  console.log(JSON.stringify(r));
  process.exitCode = r.ok ? 0 : 1;
}
