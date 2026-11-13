// OpenAI-compatible chat completion client shared by the Elephant chat and the
// Elephant–Goldfish workflow. The API key stays server-side.

export function aiConfig(env) {
  const key = env.AI_API_KEY || env.OPENAI_API_KEY;
  if (!key) throw Error('Idea AI is not configured. Set the AI_API_KEY environment variable before starting the server.');
  return {
    key,
    base: (env.AI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, ''),
    model: env.AI_MODEL || 'gpt-4.1-mini',
    provider: env.AI_PROVIDER || 'OpenAI-compatible',
  };
}

const PROVIDER_ATTEMPTS = 4;
const MAX_WAIT_MS = 60000;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Caps simultaneous model requests (AI_MAX_CONCURRENCY, default 4) so accounts
// with small per-minute token limits are not exhausted by parallel reviewers.
let active = 0;
const waiting = [];
async function acquireSlot(limit) {
  if (active >= limit) await new Promise((resolve) => waiting.push(resolve));
  active += 1;
}
function releaseSlot() {
  active -= 1;
  waiting.shift()?.();
}

// Seconds from a Retry-After header, or a short increasing default.
function retryDelay(response, attempt) {
  const header = Number(response.headers.get('retry-after'));
  const ms = Number.isFinite(header) && header > 0 ? header * 1000 : 1500 * attempt;
  return Math.min(MAX_WAIT_MS, ms);
}

// Each call is a stateless request: no server-side thread or conversation id is
// sent, so the model sees only the messages passed here. Rate limits (429) and
// provider-side JSON validation failures are transient and retried here; other
// failures are reported to the caller, whose own retry policy applies.
export async function aiComplete(env, messages, options = {}) {
  const config = aiConfig(env);
  await acquireSlot(Math.max(1, Math.floor(Number(env.AI_MAX_CONCURRENCY)) || 4));
  try {
    return await completeWithRetries(config, messages, options);
  } finally {
    releaseSlot();
  }
}

async function completeWithRetries(config, messages, { json = false, timeoutMs = 90000 } = {}) {
  let jsonMode = json;
  for (let attempt = 1; ; attempt += 1) {
    const control = new AbortController();
    const timeout = setTimeout(() => control.abort(), timeoutMs);
    try {
      const response = await fetch(config.base + '/chat/completions', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + config.key, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: config.model, messages, temperature: 0.25, ...(jsonMode ? { response_format: { type: 'json_object' } } : {}) }),
        signal: control.signal,
      });
      if (response.ok) {
        const payload = await response.json();
        const content = payload.choices?.[0]?.message?.content;
        if (content) return { content, usage: payload.usage || null, model: config.model, provider: config.provider };
        // Reasoning models occasionally spend the whole output on hidden reasoning; that is transient.
        if (attempt < PROVIDER_ATTEMPTS) continue;
        throw Error('Idea AI returned an empty response.');
      }
      if (response.status === 401 || response.status === 403) throw Error('Idea AI credentials were rejected.');
      const detail = await response.json().catch(() => ({}));
      const code = String(detail?.error?.code || detail?.error?.type || '').replace(/[^a-z0-9_.-]/gi, '').slice(0, 60);
      if (response.status === 429) {
        // A long Retry-After means a usage quota (for example tokens per day), not a burst; waiting here would only hold the request open.
        const seconds = Number(response.headers.get('retry-after'));
        if (Number.isFinite(seconds) && seconds * 1000 > MAX_WAIT_MS) throw Error(`The AI provider's usage limit for this model is reached. Try again in about ${Math.ceil(seconds / 60)} minute${Math.ceil(seconds / 60) === 1 ? '' : 's'}, or use another model.`);
      }
      const transient = response.status === 429 || code === 'json_validate_failed';
      if (transient && attempt < PROVIDER_ATTEMPTS) {
        // After two rejected JSON-mode replies, ask without JSON mode; callers
        // extract and validate the JSON object from the plain reply.
        if (code === 'json_validate_failed' && attempt >= 2) jsonMode = false;
        await wait(response.status === 429 ? retryDelay(response, attempt) : 250);
        continue;
      }
      if (response.status === 429) throw Error('Idea AI is rate limited. Please wait and retry.');
      if (response.status === 413) throw Error('This request is larger than the AI provider allows per minute for this model. Use a model or plan with a higher token limit.');
      throw Error(`Idea AI could not complete this request (HTTP ${response.status}${code ? ', ' + code : ''}).`);
    } catch (error) {
      if (error.name === 'AbortError') throw Error('Idea AI did not respond in time.');
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function parseJsonContent(content) {
  try {
    return JSON.parse(content);
  } catch {
    const match = String(content).match(/\{[\s\S]*\}/);
    if (match) {
      try { return JSON.parse(match[0]); } catch {}
    }
    throw Error('Idea AI returned an invalid structured response. Please retry.');
  }
}

export async function aiJSON(env, messages) {
  return parseJsonContent((await aiComplete(env, messages, { json: true })).content);
}
