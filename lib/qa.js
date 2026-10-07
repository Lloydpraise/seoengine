// Automated quality checks on a draft. Pure functions — no network.
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9\s.]/g, ' ').replace(/\s+/g, ' ').trim();
const words = (s) => norm(s).split(' ').filter(Boolean);

function shingles(text, n = 6) {
  const w = words(text);
  const set = new Set();
  for (let i = 0; i + n <= w.length; i++) set.add(w.slice(i, i + n).join(' '));
  return set;
}
function containment(a, b) {
  if (!a.size) return 0;
  let hit = 0;
  for (const x of a) if (b.has(x)) hit++;
  return hit / a.size;
}

function bodyText(d) {
  return [d.short_description, ...(d.sections || []).map((s) => `${s.heading}. ${s.body}`), ...(d.faqs || []).map((f) => `${f.q} ${f.a}`)].join('\n');
}

const countWords = (d) => words([...(d.sections || []).map((s) => s.body), d.short_description].join(' ')).length;

const FLUFF = ['elevate your', 'unleash', 'game-changer', "in today's fast-paced", 'look no further', 'take your kitchen to the next level', 'seamlessly', 'unlock the', 'state-of-the-art', 'cutting-edge'];
const UNIT = '(?:kg|g|l|litres?|liters?|w|kw|v|hz|mm|cm|m|°c|c|rpm|cfm|pcs|trays?|burners?|shelves|doors|months?|years?|l\\/h|kg\\/h|mins?|minutes|ltr)';

function numbersIn(text) {
  const out = [];
  const t = String(text).toLowerCase().replace(/(\d),(\d{3})/g, '$1$2');
  for (const m of t.matchAll(new RegExp(`(\\d+(?:\\.\\d+)?)\\s?(${UNIT})?(?![a-z0-9])`, 'g'))) {
    out.push({ num: m[1], unit: m[2] || '' });
  }
  return out;
}

/**
 * ctx: { primary, targets:{wordsMin,wordsMax,sectionsMin,faqMin}, allowedText, sourceTexts:[], otherBodies:[] }
 */
function check(d, ctx = {}) {
  const issues = [];
  const add = (level, code, msg) => issues.push({ level, code, msg });
  const t = ctx.targets || {};
  const primary = norm(ctx.primary || d.primary_keyword || '');
  const title = d.seo_title || '', meta = d.meta_description || '', h1 = d.h1 || '';
  const body = bodyText(d);
  const wc = countWords(d);

  if (!title) add('error', 'title_missing', 'SEO title is empty');
  else if (title.length > 60) add('error', 'title_long', `SEO title is ${title.length} characters (max 60)`);
  else if (title.length < 30) add('warn', 'title_short', `SEO title is only ${title.length} characters`);
  if (!meta) add('error', 'meta_missing', 'Meta description is empty');
  else if (meta.length > 155) add('error', 'meta_long', `Meta description is ${meta.length} characters (max 155)`);
  else if (meta.length < 110) add('warn', 'meta_short', `Meta description is only ${meta.length} characters`);

  if (primary) {
    if (!norm(title).includes(primary)) add('error', 'kw_title', `Primary keyword "${primary}" is not in the title`);
    if (!norm(meta).includes(primary)) add('warn', 'kw_meta', 'Primary keyword is not in the meta description');
    if (!norm(h1).includes(primary)) add('warn', 'kw_h1', 'Primary keyword is not in the H1');
    if (!words(d.short_description + ' ' + ((d.sections || [])[0] || {}).body).slice(0, 120).join(' ').includes(primary)) {
      add('warn', 'kw_intro', 'Primary keyword is not in the first 120 words');
    }
  } else add('error', 'kw_missing', 'No primary keyword was chosen');

  if (t.wordsMin && wc < t.wordsMin) add(wc < t.wordsMin * 0.6 ? 'error' : 'warn', 'words_low', `Body is ${wc} words; style profile expects ${t.wordsMin}–${t.wordsMax}`);
  if (t.wordsMax && wc > t.wordsMax * 1.25) add('warn', 'words_high', `Body is ${wc} words; style profile expects ${t.wordsMin}–${t.wordsMax}`);
  if (t.sectionsMin && (d.sections || []).length < t.sectionsMin) add('warn', 'sections_low', `Only ${(d.sections || []).length} sections; profile expects at least ${t.sectionsMin}`);
  if (t.faqMin && (d.faqs || []).length < t.faqMin) add('warn', 'faq_low', `Only ${(d.faqs || []).length} FAQs; profile expects at least ${t.faqMin}`);
  if (!d.alt_text) add('warn', 'alt_missing', 'Image alt text is empty');

  if (!/\b(kenya|nairobi|kes|mombasa|kisumu)\b/i.test(`${title} ${meta} ${body}`)) add('warn', 'kenya', 'No Kenya / Nairobi / KES mention anywhere');
  const fl = FLUFF.filter((f) => body.toLowerCase().includes(f));
  if (fl.length) add('warn', 'fluff', `Generic filler phrases: ${fl.join(', ')}`);

  // Numbers that appear in the copy but nowhere in the facts, notes or shop knowledge
  if (ctx.allowedText !== undefined) {
    const allowed = new Set(numbersIn(ctx.allowedText).map((n) => n.num));
    const fullText = [title, meta, h1, body, ...(d.specs || []).map((s) => `${s.label} ${s.value}`)].join(' ');
    const bad = numbersIn(fullText).filter((n) => !allowed.has(n.num) && (n.unit || n.num.includes('.') || n.num.length >= 3));
    const uniq = [...new Set(bad.map((n) => n.num + (n.unit ? ' ' + n.unit : '')))];
    const withUnit = bad.some((n) => n.unit);
    if (uniq.length) add(withUnit ? 'error' : 'warn', 'unsupported_numbers', `Numbers not found in your facts or notes: ${uniq.slice(0, 8).join(', ')}`);
  }

  const mine = shingles(body);
  let overlapMax = 0, overlapHost = '';
  for (const s of ctx.sourceTexts || []) {
    const c = containment(mine, shingles(s.text));
    if (c > overlapMax) { overlapMax = c; overlapHost = s.host; }
  }
  if (overlapMax > 0.12) add('error', 'copied', `${Math.round(overlapMax * 100)}% of the wording matches ${overlapHost} — rewrite in your own words`);
  else if (overlapMax > 0.06) add('warn', 'copied_soft', `${Math.round(overlapMax * 100)}% wording overlap with ${overlapHost}`);

  let dupMax = 0, dupWith = '';
  for (const o of ctx.otherBodies || []) {
    const c = containment(mine, shingles(o.text));
    if (c > dupMax) { dupMax = c; dupWith = o.name; }
  }
  if (dupMax > 0.5) add('error', 'duplicate', `${Math.round(dupMax * 100)}% similar to your page for "${dupWith}"`);
  else if (dupMax > 0.35) add('warn', 'duplicate_soft', `${Math.round(dupMax * 100)}% similar to your page for "${dupWith}"`);

  return {
    pass: !issues.some((i) => i.level === 'error'),
    issues,
    stats: { words: wc, titleLen: title.length, metaLen: meta.length, overlap: +overlapMax.toFixed(3), duplicate: +dupMax.toFixed(3) },
  };
}
module.exports = { check, countWords, bodyText, shingles, containment, numbersIn };
