#!/usr/bin/env node
/**
 * fetch_hotspot.js — 抓取国内平台热榜公开 API，生成 hotspot.json（供 NIKO 热点看板拉取）
 *
 * 运行环境：
 *   - GitHub Actions runner（Node 20+，内置 fetch）—— 推荐，网络不受限
 *   - 本机 Node 18+（部分平台接口在本机网络可能被限制）
 *
 * 用法：node scripts/fetch_hotspot.js
 * 输出：仓库根目录 hotspot.json（国内平台更新 + 日韩/抓取失败平台保留旧数据）
 *
 * 数据格式（与 NIKO 前端 applyCloudHot 严格对应）：
 *   regions.国内[] = { title, desc, platform, hot, link }
 *   platform 必须匹配前端 cnMap：微博热搜 / 抖音热榜 / B站热搜 / 小红书热门 / 快手热榜 / 百度热搜
 */
const fs = require('fs');
const path = require('path');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const OUTPUT = path.join(__dirname, '..', 'hotspot.json');

// 北京时间（UTC+8）日期，不用 toISOString（那是 UTC）
function localDateStr() {
    const n = new Date(Date.now() + 8 * 3600 * 1000);
    return n.toISOString().slice(0, 10);
}
function nowCST() {
    return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 19) + '+08:00';
}

async function getJSON(url, headers = {}, timeoutMs = 12000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const res = await fetch(url, { headers: { 'User-Agent': UA, ...headers }, signal: ctrl.signal });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return await res.json();
    } finally { clearTimeout(timer); }
}

function fmtHot(n) {
    if (n === undefined || n === null || n === '') return '热';
    const num = Number(n);
    if (!isFinite(num)) return String(n);
    return num >= 10000 ? (num / 10000).toFixed(1).replace(/\.0$/, '') + '万' : String(num);
}

/**
 * 各平台抓取器：返回 [{title, desc, platform, hot, link}]，抛错表示该平台抓取失败（上层降级保留旧数据）
 * 全部为免登录公开接口：
 *   微博热搜  https://weibo.com/ajax/side/hotSearch            （无需登录）
 *   百度热搜  https://top.baidu.com/api/board?tab=realtime      （公开 JSON）
 *   B站热搜   https://s.search.bilibili.com/main/hotword        （公开 JSON）
 *   知乎热榜  https://www.zhihu.com/api/v3/feed/topstory/hot-lists/total（前端暂无知乎板块，抓取后默认不写入，留作启用备用）
 * 抖音/快手：无稳定免登录公开 API，保留旧数据不抓取
 */
const fetchers = {
    '微博热搜': async () => {
        // 关键：必须带 Referer: https://weibo.com/（否则 403）。先预热首页建立会话更稳。
        try { await getJSON('https://weibo.com/', {}, 6000); } catch (e) {}
        const d = await getJSON('https://weibo.com/ajax/side/hotSearch', { Referer: 'https://weibo.com/' });
        const list = (d && d.data && d.data.realtime) || [];
        return list.slice(0, 15).map(it => ({
            title: (it.word || it.note || '').trim(),
            desc: (it.note && it.word && it.note !== it.word) ? it.note.trim() : '',
            platform: '微博热搜',
            hot: fmtHot(it.num),
            link: 'https://s.weibo.com/weibo?q=' + encodeURIComponent(it.word || '') + '&Refer=top'
        })).filter(x => x.title);
    },
    '百度热搜': async () => {
        const d = await getJSON('https://top.baidu.com/api/board?platform=wise&tab=realtime');
        const cards = (d && d.data && d.data.cards) || [];
        const inner = (cards[0] && cards[0].content && cards[0].content[0] && cards[0].content[0].content) || [];
        return inner.slice(0, 15).map(it => ({
            title: (it.word || '').trim(),
            desc: '',
            platform: '百度热搜',
            hot: it.newHotName || '热',
            link: it.url || 'https://top.baidu.com/board?tab=realtime'
        })).filter(x => x.title);
    },
    'B站热搜': async () => {
        const d = await getJSON('https://s.search.bilibili.com/main/hotword');
        const list = (d && d.list) || [];
        return list.slice(0, 15).map(it => ({
            title: (it.keyword || '').trim(),
            desc: '',
            platform: 'B站热搜',
            hot: (it.show_name && it.show_name !== it.keyword) ? it.show_name : '热',
            link: 'https://search.bilibili.com/all?keyword=' + encodeURIComponent(it.keyword || '')
        })).filter(x => x.title);
    },
    '知乎热榜': async () => {
        const d = await getJSON('https://www.zhihu.com/api/v3/feed/topstory/hot-lists/total?limit=30&desktop=true', { Referer: 'https://www.zhihu.com/' });
        const list = (d && d.data) || [];
        return list.slice(0, 15).map(it => ({
            title: (it.target && it.target.title || '').trim(),
            desc: (it.target && it.target.excerpt || '').trim().slice(0, 60),
            platform: '知乎热榜',
            hot: it.detail_text || '热',
            link: (it.target && it.target.url) ? ('https://www.zhihu.com' + it.target.url) : 'https://www.zhihu.com/hot'
        })).filter(x => x.title);
    }
};

async function main() {
    // 1) 读旧数据（首次运行可无）
    let old = { version: 2, fetchedAt: nowCST(), date: localDateStr(), summary: '', regions: {} };
    try {
        if (fs.existsSync(OUTPUT)) old = JSON.parse(fs.readFileSync(OUTPUT, 'utf-8'));
    } catch (e) { console.warn('⚠️ 旧 hotspot.json 解析失败，将重建:', e.message); }
    old.regions = old.regions || {};

    // 2) 抓取国内平台（并发，单个失败不影响其他）
    const results = await Promise.all(Object.entries(fetchers).map(async ([name, fn]) => {
        try {
            const items = await fn();
            console.log(`✅ ${name}: ${items.length} 条`);
            return { name, items, ok: true };
        } catch (e) {
            console.warn(`⚠️ ${name} 抓取失败: ${e.message.slice(0, 80)}（保留旧数据）`);
            return { name, items: null, ok: false };
        }
    }));

    // 3) 组装国内数据：新抓到的平台用新数据，抓取失败的平台保留旧数据
    const oldCN = old.regions['国内'] || [];
    const oldByPlatform = {};
    oldCN.forEach(it => { (oldByPlatform[it.platform] = oldByPlatform[it.platform] || []).push(it); });

    const mergedCN = [];
    results.forEach(({ name, items, ok }) => {
        if (ok && items.length) mergedCN.push(...items);
        else if (oldByPlatform[name]) mergedCN.push(...oldByPlatform[name]);
    });
    // 补上旧数据里有、但本次没尝试抓取的平台（抖音/快手/小红书等）
    Object.keys(oldByPlatform).forEach(p => {
        if (!fetchers[p] && !mergedCN.some(x => x.platform === p)) mergedCN.push(...oldByPlatform[p]);
    });

    // 4) summary：各平台 Top1
    const tops = {};
    mergedCN.forEach(it => { if (!tops[it.platform]) tops[it.platform] = it.title; });
    const summary = '今日热点：' + Object.entries(tops).map(([p, t]) => `${p}「${t}」`).join('；') + '。';

    const next = {
        version: 2,
        fetchedAt: nowCST(),
        date: localDateStr(),
        summary,
        regions: {
            '国内': mergedCN,
            // 日韩数据不抓取，保留旧数据
            ...(old.regions['日本'] ? { '日本': old.regions['日本'] } : {}),
            ...(old.regions['韩国'] ? { '韩国': old.regions['韩国'] } : {})
        }
    };

    fs.writeFileSync(OUTPUT, JSON.stringify(next, null, 2), 'utf-8');
    const total = Object.values(next.regions).reduce((s, a) => s + a.length, 0);
    console.log(`\n📦 已写入 hotspot.json：国内 ${mergedCN.length} 条 / 日韩 ${(next.regions['日本'] || []).length + (next.regions['韩国'] || []).length} 条 / 共 ${total} 条`);
    console.log('📅 日期:', next.date, '| 抓取时间:', next.fetchedAt);

    if (!mergedCN.length) { console.error('❌ 国内平台全部抓取失败且无旧数据，不提交'); process.exit(1); }
}

main().catch(e => { console.error('❌ 脚本异常:', e.message); process.exit(1); });
