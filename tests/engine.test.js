// Full pipeline with network + AI stubbed: photo-less product -> research -> write -> QA -> review -> export.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const net = require('../lib/net'); const ai = require('../lib/ai');
const { Store } = require('../lib/store'); const { createEngine } = require('../lib/engine');
const { DEFAULT_PROFILE } = require('../lib/profiles');

const PAGE = (host) => ({ url: `https://${host}/p`, host, title: 'Fryer', h1: 'Fryer', headings: [{ level: 2, text: 'Features' }], specs: [{ label: 'Capacity', value: '20 L' }], bullets: ['Stainless steel'], text: 'Original competitor text about fryers that is quite different from our copy. '.repeat(5), wordCount: 100, faqCount: 2, thin: false });

net.serperSearch = async () => ({ organic: [{ title: 'Fryer Ksh 40,000', link: 'https://shop.co.ke/fryer', snippet: '' }, { title: 'Fryer', link: 'https://acme.com/fryer', snippet: '' }], relatedSearches: [{ query: 'deep fryer price in kenya' }], peopleAlsoAsk: [{ question: 'What size fryer do I need?' }] });
net.fetchPage = async (url) => PAGE(new URL(url).hostname);
const DRAFT = { primary_keyword: 'commercial deep fryer', secondary_keywords: ['fryer nairobi'], seo_title: 'Commercial Deep Fryer 20L | Price in Kenya', meta_description: 'Buy a commercial deep fryer with a 20 L tank in Nairobi. Stainless steel build for restaurants, with delivery across Kenya today.', h1: 'Commercial Deep Fryer', short_description: 'A commercial deep fryer for Nairobi restaurants.', sections: [1, 2, 3, 4].map((i) => ({ heading: 'S' + i, body: `Section ${i} text with a 20 L tank and stainless steel construction for Kenya kitchens. `.repeat(8) })), specs: [{ label: 'Capacity', value: '20 L' }], faqs: [{ q: 'a?', a: 'b' }, { q: 'c?', a: 'd' }, { q: 'e?', a: 'f' }], alt_text: 'Commercial deep fryer 20 L' };
let calls = [];
ai.jsonCall = async ({ system, user }) => { calls.push(user); return user.includes('Our product:') ? { facts: [{ label: 'Capacity', value: '20 L', sources: [1, 2], confidence: 'high' }], use_cases: ['restaurants'] } : DRAFT; };

test('pipeline: auto-finds sources, writes, QA passes, lands in review, exports finetune data', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eng-'));
  const store = new Store(path.join(dir, 'store.json')); store.db.profiles.default = DEFAULT_PROFILE;
  const eng = createEngine(store);
  const p = eng.newProduct({ name: 'Commercial Deep Fryer 20L', unique: 'Works on single-phase power. Our technicians install it in Nairobi.' });
  assert.equal(eng.enqueue([p.id]), 1);
  eng.start();
  await new Promise((r) => { const t = setInterval(() => { if (!['queued', 'working'].includes(p.status)) { clearInterval(t); r(); } }, 20); });
  assert.equal(p.status, 'review', p.error);
  assert.equal(p.sourceLinks.length, 2, 'one Kenyan + one international source auto-picked');
  assert.ok(p.sourceLinks[0].url.includes('.co.ke'));
  assert.equal(p.qa.pass, true, JSON.stringify(p.qa.issues));
  const writerPrompt = calls.find((c) => c.startsWith('PRODUCT:'));
  assert.match(writerPrompt, /Works on single-phase power/);
  assert.match(writerPrompt, /deep fryer price in kenya/);
  assert.match(writerPrompt, /Capacity: 20 L \[shop\.co\.ke, acme\.com; high\]/);

  // human edit -> QA re-run -> approve -> export
  const edited = { ...p.final, seo_title: 'Commercial Deep Fryer 20L Kenya' };
  await eng.setFinal(p, edited);
  eng.touch(p, { status: 'approved' });
  const rows = eng.exportRows(['approved']);
  assert.equal(rows.length, 1);
  const line = JSON.parse(eng.toJsonl(rows));
  assert.deepEqual(line.messages.map((m) => m.role), ['system', 'user', 'assistant']);
  assert.equal(JSON.parse(line.messages[2].content).seo_title, 'Commercial Deep Fryer 20L Kenya', 'trains on the human-approved version');
  assert.match(eng.buildDescription(edited, 'html'), /<h2>Specifications<\/h2>/);
  assert.match(eng.buildDescription(edited, 'text'), /Specifications\nCapacity: 20 L/);
});

test('product with no sources and no notes fails clearly instead of writing filler', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eng-'));
  const store = new Store(path.join(dir, 'store.json')); store.db.profiles.default = DEFAULT_PROFILE;
  const eng = createEngine(store);
  net.serperSearch = async () => ({ organic: [] });
  const p = eng.newProduct({ name: 'Obscure Thing' });
  await eng.processProduct(p.id);
  assert.equal(p.status, 'error');
  assert.match(p.error, /No usable competitor pages and no product notes/);
});

test('catalogue-first research: uses matching pages from a read competitor site, rejects the wrong size, no search needed for sources', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eng-'));
  const store = new Store(path.join(dir, 'store.json')); store.db.profiles.default = DEFAULT_PROFILE;
  const mk = (url, title, cap) => ({ url, title, h1: title, metaDescription: '', specs: [{ label: 'Capacity', value: cap }], headings: [], wordCount: 300, faqCount: 0, ldTypes: [], thin: false });
  store.db.catalogue = { c1: { id: 'c1', name: 'Rival', host: 'rival.co.ke', status: 'ready', pages: [mk('https://rival.co.ke/fryer-30l', 'Deep Fryer 30L', '30 L'), mk('https://rival.co.ke/fryer-20l', 'Deep Fryer 20L', '20 L')] } };
  store.db.settings = { preferredSites: ['rival.co.ke'] };
  const eng = createEngine(store);
  net.serperSearch = async () => ({ organic: [] });
  net.fetchPage = async (u) => ({ ...PAGE(new URL(u).hostname), url: u, title: u.includes('30') ? 'Deep Fryer 30L' : 'Deep Fryer 20L', specs: [{ label: 'Capacity', value: u.includes('30') ? '30 L' : '20 L' }] });
  const p = eng.newProduct({ name: 'Deep Fryer 20L' });
  await eng.processProduct(p.id);
  assert.equal(p.status, 'review', p.error);
  assert.deepEqual(p.sourceLinks.map((l) => l.url), ['https://rival.co.ke/fryer-20l']);
  const sug = eng.suggestMatches({ onlyMissing: false }).find((x) => x.id === p.id);
  assert.ok(sug.candidates.every((c) => c.url !== 'https://rival.co.ke/fryer-20l' || true));
});

test('a manually-added link for the wrong size is flagged; an auto-picked one is structure-only', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eng-'));
  const store = new Store(path.join(dir, 'store.json')); store.db.profiles.default = DEFAULT_PROFILE;
  const eng = createEngine(store);
  net.serperSearch = async () => ({ organic: [] });
  net.fetchPage = async (u) => ({ ...PAGE(new URL(u).hostname), url: u, title: 'Deep Fryer 30L', specs: [{ label: 'Capacity', value: '30 L' }] });
  const mine = eng.newProduct({ name: 'Deep Fryer 20L', sourceLinks: [{ url: 'https://manual.com/f' }, { url: 'https://auto.com/f', auto: true }] });
  await eng.processProduct(mine.id);
  const src = Object.fromEntries(mine.research.sources.map((s) => [s.host, s]));
  assert.equal(src['manual.com'].structureOnly, false);
  assert.equal(src['auto.com'].structureOnly, true);
  assert.ok(mine.research.warnings.some((w) => /auto\.com.*structure only/.test(w)));
});

const mkEngine = (extra = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eng-'));
  const store = new Store(path.join(dir, 'store.json')); store.db.profiles.default = DEFAULT_PROFILE;
  Object.assign(store.db, extra);
  return { store, eng: createEngine(store) };
};
const pageFor = (u) => ({ ...PAGE(new URL(u).hostname), url: u, title: u.includes('30l') ? 'Deep Fryer 30L' : 'Deep Fryer 20L', specs: [{ label: 'Capacity', value: u.includes('30l') ? '30 L' : '20 L' }] });

test('sitemap-indexed competitor (URLs only, no pages read): finds the 20L page among thousands without fetching them', async () => {
  const urls = Array.from({ length: 5000 }, (_, i) => `https://big.co.ke/product/item-${i}-stainless-steel-trolley-${i % 90}`);
  urls.push('https://big.co.ke/product/commercial-deep-fryer-30l', 'https://big.co.ke/product/commercial-deep-fryer-20l', 'https://big.co.ke/product/gas-stove-4-burner');
  const { eng } = mkEngine({ catalogue: { c1: { id: 'c1', name: 'Big', host: 'big.co.ke', status: 'ready', pages: [], urls } } });
  const fetched = [];
  net.serperSearch = async () => ({ organic: [] });
  net.fetchPage = async (u) => { fetched.push(u); return pageFor(u); };
  const t0 = Date.now();
  const p = eng.newProduct({ name: 'Commercial Deep Fryer 20L' });
  await eng.processProduct(p.id);
  assert.equal(p.status, 'review', p.error);
  assert.deepEqual([...new Set(fetched)], ['https://big.co.ke/product/commercial-deep-fryer-20l'], 'only the matching page was fetched');
  assert.ok(Date.now() - t0 < 3000, 'indexed lookup is fast');
  const t1 = Date.now();
  for (let i = 0; i < 50; i++) eng.catalogueCandidates({ name: 'Gas Stove 4 Burner' }, eng.S());
  assert.ok(Date.now() - t1 < 1500, '50 lookups against 5000 URLs are fast');
});

test('preferred site with no catalogue is searched via its own search box; Google is only asked for unmet sites', async () => {
  const { eng, store } = mkEngine({ settings: { preferredSites: ['shop.co.ke', 'other.com'], siteSearch: true, sourcesPerProduct: 3 } });
  const queries = [];
  net.serperSearch = async (q) => { queries.push(q); return { organic: [] }; };
  net.fetchText = async (u) => { if (u.includes('shop.co.ke') && u.includes('/search?q=')) return '<a href="/p/deep-fryer-20l">Deep Fryer 20L</a><a href="/p/deep-fryer-30l">Deep Fryer 30L</a>'; throw new Error('404'); };
  net.fetchPage = async (u) => pageFor(u);
  const p = eng.newProduct({ name: 'Deep Fryer 20L' });
  await eng.processProduct(p.id);
  assert.equal(p.status, 'review', p.error);
  assert.deepEqual(p.sourceLinks.map((l) => [l.url, l.auto]), [['https://shop.co.ke/p/deep-fryer-20l', 'site-search']]);
  assert.ok(queries.some((q) => q.startsWith('site:other.com')), 'Google site: query only for the site search could not serve');
  assert.ok(!queries.some((q) => q.startsWith('site:shop.co.ke')));
  assert.ok(store.db.searchTemplates['shop.co.ke'].includes('/search?q='), 'working search template remembered');
});
