// ADIS application server.
//
// Runs the whole application (UI + API) on localhost against one persistent,
// file-backed SQLite database. There is no hosting platform, cloud database
// binding, or external account involved: `npm start` is all that is needed.

import { createServer } from "node:http";
import { chmod, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const [nodeMajor, nodeMinor] = process.versions.node.split(".").map(Number);
if (nodeMajor < 22 || (nodeMajor === 22 && nodeMinor < 9)) {
  console.error(`ADIS needs Node.js 22.9 or newer for its built-in SQLite support (found ${process.versions.node}).`);
  process.exit(1);
}

const { DatabaseSync } = await import("node:sqlite");
const { default: app } = await import("../worker/index.js");

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_DATABASE_PATH = resolve(root, ".data", "adis-local.sqlite");
const MIGRATIONS_TABLE = "schema_migrations";
const LEGACY_MIGRATIONS_TABLE = "d1_migrations";

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

// The API handlers use a small prepare/bind/first/all/run/batch interface.
// This class implements it directly on node:sqlite so the handlers run
// unchanged against the local SQLite file.
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

function tableExists(database, name) {
  return Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}

export async function migrateLocalDatabase(database) {
  // Databases created by earlier builds tracked migrations in a differently
  // named table. Rename it in place so history is kept and nothing reapplies.
  if (tableExists(database, LEGACY_MIGRATIONS_TABLE) && !tableExists(database, MIGRATIONS_TABLE)) {
    database.exec(`ALTER TABLE ${LEGACY_MIGRATIONS_TABLE} RENAME TO ${MIGRATIONS_TABLE}`);
  }
  database.exec(`
    CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  const applied = new Set(database.prepare(`SELECT name FROM ${MIGRATIONS_TABLE}`).all().map((row) => row.name));
  const files = await migrationFiles();
  for (const name of files) {
    if (applied.has(name)) continue;
    const sql = await readFile(resolve(root, "migrations", name), "utf8");
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(sql);
      database.prepare(`INSERT INTO ${MIGRATIONS_TABLE} (name) VALUES (?)`).run(name);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw new Error(`Migration ${name} failed: ${error.message}`, { cause: error });
    }
  }
  return files;
}

function isValidKey(value) {
  if (!value || typeof value !== "string") return false;
  const normalized = value.trim();
  const decoded = Buffer.from(normalized, "base64");
  const canonical = decoded.toString("base64").replace(/=+$/, "");
  return decoded.length === 32 && canonical === normalized.replace(/=+$/, "");
}

function hasEncryptedCredentials(database) {
  if (!tableExists(database, "repository_connections")) return false;
  return Number(database.prepare("SELECT COUNT(*) AS count FROM repository_connections").get().count) > 0;
}

// Resolve the credential encryption key without ever silently replacing one.
// Order: CREDENTIAL_ENCRYPTION_KEY env var, then the key file stored next to
// the database. A new key file is created only for a database that holds no
// encrypted credentials yet, so existing ciphertext can never be orphaned.
export async function resolveCredentialKey({ envValue, keyPath, database }) {
  const fromEnv = typeof envValue === "string" ? envValue.trim() : "";
  if (fromEnv) {
    if (!isValidKey(fromEnv)) throw new Error("CREDENTIAL_ENCRYPTION_KEY must be a valid base64-encoded 32-byte key.");
    return { key: fromEnv, source: "environment" };
  }
  if (existsSync(keyPath)) {
    const fromFile = (await readFile(keyPath, "utf8")).trim();
    if (!isValidKey(fromFile)) throw new Error(`The credential key file ${keyPath} is not a valid base64-encoded 32-byte key.`);
    return { key: fromFile, source: "file" };
  }
  if (hasEncryptedCredentials(database)) {
    throw new Error(
      `This database already contains encrypted repository credentials, but no key was found at ${keyPath} ` +
      "and CREDENTIAL_ENCRYPTION_KEY is not set. Restore the original key; generating a new one would make those credentials unreadable.",
    );
  }
  const created = randomBytes(32).toString("base64");
  await writeFile(keyPath, `${created}\n`, { mode: 0o600, flag: "wx" });
  await chmod(keyPath, 0o600);
  return { key: created, source: "created" };
}

export const MAX_BODY_BYTES = 1024 * 1024;
const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Only answer requests addressed to an expected host name. This defeats DNS
// rebinding, where a hostile site points its own domain at 127.0.0.1.
function allowedHostnames(env) {
  const extra = String(env.ALLOWED_HOSTS || "").split(",").map((value) => value.trim().toLowerCase()).filter(Boolean);
  return new Set([...LOOPBACK_HOSTS, ...extra]);
}

function requestHost(req, allowed) {
  const host = String(req.headers.host || "").trim().toLowerCase();
  let hostname = "";
  try { hostname = new URL(`http://${host}`).hostname; } catch {}
  if (!hostname || !allowed.has(hostname)) throw new HttpError(403, "This server only answers requests addressed to an allowed host name.");
  return host;
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, `Request bodies are limited to ${MAX_BODY_BYTES} bytes.`);
    chunks.push(chunk);
  }
  return chunks.length ? Buffer.concat(chunks) : undefined;
}

async function requestFromNode(req, allowed) {
  const host = requestHost(req, allowed);
  const body = await readBody(req);
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) value.forEach((entry) => headers.append(name, entry));
    else if (value !== undefined) headers.set(name, value);
  }
  // The URL carries the validated Host so the app can compare it with Origin.
  return new Request(new URL(req.url || "/", `http://${host}`), {
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
  databasePath = DEFAULT_DATABASE_PATH,
  host = "127.0.0.1",
  port = 0,
  env = {},
} = {}) {
  const appEnv = { LOCAL_DEMO_MODE: "true", ...process.env, ...env };
  await mkdir(dirname(databasePath), { recursive: true });
  const sqlite = new DatabaseSync(databasePath);
  let server;
  try {
    sqlite.exec("PRAGMA foreign_keys = ON");
    sqlite.exec("PRAGMA journal_mode = WAL");
    sqlite.exec("PRAGMA busy_timeout = 5000");
    const migrations = await migrateLocalDatabase(sqlite);
    const keyPath = resolve(appEnv.CREDENTIAL_KEY_FILE || resolve(dirname(databasePath), "credential.key"));
    const credentialKey = await resolveCredentialKey({ envValue: appEnv.CREDENTIAL_ENCRYPTION_KEY, keyPath, database: sqlite });
    appEnv.CREDENTIAL_ENCRYPTION_KEY = credentialKey.key;
    appEnv.DB = new SQLiteDatabaseAdapter(sqlite);
    const allowed = allowedHostnames(appEnv);
    if (!["0.0.0.0", "::", "::1", ...LOOPBACK_HOSTS].includes(host)) allowed.add(host.toLowerCase());
    server = createServer(async (req, res) => {
      try {
        const response = await app.fetch(await requestFromNode(req, allowed), appEnv);
        await sendNodeResponse(res, response);
      } catch (error) {
        const status = error instanceof HttpError ? error.status : 500;
        if (status === 500) console.error("Request failed:", error instanceof Error ? error.message : "unknown error");
        res.statusCode = status;
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.setHeader("connection", "close");
        res.end(JSON.stringify({ error: status === 500 ? "Internal server error" : error.message }));
      }
    });
    await new Promise((resolveListen, reject) => {
      server.once("error", reject);
      server.listen(port, host, resolveListen);
    });
    const address = server.address();
    const origin = `http://${host.includes(":") ? `[${host}]` : host}:${address.port}`;
    return {
      origin,
      databasePath,
      migrations,
      sqlite,
      keyPath,
      keySource: credentialKey.source,
      async close() {
        await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
        sqlite.close();
      },
    };
  } catch (error) {
    if (server?.listening) server.close();
    sqlite.close();
    throw error;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const port = Number(process.env.PORT || 8787);
  let backend;
  try {
    backend = await startLocalBackend({
      databasePath: resolve(process.env.LOCAL_DB_PATH || DEFAULT_DATABASE_PATH),
      host: process.env.HOST || "127.0.0.1",
      port,
    });
  } catch (error) {
    if (error?.code === "EADDRINUSE") console.error(`Port ${port} is already in use. Stop the other process or run with PORT=<another port>.`);
    else console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
  const shown = (path) => relative(process.cwd(), path) || path;
  console.log(`ADIS is running at http://localhost:${new URL(backend.origin).port}`);
  console.log(`SQLite database: ${shown(backend.databasePath)}`);
  if (backend.keySource === "created") console.log(`Created a credential key at ${shown(backend.keyPath)}. Keep it with the database; do not commit it.`);
  else if (backend.keySource === "file") console.log(`Credential key: ${shown(backend.keyPath)}`);
  else console.log("Credential key: CREDENTIAL_ENCRYPTION_KEY environment variable");
  const listenHost = process.env.HOST || "127.0.0.1";
  const singleUser = String(process.env.LOCAL_DEMO_MODE ?? "true").toLowerCase() === "true";
  if (!["127.0.0.1", "localhost", "::1"].includes(listenHost) && singleUser) {
    console.warn(`WARNING: HOST=${listenHost} makes ADIS reachable from other machines, and single-user mode has no sign-in.`);
    console.warn("Anyone who can reach this port can use the app. Prefer the default HOST=127.0.0.1.");
  }
  if (!process.env.AI_API_KEY && !process.env.OPENAI_API_KEY) console.log("AI_API_KEY is not set: repository onboarding works, idea-generation steps will report that AI is not configured.");
  const shutdown = async () => {
    await backend.close();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
