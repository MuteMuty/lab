// Shared helpers for the night shift. No npm dependencies on purpose.
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const LAB = process.env.LAB_ROOT || join(homedir(), "brightloop-lab");
export const NIGHTSHIFT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Read JSON; return `fallback` on any error (missing file, bad JSON). */
export function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

export function localDate(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function run(cmd, args = [], { cwd, env, input } = {}) {
  const r = spawnSync(cmd, args, {
    cwd, input, encoding: "utf8", env: { ...process.env, ...env }, maxBuffer: 64 * 1024 * 1024,
  });
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: (r.stderr ?? "") + (r.error ? String(r.error) : "") };
}

export function loadConfig() {
  return readJson(join(NIGHTSHIFT, "config.json"), null);
}

export function loadProjects() {
  return readJson(join(NIGHTSHIFT, "projects.json"), []);
}

export function projectDir(p) {
  return join(LAB, p.path);
}

export function loadContract(p) {
  return readJson(join(projectDir(p), "lab.json"), null);
}

export function findProject(name) {
  const p = loadProjects().find((x) => x.name === name);
  if (!p) throw new Error(`unknown project: ${name} (not in nightshift/projects.json)`);
  return p;
}
