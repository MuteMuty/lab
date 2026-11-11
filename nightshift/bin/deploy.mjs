#!/usr/bin/env node
// Deploy a lab project with the scoped Cloudflare key, smoke-test it live,
// and roll back automatically if the smoke test fails.
// CLI: deploy.mjs <project> [--dry-run]   prints JSON, exit 1 unless ok
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { LAB, run, findProject, loadContract, projectDir } from "./lib.mjs";
import { smoke } from "./smoke.mjs";

export const ENV_FILE = join(LAB, ".secrets", "cloudflare.env");
const SMOKE_TRIES = 6;
const SMOKE_WAIT_MS = 10_000;

export function loadEnvFile(path = ENV_FILE) {
  const env = {};
  try {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*"?([^"\n]*)"?\s*$/);
      if (m) env[m[1]] = m[2];
    }
  } catch {}
  return env;
}

function latestVersion(stdout) {
  try {
    const list = JSON.parse(stdout);
    const sorted = [...list].sort((a, b) => String(b.created_on).localeCompare(String(a.created_on)));
    return sorted[0]?.versions?.[0]?.version_id ?? null;
  } catch {
    return null;
  }
}

export async function deploy(projectName, opts = {}) {
  const p = opts.contract ? null : findProject(projectName);
  const contract = opts.contract ?? loadContract(p);
  const dir = opts.dir ?? projectDir(p);
  const env = opts.env ?? loadEnvFile();
  const runner = opts.runner ?? run;
  const smokeFn = opts.smokeFn ?? ((name) => smoke(name));
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const result = { project: projectName, ok: false, wasHealthy: null, versionId: null, previousVersionId: null, smoke: null, rolledBack: false };

  if (!contract) return { ...result, error: "project has no lab.json" };
  if (!env.CLOUDFLARE_API_TOKEN || !env.CLOUDFLARE_ACCOUNT_ID) {
    return { ...result, error: "scoped Cloudflare token missing (~/brightloop-lab/.secrets/cloudflare.env)" };
  }
  const sh = (command) => runner("sh", ["-c", command], { cwd: dir, env });

  // Only a version that was serving fine is worth rolling back to.
  result.wasHealthy = !!(await smokeFn(projectName))?.ok;
  const prev = runner("npx", ["wrangler", "deployments", "list", "--json"], { cwd: dir, env });
  result.previousVersionId = prev.code === 0 ? latestVersion(prev.stdout) : null;

  if (contract.commands?.build) {
    const b = sh(contract.commands.build);
    if (b.code !== 0) return { ...result, step: "build", error: b.stderr.slice(-2000) };
  }
  if (opts.dryRun) return { ...result, ok: true, dryRun: true };

  const d = sh(contract.commands.deploy);
  if (d.code !== 0) return { ...result, step: "deploy", error: (d.stderr || d.stdout).slice(-2000) };
  result.versionId = d.stdout.match(/Current Version ID:\s*([0-9a-f-]{36})/)?.[1] ?? null;

  for (let i = 0; i < SMOKE_TRIES; i++) {
    result.smoke = await smokeFn(projectName);
    if (result.smoke.ok) return { ...result, ok: true };
    if (i < SMOKE_TRIES - 1) await sleep(SMOKE_WAIT_MS);
  }
  if (result.previousVersionId && result.wasHealthy) {
    const rb = runner("npx", ["wrangler", "rollback", result.previousVersionId, "--message", "night shift auto-rollback", "-y"], { cwd: dir, env });
    result.rolledBack = rb.code === 0;
    if (rb.code !== 0) result.rollbackError = rb.stderr.slice(-1000);
  }
  return { ...result, step: "smoke" };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const r = await deploy(process.argv[2], { dryRun: process.argv.includes("--dry-run") });
  console.log(JSON.stringify(r, null, 2));
  process.exitCode = r.ok ? 0 : 1;
}
