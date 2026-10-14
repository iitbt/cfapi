-- 0008: app_notices 增加「定向公告」字段(2.5.7)
-- 语义: target_user_id 非空 = 只发给这个用户(系统消息, 如"内部测试申请已通过 / 内部测试已取消");
--       NULL = 全体公告(与历史数据同义, 老库升级后全部为 NULL, 可见性不变)。
-- 用户侧由 /content/get_notices 与 /content/get_notice_unread 按它过滤("全体 OR 只给我")。
-- 幂等性: ALTER TABLE ADD COLUMN **不幂等**(重复执行会报 duplicate column name), 只对老库执行一次。
-- 新建库的 app_notices 已含该列(见 0001_schema.sql), 不用跑本文件。
-- 执行: npm run schema:noticetarget
ALTER TABLE app_notices ADD COLUMN target_user_id INTEGER;
