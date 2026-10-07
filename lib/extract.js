// Turns raw HTML into structured data: specs, headings, FAQs, JSON-LD. No dependencies.
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', deg: '°', times: '×', frac12: '½' };

function decode(s) {
  return String(s).replace(/&(#x?[0-9a-f]+|[a-z0-9]+);/gi, (m, e) => {
    if (e[0] === '#') {
      try {
        const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return String.fromCodePoint(n);
      } catch { return m; }
    }
    return ENT[e.toLowerCase()] ?? m;
  });
}
const clean = (s) => decode(String(s).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

function attrs(tag) {
  const out = {};
  tag.replace(/([a-zA-Z:_-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g, (_, k, a, b) => { out[k.toLowerCase()] = a ?? b; return ''; });
  return out;
}

function extractPage(html, url = '') {
  let host = '';
  try { host = new URL(url).hostname.replace(/^www\./, ''); } catch {}

  const ld = [];
  html.replace(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi, (_, j) => {
    try { ld.push(JSON.parse(j.trim())); } catch {}
    return '';
  });
  const nodes = [];
  const walk = (o) => {
    if (!o || typeof o !== 'object') return;
    if (Array.isArray(o)) return o.forEach(walk);
    nodes.push(o);
    if (o['@graph']) walk(o['@graph']);
  };
  ld.forEach(walk);
  const typesOf = (n) => [].concat(n['@type'] || []);
  const prod = nodes.find((n) => typesOf(n).includes('Product'));
  const faqLd = nodes.find((n) => typesOf(n).includes('FAQPage'));

  const metas = {};
  (html.match(/<meta\b[^>]*>/gi) || []).forEach((t) => {
    const a = attrs(t);
    const k = (a.name || a.property || '').toLowerCase();
    if (k && a.content !== undefined && !(k in metas)) metas[k] = decode(a.content).trim();
  });

  const body = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|svg|nav|footer|aside|form|iframe|template)\b[\s\S]*?<\/\1>/gi, ' ');

  const titleM = body.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const headings = [];
  body.replace(/<h([1-4])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_, l, t) => {
    const text = clean(t);
    if (text) headings.push({ level: +l, text });
    return '';
  });
  const h1 = (headings.find((h) => h.level === 1) || {}).text || '';

  // specs: 2-cell table rows, definition lists, "Label: value" list items, JSON-LD properties
  const specs = [];
  const seen = new Set();
  const addSpec = (label, value) => {
    label = clean(label).replace(/[:：]\s*$/, '');
    value = clean(value);
    if (!label || !value || label.length > 60 || value.length > 220) return;
    const k = label.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    specs.push({ label, value });
  };
  body.replace(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi, (_, row) => {
    const cells = [...row.matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((m) => m[1]);
    if (cells.length === 2) addSpec(cells[0], cells[1]);
    return '';
  });
  body.replace(/<dt\b[^>]*>([\s\S]*?)<\/dt>\s*<dd\b[^>]*>([\s\S]*?)<\/dd>/gi, (_, a, b) => { addSpec(a, b); return ''; });
  const bullets = [];
  body.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_, t) => {
    const text = clean(t);
    if (text.length < 4 || text.length > 220) return '';
    const m = text.match(/^([^:]{2,40}):\s*(.{1,170})$/);
    if (m) addSpec(m[1], m[2]); else if (!bullets.includes(text)) bullets.push(text);
    return '';
  });
  if (prod && Array.isArray(prod.additionalProperty)) {
    prod.additionalProperty.forEach((p) => p && p.name && addSpec(String(p.name), String(p.value ?? '')));
  }

  const paragraphs = [];
  body.replace(/<p\b[^>]*>([\s\S]*?)<\/p>/gi, (_, t) => {
    const text = clean(t);
    if (text.length >= 50) paragraphs.push(text);
    return '';
  });
  let text = [...paragraphs, ...bullets.slice(0, 40)].join('\n');
  if (text.length < 300) text = clean(body).slice(0, 8000);
  text = text.slice(0, 20000);
  const wordCount = text.split(/\s+/).filter(Boolean).length;

  let faqCount = 0;
  if (faqLd && faqLd.mainEntity) faqCount = [].concat(faqLd.mainEntity).length;
  if (!faqCount) faqCount = headings.filter((h) => /\?$/.test(h.text)).length;
  if (!faqCount) faqCount = (body.match(/<summary\b/gi) || []).length;

  const offer = prod && [].concat(prod.offers || [])[0];
  const brand = prod && (typeof prod.brand === 'object' ? prod.brand && prod.brand.name : prod.brand);
  return {
    url, host,
    title: titleM ? clean(titleM[1]) : '',
    metaDescription: metas.description || metas['og:description'] || '',
    h1, headings, specs, bullets: bullets.slice(0, 40),
    text, wordCount, faqCount,
    ldTypes: [...new Set(nodes.flatMap(typesOf))],
    productLd: prod ? { name: prod.name || '', brand: brand || '', sku: prod.sku || '', price: offer && offer.price, currency: offer && offer.priceCurrency } : null,
    hasSpecTable: specs.length >= 3,
    thin: wordCount < 80,
  };
}
function extractLinks(html, base) {
  const out = [];
  html.replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (_, a, t) => {
    const h = attrs('<a ' + a + '>').href;
    if (!h || /^(mailto|tel|javascript):/i.test(h)) return '';
    try { const u = new URL(decode(h), base); u.hash = ''; out.push({ url: u.href, text: clean(t) }); } catch {}
    return '';
  });
  return out;
}
module.exports = { extractPage, extractLinks, clean, decode };
