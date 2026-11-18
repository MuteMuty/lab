// Loads the shared analytics script after the page has loaded and gone idle, so it never delays the page.
// If the script is blocked or fails, the queued events are simply never sent. If the visitor asked not to be
// tracked, the script isn't even fetched and track() does nothing (the script itself checks again).
import { optedOut, type AllowList, type Props } from "./guard.ts";

export function loadAnalytics(project: string, allow: AllowList, src = "/analytics/v1.js") {
  if (optedOut(navigator, window)) return;
  window.labAnalytics = { project, allow, queue: [] };
  const add = () => document.head.append(Object.assign(document.createElement("script"), { src, async: true }));
  const idle = () => ("requestIdleCallback" in window ? requestIdleCallback(add, { timeout: 3000 }) : setTimeout(add, 200));
  if (document.readyState === "complete") idle();
  else addEventListener("load", idle, { once: true });
}

export const track = (name: string, props?: Props) => { window.labAnalytics?.queue.push([name, props]); };
