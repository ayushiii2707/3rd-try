// Behaviour tests for the repository audit fixes: cross-site protection,
// host validation, request limits, page identity, credential storage,
// provider discovery, setup validation, and idea-workflow integrity.
import assert from "node:assert/strict";
import { randomBytes, webcrypto } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { MAX_BODY_BYTES, startLocalBackend } from "../scripts/local-backend.mjs";

const nativeFetch = globalThis.fetch;
const KEY = Buffer.alloc(32, 11).toString("base64");

const jsonResponse = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

// A configurable stand-in for GitHub and the model provider. Nothing leaves the machine.
function createProviderMock() {
  const mock = {
    seenTokens: [],
    branchPages: [["main", "develop"]],
    contentsStatus: 200,
    aiStatus: 200,
    aiContent: JSON.stringify({ summary: "No findings.", findings: [] }),
    offline: false,
    async fetch(input, init = {}) {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (mock.offline) throw new Error(`Unexpected network call to ${url.host}`);
      if (url.host === "api.github.com") {
        mock.seenTokens.push(request.headers.get("authorization"));
        const repoMatch = url.pathname.match(/^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/);
        if (!repoMatch) return jsonResponse({ message: "Not Found" }, 404);
        const [, owner, repo, rest = ""] = repoMatch;
        if (!rest) {
          return jsonResponse({
            id: `${owner}-${repo}`.length * 1000 + repo.length,
            name: repo, owner: { login: owner }, html_url: `https://github.com/${owner}/${repo}`,
            default_branch: "main", private: true, permissions: { pull: true },
          });
        }
        if (rest === "/branches") {
          const page = Number(url.searchParams.get("page") || 1);
          const names = mock.branchPages[page - 1] || [];
          const headers = page < mock.branchPages.length
            ? { link: `<https://api.github.com/repos/${owner}/${repo}/branches?per_page=100&page=${page + 1}>; rel="next"` }
            : {};
          return jsonResponse(names.map((name) => ({ name })), 200, headers);
        }
        if (rest === "/contents") {
          return mock.contentsStatus === 404
            ? jsonResponse({ message: "This repository is empty." }, 404)
            : jsonResponse([{ type: "dir", name: "src" }, { type: "file", name: "README.md" }]);
        }
        if (rest === "/labels") return jsonResponse([{ name: "bug", color: "d73a4a", description: "Something is broken" }]);
      }
      if (url.host === "mock-ai.invalid") {
        if (mock.aiStatus !== 200) return jsonResponse({ error: { message: "temporary failure" } }, mock.aiStatus);
        const body = JSON.parse(await request.text());
        const prompt = body.messages.map((message) => message.content).join("\n");
        const content = prompt.includes('Return {"ok":true}') ? JSON.stringify({ ok: true })
          : prompt.includes("Begin a Socratic discovery session") ? JSON.stringify({ reply: "Who is this for?", hypothesis: "", ready: false, memory: {} })
          : mock.aiContent;
        return jsonResponse({ choices: [{ message: { content } }] });
      }
      throw new Error(`Unexpected external request: ${request.method} ${request.url}`);
    },
  };
  return mock;
}

async function withBackend(run, { env = {} } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "adis-audit-"));
  const databasePath = join(directory, "adis.sqlite");
  const mock = createProviderMock();
  globalThis.fetch = (input, init) => mock.fetch(input, init);
  const backendEnv = {
    CREDENTIAL_ENCRYPTION_KEY: KEY,
    TRUST_USER_HEADER: "",
    AI_API_KEY: "mock-model-key",
    AI_BASE_URL: "https://mock-ai.invalid/v1",
    AI_MODEL: "mock-model",
    ADIS_USER_NAME: "",
    ADIS_WORKSPACE_NAME: "",
    ...env,
  };
  let backend = await startLocalBackend({ databasePath, env: backendEnv });
  const responses = [];
  const call = async (path, { method = "GET", body, headers = {} } = {}) => {
    const response = await nativeFetch(`${backend.origin}${path}`, {
      method,
      headers: { ...(method === "GET" ? {} : { "content-type": "application/json" }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    responses.push(text);
    let payload = null;
    try { payload = JSON.parse(text); } catch {}
    return { status: response.status, headers: response.headers, body: payload, text };
  };
  const context = {
    directory, databasePath, mock, call, responses,
    get backend() { return backend; },
    async restart(nextEnv = {}) {
      await backend.close();
      backend = await startLocalBackend({ databasePath, env: { ...backendEnv, ...nextEnv } });
    },
  };
  try {
    await run(context);
  } finally {
    await backend.close();
    globalThis.fetch = nativeFetch;
  }
}

async function createProject(call, code = "AUDIT") {
  const created = await call("/api/projects", { method: "POST", body: { name: "Audit project", code } });
  assert.equal(created.status, 201, created.text);
  return created.body.project.id;
}

function rawRequest(origin, { path = "/api/projects", host, method = "GET", headers = {}, body } = {}) {
  const url = new URL(origin);
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: url.hostname, port: url.port, path, method, headers: { host, ...headers } }, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

test("state-changing API calls from other sites are rejected", async () => {
  await withBackend(async ({ call, backend }) => {
    const plain = await nativeFetch(`${backend.origin}/api/projects`, {
      method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify({ name: "x", code: "EVIL" }),
    });
    assert.equal(plain.status, 415);
    const foreignOrigin = await call("/api/projects", { method: "POST", body: { name: "x", code: "EVIL" }, headers: { origin: "https://evil.example" } });
    assert.equal(foreignOrigin.status, 403);
    const crossSite = await call("/api/projects", { method: "POST", body: { name: "x", code: "EVIL" }, headers: { "sec-fetch-site": "cross-site" } });
    assert.equal(crossSite.status, 403);
    const sameSiteOtherPort = await call("/api/projects", { method: "POST", body: { name: "x", code: "EVIL" }, headers: { "sec-fetch-site": "same-site" } });
    assert.equal(sameSiteOtherPort.status, 403);
    const sameOrigin = await call("/api/projects", { method: "POST", body: { name: "Mine", code: "MINE" }, headers: { origin: backend.origin, "sec-fetch-site": "same-origin" } });
    assert.equal(sameOrigin.status, 201, sameOrigin.text);
    const listed = await call("/api/projects");
    assert.deepEqual(listed.body.projects.map((project) => project.code), ["MINE"]);
  });
});

test("requests addressed to an unknown host name are refused", async () => {
  await withBackend(async ({ backend }) => {
    const port = new URL(backend.origin).port;
    const rebinding = await rawRequest(backend.origin, { host: `attacker.example:${port}` });
    assert.equal(rebinding.status, 403);
    assert.equal((await rawRequest(backend.origin, { host: `localhost:${port}` })).status, 200);
    assert.equal((await rawRequest(backend.origin, { host: `127.0.0.1:${port}` })).status, 200);
  });
});

test("oversized request bodies are rejected before reaching the app", async () => {
  await withBackend(async ({ backend }) => {
    const port = new URL(backend.origin).port;
    const response = await rawRequest(backend.origin, {
      method: "POST", host: `localhost:${port}`, headers: { "content-type": "application/json" },
      body: "x".repeat(MAX_BODY_BYTES + 10),
    }).catch((error) => ({ status: error.code === "EPIPE" || error.code === "ECONNRESET" ? 413 : 0 }));
    assert.equal(response.status, 413);
  });
});

test("the page carries security headers and the configured local identity", async () => {
  await withBackend(async ({ call }) => {
    const page = await call("/");
    assert.equal(page.status, 200);
    const csp = page.headers.get("content-security-policy") || "";
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /connect-src 'self'/);
    assert.equal(page.headers.get("x-frame-options"), "DENY");
    assert.match(page.text, /const viewer=\{"name":"Priya Shah","role":"Owner","workspace":"Team \\u003cHub>","initials":"PS"\}/);
    assert.doesNotMatch(page.text, /ayushi|TEST-A|__ADIS_VIEWER_JSON__/i);
    assert.doesNotMatch(page.text, />Run scan</);
  }, { env: { ADIS_USER_NAME: "Priya Shah", ADIS_WORKSPACE_NAME: "Team <Hub>" } });
});

test("repository credentials are encrypted, bound to their row, and never exposed", async () => {
  await withBackend(async ({ call, databasePath, mock, responses, restart }) => {
    const projectId = await createProject(call);
    const token = `ghp_${randomBytes(18).toString("hex")}`;
    const first = await call(`/api/projects/${projectId}/connections`, { method: "POST", body: { provider: "github", owner: "acme", repository: "alpha", pat: token } });
    assert.equal(first.status, 201, first.text);
    const second = await call(`/api/projects/${projectId}/connections`, { method: "POST", body: { provider: "github", owner: "acme", repository: "beta-service", pat: `ghp_${randomBytes(18).toString("hex")}` } });
    assert.equal(second.status, 201, second.text);
    assert.ok(mock.seenTokens.includes(`Bearer ${token}`), "the provider received the real token");

    const discovered = await call(`/api/projects/${projectId}/connections/${first.body.connection.id}/discover`, { method: "POST" });
    assert.equal(discovered.status, 200, discovered.text);
    await call(`/api/projects/${projectId}/connections`);
    await call(`/api/projects/${projectId}/connections/${first.body.connection.id}/labels`);

    // No API response ever contains the token.
    assert.ok(responses.every((text) => !text.includes(token)));

    // Neither the database file nor its write-ahead log holds the plaintext.
    for (const file of [databasePath, `${databasePath}-wal`]) {
      const bytes = await readFile(file).catch(() => Buffer.alloc(0));
      assert.equal(bytes.includes(Buffer.from(token)), false, `${file} must not contain the token`);
    }

    const sqlite = new DatabaseSync(databasePath);
    const rows = sqlite.prepare("SELECT id, encrypted_pat, credential_iv, credential_version FROM repository_connections ORDER BY repository").all();
    assert.deepEqual(rows.map((row) => row.credential_version), [2, 2]);

    // A ciphertext copied into another row cannot be decrypted there.
    sqlite.prepare("UPDATE repository_connections SET encrypted_pat = ?, credential_iv = ? WHERE id = ?").run(rows[0].encrypted_pat, rows[0].credential_iv, rows[1].id);
    const swapped = await call(`/api/projects/${projectId}/connections/${rows[1].id}/discover`, { method: "POST" });
    assert.equal(swapped.status, 409);
    assert.match(swapped.body.error, /cannot be read/);

    // Records written before version 2 (no associated data) still decrypt.
    const key = await webcrypto.subtle.importKey("raw", Buffer.from(KEY, "base64"), { name: "AES-GCM" }, false, ["encrypt"]);
    const iv = webcrypto.getRandomValues(new Uint8Array(12));
    const legacy = Buffer.from(await webcrypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(token)));
    sqlite.prepare("UPDATE repository_connections SET encrypted_pat = ?, credential_iv = ?, credential_version = 1 WHERE id = ?")
      .run(legacy.toString("base64"), Buffer.from(iv).toString("base64"), rows[1].id);
    sqlite.close();
    const legacyDiscover = await call(`/api/projects/${projectId}/connections/${rows[1].id}/discover`, { method: "POST" });
    assert.equal(legacyDiscover.status, 200, legacyDiscover.text);

    // With the wrong key the app reports a reconnect instead of crashing.
    await restart({ CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 12).toString("base64") });
    const wrongKey = await call(`/api/projects/${projectId}/connections/${rows[0].id}/discover`, { method: "POST" });
    assert.equal(wrongKey.status, 409);
    assert.match(wrongKey.body.error, /Reconnect this repository/);
    assert.ok(!wrongKey.text.includes(token));
  });
});

test("GitHub discovery follows pagination, handles empty repositories, and branch reads use the cache", async () => {
  await withBackend(async ({ call, mock }) => {
    const projectId = await createProject(call);
    mock.branchPages = [Array.from({ length: 100 }, (_, index) => `feature-${index}`), ["main", "release"]];
    mock.contentsStatus = 404;
    const connection = (await call(`/api/projects/${projectId}/connections`, { method: "POST", body: { provider: "github", owner: "acme", repository: "empty", pat: "ghp_example" } })).body.connection;
    const discovered = await call(`/api/projects/${projectId}/connections/${connection.id}/discover`, { method: "POST" });
    assert.equal(discovered.status, 200, discovered.text);
    assert.equal(discovered.body.branches.length, 102);
    assert.ok(discovered.body.branches.includes("release"));
    assert.deepEqual(discovered.body.folders, []);

    mock.offline = true;
    const cached = await call(`/api/projects/${projectId}/connections/${connection.id}/branches`);
    assert.equal(cached.status, 200, cached.text);
    assert.equal(cached.body.cached, true);
    assert.equal(cached.body.branches.length, 102);
  });
});

test("setup only accepts this project's connection and a real branch, and keeps omitted fields", async () => {
  await withBackend(async ({ call }) => {
    const projectId = await createProject(call, "SETUPA");
    const otherProjectId = await createProject(call, "SETUPB");
    const connection = (await call(`/api/projects/${projectId}/connections`, { method: "POST", body: { provider: "github", owner: "acme", repository: "alpha", pat: "ghp_example" } })).body.connection;
    const foreign = (await call(`/api/projects/${otherProjectId}/connections`, { method: "POST", body: { provider: "github", owner: "acme", repository: "gamma", pat: "ghp_example" } })).body.connection;

    const crossProject = await call(`/api/projects/${projectId}/setup`, { method: "PATCH", body: { connection_id: foreign.id } });
    assert.equal(crossProject.status, 400);

    // Finishing requires a branch confirmed by discovery.
    await call(`/api/projects/${projectId}/setup`, { method: "PATCH", body: { connection_id: connection.id, selected_branch: "main", service_type: "API" } });
    const unconfirmed = await call(`/api/projects/${projectId}/setup/finish`, { method: "POST" });
    assert.equal(unconfirmed.status, 400);

    await call(`/api/projects/${projectId}/connections/${connection.id}/discover`, { method: "POST" });
    const missingBranch = await call(`/api/projects/${projectId}/setup`, { method: "PATCH", body: { connection_id: connection.id, selected_branch: "does-not-exist" } });
    assert.equal(missingBranch.status, 400);

    assert.equal((await call(`/api/projects/${projectId}/setup`, { method: "PATCH", body: { import_issues: true } })).status, 200);
    assert.equal((await call(`/api/projects/${projectId}/setup`, { method: "PATCH", body: { label_mapping: { bug: "Issue" } } })).status, 200);
    const setup = (await call(`/api/projects/${projectId}/setup`)).body.setup;
    assert.equal(setup.import_issues, 1, "a partial update must not reset import_issues");
    assert.equal(setup.selected_branch, "main");

    const azure = await call(`/api/projects/${projectId}/setup`, { method: "PATCH", body: { work_tracking: "azure" } });
    assert.equal(azure.status, 200);
    assert.equal((await call(`/api/projects/${projectId}/setup`)).body.setup.work_tracking, "none");

    const finished = await call(`/api/projects/${projectId}/setup/finish`, { method: "POST" });
    assert.equal(finished.status, 200, finished.text);
  });
});

test("API errors are classified honestly", async () => {
  await withBackend(async ({ call }) => {
    const projectId = await createProject(call, "ERRORS");
    const duplicate = await call("/api/projects", { method: "POST", body: { name: "Again", code: "ERRORS" } });
    assert.equal(duplicate.status, 409);
    const readOnly = await call(`/api/projects/${projectId}/idea/executions`, { method: "POST", body: { operation: "draft_section" } });
    assert.equal(readOnly.status, 405, "execution records are read-only; model calls run only through workflow steps");
    const unknownDecision = await call(`/api/projects/${projectId}/idea/findings/missing`, { method: "PATCH", body: { decision: "accept" } });
    assert.equal(unknownDecision.status, 404);
  });
});

test("a failed Elephant reply leaves no orphan message, and the agent label matches the model", async () => {
  await withBackend(async ({ call, mock, databasePath }) => {
    const projectId = await createProject(call, "CHAT");
    const agent = await call(`/api/projects/${projectId}/idea/agent`, { method: "POST" });
    assert.equal(agent.status, 201, agent.text);
    assert.equal(agent.body.agent.model, "mock-model");
    assert.equal((await call(`/api/projects/${projectId}/idea/start`, { method: "POST" })).status, 201);

    mock.aiStatus = 500;
    const failed = await call(`/api/projects/${projectId}/idea/messages`, { method: "POST", body: { content: "It is for small teams." } });
    assert.equal(failed.status, 503);
    const sqlite = new DatabaseSync(databasePath, { readOnly: true });
    const roles = sqlite.prepare("SELECT role FROM idea_messages WHERE project_id = ? ORDER BY created_at").all(projectId).map((row) => row.role);
    sqlite.close();
    assert.deepEqual(roles, ["assistant"]);
  });
});
