CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  code TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(user_id, code)
);

CREATE TABLE IF NOT EXISTS repository_connections (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK(provider = 'github'),
  owner TEXT NOT NULL,
  repository TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  repository_url TEXT NOT NULL,
  default_branch TEXT,
  is_private INTEGER NOT NULL DEFAULT 0,
  permissions_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('connected', 'invalid')),
  encrypted_pat TEXT NOT NULL,
  credential_iv TEXT NOT NULL,
  credential_version INTEGER NOT NULL DEFAULT 1,
  connected_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
  UNIQUE(project_id, provider, repository_id)
);
