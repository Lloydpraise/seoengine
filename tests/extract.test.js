const test = require('node:test');
const assert = require('node:assert/strict');
const { extractPage } = require('../lib/extract');

const HTML = `<html><head><title>20L Deep Fryer &amp; Basket | Acme</title>
<meta name="description" content="Twin-tank fryer, 6 kW."><script type="application/ld+json">{"@graph":[{"@type":"Product","name":"20L Fryer","brand":{"name":"Acme"},"offers":{"price":"45000","priceCurrency":"KES"}},{"@type":"FAQPage","mainEntity":[{"name":"q1"},{"name":"q2"}]}]}</script>
<style>.x{}</style></head><body><nav><ul><li>Home page link</li></ul></nav>
<h1>20L Deep Fryer</h1><h2>Specifications</h2>
<table><tr><th>Power</th><td>6 kW</td></tr><tr><td>Capacity</td><td>20 L</td></tr><tr><td>Voltage</td><td>380V</td></tr><tr><td>a</td><td>b</td><td>c</td></tr></table>
<ul><li>Material: 304 stainless steel</li><li>Includes two frying baskets</li></ul>
<p>This fryer is built for busy restaurant kitchens that need consistent oil temperature all day long.</p>
<h2>Why buy?</h2></body></html>`;

test('extracts title, meta, headings, specs, bullets, json-ld', () => {
  const p = extractPage(HTML, 'https://www.acme.com/fryer');
  assert.equal(p.title, '20L Deep Fryer & Basket | Acme');
  assert.equal(p.metaDescription, 'Twin-tank fryer, 6 kW.');
  assert.equal(p.h1, '20L Deep Fryer');
  assert.equal(p.host, 'acme.com');
  assert.deepEqual(p.specs.map((s) => s.label), ['Power', 'Capacity', 'Voltage', 'Material']);
  assert.ok(p.bullets.includes('Includes two frying baskets'));
  assert.ok(!p.bullets.some((b) => b.includes('Home page')), 'nav is stripped');
  assert.equal(p.faqCount, 2);
  assert.equal(p.productLd.price, '45000');
  assert.ok(p.ldTypes.includes('FAQPage'));
  assert.ok(p.hasSpecTable);
});
