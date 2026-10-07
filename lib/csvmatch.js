// CSV parsing + fuzzy matching of sheet rows to products.
function parseCsv(text) {
  text = String(text).replace(/^\uFEFF/, '');
  const firstLine = text.split(/\r?\n/, 1)[0] || '';
  const delim = [',', ';', '\t'].map((d) => [d, firstLine.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = [];
  let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === delim) { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cur); cur = '';
      if (row.some((x) => x.trim())) rows.push(row);
      row = [];
    } else cur += c;
  }
  row.push(cur);
  if (row.some((x) => x.trim())) rows.push(row);
  if (!rows.length) return [];
  const head = rows[0].map((h) => h.trim().toLowerCase());
  return rows.slice(1).map((r) => Object.fromEntries(head.map((h, i) => [h, (r[i] || '').trim()])));
}

const STOP = new Set(['the', 'a', 'an', 'and', 'of', 'for', 'with', 'in', 'to', 'commercial']);
const tokens = (s) => new Set(String(s).toLowerCase().replace(/\.(jpe?g|png|webp)$/i, '').replace(/(\d)\s*(litres?|liters?|ltrs?|ltr|l|kgs?|kw|w|v|mm|cm)\b/g, (m, d, u) => d + (/^lit|^ltr/.test(u) ? 'l' : u.replace(/^kgs$/, 'kg'))).replace(/[^a-z0-9]+/g, ' ').split(' ').filter((t) => t && !STOP.has(t)));
function similarity(a, b) {
  const A = tokens(a), B = tokens(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  const jac = inter / (A.size + B.size - inter);
  const cont = inter / Math.min(A.size, B.size);
  return Math.max(jac, cont * 0.85);
}

const pick = (o, names) => { for (const n of names) if (o[n]) return o[n]; return ''; };
const URL_RE = /https?:\/\/[^\s,;|"'<>]+/gi;

function parseRow(o) {
  const links = [];
  for (const [k, v] of Object.entries(o)) {
    if (/link|url|competitor|source|reference/.test(k)) (String(v).match(URL_RE) || []).forEach((u) => !links.includes(u) && links.push(u));
  }
  return {
    name: pick(o, ['product', 'name', 'title', 'product_name', 'product name', 'sku']),
    filename: pick(o, ['filename', 'file', 'image', 'file_name']),
    links,
    knowledge: pick(o, ['knowledge', 'notes', 'info', 'unique', 'product_info', 'our_notes', 'expertise']),
    major_category: pick(o, ['major_category', 'category', 'major category']),
    sub_category: pick(o, ['sub_category', 'sub category', 'subcategory']),
    profile: pick(o, ['profile', 'style', 'style_profile']),
  };
}

function matchRows(rows, products) {
  return rows.map((o, index) => {
    const parsed = parseRow(o);
    let best = null;
    const alts = [];
    for (const p of products) {
      let score = 0, how = '';
      if (parsed.filename && p.localImage && parsed.filename.toLowerCase() === p.localImage.toLowerCase()) { score = 1; how = 'filename'; }
      else if (parsed.name && p.name && parsed.name.toLowerCase() === p.name.toLowerCase()) { score = 1; how = 'exact name'; }
      else {
        const s = Math.max(parsed.name && p.name ? similarity(parsed.name, p.name) : 0,
          parsed.filename && p.localImage ? similarity(parsed.filename, p.localImage) : 0);
        score = s; how = 'similar name';
      }
      if (score >= 0.5) alts.push({ id: p.id, name: p.name || p.localImage, score: +score.toFixed(2), how });
    }
    alts.sort((a, b) => b.score - a.score);
    best = alts[0] || null;
    const confidence = !best ? 'none' : best.score >= 0.8 ? 'high' : 'low';
    return { index, parsed, match: best, alternatives: alts.slice(0, 4), confidence };
  });
}
module.exports = { parseCsv, parseRow, matchRows, similarity, tokens };
