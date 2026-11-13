// A small stand-in for Cloudflare D1, backed by Node's built-in SQLite and the real migrations.
// Only the calls the hub uses: prepare().bind().first()/all()/run() and batch().
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
export const migrations = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();

/** A fresh in-memory database with the given migrations applied (all of them by default). */
export function d1(applied = migrations) {
  const raw = new DatabaseSync(":memory:");
  for (const f of applied) raw.exec(readFileSync(join(dir, f), "utf8"));
  const exec = (sql, args) => {
    const results = raw.prepare(sql).all(...args);
    const { c } = raw.prepare("select changes() as c").get();
    return { success: true, results, meta: { changes: Number(c) } };
  };
  const statement = (sql, args = []) => ({
    bind: (...a) => statement(sql, a),
    exec: () => exec(sql, args),
    async first() { return exec(sql, args).results[0] ?? null; },
    async all() { return exec(sql, args); },
    async run() { return exec(sql, args); },
  });
  return {
    raw,
    prepare: (sql) => statement(sql),
    async batch(list) {
      raw.exec("begin");
      try {
        const out = list.map((s) => s.exec());
        raw.exec("commit");
        return out;
      } catch (e) {
        raw.exec("rollback");
        throw e;
      }
    },
  };
}
