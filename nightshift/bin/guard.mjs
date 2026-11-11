#!/usr/bin/env node
// Command guard: a Claude Code PreToolUse hook that mechanically enforces the
// night shift's safety rules (spec 5.12). Exit 2 blocks the tool call; the
// reason on stderr is shown to the agent.
//
// It is defence in depth, not a sandbox: it parses shell commands
// conservatively and refuses anything it can't understand that looks dangerous.
import { readFileSync, appendFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { join, resolve, dirname, basename } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const SAFE_DEVICES = new Set(["/dev/null", "/dev/stdout", "/dev/stderr", "/dev/tty"]);
const SYSTEM_CMDS = new Set([
  "sudo", "doas", "pmset", "launchctl", "defaults", "crontab", "diskutil", "shutdown", "reboot", "halt",
  "csrutil", "networksetup", "scutil", "systemsetup", "osascript", "spctl", "dscl", "security",
]);
const WRANGLER_OK = new Set(["deploy", "rollback", "versions", "deployments", "d1", "dev", "whoami", "tail", "secret", "types", "check"]);
const WRANGLER_WORKER_SCOPED = new Set(["deploy", "rollback", "versions", "deployments", "tail", "secret"]);
const D1_DB_SCOPED = new Set(["execute", "migrations", "export", "info", "time-travel"]);
const GH_BLOCKED = new Set(["secret", "ssh-key", "gpg-key", "config", "extension", "alias", "codespace", "variable", "ruleset"]);
const RISKY_WORDS = /\b(rm|rmdir|mv|dd|sudo|push|wrangler|gh|find|truncate|shred)\b/;

// ---------------------------------------------------------------- parsing

/** Pull out $( … ) and ` … ` bodies (outside single quotes); replace them with a placeholder. */
function extractSubstitutions(str) {
  const subs = [];
  let out = "";
  let q = null;
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (q === "'") { out += c; if (c === "'") q = null; continue; }
    if (c === "\\" && i + 1 < str.length) { out += c + str[i + 1]; i++; continue; }
    if (c === "'" && !q) { q = "'"; out += c; continue; }
    if (c === '"') { q = q === '"' ? null : '"'; out += c; continue; }
    if (c === "$" && str[i + 1] === "(") {
      let depth = 1, j = i + 2;
      for (; j < str.length && depth > 0; j++) {
        if (str[j] === "(") depth++;
        else if (str[j] === ")") depth--;
      }
      if (depth !== 0) return { error: true };
      subs.push(str.slice(i + 2, j - 1));
      out += "$__SUBST__";
      i = j - 1;
      continue;
    }
    if (c === "`") {
      const j = str.indexOf("`", i + 1);
      if (j < 0) return { error: true };
      subs.push(str.slice(i + 1, j));
      out += "$__SUBST__";
      i = j;
      continue;
    }
    out += c;
  }
  if (q) return { error: true };
  return { text: out, subs };
}

/** Split into segments of words, with redirection targets per segment. */
function tokenize(str) {
  const segments = [];
  let words = [], redirects = [], cur = null, q = null, redirectNext = false;
  const pushWord = () => {
    if (cur === null) return;
    if (redirectNext) { redirects.push(cur); redirectNext = false; }
    else words.push(cur);
    cur = null;
  };
  const endSegment = () => {
    pushWord();
    if (words.length || redirects.length) segments.push({ words, redirects });
    words = []; redirects = [];
  };
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (q) {
      if (c === q) q = null;
      else if (c === "\\" && q === '"' && i + 1 < str.length) cur += str[++i];
      else cur += c;
      continue;
    }
    if (c === "'" || c === '"') { q = c; cur = cur ?? ""; continue; }
    if (c === "\\" && i + 1 < str.length) { cur = (cur ?? "") + str[++i]; continue; }
    if (c === " " || c === "\t") { pushWord(); continue; }
    if (c === "\n" || c === ";" || c === "|" || c === "&" || c === "(" || c === ")") {
      if (c === "&" && str[i + 1] === ">") { pushWord(); redirectNext = true; i++; if (str[i + 1] === ">") i++; continue; }
      if (c === "&" && cur === null && words.length === 0 && redirectNext) continue;
      endSegment();
      if ((c === "&" || c === "|") && str[i + 1] === c) i++;
      continue;
    }
    if (c === ">") {
      if (cur !== null && /^\d$/.test(cur)) cur = null; // 2> file
      pushWord();
      if (str[i + 1] === ">") i++;
      if (str[i + 1] === "&") { // 2>&1
        i++;
        while (i + 1 < str.length && /\d|-/.test(str[i + 1])) i++;
        continue;
      }
      redirectNext = true;
      continue;
    }
    if (c === "<") { pushWord(); continue; }
    cur = (cur ?? "") + c;
  }
  if (q) return { error: true };
  endSegment();
  return { segments };
}

// ---------------------------------------------------------------- policy

function makeCtx(opts) {
  const tmp = [...new Set([...(opts.tmp ?? []), "/tmp", "/private/tmp"])].map((p) => p.replace(/\/$/, ""));
  const cache = new Map();
  const inLab = (p) => p === opts.lab || p.startsWith(opts.lab + "/");
  const worktree = (p) => {
    if (!opts.commonDirOf) return false;
    if (!cache.has(p)) {
      const cd = opts.commonDirOf(p);
      cache.set(p, !!cd && inLab(resolve(cd)));
    }
    return cache.get(p);
  };
  return {
    ...opts,
    allowed(p) {
      if (p === null) return false;
      if (SAFE_DEVICES.has(p)) return true;
      if (inLab(p)) return true;
      if (tmp.some((t) => p === t || p.startsWith(t + "/"))) return true;
      return worktree(p);
    },
    protectedPath(p) {
      if (p === null) return false;
      return /\/nightshift\/SAFETY\.md$/.test(p) || /\/nightshift\/bin\/guard\.mjs$/.test(p) ||
        /\/\.claude\/settings(\.local)?\.json$/.test(p);
    },
  };
}

/** Resolve a shell word to an absolute path, or null if it depends on something unknown. */
function toPath(word, cwd, ctx) {
  if (word === undefined) return null;
  let w = word;
  w = w.replace(/^~(?=\/|$)/, ctx.home).replace(/\$\{?HOME\}?/g, ctx.home);
  // The night shift's own shorthands (DIRECTOR.md): LAB and NS.
  w = w.replace(/\$\{LAB\}|\$LAB(?![A-Za-z0-9_])/g, ctx.lab).replace(/\$\{NS\}|\$NS(?![A-Za-z0-9_])/g, `${ctx.lab}/lab/nightshift/bin`);
  const tmpdirEnv = (ctx.env?.TMPDIR ?? "").replace(/\/$/, "");
  if (tmpdirEnv) w = w.replace(/\$\{?TMPDIR\}?/g, tmpdirEnv);
  if (w.includes("$") || w.includes("`")) return null;
  const glob = w.search(/[*?[{]/);
  if (glob >= 0) w = w.slice(0, glob) || ".";
  if (!w.startsWith("/")) {
    if (cwd === null) return null;
    w = join(cwd, w);
  }
  return resolve(w);
}

const isFlag = (w) => w.startsWith("-") && w !== "-";
const nonFlags = (args) => args.filter((a) => !isFlag(a));

function stripCommand(words) {
  let i = 0;
  while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) i++;
  let w = words.slice(i);
  // wrappers
  for (;;) {
    const name = w[0] && basename(w[0]);
    if (["env", "command", "exec", "nohup", "time", "nice", "builtin"].includes(name)) {
      w = w.slice(1);
      while (w.length && (isFlag(w[0]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0]))) w = w.slice(1);
      continue;
    }
    if (["npx", "bunx", "pnpx"].includes(name) || (name === "pnpm" && w[1] === "dlx") || (name === "npm" && w[1] === "exec")) {
      w = w.slice(name === "pnpm" || name === "npm" ? 2 : 1);
      while (w.length && isFlag(w[0])) w = w.slice(1);
      if (w[0]) w = [w[0].replace(/@[^/]*$/, ""), ...w.slice(1)];
      continue;
    }
    break;
  }
  return w;
}

function flagValue(args, ...names) {
  for (let i = 0; i < args.length; i++) {
    for (const n of names) {
      if (args[i] === n) return args[i + 1];
      if (args[i].startsWith(n + "=")) return args[i].slice(n.length + 1);
    }
  }
  return undefined;
}

function checkGitPush(args) {
  for (const a of args) {
    if (["--force", "--force-with-lease", "--mirror", "--all", "--prune", "--delete", "-d", "--tags"].includes(a) || a.startsWith("--force")) {
      return `git push ${a} is not allowed`;
    }
    if (/^-[a-zA-Z]*[fd]/.test(a) && !a.startsWith("--")) return `git push ${a} is not allowed`;
  }
  const rest = nonFlags(args).filter((a, i, arr) => !(i > 0 && ["-o", "--push-option", "--repo"].includes(arr[i - 1])));
  for (const spec of rest.slice(1)) {
    if (spec.startsWith("+")) return "force refspecs (+ref) are not allowed";
    const dest = (spec.includes(":") ? spec.split(":")[1] : spec).replace(/^refs\/heads\//, "");
    if (dest === "") return "deleting remote branches is not allowed";
    if (!(dest === "main" || dest === "HEAD" || dest.startsWith("night/"))) return `pushing to "${dest}" is not allowed (only main and night/*)`;
  }
  return null;
}

function checkSegment(seg, state, ctx) {
  for (const r of seg.redirects) {
    const p = toPath(r, state.cwd, ctx);
    if (!ctx.allowed(p)) return `writing to ${r} (outside the lab) is not allowed`;
    if (ctx.protectedPath(p)) return `writing to ${r} is not allowed`;
  }
  const words = stripCommand(seg.words);
  if (!words.length) return null;
  const cmd = basename(words[0]);
  const args = words.slice(1);
  const pathsAllowed = (list, what) => {
    for (const a of list) {
      const p = toPath(a, state.cwd, ctx);
      if (!ctx.allowed(p)) return `${what} ${a} is outside the lab`;
      if (ctx.protectedPath(p)) return `${what} ${a} is a protected file`;
    }
    return null;
  };

  if (SYSTEM_CMDS.has(cmd)) return `${cmd} is not allowed (system changes)`;

  switch (cmd) {
    case "cd": case "pushd": {
      const target = args.filter((a) => !isFlag(a))[0];
      state.cwd = target === undefined ? ctx.home : toPath(target, state.cwd, ctx);
      return null;
    }
    case "bash": case "sh": case "zsh": case "dash": {
      const i = args.indexOf("-c");
      if (i >= 0) return checkCommand(args[i + 1] ?? "", state.cwd, ctx);
      return null;
    }
    case "eval":
      return checkCommand(args.join(" "), state.cwd, ctx);
    case "xargs":
      if (args.some((a) => /^(rm|rmdir|mv|shred|truncate|chmod|chown)$/.test(basename(a)))) return "xargs with destructive commands is not allowed";
      return null;
    case "rm": case "rmdir": case "unlink": case "shred": case "tee": case "touch": case "mkdir":
      return pathsAllowed(nonFlags(args), cmd);
    case "truncate":
      return pathsAllowed(nonFlags(args).filter((a, i, arr) => !(i === 0 && flagValue(args, "-s") === a)), cmd);
    case "chmod": case "chown": case "chgrp":
      return pathsAllowed(nonFlags(args).slice(1), cmd);
    case "mv":
      return pathsAllowed(nonFlags(args), cmd);
    case "cp": case "ln": case "install": {
      const nf = nonFlags(args);
      return pathsAllowed(nf.slice(-1), cmd);
    }
    case "rsync": {
      const nf = nonFlags(args);
      return pathsAllowed(args.some((a) => a.startsWith("--delete")) ? nf : nf.slice(-1), cmd);
    }
    case "sed": case "perl": {
      if (!args.some((a) => /^-i/.test(a) || /^-[a-zA-Z]*i/.test(a))) return null;
      return pathsAllowed(nonFlags(args).slice(1), `${cmd} -i`);
    }
    case "dd": {
      const of = args.find((a) => a.startsWith("of="));
      return of ? pathsAllowed([of.slice(3)], "dd of=") : null;
    }
    case "find": {
      const destructive = args.includes("-delete") ||
        args.some((a, i) => (a === "-exec" || a === "-execdir" || a === "-ok") && /^(rm|mv|shred|truncate)$/.test(basename(args[i + 1] ?? "")));
      if (!destructive) return null;
      const roots = [];
      for (const a of args) { if (isFlag(a) || a === "(" || a === "!") break; roots.push(a); }
      return pathsAllowed(roots.length ? roots : ["."], "find");
    }
    case "git": {
      let cwd = state.cwd;
      const c = flagValue(args, "-C");
      if (c !== undefined) cwd = toPath(c, state.cwd, ctx);
      const sub = args.filter((a, i) => !isFlag(a) && !(i > 0 && args[i - 1] === "-C"))[0];
      if (sub === "clone") {
        const nf = nonFlags(args).slice(1);
        const dest = nf[1] ? toPath(nf[1], cwd, ctx) : cwd;
        if (!ctx.allowed(dest)) return "git clone outside the lab is not allowed";
        return null;
      }
      if (!ctx.allowed(cwd)) return "git outside the lab is not allowed";
      if (sub === "push") return checkGitPush(args.slice(args.indexOf("push") + 1));
      if (sub === "filter-branch" || sub === "filter-repo") return `git ${sub} is not allowed`;
      if (sub === "add" && args.some((a) => a.includes(".secrets"))) return "secrets must never be committed";
      return null;
    }
    case "gh": {
      const nf = nonFlags(args);
      const [group, action] = nf;
      if (group === "auth" && action !== "status") return "gh auth commands are not allowed";
      if (GH_BLOCKED.has(group)) return `gh ${group} is not allowed`;
      if (group === "repo" && action === "delete") return "deleting repositories is not allowed";
      if (group === "repo" && action === "edit") {
        const ok = new Set(["--visibility", "--accept-visibility-change-consequences", "--description", "--homepage", "--add-topic", "-d", "-h"]);
        for (let i = 0; i < args.length; i++) {
          if (isFlag(args[i]) && !ok.has(args[i].split("=")[0])) return `gh repo edit ${args[i]} is not allowed`;
        }
        const vis = flagValue(args, "--visibility");
        if (vis !== undefined && vis !== "public") return "only making a repo public is allowed";
      }
      if (group === "api") {
        const method = (flagValue(args, "-X", "--method") ?? "GET").toUpperCase();
        if (method !== "GET" || args.some((a) => ["-f", "-F", "--field", "--raw-field", "--input"].includes(a.split("=")[0]))) {
          return "gh api may only read (GET)";
        }
      }
      const repoFlag = flagValue(args, "-R", "--repo");
      const repoInArgs = /MuteMuty\//.test(args.join(" "));
      if (!repoFlag && !repoInArgs && !ctx.allowed(state.cwd)) return "gh outside a lab repo is not allowed";
      return null;
    }
    case "wrangler": {
      const nf = nonFlags(args);
      const sub = nf[0];
      if (!WRANGLER_OK.has(sub)) return `wrangler ${sub ?? ""} is not allowed`;
      if (WRANGLER_WORKER_SCOPED.has(sub)) {
        let name = flagValue(args, "--name");
        if (!name) {
          const config = flagValue(args, "--config", "-c");
          const dir = config ? dirname(toPath(config, state.cwd, ctx) ?? "/") : state.cwd;
          name = dir ? ctx.readWorkerName(dir) : null;
        }
        if (!ctx.allowWorkers.includes(name)) return `wrangler ${sub} for worker "${name}" is not allowed`;
      }
      if (sub === "d1") {
        const d1sub = nf[1];
        if (d1sub === "delete") return "deleting databases is not allowed";
        if (D1_DB_SCOPED.has(d1sub)) {
          const db = d1sub === "migrations" ? nf[3] : nf[2];
          if (!ctx.allowD1.includes(db)) return `database "${db}" is not a lab database`;
        }
      }
      return null;
    }
    case "curl": case "wget": {
      const joined = args.join(" ");
      if (!/api\.cloudflare\.com/.test(joined)) return null;
      const method = (flagValue(args, "-X", "--request", "--method") ?? "GET").toUpperCase();
      const sendsData = args.some((a) => /^(-d|--data.*|-F|--form|-T|--upload-file|--post-data|--post-file)$/.test(a.split("=")[0]));
      if (method !== "GET" || sendsData) return "changing Cloudflare through its API directly is not allowed";
      return null;
    }
    default:
      return null;
  }
}

function checkCommand(command, cwd, ctx) {
  if (/breza/i.test(command)) return "anything mentioning Breza is off limits";
  const sub = extractSubstitutions(command);
  if (sub.error) return RISKY_WORDS.test(command) ? "could not parse this command safely" : null;
  for (const s of sub.subs) {
    const r = checkCommand(s, cwd, ctx);
    if (r) return r;
  }
  for (const m of command.matchAll(/(?:github\.com[/:]|\b)MuteMuty\/([A-Za-z0-9_.-]+)/g)) {
    const repo = m[1].replace(/\.git$/, "").replace(/\.+$/, "");
    if (!ctx.allowRepos.includes(repo)) return `repository MuteMuty/${repo} is not a lab repo`;
  }
  const t = tokenize(sub.text);
  if (t.error) return RISKY_WORDS.test(command) ? "could not parse this command safely" : null;
  const state = { cwd };
  for (const seg of t.segments) {
    const r = checkSegment(seg, state, ctx);
    if (r) return r;
  }
  return null;
}

/** Decide one hook call. */
export function check(input, opts) {
  const ctx = makeCtx(opts);
  const tool = input.tool_name;
  const ti = input.tool_input ?? {};
  const cwd = input.cwd ?? null;
  let reason = null;
  if (tool === "Bash") {
    reason = checkCommand(String(ti.command ?? ""), cwd, ctx);
  } else if (["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(tool)) {
    const raw = ti.file_path ?? ti.notebook_path;
    const p = raw ? toPath(String(raw), cwd, ctx) : null;
    if (/breza/i.test(String(raw ?? ""))) reason = "anything mentioning Breza is off limits";
    else if (!ctx.allowed(p)) reason = `writing ${raw} (outside the lab) is not allowed`;
    else if (ctx.protectedPath(p)) reason = `${raw} is protected; only Erik edits it`;
  }
  return reason ? { allow: false, reason } : { allow: true };
}

// ---------------------------------------------------------------- hook entry point

function defaultCommonDirOf(p) {
  let dir = p;
  while (dir !== "/" && !existsSync(dir)) dir = dirname(dir);
  const r = spawnSync("git", ["-C", dir, "rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

function defaultReadWorkerName(dir) {
  for (const f of ["wrangler.jsonc", "wrangler.json", "wrangler.toml"]) {
    try {
      const text = readFileSync(join(dir, f), "utf8");
      const m = f.endsWith(".toml") ? text.match(/^\s*name\s*=\s*"([^"]+)"/m) : text.match(/"name"\s*:\s*"([^"]+)"/);
      if (m) return m[1];
    } catch {}
  }
  return null;
}

function liveOptions() {
  const lab = process.env.LAB_ROOT || join(homedir(), "brightloop-lab");
  const here = dirname(fileURLToPath(import.meta.url));
  let projects = [];
  try { projects = JSON.parse(readFileSync(join(here, "..", "projects.json"), "utf8")); } catch {}
  return {
    lab,
    home: homedir(),
    tmp: [tmpdir()],
    env: process.env,
    allowRepos: [...new Set(projects.map((p) => p.repo.split("/")[1]))],
    allowWorkers: projects.map((p) => p.worker),
    allowD1: projects.flatMap((p) => p.d1 ?? []),
    commonDirOf: defaultCommonDirOf,
    readWorkerName: defaultReadWorkerName,
  };
}

async function main() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  let input;
  try { input = JSON.parse(raw); } catch { process.exit(0); }
  const opts = liveOptions();
  // Only guard sessions working in the lab (or a lab worktree).
  const ctx = makeCtx(opts);
  const cwd = input.cwd ? resolve(input.cwd) : null;
  const tmpLike = cwd && opts.tmp.some((t) => cwd.startsWith(t));
  if (!cwd || !(ctx.allowed(cwd) && !tmpLike)) process.exit(0);
  const r = check(input, opts);
  if (r.allow) process.exit(0);
  try {
    appendFileSync(join(opts.lab, "nightshift-blocked.jsonl"),
      JSON.stringify({ time: new Date().toISOString(), tool: input.tool_name, input: input.tool_input, cwd, reason: r.reason }) + "\n");
  } catch {}
  process.stderr.write(`Blocked by the night shift guard: ${r.reason}. See lab/nightshift/SAFETY.md.\n`);
  process.exit(2);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
