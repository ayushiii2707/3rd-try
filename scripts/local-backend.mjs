import { createServer } from "node:http";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

import worker from "../worker/index.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

class SQLiteStatement {
  constructor(database, sql, bindings = []) {
    this.database = database;
    this.sql = sql;
    this.bindings = bindings;
  }

  bind(...bindings) {
    return new SQLiteStatement(this.database, this.sql, bindings);
  }

  first(column) {
    const row = this.database.prepare(this.sql).get(...this.bindings) ?? null;
    return column && row ? row[column] : row;
  }

  all() {
    return { success: true, results: this.database.prepare(this.sql).all(...this.bindings) };
  }

  run() {
    const result = this.database.prepare(this.sql).run(...this.bindings);
    return {
      success: true,
      results: [],
      meta: {
        changes: Number(result.changes),
        last_row_id: Number(result.lastInsertRowid),
      },
    };
  }
}

// This small adapter lets the existing SQL-oriented API handlers run unchanged
// on standard node:sqlite. It is not a second backend or a D1 runtime.
export class SQLiteDatabaseAdapter {
  constructor(database) {
    this.database = database;
  }

  prepare(sql) {
    return new SQLiteStatement(this.database, sql);
  }

  batch(statements) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const results = statements.map((statement) => statement.run());
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

async function migrationFiles() {
  return (await readdir(resolve(root, "migrations")))
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort();
}

export async function migrateLocalDatabase(database) {
  // Retain the legacy table name so databases created by earlier builds keep
  // their migration history and never reapply an existing migration.
  database.exec(`
    CREATE TABLE IF NOT EXISTS d1_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  const applied = new Set(database.prepare("SELECT name FROM d1_migrations").all().map((row) => row.name));
  const files = await migrationFiles();
  for (const name of files) {
    if (applied.has(name)) continue;
    const sql = await readFile(resolve(root, "migrations", name), "utf8");
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(sql);
      database.prepare("INSERT INTO d1_migrations (name) VALUES (?)").run(name);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw new Error(`Local migration ${name} failed: ${error.message}`, { cause: error });
    }
  }
  return files;
}

function assertEncryptionKey(value) {
  if (!value || typeof value !== "string") {
    throw new Error("CREDENTIAL_ENCRYPTION_KEY is required. Set one stable base64-encoded 32-byte key before starting the application.");
  }
  const normalized = value.trim();
  const decoded = Buffer.from(normalized, "base64");
  const canonical = decoded.toString("base64").replace(/=+$/, "");
  if (decoded.length !== 32 || canonical !== normalized.replace(/=+$/, "")) {
    throw new Error("CREDENTIAL_ENCRYPTION_KEY must be a valid base64-encoded 32-byte key.");
  }
}

async function requestFromNode(req, origin) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) value.forEach((entry) => headers.append(name, entry));
    else if (value !== undefined) headers.set(name, value);
  }
  return new Request(new URL(req.url || "/", origin), {
    method: req.method,
    headers,
    body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
    duplex: body ? "half" : undefined,
  });
}

async function sendNodeResponse(res, response) {
  res.statusCode = response.status;
  for (const [name, value] of response.headers) res.setHeader(name, value);
  res.end(Buffer.from(await response.arrayBuffer()));
}

export async function startLocalBackend({
  databasePath = resolve(root, ".data", "adis-local.sqlite"),
  host = "127.0.0.1",
  port = 0,
  env = {},
} = {}) {
  const workerEnv = { LOCAL_DEMO_MODE: "true", ...process.env, ...env };
  assertEncryptionKey(workerEnv.CREDENTIAL_ENCRYPTION_KEY);
  await mkdir(dirname(databasePath), { recursive: true });
  const sqlite = new DatabaseSync(databasePath);
  sqlite.exec("PRAGMA foreign_keys = ON");
  sqlite.exec("PRAGMA journal_mode = WAL");
  sqlite.exec("PRAGMA busy_timeout = 5000");
  const migrations = await migrateLocalDatabase(sqlite);
  workerEnv.DB = new SQLiteDatabaseAdapter(sqlite);
  let origin;
  const server = createServer(async (req, res) => {
    try {
      const response = await worker.fetch(await requestFromNode(req, origin), workerEnv);
      await sendNodeResponse(res, response);
    } catch (error) {
      console.error("Local application request failed:", error instanceof Error ? error.message : "unknown error");
      res.statusCode = 500;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ error: "Internal server error" }));
    }
  });
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolveListen);
  });
  const address = server.address();
  origin = `http://${host}:${address.port}`;
  return {
    origin,
    databasePath,
    migrations,
    sqlite,
    async close() {
      await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
      sqlite.close();
    },
  };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const backend = await startLocalBackend({
    databasePath: resolve(process.env.LOCAL_DB_PATH || resolve(root, ".data", "adis-local.sqlite")),
    port: Number(process.env.PORT || 8787),
  });
  console.log(`ADIS local application listening at ${backend.origin}`);
  console.log(`Persistent database: ${backend.databasePath}`);
  const shutdown = async () => {
    await backend.close();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
