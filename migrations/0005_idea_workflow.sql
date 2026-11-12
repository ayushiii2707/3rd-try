CREATE TABLE IF NOT EXISTS idea_messages (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('user','assistant')),
  content TEXT NOT NULL,
  hypothesis TEXT NOT NULL DEFAULT '',
  ready INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_idea_messages_project_created
  ON idea_messages(project_id, created_at);

CREATE TABLE IF NOT EXISTS idea_artifacts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('concept_brief','design_draft')),
  version INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, kind, version),
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_idea_artifacts_project_version
  ON idea_artifacts(project_id, kind, version DESC);

CREATE TABLE IF NOT EXISTS idea_review_runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  round INTEGER NOT NULL,
  status TEXT NOT NULL,
  clean_rounds INTEGER NOT NULL DEFAULT 0,
  summary TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  completed_at TEXT,
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY(artifact_id) REFERENCES idea_artifacts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_idea_reviews_project_created
  ON idea_review_runs(project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS idea_findings (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  lens TEXT NOT NULL,
  severity TEXT NOT NULL,
  title TEXT NOT NULL,
  detail TEXT NOT NULL,
  recommendation TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  FOREIGN KEY(run_id) REFERENCES idea_review_runs(id) ON DELETE CASCADE,
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_idea_findings_run
  ON idea_findings(run_id, severity, created_at);
