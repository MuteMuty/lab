// lab.brightloopapps.com: static hub plus the suggestion box API.
import { handleSuggest } from "./suggest.js";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
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
