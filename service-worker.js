const CACHE_NAME = "guigs-stock-shell-v11";
const CACHE_PREFIX = "guigs-stock-shell-v";

const APP_SHELL = [
  "./",
  "./index.html",
  "./auth-preview.html",
  "./reset-password.html",
  "./cloud-dashboard.js",
  "./inventory.js",
  "./reports.js",
  "./fridges.js",
  "./pwa.js",
  "./config.js",
  "./auth-preview.js",
  "./reset-password.js",
  "./manifest.webmanifest",
  "./logo-guigs.png",
  "./icons/guigs-stock-192.png",
  "./icons/guigs-stock-512.png",
  "./icons/guigs-stock-maskable-512.png",
];
const shell = new Map(APP_SHELL.map(entry => {
  const url = new URL(entry, self.registration.scope);
  return [url.pathname, url.href];
}));
for (const alias of ["index", "auth-preview", "reset-password"]) {
  const path = new URL(alias, self.registration.scope);
  shell.set(path.pathname, new URL(alias + ".html", self.registration.scope).href);
}

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(APP_SHELL);
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME).map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;

  if (request.method !== "GET") {
    return;
  }

  const url = new URL(request.url);

  /*
   * Nunca interceptar Supabase
   * ou qualquer recurso externo.
   */
  if (url.origin !== self.location.origin) {
    return;
  }

  const asset = shell.get(url.pathname);
  if (!asset) return;
  // Rede primeiro. Só o shell público entra no cache; nunca guardar parâmetros de Auth.
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    try {
      const response = await fetch(request);
      if (response.ok && !url.search) {
        try { await cache.put(asset, response.clone()); } catch { /* falha de cache não derruba rede */ }
      }
      return response;
    } catch {
      return await cache.match(asset) || Response.error();
    }
  })());
});
