#!/usr/bin/env node
// Command guard: a Claude Code PreToolUse hook that mechanically enforces the
// night shift's safety rules (spec 5.12). Exit 2 blocks the tool call; the
// reason on stderr is shown to the agent.
//
// It is defence in depth, not a sandbox: it parses shell commands
// conservatively, fails closed on anything it can't understand that could
// write or delete, and fails closed on its own errors.
import { readFileSync, appendFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { join, resolve, dirname, basename } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const SAFE_DEVICES = new Set(["/dev/null", "/dev/stdout", "/dev/stderr", "/dev/tty"]);
const SYSTEM_CMDS = new Set([
  "sudo", "doas", "pmset", "launchctl", "defaults", "crontab", "diskutil", "shutdown", "reboot", "halt",
  "csrutil", "networksetup", "scutil", "systemsetup", "osascript", "spctl", "dscl", "security", "killall",
]);
// Shell keywords that can start a segment; the real command follows them.
const RESERVED = new Set(["if", "then", "elif", "else", "fi", "do", "done", "while", "until", "{", "}", "!", "time", "case", "esac"]);
const WRANGLER_OK = new Set(["dev", "whoami", "types", "check", "d1", "deployments", "versions", "tail"]);
const WRANGLER_VIA_HELPER = new Set(["deploy", "rollback", "secret", "delete", "publish"]);
const WRANGLER_WORKER_SCOPED = new Set(["deployments", "versions", "tail"]);
const D1_DB_SCOPED = new Set(["execute", "migrations", "export", "info", "time-travel"]);
const GH_BLOCKED = new Set(["secret", "ssh-key", "gpg-key", "config", "extension", "alias", "codespace", "variable", "ruleset"]);
const RISKY = /\b(rm|rmdir|unlink|mv|cp|ln|dd|tee|sed|perl|tar|chmod|chown|truncate|shred|find|xargs|sudo|push|wrangler|gh|kill|pkill|killall)\b|>/;
const DEV_SERVER = /vite|wrangler|preview|playwright|--port|http\.server/;

// ---------------------------------------------------------------- parsing

/** Remove here-doc bodies (their text is data) and whole-line comments. */
function stripHeredocsAndComments(str) {
  const out = [];
  let delim = null, dash = false;
  for (const line of str.split("\n")) {
    if (delim !== null) {
      if ((dash ? line.replace(/^\t+/, "") : line).trim() === delim) delim = null;
      continue;
    }
    if (/^\s*#/.test(line)) continue;
    const re = /<<(-?)\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/g;
    let m, kept = line;
    while ((m = re.exec(line))) {
      if (line[m.index - 1] === "<" || line[m.index + 2] === "<") continue; // here-string
      delim = m[3];
      dash = m[1] === "-";
      kept = line.slice(0, m.index) + line.slice(m.index + m[0].length);
      break;
    }
    out.push(kept);
  }
  return out.join("\n");
}

/** Pull out $( … ) and ` … ` bodies (outside single quotes); replace them with a placeholder. */
function extractSubstitutions(str) {
  const subs = [];
  let out = "";
  let q = null;
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (q === "'") { out += c; if (c === "'") q = null; continue; }
    if (c === "\\" && i + 1 < str.length) { out += c + str[i + 1]; i++; continue; }
    if (!q && c === "#" && (i === 0 || /\s/.test(str[i - 1]))) { // inline comment
      while (i < str.length && str[i] !== "\n") i++;
      out += "\n";
      continue;
    }
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
  // For each segment, remember the paren depth and the separators before and after it,
  // so the policy can tell whether a variable assignment is sure to run in this shell.
  let depth = 0, prev = "start", unbalanced = false;
  const pushWord = () => {
    if (cur === null) return;
    if (redirectNext) { redirects.push(cur); redirectNext = false; }
    else words.push(cur);
    cur = null;
  };
  const endSegment = (sep) => {
    pushWord();
    if (words.length || redirects.length) segments.push({ words, redirects, depth, prev, sep });
    words = []; redirects = [];
    prev = sep;
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
    if (c === "#" && cur === null) { while (i + 1 < str.length && str[i + 1] !== "\n") i++; continue; }
    if (c === " " || c === "\t") { pushWord(); continue; }
    if (c === "\n" || c === ";" || c === "|" || c === "&" || c === "(" || c === ")") {
      if (c === "&" && str[i + 1] === ">") { pushWord(); redirectNext = true; i++; if (str[i + 1] === ">") i++; continue; }
      let sep = c;
      if ((c === "&" || c === "|" || c === ";") && str[i + 1] === c) { i++; sep = c + c; }
      endSegment(sep);
      if (c === "(") depth++;
      if (c === ")") { depth--; if (depth < 0) { unbalanced = true; depth = 0; } }
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
  endSegment("end");
  return { segments, unbalanced: unbalanced || depth !== 0 };
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
    allowRepos: (opts.allowRepos ?? []).map((r) => r.toLowerCase()),
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
        /\/\.claude\/settings(\.local)?\.json$/.test(p) || p.includes("/.secrets");
    },
    /** Deleting or moving these would lose a repo, its history, or the lab itself. */
    precious(p) {
      if (p === null) return false;
      return p === opts.lab || dirname(p) === opts.lab || p.split("/").includes(".git") || p.includes("/.secrets");
    },
  };
}

/** Resolve a shell word to an absolute path, or null if it depends on something unknown. */
function toPath(word, cwd, ctx) {
  if (word === undefined) return null;
  let w = expandVars(word, ctx);
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

/** Replace $NAME / ${NAME} with values this command set for certain (see trackVars). */
function expandVars(word, ctx) {
  if (!ctx.vars?.size) return word;
  return word.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
    (m, a, b) => (ctx.vars.has(a ?? b) ? ctx.vars.get(a ?? b) : m));
}

/** Expand an assignment's value the way the shell would, or null if it depends on something unknown. */
function assignedValue(raw, ctx) {
  let v = expandVars(raw, ctx).replace(/^~(?=\/|$)/, ctx.home).replace(/\$\{?HOME\}?/g, ctx.home);
  v = v.replace(/\$\{LAB\}|\$LAB(?![A-Za-z0-9_])/g, ctx.lab).replace(/\$\{NS\}|\$NS(?![A-Za-z0-9_])/g, `${ctx.lab}/lab/nightshift/bin`);
  return v.includes("$") || v.includes("`") ? null : v;
}

const BLOCK_OPEN = new Set(["if", "while", "until", "for", "select", "case", "{", "function"]);
const BLOCK_CLOSE = new Set(["fi", "done", "esac", "}"]);
const VAR_WRITERS = new Set(["unset", "read", "local", "declare", "typeset", "readonly", "export", "for", "select", "getopts", "mapfile", "readarray", "eval", "source", "."]);
const ASSIGN = /^([A-Za-z_][A-Za-z0-9_]*)\+?=(.*)$/s;

/**
 * Learn variables from plain top-level assignments (`R=…;`, `export R=…;`) that the shell is sure to
 * run in this shell: not in ( ), a pipeline, the background, after && or ||, or inside if/loops/case/{ }.
 * Anything else that might set or clear a variable makes it unknown again, so a path using it fails closed.
 */
function trackVars(seg, state, ctx) {
  const w = seg.words;
  if (!w.length) return;
  const first = w[0];
  const certain = !state.unbalanced && seg.depth === 0 && state.block === 0 &&
    ["start", ";", "\n"].includes(seg.prev) && [";", "&&", "\n", "end"].includes(seg.sep);
  const plain = w.every((x) => ASSIGN.test(x)) && !w.some((x) => /^[A-Za-z_][A-Za-z0-9_]*\+=/.test(x));
  const exported = first === "export" && w.length > 1 && w.slice(1).every((x) => ASSIGN.test(x) && !/^[A-Za-z_][A-Za-z0-9_]*\+=/.test(x));
  if (certain && (plain || exported)) {
    for (const x of exported ? w.slice(1) : w) {
      const [, name, raw] = x.match(ASSIGN);
      const v = assignedValue(raw, ctx);
      if (v === null) ctx.vars.delete(name); else ctx.vars.set(name, v);
    }
  } else {
    for (const x of w) { const m = x.match(ASSIGN); if (m) ctx.vars.delete(m[1]); }
    if (w.some((x) => VAR_WRITERS.has(x))) for (const x of w) if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(x)) ctx.vars.delete(x);
  }
  if (BLOCK_OPEN.has(first)) state.block++;
  if (BLOCK_CLOSE.has(first)) state.block = Math.max(0, state.block - 1);
}

const isFlag = (w) => w.startsWith("-") && w !== "-";
const nonFlags = (args) => args.filter((a) => !isFlag(a));
const isAssignment = (w) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(w);

/** Peel off keywords, env assignments and wrapper commands to find the real command. */
function stripCommand(words) {
  let w = words.slice();
  for (;;) {
    while (w.length && isAssignment(w[0])) w = w.slice(1);
    if (!w.length) return w;
    const name = basename(w[0]);
    if (RESERVED.has(w[0])) { w = w.slice(1); continue; }
    if (w[0] === "for" || w[0] === "select") return []; // loop header: the word list is data
    if (["command", "exec", "nohup", "builtin", "stdbuf"].includes(name)) {
      w = w.slice(1);
      while (w.length && isFlag(w[0])) w = w.slice(1);
      continue;
    }
    if (name === "nice") {
      w = w.slice(1);
      while (w.length && isFlag(w[0])) w = w.slice(w[0] === "-n" ? 2 : 1);
      continue;
    }
    if (name === "timeout" || name === "gtimeout") {
      w = w.slice(1);
      while (w.length && isFlag(w[0])) w = w.slice(["-s", "-k", "--signal", "--kill-after"].includes(w[0]) ? 2 : 1);
      w = w.slice(1); // duration
      continue;
    }
    if (name === "caffeinate") {
      w = w.slice(1);
      while (w.length && isFlag(w[0])) w = w.slice(["-t", "-w"].includes(w[0]) ? 2 : 1);
      continue;
    }
    if (name === "env") {
      w = w.slice(1);
      while (w.length && (isFlag(w[0]) || isAssignment(w[0]))) {
        if (w[0] === "-S" || w[0] === "--split-string") return ["sh", "-c", w[1] ?? ""];
        w = w.slice(["-u", "-C", "--unset", "--chdir"].includes(w[0]) ? 2 : 1);
      }
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

/** git [global options] <subcommand> [args] */
function gitParts(args) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-C" || a === "-c" || a === "--git-dir" || a === "--work-tree" || a === "--namespace") { i++; continue; }
    if (isFlag(a)) continue;
    return { sub: a, rest: args.slice(i + 1) };
  }
  return { sub: undefined, rest: [] };
}

function repoAllowed(ref, ctx) {
  const [owner, name] = ref.replace(/\.git$/, "").split("/");
  return owner?.toLowerCase() === "mutemuty" && ctx.allowRepos.includes((name ?? "").replace(/\.+$/, "").toLowerCase());
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
  const pathsAllowed = (list, what, { deleting = false } = {}) => {
    for (const a of list) {
      const p = toPath(a, state.cwd, ctx);
      if (!ctx.allowed(p)) return `${what} ${a} is outside the lab`;
      if (ctx.protectedPath(p)) return `${what} ${a} is a protected file`;
      if (deleting && ctx.precious(p)) return `${what} ${a} would remove a lab repo, its history, or the lab itself`;
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
      const i = args.findIndex((a) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a));
      if (i >= 0) return checkCommand(args[i + 1] ?? "", state.cwd, ctx);
      return null;
    }
    case "eval":
      return checkCommand(args.join(" "), state.cwd, ctx);
    case "xargs":
      if (args.some((a) => /^(rm|rmdir|mv|shred|truncate|chmod|chown)$/.test(basename(a)))) return "xargs with destructive commands is not allowed";
      return null;
    case "rm": case "rmdir": case "unlink": case "shred":
      return pathsAllowed(nonFlags(args), cmd, { deleting: true });
    case "tee": case "touch": case "mkdir":
      return pathsAllowed(nonFlags(args), cmd);
    case "truncate":
      return pathsAllowed(nonFlags(args).filter((a, i, arr) => !(i === 0 && flagValue(args, "-s") === a)), cmd);
    case "chmod": case "chown": case "chgrp":
      return pathsAllowed(nonFlags(args).slice(1), cmd);
    case "mv":
      return pathsAllowed(nonFlags(args), cmd, { deleting: true });
    case "cp": case "ln": case "install": {
      const nf = nonFlags(args);
      if (nf.length < 2) return null;
      const srcs = nf.slice(0, -1).map((a) => toPath(a, state.cwd, ctx));
      let dest = toPath(nf.at(-1), state.cwd, ctx);
      if (dest && /\/\.claude\/?$/.test(nf.at(-1)) && srcs.length === 1 && srcs[0]) dest = join(dest, basename(srcs[0]));
      if (!ctx.allowed(dest)) return `${cmd} ${nf.at(-1)} is outside the lab`;
      if (ctx.protectedPath(dest)) {
        // Copying the lab's own hook settings into a new lab repo is how new projects get guarded.
        const canonical = cmd === "cp" && srcs.length === 1 && srcs[0] && srcs[0].startsWith(ctx.lab + "/") &&
          /\/\.claude\/settings\.json$/.test(srcs[0]) && /\/\.claude\/settings\.json$/.test(dest);
        if (!canonical) return `${cmd} ${nf.at(-1)} is a protected file`;
      }
      return null;
    }
    case "rsync": {
      const nf = nonFlags(args);
      return pathsAllowed(args.some((a) => a.startsWith("--delete")) ? nf : nf.slice(-1), cmd);
    }
    case "sed": case "perl": {
      if (!args.some((a) => /^-i/.test(a) || /^-[a-zA-Z]*i/.test(a))) return null;
      // sed [-i [suffix]] [-e script]... [script] file...
      const files = [];
      let scriptGiven = false;
      for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === "-i" && (args[i + 1] === "" || /^\.\w*$/.test(args[i + 1] ?? ""))) { i++; continue; }
        if (a === "-e" || a === "-f" || a === "--expression" || a === "--file") { scriptGiven = true; i++; continue; }
        if (isFlag(a)) continue;
        if (!scriptGiven) { scriptGiven = true; continue; }
        files.push(a);
      }
      return pathsAllowed(files, `${cmd} -i`);
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
      return pathsAllowed(roots.length ? roots : ["."], "find", { deleting: true });
    }
    case "pkill": {
      const pattern = nonFlags(args).at(-1) ?? "";
      if (args.includes("-f") && DEV_SERVER.test(pattern)) return null;
      return "pkill may only stop dev servers you started (pkill -f \"vite preview … --port N\"), or use kill <pid>";
    }
    case "kill": {
      const targets = nonFlags(args).filter((a) => !/^-\w+$/.test(a));
      if (targets.every((a) => /^\d+$/.test(a) || /^%\d+$/.test(a))) return null;
      return "kill only takes process ids";
    }
    case "git": {
      let cwd = state.cwd;
      const c = flagValue(args, "-C");
      if (c !== undefined) cwd = toPath(c, state.cwd, ctx);
      const { sub, rest } = gitParts(args);
      if (sub === "clone") {
        const nf = nonFlags(rest);
        const dest = nf[1] ? toPath(nf[1], cwd, ctx) : cwd;
        if (!ctx.allowed(dest)) return "git clone outside the lab is not allowed";
        return null;
      }
      if (!ctx.allowed(cwd)) return "git outside the lab is not allowed";
      if (sub === "push") return checkGitPush(rest);
      if (sub === "filter-branch" || sub === "filter-repo") return `git ${sub} is not allowed`;
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
        for (const a of args) {
          if (isFlag(a) && !ok.has(a.split("=")[0])) return `gh repo edit ${a} is not allowed`;
        }
        const vis = flagValue(args, "--visibility");
        if (vis !== undefined && vis !== "public") return "only making a repo public is allowed";
      }
      if (group === "api") {
        let method = flagValue(args, "-X", "--method");
        for (const a of args) if (/^-X[A-Za-z]+$/.test(a)) method = a.slice(2);
        if ((method ?? "GET").toUpperCase() !== "GET" ||
          args.some((a) => ["-f", "-F", "--field", "--raw-field", "--input"].includes(a.split("=")[0]))) {
          return "gh api may only read (GET)";
        }
      }
      const refs = [];
      const rf = flagValue(args, "-R", "--repo");
      if (rf) refs.push(rf);
      for (const a of args) {
        const m = a.match(/github\.com[/:]([^/\s]+)\/([^/\s#?]+)/i);
        if (m) refs.push(`${m[1]}/${m[2]}`);
      }
      if (group === "repo" && nf[2] && /^[\w.-]+\/[\w.-]+$/.test(nf[2])) refs.push(nf[2]);
      if (group === "api") {
        const m = (nf[1] ?? "").match(/^\/?repos\/([^/]+)\/([^/]+)/);
        if (m) refs.push(`${m[1]}/${m[2]}`);
      }
      for (const r of refs) if (!repoAllowed(r, ctx)) return `gh may only touch lab repos (not ${r})`;
      if (!refs.length && !ctx.allowed(state.cwd)) return "gh outside a lab repo is not allowed";
      return null;
    }
    case "wrangler": {
      const nf = nonFlags(args);
      const sub = nf[0];
      if (WRANGLER_VIA_HELPER.has(sub)) return `wrangler ${sub} is not allowed here: deploy with nightshift/bin/deploy.mjs`;
      if (!WRANGLER_OK.has(sub)) return `wrangler ${sub ?? ""} is not allowed`;
      if (sub === "versions" && !["list", "view"].includes(nf[1])) return "wrangler versions may only be listed";
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
        if (args.includes("--remote")) return "the live database is reached only through nightshift/bin/suggestions.mjs";
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
  if (/\.secrets(\/|\b)/.test(command)) return "the secrets folder stays private (helpers read it themselves)";
  const cleaned = stripHeredocsAndComments(command);
  const failClosed = () => (RISKY.test(cleaned) ? "could not parse this command safely; split it into simpler commands" : null);
  const sub = extractSubstitutions(cleaned);
  if (sub.error) return failClosed();
  for (const s of sub.subs) {
    const r = checkCommand(s, cwd, ctx);
    if (r) return r;
  }
  for (const m of cleaned.matchAll(/(?:github\.com[/:]|\b)MuteMuty\/([A-Za-z0-9_.-]+)/gi)) {
    if (!repoAllowed(`MuteMuty/${m[1]}`, ctx)) return `repository MuteMuty/${m[1].replace(/\.+$/, "")} is not a lab repo`;
  }
  const t = tokenize(sub.text);
  if (t.error) return failClosed();
  const state = { cwd, block: 0, unbalanced: t.unbalanced };
  ctx.vars = new Map();
  for (const seg of t.segments) {
    const r = checkSegment(seg, state, ctx);
    if (r) return r;
    trackVars(seg, state, ctx);
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
  } else if (["Read", "Grep", "Glob"].includes(tool)) {
    const raw = ti.file_path ?? ti.path;
    const p = raw ? toPath(String(raw), cwd, ctx) : cwd;
    const secrets = join(ctx.lab, ".secrets");
    // Reading the secrets folder, or searching a folder that contains it, would put keys in the transcript.
    if (p && (p.startsWith(secrets) || (tool === "Grep" && secrets.startsWith(p + "/")))) reason = "the secrets folder stays private";
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

export function liveOptions() {
  const lab = process.env.LAB_ROOT || join(homedir(), "brightloop-lab");
  const here = dirname(fileURLToPath(import.meta.url));
  let projects = [];
  try { projects = JSON.parse(readFileSync(join(here, "..", "projects.json"), "utf8")); } catch {}
  if (!Array.isArray(projects)) projects = [];
  const valid = projects.filter((p) => p && typeof p === "object");
  return {
    lab,
    home: homedir(),
    tmp: [tmpdir()],
    env: process.env,
    allowRepos: [...new Set(valid.filter((p) => typeof p.repo === "string" && p.repo.includes("/")).map((p) => p.repo.split("/")[1]))],
    allowWorkers: valid.filter((p) => typeof p.worker === "string").map((p) => p.worker),
    allowD1: valid.flatMap((p) => (Array.isArray(p.d1) ? p.d1.filter((d) => typeof d === "string") : [])),
    commonDirOf: defaultCommonDirOf,
    readWorkerName: defaultReadWorkerName,
  };
}

function block(lab, input, reason) {
  try {
    appendFileSync(join(lab, "nightshift-blocked.jsonl"),
      JSON.stringify({ time: new Date().toISOString(), tool: input?.tool_name, input: input?.tool_input, cwd: input?.cwd, reason }) + "\n");
  } catch {}
  process.stderr.write(`Blocked by the night shift guard: ${reason}. See lab/nightshift/SAFETY.md.\n`);
  process.exit(2);
}

async function main() {
  const lab = process.env.LAB_ROOT || join(homedir(), "brightloop-lab");
  let input = null;
  try {
    let raw = "";
    for await (const chunk of process.stdin) raw += chunk;
    input = JSON.parse(raw);
    const r = check({ ...input, cwd: input.cwd ? resolve(input.cwd) : null }, liveOptions());
    if (r.allow) process.exit(0);
    block(lab, input, r.reason);
  } catch (e) {
    // Fail closed: a guard that crashes must not let the command through.
    block(lab, input, `guard error (${e?.message ?? e})`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
