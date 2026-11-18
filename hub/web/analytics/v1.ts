// The lab's shared analytics script, served as /analytics/v1.js and loaded by every lab page once it's idle.
// posthog-js is bundled in (scripts/bundle.ts), so the browser never loads a script from another host.
//
// A page uses it like this (see load.ts, which the hub uses):
//   window.labAnalytics = { project: "afterstep", allow: EVENTS, queue: [] };  // EVENTS: the project's allow-list file
//   …then, after the page has loaded and gone idle, add <script src="https://lab.brightloopapps.com/analytics/v1.js" async>.
//   Send events with window.labAnalytics.queue.push(["play_started", {}]), before or after the script arrives.
// The rules (what may be sent, the event convention, production only) live in guard.ts.
import { posthog } from "posthog-js/dist/module.slim.no-external";
import { start } from "./guard.ts";

declare const POSTHOG_KEY: string; // nightshift/config.json → posthog.projectKey, set at build time; "" sends nothing

try {
  start({ key: POSTHOG_KEY, hostname: location.hostname, config: window.labAnalytics, client: posthog, nav: navigator, win: window });
} catch {}
