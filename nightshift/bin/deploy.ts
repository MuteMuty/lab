#!/usr/bin/env node
// Deploy a lab project with the scoped Cloudflare key, smoke-test it live,
// and roll back automatically if the smoke test fails.
// CLI: deploy.ts <project> [--dry-run]   prints JSON, exit 1 unless ok
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { LAB, run, findProject, loadContract, projectDir, type Contract, type Runner } from "./lib.ts";
import { smoke, type SmokeReport } from "./smoke.ts";

export type Route = { pattern: string; custom_domain?: boolean };
export type DeployOptions = {
  dryRun?: boolean;
  contract?: Pick<Contract, "commands" | "worker"> | null;
  dir?: string;
  env?: Record<string, string>;
  runner?: Runner;
  smokeFn?: (name: string) => Promise<SmokeReport>;
  sleep?: (ms: number) => Promise<unknown>;
  worker?: string;
  subdomain?: string;
  routes?: Route[];
  stateFile?: string;
};
export type DeployResult = {
  project: string;
  ok: boolean;
  wasHealthy: boolean | null;
  versionId: string | null;
  previousVersionId: string | null;
  smoke: SmokeReport | null;
  rolledBack: boolean;
  urls?: string[];
  step?: "build" | "deploy" | "smoke";
  error?: string;
  rollbackError?: string;
  dryRun?: boolean;
};
export type RestoreResult = {
  project: string; ok: boolean; action: "none" | "rollback failed" | "rolled back";
  needsErik?: boolean; versionId?: string; error?: string;
};
type State = Record<string, { versionId: string; at: string }>;

export const ENV_FILE = join(LAB, ".secrets", "cloudflare.env");
export const STATE_FILE = join(LAB, "nightshift-state.json");
const ZONE = "brightloopapps.com";

function readState(file: string): State {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return {}; }
}
function rememberGood(file: string, project: string, versionId: string | null) {
  if (!versionId) return;
  const s = readState(file);
  s[project] = { versionId, at: new Date().toISOString() };
  writeFileSync(file, JSON.stringify(s, null, 2) + "\n");
}

/** Route patterns from the project's wrangler config (jsonc or toml). */
export function readRoutes(dir: string): Route[] {
  for (const f of ["wrangler.jsonc", "wrangler.json", "wrangler.toml"]) {
    const path = join(dir, f);
    if (!existsSync(path)) continue;
    const text = readFileSync(path, "utf8");
    return [...text.matchAll(/pattern"?\s*[:=]\s*"([^"]+)"/g)].map((m) => ({ pattern: m[1]! }));
  }
  return [];
}

/** A project may only serve on its own subdomain (or workers.dev). */
export function routeProblem(routes: Route[], subdomain: string | undefined): string | null {
  for (const r of routes) {
    if (r.pattern !== `${subdomain}.${ZONE}`) return `route "${r.pattern}" is not allowed (only ${subdomain}.${ZONE})`;
  }
  return null;
}
const SMOKE_TRIES = 6;
const SMOKE_WAIT_MS = 10_000;

export function loadEnvFile(path = ENV_FILE): Record<string, string> {
  const env: Record<string, string> = {};
  try {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*"?([^"\n]*)"?\s*$/);
      if (m) env[m[1]!] = m[2]!;
    }
  } catch {}
  return env;
}

function latestVersion(stdout: string): string | null {
  try {
    const list: { created_on?: string; versions?: { version_id?: string }[] }[] = JSON.parse(stdout);
    const sorted = [...list].sort((a, b) => String(b.created_on).localeCompare(String(a.created_on)));
    return sorted[0]?.versions?.[0]?.version_id ?? null;
  } catch {
    return null;
  }
}

export async function deploy(projectName: string, opts: DeployOptions = {}): Promise<DeployResult> {
  const p = opts.contract ? null : findProject(projectName);
  const contract = opts.contract ?? (p && loadContract(p));
  const dir = opts.dir ?? projectDir(p!);
  const env = opts.env ?? loadEnvFile();
  const runner = opts.runner ?? run;
  const smokeFn = opts.smokeFn ?? ((name: string) => smoke(name));
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const result: DeployResult = { project: projectName, ok: false, wasHealthy: null, versionId: null, previousVersionId: null, smoke: null, rolledBack: false };

  if (!contract) return { ...result, error: "project has no lab.json" };
  const worker = opts.worker ?? contract.worker ?? p?.worker;
  const subdomain = opts.subdomain ?? p?.subdomain ?? worker;
  const badRoute = routeProblem(opts.routes ?? readRoutes(dir), subdomain);
  if (badRoute) return { ...result, error: badRoute };
  const stateFile = opts.stateFile ?? STATE_FILE;
  if (!env.CLOUDFLARE_API_TOKEN || !env.CLOUDFLARE_ACCOUNT_ID) {
    return { ...result, error: "scoped Cloudflare token missing (~/brightloop-lab/.secrets/cloudflare.env)" };
  }
  const sh = (command: string) => runner("sh", ["-c", command], { cwd: dir, env });

  // Only a version that was serving fine is worth rolling back to.
  result.wasHealthy = !!(await smokeFn(projectName))?.ok;
  const prev = runner("npx", ["wrangler", "deployments", "list", "--json"], { cwd: dir, env });
  result.previousVersionId = prev.code === 0 ? latestVersion(prev.stdout) : null;
  if (result.wasHealthy && !opts.dryRun) rememberGood(stateFile, projectName, result.previousVersionId);

  if (contract.commands?.build) {
    const b = sh(contract.commands.build);
    if (b.code !== 0) return { ...result, step: "build", error: b.stderr.slice(-2000) };
  }
  if (opts.dryRun) return { ...result, ok: true, dryRun: true };

  const d = sh(contract.commands?.deploy ?? "npx wrangler deploy");
  if (d.code !== 0) return { ...result, step: "deploy", error: (d.stderr || d.stdout).slice(-2000) };
  result.versionId = d.stdout.match(/Current Version ID:\s*([0-9a-f-]{36})/)?.[1] ?? null;
  // A new project's *.workers.dev preview URL is only known from wrangler's output.
  result.urls = [...new Set(d.stdout.match(/https:\/\/[^\s]+/g) ?? [])];

  for (let i = 0; i < SMOKE_TRIES; i++) {
    result.smoke = await smokeFn(projectName);
    if (result.smoke.ok) {
      rememberGood(stateFile, projectName, result.versionId);
      return { ...result, ok: true };
    }
    if (i < SMOKE_TRIES - 1) await sleep(SMOKE_WAIT_MS);
  }
  if (result.previousVersionId && result.wasHealthy) {
    const rb = runner("npx", ["wrangler", "rollback", result.previousVersionId, "--message", "night shift auto-rollback", "-y"], { cwd: dir, env });
    result.rolledBack = rb.code === 0;
    if (rb.code !== 0) result.rollbackError = rb.stderr.slice(-1000);
  }
  return { ...result, step: "smoke" };
}

/** Recovery: if the live site is broken, roll back to the last version known to be good. */
export async function restore(projectName: string, opts: DeployOptions = {}): Promise<RestoreResult> {
  const p = opts.contract ? null : findProject(projectName);
  const dir = opts.dir ?? projectDir(p!);
  const env = opts.env ?? loadEnvFile();
  const runner = opts.runner ?? run;
  const smokeFn = opts.smokeFn ?? ((name: string) => smoke(name));
  const stateFile = opts.stateFile ?? STATE_FILE;
  const before = await smokeFn(projectName);
  if (before?.ok) return { project: projectName, ok: true, action: "none" };
  const good = readState(stateFile)[projectName]?.versionId;
  if (!good) return { project: projectName, ok: false, needsErik: true, action: "none", error: "no known good version to roll back to" };
  const rb = runner("npx", ["wrangler", "rollback", good, "--message", "night shift recovery", "-y"], { cwd: dir, env });
  if (rb.code !== 0) return { project: projectName, ok: false, needsErik: true, action: "rollback failed", error: rb.stderr.slice(-1000) };
  const after = await smokeFn(projectName);
  return { project: projectName, ok: !!after?.ok, action: "rolled back", versionId: good, needsErik: !after?.ok };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href && process.argv.includes("--restore")) {
  const r = await restore(process.argv[2]);
  console.log(JSON.stringify(r, null, 2));
  process.exitCode = r.ok ? 0 : 1;
} else if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const r = await deploy(process.argv[2], { dryRun: process.argv.includes("--dry-run") || process.env.DRY_RUN === "1" });
  console.log(JSON.stringify(r, null, 2));
  process.exitCode = r.ok ? 0 : 1;
}
