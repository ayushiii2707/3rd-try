-- Additive Elephant–Goldfish execution foundation.
-- This migration intentionally leaves all existing tables, rows, and routes intact.

ALTER TABLE idea_sessions ADD COLUMN workflow_state TEXT NOT NULL DEFAULT 'session_ready';
ALTER TABLE idea_sessions ADD COLUMN state_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE idea_sessions ADD COLUMN completed_at TEXT;

ALTER TABLE idea_artifacts ADD COLUMN parent_artifact_id TEXT REFERENCES idea_artifacts(id) ON DELETE SET NULL;
ALTER TABLE idea_artifacts ADD COLUMN content_sha256 TEXT;
ALTER TABLE idea_artifacts ADD COLUMN prompt_version TEXT;
ALTER TABLE idea_artifacts ADD COLUMN source_manifest_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE idea_artifacts ADD COLUMN row_version INTEGER NOT NULL DEFAULT 0;

ALTER TABLE idea_review_runs ADD COLUMN workflow_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE idea_review_runs ADD COLUMN input_artifact_sha256 TEXT;
ALTER TABLE idea_review_runs ADD COLUMN current_stage TEXT;
ALTER TABLE idea_review_runs ADD COLUMN updated_at TEXT;
ALTER TABLE idea_review_runs ADD COLUMN cancel_requested_at TEXT;

ALTER TABLE idea_findings ADD COLUMN artifact_id TEXT REFERENCES idea_artifacts(id) ON DELETE SET NULL;
ALTER TABLE idea_findings ADD COLUMN source_execution_id TEXT;
ALTER TABLE idea_findings ADD COLUMN review_stage TEXT;
ALTER TABLE idea_findings ADD COLUMN evidence_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE idea_findings ADD COLUMN resolution_note TEXT NOT NULL DEFAULT '';
ALTER TABLE idea_findings ADD COLUMN resolved_by TEXT;
ALTER TABLE idea_findings ADD COLUMN updated_at TEXT;
ALTER TABLE idea_findings ADD COLUMN row_version INTEGER NOT NULL DEFAULT 0;

ALTER TABLE idea_memory ADD COLUMN version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE idea_memory ADD COLUMN memory_sha256 TEXT;

CREATE TABLE IF NOT EXISTS idea_executions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  review_run_id TEXT REFERENCES idea_review_runs(id) ON DELETE CASCADE,
  artifact_id TEXT REFERENCES idea_artifacts(id) ON DELETE SET NULL,
  parent_execution_id TEXT REFERENCES idea_executions(id) ON DELETE SET NULL,
  idempotency_key TEXT NOT NULL,
  agent_role TEXT NOT NULL CHECK (agent_role IN ('elephant', 'goldfish', 'system')),
  operation TEXT NOT NULL,
  review_stage TEXT,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  adapter_version TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  persona_version TEXT NOT NULL,
  input_manifest_json TEXT NOT NULL DEFAULT '[]',
  input_sha256 TEXT NOT NULL,
  output_sha256 TEXT,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancel_requested', 'cancelled')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 2 CHECK (max_attempts >= 1),
  lease_token TEXT,
  lease_expires_at TEXT,
  heartbeat_at TEXT,
  error_code TEXT,
  error_message TEXT,
  usage_json TEXT,
  queued_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  cancel_requested_at TEXT,
  cancelled_at TEXT,
  updated_at TEXT NOT NULL,
  resulting_artifact_id TEXT REFERENCES idea_artifacts(id) ON DELETE SET NULL,
  UNIQUE (project_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_idea_executions_project_status_updated
  ON idea_executions(project_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_idea_executions_run_stage
  ON idea_executions(review_run_id, review_stage);
CREATE INDEX IF NOT EXISTS idx_idea_executions_status_lease
  ON idea_executions(status, lease_expires_at);

CREATE TABLE IF NOT EXISTS idea_execution_attempts (
  id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL REFERENCES idea_executions(id) ON DELETE CASCADE,
  attempt_no INTEGER NOT NULL CHECK (attempt_no >= 1),
  provider_request_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'cancelled')),
  input_sha256 TEXT NOT NULL,
  output_sha256 TEXT,
  result_json TEXT,
  usage_json TEXT,
  error_code TEXT,
  error_message TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE (execution_id, attempt_no)
);

CREATE INDEX IF NOT EXISTS idx_idea_execution_attempts_execution
  ON idea_execution_attempts(execution_id, attempt_no);

CREATE TABLE IF NOT EXISTS idea_review_stage_results (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES idea_review_runs(id) ON DELETE CASCADE,
  execution_id TEXT REFERENCES idea_executions(id) ON DELETE SET NULL,
  stage TEXT NOT NULL CHECK (stage IN ('zoom_out', 'comprehension', 'critic', 'intermediate_zoom_out', 'implementation_readiness', 'synthesis')),
  sequence INTEGER NOT NULL CHECK (sequence BETWEEN 1 AND 6),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'not_run')),
  result_json TEXT NOT NULL DEFAULT '{}',
  result_sha256 TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (run_id, stage),
  UNIQUE (run_id, sequence)
);

CREATE INDEX IF NOT EXISTS idx_idea_review_stage_results_run
  ON idea_review_stage_results(run_id, sequence, status);

CREATE TABLE IF NOT EXISTS idea_artifact_approvals (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  artifact_id TEXT NOT NULL REFERENCES idea_artifacts(id) ON DELETE CASCADE,
  artifact_sha256 TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('approved', 'rejected', 'revoked')),
  decided_by TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  idempotency_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (project_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_idea_artifact_approvals_artifact
  ON idea_artifact_approvals(artifact_id, created_at DESC);

CREATE TABLE IF NOT EXISTS idea_workflow_events (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  execution_id TEXT REFERENCES idea_executions(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  from_state TEXT,
  to_state TEXT,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'system')),
  actor_id TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  idempotency_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (project_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_idea_workflow_events_project
  ON idea_workflow_events(project_id, created_at DESC);
