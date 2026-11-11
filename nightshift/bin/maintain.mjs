#!/usr/bin/env node
// Run a project's cheap, model-free maintenance chore; commit, push and deploy if it changed anything.
// CLI: maintain.mjs <project> [--dry-run]
import { pathToFileURL } from "node:url";
import { run, findProject, loadContract, projectDir } from "./lib.mjs";
import { deploy } from "./deploy.mjs";

const TRAILER = "\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>";

export async function maintain(projectName, opts = {}) {
  const p = opts.contract ? null : findProject(projectName);
  const contract = opts.contract ?? loadContract(p);
  const dir = opts.dir ?? projectDir(p);
  const runner = opts.runner ?? run;
  const deployFn = opts.deployFn ?? ((name) => deploy(name, { dryRun: opts.dryRun }));
  const res = { project: projectName, ok: true, changed: false, committed: false, deployed: false };
  const cmd = contract?.commands?.maintenance;
  if (!cmd) return res;

  const m = runner("sh", ["-c", cmd], { cwd: dir });
  const lines = m.stdout.trim().split("\n");
  if (m.code !== 0) return { ...res, ok: false, error: (m.stderr || m.stdout).slice(-1500) };
  res.output = lines.slice(-6).join("\n");
  if (lines.at(-1) !== "CHANGED") return res;
  res.changed = true;
  if (opts.dryRun) return res;

  const files = runner("git", ["ls-files", "--others", "--modified", "--exclude-standard"], { cwd: dir }).stdout.trim().split("\n").filter(Boolean);
  const last = files.map((f) => f.match(/(\d{4}-\d\d-\d\d)\.json$/)?.[1]).filter(Boolean).sort().at(-1);
  const add = runner("git", ["add", "-A", "levels"], { cwd: dir });
  const commit = runner("git", ["commit", "-q", "-m", `chore: daily puzzles${last ? ` through ${last}` : ""}${TRAILER}`], { cwd: dir });
  if (add.code || commit.code) return { ...res, ok: false, error: "commit failed: " + (commit.stderr || add.stderr) };
  const push = runner("git", ["push", "-q"], { cwd: dir });
  if (push.code) return { ...res, ok: false, error: "push failed: " + push.stderr };
  res.committed = true;
  const d = await deployFn(projectName);
  res.deployed = !!d.ok;
  res.deploy = d;
  if (!d.ok) res.ok = false;
  return res;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const r = await maintain(process.argv[2], { dryRun: process.argv.includes("--dry-run") });
  console.log(JSON.stringify(r, null, 2));
  process.exitCode = r.ok ? 0 : 1;
}
