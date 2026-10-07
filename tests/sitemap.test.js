const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('../lib/net');
const sm = require('../lib/sitemap');
const ss = require('../lib/sitesearch');

test('discovers sitemap from robots.txt, falls back to common paths', async () => {
  net.fetchText = async (u) => { if (u.endsWith('/robots.txt')) return 'User-agent: *\nSitemap: https://a.co.ke/wp-sitemap.xml'; throw new Error('404'); };
  assert.deepEqual(await sm.discover('a.co.ke'), ['https://a.co.ke/wp-sitemap.xml']);
  net.fetchText = async (u) => { if (u === 'https://b.com/sitemap_index.xml') return '<urlset><loc>https://b.com/x</loc></urlset>'; throw new Error('404'); };
  assert.deepEqual(await sm.discover('https://b.com/some/page'), ['https://b.com/sitemap_index.xml']);
});

test('expands a sitemap index, prefers product sitemaps, ignores non-product URLs and gz', async () => {
  const files = {
    'https://c.com/sitemap.xml': '<sitemapindex><loc>https://c.com/post-sitemap.xml</loc><loc>https://c.com/product-sitemap.xml</loc><loc>https://c.com/x.xml.gz</loc></sitemapindex>',
    'https://c.com/product-sitemap.xml': '<urlset><loc>https://c.com/product/deep-fryer-20l</loc><loc>https://c.com/product/gas-stove-4-burner</loc><loc>https://c.com/img/a.jpg</loc><loc>https://other.com/p</loc></urlset>',
    'https://c.com/post-sitemap.xml': '<urlset><loc>https://c.com/blog/news-post</loc></urlset>',
  };
  net.fetchText = async (u) => files[u] || (() => { throw new Error('404'); })();
  assert.deepEqual(await sm.productUrls(['https://c.com/sitemap.xml']), ['https://c.com/product/deep-fryer-20l', 'https://c.com/product/gas-stove-4-burner']);
});

test('generic sitemap without a product section: keeps slug-like pages, drops blog/category/short pages', async () => {
  net.fetchText = async () => '<urlset><loc>https://d.com/deep-fryer-20-litre</loc><loc>https://d.com/about</loc><loc>https://d.com/category/fryers/</loc><loc>https://d.com/blog/hello-world-post</loc></urlset>';
  assert.deepEqual(await sm.productUrls(['https://d.com/sitemap.xml']), ['https://d.com/deep-fryer-20-litre']);
});

test('site search: tries templates until one returns products, picks the right size, remembers the template', async () => {
  const tried = [];
  net.fetchText = async (u) => {
    tried.push(u);
    if (!u.includes('/search?q=')) throw new Error('404');
    return '<a href="/cart">Cart</a><a href="/products/deep-fryer-30l">Deep Fryer 30L</a><a href="/products/deep-fryer-20l">Deep Fryer 20L Commercial</a><a href="/about">About</a><a href="/products/deep-fryer-20l?add-to-cart=1">Buy</a>';
  };
  const r = await ss.search('shop.co.ke', 'Commercial Deep Fryer 20L');
  assert.ok(r.template.includes('/search?q='));
  assert.equal(r.results[0].url, 'https://shop.co.ke/products/deep-fryer-20l');
  assert.equal(r.results.find((x) => x.url.includes('30l')).conflicts.length, 1);
  tried.length = 0;
  await ss.search('shop.co.ke', 'Deep Fryer 20L', { known: r.template });
  assert.equal(tried.length, 1, 'known template is tried first');
});

test("real Yoast layout (Shine): index has product, product_cat and product_tag sitemaps; only real products are indexed", async () => {
  const files = {
    'https://shine.co.ke/sitemap_index.xml': ['post', 'page', 'elementskit_template', 'product', 'metform-form', 'category', 'product_cat', 'product_tag', 'author'].map((n) => `<sitemap><loc>https://shine.co.ke/${n}-sitemap.xml</loc></sitemap>`).join(''),
    'https://shine.co.ke/product-sitemap.xml': '<urlset><loc>https://shine.co.ke/product/commercial-electric-double-fryer/</loc><loc>https://shine.co.ke/product/two-burner-gas-stove/</loc></urlset>',
    'https://shine.co.ke/product_cat-sitemap.xml': '<urlset><loc>https://shine.co.ke/product-category/electric-fryers/</loc></urlset>',
    'https://shine.co.ke/product_tag-sitemap.xml': '<urlset><loc>https://shine.co.ke/product-tag/commercial-electric-double-fryer-kenya/</loc></urlset>',
    'https://shine.co.ke/post-sitemap.xml': '<urlset><loc>https://shine.co.ke/how-to-maintain-kitchen-appliances/</loc></urlset>',
  };
  const asked = [];
  net.fetchText = async (u) => { asked.push(u); return files[u] || (() => { throw new Error('404'); })(); };
  const urls = await sm.productUrls(['https://shine.co.ke/sitemap_index.xml']);
  assert.deepEqual(urls, ['https://shine.co.ke/product/commercial-electric-double-fryer/', 'https://shine.co.ke/product/two-burner-gas-stove/']);
  assert.ok(!asked.some((u) => /product_cat|product_tag|post-sitemap/.test(u)), 'category, tag and blog sitemaps are never even downloaded');
});

test('category/tag URLs are dropped even from a generic sitemap', async () => {
  net.fetchText = async () => '<urlset><loc>https://e.com/product-category/fryers/</loc><loc>https://e.com/product-tag/fryer-kenya/</loc><loc>https://e.com/product/deep-fryer-20-litre</loc></urlset>';
  assert.deepEqual(await sm.productUrls(['https://e.com/product-sitemap.xml']), ['https://e.com/product/deep-fryer-20-litre']);
});
