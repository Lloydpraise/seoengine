require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const { stringify } = require('csv-stringify/sync');
const { Store } = require('./lib/store');
const { createEngine } = require('./lib/engine');
const { getSettings, DEFAULTS } = require('./lib/settings');
const profiles = require('./lib/profiles');
const { parseCsv, matchRows } = require('./lib/csvmatch');
const catalogue = require('./lib/catalogue');
const sitemap = require('./lib/sitemap');
const net = require('./lib/net');
const { getProcessedFileNames } = require('./duplicate-skip');

const store = new Store(process.env.SEO_STORE || undefined);
if (!store.db.profiles.default) store.db.profiles.default = profiles.DEFAULT_PROFILE;
if (!store.db.profiles.long) store.db.profiles.long = profiles.LONG_PROFILE;
if (!store.db.profiles['kenya-longtail']) store.db.profiles['kenya-longtail'] = profiles.KENYA_LONGTAIL_PROFILE;
store.db.catalogue = store.db.catalogue || {};
Object.values(store.db.catalogue).forEach((c) => { if (c.status === 'crawling') { c.status = 'error'; c.error = 'Interrupted by a restart. Read the site again.'; } });
const catSummary = (c) => ({ id: c.id, name: c.name, host: c.host, startUrl: c.startUrl, status: c.status, error: c.error, tried: c.tried, kind: c.urls ? 'index' : 'pages', found: (c.urls ? c.urls.length : c.pages.length) || c.found || 0, failed: (c.failed || []).length, crawledAt: c.crawledAt });
net.setBrowser(getSettings(store).useBrowser);
const engine = createEngine(store);
const IMAGES = engine.IMAGES;
fs.mkdirSync(IMAGES, { recursive: true });

const app = express();
app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'ui')));
app.use('/images', express.static(IMAGES));
app.get('/productprices.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'productprices.html')));
// Legacy: used only by productprices.html. Safe because the server listens on localhost only.
app.get('/api/config', (req, res) => res.json({ supabase_url: process.env.SUPABASE_URL, supabase_service_key: process.env.SUPABASE_SERVICE_KEY }));

const wrap = (fn) => async (req, res) => {
  try { res.json((await fn(req, res)) ?? { ok: true }); }
  catch (e) { console.error(e); res.status(400).json({ error: e.message }); }
};
const getP = (req) => {
  const p = store.db.products[req.params.id];
  if (!p) throw new Error('Product not found');
  return p;
};
const cleanLinks = (arr) => [...new Set([].concat(arr || []).map((u) => (typeof u === 'string' ? u : u.url)).map((u) => String(u || '').trim()).filter((u) => /^https?:\/\//i.test(u)))];

// ---------- state ----------
app.get('/api/state', wrap(() => {
  const s = getSettings(store);
  return {
    products: engine.products().sort((a, b) => b.created - a.created).map(engine.summary),
    queue: engine.qstats(),
    profiles: Object.entries(store.db.profiles).map(([id, p]) => ({ ...p, id })),
    knowledge: store.db.knowledge,
    catalogues: Object.values(store.db.catalogue).map(catSummary),
    settings: s,
    keys: { openai: !!process.env.OPENAI_API_KEY, serper: !!process.env.SERPER_API_KEY, supabase: !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) },
  };
}));

// ---------- live events ----------
const clients = new Set();
const send = (o) => { const d = `data: ${JSON.stringify(o)}\n\n`; clients.forEach((r) => r.write(d)); };
engine.bus.on('product', (p) => send({ type: 'product', product: p }));
engine.bus.on('queue', (q) => send({ type: 'queue', queue: q }));
app.get('/api/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  clients.add(res);
  req.on('close', () => clients.delete(res));
});

// ---------- products ----------
app.get('/api/products/:id', wrap((req) => getP(req)));

app.post('/api/products', wrap((req) => {
  const b = req.body;
  if (!String(b.name || '').trim()) throw new Error('Enter a product name');
  const p = engine.newProduct({
    name: b.name.trim(), major_category: b.major_category || '', sub_category: b.sub_category || '',
    sourceLinks: cleanLinks(b.links).map((url) => ({ url })), unique: b.unique || '', profileId: b.profileId || '',
  });
  return engine.summary(p);
}));

app.patch('/api/products/:id', wrap((req) => {
  const p = getP(req), b = req.body, patch = {};
  for (const k of ['name', 'major_category', 'sub_category', 'unique', 'profileId']) if (k in b) patch[k] = b[k];
  if ('links' in b) {
    patch.sourceLinks = cleanLinks(b.links).map((url) => ({ url }));
    if (p.research && JSON.stringify(patch.sourceLinks.map((l) => l.url)) !== JSON.stringify(p.sourceLinks.map((l) => l.url))) p.research.stale = true;
  }
  engine.touch(p, patch);
  return engine.summary(p);
}));

app.delete('/api/products/:id', wrap((req) => { getP(req); delete store.db.products[req.params.id]; store.save(); }));

app.post('/api/products/bulk', wrap((req) => {
  const { ids = [], action, value } = req.body;
  if (action === 'queue') return { queued: engine.enqueue(ids) };
  for (const id of ids) {
    const p = store.db.products[id];
    if (!p) continue;
    if (action === 'delete') delete store.db.products[id];
    else if (action === 'profile') engine.touch(p, { profileId: value });
    else if (action === 'category') engine.touch(p, { major_category: value.major || '', sub_category: value.sub || '' });
  }
  store.save();
}));

// photo upload: raw body, filename in ?name=
app.post('/api/upload', express.raw({ type: () => true, limit: '40mb' }), wrap((req) => {
  const base = path.basename(String(req.query.name || 'photo.jpg')).replace(/[^a-zA-Z0-9._ ()-]/g, '_');
  if (!/\.(jpe?g|png|webp)$/i.test(base)) throw new Error(`${base}: only JPG, PNG or WEBP photos`);
  if (engine.products().some((p) => p.localImage === base)) return { duplicate: true, name: base };
  fs.writeFileSync(path.join(IMAGES, base), req.body);
  const p = engine.newProduct({ localImage: base });
  return { id: p.id, name: base };
}));

app.post('/api/scan-images', wrap((req) => {
  const known = new Set(engine.products().map((p) => p.localImage).filter(Boolean));
  const old = req.body.includeProcessed ? new Set() : getProcessedFileNames(path.join(__dirname, 'output'));
  const files = fs.readdirSync(IMAGES).filter((f) => /\.(jpe?g|png|webp)$/i.test(f) && !known.has(f) && !old.has(f));
  files.forEach((f) => engine.newProduct({ localImage: f }));
  return { added: files.length, skippedOld: old.size };
}));

app.post('/api/import-supabase', wrap(async () => ({ added: await engine.importFromSupabase() })));

app.post('/api/products/:id/find-sources', wrap(async (req) => {
  const p = getP(req);
  const kenya = require('./lib/kenya');
  const st = getSettings(store);
  const kw = await kenya.harvest(p.name, { preferredHosts: st.preferredSites });
  const candidates = kenya.pickSources(kw.organic, st.siteUrl, p.sourceLinks.map((l) => l.url), { name: p.name, limit: st.sourcesPerProduct, preferredHosts: st.preferredSites, preferred: kw.preferred });
  const strong = engine.catalogueCandidates(p, st).filter((c) => !p.sourceLinks.some((l) => l.url === c.url)).map((c) => ({ link: c.url, title: c.title, snippet: `From ${c.site}` }));
  return { candidates: [...strong, ...candidates], all: [...strong, ...kw.preferred, ...kw.organic].slice(0, 14) };
}));

// ---------- queue ----------
app.post('/api/queue/start', wrap(() => { engine.start(); return engine.qstats(); }));
app.post('/api/queue/pause', wrap(() => { engine.pause(); return engine.qstats(); }));

// ---------- review ----------
app.post('/api/products/:id/final', wrap(async (req) => { const p = getP(req); await engine.setFinal(p, req.body.final); return { qa: p.qa }; }));
app.post('/api/products/:id/regenerate', wrap((req) => { getP(req); engine.regenerate(req.params.id, req.body); return { started: true }; }));
app.post('/api/products/:id/approve', wrap((req) => { const p = getP(req); if (!p.final) throw new Error('Nothing to approve'); engine.touch(p, { status: 'approved', stage: 'Approved' }); }));
app.post('/api/products/:id/reopen', wrap((req) => { const p = getP(req); engine.touch(p, { status: 'review', stage: 'Ready for review' }); }));
app.post('/api/products/:id/publish', wrap(async (req) => ({ url: await engine.publish(getP(req).id) })));
app.post('/api/publish-approved', wrap(async () => {
  const ids = engine.products().filter((p) => p.status === 'approved').map((p) => p.id);
  const out = { published: 0, failed: [] };
  for (const id of ids) {
    try { await engine.publish(id); out.published++; }
    catch (e) { out.failed.push(`${store.db.products[id].name}: ${e.message}`); engine.touch(store.db.products[id], { error: e.message }); }
  }
  return out;
}));
app.get('/api/products/:id/preview', wrap((req) => { const p = getP(req); return { description: engine.buildDescription(p.final, 'html') }; }));

// ---------- competitor sites ----------
app.post('/api/catalogue/crawl', wrap((req) => {
  const { name, url, filter, max, mode } = req.body;
  const raw = String(url || '').trim();
  if (!raw) throw new Error('Enter the competitor site address');
  const startUrl = /^https?:\/\//i.test(raw) ? raw : 'https://' + raw;
  const cat = { id: store.id('c'), name: String(name || '').trim() || catalogue.hostOf(startUrl), host: catalogue.hostOf(startUrl), startUrl, status: 'crawling', tried: 0, found: 0, pages: [], failed: [] };
  store.db.catalogue[cat.id] = cat;
  const done = (patch) => { Object.assign(cat, patch, { crawledAt: Date.now() }); store.save(); send({ type: 'catalogue', catalogue: catSummary(cat) }); };
  const job = mode === 'pages'
    ? catalogue.crawl({ startUrl, filter, max: Math.min(300, Math.max(5, +max || 60)), onProgress: (tried, found) => { cat.tried = tried; cat.found = found; send({ type: 'catalogue', catalogue: catSummary(cat) }); } })
        .then((r) => done({ pages: r.pages, failed: r.failed, status: r.pages.length ? 'ready' : 'error', error: r.pages.length ? '' : `Read ${r.candidates} links but none looked like product pages. Try a category page that lists products, or add a link filter such as /product/.` }))
    : (async () => {
        const maps = sitemap.isSitemapUrl(startUrl) ? [startUrl] : await sitemap.discover(startUrl);
        if (!maps.length) throw new Error('No sitemap found for this site. Use "Read pages now" with a category page instead.');
        const urls = await sitemap.productUrls(maps, { filter });
        if (!urls.length) throw new Error('The sitemap has no product-looking links. Try adding a filter such as /product/.');
        done({ urls, sitemaps: maps, status: 'ready', error: '' });
      })();
  job.catch((e) => done({ status: 'error', error: e.message }));
  return catSummary(cat);
}));
app.post('/api/catalogue/try', wrap(async (req) => {
  if (!String(req.body.name || '').trim()) throw new Error('Type a product name to try');
  return engine.trySources(req.body.name.trim());
}));
app.delete('/api/catalogue/:id', wrap((req) => { delete store.db.catalogue[req.params.id]; store.save(); }));
app.post('/api/catalogue/:id/style', wrap(async (req) => {
  const cat = store.db.catalogue[req.params.id];
  if (!cat || cat.status !== 'ready') throw new Error('Read the site first');
  if (cat.urls) throw new Error('Style learning needs page content. Use "Read pages now" for this site.');
  const picks = catalogue.richest(cat.pages, Math.min(10, Math.max(2, +req.body.count || 8)));
  if (!picks.length) throw new Error('No pages with enough text to learn from');
  const prof = await profiles.ingest({ name: req.body.name || `${cat.name} style`, urls: picks.map((p) => p.url), model: getSettings(store).extractModel });
  const id = store.id('s'); store.db.profiles[id] = prof; store.save();
  return { id, name: prof.name, pages: picks.length };
}));
app.post('/api/catalogue/match', wrap((req) => {
  const results = engine.suggestMatches({ onlyMissing: req.body.onlyMissing !== false });
  return { results, minFit: getSettings(store).minFit, catalogues: Object.values(store.db.catalogue).filter((c) => c.status === 'ready').length };
}));
app.post('/api/catalogue/apply', wrap((req) => ({ updated: engine.applyMatches(req.body.assignments || []) })));

// ---------- styles (ingestor) ----------
app.post('/api/profiles/ingest', wrap(async (req) => {
  const urls = cleanLinks(req.body.urls);
  if (!req.body.name || !urls.length) throw new Error('Give the style a name and at least one reference link');
  const prof = await profiles.ingest({ name: req.body.name, urls, model: getSettings(store).extractModel });
  const id = store.id('s');
  store.db.profiles[id] = prof;
  store.save();
  return { id, ...prof };
}));
app.patch('/api/profiles/:id', wrap((req) => {
  const p = store.db.profiles[req.params.id];
  if (!p) throw new Error('Style not found');
  const b = req.body;
  if (b.name) p.name = b.name;
  if ('rules' in b) p.rules = b.rules;
  if (b.targets) p.targets = { ...p.targets, ...Object.fromEntries(Object.entries(b.targets).map(([k, v]) => [k, +v || 0])) };
  if (b.analysis) p.analysis = { ...p.analysis, ...b.analysis };
  store.save();
}));
app.delete('/api/profiles/:id', wrap((req) => { if (req.params.id === 'default') throw new Error('The default style cannot be deleted'); delete store.db.profiles[req.params.id]; store.save(); }));

// ---------- knowledge + settings ----------
app.put('/api/knowledge', wrap((req) => { store.db.knowledge[req.body.key] = req.body.text || ''; store.save(); }));
app.put('/api/settings', wrap((req) => {
  const b = req.body, out = {};
  for (const k of Object.keys(DEFAULTS)) if (k in b) out[k] = b[k];
  if (typeof out.extraColumns === 'string') out.extraColumns = out.extraColumns.trim() ? JSON.parse(out.extraColumns) : {};
  for (const k of ['majorCategories', 'subCategories']) if (typeof out[k] === 'string') out[k] = out[k].split('\n').map((x) => x.trim()).filter(Boolean);
  if (typeof out.preferredSites === 'string') out.preferredSites = out.preferredSites.split('\n').map((x) => x.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0]).filter(Boolean);
  if ('sourcesPerProduct' in out) out.sourcesPerProduct = Math.min(4, Math.max(1, +out.sourcesPerProduct || 3));
  if ('concurrency' in out) out.concurrency = Math.min(5, Math.max(1, +out.concurrency || 2));
  store.db.settings = { ...store.db.settings, ...out };
  net.setBrowser(getSettings(store).useBrowser);
  store.save();
}));

// ---------- CSV: match sheet rows to products ----------
app.post('/api/csv/preview', wrap((req) => {
  const rows = parseCsv(req.body.text || '');
  if (!rows.length) throw new Error('The sheet is empty or has no header row');
  return { total: rows.length, results: matchRows(rows, engine.products()) };
}));
app.post('/api/csv/apply', wrap((req) => {
  const out = { updated: 0, created: 0, skipped: 0, ids: [] };
  for (const r of req.body.rows) {
    const pr = r.parsed;
    const merge = (p) => {
      const links = cleanLinks([...p.sourceLinks.map((l) => l.url), ...pr.links]);
      const patch = { sourceLinks: links.map((url) => ({ url, auto: (p.sourceLinks.find((l) => l.url === url) || {}).auto })) };
      if (links.length !== p.sourceLinks.length && p.research) p.research.stale = true;
      if (pr.knowledge) patch.unique = p.unique && !p.unique.includes(pr.knowledge) ? `${p.unique}\n${pr.knowledge}` : pr.knowledge;
      if (pr.major_category) patch.major_category = pr.major_category;
      if (pr.sub_category) patch.sub_category = pr.sub_category;
      const prof = Object.entries(store.db.profiles).find(([id, x]) => id === pr.profile || x.name.toLowerCase() === String(pr.profile).toLowerCase());
      if (prof) patch.profileId = prof[0];
      engine.touch(p, patch);
      out.ids.push(p.id);
    };
    if (r.action === 'update' && store.db.products[r.matchId]) { merge(store.db.products[r.matchId]); out.updated++; }
    else if (r.action === 'create' && (pr.name || pr.filename)) {
      const p = engine.newProduct({ name: pr.name || '', localImage: pr.filename && fs.existsSync(path.join(IMAGES, pr.filename)) ? pr.filename : '' });
      merge(p); out.created++;
    } else out.skipped++;
  }
  if (req.body.queue) out.queued = engine.enqueue(out.ids);
  if (req.body.queue && req.body.start) engine.start();
  return out;
}));

// ---------- export ----------
const statusesFrom = (q) => (q === 'all' ? ['review', 'approved', 'published'] : q === 'approved' ? ['approved', 'published'] : [q || 'approved']);
app.get('/api/export.jsonl', (req, res) => {
  res.set({ 'Content-Type': 'application/jsonl', 'Content-Disposition': 'attachment; filename="finetune.jsonl"' });
  res.send(engine.toJsonl(engine.exportRows(statusesFrom(req.query.status))));
});
app.get('/api/export.csv', (req, res) => {
  const rows = engine.exportRows(statusesFrom(req.query.status));
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="seo-input-output.csv"' });
  res.send('\uFEFF' + stringify(rows.map(({ system, ...r }) => r), { header: true }));
});
app.get('/api/export-count', wrap((req) => ({ count: engine.exportRows(statusesFrom(req.query.status)).length })));

process.on('SIGINT', () => { store.flush(); process.exit(0); });
process.on('SIGTERM', () => { store.flush(); process.exit(0); });

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, '127.0.0.1', () => console.log(`\nSEO Engine running. Open http://127.0.0.1:${PORT}\n`));
}
module.exports = { app, store, engine };
