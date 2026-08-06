const CACHE_NAME = 'terenska-evidencija-v2';
const ASSETS = [
  './',
  './index.html',
  './css/styles.css',
  './js/app.js',
  './js/db.js',
  './js/map.js',
  './js/gps.js',
  './js/audio.js',
  './js/export.js',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js'
];

// 1. Instalacija - spremanje svih statičkih fajlova
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS))
  );
  self.skipWaiting(); // Odmah preuzmi kontrolu bez čekanja na zatvaranje taba
});

// 2. Aktivacija - automatsko brisanje starih verzija keša (v1, v0, itd.)
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(
        keys.map(key => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    })
  );
  self.clients.claim();
});

// 3. Presretanje mrežnih zahtjeva
self.addEventListener('fetch', e => {
  // Ignorišemo Supabase API pozive (pusti ih direktno na mrežu, jer njih rješava sync.js)
  if (e.request.url.includes('supabase.co')) {
    return;
  }

  e.respondWith(
    caches.match(e.request).then(res => {
      // Ako imamo u kešu, vrati iz keša, inače idi na mrežu
      return res || fetch(e.request).catch(() => {
        // Ako nema mreže i traži se stranica, vrati index.html
        if (e.request.mode === 'navigate') {
          return caches.match('./index.html');
        }
      });
    })
  );
});