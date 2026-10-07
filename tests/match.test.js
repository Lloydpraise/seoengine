const test = require('node:test');
const assert = require('node:assert/strict');
const { attrsOf, score } = require('../lib/match');
const kenya = require('../lib/kenya');

test('reads sizes and counts from names', () => {
  const a = attrsOf('Commercial Gas Stove 4-Burner 6kW 900mm');
  assert.ok(a.burner.has('4') && a.kw.has('6') && a.mm.has('900'));
  assert.ok(attrsOf('Fryer 20 litres').l.has('20') && attrsOf('Fryer 20L').l.has('20'));
});

test('very similar products: right size scores high, wrong size is rejected', () => {
  const ours = 'Commercial Deep Fryer 20L';
  const right = score(ours, { title: 'Deep Fryer 20 Litre Commercial', h1: '', specs: [{ label: 'Capacity', value: '20 L' }], url: 'https://a.com/p' });
  const wrong = score(ours, { title: 'Commercial Deep Fryer 30L', h1: '', specs: [], url: 'https://a.com/p2' });
  assert.ok(right.score >= 0.8 && right.conflicts.length === 0);
  assert.ok(wrong.score <= 0.45 && wrong.conflicts[0].unit === 'l');
  assert.equal(score('Gas Stove 4 Burner', { title: '6 Burner Gas Stove', url: 'https://a.com/x' }).conflicts.length, 1);
});

test('size can come from the URL or spec table when the title omits it', () => {
  assert.equal(score('Deep Fryer 20L', { title: 'Deep Fryer', url: 'https://a.com/deep-fryer-30l' }).conflicts.length, 1);
  assert.equal(score('Deep Fryer 20L', { title: 'Deep Fryer', specs: [{ label: 'Capacity', value: '20 L' }], url: 'https://a.com/d' }).agree.length, 1);
});

test('source picking: preferred site first, wrong sizes dropped, Kenyan + international mix, not just Google order', () => {
  const org = [
    { title: 'Deep Fryer 30L', link: 'https://top.com/fryer-30l', snippet: '' },
    { title: 'Deep Fryer 20L price Ksh', link: 'https://shop.co.ke/fryer-20l', snippet: '' },
    { title: 'Deep Fryer 20L spec', link: 'https://maker.com/fryer-20l', snippet: '' },
    { title: 'Fryer 20L', link: 'https://other.co.ke/f', snippet: 'Nairobi' },
  ];
  const pref = [{ title: 'Deep Fryer 20L', link: 'https://favourite.com/p/fryer-20l', snippet: '' }];
  const picks = kenya.pickSources(org, 'https://kitchenandall.com', [], { name: 'Commercial Deep Fryer 20L', limit: 3, preferredHosts: ['favourite.com'], preferred: pref });
  assert.equal(picks[0].host, 'favourite.com');
  assert.ok(!picks.some((p) => p.host === 'top.com'), '30L page dropped even though Google ranked it first');
  assert.ok(picks.some((p) => p.kenyan) && picks.some((p) => !p.kenyan));
  assert.equal(picks.length, 3);
});
