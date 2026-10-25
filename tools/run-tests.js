const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const mode = process.argv[2];
const suffix = mode === 'unit' ? '.test.js' : mode === 'e2e' ? '.e2e.js' : undefined;
if (!suffix) {
  console.error('usage: node tools/run-tests.js <unit|e2e>');
  process.exit(2);
}

function collect(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...collect(file));
    else if (entry.isFile() && entry.name.endsWith(suffix)) files.push(file);
  }
  return files;
}

const files = collect(path.resolve(__dirname, '..', 'dist')).sort();
if (!files.length) {
  console.error(`no ${mode} test files found under dist/`);
  process.exit(1);
}

const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
