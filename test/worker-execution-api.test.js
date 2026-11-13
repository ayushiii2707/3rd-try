import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import worker from "../worker/index.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const migrationNames = [
  "0001_project_connections.sql",
  "0002_project_setup.sql",
  "0003_project_onboarding.sql",
  "0004_idea_sessions.sql",
  "0005_idea_workflow.sql",
  "0006_idea_agent_memory.sql",
  "0007_idea_execution_foundation.sql",
];

class D1Statement {
  constructor(database, sql, bindings = []) {
    this.database = database;
    this.sql = sql;
    this.bindings = bindings;
  }
  bind(...bindings) { return new D1Statement(this.database, this.sql, bindings); }
  first() { return this.database.prepare(this.sql).get(...this.bindings) ?? null; }
  all() { return { results: this.database.prepare(this.sql).all(...this.bindings) }; }
  run() {
    const result = this.database.prepare(this.sql).run(...this.bindings);
    return { meta: { changes: Number(result.changes) } };
  }
}

class D1Database {
  constructor(database) { this.database = database; }
  prepare(sql) { return new D1Statement(this.database, sql); }
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
  return { sqlite, env: { DB: new D1Database(sqlite), AI_MODEL: "test-model" } };
}

function request(env, path, { method = "GET", user = "user-1", body } = {}) {
  return worker.fetch(new Request(`https://local.test${path}`, {
    method,
    headers: {
      "oai-authenticated-user-id": user,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env);
}

const validConceptBrief = `# Working hypothesis
Build a reliable planning pipeline.

# Problem
Planning state is fragmented and difficult to resume.

# Target users
Product and engineering teams.

# Desired outcomes
A durable, reviewable plan.

# In scope
Concept brief generation and persistence.

# Out of scope
Ordered Goldfish review.

# Constraints
Use the existing Worker and D1 database.

# Assumptions
Use an idempotent execution lifecycle.

# Risks
The existing session contains enough discovery context.

# Success measures
Executions resume without duplicated artifacts.

# Open questions
Which review lenses should run first?`;

function modelResponse(content = validConceptBrief, status = 200) {
  if (status !== 200) {
    return new Response(JSON.stringify({ error: { message: "temporary provider failure" } }), {
      status,
      headers: { "content-type": "application/json" },
    });
  }
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

test("execution API is project-scoped, idempotent, cancellable, and makes no provider call", async () => {
  const { sqlite, env } = await database(7);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("External model calls are forbidden in foundation tests."); };
  try {
    const schemaResponse = await request(env, "/api/projects/project-1/idea/execution-schema");
    assert.equal(schemaResponse.status, 200);
    assert.equal((await schemaResponse.json()).schema.ready, true);

    const firstResponse = await request(env, "/api/projects/project-1/idea/executions", {
      method: "POST",
      body: { operation: "concept_brief" },
    });
    assert.equal(firstResponse.status, 201);
    const first = await firstResponse.json();
    assert.equal(first.created, true);
    assert.equal(first.execution.status, "queued");

    const repeatedResponse = await request(env, "/api/projects/project-1/idea/executions", {
      method: "POST",
      body: { operation: "concept_brief" },
    });
    assert.equal(repeatedResponse.status, 200);
    const repeated = await repeatedResponse.json();
    assert.equal(repeated.created, false);
    assert.equal(repeated.execution.id, first.execution.id);

    const listResponse = await request(env, "/api/projects/project-1/idea/executions?limit=10");
    assert.equal(listResponse.status, 200);
    assert.equal((await listResponse.json()).executions.length, 1);

    const cancelResponse = await request(env, `/api/projects/project-1/idea/executions/${first.execution.id}/cancel`, { method: "POST" });
    assert.equal(cancelResponse.status, 200);
    assert.equal((await cancelResponse.json()).execution.status, "cancelled");

    const unauthorized = await request(env, "/api/projects/project-1/idea/executions", { user: "user-2" });
    assert.equal(unauthorized.status, 404);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM idea_executions").get().count, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("execution API reports the pre-0007 schema and refuses to enqueue", async () => {
  const { env } = await database(6);
  const schemaResponse = await request(env, "/api/projects/project-1/idea/execution-schema");
  assert.equal(schemaResponse.status, 200);
  const schema = (await schemaResponse.json()).schema;
  assert.equal(schema.ready, false);
  assert.ok(schema.missing_tables.includes("idea_executions"));

  const enqueueResponse = await request(env, "/api/projects/project-1/idea/executions", {
    method: "POST",
    body: { operation: "concept_brief" },
  });
  assert.equal(enqueueResponse.status, 503);
  assert.equal((await enqueueResponse.json()).code, "IDEA_EXECUTION_SCHEMA_NOT_READY");
});

test("Elephant concept brief runs through the existing artifact route and is idempotently reused", async () => {
  const { sqlite, env } = await database(7);
  env.AI_API_KEY = "mock-key";
  env.AI_BASE_URL = "https://mock.invalid/v1";
  const originalFetch = globalThis.fetch;
  let providerCalls = 0;
  globalThis.fetch = async () => {
    providerCalls += 1;
    return modelResponse();
  };
  try {
    const firstResponse = await request(env, "/api/projects/project-1/idea/artifacts", {
      method: "POST",
      body: { kind: "concept_brief" },
    });
    assert.equal(firstResponse.status, 201);
    const first = await firstResponse.json();
    assert.equal(first.execution.status, "succeeded");
    assert.equal(first.artifact.kind, "concept_brief");
    assert.equal(first.artifact.prompt_version, "concept_brief-v1");
    assert.match(first.artifact.content_sha256, /^[a-f0-9]{64}$/);
    const provenance = JSON.parse(first.artifact.source_manifest_json);
    assert.ok(provenance.some((entry) => entry.kind === "idea_session"));
    assert.ok(provenance.some((entry) => entry.kind === "idea_message"));
    assert.ok(provenance.some((entry) => entry.kind === "idea_memory"));

    const attempt = sqlite.prepare("SELECT * FROM idea_execution_attempts WHERE execution_id = ?").get(first.execution.id);
    assert.equal(attempt.status, "succeeded");
    assert.equal(attempt.output_sha256, first.artifact.content_sha256);
    const session = sqlite.prepare("SELECT workflow_state, state_version FROM idea_sessions WHERE project_id = ?").get("project-1");
    assert.deepEqual({ ...session }, { workflow_state: "concept_brief_ready", state_version: 1 });
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM idea_workflow_events WHERE event_type = 'concept_brief_persisted'").get().count, 1);

    const repeatedResponse = await request(env, "/api/projects/project-1/idea/artifacts", {
      method: "POST",
      body: { kind: "concept_brief" },
    });
    assert.equal(repeatedResponse.status, 200);
    const repeated = await repeatedResponse.json();
    assert.equal(repeated.execution.id, first.execution.id);
    assert.equal(repeated.artifact.id, first.artifact.id);
    assert.equal(providerCalls, 1);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM idea_executions").get().count, 1);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM idea_artifacts WHERE kind = 'concept_brief'").get().count, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Elephant concept brief retries a provider failure and resumes the same execution", async () => {
  const { sqlite, env } = await database(7);
  env.AI_API_KEY = "mock-key";
  env.AI_BASE_URL = "https://mock.invalid/v1";
  const originalFetch = globalThis.fetch;
  let providerCalls = 0;
  globalThis.fetch = async () => {
    providerCalls += 1;
    return providerCalls === 1 ? modelResponse("", 500) : modelResponse();
  };
  try {
    const failedResponse = await request(env, "/api/projects/project-1/idea/artifacts", {
      method: "POST",
      body: { kind: "concept_brief" },
    });
    assert.equal(failedResponse.status, 503);
    const failed = await failedResponse.json();
    assert.equal(failed.code, "PROVIDER_ERROR");
    assert.equal(failed.retryable, true);
    const queued = sqlite.prepare("SELECT * FROM idea_executions").get();
    assert.equal(queued.status, "queued");
    assert.equal(queued.attempt_count, 1);
    assert.equal(sqlite.prepare("SELECT status FROM idea_execution_attempts WHERE execution_id = ? AND attempt_no = 1").get(queued.id).status, "failed");
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM idea_artifacts").get().count, 0);

    const resumedResponse = await request(env, "/api/projects/project-1/idea/artifacts", {
      method: "POST",
      body: { kind: "concept_brief" },
    });
    assert.equal(resumedResponse.status, 200);
    const resumed = await resumedResponse.json();
    assert.equal(resumed.execution.id, queued.id);
    assert.equal(resumed.execution.status, "succeeded");
    assert.equal(resumed.execution.attempt_count, 2);
    assert.equal(providerCalls, 2);
    assert.deepEqual(
      sqlite.prepare("SELECT attempt_no, status FROM idea_execution_attempts WHERE execution_id = ? ORDER BY attempt_no").all(queued.id).map((row) => ({ ...row })),
      [{ attempt_no: 1, status: "failed" }, { attempt_no: 2, status: "succeeded" }],
    );
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM idea_artifacts WHERE kind = 'concept_brief'").get().count, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Elephant processor rejects changed discovery input before calling the provider", async () => {
  const { sqlite, env } = await database(7);
  env.AI_API_KEY = "mock-key";
  env.AI_BASE_URL = "https://mock.invalid/v1";
  const originalFetch = globalThis.fetch;
  let providerCalls = 0;
  globalThis.fetch = async () => {
    providerCalls += 1;
    return modelResponse();
  };
  try {
    const enqueueResponse = await request(env, "/api/projects/project-1/idea/executions", {
      method: "POST",
      body: { operation: "concept_brief" },
    });
    assert.equal(enqueueResponse.status, 201);
    const queued = (await enqueueResponse.json()).execution;
    sqlite.prepare("INSERT INTO idea_messages (id, project_id, role, content, hypothesis, ready, created_at) VALUES (?, ?, ?, ?, '', 0, ?)")
      .run("message-2", "project-1", "user", "The discovery input changed.", "2026-11-13T00:01:00.000Z");

    const processResponse = await request(env, `/api/projects/project-1/idea/executions/${queued.id}/process`, { method: "POST" });
    assert.equal(processResponse.status, 409);
    const failure = await processResponse.json();
    assert.equal(failure.code, "INPUT_CHANGED");
    assert.equal(failure.retryable, false);
    assert.equal(providerCalls, 0);
    const execution = sqlite.prepare("SELECT status, attempt_count, error_code FROM idea_executions WHERE id = ?").get(queued.id);
    assert.deepEqual({ ...execution }, { status: "failed", attempt_count: 1, error_code: "INPUT_CHANGED" });
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM idea_artifacts").get().count, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
