// Kenya-specific SEO: search data harvesting + competitor source selection + writing rules.
const net = require('./net');
const match = require('./match');

const KENYA_RULES = `KENYA SEO RULES
- Write for buyers searching Google Kenya. Target phrasing such as "[product] price in Kenya", "buy [product] Nairobi", "[product] for sale in Kenya", "commercial [product] Kenya".
- Use British English and metric units (litres, kg, kW, mm). Prices in KES (write "KES"), but never state a price unless it is given in the facts.
- Mention Kenya or Nairobi naturally (title or meta and once in the body), plus delivery across Kenya when SHOP KNOWLEDGE supports it. Never invent branches, delivery times, or warranty terms.
- Where relevant and supported by the facts, use local context: KPLC single-phase vs three-phase power, LPG vs electric, generator back-up, hotels, restaurants, butcheries, bakeries, institutions, juakali-fabricated stainless steel.
- Local terms buyers use are fine if they fit the product (e.g. jiko, juakali, sufuria).`;

const SKIP_HOSTS = /(youtube|facebook|instagram|pinterest|tiktok|twitter|x\.com|reddit|quora|wikipedia|linkedin|amazon|ebay|walmart|aliexpress)\./i;

const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
const hostMatches = (h, pref) => h === pref || h.endsWith('.' + pref);

// "Kenya" goes after every Google keyword: it pulls Kenyan shops and Kenyan phrasing to the top. (The competitor sites' own search
// boxes are NOT given it: they need every word to be in the product text, so an extra word would hide products.)
const withKenya = (q) => (/\bkenya\b/i.test(q) ? q : `${q} Kenya`);

async function harvest(name, { preferredHosts = [] } = {}) {
  const base = [`${name} price in Kenya`, `buy ${name} Nairobi`, `${name} specifications`].map(withKenya);
  const pref = preferredHosts.slice(0, 4).map((h) => `site:${h} ${name}`);
  const out = { organic: [], preferred: [], related: [], questions: [], errors: [], attempted: base.length + pref.length };
  for (const q of [...base, ...pref]) {
    try {
      const isSite = q.startsWith('site:');
      let r = await net.serperSearch(isSite ? withKenya(q) : q);
      // a site: search that comes back empty with "Kenya" added is repeated once without it, so a shop whose pages never say Kenya is not missed
      if (isSite && !(r.organic || []).length) r = await net.serperSearch(q);
      const target = isSite ? out.preferred : out.organic;
      (r.organic || []).slice(0, 8).forEach((o) => target.push({ title: o.title || '', link: o.link || '', snippet: o.snippet || '' }));
      if (!isSite) {
        (r.relatedSearches || []).forEach((x) => x.query && out.related.push(x.query));
        (r.peopleAlsoAsk || []).forEach((x) => x.question && out.questions.push(x.question));
      }
    } catch (e) { out.errors.push(e.message); }
  }
  const uniq = (a) => [...new Set(a)];
  out.related = uniq(out.related).slice(0, 12);
  out.questions = uniq(out.questions).slice(0, 8);
  const seen = new Set();
  const dedupe = (arr) => arr.filter((o) => o.link && !seen.has(o.link) && seen.add(o.link));
  out.preferred = dedupe(out.preferred);
  out.organic = dedupe(out.organic);
  return out;
}

const isKenyan = (o) =>
  /^https?:\/\/[^/]+\.ke(\/|$)/i.test(o.link) || /\b(ksh|kes|nairobi|kenya|mombasa)\b/i.test(`${o.title} ${o.snippet}`);

/**
 * Choose competitor pages. Ranked by (1) your preferred sites, in your order, then (2) how well the result
 * matches YOUR product's size/specs, not by where Google happened to rank it. Wrong-size results are dropped.
 * Keeps a mix of Kenyan and international pages when there is room.
 */
function pickSources(organic, ownSiteUrl, existingUrls = [], opts = {}) {
  const { name = '', limit = 3, preferredHosts = [], preferred = [] } = opts;
  const own = hostOf(ownSiteUrl);
  const have = new Set(existingUrls);
  const seen = new Set();
  const cands = [];
  for (const o of [...preferred, ...organic]) {
    const h = hostOf(o.link);
    if (!h || seen.has(o.link) || have.has(o.link) || h === own) continue;
    const pi = preferredHosts.findIndex((p) => hostMatches(h, p));
    if (SKIP_HOSTS.test(h + '.') && pi < 0) continue;
    seen.add(o.link);
    const fit = name ? match.score(name, { title: o.title, metaDescription: o.snippet, url: o.link }) : { score: 0.5, conflicts: [] };
    if (fit.conflicts.length) continue; // different size / model
    cands.push({ ...o, host: h, prefRank: pi, fit: fit.score, kenyan: isKenyan(o), order: cands.length });
  }
  const byFit = (a, b) => b.fit - a.fit || a.order - b.order;
  const picks = [];
  const take = (c) => { if (c && !picks.includes(c) && picks.length < limit) picks.push(c); };
  // 1. one best page per preferred site, in your order
  [...new Set(cands.filter((c) => c.prefRank >= 0).map((c) => c.prefRank))].sort((a, b) => a - b)
    .forEach((r) => take(cands.filter((c) => c.prefRank === r).sort(byFit)[0]));
  // 2. balance: best Kenyan + best international
  const rest = cands.filter((c) => !picks.includes(c)).sort(byFit);
  take(rest.find((c) => c.kenyan));
  take(rest.find((c) => !c.kenyan));
  // 3. fill with best remaining
  rest.forEach(take);
  return picks;
}

module.exports = { KENYA_RULES, harvest, pickSources, withKenya };
