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
  const eng = newEngine(profile); eng.store.db.settings = { imageMode: 'full' };
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
  eng.store.db.settings = { imageMode: 'full', photoDetail: 'high', qaDetail: 'auto' };
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

// ---------- lean mode ("once"): the default ----------
const leanRun = async ({ firstWords = 'ok', over = {}, photo = true, profile } = {}) => {
  const eng = newEngine(profile); const seen = [];
  vision.productImage = async () => (photo ? 'data:image/png;base64,AAAA' : null); vision.loadImage = async () => 'data:image/png;base64,BBBB';
  net.fetchPage = async (u) => ({ url: u, host: new URL(u).hostname, image: 'https://img/c.jpg', title: 'Gas Cooker 4 Burner', h1: 'Gas Cooker 4 Burner', headings: [{ level: 2, text: 'Care' }], specs: [{ label: 'Burners', value: '4' }], bullets: [], text: 'Different competitor wording about cookers. '.repeat(10), wordCount: 100, faqCount: 0, thin: false });
  ai.jsonCall = async (a) => {
    seen.push({ label: a.label, images: a.images || [], user: a.user, maxTokens: a.maxTokens });
    if (a.system === vision.LOOK_SYSTEM) return { seen: { product_type: 'cooker', visible_features: ['4 burners'], finish_colour: 'steel', not_visible: [] }, name_check: { verdict: 'matches' }, sources: [] };
    if (a.label === 'facts') return { facts: [{ label: 'Burners', value: '4', sources: [1], confidence: 'high' }], use_cases: [] };
    if (a.label === 'write-expand') return { sections: [{ heading: 'Care and cleaning', body: 'Wipe it down after use. '.repeat(30), confidence: 'medium', note: 'general advice' }] };
    if (a.label === 'write-patch') return { primary_keyword: 'gas cooker', seo_title: 'Gas Cooker 4 Burner | Price in Kenya', meta_description: 'Buy a gas cooker with four burners in Nairobi. Stainless steel build for restaurants, with delivery across Kenya today and support.' };
    return draft(over);
  };
  const p = eng.newProduct({ name: 'Gas Cooker 4 Burner', unique: 'Four burners, 900 mm wide. Installed in Nairobi.', imageUrl: 'https://x/y.png', sourceLinks: [{ url: 'https://a.co.ke/c' }, { url: 'https://b.co.ke/c' }] });
  await eng.processProduct(p.id);
  return { eng, p, seen, imgs: seen.reduce((n, c) => n + c.images.length, 0) };
};

test('lean mode: look + facts + write only, and the photo is sent exactly once (no competitor photos, no QA photo, no photo in the writer)', async () => {
  const { p, seen, imgs } = await leanRun();
  assert.equal(p.status, 'review', p.error);
  assert.deepEqual(seen.map((c) => c.label), ['look', 'facts', 'write']);
  assert.equal(imgs, 1); assert.equal(seen[0].images.length, 1);
  assert.equal(p.vqa.skipped, true); assert.equal(p.review.items.find((i) => i.key === 'photo'), undefined, 'no photo row when nothing disagrees');
  assert.equal(p.wrote.viaDescription, true);
  assert.match(seen[2].user, /Product type in the photo: cooker/, 'the writer reads the description of the photo');
});

test('lean mode: a short draft is expanded APPEND-ONLY (no full rewrite), new sections arrive rated', async () => {
  const profile = { ...DEFAULT_PROFILE, targets: { ...DEFAULT_PROFILE.targets, wordsMin: 900, wordsMax: 1200 } };
  const { p, seen } = await leanRun({ profile });
  const ex = seen.filter((c) => c.label === 'write-expand'); assert.equal(ex.length, 1);
  assert.doesNotMatch(ex[0].user, /DRAFT:\s*\{/, 'the whole draft is not sent back');
  assert.equal(p.draft.sections.length, 3); assert.equal(p.draft.sections[2].heading, 'Care and cleaning');
  assert.ok(p.aiReview.items.some((i) => /Care and cleaning/.test(i.key) && i.confidence === 'medium'));
});

test('lean mode: a too-long title or meta is fixed in CODE (no AI call); the AI patch is only for what code cannot fix (no keyword at all)', async () => {
  const long = await leanRun({ over: { seo_title: 'Gas Cooker 4 Burner Commercial Stainless Steel Price in Kenya Nairobi Today', meta_description: 'Buy a gas cooker with four burners in Nairobi. '.repeat(6) } });
  assert.deepEqual(long.seen.map((c) => c.label), ['look', 'facts', 'write'], 'no patch call');
  assert.ok(long.p.draft.seo_title.length <= 60 && long.p.draft.meta_description.length <= 155); assert.equal(long.p.draft.sections.length, 2, 'body untouched');
  const nokw = await leanRun({ over: { primary_keyword: '' } });
  assert.deepEqual(nokw.seen.map((c) => c.label), ['look', 'facts', 'write', 'write-patch'], 'only the AI can choose a keyword');
});

test('qa.fixHead: trims at word boundaries, keeps the keyword in the title, never touches the body', () => {
  const qa = require('../lib/qa');
  const d = { primary_keyword: 'gas cooker', seo_title: 'Cooker 4 Burner', meta_description: 'x', short_description: 'A solid gas cooker for Nairobi kitchens.', sections: [{ heading: 'h', body: 'b' }] };
  const f = qa.fixHead(d);
  assert.match(f.seo_title, /^Gas Cooker/); assert.ok(f.seo_title.length <= 60); assert.deepEqual(f.sections, d.sections);
  assert.ok(qa.fixHead({ ...d, seo_title: 'Gas Cooker | ' + 'Very Long Words '.repeat(8) }).seo_title.length <= 60);
});

test('lean mode: counts in the copy that the photo description does not show are flagged in code (no AI call), and follow the owner\'s edits', async () => {
  const { eng, p, seen } = await leanRun({ over: { short_description: 'A gas cooker with six burners for Nairobi kitchens.' } });
  assert.ok(!seen.some((c) => c.label === 'qa-photo'));
  assert.ok(p.vqa.codeChecks.some((c) => c.where === 'short_description' && c.shows === '4'));
  const it = p.review.items.find((i) => i.key === 'short_description'); assert.notEqual(it.confidence, 'high'); assert.match(it.notes.map((n) => n.text).join(' '), /photo shows 4/);
  await eng.setFinal(p, { ...p.final, short_description: 'A gas cooker with four burners for Nairobi kitchens.' });
  assert.equal(p.vqa.codeChecks.length, 0);
});

test('merged research: ONE call (photo + sources) replaces look + facts; a page judged "different" is demoted and its facts dropped', async () => {
  const eng = newEngine(); eng.store.db.settings = { researchMode: 'merged' };
  vision.productImage = async () => 'data:image/png;base64,AAAA'; quietNet();
  net.fetchPage = async (u) => ({ url: u, host: new URL(u).hostname, image: 'https://img/c.jpg', title: 'Gas Cooker 4 Burner', h1: 'Gas Cooker 4 Burner', headings: [], specs: [{ label: 'Burners', value: '4' }], bullets: ['b'], text: 'Different competitor wording about cookers. '.repeat(10), wordCount: 100, faqCount: 0, thin: false });
  const seen = [];
  ai.jsonCall = async (a) => {
    seen.push({ label: a.label, images: a.images || [] });
    if (a.label === 'research') return { seen: { product_type: 'cooker', visible_features: ['4 burners'], finish_colour: '', not_visible: [] }, name_check: { verdict: 'matches' }, sources: [{ index: 1, verdict: 'same' }, { index: 2, verdict: 'different', reason: 'a 6 burner range' }],
      facts: [{ label: 'Burners', value: '4', sources: [1], confidence: 'high' }, { label: 'Ovens', value: '2', sources: [2], confidence: 'low' }], use_cases: [] };
    return draft();
  };
  const p = eng.newProduct({ name: 'Gas Cooker 4 Burner', unique: 'Four burners, 900 mm wide. Installed in Nairobi.', imageUrl: 'https://x/y.png', sourceLinks: [{ url: 'https://a.co.ke/c', auto: true }, { url: 'https://b.co.ke/c', auto: true }] });
  await eng.processProduct(p.id);
  assert.equal(p.status, 'review', p.error);
  assert.deepEqual(seen.map((c) => c.label), ['research', 'write']); assert.equal(seen[0].images.length, 1);
  assert.deepEqual(p.facts.facts.map((f) => f.label), ['Burners']); assert.deepEqual(p.facts.facts[0].hosts, ['a.co.ke']);
  assert.equal(p.research.sources.find((x) => x.host === 'b.co.ke').structureOnly, true);
  assert.ok(p.research.warnings.some((w) => /b\.co\.ke.*different product/.test(w)));
});

test('research cache: reused until the name, photo, your links, or a research setting changes', async () => {
  const eng = newEngine(); vision.productImage = async () => null; quietNet(); let facts = 0;
  net.fetchPage = async (u) => ({ url: u, host: new URL(u).hostname, title: 'Gas Cooker 4 Burner', h1: 'x', headings: [], specs: [{ label: 'Burners', value: '4' }], bullets: [], text: 'Other words. '.repeat(30), wordCount: 100, faqCount: 0, thin: false });
  ai.jsonCall = async (a) => { if (a.label === 'facts') facts++; return a.label === 'facts' ? { facts: [], use_cases: [] } : draft(); };
  const p = eng.newProduct({ name: 'Gas Cooker 4 Burner', unique: 'Four burners, 900 mm wide. Nairobi.', sourceLinks: [{ url: 'https://a.co.ke/c' }] });
  await eng.processProduct(p.id); await eng.processProduct(p.id); assert.equal(facts, 1, 'second run reuses the research');
  eng.store.db.settings = { researchMode: 'merged' }; await eng.processProduct(p.id); assert.equal(facts, 2, 'a research setting changed: research redone');
  await eng.processProduct(p.id); assert.equal(facts, 2);
});

test('full mode still works: 4+ images (look with competitor photo, writer, QA)', async () => {
  const eng = newEngine(); eng.store.db.settings = { imageMode: 'full' };
  vision.productImage = async () => 'data:image/png;base64,AAAA'; vision.loadImage = async () => 'data:image/png;base64,BBBB'; quietNet();
  net.fetchPage = async (u) => ({ url: u, host: new URL(u).hostname, image: 'https://img/c.jpg', title: 'Gas Cooker 4 Burner', h1: 'Gas Cooker 4 Burner', headings: [], specs: [], bullets: ['a'], text: 'Other words entirely. '.repeat(20), wordCount: 100, faqCount: 0, thin: false });
  let imgs = 0;
  ai.jsonCall = async (a) => { imgs += (a.images || []).length; if (a.system === vision.LOOK_SYSTEM) return { seen: {}, name_check: { verdict: 'matches' }, sources: [{ index: 1, verdict: 'same' }] }; if (a.system === vision.QA_SYSTEM) return { image_matches_copy: 'yes', name_vs_image: { verdict: 'matches' }, contradictions: [], unconfirmed: [] }; if (a.label === 'facts') return { facts: [], use_cases: [] }; return draft(); };
  const p = eng.newProduct({ name: 'Gas Cooker 4 Burner', unique: 'Four burners. Nairobi.', imageUrl: 'https://x/y.png', sourceLinks: [{ url: 'https://a.co.ke/c' }] });
  await eng.processProduct(p.id);
  assert.equal(imgs, 4); assert.equal(p.vqa.checked, true);
});

test('lean mode: name vs photo disagreement still surfaces as a photo row', async () => {
  const eng = newEngine(); vision.productImage = async () => 'data:image/png;base64,AAAA'; quietNet();
  ai.jsonCall = async (a) => (a.system === vision.LOOK_SYSTEM ? { seen: { product_type: 'cooker' }, name_check: { verdict: 'conflicts', reason: 'name says 4 burners, photo shows 6' }, sources: [] } : draft());
  const p = eng.newProduct({ name: 'Gas Cooker 4 Burner', unique: 'Four burners. Nairobi.', imageUrl: 'https://x/y.png' });
  await eng.processProduct(p.id);
  const row = p.review.items.find((i) => i.key === 'photo'); assert.equal(row.confidence, 'low'); assert.match(row.notes[0].text, /photo shows 6/);
});

test('ai: bad JSON is retried once, not five times; a cut-off answer is not repeated; the output cap is sent and dropped if rejected', async () => {
  ai.jsonCall = realJsonCall; process.env.AI_USAGE_LOG = '0'; let n = 0;
  ai._setClient({ chat: { completions: { create: async () => { n++; return { choices: [{ message: { content: 'not json' }, finish_reason: 'stop' }], usage: null }; } } } });
  await assert.rejects(ai.jsonCall({ model: 'm', system: 's', user: 'u' })); assert.equal(n, 2);
  n = 0; ai._setClient({ chat: { completions: { create: async () => { n++; return { choices: [{ message: { content: '{"a":' }, finish_reason: 'length' }], usage: null }; } } } });
  await assert.rejects(ai.jsonCall({ model: 'm', system: 's', user: 'u', maxTokens: 100 }), /cut off/); assert.equal(n, 1);
  const bodies = []; ai._setClient({ chat: { completions: { create: async (b) => { bodies.push(b); if (b.max_completion_tokens) { const e = new Error('Unsupported parameter: max_completion_tokens'); e.status = 400; throw e; } return { choices: [{ message: { content: '{"ok":1}' }, finish_reason: 'stop' }], usage: null }; } } } });
  assert.deepEqual(await ai.jsonCall({ model: 'm', system: 's', user: 'u', maxTokens: 100 }), { ok: 1 }); assert.equal(bodies[0].max_completion_tokens, 100); assert.ok(!('max_completion_tokens' in bodies[1]));
});

test('cost: usage is priced from the price table, projected for the products still to do, and the queue pauses at the spend limit', async () => {
  ai.jsonCall = realJsonCall; process.env.AI_USAGE_LOG = '0';
  ai._setClient({ chat: { completions: { create: async () => ({ choices: [{ message: { content: '{"ok":1}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1000000, completion_tokens: 1000000, prompt_tokens_details: { cached_tokens: 0 } } }) } } });
  const eng = newEngine(); eng.store.db.settings = { maxSpendUsd: 1.5 };
  const p = eng.newProduct({ name: 'A' }); eng.newProduct({ name: 'B' });
  eng.enqueue([p.id]); eng.start();
  await ai.jsonCall({ model: 'gpt-4.1-mini', system: 's', user: 'u', productId: p.id, label: 'write' });
  assert.ok(Math.abs(eng.usage().cost - 2.0) < 1e-9, '1M in x $0.40 + 1M out x $1.60'); assert.equal(eng.qstats().active, false, 'paused: spend limit reached');
  p.status = 'review'; const u = eng.usage(); assert.equal(u.productsDone, 1); assert.equal(u.productsLeft, 1); assert.ok(Math.abs(u.projected - 2.0) < 1e-9);
});
