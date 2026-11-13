# Elephant–Goldfish Model Reference Analysis

## Reference and provenance

The upstream reference inspected for this analysis is:

- Repository: `google/elephant-goldfish-model`.
- Pinned commit: `270b10326bf366d823bc76fd662cf83808d5781e`.
- License: Apache License 2.0.
- Upstream status: the README identifies it as not an officially supported Google product.

Any adapted prompts, persona definitions, or documentation must retain required Apache-2.0 notices and record upstream provenance. The application should implement the ideas natively rather than silently copying an unversioned moving target.

## What EGM actually is

EGM is primarily a collection of agent skills, reviewer personas, orchestration instructions, artifact standards, and test fixtures for supported agent harnesses. It is **not** a hosted multi-tenant web application, database schema, credential vault, background job system, or UI component library.

Its core design is a division of memory and responsibility:

- **Elephant:** the persistent primary context. It explores an idea, remembers decisions, drafts artifacts, and resolves reviewer findings with the user.
- **Goldfish:** fresh-context adversarial reviewers. They receive only the target artifact and explicitly allowed supporting material. They do not inherit the Elephant conversation.
- **Synthesizer:** coordinates reviewers and normalizes/deduplicates their outputs into an artifact-first report.
- **Human:** approves sections, decides disputed findings, supplies missing domain knowledge, and approves the final design.

The upstream implementation treats Markdown artifacts as the stable handoff boundary. Chat transcripts are working context, not the final deliverable.

## Upstream workflow

### Brainstorm

The Elephant explores the problem and constraints before producing `concepts_brief.md`. Upstream can use a multi-lens Goldfish swarm during ideation; the synthesizer documentation describes seven lenses and requires failed reviewers to be marked `not run`, never as zero-finding successes.

### Draft

The Elephant turns the approved brief into a design, with section-oriented review and explicit human gates. The durable output is a design artifact rather than an implementation patch.

### Independent review

The upstream review is ordered and substantive, not five interchangeable prompts:

1. **Zoom Out** — high-level coherence and inventive alternatives.
2. **Comprehension** — whether a fresh reader can understand the document from allowed context.
3. **Critic** — design, structural, and style criticism.
4. **Intermediate Zoom Out** — reassessment after detailed criticism.
5. **Implementation Readiness** — whether the design is sufficiently specified to execute safely.

The precise personas are stored under `agents/`, including zoom-out, comprehension, design critic, structural, style, implementation-readiness, inventive-catalyst, and synthesizer roles.

### Resolution

The Elephant evaluates consolidated findings and categorizes them. A contest must cite evidence the reviewer was allowed to read. A comprehension gap cannot be dismissed merely because the Elephant remembers omitted context. The human resolution gate is essential: some findings require domain knowledge rather than simple approval.

### Iterative convergence

After fixes, fresh reviewers run again. A reviewer failure is retried once and then recorded as `not run`; it cannot count as a clean result. A clean round has no unsettled blocker or major findings, and all required reviewers must have run. The workflow retains reports and returns to a human checkpoint between rounds.

## Genuine context isolation

The strongest upstream rule is explicit: a Goldfish runs in a fresh context with no parent conversation history. For Codex-like harnesses, upstream calls for a child/subagent with context forking disabled (`fork_turns: "none"` or the host equivalent). If no mechanism can establish fresh context, the review must stop rather than run in the Elephant context.

Fresh conversation context alone is not always sufficient because hosts may inject filesystem instructions, configured memory, or project context. Upstream therefore recommends a canary test: place a unique secret marker only in parent context and prove the child cannot report it. The test must also inspect child inputs/tool traces where the host exposes them.

For this web application, the equivalent standard is:

- Each reviewer is a distinct execution with a distinct execution ID.
- Its request is built from an allowlist: persona, target artifact version, approved standards, and explicitly approved source material.
- Elephant messages and memory are never queried into reviewer input.
- The exact canonical input is hashed and recorded.
- A private-marker isolation probe is run for each provider/model capability profile.
- Reviewer output, status, timing, model identity, and failure are recorded individually.
- A failed or unverifiable reviewer is `not run`, not clean.

A stateless API request can be a fresh inference context if the application constructs it from the allowlist and proves no hidden server-side thread is reused. Merely sending five prompts in parallel is not enough without this evidence.

## What can be adapted directly

- Elephant versus Goldfish responsibility boundaries.
- Artifact-first handoffs.
- Ordered reviewer stages and persona responsibilities.
- Allowlisted reviewer inputs.
- Failed-reviewer semantics and one focused retry.
- Normalization/deduplication before resolution.
- Evidence-based contesting.
- Human resolution and approval gates.
- Clean-round convergence criteria.
- Isolation canary tests and execution evidence.
- No-production-code boundary during design phases.

These are architectural mechanisms. They should be represented as versioned prompt/persona assets and explicit services rather than embedded, untraceable strings.

## What must be implemented independently

Because upstream is not a web backend, this application must build:

- Multi-user/project authorization.
- Persistent sessions and resumability.
- Database migrations and transactional state changes.
- Provider configuration and encrypted credential lifecycle.
- Durable execution/event records.
- Idempotent APIs, cancellation, retries, and concurrency control.
- Browser UI, loading/error states, tabs, artifacts, and history.
- Usage limits and cost approval.
- Artifact version browsing and export.
- Cross-user isolation and security headers.
- Provider capability verification.
- Regression tests for the existing GitHub/Bitbucket pipelines.

## Differences from the current implementation

The current application already has an Elephant-like chat, artifact versions, five generic review calls, finding dispositions, and a simple multi-round rule. It does not preserve the upstream stage ordering, personas, evidence model, synthesizer boundary, human approval semantics, or verifiable fresh-context isolation.

The existing review therefore provides useful scaffolding but cannot be labeled an EGM-equivalent Goldfish review until the isolation and execution evidence requirements are met.

## Upstream verification model

Upstream contains offline unit tests plus opt-in native integration probes for multiple harnesses. Its Codex tests verify installation, fresh-context behavior, reviewer ordering, required reads, and output artifacts. The test documentation warns that artifact existence alone does not prove reviewer isolation and that host-added instructions must be tested separately.

Our implementation should follow that evidentiary standard: retain exact execution inputs/hashes and test a deliberately excluded marker, rather than relying on a model's claim that it was isolated.

## Limitations and assumptions

- Provider APIs differ in whether they expose server-side threads. Each adapter must explicitly state whether requests are stateless or thread-bound.
- A single provider/model can run multiple independent reviewers, but independent input construction and execution proof remain mandatory.
- The upstream prompt assets may evolve; this application must pin and version any adapted assets.
- No live upstream native harness or paid model was executed during this analysis.
