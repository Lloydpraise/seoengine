const OpenAI = require('openai');
let client;
const getClient = () => {
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is missing in .env');
  return client || (client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY }));
};

// JSON-mode call with retry on rate limits / transient errors.
// images: optional [{ url, detail }] (url may be a data: URL). Sent as vision input alongside the text.
async function jsonCall({ model, system, user, images }) {
  let lastErr;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const r = await getClient().chat.completions.create({
        model,
        messages: [{ role: 'system', content: system }, { role: 'user', content: images && images.length ? [{ type: 'text', text: user }, ...images.map((i) => ({ type: 'image_url', image_url: { url: i.url, detail: i.detail || 'auto' } }))] : user }],
        response_format: { type: 'json_object' },
      });
      return JSON.parse(r.choices[0].message.content);
    } catch (e) {
      lastErr = e;
      const retryable = e.status === 429 || e.status >= 500 || e instanceof SyntaxError;
      if (!retryable) break;
      await new Promise((r) => setTimeout(r, 1500 * 2 ** attempt));
    }
  }
  throw new Error(`OpenAI call failed: ${lastErr && lastErr.message}`);
}
module.exports = { jsonCall };
