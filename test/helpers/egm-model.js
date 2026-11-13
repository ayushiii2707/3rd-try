// Deterministic stand-in for the OpenAI-compatible model used by the
// Elephant–Goldfish workflow. It routes on the "EGM-TASK:" line of the system
// prompt, records every request for isolation assertions, and can be told to
// fail specific calls. Nothing leaves the machine.

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const SECTION_TEXT = {
  overview: "## Overview\n### The Problem\nTeams lose planning context.\n### Goals\nKeep plans durable.\n### Non-Goals\nNo code generation.\n### Open Questions\nNone yet.\n### Critical User Journeys\nCUJ 1: Given a session, When I return, Then my plan is there.\nCUJ 2: Given a review, When it ends, Then findings are listed.",
  technical_plan: "## Technical Plan\nA local server stores sessions in SQLite.\n```\nbrowser -> server -> sqlite\n```\n## Non-Functional Requirements\nRestarts must not lose data.",
  alternatives: "## Alternatives Considered\n### Alternative A: hosted database\nPros: shared. Cons: setup. Reason for Rejection: Rejected by author: local first.\n## Additional Resources\nNone.\n## Future Improvements\nExport to PDF.",
  implementation: "## Detailed Implementation Plan\n### Target Files to Create/Modify\n1. worker/egm.js (Type: Create) - workflow engine.\n### Verification Plan\nUnit tests and an integration test.",
};

export function createModel(options = {}) {
  const model = {
    requests: [],
    counts: {},
    failures: { ...(options.failures || {}) },
    // persona -> function(userContent, round) => findings
    reviewFindings: options.reviewFindings || (() => []),
    contradictions: options.contradictions ?? [],
    classify: options.classify || ((item) => ({ category: "propose_fix", justification: "Agreed.", evidence: "", proposed_edit: "Add the missing detail." })),
    async handle(input, init) {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.hostname !== "mock-ai.invalid") return null;
      const body = JSON.parse(await request.text());
      const system = body.messages.find((message) => message.role === "system")?.content || "";
      const user = body.messages.filter((message) => message.role !== "system").map((message) => message.content).join("\n");
      const task = (system.match(/EGM-TASK: (\S+)/) || [])[1] || (user.includes('Return {"ok":true}') ? "agent_check" : system.includes("Begin a Socratic discovery") ? "chat_start" : "chat");
      model.requests.push({ task, system, user, raw: JSON.stringify(body) });
      model.counts[task] = (model.counts[task] || 0) + 1;
      if (model.failures[task] > 0) {
        model.failures[task] -= 1;
        return json({ error: { message: "temporary failure" } }, 500);
      }
      const reply = (content) => json({ choices: [{ message: { content: typeof content === "string" ? content : JSON.stringify(content) } }], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } });
      if (task === "agent_check") return reply({ ok: true });
      if (task === "chat_start") return reply({ reply: "Who is this for?", hypothesis: "Teams need durable plans.", ready: false, memory: { known_facts: [], assumptions: [], constraints: [], decisions: [], open_questions: ["Who?"] } });
      if (task === "chat") return reply({ reply: "Clear enough to review.", hypothesis: "Teams need durable plans.", ready: true, memory: { known_facts: ["Small teams"], assumptions: [], constraints: [], decisions: [], open_questions: [] } });
      if (task === "brainstorm_hypothesis") return reply("## Working Hypothesis\nTeams need durable plans.\n## Problem\nContext is lost.\n## Target Users\nSmall teams.\n## Open Questions\nNone.");
      if (task.startsWith("brainstorm_lens:")) return reply({ summary: "One risk.", issues: [{ severity: "Major", title: "Scope creep", risk: "Too many features.", requirement: "Ship the smallest version." }] });
      if (task === "brainstorm_synthesis") return reply({ brief_markdown: "## Overview\nDurable plans.\n## Analysis\nScope risk.\n## Goals vs. Non-Goals\n### In-Scope Goals\nPlans.\n### Out-of-Scope Non-Goals\nCode.\n## Alternatives Weighed\nHosted vs local.\n## Key Decisions & Staging for Next Steps\nLocal first.", objections: ["Scope may grow.", "Local only."] });
      if (task.startsWith("draft_section:")) return reply(SECTION_TEXT[task.split(":")[1]]);
      if (task === "draft_reconcile") {
        const contradictions = typeof model.contradictions === "function" ? model.contradictions() : model.contradictions;
        return reply({ contradictions });
      }
      if (task.startsWith("review:")) {
        const persona = task.split(":")[1];
        const findings = model.reviewFindings(persona, user) || [];
        const result = { summary: findings.length ? "Issues found." : "No findings.", findings };
        if (persona === "comprehension") Object.assign(result, { what_this_proposes: "A durable planner.", how_existing_system_works: "Plans are stored locally." });
        return reply(result);
      }
      if (task === "review_classification") {
        const ids = [...user.matchAll(/"id": "([^"]+)"/g)].map((match) => match[1]);
        return reply({ items: ids.map((id) => ({ id, ...model.classify(id, user) })) });
      }
      if (task === "resolve_findings") {
        const doc = user.split("DESIGN DOC:\n")[1] || "";
        return reply(doc.replace("Teams lose planning context.", "Teams lose planning context. REVISED: restart behaviour is specified."));
      }
      throw new Error("Unhandled mock task " + task);
    },
  };
  return model;
}
