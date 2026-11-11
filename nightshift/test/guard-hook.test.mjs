// Runs guard.mjs the way Claude Code does: JSON on stdin, exit code decides.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const GUARD = process.env.GUARD_PATH || join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "guard.mjs");
const lab = mkdtempSync(join(tmpdir(), "ns-lab-"));
const hook = (stdin) => spawnSync("node", [GUARD], { input: stdin, encoding: "utf8", env: { ...process.env, LAB_ROOT: lab } });
const bash = (command, cwd) => hook(JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd }));

test("blocks a destructive command even when the session cwd is outside the lab", () => {
  const r = bash("rm -rf ~/Documents", join(homedir(), ".t3", "userdata", "attachments"));
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /Blocked by the night shift guard/);
  assert.ok(existsSync(join(lab, "nightshift-blocked.jsonl")));
  assert.match(readFileSync(join(lab, "nightshift-blocked.jsonl"), "utf8"), /Documents/);
});

test("unreadable hook input fails closed", () => {
  const r = hook("this is not json");
  assert.equal(r.status, 2);
  assert.match(r.stderr, /guard error/);
});

test("routine work inside the lab is allowed", () => {
  const r = bash(`ls ${lab}`, lab);
  assert.equal(r.status, 0, r.stderr);
});
