const CACHE_NAME = "guigs-stock-shell-v16";
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
  "./image-library.js",
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
const canonicalPages = new Map([
  ["index.html", "./"],
  ["auth-preview.html", "auth-preview"],
  ["reset-password.html", "reset-password"],
].map(([file, route]) => [
  new URL(file, self.registration.scope).href,
  new URL(route, self.registration.scope),
]));
for (const [asset, route] of canonicalPages) {
  if (!shell.has(route.pathname)) shell.set(route.pathname, asset);
}

shell.set(new URL("index", self.registration.scope).pathname, new URL("index.html", self.registration.scope).href);

function isShellResponse(response) {
  return response?.ok && !response.redirected;
}

async function fetchShellAsset(asset) {
  let response = await fetch(asset, { cache: "reload", redirect: "manual" });
  const canonical = canonicalPages.get(asset);
  // Pages redireciona os arquivos HTML para suas rotas públicas.
  if (response.type === "opaqueredirect" && canonical) {
    response = await fetch(canonical, { cache: "reload", redirect: "error" });
  }
  if (!isShellResponse(response)) throw new Error("Resposta inválida para o app shell");
  return response;
}

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    const assets = new Set(shell.values());
    await Promise.all([...assets].map(async (asset) => cache.put(asset, await fetchShellAsset(asset))));
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
      if (isShellResponse(response) && !url.search) {
        try { await cache.put(asset, response.clone()); } catch { /* falha de cache não derruba rede */ }
      }
      return response;
    } catch {
      const cached = await cache.match(asset);
      return isShellResponse(cached) ? cached : Response.error();
    }
  })());
});
