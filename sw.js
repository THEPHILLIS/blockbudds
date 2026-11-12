/* BlockBudds app shell. Bump CACHE when the shell files change. */
var CACHE = "blockbudds-shell-v1";
var SHELL = [
  "/",
  "/index.html",
  "/manifest.webmanifest",
  "/favicon.svg",
  "/favicon.png",
  "/apple-touch-icon.png",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/icon-maskable-512.png"
];

function isLiveData(url) {
  var host = url.hostname;
  return host === "supabase.co" || host.endsWith(".supabase.co") || host.endsWith(".supabase.in");
}

self.addEventListener("install", function (event) {
  event.waitUntil(
    caches.open(CACHE).then(function (cache) {
      return cache.addAll(SHELL);
    }).then(function () {
      return self.skipWaiting();
    })
  );
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (key) {
        return key !== CACHE;
      }).map(function (key) {
        return caches.delete(key);
      }));
    }).then(function () {
      return self.clients.claim();
    })
  );
});

function isDocument(request, url) {
  return request.mode === "navigate" || url.pathname === "/" || url.pathname === "/index.html";
}

self.addEventListener("fetch", function (event) {
  var request = event.request;
  if (request.method !== "GET") return;

  var url;
  try {
    url = new URL(request.url);
  } catch (err) {
    return;
  }

  if (url.origin !== self.location.origin || isLiveData(url)) return;
  if (url.pathname === "/sw.js") return;

  if (isDocument(request, url)) {
    event.respondWith(
      fetch(request, { cache: "no-store" }).then(function (response) {
        if (response && response.ok && response.type === "basic") {
          var forIndex = response.clone();
          var forRoot = response.clone();
          caches.open(CACHE).then(function (cache) {
            cache.put("/index.html", forIndex);
            cache.put("/", forRoot);
          });
        }
        return response;
      }).catch(function () {
        return caches.match("/index.html").then(function (cached) {
          return cached || caches.match("/");
        });
      })
    );
    return;
  }

  event.respondWith(
    caches.match(request).then(function (cached) {
      var refresh = fetch(request).then(function (response) {
        if (response && response.ok && response.type === "basic") {
          var copy = response.clone();
          caches.open(CACHE).then(function (cache) {
            cache.put(request, copy);
          });
        }
        return response;
      }).catch(function () {
        return cached;
      });
      return cached || refresh;
    })
  );
});
