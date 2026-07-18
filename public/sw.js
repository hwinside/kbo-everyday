const CACHE_NAME = "kbo-everyday-v19";

// NOTE: /offline 라우트는 존재하지 않는다(404). 이를 precache하면 cache.addAll이
// reject → SW install 자체가 실패해 업데이트가 막힌다. 오프라인 전용 페이지를
// 만들기 전까지 precache는 비워둔다.
const PRECACHE_ASSETS = [];

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

// ---- Web Push (어드민 PWA 알림 — /api/admin/push, 2026-07-18) ----
self.addEventListener("push", (event) => {
  if (!event.data) return;
  let payload = {};
  try {
    payload = event.data.json();
  } catch {
    payload = { title: "크보팬", body: event.data.text() };
  }
  const title = payload.title || "크보팬";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: payload.body || "",
      tag: payload.tag || undefined,
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      data: { url: payload.url || "/" },
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clientList) => {
        // 이미 열린 창이 있으면 재사용해 이동 (iOS 홈화면 웹앱은 단일 창)
        for (const client of clientList) {
          if ("focus" in client && "navigate" in client) {
            return client.focus().then(() => client.navigate(url));
          }
        }
        return self.clients.openWindow(url);
      })
  );
});
