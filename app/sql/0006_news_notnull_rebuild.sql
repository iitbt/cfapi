-- 老库收紧约束(2.4.9) —— ⚠️ 这是**唯一一个会重建数据表**的脚本, 执行前请先备份
--
-- 目的: 把 news 的 publish_time / shares / likes / favorites / status 与三张关联表的 created_at
--       从"允许 NULL / 默认空串"收紧成 NOT NULL + 合理默认值, 与 0001_schema.sql(新库) 的口径一致。
-- 为什么必须重建表: SQLite(D1 同样)不支持 `ALTER TABLE ... ALTER COLUMN`,
--       改列的 NOT NULL/默认值只能"建新表 → 拷数据 → 删旧表 → 改名 → 重建索引"。
--
-- 【影响面】
--   · 只动这 4 张表的结构与索引, 不改任何业务数据(抄数据时用 COALESCE 把历史 NULL 换成默认值);
--   · 重建期间这 4 张表短暂不可用(脚本是一次提交, 正常情况下是秒级);
--   · 表的 id 值不变(显式带上 id 列拷贝), 但 AUTOINCREMENT 计数会跟着表名走, 不影响后续新 id。
--
-- 【执行前必须做】
--   1) 备份: wrangler d1 export lyjxxapp-d1 --remote --output backup-<日期>.sql
--      (或 Cloudflare 控制台 D1 → Time Travel, 7 天内可回滚到时间点)
--   2) 先跑一遍体检, 看清有多少行、有多少 NULL 会被填默认值(在控制台执行, 不要在 --file 里跑):
--        SELECT COUNT(*) AS news_rows FROM news;
--        SELECT SUM(publish_time IS NULL) AS null_publish, SUM(status IS NULL) AS null_status,
--               SUM(likes IS NULL) AS null_likes, SUM(shares IS NULL) AS null_shares,
--               SUM(favorites IS NULL) AS null_favorites FROM news;
--        SELECT COUNT(*) AS fav_rows, SUM(created_at='') AS empty_created FROM news_favorites;
--   3) 低峰执行(重建期间写入会失败, 小程序端会看到 5xx)。
--
-- 【执行】
--   wrangler d1 execute lyjxxapp-d1 --file=app/sql/0006_news_notnull_rebuild.sql --remote
--   用控制台逐块粘贴时**必须把本文件一次性贴完**(分块执行会停在"已删旧表"那一步, 数据会变成只剩新表)。
--
-- 【回滚】执行失败且旧表已被删时, 用第 1 步的备份恢复: wrangler d1 execute ... --file=backup-<日期>.sql
--
-- 【执行后回验】
--   SELECT COUNT(*) FROM news;                       -- 行数应与执行前一致
--   SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'news%';  -- 不应再有 *_new
--   SELECT name FROM sqlite_master WHERE type='index' AND tbl_name IN ('news','news_likes','news_favorites','news_view_history');

-- ============ 1. news ============
CREATE TABLE "news_new" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "user_id" INTEGER,
  "title" TEXT NOT NULL DEFAULT '',
  "desc" TEXT,
  "content" TEXT,
  "category" TEXT NOT NULL DEFAULT '',
  "image" TEXT,
  "video_url" TEXT,
  "publish_time" TEXT NOT NULL DEFAULT (datetime('now','+8 hours')),
  "activity_time" TEXT,
  "view_count" INTEGER NOT NULL DEFAULT 0,
  "shares" INTEGER NOT NULL DEFAULT 0,
  "likes" INTEGER NOT NULL DEFAULT 0,
  "favorites" INTEGER NOT NULL DEFAULT 0,
  "type" TEXT DEFAULT 'admin_users',
  "status" TEXT NOT NULL DEFAULT 'approved',
  "deleted_at" TEXT
);

INSERT INTO "news_new" (
  id, user_id, title, "desc", content, category, image, video_url, publish_time, activity_time,
  view_count, shares, likes, favorites, type, status, deleted_at
)
SELECT
  id, user_id, title, "desc", content, category, image, video_url,
  COALESCE(NULLIF(publish_time, ''), datetime('now','+8 hours')),
  activity_time,
  COALESCE(view_count, 0), COALESCE(shares, 0), COALESCE(likes, 0), COALESCE(favorites, 0),
  COALESCE(NULLIF(type, ''), 'admin_users'),
  COALESCE(NULLIF(status, ''), 'approved'),
  deleted_at
FROM "news";

DROP TABLE "news";
ALTER TABLE "news_new" RENAME TO "news";

CREATE INDEX idx_news_category_deleted ON news (category, deleted_at);
CREATE INDEX idx_news_publish ON news (publish_time);
CREATE INDEX idx_news_status_deleted_publish ON news (status, deleted_at, publish_time);
CREATE INDEX "idx_news_status_type_publish" ON "news" ("status", "type", "publish_time");
CREATE INDEX idx_news_type_deleted_publish ON news (type, deleted_at, publish_time, id);
CREATE INDEX idx_news_user ON news (user_id);

-- ============ 2. news_favorites ============
CREATE TABLE "news_favorites_new" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "news_id" INTEGER NOT NULL DEFAULT 0,
  "user_id" INTEGER NOT NULL DEFAULT 0,
  "created_at" TEXT NOT NULL DEFAULT (datetime('now','+8 hours'))
);
INSERT INTO "news_favorites_new" (id, news_id, user_id, created_at)
SELECT id, news_id, user_id, COALESCE(NULLIF(created_at, ''), datetime('now','+8 hours')) FROM "news_favorites";
DROP TABLE "news_favorites";
ALTER TABLE "news_favorites_new" RENAME TO "news_favorites";
CREATE UNIQUE INDEX news_favorites_uniq ON news_favorites (news_id, user_id);
CREATE INDEX idx_news_favorites_user ON news_favorites (user_id, created_at);

-- ============ 3. news_likes ============
CREATE TABLE "news_likes_new" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "news_id" INTEGER NOT NULL DEFAULT 0,
  "user_id" INTEGER NOT NULL DEFAULT 0,
  "created_at" TEXT NOT NULL DEFAULT (datetime('now','+8 hours'))
);
INSERT INTO "news_likes_new" (id, news_id, user_id, created_at)
SELECT id, news_id, user_id, COALESCE(NULLIF(created_at, ''), datetime('now','+8 hours')) FROM "news_likes";
DROP TABLE "news_likes";
ALTER TABLE "news_likes_new" RENAME TO "news_likes";
CREATE UNIQUE INDEX news_likes_uniq ON news_likes (news_id, user_id);
CREATE INDEX idx_news_likes_user ON news_likes (user_id, created_at);

-- ============ 4. news_view_history ============
CREATE TABLE "news_view_history_new" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "news_id" INTEGER NOT NULL DEFAULT 0,
  "user_id" INTEGER NOT NULL DEFAULT 0,
  "created_at" TEXT NOT NULL DEFAULT (datetime('now','+8 hours'))
);
INSERT INTO "news_view_history_new" (id, news_id, user_id, created_at)
SELECT id, news_id, user_id, COALESCE(NULLIF(created_at, ''), datetime('now','+8 hours')) FROM "news_view_history";
DROP TABLE "news_view_history";
ALTER TABLE "news_view_history_new" RENAME TO "news_view_history";
CREATE UNIQUE INDEX "news_view_history_uniq" ON "news_view_history" ("news_id", "user_id");
CREATE INDEX "idx_nvh_user_time" ON "news_view_history" ("user_id", "created_at", "id");
