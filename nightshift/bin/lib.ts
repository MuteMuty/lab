// Shared helpers for the night shift. No npm dependencies on purpose: Node runs this TypeScript as is.
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/** A lab project, as listed in nightshift/projects.json. */
export type Project = {
  name: string;
  repo: string;
  path: string;
  worker: string;
  public: boolean;
  d1?: string[];
  subdomain?: string;
};

/** A project's lab.json: how the night shift installs, tests, serves and deploys it. */
export type Contract = {
  name?: string;
  url: string;
  worker?: string;
  commands?: Partial<Record<"install" | "test" | "build" | "serve" | "playtest" | "deploy" | "maintenance", string>>;
  smoke?: string[];
};

/** One step of the usage dial (config.json "levels"). */
export type Level = { tasks: number | "fill"; fixRounds: number; parallel?: number };

export type Config = {
  start: string;
  windowStart: string;
  windowEnd: string;
  noNewWorkAfter: string;
  hardStop: string;
  puzzleBufferDays: number;
  newProjectEveryDays: number;
  levels: Record<string, Level>;
  defaultLevel: string;
  models: Record<string, unknown>;
  scoutWhenPolishBelow: number;
  dayShiftBlockHours: number;
};

export type RunResult = { code: number; stdout: string; stderr: string };
export type RunOptions = { cwd?: string; env?: NodeJS.ProcessEnv; input?: string };
export type Runner = (cmd: string, args?: string[], opts?: RunOptions) => RunResult;

export const LAB = process.env.LAB_ROOT || join(homedir(), "brightloop-lab");
export const NIGHTSHIFT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Read JSON; return `fallback` on any error (missing file, bad JSON). */
export function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

export function localDate(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export const run: Runner = (cmd, args = [], { cwd, env, input } = {}) => {
  const r = spawnSync(cmd, args, {
    cwd, input, encoding: "utf8", env: { ...process.env, ...env }, maxBuffer: 64 * 1024 * 1024,
  });
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: (r.stderr ?? "") + (r.error ? String(r.error) : "") };
};

export function loadConfig(): Config | null {
  return readJson<Config | null>(join(NIGHTSHIFT, "config.json"), null);
}

export function loadProjects(): Project[] {
  return readJson<Project[]>(join(NIGHTSHIFT, "projects.json"), []);
}

export function projectDir(p: Project): string {
  return join(LAB, p.path);
}

export function loadContract(p: Project): Contract | null {
  return readJson<Contract | null>(join(projectDir(p), "lab.json"), null);
}

export function findProject(name: string): Project {
  const p = loadProjects().find((x) => x.name === name);
  if (!p) throw new Error(`unknown project: ${name} (not in nightshift/projects.json)`);
  return p;
}
