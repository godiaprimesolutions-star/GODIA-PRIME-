const CACHE_NAME = "godia-prime-connect-shell-v1";
const APP_SHELL = ["/", "/manifest.webmanifest", "/icons/gpc-icon-192.png", "/icons/gpc-icon-512.png", "/icons/gpc-apple-touch-icon.png"];
self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;
  if (request.mode === "navigate") {
    event.respondWith(fetch(request).then(response => {
      if (response && response.ok) { const copy = response.clone(); caches.open(CACHE_NAME).then(cache => cache.put("/", copy)); }
      return response;
    }).catch(() => caches.match("/").then(cached => cached || Response.error())));
    return;
  }
  if (APP_SHELL.includes(url.pathname) || url.pathname.startsWith("/icons/")) {
    event.respondWith(caches.match(request).then(cached => cached || fetch(request)));
  }
});
