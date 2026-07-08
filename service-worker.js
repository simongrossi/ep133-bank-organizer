const CACHE_NAME = 'ep-bank-organizer-v2';
const APP_SHELL = [
  './',
  './index.html',
  './styles.css',
  './manifest.webmanifest',
  './assets/icon.svg',
  './src/app.js',
  './src/config.js',
  './src/classifier.js',
  './src/allocator.js',
  './src/wav.js',
  './src/pack.js',
  './src/pak.js',
  './src/padmap.js',
  './src/stats.js',
  './src/midi.js',
  './src/transport.js',
  './src/utils.js'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))))
  );
  self.clients.claim();
});

// Network-first : on sert la version fraîche dès que le serveur répond, et on
// retombe sur le cache uniquement hors-ligne. Évite que la PWA serve d'anciens
// fichiers après une mise à jour de l'application.
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    fetch(event.request)
      .then(response => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
