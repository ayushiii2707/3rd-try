# ADIS Project Hub

ADIS has two independent onboarding paths:

- **I Have Code** connects an existing GitHub or Bitbucket repository.
- **I Am Starting From an Idea** runs the Elephant–Goldfish workflow: brainstorm, draft, independent review, resolution, and iterative convergence.

The whole application — UI and API — runs on **localhost** with Node.js and stores everything in **one SQLite file**. There is no hosting platform, cloud database, or external account to set up.

## Branches

| Branch | Purpose |
| --- | --- |
| `main` (default) | The complete, current application. Start here. |
| `egm` | Isolated Elephant–Goldfish pipeline development, kept in sync with `main`. |
| `external-sources` | Former default branch, kept identical to `main` so existing clones update with `git pull`. Switch to `main`. |

Earlier local-only history is preserved in the tags `archive/hosted-site-main` and `archive/codex-idea-workflow`.

### Already cloned the repository?

```bash
git fetch origin --prune --tags
git switch main        # creates a local main tracking origin/main if you don't have one
git pull
npm start
```

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
| `AI_API_KEY` (alias `OPENAI_API_KEY`) | unset | Model access for the idea workflow. Without it, repository onboarding works and idea-generation steps report that AI is not configured. |
| `AI_BASE_URL` | `https://api.openai.com/v1` | OpenAI-compatible endpoint. |
| `AI_MODEL` | `gpt-4.1-mini` | Model name. |
| `AI_PROVIDER` | `OpenAI-compatible` | Provider label shown in the idea workspace and execution records. |
| `AI_MAX_CONCURRENCY` | `4` | Maximum simultaneous model requests. Set `1` for accounts with small per-minute token limits (for example free tiers); rate-limited requests wait for the provider's Retry-After and are retried. |
| `ADIS_USER_NAME` / `ADIS_USER_ROLE` | `Local user` / `Owner` | Name and role shown in the app. |
| `ADIS_WORKSPACE_NAME` | `My workspace` | Workspace title on the project list. |
| `PORT` / `HOST` | `8787` / `127.0.0.1` | Listen address. |
| `ALLOWED_HOSTS` | unset | Extra comma-separated host names the server answers to (see Security). |
| `LOCAL_DB_PATH` | `.data/adis-local.sqlite` | SQLite database file. |
| `CREDENTIAL_ENCRYPTION_KEY` | read from `.data/credential.key` | Only set this to reuse a specific existing key. |

### Users and sign-in

Locally the app runs in single-user mode: every request acts as the local user, so no sign-in is needed. If the server is later placed behind an authenticating reverse proxy, set `LOCAL_DEMO_MODE=false` and `TRUST_USER_HEADER=true`; the proxy must then send the signed-in user's id in the `x-adis-user-id` header. API requests with no user are rejected with `401`. The header is ignored unless `TRUST_USER_HEADER=true`.

## Security

- **Cross-site protection:** every state-changing API request must be a same-origin `application/json` request. Requests from other websites (wrong `Origin`, `Sec-Fetch-Site` other than `same-origin`, or a non-JSON body) are rejected, so a page you visit cannot drive your local instance.
- **Host validation:** the server only answers requests addressed to `localhost`, `127.0.0.1`, or `[::1]` (plus `ALLOWED_HOSTS`), which blocks DNS-rebinding attacks.
- **Limits and headers:** request bodies are capped at 1 MB. The page is served with a Content Security Policy, `X-Frame-Options: DENY`, and `Referrer-Policy: no-referrer`.
- **Network exposure:** with the default `HOST=127.0.0.1` only your machine can reach the app. Setting another `HOST` prints a warning, because single-user mode has no sign-in; add the host name you browse to via `ALLOWED_HOSTS`.

## Database

One file-backed SQLite database holds all projects, repository connections, onboarding state, idea sessions, messages, artifacts, reviews, findings, memory, and execution records. Numbered SQL files under `migrations/` are the only schema source; they are applied in order inside transactions at startup and recorded in the `schema_migrations` table. A database created by an earlier build (which used a `d1_migrations` table) is upgraded in place with its history and data preserved.

To inspect it: `sqlite3 .data/adis-local.sqlite` (stop the server first, or open read-only).

## Repository connections and credential security

GitHub is validated through `GET https://api.github.com/repos/{owner}/{repository}` and Bitbucket through `GET https://api.bitbucket.org/2.0/repositories/{workspace}/{repository}`. A connection is stored only after the submitted credential can access the exact repository. Branch and folder discovery use each provider's official API with full pagination, and the result is cached in SQLite. Discovery runs against the provider right after **Check and add** (and via `POST …/connections/{id}/discover`); later page loads read the cache instead of calling the provider again. Setup only accepts a connection that belongs to the project, and finishing setup requires a branch that discovery confirmed.

GitHub PATs and Bitbucket credential bundles are encrypted with AES-256-GCM using a fresh 96-bit IV before they are written to SQLite. New records (`credential_version` 2) also bind the ciphertext to its project, provider, and repository as authenticated associated data, so a ciphertext copied to another row cannot be decrypted; older version 1 records remain readable and are upgraded when a repository is reconnected. The encryption key is kept outside the database. Plaintext credentials are not returned by APIs, not written to logs, and are decrypted only inside backend repository operations. The test suite checks that neither the database file nor its write-ahead log contains a stored token.

Repository scanning is not implemented yet; the dashboard shows it as unavailable.

## Elephant–Goldfish workflow

"I'm starting from an idea" implements the [Elephant–Goldfish Model](https://github.com/google/elephant-goldfish-model) (Apache-2.0; see `NOTICE`): **design with an Elephant, review with a Goldfish.** Elephant is the persistent planner that remembers the discovery conversation. Goldfish reviewers start fresh and see only the document under review. The workflow needs no repository connection.

1. **Brainstorm.** Elephant asks one focused question at a time and keeps a structured memory. When you choose *Review with Goldfishes*, Elephant writes an anchored hypothesis and seven fresh lenses stress-test it in parallel (Contrarian/YAGNI; Cost, Quota & Token Economics; UX & Developer Ergonomics; Migration & Backward Compatibility; Observability & SRE Debuggability; Long-Term Tech Debt; Inventive Catalyst). A synthesizer writes `concepts_brief.md` and lists the strongest objections.
2. **Draft.** Elephant writes the design doc from the brief one section at a time (Overview and user journeys → Technical Plan → Alternatives → Detailed Implementation Plan); you approve each section, with optional feedback. Choices with several defensible answers are presented as options for you to decide. Finalizing checks the draft against the brief and shows any contradictions before the doc is saved.
3. **Independent review.** Five ordered stages, each run by new reviewers: Zoom Out (+ Inventive Catalyst) → Comprehension (the document alone) → Design Critique (design, structure, style) → Intermediate Zoom Out → Implementation Readiness. Findings are rated Blocker, Major, or Nit, merged, given stable ids, and written to a Goldfish Review Report.
4. **Resolution.** Elephant proposes one category per finding — propose fix, contest (with evidence the reviewer could read), escalate (needs a fact only you have), or decline — and you decide. A comprehension gap cannot be contested. Every Blocker and Major needs a decision before Elephant applies the accepted changes into a new design doc version linked to its parent.
5. **Iterative convergence.** A round is clean when every reviewer ran and no unsettled Blocker or Major remains. Two consecutive clean rounds converge; after five rounds (or when fixes keep reopening issues) you choose to accept, continue, or return to drafting. Final approval records the approved document's SHA-256. Settled findings (contested, declined, confirmed) stay settled when re-raised.

**Isolation and durability.** Every Elephant and Goldfish call is a separate, stateless model request recorded as a durable execution (idempotent enqueue, claimed attempt, input hash, output hash). A reviewer is retried once; if it fails again it is recorded as *not run* and the round cannot be clean. A private marker that exists only in Elephant's context is checked against every Goldfish request before it is sent; if it would leak, the reviewer does not run. Completed steps are reused, so a reload or server restart resumes where the workflow stopped. The concepts brief, design doc versions, and review reports download as Markdown.

The model key is server-only and is never stored in SQLite or sent to the browser.

## Verification

```bash
npm test               # all tests: unit, UI contract, and integration (real HTTP server, real SQLite file)
npm run build          # syntax-checks every module
npm run validate       # boots the app on a temporary SQLite file and checks UI + API
```

GitHub, Bitbucket, and model-provider network calls are mocked in the automated suite. Those tests prove local application behavior, not live third-party authentication or paid inference.
