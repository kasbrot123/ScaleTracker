// Macht die Seite installierbar. Es wird bewusst nichts gecacht, die Daten kommen immer vom Server.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (event) => event.respondWith(fetch(event.request)));
