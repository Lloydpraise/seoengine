// Photo-aware writing, the last-step photo QA, and the confidence notes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const net = require('../lib/net'); const ai = require('../lib/ai'); const vision = require('../lib/vision');
const { Store } = require('../lib/store'); const { createEngine } = require('../lib/engine');
const { DEFAULT_PROFILE } = require('../lib/profiles');

const draft = (over = {}) => ({
  primary_keyword: 'gas cooker', seo_title: 'Gas Cooker 4 Burner | Price in Kenya', h1: 'Gas Cooker 4 Burner', short_description: 'A 4 burner gas cooker for Nairobi kitchens.',
  meta_description: 'Buy a 4 burner gas cooker in Nairobi. Stainless steel build for restaurants, with delivery across Kenya today and support.',
  sections: [{ heading: 'Why it works', body: 'Four burners and an oven. '.repeat(40) }, { heading: 'Size', body: 'It measures 900 mm wide. '.repeat(40) }],
  specs: [{ label: 'Burners', value: '4' }, { label: 'Width', value: '900 mm' }], faqs: [{ q: 'a?', a: 'b' }, { q: 'c?', a: 'd' }, { q: 'e?', a: 'f' }], alt_text: 'Gas cooker', ...over,
});

test('mergeReview: code lowers unsupported dimensions even when the AI says high; unrated parts are flagged', () => {
  const d = draft({ specs: [{ label: 'Width', value: '900 mm' }, { label: 'Weight', value: '48 kg' }] });
  const ai1 = vision.normAiReview({ overall: 'high', items: [{ key: 'dimensions', confidence: 'high', note: '' }, { key: 'section:Why it works', confidence: 'medium', note: 'oven not clear in photo' }] });
  const r = vision.mergeReview({ ai: ai1, draft: d, allowedText: 'Gas Cooker 4 Burner\nWidth: 900 mm' });
  const dim = r.items.find((i) => i.key === 'dimensions');
  assert.equal(dim.confidence, 'low', 'AI said high but 48 kg is in no source');
  assert.ok(dim.notes.some((n) => n.from === 'check' && /48 kg/.test(n.text)));
  assert.equal(r.items.find((i) => i.key === 'section:0').confidence, 'medium');
  assert.equal(r.items.find((i) => i.key === 'faqs').confidence, 'unrated', 'AI never rated the FAQs');
  assert.equal(r.overall, 'low');
  assert.equal(r.items[0].confidence, 'low', 'worst items come first');
});

test('mergeReview: no AI review at all means nothing is trusted; ticking an item off removes it from the to-do count', () => {
  const r = vision.mergeReview({ ai: null, draft: draft(), allowedText: 'Gas Cooker 4 Burner width 900 mm' });
  assert.ok(r.items.every((i) => i.confidence === 'unrated' || i.confidence === 'low'));
  const before = r.needsYou;
  const r2 = vision.mergeReview({ ai: null, draft: draft(), allowedText: 'Gas Cooker 4 Burner width 900 mm', checked: { faqs: true } });
  assert.equal(r2.needsYou, before - 1);
});

test('mergeReview: photo contradictions lower the section they point at', () => {
  const vq = vision.normQA({ image_matches_copy: 'partly', name_vs_image: { verdict: 'matches' }, contradictions: [{ where: 'section 1', claim: 'and an oven', image_shows: 'no oven door', severity: 'high' }], unconfirmed: [], summary: 'oven claim wrong' });
  const ai1 = vision.normAiReview({ items: [{ key: 'section:0', confidence: 'high' }, { key: 'section:1', confidence: 'high' }, { key: 'specs', confidence: 'high' }, { key: 'faqs', confidence: 'high' }, { key: 'short_description', confidence: 'high' }, { key: 'dimensions', confidence: 'high' }] });
  const r = vision.mergeReview({ ai: ai1, draft: draft(), allowedText: 'Gas Cooker 4 Burner 900 mm', vq });
  assert.equal(r.items.find((i) => i.key === 'section:0').confidence, 'low');
  assert.equal(r.items.find((i) => i.key === 'section:1').confidence, 'high');
  assert.equal(r.items.find((i) => i.key === 'photo').confidence, 'low');
});

test('photo QA issues: conflicts between the admin name and the photo are flagged, not silently resolved', () => {
  const vq = vision.normQA({ image_matches_copy: 'yes', name_vs_image: { verdict: 'conflicts', reason: 'name says 4 burners, photo shows 6' }, contradictions: [], unconfirmed: [] });
  const iss = vision.visionIssues(vq);
  assert.ok(iss.some((i) => i.level === 'error' && i.code === 'name_photo_conflict'));
  assert.equal(vision.visionIssues({ checked: false, reason: 'No photo' })[0].level, 'warn');
});

test('pipeline with a photo: different-looking competitor is demoted, writer and QA both see the photo, QA mismatch triggers one rewrite', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vis-'));
  const store = new Store(path.join(dir, 'store.json')); store.db.profiles.default = DEFAULT_PROFILE;
  const eng = createEngine(store);
  const seenImages = { look: 0, writer: 0, qa: 0 };
  let qaRuns = 0, writerRuns = 0;
  vision.productImage = async () => 'data:image/png;base64,AAAA';
  vision.loadImage = async () => 'data:image/png;base64,BBBB';
  net.serperSearch = async () => ({ organic: [{ title: 'Cooker', link: 'https://shop.co.ke/cooker', snippet: '' }], relatedSearches: [], peopleAlsoAsk: [] });
  net.fetchPage = async (u) => ({ url: u, host: new URL(u).hostname, image: 'https://img.example/c.jpg', title: 'Gas Cooker 6 Burner', h1: 'Gas Cooker 6 Burner', headings: [], specs: [{ label: 'Burners', value: '6' }], bullets: [], text: 'Competitor text about cookers that is different. '.repeat(10), wordCount: 100, faqCount: 0, thin: false });
  ai.jsonCall = async ({ system, user, images }) => {
    if (system === vision.LOOK_SYSTEM) { seenImages.look = images.length; return { seen: { product_type: 'gas cooker', visible_features: ['4 burners'], finish_colour: 'steel', not_visible: ['dimensions'] }, name_check: { verdict: 'matches', reason: '' }, sources: [{ index: 1, verdict: 'different', reason: '6 burners' }] }; }
    if (system === vision.QA_SYSTEM) { seenImages.qa = images.length; qaRuns++; return qaRuns === 1 ? { image_matches_copy: 'partly', name_vs_image: { verdict: 'matches' }, contradictions: [{ where: 'section 1', claim: 'and an oven', image_shows: 'no oven', severity: 'high' }], unconfirmed: [] , summary: 'oven' } : { image_matches_copy: 'yes', name_vs_image: { verdict: 'matches' }, contradictions: [], unconfirmed: [], summary: 'ok' }; }
    if (user.includes('Our product:')) return { facts: [], use_cases: [] };
    writerRuns++; if (images) seenImages.writer = images.length;
    return { ...draft(), review: { overall: 'medium', items: [{ key: 'dimensions', confidence: 'low', note: 'width only from the name' }], owner_questions: ['Is the width 900 mm?'] } };
  };
  const p = eng.newProduct({ name: 'Gas Cooker 4 Burner 900 mm', imageUrl: 'https://x/y.png', unique: 'Four burners, 900 mm wide, installed by our technicians in Nairobi.' });
  await eng.processProduct(p.id);
  assert.equal(p.status, 'review', p.error);
  assert.equal(p.research.sources[0].structureOnly, true, 'auto-picked page whose photo shows a different product is never used for facts');
  assert.ok(p.research.warnings.some((w) => /different product/.test(w)));
  assert.equal(seenImages.look, 2, 'shop photo + one competitor image');
  assert.equal(seenImages.writer, 1, 'writer sees the shop photo');
  assert.equal(seenImages.qa, 1, 'QA sees the shop photo');
  assert.equal(qaRuns, 2, 'QA ran, flagged, writer rewrote once, QA ran again');
  assert.equal(writerRuns, 2);
  assert.equal(p.vqa.checked, true);
  assert.equal(eng.summary(p).photoFlags, 0);
  assert.ok(p.review.items.find((i) => i.key === 'dimensions'), 'dimensions row exists');
  assert.ok(p.review.owner_questions.includes('Is the width 900 mm?'));
  assert.ok(!('review' in p.final), 'review notes never leak into the published copy');
  const row = eng.exportRows(['review'])[0];
  assert.ok(JSON.parse(row.output).review, 'fine-tune data keeps the AI notes so the tuned model keeps writing them');
});

test('writing model without image support: falls back to text, and says so', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vis-'));
  const store = new Store(path.join(dir, 'store.json')); store.db.profiles.default = DEFAULT_PROFILE;
  const eng = createEngine(store);
  vision.productImage = async () => 'data:image/png;base64,AAAA';
  vision.loadImage = async () => null;
  net.serperSearch = async () => ({ organic: [], relatedSearches: [], peopleAlsoAsk: [] });
  ai.jsonCall = async ({ system, user, images }) => {
    if (system === vision.LOOK_SYSTEM) return { seen: { product_type: 'cooker' }, name_check: { verdict: 'matches' }, sources: [] };
    if (system === vision.QA_SYSTEM) return { image_matches_copy: 'yes', name_vs_image: { verdict: 'matches' }, contradictions: [], unconfirmed: [] };
    if (images) throw new Error('model does not support images');
    return draft();
  };
  const p = eng.newProduct({ name: 'Gas Cooker 4 Burner 900 mm', imageUrl: 'https://x/y.png', unique: 'Four burners, 900 mm wide. Installed in Nairobi.' });
  await eng.processProduct(p.id);
  assert.equal(p.status, 'review', p.error);
  assert.equal(p.wrote.sawPhoto, false);
  assert.equal(p.wrote.hadPhoto, true);
  assert.equal(p.review.items.find((i) => i.key === 'faqs').confidence, 'unrated', 'no AI review came back, so nothing is trusted');
});

test('no photo at all: the copy is flagged as not checked visually', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vis-'));
  const store = new Store(path.join(dir, 'store.json')); store.db.profiles.default = DEFAULT_PROFILE;
  const eng = createEngine(store);
  vision.productImage = async () => null;
  net.serperSearch = async () => ({ organic: [], relatedSearches: [], peopleAlsoAsk: [] });
  ai.jsonCall = async () => draft();
  const p = eng.newProduct({ name: 'Gas Cooker 4 Burner 900 mm', unique: 'Four burners, 900 mm wide. Installed in Nairobi.' });
  await eng.processProduct(p.id);
  assert.equal(p.vqa.checked, false);
  assert.equal(p.review.items.find((i) => i.key === 'photo').confidence, 'low');
});

test('the admin renaming a product or swapping its photo on /admin is picked up before the next run', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vis-'));
  const store = new Store(path.join(dir, 'store.json')); store.db.profiles.default = DEFAULT_PROFILE;
  let row = { name: 'Gas Cooker 6 Burner', image_url: 'https://x/new.png' };
  const eng = createEngine(store, { readSiteRow: async () => row });
  vision.productImage = async () => null;
  net.serperSearch = async () => ({ organic: [], relatedSearches: [], peopleAlsoAsk: [] });
  ai.jsonCall = async () => draft();
  const p = eng.newProduct({ name: 'Gas Cooker', supabaseId: 7, imageUrl: 'https://x/old.png', sourceLinks: [{ url: 'https://auto.example/a', auto: 'catalogue' }, { url: 'https://mine.example/b' }], unique: 'Six burners, installed in Nairobi.', visual: { old: true }, research: { stale: false, sources: [], warnings: [], keywords: {} } });
  net.fetchPage = async (u) => ({ url: u, host: new URL(u).hostname, image: '', title: 'Cooker', h1: 'Cooker', headings: [], specs: [], bullets: [], text: 'Competitor text. '.repeat(30), wordCount: 100, faqCount: 0, thin: false });
  await eng.processProduct(p.id);
  assert.equal(p.name, 'Gas Cooker 6 Burner');
  assert.equal(p.imageUrl, 'https://x/new.png');
  assert.deepEqual(p.sourceLinks.map((l) => l.url).includes('https://auto.example/a'), false, 'auto-picked pages matched to the old name are dropped');
  assert.ok(p.sourceLinks.some((l) => l.url === 'https://mine.example/b'), 'pages the owner added stay');
  assert.notDeepEqual(p.visual, { old: true }, 'old photo comparison is not reused');
});

test('redo: published items go back through the pipeline, land in review, and the live site is untouched', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vis-'));
  const store = new Store(path.join(dir, 'store.json')); store.db.profiles.default = DEFAULT_PROFILE;
  const eng = createEngine(store);
  vision.productImage = async () => null;
  net.serperSearch = async () => ({ organic: [], relatedSearches: [], peopleAlsoAsk: [] });
  net.fetchPage = async (u) => ({ url: u, host: 'a.com', image: '', title: 'x', h1: 'x', headings: [], specs: [], bullets: [], text: 'text '.repeat(60), wordCount: 100, faqCount: 0, thin: false });
  ai.jsonCall = async () => draft();
  const pub = eng.newProduct({ name: 'Gas Cooker 4 Burner 900 mm', status: 'published', final: draft(), unique: 'Four burners, 900 mm. Nairobi.', publishedUrl: 'https://live/x', research: { stale: false, sources: [], warnings: [], keywords: {} } });
  const fresh = eng.newProduct({ name: 'Other', status: 'new' });
  assert.deepEqual(eng.redoable(), [pub.id]);
  assert.equal(eng.redo([pub.id, fresh.id]), 1, 'only published/approved items can be redone');
  assert.equal(pub.status, 'queued');
  assert.equal(pub.research.stale, true, 'research re-runs so the photo comparison happens');
  eng.start();
  await new Promise((r) => { const t = setInterval(() => { if (!['queued', 'working'].includes(pub.status)) { clearInterval(t); r(); } }, 20); });
  assert.equal(pub.status, 'review', pub.error);
  assert.equal(pub.publishedUrl, 'https://live/x', 'still points at the live page; nothing was published');
});
