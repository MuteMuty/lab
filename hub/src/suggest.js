// Suggestion box logic. Pure apart from the D1 calls, so it can be tested in Node.
const MAX_LEN = 500;
const MIN_LEN = 3;
const PER_DAY = 5;
const PROJECT = /^[a-z0-9-]{1,40}$/;

async function sha256Hex(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const reply = (status, json) => ({ status, json });

export async function handleSuggest(body, { ip, salt, db, now = new Date() }) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return reply(400, { error: "Send a JSON object." });
  if (typeof body.website === "string" && body.website.trim() !== "") return reply(200, { ok: true }); // honeypot
  if (typeof body.text !== "string") return reply(400, { error: "Write between 3 and 500 characters." });
  const text = body.text.trim();
  const len = [...text].length;
  if (len < MIN_LEN || len > MAX_LEN) return reply(400, { error: "Write between 3 and 500 characters." });
  let project = null;
  if (body.project !== undefined && body.project !== null && body.project !== "") {
    if (typeof body.project !== "string" || !PROJECT.test(body.project)) return reply(400, { error: "Unknown project." });
    project = body.project;
  }
  const ipHash = await sha256Hex(`${salt}:${ip ?? "unknown"}`);
  const since = new Date(now.getTime() - 24 * 3600 * 1000).toISOString();
  const row = await db.prepare("select count(*) as n from suggestions where ip_hash = ?1 and created_at > ?2").bind(ipHash, since).first();
  if ((row?.n ?? 0) >= PER_DAY) return reply(429, { error: "That's plenty for today. Thanks!" });
  await db.prepare("insert into suggestions (created_at, text, project, ip_hash, status) values (?1, ?2, ?3, ?4, 'new')")
    .bind(now.toISOString(), text, project, ipHash).run();
  return reply(200, { ok: true });
}
