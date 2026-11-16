// A small stand-in for Cloudflare D1, backed by Node's built-in SQLite and the real migrations.
// Only the calls the hub uses: prepare().bind().first()/all()/run() and batch().
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Db, Statement } from "../src/likes.ts";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
export const migrations = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();

type Result = { success: true; results: Record<string, unknown>[]; meta: { changes: number } };
type FakeStatement = Statement & { exec(): Result };

/** A fresh in-memory database with the given migrations applied (all of them by default). */
export function d1(applied = migrations): Db & { raw: DatabaseSync } {
  const raw = new DatabaseSync(":memory:");
  for (const f of applied) raw.exec(readFileSync(join(dir, f), "utf8"));
  const exec = (sql: string, args: SQLInputValue[]): Result => {
    const results = raw.prepare(sql).all(...args);
    const { c } = raw.prepare("select changes() as c").get() as { c: number };
    return { success: true, results, meta: { changes: Number(c) } };
  };
  const statement = (sql: string, args: SQLInputValue[] = []): FakeStatement => ({
    bind: (...a) => statement(sql, a as SQLInputValue[]),
    exec: () => exec(sql, args),
    async first<T>() { return (exec(sql, args).results[0] ?? null) as T | null; },
    async all<T>() { return exec(sql, args) as unknown as { results: T[] }; },
    async run() { return exec(sql, args); },
  });
  return {
    raw,
    prepare: (sql) => statement(sql),
    async batch(list) {
      raw.exec("begin");
      try {
        const out = (list as FakeStatement[]).map((s) => s.exec());
        raw.exec("commit");
        return out;
      } catch (e) {
        raw.exec("rollback");
        throw e;
      }
    },
  };
}
