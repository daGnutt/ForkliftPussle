// Preloaded by `npm test`: announces each test section before it runs and its duration after.
// Set TRACE=0 to silence, SLOW_MS (default 1000) marks slow sections.
import { register } from 'node:module';
import { writeSync } from 'node:fs';

register('./trace-hooks.js', import.meta.url);

const on = process.env.TRACE !== '0';
const slowMs = Number(process.env.SLOW_MS || 1000);
const out = (s) => writeSync(1, s + '\n');
let cur = null;
const done = () => {
  if (!cur) return;
  const ms = Math.round(performance.now() - cur.t0);
  out(`${cur.sub ? '     ' : '  '}done in ${ms} ms${ms >= slowMs ? '  <-- SLOW' : ''}`);
  cur = null;
};
globalThis.__t = (title, line, sub) => {
  if (!on) return;
  done();
  out(`${sub ? '   ·' : '▶'} [line ${line}] ${title}`);
  cur = { t0: performance.now(), sub };
};
process.on('exit', done);
