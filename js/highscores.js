// Local high scores per (seed, level), stored as { score, time, name } under one localStorage key.
const KEY = 'forklift-highscores';

const read = (store) => {
  try { return JSON.parse(store.getItem(KEY)) || {}; } catch { return {}; }
};
const keyOf = (seed, level) => `${seed || 0}:${level}`;

export function getBest(store, seed, level) {
  return read(store)[keyOf(seed, level)] || null;
}

// Lowest level number (from 1) with no saved score for this seed.
export function lowestUnscored(store, seed) {
  const all = read(store);
  let n = 1;
  while (all[keyOf(seed, n)]) n++;
  return n;
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

// 1 point off per 10 seconds; only applied to the submitted score, never to level completion.
export const timePenalty = (time) => Math.floor(time / 10);
export const finalScore = (points, time) => Math.max(0, points - timePenalty(time));

export function formatTime(time) {
  const t = Math.floor(time);
  if (t < 60) return `${t}s`;
  if (t < 3600) return `${Math.floor(t / 60)}m ${String(t % 60).padStart(2, '0')}s`;
  const h = Math.floor(t / 3600);
  if (h >= 100) return '100+ h';
  return `${h}h ${String(Math.floor((t % 3600) / 60)).padStart(2, '0')}m`;
}
