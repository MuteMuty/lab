// Anonymous like counts (lab#16). Pure apart from the D1 calls, so it can be tested in Node.
// No cookies, no accounts, no raw IPs. Abuse limits use an HMAC of the IP and the day, which
// can't be linked from one day to the next and is cleared after 30 days. The likes themselves
// are kept forever; a like can only be taken back with its random receipt.
const RECEIPT = /^[0-9a-f]{32}$/;
const PER_MINUTE = 20; // like + unlike requests per IP hash
const KEEP_IP_DAYS = 30;
const DAY_MS = 24 * 3600 * 1000;

/** The few D1 calls the hub makes. Cloudflare's D1 binding fits it, and so does the SQLite stand-in in test/d1.ts. */
export interface Statement {
  bind(...values: unknown[]): Statement;
  first<T = Row>(): Promise<T | null>;
  all<T = Row>(): Promise<{ results?: T[] }>;
  run(): Promise<unknown>;
}
export interface Db {
  prepare(sql: string): Statement;
  batch(statements: Statement[]): Promise<{ results?: Row[]; meta?: { changes?: number } }[]>;
}
type Row = Record<string, unknown>;

export type Counts = { total: number; week: number };
/** A status and the JSON body to send back. */
export type Reply<T = any> = { status: number; json: T };
export type LikeOptions = { db: Db; projects: string[]; ip?: string | null; salt: string; now?: Date };

const reply = <T,>(status: number, json: T): Reply<T> => ({ status, json });
const unknown = () => reply(404, { error: "Unknown project." });
const enc = (s: string) => new TextEncoder().encode(s);
const hex = (buf: ArrayBuffer | Uint8Array) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const dayOf = (now: Date, daysAgo = 0) => new Date(now.getTime() - daysAgo * DAY_MS).toISOString().slice(0, 10);

const sha256Hex = async (s: string) => hex(await crypto.subtle.digest("SHA-256", enc(s)));
const randomHex = (bytes: number) => hex(crypto.getRandomValues(new Uint8Array(bytes)));

/** HMAC of the IP and the day, keyed with the suggestion box's salt secret. */
export async function ipHash(salt: string, ip: string | null | undefined, day: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc(salt), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, enc(`${day}|${ip ?? "unknown"}`)));
}

/** The hub's project cards plus preview-only lab projects. Never the hub itself. */
export function likeable(hubProjects: { name: string }[], labProjects: { name: string; public: boolean }[]): string[] {
  const names = [...hubProjects.map((p) => p.name), ...labProjects.filter((p) => !p.public).map((p) => p.name)];
  return [...new Set(names)].filter((n) => n !== "hub");
}

/** The lab's own origins: its brightloopapps.com subdomains and this account's workers.dev previews. */
const ORIGINS = [/^https:\/\/[a-z0-9-]+\.brightloopapps\.com$/, /^https:\/\/[a-z0-9-]+\.erko-erka1\.workers\.dev$/];
export const allowedOrigin = (origin: string | null | undefined): origin is string => typeof origin === "string" && ORIGINS.some((r) => r.test(origin));

// Any database failure (most likely: migration 0002 isn't applied yet) is a clean 503.
async function guarded(fn: () => Promise<Reply>): Promise<Reply> {
  try {
    return await fn();
  } catch {
    return reply(503, { error: "Likes are resting right now. Try again later." });
  }
}

const COUNTS = `select coalesce(sum(n), 0) as total, coalesce(sum(case when day >= ?2 then n else 0 end), 0) as week
  from like_counts where project = ?1`;
const counts = (row: Row | null | undefined): Counts => ({ total: Number(row?.total ?? 0), week: Number(row?.week ?? 0) });

async function overLimit(db: Db, hash: string, now: Date) {
  const row = await db.prepare(`insert into like_hits (ip_hash, minute, n) values (?1, ?2, 1)
    on conflict (ip_hash, minute) do update set n = n + 1 returning n`).bind(hash, now.toISOString().slice(0, 16)).first<{ n: number }>();
  return (row?.n ?? 0) > PER_MINUTE;
}
const limited = () => reply(429, { error: "That's a lot of likes. Try again in a minute." });

/** `{ "<project>": { total, week } }` for every likeable project. The week is today and the 6 days before. */
export function getLikes({ db, projects, now = new Date() }: Omit<LikeOptions, "salt" | "ip">): Promise<Reply> {
  return guarded(async () => {
    const { results } = await db.prepare(`select project, sum(n) as total, sum(case when day >= ?1 then n else 0 end) as week
      from like_counts group by project`).bind(dayOf(now, 6)).all<Row & { project: string }>();
    const out: Record<string, Counts> = Object.fromEntries(projects.map((p) => [p, { total: 0, week: 0 }]));
    for (const r of results ?? []) if (projects.includes(r.project)) out[r.project] = counts(r);
    return reply(200, out);
  });
}

export function addLike(project: string, { db, projects, ip, salt, now = new Date() }: LikeOptions): Promise<Reply> {
  if (!projects.includes(project)) return Promise.resolve(unknown());
  return guarded(async () => {
    const day = dayOf(now);
    const hash = await ipHash(salt, ip, day);
    if (await overLimit(db, hash, now)) return limited();
    const receipt = randomHex(16);
    const [added, after] = await db.batch([
      db.prepare("insert into likes (project, day, receipt_hash, ip_hash) values (?1, ?2, ?3, ?4) on conflict do nothing")
        .bind(project, day, await sha256Hex(receipt), hash),
      db.prepare(COUNTS).bind(project, dayOf(now, 6)),
    ]);
    const c = counts(after?.results?.[0]);
    if (!added?.meta?.changes) return reply(409, { error: "This network already liked it today.", ...c });
    return reply(200, { receipt, ...c });
  });
}

export function removeLike(project: string, body: unknown, { db, projects, ip, salt, now = new Date() }: LikeOptions): Promise<Reply> {
  if (!projects.includes(project)) return Promise.resolve(unknown());
  const receipt = body && typeof body === "object" && "receipt" in body ? body.receipt : undefined;
  if (typeof receipt !== "string" || !RECEIPT.test(receipt)) {
    return Promise.resolve(reply(400, { error: "Send the receipt you got for the like." }));
  }
  return guarded(async () => {
    if (await overLimit(db, await ipHash(salt, ip, dayOf(now)), now)) return limited();
    const [removed, after] = await db.batch([
      db.prepare("delete from likes where project = ?1 and receipt_hash = ?2").bind(project, await sha256Hex(receipt)),
      db.prepare(COUNTS).bind(project, dayOf(now, 6)),
    ]);
    const c = counts(after?.results?.[0]);
    if (!removed?.meta?.changes) return reply(404, { error: "That like wasn't found.", ...c });
    return reply(200, { ok: true, ...c });
  });
}

/** Clear the IP hash from likes older than 30 days and forget past minutes' rate-limit hits. Never throws. */
export async function cleanupLikes(db: Db, now = new Date()): Promise<void> {
  try {
    await db.batch([
      db.prepare("update likes set ip_hash = null where ip_hash is not null and day < ?1").bind(dayOf(now, KEEP_IP_DAYS)),
      db.prepare("delete from like_hits where minute < ?1").bind(now.toISOString().slice(0, 16)),
    ]);
  } catch {}
}
