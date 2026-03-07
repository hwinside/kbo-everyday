const CACHE_NAME = "kbo-everyday-v12";

const PRECACHE_ASSETS = ["/", "/offline"];

const CACHEABLE_EXTENSIONS = [
  ".js", ".css", ".woff2", ".woff",
  ".png", ".jpg", ".jpeg", ".svg", ".webp", ".ico",
];

self.addEventListener("install", (event) => {
  self.skipWaiting(); // 즉시 활성화
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_ASSETS))
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim()) // 모든 탭 즉시 제어
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // API/auth는 캐시하지 않음
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/auth/")) return;

  const ext = url.pathname.split(".").pop() || "";
  const isCacheable = CACHEABLE_EXTENSIONS.some((e) => `.${ext}` === e);

  if (isCacheable) {
    // Network-first for JS (최신 빌드 즉시 반영), cache-first for static assets
    const isScript = `.${ext}` === ".js" || `.${ext}` === ".css";

    if (isScript) {
      // Network-first: 네트워크 먼저, 실패 시 캐시
      event.respondWith(
        fetch(request)
          .then((response) => {
            if (response.ok) {
              const clone = response.clone();
              caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
            }
            return response;
          })
          .catch(() => caches.match(request).then((c) => c || new Response("Offline", { status: 503 })))
      );
    } else {
      // Stale-while-revalidate for images/fonts
      event.respondWith(
        caches.match(request).then((cached) => {
          const fetchPromise = fetch(request).then((response) => {
            if (response.ok) {
              const clone = response.clone();
              caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
            }
            return response;
          });
          return cached || fetchPromise;
        })
      );
    }
  }
});
