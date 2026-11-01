// Online high score server (https://highscore.gnutt.se). Every call fails soft: offline keeps the local score.
import { unsynced, markSynced } from './highscores.js';

const API = 'https://highscore.gnutt.se/api/games';
const GAME = 'forklift';
const MAX_PER_SYNC = 25; // server allows 30 writes/min per IP

// Returns [{name, points, time, level, meta, created}] or null when offline.
export async function fetchScores(board, limit = 10) {
  try {
    const res = await fetch(`${API}/${GAME}/boards/${encodeURIComponent(board)}?limit=${limit}`);
    const json = await res.json();
    return json.status === 'success' ? json.data : null;
  } catch { return null; }
}

// Returns the rank (1 = best) or null on failure. Never throws.
export async function submitScore(board, { name, points, time, level }) {
  try {
    // Plain-text body: no CORS preflight.
    const res = await fetch(`${API}/${GAME}/boards/${encodeURIComponent(board)}/scores`, {
      method: 'POST',
      body: JSON.stringify({ name, points, time, level }),
    });
    const json = await res.json();
    return res.ok ? json.rank : null;
  } catch { return null; }
}

// Uploads the local bests not yet on the global list and flags the accepted ones as synced.
export async function syncScores(store, submit = submitScore) {
  let sent = 0;
  for (const { board, level, entry } of unsynced(store).slice(0, MAX_PER_SYNC)) {
    const rank = await submit(board, { name: entry.name, points: entry.score, time: entry.time, level });
    if (rank == null) continue;
    markSynced(store, board, entry);
    sent++;
  }
  return sent;
}
