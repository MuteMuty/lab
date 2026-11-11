// Build the hub's data files from lab state and GitHub (read-only gh calls).
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const hub = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(hub, "public", "data");
mkdirSync(out, { recursive: true });

const gh = (args) => {
  const r = spawnSync("gh", args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`gh ${args.join(" ")} failed: ${r.stderr}`);
  return JSON.parse(r.stdout || "[]");
};

const projects = JSON.parse(readFileSync(join(hub, "projects.json"), "utf8"));
writeFileSync(join(out, "projects.json"), JSON.stringify(projects));

const allow = JSON.parse(readFileSync(join(hub, "..", "nightshift", "projects.json"), "utf8"));
const repos = [...new Set(allow.filter((p) => p.public).map((p) => p.repo))];
const changes = repos.flatMap((repo) =>
  gh(["pr", "list", "-R", repo, "--state", "merged", "--limit", "30", "--json", "title,url,mergedAt"])
    .map((pr) => ({ repo, title: pr.title, url: pr.url, mergedAt: pr.mergedAt })),
).sort((a, b) => b.mergedAt.localeCompare(a.mergedAt)).slice(0, 30);
writeFileSync(join(out, "changelog.json"), JSON.stringify(changes));

const roadmap = gh(["issue", "list", "-R", "MuteMuty/lab", "--state", "open", "--limit", "50", "--json", "number,title,url,labels"])
  .filter((i) => i.labels.some((l) => ["idea", "suggestion"].includes(l.name)) && !i.labels.some((l) => l.name === "parked"))
  .map((i) => ({ number: i.number, title: i.title, url: i.url, fromVisitor: i.labels.some((l) => l.name === "suggestion") }));
writeFileSync(join(out, "roadmap.json"), JSON.stringify(roadmap));

console.log(`hub data: ${projects.length} projects, ${changes.length} changes, ${roadmap.length} roadmap items`);
