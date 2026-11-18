// Bundles the browser code: the hub page (public/app.js) and the lab's shared analytics script
// (public/analytics/v1.js, posthog-js included). Run by wrangler dev and deploy (see wrangler.jsonc).
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const hub = join(dirname(fileURLToPath(import.meta.url)), "..");
// The public PostHog ingestion key. Without one, the analytics script sends nothing.
const config: { posthog?: { projectKey?: string } } = JSON.parse(readFileSync(join(hub, "..", "nightshift", "config.json"), "utf8"));
const key = config.posthog?.projectKey ?? "";
if (key && !/^phc_\w+$/.test(key)) throw new Error("nightshift/config.json: posthog.projectKey should look like phc_…");

const common = { absWorkingDir: hub, bundle: true, minify: true, target: "es2022", logLevel: "warning" } as const;
await Promise.all([
  build({ ...common, entryPoints: ["web/app.ts"], format: "esm", outfile: "public/app.js" }),
  build({ ...common, entryPoints: ["web/analytics/v1.ts"], format: "iife", outfile: "public/analytics/v1.js", define: { POSTHOG_KEY: JSON.stringify(key) } }),
]);
console.log(`bundled app.js and analytics/v1.js (${key ? "with" : "without"} a PostHog key)`);
