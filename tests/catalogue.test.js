const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('../lib/net');
const { crawl, richest } = require('../lib/catalogue');
const { extractLinks } = require('../lib/extract');

const CATEGORY = `<a href="/product/fryer-20l">Fryer 20L</a><a href="/product/fryer-30l/">Fryer 30L</a><a href="/cart">Cart</a><a href="/img/x.jpg">img</a>
<a href="https://other.com/x">ext</a><a href="/product/fryer-20l">dup</a><a href="/fryers/page/2">Next</a><a href="/about">About</a>`;
const PAGE2 = `<a href="/product/stove-4">Stove</a>`;
const page = (u, specs = 4) => ({ url: u, title: u, h1: u, metaDescription: '', specs: Array.from({ length: specs }, (_, i) => ({ label: 'a' + i, value: 'b' })), headings: [{ level: 2, text: 'x' }], wordCount: 300, faqCount: 1, ldTypes: [], thin: false, bullets: [], text: '', productLd: null });

test('extractLinks resolves relative links', () => {
  assert.equal(extractLinks('<a href="/a/b#x">Hi</a>', 'https://s.com/c/')[0].url, 'https://s.com/a/b');
});

test('crawl: follows pagination, drops cart/assets/external/duplicates, keeps product pages only', async () => {
  net.fetchText = async (u) => (u.includes('/page/2') ? PAGE2 : CATEGORY);
  const fetched = [];
  net.fetchPage = async (u) => { fetched.push(u); if (u.includes('stove')) return { ...page(u, 0), h1: '', wordCount: 20 }; return page(u); };
  const r = await crawl({ startUrl: 'https://comp.co.ke/fryers/', max: 10 });
  assert.deepEqual(fetched.sort(), ['https://comp.co.ke/product/fryer-20l', 'https://comp.co.ke/product/fryer-30l/', 'https://comp.co.ke/product/stove-4']);
  assert.equal(r.pages.length, 2, 'stove page had no specs and little content so it is not treated as a product');
});

test('crawl reads sitemaps, including child sitemaps, with a link filter', async () => {
  net.fetchText = async (u) => (u.endsWith('index.xml') ? '<sitemapindex><loc>https://c.com/product-sitemap.xml</loc><loc>https://c.com/post-sitemap.xml</loc></sitemapindex>' : '<urlset><loc>https://c.com/product/a</loc><loc>https://c.com/blog/b</loc></urlset>');
  net.fetchPage = async (u) => page(u);
  const r = await crawl({ startUrl: 'https://c.com/index.xml', filter: '/product/', max: 5 });
  assert.deepEqual(r.pages.map((p) => p.url), ['https://c.com/product/a']);
});

test('richest picks the deepest pages for learning a style', () => {
  const ps = [{ ...page('a'), wordCount: 100 }, { ...page('b'), wordCount: 900 }, { ...page('c'), wordCount: 500, thin: true }];
  assert.equal(richest(ps, 1)[0].url, 'b');
});
