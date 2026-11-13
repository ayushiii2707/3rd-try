import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { startLocalBackend } from "../scripts/local-backend.mjs";

const nativeFetch = globalThis.fetch;
const conceptBrief = `# Working hypothesis
The persistent workflow is viable.

# Problem
Project planning data must survive restarts.

# Target users
Product teams using ADIS.

# Desired outcomes
Durable, traceable planning records.

# In scope
The local Worker and its existing APIs.

# Out of scope
Production deployment.

# Constraints
No paid or live provider calls.

# Assumptions
SQLite faithfully adapts the D1 API used here.

# Risks
Production schema drift still requires read-only inspection.

# Success measures
All records remain readable after a restart.

# Open questions
Production binding identity is not available locally.`;

const initialPlan = `# PLAN_VERSION_ONE

## Goal
Persist the complete idea workflow.

## Acceptance criteria
The API stores every generated artifact.`;

const revisedPlan = `# PLAN_VERSION_TWO

## Goal
Persist the complete idea workflow.

## Acceptance criteria
The API stores every generated artifact and proves that records survive a backend restart.`;

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function externalMock(input, init = {}) {
  const request = input instanceof Request ? input : new Request(input, init);
  const url = new URL(request.url);
  if (url.hostname === "api.github.com") {
    assert.equal(request.headers.get("authorization"), "Bearer github-secret-value");
    if (url.pathname.endsWith("/branches")) return jsonResponse([{ name: "main" }]);
    if (url.pathname.endsWith("/contents")) return jsonResponse([{ type: "dir", name: "src" }]);
    if (url.pathname.endsWith("/labels")) return jsonResponse([]);
    return jsonResponse({
      id: 314159,
      name: "gh-repo",
      owner: { login: "gh-owner" },
      html_url: "https://github.com/gh-owner/gh-repo",
      default_branch: "main",
      private: true,
      permissions: { pull: true, push: false, admin: false },
    });
  }
  if (url.hostname === "api.bitbucket.org") {
    const authorization = request.headers.get("authorization") || "";
    assert.ok(
      authorization === "Bearer bitbucket-secret-value"
      || authorization === `Basic ${Buffer.from("user@example.com:bitbucket-secret-value").toString("base64")}`
      || authorization === `Basic ${Buffer.from("bb-user:bitbucket-secret-value").toString("base64")}`,
    );
    if (url.pathname.includes("/refs/branches")) return jsonResponse({ values: [{ name: "main" }] });
    if (url.pathname.includes("/src/main/")) return jsonResponse({ values: [{ type: "commit_directory", path: "src" }] });
    return jsonResponse({
      uuid: "{bb-repo-uuid}",
      slug: "bb-repo",
      full_name: "bb-space/bb-repo",
      workspace: { slug: "bb-space" },
      links: { html: { href: "https://bitbucket.org/bb-space/bb-repo" } },
      mainbranch: { name: "main" },
      is_private: true,
    });
  }
  if (url.hostname === "mock-ai.invalid") {
    const body = JSON.parse(await request.text());
    const prompt = body.messages.map((message) => message.content).join("\n");
    let content = conceptBrief;
    if (prompt.includes('Return {"ok":true}')) content = JSON.stringify({ ok: true });
    else if (prompt.includes("Begin a Socratic discovery")) content = JSON.stringify({
      reply: "Who experiences this problem most often?",
      hypothesis: "The workflow needs durable planning memory.",
      ready: false,
      memory: { known_facts: ["Persistence is required"], assumptions: [], constraints: [], decisions: [], open_questions: ["Primary user?"] },
    });
    else if (prompt.includes("Ask one concise")) content = JSON.stringify({
      reply: "The concept is ready for a brief.",
      hypothesis: "A persistent Worker lifecycle addresses the need.",
      ready: true,
      memory: { known_facts: ["Product teams are primary users"], assumptions: [], constraints: ["No production changes"], decisions: ["Use the existing Worker"], open_questions: [] },
    });
    else if (prompt.includes("Create the complete plan.md")) content = initialPlan;
    else if (prompt.includes("PLAN.MD ONLY:")) {
      const systemPrompt = body.messages.find((message) => message.role === "system")?.content || "";
      const shouldFindGap = prompt.includes("PLAN_VERSION_ONE") && systemPrompt.includes("independent Scope reviewer");
      content = JSON.stringify(shouldFindGap ? {
        summary: "Scope gap found.",
        findings: [{
          severity: "Major",
          title: "Clarify persistence boundary",
          detail: "The plan does not state the restart acceptance check.",
          recommendation: "Add an explicit restart persistence criterion.",
        }],
      } : { summary: "No findings.", findings: [] });
    }
    else if (prompt.includes("ACCEPTED GOLDFISH FINDINGS")) content = revisedPlan;
    return jsonResponse({
      id: "mock-model-request",
      choices: [{ message: { content } }],
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    });
  }
  throw new Error(`Unexpected external request: ${request.method} ${request.url}`);
}

async function api(origin, path, { method = "GET", body, user = "integration-user" } = {}) {
  const response = await nativeFetch(`${origin}${path}`, {
    method,
    headers: {
      "oai-authenticated-user-id": user,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(`${method} ${path} returned ${response.status}: ${JSON.stringify(payload)}`);
  return payload;
}

test("existing application APIs persist complete local lifecycle across a backend restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "adis-local-integration-"));
  const databasePath = join(directory, "adis.sqlite");
  const env = {
    CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    AI_API_KEY: "mock-model-key",
    AI_BASE_URL: "https://mock-ai.invalid/v1",
    AI_MODEL: "mock-planner",
  };
  let backend;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = externalMock;
  try {
    backend = await startLocalBackend({ databasePath, env });
    const frontendResponse = await nativeFetch(backend.origin);
    assert.equal(frontendResponse.status, 200);
    assert.match(frontendResponse.headers.get("content-type") || "", /text\/html/);
    const frontend = await frontendResponse.text();
    assert.match(frontend, /I have code/i);
    assert.match(frontend, /starting from an idea/i);
    assert.doesNotMatch(frontend, /Azure DevOps/);

    const created = await api(backend.origin, "/api/projects", {
      method: "POST",
      body: { name: "Persistent project", code: "PERSIST", description: "Restart integration verification" },
    });
    const projectId = created.project.id;

    await api(backend.origin, `/api/projects/${projectId}/idea`, {
      method: "PATCH",
      body: { title: "Persistent idea", stage: "workspace" },
    });
    await api(backend.origin, `/api/projects/${projectId}/idea/agent`, { method: "POST" });
    await api(backend.origin, `/api/projects/${projectId}/idea/start`, { method: "POST" });
    await api(backend.origin, `/api/projects/${projectId}/idea/messages`, {
      method: "POST",
      body: { content: "Product teams need durable project planning after restarts." },
    });
    const artifactResult = await api(backend.origin, `/api/projects/${projectId}/idea/artifacts`, {
      method: "POST",
      body: { kind: "concept_brief" },
    });
    assert.equal(artifactResult.artifact.kind, "concept_brief");

    const githubResult = await api(backend.origin, `/api/projects/${projectId}/connections`, {
      method: "POST",
      body: { provider: "github", owner: "gh-owner", repository: "gh-repo", pat: "github-secret-value" },
    });
    const bitbucketResult = await api(backend.origin, `/api/projects/${projectId}/connections`, {
      method: "POST",
      body: { provider: "bitbucket", workspace: "bb-space", repository: "bb-repo", token: "bitbucket-secret-value", email: "user@example.com", username: "bb-user" },
    });
    const githubId = githubResult.connection.id;
    const bitbucketId = bitbucketResult.connection.id;

    const githubDiscovery = await api(backend.origin, `/api/projects/${projectId}/connections/${githubId}/discover`, { method: "POST" });
    const bitbucketDiscovery = await api(backend.origin, `/api/projects/${projectId}/connections/${bitbucketId}/discover`, { method: "POST" });
    assert.deepEqual(githubDiscovery.branches, ["main"]);
    assert.deepEqual(bitbucketDiscovery.branches, ["main"]);

    await api(backend.origin, `/api/projects/${projectId}/setup`, {
      method: "PATCH",
      body: {
        connection_id: githubId,
        selected_branch: "main",
        product_mode: "whole",
        product_name: "Persistent product",
        service_type: "Service",
        environments: ["Production", "Development"],
        work_tracking: "none",
        import_issues: true,
        label_mapping: {},
        onboarding_stage: "complete",
      },
    });
    await api(backend.origin, `/api/projects/${projectId}/setup/finish`, { method: "POST" });

    await backend.close();
    backend = await startLocalBackend({ databasePath, env });

    const restoredProject = await api(backend.origin, `/api/projects/${projectId}`);
    const restoredWorkflow = await api(backend.origin, `/api/projects/${projectId}/idea/workflow`);
    const restoredExecutions = await api(backend.origin, `/api/projects/${projectId}/idea/executions`);
    const restoredConnections = await api(backend.origin, `/api/projects/${projectId}/connections`);
    const restoredSetup = await api(backend.origin, `/api/projects/${projectId}/setup`);
    assert.equal(restoredProject.project.code, "PERSIST");
    assert.ok(restoredWorkflow.messages.length >= 3);
    assert.equal(restoredWorkflow.artifacts.length, 1);
    assert.equal(restoredExecutions.executions.length, 1);
    assert.equal(restoredExecutions.executions[0].status, "succeeded");
    assert.equal(restoredConnections.connections.length, 2);
    assert.ok(restoredSetup.setup.setup_completed_at);

    assert.deepEqual((await api(backend.origin, `/api/projects/${projectId}/connections/${githubId}/branches`)).branches, ["main"]);
    assert.deepEqual((await api(backend.origin, `/api/projects/${projectId}/connections/${bitbucketId}/branches`)).branches, ["main"]);
    assert.deepEqual(
      (await api(backend.origin, `/api/projects/${projectId}/connections/${githubId}/discover`, { method: "POST" })).branches,
      ["main"],
    );
    assert.deepEqual(
      (await api(backend.origin, `/api/projects/${projectId}/connections/${bitbucketId}/discover`, { method: "POST" })).branches,
      ["main"],
    );

    const otherUserProjects = await api(backend.origin, "/api/projects", { user: "other-user" });
    assert.deepEqual(otherUserProjects.projects, []);
    const unauthorized = await nativeFetch(`${backend.origin}/api/projects/${projectId}`, { headers: { "oai-authenticated-user-id": "other-user" } });
    assert.equal(unauthorized.status, 404);

    await backend.close();
    backend = undefined;

    const sqlite = new DatabaseSync(databasePath);
    sqlite.exec("PRAGMA foreign_keys = ON");
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM d1_migrations").get().count, 7);
    assert.deepEqual(sqlite.prepare("PRAGMA foreign_key_check").all(), []);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM projects").get().count, 1);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM idea_sessions").get().count, 1);
    assert.ok(sqlite.prepare("SELECT COUNT(*) AS count FROM idea_messages").get().count >= 3);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM idea_artifacts").get().count, 1);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM idea_executions").get().count, 1);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM idea_execution_attempts").get().count, 1);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM repository_connections").get().count, 2);
    const credentials = sqlite.prepare("SELECT provider, encrypted_pat, credential_iv FROM repository_connections ORDER BY provider").all();
    assert.equal(credentials.length, 2);
    assert.ok(credentials.every((row) => row.encrypted_pat && row.credential_iv));
    assert.ok(credentials.every((row) => !row.encrypted_pat.includes("secret-value")));
    const artifact = sqlite.prepare("SELECT content_sha256, prompt_version, source_manifest_json FROM idea_artifacts").get();
    assert.ok(artifact.content_sha256);
    assert.ok(artifact.prompt_version);
    assert.ok(Array.isArray(JSON.parse(artifact.source_manifest_json)));
    sqlite.close();
  } finally {
    if (backend) await backend.close();
    globalThis.fetch = originalFetch;
  }
});

test("Elephant and isolated Goldfish complete, converge, and resume without a repository", async () => {
  const directory = await mkdtemp(join(tmpdir(), "adis-egm-integration-"));
  const databasePath = join(directory, "adis.sqlite");
  const env = {
    CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"),
    AI_API_KEY: "mock-model-key",
    AI_BASE_URL: "https://mock-ai.invalid/v1",
    AI_MODEL: "mock-planner",
  };
  let backend;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = externalMock;
  try {
    backend = await startLocalBackend({ databasePath, env });
    const created = await api(backend.origin, "/api/projects", {
      method: "POST",
      body: { name: "Independent EGM", code: "EGM", description: "No repository required" },
    });
    const projectId = created.project.id;

    await api(backend.origin, `/api/projects/${projectId}/idea`, {
      method: "PATCH",
      body: { title: "Durable planning", stage: "workspace" },
    });
    assert.deepEqual((await api(backend.origin, `/api/projects/${projectId}/connections`)).connections, []);

    await api(backend.origin, `/api/projects/${projectId}/idea/agent`, { method: "POST" });
    await api(backend.origin, `/api/projects/${projectId}/idea/start`, { method: "POST" });
    await api(backend.origin, `/api/projects/${projectId}/idea/messages`, {
      method: "POST",
      body: { content: "Product teams need a plan that survives restarts." },
    });
    await api(backend.origin, `/api/projects/${projectId}/idea/artifacts`, {
      method: "POST",
      body: { kind: "concept_brief" },
    });
    const draft = await api(backend.origin, `/api/projects/${projectId}/idea/artifacts`, {
      method: "POST",
      body: { kind: "design_draft" },
    });
    assert.equal(draft.artifact.content, initialPlan);

    const firstReview = await api(backend.origin, `/api/projects/${projectId}/idea/review`, { method: "POST" });
    assert.equal(firstReview.run.round, 1);
    assert.equal(firstReview.findings.length, 1);
    await api(backend.origin, `/api/projects/${projectId}/idea/findings/${firstReview.findings[0].id}`, {
      method: "PATCH",
      body: { status: "accepted" },
    });
    const resolution = await api(backend.origin, `/api/projects/${projectId}/idea/resolve`, { method: "POST" });
    assert.equal(resolution.applied, 1);
    assert.equal(resolution.artifact.content, revisedPlan);

    const cleanOne = await api(backend.origin, `/api/projects/${projectId}/idea/review`, { method: "POST" });
    assert.equal(cleanOne.run.clean_rounds, 1);
    assert.equal(cleanOne.run.status, "complete");
    const converged = await api(backend.origin, `/api/projects/${projectId}/idea/review`, { method: "POST" });
    assert.equal(converged.run.clean_rounds, 2);
    assert.equal(converged.run.status, "converged");

    let workflow = await api(backend.origin, `/api/projects/${projectId}/idea/workflow`);
    assert.ok(workflow.messages.length >= 3);
    assert.equal(workflow.artifacts.length, 3);
    assert.equal(workflow.runs.length, 3);
    assert.equal(workflow.latest_run.status, "converged");
    assert.ok(Object.keys(workflow.memory).length > 0);
    assert.deepEqual((await api(backend.origin, `/api/projects/${projectId}/connections`)).connections, []);

    await backend.close();
    backend = await startLocalBackend({ databasePath, env });
    workflow = await api(backend.origin, `/api/projects/${projectId}/idea/workflow`);
    assert.equal(workflow.artifacts.length, 3);
    assert.equal(workflow.runs.length, 3);
    assert.equal(workflow.latest_run.status, "converged");
    assert.equal(workflow.findings.length, 0);

    await backend.close();
    backend = undefined;
    const sqlite = new DatabaseSync(databasePath);
    sqlite.exec("PRAGMA foreign_keys = ON");
    assert.deepEqual(sqlite.prepare("PRAGMA foreign_key_check").all(), []);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM projects").get().count, 1);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM idea_sessions").get().count, 1);
    assert.ok(sqlite.prepare("SELECT COUNT(*) AS count FROM idea_messages").get().count >= 3);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM idea_memory").get().count, 1);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM idea_artifacts").get().count, 3);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM idea_review_runs").get().count, 3);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM idea_findings").get().count, 1);
    assert.equal(sqlite.prepare("SELECT status FROM idea_findings").get().status, "fixed");
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM repository_connections").get().count, 0);
    sqlite.close();
  } finally {
    if (backend) await backend.close();
    globalThis.fetch = originalFetch;
  }
});

test("local runtime refuses to open a database without the existing encryption key contract", async () => {
  const directory = await mkdtemp(join(tmpdir(), "adis-key-integration-"));
  await assert.rejects(
    startLocalBackend({ databasePath: join(directory, "missing.sqlite"), env: { CREDENTIAL_ENCRYPTION_KEY: "" } }),
    /CREDENTIAL_ENCRYPTION_KEY is required/,
  );
  await assert.rejects(
    startLocalBackend({ databasePath: join(directory, "invalid.sqlite"), env: { CREDENTIAL_ENCRYPTION_KEY: "not-base64" } }),
    /valid base64-encoded 32-byte key/,
  );
});
