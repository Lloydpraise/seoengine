// Finds a competitor's sitemap from just its domain and lists its product URLs (no page fetching).
const net = require('./net');

const ASSET = /\.(jpe?g|png|gif|webp|svg|pdf|css|js|ico|zip|mp4|gz)(\?|$)/i;
const NAV = /\/(cart|checkout|my-account|account|login|register|wishlist|contact|about|blog|news|tag|search|privacy|terms|faq|cdn-cgi|feed|category|categories|collections?|brand|page)(\/|$|\?)/i;
const COMMON = ['/sitemap.xml', '/sitemap_index.xml', '/wp-sitemap.xml', '/sitemap-index.xml', '/product-sitemap.xml', '/sitemap_products_1.xml', '/sitemap-products.xml', '/sitemaps/sitemap.xml'];
// product-sitemap.xml / wp-sitemap-posts-product-1.xml / sitemap_products_1.xml, but NOT product_cat / product_tag / brand sitemaps
const isProductMap = (u) => /(^|\/)(wp-sitemap-posts-product-\d+|products?-sitemap\d*|sitemap[-_]products?[-_]?\d*)\.xml/i.test(u);
const isOtherMap = (u) => /(post|page|author|elementskit|metform|form|attachment|category|categories|cat|tag|brand|collection|attribute|blog)[-_.]?sitemap|sitemap[-_.](post|page|author|collection|blog)|(^|\/)(post|page|author|category|product_cat|product_tag|product-cat|product-tag)[-_]/i.test(u);
const NONPRODUCT = /\/(product-category|product-tag|product_cat|product_tag|category|tag|brand)\//i;
const isXml = (u) => /\.xml(\?|$)/i.test(u);
const parseLocs = (xml) => [...xml.matchAll(/<loc>\s*(?:<!\[CDATA\[)?\s*([^<\s\]]+)/gi)].map((m) => m[1]);
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
const isSitemapUrl = (u) => isXml(u) || /sitemap/i.test(u);

function origin(input) {
  const t = String(input).trim();
  return new URL(/^https?:\/\//i.test(t) ? t : 'https://' + t).origin;
}

async function discover(input) {
  const o = origin(input);
  const found = [];
  try { for (const m of (await net.fetchText(o + '/robots.txt')).matchAll(/^\s*sitemap:\s*(\S+)/gim)) found.push(m[1]); } catch {}
  if (!found.length) {
    for (const p of COMMON) {
      try { if (/<loc>/i.test(await net.fetchText(o + p))) { found.push(o + p); break; } } catch {}
    }
  }
  return [...new Set(found)];
}

// Product-looking URLs from one or more sitemaps (expands sitemap indexes, prefers "product" child sitemaps)
async function productUrls(sitemaps, { filter = '', limit = 20000 } = {}) {
  const host = hostOf(sitemaps[0]);
  const visited = new Set(), urls = [];
  let usedProductSitemap = false;
  const load = async (u) => {
    if (visited.has(u) || visited.size > 40 || /\.gz(\?|$)/i.test(u)) return;
    visited.add(u);
    let xml;
    try { xml = await net.fetchText(u); } catch { return; }
    const locs = parseLocs(xml);
    const kids = locs.filter(isXml);
    if (kids.length) {
      const prod = kids.filter(isProductMap);
      if (prod.length) usedProductSitemap = true;
      const pool = prod.length ? prod : kids.filter((k) => !isOtherMap(k));
      for (const k of (pool.length ? pool : kids).slice(0, 15)) await load(k);
    }
    locs.filter((l) => !isXml(l)).forEach((l) => urls.push(l));
  };
  for (const s of sitemaps) await load(s);
  if (sitemaps.some(isProductMap)) usedProductSitemap = true;
  const f = String(filter).trim().toLowerCase();
  const out = [], seen = new Set();
  for (const u of urls) {
    if (seen.has(u) || hostOf(u) !== host || ASSET.test(u) || NONPRODUCT.test(u)) continue;
    let path = '';
    try { path = new URL(u).pathname; } catch { continue; }
    const last = path.split('/').filter(Boolean).pop() || '';
    if (f && !u.toLowerCase().includes(f)) continue;
    // without a product sitemap or a filter, keep only slug-like URLs and drop obvious non-product sections
    if (!usedProductSitemap && !f && (NAV.test(path) || !/-/.test(last) || last.length < 8)) continue;
    seen.add(u); out.push(u);
    if (out.length >= limit) break;
  }
  return out;
}
module.exports = { discover, productUrls, parseLocs, isSitemapUrl, ASSET, NAV, hostOf };
