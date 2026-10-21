// The "ingestor": reads reference pages and learns the SEO pattern to reproduce.
const net = require('./net');
const ai = require('./ai');

const DEFAULT_PROFILE = {
  id: 'default',
  name: 'Default Kenya product page',
  urls: [],
  builtin: true,
  analysis: {
    title_pattern: '[Primary keyword] – [key spec or use] | Price in Kenya',
    meta_pattern: 'Benefit + key spec + "Buy in Nairobi / delivery across Kenya" + soft call to action',
    h1_pattern: '[Product name] for [typical buyer]',
    tone: 'Plain, practical, confident. Written like an experienced equipment supplier advising a restaurant or hotel owner.',
    structure: ['Short intro with primary keyword', 'Key features and benefits', 'Who it suits and where it is used', 'What to check before buying (power, space, capacity)', 'Care and maintenance', 'Delivery, installation and support'],
    spec_presentation: 'Specification table of label/value pairs, only verified specs',
    faq_style: '3–4 buyer questions with direct 1–3 sentence answers',
    do: ['Lead with what the buyer gets', 'Use specific verified numbers'],
    dont: ['Invent specs', 'Use generic marketing filler'],
  },
  rules: '',
  targets: { wordsMin: 450, wordsMax: 750, sectionsMin: 4, faqMin: 3 },
  exemplars: [],
};

const LONG_PROFILE = {
  ...DEFAULT_PROFILE, id: 'long', name: 'Long-form buying guide page',
  analysis: { ...DEFAULT_PROFILE.analysis,
    structure: ['Intro with primary keyword', 'Key features and benefits', 'Who it suits and use cases', 'Buying checklist: power, capacity, space, materials', 'Installation and power requirements', 'Care and maintenance', 'Common mistakes to avoid', 'Delivery, warranty and support in Kenya'],
    faq_style: '5–7 buyer questions with direct, specific 2–4 sentence answers' },
  targets: { wordsMin: 1000, wordsMax: 1600, sectionsMin: 7, faqMin: 5 },
};

// Built from reading a live product page on shinekitchenware.co.ke (structure and tactics only, none of its wording).
const KENYA_LONGTAIL_PROFILE = {
  ...DEFAULT_PROFILE, id: 'kenya-longtail', name: 'Kenya long-tail product page (Shine-style)', builtin: true,
  analysis: {
    title_pattern: '[Product] Price in Kenya | [Store]',
    meta_pattern: 'Buy [Product] in Kenya from [Store]. [Main benefit]. [Who it suits]. [Delivery or support]. About 150 characters.',
    h1_pattern: '[Product]',
    tone: 'Plain, benefit-led, written for restaurant, hotel, school and catering buyers in Kenya. Specific and practical, never vague.',
    structure: [
      'Short intro (2 sentences) with the primary keyword, followed by 5-6 benefit bullets',
      'What is a [Product]? (definition and how it works)',
      'Benefits of the [Product] (bold lead-in per benefit)',
      'Applications (restaurants, hotels, catering, schools, butcheries, institutions: only those that really fit)',
      'Specifications (table of exact values)',
      'Why buy from [Store] in Kenya (delivery, installation, warranty, support, only what is supported by SHOP KNOWLEDGE)',
      'FAQs about [Product] (8-10 real buyer questions, each answered directly)',
      'Closing call to action: Buy [Product] in Kenya today',
    ],
    spec_presentation: 'Two-column table. Exact numbers only. If a value is unknown, leave the row out instead of writing a range or "model dependent".',
    faq_style: '8-10 numbered buyer questions: where to buy, size/capacity, power (single-phase/three-phase), cleaning, durability, warranty, delivery. Answers 1-3 sentences.',
    keyword_placement: 'Primary keyword in title, meta, H1, first sentence, one heading and the closing section. The phrase "buy [product] in Kenya" at most 3 times in total. Vary wording elsewhere.',
    cta_style: 'Soft, practical, mentions ordering or WhatsApp only if SHOP KNOWLEDGE says so.',
    do: ['Give 3-5 long-tail "[product] Kenya" phrases as secondary keywords (they become product tags)', 'Link-worthy specifics: power type, capacity, dimensions, material', 'Answer the questions buyers actually ask'],
    dont: ['Repeat the same sentence across sections', 'Use vague ranges such as "10-15 litres (model dependent)"', 'Claim home use unless the facts support it', 'Contradict yourself between sections and the spec table'],
  },
  targets: { wordsMin: 800, wordsMax: 1300, sectionsMin: 6, faqMin: 8 },
};

const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

async function ingest({ name, urls, model }) {
  const pages = [];
  const failed = [];
  for (const url of urls) {
    try { pages.push(await net.fetchPage(url)); } catch (e) { failed.push(`${url}: ${e.message}`); }
  }
  if (!pages.length) throw new Error(`Could not read any of the links. ${failed.join(' | ')}`);

  const h2 = (p) => p.headings.filter((h) => h.level === 2).length;
  const stats = {
    pages: pages.length,
    avgWords: Math.round(avg(pages.map((p) => p.wordCount))),
    avgSections: Math.round(avg(pages.map(h2))),
    avgFaqs: Math.round(avg(pages.map((p) => p.faqCount))),
    avgSpecs: Math.round(avg(pages.map((p) => p.specs.length))),
    thinPages: pages.filter((p) => p.thin).length,
  };

  const sample = pages.map((p, i) => `PAGE ${i + 1} (${p.host})
Title tag: ${p.title}
Meta description: ${p.metaDescription}
H1: ${p.h1}
Headings in order: ${p.headings.map((h) => `H${h.level} ${h.text}`).slice(0, 30).join(' | ')}
Words: ${p.wordCount}; spec rows: ${p.specs.length}; FAQ items: ${p.faqCount}; structured data: ${(p.ldTypes || []).join(', ') || 'none'}
Opening text (for tone only): ${p.text.slice(0, 450)}`).join('\n\n');

  const analysis = await ai.jsonCall({ label: 'style-profile',
    model,
    system: 'You are a senior e-commerce SEO analyst. You study reference product pages and write a reusable style guide that another writer can follow to produce the SAME KIND of SEO page about different products. Describe patterns, never quote sentences.',
    user: `${sample}

Return JSON only:
{"title_pattern":"","meta_pattern":"","h1_pattern":"","tone":"","structure":["ordered section purposes"],"paragraph_style":"","spec_presentation":"","faq_style":"","cta_style":"","keyword_placement":"","do":[],"dont":[]}
Patterns must use placeholders like [Product], [Spec], [Use case]. Do not copy wording from the pages.`,
  });

  return {
    name, urls, builtin: false, stats, analysis, rules: '', failed,
    targets: {
      wordsMin: Math.max(200, Math.round(stats.avgWords * 0.8)),
      wordsMax: Math.min(1800, Math.max(350, Math.round(stats.avgWords * 1.2))),
      sectionsMin: Math.max(3, stats.avgSections - 1),
      faqMin: Math.max(2, Math.min(5, stats.avgFaqs || 3)),
    },
    exemplars: pages.map((p) => ({ host: p.host, title: p.title, meta: p.metaDescription, h1: p.h1, headings: p.headings.map((h) => `H${h.level} ${h.text}`).slice(0, 20) })),
  };
}
module.exports = { ingest, DEFAULT_PROFILE, LONG_PROFILE, KENYA_LONGTAIL_PROFILE };
