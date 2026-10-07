// Uses a competitor's own search box (plain URL) to find the page for a product. Free: no Google credits.
const net = require('./net');
const { extractLinks } = require('./extract');
const { ASSET, NAV, hostOf } = require('./sitemap');
const match = require('./match');

const TEMPLATES = [
  'https://{host}/?s={q}&post_type=product', // WooCommerce / WordPress
  'https://{host}/search?q={q}', // Shopify and many others
  'https://{host}/catalogsearch/result/?q={q}', // Magento
  'https://{host}/index.php?route=product/search&search={q}', // OpenCart
  'https://{host}/?s={q}',
  'https://{host}/search/?q={q}',
];
const NOISE = /(add-to-cart|orderby|wishlist|compare|[?&](sort|filter|min_price|max_price|page|paged)=|#)/i;

async function search(host, query, { known } = {}) {
  const tpls = known ? [known, ...TEMPLATES.filter((t) => t !== known)] : TEMPLATES;
  for (const t of tpls) {
    const url = t.replace('{host}', host).replace('{q}', encodeURIComponent(query));
    let html;
    try { html = await net.fetchText(url); } catch { continue; }
    let links = extractLinks(html, url);
    if (!links.length && net.browserOn()) { try { links = extractLinks((await net.fetchRendered(url)).html, url); } catch {} }
    const seen = new Set();
    const scored = links
      .filter((l) => hostOf(l.url) === hostOf(url) && !ASSET.test(l.url) && !NAV.test(new URL(l.url).pathname) && !NOISE.test(l.url) && l.url !== url && !seen.has(l.url) && seen.add(l.url))
      .map((l) => ({ url: l.url, text: l.text, ...match.score(query, { title: l.text, url: l.url }) }))
      .filter((x) => x.tok >= 0.34)
      .sort((a, b) => b.score - a.score).slice(0, 5);
    if (scored.length) return { template: t, results: scored };
  }
  return { template: null, results: [] };
}
module.exports = { search, TEMPLATES };
