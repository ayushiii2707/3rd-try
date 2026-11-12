# ADIS Project Hub

An ADIS/HUB-inspired project onboarding flow with persistent projects and live GitHub and Bitbucket repository checks.

## Security and configuration

Set `CREDENTIAL_ENCRYPTION_KEY` in the hosted Site runtime environment to a base64-encoded 32-byte key (for example, `openssl rand -base64 32`). It is deliberately not generated at startup: changing or losing this key prevents decryption of stored credentials. The application encrypts every GitHub PAT and Bitbucket credential bundle with AES-256-GCM and a fresh 96-bit IV before writing it to D1 (SQLite); plaintext credentials are never returned by an API.

The worker validates GitHub with `GET https://api.github.com/repos/{owner}/{repository}` and Bitbucket with `GET https://api.bitbucket.org/2.0/repositories/{workspace}/{repository}` over HTTPS before creating a connection. It then verifies branch access using the selected provider's official API. Successful responses prove access to that exact repository, including private repositories when the submitted credential permits it. Provider failures are mapped to safe, user-actionable messages. Live success-path verification still needs user-provided valid credentials.

The numbered files under `migrations/` document the production schema, including the persisted idea conversation, versioned artifacts, isolated review rounds, and finding resolutions in `0005_idea_workflow.sql`. The worker also performs an idempotent bootstrap because this minimal Worker starter has no migration runner; apply the numbered migrations in order when using a platform migration runner.

## Idea workflow AI

The “I’m starting from an idea” workspace implements only five stages: brainstorm, draft, independent review, resolution, and iterative convergence. Configure the server-side `AI_API_KEY` secret (or `OPENAI_API_KEY`). Optional `AI_BASE_URL` and `AI_MODEL` values select an OpenAI-compatible endpoint and model; the defaults are `https://api.openai.com/v1` and `gpt-4.1-mini`. The key is read only by the Worker and is never sent to the browser or stored in D1.

Brainstorm messages, concept briefs, design drafts, review rounds, and finding decisions are persisted in D1. Five isolated review calls examine only the current artifact through Scope, Comprehension, Design, Feasibility, and Readiness lenses. The loop converges after two consecutive clean rounds and stops after five rounds.

Use this starter for a static microsite, click counter, or simple internal UI whose state is browser-scoped. It has no dependencies and needs no install.

Edit `worker/index.js`, then publish through the Sites hosting workflow with this starter's build and validation in `commands`.

The build copies only `worker/index.js` and `.openai/hosting.json`. Do not add standalone asset files. Embed any essential raster bytes in `worker/index.js` and serve or reference them as a data URL.

Pass these argument arrays as `commands`:

```json
[
  ["bash", "scripts/build.sh"],
  ["node", "scripts/validate-artifact.mjs"],
  ["node", "scripts/audit-workflow.mjs"]
]
```

The deterministic build produces:

```text
dist/
├── .openai/
│   └── hosting.json
└── server/
    └── index.js
```

`dist/server/index.js` is an ES module with a default export containing `fetch(request, env, ctx)`. Edit `worker/index.js`, not the generated file under `dist/`.
