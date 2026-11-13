# Phase 3A — Execution Feasibility Report

## Scope and conclusion

This report evaluates the current Cloudflare Worker/D1 implementation and the smallest reliable way to run the approved Elephant–Goldfish stages. It makes no runtime changes, invokes no model, creates no infrastructure, and does not deploy.

The existing architecture can support the pipeline if it is implemented as bounded, durable, multi-request orchestration: persist a queued operation, claim exactly one stage with an expiring lease, perform at most one bounded external model call, atomically adopt its result, and resume the next stage in a later request. D1 records alone do not create background jobs. A complete review cycle cannot be promised to continue after the client disconnects, and `waitUntil()` is not a durable job runner.

No additional Cloudflare product is necessary for the first reliable, user-driven implementation. Fully autonomous execution after the browser closes would require a separately approved durable trigger such as Queues or Workflows.

## 1. Current Worker execution behavior

The application is a single Cloudflare Worker (`worker/index.js`) with an API router and D1 binding:

- Every API request calls `database(env)`, which batches runtime `CREATE TABLE IF NOT EXISTS` statements.
- AI calls use an OpenAI-compatible `/chat/completions` endpoint with an `AbortController` timeout of 45 seconds.
- GitHub and Bitbucket calls use 12-second timeouts.
- The Worker export accepts `(request, env)` only; it does not currently accept `ExecutionContext` or call `waitUntil()`.
- Project access is scoped through `ownedProject`, but the current identity fallback is `local-demo-user` when the trusted user header is absent. That is acceptable only for local demo mode, not production authorization.
- Elephant chat persists the user message before the external call, then batches memory and assistant-message writes after success. A failed call can therefore leave a user message without its assistant response; an unguarded retry can duplicate input.
- Artifact version allocation uses `SELECT MAX(version) + 1`, then a separate insert. Concurrent generation can collide with the existing unique key.
- A review run is inserted as `running`, then five generic lenses execute concurrently with `Promise.allSettled`. There is no durable stage cursor, lease, retry attempt, idempotency key, or stale-run recovery.
- If any reviewer fails, the run is marked failed. If the Worker terminates before that update, the row may remain `running` indefinitely.
- Finding inserts are a D1 batch, but completion of the run is a later statement.
- Resolution calls the model, inserts a new artifact, and updates findings in separate steps; a partial failure can leave the new artifact without all finding dispositions.
- The five current lenses are parallel generic reviews. They are not the ordered `Zoom Out → Comprehension → Critic → Intermediate Zoom Out → Implementation Readiness → synthesis` method.

These behaviors already provide useful persistence, but they do not yet provide authoritative durable execution.

## 2. Cloudflare runtime constraints relevant to this application

The current official Workers limits document states:

- Memory is 128 MB per isolate.
- CPU limits are plan-dependent: the Free plan has a much smaller CPU allowance; paid Workers can be configured up to five minutes of CPU, with a lower default. Waiting for network/D1 I/O does not itself consume CPU, but parsing, validation, hashing, and orchestration do.
- Subrequest limits are plan-dependent, and only six simultaneous outgoing connections may be open per invocation.
- An incoming HTTP request may remain open while the client remains connected, but an invocation can still be interrupted by runtime updates, resource pressure, or errors.

See Cloudflare's current [Workers limits](https://developers.cloudflare.com/workers/platform/limits/). The deployed account plan and `cpu_ms` configuration are not present in this repository, so Phase 3B must not assume paid-plan limits.

Cloudflare's [ExecutionContext documentation](https://developers.cloudflare.com/workers/runtime-apis/context/) establishes the important disconnect behavior:

- Unawaited work that is not registered can be cancelled when the response completes.
- `waitUntil()` extends work for at most 30 seconds after a response or client disconnect, shared across all `waitUntil()` calls for that request.
- Work still unfinished after that grace period is cancelled.
- Cloudflare recommends Queues for work that must reliably continue beyond that window.

Therefore `waitUntil()` can be useful for short best-effort telemetry, not for a durable multi-stage review or convergence loop.

For D1, Cloudflare documents that `batch()` executes statements sequentially and non-concurrently as a transaction; if one statement fails, the sequence is aborted and rolled back. See the [D1 Worker API](https://developers.cloudflare.com/d1/worker-api/d1-database/). This is suitable for atomic state transitions and related local writes, but an external model call cannot be inside a D1 transaction.

## 3. Can the existing architecture support multi-stage orchestration?

Yes, with a resumable state machine spanning multiple HTTP requests. It cannot reliably support an in-memory loop that assumes one Worker invocation will survive all reviewers, resolution, and convergence.

The reliable unit is one bounded operation:

1. A request validates ownership, current workflow state, and artifact hash.
2. A D1 batch creates or finds an idempotent `queued` execution and appends a workflow event.
3. The same or a later request conditionally claims that execution by changing `queued` (or expired `running`) to `running` with a random lease token and expiry.
4. The Worker constructs an allowlisted stateless reviewer context and performs one model call with the existing timeout mechanism.
5. The response is schema-validated and hashed.
6. A D1 batch adopts the result only if the same lease still owns the execution and cancellation has not been requested. It writes the attempt, stage result/findings/artifact as appropriate, updates the run/session cursor, and appends an event.
7. The response tells the UI whether the next operation is ready. The UI explicitly advances it, or a later visit resumes it.

This design reuses the Worker, D1, current endpoints and UI concepts. It adds durable records, not a parallel service.

## 4. Queued, running, and completed behavior

### Queued

- Created before any external call.
- Unique `(project_id, idempotency_key)` prevents a double-click or retried HTTP request from creating duplicate work.
- The idempotency key should include project, operation, input artifact hash, workflow version, stage, and review round.
- A queued row is visible to polling/read endpoints and remains resumable after the browser closes.

### Running

- Claimed with an atomic conditional update, for example `UPDATE ... SET status='running', lease_token=?, lease_expires_at=? WHERE id=? AND (status='queued' OR (status='running' AND lease_expires_at < ?))`.
- The caller must inspect D1's affected-row metadata. Zero changed rows means another request owns the work.
- Each external call receives one attempt row. A heartbeat is optional for a 45-second call but the lease must exceed the provider timeout plus finalization margin.
- The execution cursor and `idea_review_stage_results` establish exactly which ordered stage is active.

### Completed

- Model output is not accepted merely because HTTP succeeded. It must pass schema validation, role/stage checks, input-hash verification, and the isolation evidence policy.
- The final D1 batch marks the attempt and execution succeeded, persists normalized output, updates the run/session cursor, and appends a workflow event.
- A completed stage is immutable. Rerunning it creates a new execution/attempt lineage rather than overwriting evidence.
- A run becomes complete only after synthesis/deduplication succeeds. Convergence requires the configured clean-review rule and explicit artifact approval; a single successful response is not convergence.

## 5. Interruption and retry behavior

Interruption can occur before the external call, during it, or after the provider responds but before D1 finalization.

- **Before claim:** the row remains queued and is safe to retry.
- **After claim, before/during provider call:** the execution remains running until its lease expires. A later request may reclaim it if `attempt_count < max_attempts`.
- **Provider may have completed but Worker died:** a retry may result in another billable provider call because the provider-side operation is not transactionally linked to D1. The local idempotency key prevents duplicate adoption, not necessarily duplicate provider work.
- **After successful D1 finalization:** the same HTTP retry returns the existing execution/result instead of making another call.
- **Invalid structured response:** record a failed attempt with redacted diagnostics, then retry only within the explicit attempt limit. Do not count it as a clean reviewer result.
- **Exhausted attempts:** mark execution and current run stage failed; keep prior successful stages and show a retry/resume action.

Recovery should be demand-driven in the first implementation: opening the workflow or clicking Resume scans for expired leases and advances eligible work. Do not claim autonomous background recovery without a durable trigger.

## 6. Cancellation and what cannot be cancelled

Cancellation is cooperative:

- A cancel request atomically changes queued work to `cancelled`, or running work to `cancel_requested`, and records who requested it.
- A Worker invocation that owns the active `AbortController` may abort its local fetch when it observes cancellation, but a different request cannot directly signal an already-running isolate.
- The remote model provider may continue processing or billing after the client aborts; the application cannot guarantee provider-side cancellation unless that provider exposes a verified cancellation API.
- On response, the running invocation checks durable status before adopting output. If cancellation was requested, it records the attempt as cancelled/discarded and never advances workflow state.
- Completed executions and already-approved artifacts are not “cancelled”; they may be superseded or have approval revoked with a new audit event.

The UI and API must say “cancellation requested” rather than falsely claim an in-flight provider computation was stopped.

## 7. Concurrent execution control

D1 is sufficient for optimistic concurrency if every transition is conditional and checked:

- `idea_sessions.state_version` prevents two tabs from advancing the same project state.
- The execution idempotency unique key collapses duplicate submissions.
- Lease-token compare-and-swap prevents two requests from adopting the same stage.
- A unique `(project_id, round)` review index prevents duplicate review-round allocation after existing data is audited.
- Artifact content hashes prevent a run from applying findings to a different plan version.
- Finding `row_version` prevents concurrent accept/decline actions from overwriting each other.
- Artifact version allocation must catch unique conflicts and reread/retry; `MAX + 1` alone is not sufficient.

D1 `batch()` should contain only local SQL transitions. Never hold or simulate a database transaction across a network model call. If strong sequential read-after-write behavior becomes necessary across replicas, D1 Sessions/bookmarks are available in the [D1 Worker API](https://developers.cloudflare.com/d1/worker-api/d1-database/), but the current primary-read path may be sufficient and should be measured before adding session plumbing.

## 8. Elephant/Goldfish isolation feasibility

Separate CLI processes are not required. The current OpenAI-compatible stateless request model can provide Goldfish isolation if Phase 3B enforces all of the following:

- Each reviewer request is built from an explicit allowlist: exact `plan.md` artifact content plus the minimum upstream stage result required by the ordered graph.
- It never includes Elephant messages, `idea_memory`, hidden chat IDs, prior provider conversation IDs, unrelated findings, or repository credentials.
- `input_manifest_json` and `input_sha256` are persisted before the call.
- Provider configuration is verified not to reuse hidden conversation state.
- A private-marker canary is placed only in Elephant-private context. Independent Goldfish outputs must not reproduce or rely on it.
- Isolation is reported as unverified until the configured provider/runtime passes that test.

The existing five simultaneous calls are separate HTTP calls, but that fact alone does not prove isolation. Ordered stage inputs and evidence must be recorded.

## 9. Is additional infrastructure necessary?

Not for the smallest reliable, user-driven implementation.

The Worker and D1 can support:

- Brainstorm and memory updates one turn per request.
- Concept brief and plan generation one artifact per request.
- Ordered Goldfish review one stage per request.
- Human resolution through normal API requests.
- Re-review/convergence over multiple explicit requests.
- Durable resume after browser refresh or interruption.

Additional infrastructure becomes necessary only if the product requirement changes to “run the entire graph autonomously and reliably after the user closes the browser.” `waitUntil()` cannot guarantee that. At that point, the smallest Cloudflare-native option should be separately evaluated and approved—likely a Queue consumer for durable delivery or Cloudflare Workflows for long-lived multi-step orchestration. Neither should be introduced in Phase 3B without approval.

## 10. Smallest reliable implementation

The recommended Phase 3B sequence is:

1. Complete the target-D1 inventory and additive `0007` migration approval from the schema report.
2. Add schema-version checks and durable execution helpers while preserving current response shapes.
3. Convert one operation first—concept brief generation—to queued/claimed/finalized idempotent execution.
4. Add ordered stage definitions and execute one Goldfish stage per request; retain legacy review history as workflow version 1.
5. Add synthesis/deduplication, evidence-backed findings, and private-marker isolation verification.
6. Make human dispositions compare-and-swap safe; revise only accepted findings into a child artifact.
7. Re-review the new artifact through the same ordered stages until the explicit convergence rule or round limit is reached.
8. Add approval bound to artifact hash.
9. Add stale-lease resume, cooperative cancellation, bounded retry, and failure UI states.
10. Only after all databases are migrated, make migrations authoritative and retire per-request table creation.

Each step is independently testable and can be feature-gated. No current GitHub, Bitbucket, project onboarding, ideation messages, memory, artifacts, or legacy reviews need to be deleted or recreated.

## 11. Verification plan

### Automated, no paid model required

- State-transition and allowlist unit tests.
- Idempotent double-submit tests.
- Two concurrent claim attempts; exactly one may acquire the lease.
- Stale-lease reclaim and max-attempt exhaustion.
- Cancellation before claim, during running, and before result adoption.
- Worker termination simulation between every durable write boundary.
- Invalid JSON/schema response and provider 401/429/5xx/timeout handling.
- Artifact hash mismatch and stale resolution rejection.
- Existing-route regression tests for project creation, GitHub, Bitbucket, setup, and current idea reads.
- D1 migration, foreign-key, orphan, row-count, and response-shape tests.

### Provider/runtime verification requiring explicit approval/configuration

- One real configured-provider call per operation type.
- Private-marker canary test for Goldfish isolation.
- Provider request ID, usage metadata, timeout, and error mapping confirmation.
- Verify whether aborting a request stops provider work or only the local fetch.
- Confirm deployed Workers plan, CPU configuration, bindings, and actual response/disconnect behavior.

No claim of live isolation or end-to-end model execution should be made until these provider tests pass.

## 12. Remaining assumptions and decisions for Phase 3B

1. The deployed D1 schema and migration history are still unknown and must be inventoried.
2. The Cloudflare account plan and configured Worker CPU limit are unknown.
3. The production authentication layer must guarantee `oai-authenticated-user-id`; `local-demo-user` must be restricted to an explicit local mode.
4. The configured AI provider's hidden-state behavior, request IDs, usage shape, and cancellation semantics are unverified.
5. The exact convergence rule needs approval. The current implementation uses two clean rounds and a five-round cap; retaining that is the least disruptive default.
6. The maximum per-stage retry count and lease duration need operational tuning; a conservative starting point is two attempts and a lease longer than the 45-second provider timeout plus finalization margin.
7. Background autonomous continuation is out of scope unless new infrastructure is approved.

## Phase 3B execution recommendation

Proceed only with bounded, user-initiated, resumable stages backed by D1 execution records and optimistic concurrency. Do not place the full review graph in one request, do not rely on `waitUntil()` for durability, and do not add Queues, Durable Objects, or Workflows yet. Preserve all existing UI/API data and introduce the ordered graph behind a workflow version/feature gate.
