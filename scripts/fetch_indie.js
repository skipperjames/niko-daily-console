#!/usr/bin/env node
/**
 * fetch_indie.js — 抓取 Steam 独立游戏公开数据，生成 indie.json（供 NIKO 独立游戏雷达拉取）
 *
 * 运行环境：
 *   - GitHub Actions runner（Node 20+，内置 fetch）—— 必须，海外 IP 直连 Steam
 *   - 本机（国内网络直连 Steam 会超时，不可用）
 *
 * 用法：node scripts/fetch_indie.js
 * 输出：仓库根目录 indie.json
 *
 * === 数据源（全部 Steam 官方公开接口，无需 API key）===
 *   候选发现  store.steampowered.com/api/featuredcategories   （新作 / 热销榜）
 *             store.steampowered.com/search/results/          （按发行日期倒序翻页）
 *   评论数    store.steampowered.com/appreviews/{appid}       （销量反推的基石）
 *   详情      store.steampowered.com/api/appdetails           （名称/价格/厂商/分类/描述）
 *   当前在线  api.steampowered.com/ISteamUserStats/GetNumberOfCurrentPlayers
 *   赛道密度  store.steampowered.com/tagdata/populartags/english + 带 tags 的搜索
 *
 * === 已废弃 / 不可用（勿再接入）===
 *   ISteamChartsService/GetTopReleasesPages  官方月度新品榜已停更，最新一期停在 2025-02
 *   steamdb.info                             403
 *   VG Insights / Gamalytic                  需付费 key，本轮用评论数反推替代
 *
 * === 重要约定 ===
 *   1) 本脚本只产出「可查证的硬数据」。爆款因子 / 曝光时间线 / 工具链推断 / 难度三轴
 *      属于 AI 分析，写在 games[].analysis 里，由人工或 AI 补充；
 *      本脚本每次运行会【保留】旧文件里已有的 analysis（按 appid 匹配），绝不覆盖。
 *   2) 销量为 Boxleiter 法评论数反推，属第三方估算，不是官方数字，前端必须标注。
 *   3) 任一环节失败只降级该字段为 null，不整体报错。
 */
const fs = require('fs');
const path = require('path');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const OUTPUT = path.join(__dirname, '..', 'indie.json');

const MAX_CANDIDATES = 220;   // 候选池上限（最近发行的游戏）
const MIN_REVIEWS = 120;      // 进榜门槛：评论数下限
const TOP_N = 8;              // 最终保留款数
const SEARCH_PAGES = 2;       // 搜索翻页数（每页 100）
const CONCURRENCY = 8;        // 并发数

// ---------- 通用工具 ----------
function nowCST() { return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 19) + '+08:00'; }
function localDateStr() { return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10); }
function pad(n) { return String(n).padStart(2, '0'); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchRaw(url, headers = {}, timeoutMs = 15000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8', ...headers }, signal: ctrl.signal });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return await res.text();
    } finally { clearTimeout(timer); }
}

async function getJSON(url, headers, timeoutMs) {
    const t = await fetchRaw(url, headers, timeoutMs);
    return JSON.parse(t);
}

// 并发池：任一任务抛错返回 null，不中断整批
async function pool(list, worker, size = CONCURRENCY) {
    const out = new Array(list.length).fill(null);
    let cursor = 0;
    const runners = Array.from({ length: Math.min(size, list.length) }, async () => {
        while (true) {
            const i = cursor++;
            if (i >= list.length) break;
            try { out[i] = await worker(list[i], i); }
            catch (e) { out[i] = null; }
        }
    });
    await Promise.all(runners);
    return out;
}

// 日期解析：兼容「2026 年 9 月 25 日」与「25 Sep, 2026」/「Sep 25, 2026」
function parseRelease(s) {
    if (!s) return null;
    const str = String(s).trim();
    let m = str.match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
    if (m) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
    m = str.match(/(\d{4})\s*年\s*(\d{1,2})\s*月/);
    if (m) return `${m[1]}-${pad(m[2])}-01`;
    const clean = str.replace(/,/g, '').replace(/\s+/g, ' ');
    const t = Date.parse(clean);
    if (!isNaN(t)) return new Date(t).toISOString().slice(0, 10);
    return null;
}

function daysSince(dateStr) {
    if (!dateStr) return null;
    const t = Date.parse(dateStr + 'T00:00:00Z');
    if (isNaN(t)) return null;
    return Math.max(1, Math.round((Date.now() - t) / 86400000));
}

// ---------- 1. 候选池 ----------
function parseAppIds(html) {
    const ids = [];
    const re = /data-ds-appid="(\d+)"/g;
    let m;
    while ((m = re.exec(html || '')) !== null) ids.push(m[1]);
    return ids;
}

async function fetchFromFeatured() {
    const d = await getJSON('https://store.steampowered.com/api/featuredcategories?cc=us&l=english');
    const ids = [];
    ['newreleases', 'top_sellers', 'specials'].forEach(k => {
        const items = (d && d[k] && d[k].items) || [];
        items.forEach(it => { if (it && it.id) ids.push(String(it.id)); });
    });
    return ids;
}

async function fetchFromSearch() {
    const ids = [];
    for (let p = 0; p < SEARCH_PAGES; p++) {
        const url = `https://store.steampowered.com/search/results/?query&start=${p * 100}&count=100&dynamic_data=&sort_by=Released_DESC&infinite=1&cc=us&l=english`;
        try {
            const d = await getJSON(url);
            ids.push(...parseAppIds(d && d.results_html));
        } catch (e) { console.warn(`⚠️ 搜索第 ${p + 1} 页失败: ${e.message}`); }
        await sleep(400);
    }
    return ids;
}

async function collectCandidates() {
    const bag = [];
    try { const a = await fetchFromFeatured(); console.log(`✅ 商店榜单候选: ${a.length}`); bag.push(...a); }
    catch (e) { console.warn('⚠️ 商店榜单失败: ' + e.message); }
    const b = await fetchFromSearch();
    console.log(`✅ 搜索倒序候选: ${b.length}`);
    bag.push(...b);
    const seen = new Set();
    const uniq = [];
    for (const id of bag) {
        if (!id || seen.has(id)) continue;
        seen.add(id); uniq.push(id);
        if (uniq.length >= MAX_CANDIDATES) break;
    }
    return uniq;
}

// ---------- 2. 评论数 ----------
async function fetchReviews(appid) {
    const url = `https://store.steampowered.com/appreviews/${appid}?json=1&num_per_page=0&language=all&purchase_type=all&filter=summary`;
    const d = await getJSON(url);
    const q = d && d.query_summary;
    if (!q || !q.total_reviews) return null;
    const total = q.total_reviews || 0;
    const pos = q.total_positive || 0;
    return {
        total,
        positive: pos,
        negative: q.total_negative || 0,
        score: q.review_score_desc || '',
        positivePct: total ? Math.round((pos / total) * 100) : null
    };
}

// ---------- 3. 游戏详情 ----------
async function fetchDetails(appid) {
    const d = await getJSON(`https://store.steampowered.com/api/appdetails?appids=${appid}&cc=us&l=schinese`);
    const node = d && d[appid];
    if (!node || !node.success || !node.data) return null;
    const g = node.data;
    const price = g.price_overview || null;
    return {
        appid,
        name: g.name || '',
        header: g.header_image || '',
        desc: (g.short_description || '').replace(/\s+/g, ' ').trim(),
        releaseText: (g.release_date && g.release_date.date) || '',
        release: parseRelease(g.release_date && g.release_date.date),
        comingSoon: !!(g.release_date && g.release_date.coming_soon),
        developers: g.developers || [],
        publishers: g.publishers || [],
        genres: (g.genres || []).map(x => x.description),
        categories: (g.categories || []).map(x => x.description),
        priceUsd: price ? +(price.final / 100).toFixed(2) : (g.is_free ? 0 : null),
        priceInitial: price ? +(price.initial / 100).toFixed(2) : null,
        discount: price ? price.discount_percent : 0,
        isFree: !!g.is_free,
        url: `https://store.steampowered.com/app/${appid}/`,
        requiredAge: g.required_age || 0
    };
}

// ---------- 4. 当前在线 ----------
async function fetchPlayers(appid) {
    const d = await getJSON(`https://api.steampowered.com/ISteamUserStats/GetNumberOfCurrentPlayers/v1/?appid=${appid}`);
    return (d && d.response && d.response.result === 1) ? d.response.player_count : null;
}

// ---------- 5. 销量估算（Boxleiter 评论数反推）----------
function estimateSales(reviews, priceUsd, isFree) {
    const n = reviews && reviews.total;
    if (!n) return null;
    if (isFree) return { mid: null, low: null, high: null, basis: '免费游戏（F2P），不适用评论数反推', confidence: 1 };
    let mul = 30;
    if (priceUsd == null) mul = 30;
    else if (priceUsd < 5) mul = 45;
    else if (priceUsd < 10) mul = 38;
    else if (priceUsd < 20) mul = 30;
    else mul = 22;
    const mid = Math.round(n * mul);
    return {
        mid,
        low: Math.round(mid * 0.6),
        high: Math.round(mid * 1.6),
        basis: `Boxleiter 法 · 评论数 × ${mul}（$${priceUsd == null ? '?' : priceUsd} 价格带）`,
        confidence: 2,
        note: '第三方估算，非官方数据。评论率随类型/地区/促销波动，误差可达 ±60%，只看量级不看精度'
    };
}

// ---------- 6. 爆款指数 ----------
function priceFactor(priceUsd, isFree) {
    if (isFree) return 1.2;
    if (priceUsd == null) return 1.0;
    if (priceUsd < 5) return 1.0;
    if (priceUsd < 10) return 0.9;
    if (priceUsd < 20) return 0.75;
    return 0.6;
}

function burstScore(reviews, days, priceUsd, isFree) {
    const n = reviews && reviews.total;
    if (!n || !days) return null;
    const daily = n / days;
    const fresh = days <= 30 ? 1.3 : 1.0;
    return +(daily * priceFactor(priceUsd, isFree) * fresh).toFixed(2);
}

function tierOf(score) {
    if (score == null) return { key: 'na', label: '—', rank: 0 };
    if (score >= 60) return { key: 'burst', label: '🔥 现象级', rank: 3 };
    if (score >= 15) return { key: 'dark', label: '⚡ 黑马', rank: 2 };
    if (score >= 4) return { key: 'watch', label: '🌱 值得蹲', rank: 1 };
    return { key: 'low', label: '—', rank: 0 };
}

// ---------- 7. 赛道饱和度（近 12 个月新发行密度）----------
const GENRE_CN2EN = {
    '动作': 'Action', '冒险': 'Adventure', '独立': 'Indie', '角色扮演': 'RPG',
    '策略': 'Strategy', '模拟': 'Simulation', '休闲': 'Casual', '体育': 'Sports',
    '竞速': 'Racing', '大型多人在线': 'Massively Multiplayer', '抢先体验': 'Early Access',
    '免费开玩': 'Free to Play', '教育': 'Education', '实用工具': 'Utilities',
    '动画制作与建模': 'Animation & Modeling', '设计与插画': 'Design & Illustration',
    '游戏开发': 'Game Development', '音频制作': 'Audio Production'
};
// 过于宽泛、不具区分度的分类，不作为赛道主标签
const GENRE_TOO_BROAD = new Set(['Indie', 'Free to Play', 'Early Access', 'Casual', 'Utilities', 'Massively Multiplayer']);

async function fetchTagTable() {
    const d = await getJSON('https://store.steampowered.com/tagdata/populartags/english');
    if (!Array.isArray(d)) return {};
    const map = {};
    d.forEach(x => { if (x && x.name && x.tagid) map[x.name] = x.tagid; });
    return map;
}

function pickTrackGenre(genres) {
    const en = (genres || []).map(g => GENRE_CN2EN[g] || g);
    const specific = en.filter(g => !GENRE_TOO_BROAD.has(g));
    return specific[0] || en[0] || null;
}

async function fetchSaturation(tagId) {
    if (!tagId) return null;
    const url = `https://store.steampowered.com/search/results/?query&start=0&count=100&sort_by=Released_DESC&tags=${tagId}&infinite=1&cc=us&l=english`;
    const d = await getJSON(url);
    const html = (d && d.results_html) || '';
    const total = (d && d.total_count) ? d.total_count : null;
    const dates = [];
    const re = /search_released[^>]*>\s*([^<]+?)\s*</g;
    let m;
    while ((m = re.exec(html)) !== null) {
        const dt = parseRelease(m[1]);
        if (dt) dates.push(dt);
    }
    if (dates.length < 10) return { total, recent12m: null, perMonth: null, verdict: null, basis: '样本不足' };
    dates.sort().reverse();
    const newest = dates[0];
    const oldest = dates[dates.length - 1];
    const spanDays = Math.max(1, Math.round((Date.parse(newest + 'T00:00:00Z') - Date.parse(oldest + 'T00:00:00Z')) / 86400000));
    const perMonth = +(dates.length / Math.max(1, spanDays / 30)).toFixed(1);
    const cutoff = Date.now() - 365 * 86400000;
    const recent12m = dates.filter(x => Date.parse(x + 'T00:00:00Z') >= cutoff).length;
    let verdict;
    if (perMonth >= 60) verdict = { key: 'shark', label: '🦈 红海' };
    else if (perMonth >= 15) verdict = { key: 'fish', label: '🐠 一般' };
    else verdict = { key: 'empty', label: '🐟 空旷' };
    return { total, recent12m, perMonth, verdict, basis: `该标签最近 ${dates.length} 款新作的发行密度`, sampleNewest: newest, sampleOldest: oldest };
}

// ---------- 8. 赛道归类标签（供前端展示与 X5 对比用）----------
const TRACK_HINT = {
    'Roguelike': 'Roguelike / 肉鸽', 'Roguelite': 'Roguelike / 肉鸽',
    'Simulation': '模拟经营', 'Strategy': '策略', 'RPG': '角色扮演',
    'Action': '动作', 'Adventure': '冒险', 'Racing': '竞速', 'Sports': '体育'
};
function trackLabel(genre) { return TRACK_HINT[genre] || genre || '未归类'; }

// ---------- main ----------
async function main() {
    // 读旧文件：保留人工/AI 补的分析，以及官方销量公告
    let old = null;
    try { if (fs.existsSync(OUTPUT)) old = JSON.parse(fs.readFileSync(OUTPUT, 'utf-8')); }
    catch (e) { console.warn('⚠️ 旧 indie.json 解析失败，将重建: ' + e.message); }
    const oldByAppid = {};
    if (old && Array.isArray(old.games)) old.games.forEach(g => { if (g && g.appid) oldByAppid[g.appid] = g; });

    // 候选池
    let candidates = await collectCandidates();
    console.log(`\n📋 候选池去重后: ${candidates.length} 款`);

    // 第一轮：抓评论数，过滤出有基本体量的
    console.log('⏳ 第一轮：抓评论数…');
    const withReviews = [];
    const revResults = await pool(candidates, async (appid) => {
        const r = await fetchReviews(appid);
        return r ? { appid, reviews: r } : null;
    });
    revResults.forEach(x => { if (x && x.reviews && x.reviews.total >= MIN_REVIEWS) withReviews.push(x); });
    console.log(`✅ 评论数 ≥ ${MIN_REVIEWS} 的: ${withReviews.length} 款`);

    if (!withReviews.length) {
        console.error('❌ 没有抓到任何达标游戏，保留旧文件不覆盖');
        process.exit(1);
    }

    // 第二轮：抓详情（并发）
    console.log('⏳ 第二轮：抓游戏详情…');
    const detailed = (await pool(withReviews, async (item) => {
        const d = await fetchDetails(item.appid);
        if (!d) return null;
        return { ...d, reviews: item.reviews };
    })).filter(Boolean);
    console.log(`✅ 详情抓取成功: ${detailed.length} 款`);

    // 计算爆款指数 + 销量估算 + 排序
    const scored = detailed.map(g => {
        const days = daysSince(g.release);
        const score = burstScore(g.reviews, days, g.priceUsd, g.isFree);
        return {
            ...g,
            days,
            burst: { score, ...tierOf(score) },
            sales: estimateSales(g.reviews, g.priceUsd, g.isFree),
            track: { primary: pickTrackGenre(g.genres), label: trackLabel(pickTrackGenre(g.genres)), saturation: null },
            playersCurrent: null,
            analysis: (oldByAppid[g.appid] && oldByAppid[g.appid].analysis) || null
        };
    })
        // 只保留近 18 个月内发行、且指数达标的
        .filter(g => g.days != null && g.days <= 550 && g.burst.rank >= 1)
        .sort((a, b) => (b.burst.score || 0) - (a.burst.score || 0));

    const picked = scored.slice(0, TOP_N);
    console.log(`🎯 入选 ${picked.length} 款`);

    // 第三轮：当前在线 + 赛道饱和度（只对入选款做）
    console.log('⏳ 第三轮：当前在线 + 赛道密度…');
    let tagTable = {};
    try { tagTable = await fetchTagTable(); console.log(`✅ 标签表: ${Object.keys(tagTable).length} 项`); }
    catch (e) { console.warn('⚠️ 标签表失败: ' + e.message); }

    await pool(picked, async (g) => {
        try { g.playersCurrent = await fetchPlayers(g.appid); } catch (e) { }
        try {
            const tagId = tagTable[g.track.primary];
            if (tagId) g.track.saturation = await fetchSaturation(tagId);
        } catch (e) { }
        return g;
    }, 4);

    const next = {
        version: 1,
        fetchedAt: nowCST(),
        date: localDateStr(),
        source: 'Steam 官方公开接口（商店榜单 / 搜索 / 详情 / 评论数 / 当前在线）',
        caveat: '销量为 Boxleiter 法评论数反推，属第三方估算，非官方数字；官方销量公告见各游戏 analysis.officialSales',
        stats: {
            candidates: candidates.length,
            passedReviews: withReviews.length,
            detailed: detailed.length,
            picked: picked.length
        },
        games: picked
    };

    fs.writeFileSync(OUTPUT, JSON.stringify(next, null, 2), 'utf-8');
    console.log(`\n📦 已写入 indie.json：${picked.length} 款`);
    picked.forEach((g, i) => {
        console.log(`  ${i + 1}. [${g.burst.label}] ${g.name} | 评论 ${g.reviews.total} | 估算 ${g.sales && g.sales.mid ? g.sales.mid.toLocaleString() : '—'} 份 | ${g.release}`);
    });
    console.log('📅 日期:', next.date, '| 抓取时间:', next.fetchedAt);
}

main().catch(e => { console.error('❌ 脚本异常:', e.message); process.exit(1); });
