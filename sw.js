// Bump CACHE when shipping changes so clients drop stale files.
const CACHE = 'forklift-v7';
const CORE = [
  './', 'index.html', 'style.css', 'favicon.svg', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png',
  ...['audio', 'debug', 'decals', 'forklift', 'game', 'geom', 'highscores', 'input', 'level',
    'main', 'midi', 'pov', 'render', 'revlight', 'savestate', 'theme'].map(m => `js/${m}.js`),
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Network first (fresh updates when online), cached copy when offline; MIDI etc. cached on first use.
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  // no-cache revalidates past GitHub Pages' ~10 min HTTP cache, so the PWA never runs files older than the server's.
  // Fall back to the cache if the network hasn't answered within 3 s.
  const net = fetch(req, { cache: 'no-cache' }).then(res => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
    return res;
  });
  const cached = () => caches.match(req, { ignoreSearch: true });
  const timeout = new Promise((_, rej) => setTimeout(rej, 3000));
  e.respondWith(Promise.race([net, timeout]).catch(() => cached().then(r => r || net)));
});
