#!/usr/bin/env node
// Pre-flight: decide what kind of night this is, before any model work.
// CLI prints one JSON object: { go, mode, reason, dial, recover, date, pull, smoke }.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { LAB, readJson, localDate, run, loadConfig, loadProjects, projectDir } from "./lib.mjs";
import { resolveDial, DIAL_FILE } from "./dial.mjs";
import { findUnfinished } from "./log.mjs";
import { smoke } from "./smoke.mjs";

const minutes = (hhmm) => { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m; };

/** Pure decision. */
export function decide({ now, dialRaw, stopExists, dryRun, recover, force }) {
  const cfg = loadConfig() ?? { windowStart: "01:30", windowEnd: "05:30" };
  const dial = resolveDial(dialRaw, now);
  const date = localDate(now);
  const out = (go, mode, reason) => ({ go, mode, reason, dial, recover: recover ?? null, date });
  if (stopExists) return out(false, "stop", "STOP file present");
  if (dryRun) return out(true, "dry-run", "rehearsal");
  if (dial.tasks === 0) return out(true, "maintenance", "dial is off");
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
  });
  if (result.go) {
    const repos = [...new Map(loadProjects().map((p) => [p.repo, projectDir(p).replace(/\/hub$/, "")])).entries()];
    result.pull = repos.map(([repo, dir]) => {
      const r = run("git", ["-C", dir, "pull", "--ff-only", "-q"]);
      return { repo, ok: r.code === 0, error: r.code ? r.stderr.trim().slice(0, 300) : undefined };
    });
    result.smoke = {};
    for (const p of loadProjects().filter((p) => p.public)) {
      if (existsSync(join(projectDir(p), "lab.json"))) result.smoke[p.name] = await smoke(p.name);
    }
  }
  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
