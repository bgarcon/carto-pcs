// Service worker minimal — installabilité PWA pour agent.html, pas d'offline complet
// (l'app dépend du réseau pour le WebSocket, l'upload et les tuiles carto).
const CACHE_NAME = 'submersion-terrain-v1';
const APP_SHELL = [
  'agent.html',
  'agent-config.js',
  'manifest.json',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  const isAppShell = APP_SHELL.some((path) => url.pathname.endsWith('/' + path) || url.pathname === '/' + path);
  if (!isAppShell) return; // tout le reste (WS, /upload-event, tuiles) passe directement au réseau

  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
