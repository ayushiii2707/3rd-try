import assert from "node:assert/strict";
import test from "node:test";

import { aiComplete } from "../worker/ai.js";

const env = { AI_API_KEY: "test-key", AI_BASE_URL: "https://model.invalid/v1", AI_MODEL: "m" };
const reply = (content) => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
const failure = (status, code, headers = {}) => new Response(JSON.stringify({ error: { code, message: "x" } }), { status, headers });

async function withResponses(responses, run) {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => responses[Math.min(calls++, responses.length - 1)];
  try { return await run(() => calls); } finally { globalThis.fetch = original; }
}

test("provider JSON validation failures are retried", async () => {
  await withResponses([failure(400, "json_validate_failed"), failure(400, "json_validate_failed"), reply('{"ok":true}')], async (calls) => {
    const result = await aiComplete(env, [{ role: "user", content: "json" }], { json: true });
    assert.equal(result.content, '{"ok":true}');
    assert.equal(calls(), 3);
  });
});

test("after two rejected JSON-mode replies the request is retried without JSON mode", async () => {
  const original = globalThis.fetch;
  const bodies = [];
  const responses = [failure(400, "json_validate_failed"), failure(400, "json_validate_failed"), reply('Sure: {"ok":true}')];
  globalThis.fetch = async (url, init) => { bodies.push(JSON.parse(init.body)); return responses[bodies.length - 1]; };
  try {
    const result = await aiComplete(env, [{ role: "user", content: "json" }], { json: true });
    assert.equal(result.content, 'Sure: {"ok":true}');
    assert.deepEqual(bodies.map((body) => Boolean(body.response_format)), [true, true, false]);
  } finally { globalThis.fetch = original; }
});

test("an empty model reply is retried", async () => {
  await withResponses([reply(""), reply("filled")], async (calls) => {
    assert.equal((await aiComplete(env, [{ role: "user", content: "hi" }])).content, "filled");
    assert.equal(calls(), 2);
  });
});

test("rate limits wait for Retry-After and then succeed", async () => {
  await withResponses([failure(429, "rate_limit_exceeded", { "retry-after": "0.01" }), reply("done")], async (calls) => {
    assert.equal((await aiComplete(env, [{ role: "user", content: "hi" }])).content, "done");
    assert.equal(calls(), 2);
  });
});

test("AI_MAX_CONCURRENCY caps simultaneous requests", async () => {
  const original = globalThis.fetch;
  let inFlight = 0, peak = 0;
  globalThis.fetch = async () => {
    inFlight += 1; peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 15));
    inFlight -= 1;
    return reply("ok");
  };
  try {
    await Promise.all(Array.from({ length: 5 }, () => aiComplete({ ...env, AI_MAX_CONCURRENCY: "2" }, [{ role: "user", content: "hi" }])));
    assert.equal(peak, 2);
  } finally { globalThis.fetch = original; }
});

test("a quota wait longer than a minute fails at once with the time to retry", async () => {
  await withResponses([failure(429, "rate_limit_exceeded", { "retry-after": "190" }), reply("never")], async (calls) => {
    await assert.rejects(aiComplete(env, [{ role: "user", content: "hi" }]), /usage limit for this model is reached\. Try again in about 4 minutes/);
    assert.equal(calls(), 1);
  });
});

test("a request above the provider's per-minute token limit explains itself", async () => {
  await withResponses([failure(413, "rate_limit_exceeded")], async () => {
    await assert.rejects(aiComplete(env, [{ role: "user", content: "hi" }]), /larger than the AI provider allows per minute/);
  });
});

test("other provider errors are not retried here and report their code", async () => {
  await withResponses([failure(500, "internal_error"), reply("never")], async (calls) => {
    await assert.rejects(aiComplete(env, [{ role: "user", content: "hi" }]), /HTTP 500, internal_error/);
    assert.equal(calls(), 1);
  });
  await withResponses([failure(401, "invalid_api_key")], async () => {
    await assert.rejects(aiComplete(env, [{ role: "user", content: "hi" }]), /credentials were rejected/);
  });
});
