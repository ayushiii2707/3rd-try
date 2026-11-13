-- Elephant–Goldfish model workflow: Goldfish brainstorm swarm, section-by-section
-- drafting with approval, five ordered review stages, categorized resolution, and
-- clean-round convergence. Additive only: existing tables and rows are preserved.

-- Private marker placed only in Elephant context; proves it never reaches a Goldfish.
-- Never returned by any API.
ALTER TABLE idea_sessions ADD COLUMN egm_canary TEXT;
-- Number of times the user chose to continue past the five-round cap.
ALTER TABLE idea_sessions ADD COLUMN cap_extensions INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS idea_brainstorm_rounds (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  round INTEGER NOT NULL,
  hypothesis TEXT NOT NULL,
  hypothesis_sha256 TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('complete', 'failed')),
  lens_results_json TEXT NOT NULL DEFAULT '[]',
  objections_json TEXT NOT NULL DEFAULT '[]',
  brief_artifact_id TEXT REFERENCES idea_artifacts(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  UNIQUE (project_id, round)
);

CREATE TABLE IF NOT EXISTS idea_draft_sections (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  section_key TEXT NOT NULL CHECK (section_key IN ('overview', 'technical_plan', 'alternatives', 'implementation')),
  version INTEGER NOT NULL,
  content TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'approved', 'superseded')),
  feedback TEXT NOT NULL DEFAULT '',
  brief_artifact_id TEXT REFERENCES idea_artifacts(id) ON DELETE SET NULL,
  execution_id TEXT REFERENCES idea_executions(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  approved_at TEXT,
  UNIQUE (project_id, section_key, version)
);

CREATE INDEX IF NOT EXISTS idx_idea_draft_sections_project
  ON idea_draft_sections(project_id, section_key, version DESC);

ALTER TABLE idea_review_runs ADD COLUMN clean INTEGER NOT NULL DEFAULT 0;
ALTER TABLE idea_review_runs ADD COLUMN reviewer_status_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE idea_review_runs ADD COLUMN report_markdown TEXT NOT NULL DEFAULT '';
ALTER TABLE idea_review_runs ADD COLUMN churn INTEGER NOT NULL DEFAULT 0;

ALTER TABLE idea_findings ADD COLUMN finding_key TEXT;
ALTER TABLE idea_findings ADD COLUMN affected_scope TEXT NOT NULL DEFAULT '';
ALTER TABLE idea_findings ADD COLUMN reviewers_json TEXT NOT NULL DEFAULT '[]';
-- Elephant's proposal: propose_fix | contest | escalate | decline.
ALTER TABLE idea_findings ADD COLUMN category TEXT;
ALTER TABLE idea_findings ADD COLUMN elephant_justification TEXT NOT NULL DEFAULT '';
ALTER TABLE idea_findings ADD COLUMN proposed_edit TEXT NOT NULL DEFAULT '';
-- Settled findings (contested, declined, or confirmed risks) are not reopened when re-raised.
ALTER TABLE idea_findings ADD COLUMN settled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE idea_findings ADD COLUMN carried_from TEXT;
