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

const MAX_CANDIDATES = 1000;  // 候选池上限 220→400→1000（2026-09-28 二改：用户要「多搜点独立游戏」）
const MIN_REVIEWS = 20;       // 进榜门槛：评论数下限（太冷门的没有参考价值）
// ★ 团队规模范围（2026-09-28 三改）：用户原话「搜索游戏改成 1-3 人可做的范围吧，别把个人制作过滤掉了」。
//   判据是「1-3 人可做」：自研自发（无外部发行商，或发行商 == 开发商），或开发商家数 ≤ MAX_TEAM。
//   1 人（个人制作）当然在范围内，而且**享有体量豁免**（见 MAX_REVIEWS 的说明）。
const MAX_TEAM = 3;
// 体量上限：评论数 > MAX_REVIEWS 判为大制作（18 个月窗口内，1-3 人团队几乎堆不到 6 万评论）。
//   点名剔除过：WARDOGS（9.4 万 · 发行 Team17）/ 沙丘：觉醒（7.9 万 · Funcom）—— 对「独立游戏怎么打」无参考价值。
//   ⚠️ 豁免（本轮新增）：**个人制作**（开发商仅 1 家 + 自研自发）不受此上限约束 ——
//      一个人/两个人做出来的爆款恰恰最值得看（「我也能做到，而且它爆了」），绝不能被体量门槛误杀。
const MAX_REVIEWS = 60000;
// 粗筛上限：第一轮先砍掉明显的大厂巨制（避免为它们多抓一遍详情，纯省流量）；
//   真正的大小判定挪到详情之后，因为那时才拿得到 developers / publishers，才能做「个人制作豁免」。
const MAX_REVIEWS_PREFILTER = 250000;
const TOP_N = 20;             // 最终保留款数（用户要求雷达墙展示 20 款）
const MIN_BURST = 1.5;        // 爆款指数下限
const SEARCH_PAGES = 6;       // 全站新作倒序翻页数 4→6
const INDIE_PAGES = 6;        // ★ 新增：Indie 标签（tag 492）倒序翻页数 —— 直接搜独立游戏，而不是全站新游
const CONCURRENCY = 3;        // 并发数（8→3：扩池后触发 Steam 限流，主动降速）
const REQ_GAP = 320;          // 单请求之间的主动间隔（ms），标签总数这类串行请求用

// ---------- 通用工具 ----------
function nowCST() { return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 19) + '+08:00'; }
function localDateStr() { return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10); }
function pad(n) { return String(n).padStart(2, '0'); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// 带退避重试：Steam 对高频请求会返回 403/429（2026-09-27 扩池到 400 后实测被限流，详情抓取全灭）
async function fetchRaw(url, headers = {}, timeoutMs = 15000, retries = 3) {
    let lastErr = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeoutMs);
        try {
            const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8', ...headers }, signal: ctrl.signal });
            clearTimeout(timer);
            if (res.ok) return await res.text();
            lastErr = new Error('HTTP ' + res.status);
            // 只有「限流 / 临时故障」才重试，404 之类的直接抛
            if (!(res.status === 403 || res.status === 429 || res.status >= 500) || attempt >= retries) throw lastErr;
        } catch (e) {
            clearTimeout(timer);
            lastErr = e;
            if (attempt >= retries) throw lastErr;
        }
        await sleep(1200 * Math.pow(2, attempt) + Math.floor(Math.random() * 700)); // 1.2s → 2.4s → 4.8s（带抖动）
    }
    throw lastErr || new Error('fetch failed');
}

async function getJSON(url, headers, timeoutMs) {
    const t = await fetchRaw(url, headers, timeoutMs);
    return JSON.parse(t);
}

// 并发池：任一任务抛错返回 null，不中断整批；gapMs 用于主动限速（避免触发 Steam 限流）
async function pool(list, worker, size = CONCURRENCY, gapMs = 0) {
    const out = new Array(list.length).fill(null);
    let cursor = 0;
    const runners = Array.from({ length: Math.min(size, list.length) }, async () => {
        while (true) {
            const i = cursor++;
            if (i >= list.length) break;
            try { out[i] = await worker(list[i], i); }
            catch (e) { out[i] = null; }
            if (gapMs) await sleep(gapMs);
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

// ★ 2026-09-28 新增：直接按 Steam「Indie」标签搜索 —— 这才是「独立游戏候选池」的正解。
//   旧逻辑只搜全站新游（Released_DESC），独立游戏只占其中一小部分，还会被大制作稀释。
//   tag 492 = Steam 官方固定 Indie 标签（先动态从 tagdata 取，取不到回退 492）。
let INDIE_TAG_ID = 492;
async function resolveIndieTagId() {
    try {
        const d = await getJSON('https://store.steampowered.com/tagdata/populartags/english');
        if (Array.isArray(d)) {
            const hit = d.find(x => x && /^indie$/i.test(String(x.name || '').trim()));
            if (hit && hit.tagid) return hit.tagid;
        }
    } catch (e) { console.warn('⚠️ Indie 标签 id 解析失败，回退 492: ' + e.message); }
    return 492;
}

async function fetchFromIndieTag(tagId) {
    const ids = [];
    for (let p = 0; p < INDIE_PAGES; p++) {
        const url = `https://store.steampowered.com/search/results/?query&start=${p * 100}&count=100&sort_by=Released_DESC&tags=${tagId}&infinite=1&cc=us&l=english`;
        try {
            const d = await getJSON(url);
            ids.push(...parseAppIds(d && d.results_html));
        } catch (e) { console.warn(`⚠️ Indie 标签第 ${p + 1} 页失败: ${e.message}`); }
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
    INDIE_TAG_ID = await resolveIndieTagId();
    const c = await fetchFromIndieTag(INDIE_TAG_ID);
    console.log(`✅ Indie 标签候选(tag ${INDIE_TAG_ID}): ${c.length}`);
    bag.push(...c);
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

// ---------- 3.5 社区标签（2026-09-27 新增）----------
// 为什么要抓：appdetails 只给 genres（动作/冒险/独立这种大颗粒），说明不了「这个作真正打在哪个细分赛道」。
// 用户反馈：「每个游戏都是红海，看不出区别」→ 必须展示该作真实的社区标签，并**逐标签**算全站总数，
// 才能回答「窄标签（细分赛道）挤不挤」。标签顺序 = Steam 社区投票序（最相关在前）。
async function fetchStoreTags(appid) {
    const html = await fetchRaw(`https://store.steampowered.com/app/${appid}/?l=english&cc=us`, {
        'Cookie': 'birthtime=283993201; lastagecheckage=1-January-1980; wants_mature_content=1;'
    }, 20000);
    const out = [];
    const re = /class="app_tag"[^>]*>\s*([^<]+?)\s*</g;
    let m;
    while ((m = re.exec(html || '')) !== null) {
        // Steam 页面里标签名带 HTML 实体（实测 Design &amp; Illustration）→ 必须解码，否则前端显示 &amp;
        const t = decodeEnt(m[1].replace(/\s+/g, ' ').trim());
        if (t && out.indexOf(t) < 0) out.push(t);
        if (out.length >= 8) break;   // 只留前 8 个：Steam 按社区投票序返回，后面的多是 Simulation/Singleplayer 这类噪声
    }
    return out;
}

function decodeEnt(s) {
    return String(s)
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&apos;/g, "'")
        .replace(/&#x27;/gi, "'").replace(/&nbsp;/g, ' ');
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

// ---------- AAA / 大厂排除（2026-09-27：首跑混入 The Last of Us Part II Remastered）----------
// 只排「确定的大厂 / 第一方」。独立游戏发行商（Devolver / Annapurna / Team17 / Hooded Horse / Focus 等）一律不动，
// 否则会把真正的独立爆款误杀。匹配 publishers + developers 小写包含。
const AAA_PUBLISHERS = [
    'sony', 'playstation', 'microsoft', 'xbox game studios', 'nintendo',
    'electronic arts', 'ea games', 'ubisoft', 'activision', 'blizzard', 'take-two', 'take 2',
    '2k games', 'rockstar', 'bethesda', 'zenimax', 'capcom', 'bandai namco', 'square enix',
    'sega', 'konami', 'warner bros', 'wb games', 'epic games', 'tencent', 'netease', 'miHoYo',
    // ★ 2026-09-28 第二批：不是第一方，但属于「中大体量发行商」—— 发的是几十人团队的商业制作，
    //   不属于「2-3 人小团队」范畴。只收最明确的，避免误杀 Devolver / Annapurna / Raw Fury 这类专发小独立游戏的厂牌。
    '505 games', 'focus entertainment', 'nacon', 'prime matter', 'deep silver',
    'saber interactive', 'embracer', 'thq nordic', 'koch media', 'private division',
    'gearbox publishing', 'krafton', 'pearl abyss', 'nexon', 'smilegate', 'platinumgames',
    'team17', 'curve games', 'no more robots', 'tinybuild', 'paradox interactive',
];
function isAAA(g) {
    const names = [].concat(g.publishers || [], g.developers || []).join(' ').toLowerCase();
    return AAA_PUBLISHERS.some(k => names.includes(k));
}

// ★ 2026-09-28 新增：小团队信号（这是「1-3 人可做」的可查证代理）
//   Steam 公开接口拿不到员工人数，但「自研自发」是小团队最强的结构性特征：
//     ① 没有发行商（publishers 为空）→ 自己发；
//     ② 发行商与开发商同名 → 自己发（小工作室常见，大厂会把发行独立成实体）；
//   再叠加「开发商 ≤ MAX_TEAM(3) 家」（多家联合开发通常体量更大）。
//   solo = 开发商仅 1 家且自研自发 → 真·个人制作（享体量豁免）。
//   tier 0 = 最像 1-3 人小团队，tier 1 = 自研自发但开发商偏多，tier 2 = 有独立发行商。仅用于排序优先级。
function teamSignal(g) {
    const devs = (g.developers || []).map(s => String(s).toLowerCase().trim()).filter(Boolean);
    const pubs = (g.publishers || []).map(s => String(s).toLowerCase().trim()).filter(Boolean);
    const devCount = devs.length || 1;
    const selfPub = pubs.length === 0 || pubs.some(p => devs.includes(p));
    const solo = devs.length === 1 && pubs.length === 0;
    return { selfPub, devCount, solo, tier: (selfPub && devCount <= MAX_TEAM) ? 0 : (selfPub ? 1 : 2) };
}

// ★ 2026-09-28 三改：把「1-3 人可做」从「排序偏好」升级为**硬门槛**（用户要「搜索范围」改成 1-3 人）。
//   进范围 = 自研自发，或开发商 ≤ 3 家 —— 换句话说，「有外部发行商 + 多家开发商」的大体量作品直接不进榜。
function inTeamScope(g) {
    const t = teamSignal(g);
    return t.selfPub || t.devCount <= MAX_TEAM;
}
// 个人制作（开发商仅 1 家 + 自研自发）→ 体量上限豁免。
//   ⚠️ 判据不能要求「publishers 为空」：Steam 上个人开发者常把 publisher 也填成自己（publishers == developers），
//   2026-09-28 实测「无发行商」这条 20 款里命中 0 款 —— 豁免等于没写。改用 teamSignal().selfPub（无发行商 或 发行==开发）。
function isSoloDev(g) {
    const t = teamSignal(g);
    return t.selfPub && (g.developers || []).filter(Boolean).length === 1;
}

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

// 赛道饱和度（2026-09-27 三次修正，最终版）
// 教训链：① 原算法 Math.max(1, spanDays/30) 把「1 天」当「1 个月」→ 假红海；
//        ② 改翻页取 500 条 → Steam 的 start 翻页对 tag 搜索无效（跨度不增）；
//        ③ 加诊断实测发现：按 Released_DESC 返回的 100 条**唯一日期只有 2 个**（最近两天的上架条目），
//           说明该接口下「最近 N 款」根本不代表该标签的新作分布，任何密度外推都是假的。
// → 最终改用**可查证的硬指标**：该标签在 Steam 的全站游戏总数（total_count）。它回答的是「这个赛道有多拥挤」，
//   而不是伪精确的「每月新增多少款」。
async function fetchSaturation(tagId) {
    if (!tagId) return null;
    const url = `https://store.steampowered.com/search/results/?query&start=0&count=100&sort_by=Released_DESC&tags=${tagId}&infinite=1&cc=us&l=english`;
    const d = await getJSON(url);
    const html = (d && d.results_html) || '';
    const total = (d && d.total_count) ? Number(d.total_count) : null;
    if (!total) return { total: null, sampleCount: null, verdict: null, basis: '接口未返回全站总数' };
    let verdict;
    if (total >= 50000) verdict = { key: 'shark', label: '🦈 红海' };
    else if (total >= 10000) verdict = { key: 'fish', label: '🐠 一般' };
    else verdict = { key: 'empty', label: '🐟 空旷' };
    return {
        total, sampleCount: null, perDay: null, perMonth: null, verdict,
        basis: `Steam 该标签全站 ${total.toLocaleString('en-US')} 款（分档：≥5 万红海 / ≥1 万一般）`,
    };
}

// ---------- 8. 赛道归类标签（供前端展示与 X5 对比用）----------
// 2026-09-27 加：标签黑名单
// 背景：把「全站总数最小的标签」当成细分赛道，会挑出 Memes / Loot / Hentai 这种噪声。
// → NON_TRACK 列出「情绪 / 形式 / 功能 / 体量」类标签，它们不构成赛道，不参与「细分定位」评选（但仍然展示）。
// → NSFW 命中的作品整款剔除，不进雷达。
const NON_TRACK_TAGS = new Set([
    'Memes', 'Funny', 'Comedy', 'Cute', 'Atmospheric', 'Relaxing', 'Colorful', 'Beautiful',
    'Great Soundtrack', 'Soundtrack', 'Music', 'Violent', 'Gore', 'Sexual Content',
    'Indie', 'Early Access', 'Free to Play', 'Singleplayer', 'Multiplayer', 'Co-op',
    'Online Co-Op', 'Local Co-Op', 'Local Multiplayer', 'PvP', 'Massively Multiplayer',
    'Steam Achievements', 'Steam Cloud', 'Steam Workshop', 'Full controller support',
    'Controller', 'Trading Cards', 'Remote Play Together', 'In-App Purchases',
    '2D', '3D', 'Pixel Graphics', 'Retro', 'Stylized', 'Realistic', 'Cartoony',
    'Fantasy', 'Sci-fi', 'Anime', 'Dark', 'Nudity', 'Mature', 'Point & Click',
]);
const NSFW_TAG_RE = /hentai|nsfw|sexual content|sexual themes|adult only|mature content|nudity|erotic/i;
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
    }, 3, 120);
    let tooBig = 0, tooSmall = 0;
    revResults.forEach(x => {
        if (!x || !x.reviews) return;
        const n = x.reviews.total;
        // 第一轮只做「粗筛」：砍掉明显的大厂巨制，省掉一轮详情请求。
        // （真正的体量判定挪到第二轮之后 —— 那时才拿得到 developers / publishers，才能做「个人制作豁免」）
        if (n > MAX_REVIEWS_PREFILTER) { tooBig++; return; }
        if (n < MIN_REVIEWS) { tooSmall++; return; }
        withReviews.push(x);
    });
    console.log(`✅ 评论数 ≥ ${MIN_REVIEWS} 的: ${withReviews.length} 款（粗筛上限 ${MAX_REVIEWS_PREFILTER}）`);
    console.log(`   ↳ 剔除：粗筛巨制 ${tooBig} 款（评论 > ${MAX_REVIEWS_PREFILTER}）· 过于冷门 ${tooSmall} 款（< ${MIN_REVIEWS}）`);

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
    }, 2, 400)).filter(Boolean);   // 2026-09-28：并发 3→2、间隔 150→400ms —— 上一轮 17 款详情挂了 9 款，是限流
    console.log(`✅ 详情抓取成功: ${detailed.length} 款`);

    // ★ 2026-09-28 三改（核心）：拿到 developers / publishers 之后再定「体量 + 团队范围」
    //   ① 体量上限：评论 > MAX_REVIEWS 判为大制作 → 剔除；**个人制作豁免**（1 家开发商 + 自研自发）。
    //   ② 团队范围：只保留「1-3 人可做」（自研自发，或开发商 ≤ MAX_TEAM 家）。
    //   顺序：先判体量（信息更硬），再判范围（兜底挡掉「发行商 + 多开发商」的大体量组合）。
    let tooBigTeam = 0, outScope = 0;
    const detailedKept = detailed.filter(g => {
        const n = (g.reviews && g.reviews.total) || 0;
        if (n > MAX_REVIEWS && !isSoloDev(g)) {
            tooBigTeam++;
            console.log(`   ⛔ 排除大体量作品: ${g.name}（评论 ${n} · ${(g.publishers || g.developers || []).join('/') || '—'}）`);
            return false;
        }
        if (!inTeamScope(g)) {
            outScope++;
            console.log(`   ⛔ 超出 1-3 人范围: ${g.name}（开发商 ${(g.developers || []).join('/') || '—'} · 发行 ${(g.publishers || []).join('/') || '—'}）`);
            return false;
        }
        return true;
    });
    console.log(`✅ 体量 + 1-3 人范围过滤后: ${detailedKept.length} 款（剔：大体量 ${tooBigTeam} · 超范围 ${outScope}）`);
    console.log(`   ↳ 其中个人制作（1 家开发商 + 自研自发）${detailedKept.filter(isSoloDev).length} 款 —— 已豁免体量上限`);

    // 计算爆款指数 + 销量估算 + 排序
    const scoredAll = detailedKept.map(g => {
        const days = daysSince(g.release);
        const score = burstScore(g.reviews, days, g.priceUsd, g.isFree);
        return {
            ...g,
            days,
            team: teamSignal(g),   // ★ 小团队信号（自研自发 + 开发商数），用于排序优先级
            burst: { score, ...tierOf(score) },
            sales: estimateSales(g.reviews, g.priceUsd, g.isFree),
            track: { primary: pickTrackGenre(g.genres), label: trackLabel(pickTrackGenre(g.genres)), saturation: null, niche: null },
            tags: [],            // 社区标签（第三轮补），[{ name, total, verdict, idKnown }]
            playersCurrent: null,
            analysis: (oldByAppid[g.appid] && oldByAppid[g.appid].analysis) || null
        };
    });

    // 先排掉 AAA / 大厂（可查证的发行商黑名单）—— AAA 判定只跑一次，日志不重复打
    const aaaHit = new Set();
    scoredAll.forEach(g => {
        if (isAAA(g)) {
            aaaHit.add(g.appid);
            console.log(`   ⛔ 排除大厂作品: ${g.name}（${(g.publishers || g.developers || []).join(' / ') || '—'}）`);
        }
    });

    // ★ 排序口径（2026-09-28 二改 / 三改沿用）：小团队优先级 > 爆款指数。
    //   用户要的是「1-3 人可做」的作品，所以 tier 0（自研自发 + 开发商 ≤3 家）排最前，同 tier 内再比爆款指数。
    const rankCmp = (a, b) => ((a.team ? a.team.tier : 2) - (b.team ? b.team.tier : 2)) || ((b.burst.score || 0) - (a.burst.score || 0));

    // 再只保留近 18 个月内发行、且爆款指数达标的
    const scored = scoredAll
        .filter(g => !aaaHit.has(g.appid) && g.days != null && g.days <= 550 && (g.burst.score || 0) >= MIN_BURST)
        .sort(rankCmp);

    // 2026-09-28 兜底：达标款数不足 TOP_N 时，从次优池（指数 >0 但没过 MIN_BURST）按同一排序口径补足 ——
    // 保证雷达墙尽量凑满 TOP_N，而不是被门槛卡死只剩个位数。
    if (scored.length < TOP_N) {
        const taken = new Set(scored.map(g => g.appid));
        const extra = scoredAll
            .filter(g => !aaaHit.has(g.appid) && !taken.has(g.appid) && g.days != null && g.days <= 550 && (g.burst.score || 0) > 0)
            .sort(rankCmp);
        const need = TOP_N - scored.length;
        console.log(`ℹ️ 达标仅 ${scored.length} 款（< ${TOP_N}），从次优池补 ${Math.min(extra.length, need)} 款`);
        scored.push(...extra.slice(0, need));
        scored.sort(rankCmp);
    }
    console.log(`ℹ️ 排序后前 ${Math.min(scored.length, TOP_N)} 款中「1-3 人可做（tier 0）」${scored.slice(0, TOP_N).filter(g => g.team && g.team.tier === 0).length} 款`
        + `（个人制作 ${scored.slice(0, TOP_N).filter(isSoloDev).length} 款）`);
    console.log(`✅ 进榜候选: ${scored.length} 款（目标 ${TOP_N}）`);

    // ★ 保护：抓取异常（限流导致详情全灭）时绝不覆盖线上数据。
    // 2026-09-27 教训：候选池扩到 400 触发 Steam 限流 → detailed=0 → 空 games 被写进 indie.json，线上雷达被清空。
    const MIN_KEEP = 3;
    // 2026-09-27：多取 5 个候选 —— 因为要等抓到社区标签后才能剔掉成人内容，剔完再取前 TOP_N
    const pre = scored.slice(0, TOP_N + 15);
    if (pre.length < MIN_KEEP) {
        console.error(`❌ 上榜仅 ${pre.length} 款（< ${MIN_KEEP}），判定为抓取异常 / 被限流，保留旧文件不覆盖`);
        process.exit(1);
    }

    // 第三轮：当前在线 + 社区标签（对候选入选款做）
    console.log('⏳ 第三轮：当前在线 + 社区标签…');
    let tagTable = {};
    try { tagTable = await fetchTagTable(); console.log(`✅ 标签表: ${Object.keys(tagTable).length} 项`); }
    catch (e) { console.warn('⚠️ 标签表失败: ' + e.message); }

    await pool(pre, async (g) => {
        try { g.playersCurrent = await fetchPlayers(g.appid); } catch (e) { }
        try { g.tags = await fetchStoreTags(g.appid); } catch (e) { }
        return g;
    }, 2, 300);

    // 3.0 剔掉成人内容（标签命中 NSFW）—— 再定最终 TOP_N
    const picked = pre.filter(g => {
        const hit = (g.tags || []).find(t => NSFW_TAG_RE.test(t));
        if (hit) { console.log(`   🚫 排除成人内容: ${g.name}（标签「${hit}」）`); return false; }
        return true;
    }).slice(0, TOP_N);
    console.log(`🎯 最终入选 ${picked.length} 款（候选 ${pre.length} → 剔除成人内容后取前 ${TOP_N}）`);
    if (picked.length < MIN_KEEP) {
        console.error(`❌ 最终入选仅 ${picked.length} 款（< ${MIN_KEEP}），保留旧文件不覆盖`);
        process.exit(1);
    }

    // 3.1 逐标签算全站总数（跨游戏去重 + 限量 + 间隔，避免限流）
    // 目的：回答「到底是哪个标签红海」。粗标签（动作 8.9 万）必然红海，没信息量；
    //       把标签按全站总数升序排，**最靠前的那个 = 该作真正的细分赛道**，这才是有效信号。
    const MAX_TAGS = 42;
    const uniqTags = [];
    picked.forEach(g => (g.tags || []).forEach(t => { if (uniqTags.indexOf(t) < 0) uniqTags.push(t); }));
    const tagStat = {};
    let tagHit = 0;
    for (const name of uniqTags.slice(0, MAX_TAGS)) {
        const id = tagTable[name];
        if (!id) { tagStat[name] = { total: null, verdict: null, idKnown: false }; continue; }
        try {
            const s = await fetchSaturation(id);
            tagStat[name] = { total: (s && s.total) || null, verdict: (s && s.verdict) || null, idKnown: true };
            if (s && s.total) tagHit++;
        } catch (e) { tagStat[name] = { total: null, verdict: null, idKnown: true }; }
        await sleep(REQ_GAP);
    }
    console.log(`✅ 标签总数已取 ${tagHit}/${uniqTags.length} 个（限量 ${MAX_TAGS}）`);

    // 3.2 挂回每款：按全站总数升序（越靠前越细分），并挑出「细分定位」
    picked.forEach(g => {
        const arr = (g.tags || []).map(name => Object.assign({ name }, tagStat[name] || { total: null, verdict: null, idKnown: false }));
        arr.sort((a, b) => {
            if (a.total == null && b.total == null) return 0;
            if (a.total == null) return 1;
            if (b.total == null) return -1;
            return a.total - b.total;
        });
        g.tags = arr;
        // 细分定位优先挑「非噪声标签」里最窄的那个；全都命中黑名单时退回最窄的任意标签
        const niche = arr.find(x => x.total != null && x.verdict && !NON_TRACK_TAGS.has(x.name))
            || arr.find(x => x.total != null && x.verdict);
        g.track.niche = niche ? niche.name : null;
        if (niche) {
            g.track.saturation = {
                total: niche.total, verdict: niche.verdict,
                basis: `细分标签「${niche.name}」全站 ${niche.total.toLocaleString('en-US')} 款`,
            };
        }
    });

    // 3.3 兜底：一款标签都没抓到 → 退回 genres 的粗标签总数（保持旧行为，前端不至于空）
    const noTag = picked.filter(g => !g.tags.length);
    if (noTag.length) {
        console.warn(`⚠️ ${noTag.length} 款未抓到社区标签，退回 genres 粗标签`);
        await pool(noTag, async (g) => {
            try {
                const id = tagTable[g.track.primary];
                if (id) g.track.saturation = await fetchSaturation(id);
            } catch (e) { }
            return g;
        }, 2, 300);
    }

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
            picked: picked.length,
            minReviews: MIN_REVIEWS,
            maxReviews: MAX_REVIEWS,
            maxReviewsPrefilter: MAX_REVIEWS_PREFILTER,
            maxTeam: MAX_TEAM,
            soloDev: picked.filter(isSoloDev).length,
            selfPublished: picked.filter(g => g.team && g.team.selfPub).length,
            indieTagId: INDIE_TAG_ID
        },
        games: picked
    };

    fs.writeFileSync(OUTPUT, JSON.stringify(next, null, 2), 'utf-8');
    console.log(`\n📦 已写入 indie.json：${picked.length} 款`);
    picked.forEach((g, i) => {
        const t = g.team || {};
        const who = t.selfPub ? `自研自发(${t.devCount}家)` : `发行:${(g.publishers || []).join('/') || '—'}`;
        console.log(`  ${i + 1}. [${g.burst.label}] ${g.name} | 评论 ${g.reviews.total} | ${who} | 开发商 ${(g.developers || []).join('/') || '—'} | 估算 ${g.sales && g.sales.mid ? g.sales.mid.toLocaleString() : '—'} 份 | ${g.release}`);
    });
    console.log('📅 日期:', next.date, '| 抓取时间:', next.fetchedAt);
}

main().catch(e => { console.error('❌ 脚本异常:', e.message); process.exit(1); });
