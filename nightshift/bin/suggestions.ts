#!/usr/bin/env node
// Read and update visitor suggestions in the hub's D1 database (lab-hub).
// CLI: suggestions.ts pull | mark <id> <accepted|rejected|duplicate>
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { LAB, run, type Runner } from "./lib.ts";

export type Suggestion = { id: number; text: string; project: string | null; created_at: string };
type D1Options = { runner?: Runner };
import { loadEnvFile } from "./deploy.ts";

const HUB = join(LAB, "lab", "hub");
const STATUSES = new Set(["accepted", "rejected", "duplicate"]);

function d1<T>(sql: string, { runner = run }: D1Options = {}): T[] {
  const r = runner("npx", ["wrangler", "d1", "execute", "lab-hub", "--remote", "--json", "--command", sql], { cwd: HUB, env: loadEnvFile() });
  if (r.code !== 0) throw new Error(`d1 failed: ${r.stderr.slice(-500)}`);
  return JSON.parse(r.stdout)?.[0]?.results ?? [];
}

export function pull(opts?: D1Options): Suggestion[] {
  return d1<Suggestion>("select id, text, project, created_at from suggestions where status = 'new' order by id limit 50", opts);
}

export function mark(id: number, status: string | undefined, opts?: D1Options) {
  if (!Number.isInteger(id) || id < 1) throw new Error(`bad suggestion id: ${id}`);
  if (!status || !STATUSES.has(status)) throw new Error(`bad status: ${status}`);
  if (process.env.DRY_RUN === "1") return { id, status, dryRun: true };
  d1(`update suggestions set status = '${status}' where id = ${id}`, opts);
  return { id, status };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [cmd, id, status] = process.argv.slice(2);
  if (cmd === "pull") console.log(JSON.stringify(pull(), null, 2));
  else if (cmd === "mark") console.log(JSON.stringify(mark(Number(id), status)));
  else { console.error("usage: suggestions.ts pull | mark <id> <accepted|rejected|duplicate>"); process.exitCode = 2; }
}
