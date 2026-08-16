-- Cloudflare D1 初始化脚本
-- 用法: wrangler d1 execute gzh-hot-db --file=./schema.sql
CREATE TABLE IF NOT EXISTS hot_articles (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  author        TEXT,
  url           TEXT,
  image_url     TEXT,
  clicks_count  INTEGER DEFAULT 0,
  like_count    INTEGER DEFAULT 0,
  watch_count   INTEGER DEFAULT 0,
  comments_count INTEGER DEFAULT 0,
  public_time   TEXT,
  summary       TEXT,
  fetched_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hot_articles_fetched_at ON hot_articles(fetched_at);
