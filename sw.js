/* Service Worker: App-Dateien offline bereithalten. Datenbank und Bilder kommen immer frisch aus dem Netz. */
const VERSION = 'kartenalbum-v1';
const DATEIEN = ['./', './index.html', './app.css', './app.js', './manifest.webmanifest', './icon-180.png', './icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(DATEIEN)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin || e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request).then((antwort) => {
      const kopie = antwort.clone();
      caches.open(VERSION).then((c) => c.put(e.request, kopie));
      return antwort;
    }).catch(() => caches.match(e.request).then((t) => t || caches.match('./index.html')))
  );
});
