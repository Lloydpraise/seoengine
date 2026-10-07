// Attribute-aware matching: "Fryer 20L" must not match a 30L page, "4 burner" must not match "6 burner".
const { similarity } = require('./csvmatch');

const UMAP = { litre: 'l', litres: 'l', liter: 'l', liters: 'l', ltr: 'l', ltrs: 'l', l: 'l', kg: 'kg', kgs: 'kg', g: 'g', kw: 'kw', w: 'w', v: 'v', hz: 'hz', mm: 'mm', cm: 'cm',
  burner: 'burner', burners: 'burner', plate: 'plate', plates: 'plate', door: 'door', doors: 'door', tray: 'tray', trays: 'tray', deck: 'deck', decks: 'deck',
  tier: 'tier', tiers: 'tier', shelf: 'shelf', shelves: 'shelf', gn: 'gn', pan: 'pan', pans: 'pan', head: 'head', heads: 'head' };
const UNIT_RE = /(\d+(?:\.\d+)?)\s*(litres?|liters?|ltrs?|ltr|l|kgs?|kg|g|kw|w|v|hz|mm|cm|burners?|plates?|doors?|trays?|decks?|tiers?|shelf|shelves|gn|pans?|heads?)(?![a-z])/g;

function attrsOf(text) {
  const t = String(text).toLowerCase().replace(/(\d),(\d{3})/g, '$1$2').replace(/(\d)-(?=[a-z])/g, '$1 ');
  const out = {};
  for (const m of t.matchAll(UNIT_RE)) (out[UMAP[m[2]] || m[2]] ??= new Set()).add(String(+m[1]));
  return out;
}

const slug = (u) => { try { return new URL(u).pathname.replace(/[-_/]+/g, ' '); } catch { return ''; } };

/** How well does a competitor page (or search result) describe OUR product? */
function score(name, page) {
  const ours = attrsOf(name);
  const specs = (page.specs || []).map((s) => `${s.label} ${s.value}`).join(' ');
  const text = `${page.title || ''} ${page.h1 || ''} ${page.metaDescription || ''} ${specs} ${slug(page.url || '')}`;
  const theirs = attrsOf(text);
  const agree = [], conflicts = [];
  let missing = 0;
  for (const u of Object.keys(ours)) {
    if (!theirs[u]) missing++;
    else if ([...ours[u]].some((n) => theirs[u].has(n))) agree.push(u);
    else conflicts.push({ unit: u, ours: [...ours[u]].join('/'), theirs: [...theirs[u]].slice(0, 4).join('/') });
  }
  const n = Object.keys(ours).length;
  const attrScore = n ? (agree.length + 0.3 * missing) / n : 0.5;
  const tok = similarity(name, `${page.title || ''} ${page.h1 || ''} ${slug(page.url || '')}`);
  let s = 0.6 * tok + 0.4 * attrScore;
  if (conflicts.length) s = Math.min(s, 0.45);
  return { score: +s.toFixed(2), tok: +tok.toFixed(2), conflicts, agree, missing };
}
const conflictText = (c) => c.map((x) => `${x.unit.toUpperCase()}: theirs ${x.theirs}, yours ${x.ours}`).join('; ');
const slugTitle = (u) => { try { return new URL(u).pathname.split('/').filter(Boolean).pop().replace(/[-_]+/g, ' '); } catch { return ''; } };
module.exports = { attrsOf, score, conflictText, slugOf: slug, slugTitle };
