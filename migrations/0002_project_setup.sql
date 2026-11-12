CREATE TABLE IF NOT EXISTS repository_discovery (
  connection_id TEXT PRIMARY KEY,
  branches_json TEXT NOT NULL,
  folders_json TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  FOREIGN KEY(connection_id) REFERENCES repository_connections(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS project_setup (
  project_id TEXT PRIMARY KEY,
  connection_id TEXT,
  selected_branch TEXT,
  product_mode TEXT,
  product_name TEXT,
  service_type TEXT,
  environments_json TEXT NOT NULL DEFAULT '[]',
  work_tracking TEXT NOT NULL DEFAULT 'none',
  import_issues INTEGER NOT NULL DEFAULT 0,
  label_mapping_json TEXT NOT NULL DEFAULT '{}',
  setup_completed_at TEXT,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY(connection_id) REFERENCES repository_connections(id) ON DELETE SET NULL
);
