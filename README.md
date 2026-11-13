# ADIS Project Hub

ADIS has two independent onboarding paths:

- **I Have Code** connects an existing GitHub or Bitbucket repository.
- **I Am Starting From an Idea** runs the Elephant–Goldfish workflow: brainstorm, draft, independent review, resolution, and iterative convergence.

The whole application — UI and API — runs on **localhost** with Node.js and stores everything in **one SQLite file**. There is no hosting platform, cloud database, or external account to set up.

## Run locally

Requirements: Node.js 22.9 or newer (the server uses Node's built-in `node:sqlite`). No `npm install` is needed — there are no dependencies.

```bash
npm start
```

Open <http://localhost:8787>.

That is all. On first start the server:

- creates the SQLite database at `.data/adis-local.sqlite` and applies every migration in `migrations/`;
- creates a credential encryption key at `.data/credential.key` (file mode 600) and reuses it on every later start.

`.data/` is git-ignored. Keep `credential.key` together with the database: repository credentials stored in that database can only be decrypted with that key. The server never generates a new key for a database that already holds encrypted credentials — it stops with an explanation instead.

`npm run dev` does the same but restarts automatically when files in `worker/` or `scripts/` change.

### Optional settings

Copy `.env.example` to `.env` (git-ignored) or export variables in your shell:

| Variable | Default | Purpose |
| --- | --- | --- |
| `AI_API_KEY` | unset | Model access for the idea workflow. Without it, repository onboarding works and idea-generation steps report that AI is not configured. |
| `AI_BASE_URL` | `https://api.openai.com/v1` | OpenAI-compatible endpoint. |
| `AI_MODEL` | `gpt-4.1-mini` | Model name. |
| `PORT` / `HOST` | `8787` / `127.0.0.1` | Listen address. |
| `LOCAL_DB_PATH` | `.data/adis-local.sqlite` | SQLite database file. |
| `CREDENTIAL_ENCRYPTION_KEY` | read from `.data/credential.key` | Only set this to reuse a specific existing key. |

### Users and sign-in

Locally the app runs in single-user mode: every request acts as the local user, so no sign-in is needed. If the server is later placed behind an authenticating reverse proxy, set `LOCAL_DEMO_MODE=false` and `TRUST_USER_HEADER=true`; the proxy must then send the signed-in user's id in the `x-adis-user-id` header. API requests with no user are rejected with `401`. The header is ignored unless `TRUST_USER_HEADER=true`.

## Database

One file-backed SQLite database holds all projects, repository connections, onboarding state, idea sessions, messages, artifacts, reviews, findings, memory, and execution records. Numbered SQL files under `migrations/` are applied in order inside transactions and recorded in the `schema_migrations` table. A database created by an earlier build (which used a `d1_migrations` table) is upgraded in place with its history and data preserved.

To inspect it: `sqlite3 .data/adis-local.sqlite` (stop the server first, or open read-only).

## Repository connections and credential security

GitHub is validated through `GET https://api.github.com/repos/{owner}/{repository}` and Bitbucket through `GET https://api.bitbucket.org/2.0/repositories/{workspace}/{repository}`. Branch and directory discovery also use each provider's official HTTPS API. A connection is stored only after the submitted credential can access the exact repository.

GitHub PATs and Bitbucket credential bundles are encrypted with AES-256-GCM using a fresh 96-bit IV before they are written to SQLite. The encryption key is kept outside the database. Plaintext credentials are not returned by APIs or written to logs, and are decrypted only inside backend repository operations.

## Elephant–Goldfish workflow

The idea workflow does not require or create a repository connection. Brainstorm messages and Elephant memory are persisted in SQLite. Elephant creates a concept brief (through the durable execution lifecycle) and a `plan.md`; Goldfish reviewers receive only that plan. Accepted findings are applied by Elephant. Convergence requires two consecutive clean review rounds and stops after five rounds.

Current status: only concept-brief generation runs through the durable queue/claim/retry lifecycle. The ordered six-stage Goldfish review, formal approval gates, and context-isolation proof are still being implemented — see `CODEX_HANDOFF_CONTEXT.md`.

The model key is server-only and is never stored in SQLite or sent to the browser.

## Verification

```bash
npm test               # unit + integration tests (real HTTP server, real SQLite file)
npm run build          # syntax-checks every module
npm run validate       # boots the app on a temporary SQLite file and checks UI + API
npm run audit          # source-level workflow checks
```

GitHub, Bitbucket, and model-provider network calls are mocked in the automated suite. Those tests prove local application behavior, not live third-party authentication or paid inference.
