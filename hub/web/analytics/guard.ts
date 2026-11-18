// The rules every lab page's usage events go through before anything leaves the browser (SAFETY.md,
// "Usage events", lab#71). The shared script (v1.ts) runs these around posthog; tests run them with a fake.
//
// The lab-wide convention, so every project's numbers line up:
//   - every page sends `$pageview`;
//   - a project with a play loop sends `play_started` and `play_finished` (plus its own named events);
//   - the hub sends `project_opened {project}` when a visitor follows a project's card;
//   - every event carries `project`: the project it's about. That's the page's own project, unless the
//     event lists `project` itself (the hub's `project_opened`), in which case it must be a known name.
// Properties are enum-like values or bucketed numbers (`bucket()` below), never free text, and never
// anything a visitor typed, drew, recorded or uploaded. Each project keeps its allow-list in one file.
import type { PostHogConfig, CaptureResult, CaptureOptions } from "posthog-js/dist/module.slim.no-external";

export type Value = string | number | boolean;
/** Event name → the properties it may carry → each property's allowed values (enums or bucket labels). */
export type AllowList = Readonly<Record<string, Readonly<Record<string, readonly Value[]>>>>;
export type Props = Record<string, unknown>;
/** [event name, properties] waiting for the script, or handed to it after it has started. */
export type Queued = [string, Props?];
/** What a page sets on `window.labAnalytics` before the shared script loads. */
export type Config = { project: string; allow: AllowList; queue: { push(...events: Queued[]): unknown } };
/** The part of posthog the script uses, so tests can pass a stand-in. */
export type Client = {
  init(key: string, options: Partial<PostHogConfig>): unknown;
  capture(name: string, props?: Props, options?: CaptureOptions): unknown;
};

declare global { interface Window { labAnalytics?: Config } }

const own = <T extends object>(o: T, k: string): k is Extract<keyof T, string> => Object.hasOwn(o, k);

/** Lab pages in production. Everything else (localhost, *.workers.dev previews, tests, playtests) sends nothing. */
export const isProduction = (hostname: string) => hostname.endsWith(".brightloopapps.com");

/** The properties an event may carry, with `project` attached, or null when the event may not be sent. */
export function allowed(allow: AllowList, project: string, event: string, props: Props = {}): Props | null {
  if (!own(allow, event)) return null;
  const spec = allow[event]!;
  const out: Props = { project };
  for (const [k, v] of Object.entries(props)) {
    if (own(spec, k) && spec[k]!.includes(v as Value)) out[k] = v;
  }
  // An event that lists `project` is about another project, so a missing or unknown name can't fall back to ours.
  if (own(spec, "project") && !spec.project!.includes(props.project as Value)) return null;
  return out;
}

/** A label for a count: `edges` are ascending lower bounds, so bucket(7, [1, 5, 10]) is "5-9" and 12 is "10+". */
export function bucket(n: number, edges: readonly number[]): string {
  let i = edges.findLastIndex((e) => n >= e);
  if (i < 0) return `<${edges[0]}`;
  return i === edges.length - 1 ? `${edges[i]}+` : `${edges[i]}-${edges[i + 1]! - 1}`;
}

// posthog's own `$` properties stay (browser, screen size, page address…), except person properties,
// and any address loses its query and fragment, where a page could hold something a visitor chose.
const trimUrl = (v: unknown) => {
  if (typeof v !== "string" || !/^https?:\/\//.test(v)) return v;
  try { const u = new URL(v); return u.origin + u.pathname; } catch { return v; }
};
const POSTHOG_OWN = new Set(["token", "distinct_id"]);

/** posthog's before_send: the last look at an event, after posthog has added its own properties. */
export const cleanEvent = (allow: AllowList, project: string) => (e: CaptureResult | null): CaptureResult | null => {
  if (!e) return null;
  const page: Props = {};
  const kept: Props = {};
  for (const [k, v] of Object.entries(e.properties ?? {})) {
    if (k === "$set" || k === "$set_once" || k === "$unset") continue;
    if (k.startsWith("$")) kept[k] = trimUrl(v);
    else if (POSTHOG_OWN.has(k)) kept[k] = v;
    else page[k] = v;
  }
  const ours = allowed(allow, project, e.event, page);
  if (!ours) return null;
  const { $set, $set_once, $unset, ...rest } = e;
  return { ...rest, properties: { ...kept, ...ours } };
};

/** posthog, cookieless in the EU, with everything except the events we name switched off. */
export const options = (allow: AllowList, project: string): Partial<PostHogConfig> => ({
  api_host: "https://eu.i.posthog.com",
  cookieless_mode: "always",
  persistence: "memory",
  disable_persistence: true,
  person_profiles: "never",
  respect_dnt: true,
  autocapture: false,
  capture_pageview: false, // sent by start(), through the allow-list
  capture_pageleave: false,
  capture_heatmaps: false,
  capture_dead_clicks: false,
  capture_exceptions: false,
  capture_performance: false,
  rageclick: false,
  save_campaign_params: false,
  disable_session_recording: true,
  disable_surveys: true,
  disable_product_tours: true,
  disable_conversations: true,
  disable_web_experiments: true,
  disable_external_dependency_loading: true, // never load a script from another host
  advanced_disable_flags: true, // no feature flags and no remote config request
  before_send: cleanEvent(allow, project),
});

/**
 * Starts analytics for the page's config: in production with a key, posthog starts, sends `$pageview`,
 * then everything queued, and every later `queue.push` goes straight through. Otherwise the queue is
 * emptied and stays empty. Returns whether anything can be sent. Never throws.
 */
export function start({ key, hostname, config, client }: { key: string; hostname: string; config: Config | undefined; client: Client }): boolean {
  if (!config) return false;
  const queued = Array.isArray(config.queue) ? config.queue.splice(0) as Queued[] : [];
  const drop = () => { config.queue = { push: () => 0 }; return false; };
  if (!key || !isProduction(hostname)) return drop();
  const send = ([name, props]: Queued) => {
    const p = allowed(config.allow, config.project, name, props);
    if (p) try { client.capture(name, p, { send_instantly: true }); } catch {}
  };
  try {
    client.init(key, options(config.allow, config.project));
  } catch {
    return drop();
  }
  send(["$pageview"]);
  queued.forEach(send);
  config.queue = { push: (...events: Queued[]) => { events.forEach(send); return 0; } };
  return true;
}
