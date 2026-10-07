// All outbound HTTP lives here (easy to stub in tests).
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { extractPage } = require('./extract');
const browser = require('./browser');
const cfg = { useBrowser: false };
const setBrowser = (on) => { cfg.useBrowser = !!on; };
const browserOn = () => cfg.useBrowser && browser.available();
const fetchRendered = (url) => browser.render(url);

const CACHE = path.join(__dirname, '..', 'data', 'cache');
const UA = 'Mozilla/5.0 (compatible; KitchenAll-SEO-Research/1.0)';
const key = (u) => crypto.createHash('sha1').update(u).digest('hex');
const readCache = (u) => { try { return JSON.parse(fs.readFileSync(path.join(CACHE, key(u) + '.json'), 'utf8')); } catch { return null; } };

async function fetchPage(url, { maxAgeMs = 7 * 864e5, allowStale = false } = {}) {
  if (!/^https?:\/\//i.test(url)) throw new Error(`Not a valid link: ${url}`);
  const c = readCache(url);
  if (c && (allowStale || Date.now() - c.fetchedAt < maxAgeMs)) return c.page;
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'text/html,*/*', 'Accept-Language': 'en-KE,en;q=0.9' },
    timeout: 25000, size: 4e6, redirect: 'follow',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  let page = extractPage(await res.text(), res.url || url);
  if (page.thin && browserOn()) { try { const r = await browser.render(url); const p2 = extractPage(r.html, r.url || url); if (p2.wordCount > page.wordCount) page = p2; } catch {} }
  fs.mkdirSync(CACHE, { recursive: true });
  fs.writeFileSync(path.join(CACHE, key(url) + '.json'), JSON.stringify({ fetchedAt: Date.now(), page }));
  return page;
}

async function fetchText(url) {
  if (!/^https?:\/\//i.test(url)) throw new Error(`Not a valid link: ${url}`);
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html,application/xml,*/*', 'Accept-Language': 'en-KE,en;q=0.9' }, timeout: 25000, size: 8e6, redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

async function serper(endpoint, body) {
  if (!process.env.SERPER_API_KEY) throw new Error('SERPER_API_KEY is missing in .env');
  const res = await fetch(`https://google.serper.dev/${endpoint}`, {
    method: 'POST',
    headers: { 'X-API-KEY': process.env.SERPER_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Serper ${endpoint} error ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

// Kenya-targeted Google results
const serperSearch = (q) => serper('search', { q, gl: 'ke', hl: 'en', location: 'Kenya', num: 10 });

async function serperLens(url) {
  const json = await serper('lens', { url });
  const raw = json.organic || json.visualMatches || json.images || json.results || [];
  return raw.slice(0, 15).map((m) => ({ title: m.title || m.name || '', source: m.source || m.domain || '' }));
}
module.exports = { fetchPage, fetchText, setBrowser, browserOn, fetchRendered, serperSearch, serperLens };
