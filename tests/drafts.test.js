// Claude drafts: imported into "To review" without any AI call; publishing keeps the old link in old_slugs.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path'); const http = require('http');
const net = require('../lib/net'); const ai = require('../lib/ai');
const { Store } = require('../lib/store'); const { createEngine } = require('../lib/engine');
const { DEFAULT_PROFILE } = require('../lib/profiles');

net.fetchPage = async () => { throw new Error('offline'); };
ai.jsonCall = async () => { throw new Error('no AI in this test'); };

const DRAFT = {
  id: 46, name: '4 ring mild steel burner', slug: '4-ring-mild-steel-gas-burner', drafted_at: 1000,
  photo_check: 'One large burner with four rings.', competitor_check: 'Shine photo is a different product.', sources: ['https://shine.test/p'],
  primary_keyword: '4 ring gas burner', secondary_keywords: ['4 ring gas burner Kenya'],
  seo_title: '4 Ring Gas Burner | Kenya', meta_description: 'A 4 ring gas burner on a mild steel stand for big sufurias in Kenya.', h1: '4 Ring Gas Burner',
  short_description: 'This 4 ring gas burner heats big pots.', sections: [{ heading: 'Key Features', body: 'Four rings.' }], specs: [{ label: 'Rings', value: '4' }],
  faqs: [{ q: 'Is it a cooker?', a: 'No.' }], alt_text: '4 ring gas burner', owner_questions: ['High or low pressure?'],
};

test('Claude drafts land in To review on the matching site product, and re-import skips reviewed ones', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drafts-'));
  const store = new Store(path.join(dir, 'store.json')); store.db.profiles.default = DEFAULT_PROFILE;
  const eng = createEngine(store);
  const existing = eng.newProduct({ name: '4 ring mild steel burner', supabaseId: 46, slug: 'crawfish-boiler-with-propane-burner-100qt', status: 'new' });

  const r = await eng.importDrafts([DRAFT, { id: 99, name: 'New one', ...Object.fromEntries(Object.entries(DRAFT).filter(([k]) => !['id', 'name'].includes(k))) }]);
  assert.deepEqual([r.added, r.updated], [1, 1]);
  assert.equal(existing.status, 'review');
  assert.equal(existing.origin, 'claude');
  assert.equal(existing.seoSlug, '4-ring-mild-steel-gas-burner');
  assert.equal(existing.final.seo_title, DRAFT.seo_title);
  assert.match(existing.unique, /four rings/);
  assert.deepEqual(existing.aiReview.owner_questions, ['High or low pressure?']);
  assert.ok(existing.qa && existing.review);
  assert.equal(eng.summary(existing).origin, 'claude');

  eng.touch(existing, { status: 'approved' });
  const again = await eng.importDrafts([DRAFT]);
  assert.equal(again.skipped.length, 1, 'an approved draft is not overwritten by the same batch');
  assert.equal(existing.status, 'approved');

  eng.touch(existing, { status: 'published' });
  const edited = await eng.importDrafts([{ ...DRAFT, drafted_at: 500, meta_description: 'A 4 ring gas burner for big sufurias in hotels and schools across Kenya.' }]);
  assert.equal(edited.updated, 1, 'an edited draft goes back to review even when its drafted_at is older');
  assert.equal(existing.status, 'review');
  store.flush();
});

test('publishing uses the draft slug and records the old slug for redirects', async (t) => {
  const patches = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      const sel = url.searchParams.get('select') || '';
      res.end(sel.includes('old_slugs') ? JSON.stringify({ slug: 'crawfish-boiler', old_slugs: ['older'] }) : '[]');
      return;
    }
    let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => { patches.push(JSON.parse(body)); res.writeHead(204); res.end(); });
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const prev = [process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY];
  t.after(() => { server.close(); [process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY] = prev; if (prev[0] === undefined) delete process.env.SUPABASE_URL; if (prev[1] === undefined) delete process.env.SUPABASE_SERVICE_KEY; });
  process.env.SUPABASE_URL = `http://127.0.0.1:${server.address().port}`; process.env.SUPABASE_SERVICE_KEY = 'k';

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drafts-pub-'));
  const store = new Store(path.join(dir, 'store.json')); store.db.settings = { siteUrl: 'https://shop.test' };
  const eng = createEngine(store);
  const p = eng.newProduct({ name: '4 ring mild steel burner', supabaseId: 46, seoSlug: '4-ring-gas-burner', final: { ...DRAFT } });
  assert.equal(await eng.publish(p.id), 'https://shop.test/product/4-ring-gas-burner');
  assert.equal(patches[0].slug, '4-ring-gas-burner');
  assert.deepEqual(patches[0].old_slugs, ['older', 'crawfish-boiler']);
  store.flush();
});

test('before supabase-old-slugs.sql is run, publishing keeps the live slug so old links never break', async (t) => {
  const patches = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET') {
      const sel = url.searchParams.get('select') || '';
      if (sel.includes('old_slugs')) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ message: 'column products.old_slugs does not exist', code: '42703' })); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(sel === 'slug' ? JSON.stringify({ slug: 'crawfish-boiler' }) : '[]');
      return;
    }
    let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => { patches.push(JSON.parse(body)); res.writeHead(204); res.end(); });
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const prev = [process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY];
  t.after(() => { server.close(); [process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY] = prev; if (prev[0] === undefined) delete process.env.SUPABASE_URL; if (prev[1] === undefined) delete process.env.SUPABASE_SERVICE_KEY; });
  process.env.SUPABASE_URL = `http://127.0.0.1:${server.address().port}`; process.env.SUPABASE_SERVICE_KEY = 'k';

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drafts-pub-'));
  const store = new Store(path.join(dir, 'store.json')); store.db.settings = { siteUrl: 'https://shop.test' };
  const eng = createEngine(store);
  const p = eng.newProduct({ name: '4 ring mild steel burner', supabaseId: 46, seoSlug: '4-ring-gas-burner', status: 'approved', final: { ...DRAFT } });
  assert.equal(await eng.publish(p.id), 'https://shop.test/product/crawfish-boiler');
  assert.equal(patches[0].slug, 'crawfish-boiler');
  assert.equal(patches[0].old_slugs, undefined);
  assert.equal(p.status, 'published');
  store.flush();
});
