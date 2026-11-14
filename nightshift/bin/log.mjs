#!/usr/bin/env node
// The night log: lab/nightshift/logs/<date>.md, written step by step so a night
// that dies halfway can be picked up by the next one.
// CLI: log.mjs start <date> <dial> <mode> [preflight.json] | begin <date> <id> <detail> | end <date> <id> <ok|failed|skipped> <detail> | finish <date> <status> | unfinished
import { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { NIGHTSHIFT, readJson } from "./lib.mjs";

const LOGS = join(NIGHTSHIFT, "logs");
const MARK = { ok: "x", failed: "!", skipped: "-" };
const oneLine = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const file = (date, dir) => join(dir, `${date}.md`);

/** Starts a run. `likes` (pre-flight's) is recorded as one `likes: {json}` line, so later runs can compare. */
export function startLog(date, { dial, mode, likes }, dir = LOGS) {
  mkdirSync(dir, { recursive: true });
  const path = file(date, dir);
  const now = new Date();
  const hhmm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  const record = likes && typeof likes === "object" ? `likes: ${JSON.stringify(likes)}\n\n` : "";
  const heading = `## Run ${hhmm} · mode ${mode} · dial ${dial}\n\n${record}`;
  if (!existsSync(path)) {
    writeFileSync(path, `---\nstatus: running\ndial: ${dial}\nmode: ${mode}\n---\n\n# Night shift ${date}\n\n${heading}`);
  } else {
    const text = readFileSync(path, "utf8").replace(/^status: .*$/m, "status: running");
    writeFileSync(path, `${text.replace(/\n*$/, "\n")}\n${heading}`);
  }
  return path;
}

export function stepBegin(date, id, detail, dir = LOGS) {
  const path = file(date, dir);
  writeFileSync(path, readFileSync(path, "utf8") + `- [ ] ${oneLine(id)}: ${oneLine(detail)}\n`);
}

/** Close the most recent open step with this id. */
export function stepEnd(date, id, result, detail, dir = LOGS) {
  const path = file(date, dir);
  const lines = readFileSync(path, "utf8").split("\n");
  const prefix = `- [ ] ${oneLine(id)}:`;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].startsWith(prefix)) {
      lines[i] = `- [${MARK[result] ?? "!"}] ${oneLine(id)}: ${oneLine(detail)}`;
      break;
    }
  }
  writeFileSync(path, lines.join("\n"));
}

export function finishLog(date, status, dir = LOGS) {
  const path = file(date, dir);
  writeFileSync(path, readFileSync(path, "utf8").replace(/^status: .*$/m, `status: ${status}`));
}

export function appendNote(date, text, dir = LOGS) {
  const path = file(date, dir);
  writeFileSync(path, readFileSync(path, "utf8") + `\n${text}\n`);
}

/** `[{ date, likes }]`, oldest first: the last likes record in each day's log. */
export function likesHistory(dir = LOGS) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const f of readdirSync(dir).filter((f) => /^\d{4}-\d\d-\d\d\.md$/.test(f)).sort()) {
    const lines = [...readFileSync(join(dir, f), "utf8").matchAll(/^likes: (\{.*\})$/gm)].reverse();
    for (const [, json] of lines) {
      try {
        out.push({ date: f.slice(0, 10), likes: JSON.parse(json) });
        break;
      } catch { /* a broken record: try the one before it */ }
    }
  }
  return out;
}

/** The newest log still marked running, with its open steps. */
export function findUnfinished(dir = LOGS) {
  if (!existsSync(dir)) return null;
  const logs = readdirSync(dir).filter((f) => /^\d{4}-\d\d-\d\d\.md$/.test(f)).sort().reverse();
  for (const f of logs) {
    const text = readFileSync(join(dir, f), "utf8");
    if (!/^status: running$/m.test(text)) continue;
    const openSteps = [...text.matchAll(/^- \[ \] ([^:]+): (.*)$/gm)].map((m) => ({ id: m[1], detail: m[2] }));
    return { date: f.slice(0, 10), openSteps };
  }
  return null;
}

function main([cmd, date, ...a]) {
  switch (cmd) {
    case "start": console.log(startLog(date, { dial: a[0], mode: a[1], likes: a[2] ? readJson(a[2], null)?.likes : null })); break;
    case "begin": stepBegin(date, a[0], a.slice(1).join(" ")); break;
    case "end": stepEnd(date, a[0], a[1], a.slice(2).join(" ")); break;
    case "finish": finishLog(date, a[0]); break;
    case "note": appendNote(date, a.join(" ")); break;
    case "unfinished": console.log(JSON.stringify(findUnfinished())); break;
    default: console.error("usage: log.mjs start|begin|end|finish|note|unfinished …"); return 2;
  }
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) process.exitCode = main(process.argv.slice(2));
