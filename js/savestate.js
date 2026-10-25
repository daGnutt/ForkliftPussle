import { newGame } from './game.js';

export const SAVE_VERSION = 1;

const clone = (v) => JSON.parse(JSON.stringify(v));
const num = (v) => typeof v === 'number' && Number.isFinite(v);
const DYNAMIC = ['stacks', 'fl', 'carried', 'carriedRel', 'carriedRots', 'carriedPen', 'carriedOffs', 'bonks', 'H', 'hf', 'status', 'time', 'started'];

// Plain-JSON snapshot of a level in progress; the static layout is regenerated from (level, seed, hard).
export function serializeGame(g, seedText = '') {
  const state = {};
  for (const k of DYNAMIC) state[k] = clone(g[k]);
  return { version: SAVE_VERSION, level: g.level, seed: g.seed, seedText, hard: g.hard, state };
}

// Returns a new game from a snapshot, or throws if the data is not a valid snapshot.
export function deserializeGame(data) {
  if (!data || data.version !== SAVE_VERSION || !data.state) throw new Error('Unknown save format');
  const { level, seed, hard, state: s } = data;
  if (!Number.isInteger(level) || level < 1 || !num(seed)) throw new Error('Bad level or seed');
  const g = newGame(level, seed, !!hard);
  const okFl = s.fl && ['x', 'y', 'a', 'speed', 'steer'].every((k) => num(s.fl[k]));
  const okStacks = Array.isArray(s.stacks) && s.stacks.every((st) => num(st.x) && num(st.y) && Array.isArray(st.layers) && st.layers.length > 0 && st.layers.length <= 5 && st.layers.every(Number.isInteger));
  const okCarried = s.carried === null || (Array.isArray(s.carried) && s.carried.length > 0 && s.carried.every(Number.isInteger));
  if (!okFl || !okStacks || !okCarried || !Number.isInteger(s.H) || s.H < 0 || s.H > 5) throw new Error('Corrupt state');
  if (s.status !== 'play' && s.status !== 'won') throw new Error('Corrupt state');
  const boxes = (a) => a.reduce((n, st) => n + st.layers.length, 0) + (s.carried ? s.carried.length : 0);
  if (boxes(s.stacks) !== boxes(g.stacks)) throw new Error('State does not match level');
  Object.assign(g, clone(s));
  if (!num(g.hf)) g.hf = g.H;
  if (!num(g.time)) g.time = 0;
  if (!num(g.bonks)) g.bonks = 0;
  g.started = !!g.started;
  return g;
}
