-- 0009 公告接收人(2.5.9): 给 app_notices 加 receiver_type 并回填历史定向行
--
-- 只给**老库**跑一次。ALTER TABLE ADD COLUMN 不幂等(重复执行报 duplicate column name),
-- 所以它故意不并进 npm run schema:remote(那是"建新库"用的, 0001 已经带这一列)。
-- 新库不用跑; 老库跑: npm run schema:noticereceiver
--
-- receiver_type: 0=所有用户(与历史数据同义) / 1=内部测试用户 / 2=普通用户(已登录且非内部测试) / 3=指定用户
ALTER TABLE app_notices ADD COLUMN receiver_type INTEGER NOT NULL DEFAULT 0;

-- 回填: 2.5.7 起发的"内部测试申请已通过/已取消"是定向消息(target_user_id 非空), 语义上就是 receiver_type=3。
-- 不回填的话它们会变成 DEFAULT 0 = "所有用户" —— 私信变广播, 这是本次升级唯一必须补的一步。
UPDATE app_notices SET receiver_type = 3 WHERE target_user_id IS NOT NULL AND receiver_type = 0;
