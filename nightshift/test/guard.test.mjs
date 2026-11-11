import { test } from "node:test";
import assert from "node:assert/strict";
import { check } from "../bin/guard.mjs";

const HOME = "/Users/erik";
const LAB = `${HOME}/brightloop-lab`;
const opts = {
  lab: LAB,
  home: HOME,
  tmp: ["/private/tmp/x", "/tmp"],
  allowRepos: ["lab", "afterstep"],
  allowWorkers: ["afterstep", "lab-hub"],
  allowD1: ["lab-hub"],
  env: { TMPDIR: "/private/tmp/x/" },
  // a builder worktree living outside LAB, whose git common dir is inside LAB
  commonDirOf: (p) => (p.startsWith("/wt/afterstep") ? `${LAB}/afterstep/.git` : null),
  readWorkerName: (dir) => ({ [`${LAB}/afterstep`]: "afterstep", "/wt/afterstep": "afterstep", [`${LAB}/other`]: "other-worker" })[dir] ?? null,
};
const bash = (command, cwd = `${LAB}/afterstep`) => check({ tool_name: "Bash", tool_input: { command }, cwd }, opts);
const write = (file_path, tool_name = "Write") => check({ tool_name, tool_input: { file_path }, cwd: LAB }, opts);

const blocked = [
  ["rm -rf ~/Documents", () => bash("rm -rf ~/Documents")],
  ["cd / && rm -rf x", () => bash("cd / && rm -rf x")],
  ["rm via .. escape", () => bash("rm -rf ~/brightloop-lab/../Documents")],
  ["bash -c rm home", () => bash('bash -c "rm -rf ~"')],
  ["$(...) rm", () => bash("echo $(rm -rf /Users/erik/Desktop)")],
  ["sudo", () => bash("sudo pmset -a sleep 0")],
  ["force push", () => bash("git push --force origin main")],
  ["plus refspec", () => bash("git push origin +main")],
  ["push other branch", () => bash("git push origin main:release")],
  ["delete repo", () => bash("gh repo delete MuteMuty/afterstep --yes")],
  ["foreign repo", () => bash("gh pr list -R MuteMuty/resume")],
  ["foreign repo url", () => bash("git clone https://github.com/MuteMuty/CleanPath.git")],
  ["wrangler dns", () => bash("npx wrangler dns records delete x")],
  ["deploy foreign worker", () => bash("npx wrangler deploy", `${LAB}/other`)],
  ["breza anywhere", () => bash("cat ~/x/breza-notes.txt")],
  ["write zshrc", () => write(`${HOME}/.zshrc`)],
  ["edit SAFETY.md", () => write(`${LAB}/lab/nightshift/SAFETY.md`, "Edit")],
  ["edit guard", () => write(`${LAB}/lab/nightshift/bin/guard.mjs`, "Edit")],
  ["edit settings", () => write(`${LAB}/afterstep/.claude/settings.json`)],
  ["redirect outside", () => bash("echo hi > ~/notes.txt")],
  ["mv out of lab", () => bash("mv ~/brightloop-lab/afterstep ~/Desktop/")],
  ["find delete outside", () => bash("find ~/Downloads -name '*.zip' -delete")],
  ["curl cloudflare mutate", () => bash("curl -X DELETE https://api.cloudflare.com/client/v4/zones/1/dns_records/2")],
  ["gh auth token", () => bash("gh auth token")],
  ["git add secrets", () => bash("git add ../.secrets/cloudflare.env")],
  ["unbalanced quote rm", () => bash("rm -rf 'oops")],
  ["unknown var path", () => bash("rm -rf $SOMEWHERE/x")],
  ["$LAB escape", () => bash("rm -rf $LAB/../Documents")],
  ["foreign repo with full stop", () => bash('echo "see MuteMuty/resume."')],
  ["sed -i outside the lab", () => bash("sed -i '' 's/a/b/' ~/.zshrc")],
  ["d1 other database", () => bash("npx wrangler d1 execute prod-db --remote --command 'drop table x'")],
  ["wrangler login", () => bash("npx wrangler logout")],
];
const allowed = [
  ["rm dist", () => bash("rm -rf ~/brightloop-lab/afterstep/web/dist")],
  ["rm relative in lab", () => bash("rm -rf web/dist && npm run build")],
  ["rm tmp", () => bash("rm -rf $TMPDIR/x")],
  ["push night branch", () => bash("git push -u origin night/2026-11-12-foo")],
  ["push main", () => bash("git push origin main")],
  ["plain push", () => bash("git push")],
  ["merge pr", () => bash("gh pr merge 3 -R MuteMuty/afterstep --squash")],
  ["make public", () => bash("gh repo edit MuteMuty/afterstep --visibility public --accept-visibility-change-consequences")],
  ["deploy afterstep", () => bash("npx wrangler deploy")],
  ["deploy from worktree", () => bash("npx wrangler@4.160.0 deploy", "/wt/afterstep")],
  ["rm in worktree", () => bash("rm -rf node_modules", "/wt/afterstep")],
  ["d1 lab-hub", () => bash('npx wrangler d1 execute lab-hub --remote --command "select 1"')],
  ["write readme", () => write(`${LAB}/afterstep/README.md`)],
  ["write tmp", () => write("/private/tmp/x/notes.md")],
  ["cargo test", () => bash("PATH=$HOME/.cargo/bin:$PATH cargo test --release")],
  ["redirect in lab", () => bash("node gen.mjs > web/public/data.json 2>/dev/null")],
  ["grep pipe", () => bash("git log --oneline | head -5")],
  ["gh issue create", () => bash("gh issue create -R MuteMuty/lab -t 'x' -F /private/tmp/x/body.md")],
  ["git -C $LAB worktree remove", () => bash("git -C $LAB/afterstep worktree remove $LAB/.worktrees/night-x --force", "/wt/afterstep")],
  ["${LAB} braces", () => bash("rm -rf ${LAB}/.worktrees/playtest-x")],
  ["lab repo before a full stop", () => bash('node log.mjs note 2026-11-11 "pushed to MuteMuty/lab."')],
  ["sed -i with empty suffix (macOS)", () => bash("sed -i '' 's/0.85rem/0.9rem/' web/src/style.css")],
  ["sed -i script with anchors and parens", () => bash("sed -i '' 's/^  board.focus({ preventScroll: true });$/  \\/\\/ NEG/' web/src/main.ts")],
  ["sed -i -e expression", () => bash("sed -i.bak -e 's/a/b/' -e 's/c/d/' web/src/style.css")],
  ["wrangler rollback", () => bash("npx wrangler rollback abc --message 'auto' -y")],
];

for (const [name, fn] of blocked) test(`blocks: ${name}`, () => assert.equal(fn().allow, false, JSON.stringify(fn())));
for (const [name, fn] of allowed) test(`allows: ${name}`, () => assert.equal(fn().allow, true, JSON.stringify(fn())));
