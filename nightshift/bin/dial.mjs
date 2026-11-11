#!/usr/bin/env node
// The usage dial: how much of Erik's Claude plan the night shift may use.
// Usage: dial                       show the setting
//        dial <off|low|normal|high> [--until <weekday|YYYY-MM-DD>] [--then <level>]
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { LAB, readJson, localDate, loadConfig } from "./lib.mjs";

const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const FALLBACK_LEVELS = {
  off: { tasks: 0, fixRounds: 0 }, low: { tasks: 1, fixRounds: 0 },
  normal: { tasks: 2, fixRounds: 1 }, high: { tasks: 3, fixRounds: 2 },
};
export const DIAL_FILE = join(LAB, "dial.json");

function levels() {
  return loadConfig()?.levels ?? FALLBACK_LEVELS;
}

/** Effective dial for a run at `now`. Never throws. */
export function resolveDial(raw, now = new Date()) {
  const L = levels();
  const ok = (l) => typeof l === "string" && Object.hasOwn(L, l);
  const d = raw && typeof raw === "object" ? raw : {};
  let level = ok(d.level) ? d.level : "normal";
  const until = typeof d.until === "string" && /^\d{4}-\d\d-\d\d$/.test(d.until) ? d.until : null;
  const expired = !!until && localDate(now) >= until;
  if (expired) level = ok(d.then) ? d.then : "normal";
  return { level, ...L[level], until: expired ? null : until, then: ok(d.then) ? d.then : "normal", expired };
}

/** "monday" -> the next Monday (never today); ISO dates pass through. */
export function parseUntil(word, now = new Date()) {
  const w = String(word).trim().toLowerCase();
  if (/^\d{4}-\d\d-\d\d$/.test(w)) return w;
  const i = DAYS.indexOf(w);
  if (i < 0) throw new Error(`can't read "${word}": use a weekday name or YYYY-MM-DD`);
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let ahead = (i - d.getDay() + 7) % 7;
  if (ahead === 0) ahead = 7;
  d.setDate(d.getDate() + ahead);
  return localDate(d);
}

function describe(d) {
  return `${d.level} (${d.tasks} task${d.tasks === 1 ? "" : "s"} a night, ${d.fixRounds} fix round${d.fixRounds === 1 ? "" : "s"})` +
    (d.until ? ` until ${d.until}, then ${d.then}` : "");
}

function main(argv) {
  const now = new Date();
  if (argv.length === 0) {
    console.log(describe(resolveDial(readJson(DIAL_FILE, undefined), now)));
    return 0;
  }
  const [level, ...rest] = argv;
  if (!Object.hasOwn(levels(), level)) {
    console.error(`unknown level "${level}". Use one of: ${Object.keys(levels()).join(", ")}`);
    return 2;
  }
  const out = { level, until: null, then: "normal" };
  for (let i = 0; i < rest.length; i += 2) {
    if (rest[i] === "--until") out.until = parseUntil(rest[i + 1], now);
    else if (rest[i] === "--then") {
      if (!Object.hasOwn(levels(), rest[i + 1])) { console.error(`unknown level "${rest[i + 1]}"`); return 2; }
      out.then = rest[i + 1];
    } else { console.error(`unknown option ${rest[i]}`); return 2; }
  }
  writeFileSync(DIAL_FILE, JSON.stringify(out, null, 2) + "\n");
  console.log(describe(resolveDial(out, now)));
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) process.exitCode = main(process.argv.slice(2));
