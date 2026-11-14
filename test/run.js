// Runs test categories: `node test/run.js [category ...]` (no args = all). Each category is test/<name>.test.js.
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('.', import.meta.url));
const all = readdirSync(dir).filter((f) => f.endsWith('.test.js')).map((f) => f.replace('.test.js', '')).sort();
const wanted = process.argv.slice(2);
const bad = wanted.filter((c) => !all.includes(c));
if (bad.length) {
  console.error(`Unknown category: ${bad.join(', ')}. Available: ${all.join(', ')}`);
  process.exit(2);
}

let failed = [];
for (const c of wanted.length ? wanted : all) {
  console.log(`\n=== ${c} ===`);
  const r = spawnSync(process.execPath, ['--import', './test/trace.js', `test/${c}.test.js`], { stdio: 'inherit' });
  if (r.status !== 0) failed.push(c);
}
if (failed.length) {
  console.error(`\nFAILED: ${failed.join(', ')}`);
  process.exit(1);
}
console.log('\nall selected test categories passed');
