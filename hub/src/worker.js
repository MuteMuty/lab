// lab.brightloopapps.com: static hub plus the suggestion box and like count APIs.
import { handleSuggest } from "./suggest.js";
import { likeable, allowedOrigin, getLikes, addLike, removeLike, cleanupLikes } from "./likes.js";
import hubProjects from "../projects.json" with { type: "json" };
import labProjects from "../../nightshift/projects.json" with { type: "json" };

const LIKEABLE = likeable(hubProjects, labProjects);
const CLEANUP_EVERY_MS = 3600 * 1000;
let nextCleanup = 0;

async function likesApi(request, env, ctx, url) {
  const origin = request.headers.get("Origin");
  const cors = allowedOrigin(origin) ? { "access-control-allow-origin": origin } : {};
  const headers = { "cache-control": "no-store", vary: "Origin", ...cors };
  const json = (r) => Response.json(r.json, { status: r.status, headers });
  const [project, ...rest] = url.pathname.split("/").slice(3); // "", "api", "likes", <project>
  const list = project === undefined;
  if (!list && (rest.length || !LIKEABLE.includes(project))) return json({ status: 404, json: { error: "Unknown project." } });

  const methods = list ? ["GET"] : ["POST", "DELETE"];
  if (request.method === "OPTIONS") {
    const preflight = origin && cors["access-control-allow-origin"]
      ? { "access-control-allow-methods": methods.join(", "), "access-control-allow-headers": "content-type", "access-control-max-age": "86400" }
      : {};
    return new Response(null, { status: 204, headers: { ...headers, ...preflight } });
  }
  if (!methods.includes(request.method)) return json({ status: 405, json: { error: `Use ${methods.join(" or ")}.` } });

  // Opportunistic cleanup, at most hourly per isolate: clears IP hashes older than 30 days.
  const now = Date.now();
  if (now >= nextCleanup) {
    nextCleanup = now + CLEANUP_EVERY_MS;
    ctx?.waitUntil?.(cleanupLikes(env.DB, new Date(now)));
  }

  const opts = { db: env.DB, projects: LIKEABLE, ip: request.headers.get("CF-Connecting-IP"), salt: env.SUGGEST_SALT ?? "dev-salt" };
  if (list) {
    const r = await getLikes(opts);
    // The lab page asks quietly: a 503 would show up as a console error before migration 0002 is applied.
    if (r.status === 503 && url.searchParams.has("quiet")) return new Response(null, { status: 204, headers });
    return json(r);
  }
  if (request.method === "POST") return json(await addLike(project, opts));
  if ((request.headers.get("content-length") ?? "0") > 4096) return json({ status: 413, json: { error: "Too long." } });
  let body = null;
  try { body = await request.json(); } catch {}
  return json(await removeLike(project, body, opts));
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/api/likes" || url.pathname.startsWith("/api/likes/")) return likesApi(request, env, ctx, url);
    if (url.pathname === "/api/suggest") {
      if (request.method !== "POST") return Response.json({ error: "Use POST." }, { status: 405 });
      if ((request.headers.get("content-length") ?? "0") > 4096) return Response.json({ error: "Too long." }, { status: 413 });
      let body = null;
      try { body = await request.json(); } catch {}
      const r = await handleSuggest(body, {
        ip: request.headers.get("CF-Connecting-IP"),
        salt: env.SUGGEST_SALT ?? "dev-salt",
        db: env.DB,
      });
      return Response.json(r.json, { status: r.status, headers: { "cache-control": "no-store" } });
    }
    return env.ASSETS.fetch(request);
  },
};
