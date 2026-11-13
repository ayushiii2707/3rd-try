// Elephant–Goldfish Model workflow engine.
//
// Elephant: the persistent planner. It sees the discovery conversation and
// memory, writes the concepts brief and design doc, and answers findings.
// Goldfish: fresh reviewers. Each one is a separate, stateless model request
// built only from an allowlist (persona, target document, approved reference
// material). A private marker that exists only in Elephant context is checked
// against every Goldfish request before it is sent.
//
// Every model call runs through the durable execution records in
// idea-execution.js: idempotent enqueue, claimed attempts, one retry, and the
// exact input hash. A reviewer that fails twice is recorded as "not run".

import { aiComplete, aiConfig, parseJsonContent } from './ai.js';
import {
  canonicalJson, claimIdeaExecution, enqueueIdeaExecution,
  finishIdeaExecution, sha256,
} from './idea-execution.js';
import {
  BRAINSTORM_LENSES, DESIGN_DOC_STANDARD, DRAFT_SECTIONS, PERSONAS, PERSONA_VERSION,
  REVIEW_STAGES, SYNTHESIZER_PROMPT, goldfishSystemPrompt,
} from './egm-personas.js';

const PROMPT_VERSION = 'egm-v1';
const MAX_ROUNDS = 5;
const CLEAN_ROUNDS_TO_CONVERGE = 2;
const SEVERITIES = ['Blocker', 'Major', 'Nit'];
const CATEGORIES = ['propose_fix', 'contest', 'escalate', 'decline'];

export class EgmError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

class IsolationError extends Error {}

const now = () => new Date().toISOString();
const clean = (value, max = 4000) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
const parseJson = (value, fallback) => { try { return JSON.parse(value); } catch { return fallback; } };

// ---------- context ----------

async function sessionRow(env, projectId) {
  return env.DB.prepare('SELECT * FROM idea_sessions WHERE project_id=?').bind(projectId).first();
}

async function canaryFor(env, projectId) {
  const row = await sessionRow(env, projectId);
  if (row?.egm_canary) return row.egm_canary;
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  const canary = 'EGM-PRIVATE-' + [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  await env.DB.prepare('UPDATE idea_sessions SET egm_canary=COALESCE(egm_canary,?) WHERE project_id=?').bind(canary, projectId).run();
  return (await sessionRow(env, projectId))?.egm_canary || canary;
}

async function setState(env, projectId, state) {
  return env.DB.prepare('UPDATE idea_sessions SET workflow_state=?,state_version=state_version+1,updated_at=? WHERE project_id=?').bind(state, now(), projectId);
}

function elephantSystem(canary, task) {
  return `You are Elephant, the persistent planning agent. You remember the whole discovery conversation and write the planning artifacts.
Execution constraints: stress-test ideas by default; no praise or flattery; critique first and generate counter-arguments; plain, specific language; never invent facts the user has not given; preserve uncertainty as open questions.
Private session marker: ${canary}. It is confidential. Never write it in any output.
EGM-TASK: ${task}`;
}

async function elephantContext(env, projectId) {
  const [messages, memory, session] = await Promise.all([
    env.DB.prepare('SELECT role,content,hypothesis FROM idea_messages WHERE project_id=? ORDER BY created_at').bind(projectId).all(),
    env.DB.prepare('SELECT memory_json FROM idea_memory WHERE project_id=?').bind(projectId).first(),
    sessionRow(env, projectId),
  ]);
  const transcript = messages.results.slice(-60).map((item) => (item.role === 'user' ? 'USER: ' : 'ELEPHANT: ') + item.content).join('\n\n');
  return { title: session?.title || 'Idea', transcript, memory: memory?.memory_json || '{}', count: messages.results.length };
}

async function latestArtifact(env, projectId, kind) {
  return env.DB.prepare('SELECT * FROM idea_artifacts WHERE project_id=? AND kind=? ORDER BY version DESC LIMIT 1').bind(projectId, kind).first();
}

// ---------- durable model step ----------

function assertIsolated(messages, canary) {
  if (canary && JSON.stringify(messages).includes(canary)) {
    throw new IsolationError('Isolation check failed: Elephant-private context reached a Goldfish request.');
  }
}

async function succeededResult(env, executionId) {
  const row = await env.DB.prepare("SELECT result_json FROM idea_execution_attempts WHERE execution_id=? AND status='succeeded' ORDER BY attempt_no DESC LIMIT 1").bind(executionId).first();
  return row ? parseJson(row.result_json, null) : null;
}

// Runs one model call durably. Returns { result } on success or { failed, error }
// after the single retry is exhausted. Re-running the same inputs reuses the
// stored result instead of calling the model again.
async function runStep(env, step) {
  const config = aiConfig(env);
  const { projectId, role, operation, scope, persona = role, messages, canary } = step;
  const inputSha256 = await sha256({ messages });
  const manifest = [...(step.manifest || [])];
  if (role === 'goldfish') {
    try {
      assertIsolated(messages, canary);
    } catch (error) {
      return { failed: true, error: error.message, code: 'ISOLATION_CHECK_FAILED' };
    }
    manifest.push({ kind: 'isolation_check', elephant_marker_absent: true, marker_sha256: (await sha256(canary || '')).slice(0, 16) });
  }
  const baseKey = `${operation}:${scope}:${persona}:${inputSha256.slice(0, 24)}`;
  const failedGroups = await env.DB.prepare("SELECT COUNT(*) AS count FROM idea_executions WHERE project_id=? AND idempotency_key LIKE ? AND status='failed'").bind(projectId, baseKey + ':%').first();
  const idempotencyKey = `${baseKey}:${Number(failedGroups?.count || 0)}`;
  const { execution } = await enqueueIdeaExecution(env.DB, {
    projectId, idempotencyKey, agentRole: role, operation, reviewStage: step.stage || null,
    reviewRunId: step.runId || null, artifactId: step.artifactId || null,
    provider: config.provider, model: config.model, adapterVersion: 'openai-compatible-v1',
    promptVersion: PROMPT_VERSION, personaVersion: `${PERSONA_VERSION}:${persona}`,
    inputManifest: manifest, inputSha256, actorType: step.actorId ? 'user' : 'system', actorId: step.actorId, maxAttempts: 2,
  });
  if (execution.status === 'succeeded') return { result: await succeededResult(env, execution.id), executionId: execution.id, reused: true };
  let lastError = execution.error_message || 'The step failed.';
  for (;;) {
    const claim = await claimIdeaExecution(env.DB, { executionId: execution.id, workerId: `egm:${operation}:${persona}`, leaseSeconds: 300 });
    if (!claim.claimed) {
      if (claim.execution?.status === 'succeeded') return { result: await succeededResult(env, execution.id), executionId: execution.id, reused: true };
      if (claim.reason === 'attempts_exhausted' || claim.execution?.status === 'failed') return { failed: true, error: lastError, executionId: execution.id };
      throw new EgmError(409, 'This step is already running. Refresh in a moment.');
    }
    const attemptNo = Number(claim.execution.attempt_count);
    try {
      const response = await aiComplete(env, messages, { json: Boolean(step.json) });
      if (role === 'elephant' && canary && response.content.includes(canary)) throw Error('Elephant output contained the private session marker.');
      const parsed = step.json ? parseJsonContent(response.content) : response.content;
      const result = step.validate ? step.validate(parsed) : parsed;
      const outputSha256 = await sha256(result);
      await finishIdeaExecution(env.DB, { executionId: execution.id, leaseToken: claim.lease_token, attemptNo, succeeded: true, result, outputSha256, usage: response.usage || undefined });
      return { result, executionId: execution.id, reused: false };
    } catch (error) {
      lastError = error instanceof Error ? error.message : 'The step failed.';
      const finished = await finishIdeaExecution(env.DB, { executionId: execution.id, leaseToken: claim.lease_token, attemptNo, succeeded: false, errorCode: 'STEP_FAILED', errorMessage: lastError, retryable: true });
      if (finished.execution?.status !== 'queued') return { failed: true, error: lastError, executionId: execution.id };
    }
  }
}

// ---------- normalizers ----------

function normalizeSeverity(value, max) {
  const severity = SEVERITIES.find((item) => item.toLowerCase() === String(value || '').trim().toLowerCase()) || 'Major';
  if (max && SEVERITIES.indexOf(severity) < SEVERITIES.indexOf(max)) return max;
  return severity;
}

function normalizeLens(personaKey) {
  return (parsed) => {
    if (!parsed || !Array.isArray(parsed.issues)) throw Error('The lens report was not in the expected format.');
    return {
      summary: clean(parsed.summary, 1000),
      issues: parsed.issues.slice(0, 15).map((item) => ({
        severity: normalizeSeverity(item.severity),
        title: clean(item.title, 200),
        risk: clean(item.risk, 2000),
        requirement: clean(item.requirement, 1500),
      })).filter((item) => item.title && item.risk),
      persona: personaKey,
    };
  };
}

function normalizeReview(personaKey) {
  const persona = PERSONAS[personaKey];
  return (parsed) => {
    if (!parsed || !Array.isArray(parsed.findings)) throw Error('The reviewer report was not in the expected format.');
    const result = {
      summary: clean(parsed.summary, 1000),
      findings: parsed.findings.slice(0, 20).map((item) => ({
        severity: normalizeSeverity(item.severity, persona.maxSeverity),
        title: clean(item.title, 200),
        affected_scope: clean(item.affected_scope, 300),
        description: clean(item.description, 3000),
        rationale: clean(item.rationale, 2500),
      })).filter((item) => item.title && item.description),
    };
    if (persona.paraphrase) {
      result.what_this_proposes = clean(parsed.what_this_proposes, 1500);
      result.how_existing_system_works = clean(parsed.how_existing_system_works, 1500);
      if (!result.what_this_proposes || !result.how_existing_system_works) throw Error('The comprehension report is missing its paraphrase.');
    }
    return result;
  };
}

function requireMarkdown(minLength = 40) {
  return (content) => {
    const text = String(content || '').trim();
    if (text.length < minLength) throw Error('The model returned an empty document.');
    return text.replace(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/i, '$1').trim();
  };
}

// ---------- brainstorm ----------

const LENS_STATUS = (key, outcome) => ({
  persona: key, lens: PERSONAS[key].brainstorm.lens,
  status: outcome.failed ? 'not run' : 'completed',
  error: outcome.failed ? outcome.error : undefined,
  execution_id: outcome.executionId || null,
  result: outcome.failed ? null : outcome.result,
});

export async function runBrainstorm(env, projectId, { actorId, authorName }) {
  const context = await elephantContext(env, projectId);
  if (!context.count) throw new EgmError(400, 'Start thinking with Elephant before running the Goldfish brainstorm.');
  const canary = await canaryFor(env, projectId);
  const hypothesis = await runStep(env, {
    projectId, role: 'elephant', operation: 'brainstorm_hypothesis', scope: 'session', actorId, canary,
    manifest: [{ kind: 'idea_messages', count: context.count }, { kind: 'idea_memory' }],
    messages: [
      { role: 'system', content: elephantSystem(canary, 'brainstorm_hypothesis') },
      { role: 'user', content: `Write the anchored hypothesis for this idea in Markdown with these sections: Working Hypothesis, Problem, Target Users, Desired Outcomes, Constraints, Assumptions, Open Questions. Use only what the discussion and memory establish.\n\nIDEA: ${context.title}\n\nDISCOVERY CONVERSATION:\n${context.transcript}\n\nELEPHANT MEMORY:\n${context.memory}` },
    ],
    validate: requireMarkdown(),
  });
  if (hypothesis.failed) throw new EgmError(503, 'Elephant could not prepare the hypothesis: ' + hypothesis.error);
  const hypothesisText = hypothesis.result;
  const hypothesisSha = await sha256(hypothesisText);
  const lensOutcomes = await Promise.all(BRAINSTORM_LENSES.map((key) => runStep(env, {
    projectId, role: 'goldfish', operation: 'brainstorm_lens', scope: hypothesisSha.slice(0, 24), persona: key, canary,
    manifest: [{ kind: 'anchored_hypothesis', sha256: hypothesisSha }], json: true,
    messages: [
      { role: 'system', content: goldfishSystemPrompt(key, 'brainstorm') },
      { role: 'user', content: 'ANCHORED HYPOTHESIS:\n' + hypothesisText },
    ],
    validate: normalizeLens(key),
  })));
  const lenses = BRAINSTORM_LENSES.map((key, index) => LENS_STATUS(key, lensOutcomes[index]));
  const completed = lenses.filter((lens) => lens.status === 'completed');
  if (!completed.length) throw new EgmError(503, 'No Goldfish lens could run. Check the AI configuration and retry.', { lenses });
  const reports = lenses.map((lens) => `### ${lens.lens} (${lens.status})\n` + (lens.result ? `${lens.result.summary}\n` + lens.result.issues.map((issue) => `- [${issue.severity}] ${issue.title}: ${issue.risk} Requirement: ${issue.requirement}`).join('\n') : 'Not run; no findings recorded.')).join('\n\n');
  const synthesis = await runStep(env, {
    projectId, role: 'goldfish', operation: 'brainstorm_synthesis', scope: hypothesisSha.slice(0, 24), persona: 'synthesizer', canary, json: true,
    manifest: [{ kind: 'anchored_hypothesis', sha256: hypothesisSha }, { kind: 'lens_reports', completed: completed.length, not_run: lenses.length - completed.length }],
    messages: [
      { role: 'system', content: SYNTHESIZER_PROMPT },
      { role: 'user', content: `ANCHORED HYPOTHESIS:\n${hypothesisText}\n\nLENS REPORTS:\n${reports}` },
    ],
    validate: (parsed) => {
      const brief = clean(parsed?.brief_markdown, 60000);
      if (!/alternatives weighed/i.test(brief) || !/goals/i.test(brief)) throw Error('The concepts brief is missing required sections.');
      return { brief_markdown: brief, objections: (Array.isArray(parsed.objections) ? parsed.objections : []).map((item) => clean(String(item), 500)).filter(Boolean).slice(0, 3) };
    },
  });
  if (synthesis.failed) throw new EgmError(503, 'The synthesizer could not write the concepts brief: ' + synthesis.error);
  const at = now();
  const roundRow = await env.DB.prepare('SELECT MAX(round) AS round FROM idea_brainstorm_rounds WHERE project_id=?').bind(projectId).first();
  const round = Number(roundRow?.round || 0) + 1;
  const content = `# ${context.title} — Concepts Brief\n\n**Author:** ${authorName} · **Date:** ${at.slice(0, 10)}\n\n${synthesis.result.brief_markdown}\n`;
  const artifact = await artifactInsert(env, projectId, 'concept_brief', `${context.title} — concepts_brief.md`, content, {
    status: 'draft', manifest: [{ kind: 'brainstorm_round', round }, { kind: 'anchored_hypothesis', sha256: hypothesisSha }, ...lenses.map((lens) => ({ kind: 'lens', persona: lens.persona, status: lens.status }))],
  });
  const roundId = crypto.randomUUID();
  const storedLenses = lenses.map(({ result, ...lens }) => ({ ...lens, summary: result?.summary || '', issues: result?.issues || [] }));
  await env.DB.batch([
    artifact.statement,
    env.DB.prepare('INSERT INTO idea_brainstorm_rounds(id,project_id,round,hypothesis,hypothesis_sha256,status,lens_results_json,objections_json,brief_artifact_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .bind(roundId, projectId, round, hypothesisText, hypothesisSha, 'complete', JSON.stringify(storedLenses), JSON.stringify(synthesis.result.objections), artifact.artifact.id, at),
    await setState(env, projectId, 'brief_ready'),
  ]);
  return { round, artifact: artifact.artifact, lenses: storedLenses, objections: synthesis.result.objections };
}

// ---------- artifacts ----------

async function artifactInsert(env, projectId, kind, title, content, { parentId = null, status = 'draft', manifest = [] } = {}) {
  const versionRow = await env.DB.prepare('SELECT MAX(version) AS version FROM idea_artifacts WHERE project_id=? AND kind=?').bind(projectId, kind).first();
  const id = crypto.randomUUID(), version = Number(versionRow?.version || 0) + 1, at = now(), contentSha256 = await sha256(content);
  return {
    statement: env.DB.prepare('INSERT INTO idea_artifacts(id,project_id,kind,version,status,title,content,parent_artifact_id,content_sha256,prompt_version,source_manifest_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .bind(id, projectId, kind, version, status, title, content, parentId, contentSha256, PROMPT_VERSION, canonicalJson(manifest), at, at),
    artifact: { id, project_id: projectId, kind, version, status, title, content, parent_artifact_id: parentId, content_sha256: contentSha256, created_at: at, updated_at: at },
  };
}

// ---------- draft ----------

async function latestSections(env, projectId) {
  const rows = await env.DB.prepare('SELECT * FROM idea_draft_sections WHERE project_id=? ORDER BY version DESC').bind(projectId).all();
  return Object.fromEntries(DRAFT_SECTIONS.map((section) => [section.key, rows.results.find((row) => row.section_key === section.key) || null]));
}

export async function generateSection(env, projectId, key, { feedback = '', actorId }) {
  const index = DRAFT_SECTIONS.findIndex((section) => section.key === key);
  if (index < 0) throw new EgmError(404, 'Unknown design doc section.');
  const brief = await latestArtifact(env, projectId, 'concept_brief');
  if (!brief) throw new EgmError(400, 'Run the Goldfish brainstorm to create the concepts brief before drafting.');
  const sections = await latestSections(env, projectId);
  const earlier = DRAFT_SECTIONS.slice(0, index);
  const unapproved = earlier.find((section) => sections[section.key]?.status !== 'approved');
  if (unapproved) throw new EgmError(400, `Approve the ${unapproved.title} section first.`);
  const current = sections[key];
  const context = await elephantContext(env, projectId);
  const canary = await canaryFor(env, projectId);
  const nextVersion = Number(current?.version || 0) + 1;
  const note = clean(feedback, 3000);
  const approvedText = earlier.map((section) => sections[section.key].content).join('\n\n');
  const outcome = await runStep(env, {
    projectId, role: 'elephant', operation: 'draft_section', scope: `${key}:v${nextVersion}`, actorId, canary, artifactId: brief.id,
    manifest: [{ kind: 'concept_brief', artifact_id: brief.id, sha256: brief.content_sha256 }, { kind: 'approved_sections', keys: earlier.map((section) => section.key) }],
    messages: [
      { role: 'system', content: elephantSystem(canary, 'draft_section:' + key) },
      { role: 'user', content: `You are drafting a design document one section at a time.\nTASK: ${DRAFT_SECTIONS[index].instructions}\nHARD LENGTH LIMIT: at most ${DRAFT_SECTIONS[index].words} words in total. Prefer short bullet points over prose; no repetition.\nReturn only the Markdown for this part. Do not repeat earlier sections. Do not write implementation code.\n\nCONCEPTS BRIEF:\n${brief.content}\n\nAPPROVED EARLIER SECTIONS:\n${approvedText || '(none yet)'}\n\nDISCOVERY CONVERSATION:\n${context.transcript}\n\nELEPHANT MEMORY:\n${context.memory}` + (current ? `\n\nPREVIOUS DRAFT OF THIS SECTION:\n${current.content}` : '') + (note ? `\n\nAUTHOR FEEDBACK TO APPLY:\n${note}` : '') },
    ],
    validate: (content) => {
      const text = requireMarkdown()(content);
      const count = text.split(/\s+/).filter(Boolean).length;
      // Keeps the finished design doc small enough for every Goldfish to review in one request.
      if (count > DRAFT_SECTIONS[index].words * 1.5) throw Error(`The section is ${count} words; the limit is ${DRAFT_SECTIONS[index].words}.`);
      return text;
    },
  });
  if (outcome.failed) throw new EgmError(503, 'Elephant could not draft this section: ' + outcome.error);
  const id = crypto.randomUUID(), at = now();
  await env.DB.batch([
    env.DB.prepare("UPDATE idea_draft_sections SET status='superseded' WHERE project_id=? AND section_key=? AND status!='superseded'").bind(projectId, key),
    env.DB.prepare('INSERT INTO idea_draft_sections(id,project_id,section_key,version,content,status,feedback,brief_artifact_id,execution_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .bind(id, projectId, key, nextVersion, outcome.result, 'draft', note, brief.id, outcome.executionId, at),
    await setState(env, projectId, 'drafting'),
  ]);
  return { section: { id, section_key: key, version: nextVersion, content: outcome.result, status: 'draft', feedback: note, created_at: at } };
}

export async function approveSection(env, projectId, key) {
  const sections = await latestSections(env, projectId);
  const current = sections[key];
  if (!current) throw new EgmError(404, 'Draft this section before approving it.');
  if (current.status === 'approved') return { section: current };
  await env.DB.prepare("UPDATE idea_draft_sections SET status='approved',approved_at=? WHERE id=? AND status='draft'").bind(now(), current.id).run();
  return { section: { ...current, status: 'approved' } };
}

export async function finalizeDraft(env, projectId, { acknowledge = false, actorId, authorName }) {
  const sections = await latestSections(env, projectId);
  const missing = DRAFT_SECTIONS.find((section) => sections[section.key]?.status !== 'approved');
  if (missing) throw new EgmError(400, `Approve every section before finalizing. Next: ${missing.title}.`);
  const brief = await latestArtifact(env, projectId, 'concept_brief');
  const session = await sessionRow(env, projectId);
  const title = session?.title || 'Design';
  const body = DRAFT_SECTIONS.map((section) => sections[section.key].content.trim()).join('\n\n');
  const canary = await canaryFor(env, projectId);
  const reconcile = await runStep(env, {
    projectId, role: 'elephant', operation: 'draft_reconcile', scope: 'finalize', actorId, canary, json: true,
    manifest: [{ kind: 'concept_brief', artifact_id: brief.id }, { kind: 'draft_sections', ids: DRAFT_SECTIONS.map((section) => sections[section.key].id) }],
    messages: [
      { role: 'system', content: elephantSystem(canary, 'draft_reconcile') },
      { role: 'user', content: `Compare the design draft against the concepts brief. List only real contradictions, not omissions of detail. Do not change the draft.\nReturn JSON only: {"contradictions":[{"section":"...","draft_says":"...","brief_says":"..."}]}\n\nCONCEPTS BRIEF:\n${brief.content}\n\nDESIGN DRAFT:\n${body}` },
    ],
    validate: (parsed) => ({ contradictions: (Array.isArray(parsed?.contradictions) ? parsed.contradictions : []).slice(0, 20).map((item) => ({ section: clean(item.section, 200), draft_says: clean(item.draft_says, 1000), brief_says: clean(item.brief_says, 1000) })).filter((item) => item.draft_says || item.brief_says) }),
  });
  if (reconcile.failed) throw new EgmError(503, 'Elephant could not check the draft against the brief: ' + reconcile.error);
  if (reconcile.result.contradictions.length && !acknowledge) return { finalized: false, contradictions: reconcile.result.contradictions };
  const at = now();
  const content = `# ${title}\n\n**Author:** ${authorName} · **Status:** In Review · **Date:** ${at.slice(0, 10)}\n\n${body}\n\n_Drafted with EGM_\n`;
  const artifact = await artifactInsert(env, projectId, 'design_draft', `${title} — design doc`, content, {
    status: 'in_review',
    manifest: [{ kind: 'concept_brief', artifact_id: brief.id }, { kind: 'acknowledged_contradictions', count: reconcile.result.contradictions.length }],
  });
  await env.DB.batch([artifact.statement, await setState(env, projectId, 'draft_ready')]);
  return { finalized: true, artifact: artifact.artifact, contradictions: reconcile.result.contradictions };
}

// ---------- review ----------

function documentRanges(content) {
  const lines = String(content).split('\n');
  const split = lines.findIndex((line) => /^#{1,3}\s+Detailed Implementation Plan\b/i.test(line));
  const numbered = (from, to) => lines.slice(from, to).map((line, index) => `${String(from + index + 1).padStart(4, ' ')}| ${line}`).join('\n');
  return {
    total: lines.length,
    full: { from: 1, to: lines.length, text: numbered(0, lines.length) },
    feature: split > 0 ? { from: 1, to: split, text: numbered(0, split) } : { from: 1, to: lines.length, text: numbered(0, lines.length) },
    detailed: split >= 0 ? { from: split + 1, to: lines.length, text: numbered(split, lines.length) } : { from: 1, to: lines.length, text: numbered(0, lines.length), missing: true },
  };
}

async function loopInfo(env, projectId, session) {
  const root = await env.DB.prepare("SELECT created_at FROM idea_artifacts WHERE project_id=? AND kind='design_draft' AND parent_artifact_id IS NULL ORDER BY version DESC LIMIT 1").bind(projectId).first();
  const loopStart = root?.created_at || '';
  const runs = await env.DB.prepare("SELECT * FROM idea_review_runs WHERE project_id=? AND created_at>=? ORDER BY created_at").bind(projectId, loopStart).all();
  const completed = runs.results.filter((run) => ['complete', 'converged'].includes(run.status));
  const limit = MAX_ROUNDS + Number(session?.cap_extensions || 0);
  const last = completed[completed.length - 1] || null;
  return { loopStart, runs: runs.results, completed, limit, last, running: runs.results.find((run) => run.status === 'running') || null };
}

export async function startRound(env, projectId) {
  const artifact = await latestArtifact(env, projectId, 'design_draft');
  if (!artifact) throw new EgmError(400, 'Finalize the design doc before starting a Goldfish review.');
  const session = await sessionRow(env, projectId);
  if (session?.workflow_state === 'approved') throw new EgmError(409, 'This design is already approved.');
  const loop = await loopInfo(env, projectId, session);
  if (loop.running) return { run: loop.running, resumed: true };
  if (loop.last?.status === 'converged') throw new EgmError(409, 'The review has converged. Give final approval or return to drafting.');
  if (loop.last) {
    const pending = await env.DB.prepare("SELECT COUNT(*) AS count FROM idea_findings WHERE run_id=? AND status='open' AND settled=0 AND severity IN ('Blocker','Major')").bind(loop.last.id).first();
    if (Number(pending?.count)) throw new EgmError(409, 'Decide every Blocker and Major finding before the next round.');
    const accepted = await env.DB.prepare("SELECT COUNT(*) AS count FROM idea_findings WHERE run_id=? AND status='accepted'").bind(loop.last.id).first();
    if (Number(accepted?.count)) throw new EgmError(409, 'Apply the accepted changes before the next round.');
  }
  if (loop.completed.length >= loop.limit) throw new EgmError(409, `The review reached its ${loop.limit}-round limit. Choose how to proceed.`, { needs_decision: 'cap' });
  if (loop.last?.churn && session?.workflow_state !== 'reviewing') throw new EgmError(409, 'The last round reopened issues at the scope of an applied fix. Choose how to proceed.', { needs_decision: 'churn' });
  const id = crypto.randomUUID(), at = now(), round = loop.completed.length + 1;
  await env.DB.batch([
    env.DB.prepare('INSERT INTO idea_review_runs(id,project_id,artifact_id,round,status,clean_rounds,summary,workflow_version,input_artifact_sha256,current_stage,updated_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
      .bind(id, projectId, artifact.id, round, 'running', 0, '', 2, artifact.content_sha256 || await sha256(artifact.content), null, at, at),
    await setState(env, projectId, 'reviewing'),
  ]);
  return { run: { id, round, status: 'running', artifact_id: artifact.id } };
}

async function stageResults(env, runId) {
  const rows = await env.DB.prepare('SELECT * FROM idea_review_stage_results WHERE run_id=? ORDER BY sequence').bind(runId).all();
  return rows.results.map((row) => ({ ...row, result: parseJson(row.result_json, {}) }));
}

function stageReport(stage, reviewers) {
  const lines = [`## ${stage.title} report`, ''];
  for (const reviewer of reviewers) {
    lines.push(`### ${PERSONAS[reviewer.persona].title} — ${reviewer.status}`);
    if (reviewer.status !== 'completed') { lines.push(`Not run: ${reviewer.error || 'no report'}.`, ''); continue; }
    if (reviewer.result.what_this_proposes) {
      lines.push('**What this proposes**', reviewer.result.what_this_proposes, '', '**How the existing system works, per this document**', reviewer.result.how_existing_system_works, '');
    }
    if (!reviewer.result.findings.length) { lines.push(reviewer.result.summary || 'No findings.', ''); continue; }
    if (reviewer.result.summary) lines.push(reviewer.result.summary, '');
    reviewer.result.findings.forEach((finding, index) => lines.push(`${index + 1}. **[${finding.severity}] ${finding.title}** — ${finding.affected_scope || 'whole document'}`, `   ${finding.description}`, `   Rationale: ${finding.rationale}`));
    lines.push('');
  }
  return lines.join('\n');
}

export async function runNextStage(env, projectId, runId, { actorId }) {
  const run = await env.DB.prepare('SELECT * FROM idea_review_runs WHERE id=? AND project_id=?').bind(runId, projectId).first();
  if (!run) throw new EgmError(404, 'Review round not found.');
  if (run.status !== 'running') return { run, done: true };
  const done = await stageResults(env, runId);
  if (done.length >= REVIEW_STAGES.length) return synthesizeRound(env, projectId, run, done, { actorId });
  const stage = REVIEW_STAGES[done.length];
  const artifact = await env.DB.prepare('SELECT * FROM idea_artifacts WHERE id=? AND project_id=?').bind(run.artifact_id, projectId).first();
  const ranges = documentRanges(artifact.content);
  const target = ranges[stage.range];
  const canary = await canaryFor(env, projectId);
  const prior = (stage.priorStages || []).map((key) => done.find((item) => item.stage === key)).filter(Boolean)
    .flatMap((item) => (item.result.reviewers || []).flatMap((reviewer) => (reviewer.result?.findings || []).map((finding) => `- [${finding.severity}] (${PERSONAS[reviewer.persona].title}) ${finding.title} @ ${finding.affected_scope}: ${finding.description}`)));
  const contextBlocks = [];
  if (stage.withStandard) contextBlocks.push(DESIGN_DOC_STANDARD);
  if (stage.priorStages) contextBlocks.push('FINDINGS FROM EARLIER STAGES OF THIS ROUND (allowed context; reassess the whole design in light of them):\n' + (prior.join('\n') || '(none)'));
  if (stage.range === 'detailed' && target.missing) contextBlocks.push('NOTE: The document has no "Detailed Implementation Plan" section, so the whole document is shown.');
  const outcomes = await Promise.all(stage.reviewers.map((persona) => runStep(env, {
    projectId, role: 'goldfish', operation: 'review_reviewer', stage: stage.key, scope: `${runId}:${stage.key}`, persona, runId, artifactId: artifact.id, canary, json: true, actorId,
    manifest: [
      { kind: 'design_doc', artifact_id: artifact.id, version: artifact.version, sha256: artifact.content_sha256, lines: `${target.from}-${target.to}` },
      ...(stage.withStandard ? [{ kind: 'document_standard', name: 'design_doc' }] : []),
      ...(stage.priorStages ? [{ kind: 'prior_stage_findings', stages: stage.priorStages, count: prior.length }] : []),
    ],
    messages: [
      { role: 'system', content: goldfishSystemPrompt(persona, 'review') },
      { role: 'user', content: `TARGET: ${artifact.title}, lines ${target.from}-${target.to} of ${ranges.total}.\n\n${contextBlocks.length ? contextBlocks.join('\n\n') + '\n\n' : ''}DOCUMENT:\n${target.text}` },
    ],
    validate: normalizeReview(persona),
  })));
  const reviewers = stage.reviewers.map((persona, index) => ({
    persona, status: outcomes[index].failed ? 'not run' : 'completed', error: outcomes[index].failed ? outcomes[index].error : undefined,
    execution_id: outcomes[index].executionId || null, result: outcomes[index].failed ? null : outcomes[index].result,
  }));
  // A stage in which no reviewer could run (provider quota, outage, isolation
  // failure) says nothing about the design: record nothing so it can be retried.
  if (reviewers.every((reviewer) => reviewer.status !== 'completed')) {
    throw new EgmError(503, `No reviewer could run in the ${stage.title} stage: ${reviewers[0].error || 'unknown error'} Nothing was recorded; retry this stage.`);
  }
  const report = stageReport(stage, reviewers);
  const resultJson = { reviewers, report_markdown: report, lines: `${target.from}-${target.to}` };
  const at = now();
  const status = 'succeeded';
  await env.DB.batch([
    env.DB.prepare('INSERT INTO idea_review_stage_results(id,run_id,execution_id,stage,sequence,status,result_json,result_sha256,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(run_id,stage) DO NOTHING')
      .bind(crypto.randomUUID(), runId, reviewers[0].execution_id, stage.key, done.length + 1, status, canonicalJson(resultJson), await sha256(resultJson), at, at),
    env.DB.prepare('UPDATE idea_review_runs SET current_stage=?,updated_at=? WHERE id=?').bind(stage.key, at, runId),
  ]);
  return { run: { ...run, current_stage: stage.key }, stage: { key: stage.key, title: stage.title, sequence: done.length + 1, status, reviewers: reviewers.map(({ result, ...reviewer }) => ({ ...reviewer, findings: result?.findings?.length || 0 })), report_markdown: report } };
}

const words = (text) => new Set(String(text || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((word) => word.length > 2));
function similar(a, b) {
  const left = words(a), right = words(b);
  if (!left.size || !right.size) return false;
  const shared = [...left].filter((word) => right.has(word)).length;
  return shared / Math.min(left.size, right.size) >= 0.6;
}
const sameScope = (a, b) => {
  const norm = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return Boolean(norm(a)) && (norm(a) === norm(b) || norm(a).includes(norm(b)) || norm(b).includes(norm(a)));
};

// Merge all stage findings into one deduplicated list with stable ids.
function mergeFindings(stages, round) {
  const merged = [];
  for (const stage of stages) {
    for (const reviewer of stage.result.reviewers || []) {
      for (const finding of reviewer.result?.findings || []) {
        const existing = merged.find((item) => similar(item.title, finding.title) && (sameScope(item.affected_scope, finding.affected_scope) || !item.affected_scope || !finding.affected_scope));
        if (existing) {
          if (!existing.reviewers.includes(reviewer.persona)) existing.reviewers.push(reviewer.persona);
          if (SEVERITIES.indexOf(finding.severity) < SEVERITIES.indexOf(existing.severity)) existing.severity = finding.severity;
          continue;
        }
        merged.push({ ...finding, stage: stage.stage, reviewers: [reviewer.persona] });
      }
    }
  }
  const counters = {};
  for (const finding of merged) {
    const lead = finding.reviewers[0];
    counters[lead] = (counters[lead] || 0) + 1;
    finding.key = `${lead}-${round}-${counters[lead]}`;
  }
  return merged.sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity));
}

async function synthesizeRound(env, projectId, run, stages, { actorId }) {
  const session = await sessionRow(env, projectId);
  const loop = await loopInfo(env, projectId, session);
  const previousRuns = loop.completed.filter((item) => item.id !== run.id);
  const previous = previousRuns[previousRuns.length - 1] || null;
  const priorFindings = previousRuns.length
    ? (await env.DB.prepare(`SELECT * FROM idea_findings WHERE run_id IN (${previousRuns.map(() => '?').join(',')})`).bind(...previousRuns.map((item) => item.id)).all()).results
    : [];
  const fixedLastRound = previous ? priorFindings.filter((item) => item.run_id === previous.id && item.status === 'fixed') : [];
  const findings = mergeFindings(stages, run.round);
  let churn = false;
  for (const finding of findings) {
    const settled = priorFindings.find((item) => item.settled && similar(item.title, finding.title));
    if (settled) { finding.status = settled.status; finding.settled = 1; finding.carried_from = settled.id; continue; }
    const reopened = priorFindings.find((item) => item.status === 'fixed' && similar(item.title, finding.title) && sameScope(item.affected_scope, finding.affected_scope));
    if (reopened) finding.carried_from = reopened.id;
    if (['Blocker', 'Major'].includes(finding.severity) && fixedLastRound.some((item) => sameScope(item.affected_scope, finding.affected_scope))) churn = true;
    finding.status = 'open';
    finding.settled = 0;
  }
  const reviewerStatus = stages.flatMap((stage) => (stage.result.reviewers || []).map((reviewer) => ({ stage: stage.stage, persona: reviewer.persona, reviewer: PERSONAS[reviewer.persona].title, status: reviewer.status })));
  const allRan = reviewerStatus.every((item) => item.status === 'completed');
  const isClean = allRan && !findings.some((finding) => ['Blocker', 'Major'].includes(finding.severity) && !finding.settled);
  const cleanRounds = isClean ? Number(previous?.clean_rounds || 0) + 1 : 0;
  const status = cleanRounds >= CLEAN_ROUNDS_TO_CONVERGE ? 'converged' : 'complete';
  const artifact = await env.DB.prepare('SELECT title,version FROM idea_artifacts WHERE id=?').bind(run.artifact_id).first();
  const counts = Object.fromEntries(SEVERITIES.map((severity) => [severity, findings.filter((finding) => finding.severity === severity).length]));
  const report = [
    '# Goldfish Review Report', '',
    `**Target:** ${artifact.title} (version ${artifact.version}) · **Round:** ${run.round} · **Result:** ${isClean ? 'clean' : 'not clean'}${churn ? ' · churn detected' : ''}`, '',
    '## Reviewer Status', '', '| Stage | Reviewer | Status |', '| --- | --- | --- |',
    ...reviewerStatus.map((item) => `| ${REVIEW_STAGES.find((stage) => stage.key === item.stage).title} | ${item.reviewer} | ${item.status} |`), '',
    `## Prioritized Findings (Blockers -> Major -> Nits)`, '', `🔴 ${counts.Blocker} Blocker · 🟡 ${counts.Major} Major · 🟢 ${counts.Nit} Nit`, '',
    ...findings.flatMap((finding) => [
      `### [${finding.key}] ${finding.title} - Severity: ${finding.severity}${finding.settled ? ' (settled earlier)' : ''}`,
      `- **Reviewer Lens:** ${finding.reviewers.map((key) => PERSONAS[key].title).join(', ')}`,
      `- **Affected Scope:** ${finding.affected_scope || 'whole document'}`,
      `- **Discrepancy Description:** ${finding.description}`,
      `- **Rationale & Recommendation:** ${finding.rationale}`, '',
    ]),
    '## Stage Reports', '', ...stages.map((stage) => stage.result.report_markdown),
  ].join('\n');
  const at = now();
  // A per-request token makes the findings insert conditional on this request
  // having completed the run, so concurrent synthesis cannot duplicate findings.
  const token = 'synthesis:' + crypto.randomUUID();
  const nextState = status === 'converged' ? 'converged' : findings.some((finding) => !finding.settled) ? 'resolving' : 'review_clean';
  const [completedRun] = await env.DB.batch([
    env.DB.prepare('UPDATE idea_review_runs SET status=?,clean=?,clean_rounds=?,churn=?,reviewer_status_json=?,report_markdown=?,summary=?,current_stage=?,completed_at=?,updated_at=? WHERE id=? AND status=?')
      .bind(status, isClean ? 1 : 0, cleanRounds, churn ? 1 : 0, JSON.stringify(reviewerStatus), report, `${counts.Blocker} Blocker, ${counts.Major} Major, ${counts.Nit} Nit`, token, at, at, run.id, 'running'),
    ...findings.map((finding) => env.DB.prepare('INSERT INTO idea_findings(id,run_id,project_id,lens,severity,title,detail,recommendation,status,created_at,artifact_id,review_stage,finding_key,affected_scope,reviewers_json,settled,carried_from,updated_at) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM idea_review_runs WHERE id=? AND current_stage=?)')
      .bind(crypto.randomUUID(), run.id, projectId, finding.reviewers.map((key) => PERSONAS[key].title).join(', '), finding.severity, finding.title, finding.description, finding.rationale, finding.status, at, run.artifact_id, finding.stage, finding.key, finding.affected_scope, JSON.stringify(finding.reviewers), finding.settled, finding.carried_from || null, at, run.id, token)),
    await setState(env, projectId, nextState),
  ]);
  if (!Number(completedRun?.meta?.changes)) return { run: await env.DB.prepare('SELECT * FROM idea_review_runs WHERE id=?').bind(run.id).first(), synthesized: false };
  const toClassify = findings.filter((finding) => !finding.settled).length;
  return { run: { ...run, status, clean: isClean, clean_rounds: cleanRounds, churn }, synthesized: true, findings: findings.length, to_classify: toClassify };
}

// Elephant proposes one category per open finding, with evidence rules applied.
// Findings are classified in small batches (one request each) so every request
// stays within provider per-minute token limits; callers repeat until none remain.
const CLASSIFY_BATCH = 8;
export async function classifyFindings(env, projectId, runId, { actorId } = {}) {
  const run = await env.DB.prepare('SELECT * FROM idea_review_runs WHERE id=? AND project_id=?').bind(runId, projectId).first();
  if (!run) throw new EgmError(404, 'Review round not found.');
  const pending = (await env.DB.prepare("SELECT * FROM idea_findings WHERE run_id=? AND settled=0 AND category IS NULL ORDER BY CASE severity WHEN 'Blocker' THEN 0 WHEN 'Major' THEN 1 ELSE 2 END, finding_key").bind(runId).all()).results;
  if (!pending.length) return { classified: 0, remaining: 0 };
  const open = pending.slice(0, CLASSIFY_BATCH);
  const artifact = await env.DB.prepare('SELECT * FROM idea_artifacts WHERE id=?').bind(run.artifact_id).first();
  const context = await elephantContext(env, projectId);
  const canary = await canaryFor(env, projectId);
  const list = open.map((item) => ({ id: item.finding_key, severity: item.severity, reviewers: item.lens, scope: item.affected_scope, description: item.detail, rationale: item.recommendation }));
  const outcome = await runStep(env, {
    projectId, role: 'elephant', operation: 'review_classification', scope: `${runId}:${(await sha256(open.map((item) => item.finding_key))).slice(0, 16)}`, actorId, canary, json: true, runId, artifactId: artifact.id,
    manifest: [{ kind: 'design_doc', artifact_id: artifact.id }, { kind: 'findings', count: list.length }],
    messages: [
      { role: 'system', content: elephantSystem(canary, 'review_classification') },
      { role: 'user', content: `Categorize each Goldfish finding with exactly one category:
- propose_fix: you agree; give the exact proposed edit.
- contest: the reviewer is wrong; cite checkable evidence the reviewer could read (a line or section of the document). "This was intentional" is not evidence. Never contest a comprehension gap: if a fresh reader could not understand it, propose a fix.
- escalate: resolving it needs a fact only the author has; say which fact.
- decline: real but not worth changing (usually a Nit); say why.
Do not change any severity. Do not add context only to satisfy a reviewer.
Return JSON only: {"items":[{"id":"finding id","category":"propose_fix|contest|escalate|decline","justification":"...","evidence":"...","proposed_edit":"..."}]}

FINDINGS:\n${JSON.stringify(list, null, 1)}\n\nDESIGN DOC:\n${documentRanges(artifact.content).full.text}\n\nDISCOVERY MEMORY:\n${context.memory}` },
    ],
    validate: (parsed) => ({ items: (Array.isArray(parsed?.items) ? parsed.items : []).map((item) => ({ id: clean(item.id, 100), category: CATEGORIES.includes(item.category) ? item.category : 'escalate', justification: clean(item.justification, 2000), evidence: clean(item.evidence, 2000), proposed_edit: clean(item.proposed_edit, 6000) })) }),
  });
  if (outcome.failed) return { classified: 0, remaining: pending.length, error: outcome.error };
  const at = now();
  const statements = [];
  for (const finding of open) {
    const item = outcome.result.items.find((entry) => entry.id === finding.finding_key);
    if (!item) continue;
    let category = item.category;
    const comprehension = JSON.parse(finding.reviewers_json || '[]').includes('comprehension');
    if (category === 'contest' && comprehension) category = 'propose_fix';
    else if (category === 'contest' && !item.evidence) category = 'escalate';
    statements.push(env.DB.prepare('UPDATE idea_findings SET category=?,elephant_justification=?,evidence_json=?,proposed_edit=?,updated_at=?,row_version=row_version+1 WHERE id=? AND category IS NULL')
      .bind(category, item.justification, JSON.stringify(item.evidence ? [item.evidence] : []), item.proposed_edit, at, finding.id));
  }
  if (statements.length) await env.DB.batch(statements);
  return { classified: statements.length, remaining: pending.length - statements.length };
}

// ---------- resolution ----------

// Human decisions per Elephant category, following the upstream resolution gate.
const DECISIONS = {
  propose_fix: { accept: 'accepted', skip: 'declined' },
  contest: { agree: 'contested', overrule: 'accepted' },
  escalate: { confirm: 'escalated', add_fact: 'accepted' },
  decline: { accept_decline: 'declined', overrule: 'accepted' },
  uncategorized: { accept: 'accepted', skip: 'declined' },
};
const SETTLED_STATUSES = new Set(['contested', 'declined', 'escalated']);

export async function decideFinding(env, projectId, findingId, { decision, note = '', actorId }) {
  const finding = await env.DB.prepare('SELECT f.*, r.status AS run_status FROM idea_findings f JOIN idea_review_runs r ON r.id=f.run_id WHERE f.id=? AND f.project_id=?').bind(findingId, projectId).first();
  if (!finding) throw new EgmError(404, 'Finding not found.');
  if (finding.status === 'fixed') throw new EgmError(409, 'This finding was already applied.');
  const latest = await env.DB.prepare("SELECT id FROM idea_review_runs WHERE project_id=? AND status IN ('complete','converged') ORDER BY created_at DESC LIMIT 1").bind(projectId).first();
  if (latest?.id !== finding.run_id) throw new EgmError(409, 'Only findings from the latest review round can be decided.');
  const options = DECISIONS[finding.category || 'uncategorized'];
  let status;
  if (decision === 'reopen') status = 'open';
  else status = options[decision];
  if (!status) throw new EgmError(400, `Choose one of: ${Object.keys(options).join(', ')}, or reopen.`);
  const text = clean(note, 3000);
  if (decision === 'add_fact' && !text) throw new EgmError(400, 'Enter the fact to add to the design doc.');
  const at = now();
  await env.DB.prepare('UPDATE idea_findings SET status=?,settled=?,resolution_note=?,resolved_by=?,resolved_at=?,updated_at=?,row_version=row_version+1 WHERE id=?')
    .bind(status, SETTLED_STATUSES.has(status) ? 1 : 0, text, actorId || null, status === 'open' ? null : at, at, findingId).run();
  return { id: findingId, status, settled: SETTLED_STATUSES.has(status) };
}

export async function autoAcceptFixes(env, projectId, { actorId }) {
  const latest = await env.DB.prepare("SELECT id FROM idea_review_runs WHERE project_id=? AND status IN ('complete','converged') ORDER BY created_at DESC LIMIT 1").bind(projectId).first();
  if (!latest) throw new EgmError(400, 'There is no completed review round.');
  const at = now();
  const result = await env.DB.prepare("UPDATE idea_findings SET status='accepted',resolved_by=?,resolved_at=?,updated_at=?,row_version=row_version+1 WHERE run_id=? AND status='open' AND settled=0 AND category='propose_fix'").bind(actorId || null, at, at, latest.id).run();
  return { accepted: Number(result.meta?.changes || 0) };
}

export async function applyResolutions(env, projectId, { actorId }) {
  const latest = await env.DB.prepare("SELECT * FROM idea_review_runs WHERE project_id=? AND status IN ('complete','converged') ORDER BY created_at DESC LIMIT 1").bind(projectId).first();
  if (!latest) throw new EgmError(400, 'There is no completed review round.');
  const findings = (await env.DB.prepare('SELECT * FROM idea_findings WHERE run_id=?').bind(latest.id).all()).results;
  const undecided = findings.filter((item) => item.status === 'open' && !item.settled && ['Blocker', 'Major'].includes(item.severity));
  if (undecided.length) throw new EgmError(409, `Decide every Blocker and Major finding first (${undecided.length} remaining).`);
  const accepted = findings.filter((item) => item.status === 'accepted');
  if (!accepted.length) throw new EgmError(400, 'No accepted findings to apply.');
  const artifact = await latestArtifact(env, projectId, 'design_draft');
  const canary = await canaryFor(env, projectId);
  const instructions = accepted.map((item, index) => `${index + 1}. [${item.finding_key}] (${item.severity}) ${item.title} @ ${item.affected_scope}\n${item.detail}\nReviewer rationale: ${item.recommendation}` + (item.proposed_edit ? `\nProposed edit: ${item.proposed_edit}` : '') + (item.resolution_note ? `\nAuthor-supplied fact to add: ${item.resolution_note}` : '')).join('\n\n');
  const outcome = await runStep(env, {
    projectId, role: 'elephant', operation: 'resolve_findings', scope: latest.id, actorId, canary, artifactId: artifact.id,
    manifest: [{ kind: 'design_doc', artifact_id: artifact.id }, { kind: 'accepted_findings', ids: accepted.map((item) => item.finding_key) }],
    messages: [
      { role: 'system', content: elephantSystem(canary, 'resolve_findings') },
      { role: 'user', content: `Revise the design doc by applying only the accepted findings below. Keep everything else unchanged, keep the section structure and the footer, set Status to In Review, and do not make the document more than about 10% longer. Return the complete revised Markdown document only.\n\nACCEPTED FINDINGS:\n${instructions}\n\nDESIGN DOC:\n${artifact.content}` },
    ],
    validate: requireMarkdown(100),
  });
  if (outcome.failed) throw new EgmError(503, 'Elephant could not apply the changes: ' + outcome.error);
  const revision = await artifactInsert(env, projectId, 'design_draft', artifact.title, outcome.result, {
    parentId: artifact.id, status: 'in_review', manifest: [{ kind: 'resolved_findings', run_id: latest.id, ids: accepted.map((item) => item.finding_key) }],
  });
  const at = now();
  await env.DB.batch([
    revision.statement,
    ...accepted.map((item) => env.DB.prepare("UPDATE idea_findings SET status='fixed',updated_at=?,row_version=row_version+1 WHERE id=? AND status='accepted'").bind(at, item.id)),
    await setState(env, projectId, 'revision_ready'),
  ]);
  return { artifact: revision.artifact, applied: accepted.length };
}

// ---------- convergence and approval ----------

export async function convergenceDecision(env, projectId, choice) {
  const session = await sessionRow(env, projectId);
  const loop = await loopInfo(env, projectId, session);
  if (!loop.last) throw new EgmError(400, 'There is no completed review round.');
  const needsDecision = loop.completed.length >= loop.limit || Boolean(loop.last.churn);
  if (!needsDecision && choice !== 'redraft') throw new EgmError(409, 'No convergence decision is needed right now.');
  if (choice === 'accept') {
    await (await setState(env, projectId, 'awaiting_final_approval')).run();
  } else if (choice === 'continue') {
    await env.DB.batch([
      env.DB.prepare('UPDATE idea_sessions SET cap_extensions=cap_extensions+? WHERE project_id=?').bind(loop.completed.length >= loop.limit ? 1 : 0, projectId),
      await setState(env, projectId, 'reviewing'),
    ]);
  } else if (choice === 'redraft') {
    await env.DB.batch([
      env.DB.prepare("UPDATE idea_draft_sections SET status='draft',approved_at=NULL WHERE project_id=? AND status='approved'").bind(projectId),
      await setState(env, projectId, 'drafting'),
    ]);
  } else {
    throw new EgmError(400, 'Choose accept, continue, or redraft.');
  }
  return { choice };
}

export async function approveDesign(env, projectId, { actorId, note = '' }) {
  const session = await sessionRow(env, projectId);
  const loop = await loopInfo(env, projectId, session);
  const artifact = await latestArtifact(env, projectId, 'design_draft');
  if (!artifact) throw new EgmError(400, 'There is no design doc to approve.');
  const converged = loop.last?.status === 'converged' && loop.last.artifact_id === artifact.id;
  if (!converged && session?.workflow_state !== 'awaiting_final_approval') throw new EgmError(409, 'Final approval needs two consecutive clean review rounds, or an explicit decision to accept the remaining findings.');
  const at = now();
  const content = artifact.content.replace(/\*\*Status:\*\* [A-Za-z ]+?( ·|\n)/, '**Status:** Approved$1');
  const contentSha256 = await sha256(content);
  await env.DB.batch([
    env.DB.prepare("UPDATE idea_artifacts SET status='approved',content=?,content_sha256=?,updated_at=?,row_version=row_version+1 WHERE id=?").bind(content, contentSha256, at, artifact.id),
    env.DB.prepare('INSERT INTO idea_artifact_approvals(id,project_id,artifact_id,artifact_sha256,decision,decided_by,note,idempotency_key,created_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(project_id,idempotency_key) DO NOTHING')
      .bind(crypto.randomUUID(), projectId, artifact.id, contentSha256, 'approved', actorId || 'local-user', clean(note, 1000), `final-approval:${artifact.id}`, at),
    env.DB.prepare("UPDATE idea_sessions SET workflow_state='approved',completed_at=?,state_version=state_version+1,updated_at=? WHERE project_id=?").bind(at, at, projectId),
  ]);
  return { approved: true, artifact_id: artifact.id, artifact_sha256: contentSha256 };
}

// ---------- read model ----------

export async function egmState(env, projectId) {
  const session = await sessionRow(env, projectId);
  const [brainstormRows, sections, loop, approval] = await Promise.all([
    env.DB.prepare('SELECT id,round,hypothesis,status,lens_results_json,objections_json,brief_artifact_id,created_at FROM idea_brainstorm_rounds WHERE project_id=? ORDER BY round DESC LIMIT 5').bind(projectId).all(),
    latestSections(env, projectId),
    loopInfo(env, projectId, session),
    env.DB.prepare("SELECT artifact_id,artifact_sha256,decided_by,created_at FROM idea_artifact_approvals WHERE project_id=? AND decision='approved' ORDER BY created_at DESC LIMIT 1").bind(projectId).first(),
  ]);
  const allRuns = (await env.DB.prepare('SELECT * FROM idea_review_runs WHERE project_id=? ORDER BY created_at DESC LIMIT 20').bind(projectId).all()).results;
  const current = allRuns[0] || null;
  const stages = current ? await stageResults(env, current.id) : [];
  const state = session?.workflow_state || 'session_ready';
  const decided = ['reviewing', 'awaiting_final_approval', 'approved', 'drafting'].includes(state);
  const needsDecision = loop.last && loop.last.status !== 'converged' && !decided && !loop.running
    ? (loop.completed.length >= loop.limit ? 'cap' : loop.last.churn ? 'churn' : null) : null;
  return {
    state,
    brainstorm: brainstormRows.results.map((row) => ({ id: row.id, round: row.round, status: row.status, hypothesis: row.hypothesis, lenses: parseJson(row.lens_results_json, []), objections: parseJson(row.objections_json, []), brief_artifact_id: row.brief_artifact_id, created_at: row.created_at })),
    draft: DRAFT_SECTIONS.map((section) => ({ key: section.key, title: section.title, ...(sections[section.key] ? { version: sections[section.key].version, status: sections[section.key].status, content: sections[section.key].content, feedback: sections[section.key].feedback } : { status: 'not_started' }) })),
    review: {
      stages: REVIEW_STAGES.map((stage, index) => {
        const result = stages.find((item) => item.stage === stage.key);
        return { key: stage.key, title: stage.title, sequence: index + 1, reviewers: stage.reviewers.map((key) => PERSONAS[key].title), status: result ? result.status : 'pending', report_markdown: result?.result.report_markdown || '', reviewer_status: (result?.result.reviewers || []).map((reviewer) => ({ reviewer: PERSONAS[reviewer.persona].title, status: reviewer.status, findings: reviewer.result?.findings?.length || 0 })) };
      }),
      current_run: current ? { id: current.id, round: current.round, status: current.status, clean: Boolean(current.clean), clean_rounds: current.clean_rounds, churn: Boolean(current.churn), report_markdown: current.report_markdown, reviewer_status: parseJson(current.reviewer_status_json, []), artifact_id: current.artifact_id } : null,
      completed_rounds: loop.completed.length,
      round_limit: loop.limit,
      clean_rounds: loop.last?.clean_rounds || 0,
      needs_decision: needsDecision || null,
    },
    approval: approval || null,
  };
}

