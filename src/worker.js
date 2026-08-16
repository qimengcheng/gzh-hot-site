// Cloudflare Worker: 公众号热门文章 -> D1 -> 网站
// 功能:
//   1) 每 6 小时(scheduled) 抓取红狐「全站热门爆款」写入 D1
//   2) 访问站点时展示「最近 7 天抓取到的」热门文章
// 部署: wrangler deploy  (需先 wrangler d1 create 并回填 database_id, wrangler secret put REDFOX_API_KEY)

// 版本号：初始 0.0.1；小更新 +0.0.1，重要更新 +0.1
const VERSION = "0.0.1";

// 更新日志（北京时间）。同日有多条更新时会自动显示具体时间（HH:MM）以区分。
// 维护约定：最新版本写在数组最前；time 格式 "YYYY-MM-DD HH:MM"。
const CHANGELOG = [
  { version: "0.0.1", time: "2026-08-16 18:30", note: "首次发布：页面顶部版本号、底部更新日志；每 6 小时自动抓取红狐全站热门写入 D1" },
];

const API_URL = "https://redfox.hk/story/api/gzh/search/hotArticleNew";

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

async function fetchHotArticles(apiKey) {
  const body = JSON.stringify({
    keyword: "", // 空关键词 = 全站热门
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

async function upsertArticles(db, articles, fetchedAt) {
  if (!articles.length) return 0;
  const queries = articles.map((a) =>
    db
      .prepare(
        `INSERT INTO hot_articles
          (id, title, author, url, image_url, clicks_count, like_count, watch_count, comments_count, public_time, summary, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           title=excluded.title, author=excluded.author, url=excluded.url,
           image_url=excluded.image_url, clicks_count=excluded.clicks_count,
           like_count=excluded.like_count, watch_count=excluded.watch_count,
           comments_count=excluded.comments_count, public_time=excluded.public_time,
           summary=excluded.summary, fetched_at=excluded.fetched_at`
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
        fetchedAt
      )
  );
  await db.batch(queries);
  return articles.length;
}

async function runFetch(env) {
  const articles = await fetchHotArticles(env.REDFOX_API_KEY);
  const n = await upsertArticles(env.DB, articles, new Date().toISOString());
  return n;
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

async function renderSite(db) {
  const { results } = await db
    .prepare(
      `SELECT * FROM hot_articles
       WHERE fetched_at >= ?
       ORDER BY fetched_at DESC, clicks_count DESC
       LIMIT 300`
    )
    .bind(daysAgoISO(7))
    .all();

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
          <span>🕒 抓取 ${esc((r.fetched_at || "").slice(0, 16))}</span>
        </div>
        ${summary ? `<p class="card-summary">${esc(summary)}…</p>` : ""}
      </article>`;
    })
    .join("");

  const updated = results.length
    ? (results[0].fetched_at || "").slice(0, 16)
    : "—";

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
  header { text-align:center; color:#fff; padding:18px 0 26px; }
  header h1 { font-size:2em; margin-bottom:8px; }
  header .sub { opacity:.92; font-size:.98em; }
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
      <div class="sub">展示「最近 7 天抓取到的」全站爆款（阅读 5000+）</div>
    </header>
    <div class="stats">
      <div class="stat">收录文章 <b>${results.length}</b> 篇</div>
      <div class="stat">最近抓取 ${esc(updated)}</div>
      <div class="stat">更新频率 每 6 小时</div>
    </div>
    ${results.length ? `<div class="cards">${cards}</div>` : `<div class="empty">暂无数据，定时任务将在下次抓取后更新。</div>`}
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
    const html = await renderSite(env.DB);
    return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
  },
};
