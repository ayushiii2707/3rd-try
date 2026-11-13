# Existing System Baseline

> **Runtime note (superseded platform details):** This analysis was written when the app was hosted as a Cloudflare-style Worker with a D1 binding. That is no longer the case. The application now runs only on localhost with Node.js (`npm start`) and stores everything in one SQLite file (`.data/adis-local.sqlite`); there is no hosting platform, D1 binding, Wrangler, or cloud account. Read "D1" below as "the SQLite database" and ignore Cloudflare limits, deployment, Time Travel, and Wrangler steps. See README.md.

## Scope and verification date

This baseline records the local application as inspected on 2026-11-13, before any work for the master Elephant–Goldfish implementation prompt. It separates code that exists from behavior that has actually been proven. No deployment, remote push, database mutation, or paid model call was performed during this audit.

The checkout was on `elephant-goldfish-pipeline`. Pre-existing working-tree changes in `worker/index.js`, `scripts/audit-workflow.mjs`, and `.wrangler/` were left untouched.

## Application shape

The application is a small Cloudflare Worker-style site:

- `worker/index.js` contains the HTTP router, database access, GitHub and Bitbucket adapters, LLM calls, and the generated HTML/CSS/browser JavaScript.
- D1 provides SQLite-compatible persistence through `env.DB`.
- `migrations/0001` through `0006` define project, repository, onboarding, and ideation tables.
- `scripts/build.sh` copies the Worker into the distributable artifact.
- `scripts/validate-artifact.mjs` and `scripts/audit-workflow.mjs` perform static artifact/source checks.

There is no frontend framework, backend framework, dependency injection layer, job queue, or browser test harness. The architecture is deployable but highly concentrated in one large source file, which increases regression risk.

## Existing project and repository workflows

The application already contains two onboarding paths:

1. **I have code** — creates a project, connects GitHub or Bitbucket, retrieves repository metadata and branches, and stores setup selections.
2. **I am starting from an idea** — opens the Ideate workspace and exposes a five-stage checklist.

GitHub and Bitbucket access is implemented with their official HTTPS APIs. Repository credentials are encrypted with AES-256-GCM using a fresh 96-bit IV and a server-side `CREDENTIAL_ENCRYPTION_KEY`. The key is not stored with ciphertext and plaintext credentials are not returned to the browser. This is structurally sound, but this audit did not use live credentials and therefore is not a live provider certification.

## Current Ideate user interface

The current Ideate screen exposes:

- Brainstorm.
- Draft.
- Independent Review.
- Resolution.
- Iterative Convergence.
- A New Session action.
- A Connect Agent action.
- An Elephant conversation and memory area.
- Versioned concept/design artifact controls.
- Review findings and finding disposition actions.

The existing UI is more than a static mockup. It calls backend endpoints and renders stored state. It does not yet provide the complete requested Elephant, Goldfish, and History workspaces, execution evidence, approval experience, export surface, or robust recovery/cancellation states.

## Functional versus incomplete behavior

### Functional in the source

- A project-scoped idea session can be created and resumed.
- User and assistant messages can be stored in `idea_messages`.
- Structured memory can be stored in `idea_memory`.
- An OpenAI-compatible agent endpoint can be probed.
- Concept and design artifacts can be stored with increasing versions in `idea_artifacts`.
- Five review prompts can be invoked concurrently.
- Findings can be stored and assigned dispositions such as accepted or contested.
- Accepted findings can be passed to the Elephant path to revise a design.
- Review rounds and a simple convergence rule are persisted.

### Incomplete, weak, or placeholder behavior

- **Agent connection:** the check asks a model to return `{"ok":true}`. It verifies model reachability, not tool capability, context isolation, cancellation support, model identity, or reviewer spawning.
- **Goldfish isolation:** review calls are separate stateless HTTP requests, but the application does not record or prove their constructed contexts. It does not run the upstream ordered reviewer stages or an isolation canary test. The UI must not claim upstream-equivalent independent review yet.
- **Reviewer identities:** the five current lenses are Scope, Comprehension, Design, Feasibility, and Readiness. They do not match the upstream staged reviewer graph.
- **History:** artifact versions and rounds exist, but there is no authoritative chronological event log covering transitions, retries, approvals, executions, and failure reasons.
- **State machine:** session stages are loose string states. Transition preconditions, idempotency, and concurrent mutation control are not enforced centrally.
- **Approvals:** no durable final approval record exists with approver, artifact hash/version, timestamp, and decision context.
- **Artifacts:** versioning exists, but prompt/model provenance, input hashes, source references, validation results, and export metadata are absent.
- **Failure recovery:** a user message is stored before the model call. A failed response can therefore leave a partial turn without a paired execution record or deterministic retry key.
- **Cancellation:** the backend uses a timeout, but there is no user-visible cancellation protocol or durable cancellation state.
- **Costs and limits:** there are no per-project budgets, token/cost records, or rate/concurrency controls for ideation.

## Frontend/backend communication

The browser uses JSON requests to project-scoped `/api/projects/:projectId/...` endpoints served by the same Worker. The Worker:

1. Resolves the authenticated user identifier.
2. Verifies that the project belongs to that user.
3. Reads or mutates D1.
4. Calls external providers server-side where required.
5. Returns non-secret JSON.

The authorization boundary is weakened in local/default operation because a missing `oai-authenticated-user-id` header falls back to `local-demo-user`. That fallback is useful for local demos but is not an acceptable production identity guarantee.

## LLM and agent execution

The current adapter targets an OpenAI-compatible `/chat/completions` endpoint. Configuration is supplied by server-side environment values:

- `AI_API_KEY` or `OPENAI_API_KEY`.
- `AI_BASE_URL` (default `https://api.openai.com/v1`).
- `AI_MODEL` (default `gpt-4.1-mini` in the main adapter).

There is a configuration inconsistency: the saved connection response defaults to `gpt-4o-mini` when `AI_MODEL` is absent, while the execution adapter defaults to `gpt-4.1-mini`. This must be corrected before execution metadata can be trusted.

Prompts request JSON and responses are parsed into application records. There is no provider-neutral execution contract, prompt registry, schema validator, streaming transport, token accounting, retry policy, or durable execution table.

## Persistence baseline

Existing tables are:

- `projects`.
- `repository_connections`.
- `repository_discovery`.
- `project_setup`.
- `project_onboarding`.
- `idea_sessions`.
- `idea_messages`.
- `idea_artifacts`.
- `idea_review_runs`.
- `idea_findings`.
- `idea_agent_connections`.
- `idea_memory`.

Important gaps include workflow events, transition attempts, execution records, reviewer inputs, resolution decisions, approvals, cancellation/lease data, usage/cost records, and source-reference provenance. Runtime schema bootstrapping in `worker/index.js` also differs from some migration constraints, creating schema-drift risk.

## Security baseline

Positive controls:

- Repository secrets remain server-side.
- GitHub and Bitbucket credentials use authenticated encryption.
- API responses use `Cache-Control: no-store`.
- External provider traffic uses HTTPS.
- Project ownership checks are present on project-scoped routes.

Gaps requiring work:

- Production authentication must not rely on a fallback identity.
- The HTML response does not show a complete CSP/HSTS/frame/referrer security-header policy.
- Sensitive prompt/message logging rules are not formalized.
- Ideation agent credentials are environment-wide; there is no encrypted per-user/provider credential record or explicit credential rotation lifecycle.
- No project-level execution quotas, replay protection, or concurrency leases exist.
- Authorization and cross-user isolation lack automated negative tests.

## Verification performed

The following local commands passed:

- `npm run build`.
- `npm run validate`.
- `npm run audit`.

These results prove that the current source builds and satisfies the repository's static assertions. They do **not** prove browser interactions, database restart persistence, live GitHub/Bitbucket access, live LLM behavior, reviewer isolation, or the requested end-to-end workflow. The current audit script is largely based on expected source strings and should be treated as a smoke check.

## Main regression risks

1. The monolithic Worker couples UI, routing, storage, providers, and orchestration.
2. Runtime DDL and migrations can diverge.
3. Existing repository onboarding and credential code shares the same file as Ideate changes.
4. Current clients may depend on existing endpoint shapes and stage names.
5. Concurrent review requests can partially fail without durable per-execution recovery.
6. Introducing schema constraints without migrating existing rows could block startup.
7. Paid model calls could be triggered accidentally unless every execution remains user initiated and budget gated.

## Baseline conclusion

The project has a useful persisted prototype, not a complete EGM implementation. The safe path is additive: preserve existing project/repository tables and routes, introduce explicit orchestration and evidence records behind compatible endpoints, then replace each weak stage only after focused regression tests pass.
