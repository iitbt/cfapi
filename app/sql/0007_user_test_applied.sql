-- 0007: users 表新增「内部测试申请」标记(4.4.7)
-- 语义: 1 = 用户已在小程序「我的 → 申请测试」提交申请, 后台用户列表据此显示「已申请」徽章;
--       管理员点「设为内部测试」时把它清回 0(申请已处理, 不重复显示, 也不阻塞用户重复点按)。
-- 幂等性: ALTER TABLE ADD COLUMN **不幂等**(重复执行会报 "duplicate column name"), 只在对老库执行一次。
-- 新建库的 users 表已含该列(见 0001_schema.sql), 不用跑本文件。
-- 执行: npm run schema:testapply   (等价于 wrangler d1 execute lyjxxapp-d1 --remote --file=app/sql/0007_user_test_applied.sql)
ALTER TABLE users ADD COLUMN test_applied INTEGER NOT NULL DEFAULT 0;
