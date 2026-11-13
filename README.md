# ADIS Project Hub

ADIS has two independent onboarding paths:

- **I Have Code** connects an existing GitHub or Bitbucket repository.
- **I Am Starting From an Idea** runs the five-stage Elephant–Goldfish workflow: brainstorm, draft, independent review, resolution, and iterative convergence.

The application uses one persistent, file-backed SQLite database. The local server reuses the existing API handler and SQL contracts through a thin `node:sqlite` adapter; it is not a parallel backend and has no Cloudflare D1 runtime dependency.

## Run locally

Use a stable base64-encoded 32-byte credential key. The server deliberately refuses to start when the key is missing or invalid because silently replacing it would make existing encrypted credentials unreadable.

```bash
export CREDENTIAL_ENCRYPTION_KEY="$(openssl rand -base64 32)"
npm start
```

The application listens on `http://127.0.0.1:8787` and stores its database at `.data/adis-local.sqlite`. `LOCAL_DB_PATH` and `PORT` override those defaults. Keep the same encryption key across restarts.

Numbered SQL files under `migrations/` are applied transactionally. Migration history remains in the legacy-named `d1_migrations` table for compatibility with databases created by earlier builds; the database itself is standard SQLite. Existing rows and relationships are preserved by the additive migrations.

## Repository connections and credential security

GitHub is validated through `GET https://api.github.com/repos/{owner}/{repository}` and Bitbucket through `GET https://api.bitbucket.org/2.0/repositories/{workspace}/{repository}`. Branch and directory discovery also use each provider's official HTTPS API. A connection is stored only after the submitted credential can access the exact repository.

GitHub PATs and Bitbucket credential bundles are encrypted with AES-256-GCM using a fresh 96-bit IV before they are written to SQLite. The encryption key remains outside the database. Plaintext credentials are not returned by APIs or written to logs, and are decrypted only inside authenticated backend repository operations.

## Elephant–Goldfish workflow

The idea workflow does not require or create a repository connection. Brainstorm messages and durable Elephant memory are persisted in SQLite. Elephant creates a concept brief and complete `plan.md`; five isolated Goldfish reviewers receive only that plan and review it through Scope, Comprehension, Design, Feasibility, and Readiness lenses. Accepted findings are applied by Elephant. Convergence requires two consecutive clean review rounds and stops after five rounds.

Configure model access only when live inference is intentionally authorized:

```bash
export AI_API_KEY="..."
# Optional:
export AI_BASE_URL="https://api.openai.com/v1"
export AI_MODEL="gpt-4.1-mini"
```

The model key is server-only and is never stored in SQLite or sent to the browser.

## Verification

```bash
npm test
npm run test:integration
npm run build
npm run validate
npm run audit
```

The integration suite uses real HTTP requests, the production API handlers, all migrations, and a real file-backed SQLite database that is closed and reopened. It verifies persistence, relationships, encrypted credential records, repository onboarding, and the complete Elephant–Goldfish lifecycle.

GitHub, Bitbucket, and model-provider network calls are mocked in the automated suite. Those tests prove local application behavior, not live third-party authentication or paid inference. Live provider success must be reported separately and requires fresh user-authorized credentials.
