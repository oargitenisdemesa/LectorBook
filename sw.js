const CACHE = 'lectorbook-v2';
const ASSETS = ['./', 'index.html', 'epub.js', 'tts.js', 'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png'];
// Librerías del motor de voz que se guardan para usarlas sin conexión (los modelos de voz van aparte, en el almacenamiento de la app).
const CDN_OK = ['cdn.jsdelivr.net', 'esm.sh'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Muestra lo guardado al instante y lo actualiza en segundo plano.
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (url.origin !== location.origin && !CDN_OK.includes(url.hostname)) return;   // modelos y demás: no se tocan
  if (e.request.headers.has('range')) return;
  e.respondWith(
    caches.open(CACHE).then(async cache => {
      const cached = await cache.match(e.request);
      const network = fetch(e.request)
        .then(res => { if (res && res.ok && res.status === 200) cache.put(e.request, res.clone()); return res; })
        .catch(() => cached);
      return cached || network;
    })
  );
});
