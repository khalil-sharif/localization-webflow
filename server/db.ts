import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

// Project root: one level above server/ (ts-node) or two above dist/server/ (compiled).
export const ROOT = path.basename(path.dirname(__dirname)) === "dist" ? path.resolve(__dirname, "..", "..") : path.resolve(__dirname, "..");

/**
 * Persistence adapter. Domain services only talk to this interface, so a Postgres/MySQL
 * implementation can be dropped into createAdapter() without touching any other file.
 * Placeholders are positional `?`.
 */
export interface DbAdapter {
  exec(sql: string): void;
  run(sql: string, params?: unknown[]): { changes: number };
  get<T>(sql: string, params?: unknown[]): T | undefined;
  all<T>(sql: string, params?: unknown[]): T[];
  transaction<T>(fn: () => T): T;
}

class SqliteAdapter implements DbAdapter {
  private conn: Database.Database;

  constructor(file: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.conn = new Database(file);
    this.conn.pragma("journal_mode = WAL");
    this.conn.pragma("foreign_keys = ON");
  }
  exec(sql: string): void {
    this.conn.exec(sql);
  }
  run(sql: string, params: unknown[] = []): { changes: number } {
    const info = this.conn.prepare(sql).run(...params);
    return { changes: info.changes };
  }
  get<T>(sql: string, params: unknown[] = []): T | undefined {
    return this.conn.prepare(sql).get(...params) as T | undefined;
  }
  all<T>(sql: string, params: unknown[] = []): T[] {
    return this.conn.prepare(sql).all(...params) as T[];
  }
  transaction<T>(fn: () => T): T {
    return this.conn.transaction(fn)();
  }
}

function createAdapter(): DbAdapter {
  const kind = process.env.DB_ADAPTER || "sqlite";
  if (kind === "sqlite") return new SqliteAdapter(process.env.DATABASE_PATH || path.join(ROOT, "db", "localization.sqlite"));
  throw new Error(`Unsupported DB_ADAPTER "${kind}". Implement DbAdapter and register it in server/db.ts.`);
}

export const db: DbAdapter = createAdapter();

export function migrate(): void {
  db.exec(fs.readFileSync(path.join(ROOT, "db", "schema.sql"), "utf-8"));
}
