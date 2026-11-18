// Usage: what PostHog counted for each lab project (lab#72), so real use, not only likes, steers the work.
// Pre-flight calls `fetchUsage` and `usageTrend`; the night log records `usage` so later nights can compare.
//
// The key: ~/brightloop-lab/.secrets/posthog.env holds POSTHOG_PERSONAL_API_KEY (read-only, "Query: Read",
// one project) and POSTHOG_PROJECT_ID. This file reads it itself, as deploy.ts reads cloudflare.env, and
// the key goes only into the Authorization header: never into a result, an error, a log or a report.
// No env file, a failed call or a strange answer all give null, and the night goes on as before.
//
// What is counted (the lab-wide convention in lab/hub/web/analytics/guard.ts; every event carries `project`):
//   visitors  distinct visitors with a `$pageview`. Cookieless mode hashes visitors per day, so over a week
//             this is roughly the sum of each day's visitors: a fair trend, not an exact head count.
//   started   `play_started` events; finished: `play_finished` events.
import { join } from "node:path";
import { LAB, loadConfig, type Project } from "./lib.ts";
import { loadEnvFile } from "./deploy.ts";

export const POSTHOG_ENV_FILE = join(LAB, ".secrets", "posthog.env");
/** The private API host (EU cloud), not the `eu.i.` ingestion host the pages send to. */
export const DEFAULT_API_HOST = "https://eu.posthog.com";

/** One project's last 7 days, plus the 14-day numbers the stall signal needs. */
export type ProjectUsage = {
  visitors: number; started: number; finished: number;
  /** finished / started, rounded to 2 places; null with no starts. */
  finishRate: number | null;
  visitors14: number; finished14: number;
  /** The project's first event in the last 30 days (YYYY-MM-DD). */
  firstSeen: string;
};
export type Usage = Record<string, ProjectUsage>;

export type UsageTrend = {
  /** "Usage this week: afterstep 140 visitors, 61% finish (+5) · inkchime 38 visitors, 22% finish (new)" */
  line: string;
  /** The last earlier day with a `usage:` record, which the (+n) compares with. */
  previous: string | null;
  /** Launched projects with 30+ starts this week and a finish rate under half the median: scout these first. */
  stuck: string[];
  /** The median finish rate those are compared with (projects with 30+ starts); null when none qualify. */
  median: number | null;
  /** Launched projects seen for 14+ days with 20+ visitors in the last 14 days but almost no finishes (≤5%). For Erik. */
  stalled: string[];
};

export const USAGE_QUERY = `select properties.project as project,
  uniqIf(distinct_id, event = '$pageview' and timestamp > now() - interval 7 day) as visitors,
  countIf(event = 'play_started' and timestamp > now() - interval 7 day) as started,
  countIf(event = 'play_finished' and timestamp > now() - interval 7 day) as finished,
  uniqIf(distinct_id, event = '$pageview' and timestamp > now() - interval 14 day) as visitors14,
  countIf(event = 'play_finished' and timestamp > now() - interval 14 day) as finished14,
  min(timestamp) as first_seen
from events
where timestamp > now() - interval 30 day and properties.project is not null
group by project`;

const PROJECT = /^[a-z0-9-]{1,40}$/;
const count = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 0;
const rate = (finished: number, started: number) => (started > 0 ? Math.round((finished / started) * 100) / 100 : null);

type FetchLike = (url: string, init?: RequestInit) => Promise<Pick<Response, "status" | "json">>;

/** The last 7 days per project, or null on any failure (no key, network, timeout, non-200, wrong shape). */
export async function fetchUsage(
  { fetch = globalThis.fetch, env = loadEnvFile(POSTHOG_ENV_FILE), apiHost = loadConfig()?.posthog?.apiHost ?? DEFAULT_API_HOST, timeoutMs = 10_000 }:
    { fetch?: FetchLike; env?: Record<string, string>; apiHost?: string; timeoutMs?: number } = {},
): Promise<Usage | null> {
  const key = env.POSTHOG_PERSONAL_API_KEY;
  const projectId = env.POSTHOG_PROJECT_ID;
  if (!key || !projectId || !/^\d+$/.test(projectId)) return null;
  try {
    const res = await fetch(`${apiHost}/api/projects/${projectId}/query/`, {
      method: "POST",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ query: { kind: "HogQLQuery", query: USAGE_QUERY } }),
    });
    if (res.status !== 200) return null;
    const data = (await res.json()) as { columns?: unknown; results?: unknown };
    if (!Array.isArray(data?.columns) || !Array.isArray(data?.results)) return null;
    const col = (name: string) => (data.columns as unknown[]).indexOf(name);
    const at = Object.fromEntries(["project", "visitors", "started", "finished", "visitors14", "finished14", "first_seen"].map((c) => [c, col(c)]));
    if (Object.values(at).some((i) => i < 0)) return null;
    const usage: Usage = {};
    for (const row of data.results) {
      if (!Array.isArray(row)) return null;
      const project = row[at.project!];
      const nums = (["visitors", "started", "finished", "visitors14", "finished14"] as const).map((c) => row[at[c]!]);
      const firstSeen = String(row[at.first_seen!] ?? "").slice(0, 10);
      if (typeof project !== "string" || !PROJECT.test(project)) continue; // not a lab project name: ignore it
      if (!nums.every(count) || !/^\d{4}-\d\d-\d\d$/.test(firstSeen)) return null;
      const [visitors, started, finished, visitors14, finished14] = nums as number[];
      usage[project] = { visitors: visitors!, started: started!, finished: finished!, finishRate: rate(finished!, started!), visitors14: visitors14!, finished14: finished14!, firstSeen };
    }
    return usage;
  } catch {
    return null;
  }
}

const daysBefore = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) - n * 864e5).toISOString().slice(0, 10);
const ZERO: ProjectUsage = { visitors: 0, started: 0, finished: 0, finishRate: null, visitors14: 0, finished14: 0, firstSeen: "" };

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/**
 * Pure. Turns this week's usage into the report line and the two signals.
 * A launched project with no events this month is shown as "0 visitors" (the query worked; nobody came).
 * (+n) is the change in finish rate, in percentage points, since `previous`; (new) when that record had no rate.
 */
export function usageTrend(
  { usage, history, projects, today }:
    { usage: Usage | null | undefined; history: { date: string; usage: Usage }[]; projects: Pick<Project, "name" | "public">[]; today: string },
): UsageTrend | null {
  if (!usage) return null;
  const launched = projects.filter((p) => p.public && p.name !== "hub").map((p) => p.name);
  const get = (name: string) => usage[name] ?? ZERO;
  const prev = history.filter((h) => h.date < today).at(-1) ?? null;
  const pct = (r: number) => `${Math.round(r * 100)}%`;
  const part = (name: string) => {
    const u = get(name);
    const people = `${u.visitors} visitor${u.visitors === 1 ? "" : "s"}`;
    if (u.finishRate === null) return `${name} ${people}, no plays`;
    const before = prev?.usage?.[name]?.finishRate;
    const change = typeof before === "number" ? Math.round((u.finishRate - before) * 100) : null;
    const delta = change === null ? "new" : change < 0 ? `-${-change}` : `+${change}`;
    return `${name} ${people}, ${pct(u.finishRate)} finish (${delta})`;
  };
  const line = `Usage this week: ${launched.map(part).join(" · ") || "none"}`;

  const busy = launched.filter((n) => get(n).started >= 30 && get(n).finishRate !== null);
  const mid = median(busy.map((n) => get(n).finishRate!));
  const stuck = mid === null ? [] : busy.filter((n) => get(n).finishRate! < mid / 2);

  const cutoff = daysBefore(today, 14);
  const stalled = launched.filter((n) => {
    const u = get(n);
    return u.firstSeen !== "" && u.firstSeen <= cutoff && u.visitors14 >= 20 && u.finished14 <= u.visitors14 * 0.05;
  });
  return { line, previous: prev?.date ?? null, stuck, median: mid, stalled };
}
