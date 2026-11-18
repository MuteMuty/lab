// The hub's usage events: the only ones it may send (SAFETY.md, "Usage events"). The convention is in analytics/guard.ts.
// Adding an event or value here is a normal commit; anything new in kind needs Erik.
import type { AllowList } from "./analytics/guard.ts";
import projects from "../projects.json" with { type: "json" };

export const PROJECT = "hub";
export const EVENTS = {
  $pageview: {},
  // A visitor followed a project's card to play it.
  project_opened: { project: projects.map((p) => p.name) },
} satisfies AllowList;
