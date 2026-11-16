#!/usr/bin/env node
// Smoke test: every path in a project's lab.json "smoke" list must return 200.
// If this Mac can't resolve the host (e.g. a cached "no such host" right after a
// new subdomain goes live), it asks Cloudflare's DNS-over-HTTPS resolver for the
// address and retries with curl --resolve, so a real outage isn't confused with
// a stale local cache. HTTP errors (4xx/5xx) are never retried this way.
// CLI: smoke.ts <project> [baseUrl]
import { pathToFileURL } from "node:url";
import { run, findProject, loadContract, type RunResult } from "./lib.ts";

export type SmokeResult = { path: string; status: number; via: "local" | "doh" };
export type SmokeReport = { ok: boolean; results: SmokeResult[]; error?: string };
export type SmokeOptions = {
  fetchFn?: (url: string, init?: RequestInit) => Promise<Pick<Response, "status" | "json">>;
  curl?: (args: string[]) => RunResult;
};

async function dohLookup(host: string, fetchFn: NonNullable<SmokeOptions["fetchFn"]>): Promise<string | null> {
  try {
    const r = await fetchFn(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=A`, {
      headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(10000),
    });
    const d = (await r.json()) as { Answer?: { type: number; data: string }[] };
    return (d.Answer ?? []).find((a) => a.type === 1)?.data ?? null;
  } catch {
    return null;
  }
}

export async function smokeUrls(
  root: string, paths: string[], { fetchFn = fetch, curl = (args) => run("curl", args) }: SmokeOptions = {},
): Promise<SmokeReport> {
  const base = root.replace(/\/$/, "");
  const host = new URL(base).hostname;
  let ip: string | undefined;
  const results: SmokeResult[] = [];
  for (const path of paths) {
    let status = 0, via: SmokeResult["via"] = "local";
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

export async function smoke(projectName: string, base?: string, opts?: SmokeOptions): Promise<SmokeReport> {
  const contract = loadContract(findProject(projectName));
  if (!contract) return { ok: false, results: [], error: "no lab.json" };
  return smokeUrls(base ?? contract.url, contract.smoke ?? ["/"], opts);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const r = await smoke(process.argv[2], process.argv[3]);
  console.log(JSON.stringify(r));
  process.exitCode = r.ok ? 0 : 1;
}
