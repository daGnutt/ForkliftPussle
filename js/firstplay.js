// ?firstplay: replace localStorage with an empty in-memory store for this visit, so the game behaves like a first run
// (scheme picker, tutorial, level 1) without touching or overwriting the real saved data.
// Must be the first import of main.js so it runs before any module reads localStorage.
export const firstPlay = typeof location !== 'undefined' && new URLSearchParams(location.search).has('firstplay');

if (firstPlay) {
  const data = new Map();
  const mem = {
    getItem: (k) => (data.has(String(k)) ? data.get(String(k)) : null),
    setItem: (k, v) => { data.set(String(k), String(v)); },
    removeItem: (k) => { data.delete(String(k)); },
    clear: () => data.clear(),
    key: (i) => [...data.keys()][i] ?? null,
    get length() { return data.size; },
  };
  Object.defineProperty(window, 'localStorage', { value: mem, configurable: true });
}
