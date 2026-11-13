# Phase 3A — Schema Impact Report

## Scope and conclusion

This report is a design review only. It does not add or alter a table, run a migration, change runtime behavior, deploy, or invoke an AI model.

The Elephant–Goldfish pipeline should continue to use the existing Cloudflare D1 database and the existing project identity. The current twelve tables remain the system of record. Five small, D1-native tables and targeted additive columns are recommended to represent durable execution, ordered review stages, approvals, and workflow history without creating a second project/session hierarchy.

The most important prerequisite is resolving schema authority. Migrations `0001`–`0006` declare foreign keys, checks, uniqueness, and indexes, but `worker/index.js` also runs `CREATE TABLE IF NOT EXISTS` on every API request and its table definitions omit the foreign keys, checks, and indexes. If runtime bootstrap creates a table first, a later historical migration does not retrofit those omitted constraints. Historical migrations must not be edited; a forward-only inventory and hardening strategy is required.

## 1. Existing tables and relationships

| Table | Identity and ownership | Existing relationships | Current use |
|---|---|---|---|
| `projects` | `id` primary key; owned by `user_id`; unique `(user_id, code)` | Root of all project data | Project metadata and authorization boundary |
| `repository_connections` | `id` primary key; `project_id` required | Migration FK to `projects(id)` with cascade; unique `(project_id, provider, repository_id)` | Encrypted GitHub/Bitbucket credentials and repository metadata |
| `repository_discovery` | `connection_id` primary key | Migration FK to `repository_connections(id)` with cascade | Cached branches and folders |
| `project_setup` | `project_id` primary key | Migration FKs to project (cascade) and connection (set null) | Branch, product, environment, tracker, and setup choices |
| `project_onboarding` | `project_id` primary key | Migration FK to project with cascade | Main onboarding UI stage |
| `idea_sessions` | One row per `project_id` | Migration FK to project with cascade | Ideation title and current UI stage |
| `idea_messages` | `id` primary key; scoped by `project_id` | Migration FK to project with cascade | Persistent Elephant conversation |
| `idea_artifacts` | `id` primary key; version unique within project/kind | Migration FK to project with cascade | Versioned concept briefs and `plan.md` drafts |
| `idea_review_runs` | `id` primary key; project and artifact scoped | Migration FKs to project and artifact with cascade | One Goldfish review round |
| `idea_findings` | `id` primary key; run and project scoped | Migration FKs to review run and project with cascade | Findings and user dispositions |
| `idea_agent_connections` | One row per `project_id` | Migration FK to project with cascade | Provider/model connectivity state; no secret is stored here |
| `idea_memory` | One row per `project_id` | Migration FK to project with cascade | Structured Elephant memory |

The existing identity chain is sufficient: `projects.id` is the root, `idea_sessions.project_id` is the ideation session identity, artifacts and messages belong to that project/session, and review runs/findings belong to the same project. No second EGM project or session model is needed.

## 2. Tables reused unchanged

These tables should be reused without schema changes:

- `projects`
- `repository_connections`
- `repository_discovery`
- `project_setup`
- `project_onboarding`
- `idea_messages`
- `idea_agent_connections`

Their existing API behavior can remain unchanged. Repository credentials continue to use the existing encrypted fields; execution records must never contain tokens, raw authorization headers, or encryption keys.

## 3. Tables requiring additive extensions

The following columns are proposed. They are additive and nullable or have safe defaults so existing rows remain readable by the current Worker.

### `idea_sessions`

| Column | D1 type and constraint | Why it is needed |
|---|---|---|
| `workflow_state` | `TEXT NOT NULL DEFAULT 'session_ready'` | Separates internal orchestration state from the existing `stage`, which is a UI/navigation value. Application validation should initially enforce the allowed state set. |
| `state_version` | `INTEGER NOT NULL DEFAULT 0` | Optimistic concurrency token for competing tabs/requests. |
| `completed_at` | `TEXT NULL` | Records final approval/completion without overloading `updated_at`. |

Allowed `workflow_state` values should be: `session_ready`, `agent_verified`, `brainstorm_active`, `concept_brief_ready`, `draft_ready`, `review_queued`, `review_running`, `review_ready_for_resolution`, `resolution_active`, `revision_ready`, `convergence_check`, `awaiting_final_approval`, `approved`, and `cancelled`. Because SQLite cannot add a table-level check to an existing table with a simple `ALTER TABLE`, Phase 3B should validate this allowlist in code; a later reviewed rebuild may add the database check.

### `idea_artifacts`

| Column | D1 type and constraint | Why it is needed |
|---|---|---|
| `parent_artifact_id` | `TEXT NULL REFERENCES idea_artifacts(id) ON DELETE SET NULL` | Preserves revision lineage from a reviewed plan to its resolved successor. |
| `content_sha256` | `TEXT NULL` | Binds reviews and approvals to exact content, rather than only a mutable-looking artifact identifier. Existing rows are backfilled before new code treats this as required. |
| `prompt_version` | `TEXT NULL` | Identifies the prompt/template that produced an artifact. |
| `source_manifest_json` | `TEXT NOT NULL DEFAULT '[]'` | Records allowlisted source IDs, kinds, versions, and hashes used to create the artifact without duplicating source content. |
| `row_version` | `INTEGER NOT NULL DEFAULT 0` | Supports compare-and-swap updates. |

### `idea_review_runs`

| Column | D1 type and constraint | Why it is needed |
|---|---|---|
| `workflow_version` | `INTEGER NOT NULL DEFAULT 1` | Distinguishes legacy five-lens reviews from the ordered EGM-compatible graph. |
| `input_artifact_sha256` | `TEXT NULL` | Proves which exact plan content the run reviewed. |
| `current_stage` | `TEXT NULL` | Resumable orchestration cursor. |
| `updated_at` | `TEXT NULL` | Detects stale/incomplete runs. Existing rows can use `completed_at` or `created_at` during backfill. |
| `cancel_requested_at` | `TEXT NULL` | Durable cooperative cancellation request. |

Add a unique index on `(project_id, round)` only after a preflight proves no duplicates. Add an operational index on `(status, updated_at)` for stale-run recovery.

### `idea_findings`

| Column | D1 type and constraint | Why it is needed |
|---|---|---|
| `artifact_id` | `TEXT NULL REFERENCES idea_artifacts(id) ON DELETE CASCADE` | Directly binds each finding to the reviewed artifact, avoiding an extra join when validating resolution input. |
| `source_execution_id` | `TEXT NULL REFERENCES idea_executions(id) ON DELETE SET NULL` | Links evidence to the exact independent reviewer execution. |
| `review_stage` | `TEXT NULL` | Replaces ambiguous use of `lens` for the ordered methodology while preserving legacy `lens`. |
| `evidence_json` | `TEXT NOT NULL DEFAULT '[]'` | Stores structured citations to plan sections/requirements. |
| `resolution_note` | `TEXT NOT NULL DEFAULT ''` | Preserves the user's decision rationale. |
| `resolved_by` | `TEXT NULL` | Records the actor that accepted, declined, or fixed the finding. |
| `updated_at` | `TEXT NULL` | Audit timestamp for disposition changes. |
| `row_version` | `INTEGER NOT NULL DEFAULT 0` | Prevents lost updates from concurrent resolution screens. |

Legacy `lens` remains intact so existing response shapes and history continue to work. New code writes both a readable `lens` label and canonical `review_stage`.

### `idea_memory`

| Column | D1 type and constraint | Why it is needed |
|---|---|---|
| `version` | `INTEGER NOT NULL DEFAULT 0` | Enables safe compare-and-swap memory updates. |
| `memory_sha256` | `TEXT NULL` | Detects accidental overwrite and ties generated artifacts to a known memory snapshot. |

## 4. Necessary new tables

### `idea_executions`

This is the authoritative unit of durable model work. `idea_review_runs` describes a review round, but it cannot represent idempotency, leases, retries, prompt/persona versions, provider metadata, per-stage status, or cancellation.

```sql
CREATE TABLE idea_executions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  review_run_id TEXT,
  artifact_id TEXT,
  parent_execution_id TEXT,
  idempotency_key TEXT NOT NULL,
  agent_role TEXT NOT NULL CHECK(agent_role IN ('elephant','goldfish','system')),
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
  status TEXT NOT NULL CHECK(status IN (
    'queued','running','succeeded','failed','cancel_requested','cancelled'
  )),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 2 CHECK(max_attempts >= 1),
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
  resulting_artifact_id TEXT,
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY(review_run_id) REFERENCES idea_review_runs(id) ON DELETE CASCADE,
  FOREIGN KEY(artifact_id) REFERENCES idea_artifacts(id) ON DELETE SET NULL,
  FOREIGN KEY(parent_execution_id) REFERENCES idea_executions(id) ON DELETE SET NULL,
  FOREIGN KEY(resulting_artifact_id) REFERENCES idea_artifacts(id) ON DELETE SET NULL,
  UNIQUE(project_id, idempotency_key)
);

CREATE INDEX idx_idea_executions_project_status
  ON idea_executions(project_id, status, updated_at DESC);
CREATE INDEX idx_idea_executions_run_stage
  ON idea_executions(review_run_id, review_stage);
CREATE INDEX idx_idea_executions_lease
  ON idea_executions(status, lease_expires_at);
```

`input_manifest_json` stores only allowlisted source references and hashes. `error_message` must be redacted. No credential or complete authorization material belongs in this table.

### `idea_execution_attempts`

One execution may be retried. This table preserves the attempt-level provider request, timing, validation, and error trail without overwriting the parent execution.

```sql
CREATE TABLE idea_execution_attempts (
  id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL,
  attempt_no INTEGER NOT NULL CHECK(attempt_no >= 1),
  provider_request_id TEXT,
  status TEXT NOT NULL CHECK(status IN ('running','succeeded','failed','cancelled')),
  input_sha256 TEXT NOT NULL,
  output_sha256 TEXT,
  result_json TEXT,
  usage_json TEXT,
  error_code TEXT,
  error_message TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  FOREIGN KEY(execution_id) REFERENCES idea_executions(id) ON DELETE CASCADE,
  UNIQUE(execution_id, attempt_no)
);

CREATE INDEX idx_idea_execution_attempts_execution
  ON idea_execution_attempts(execution_id, attempt_no);
```

`result_json` is optional and must contain sanitized structured output or schema-validation diagnostics only. Retention should be bounded; secrets and request headers are prohibited.

### `idea_review_stage_results`

The existing run row cannot represent ordered, individually recoverable stages. This table records the upstream-inspired sequence and normalized result for each stage.

```sql
CREATE TABLE idea_review_stage_results (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  execution_id TEXT,
  stage TEXT NOT NULL CHECK(stage IN (
    'zoom_out','comprehension','critic','intermediate_zoom_out',
    'implementation_readiness','synthesis'
  )),
  sequence INTEGER NOT NULL CHECK(sequence BETWEEN 1 AND 6),
  status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','failed','not_run')),
  result_json TEXT NOT NULL DEFAULT '{}',
  result_sha256 TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(run_id) REFERENCES idea_review_runs(id) ON DELETE CASCADE,
  FOREIGN KEY(execution_id) REFERENCES idea_executions(id) ON DELETE SET NULL,
  UNIQUE(run_id, stage),
  UNIQUE(run_id, sequence)
);

CREATE INDEX idx_idea_review_stage_results_run
  ON idea_review_stage_results(run_id, sequence, status);
```

### `idea_artifact_approvals`

Artifact `status` is not enough to prove who approved which immutable content or to retain revocation/rejection history.

```sql
CREATE TABLE idea_artifact_approvals (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  artifact_sha256 TEXT NOT NULL,
  decision TEXT NOT NULL CHECK(decision IN ('approved','rejected','revoked')),
  decided_by TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  idempotency_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY(artifact_id) REFERENCES idea_artifacts(id) ON DELETE CASCADE,
  UNIQUE(project_id, idempotency_key)
);

CREATE INDEX idx_idea_artifact_approvals_artifact
  ON idea_artifact_approvals(artifact_id, created_at DESC);
```

### `idea_workflow_events`

Current mutable rows show the latest state but not why or how it changed. An append-only event trail is needed for recovery, audit, and UI history; it is not a second workflow state store.

```sql
CREATE TABLE idea_workflow_events (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  execution_id TEXT,
  event_type TEXT NOT NULL,
  from_state TEXT,
  to_state TEXT,
  actor_type TEXT NOT NULL CHECK(actor_type IN ('user','system')),
  actor_id TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  idempotency_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY(execution_id) REFERENCES idea_executions(id) ON DELETE SET NULL,
  UNIQUE(project_id, idempotency_key)
);

CREATE INDEX idx_idea_workflow_events_project_created
  ON idea_workflow_events(project_id, created_at DESC);
```

## 5. Existing-to-new relationship mapping

```text
projects (existing)
├── idea_sessions (existing, extended internal state)
├── idea_messages (existing Elephant conversation)
├── idea_memory (existing, versioned)
├── idea_artifacts (existing, revision lineage + hash)
│   └── idea_artifact_approvals (new)
├── idea_review_runs (existing, ordered-run cursor)
│   ├── idea_review_stage_results (new)
│   └── idea_findings (existing, evidence + execution link)
├── idea_executions (new)
│   └── idea_execution_attempts (new)
└── idea_workflow_events (new append-only history)
```

All new rows are rooted in the existing `projects.id`. There is no new project/session identity. Existing endpoints may continue returning messages, artifacts, runs, findings, agent, and memory; Phase 3B can add optional provenance fields or separate execution endpoints without removing current fields.

## 6. Compatibility with migrations `0001`–`0006`

- Do not modify historical migrations.
- A new migration `0007` should be additive: new tables, safe columns, and non-conflicting indexes.
- Columns with defaults preserve reads/writes by the existing Worker. Nullable hashes and references allow an explicit backfill before enforcement.
- Existing `idea_artifacts.kind`, message roles, connection providers/statuses, and current API response fields remain valid.
- Legacy review runs remain `workflow_version = 1`; new ordered runs use a later workflow version. They are not falsely relabeled as EGM runs.
- New foreign keys must use the existing project/artifact/run keys. D1 enforces foreign keys by default; schema-altering rebuilds may require `PRAGMA defer_foreign_keys = true`, per Cloudflare's [D1 foreign-key guidance](https://developers.cloudflare.com/d1/sql-api/foreign-keys/).
- A separate, explicitly approved hardening migration should rebuild only legacy tables that are proven unconstrained in a target database. It must not be bundled invisibly into feature migration `0007`.

## 7. Runtime schema drift findings

Source inspection found these exact differences:

1. `worker/index.js` runs every statement in `DDL` from `database(env)` on every API request.
2. Runtime table definitions omit every foreign key declared in migrations `0001`–`0006`.
3. Runtime definitions omit provider/status/role/kind checks declared by migrations.
4. Runtime bootstrap does not create the migration indexes.
5. `README.md` describes migrations as authoritative, but runtime creation can win the race on an empty database.
6. `CREATE TABLE IF NOT EXISTS` does not reconcile an already-created table. Therefore applying historical migrations after runtime bootstrap does not add missing table constraints.
7. No local D1 database file was found in the workspace, only Wrangler cache metadata. No Wrangler D1 binding/configuration or authenticated production inventory was available, so the actual deployed schema cannot be truthfully asserted from this checkout.

The consequences are concrete: orphan rows may be possible, invalid enumerated values may exist, and cascade behavior may differ by environment. Indexes may still exist if migrations were applied later because `CREATE INDEX IF NOT EXISTS` is independent, but that must be inventoried rather than assumed.

## 8. Migration strategy

Cloudflare D1 supports ordered migration files tracked as applied; existing applied files are not retroactive. Use Wrangler's migration list/apply workflow described in the official [D1 migrations documentation](https://developers.cloudflare.com/d1/reference/migrations/).

### Gate 0 — inventory, no mutation

For each local, preview, staging, and production binding:

- Record `sqlite_master` table/index SQL.
- Record `PRAGMA table_info`, `foreign_key_list`, `index_list`, and `index_info` for all twelve tables.
- Run `PRAGMA foreign_key_check` and `PRAGMA integrity_check`.
- Run the data-quality queries described below.
- Record applied migration history and the target database identifier.

### Migration `0007` — additive feature foundation

- Add the proposed columns with safe defaults/nullability.
- Create the five new tables and indexes.
- Do not rebuild or drop a legacy table.
- Backfill hashes, `updated_at`, and manifests in bounded batches or a controlled maintenance script after the columns exist.
- Enable Phase 3B code only after schema-version verification succeeds.

### Migration `0008` — separately approved legacy hardening

Only for databases whose inventory proves drift:

- Preflight and cleanse invalid rows; never silently delete them.
- Create constrained replacement tables, copy rows explicitly, validate counts and foreign keys, then swap names.
- Defer foreign-key checks during the schema alteration only as D1 requires, then run `foreign_key_check` immediately.
- Add missing indexes and uniqueness only after duplicate audits pass.
- Preserve IDs and timestamps exactly.

### Runtime authority transition

After every active database has applied the required migration:

- Stop creating full schema on each request.
- Replace bootstrap with a cheap schema-version/required-table check that fails safely and identifies an operator action.
- Do not remove runtime bootstrap before all existing deployments are inventoried and migrated.
- Never allow the application to auto-create a less constrained production schema.

## 9. Data-preservation verification plan

Before applying any migration, capture:

- Row counts for every existing table.
- Counts grouped by project, artifact kind/version, run status, finding status, and provider.
- Deterministic content hashes outside the database for exported rows, ordered by primary key.
- Maximum artifact version and review round per project.
- All orphan checks for every declared relationship.
- Duplicate candidates for `(user_id, code)`, repository identity, artifact version, and `(project_id, round)`.
- Invalid enum values and `json_valid(...)` failures for JSON columns.
- Credential safety checks that verify encrypted fields are populated without printing their values.

Apply first to a cloned/staging database. After migration, compare counts and hashes, run `integrity_check` and `foreign_key_check`, then exercise read-only route smoke tests and local mocked failure tests. No paid model call is required to validate schema compatibility.

For production, capture a D1 restore point/bookmark and an export before mutation. D1 Time Travel is continuously available for supported production databases and supports point-in-time restoration; retention and database generation must be checked first using the official [D1 Time Travel documentation](https://developers.cloudflare.com/d1/reference/time-travel/).

## 10. Recovery strategy

- Treat migrations as forward-only; do not ship a destructive down migration.
- Stop before mutation if inventory, duplicate, orphan, JSON, or enum preflight fails.
- If additive `0007` fails, leave old columns/tables untouched and keep the feature flag off; repair with a new forward migration.
- If a later table rebuild fails or post-validation differs, stop traffic to the affected feature and restore to the captured Time Travel bookmark where supported.
- If Time Travel is unavailable for that database generation, restore the pre-migration export into a fresh D1 database, validate it, and explicitly rebind after operator approval.
- Do not claim arbitrary DDL rollback. Recovery is restore-based and must be rehearsed against staging.

## 11. Risks and alternatives

| Risk | Impact | Mitigation / alternative |
|---|---|---|
| Unknown deployed schema | A migration that is safe locally may fail or preserve bad rows remotely | Mandatory per-binding inventory before writing `0007` |
| Runtime bootstrap wins on new databases | New installs remain unconstrained | Make migrations authoritative after coordinated rollout; fail closed on schema mismatch |
| Artifact version race (`MAX(version)+1`) | Concurrent generations can collide | Allocate under idempotency + retry unique conflict; later use a project/session revision counter |
| Review round race | Duplicate round numbers | Preflight, unique index, conditional state transition, retry |
| External call between separate writes | `running` rows can become stale | Durable execution leases and recovery, described in the execution report |
| Large JSON growth | D1 rows and read responses become expensive | Store normalized outputs, hashes/manifests, bounded diagnostics; avoid duplicating full prompts |
| Too many new concepts | Operational complexity | The five proposed tables are the minimum that separates execution, attempts, stage results, approvals, and history cleanly; combining them would lose integrity or auditability |
| Rebuilding legacy tables | Highest migration risk | Keep it separate from feature work and perform only where inventory proves missing constraints |

## Phase 3B schema recommendation

Approve `0007` only after target-database inventory is available. `0007` should be additive and introduce execution/provenance support while preserving all existing API fields. Defer any legacy-table rebuild to a separately reviewed `0008`. The first Phase 3B implementation should use the new records for one bounded stage at a time and must not switch schema authority until all deployments are known to be migrated.
