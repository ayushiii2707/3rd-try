import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import {
  cancelIdeaExecution,
  claimIdeaExecution,
  enqueueIdeaExecution,
  finishIdeaExecution,
  inspectIdeaExecutionSchema,
  listIdeaExecutions,
  redactDiagnostic,
  sha256,
} from "../worker/idea-execution.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

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

async function migration(number) {
  const names = {
    1: "0001_project_connections.sql",
    2: "0002_project_setup.sql",
    3: "0003_project_onboarding.sql",
    4: "0004_idea_sessions.sql",
    5: "0005_idea_workflow.sql",
    6: "0006_idea_agent_memory.sql",
    7: "0007_idea_execution_foundation.sql",
  };
  return readFile(resolve(root, "migrations", names[number]), "utf8");
}

async function database({ through = 7 } = {}) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  for (let number = 1; number <= through; number += 1) sqlite.exec(await migration(number));
  return { sqlite, db: new SQLiteDatabase(sqlite) };
}

function seedProject(sqlite) {
  const at = "2026-11-13T00:00:00.000Z";
  sqlite.prepare("INSERT INTO projects (id, user_id, name, code, description, created_at, updated_at) VALUES (?, ?, ?, ?, '', ?, ?)")
    .run("project-1", "user-1", "Idea project", "IDEA", at, at);
  return at;
}

async function executionInput(overrides = {}) {
  return {
    projectId: "project-1",
    idempotencyKey: "draft:artifact-1:v1",
    agentRole: "elephant",
    operation: "design_draft",
    provider: "openai-compatible",
    model: "test-model",
    adapterVersion: "1",
    promptVersion: "draft-v1",
    personaVersion: "elephant-v1",
    inputManifest: [{ kind: "concept_brief", id: "artifact-1", version: 1 }],
    inputSha256: await sha256("input"),
    now: "2026-11-13T00:01:00.000Z",
    ...overrides,
  };
}

test("migration 0007 is additive and preserves existing ideation data", async () => {
  const { sqlite, db } = await database({ through: 6 });
  const at = seedProject(sqlite);
  sqlite.prepare("INSERT INTO idea_sessions (project_id, title, stage, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
    .run("project-1", "Existing idea", "discover", at, at);
  sqlite.prepare("INSERT INTO idea_artifacts (id, project_id, kind, version, status, title, content, created_at, updated_at) VALUES (?, ?, ?, 1, 'draft', ?, ?, ?, ?)")
    .run("artifact-1", "project-1", "concept_brief", "Brief", "preserve me", at, at);
  sqlite.prepare("INSERT INTO idea_memory (project_id, memory_json, updated_at) VALUES (?, ?, ?)")
    .run("project-1", "{\"fact\":\"preserve me\"}", at);

  assert.equal((await inspectIdeaExecutionSchema(db)).ready, false);
  sqlite.exec(await migration(7));
  const inventory = await inspectIdeaExecutionSchema(db);
  assert.deepEqual(inventory, { ready: true, missing_tables: [], missing_columns: {} });

  const session = sqlite.prepare("SELECT * FROM idea_sessions WHERE project_id = ?").get("project-1");
  const artifact = sqlite.prepare("SELECT * FROM idea_artifacts WHERE id = ?").get("artifact-1");
  const memory = sqlite.prepare("SELECT * FROM idea_memory WHERE project_id = ?").get("project-1");
  assert.equal(session.title, "Existing idea");
  assert.equal(session.workflow_state, "session_ready");
  assert.equal(artifact.content, "preserve me");
  assert.equal(artifact.source_manifest_json, "[]");
  assert.equal(memory.memory_json, "{\"fact\":\"preserve me\"}");
  assert.equal(memory.version, 0);
  assert.deepEqual(sqlite.prepare("PRAGMA foreign_key_check").all(), []);
});

test("enqueue is idempotent and stores no prompt or credential payload", async () => {
  const { sqlite, db } = await database();
  seedProject(sqlite);
  const input = await executionInput();
  const first = await enqueueIdeaExecution(db, input);
  const second = await enqueueIdeaExecution(db, input);
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(first.execution.id, second.execution.id);
  assert.equal((await listIdeaExecutions(db, "project-1")).length, 1);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM idea_workflow_events").get().count, 1);
  const stored = sqlite.prepare("SELECT input_manifest_json FROM idea_executions").get().input_manifest_json;
  assert.equal(stored.includes("input"), false);
  assert.equal(stored.includes("token"), false);
  await assert.rejects(
    enqueueIdeaExecution(db, await executionInput({ idempotencyKey: "invalid-digest", inputSha256: "not-a-digest" })),
    /SHA-256 digest/,
  );
});

test("only one worker can claim an execution and an expired lease can be reclaimed", async () => {
  const { sqlite, db } = await database();
  seedProject(sqlite);
  const queued = await enqueueIdeaExecution(db, await executionInput({ maxAttempts: 3 }));
  const firstClaim = await claimIdeaExecution(db, {
    executionId: queued.execution.id,
    workerId: "worker-a",
    now: "2026-11-13T00:02:00.000Z",
    leaseSeconds: 30,
  });
  const competingClaim = await claimIdeaExecution(db, {
    executionId: queued.execution.id,
    workerId: "worker-b",
    now: "2026-11-13T00:02:05.000Z",
    leaseSeconds: 30,
  });
  const reclaimed = await claimIdeaExecution(db, {
    executionId: queued.execution.id,
    workerId: "worker-b",
    now: "2026-11-13T00:03:00.000Z",
    leaseSeconds: 30,
  });
  assert.equal(firstClaim.claimed, true);
  assert.equal(competingClaim.claimed, false);
  assert.equal(reclaimed.claimed, true);
  assert.notEqual(reclaimed.lease_token, firstClaim.lease_token);
  assert.equal(reclaimed.execution.attempt_count, 2);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM idea_execution_attempts").get().count, 2);
  assert.deepEqual(
    sqlite.prepare("SELECT attempt_no, status, error_code FROM idea_execution_attempts ORDER BY attempt_no").all().map((row) => ({ ...row })),
    [
      { attempt_no: 1, status: "failed", error_code: "LEASE_EXPIRED" },
      { attempt_no: 2, status: "running", error_code: null },
    ],
  );
});

test("completion requires the active lease and failed attempts retry safely", async () => {
  const { sqlite, db } = await database();
  seedProject(sqlite);
  const queued = await enqueueIdeaExecution(db, await executionInput());
  const claim = await claimIdeaExecution(db, {
    executionId: queued.execution.id,
    workerId: "worker-a",
    now: "2026-11-13T00:02:00.000Z",
  });
  const stale = await finishIdeaExecution(db, {
    executionId: queued.execution.id,
    attemptNo: 1,
    leaseToken: "wrong-lease",
    succeeded: true,
    outputSha256: await sha256("output"),
    now: "2026-11-13T00:02:10.000Z",
  });
  assert.equal(stale.adopted, false);
  const failed = await finishIdeaExecution(db, {
    executionId: queued.execution.id,
    attemptNo: 1,
    leaseToken: claim.lease_token,
    succeeded: false,
    errorCode: "UPSTREAM_TIMEOUT",
    errorMessage: "Authorization: Bearer secret-value",
    now: "2026-11-13T00:02:11.000Z",
  });
  assert.equal(failed.adopted, true);
  assert.equal(failed.execution.status, "queued");
  assert.equal(failed.execution.error_message.includes("secret-value"), false);
});

test("queued executions cancel immediately while running executions request cooperative cancellation", async () => {
  const { sqlite, db } = await database();
  seedProject(sqlite);
  const queued = await enqueueIdeaExecution(db, await executionInput());
  const cancelled = await cancelIdeaExecution(db, {
    projectId: "project-1",
    executionId: queued.execution.id,
    actorId: "user-1",
    now: "2026-11-13T00:02:00.000Z",
  });
  assert.equal(cancelled.changed, true);
  assert.equal(cancelled.execution.status, "cancelled");

  const runningSeed = await enqueueIdeaExecution(db, await executionInput({ idempotencyKey: "draft:artifact-1:v2" }));
  await claimIdeaExecution(db, {
    executionId: runningSeed.execution.id,
    workerId: "worker-a",
    now: "2026-11-13T00:03:00.000Z",
  });
  const requested = await cancelIdeaExecution(db, {
    projectId: "project-1",
    executionId: runningSeed.execution.id,
    actorId: "user-1",
    now: "2026-11-13T00:03:05.000Z",
  });
  assert.equal(requested.changed, true);
  assert.equal(requested.execution.status, "cancel_requested");
});

test("diagnostic redaction removes common secret formats", () => {
  const message = redactDiagnostic("token=abc123 github_pat_secret Bearer top.secret.value");
  assert.equal(message.includes("abc123"), false);
  assert.equal(message.includes("github_pat_secret"), false);
  assert.equal(message.includes("top.secret.value"), false);
});
