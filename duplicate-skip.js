const fs = require('fs');
const path = require('path');
const { parseCsv } = require('./lib/csvmatch');

const FILE_NAME_HEADERS = new Set(['filename', 'file_name', 'file name']);

function getProcessedFileNames(outputDir) {
  if (!fs.existsSync(outputDir)) return new Set();

  const names = new Set();
  for (const file of fs.readdirSync(outputDir)) {
    if (!/\.csv$/i.test(file)) continue;
    const rows = parseCsv(fs.readFileSync(path.join(outputDir, file), 'utf8'));
    for (const row of rows) {
      const header = Object.keys(row).find((key) => FILE_NAME_HEADERS.has(key));
      const name = header && row[header].trim();
      if (name) names.add(name);
    }
  }
  return names;
}

function filterFilesByExistingResults(files, outputDir) {
  const processed = getProcessedFileNames(outputDir);
  const remaining = files.filter((file) => !processed.has(file));
  return { files: remaining, skipped: files.length - remaining.length };
}

module.exports = { getProcessedFileNames, filterFilesByExistingResults };
