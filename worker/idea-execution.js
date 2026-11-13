export const IDEA_REVIEW_STAGES = Object.freeze([
  "zoom_out", "comprehension", "critic", "intermediate_zoom_out",
  "implementation_readiness", "synthesis",
]);

export const IDEA_EXECUTION_OPERATIONS = Object.freeze([
  "concept_brief", "design_draft", "review_stage", "review_synthesis",
  "resolve_findings", "convergence_review",
]);

const REQUIRED_SCHEMA = Object.freeze({
  idea_sessions: ["workflow_state", "state_version", "completed_at"],
  idea_artifacts: ["parent_artifact_id", "content_sha256", "prompt_version", "source_manifest_json", "row_version"],
  idea_review_runs: ["workflow_version", "input_artifact_sha256", "current_stage", "updated_at", "cancel_requested_at"],
  idea_findings: ["artifact_id", "source_execution_id", "review_stage", "evidence_json", "resolution_note", "resolved_by", "updated_at", "row_version"],
  idea_memory: ["version", "memory_sha256"],
  idea_executions: ["id", "project_id", "idempotency_key", "agent_role", "operation", "input_sha256", "status", "lease_token", "lease_expires_at"],
  idea_execution_attempts: ["id", "execution_id", "attempt_no", "status", "input_sha256"],
  idea_review_stage_results: ["id", "run_id", "stage", "sequence", "status"],
  idea_artifact_approvals: ["id", "project_id", "artifact_id", "decision", "idempotency_key"],
  idea_workflow_events: ["id", "project_id", "event_type", "actor_type", "idempotency_key"],
});

// Raised for invalid caller input. Handlers map it to HTTP 400; any other
// TypeError is a programming error and is reported as a generic 500.
export class IdeaValidationError extends TypeError {
  constructor(message) {
    super(message);
    this.name = "IdeaValidationError";
  }
}

export class IdeaExecutionSchemaError extends Error {
  constructor(inventory) {
    super("The Elephant–Goldfish execution schema is not installed.");
    this.name = "IdeaExecutionSchemaError";
    this.code = "IDEA_EXECUTION_SCHEMA_NOT_READY";
    this.inventory = inventory;
  }
}

const values = (result) => result?.results ?? result ?? [];
const changes = (result) => Number(result?.meta?.changes ?? result?.changes ?? 0);
const iso = (value = new Date()) => value instanceof Date ? value.toISOString() : new Date(value).toISOString();
const id = () => crypto.randomUUID();
const statement = (db, sql, binds = []) => binds.length ? db.prepare(sql).bind(...binds) : db.prepare(sql);
const first = (db, sql, binds = []) => statement(db, sql, binds).first();
const all = async (db, sql, binds = []) => values(await statement(db, sql, binds).all());

export function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

export async function sha256(value) {
  const bytes = new TextEncoder().encode(typeof value === "string" ? value : canonicalJson(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function redactDiagnostic(value) {
  return String(value ?? "")
    .replace(/(?:github_pat_|ghp_|gho_|glpat-)[A-Za-z0-9_\-]+/gi, "[REDACTED_TOKEN]")
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, "Bearer [REDACTED]")
    .replace(/(authorization|token|password|secret)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .slice(0, 500);
}

export async function inspectIdeaExecutionSchema(db) {
  const tableRows = await all(db, "SELECT name FROM sqlite_master WHERE type = 'table'");
  const present = new Set(tableRows.map((row) => row.name));
  const missingTables = Object.keys(REQUIRED_SCHEMA).filter((name) => !present.has(name));
  const missingColumns = {};
  for (const [table, required] of Object.entries(REQUIRED_SCHEMA)) {
    if (!present.has(table)) continue;
    const columns = new Set((await all(db, `PRAGMA table_info(${table})`)).map((row) => row.name));
    const missing = required.filter((column) => !columns.has(column));
    if (missing.length) missingColumns[table] = missing;
  }
  return {
    ready: missingTables.length === 0 && Object.keys(missingColumns).length === 0,
    missing_tables: missingTables,
    missing_columns: missingColumns,
  };
}

export async function assertIdeaExecutionSchema(db) {
  const inventory = await inspectIdeaExecutionSchema(db);
  if (!inventory.ready) throw new IdeaExecutionSchemaError(inventory);
  return inventory;
}

function requireText(value, field, max = 200) {
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized.length > max) throw new IdeaValidationError(`${field} is required and must be at most ${max} characters.`);
  return normalized;
}

function requireSha256(value, field) {
  const normalized = requireText(value, field, 64);
  if (!/^[a-f0-9]{64}$/i.test(normalized)) throw new IdeaValidationError(`${field} must be a SHA-256 digest.`);
  return normalized.toLowerCase();
}

function parseJsonColumn(row) {
  if (!row) return row;
  const copy = { ...row };
  for (const key of ["input_manifest_json", "usage_json"]) {
    if (typeof copy[key] === "string") {
      try { copy[key.replace(/_json$/, "")] = JSON.parse(copy[key]); } catch { copy[key.replace(/_json$/, "")] = null; }
    }
    delete copy[key];
  }
  return copy;
}

export async function enqueueIdeaExecution(db, input) {
  await assertIdeaExecutionSchema(db);
  const projectId = requireText(input.projectId, "projectId");
  const idempotencyKey = requireText(input.idempotencyKey, "idempotencyKey");
  const operation = requireText(input.operation, "operation");
  const agentRole = requireText(input.agentRole, "agentRole");
  if (!IDEA_EXECUTION_OPERATIONS.includes(operation)) throw new IdeaValidationError("Unsupported idea execution operation.");
  if (!["elephant", "goldfish", "system"].includes(agentRole)) throw new IdeaValidationError("Unsupported idea agent role.");
  if (input.reviewStage && !IDEA_REVIEW_STAGES.includes(input.reviewStage)) throw new IdeaValidationError("Unsupported review stage.");
  const queuedAt = iso(input.now);
  const executionId = input.id || id();
  const eventId = id();
  const manifest = Array.isArray(input.inputManifest) ? input.inputManifest : [];
  const maxAttempts = Math.max(1, Math.min(5, Number(input.maxAttempts ?? 2)));
  const execution = statement(db, `INSERT INTO idea_executions (
    id, project_id, review_run_id, artifact_id, parent_execution_id, idempotency_key,
    agent_role, operation, review_stage, provider, model, adapter_version,
    prompt_version, persona_version, input_manifest_json, input_sha256, status,
    max_attempts, queued_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)
  ON CONFLICT(project_id, idempotency_key) DO NOTHING`, [
    executionId, projectId, input.reviewRunId ?? null, input.artifactId ?? null,
    input.parentExecutionId ?? null, idempotencyKey, agentRole, operation,
    input.reviewStage ?? null, requireText(input.provider, "provider"),
    requireText(input.model, "model"), requireText(input.adapterVersion, "adapterVersion"),
    requireText(input.promptVersion, "promptVersion"), requireText(input.personaVersion, "personaVersion"),
    canonicalJson(manifest), requireSha256(input.inputSha256, "inputSha256"), maxAttempts,
    queuedAt, queuedAt,
  ]);
  const event = statement(db, `INSERT INTO idea_workflow_events (
    id, project_id, execution_id, event_type, actor_type, actor_id, payload_json,
    idempotency_key, created_at
  ) SELECT ?, ?, id, 'execution_queued', ?, ?, ?, ?, ?
    FROM idea_executions WHERE project_id = ? AND idempotency_key = ?
  ON CONFLICT(project_id, idempotency_key) DO NOTHING`, [
    eventId, projectId, input.actorType === "user" ? "user" : "system",
    input.actorId ?? null, canonicalJson({ operation, review_stage: input.reviewStage ?? null }),
    `${idempotencyKey}:queued`, queuedAt, projectId, idempotencyKey,
  ]);
  const [insertResult] = await db.batch([execution, event]);
  const row = await first(db, "SELECT * FROM idea_executions WHERE project_id = ? AND idempotency_key = ?", [projectId, idempotencyKey]);
  return { created: changes(insertResult) > 0, execution: parseJsonColumn(row) };
}

export async function listIdeaExecutions(db, projectId, { limit = 50 } = {}) {
  await assertIdeaExecutionSchema(db);
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 50));
  const rows = await all(db, `SELECT * FROM idea_executions
    WHERE project_id = ? ORDER BY queued_at DESC LIMIT ?`, [requireText(projectId, "projectId"), safeLimit]);
  return rows.map(parseJsonColumn);
}

export async function getIdeaExecution(db, { projectId, executionId }) {
  await assertIdeaExecutionSchema(db);
  const row = await first(db, "SELECT * FROM idea_executions WHERE id = ? AND project_id = ?", [
    requireText(executionId, "executionId"), requireText(projectId, "projectId"),
  ]);
  return parseJsonColumn(row);
}

export async function claimIdeaExecution(db, { executionId, workerId, leaseSeconds = 60, now = new Date() }) {
  await assertIdeaExecutionSchema(db);
  const current = await first(db, "SELECT * FROM idea_executions WHERE id = ?", [requireText(executionId, "executionId")]);
  if (!current) return { claimed: false, reason: "not_found" };
  const attemptNo = Number(current.attempt_count) + 1;
  if (attemptNo > Number(current.max_attempts)) return { claimed: false, reason: "attempts_exhausted", execution: parseJsonColumn(current) };
  const claimedAt = iso(now);
  const leaseToken = id();
  const leaseExpiresAt = iso(new Date(new Date(now).getTime() + Math.max(10, leaseSeconds) * 1000));
  const expirePriorAttempt = statement(db, `UPDATE idea_execution_attempts SET
      status = 'failed', error_code = 'LEASE_EXPIRED',
      error_message = 'The worker lease expired before completion.', completed_at = ?
    WHERE execution_id = ? AND status = 'running'
      AND EXISTS (SELECT 1 FROM idea_executions WHERE id = ? AND status = 'running' AND lease_expires_at <= ?)`,
  [claimedAt, current.id, current.id, claimedAt]);
  const update = statement(db, `UPDATE idea_executions SET
      status = 'running', lease_token = ?, lease_expires_at = ?, heartbeat_at = ?,
      started_at = COALESCE(started_at, ?), attempt_count = attempt_count + 1,
      updated_at = ?, error_code = NULL, error_message = NULL
    WHERE id = ? AND attempt_count = ? AND attempt_count < max_attempts
      AND (status = 'queued' OR (status = 'running' AND lease_expires_at <= ?))`, [
    leaseToken, leaseExpiresAt, claimedAt, claimedAt, claimedAt,
    current.id, Number(current.attempt_count), claimedAt,
  ]);
  const attempt = statement(db, `INSERT INTO idea_execution_attempts (
      id, execution_id, attempt_no, status, input_sha256, started_at
    ) SELECT ?, id, ?, 'running', input_sha256, ? FROM idea_executions
      WHERE id = ? AND lease_token = ? AND status = 'running'`, [id(), attemptNo, claimedAt, current.id, leaseToken]);
  const event = statement(db, `INSERT INTO idea_workflow_events (
      id, project_id, execution_id, event_type, actor_type, actor_id, payload_json,
      idempotency_key, created_at
    ) SELECT ?, project_id, id, 'execution_claimed', 'system', ?, ?, ?, ?
      FROM idea_executions WHERE id = ? AND lease_token = ? AND status = 'running'`, [
    id(), requireText(workerId, "workerId"), canonicalJson({ attempt_no: attemptNo }),
    `${current.id}:claimed:${attemptNo}`, claimedAt, current.id, leaseToken,
  ]);
  const [, updateResult] = await db.batch([expirePriorAttempt, update, attempt, event]);
  const execution = await first(db, "SELECT * FROM idea_executions WHERE id = ?", [current.id]);
  return changes(updateResult) > 0
    ? { claimed: true, lease_token: leaseToken, execution: parseJsonColumn(execution) }
    : { claimed: false, reason: "already_claimed", execution: parseJsonColumn(execution) };
}

export async function cancelIdeaExecution(db, { projectId, executionId, actorId, now = new Date() }) {
  await assertIdeaExecutionSchema(db);
  const at = iso(now);
  const update = statement(db, `UPDATE idea_executions SET
      status = CASE status WHEN 'queued' THEN 'cancelled' ELSE 'cancel_requested' END,
      cancel_requested_at = ?, cancelled_at = CASE status WHEN 'queued' THEN ? ELSE cancelled_at END,
      completed_at = CASE status WHEN 'queued' THEN ? ELSE completed_at END,
      updated_at = ?
    WHERE id = ? AND project_id = ? AND status IN ('queued', 'running')`, [
    at, at, at, at, requireText(executionId, "executionId"), requireText(projectId, "projectId"),
  ]);
  const event = statement(db, `INSERT INTO idea_workflow_events (
      id, project_id, execution_id, event_type, actor_type, actor_id, payload_json,
      idempotency_key, created_at
    ) SELECT ?, project_id, id, 'execution_cancel_requested', 'user', ?, '{}', ?, ?
      FROM idea_executions WHERE id = ? AND project_id = ? AND cancel_requested_at = ?
    ON CONFLICT(project_id, idempotency_key) DO NOTHING`, [
    id(), actorId ?? null, `${executionId}:cancel:${at}`, at, executionId, projectId, at,
  ]);
  const [result] = await db.batch([update, event]);
  const execution = await first(db, "SELECT * FROM idea_executions WHERE id = ? AND project_id = ?", [executionId, projectId]);
  return { changed: changes(result) > 0, execution: parseJsonColumn(execution) };
}

export async function finishIdeaExecution(db, input) {
  await assertIdeaExecutionSchema(db);
  const at = iso(input.now);
  const status = input.succeeded ? "succeeded" : "failed";
  const safeError = input.succeeded ? null : redactDiagnostic(input.errorMessage || "Execution failed.");
  const outputSha = input.outputSha256 ?? null;
  const attempt = statement(db, `UPDATE idea_execution_attempts SET
      status = ?, output_sha256 = ?, result_json = ?, usage_json = ?, error_code = ?,
      error_message = ?, completed_at = ?
    WHERE execution_id = ? AND attempt_no = ? AND status = 'running'
      AND EXISTS (SELECT 1 FROM idea_executions WHERE id = ? AND lease_token = ? AND status = 'running')`, [
    status, outputSha, input.result === undefined ? null : canonicalJson(input.result),
    input.usage === undefined ? null : canonicalJson(input.usage), input.errorCode ?? null,
    safeError, at, input.executionId, Number(input.attemptNo), input.executionId, input.leaseToken,
  ]);
  const retryable = input.retryable !== false;
  const execution = statement(db, input.succeeded
    ? `UPDATE idea_executions SET status = 'succeeded', output_sha256 = ?, usage_json = ?,
        resulting_artifact_id = ?, completed_at = ?, updated_at = ?, lease_token = NULL,
        lease_expires_at = NULL, heartbeat_at = NULL
      WHERE id = ? AND lease_token = ? AND status = 'running'`
    : `UPDATE idea_executions SET
        status = CASE WHEN ? = 1 AND attempt_count < max_attempts THEN 'queued' ELSE 'failed' END,
        error_code = ?, error_message = ?, completed_at = CASE WHEN ? = 1 AND attempt_count < max_attempts THEN NULL ELSE ? END,
        updated_at = ?, lease_token = NULL, lease_expires_at = NULL, heartbeat_at = NULL
      WHERE id = ? AND lease_token = ? AND status = 'running'`, input.succeeded
      ? [outputSha, input.usage === undefined ? null : canonicalJson(input.usage), input.resultingArtifactId ?? null, at, at, input.executionId, input.leaseToken]
      : [retryable ? 1 : 0, input.errorCode ?? "EXECUTION_FAILED", safeError, retryable ? 1 : 0, at, at, input.executionId, input.leaseToken]);
  const [, executionResult] = await db.batch([attempt, execution]);
  const row = await first(db, "SELECT * FROM idea_executions WHERE id = ?", [input.executionId]);
  return { adopted: changes(executionResult) > 0, execution: parseJsonColumn(row) };
}

export async function heartbeatIdeaExecution(db, { executionId, leaseToken, leaseSeconds = 60, now = new Date() }) {
  await assertIdeaExecutionSchema(db);
  const at = iso(now);
  const expiresAt = iso(new Date(new Date(now).getTime() + Math.max(10, leaseSeconds) * 1000));
  const result = await statement(db, `UPDATE idea_executions SET heartbeat_at = ?, lease_expires_at = ?, updated_at = ?
    WHERE id = ? AND lease_token = ? AND status = 'running' AND cancel_requested_at IS NULL`, [
    at, expiresAt, at, requireText(executionId, "executionId"), requireText(leaseToken, "leaseToken"),
  ]).run();
  return { renewed: changes(result) > 0, lease_expires_at: expiresAt };
}

export async function persistIdeaArtifactExecution(db, input) {
  await assertIdeaExecutionSchema(db);
  const projectId = requireText(input.projectId, "projectId");
  const executionId = requireText(input.executionId, "executionId");
  const leaseToken = requireText(input.leaseToken, "leaseToken");
  const kind = requireText(input.kind, "kind", 50);
  const operation = requireText(input.operation, "operation", 50);
  if (![["design_draft", "design_draft"], ["resolve_findings", "design_draft"]]
    .some(([expectedOperation, expectedKind]) => operation === expectedOperation && kind === expectedKind)) {
    throw new IdeaValidationError("Unsupported durable artifact operation.");
  }
  const content = requireText(input.content, "content", 200000);
  const title = requireText(input.title, "title", 300);
  const outputSha256 = requireSha256(input.outputSha256, "outputSha256");
  const promptVersion = requireText(input.promptVersion, "promptVersion", 100);
  const at = iso(input.now);
  const existing = await first(db, `SELECT a.* FROM idea_executions e JOIN idea_artifacts a ON a.id=e.resulting_artifact_id
    WHERE e.id=? AND e.project_id=? AND e.status='succeeded'`, [executionId, projectId]);
  if (existing) return { adopted: false, artifact: existing, execution: await getIdeaExecution(db, { projectId, executionId }) };
  const versionRow = await first(db, "SELECT MAX(version) AS version FROM idea_artifacts WHERE project_id=? AND kind=?", [projectId, kind]);
  const version = Number(versionRow?.version || 0) + 1;
  const artifactId = input.artifactId || id();
  const usageJson = input.usage === undefined ? null : canonicalJson(input.usage);
  const resultJson = canonicalJson({ artifact_id: artifactId, kind, version });
  const manifest = canonicalJson(Array.isArray(input.sourceManifest) ? input.sourceManifest : []);
  const statements = [
    statement(db, `INSERT INTO idea_artifacts (id,project_id,kind,version,status,title,content,created_at,updated_at,parent_artifact_id,content_sha256,prompt_version,source_manifest_json,row_version)
      SELECT ?,project_id,?,?,'draft',?,?,?,?,?,?,?, ?,0 FROM idea_executions
      WHERE id=? AND project_id=? AND lease_token=? AND status='running' AND operation=?`, [
      artifactId, kind, version, title, content, at, at, input.parentArtifactId ?? null, outputSha256, promptVersion, manifest,
      executionId, projectId, leaseToken, operation,
    ]),
    statement(db, `UPDATE idea_execution_attempts SET status='succeeded',output_sha256=?,result_json=?,usage_json=?,completed_at=?
      WHERE execution_id=? AND attempt_no=? AND status='running'`, [outputSha256, resultJson, usageJson, at, executionId, Number(input.attemptNo)]),
    statement(db, `UPDATE idea_executions SET status='succeeded',output_sha256=?,usage_json=?,resulting_artifact_id=?,completed_at=?,updated_at=?,lease_token=NULL,lease_expires_at=NULL,heartbeat_at=NULL
      WHERE id=? AND project_id=? AND lease_token=? AND status='running'`, [outputSha256, usageJson, artifactId, at, at, executionId, projectId, leaseToken]),
    statement(db, `UPDATE idea_sessions SET workflow_state=?,state_version=state_version+1,updated_at=? WHERE project_id=?`, [operation === "design_draft" ? "draft_ready" : "revision_ready", at, projectId]),
  ];
  for (const findingId of input.resolvedFindingIds || []) statements.push(statement(db, `UPDATE idea_findings SET status='fixed',resolution_note=?,resolved_by=?,resolved_at=?,updated_at=?,row_version=row_version+1
    WHERE id=? AND project_id=? AND status='accepted'`, [input.resolutionNote || "Applied in durable revision.", input.workerId || "system", at, at, findingId, projectId]));
  statements.push(statement(db, `INSERT INTO idea_workflow_events (id,project_id,execution_id,event_type,actor_type,actor_id,to_state,payload_json,idempotency_key,created_at)
    VALUES (?,?,?,?, 'system',?,?,?,?,?) ON CONFLICT(project_id,idempotency_key) DO NOTHING`, [id(), projectId, executionId, `${operation}_persisted`, input.workerId ?? null, operation === "design_draft" ? "draft_ready" : "revision_ready", canonicalJson({artifact_id:artifactId,kind,version,content_sha256:outputSha256}), `${executionId}:${operation}_persisted`, at]));
  const results = await db.batch(statements);
  const finalExecution = await getIdeaExecution(db, { projectId, executionId });
  const artifact = finalExecution?.resulting_artifact_id ? await first(db, "SELECT * FROM idea_artifacts WHERE id=?", [finalExecution.resulting_artifact_id]) : null;
  return { adopted: changes(results[2]) > 0, artifact, execution: finalExecution };
}

export async function persistIdeaReviewStageExecution(db, input) {
  await assertIdeaExecutionSchema(db);
  const stage = requireText(input.stage, "stage");
  const sequence = IDEA_REVIEW_STAGES.indexOf(stage) + 1;
  if (!sequence) throw new IdeaValidationError("Unsupported review stage.");
  const at = iso(input.now);
  const resultSha = requireSha256(input.outputSha256, "outputSha256");
  const resultJson = canonicalJson(input.result ?? {});
  const usageJson = input.usage === undefined ? null : canonicalJson(input.usage);
  const statements = [
    statement(db, `INSERT INTO idea_review_stage_results (id,run_id,execution_id,stage,sequence,status,result_json,result_sha256,created_at,updated_at)
      VALUES (?,?,?,?,?,'succeeded',?,?,?,?) ON CONFLICT(run_id,stage) DO UPDATE SET execution_id=excluded.execution_id,status='succeeded',result_json=excluded.result_json,result_sha256=excluded.result_sha256,updated_at=excluded.updated_at`, [id(), input.runId, input.executionId, stage, sequence, resultJson, resultSha, at, at]),
    statement(db, `UPDATE idea_execution_attempts SET status='succeeded',output_sha256=?,result_json=?,usage_json=?,completed_at=? WHERE execution_id=? AND attempt_no=? AND status='running'`, [resultSha, resultJson, usageJson, at, input.executionId, Number(input.attemptNo)]),
    statement(db, `UPDATE idea_executions SET status='succeeded',output_sha256=?,usage_json=?,completed_at=?,updated_at=?,lease_token=NULL,lease_expires_at=NULL,heartbeat_at=NULL WHERE id=? AND project_id=? AND lease_token=? AND status='running'`, [resultSha, usageJson, at, at, input.executionId, input.projectId, input.leaseToken]),
    statement(db, `UPDATE idea_review_runs SET current_stage=?,updated_at=? WHERE id=? AND project_id=?`, [stage, at, input.runId, input.projectId]),
    statement(db, `INSERT INTO idea_workflow_events (id,project_id,execution_id,event_type,actor_type,actor_id,payload_json,idempotency_key,created_at) VALUES (?,?,?,'review_stage_succeeded','system',?,?,?,?) ON CONFLICT(project_id,idempotency_key) DO NOTHING`, [id(), input.projectId, input.executionId, input.workerId ?? null, canonicalJson({run_id:input.runId,stage,sequence,result_sha256:resultSha}), `${input.executionId}:stage_succeeded`, at]),
  ];
  const results = await db.batch(statements);
  return { adopted: changes(results[2]) > 0, execution: await getIdeaExecution(db,{projectId:input.projectId,executionId:input.executionId}) };
}

export async function persistConceptBriefExecution(db, input) {
  await assertIdeaExecutionSchema(db);
  const projectId = requireText(input.projectId, "projectId");
  const executionId = requireText(input.executionId, "executionId");
  const leaseToken = requireText(input.leaseToken, "leaseToken");
  const content = requireText(input.content, "content", 200000);
  const title = requireText(input.title || "Concept brief", "title", 300);
  const promptVersion = requireText(input.promptVersion, "promptVersion", 100);
  const outputSha256 = requireSha256(input.outputSha256, "outputSha256");
  const at = iso(input.now);
  const existing = await first(db, `SELECT a.* FROM idea_executions e
    JOIN idea_artifacts a ON a.id = e.resulting_artifact_id
    WHERE e.id = ? AND e.project_id = ? AND e.status = 'succeeded'`, [executionId, projectId]);
  if (existing) {
    return { adopted: false, artifact: existing, execution: await getIdeaExecution(db, { projectId, executionId }) };
  }
  const versionRow = await first(db, "SELECT MAX(version) AS version FROM idea_artifacts WHERE project_id = ? AND kind = 'concept_brief'", [projectId]);
  const version = Number(versionRow?.version || 0) + 1;
  const artifactId = input.artifactId || id();
  const sourceManifestJson = canonicalJson(Array.isArray(input.sourceManifest) ? input.sourceManifest : []);
  const usageJson = input.usage === undefined ? null : canonicalJson(input.usage);
  const resultJson = canonicalJson({ artifact_id: artifactId, kind: "concept_brief", version });
  const artifact = statement(db, `INSERT INTO idea_artifacts (
      id, project_id, kind, version, status, title, content, created_at, updated_at,
      parent_artifact_id, content_sha256, prompt_version, source_manifest_json, row_version
    ) SELECT ?, project_id, 'concept_brief', ?, 'draft', ?, ?, ?, ?, NULL, ?, ?, ?, 0
      FROM idea_executions
      WHERE id = ? AND project_id = ? AND lease_token = ? AND status = 'running' AND operation = 'concept_brief'`, [
    artifactId, version, title, content, at, at, outputSha256, promptVersion,
    sourceManifestJson, executionId, projectId, leaseToken,
  ]);
  const attempt = statement(db, `UPDATE idea_execution_attempts SET
      status = 'succeeded', output_sha256 = ?, result_json = ?, usage_json = ?, completed_at = ?
    WHERE execution_id = ? AND attempt_no = ? AND status = 'running'
      AND EXISTS (SELECT 1 FROM idea_executions WHERE id = ? AND project_id = ? AND lease_token = ? AND status = 'running')`, [
    outputSha256, resultJson, usageJson, at, executionId, Number(input.attemptNo), executionId, projectId, leaseToken,
  ]);
  const execution = statement(db, `UPDATE idea_executions SET
      status = 'succeeded', output_sha256 = ?, usage_json = ?, resulting_artifact_id = ?,
      completed_at = ?, updated_at = ?, lease_token = NULL, lease_expires_at = NULL,
      heartbeat_at = NULL, error_code = NULL, error_message = NULL
    WHERE id = ? AND project_id = ? AND lease_token = ? AND status = 'running' AND operation = 'concept_brief'`, [
    outputSha256, usageJson, artifactId, at, at, executionId, projectId, leaseToken,
  ]);
  const session = statement(db, `UPDATE idea_sessions SET
      workflow_state = 'concept_brief_ready', state_version = state_version + 1, updated_at = ?
    WHERE project_id = ? AND EXISTS (
      SELECT 1 FROM idea_executions WHERE id = ? AND project_id = ? AND status = 'succeeded' AND resulting_artifact_id = ?
    )`, [at, projectId, executionId, projectId, artifactId]);
  const event = statement(db, `INSERT INTO idea_workflow_events (
      id, project_id, execution_id, event_type, actor_type, actor_id,
      from_state, to_state, payload_json, idempotency_key, created_at
    ) SELECT ?, project_id, id, 'concept_brief_persisted', 'system', ?,
      NULL, 'concept_brief_ready', ?, ?, ? FROM idea_executions
      WHERE id = ? AND project_id = ? AND status = 'succeeded' AND resulting_artifact_id = ?
    ON CONFLICT(project_id, idempotency_key) DO NOTHING`, [
    id(), input.workerId ?? null,
    canonicalJson({ kind: "concept_brief", artifact_id: artifactId, version, content_sha256: outputSha256 }),
    `${executionId}:concept_brief_persisted`, at, executionId, projectId, artifactId,
  ]);
  const [, , executionResult] = await db.batch([artifact, attempt, execution, session, event]);
  const finalExecution = await getIdeaExecution(db, { projectId, executionId });
  const finalArtifact = finalExecution?.resulting_artifact_id
    ? await first(db, "SELECT * FROM idea_artifacts WHERE id = ? AND project_id = ?", [finalExecution.resulting_artifact_id, projectId])
    : null;
  return { adopted: changes(executionResult) > 0, artifact: finalArtifact, execution: finalExecution };
}
