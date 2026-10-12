-- 冗余索引清理(2.4.9)
--
-- 背景: 0001_schema.sql 是从旧库的真实 DDL 导出的, 里面对**同一列组合**留了多条索引(历次迁移反复加过),
-- 还有几条"被更长复合索引的前缀覆盖"的短索引。代价是: 每次写入都要多维护几份索引(D1 按写入计费),
-- EXPLAIN 结果也难读。这里只删**语义重复**的那一份, 保留列更全/被查询真正用到的那条。
--
-- 安全性: 全部 `DROP INDEX IF EXISTS`, 可以重复执行; 不动任何数据与表结构。
-- 查询能力不受影响: 只按 status / category / news_id / position 过滤的语句, 仍然能用上保留下来的
-- 那条复合索引(最左前缀匹配)。
--
-- 用法(二选一):
--   wrangler d1 execute lyjxxapp-d1 --file=app/sql/0005_drop_redundant_indexes.sql --remote
--   或按 DEPLOY.md 的做法拆块后在 D1 控制台逐块粘贴(工具: python tools/split_sql.py)
--
-- 执行前建议先看一眼现有索引名(确认要删的确实存在, 名字对各库可能略有差异):
--   SELECT name FROM sqlite_master WHERE type='index' AND tbl_name IN ('news','news_likes','news_favorites','news_shares','news_comments','users','banner_images') ORDER BY tbl_name, name;

-- ① 列组合完全相同的两条: 删掉不带 idx_ 前缀的那一份
DROP INDEX IF EXISTS "user_id";           -- 与 idx_news_user 相同: news(user_id)
DROP INDEX IF EXISTS "unique_favorite";   -- 与 news_favorites_uniq 相同: news_favorites(news_id,user_id)
DROP INDEX IF EXISTS "unique_like";       -- 与 news_likes_uniq 相同: news_likes(news_id,user_id)
DROP INDEX IF EXISTS "news_id";           -- 与 news_shares_uniq 相同: news_shares(news_id,user_id)
DROP INDEX IF EXISTS "status";            -- 与 idx_news_comments_status 相同: news_comments(status)
DROP INDEX IF EXISTS "email_unique";      -- 与 users_email 相同: users(email)

-- ② 被更长复合索引最左前缀覆盖的短索引
DROP INDEX IF EXISTS idx_position_status;        -- banner_images(position,status) ⊂ (position,status,sort_order,id)
DROP INDEX IF EXISTS idx_news_category;          -- news(category) ⊂ (category,deleted_at)
DROP INDEX IF EXISTS idx_news_status;            -- news(status) ⊂ (status,deleted_at,publish_time)
DROP INDEX IF EXISTS idx_news_comments_news;     -- news_comments(news_id) ⊂ (news_id,status,created_at)

-- 执行后回验(应当只剩保留下来的那一份, 每列组合一条):
--   SELECT name, tbl_name, sql FROM sqlite_master WHERE type='index' ORDER BY tbl_name, name;
