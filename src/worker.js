// Cloudflare Worker: 公众号热门文章 -> D1 -> 网站
// 功能:
//   1) 每 6 小时(scheduled) 按「分类关键词」分别抓取红狐热门写入 D1（打标 category）
//   2) 访问站点时按分类标签筛选展示「最近 7 天抓取到的」热门文章
// 部署: wrangler deploy  (需先 wrangler d1 create 并回填 database_id, wrangler secret put REDFOX_API_KEY)

// 版本号：初始 0.0.1；小更新 +0.0.1，重要更新 +0.1
const VERSION = "0.0.3";

// 更新日志（北京时间）。同日有多条更新时会自动显示具体时间（HH:MM）以区分。
// 维护约定：最新版本写在数组最前；time 格式 "YYYY-MM-DD HH:MM"。
const CHANGELOG = [
  { version: "0.0.3", time: "2026-08-16 19:21", note: "新增 12 个分类（推荐/科技/财经/健康/社会/娱乐/教育/体育/美食/旅行/汽车/育儿），按主题关键词分别抓取并打标；页面顶部加分类标签切换；每类 pageSize=50，解决文章数量少的问题" },
  { version: "0.0.2", time: "2026-08-16 11:15", note: "页面时间统一显示北京时间：抓取时间由 UTC 转为 UTC+8，发布时间原本即为北京时间保持不变" },
  { version: "0.0.1", time: "2026-08-16 19:05", note: "首次发布：页面顶部版本号、底部更新日志；每 6 小时自动抓取红狐全站热门写入 D1" },
];

const API_URL = "https://redfox.hk/story/api/gzh/search/hotArticleNew";

// 分类配置：label 用于展示与标签；kw 为传给红狐 API 的关键词（空=全站热门）；pages 为翻页数。
// 每类 pageSize=50（见 fetchHotArticles），故每类单次抓取约 50 篇，解决「数量少」。
const CATEGORIES = [
  { label: "推荐", kw: "", pages: 1 },
  { label: "科技", kw: "科技", pages: 1 },
  { label: "财经", kw: "财经", pages: 1 },
  { label: "健康", kw: "健康", pages: 1 },
  { label: "社会", kw: "社会", pages: 1 },
  { label: "娱乐", kw: "娱乐", pages: 1 },
  { label: "教育", kw: "教育", pages: 1 },
  { label: "体育", kw: "体育", pages: 1 },
  { label: "美食", kw: "美食", pages: 1 },
  { label: "旅行", kw: "旅行", pages: 1 },
  { label: "汽车", kw: "汽车", pages: 1 },
  { label: "育儿", kw: "育儿", pages: 1 },
];
const CAT_LABELS = ["全部", ...CATEGORIES.map((c) => c.label)];

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}
function daysAgoStr(n) {
  return new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
}
// 用于 D1 时间比较的 ISO 时间点(最近 n 天)
function daysAgoISO(n) {
  return new Date(Date.now() - n * 86400000).toISOString();
}

async function fetchHotArticles(apiKey, kw, page) {
  const body = JSON.stringify({
    keyword: kw || "",
    pageNum: page || 1,
    pageSize: 50,
    startDate: daysAgoStr(30),
    endDate: todayStr(),
    source: "公众号爆款文章洞察-WorkBuddy",
  });
  const res = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
    body,
  });
  if (!res.ok) throw new Error("redfox http " + res.status);
  const json = await res.json();
  if (json.code !== 2000) throw new Error("redfox code " + json.code);
  return json.data.articles || [];
}

async function upsertArticles(db, articles, fetchedAt, category) {
  if (!articles.length) return 0;
  const queries = articles.map((a) =>
    db
      .prepare(
        `INSERT INTO hot_articles
          (id, title, author, url, image_url, clicks_count, like_count, watch_count, comments_count, public_time, summary, fetched_at, category)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           title=excluded.title, author=excluded.author, url=excluded.url,
           image_url=excluded.image_url, clicks_count=excluded.clicks_count,
           like_count=excluded.like_count, watch_count=excluded.watch_count,
           comments_count=excluded.comments_count, public_time=excluded.public_time,
           summary=excluded.summary, fetched_at=excluded.fetched_at`
        // 注意：category 不在 DO UPDATE 中，保留首次分类（同一篇文章只归入最先抓到它的类目）
      )
      .bind(
        String(a.id),
        a.title || "",
        a.author || "",
        a.url || "",
        a.imageUrl || "",
        Number(a.clicksCount) || 0,
        Number(a.likeCount) || 0,
        Number(a.watchCount) || 0,
        Number(a.commentsCount) || 0,
        a.publicTime || "",
        a.summary || "",
        fetchedAt,
        category
      )
  );
  await db.batch(queries);
  return articles.length;
}

// 幂等建表补列：新增 category 字段（默认 '推荐'）。模块级 schemaReady 避免每次请求都执行 ALTER。
let schemaReady = false;
async function ensureSchema(db) {
  if (schemaReady) return;
  try {
    await db.exec(
      "ALTER TABLE hot_articles ADD COLUMN category TEXT NOT NULL DEFAULT '推荐'"
    );
    schemaReady = true;
  } catch (e) {
    // 列已存在属于正常情况，标记为已就绪；其它错误记录后下次重试
    if (e && /duplicate column|already exists/i.test(e.message || "")) schemaReady = true;
    else console.error("ensureSchema error:", e && e.message);
  }
}

async function runFetch(env) {
  await ensureSchema(env.DB);
  let total = 0;
  const fetchedAt = new Date().toISOString();
  for (const cat of CATEGORIES) {
    for (let p = 1; p <= cat.pages; p++) {
      try {
        const arts = await fetchHotArticles(env.REDFOX_API_KEY, cat.kw, p);
        const n = await upsertArticles(env.DB, arts, fetchedAt, cat.label);
        total += n;
        console.log(`fetch cat=${cat.label} page=${p} count=${arts.length} upsert=${n}`);
      } catch (e) {
        console.error(`fetch cat=${cat.label} page=${p} error:`, e.message);
      }
    }
  }
  return total;
}

function fmtNum(n) {
  n = Number(n) || 0;
  if (n >= 100000) return "10w+";
  if (n >= 10000) return (n / 10000).toFixed(1) + "w";
  return String(n);
}
function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
// 将 D1 中存储的 UTC 时间(ISO, 带 Z) 转换为北京时间(UTC+8)的 "YYYY-MM-DD HH:MM" 字符串。
// 关键：用 getUTC* 读取分量并在绝对时刻上显式 +8 小时，避免依赖运行时本地时区
// （Cloudflare Worker 运行时为 UTC，本地开发可能在 +8，两种环境都必须得到正确北京时刻）。
function utcToBeijing(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso).slice(0, 16); // 解析失败兜底
  const beijing = new Date(d.getTime() + 8 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, "0");
  return `${beijing.getUTCFullYear()}-${p(beijing.getUTCMonth() + 1)}-${p(beijing.getUTCDate())} ${p(beijing.getUTCHours())}:${p(beijing.getUTCMinutes())}`;
}

function renderChangelog() {
  const dayCount = {};
  for (const e of CHANGELOG) {
    const d = e.time.slice(0, 10);
    dayCount[d] = (dayCount[d] || 0) + 1;
  }
  const items = CHANGELOG.map((e) => {
    const d = e.time.slice(0, 10);
    const label = dayCount[d] > 1 ? e.time : d; // 同日多条才显示具体时间
    return `<li><span class="cl-ver">v${esc(e.version)}</span><span class="cl-time">${esc(label)}</span><span class="cl-note">${esc(e.note)}</span></li>`;
  }).join("");
  return `<section class="changelog"><h2>📝 更新日志</h2><ul>${items}</ul></section>`;
}

async function renderSite(db, cat) {
  await ensureSchema(db);
  // cat 仅接受已知标签，未知值回落到「全部」，避免误匹配导致空白
  const filter = CAT_LABELS.includes(cat) && cat !== "全部" ? cat : null;
  const { results } = await db
    .prepare(
      `SELECT * FROM hot_articles
       WHERE fetched_at >= ? AND (? IS NULL OR category = ?)
       ORDER BY clicks_count DESC, fetched_at DESC
       LIMIT 300`
    )
    .bind(daysAgoISO(7), filter, filter)
    .all();

  const tabs = CAT_LABELS.map((t) => {
    const active = t === (filter || "全部") ? " class=\"active\"" : "";
    return `<a href="?cat=${encodeURIComponent(t)}"${active}>${esc(t)}</a>`;
  }).join("");

  const cards = results
    .map((r) => {
      const summary = (r.summary || "").slice(0, 120);
      return `
      <article class="card">
        <div class="card-top">
          <h3 class="card-title"><a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.title)}</a></h3>
          <div class="card-metrics">
            <span class="m reads">👁 ${fmtNum(r.clicks_count)}</span>
            <span class="m likes">👍 ${fmtNum(r.like_count)}</span>
            <span class="m watch">👀 ${fmtNum(r.watch_count)}</span>
          </div>
        </div>
        <div class="card-meta">
          <span>👤 ${esc(r.author || "未知作者")}</span>
          <span>📅 发布 ${esc((r.public_time || "").slice(0, 16))}</span>
          <span>🕒 抓取 ${esc(utcToBeijing(r.fetched_at))}</span>
        </div>
        ${summary ? `<p class="card-summary">${esc(summary)}…</p>` : ""}
      </article>`;
    })
    .join("");

  const updated = results.length
    ? utcToBeijing(results[0].fetched_at)
    : "—";

  const catTitle = filter ? ` · ${esc(filter)}` : "";

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>公众号热门文章 · 近7天</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;
         background:linear-gradient(135deg,#667eea 0%,#764ba2 100%); min-height:100vh; padding:24px; color:#2d3436; }
  .wrap { max-width:920px; margin:0 auto; }
  header { text-align:center; color:#fff; padding:18px 0 18px; }
  header h1 { font-size:2em; margin-bottom:8px; }
  header .sub { opacity:.92; font-size:.98em; }
  .tabs { display:flex; gap:8px; justify-content:center; flex-wrap:wrap; margin:6px 0 18px; }
  .tabs a { background:rgba(255,255,255,.2); color:#fff; text-decoration:none; padding:7px 14px; border-radius:20px;
            font-size:.88em; transition:all .15s ease; }
  .tabs a:hover { background:rgba(255,255,255,.35); }
  .tabs a.active { background:#fff; color:#6c5ce7; font-weight:700; }
  .stats { display:flex; gap:12px; justify-content:center; margin-bottom:22px; flex-wrap:wrap; }
  .stat { background:rgba(255,255,255,.18); color:#fff; border-radius:12px; padding:10px 18px; font-size:.9em; }
  .card { background:#fff; border-radius:14px; box-shadow:0 6px 16px rgba(0,0,0,.12); padding:18px 20px; margin-bottom:16px;
          transition:transform .2s ease, box-shadow .2s ease; }
  .card:hover { transform:translateY(-3px); box-shadow:0 10px 22px rgba(0,0,0,.18); }
  .card-top { display:flex; justify-content:space-between; gap:14px; align-items:flex-start; }
  .card-title { font-size:1.08em; line-height:1.4; }
  .card-title a { color:#2d3436; text-decoration:none; }
  .card-title a:hover { color:#6c5ce7; }
  .card-metrics { display:flex; gap:8px; flex-shrink:0; }
  .card-metrics .m { background:#f1f2f6; border-radius:10px; padding:4px 10px; font-size:.82em; white-space:nowrap; }
  .card-meta { display:flex; gap:16px; flex-wrap:wrap; color:#636e72; font-size:.85em; margin:10px 0; }
  .card-summary { color:#4b4b4b; line-height:1.6; font-size:.92em; }
  .empty { background:#fff; border-radius:14px; padding:40px; text-align:center; color:#636e72; }
  footer { text-align:center; color:rgba(255,255,255,.8); font-size:.82em; padding:20px 0; }
  a { color:#6c5ce7; }
  .ver-badge { font-size:.5em; background:#fff; color:#6c5ce7; border-radius:10px; padding:3px 10px; vertical-align:middle; margin-left:6px; }
  .changelog { background:rgba(255,255,255,.96); border-radius:14px; padding:18px 22px; margin-top:10px; color:#2d3436; }
  .changelog h2 { font-size:1.1em; margin-bottom:12px; }
  .changelog ul { list-style:none; }
  .changelog li { display:flex; gap:12px; align-items:baseline; padding:9px 0; border-bottom:1px dashed #e3e3e3; font-size:.9em; }
  .changelog li:last-child { border-bottom:none; }
  .cl-ver { font-weight:700; color:#6c5ce7; white-space:nowrap; }
  .cl-time { color:#888; white-space:nowrap; font-variant-numeric:tabular-nums; }
  .cl-note { color:#444; }
</style>
</head>
<body>
  <div class="wrap">
    <header>
      <h1>📊 公众号热门文章 <span class="ver-badge">v${VERSION}</span></h1>
      <div class="sub">按分类浏览「最近 7 天抓取到的」公众号爆款（每 6 小时更新）</div>
    </header>
    <nav class="tabs">${tabs}</nav>
    <div class="stats">
      <div class="stat">${filter ? esc(filter) : "全部"} 收录 <b>${results.length}</b> 篇</div>
      <div class="stat">最近抓取 ${esc(updated)}</div>
      <div class="stat">更新频率 每 6 小时</div>
    </div>
    ${results.length ? `<div class="cards">${cards}</div>` : `<div class="empty">该分类暂无数据，定时任务将在下次抓取后更新。</div>`}
    ${renderChangelog()}
    <footer>数据来源：红狐数据 · 公众号公开文章，版权归原作者所有</footer>
  </div>
</body>
</html>`;
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runFetch(env).catch((e) => console.error("fetch error", e.message)));
  },
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/refresh" && request.method === "POST") {
      try {
        const n = await runFetch(env);
        return new Response(JSON.stringify({ ok: true, inserted: n }), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: e.message }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
    }
    const cat = url.searchParams.get("cat") || "全部";
    const html = await renderSite(env.DB, cat);
    return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
  },
};
