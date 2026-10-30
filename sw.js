const CACHE = 'lectorbook-v13';
const ASSETS = ['./', 'index.html', 'epub.js', 'docs.js', 'expr.js', 'tts.js', 'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png'];
// Librerías del motor de voz (URLs con versión fija): se guardan para usarlas sin conexión.
// Los modelos de voz no pasan por aquí: van en el almacenamiento de la app.
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

/* El código propio (página y módulos) se pide siempre a la red, para que nunca se mezclen versiones
   distintas de index.html / tts.js / docs.js; sin conexión, se usa la copia guardada. */
async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(req);
    if (res && res.status === 200) cache.put(req, res.clone());
    return res;
  } catch (err) {
    const cached = await cache.match(req);
    if (cached) return cached;
    throw err;
  }
}

/* Las librerías de CDN tienen versión fija: se sirven desde la caché y solo se piden si no están. */
async function cacheFirst(req) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(req);
  if (cached) return cached;
  const res = await fetch(req);
  if (res && res.status === 200) cache.put(req, res.clone());
  return res;
}

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || e.request.headers.has('range')) return;
  if (url.origin === location.origin) e.respondWith(networkFirst(e.request));
  else if (CDN_OK.includes(url.hostname)) e.respondWith(cacheFirst(e.request));
});
