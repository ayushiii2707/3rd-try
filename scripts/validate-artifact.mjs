// Boots the real application server on a throwaway SQLite file and checks
// that the UI and API answer on localhost.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startLocalBackend } from "./local-backend.mjs";

const directory = await mkdtemp(join(tmpdir(), "adis-validate-"));
const backend = await startLocalBackend({
  databasePath: join(directory, "adis.sqlite"),
  env: { CREDENTIAL_ENCRYPTION_KEY: "", CREDENTIAL_KEY_FILE: "", TRUST_USER_HEADER: "" },
});
try {
  const page = await fetch(`${backend.origin}/`);
  assert.equal(page.status, 200, "GET / must serve the application");
  assert.match(page.headers.get("content-type") || "", /text\/html/);
  const projects = await fetch(`${backend.origin}/api/projects`);
  assert.equal(projects.status, 200, "GET /api/projects must succeed on localhost");
  assert.deepEqual((await projects.json()).projects, []);
  console.log(`Application validated on ${backend.origin} with SQLite (${backend.migrations.length} migrations).`);
} finally {
  await backend.close();
  await rm(directory, { recursive: true, force: true });
}
