// NIKO Service Worker — 网络优先策略
// 一旦注册成功，所有后续加载都由 SW 接管：
//   1. 优先从网络获取最新版（绕过浏览器缓存）
//   2. 网络失败时降级到本地缓存
//   3. 每次 fetch 带 cache: 'no-cache'，告诉 CDN/代理不要返回旧缓存
const CACHE_NAME = 'niko-sw-202609040521';

self.addEventListener('install', function(e) {
    self.skipWaiting();
});

self.addEventListener('activate', function(e) {
    // 清理旧版 SW 缓存（v1 → v2 升级时强制扔掉历史缓存）
    e.waitUntil(
        caches.keys().then(function(keys) {
            return Promise.all(keys.filter(function(k) { return k !== CACHE_NAME; }).map(function(k) { return caches.delete(k); }));
        }).then(function() { return self.clients.claim(); })
    );
});

self.addEventListener('fetch', function(e) {
    // 只拦截 GET 请求
    if (e.request.method !== 'GET') return;

    e.respondWith(
        fetch(e.request, { cache: 'no-cache' })
            .then(function(res) {
                // 成功拿到最新版，存一份到 SW 缓存（供离线降级）
                var copy = res.clone();
                caches.open(CACHE_NAME).then(function(c) { c.put(e.request, copy); });
                return res;
            })
            .catch(function() {
                // 网络失败，降级到缓存
                return caches.match(e.request).then(function(cached) {
                    return cached || caches.match('./app.html');
                });
            })
    );
});
