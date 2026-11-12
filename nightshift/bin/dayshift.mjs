#!/usr/bin/env node
// Day shift: hand an unused day to the night shift. Erik runs this; the director never does.
// Usage: dayshift                    start now, work until 23:00
//        dayshift --until 18:00      start now, hard stop at 18:00
//        dayshift --hours 5          start now, hard stop 5 hours from now
//        dayshift --tomorrow         plan tomorrow 06:30–23:00 (combine with --from / --until)
//        dayshift --from 09:00       start later today (or tomorrow, with --tomorrow)
//        dayshift --rehearsal ...    same, as a dry run (PRs closed, nothing deployed)
//        dayshift status             show the current or planned day shift
//        dayshift stop               cancel it; a running director wraps up at its next step
// A long shift is split into blocks (config dayShiftBlockHours), each a fresh director run,
// so one long session can't run out of context and one failed block doesn't lose the day.
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";
import { LAB, readJson, localDate, loadConfig } from "./lib.mjs";
import { findUnfinished } from "./log.mjs";
import { DAYSHIFT_FILE, activeDayShift } from "./preflight.mjs";
import { resolveDial, DIAL_FILE } from "./dial.mjs";

const WEBHOOK_FILE = join(LAB, ".secrets", "dayshift-webhook");
export const EARLIEST = "06:30";   // after the night's hard stop
export const LATEST = "23:30";     // well before the night window opens at 01:30
export const DEFAULT_UNTIL = "23:00";
export const WRAP_UP_MINUTES = 45; // no new helper this long before the hard stop
export const MIN_MINUTES = 90;     // one builder + playtest needs about this
export const BLOCK_GAP = 5;        // minutes between blocks, so two directors never overlap

const pad = (n) => String(n).padStart(2, "0");
const toMin = (hhmm) => { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m; };
const toHHMM = (min) => `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Split [start, stop) into blocks of about `blockMinutes`; a short tail joins the block before it. */
export function splitBlocks(start, stop, blockMinutes) {
  const blocks = [];
  let s = start;
  while (s < stop) {
    let e = Math.min(s + blockMinutes, stop);
    if (stop - e < MIN_MINUTES) e = stop;
    blocks.push({ start: toHHMM(s), noNewWorkAfter: toHHMM(e - WRAP_UP_MINUTES), hardStop: toHHMM(e) });
    s = e + BLOCK_GAP;
  }
  return blocks;
}

/** Pure: the plan for a day shift asked for at `now`. Throws a readable error when it can't run. */
export function planWindow({ now, until, hours, from, tomorrow = false, blockHours }) {
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + (tomorrow ? 1 : 0));
  if (from != null && !HHMM.test(from)) throw new Error(`can't read --from ${from}: use HH:MM`);
  let start = from != null ? toMin(from) : tomorrow ? toMin(EARLIEST) : nowMin;
  if (!tomorrow && start < nowMin) start = nowMin;
  if (start < toMin(EARLIEST)) {
    if (tomorrow || from != null) start = toMin(EARLIEST);
    else throw new Error(`too early: the night shift owns the hours before ${EARLIEST}`);
  }
  let stop;
  if (hours != null) {
    const h = Number(hours);
    if (!Number.isFinite(h) || h <= 0) throw new Error(`can't read --hours ${hours}`);
    stop = start + Math.round(h * 60);
  } else {
    const u = until ?? DEFAULT_UNTIL;
    if (!HHMM.test(u)) throw new Error(`can't read --until ${u}: use HH:MM`);
    stop = toMin(u);
  }
  stop = Math.min(stop, toMin(LATEST));
  if (stop - start < MIN_MINUTES) {
    throw new Error(`only ${stop - start} minutes from ${toHHMM(start)} to ${toHHMM(stop)}; a day shift needs at least ${MIN_MINUTES} (it ends by ${LATEST} at the latest)`);
  }
  const bh = Number(blockHours ?? loadConfig()?.dayShiftBlockHours ?? 5);
  const blocks = splitBlocks(start, stop, Math.max(MIN_MINUTES, Math.round(bh * 60)));
  return { date: localDate(day), startedAt: toHHMM(start), noNewWorkAfter: toHHMM(stop - WRAP_UP_MINUTES), hardStop: toHHMM(stop), blocks };
}

/** Is a day shift (running or planned) still ahead of us? */
export function stillAhead(raw, now) {
  if (!raw || typeof raw !== "object" || typeof raw.date !== "string" || !HHMM.test(String(raw.hardStop))) return false;
  const today = localDate(now);
  if (raw.date > today) return true;
  return raw.date === today && now.getHours() * 60 + now.getMinutes() < toMin(raw.hardStop);
}

const atLocal = (date, hhmm) => { const [y, mo, d] = date.split("-").map(Number); const [h, m] = hhmm.split(":").map(Number); return new Date(y, mo - 1, d, h, m); };

function describe(d) {
  const blocks = (d.blocks ?? []).map((b) => `${b.start}–${b.hardStop}`).join(", ");
  return `${d.dryRun ? "rehearsal" : "day shift"} ${d.date} ${d.startedAt}–${d.hardStop}` + (blocks ? ` in ${d.blocks.length} block${d.blocks.length === 1 ? "" : "s"}: ${blocks}` : "");
}

async function fireWebhook(date) {
  const url = readFileSync(WEBHOOK_FILE, "utf8").trim();
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ event: "dayshift", date }) });
  if (!res.ok) throw new Error(`T3's webhook answered ${res.status}`);
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/** Background: start each later block on time, after any run still in progress has finished. */
async function firer(id) {
  const log = (msg) => { try { writeFileSync(join(LAB, "dayshift-firer.log"), `${new Date().toISOString()} ${msg}\n`, { flag: "a" }); } catch {} };
  const current = () => { const d = readJson(DAYSHIFT_FILE, undefined); return d?.id === id ? d : null; };
  const plan = current();
  if (!plan) return;
  for (const b of plan.blocks) {
    const at = atLocal(plan.date, b.start);
    if (at.getTime() <= Date.now() - 60_000) continue; // already started by the dayshift command
    while (Date.now() < at.getTime()) { await pause(30_000); if (!current()) return log("cancelled"); }
    // Never start a director while another run (the night, or the block before) is still writing its log.
    const giveUp = Date.now() + 45 * 60_000;
    while (findUnfinished() && Date.now() < giveUp) { await pause(60_000); if (!current()) return log("cancelled"); }
    if (Date.now() >= atLocal(plan.date, b.noNewWorkAfter).getTime()) { log(`skipped block ${b.start}: too late to start`); continue; }
    try { await fireWebhook(plan.date); log(`started block ${b.start}`); }
    catch (e) { log(`block ${b.start} failed to start: ${e.message}`); }
  }
  log("all blocks started");
}

function keepAwake(seconds) {
  // Prevent idle and system sleep while on power, for the length of the shift. Not a setting: it ends by itself.
  const c = spawn("caffeinate", ["-i", "-s", "-t", String(seconds)], { detached: true, stdio: "ignore" });
  c.unref();
  return c.pid;
}

async function main(argv) {
  const now = new Date();
  const raw = readJson(DAYSHIFT_FILE, undefined);
  const ahead = stillAhead(raw, now);

  if (argv[0] === "_fire") { await firer(argv[1]); return 0; }
  if (argv[0] === "status") {
    if (!ahead) { console.log("no day shift running or planned"); return 0; }
    const live = activeDayShift(raw, now);
    console.log(`${live ? "running" : "planned"}: ${describe(raw)}`);
    return 0;
  }
  if (argv[0] === "stop") {
    if (!existsSync(DAYSHIFT_FILE)) { console.log("no day shift running or planned"); return 0; }
    for (const pid of [raw?.caffeinatePid, raw?.firerPid]) if (pid) { try { process.kill(pid); } catch {} }
    rmSync(DAYSHIFT_FILE);
    console.log("cancelled. A running director wraps up at its next step and writes its report; no further blocks start. The night shift is not affected.");
    return 0;
  }

  const opts = { rehearsal: false, until: undefined, hours: undefined, from: undefined, tomorrow: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--rehearsal") opts.rehearsal = true;
    else if (a === "--tomorrow") opts.tomorrow = true;
    else if (a === "--until") opts.until = argv[++i];
    else if (a === "--hours") opts.hours = argv[++i];
    else if (a === "--from") opts.from = argv[++i];
    else { console.error(`unknown option ${a}`); return 2; }
  }

  if (ahead) { console.error(`already ${activeDayShift(raw, now) ? "running" : "planned"}: ${describe(raw)}. Use "dayshift stop" first.`); return 1; }
  if (existsSync(join(LAB, "STOP"))) { console.error("~/brightloop-lab/STOP exists, so nothing would run. Delete it first."); return 1; }
  const dial = resolveDial(readJson(DIAL_FILE, undefined), now);
  if (dial.tasks === 0 && !opts.rehearsal) { console.error(`the dial is off, so a day shift would only do maintenance. Turn it up first (e.g. "dial max").`); return 1; }
  if (!existsSync(WEBHOOK_FILE)) { console.error(`missing ${WEBHOOK_FILE} (the T3 "Day shift" webhook URL)`); return 1; }

  let win;
  try { win = planWindow({ now, until: opts.until, hours: opts.hours, from: opts.from, tomorrow: opts.tomorrow }); }
  catch (e) { console.error(e.message); return 1; }

  const id = randomUUID();
  const endsAt = atLocal(win.date, win.hardStop).getTime() + 15 * 60_000;
  const record = { id, ...win, dryRun: opts.rehearsal, caffeinatePid: keepAwake(Math.ceil((endsAt - now.getTime()) / 1000)) };
  writeFileSync(DAYSHIFT_FILE, JSON.stringify(record, null, 2) + "\n");

  const startsNow = atLocal(win.date, win.blocks[0].start).getTime() <= now.getTime() + 60_000;
  if (startsNow) {
    try { await fireWebhook(win.date); }
    catch (e) {
      try { process.kill(record.caffeinatePid); } catch {}
      rmSync(DAYSHIFT_FILE);
      console.error(`couldn't start it (${e.message}). Nothing started.`);
      return 1;
    }
  }
  if (!startsNow || win.blocks.length > 1) {
    const f = spawn(process.execPath, [fileURLToPath(import.meta.url), "_fire", id], { detached: true, stdio: "ignore" });
    f.unref();
    record.firerPid = f.pid;
    writeFileSync(DAYSHIFT_FILE, JSON.stringify(record, null, 2) + "\n");
  }
  console.log(`${startsNow ? "started" : "planned"}: ${describe(record)}, dial ${dial.level}.`);
  console.log(`Each block's report appears as a new "Day shift" thread in the BrightLoop Lab project. Keep the Mac on power with the lid open.`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) process.exitCode = await main(process.argv.slice(2));
