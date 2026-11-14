#!/usr/bin/env node
// Pre-flight: decide what kind of night this is, before any model work.
// CLI prints one JSON object: { go, mode, reason, dial, window, recover, date, pull, smoke, likes, likesTrend }.
// `window` says when to stop: the night window from config.json, or a day shift
// that Erik started with ~/brightloop-lab/dayshift (read from dayshift.json).
// `likes` is the hub's like API ({ <project>: { total, week } }, or null if it failed);
// `likesTrend` compares it with the likes recorded in earlier night logs (lab#19).
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { LAB, readJson, localDate, run, loadConfig, loadProjects, projectDir } from "./lib.mjs";
import { resolveDial, DIAL_FILE } from "./dial.mjs";
import { findUnfinished, likesHistory } from "./log.mjs";
import { smoke } from "./smoke.mjs";

const minutes = (hhmm) => { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m; };
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
export const DAYSHIFT_FILE = join(LAB, "dayshift.json");

/** A day shift counts only on its own date, before its hard stop, with sane times. */
export function activeDayShift(raw, now) {
  const d = raw && typeof raw === "object" ? raw : null;
  if (!d || d.date !== localDate(now)) return null;
  if (!HHMM.test(String(d.noNewWorkAfter)) || !HHMM.test(String(d.hardStop))) return null;
  const t = now.getHours() * 60 + now.getMinutes();
  // A planned shift is split into blocks; the window is the block we're in. No blocks: one block from startedAt.
  const blocks = Array.isArray(d.blocks) && d.blocks.length
    ? d.blocks
    : [{ start: d.startedAt ?? "00:00", noNewWorkAfter: d.noNewWorkAfter, hardStop: d.hardStop }];
  for (const b of blocks) {
    if (!b || !HHMM.test(String(b.start ?? "00:00")) || !HHMM.test(String(b.noNewWorkAfter)) || !HHMM.test(String(b.hardStop))) return null;
    if (minutes(b.noNewWorkAfter) > minutes(b.hardStop)) return null;
    if (t >= minutes(b.start ?? "00:00") && t < minutes(b.hardStop)) {
      return { kind: "day", noNewWorkAfter: b.noNewWorkAfter, hardStop: b.hardStop, dryRun: d.dryRun === true };
    }
  }
  return null;
}

export const LIKES_URL = "https://lab.brightloopapps.com/api/likes";
const count = (n) => Number.isInteger(n) && n >= 0;

/** The like counts, or null on any failure (network, timeout, non-200, bad JSON, wrong shape). */
export async function fetchLikes({ fetch = globalThis.fetch, url = LIKES_URL, timeoutMs = 5000 } = {}) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: "application/json" } });
    if (res.status !== 200) return null;
    const data = await res.json();
    if (!data || typeof data !== "object" || Array.isArray(data)) return null;
    const ok = Object.values(data).every((v) => v && typeof v === "object" && count(v.total) && count(v.week));
    return ok ? data : null;
  } catch {
    return null;
  }
}

const daysBefore = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) - n * 864e5).toISOString().slice(0, 10);

/**
 * Pure. Compares today's likes with `history` ([{ date, likes }], oldest first, from the night logs).
 * - `line`: "Likes this week: afterstep 12 (+4), inkchime 3 (new)". The number is `week`; (+n) is the
 *   change in `total` since `previous` (the last earlier day with a record); (new) means not in that record.
 * - `top`: the launched project with the most likes this week; null on a tie or when none has any.
 * - `quiet`: launched projects whose `total` hasn't grown since `since` (the newest record at least 14 days
 *   old) while another's has. A project missing from that record isn't judged. null: not enough history yet.
 */
export function likesTrend({ likes, history, projects, today }) {
  if (!likes) return null;
  const launched = projects.filter((p) => p.public && p.name !== "hub" && likes[p.name]).map((p) => p.name);
  const prev = history.filter((h) => h.date < today).at(-1) ?? null;
  const change = (name) => {
    const before = prev?.likes?.[name]?.total;
    if (!Number.isInteger(before)) return "new";
    const d = likes[name].total - before;
    return d < 0 ? `-${-d}` : `+${d}`;
  };
  const line = `Likes this week: ${launched.map((n) => `${n} ${likes[n].week} (${change(n)})`).join(", ") || "none"}`;
  const ranked = [...launched].sort((a, b) => likes[b].week - likes[a].week);
  const best = likes[ranked[0]]?.week ?? 0;
  const top = best > 0 && likes[ranked[1]]?.week !== best ? ranked[0] : null;
  const old = history.filter((h) => h.date <= daysBefore(today, 14)).at(-1);
  let quiet = null;
  if (old) {
    const gain = Object.fromEntries(launched.filter((n) => Number.isInteger(old.likes?.[n]?.total)).map((n) => [n, likes[n].total - old.likes[n].total]));
    const anyGrew = Object.values(gain).some((g) => g > 0);
    quiet = { since: old.date, projects: anyGrew ? Object.keys(gain).filter((n) => gain[n] <= 0) : [] };
  }
  return { line, previous: prev?.date ?? null, top, quiet };
}

/** Pure decision. */
export function decide({ now, dialRaw, stopExists, dryRun, recover, force, dayShiftRaw }) {
  const cfg = loadConfig() ?? { windowStart: "01:30", windowEnd: "05:30", noNewWorkAfter: "05:15", hardStop: "06:00" };
  const dial = resolveDial(dialRaw, now);
  const date = localDate(now);
  const day = activeDayShift(dayShiftRaw, now);
  const window = day
    ? { kind: "day", noNewWorkAfter: day.noNewWorkAfter, hardStop: day.hardStop }
    : { kind: "night", noNewWorkAfter: cfg.noNewWorkAfter ?? "05:15", hardStop: cfg.hardStop ?? "06:00" };
  const out = (go, mode, reason) => ({ go, mode, reason, dial, window, recover: recover ?? null, date });
  if (stopExists) return out(false, "stop", "STOP file present");
  if (dryRun || day?.dryRun) return out(true, "dry-run", day ? `day-shift rehearsal until ${day.hardStop}` : "rehearsal");
  if (dial.tasks === 0) return out(true, "maintenance", "dial is off");
  if (day) return out(true, "full", `day shift until ${day.hardStop}`);
  const t = now.getHours() * 60 + now.getMinutes();
  if (!force && (t < minutes(cfg.windowStart) || t > minutes(cfg.windowEnd))) {
    return out(true, "maintenance", `started at ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}, outside ${cfg.windowStart}–${cfg.windowEnd}`);
  }
  return out(true, "full", force ? "supervised run (NIGHTSHIFT_FORCE=1)" : "normal night");
}

async function main() {
  const now = new Date();
  const result = decide({
    now,
    dialRaw: readJson(DIAL_FILE, undefined),
    stopExists: existsSync(join(LAB, "STOP")),
    dryRun: process.env.DRY_RUN === "1",
    force: process.env.NIGHTSHIFT_FORCE === "1",
    recover: findUnfinished(),
    dayShiftRaw: readJson(DAYSHIFT_FILE, undefined),
  });
  if (result.go) {
    const repos = [...new Map(loadProjects().map((p) => [p.repo, projectDir(p).replace(/\/hub$/, "")])).entries()];
    result.pull = repos.map(([repo, dir]) => {
      const r = run("git", ["-C", dir, "pull", "--ff-only", "-q"]);
      return { repo, ok: r.code === 0, error: r.code ? r.stderr.trim().slice(0, 300) : undefined };
    });
    result.likes = await fetchLikes();
    result.likesTrend = likesTrend({ likes: result.likes, history: likesHistory(), projects: loadProjects(), today: result.date });
    result.smoke = {};
    for (const p of loadProjects().filter((p) => p.public)) {
      if (existsSync(join(projectDir(p), "lab.json"))) result.smoke[p.name] = await smoke(p.name);
    }
  }
  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
