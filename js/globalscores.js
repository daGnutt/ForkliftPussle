// Online high score server (https://highscore.gnutt.se). Every call fails soft: offline keeps the local score.
import { unsynced, markSynced, mergeRemote } from './highscores.js';
import { isTesting } from './testing.js';

const API = 'https://highscore.gnutt.se/api/games';
const GAME = 'forklift';
const MAX_PER_SYNC = 25; // server allows 30 writes/min per IP

// Returns [{name, points, time, level, meta, created}] or null when offline.
async function fetchScores(board, limit = 10) {
  try {
    const res = await fetch(`${API}/${GAME}/boards/${encodeURIComponent(board)}?limit=${limit}`);
    const json = await res.json();
    return json.status === 'success' ? json.data : null;
  } catch { return null; }
}

// Returns the rank (1 = best) or null on failure. Never throws.
async function submitScore(board, { name, points, time, level }) {
  if (isTesting()) return null; // only the official host posts scores
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

// One page of a player's scores across all boards ({data, total}), or null when offline.
async function fetchPlayerPage(name, offset, limit) {
  try {
    const res = await fetch(`${API}/${GAME}/players/${encodeURIComponent(name)}/scores?limit=${limit}&offset=${offset}`);
    const json = await res.json();
    return json.status === 'success' ? json : null;
  } catch { return null; }
}

const PAGE = 100, MAX_PAGES = 20;

// Downloads all of a player's global scores into the local high scores. Resolves to { fetched, added } or null when offline.
export async function pullScores(store, name, fetchPage = fetchPlayerPage) {
  let fetched = 0, added = 0;
  for (let page = 0, offset = 0; page < MAX_PAGES; page++, offset += PAGE) {
    const res = await fetchPage(name, offset, PAGE);
    if (!res) return null;
    for (const e of res.data) {
      fetched++;
      if (mergeRemote(store, e.board, { score: e.points, time: e.time ?? 0, name: e.name })) added++;
    }
    if (!res.data.length || offset + PAGE >= res.total) break;
  }
  return { fetched, added };
}

// Resolves to the top 10 entries, or null when offline.
export const fetchTopList = (board) => fetchScores(board, 10);

// Resolves to the top entry, 'none' (empty board) or 'offline'.
export async function fetchTop(board) {
  const list = await fetchScores(board, 1);
  return list === null ? 'offline' : list[0] || 'none';
}
