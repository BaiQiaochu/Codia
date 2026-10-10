const CACHE_NAME = "codia-mobile-v2";
const APP_SHELL = [
  "./",
  "./manifest.webmanifest",
  "./icon.png",
  "./styles.css",
  "./themes/codia-lilac.css",
];

const serviceWorkerScope = self as unknown as {
  skipWaiting(): void;
  clients: { claim(): Promise<void> };
  addEventListener(type: string, listener: (event: any) => void): void;
};

serviceWorkerScope.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).catch(() => null),
  );
  serviceWorkerScope.skipWaiting();
});

serviceWorkerScope.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)),
    )),
  );
  serviceWorkerScope.clients.claim();
});

serviceWorkerScope.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") {
    serviceWorkerScope.skipWaiting();
  }
});

serviceWorkerScope.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (
    event.request.method !== "GET"
    || url.pathname.startsWith("/api/")
    || url.pathname === "/ws"
  ) {
    return;
  }
  event.respondWith(fetch(event.request).catch(() => caches.match(event.request)));
});

export {};

