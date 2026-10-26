// Builds claude-drafts/batch-08.json onward from the published products' existing SEO (work/source.json)
// plus the sales-voice rewrites in rewrite/sales-*.js, then checks every draft.
// Usage: node claude-drafts/rewrite/build.js
const fs = require('fs'), path = require('path');
const qa = require('../../lib/qa');

const src = require('./work/source.json');
const fixes = require('./fixes');
const rw = {};
fs.readdirSync(__dirname).filter((f) => /^sales-\d+\.js$/.test(f)).forEach((f) => Object.assign(rw, require(path.join(__dirname, f))));

const QUALITY_SS = ['Quality stainless steel work. Our stainless steel equipment is made from high quality stainless steel with strong, neat welds and smooth, food-safe finishing. It stays hygienic, resists rust and keeps looking good after years of daily use.', 'Stainless steel you can rely on. We work with high quality stainless steel and finish every joint and edge properly, so the equipment is easy to clean, safe to handle and built to last in a busy kitchen.', 'Built properly from quality stainless steel. Thick, high quality stainless steel, clean welds and careful finishing mean equipment that does not rust, does not harbour dirt and serves your business for years.'];
const QUALITY_OTHER = ['High quality products. We stock equipment chosen for strength and long life in Kenyan working conditions, and we check every unit before it leaves our store.', 'Products we stand behind. Every item we sell is selected for build quality and durability, so you get equipment that keeps working day after day.', 'Quality first. We source and check our equipment for solid build and reliable performance, because your business depends on it working every day.'];
const COMPLY = ['Ready for inspection. We supply equipment that meets Kenyan government and public health requirements, so your premises are ready when health and safety officers visit.', 'Meets health and safety standards. Our products are supplied to meet government, public health and food safety regulations, giving you peace of mind during licensing and inspections.', 'Compliant and safe. We provide equipment that passes government and health regulations, so you can open, renew licences and pass inspections with confidence.'];
const GUIDE = ['Guidance at every step. Our team is professional and hands-on: we help you choose the right model and size, plan your layout{inst} and answer questions after you buy.', 'Professional advice from start to finish. Tell us about your business and we will recommend the right equipment, help you plan the space{inst} and support you after delivery.', 'Expert help whenever you need it. From choosing the right size to setting up{inst} and day-to-day use, our professional team guides you at every step.'];
const DELIVER = ['Quick delivery. Delivery is free within Nairobi, and we deliver quickly to all other parts of Kenya with shipping charges.', 'Fast, reliable delivery. We deliver free within Nairobi and dispatch quickly to the rest of Kenya, with shipping charges outside Nairobi.', 'Delivered fast. Free delivery within Nairobi, and quick delivery countrywide with shipping charges applying outside Nairobi.'];
const WHERE = ['You can buy it directly from Kitchen And All at kitchenandall.co.ke or by calling or messaging our team. We offer free delivery within Nairobi, quick delivery across Kenya with shipping charges, and professional guidance before and after you buy.', 'Order it from Kitchen And All on kitchenandall.co.ke, or talk to our team for advice first. Delivery is free within Nairobi and quick to the rest of Kenya with shipping charges.', 'Kitchen And All sells it online at kitchenandall.co.ke, and our team is ready to advise you on the right option. We deliver free within Nairobi and quickly countrywide with shipping charges.'];

const INSTALL = /hood|canopy|cooking unit|hotline|oven|sink|drain|grease trap|urinal|railing|cold room|balustrade|exhaust|duct/i;
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9\s.]/g, ' ').replace(/\s+/g, ' ').trim();
const wordsOf = (d) => qa.countWords(d);
// "Butcher Bone Saw 20 Inch Kenya" -> "butcher bone saw 20 inch": readable inside a question
const kwForQuestion = (k) => String(k).replace(/\s+(price\s+)?(in\s+)?(kenya|nairobi)$/i, '').split(' ').map((w) => w.split('-').map((x) => (/^[A-Z][a-z]+$/.test(x) ? x.toLowerCase() : x)).join('-')).join(' ');
const article = (k) => (/^[aeiou]/i.test(k) && !/^(uni|use|eu)/i.test(k) ? 'an' : 'a');

const STAMP = '2026-10-22T19:00:00Z';
const out = [], problems = [], retention = [];
for (const p of src) {
  const r = rw[p.id];
  if (!r) { problems.push(`${p.id} ${p.name}: no rewrite yet`); continue; }
  const f = p.final, i = p.id % 3;
  const ss = r.ss !== undefined ? r.ss : /stainless/i.test(`${p.name} ${f.specs.map((s) => s.value).join(' ')} ${p.major_category}`);
  const inst = r.inst !== undefined ? r.inst : INSTALL.test(`${p.name} ${p.sub_category}`);
  const why = [r.why, (ss ? QUALITY_SS : QUALITY_OTHER)[i], COMPLY[i], GUIDE[i].replace('{inst}', inst ? ' and installation' : ''), DELIVER[i]].join('\n\n');

  const rest = f.sections.slice(1);
  let di = -1;
  rest.forEach((s, k) => { if (/deliver/i.test(s.heading) && !/care|mainten/i.test(s.heading)) di = k; });
  const sections = [{ heading: 'Key Features and Benefits', body: r.feat }];
  rest.forEach((s, k) => sections.push(k === di ? { heading: 'Why Buy from Kitchen And All', body: why } : { heading: s.heading, body: s.body }));
  if (di < 0) sections.push({ heading: 'Why Buy from Kitchen And All', body: why });

  const qk = r.faqk || kwForQuestion(f.primary_keyword);
  const faqs = [{ q: `Where can I buy ${r.faqk ? qk : `${article(qk)} ${qk}`} in Kenya?`, a: WHERE[i] },
    ...f.faqs.filter((x) => !/^where can i buy/i.test(x.q) && !(/deliver/i.test(x.q) && /outside|across|other|counties|kenya|nairobi/i.test(x.q)))];

  // One brand name everywhere, including the sections and FAQs carried over unchanged
  const brand = (s) => String(s).replace(/KitchenAll/g, 'Kitchen And All');
  sections.forEach((s) => { s.heading = brand(s.heading); s.body = brand(s.body); });
  faqs.forEach((x) => { x.q = brand(x.q); x.a = brand(x.a); });
  const d = {
    id: p.id, name: p.name, slug: p.slug, current_slug: p.slug,
    primary_keyword: f.primary_keyword, secondary_keywords: f.secondary_keywords, seo_title: f.seo_title,
    meta_description: r.meta, h1: f.h1, short_description: r.short, sections, specs: f.specs, faqs, alt_text: f.alt_text,
    photo_check: 'Existing SEO rewritten in sales voice; facts unchanged.', competitor_check: '', sources: p.sources, owner_questions: [],
    image_url: p.image_url, major_category: p.major_category, sub_category: p.sub_category, drafted_at: STAMP,
  };

  if (fixes[p.id]) fixes[p.id](d);

  // QA exactly as the engine runs it after import (allowed text = name + facts + product notes)
  const allowed = [p.name, p.facts, p.unique, d.photo_check].join('\n');
  const before = qa.check(f, { allowedText: allowed }), after = qa.check(d, { allowedText: allowed });
  const errs = (x) => new Set(x.issues.filter((k) => k.level === 'error').map((k) => k.code));
  const newErr = after.issues.filter((k) => k.level === 'error' && !errs(before).has(k.code));
  if (newErr.length) problems.push(`${p.id} ${p.name}: new QA error ${newErr.map((k) => k.msg).join(' | ')}`);
  const oldErr = after.issues.filter((k) => k.level === 'error' && errs(before).has(k.code));
  if (oldErr.length) problems.push(`${p.id} ${p.name}: QA error carried over from the old copy: ${oldErr.map((k) => k.msg).join(' | ')}`);

  const kw = norm(f.primary_keyword);
  const m = d.meta_description.length;
  if (m < 110 || m > 155) problems.push(`${p.id}: meta is ${m} chars`);
  if (!norm(d.meta_description).includes(kw)) problems.push(`${p.id}: primary keyword not in meta`);
  if (!norm(d.short_description.split(/(?<=[.!?])\s+/).slice(0, 2).join(' ')).includes(kw)) problems.push(`${p.id}: primary keyword not in first two sentences of intro`);
  if (!norm(r.feat).includes(kw)) problems.push(`${p.id}: primary keyword not in features`);
  if (wordsOf(d) < wordsOf(f)) problems.push(`${p.id}: words dropped ${wordsOf(f)} -> ${wordsOf(d)}`);

  const oldText = norm([f.meta_description, f.short_description, f.sections[0].body].join(' '));
  const newText = norm([d.meta_description, d.short_description, r.feat].join(' '));
  for (const k of [f.primary_keyword, ...f.secondary_keywords]) if (oldText.includes(norm(k)) && !newText.includes(norm(k))) retention.push(`${p.id} ${p.name}: lost "${k}"`);
  out.push({ d, old: f });
}

// Pages should not read alike
for (const x of out) {
  const mine = qa.shingles(qa.bodyText(x.d));
  for (const y of out) if (y !== x) { const c = qa.containment(mine, qa.shingles(qa.bodyText(y.d))); if (c > 0.35) problems.push(`${x.d.id}: ${Math.round(c * 100)}% similar to ${y.d.id}`); }
}

const dir = path.join(__dirname, '..');
fs.readdirSync(dir).filter((f) => /^batch-(0[89]|[1-9]\d)\.json$/.test(f)).forEach((f) => fs.unlinkSync(path.join(dir, f)));
for (let b = 0; b * 15 < out.length; b++) {
  const name = `batch-${String(8 + b).padStart(2, '0')}.json`;
  fs.writeFileSync(path.join(dir, name), JSON.stringify(out.slice(b * 15, b * 15 + 15).map((x) => x.d), null, 2) + '\n');
}
console.log(`${out.length} of ${src.length} drafts written to batch-08 onward`);
console.log(problems.length ? problems.join('\n') : 'QA: no problems');
console.log(retention.length ? `KEYWORD LOSSES:\n${retention.join('\n')}` : 'Keywords: none lost');
