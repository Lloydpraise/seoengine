// Applies the sales-voice rewrites (rewrite/batch-XX.js) to claude-drafts/batch-XX.json and runs the engine's QA on each page.
// Usage: node claude-drafts/rewrite/apply.js 01 [02 ...]   (no args = all batches that have a rewrite file)
const fs = require('fs');
const path = require('path');
const qa = require('../../lib/qa');

const dir = path.join(__dirname, '..');
const batches = process.argv.slice(2).length ? process.argv.slice(2) : fs.readdirSync(__dirname).filter((f) => /^batch-\d+\.js$/.test(f)).map((f) => f.slice(6, 8));
const STAMP = '2026-10-22T18:00:00Z';
const all = [];
let errors = 0;

for (const b of batches) {
  const file = path.join(dir, `batch-${b}.json`);
  const drafts = JSON.parse(fs.readFileSync(file, 'utf8'));
  const rw = require(path.join(__dirname, `batch-${b}.js`));
  for (const d of drafts) {
    const r = rw[d.id];
    if (!r) { console.log(`batch ${b}: no rewrite for ${d.id} ${d.name}`); errors++; continue; }
    const allowed = [d.name, d.photo_check, d.competitor_check, qa.bodyText(d), (d.specs || []).map((s) => `${s.label} ${s.value}`).join(' '), d.seo_title, d.meta_description].join('\n');
    if (r.title) d.seo_title = r.title;
    if (r.h1) d.h1 = r.h1;
    d.meta_description = r.meta;
    d.short_description = r.short;
    d.sections = r.sections.map(([heading, body]) => ({ heading, body }));
    d.faqs = r.faqs.map(([q, a]) => ({ q, a }));
    d.drafted_at = STAMP;
    const res = qa.check(d, { allowedText: allowed, targets: { wordsMin: 350, sectionsMin: 4, faqMin: 4 } });
    const bad = res.issues.filter((i) => i.level === 'error' || ['kw_meta', 'kw_h1', 'kw_intro', 'kenya', 'fluff', 'unsupported_numbers', 'meta_short', 'words_low'].includes(i.code));
    if (bad.length) { console.log(`${d.id} ${d.name}: ${bad.map((i) => i.msg).join(' | ')}`); if (bad.some((i) => i.level === 'error')) errors++; }
    if (!d.sections.some((s) => /^Why Buy/i.test(s.heading))) { console.log(`${d.id}: missing Why Buy section`); errors++; }
    if (!d.faqs.some((f) => /^Where can I buy/i.test(f.q))) { console.log(`${d.id}: missing Where can I buy FAQ`); errors++; }
    all.push({ name: d.name, text: qa.bodyText(d), d, b });
  }
  fs.writeFileSync(file, JSON.stringify(drafts, null, 2) + '\n');
  console.log(`batch ${b}: ${drafts.length} drafts written`);
}

// The "Why buy" sections share a theme, so make sure no two pages read the same overall.
for (const x of all) {
  const mine = qa.shingles(x.text);
  let max = 0, w = '';
  for (const y of all) if (y !== x) { const c = qa.containment(mine, qa.shingles(y.text)); if (c > max) { max = c; w = y.name; } }
  if (max > 0.2) console.log(`${x.d.id} ${x.name}: ${Math.round(max * 100)}% similar to ${w}`);
}
console.log(errors ? `${errors} problem(s)` : 'all clean');
process.exitCode = errors ? 1 : 0;
