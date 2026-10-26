// Reads (never writes) data/store.json and saves the 87 published, non-Claude products with SEO to work/source.json.
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..', '..');
const s = JSON.parse(fs.readFileSync(path.join(root, 'data', 'store.json'), 'utf8'));
const ids = new Set();
fs.readdirSync(path.join(root, 'claude-drafts')).filter((f) => /^batch-0[1-7]\.json$/.test(f))
  .forEach((f) => JSON.parse(fs.readFileSync(path.join(root, 'claude-drafts', f), 'utf8')).forEach((d) => ids.add(String(d.id))));
const out = Object.values(s.products)
  .filter((p) => p.supabaseId && !ids.has(String(p.supabaseId)) && (p.final || p.draft) && ['published', 'approved'].includes(p.status))
  .sort((a, b) => a.supabaseId - b.supabaseId)
  .map((p) => ({
    id: p.supabaseId, name: p.name, slug: p.slug, image_url: p.imageUrl || '', major_category: p.major_category || '', sub_category: p.sub_category || '',
    sources: (p.sourceLinks || []).map((l) => l.url), unique: p.unique || '',
    facts: (p.facts && p.facts.facts || []).map((f) => `- ${f.label}: ${f.value} [${(f.hosts || []).join(', ') || 'source'}; ${f.confidence}]`).join('\n'),
    final: p.final || p.draft,
  }));
fs.writeFileSync(path.join(__dirname, 'work', 'source.json'), JSON.stringify(out, null, 1));
console.log(out.length, 'products');
