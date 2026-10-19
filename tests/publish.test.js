const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../lib/store');
const { createEngine } = require('../lib/engine');

test('publishing an imported product updates its name and unique slug in place', async (t) => {
  const previousUrl = process.env.SUPABASE_URL;
  const previousKey = process.env.SUPABASE_SERVICE_KEY;
  const requests = [];
  const existingSlugs = new Map([
    ['new-product-name', 'another-product'],
    ['same-name', 'existing-product'],
  ]);
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET') {
      const slug = (url.searchParams.get('slug') || '').replace(/^eq\./, '');
      const id = existingSlugs.get(slug);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(id ? JSON.stringify({ id }) : '[]');
      return;
    }
    if (req.method === 'PATCH') {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        requests.push({ url, body: JSON.parse(body) });
        res.writeHead(204);
        res.end();
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seo-publish-'));
  t.after(async () => {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
    if (previousUrl === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = previousUrl;
    if (previousKey === undefined) delete process.env.SUPABASE_SERVICE_KEY;
    else process.env.SUPABASE_SERVICE_KEY = previousKey;
  });

  process.env.SUPABASE_URL = `http://127.0.0.1:${server.address().port}`;
  process.env.SUPABASE_SERVICE_KEY = 'test-service-key';
  const store = new Store(path.join(dir, 'store.json'));
  store.db.settings = { siteUrl: 'https://shop.test' };
  const engine = createEngine(store);
  const final = {
    seo_title: 'Updated product title',
    meta_description: 'Updated description',
    alt_text: 'Product image',
    short_description: 'Product details',
    sections: [],
    specs: [],
    faqs: [],
    primary_keyword: 'product',
    secondary_keywords: [],
  };

  const renamed = engine.newProduct({
    name: 'New Product Name',
    supabaseId: 'imported-product',
    slug: 'old-name',
    final,
  });
  assert.equal(await engine.publish(renamed.id), 'https://shop.test/products/new-product-name-2');
  assert.equal(renamed.slug, 'new-product-name-2');

  const unchanged = engine.newProduct({
    name: 'Same Name',
    supabaseId: 'existing-product',
    slug: 'same-name',
    final,
  });
  assert.equal(await engine.publish(unchanged.id), 'https://shop.test/products/same-name');
  assert.equal(unchanged.slug, 'same-name');

  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0].body, {
    name: 'New Product Name',
    slug: 'new-product-name-2',
    canonical_url: 'https://shop.test/products/new-product-name-2',
    description: 'Product details',
    meta_title: 'Updated product title',
    meta_description: 'Updated description',
    alt_text: 'Product image',
  });
  assert.deepEqual(requests[1].body, {
    name: 'Same Name',
    slug: 'same-name',
    canonical_url: 'https://shop.test/products/same-name',
    description: 'Product details',
    meta_title: 'Updated product title',
    meta_description: 'Updated description',
    alt_text: 'Product image',
  });
  assert.match(requests[0].url.searchParams.get('id'), /eq\.imported-product/);
  assert.match(requests[1].url.searchParams.get('id'), /eq\.existing-product/);
  store.flush();
});
