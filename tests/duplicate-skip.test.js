const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { filterFilesByExistingResults } = require('../duplicate-skip');

test('skips filenames already present in output CSV files', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seo-pipeline-'));
  const outputDir = path.join(tempDir, 'output');
  fs.mkdirSync(outputDir, { recursive: true });

  fs.writeFileSync(
    path.join(outputDir, 'results-1.csv'),
    'fileName,status\nalpha.jpg,ok\nbeta.png,ok\n',
    'utf8'
  );
  fs.writeFileSync(
    path.join(outputDir, 'results-2.csv'),
    'fileName,status\ngamma.jpeg,ok\n',
    'utf8'
  );

  const result = filterFilesByExistingResults(
    ['alpha.jpg', 'beta.png', 'delta.webp', 'gamma.jpeg'],
    outputDir
  );

  assert.deepStrictEqual(result.files, ['delta.webp']);
  assert.equal(result.skipped, 3);
});
