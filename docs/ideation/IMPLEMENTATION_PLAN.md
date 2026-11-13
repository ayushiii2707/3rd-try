# Controlled Implementation Plan

## Operating rules

- Do not deploy or push during this work unless separately requested.
- Do not run paid/external model executions without explicit approval.
- Preserve existing uncommitted work.
- Stop for review before migrations/architecture changes and again before live agent testing.
- Do not label a review independent unless isolation evidence passes.
- Do not hardcode agent messages, artifacts, or findings.

## Phase 0 — Baseline audit (complete)

1. Inventory routes, UI states, schemas, provider integrations, secrets, and scripts.
2. Run local build, validation, and audit.
3. Record functional behavior versus unproven behavior.
4. Identify schema drift, authentication fallback, monolith, and test gaps.

Deliverable: `EXISTING_SYSTEM_BASELINE.md`.

## Phase 1 — EGM reference analysis (complete)

1. Pin the upstream commit.
2. Inspect README, architecture, brainstorm/draft/review/resolve/review-loop skills, personas, Codex guidance, tests, and license.
3. Document Elephant/Goldfish roles, ordered stages, isolation standard, human gates, artifacts, and failure semantics.
4. Separate reusable mechanisms from web-application capabilities that must be built locally.

Deliverable: `EGM_REFERENCE_ANALYSIS.md`.

## Phase 2 — Architecture and approval gate (current stop)

1. Review the proposed state machine, tables, services, APIs, security, and compatibility plan.
2. Resolve open choices:
   - Whether agent credentials remain environment-wide or support encrypted per-user/provider records.
   - Which OpenAI-compatible provider/model is approved for the first real path.
   - Whether raw prompt/output retention is acceptable and for how long.
   - Token/cost limits for live verification.
   - Whether the production identity header is guaranteed by the hosting platform.
3. Obtain approval before database migrations or orchestration changes.

Deliverable: `IDEATION_ARCHITECTURE.md` and this plan.

## Phase 3 — Backend foundation

1. Add forward-only migrations for workflow events, executions, execution sources, reviewer capabilities, resolutions, approvals, and artifact provenance.
2. Add a schema/version compatibility check and eliminate migration/runtime-DDL contradictions without dropping data.
3. Introduce small service seams for authorization, sessions, transitions, executions, and artifacts.
4. Add idempotency and optimistic concurrency.
5. Add sanitized error codes and consistent no-store responses.
6. Keep old API shapes operational through adapters.

Proof required:

- Migration tests from a representative existing database.
- Roll-forward/restart persistence tests.
- Invalid transition and duplicate request tests.
- Cross-project/cross-user denial tests.
- Existing project/repository regression tests.

## Phase 4 — Provider verification and Elephant

1. Normalize the current OpenAI-compatible adapter and correct model metadata inconsistency.
2. Add durable execution records, timeouts, bounded retry, cancellation semantics, schema validation, and usage capture.
3. Implement a capability check distinct from model reachability.
4. Implement the isolation canary probe; keep Independent Review disabled until it passes.
5. Implement the Elephant context builder with explicit source references.
6. Make message send atomic from the user's perspective through a durable pending/failed/completed execution.
7. Add structured decision/memory extraction with provenance.

Proof required:

- Adapter unit tests with mocked success, invalid JSON, timeout, 401, 429, and 5xx responses.
- Secret-redaction tests.
- Context-builder allow/deny tests.
- Resume-after-failure tests.
- No paid live call until separately approved.

## Phase 5 — Brainstorm and concept brief

1. Wire Start/Resume and Connect Agent to verified backend state.
2. Complete the Elephant tab conversation states: loading, retry, cancel, failure, and refresh resume.
3. Validate sufficient context before generation.
4. Generate `concepts_brief.md` from real execution.
5. Validate and persist an immutable version with inputs, model/prompt version, hashes, and source references.
6. Add artifact open/revise/compare behavior and approval gate.

Proof required:

- Conversation persistence and ordering tests.
- Insufficient-context behavior.
- Artifact validation/version/provenance tests.
- Refresh/restart resume test.

## Phase 6 — Draft

1. Load the approved/current concept brief and approved constraints.
2. Generate an adaptive design outline.
3. Support section feedback and durable revisions.
4. Produce and validate `design_draft.md`.
5. Require explicit submission for independent review.

Proof required:

- Draft input allowlist tests.
- Version conflict tests.
- Section revision and artifact comparison tests.
- No irrelevant hardcoded sections test.

## Phase 7 — Genuine Goldfish review

1. Version the adapted upstream personas and stage graph with Apache-2.0 provenance.
2. Implement ordered stages: Zoom Out, Comprehension, Critic, Intermediate Zoom Out, Implementation Readiness.
3. Create distinct execution records and allowlisted inputs for every reviewer.
4. Run reviewers independently; retry a failed reviewer once.
5. Preserve raw output and synthesize/deduplicate into findings with full provenance.
6. Show reviewer and stage state in the Goldfish tab.
7. Refuse to mark a partial/unverified run clean.

Critical proof:

- Put a unique marker only in Elephant conversation/memory.
- Assert the canonical reviewer input and stored execution sources exclude it.
- Execute the reviewer and require it to report no knowledge of the marker.
- Verify separate execution IDs, no shared server-side thread, exact input hashes, ordered dependencies, and failure propagation.

## Phase 8 — Resolution, convergence, approval

1. Implement accept/contest/escalate/decline decisions with actor and rationale.
2. Require evidence for contests.
3. Send accepted findings and decisions to Elephant to produce a new artifact version.
4. Link each resolution to source finding and resulting artifact.
5. Determine affected review stages and rerun with fresh contexts.
6. Require all reviewers to run and no unsettled blocker/major findings before final approval.
7. Persist final approval against exact artifact version/hash.
8. Publish the approved artifact through a defined downstream read interface, without automatically generating code or scanning.

Proof required:

- Finding lifecycle and permission tests.
- Accepted-change coverage tests.
- Failed reviewer prevents convergence.
- Repeated issue/fix-failed behavior.
- Approval immutability and artifact-hash tests.

## Phase 9 — Complete UI and History

1. Finish Elephant, Goldfish, and History tabs using the current design language.
2. Show the five user-facing stages while representing detailed internal states accurately.
3. Add chronological events, executions, retries, artifacts, decisions, and approvals.
4. Add artifact version comparison/export.
5. Add accessible focus, keyboard, responsive, scroll, and error behavior.
6. Keep the existing sidebar/dashboard routes and other onboarding flows unchanged.

Proof required:

- Browser tests for both navigation paths.
- Button/state transition tests for every visible control.
- Responsive/modal scroll and focus-trap tests.
- Refresh at every stage.

## Phase 10 — Regression and real end-to-end verification

Automated suite:

- Unit: transition rules, context builders, validation, redaction, artifact hashing, convergence.
- Integration: D1 transactions/migrations, authorization, execution recovery, mocked providers, provider error mappings.
- Browser: project creation, idea entry, tabs, artifact versions, review/resolution/approval, reload/resume.
- Regression: GitHub connect/disconnect/branches, Bitbucket connect/disconnect/branches, credential encryption, project switching, code onboarding, dashboard, scan readiness.

After explicit approval for external usage/cost, run one real agent-backed end-to-end flow and report:

- Provider/model and adapter version.
- Approved budget and actual usage.
- Isolation probe evidence.
- Execution/stage IDs and outcomes.
- Artifact versions/hashes.
- Reviewer failures/retries.
- Final approval and restart persistence.

Mocked tests must be reported as mocked; they cannot be presented as live verification.

## Known blockers and assumptions

- A real provider key/model and explicit cost approval are required for live proof.
- The hosting identity contract must be confirmed before production authorization can be certified.
- D1 migration/deployment behavior must be confirmed before removing runtime schema bootstrap.
- Provider support for cancellation and usage reporting varies; adapters must expose unsupported capabilities honestly.
- A raw stateless API can provide isolated inference only if no thread is reused and the allowlisted input plus canary test are retained as evidence.

## Definition of done

The pipeline is done only when every visible action has a real authorized backend operation; all state survives refresh/restart; artifacts and decisions are versioned and traceable; Goldfish isolation is proven for the configured runtime; convergence and approval are explicit; and GitHub, Bitbucket, project onboarding, and scan readiness retain their regression coverage.
