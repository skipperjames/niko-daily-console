// NIKO Service Worker —— stale-while-revalidate（v2.26，2026-09-19）
//
// 旧策略是 network-first：每次刷新都完整重下 2.8MB（gzip 后约 800KB）的 index.html，
// 国内访问 GitHub Pages 没有节点，实测一次刷新 6~22 秒。改成：
//   1. 命中缓存 → 立刻返回（秒开），同时后台静默拉新版写回缓存，下次打开即新版
//   2. 没缓存 / 带 ?v= 或 ?_t= 的「点一下更新」跳转 → 走网络，确保真的拿到新版
//   3. niko_ver.json 永远直连网络且不缓存 —— 否则新版本永远发现不了
//   4. 网络失败 → 降级缓存；再不行降级 app.html
//
// 注意：push_api.js 每次部署都会把 CACHE_NAME 升到新时间戳，
// activate 时旧 cache 全清 → 部署后第一次打开必然拿新版，不会被旧缓存锁死。
const CACHE_NAME = 'niko-sw-202609190748';
const VER_FILE = /\/niko_ver\.json$/;

self.addEventListener('install', function () {
    self.skipWaiting();
});

self.addEventListener('activate', function (e) {
    e.waitUntil(
        caches.keys().then(function (keys) {
            return Promise.all(keys.filter(function (k) { return k !== CACHE_NAME; }).map(function (k) { return caches.delete(k); }));
        }).then(function () { return self.clients.claim(); })
    );
});

// 导航请求统一用「源 + 路径」做缓存键（丢掉 ?v= / ?_t= / ?t= 这些参数）
function canonicalUrl(url) {
    return url.origin + url.pathname;
}

// 通知所有已打开的页面：SW 缓存刚刚刷新过。
// 页面收到后自己去拉 52 字节的 niko_ver.json 比对版本号 —— 只有真·新版才会把
// 右下角提示从「正在后台下载」切成「已就绪，点一下立即切换」（0.1 秒生效）。
function notifyClients(message) {
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
        for (var i = 0; i < list.length; i++) {
            try { list[i].postMessage(message); } catch (err) {}
        }
    }).catch(function () {});
}

self.addEventListener('fetch', function (e) {
    var req = e.request;
    if (req.method !== 'GET') return;

    var url;
    try { url = new URL(req.url); } catch (err) { return; }

    // 跨域（CDN 字体 / 图标 / jsdelivr 的 tesseract 等）不接管，保持浏览器原生行为
    if (url.origin !== self.location.origin) return;

    // 版本探针：永远直连网络，绝不缓存
    if (VER_FILE.test(url.pathname)) {
        e.respondWith(fetch(req, { cache: 'no-store' }));
        return;
    }

    var isNav = req.mode === 'navigate';
    var forceFresh = /[?&](v|_t)=/.test(url.search);   // 「有新版本，点一下更新」的跳转
    var key = isNav ? canonicalUrl(url) : req.url;

    // ★★★ 后台更新这条链必须在「同步阶段」就建好并挂进 waitUntil。
    //   否则 respondWith 返回缓存后事件立刻结束、SW 被回收，
    //   后台的 fetch / 写盘 / 通知全部白做 —— 实测症状：提示永远停在
    //   「正在后台下载」，永远切不到「已就绪」，用户只能 Ctrl+F5 硬刷。
    var net = caches.open(CACHE_NAME).then(function (cache) {
        return fetch(req, { cache: 'no-cache' }).then(function (res) {
            if (res && res.ok && res.type !== 'opaque') {
                var put = null;
                try { put = cache.put(key, res.clone()); } catch (err) {}
                // 等写盘真正完成后才通知，保证页面这时 reload 一定命中新版
                (put && put.then ? put : Promise.resolve()).then(
                    function () { notifyClients({ type: 'niko-sw-updated' }); },
                    function () {}
                );
            }
            return res;
        });
    });
    try { e.waitUntil(net.then(function () {}, function () {})); } catch (err) {}

    e.respondWith((async function () {
        var cache = await caches.open(CACHE_NAME);
        var cached = null;
        try { cached = await cache.match(key); } catch (err) {}

        // 强制刷新 / 首次访问（无缓存）：必须等网络
        if (forceFresh || !cached) {
            try {
                return await net;
            } catch (err) {
                return cached || (await cache.match('./app.html')) || Response.error();
            }
        }

        // 有缓存：先给缓存（秒开）。后台更新已挂在 waitUntil 上，会自己跑完并通知页面
        return cached;
    })());
});
