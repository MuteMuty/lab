#!/usr/bin/env node
// The night log: lab/nightshift/logs/<date>.md, written step by step so a night
// that dies halfway can be picked up by the next one.
// CLI: log.ts start <date> <dial> <mode> [preflight.json] | begin <date> <id> <detail> | end <date> <id> <ok|failed|skipped> <detail> | finish <date> <status> | unfinished
import { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { NIGHTSHIFT, readJson } from "./lib.ts";
import type { Usage } from "./usage.ts";

const LOGS = join(NIGHTSHIFT, "logs");
/** The hub's like counts per project, as /api/likes returns them. */
export type Likes = Record<string, { total: number; week: number }>;
export type OpenStep = { id: string; detail: string };

const MARK: Record<string, string> = { ok: "x", failed: "!", skipped: "-" };
const oneLine = (s: unknown) => String(s ?? "").replace(/\s+/g, " ").trim();
const file = (date: string, dir: string) => join(dir, `${date}.md`);

/**
 * Starts a run. Pre-flight's `likes` and `usage` (lab#72) are each recorded as one `likes: {json}` /
 * `usage: {json}` line, so later runs can compare.
 */
export function startLog(
  date: string, { dial, mode, likes, usage }: { dial?: string; mode?: string; likes?: Likes | null; usage?: Usage | null }, dir = LOGS,
): string {
  mkdirSync(dir, { recursive: true });
  const path = file(date, dir);
  const now = new Date();
  const hhmm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  const record = (["likes", "usage"] as const)
    .map((k) => [k, k === "likes" ? likes : usage] as const)
    .filter(([, v]) => v && typeof v === "object")
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}\n\n`)
    .join("");
  const heading = `## Run ${hhmm} · mode ${mode} · dial ${dial}\n\n${record}`;
  if (!existsSync(path)) {
    writeFileSync(path, `---\nstatus: running\ndial: ${dial}\nmode: ${mode}\n---\n\n# Night shift ${date}\n\n${heading}`);
  } else {
    const text = readFileSync(path, "utf8").replace(/^status: .*$/m, "status: running");
    writeFileSync(path, `${text.replace(/\n*$/, "\n")}\n${heading}`);
  }
  return path;
}

export function stepBegin(date: string, id: string | undefined, detail: string, dir = LOGS) {
  const path = file(date, dir);
  writeFileSync(path, readFileSync(path, "utf8") + `- [ ] ${oneLine(id)}: ${oneLine(detail)}\n`);
}

/** Close the most recent open step with this id. */
export function stepEnd(date: string, id: string | undefined, result: string | undefined, detail: string, dir = LOGS) {
  const path = file(date, dir);
  const lines = readFileSync(path, "utf8").split("\n");
  const prefix = `- [ ] ${oneLine(id)}:`;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i]!.startsWith(prefix)) {
      lines[i] = `- [${MARK[result ?? ""] ?? "!"}] ${oneLine(id)}: ${oneLine(detail)}`;
      break;
    }
  }
  writeFileSync(path, lines.join("\n"));
}

export function finishLog(date: string, status: string | undefined, dir = LOGS) {
  const path = file(date, dir);
  writeFileSync(path, readFileSync(path, "utf8").replace(/^status: .*$/m, `status: ${status}`));
}

export function appendNote(date: string, text: string, dir = LOGS) {
  const path = file(date, dir);
  writeFileSync(path, readFileSync(path, "utf8") + `\n${text}\n`);
}

/** `[{ date, value }]`, oldest first: the last `<key>: {json}` record in each day's log. */
function recordHistory<T>(key: "likes" | "usage", dir: string): { date: string; value: T }[] {
  if (!existsSync(dir)) return [];
  const out: { date: string; value: T }[] = [];
  const re = new RegExp(`^${key}: (\\{.*\\})$`, "gm");
  for (const f of readdirSync(dir).filter((f) => /^\d{4}-\d\d-\d\d\.md$/.test(f)).sort()) {
    const lines = [...readFileSync(join(dir, f), "utf8").matchAll(re)].reverse();
    for (const [, json] of lines) {
      try {
        out.push({ date: f.slice(0, 10), value: JSON.parse(json!) });
        break;
      } catch { /* a broken record: try the one before it */ }
    }
  }
  return out;
}

/** `[{ date, likes }]`, oldest first: the last likes record in each day's log. */
export function likesHistory(dir = LOGS): { date: string; likes: Likes }[] {
  return recordHistory<Likes>("likes", dir).map(({ date, value }) => ({ date, likes: value }));
}

/** `[{ date, usage }]`, oldest first: the last usage record in each day's log (lab#72). */
export function usageHistory(dir = LOGS): { date: string; usage: Usage }[] {
  return recordHistory<Usage>("usage", dir).map(({ date, value }) => ({ date, usage: value }));
}

/** The newest log still marked running, with its open steps. */
export function findUnfinished(dir = LOGS): { date: string; openSteps: OpenStep[] } | null {
  if (!existsSync(dir)) return null;
  const logs = readdirSync(dir).filter((f) => /^\d{4}-\d\d-\d\d\.md$/.test(f)).sort().reverse();
  for (const f of logs) {
    const text = readFileSync(join(dir, f), "utf8");
    if (!/^status: running$/m.test(text)) continue;
    const openSteps = [...text.matchAll(/^- \[ \] ([^:]+): (.*)$/gm)].map((m) => ({ id: m[1]!, detail: m[2]! }));
    return { date: f.slice(0, 10), openSteps };
  }
  return null;
}

function main([cmd, date = "", ...a]: string[]): number {
  switch (cmd) {
    case "start": {
      const pre = a[2] ? readJson<{ likes?: Likes; usage?: Usage } | null>(a[2], null) : null;
      console.log(startLog(date, { dial: a[0], mode: a[1], likes: pre?.likes ?? null, usage: pre?.usage ?? null }));
      break;
    }
    case "begin": stepBegin(date, a[0], a.slice(1).join(" ")); break;
    case "end": stepEnd(date, a[0], a[1], a.slice(2).join(" ")); break;
    case "finish": finishLog(date, a[0]); break;
    case "note": appendNote(date, a.join(" ")); break;
    case "unfinished": console.log(JSON.stringify(findUnfinished())); break;
    default: console.error("usage: log.ts start|begin|end|finish|note|unfinished …"); return 2;
  }
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) process.exitCode = main(process.argv.slice(2));
