const OpenAI = require('openai');
let client;
const getClient = () => {
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is missing in .env');
  return client || (client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY }));
};

// JSON-mode call with retry on rate limits / transient errors.
async function jsonCall({ model, system, user }) {
  let lastErr;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const r = await getClient().chat.completions.create({
        model,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
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
