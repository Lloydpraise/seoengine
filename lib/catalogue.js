// Reads a competitor site (category page or sitemap) into a local catalogue of product pages.
const net = require('./net');
const { extractLinks } = require('./extract');

const { ASSET, NAV, parseLocs, hostOf } = require('./sitemap');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function collectLinks(startUrl, filter) {
  const host = hostOf(startUrl);
  let urls = [];
  if (/\.xml(\.gz)?(\?|$)/i.test(startUrl) || /sitemap/i.test(startUrl)) {
    let locs = parseLocs(await net.fetchText(startUrl));
    const kids = locs.filter((u) => /\.xml(\?|$)/i.test(u));
    if (kids.length) {
      locs = locs.filter((u) => !/\.xml(\?|$)/i.test(u));
      const pick = kids.filter((u) => /product/i.test(u));
      for (const k of (pick.length ? pick : kids).slice(0, 6)) {
        try { locs.push(...parseLocs(await net.fetchText(k)).filter((u) => !/\.xml/i.test(u))); } catch {}
      }
    }
    urls = locs;
  } else {
    const seen = new Set([startUrl]);
    const queue = [startUrl];
    for (let n = 0; queue.length && n < 6; n++) {
      const u = queue.shift();
      let html;
      try { html = await net.fetchText(u); } catch (e) { if (n === 0) throw e; continue; }
      for (const l of extractLinks(html, u)) {
        if (hostOf(l.url) !== host) continue;
        if (/([?&](page|p|paged)=\d+|\/page\/\d+)/i.test(l.url)) { if (!seen.has(l.url) && queue.length < 5) { seen.add(l.url); queue.push(l.url); } continue; }
        urls.push(l.url);
      }
    }
  }
  const f = String(filter || '').trim().toLowerCase();
  const out = [], seen = new Set([startUrl.replace(/\/$/, '')]);
  for (const u of urls) {
    const k = u.replace(/\/$/, '');
    if (seen.has(k) || hostOf(u) !== host || ASSET.test(u) || NAV.test(u) || (f && !u.toLowerCase().includes(f))) continue;
    seen.add(k); out.push(u);
  }
  return out;
}

const isProduct = (pg) => !!(pg.productLd || pg.specs.length >= 3 || (pg.h1 && pg.wordCount >= 150));
const slim = (pg) => ({
  url: pg.url, title: pg.title, h1: pg.h1, metaDescription: pg.metaDescription, specs: pg.specs.slice(0, 30),
  headings: pg.headings.slice(0, 25), wordCount: pg.wordCount, faqCount: pg.faqCount, ldTypes: pg.ldTypes || [], thin: pg.thin,
});

async function crawl({ startUrl, filter = '', max = 60, onProgress = () => {} }) {
  const urls = await collectLinks(startUrl, filter);
  if (!urls.length) throw new Error("No links found on that page. Use a category page that lists products, or the site's sitemap.xml.");
  const pages = [], failed = [];
  let i = 0, tried = 0;
  const limit = Math.min(max * 3, urls.length);
  const worker = async () => {
    while (pages.length < max && i < limit) {
      const u = urls[i++]; tried++;
      try { const pg = await net.fetchPage(u); if (isProduct(pg)) pages.push(slim(pg)); }
      catch (e) { failed.push(`${u}: ${e.message}`); }
      onProgress(tried, pages.length);
      await sleep(350);
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  return { pages: pages.slice(0, max), failed: failed.slice(0, 20), candidates: urls.length };
}

// Pages that best show "what a rich product page looks like" on this site
const richest = (pages, n = 8) => pages.filter((p) => !p.thin)
  .map((p) => ({ p, s: p.wordCount + 60 * p.headings.filter((h) => h.level === 2).length + 40 * p.faqCount + 15 * p.specs.length }))
  .sort((a, b) => b.s - a.s).slice(0, n).map((x) => x.p);

module.exports = { crawl, richest, hostOf };
