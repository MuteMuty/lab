#!/usr/bin/env node
// Smoke test: every path in a project's lab.json "smoke" list must return 200.
// CLI: smoke.mjs <project> [baseUrl]
import { pathToFileURL } from "node:url";
import { findProject, loadContract } from "./lib.mjs";

export async function smoke(projectName, base, { fetchFn = fetch } = {}) {
  const contract = loadContract(findProject(projectName));
  if (!contract) return { ok: false, results: [], error: "no lab.json" };
  const root = (base ?? contract.url).replace(/\/$/, "");
  const results = [];
  for (const path of contract.smoke ?? ["/"]) {
    let status = 0;
    try {
      const r = await fetchFn(root + path, { redirect: "follow", signal: AbortSignal.timeout(15000) });
      status = r.status;
    } catch {
      status = 0;
    }
    results.push({ path, status });
  }
  return { ok: results.every((r) => r.status === 200), results };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const r = await smoke(process.argv[2], process.argv[3]);
  console.log(JSON.stringify(r));
  process.exitCode = r.ok ? 0 : 1;
}
