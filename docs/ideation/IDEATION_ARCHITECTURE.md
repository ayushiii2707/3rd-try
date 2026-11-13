# Proposed Ideation Architecture

## Goals

The architecture must make every stage durable, inspectable, resumable, authorized, and honest about execution. It must preserve existing project creation, GitHub/Bitbucket connectivity, setup, and scan behavior.

The proposal is additive. Existing endpoints and tables remain available while new orchestration records are introduced behind compatible UI actions.

## Workflow state machine

Use explicit states rather than loosely assigned strings:

1. `session_ready`
2. `agent_unconfigured`
3. `agent_verified`
4. `brainstorm_active`
5. `concept_brief_ready`
6. `concept_brief_approved`
7. `draft_active`
8. `draft_ready`
9. `draft_approved_for_review`
10. `review_queued`
11. `review_running`
12. `review_partial`
13. `review_ready_for_resolution`
14. `resolution_active`
15. `revision_ready`
16. `convergence_check`
17. `awaiting_final_approval`
18. `approved`
19. `cancelled`

Every transition must have a server-side precondition, actor, timestamp, idempotency key, and event. Invalid transitions return a stable conflict response without mutating data.

## Service boundaries

### Ideation session service

Creates/resumes one authorized project session, returns a complete workspace snapshot, and controls workflow transitions.

### Elephant execution service

Builds persistent planning context from authorized project data, Elephant messages, structured decisions, and approved artifacts. It records each invocation before dispatch and stores response/provenance atomically.

### Artifact service

Creates immutable versions, validates expected structure, stores content hashes and provenance, supports comparison/export, and marks an approved/current version without overwriting history.

### Reviewer orchestration service

Constructs the ordered EGM review graph, creates isolated reviewer executions, retries a failed reviewer once, and only advances after required stage dependencies complete.

### Context isolation layer

Produces a canonical allowlisted reviewer input bundle and refuses to include Elephant messages or memory. It stores input hashes and provider capability evidence. Independent Review remains disabled if the provider/model has not passed the isolation probe.

### Synthesis and findings service

Normalizes reviewer output, preserves raw output, deduplicates findings without losing provenance, and creates stable finding identifiers.

### Resolution service

Stores human dispositions and notes, sends only accepted decisions and relevant evidence to Elephant, produces a new artifact version, and links each applied change to findings.

### Convergence controller

Determines which stages rerun, evaluates required reviewer completion, distinguishes `not run` from zero findings, checks accepted-change coverage, and creates the final approval checkpoint.

### Agent provider adapter

Defines provider-neutral operations: validate configuration, describe capabilities, execute Elephant, execute isolated reviewer, cancel when supported, normalize usage, and redact errors. The first implementation can use the existing OpenAI-compatible endpoint but must expose verified capability flags rather than assume them.

### Execution/event service

Provides the authoritative audit trail for stage transitions and agent work. This service is the source for the History tab.

## Persistence additions

Add migrations rather than rewriting current tables:

- `idea_workflow_events`: session, event type, from/to states, actor, payload, timestamp, idempotency key.
- `idea_executions`: role, stage, provider, model, status, attempt, prompt/persona version, input hash, output hash, usage, timing, error code, cancellation fields.
- `idea_execution_sources`: execution-to-artifact/source allowlist and content hash.
- `idea_reviewer_capabilities`: provider/model capability result, isolation probe ID, expiry, evidence metadata.
- `idea_resolutions`: finding, disposition, rationale, actor, source artifact version, resulting artifact version.
- `idea_approvals`: artifact/version/hash, approver, decision, timestamp.
- `idea_artifact_sources`: artifact version to messages, artifacts, requirements, or source references.

Extend existing records only where safe:

- Add explicit workflow state/version to `idea_sessions`.
- Add validation/provenance metadata to `idea_artifacts`.
- Add stage/order and completion semantics to review runs/findings.

Use foreign keys, checks, indexes, and unique idempotency constraints in migrations. Remove runtime schema drift by making migrations authoritative; until deployment mechanics are confirmed, runtime bootstrap must remain backward compatible.

## Transaction and concurrency rules

- Create an execution record and transition event in one transaction before dispatch.
- Complete an execution, write its output/artifact, and transition the session in one transaction.
- Use a session revision number for optimistic concurrency.
- Use unique idempotency keys for send, generate, review, resolve, and approve operations.
- Permit one active mutation per session/stage; reject or return the existing execution for duplicates.
- Never delete prior artifact versions, raw reviewer outputs, findings, or approval history during retry.

External model calls cannot be held inside a database transaction. Use a two-step durable execution lifecycle: persist `queued/running`, perform the external call, then finalize transactionally. A recovery pass can mark abandoned leases and allow explicit retry.

## API shape

Recommended additive endpoints:

- `GET /api/projects/:id/idea/workspace`
- `POST /api/projects/:id/idea/sessions`
- `POST /api/projects/:id/idea/agent/verify`
- `POST /api/projects/:id/idea/agent/isolation-probe`
- `POST /api/projects/:id/idea/messages`
- `POST /api/projects/:id/idea/artifacts/concept-brief`
- `POST /api/projects/:id/idea/artifacts/design-draft`
- `POST /api/projects/:id/idea/reviews`
- `POST /api/projects/:id/idea/reviews/:runId/retry`
- `POST /api/projects/:id/idea/findings/:findingId/decision`
- `POST /api/projects/:id/idea/resolutions`
- `POST /api/projects/:id/idea/convergence`
- `POST /api/projects/:id/idea/approvals`
- `POST /api/projects/:id/idea/executions/:executionId/cancel`
- `GET /api/projects/:id/idea/history`
- `GET /api/projects/:id/idea/artifacts/:artifactId/versions/:version`

All endpoints derive user identity server-side, check project/session ownership, validate state, and return sanitized errors. Existing routes can delegate to these services during migration.

## Genuine Elephant and Goldfish execution

### Elephant

Elephant uses the project-scoped persistent context selected by a documented context builder: prior Elephant messages, structured decisions, current approved artifacts, and explicitly relevant project metadata. Every input item is recorded as a source reference.

### Goldfish

Each reviewer execution is created independently. Its input contains only:

- Versioned reviewer persona.
- Exact target artifact version.
- Approved standards.
- Explicitly approved project/source excerpts required by that review stage.
- Stage-specific instructions.

It contains no Elephant conversation, memory table rows, other reviewer output, or implicit prior thread. Separate execution IDs and requests are mandatory. Ordered stages receive only the preceding outputs that the upstream graph explicitly requires.

Before enabling the feature for a provider/model, run an isolation probe with a unique marker held only in Elephant context. A reviewer must return `UNKNOWN` and recorded inputs must not contain the marker. Capability evidence expires when provider, model, prompt runtime, or adapter version changes.

## User interface integration

Reuse the current Ideate design language and workspace rather than creating a parallel product.

- **Stage 0:** open/resume without invoking a model.
- **Connect Agent:** show verified model and isolation capability separately.
- **Elephant tab:** chat, structured decisions, concept/draft generation, revisions.
- **Goldfish tab:** ordered stage progress, individual reviewer status, raw/consolidated findings, retries, and honest isolation evidence.
- **History tab:** chronological events, executions, transitions, artifact versions, decisions, retries, and approvals.
- **Artifacts area:** open, compare, inspect provenance, and export versions.

Every action exposes pending, success, recoverable failure, terminal failure, retry, and cancellation states. Page refresh reads the workspace snapshot and resumes the durable state.

## Security and privacy

- Require real authenticated identity in non-local environments.
- Keep provider credentials in server-side secrets or the existing encrypted credential service.
- Do not return prompts containing sensitive project context unless the user is authorized and the UI explicitly requires them.
- Redact provider errors and never log authorization headers or secrets.
- Add CSP, frame-ancestor protection, referrer policy, HSTS where appropriate, and consistent content-type headers.
- Enforce per-user/project authorization on every artifact, execution, finding, and history query.
- Add configurable retention for raw model inputs/outputs while preserving audit hashes when content is removed.
- Add per-project request, concurrency, token, and cost limits.

## Failure and recovery semantics

- A timed-out reviewer is retried once, then recorded `not_run`.
- Partial review remains visible and resumable; it never becomes a clean round.
- Provider rate limits use bounded backoff and surface retry timing.
- Invalid model output retains raw output securely and marks schema validation failure.
- Lost client connections do not cancel server work implicitly.
- Explicit cancel changes the durable execution state when the provider supports cancellation; otherwise it prevents result adoption.
- Missing encryption/agent configuration fails closed.

## Compatibility strategy

1. Freeze current route-response contracts with tests.
2. Add schema and services without changing repository tables.
3. Adapt existing ideation routes internally.
4. Switch the UI one stage at a time behind a local feature flag.
5. Run GitHub, Bitbucket, project creation, sidebar/routing, persistence, and scan regression suites at every phase.

This avoids a broad rewrite of `worker/index.js` while establishing seams for later modularization.
