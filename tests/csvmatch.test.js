const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCsv, matchRows } = require('../lib/csvmatch');

const CSV = `Product,Link 1,Link 2,Knowledge
"Commercial Deep Fryer 20L","https://a.co.ke/fryer","https://b.com/f","Needs 3-phase,
works with LPG"
Gas Stove 4 Burner,,,
Mystery item,,,
`;
const products = [
  { id: '1', name: 'Commercial Deep Fryer 20 L', localImage: 'IMG1.jpeg' },
  { id: '2', name: 'Gas Stove 4 Burner', localImage: '' },
  { id: '3', name: 'Chest Freezer', localImage: '' },
];

test('parses quoted multiline cells and collects links', () => {
  const rows = parseCsv(CSV);
  assert.equal(rows.length, 3);
  assert.match(rows[0].knowledge, /3-phase,\nworks with LPG/);
  const m = matchRows(rows, products);
  assert.deepEqual(m[0].parsed.links, ['https://a.co.ke/fryer', 'https://b.com/f']);
});

test('matches by name (fuzzy + exact) and leaves unknown rows unmatched', () => {
  const m = matchRows(parseCsv(CSV), products);
  assert.equal(m[0].match.id, '1');
  assert.equal(m[1].match.id, '2'); assert.equal(m[1].match.how, 'exact name');
  assert.equal(m[2].match, null);
});

test('matches by filename and handles semicolon delimiters', () => {
  const m = matchRows(parseCsv('filename;links\nimg1.JPEG;https://x.com/p'), products);
  assert.equal(m[0].match.id, '1'); assert.equal(m[0].match.how, 'filename');
});

test('treats "20 L", "20L" and "20 litres" as the same size', () => {
  const m = matchRows(parseCsv('product\nDeep Fryer 20 litres'), [{ id: 'x', name: 'Deep Fryer 20L' }]);
  assert.equal(m[0].confidence, 'high');
});
