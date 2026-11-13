import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import worker from "../worker/index.js";
import { enqueueIdeaExecution, sha256 } from "../worker/idea-execution.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const migrationNames = [
  "0001_project_connections.sql",
  "0002_project_setup.sql",
  "0003_project_onboarding.sql",
  "0004_idea_sessions.sql",
  "0005_idea_workflow.sql",
  "0006_idea_agent_memory.sql",
  "0007_idea_execution_foundation.sql",
  "0008_egm_workflow.sql",
];

class SQLiteStatement {
  constructor(database, sql, bindings = []) {
    this.database = database;
    this.sql = sql;
    this.bindings = bindings;
  }
  bind(...bindings) { return new SQLiteStatement(this.database, this.sql, bindings); }
  first() { return this.database.prepare(this.sql).get(...this.bindings) ?? null; }
  all() { return { results: this.database.prepare(this.sql).all(...this.bindings) }; }
  run() {
    const result = this.database.prepare(this.sql).run(...this.bindings);
    return { meta: { changes: Number(result.changes) } };
  }
}

class SQLiteDatabase {
  constructor(database) { this.database = database; }
  prepare(sql) { return new SQLiteStatement(this.database, sql); }
  batch(statements) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const results = statements.map((entry) => entry.run());
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

async function database(through) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  for (const name of migrationNames.slice(0, through)) {
    sqlite.exec(await readFile(resolve(root, "migrations", name), "utf8"));
  }
  const at = "2026-11-13T00:00:00.000Z";
  sqlite.prepare("INSERT INTO projects (id, user_id, name, code, description, created_at, updated_at) VALUES (?, ?, ?, ?, '', ?, ?)")
    .run("project-1", "user-1", "Idea project", "IDEA", at, at);
  sqlite.prepare("INSERT INTO idea_sessions (project_id, title, stage, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
    .run("project-1", "Reliable pipeline", "workspace", at, at);
  sqlite.prepare("INSERT INTO idea_messages (id, project_id, role, content, hypothesis, ready, created_at) VALUES (?, ?, ?, ?, '', 0, ?)")
    .run("message-1", "project-1", "user", "Build a reliable planning pipeline.", at);
  sqlite.prepare("INSERT INTO idea_memory (project_id, memory_json, updated_at) VALUES (?, '{}', ?)")
    .run("project-1", at);
  return { sqlite, env: { DB: new SQLiteDatabase(sqlite), AI_MODEL: "test-model", TRUST_USER_HEADER: "true" } };
}

function request(env, path, { method = "GET", user = "user-1", body } = {}) {
  return worker.fetch(new Request(`https://local.test${path}`, {
    method,
    headers: {
      "x-adis-user-id": user,
      ...(method === "GET" ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env);
}

test("execution records are read-only and scoped to the project owner", async () => {
  const { sqlite, env } = await database(8);
  await enqueueIdeaExecution(env.DB, {
    projectId: "project-1", idempotencyKey: "draft_section:overview:v1", agentRole: "elephant", operation: "draft_section",
    provider: "openai-compatible", model: "test-model", adapterVersion: "1", promptVersion: "egm-v1", personaVersion: "egm-personas-v1:elephant",
    inputManifest: [{ kind: "concept_brief" }], inputSha256: await sha256("input"),
  });
  const listed = await request(env, "/api/projects/project-1/idea/executions");
  assert.equal(listed.status, 200);
  const body = await listed.json();
  assert.equal(body.executions.length, 1);
  assert.equal(body.executions[0].operation, "draft_section");
  assert.equal((await request(env, "/api/projects/project-1/idea/executions", { user: "user-2" })).status, 404);
  assert.equal((await request(env, "/api/projects/project-1/idea/executions", { method: "POST", body: { operation: "draft_section" } })).status, 405);
  sqlite.close();
});
