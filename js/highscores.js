// Local high scores per (seed, level), stored as { score, time, name } under one localStorage key.
const KEY = 'forklift-highscores';

const read = (store) => {
  try { return JSON.parse(store.getItem(KEY)) || {}; } catch { return {}; }
};
const keyOf = (seed, level) => `${seed || 0}:${level}`;

export function getBest(store, seed, level) {
  return read(store)[keyOf(seed, level)] || null;
}

// Higher score wins; on equal score, less time wins.
export function beats(result, best) {
  return !best || result.score > best.score || (result.score === best.score && result.time < best.time);
}

export function saveBest(store, seed, level, result) {
  const all = read(store);
  all[keyOf(seed, level)] = { score: result.score, time: Math.round(result.time), name: result.name };
  try { store.setItem(KEY, JSON.stringify(all)); } catch { /* storage unavailable */ }
}
