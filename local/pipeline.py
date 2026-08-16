#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
本地预览版：复刻 Cloudflare Workers + D1 的逻辑（用本地 SQLite 替代 D1）。
用法:
  python pipeline.py fetch                 # 抓取热门文章并写入本地 hot.db
  python pipeline.py build                 # 生成静态快照 preview.html（最近7天）
  python pipeline.py serve --port 8000     # 启动本地网站（http://localhost:8000）

说明: REDFOX_API_KEY 优先读环境变量，否则读 ~/.openclaw/openclaw.json 的 env。
"""
import argparse
import json
import os
import sqlite3
import urllib.request
from datetime import datetime, timedelta

API_URL = "https://redfox.hk/story/api/gzh/search/hotArticleNew"
DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "hot.db")
SCHEMA = """
CREATE TABLE IF NOT EXISTS hot_articles (
  id             TEXT PRIMARY KEY,
  title          TEXT NOT NULL,
  author         TEXT,
  url            TEXT,
  image_url      TEXT,
  clicks_count   INTEGER DEFAULT 0,
  like_count     INTEGER DEFAULT 0,
  watch_count    INTEGER DEFAULT 0,
  comments_count INTEGER DEFAULT 0,
  public_time    TEXT,
  summary        TEXT,
  fetched_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fetched_at ON hot_articles(fetched_at);
"""

HTML_TEMPLATE = """<!DOCTYPE html>
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
</style>
</head>
<body>
  <div class="wrap">
    <header>
      <h1>📊 公众号热门文章</h1>
      <div class="sub">展示「最近 7 天抓取到的」全站爆款（阅读 5000+）</div>
    </header>
    <div class="stats">
      <div class="stat">收录文章 <b>__COUNT__</b> 篇</div>
      <div class="stat">最近抓取 __UPDATED__</div>
      <div class="stat">更新频率 每 6 小时</div>
    </div>
    __CARDS__
    <footer>数据来源：红狐数据 · 公众号公开文章，版权归原作者所有</footer>
  </div>
</body>
</html>"""


def load_api_key():
    k = os.environ.get("REDFOX_API_KEY")
    if k:
        return k
    p = os.path.expanduser("~/.openclaw/openclaw.json")
    try:
        with open(p, encoding="utf-8") as f:
            return json.load(f).get("env", {}).get("REDFOX_API_KEY")
    except Exception:
        return None


def fetch_hot_articles(api_key):
    end = datetime.now().strftime("%Y-%m-%d")
    start = (datetime.now() - timedelta(days=30)).strftime("%Y-%m-%d")
    body = json.dumps(
        {"keyword": "", "startDate": start, "endDate": end,
         "source": "公众号爆款文章洞察-WorkBuddy"},
        ensure_ascii=False,
    ).encode("utf-8")
    req = urllib.request.Request(
        API_URL, data=body,
        headers={"Content-Type": "application/json", "X-API-Key": api_key},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    if data.get("code") != 2000:
        raise RuntimeError("redfox code " + str(data.get("code")))
    return data.get("data", {}).get("articles", [])


def get_conn():
    conn = sqlite3.connect(DB_PATH)
    conn.executescript(SCHEMA)
    return conn


def upsert(conn, articles, fetched_at):
    rows = [
        (str(a.get("id")), a.get("title", ""), a.get("author", ""),
         a.get("url", ""), a.get("imageUrl", ""),
         int(a.get("clicksCount") or 0), int(a.get("likeCount") or 0),
         int(a.get("watchCount") or 0), int(a.get("commentsCount") or 0),
         a.get("publicTime", ""), a.get("summary", ""), fetched_at)
        for a in articles
    ]
    conn.executemany(
        """INSERT INTO hot_articles
           (id,title,author,url,image_url,clicks_count,like_count,watch_count,comments_count,public_time,summary,fetched_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(id) DO UPDATE SET
             title=excluded.title, author=excluded.author, url=excluded.url,
             image_url=excluded.image_url, clicks_count=excluded.clicks_count,
             like_count=excluded.like_count, watch_count=excluded.watch_count,
             comments_count=excluded.comments_count, public_time=excluded.public_time,
             summary=excluded.summary, fetched_at=excluded.fetched_at""",
        rows,
    )
    conn.commit()


def fmt_num(n):
    n = int(n or 0)
    if n >= 100000:
        return "10w+"
    if n >= 10000:
        return f"{n/10000:.1f}w"
    return str(n)


def esc(s):
    return (str(s if s is not None else "")
            .replace("&", "&amp;").replace("<", "&lt;")
            .replace(">", "&gt;").replace('"', "&quot;"))


def render_site(conn):
    cutoff = (datetime.now() - timedelta(days=7)).isoformat()
    cur = conn.execute(
        "SELECT * FROM hot_articles WHERE fetched_at >= ? "
        "ORDER BY fetched_at DESC, clicks_count DESC LIMIT 300",
        (cutoff,),
    )
    cols = [d[0] for d in cur.description]
    items = [dict(zip(cols, r)) for r in cur.fetchall()]

    cards = ""
    for r in items:
        summary = (r.get("summary") or "")[:120]
        summary_html = f'<p class="card-summary">{esc(summary)}…</p>' if summary else ""
        cards += f"""
      <article class="card">
        <div class="card-top">
          <h3 class="card-title"><a href="{esc(r.get('url'))}" target="_blank" rel="noopener">{esc(r.get('title'))}</a></h3>
          <div class="card-metrics">
            <span class="m reads">👁 {fmt_num(r.get('clicks_count'))}</span>
            <span class="m likes">👍 {fmt_num(r.get('like_count'))}</span>
            <span class="m watch">👀 {fmt_num(r.get('watch_count'))}</span>
          </div>
        </div>
        <div class="card-meta">
          <span>👤 {esc(r.get('author') or '未知作者')}</span>
          <span>📅 发布 {esc((r.get('public_time') or '')[:16])}</span>
          <span>🕒 抓取 {esc((r.get('fetched_at') or '')[:16])}</span>
        </div>
        {summary_html}
      </article>"""

    updated = (items[0].get("fetched_at") or "")[:16] if items else "—"
    cards_html = f'<div class="cards">{cards}</div>' if items else \
        '<div class="empty">暂无数据，运行 python pipeline.py fetch 后即可看到内容。</div>'

    return (HTML_TEMPLATE
            .replace("__CARDS__", cards_html)
            .replace("__COUNT__", str(len(items)))
            .replace("__UPDATED__", esc(updated)))


def cmd_fetch():
    key = load_api_key()
    if not key:
        raise SystemExit("未找到 REDFOX_API_KEY，请配置环境变量或 ~/.openclaw/openclaw.json")
    arts = fetch_hot_articles(key)
    conn = get_conn()
    upsert(conn, arts, datetime.now().isoformat())
    conn.close()
    print(f"已抓取并写入 {len(arts)} 篇（数据库: {DB_PATH}）")


def cmd_build():
    conn = get_conn()
    html = render_site(conn)
    conn.close()
    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "preview.html")
    with open(out, "w", encoding="utf-8") as f:
        f.write(html)
    print(f"静态快照已生成: {out}")


def cmd_serve(port):
    from http.server import BaseHTTPRequestHandler, HTTPServer

    class H(BaseHTTPRequestHandler):
        def do_GET(self):
            conn = get_conn()
            body = render_site(conn).encode("utf-8")
            conn.close()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *a):
            pass

    print(f"本地站点已启动: http://localhost:{port}  (Ctrl+C 停止)")
    HTTPServer(("0.0.0.0", port), H).serve_forever()


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("fetch")
    sub.add_parser("build")
    sp = sub.add_parser("serve")
    sp.add_argument("--port", type=int, default=8000)
    args = ap.parse_args()
    if args.cmd == "fetch":
        cmd_fetch()
    elif args.cmd == "build":
        cmd_build()
    elif args.cmd == "serve":
        cmd_serve(args.port)


if __name__ == "__main__":
    main()
