const OpenAI = require('openai');
let client;
const getClient = () => {
  if (client) return client;
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is missing in .env');
  return (client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY }));
};

// Token usage: every call reports its usage to the listener (the engine adds it up per product and per step).
// prompt_tokens includes cached_tokens, so cache hit rate = cached / prompt.
let listener = null;
const onUsage = (fn) => { listener = fn; };
function report(meta, model, usage) {
  if (!usage) return;
  const u = {
    label: meta.label || 'other', model, productId: meta.productId || '',
    prompt: usage.prompt_tokens || 0,
    cached: (usage.prompt_tokens_details && usage.prompt_tokens_details.cached_tokens) || 0,
    completion: usage.completion_tokens || 0,
  };
  if (process.env.AI_USAGE_LOG !== '0') console.log(`[ai] ${u.label} ${model} in=${u.prompt} cached=${u.cached} out=${u.completion}${meta.images ? ` images=${meta.images}` : ''}`);
  try { if (listener) listener(u); } catch { /* usage tracking must never break a run */ }
}

// JSON-mode call with retry on rate limits / transient errors.
// images: optional [{ url, detail }] (url may be a data: URL). Sent as vision input alongside the text.
// cacheKey: groups calls that share the same long prefix (OpenAI prompt_cache_key) so they land on the same cache.
// label / productId: only for usage tracking.
async function jsonCall({ model, system, user, images, cacheKey, label, productId }) {
  let lastErr, useKey = !!cacheKey;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const body = {
        model,
        messages: [{ role: 'system', content: system }, { role: 'user', content: images && images.length ? [{ type: 'text', text: user }, ...images.map((i) => ({ type: 'image_url', image_url: { url: i.url, detail: i.detail || 'low' } }))] : user }],
        response_format: { type: 'json_object' },
      };
      if (useKey) body.prompt_cache_key = String(cacheKey).slice(0, 64);
      const r = await getClient().chat.completions.create(body);
      report({ label, productId, images: images && images.length }, model, r.usage);
      return JSON.parse(r.choices[0].message.content);
    } catch (e) {
      lastErr = e;
      // an older API/SDK that does not know prompt_cache_key: carry on without it
      if (useKey && e.status === 400 && /prompt_cache_key/i.test(String(e.message))) { useKey = false; attempt--; continue; }
      const retryable = e.status === 429 || e.status >= 500 || e instanceof SyntaxError;
      if (!retryable) break;
      await new Promise((r) => setTimeout(r, 1500 * 2 ** attempt));
    }
  }
  throw new Error(`OpenAI call failed: ${lastErr && lastErr.message}`);
}
const _setClient = (c) => { client = c; }; // tests only
module.exports = { jsonCall, onUsage, _setClient };
