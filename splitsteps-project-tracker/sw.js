// Stores the page's own files so the installed app opens without a connection.
// Only files under this folder are handled. Calls to GitHub never come through
// here, so the token and the private docs are never stored by this worker.

const CACHE_PREFIX = "splitsteps-tracker-";
const CACHE = `${CACHE_PREFIX}v1`; // change when the list below changes

const SHELL = [
  "./",
  "styles.css",
  "manifest.webmanifest",
  "js/main.js",
  "js/github.js",
  "js/parse.js",
  "js/tabs.js",
  "js/docs.js",
  "vendor/marked.esm.js",
  "vendor/purify.es.mjs",
  "vendor/fonts/outfit-latin-400-normal.woff2",
  "vendor/fonts/outfit-latin-600-normal.woff2",
  "vendor/fonts/outfit-latin-700-normal.woff2",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/icon-maskable-192.png",
  "icons/icon-maskable-512.png",
  "icons/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  // Other sites on this address share this storage, so remove only our own old caches.
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(
          names
            .filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE)
            .map((name) => caches.delete(name)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

// The network comes first, so a published change shows up as it would without
// this worker. The stored copy is used only when the network fails.
async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) await cache.put(request, response.clone());
    return response;
  } catch (err) {
    const stored = await cache.match(request, { ignoreSearch: true });
    if (stored) return stored;
    if (request.mode === "navigate") {
      const page = await cache.match("./");
      if (page) return page;
    }
    throw err;
  }
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET" || !request.url.startsWith(self.registration.scope)) return;
  event.respondWith(networkFirst(request));
});
