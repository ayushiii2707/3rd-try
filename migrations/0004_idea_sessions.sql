CREATE TABLE IF NOT EXISTS idea_sessions (
  project_id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  stage TEXT NOT NULL DEFAULT 'choice',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
);
