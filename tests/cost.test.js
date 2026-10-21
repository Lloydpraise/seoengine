// Cost controls: cacheable prompt prefix, text-only retries, queue grouping, usage tracking, settings migration, photo resize.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const net = require('../lib/net'); const ai = require('../lib/ai'); const vision = require('../lib/vision');
const { Store } = require('../lib/store'); const { createEngine } = require('../lib/engine');
const { DEFAULT_PROFILE } = require('../lib/profiles');
const { getSettings, DEFAULTS } = require('../lib/settings');

const realJsonCall = ai.jsonCall, realLoadImage = vision.loadImage;
const draft = (over = {}) => ({
  primary_keyword: 'gas cooker', seo_title: 'Gas Cooker 4 Burner | Price in Kenya', h1: 'Gas Cooker 4 Burner', short_description: 'A 4 burner gas cooker for Nairobi kitchens.',
  meta_description: 'Buy a 4 burner gas cooker in Nairobi. Stainless steel build for restaurants, with delivery across Kenya today and support.',
  sections: [{ heading: 'Why it works', body: 'Four burners and an oven. '.repeat(40) }, { heading: 'Size', body: 'It measures 900 mm wide. '.repeat(40) }],
  specs: [{ label: 'Burners', value: '4' }, { label: 'Width', value: '900 mm' }], faqs: [{ q: 'a?', a: 'b' }, { q: 'c?', a: 'd' }, { q: 'e?', a: 'f' }], alt_text: 'Gas cooker', ...over,
});
const newEngine = (profile = DEFAULT_PROFILE) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cost-'));
  const store = new Store(path.join(dir, 'store.json')); store.db.profiles.default = profile;
  return createEngine(store);
};
const quietNet = () => { net.serperSearch = async () => ({ organic: [], relatedSearches: [], peopleAlsoAsk: [] }); };

test('defaults: every step uses gpt-4.1-mini, image detail is low', () => {
  for (const k of ['extractModel', 'writerModel', 'visionModel', 'qaModel']) assert.equal(DEFAULTS[k], 'gpt-4.1-mini', k);
  assert.equal(DEFAULTS.photoDetail, 'low'); assert.equal(DEFAULTS.qaDetail, 'low');
});

test('settings saved by the old version (gpt-4o, gpt-4o-mini) fall back to the new defaults; ft: and custom models are kept', () => {
  const s = getSettings({ db: { settings: { writerModel: 'gpt-4o', extractModel: 'gpt-4o-mini', visionModel: 'ft:gpt-4.1-mini:acme::1', qaModel: 'my-model', photoDetail: 'weird', qaDetail: 'high' } } });
  assert.equal(s.writerModel, 'gpt-4.1-mini'); assert.equal(s.extractModel, 'gpt-4.1-mini');
  assert.equal(s.visionModel, 'ft:gpt-4.1-mini:acme::1'); assert.equal(s.qaModel, 'my-model');
  assert.equal(s.photoDetail, 'low', 'invalid detail ignored'); assert.equal(s.qaDetail, 'high');
});

test('writing prompt: everything shared between products is in the system message, everything per product is in the user message', () => {
  const eng = newEngine();
  eng.store.db.knowledge._global = 'We install everything ourselves.'; eng.store.db.knowledge.Cooking = 'Gas is common in Nairobi hotels.';
  const a = eng.newProduct({ name: 'Gas Cooker 4 Burner 900 mm', unique: 'Notes about cooker A.', major_category: 'Cooking' });
  const b = eng.newProduct({ name: 'Deep Fryer 20L', unique: 'Notes about fryer B.', major_category: 'Cooking' });
  const c = eng.newProduct({ name: 'Chest Freezer', unique: 'Notes about freezer C.', major_category: 'Refrigeration' });
  const pa = eng.buildPrompt(a), pb = eng.buildPrompt(b), pc = eng.buildPrompt(c);
  assert.equal(pa.system, pb.system, 'same profile + category: identical system message, so it is cacheable');
  assert.notEqual(pa.system, pc.system, 'different category knowledge');
  assert.ok(pa.system.startsWith(pc.system.slice(0, 2000)), 'the long start (rules, Kenya rules, JSON shape, style) is shared across categories too');
  assert.match(pa.system, /STYLE PROFILE:/); assert.match(pa.system, /Gas is common in Nairobi hotels/); assert.match(pa.system, /Length: \d+-\d+ words/);
  assert.doesNotMatch(pa.system, /Gas Cooker 4 Burner|Notes about cooker A/, 'nothing product-specific in the shared part');
  assert.match(pa.user, /^PRODUCT: Gas Cooker 4 Burner 900 mm/); assert.match(pa.user, /Notes about cooker A\./);
  assert.doesNotMatch(pa.user, /STYLE PROFILE|SHOP KNOWLEDGE/);
  assert.equal(pa.cacheKey, pb.cacheKey); assert.notEqual(pa.cacheKey, pc.cacheKey);
  const withFb = eng.buildPrompt(a, 'Make it shorter');
  assert.equal(withFb.system, pa.system, 'feedback never changes the cacheable part'); assert.ok(withFb.user.endsWith('Make it shorter'));
});

test('retries are text-only; the photo goes with the first draft and the QA check, at the configured detail', async () => {
  const profile = { ...DEFAULT_PROFILE, targets: { ...DEFAULT_PROFILE.targets, wordsMin: 5000, wordsMax: 6000 } }; // forces the expand + fix retries
  const eng = newEngine(profile);
  vision.productImage = async () => 'data:image/png;base64,AAAA'; vision.loadImage = async () => null; quietNet();
  const seen = [];
  ai.jsonCall = async ({ system, user, images, label, cacheKey }) => {
    seen.push({ label, images: images || [], cacheKey });
    if (system === vision.LOOK_SYSTEM) return { seen: { product_type: 'cooker' }, name_check: { verdict: 'matches' }, sources: [] };
    if (system === vision.QA_SYSTEM) return { image_matches_copy: 'yes', name_vs_image: { verdict: 'matches' }, contradictions: [], unconfirmed: [] };
    return draft();
  };
  const p = eng.newProduct({ name: 'Gas Cooker 4 Burner 900 mm', imageUrl: 'https://x/y.png', unique: 'Four burners, 900 mm wide. Installed in Nairobi.' });
  await eng.processProduct(p.id);
  assert.equal(p.status, 'review', p.error);
  const by = (l) => seen.filter((c) => c.label === l);
  assert.equal(by('write').length, 1); assert.equal(by('write')[0].images.length, 1); assert.equal(by('write')[0].images[0].detail, 'low');
  assert.ok(by('write-expand').length >= 1, 'short draft triggered the expand retry'); by('write-expand').concat(by('write-fix')).forEach((c) => assert.equal(c.images.length, 0, c.label + ' is text-only'));
  assert.equal(by('qa-photo').length, 1); assert.equal(by('qa-photo')[0].images[0].detail, 'low');
  assert.equal(by('look')[0].images[0].detail, 'low');
  seen.filter((c) => c.label.startsWith('write')).forEach((c) => assert.ok(c.cacheKey, c.label + ' carries the cache key'));
  assert.equal(p.wrote.sawPhoto, true);
});

test('the photo and QA detail settings are honoured', async () => {
  const eng = newEngine();
  eng.store.db.settings = { photoDetail: 'high', qaDetail: 'auto' };
  vision.productImage = async () => 'data:image/png;base64,AAAA'; vision.loadImage = async () => null; quietNet();
  const seen = [];
  ai.jsonCall = async ({ system, images, label }) => {
    seen.push({ label, detail: images && images[0] && images[0].detail });
    if (system === vision.LOOK_SYSTEM) return { seen: {}, name_check: { verdict: 'matches' }, sources: [] };
    if (system === vision.QA_SYSTEM) return { image_matches_copy: 'yes', name_vs_image: { verdict: 'matches' }, contradictions: [], unconfirmed: [] };
    return draft();
  };
  const p = eng.newProduct({ name: 'Gas Cooker 4 Burner 900 mm', imageUrl: 'https://x/y.png', unique: 'Four burners, 900 mm wide. Installed in Nairobi.' });
  await eng.processProduct(p.id);
  assert.equal(seen.find((c) => c.label === 'write').detail, 'high'); assert.equal(seen.find((c) => c.label === 'qa-photo').detail, 'auto');
});

test('queue: waiting products with the same style profile and category run back to back', async () => {
  const eng = newEngine();
  eng.store.db.settings = { concurrency: 1 };
  vision.productImage = async () => null; quietNet();
  const order = [];
  ai.jsonCall = async ({ label, user }) => { if (label === 'write') order.push(user.match(/^PRODUCT: (.*)$/m)[1]); return draft(); };
  const mk = (name, cat) => eng.newProduct({ name, major_category: cat, unique: 'Installed by our technicians in Nairobi. Four burners.' });
  const ps = [mk('A1', 'Cooking'), mk('B1', 'Refrigeration'), mk('A2', 'Cooking'), mk('B2', 'Refrigeration'), mk('A3', 'Cooking')];
  eng.enqueue(ps.map((p) => p.id)); eng.start();
  await new Promise((r) => { const t = setInterval(() => { if (ps.every((p) => !['queued', 'working'].includes(p.status))) { clearInterval(t); r(); } }, 20); });
  assert.deepEqual(order, ['A1', 'A2', 'A3', 'B1', 'B2']);
});

test('usage: tokens and cache hits are totalled per step and per product; prompt_cache_key is sent; detail defaults to low', async () => {
  ai.jsonCall = realJsonCall;
  const bodies = [];
  ai._setClient({ chat: { completions: { create: async (body) => { bodies.push(body); return { choices: [{ message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 2000, completion_tokens: 300, prompt_tokens_details: { cached_tokens: 1536 } } }; } } } });
  process.env.AI_USAGE_LOG = '0';
  const eng = newEngine(); const p = eng.newProduct({ name: 'X' });
  await ai.jsonCall({ model: 'gpt-4.1-mini', system: 's', user: 'u', images: [{ url: 'data:image/png;base64,AAAA' }], cacheKey: 'seo:default:Cooking', label: 'write', productId: p.id });
  await ai.jsonCall({ model: 'gpt-4.1-mini', system: 's', user: 'u', label: 'qa-photo', productId: p.id });
  assert.equal(bodies[0].prompt_cache_key, 'seo:default:Cooking'); assert.equal(bodies[0].messages[1].content[1].image_url.detail, 'low');
  assert.ok(!('prompt_cache_key' in bodies[1]));
  const u = eng.usage();
  assert.equal(u.calls, 2); assert.equal(u.prompt, 4000); assert.equal(u.cached, 3072); assert.equal(u.completion, 600);
  assert.equal(u.byLabel.write.cached, 1536); assert.equal(p.usage.calls, 2);
  eng.resetUsage(); assert.equal(eng.usage().calls, 0); assert.equal(p.usage, undefined);
});

test('a model or API that rejects prompt_cache_key: the call is retried without it', async () => {
  ai.jsonCall = realJsonCall; let n = 0; const keys = [];
  ai._setClient({ chat: { completions: { create: async (body) => { n++; keys.push('prompt_cache_key' in body); if ('prompt_cache_key' in body) { const e = new Error('Unrecognized request argument supplied: prompt_cache_key'); e.status = 400; throw e; } return { choices: [{ message: { content: '{"ok":1}' } }], usage: null }; } } } });
  const r = await ai.jsonCall({ model: 'm', system: 's', user: 'u', cacheKey: 'k' });
  assert.deepEqual(r, { ok: 1 }); assert.deepEqual(keys, [true, false]);
});

test('photos are shrunk before sending (when sharp is installed)', async (t) => {
  let sharp; try { sharp = require('sharp'); } catch { return t.skip('sharp not installed'); }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'img-'));
  const file = path.join(dir, 'big.png');
  await sharp({ create: { width: 3000, height: 2000, channels: 3, background: { r: 200, g: 30, b: 30 } } }).png().toFile(file);
  vision.loadImage = realLoadImage;
  const url = await vision.loadImage({ file });
  assert.match(url, /^data:image\/jpeg;base64,/);
  const meta = await sharp(Buffer.from(url.split(',')[1], 'base64')).metadata();
  assert.equal(Math.max(meta.width, meta.height), 768); assert.ok(Buffer.from(url.split(',')[1], 'base64').length < fs.statSync(file).size);
});

test('researcher: "Kenya" is added to every Google keyword (once), and site: searches fall back to plain when empty', async () => {
  const kenya = require('../lib/kenya');
  assert.equal(kenya.withKenya('deep fryer 20L'), 'deep fryer 20L Kenya');
  assert.equal(kenya.withKenya('deep fryer price in Kenya'), 'deep fryer price in Kenya', 'never doubled');
  assert.equal(kenya.withKenya('site:shop.co.ke fryer'), 'site:shop.co.ke fryer Kenya');
  const queries = [];
  net.serperSearch = async (q) => { queries.push(q); return { organic: q.endsWith('Kenya') && q.startsWith('site:b.com') ? [] : [{ title: 't', link: 'https://x.co.ke/' + encodeURIComponent(q), snippet: '' }], relatedSearches: [], peopleAlsoAsk: [] }; };
  const out = await kenya.harvest('Deep Fryer 20L', { preferredHosts: ['a.com', 'b.com'] });
  assert.deepEqual(queries.slice(0, 3), ['Deep Fryer 20L price in Kenya', 'buy Deep Fryer 20L Nairobi Kenya', 'Deep Fryer 20L specifications Kenya']);
  assert.ok(queries.includes('site:a.com Deep Fryer 20L Kenya'));
  assert.ok(queries.includes('site:b.com Deep Fryer 20L Kenya') && queries.includes('site:b.com Deep Fryer 20L'), 'empty with Kenya: repeated once without it');
  assert.ok(!queries.includes('site:a.com Deep Fryer 20L'), 'no fallback when Kenya found results');
  assert.ok(out.organic.length && out.preferred.length);
});

test('the competitor sites\' own search boxes are NOT given the word Kenya', async () => {
  const sitesearch = require('../lib/sitesearch'); const urls = [];
  net.fetchText = async (u) => { urls.push(u); throw new Error('404'); };
  await sitesearch.search('shop.co.ke', 'Deep Fryer 20L');
  assert.ok(urls.length && urls.every((u) => !/kenya/i.test(decodeURIComponent(u).replace('shop.co.ke', ''))));
});
