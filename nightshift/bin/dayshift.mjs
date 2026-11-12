#!/usr/bin/env node
// Day shift: hand an unused day to the night shift. Erik runs this; the director never does.
// Usage: dayshift                    start now, work until 23:00
//        dayshift --until 18:00      start now, hard stop at 18:00 (no new helper 45 min before)
//        dayshift --hours 5          start now, hard stop 5 hours from now
//        dayshift --rehearsal ...    same, as a dry run (PRs closed, nothing deployed)
//        dayshift status             show the current day shift
//        dayshift stop               ask the running director to wrap up at its next step
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { LAB, readJson, localDate } from "./lib.mjs";
import { DAYSHIFT_FILE, activeDayShift } from "./preflight.mjs";
import { resolveDial, DIAL_FILE } from "./dial.mjs";

const WEBHOOK_FILE = join(LAB, ".secrets", "dayshift-webhook");
export const EARLIEST = "06:30";   // after the night's hard stop
export const LATEST = "23:30";     // well before the night window opens at 01:30
export const DEFAULT_UNTIL = "23:00";
export const WRAP_UP_MINUTES = 45; // no new helper this long before the hard stop
export const MIN_MINUTES = 90;     // one builder + playtest needs about this

const pad = (n) => String(n).padStart(2, "0");
const toMin = (hhmm) => { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m; };
const toHHMM = (min) => `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;

/** Pure: the window for a day shift started at `now`. Throws a readable error when it can't run. */
export function planWindow({ now, until, hours }) {
  const t = now.getHours() * 60 + now.getMinutes();
  if (t < toMin(EARLIEST)) throw new Error(`too early: the night shift owns the hours before ${EARLIEST}`);
  let stop;
  if (hours != null) {
    const h = Number(hours);
    if (!Number.isFinite(h) || h <= 0) throw new Error(`can't read --hours ${hours}`);
    stop = t + Math.round(h * 60);
  } else {
    const u = until ?? DEFAULT_UNTIL;
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(u)) throw new Error(`can't read --until ${u}: use HH:MM`);
    stop = toMin(u);
  }
  stop = Math.min(stop, toMin(LATEST));
  if (stop - t < MIN_MINUTES) {
    throw new Error(`only ${stop - t} minutes until ${toHHMM(stop)}; a day shift needs at least ${MIN_MINUTES} (it ends by ${LATEST} at the latest)`);
  }
  return { date: localDate(now), startedAt: toHHMM(t), noNewWorkAfter: toHHMM(stop - WRAP_UP_MINUTES), hardStop: toHHMM(stop) };
}

function describe(d) {
  return `${d.dryRun ? "rehearsal" : "day shift"} ${d.date} ${d.startedAt}–${d.hardStop} (no new work after ${d.noNewWorkAfter})`;
}

function keepAwake(seconds) {
  // Prevent idle and system sleep while on power, for the length of the shift. Not a setting: it ends by itself.
  const c = spawn("caffeinate", ["-i", "-s", "-t", String(seconds)], { detached: true, stdio: "ignore" });
  c.unref();
  return c.pid;
}

async function main(argv) {
  const now = new Date();
  const current = activeDayShift(readJson(DAYSHIFT_FILE, undefined), now);
  const raw = readJson(DAYSHIFT_FILE, undefined);

  if (argv[0] === "status") {
    console.log(current ? describe(raw) : "no day shift running");
    return 0;
  }
  if (argv[0] === "stop") {
    if (!existsSync(DAYSHIFT_FILE)) { console.log("no day shift running"); return 0; }
    if (raw?.caffeinatePid) { try { process.kill(raw.caffeinatePid); } catch {} }
    rmSync(DAYSHIFT_FILE);
    console.log("stopping: the director wraps up at its next step and writes its report. The night shift is not affected.");
    return 0;
  }

  const opts = { rehearsal: false, until: undefined, hours: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--rehearsal") opts.rehearsal = true;
    else if (a === "--until") opts.until = argv[++i];
    else if (a === "--hours") opts.hours = argv[++i];
    else { console.error(`unknown option ${a}`); return 2; }
  }

  if (current) { console.error(`already running: ${describe(raw)}. Use "dayshift stop" first.`); return 1; }
  if (existsSync(join(LAB, "STOP"))) { console.error("~/brightloop-lab/STOP exists, so nothing would run. Delete it first."); return 1; }
  const dial = resolveDial(readJson(DIAL_FILE, undefined), now);
  if (dial.tasks === 0 && !opts.rehearsal) { console.error(`the dial is off, so a day shift would only do maintenance. Turn it up first (e.g. "dial max").`); return 1; }
  if (!existsSync(WEBHOOK_FILE)) { console.error(`missing ${WEBHOOK_FILE} (the T3 "Day shift" webhook URL)`); return 1; }

  let win;
  try { win = planWindow({ now, until: opts.until, hours: opts.hours }); }
  catch (e) { console.error(e.message); return 1; }

  const secs = (toMin(win.hardStop) - toMin(win.startedAt)) * 60 + 15 * 60;
  const record = { ...win, dryRun: opts.rehearsal, caffeinatePid: keepAwake(secs) };
  writeFileSync(DAYSHIFT_FILE, JSON.stringify(record, null, 2) + "\n");

  const url = readFileSync(WEBHOOK_FILE, "utf8").trim();
  let res;
  try {
    res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ event: "dayshift", date: win.date }) });
  } catch (e) {
    rmSync(DAYSHIFT_FILE);
    console.error(`couldn't reach T3's webhook (${e.message}). Nothing started.`);
    return 1;
  }
  if (!res.ok) {
    rmSync(DAYSHIFT_FILE);
    console.error(`T3's webhook answered ${res.status}. Nothing started.`);
    return 1;
  }
  console.log(`started: ${describe(record)}, dial ${dial.level}.`);
  console.log(`The report appears as a new "Day shift" thread in the BrightLoop Lab project. Keep the Mac on power.`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) process.exitCode = await main(process.argv.slice(2));
