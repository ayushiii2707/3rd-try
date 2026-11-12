CREATE TABLE IF NOT EXISTS project_onboarding (
  project_id TEXT PRIMARY KEY,
  stage TEXT NOT NULL DEFAULT 'choice',
  updated_at TEXT NOT NULL,
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
);
