// NIKO Service Worker —— stale-while-revalidate + 镜像取源 + 页面级安全闸（v3.0，2026-11-06）
//
// 三条血管，各管一件事：
//   ① 快：导航请求先去镜像（jsDelivr，国内有节点）拿，超时或失败自动回退本站在 GitHub Pages。
//      实测（2026-11-06 公司机）同一个 index.html：Pages 116.5s / 8.0 KB·s⁻¹，jsDelivr 6.5s / 134.8 KB·s⁻¹。
//      为什么必须换通道而不是减体积：Pages 是「按单条 TCP 连接限速」，浏览器对同域只开 1 条连接，
//      拆包 / 并行 / minify 全部无效（铁律 §13.2 实测）。所以杠杆只在「换源」，不在「瘦身」。
//      ★ 页面 origin 不变（仍是 github.io）→ localStorage 不迁移、数据不动。已在本地双源实验验证 9/9。
//   ② 新：命中缓存立刻返回，同时后台静默拉新版写回缓存 —— 用户第一眼永远 100~200ms。
//   ③ 稳：返回页面时注入一段「安全闸」（GUARD_FN），拦截「整块删数据键」这种动作。
//      ★ 关键点：闸门跟着 sw.js（5KB）更新，不跟着 index.html（2.8MB）更新 ——
//        所以哪怕用户浏览器里躺着三个月前的旧页面，闸门也是最新版，不需要重下 2.8MB。
//
// ⚠️ 镜像的版本新鲜度靠 push_api.js 部署后调 jsDelivr purge 保证（它按 branch 引用缓存，最长 12 小时）。
//    若 purge 失败，sw.js 会继续从镜像拿可能滞后一版的页面 —— 页面自身的「有新版本」提示会提示用户切换。
const CACHE_NAME = 'niko-sw-202611040656';
const VER_FILE = /\/niko_ver\.json$/;

// ── 镜像 ───────────────────────────────────────────────
const MIRROR_ON = true;
const MIRROR_BASE = 'https://cdn.jsdelivr.net/gh/skipperjames/niko-daily-console@main';
const MIRROR_TIMEOUT = 12000;   // 镜像正常 6.5s；超这个数就当它挂了，回退本站
// ★ 部署时由 push_api.js 自动改写成本次构建号（和版本号同源）。
//   作用：jsDelivr 按 branch 缓存，purge 生效慢（实测部署后 4 分钟还可能是上一版）——
//   拿到镜像页面后先看它里面有没有这串构建号，没有就说明是旧版，直接回退本站。
//   这样「镜像滞后」永远不会把旧版喂给用户，最多这一次退化成慢一点。
const MIRROR_BUILD = '202611061536';

// ── 安全闸（注入页面）───────────────────────────────────
// 写成函数再用 toString() 序列化 —— 避免在 sw.js 里手动转义引号（历史教训：引号截断静默失效）。
var GUARD_FN = function () {
    try {
        var OFF_KEY = 'niko_guard_off';
        var BIN = 'niko_del_bin';
        var PROT = /^(niko_|work_calendar_)/;
        var MINLEN = 500;      // 小于 500 字符的（主题/开关/时间戳类）不保护，随便删
        var MAXBIN = 40;
        if (window.__nikoGuard) return;                     // 已装过
        if (localStorage.getItem(OFF_KEY) === '1') return;  // 用户显式关掉

        function isProtected(k, v) {
            return !!k && PROT.test(k) && typeof v === 'string' && v.length >= MINLEN;
        }
        function readBin() {
            try { var a = JSON.parse(localStorage.getItem(BIN) || '[]'); return Array.isArray(a) ? a : []; }
            catch (e) { return []; }
        }
        function writeBin(a) {
            try { localStorage.setItem(BIN, JSON.stringify(a.slice(0, MAXBIN))); } catch (e) {}
        }
        function pushBin(k, v) {
            var a = readBin();
            if (a.length && a[0].k === k && a[0].v === v) return;   // 同一条不重复记
            a.unshift({ k: k, v: v, t: Date.now() });
            writeBin(a);
        }
        function blocked(k, v) {
            try {
                window.dispatchEvent(new CustomEvent('niko-guard-blocked', { detail: { k: k, len: v.length } }));
            } catch (e) {}
            try {
                console.warn('[NIKO guard] 拦住一次数据键删除：' + k + '（' + v.length + ' 字符），原值已存进回收站 ' + BIN
                    + '。确需清掉请先 setItem("' + OFF_KEY + '","1") 或调用 __nikoGuard.off()');
            } catch (e) {}
        }

        // ① 拦截 removeItem：整块删一个有肉的数据键 —— 2026-11-06 便签被同步删光就是这一步
        var proto = Storage.prototype;
        var _rm = proto.removeItem;
        proto.removeItem = function (k) {
            try {
                if (this.getItem(OFF_KEY) === '1') return _rm.apply(this, arguments);   // 逃生门随时生效
                var v = this.getItem(k);
                if (isProtected(k, v)) { pushBin(k, v); blocked(k, v); return; }   // 拒绝删除，值留在原地
            } catch (e) {}
            return _rm.apply(this, arguments);
        };

        // ② 拦截 clear()：整库清空时先把数据键捞出来，清完再放回去
        var _clr = proto.clear;
        proto.clear = function () {
            try {
                if (this.getItem(OFF_KEY) === '1') return _clr.apply(this, arguments);
                var keep = [], i, k, v;
                for (i = 0; i < this.length; i++) {
                    k = this.key(i); v = this.getItem(k);
                    if (isProtected(k, v)) { keep.push([k, v]); pushBin(k, v); }
                }
                var r = _clr.apply(this, arguments);
                for (i = 0; i < keep.length; i++) { try { this.setItem(keep[i][0], keep[i][1]); } catch (e) {} }
                return r;
            } catch (e) { return _clr.apply(this, arguments); }
        };

        window.__nikoGuard = {
            version: 'g1',
            bin: readBin,
            restore: function (key) {
                var a = readBin(), hit = null;
                for (var i = 0; i < a.length; i++) { if (a[i].k === key) { hit = a[i]; break; } }
                if (!hit) return false;
                try { localStorage.setItem(hit.k, hit.v); } catch (e) { return false; }
                writeBin(a.filter(function (x) { return x !== hit; }));
                return true;
            },
            off: function () { try { localStorage.setItem(OFF_KEY, '1'); } catch (e) {} }
        };
    } catch (e) {}
};
var GUARD_CODE = '(' + GUARD_FN.toString() + ')();';

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

function notifyClients(message) {
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
        for (var i = 0; i < list.length; i++) {
            try { list[i].postMessage(message); } catch (err) {}
        }
    }).catch(function () {});
}

function mirrorPath(p) {
    if (!p || p === '/') return '/index.html';
    return p;
}

function looksLikePage(t) {
    if (!t || t.length < 5000) return false;                 // 真页面 2.8MB，太短说明拿到的是错误页/占位页
    return /<!doctype html|<html[\s>]/i.test(t.slice(0, 3000));
}

// 镜像拿到的这一版是不是「本次部署」？不是就当它没拿到（回退本站）。
// 没配置构建号（占位符没被替换）时一律放行，避免把整条镜像通道误杀。
function isFreshBuild(t) {
    if (!MIRROR_BUILD || MIRROR_BUILD.indexOf('__NIKO') === 0) return true;
    return t.indexOf(MIRROR_BUILD) >= 0;
}

// 取页面：镜像优先（快），失败/超时/内容可疑 → 回退本站
async function fetchDoc(req, url) {
    if (MIRROR_ON) {
        var mUrl = MIRROR_BASE + mirrorPath(url.pathname);
        try {
            var ctrl = new AbortController();
            var timer = setTimeout(function () { ctrl.abort(); }, MIRROR_TIMEOUT);
            var r = await fetch(mUrl, { mode: 'cors', cache: 'no-store', signal: ctrl.signal });
            clearTimeout(timer);
            if (r && r.ok && r.type !== 'opaque') {
                var t = await r.text();
                if (looksLikePage(t) && isFreshBuild(t)) {
                    return new Response(t, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
                }
            }
        } catch (err) {
            // 超时 / 跨域被拒 / 网络断 → 下面回退本站
        }
    }
    return await fetch(req, { cache: 'no-cache' });
}

// 往页面里插安全闸（插在 <head> 之后，尽量早于业务代码执行）
// 幂等判据必须认「注入标记属性」，不能认 `__nikoGuard` 这种名字 ——
// 页面正文里哪怕只是提了一句 __nikoGuard（比如面板里显示回收站状态），
// 按名字判断就会误以为「已注入」而跳过，闸门静默失效。
function injectGuard(html) {
    if (!html || html.indexOf('data-niko-guard') >= 0) return html;   // 已注入过就不再插
    var tag = '<script data-niko-guard="1">' + GUARD_CODE + '</' + 'script>';
    var i = html.search(/<head[^>]*>/i);
    if (i >= 0) { var j = html.indexOf('>', i) + 1; return html.slice(0, j) + tag + html.slice(j); }
    var b = html.search(/<body[^>]*>/i);
    if (b >= 0) { var j2 = html.indexOf('>', b) + 1; return html.slice(0, j2) + tag + html.slice(j2); }
    return tag + html;
}

// 只在「导航 / HTML 文档」上注入；注入失败就原样返回（绝不让白屏成为可能）
async function withGuard(res) {
    if (!res) return res;
    try {
        var ct = '';
        try { ct = res.headers.get('Content-Type') || ''; } catch (e) {}
        if (ct && ct.indexOf('text/html') < 0) return res;
        var clone = res.clone();
        var txt = await clone.text();
        var out = injectGuard(txt);
        if (out === txt) return res;
        return new Response(out, {
            status: res.status || 200,
            statusText: res.statusText || 'OK',
            headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' }
        });
    } catch (err) {
        return res;
    }
}

self.addEventListener('fetch', function (e) {
    var req = e.request;
    if (req.method !== 'GET') return;

    var url;
    try { url = new URL(req.url); } catch (err) { return; }

    // 跨域（CDN 字体 / 图标 / tesseract 等）不接管
    if (url.origin !== self.location.origin) return;

    // 版本探针：永远直连网络，绝不缓存，也绝不走镜像（要的是「本站当前版本」）
    if (VER_FILE.test(url.pathname)) {
        e.respondWith(fetch(req, { cache: 'no-store' }));
        return;
    }

    var isNav = req.mode === 'navigate';
    var forceFresh = /[?&](v|_t)=/.test(url.search);   // 「有新版本，点一下更新」的跳转
    var key = isNav ? canonicalUrl(url) : req.url;

    // 后台更新链：必须在同步阶段建好并挂进 waitUntil，否则 respondWith 一返回事件就结束、SW 被回收
    var net = (async function () {
        var cache = await caches.open(CACHE_NAME);
        var res = await fetchDoc(req, url);
        if (res && res.ok) {
            try { await cache.put(key, res.clone()); } catch (err) {}
            notifyClients({ type: 'niko-sw-updated' });
        }
        return res;
    })();
    try { e.waitUntil(net.then(function () {}, function () {})); } catch (err) {}

    e.respondWith((async function () {
        var cache = await caches.open(CACHE_NAME);
        var cached = null;
        try { cached = await cache.match(key); } catch (err) {}

        if (forceFresh || !cached) {
            try {
                return await withGuard(await net);
            } catch (err) {
                var fb = cached;
                if (!fb) { try { fb = await cache.match(new URL('app.html', url).href); } catch (e2) {} }
                if (!fb) { try { fb = await cache.match(url.origin + '/app.html'); } catch (e3) {} }
                return fb ? await withGuard(fb) : Response.error();
            }
        }

        // 有缓存：立刻给（秒开）。后台更新已挂 waitUntil，会自己跑完并通知页面
        return await withGuard(cached);
    })());
});
