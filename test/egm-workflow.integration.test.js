// End-to-end tests for the Elephant–Goldfish workflow on the real local server
// and a real SQLite file, with a deterministic mock model.
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { startLocalBackend } from "../scripts/local-backend.mjs";
import { createModel } from "./helpers/egm-model.js";

const nativeFetch = globalThis.fetch;
const PRIVATE_CHAT = "PRIVATE-DISCUSSION-7f3a";

async function withWorkflow(run, modelOptions = {}) {
  const directory = await mkdtemp(join(tmpdir(), "adis-egm-"));
  const databasePath = join(directory, "adis.sqlite");
  const model = createModel(modelOptions);
  globalThis.fetch = async (input, init) => {
    const handled = await model.handle(input, init);
    if (handled) return handled;
    throw new Error("Unexpected external request " + new Request(input, init).url);
  };
  const env = { CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 21).toString("base64"), AI_API_KEY: "mock", AI_BASE_URL: "https://mock-ai.invalid/v1", AI_MODEL: "mock-model", TRUST_USER_HEADER: "", ADIS_USER_NAME: "Test Author" };
  let backend = await startLocalBackend({ databasePath, env });
  const call = async (path, { method = "GET", body } = {}) => {
    const response = await nativeFetch(backend.origin + path, { method, headers: method === "GET" ? {} : { "content-type": "application/json" }, body: body === undefined ? (method === "GET" ? undefined : "{}") : JSON.stringify(body) });
    const text = await response.text();
    let payload = null;
    try { payload = JSON.parse(text); } catch {}
    return { status: response.status, body: payload, text, headers: response.headers };
  };
  const ok = async (path, options) => {
    const result = await call(path, options);
    assert.ok(result.status < 300, `${options?.method || "GET"} ${path} -> ${result.status} ${result.text}`);
    return result.body;
  };
  const db = () => new DatabaseSync(databasePath);
  const context = {
    model, call, ok, db,
    async restart() { await backend.close(); backend = await startLocalBackend({ databasePath, env }); },
  };
  try {
    await run(context);
  } finally {
    await backend.close();
    globalThis.fetch = nativeFetch;
  }
}

async function brainstormReady({ ok }, code = "EGM") {
  const projectId = (await ok("/api/projects", { method: "POST", body: { name: "EGM project", code } })).project.id;
  const base = `/api/projects/${projectId}/idea`;
  await ok(base, { method: "PATCH", body: { title: "Durable planner", stage: "workspace" } });
  await ok(base + "/agent", { method: "POST" });
  await ok(base + "/start", { method: "POST" });
  await ok(base + "/messages", { method: "POST", body: { content: "It is for small teams. " + PRIVATE_CHAT } });
  return { projectId, base };
}

async function draftAll({ ok }, base) {
  for (const key of ["overview", "technical_plan", "alternatives", "implementation"]) {
    await ok(`${base}/draft/sections/${key}`, { method: "POST", body: { feedback: "" } });
    await ok(`${base}/draft/sections/${key}/approve`, { method: "POST" });
  }
}

async function runRound({ ok }, base) {
  const { run } = await ok(base + "/review/rounds", { method: "POST" });
  let result;
  for (let index = 0; index < 6; index += 1) result = await ok(`${base}/review/rounds/${run.id}/next`, { method: "POST" });
  assert.equal(result.synthesized, true);
  // Elephant classifies findings in batches until none remain.
  for (let remaining = result.to_classify; remaining > 0;) {
    const batch = await ok(`${base}/review/rounds/${run.id}/classify`, { method: "POST" });
    assert.ok(batch.classified > 0, "each batch makes progress");
    remaining = batch.remaining;
  }
  return result.run;
}

test("the full Elephant–Goldfish lifecycle converges and is approved", async () => {
  let reviewCall = 0;
  await withWorkflow(async (ctx) => {
    const { ok, call, db, model } = ctx;
    const { projectId, base } = await brainstormReady(ctx);

    // Brainstorm: hypothesis, seven lenses, synthesizer.
    const brainstorm = await ok(base + "/brainstorm", { method: "POST" });
    assert.equal(brainstorm.lenses.length, 7);
    assert.ok(brainstorm.lenses.every((lens) => lens.status === "completed"));
    assert.match(brainstorm.artifact.content, /Concepts Brief[\s\S]*Alternatives Weighed/);
    assert.equal(model.counts.brainstorm_hypothesis, 1);
    assert.equal(Object.keys(model.counts).filter((task) => task.startsWith("brainstorm_lens:")).length, 7);

    // Sections must be approved in order.
    const early = await call(`${base}/draft/sections/technical_plan`, { method: "POST", body: {} });
    assert.equal(early.status, 400);
    await draftAll(ctx, base);

    // Finalize reports contradictions first; the author can keep the draft.
    const first = await ok(base + "/draft/finalize", { method: "POST", body: { acknowledge: false } });
    assert.equal(first.finalized, false);
    assert.equal(first.contradictions.length, 1);
    const finalized = await ok(base + "/draft/finalize", { method: "POST", body: { acknowledge: true } });
    assert.equal(finalized.finalized, true);
    assert.equal(model.counts.draft_reconcile, 1, "the reconcile result is reused, not re-requested");
    assert.match(finalized.artifact.content, /\*\*Status:\*\* In Review[\s\S]*## Detailed Implementation Plan[\s\S]*_Drafted with EGM_/);

    // Round 1 finds a Major issue; Elephant proposes a fix; the author accepts.
    const round1 = await runRound(ctx, base);
    assert.equal(round1.clean, false);
    const workflow1 = await ok(base + "/workflow");
    assert.equal(workflow1.findings.length, 1);
    const finding = workflow1.findings[0];
    assert.equal(finding.category, "propose_fix");
    assert.match(finding.finding_key, /^design_critic-1-1$/);
    const blocked = await call(base + "/review/rounds", { method: "POST" });
    assert.equal(blocked.status, 409, "undecided Major findings block the next round");
    await ok(`${base}/findings/${finding.id}`, { method: "PATCH", body: { decision: "accept" } });
    const applied = await ok(base + "/resolve", { method: "POST" });
    assert.equal(applied.artifact.version, 2);
    assert.equal(applied.artifact.parent_artifact_id, finalized.artifact.id);
    assert.match(applied.artifact.content, /REVISED/);

    // Two consecutive clean rounds converge.
    const round2 = await runRound(ctx, base);
    assert.equal(round2.clean, true);
    assert.equal(round2.status, "complete");
    const round3 = await runRound(ctx, base);
    assert.equal(round3.status, "converged");
    assert.equal(round3.clean_rounds, 2);
    const converged = await call(base + "/review/rounds", { method: "POST" });
    assert.equal(converged.status, 409);

    const approved = await ok(base + "/approve", { method: "POST", body: {} });
    assert.equal(approved.approved, true);
    const workflow = await ok(base + "/workflow");
    assert.equal(workflow.egm.state, "approved");
    assert.ok(workflow.egm.approval.artifact_sha256);

    // Documents and reports download as Markdown.
    const doc = await call(`${base}/documents/${applied.artifact.id}`);
    assert.equal(doc.status, 200);
    assert.match(doc.headers.get("content-disposition"), /attachment; filename=".+-v2\.md"/);
    assert.match(doc.text, /\*\*Status:\*\* Approved/);
    const report = await call(`${base}/reports/${round1.id}`);
    assert.match(report.text, /# Goldfish Review Report[\s\S]*## Reviewer Status[\s\S]*Prioritized Findings/);

    // Every reviewer call is a durable execution with an attempt record.
    const sqlite = db();
    const reviewers = sqlite.prepare("SELECT COUNT(*) AS count FROM idea_executions WHERE project_id=? AND operation='review_reviewer' AND status='succeeded'").get(projectId).count;
    assert.equal(reviewers, 9 * 3);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM idea_review_stage_results").get().count, 15);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM idea_artifact_approvals").get().count, 1);
    sqlite.close();
    assert.ok(!JSON.stringify(workflow).includes("EGM-PRIVATE-"), "the private marker never reaches the browser");

    // Everything survives a restart.
    await ctx.restart();
    const restored = await ok(base + "/workflow");
    assert.equal(restored.egm.state, "approved");
    assert.equal(restored.runs.length, 3);
  }, {
    contradictions: [{ section: "Overview", draft_says: "Local only", brief_says: "Hosted" }],
    reviewFindings: (persona, user) => {
      reviewCall += 1;
      if (persona === "design_critic" && !user.includes("REVISED")) {
        return [{ severity: "Major", title: "Restart behaviour unspecified", affected_scope: "Overview, lines 5-8", description: "No restart guarantee.", rationale: "Add one." }];
      }
      return [];
    },
  });
});

test("Goldfish requests never contain Elephant context, and a leaked marker stops the reviewer", async () => {
  await withWorkflow(async (ctx) => {
    const { ok, db, model } = ctx;
    const { projectId, base } = await brainstormReady(ctx, "ISO");
    await ok(base + "/brainstorm", { method: "POST" });
    await draftAll(ctx, base);
    const design = (await ok(base + "/draft/finalize", { method: "POST", body: {} })).artifact;
    await runRound(ctx, base);

    const sqlite = db();
    const canary = sqlite.prepare("SELECT egm_canary FROM idea_sessions WHERE project_id=?").get(projectId).egm_canary;
    assert.match(canary, /^EGM-PRIVATE-[0-9a-f]{24}$/);
    const elephant = model.requests.filter((request) => /^(brainstorm_hypothesis|draft_section|draft_reconcile|review_classification)/.test(request.task));
    const goldfish = model.requests.filter((request) => /^(brainstorm_lens|brainstorm_synthesis|review:)/.test(request.task));
    assert.ok(elephant.length > 0 && goldfish.length > 0);
    assert.ok(elephant.every((request) => request.raw.includes(canary)), "the marker is present in Elephant context");
    for (const request of goldfish) {
      assert.ok(!request.raw.includes(canary), `${request.task} must not see the Elephant marker`);
      assert.ok(!request.raw.includes(PRIVATE_CHAT), `${request.task} must not see the discovery conversation`);
      assert.ok(!request.raw.includes("ELEPHANT MEMORY"), `${request.task} must not see Elephant memory`);
    }
    // Reviewers see the document; comprehension sees it without the standard.
    const comprehension = model.requests.find((request) => request.task === "review:comprehension");
    assert.match(comprehension.user, /DOCUMENT:\n[\s\S]*The Problem/);
    assert.ok(!comprehension.user.includes("DESIGN DOCUMENT STANDARD"));
    const critic = model.requests.find((request) => request.task === "review:design_critic");
    assert.ok(critic.user.includes("DESIGN DOCUMENT STANDARD"));
    assert.ok(!critic.user.includes("Detailed Implementation Plan\n"), "the critique stage reviews the feature range only");
    const readiness = model.requests.find((request) => request.task === "review:implementation_readiness");
    assert.match(readiness.user, /Detailed Implementation Plan/);
    assert.ok(!readiness.user.includes("Teams lose planning context"), "the readiness stage reviews the detailed range only");

    // Each Goldfish execution records its isolation check in the manifest.
    const manifests = sqlite.prepare("SELECT input_manifest_json FROM idea_executions WHERE agent_role='goldfish'").all();
    assert.ok(manifests.every((row) => JSON.parse(row.input_manifest_json).some((entry) => entry.kind === "isolation_check" && entry.elephant_marker_absent === true)));

    // If the marker ever leaks into the document, no reviewer runs on it.
    sqlite.prepare("UPDATE idea_artifacts SET content=content||? WHERE id=?").run("\n" + canary, design.id);
    sqlite.close();
    const before = model.requests.length;
    const { run } = await ok(base + "/review/rounds", { method: "POST" });
    const blocked = await ctx.call(`${base}/review/rounds/${run.id}/next`, { method: "POST" });
    assert.equal(blocked.status, 503);
    assert.match(blocked.body.error, /No reviewer could run in the Zoom Out stage: Isolation check failed/);
    const check = db();
    assert.equal(check.prepare("SELECT COUNT(*) AS count FROM idea_review_stage_results WHERE run_id=?").get(run.id).count, 0, "nothing is recorded for a stage no reviewer could run");
    check.close();
    assert.equal(model.requests.length, before, "no request was sent to the model");
  });
});

test("a reviewer is retried once, then recorded as not run, and the round is not clean", async () => {
  await withWorkflow(async (ctx) => {
    const { ok, db, model } = ctx;
    const { base } = await brainstormReady(ctx, "RETRY");
    await ok(base + "/brainstorm", { method: "POST" });
    await draftAll(ctx, base);
    await ok(base + "/draft/finalize", { method: "POST", body: {} });
    model.failures["review:inventive_catalyst"] = 1; // recovers on retry
    model.failures["review:style"] = 4; // fails in both stages it runs in
    const run = await runRound(ctx, base);
    assert.equal(run.clean, false, "a not-run reviewer makes the round not clean");
    const workflow = await ok(base + "/workflow");
    const statuses = workflow.egm.review.current_run.reviewer_status;
    assert.equal(statuses.find((item) => item.persona === "inventive_catalyst").status, "completed");
    assert.deepEqual(statuses.filter((item) => item.persona === "style").map((item) => item.status), ["not run", "not run"]);
    const sqlite = db();
    const attempts = sqlite.prepare("SELECT e.persona_version, e.status, COUNT(a.id) AS attempts FROM idea_executions e JOIN idea_execution_attempts a ON a.execution_id=e.id WHERE e.operation='review_reviewer' AND (e.persona_version LIKE '%inventive_catalyst' OR e.persona_version LIKE '%style') GROUP BY e.id").all();
    sqlite.close();
    assert.ok(attempts.some((row) => row.persona_version.endsWith("inventive_catalyst") && row.status === "succeeded" && row.attempts === 2));
    assert.ok(attempts.filter((row) => row.persona_version.endsWith("style")).every((row) => row.status === "failed" && row.attempts === 2));
  });
});

test("a stage where no reviewer could run is not recorded and can be retried", async () => {
  await withWorkflow(async (ctx) => {
    const { ok, call } = ctx;
    const { base } = await brainstormReady(ctx, "OUTAGE");
    await ok(base + "/brainstorm", { method: "POST" });
    await draftAll(ctx, base);
    await ok(base + "/draft/finalize", { method: "POST", body: {} });
    const { run } = await ok(base + "/review/rounds", { method: "POST" });
    const outage = await call(`${base}/review/rounds/${run.id}/next`, { method: "POST" });
    assert.equal(outage.status, 503);
    assert.match(outage.body.error, /No reviewer could run in the Zoom Out stage/);
    const retried = await ok(`${base}/review/rounds/${run.id}/next`, { method: "POST" });
    assert.equal(retried.stage.key, "zoom_out", "the same stage runs again instead of being skipped");
    assert.ok(retried.stage.reviewers.every((reviewer) => reviewer.status === "completed"));
  }, { failures: { "review:zoom_out": 2, "review:inventive_catalyst": 2 } });
});

test("stages run strictly in order, resume after a restart, and reuse completed work", async () => {
  await withWorkflow(async (ctx) => {
    const { ok, db, model } = ctx;
    const { base } = await brainstormReady(ctx, "ORDER");
    await ok(base + "/brainstorm", { method: "POST" });
    const lensCalls = Object.entries(model.counts).filter(([task]) => task.startsWith("brainstorm_lens:")).reduce((sum, [, count]) => sum + count, 0);
    await ok(base + "/brainstorm", { method: "POST" });
    const lensCallsAfter = Object.entries(model.counts).filter(([task]) => task.startsWith("brainstorm_lens:")).reduce((sum, [, count]) => sum + count, 0);
    assert.equal(lensCallsAfter, lensCalls, "re-running the brainstorm on the same hypothesis reuses lens results");
    await draftAll(ctx, base);
    await ok(base + "/draft/finalize", { method: "POST", body: {} });
    const { run } = await ok(base + "/review/rounds", { method: "POST" });
    const s1 = await ok(`${base}/review/rounds/${run.id}/next`, { method: "POST" });
    const s2 = await ok(`${base}/review/rounds/${run.id}/next`, { method: "POST" });
    assert.deepEqual([s1.stage.key, s2.stage.key], ["zoom_out", "comprehension"]);
    await ctx.restart();
    const resumed = await ok(base + "/review/rounds", { method: "POST" });
    assert.equal(resumed.resumed, true);
    assert.equal(resumed.run.id, run.id);
    const s3 = await ok(`${base}/review/rounds/${run.id}/next`, { method: "POST" });
    assert.equal(s3.stage.key, "critic");
    const sqlite = db();
    const order = sqlite.prepare("SELECT stage, sequence FROM idea_review_stage_results WHERE run_id=? ORDER BY sequence").all(run.id).map((row) => row.stage + ":" + row.sequence);
    sqlite.close();
    assert.deepEqual(order, ["zoom_out:1", "comprehension:2", "critic:3"]);
  });
});

test("resolution rules: evidence for contests, no contesting comprehension gaps, facts for escalations", async () => {
  await withWorkflow(async (ctx) => {
    const { ok, call } = ctx;
    const { base } = await brainstormReady(ctx, "RULES");
    await ok(base + "/brainstorm", { method: "POST" });
    await draftAll(ctx, base);
    await ok(base + "/draft/finalize", { method: "POST", body: {} });
    await runRound(ctx, base);
    const findings = (await ok(base + "/workflow")).findings;
    const byReviewer = (name) => findings.find((item) => item.lens.includes(name));
    assert.equal(byReviewer("Comprehension").category, "propose_fix", "a comprehension gap cannot be contested");
    assert.equal(byReviewer("Design Critic").category, "escalate", "a contest without evidence becomes an escalation");
    assert.equal(byReviewer("Zoom Out").category, "contest");
    const escalation = byReviewer("Design Critic");
    assert.equal((await call(`${base}/findings/${escalation.id}`, { method: "PATCH", body: { decision: "add_fact" } })).status, 400);
    assert.equal((await call(`${base}/findings/${escalation.id}`, { method: "PATCH", body: { decision: "accept" } })).status, 400, "decisions must match the category");
    await ok(`${base}/findings/${escalation.id}`, { method: "PATCH", body: { decision: "add_fact", note: "Peak load is 20 users." } });
    await ok(`${base}/findings/${byReviewer("Zoom Out").id}`, { method: "PATCH", body: { decision: "agree" } });
    await ok(`${base}/findings/${byReviewer("Comprehension").id}`, { method: "PATCH", body: { decision: "accept" } });
    const after = (await ok(base + "/workflow")).findings;
    assert.equal(after.find((item) => item.lens.includes("Zoom Out")).settled, 1);
    const applied = await ok(base + "/resolve", { method: "POST" });
    assert.equal(applied.applied, 2);
    // The contested finding stays settled when the same reviewer raises it again.
    await runRound(ctx, base);
    const next = (await ok(base + "/workflow")).findings;
    const repeat = next.find((item) => item.lens.includes("Zoom Out"));
    assert.equal(repeat.settled, 1);
    assert.equal(repeat.status, "contested");
  }, {
    reviewFindings: (persona) => ({
      comprehension: [{ severity: "Major", title: "Undefined term planner", affected_scope: "Overview", description: "Planner is not defined.", rationale: "Define it." }],
      design_critic: [{ severity: "Major", title: "Load unknown", affected_scope: "Technical Plan", description: "No load estimate.", rationale: "Estimate load." }],
      zoom_out: [{ severity: "Major", title: "Queue is unnecessary", affected_scope: "Technical Plan", description: "A queue is proposed.", rationale: "Remove it." }],
    }[persona] || []),
    classify: (id) => (id.startsWith("comprehension") ? { category: "contest", justification: "It is defined.", evidence: "Overview line 3", proposed_edit: "" }
      : id.startsWith("design_critic") ? { category: "contest", justification: "Intentional.", evidence: "", proposed_edit: "" }
        : id.startsWith("zoom_out") ? { category: "contest", justification: "There is no queue.", evidence: "Technical Plan, line 18: no queue is described.", proposed_edit: "" }
          : { category: "propose_fix", justification: "Agreed.", evidence: "", proposed_edit: "Fix." }),
  });
});

test("findings are classified in batches small enough for limited model accounts", async () => {
  await withWorkflow(async (ctx) => {
    const { ok, model } = ctx;
    const { base } = await brainstormReady(ctx, "BATCH");
    await ok(base + "/brainstorm", { method: "POST" });
    await draftAll(ctx, base);
    await ok(base + "/draft/finalize", { method: "POST", body: {} });
    await runRound(ctx, base);
    assert.equal(model.counts.review_classification, 2, "ten findings take two batches of at most eight");
    const findings = (await ok(base + "/workflow")).findings;
    assert.equal(findings.length, 10);
    assert.ok(findings.every((finding) => finding.category === "propose_fix"));
  }, {
    reviewFindings: (persona) => (persona === "design_critic" ? ["Rollback", "Retention", "Quotas", "Ownership", "Monitoring", "Backups", "Encryption", "Latency", "Pagination", "Auditing"].map((topic) => ({ severity: "Major", title: topic + " undefined entirely", affected_scope: topic + " section", description: topic + " is missing.", rationale: "Add it." })) : []),
  });
});

test("returning to drafting starts a fresh review loop", async () => {
  await withWorkflow(async (ctx) => {
    const { ok } = ctx;
    const { base } = await brainstormReady(ctx, "LOOP");
    await ok(base + "/brainstorm", { method: "POST" });
    await draftAll(ctx, base);
    await ok(base + "/draft/finalize", { method: "POST", body: {} });
    const first = await runRound(ctx, base);
    assert.equal(first.round, 1);
    await ok(base + "/convergence", { method: "POST", body: { choice: "redraft" } });
    const workflow = await ok(base + "/workflow");
    assert.equal(workflow.egm.state, "drafting");
    assert.ok(workflow.egm.draft.every((section) => section.status === "draft"), "sections need approval again");
    for (const key of ["overview", "technical_plan", "alternatives", "implementation"]) await ok(`${base}/draft/sections/${key}/approve`, { method: "POST" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await ok(base + "/draft/finalize", { method: "POST", body: {} });
    assert.equal(second.artifact.parent_artifact_id, null, "a re-finalized draft is a new loop root");
    const next = await runRound(ctx, base);
    assert.equal(next.round, 1, "the round count restarts for the new draft");
  });
});

test("the round cap asks the author how to proceed", async () => {
  await withWorkflow(async (ctx) => {
    const { ok, call, db } = ctx;
    const { projectId, base } = await brainstormReady(ctx, "CAP");
    await ok(base + "/brainstorm", { method: "POST" });
    await draftAll(ctx, base);
    await ok(base + "/draft/finalize", { method: "POST", body: {} });
    for (let round = 1; round <= 5; round += 1) {
      await runRound(ctx, base);
      const findings = (await ok(base + "/workflow")).findings.filter((item) => item.status === "open");
      for (const item of findings) await ok(`${base}/findings/${item.id}`, { method: "PATCH", body: { decision: "skip" } });
    }
    const capped = await call(base + "/review/rounds", { method: "POST" });
    assert.equal(capped.status, 409);
    assert.equal(capped.body.needs_decision, "cap");
    assert.equal((await ok(base + "/workflow")).egm.review.needs_decision, "cap");
    await ok(base + "/convergence", { method: "POST", body: { choice: "continue" } });
    await runRound(ctx, base);
    await ok(base + "/convergence", { method: "POST", body: { choice: "accept" } });
    await ok(base + "/approve", { method: "POST", body: {} });
    const sqlite = db();
    assert.equal(sqlite.prepare("SELECT workflow_state FROM idea_sessions WHERE project_id=?").get(projectId).workflow_state, "approved");
    sqlite.close();
  }, {
    // Every round raises a fresh Major issue, so the loop never converges.
    reviewFindings: (() => {
      const issues = ["Missing rollback plan", "Undefined retention policy", "Absent rate limits", "Unclear ownership model", "Monitoring omitted entirely", "Backups never mentioned", "Quota handling vague"];
      let n = 0;
      return (persona) => (persona === "structural" ? [{ severity: "Major", title: issues[n++ % issues.length], affected_scope: "Section " + n, description: "Missing piece " + n + ".", rationale: "Add it." }] : []);
    })(),
  });
});
