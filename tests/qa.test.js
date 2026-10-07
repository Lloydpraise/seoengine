const test = require('node:test');
const assert = require('node:assert/strict');
const qa = require('../lib/qa');

const good = {
  primary_keyword: 'commercial deep fryer',
  seo_title: 'Commercial Deep Fryer 20L | Price in Kenya',
  meta_description: 'Buy a commercial deep fryer with a 20 litre tank in Nairobi. Durable stainless steel build for restaurants, with delivery across Kenya.',
  h1: 'Commercial Deep Fryer 20L for Restaurants',
  short_description: 'This commercial deep fryer suits busy Nairobi kitchens.',
  sections: [{ heading: 'Why it works', body: 'It holds 20 litres of oil and heats evenly for steady frying.' }],
  specs: [{ label: 'Capacity', value: '20 litres' }], faqs: [{ q: 'Is it stainless?', a: 'Yes.' }], alt_text: 'fryer',
};
const ctx = { targets: { wordsMin: 5, wordsMax: 200, sectionsMin: 1, faqMin: 1 }, allowedText: 'Capacity: 20 litres' };

test('a clean draft passes', () => assert.equal(qa.check(good, ctx).pass, true));

test('flags long title, missing keyword, invented numbers', () => {
  const bad = { ...good, seo_title: 'x'.repeat(70), sections: [{ heading: 'h', body: 'It draws 9.5 kW and weighs 48 kg.' }] };
  const r = qa.check(bad, ctx);
  const codes = r.issues.map((i) => i.code);
  assert.ok(codes.includes('title_long') && codes.includes('kw_title') && codes.includes('unsupported_numbers'));
  assert.equal(r.pass, false);
});

test('detects copying from a source and duplicates of other pages', () => {
  const src = 'It holds 20 litres of oil and heats evenly for steady frying every single day of service in the kitchen';
  const copied = { ...good, sections: [{ heading: 'a', body: src }] };
  assert.ok(qa.check(copied, { ...ctx, sourceTexts: [{ host: 'acme.com', text: src }] }).issues.some((i) => i.code === 'copied'));
  assert.ok(qa.check(copied, { ...ctx, otherBodies: [{ name: 'Other', text: qa.bodyText(copied) }] }).issues.some((i) => i.code === 'duplicate'));
});
